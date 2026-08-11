#!/usr/bin/env node
/**
 * The outage push is the only surface that reaches a phone, so it is the one that has to fire.
 *
 *     npm test
 *     node test/outagepush.mjs
 *
 * bc-excc gave "the router is holding the port and serving nothing" three surfaces: the
 * log, the 503 body, and an ntfy push. test/slowstart.mjs drives a real router into that
 * state and checks the first two — and cannot check the third, because it runs with
 * `ntfy: { enabled: false }` like every other suite here. That left the one surface that
 * works when the app is down as the one surface with no test, which is the wrong way
 * round: the log needs somebody at the Mac and the 503 needs somebody already tapping,
 * and the push is what tells you before either.
 *
 * No seam was added to the code to get here. The sandbox writes its own config.json, so
 * `ntfy.server` points at a plain http server started inside this file, and lib/notify.js
 * posts to it exactly as it would post to ntfy.sh — same publish(), same JSON body, same
 * Authorization header. Compare test/certrenew.mjs, which reaches the certificate push by
 * injecting a `notify` callback: that seam exists for renewal and does not exist for this,
 * and inventing one would test the seam rather than the push.
 *
 * The outage is produced the way test/slowstart.mjs produces it — `healthTimeoutMs: 250`,
 * a window no node process can start inside, so the first bring-ups must time out on a
 * machine of any speed. Then nothing is touched: the router retries on its own clock, and
 * both pushes have to arrive on their own.
 *
 * Three claims, and the middle one is the one a phone cares about most:
 *
 *   - the outage push fires at all, names the build, and says it is retrying;
 *   - it fires **once**, however many bring-ups fail after it — a retry loop that pushes
 *     every two seconds is a phone you turn off, and turning it off is how the next real
 *     outage goes unseen;
 *   - the recovery push fires too, because an alert you are never told is over is an
 *     alert you learn to ignore.
 *
 * Hermetic like test/slowstart.mjs and scripts/test-swap.js: a scratch config dir, two
 * ephemeral ports, advocates off, `bd` stubbed to print `[]` so nothing else in the app
 * has anything to push about.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOKEN = 'test-token-not-a-secret';
const NTFY_TOKEN = 'ntfy-token-not-a-secret';
const TOPIC = 'beadcause-test-outage';

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (cond, name, detail) => (cond ? ok(name) : bad(name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function get(port, pathname, { timeout = 10000, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const headers = token ? { 'x-beadcause-token': token } : {};
    const req = http.get({ host: '127.0.0.1', port, path: pathname, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.setTimeout(timeout, () => req.destroy(new Error(`timed out after ${timeout}ms`)));
    req.on('error', reject);
  });
}

async function waitFor(label, fn, ms) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      const got = await fn();
      if (got) return got;
    } catch {
      /* not yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(200);
  }
}

/* ------------------------------------------------------------------- the fake phone */

/**
 * About ten lines, which is the whole argument for doing it this way: lib/notify.js
 * POSTs JSON to `<server>/`, so a server that reads one body is a complete ntfy as far
 * as `publish` is concerned — and every field asserted below is a field the real ntfy.sh
 * would have received.
 */
const pushes = [];
const ntfy = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    let parsed = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* recorded as null, and asserted on below */
    }
    pushes.push({ at: Date.now(), method: req.method, url: req.url, headers: req.headers, body: parsed, raw: body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"id":"fake"}');
  });
});
const ntfyPort = await freePort();
await new Promise((resolve) => ntfy.listen(ntfyPort, '127.0.0.1', resolve));

const outagePushes = () => pushes.filter((p) => /serving nothing/i.test(p.body?.title || ''));
const recoveryPushes = () => pushes.filter((p) => /serving again/i.test(p.body?.title || ''));

/* ------------------------------------------------------------------- a real router */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-outage-'));
const stubBd = path.join(dir, 'bd');
fs.writeFileSync(stubBd, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

const port = await freePort();
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify(
    {
      port,
      host: '127.0.0.1',
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      bdBin: stubBd,
      actor: 'beadcause-test',
      // Same window, and the same reason, as test/slowstart.mjs: nothing starts in a
      // quarter of a second, so the outage is guaranteed rather than hoped for.
      healthTimeoutMs: 250,
      openSessions: false,
      autoDispatch: false,
      claudeSessions: false,
      pollSeconds: 3600,
      // The whole point of this suite. `server` is the fake above, so a push that is
      // written is a push that is caught, and a push that is skipped is a failure.
      ntfy: { enabled: true, topic: TOPIC, server: `http://127.0.0.1:${ntfyPort}`, token: NTFY_TOKEN, detail: 'full' },
      advocates: { enabled: false, workspaces: [] },
    },
    null,
    2
  )
);

// An observing instance skips every push by design (lib/notify.js), so a stray
// BEADCAUSE_OBSERVE in the environment running `npm test` would turn this suite green
// by silencing the thing it exists to check.
const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir };
delete env.BEADCAUSE_OBSERVE;
delete env.BEADCAUSE_READONLY;

const routerLog = [];
const router = spawn(process.execPath, [path.join(ROOT, 'bin', 'router.js')], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
for (const stream of [router.stdout, router.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) routerLog.push(line);
  });
}

