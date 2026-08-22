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
 * The outage is produced by a narrow window and a slow start together — `healthTimeoutMs:
 * 250` and `BEADCAUSE_START_DELAY_MS=1200`. The window alone was the original arrangement
 * and it was not a guarantee: it rested on "nothing starts in a quarter of a second",
 * which is true of this laptop opening several real beads workspaces and false of a CI
 * runner opening one empty one (bc-rcrt). The runner came up first time, the router never
 * saw an outage, and a suite about what the phone is told when nothing is being served
 * timed out having asserted none of it. A start held for 1200ms cannot fit in a 250ms
 * window on any machine, and the window doubles per bring-up until it can — so the outage
 * is guaranteed and so is the recovery, on hardware nobody has to reason about. Then nothing is touched: the router retries on its own clock, and
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
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort, freePort } from './helpers/net.mjs';
import { removeTree, removeTreeSync } from './helpers/tmp.mjs';

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
ntfy.listen(0, '127.0.0.1');
const ntfyPort = await boundPort([ntfy]);

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
      // Half of the guarantee: a window this narrow is missed by any start slower than
      // it. The other half is `BEADCAUSE_START_DELAY_MS` below, which is what makes the
      // start slower than it on a machine of any speed — see the header.
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
const env = { ...process.env, BEADCAUSE_CONFIG_DIR: dir, BEADCAUSE_START_DELAY_MS: '1200' };
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

/**
 * Ending the router, and *waiting* until it is over.
 *
 * `kill()` is not a wait: it returns once the signal is queued, and the thing it is
 * queued for is a supervisor with backends of its own — all of them holding this scratch
 * directory as their `BEADCAUSE_CONFIG_DIR` and writing state into it. Removing the
 * directory on the next line is therefore a race, and the tick it loses reads as
 * `ENOTEMPTY: directory not empty, rmdir` out of the teardown: rmSync emptied a
 * directory, something wrote into it while the walk carried on, and the `rmdir` at the
 * end found it non-empty again (bc-94c6).
 *
 * SIGTERM rather than SIGKILL, because SIGTERM is the only one the router can act on —
 * its handler stops the backends first (bin/router.js), so waiting on this one exit is
 * most of the wait for theirs as well. `once('exit')` is the wait itself: it fires when
 * the child has been reaped. The SIGKILL after five seconds is for a router that will
 * not go, which is a hang rather than a race and should not also cost the suite a stall.
 */
async function stopRouter() {
  if (router.exitCode !== null || router.signalCode) return;
  const gone = new Promise((resolve) => router.once('exit', resolve));
  router.kill('SIGTERM');
  const hard = setTimeout(() => router.kill('SIGKILL'), 5000);
  await gone;
  clearTimeout(hard);
}

/**
 * The teardown proper: reap, close, remove — each step finished before the next one
 * assumes it.
 *
 * `removeTree` rather than `cleanupTmp` because there is nothing in *this* process to
 * quiesce. The writer under `dir` is the router, in a process of its own, so importing
 * lib/commonrepo.js here would flush a snapshot nobody scheduled — while resolving
 * `CONFIG_DIR` against the real `~/.config/beadcause`, which a teardown has no business
 * being the first thing to do. What is wanted is the other half, the retry loop, which
 * is what covers a backend still on its way out after the router has gone.
 */
let tornDown = false;
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  await stopRouter();
  if (ntfy.listening) ntfy.close();
  await removeTree(dir);
}

/**
 * The backstop, for the exits that never reach `teardown` — a throw above the try block,
 * or the SIGINT below. It cannot wait, so it does the only thing an exit handler can:
 * signal, and retry the removal synchronously.
 *
 * A bare `rmSync` is at its worst here rather than at its most harmless: a throw inside
 * an exit listener is an uncaught exception on the way out, printed *after* the suite has
 * said all its checks passed and with the exit code already set — so twenty lines of red
 * land under a green pass and the run stops reading as the thing it did.
 */
