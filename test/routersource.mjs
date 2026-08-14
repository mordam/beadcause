/**
 * A stale *router* has to reach a screen — it is the one degraded state that never
 * clears itself.
 *
 * Everything else bin/router.js can be wrong about resolves on its own: a stale build
 * swaps in seconds, a deferred one is retried on the clock, a poisoned one clears the
 * moment the files move. The router's own source is different in kind, because the
 * router cannot replace itself while it owns the socket — so once `bin/router.js`,
 * `lib/build.js`, `lib/config.js` or `lib/service.js` moves under a running process,
 * that process stays on the old code until somebody restarts the daemon by hand.
 *
 * It had two surfaces, and neither is a place anybody stands: one line in launchd's log
 * at the moment it happens, and a marker on the router line of `npm run swap:status`,
 * which nothing runs on a schedule. So bc-b4fs shipped a fix for a stopped Tailscale,
 * merged, deployed — and did not run on this Mac for a day, while the console's health
 * line showed a green ✓ naming a build that really was current. It was naming the
 * *backend's* build. That is bc-0i27.16, and this suite is the third surface.
 *
 * Four claims, in the order the fact travels:
 *
 *   1. `explain()` has a verdict for it (arithmetic, no I/O — lib/startup.js's rule);
 *   2. it does not displace anything more urgent, and does not survive being fixed;
 *   3. `--status` and `routerHealth` both carry it out of the router process;
 *   4. the console draws it as its own headline, because the one it would otherwise
 *      have borrowed — "THE PHONE IS ON AN OLDER BUILD" — is false here.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-routersource-'));
// Before lib/config.js is reached: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { explain } = await import(path.join(ROOT, 'lib', 'startup.js'));
const { routerHealth } = await import(path.join(ROOT, 'lib', 'service.js'));

const MONITOR = fs.readFileSync(path.join(ROOT, 'public', 'monitor.js'), 'utf8');
const ROUTER_SRC = fs.readFileSync(path.join(ROOT, 'bin', 'router.js'), 'utf8');

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}
const done = () => {
  removeTreeSync(tmp);
  console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} passed`);
  process.exit(failures ? 1 : 0);
};

const RESTART = 'launchctl kickstart -k gui/501/m4m.beadcause';

/** A snapshot the router would publish: healthy in every way but the one asked for. */
const snapshot = (router = {}, rest = {}) => ({
  router: { pid: 4242, port: 4318, build: 'r-1', sourceChanged: false, restart: RESTART, ...router },
  disk: 'b-1',
  stale: false,
  swapping: false,
  poisoned: null,
  deferred: null,
  serving: true,
  outage: null,
  retryAt: 0,
  slowness: 0,
  active: { pid: 4243, port: 49223, build: 'b-1', role: 'primary', reaping: true, inflight: 0, upgrades: 0, upSeconds: 90 },
  retiring: [],
  ...rest,
});

console.log('a router older than its own source');

/* ------------------------------------------------------------------- the rule */

await check('a healthy router with a moved source is not ok, and says which half is old', () => {
  const v = explain(snapshot({ sourceChanged: true }));
  assert.equal(v.ok, false, 'a router running code nobody shipped reported itself healthy');
  assert.equal(v.code, 'router-source');
  const said = [v.summary, ...v.lines].join(' ');
  // The distinction the whole verdict exists to make: the backend is current, the
  // process in front of it is not. A sentence that only said "older build" would be
  // read as the swap having failed, which is the one thing that has not happened.
  assert.match(said, /router/i);
  assert.match(v.summary, /b-1/, 'the build being served is not named');
});

await check('it says a swap will not help, because a swap is what you would try', () => {
  const v = explain(snapshot({ sourceChanged: true }));
  const said = [v.summary, ...v.lines].join(' ');
  assert.match(said, /swap will not/i, 'nothing warns off `npm run swap`, which is one tap away and useless here');
  assert.equal(v.fix, RESTART, 'the fix is not the restart the router named');
  assert.ok(
    v.lines.some((l) => l.includes(RESTART)),
    'the command is in `fix` but not in the lines, so the log and the 503 lose it'
  );
});

