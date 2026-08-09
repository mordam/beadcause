#!/usr/bin/env node
/**
 * Proof that a swap is seamless — `npm test`.
 *
 * The claim bin/router.js makes is a strong one: you can edit `lib/` and the phone
 * will not notice. That is not something to take on faith, so this drives a real
 * router, on a real port, with a real backend under it, and swaps it while a client
 * is hammering it and another is parked on a long poll. If any of those requests
 * fails, the claim is false.
 *
 * Hermetic by construction: a scratch `BEADCAUSE_CONFIG_DIR`, an ephemeral port,
 * ntfy off, advocates off, and `bd` pointed at a stub that prints `[]`. Nothing here
 * reads a real workspace, opens a session, or sends a notification.
 *
 * One path is **not** covered, on purpose: a build that fails to start. Proving it
 * means leaving a syntax error in a tracked file for ten seconds, and a test that is
 * interrupted at the wrong moment would leave the checkout broken — too sharp an
 * edge to keep in a repo for a path this simple. Verify it by hand instead:
 * append rubbish to `lib/notify.js`, watch the log say `could not bring up build …`
 * once and only once, confirm the port is still answering from the old pid, then put
 * the file back and watch it swap on its own.
 */
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-not-a-secret';

let failures = 0;
const ok = (name) => console.log(`  [32m✓[0m ${name}`);
const bad = (name, detail) => {
  failures++;
  console.log(`  [31m✗[0m ${name}${detail ? `\n      ${detail}` : ''}`);
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

/** One request through the router, resolving with status, headers and body. */
function get(port, pathname, { timeout = 70000, token = TOKEN } = {}) {
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

async function waitFor(label, fn, ms = 30000) {
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

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ------------------------------------------------------------------ the sandbox

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-swap-'));
const stubBd = path.join(dir, 'bd');
fs.writeFileSync(stubBd, '#!/bin/sh\necho "[]"\n', { mode: 0o755 });

const port = await freePort();
fs.writeFileSync(
  path.join(dir, 'config.json'),
  JSON.stringify(
    {
      port,
      // Loopback only: the router would otherwise also bind the tailnet address,
      // and a test has no business being reachable from another machine.
      host: '127.0.0.1',
      baseUrl: `http://127.0.0.1:${port}`,
      token: TOKEN,
      bdBin: stubBd,
      actor: 'beadcause-test',
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
const routerLog = [];
const router = spawn(process.execPath, [path.join(ROOT, 'bin', 'router.js')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
for (const stream of [router.stdout, router.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    for (const line of chunk.split('\n')) if (line.trim()) routerLog.push(line);
  });
}

// Whatever happens below, do not leave a router and two node backends running.
const spawned = new Set();
const cleanup = () => {
  for (const pid of spawned) if (alive(pid)) try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  if (!router.killed) router.kill('SIGKILL');
  fs.rmSync(dir, { recursive: true, force: true });
};
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// A file whose mtime we move to fake an edit. Content is never touched, so the
// checkout is left exactly as it was — the build stamp is size+mtime, and mtime
// alone is a real edit as far as it is concerned.
const victim = path.join(ROOT, 'lib', 'notify.js');
const original = fs.statSync(victim);

try {
  console.log(`\nblue/green swap — router on :${port}, config in ${dir}\n`);

  // --------------------------------------------------------------- it comes up

  const first = await waitFor('the router to serve /api/health', async () => {
    const res = await get(port, '/api/health');
    return res.status === 200 ? res : null;
  });
  check(true, 'router binds the port and serves a backend');

  const build1 = first.headers['x-beadcause-build'];
  const pid1 = Number(first.headers['x-beadcause-pid']);
  spawned.add(pid1);
  check(Boolean(build1) && build1 !== 'unknown', 'every response says which build answered', `x-beadcause-build: ${build1}`);
  check(alive(pid1), 'the backend it names is a live process', `pid ${pid1}`);

  const state1 = JSON.parse((await get(port, `/internal/router/state?t=${TOKEN}`)).body);
  check(state1.active?.role === 'active', 'the backend is active, so exactly one poller is running', `role: ${state1.active?.role}`);
  check(state1.active?.reaping === true, 'and one terminal reaper, on the active backend', `reaping: ${state1.active?.reaping}`);
  check(state1.retiring.length === 0, 'nothing is draining yet');
  check(state1.stale === false, 'the router agrees the running build matches disk');

  // A backend must not be reachable except through the router: it binds loopback
  // only, and its control plane must not be proxyable from outside.
  const leaked = await get(port, `/internal/state?t=${TOKEN}`);
  check(leaked.status === 404, 'a backend control path is not proxyable through the router', `got ${leaked.status}`);
  const unauthed = await get(port, '/internal/router/state', { token: null });
  check(unauthed.status === 403, 'the router control plane refuses an unauthenticated call', `got ${unauthed.status}`);
  const wrongToken = await get(port, '/internal/router/swap', { token: 'wrong' });
  check(wrongToken.status === 403, 'and one holding the wrong token', `got ${wrongToken.status}`);

  // ------------------------------------------------- swap under continuous load

  // Two clients that must not notice anything: one hammering, one parked on the
  // long poll the phone actually uses.
  let stopHammer = false;
  const hammerErrors = [];
  let hammerCount = 0;
  const hammer = (async () => {
    while (!stopHammer) {
      try {
        const res = await get(port, '/api/health', { timeout: 10000 });
        hammerCount++;
        if (res.status !== 200) hammerErrors.push(`status ${res.status}`);
      } catch (err) {
        hammerErrors.push(err.message);
      }
      await sleep(25);
    }
  })();

  const longPoll = get(port, `/api/poll?since=1&wait=20&t=${TOKEN}`).then(
    (res) => ({ res }),
    (err) => ({ err })
  );

  // Let both settle into flight before anything moves.
  await sleep(500);

  const now = new Date();
  fs.utimesSync(victim, now, now);
  console.log('\n  … touched lib/notify.js — a swap should follow on its own\n');

  const swapped = await waitFor('the router to swap onto the new build', async () => {
    const res = await get(port, '/api/health');
    const pid = Number(res.headers['x-beadcause-pid']);
    return pid && pid !== pid1 ? res : null;
  });
  const pid2 = Number(swapped.headers['x-beadcause-pid']);
  const build2 = swapped.headers['x-beadcause-build'];
  spawned.add(pid2);

  check(pid2 !== pid1, 'a file changing on disk swaps the backend with no prompting', `${pid1} → ${pid2}`);
  check(build2 !== build1, 'the new backend reports a different build', `${build1} → ${build2}`);

  const longPollResult = await longPoll;
  check(!longPollResult.err, 'a long poll held across the cutover is not cut off', longPollResult.err?.message);
  check(longPollResult.res?.status === 200, 'and it answers 200', `status ${longPollResult.res?.status}`);

  stopHammer = true;
  await hammer;
  check(hammerErrors.length === 0, `${hammerCount} requests spanning the swap all succeeded`, hammerErrors.slice(0, 3).join('; '));

  // ----------------------------------------------------- the old one is drained

  // Longer than the router's own drain deadline: it waits out a parked long poll
  // before killing a superseded backend, and ours was parked for 20 seconds.
  const gone = await waitFor('the superseded backend to be stopped', async () => !alive(pid1), 70000).then(
    () => true,
    () => false
  );
  check(gone, 'the superseded backend is stopped once it has drained', `pid ${pid1} is still alive`);

  const state2 = JSON.parse((await get(port, `/internal/router/state?t=${TOKEN}`)).body);
  check(state2.active?.pid === pid2, 'the router is serving the new backend', `active pid ${state2.active?.pid}`);
  check(state2.active?.role === 'active', 'which has been promoted, so a poller is running again');
  check(state2.active?.reaping === true, 'and is sweeping terminals again', `reaping: ${state2.active?.reaping}`);
  check(state2.retiring.length === 0, 'and nothing is left draining', JSON.stringify(state2.retiring));
  check(state2.stale === false, 'the running build matches disk again');

  // ---------------------------------------------------------- an explicit swap

  const swapOut = await run([path.join(ROOT, 'bin', 'router.js'), '--swap'], env);
  check(swapOut.code === 0, '`router.js --swap` forces a swap and exits 0', swapOut.out);
  const afterSwap = await get(port, '/api/health');
  const pid3 = Number(afterSwap.headers['x-beadcause-pid']);
  spawned.add(pid3);
  check(pid3 !== pid2, 'even with nothing changed on disk', `${pid2} → ${pid3}`);

  const statusOut = await run([path.join(ROOT, 'bin', 'router.js'), '--status'], env);
  check(statusOut.code === 0 && /active\s+pid/.test(statusOut.out), '`router.js --status` reports what is running', statusOut.out);

  // ------------------------------------------------ a standby sweeps nothing

  // Driven directly rather than through the router, because the window where a
  // standby exists during a real swap is measured in milliseconds and this is not
  // a race worth reproducing. The invariant is what matters: a standby has no
  // poller *and* no terminal reaper. The reaper is the sharper of the two —
  // `reapTerminals` calls `closeTerminal` on any terminal past the idle window
  // with nobody attached, and on a `resumable` one that writes `exited` to the
  // record on disk. A standby sees no clients on anything, ever, because the
  // router sends it no traffic, so a standby left sweeping would eventually mark
  // the active backend's live terminals as ended in a file they both write.
  //
  // Nothing here can be caught by waiting: the idle window is 30 minutes.
  const standbyPort = await freePort();
  const standby = spawn(
    process.execPath,
    [path.join(ROOT, 'bin', 'beadcause.js'), '--port', String(standbyPort), '--standby'],
    { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'ignore'] }
  );
  spawned.add(standby.pid);

  const standbyState = await waitFor('the standby backend to answer', async () => {
    const res = await get(standbyPort, `/internal/state?t=${TOKEN}`, { timeout: 2000 });
    return res.status === 200 ? JSON.parse(res.body) : null;
  }, 15000);
  check(standbyState.role === 'standby', 'a --standby backend starts as the understudy', `role: ${standbyState.role}`);
  check(standbyState.reaping === false, 'and sweeps no terminals while it waits', `reaping: ${standbyState.reaping}`);

  // A terminal record that appears *after* this backend read the directory, which
  // is the whole case for restoring again at promotion: a standby can wait a long
  // time, and everything the outgoing backend did to a terminal in that window is
  // invisible to a list read at startup.
  const terminalsDir = path.join(dir, 'terminals');
  fs.mkdirSync(terminalsDir, { recursive: true });
  const lateId = 'bbbbbbbbbbbbbbb1';
  fs.writeFileSync(
    path.join(terminalsDir, `${lateId}.json`),
    JSON.stringify({
      id: lateId,
      workspace: 'beadcause',
      dir: '/tmp/late',
      bead: { id: 'bc-late', title: 'Written while the standby waited' },
      cols: 100,
      rows: 30,
      claudeSessionId: '11111111-2222-3333-4444-555555555555',
      status: 'live',
      startedAt: new Date(Date.now() - 60000).toISOString(),
      endedAt: null,
      exitCode: null,
      exitSignal: null,
      resumedAt: null,
      savedAt: new Date().toISOString(),
    })
  );

  const beforePromote = JSON.parse((await get(standbyPort, `/api/terminals?t=${TOKEN}`, { timeout: 5000 })).body);
  const listed = (payload) => (payload.terminals ?? payload).some?.((t) => t.id === lateId) ?? false;
  check(!listed(beforePromote), 'a record written while it waits is not in the standby list yet', JSON.stringify(beforePromote).slice(0, 120));

  const promoted = JSON.parse((await get(standbyPort, `/internal/activate?t=${TOKEN}`, { timeout: 5000 })).body);
  check(promoted.role === 'active', 'promoting it makes it active', `role: ${promoted.role}`);
  const afterPromote = JSON.parse((await get(standbyPort, `/internal/state?t=${TOKEN}`, { timeout: 2000 })).body);
  check(afterPromote.reaping === true, 'and starts the reaper it was withholding', `reaping: ${afterPromote.reaping}`);
  const afterList = JSON.parse((await get(standbyPort, `/api/terminals?t=${TOKEN}`, { timeout: 5000 })).body);
  check(listed(afterList), 'and re-reads the terminal directory, so the late record is offered', JSON.stringify(afterList).slice(0, 160));

  await get(standbyPort, `/internal/standby?t=${TOKEN}`, { timeout: 5000 });
  const afterStandDown = JSON.parse((await get(standbyPort, `/internal/state?t=${TOKEN}`, { timeout: 2000 })).body);
  check(afterStandDown.reaping === false, 'standing it down again stops the reaper', `reaping: ${afterStandDown.reaping}`);
  standby.kill('SIGKILL');

  // --------------------------------------------------------- it survives a crash

  process.kill(pid3, 'SIGKILL');
  const recovered = await waitFor('the router to replace a killed backend', async () => {
    const res = await get(port, '/api/health');
    const pid = Number(res.headers['x-beadcause-pid']);
    return res.status === 200 && pid && pid !== pid3 ? pid : null;
  });
  spawned.add(recovered);
  check(true, 'killing the backend outright brings a replacement up', `${pid3} → ${recovered}`);

  // ------------------------------------------------------------- and shuts down

  router.kill('SIGTERM');
  const shutdown = await waitFor('the router to exit', async () => router.exitCode !== null || router.signalCode, 10000).then(
    () => true,
    () => false
  );
  check(shutdown, 'the router exits on SIGTERM');
  const childGone = await waitFor('the backend to go with it', async () => !alive(recovered), 10000).then(
    () => true,
    () => false
  );
  check(childGone, 'and takes its backend with it, leaving no orphan poller', `pid ${recovered} survived`);
} catch (err) {
  bad('the run itself', err.stack || err.message);
} finally {
  fs.utimesSync(victim, original.atime, original.mtime);
}

if (failures) {
  console.log('\n--- router log ---');
  for (const line of routerLog) console.log(`  ${line}`);
}
console.log(failures ? `\n[31m${failures} check(s) failed[0m\n` : '\n[32mall checks passed[0m\n');
process.exit(failures ? 1 : 0);

/** Run one of the CLI modes and collect what it printed. */
function run(argv, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, argv, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c));
    child.stderr.on('data', (c) => (out += c));
    child.on('exit', (code) => resolve({ code, out: out.trim() }));
  });
}
