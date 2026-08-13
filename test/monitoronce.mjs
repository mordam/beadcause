/**
 * `monitor --once` must come back, even from a daemon that never answers.
 *
 * The long-poll loop in `bin/monitor.js` has always been careful about this: it builds
 * an `AbortController` around every request and arms a forty-second guard on it. The
 * `--once` path — one cold fetch, draw, exit — shared none of that, and for most of a
 * year nobody noticed, because the failure everybody actually has is a daemon that is
 * *not running*. That one refuses the connection, `ECONNREFUSED` comes straight back,
 * and the offline frame draws in milliseconds.
 *
 * The case that costs you is a daemon that completes the TCP handshake and then never
 * writes a response: a router mid-restart, a backend wedged on a lock, an ssh tunnel
 * whose far end has gone. There `--once` blocked with no upper bound at all and no
 * output — which is the worst shape available for the one mode the README advertises for
 * "screenshots, cron, sanity checks", because a cron entry that never returns is a cron
 * entry that stacks up. bc-34ku.
 *
 * `test/monitorwidth.mjs` has been working around this for as long as it has existed:
 * its own comment says the child's fetch has no timeout, which is why it must `spawn`
 * rather than `spawnSync`, and its SIGKILL guard was the only bound on this anywhere.
 *
 * So this suite is the one that asserts the bound itself, and it does it against a real
 * server that behaves exactly that way — `net.createServer` that accepts and says
 * nothing. Three claims:
 *
 *   1. it comes back at all, and cleanly (exit 0, a drawn frame — not a crash);
 *   2. it comes back *because of the timeout* and not by luck, which means bounded
 *      above by the timeout plus a start-up allowance and below by the timeout itself;
 *   3. it says which failure this was. `no answer` is the word the long-poll loop
 *      already uses, and the whole value of it is that a refused connection gets a
 *      different one — so the refusal is driven too, as the control.
 *
 * The bound is read out of `bin/monitor.js` rather than written down here: a suite that
 * hardcodes the number it is testing passes for the wrong reason the day somebody
 * changes it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { freePort, releasePorts } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/* ------------------------------------------------------- the number under test */

const SRC = fs.readFileSync(path.join(ROOT, 'bin', 'monitor.js'), 'utf8');

function constant(name) {
  const m = new RegExp(`const ${name} = (\\d+);`).exec(SRC);
  assert.ok(m, `bin/monitor.js no longer declares ${name} — this suite cannot say what it is asserting`);
  return Number(m[1]);
}

const ONCE_TIMEOUT_MS = constant('ONCE_TIMEOUT_MS');
const POLL_TIMEOUT_MS = constant('POLL_TIMEOUT_MS');

/**
 * How long a `monitor --once` may take on top of its own fetch timeout.
 *
 * Node startup plus module load costs 1.5–3s here on a laptop that is merely busy, and
 * under a full suite run — twenty agent sessions doing the same — that multiplies. This
 * is generous on purpose: the claim is "bounded", and a suite that fails because the
 * machine was loaded would be testing the machine. What it must *not* be is unbounded,
 * which is the thing that was actually wrong.
 */
const OVERHEAD_MS = 45_000;

/* ------------------------------------------------------------ a scratch config */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-monitoronce-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });
// `loadConfig()` reconciles the saved workspace list against `~/beads` on every load, so
// the child gets `tmp` as its HOME too — otherwise the frame reports whichever
// workspaces this Mac happens to have.
fs.mkdirSync(path.join(tmp, 'beads', 'beadcause', '.beads'), { recursive: true });
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    token: 'monitoronce-test-token',
    port: 4318,
    workspaces: [{ name: 'beadcause', dir: path.join(tmp, 'beads', 'beadcause', '.beads') }],
  })
);

/**
 * One `monitor --once`, timed, with a guard far outside anything it should need.
 *
 * The guard is this suite's own backstop and nothing else: if it ever fires, the bound
 * under test is not there, which is exactly the failure — so it is reported as one
 * rather than retried. `spawn` and not `spawnSync`, because the server that is refusing
 * to answer is in *this* process and `spawnSync` would block the event loop that has to
 * hold the socket open.
 */
function once(target) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/monitor.js'), '--once', '--url', target], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR, NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    let killed = false;
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    const guard = setTimeout(
      () => {
        killed = true;
        child.kill('SIGKILL');
      },
      ONCE_TIMEOUT_MS + OVERHEAD_MS + 30_000
    );
    child.on('error', reject);
    child.on('close', (code, signal) => {
      clearTimeout(guard);
      resolve({ code, signal, killed, out, err, ms: Date.now() - started });
    });
  });
}

/* ------------------------------------------------- a daemon that never answers */

// Accepts the connection, reads whatever arrives, and writes nothing, ever. Not a
// simulation of the failure — it *is* the failure, from the client's side.
// Held so teardown can destroy them: `server.close()` stops accepting and waits for the
// live ones, and a socket nobody is going to answer would keep this process up forever.
const stuckSockets = new Set();
const stuck = net.createServer((socket) => {
  socket.resume();
  stuckSockets.add(socket);
  socket.on('close', () => stuckSockets.delete(socket));
});
await new Promise((resolve) => stuck.listen(0, '127.0.0.1', resolve));
const stuckUrl = `http://127.0.0.1:${stuck.address().port}`;

