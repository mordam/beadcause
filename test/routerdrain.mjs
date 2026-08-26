#!/usr/bin/env node
/**
 * The router kills a live request at DRAIN_MS and used to answer 502 for it — bc-xl7n.134.
 *
 *     npm test
 *     node test/routerdrain.mjs
 *
 * A swap retires the backend it is replacing but lets it finish what it already had —
 * `retire()` in bin/router.js. A parked long poll or a slow board sweep can still be open
 * when DRAIN_MS runs out, and the backend is killed under it anyway; the socket the proxy
 * was piping through it dies with it, and the ordinary answer for that — 502 backend
 * unreachable — is exactly wrong here, because a *new* backend has already been serving
 * for as long as the swap took. `public/report.js` treats every 5xx as the daemon
 * failing, so the phone filed a P0 incident bead about a daemon that was working
 * perfectly well. Caught end to end in the daemon's own log across three separate routes
 * before this bead was filed by hand.
 *
 * The fix has two ends and this suite drives both, in one real router: `retire()` marks a
 * backend `draining` before DRAIN_MS can kill it, and the proxy's `upstream.on('error')`
 * reads that to answer 503 with an `x-beadcause-swap-drain` header instead of a bare 502
 * — see test/reporter.mjs for the other half, which is `public/report.js` reading that
 * header back and not filing over it.
 *
 * Two claims:
 *
 *   1. a request open on a backend DRAIN_MS forces out gets the marked 503, not a 502;
 *   2. a request open on a backend that dies *any other way* — the ordinary crash — still
 *      gets the plain 502, so this is not a blanket "never answer 502 during a swap".
 *
 * No seam in bin/router.js beyond what test/outagepush.mjs and test/slowstart.mjs already
 * lean on: a real router, a real backend (`bin/beadcause.js`), a scratch config dir, `bd`
 * stubbed to print `[]`. `drainMs` is the one new config key this bead adds — the same
 * override shape `healthTimeoutMs` already has — set small here so the kill is reachable
 * on demand instead of costing this suite sixty seconds.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './helpers/net.mjs';
import { removeTree, removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const TOKEN = 'test-token-not-a-secret';

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.message).split('\n').slice(0, 6).join('\n      ')}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A request, held open until it settles — the same shape test/outagepush.mjs uses. */
function get(port, pathname, { timeout = 20000, token = TOKEN } = {}) {
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

function post(port, pathname, { timeout = 30000, token = TOKEN } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'POST', headers: { 'x-beadcause-token': token } },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.setTimeout(timeout, () => req.destroy(new Error(`timed out after ${timeout}ms`)));
    req.on('error', reject);
    req.end();
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
    await sleep(150);
  }
}

/* ------------------------------------------------------------------- a real router */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-routerdrain-'));
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
      // Generous: this suite spawns a real bin/beadcause.js twice (the swap is the
      // point), and a slow Mac is not what either claim is about.
      healthTimeoutMs: 20000,
      // The whole reason this suite does not cost sixty seconds — see the header.
      drainMs: 400,
      openSessions: false,
      autoDispatch: false,
      claudeSessions: false,
      pollSeconds: 3600,
      ntfy: { enabled: false },
      advocates: { enabled: false, workspaces: [] },
    },
    null,
    2
  )
);

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

/** Same wait-then-hard-kill shape as test/outagepush.mjs's `stopRouter`. */
async function stopRouter() {
  if (router.exitCode !== null || router.signalCode) return;
  const gone = new Promise((resolve) => router.once('exit', resolve));
  router.kill('SIGTERM');
  const hard = setTimeout(() => router.kill('SIGKILL'), 5000);
  await gone;
  clearTimeout(hard);
}

let tornDown = false;
async function teardown() {
  if (tornDown) return;
  tornDown = true;
  await stopRouter();
  await removeTree(dir);
}

const cleanup = () => {
  if (tornDown) return;
  if (router.exitCode === null && !router.signalCode) router.kill('SIGKILL');
  removeTreeSync(dir);
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

/** `/internal/router/state` — loopback and token only, same as `--status` reads. */
async function state() {
  const res = await get(port, `/internal/router/state?t=${TOKEN}`, { timeout: 5000 });
  return JSON.parse(res.body);
}

try {
  await waitFor('a first backend to come up', async () => (await state()).active, 25000);

  let firstPid;
  let secondPid;

  await check('a request open on a backend DRAIN_MS kills gets the marked 503, not a 502', async () => {
    firstPid = (await state()).active.pid;

    // Parked well past drainMs (400ms) — long enough that only the forced kill, not the
    // poll's own timeout, can be what ends it. `since=0&want=presence` reaches the park
    // without a `bd` sweep on the way out: nothing has happened, so nothing is "changed".
    const parked = get(port, '/api/poll?since=0&wait=20&want=presence', { timeout: 25000 });

    // Wait for the park to actually be open on the first backend before swapping it out
    // from under it — a swap before this would just retire an idle backend.
    await waitFor('the request to be counted as open', async () => (await state()).active?.inflight >= 1, 10000);

    const swap = await post(port, `/internal/router/swap?t=${TOKEN}`, { timeout: 25000 });
    const swapped = JSON.parse(swap.body);
    assert.equal(swapped.ok, true, `swap did not succeed: ${swap.body}`);
    secondPid = swapped.active.pid;
    assert.notEqual(secondPid, firstPid, 'the swap did not actually change backends');

    const res = await parked;
    assert.equal(res.status, 503, `expected 503, got ${res.status}: ${res.body}`);
    assert.equal(res.headers['x-beadcause-swap-drain'], '1', 'no swap-drain header on the response');
    const body = JSON.parse(res.body);
    assert.equal(body.code, 'swap-drain');

    assert.ok(
      routerLog.some((l) => new RegExp(`retired pid ${firstPid} .*request\\(s\\) still open after`).test(l)),
      'DRAIN_MS forcing the backend out never logged'
    );
    assert.ok(
      routerLog.some((l) => new RegExp(`proxy to pid ${firstPid} failed during drain`).test(l)),
      'the drain-aware warning never logged'
    );
  });

  await check('a request open on a backend that just crashes still gets a plain 502', async () => {
    // The second backend is `active`, not `draining` — nothing has retired it. Killing it
    // directly is an ordinary crash, and the fix must not have turned every dead socket
    // into a 503: only one retired for a swap earns that reading.
    const parked = get(port, '/api/poll?since=0&wait=20&want=presence', { timeout: 25000 });
    await waitFor('the second request to be counted as open', async () => (await state()).active?.inflight >= 1, 10000);

    process.kill(secondPid, 'SIGKILL');

    const res = await parked;
    assert.equal(res.status, 502, `expected 502, got ${res.status}: ${res.body}`);
    assert.equal(res.headers['x-beadcause-swap-drain'], undefined, 'a crash was answered as if it were a swap drain');
    assert.deepEqual(JSON.parse(res.body), { error: 'backend unreachable' });

    assert.ok(
      routerLog.some((l) => l.includes(`proxy to pid ${secondPid} failed —`) && !l.includes('during drain')),
      'the ordinary crash path never logged its plain message'
    );
  });
} catch (err) {
  failures += 1;
  console.log(`\n  \x1b[31mthe run itself\x1b[0m\n      ${err.stack || err.message}`);
} finally {
  await teardown();
}

if (failures) {
  console.log('\n--- router log ---');
  for (const line of routerLog) console.log(`  ${line}`);
}
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