const cleanup = () => {
  if (!router.killed) router.kill('SIGKILL');
  ntfy.close();
  fs.rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const failedBringUps = () => routerLog.filter((l) => /would not start in time/.test(l)).length;

try {
  console.log(`\n  outage push — router on :${port}, fake ntfy on :${ntfyPort}, config in ${dir}\n`);

  // ------------------------------------------------------ it goes down, and says so

  // Whatever the router last told us about itself while it was down. Read alongside the
  // wait rather than after it, because by the time a push has been asserted on the
  // router may already have recovered — and "nothing was being served" is a claim about
  // the moment of the push, not about now.
  let down = null;
  const push = await waitFor(
    'the outage push to arrive at the fake ntfy',
    async () => {
      try {
        const snap = JSON.parse((await get(port, `/internal/router/state?t=${TOKEN}`)).body);
        if (!snap.active) down = snap;
      } catch {
        /* the router may not be listening yet */
      }
      return pushes[0] || null;
    },
    45000
  );

  check(outagePushes().length === 1, 'a total outage reaches the phone, not only the log', `${pushes.length} push(es)`);
  check(push.method === 'POST' && push.url === '/', 'posted where a real ntfy server listens', `${push.method} ${push.url}`);
  check(push.body?.topic === TOPIC, 'on the configured topic', `topic ${push.body?.topic}`);
  check(
    push.headers.authorization === `Bearer ${NTFY_TOKEN}`,
    'with the credentials a private ntfy needs — an unauthorised push is a push nobody gets',
    push.headers.authorization
  );

  check(down !== null, 'the router really was serving nothing when it pushed', JSON.stringify(down));
  check(down?.serving === false && down?.active === null, 'nothing behind the port at all', JSON.stringify(down?.active));

  const message = push.body?.message || '';
  check(/serving nothing/i.test(push.body?.title || ''), 'the title says the app is down', push.body?.title);
  check(
    down?.disk && message.includes(down.disk),
    'and the body names the build, so the phone can tell one outage from the next one',
    `disk ${down?.disk} · message ${JSON.stringify(message)}`
  );
  check(
    /retrying on its own/.test(message),
    'and says it is retrying itself — the difference between waiting and driving to the Mac',
    JSON.stringify(message)
  );
  check(
    /holding the port and serving nothing/.test(message),
    'in the same words the log and the 503 use, because it is one verdict with three surfaces'
  );
  check(push.body?.priority === 5, 'at the priority that survives a locked phone', `priority ${push.body?.priority}`);
  // Not compared against the configured baseUrl: lib/config.js reconciles that to the
  // tailnet address the phone can actually reach, so the host here is whatever this Mac
  // is called on the tailnet. The port and the path are the part that has to be right.
  const click = new URL(push.body?.click || 'http://invalid.invalid/nowhere');
  check(
    Number(click.port) === port && click.pathname === '/',
    'and tapping it opens the app on the port the router is holding',
    push.body?.click
  );
  check(
    routerLog.some((l) => /pushed the outage to the phone/.test(l)),
    'the router logs that it pushed, so the log and the phone can be reconciled'
  );

  // --------------------------------------------- and it does not keep saying it

  // The retry loop runs every couple of seconds while nothing is being served. Wait for
  // proof that it has run again since the push — a second failed bring-up — and check
  // that the phone heard nothing about it.
  const beforeRetries = failedBringUps();
  await waitFor(
    'the router to fail another bring-up while still serving nothing',
    async () => failedBringUps() > beforeRetries || (await get(port, '/api/health')).status === 200,
    45000
  );
  check(
    failedBringUps() > beforeRetries,
    'the router did keep trying while it was down',
    `${failedBringUps()} failed bring-up(s)`
  );
  check(
    outagePushes().length === 1,
    'and said so exactly once — a push per retry is a phone you turn off',
    `${outagePushes().length} outage push(es) after ${failedBringUps()} failed bring-up(s)`
  );

  // ------------------------------------------------- and it says when it is over

  // Nothing is touched here either: no file moves, no `npm run swap`, no restart.
  await waitFor('the router to bring a backend up on its own', async () => (await get(port, '/api/health')).status === 200, 120000);

  const back = await waitFor('the recovery push', async () => recoveryPushes()[0] || null, 30000);
  check(recoveryPushes().length === 1, 'the recovery is pushed too, so the alert is closed rather than left open');
  check(/serving again/i.test(back.body?.title || ''), 'and the title says it is over', back.body?.title);
  const backMessage = back.body?.message || '';
  const after = JSON.parse((await get(port, `/internal/router/state?t=${TOKEN}`)).body);
  check(
    after.active?.build && backMessage.includes(after.active.build),
    'naming the build that is now being served',
    `active ${after.active?.build} · message ${JSON.stringify(backMessage)}`
  );
  check(/after \d+s/.test(backMessage), 'and how long the phone was without an app', JSON.stringify(backMessage));
  check(
    back.body?.priority < push.body?.priority,
    'more quietly than the outage, because good news does not need to wake anybody',
    `${back.body?.priority} vs ${push.body?.priority}`
  );
  check(back.at > push.at, 'and after it, which is the only order that makes either of them readable');
  check(pushes.length === 2, 'two pushes for one outage: it broke, and it came back', `${pushes.length} push(es)`);

  router.kill('SIGTERM');
} catch (err) {
  bad('the run itself', err.stack || err.message);
}

if (failures) {
  console.log('\n--- router log ---');
  for (const line of routerLog) console.log(`  ${line}`);
  console.log('\n--- pushes ---');
  for (const p of pushes) console.log(`  ${p.raw}`);
}
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