await check('a router too old to name its own restart still gets the verdict', () => {
  // `restart` arrived with this bead. A page talking to a router that predates it must
  // get the diagnosis without the command, rather than a verdict with `fix: undefined`
  // rendered into a `<code>` block as the word.
  const v = explain(snapshot({ sourceChanged: true, restart: undefined }));
  assert.equal(v.code, 'router-source');
  assert.equal(v.fix, null, 'an absent command came through as something other than null');
  assert.match(v.lines.join(' '), /restart/i, 'the verdict no longer says to restart anything');
});

await check('and a router that matches its source is simply serving', () => {
  const v = explain(snapshot());
  assert.equal(v.ok, true);
  assert.equal(v.code, 'serving');
});

/* ------------------------------------------------------- and what it must not do */

await check('everything more urgent still wins, because those are about the phone', () => {
  // Each of these is a state the *backend* is in, and each of them means the phone is
  // being served something other than the current build — which outranks a router that
  // is serving correctly out of old code. The flag stays true underneath; see the
  // passthrough check below, which is why it is sent as a field of its own.
  const stale = explain(snapshot({ sourceChanged: true }, { stale: true }));
  assert.equal(stale.code, 'stale');

  const poisoned = explain(snapshot({ sourceChanged: true }, { poisoned: 'b-1' }));
  assert.equal(poisoned.code, 'poisoned');

  const deferred = explain(
    snapshot({ sourceChanged: true }, { deferred: { build: 'b-1', attempts: 2, until: Date.now() + 5000 } })
  );
  assert.equal(deferred.code, 'retrying');

  const nothing = explain(snapshot({ sourceChanged: true }, { active: null, serving: false, retryAt: Date.now() + 2000 }));
  assert.equal(nothing.code, 'no-backend');
});

/* --------------------------------------------------- out of the router process */

/**
 * A stub control plane on a real socket, answering `/internal/router/state` and nothing
 * else — which is the whole of what both readers below ask for. No backend is spawned
 * and port 4318 is never touched, so the case under test is a fixture rather than
 * whatever this Mac's daemon happens to be doing right now.
 */
async function withStub(snap, fn) {
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith('/internal/router/state')) return res.writeHead(404).end('{}');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(snap));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await fn(server.address().port);
  } finally {
    server.close();
  }
}

await check('routerHealth carries the verdict and the flag to the console payload', async () => {
  const health = await withStub(snapshot({ sourceChanged: true }), (port) =>
    routerHealth({ port, token: 'stub-token' })
  );
  assert.ok(health, 'routerHealth answered null against a router that replied');
  assert.equal(health.ok, false);
  assert.equal(health.code, 'router-source');
  assert.equal(health.fix, RESTART);
  assert.equal(health.sourceChanged, true);
  // And the fact survives the verdict being about something else, which is the reason
  // it is a field rather than only a code.
  const masked = await withStub(snapshot({ sourceChanged: true }, { poisoned: 'b-1' }), (port) =>
    routerHealth({ port, token: 'stub-token' })
  );
  assert.equal(masked.code, 'poisoned');
  assert.equal(masked.sourceChanged, true, 'the router being stale vanished behind a poisoned build');
});

await check('a router too old to carry the field is not reported as broken', async () => {
  const old = snapshot();
  delete old.router.sourceChanged;
  const health = await withStub(old, (port) => routerHealth({ port, token: 'stub-token' }));
  assert.equal(health.sourceChanged, false, 'a missing field became a problem the daemon invented');
  assert.equal(health.ok, true);
});