console.log(`bin/monitor.js --once — a daemon that accepts and never answers (${ONCE_TIMEOUT_MS / 1000}s bound)\n`);

const hung = await once(stuckUrl);

await check('it comes back at all', () => {
  assert.equal(
    hung.killed,
    false,
    `monitor --once never returned — this suite's own guard killed it after ${Math.round(hung.ms / 1000)}s, ` +
      'which is the unbounded fetch bc-34ku is about'
  );
  assert.equal(hung.code, 0, hung.signal ? `it died on ${hung.signal}\n${hung.err}` : `it exited ${hung.code}\n${hung.err}`);
});

await check('it comes back because of the timeout, not by luck', () => {
  assert.ok(
    hung.ms >= ONCE_TIMEOUT_MS,
    `it returned after ${hung.ms}ms, sooner than the ${ONCE_TIMEOUT_MS}ms bound — the server never answered, so ` +
      'something else ended the request and this suite is no longer measuring what it says it is'
  );
  assert.ok(
    hung.ms < ONCE_TIMEOUT_MS + OVERHEAD_MS,
    `it took ${Math.round(hung.ms / 1000)}s against a ${ONCE_TIMEOUT_MS / 1000}s bound`
  );
});

await check('it draws a frame and says no answer came', () => {
  const lines = hung.out.split('\n').filter((l) => l.length);
  const top = lines.findIndex((l) => l.startsWith('┌'));
  assert.notEqual(top, -1, `no frame was drawn at all:\n${hung.out}`);
  const frame = lines.slice(top).join('\n');
  // The same two words the long-poll loop uses when its own guard fires. A daemon that
  // took the connection and said nothing is a different diagnosis from one that refused
  // it, and this line is the only place the difference is visible.
  assert.match(frame, /no answer/, `the frame does not say what went wrong:\n${frame}`);
});

/* ------------------------------------------------------------------ the control */

// Nothing is listening here, so the connection is refused rather than accepted. This is
// the common case, it always worked, and it is what makes `no answer` mean something.
//
// A *claimed* free port rather than something conventional like `:1`: a privileged port
// comes back through undici with no `cause.code` at all, so the frame would say `fetch
// failed` and the control would prove nothing about which failure it was. `freePort()`
// is the repo's own answer to "a number nothing is going to take out from under you".
const refusedPort = await freePort();
const refused = await once(`http://127.0.0.1:${refusedPort}`);

await check('a refused connection still says something else, and fast', () => {
  assert.equal(refused.killed, false, 'a refused connection hung, which was never the failure');
  assert.equal(refused.code, 0);
  assert.ok(
    refused.ms < ONCE_TIMEOUT_MS,
    `a refusal took ${refused.ms}ms — as long as a silence, so the frame can no longer tell them apart`
  );
  assert.ok(!/no answer/.test(refused.out), 'a refused connection must not read as a daemon that went quiet');
  assert.match(refused.out, /ECONNREFUSED/, `the refusal is not named in the frame:\n${refused.out}`);
});

/* --------------------------------------------------------------- and the shape */

await check('the one fetch carries a signal', () => {
  // Read, because the two behavioural checks above cannot distinguish "the timeout is
  // armed" from "something else happened to end it at about the right moment". The
  // `--once` block is small enough to name exactly.
  const block = SRC.slice(SRC.indexOf('if (ONCE) {'));
  assert.ok(block.length > 0, 'the --once block has moved');
  const fetchCall = block.slice(0, block.indexOf('draw();'));
  assert.match(
    fetchCall,
    /signal:\s*AbortSignal\.timeout\(ONCE_TIMEOUT_MS\)/,
    'the --once fetch has no signal on it again — it is unbounded, and nothing here will notice at runtime for months'
  );
});

await check('the cold poll is not given the long-poll window', () => {
  // Not a style point. The long poll parks for `wait=25` and forty seconds is the length
  // of a *parked* request; the cold poll asks for a snapshot and gets it at once, so
  // reusing that number would mean forty seconds of a cron entry hanging on a daemon
  // that was never going to answer.
  assert.ok(
    ONCE_TIMEOUT_MS < POLL_TIMEOUT_MS,
    `a cold poll waits ${ONCE_TIMEOUT_MS}ms and a parked one ${POLL_TIMEOUT_MS}ms — the cold one must be the shorter`
  );
});

for (const s of stuckSockets) s.destroy();
stuck.close();
releasePorts();
await cleanupTmp(tmp);

console.log(
  failures
    ? `\n${failures} check(s) failed`
    : `\nall checks passed — silence bounded at ${Math.round(hung.ms / 1000)}s, a refusal answered in ${refused.ms}ms`
);
process.exit(failures ? 1 : 0);