const cleanup = () => {
  if (tornDown) return;
  if (router.exitCode === null && !router.signalCode) router.kill('SIGKILL');
  if (ntfy.listening) ntfy.close();
  removeTreeSync(dir);
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

const failedBringUps = () => routerLog.filter((l) => /would not start in time/.test(l)).length;

/**
 * How many times the recovery loop has *driven*, which is not the same as how many times
 * it failed.
 *
 * `bringUp('nothing is being served — trying again')` (bin/router.js) logs its reason on
 * every attempt, before there is an outcome. A failed bring-up — "would not start in time"
 * — is that same attempt losing a 250ms race, and whether it loses is a fact about how
 * loaded this Mac is rather than about the router. Counting the attempt is what makes the
 * assertion below say the thing it means on a quiet laptop and on a busy one alike.
 */
const retryAttempts = () => routerLog.filter((l) => /nothing is being served — trying again/.test(l)).length;

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
  // Waited for rather than read once, and the order of two lines in bin/router.js is the
  // whole reason: `pushNoBackend(...).then(() => log('pushed the outage to the phone'))`
  // logs *after* the POST resolves, while the fake ntfy above records the push the moment
  // it has read the body — before it has even answered. So the push is always observable
  // first and the log line always arrives second, over a pipe, on the router's clock.
  //
  // The gap is normally sub-millisecond and this check read as instantaneous for as long
  // as it was. On 2026-08-20 it was not: main went red here (run 32423711921) with
  // "pushed the outage to the phone" printed in the log dump *underneath* the failure,
  // timestamped 1.7ms after the assertion that said it was missing — a suite reporting
  // that a thing had not happened while quoting it happening. That is one held merge queue
  // and one session per occurrence, over an ordering that was never in doubt.
  //
  // A router that pushed and never logged still fails: the wait times out and the check
  // below is named for what it was always about, not for how long it took.
  const loggedThePush = await waitFor(
    'the router to log the push the fake ntfy has already taken',
    async () => routerLog.some((l) => /pushed the outage to the phone/.test(l)),
    15000
  ).catch(() => false);
  check(loggedThePush, 'the router logs that it pushed, so the log and the phone can be reconciled');

  // --------------------------------------------- and it does not keep saying it

  // The retry loop runs every couple of seconds while nothing is being served. Wait for
  // proof that it has run again since the push, and check that the phone heard nothing
  // about it.
  //
  // *Run* again, not *failed* again, and that is the whole of bc-nqrr and bc-vwc9. This
  // used to count "would not start in time" lines and require a second one before the
  // router recovered. `healthTimeoutMs` here is 250ms — a window no node process starts
  // inside — so on a busy Mac the next attempt loses that race too and there is a second
  // failure to count, while on a quiet one the backend comes up on the very next attempt
  // and the count stays where it was. The suite was measuring how loaded the machine is
  // and calling the answer "the router gave up", against a router log that reads as a
  // textbook recovery. It cost two deliveries a red full run that reproduced in none of
  // the runs after it, and an intermittent red whose own subject is fine is how people
  // learn to re-run a suite rather than read it.
  //
  // The retry *attempt* is logged before there is an outcome, so it is the same fact on
  // either machine — and it is the fact the check is named after. A router that gave up
  // logs no further attempt, the `waitFor` below times out, and the suite still fails.
  const beforeRetries = retryAttempts();
  await waitFor(
    'the router to drive another bring-up while still serving nothing',
    async () => retryAttempts() > beforeRetries,
    45000
  );
  check(
    retryAttempts() > beforeRetries,
    'the router did keep trying while it was down',
    `${retryAttempts()} attempt(s), ${failedBringUps()} of them too slow`
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
} catch (err) {
  bad('the run itself', err.stack || err.message);
}

// After the catch rather than as the last line of the try, so a run that threw tears down
// as completely as one that passed — and here, where awaiting is still possible, rather
// than in the exit handler, where it is not.
await teardown();

if (failures) {
  console.log('\n--- router log ---');
  for (const line of routerLog) console.log(`  ${line}`);
  console.log('\n--- pushes ---');
  for (const p of pushes) console.log(`  ${p.raw}`);
}
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