await check('`npm run swap:status` prints the block, not just the marker on one line', async () => {
  const out = await withStub(snapshot({ sourceChanged: true }), async (port) => {
    const dir = fs.mkdtempSync(path.join(tmp, 'cfg-'));
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ port, token: 'stub-token', tls: { enabled: false } }));
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(ROOT, 'bin', 'router.js'), '--status'], {
        env: { ...process.env, BEADCAUSE_CONFIG_DIR: dir },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (c) => (stdout += c));
      child.stderr.on('data', (c) => (stderr += c));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  });
  assert.equal(out.code, 0, `exit ${out.code}: ${out.stderr}`);
  // The marker was always there. What is new is the verdict underneath it, in the same
  // words the console gets — the marker alone is four words at the end of a line that
  // is mostly a pid, and it is what everybody has been not-reading.
  assert.match(out.stdout, /⚠ source changed — restart it/);
  assert.match(out.stdout, /router in front of it is older/);
  assert.match(out.stdout, new RegExp(RESTART.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

await check('the snapshot the real router publishes names the restart command', () => {
  // A source read, because the alternative is spawning a router that binds 4318. Sliced
  // between two declarations rather than by an offset, and with a sanity assert that the
  // slice is still the right region — see the note on static reads: a fixed window goes
  // red on a line added above it and reads as the field having been deleted.
  const at = ROUTER_SRC.indexOf('function snapshot()');
  assert.notEqual(at, -1, 'bin/router.js no longer declares `snapshot()`');
  const rest = ROUTER_SRC.slice(at + 1);
  const end = rest.search(/\n(?:async )?function /);
  const block = rest.slice(0, end === -1 ? rest.length : end);
  assert.match(block, /sourceChanged/, 'the slice is no longer the snapshot — fix the anchors, not the assert');
  assert.match(block, /restart:/, 'the snapshot stopped carrying the restart command, so every reader loses the fix');
});

/* ------------------------------------------------------------- and on the page */

/** Slice one function out of a page and run it, rather than grepping its source. */
function lift(src, opener) {
  const at = src.indexOf(opener);
  assert.notEqual(at, -1, `public/monitor.js no longer declares \`${opener}\``);
  if (opener.startsWith('function')) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (!depth) return src.slice(at, i + 1);
      }
    }
    throw new Error(`unbalanced braces after ${opener}`);
  }
  let depth = 0;
  for (let i = at; i < src.length; i += 1) {
    const c = src[i];
    if (c === '{' || c === '(' || c === '[') depth += 1;
    else if (c === '}' || c === ')' || c === ']') depth -= 1;
    else if (c === ';' && depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`no statement end after ${opener}`);
}

/** `routerHtml` for real. It touches no DOM — `esc` is the whole of what it borrows. */
function renderRouter(health) {
  const context = vm.createContext({ String, Object });
  vm.runInContext(
    [lift(MONITOR, 'const esc = ('), lift(MONITOR, 'function routerHtml(r)'), 'globalThis.out = routerHtml(R);'].join('\n'),
    Object.assign(context, { R: health })
  );
  return context.out;
}

await check('the console draws its own headline for it, and its own verb', () => {
  const html = renderRouter({
    ok: false,
    code: 'router-source',
    summary: 'serving build b-1, but the router in front of it is older than its own source',
    detail: 'a swap will not clear it.',
    fix: RESTART,
    serving: true,
    sourceChanged: true,
    disk: 'b-1',
  });
  assert.match(html, /THE ROUTER IS RUNNING OLDER CODE/);
  // The headline it must NOT borrow. The phone is on the current build here; saying
  // otherwise sends whoever reads it to `npm run swap`, which cannot fix this.
  assert.doesNotMatch(html, /THE PHONE IS ON AN OLDER BUILD/);
  assert.doesNotMatch(html, /force it/, 'the swap verb survived onto a state a swap cannot clear');
  assert.match(html, /restart it/);
  assert.match(html, new RegExp(RESTART.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

await check('and the two headlines it used to have are still the ones it draws', () => {
  const stale = renderRouter({ ok: false, code: 'poisoned', summary: 's', detail: '', fix: 'npm run swap', serving: true, disk: 'b-1' });
  assert.match(stale, /THE PHONE IS ON AN OLDER BUILD/);
  assert.match(stale, /force it/);

  const out = renderRouter({ ok: false, code: 'no-backend', summary: 's', detail: '', fix: 'npm run swap', serving: false, disk: 'b-1' });
  assert.match(out, /NOTHING IS BEING SERVED/);

  // And a healthy one is still one dim line rather than the block.
  const fine = renderRouter({ ok: true, code: 'serving', build: 'b-1', pid: 4243, disk: 'b-1' });
  assert.match(fine, /svc ok/);
  assert.doesNotMatch(fine, /⚠/);
});

done();
