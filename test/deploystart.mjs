#!/usr/bin/env node
/**
 * A deploy says on the event log that it *started*, and the PR board stops having a clock.
 *
 *     npm test
 *     node test/deploystart.mjs
 *
 * bc-1esd. `settleDeploys` has always emitted `{type: 'deploy'}` when a deploy ends. For
 * a long time that was the only one, and the bill for it landed on the clients: bc-rk2o
 * put every standing view on the delta stream and deleted every wall-clock timer except
 * one — the deploy strip on /prs, which kept asking `/api/deploys` every thirty seconds
 * for as long as a board was open. It was not asking about the deploy it could see. It
 * was asking whether a deploy had begun *somewhere else* — the Ship button on another
 * device, an agent's own `POST /api/deploy`, the release queue shipping itself — because
 * nothing in the log would ever say so.
 *
 * Four things hold that up, and every one of them fails silently:
 *
 * 1. **Starting a deploy emits, through the real route and out of the real `/api/poll`.**
 *    Asserted at the socket rather than against the bus, because an event a client cannot
 *    read is not an event: `/api/poll` is what the phone parks on and what the strip's
 *    wake comes out of.
 *
 * 2. **Every start emits, not just the one with a test.** There are five places in
 *    lib/server.js that begin a deploy — the PR board's Ship, the release queue's Ship,
 *    the delivery card's Ship, `POST /api/deploy`, and the auto-ship the release sweep
 *    runs with nobody pressing anything. A sixth is one `startDeploy(` away, and the
 *    board it forgot to wake would look exactly like a board with nothing to say. So the
 *    source is asserted: one call, inside `beginDeploy`.
 *
 * 3. **One event type carries both halves.** The start and the settle are both
 *    `type: 'deploy'`, told apart by the record's own `status` — `queued` against a
 *    settled word. That is what lets `BOARD_EVENTS` in public/stream.js stay as it is,
 *    and what lets a client tell "started" from "settled" without a second request.
 *
 * 4. **`scheduleDeploys` sets no timeout while nothing is live** — and *does* set one
 *    when there is no stream to wake it. Both directions matter and only one of them is
 *    the feature: a strip that has quietly stopped refreshing looks exactly like a strip
 *    with nothing to say, which is the failure this whole change must not introduce.
 *
 * That last half runs the real `public/prs.js` and the real `public/stream.js` in a vm
 * against a scripted `fetch` and a fake clock, the way test/stream.mjs runs the real
 * stream: a reimplementation of the timer here could pass while the phone shipped
 * something else. Nothing spawns a deploy that touches this checkout — the declared
 * command is `/usr/bin/true` against a temp directory that is not a git repo, so the
 * runner records its own refusal and exits, which is all this suite needs of it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);
const PUBLIC = (name) => path.join(ROOT, 'public', name);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-deploystart-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// lib/deploy.js hangs its journal off it.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createApp, listen } = await import(LIB('server.js'));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/* ==================================================== 1. the daemon says it started */

console.log('what the log says when a deploy begins');

/* A checkout that is not one. The runner fast-forwards `dir` to `origin/<base>` before
   anything else and a directory with no `.git` fails that first step, so the record
   settles itself and nothing here ever runs `true`. What is being tested is the moment
   before the spawn, which is the same moment either way. */
const DEPLOY_DIR = path.join(tmp, 'checkout');
fs.mkdirSync(DEPLOY_DIR, { recursive: true });

const WS = { name: 'beadcause', dir: path.join(tmp, 'ws', '.beads') };
fs.mkdirSync(WS.dir, { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  token: 'test-token',
  bdBin: path.join(tmp, 'bd-that-is-never-called'),
  actor: 'beadcause-test',
  workspaces: [WS],
  spaces: [],
  claudeSessionsDir: path.join(tmp, 'sessions'),
  advocates: { enabled: false, workspaces: [] },
  openSessions: false,
  agents: [],
  ntfy: {},
  deploys: {
    beadcause: { dir: DEPLOY_DIR, base: 'main', command: ['/usr/bin/true'], restarts: false },
  },
};
fs.mkdirSync(cfg.claudeSessionsDir, { recursive: true });

const servers = listen(cfg, createApp(cfg).handler);
const PORT = await boundPort(servers);
const api = (p, init) =>
  fetch(`http://127.0.0.1:${PORT}${p}`, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token, ...(init?.headers || {}) },
  });

await check('a deploy that has just started is on /api/poll, with the record`s own status', async () => {
  // Where the log is *before* the deploy, so the assertion is about this event and not
  // about whatever else the daemon has emitted since it booted.
  const before = await (await api('/api/poll?want=presence')).json();
  assert.ok(Number.isFinite(Number(before.seq)), '/api/poll carries no sequence');

  const started = await api('/api/deploy', {
    method: 'POST',
    body: JSON.stringify({ workspace: 'beadcause', reason: 'test', bead: 'bc-1esd' }),
  });
  const body = await started.json();
  assert.equal(started.status, 200, `the deploy was refused: ${JSON.stringify(body)}`);

  // `since` past the old head, so this answers at once rather than parking.
  const woken = await (await api(`/api/poll?since=${before.seq}&wait=1&want=presence`)).json();
  const events = (woken.events || []).filter((e) => e.type === 'deploy');
  assert.equal(events.length, 1, `expected one deploy event, got ${JSON.stringify(woken.events)}`);
  const ev = events[0];
  assert.equal(ev.id, body.deploy.id, 'the event names a different deploy than the one that started');
  assert.equal(ev.workspace, 'beadcause');
  assert.equal(ev.bead, 'bc-1esd', 'the bead that asked for the deploy is not on the event');
  // The whole of "a client can tell started from settled without a second read": this is
  // a status lib/deploy.js`s LIVE set owns, and a settle emits one it does not.
  assert.equal(ev.status, 'queued', 'a starting deploy must carry a status its runner still owns');
});

await check('a refused deploy announces nothing', async () => {
  const before = await (await api('/api/poll?want=presence')).json();
  // No declaration for this workspace, so `startDeploy` throws before it writes anything.
  const res = await api('/api/deploy', { method: 'POST', body: JSON.stringify({ workspace: 'nope' }) });
  assert.ok(res.status >= 400, 'a deploy for an unknown workspace was accepted');
  await res.json().catch(() => ({}));
  const after = await (await api('/api/poll?want=presence')).json();
  assert.equal(after.seq, before.seq, 'a deploy that never started moved the log');
});

/* --------------------------------------------------- the other four start the same way */

await check('every start in lib/server.js goes through the one place that emits', () => {
  const src = read('lib/server.js');
  const calls = src.match(/(?<!function )\bstartDeploy\(/g) || [];
  // One: inside `beginDeploy`. Everything else — the PR board's Ship, the release
  // queue's, the delivery card's, POST /api/deploy, the auto-ship — calls that.
  assert.equal(
    calls.length,
    1,
    `lib/server.js starts a deploy in ${calls.length} places; every one but beginDeploy's is a deploy nothing is told about`
  );
  const at = src.indexOf('function beginDeploy(');
  assert.ok(at > 0, 'beginDeploy is gone');
  const body = src.slice(at, src.indexOf('\n}', at));
  assert.ok(/startDeploy\(/.test(body), 'the one startDeploy call is not the one inside beginDeploy');
  assert.ok(/bus\.emit\(\{ type: 'deploy'/.test(body), 'beginDeploy no longer emits');
  // Five callers, and a sixth that forgot would be caught by the count above.
  const callers = src.match(/beginDeploy\(/g) || [];
  assert.ok(callers.length >= 6, `only ${callers.length - 1} call sites reach beginDeploy; there were five`);
});

await check('the start and the settle are the same event type, so no list of names had to grow', () => {
  const src = read('lib/server.js');
  const emits = src.match(/type: 'deploy[^']*'/g) || [];
  assert.deepEqual([...new Set(emits)], ["type: 'deploy'"], 'a second deploy event type appeared');
  assert.equal(emits.length, 2, `expected exactly two deploy emits (the start and the settle), got ${emits.length}`);
  // The client-side list this depends on. A `deploy` that is not in it is an event no
  // board ever acts on.
  assert.ok(/BOARD_EVENTS = \[[^\]]*'deploy'/.test(read('public/stream.js')), "'deploy' is not in BOARD_EVENTS");
});

for (const server of servers) server.close();

/* ================================================== 2. the board with no clock on it */

console.log('\nwhat the strip does about it');

/**
 * The real /prs script, in a vm, with a fake clock and a scripted `fetch`.
 *
 * The technique is test/spacebar.mjs's: stub the handful of nodes the page reaches for
 * and let the real file run. Two things are specific to this suite — `setTimeout` and
 * `clearTimeout` are captured rather than real, because the assertion *is* about which
 * timers exist; and `/api/poll` is answered by a promise the test holds, because a
 * parked poll is the state the strip is supposed to have no clock in.
 */
function board({ stream = true, deploys = [] } = {}) {
  const timers = new Map();
  let nextTimer = 0;
  /** Resolvers for the parked polls, oldest first. */
  const polls = [];
  const asked = [];
  let seq = 1;

  const node = (id) => ({
    id,
    innerHTML: '',
    hidden: false,
    value: '',
    listeners: {},
    addEventListener(type, fn) {
      this.listeners[type] = fn;
    },
    // Null on purpose: every partial-repaint path in these pages falls back to a full
    // render when the block it wanted is not there, which is what puts the settled state
    // into innerHTML where it can be asserted.
    querySelector: () => null,
    classList: { add() {}, remove() {}, toggle() {} },
  });
  const nodes = new Map([
    ['prs', node('prs')],
    ['pulse', node('pulse')],
    ['observing', node('observing')],
    // The page's one ⟳, shared with the two panes beside the board since it became one
    // (bc-d4d5) — it was `#prs-refresh` while the board was a page of its own.
    ['refresh', node('refresh')],
  ]);

  const fetchStub = async (url) => {
    asked.push(String(url));
    const ok = (body) => ({ ok: true, status: 200, json: async () => body });
    if (String(url).startsWith('/api/prs')) return ok({ repos: [], observing: false, counts: {} });
    if (String(url).startsWith('/api/deploys')) return ok({ deploys: state.deploys, deployable: [] });
    if (String(url).startsWith('/api/poll')) {
      return new Promise((resolve) => polls.push((body) => resolve(ok(body))));
    }
    throw new Error(`unscripted fetch: ${url}`);
  };

  const state = { deploys };
  const window = { beadcause: {}, scrollY: 0, scrollTo() {} };
  const ctx = vm.createContext({
    window,
    document: {
      getElementById: (id) => nodes.get(id) || null,
      addEventListener() {},
      hidden: false,
    },
    localStorage: { getItem: () => 'test-token', setItem() {} },
    setTimeout: (fn, ms) => {
      nextTimer += 1;
      timers.set(nextTimer, { fn, ms });
      return nextTimer;
    },
    clearTimeout: (id) => timers.delete(id),
    URLSearchParams,
    // Host objects, not realm intrinsics: public/stream.js aborts its parked request
    // when the page goes away, and without this the very first poll throws and every
    // assertion below would be about a stream that never started.
    AbortController,
    fetch: fetchStub,
    JSON,
    console,
  });
  vm.runInContext(fs.readFileSync(PUBLIC('prcard.js'), 'utf8'), ctx, { filename: 'prcard.js' });
  if (stream) vm.runInContext(fs.readFileSync(PUBLIC('stream.js'), 'utf8'), ctx, { filename: 'stream.js' });
  vm.runInContext(fs.readFileSync(PUBLIC('prs.js'), 'utf8'), ctx, { filename: 'prs.js' });

  return {
    timers,
    asked,
    /** Answer the oldest parked poll with these events, and let the page act on it. */
    async wake(events) {
      const answer = polls.shift();
      assert.ok(answer, 'nothing was parked on /api/poll');
      answer({ seq: (seq += 1), events });
      await settle();
    },
    /**
     * Answer it the way something that keeps no log does — a `seq` that is *absent*
     * rather than zero. public/stream.js ends the loop on that rather than busy-looping,
     * which is exactly the case the strip's fallback exists for.
     */
    async wakeWithoutALog() {
      const answer = polls.shift();
      assert.ok(answer, 'nothing was parked on /api/poll');
      answer({ events: [] });
      await settle();
    },
    parked: () => polls.length,
    set: (rows) => {
      state.deploys = rows;
    },
    /** Every timer waiting, as plain milliseconds — the whole subject of this half. */
    waits: () => [...timers.values()].map((t) => t.ms),
    fire: async (ms) => {
      for (const [id, t] of timers) {
        if (t.ms !== ms) continue;
        timers.delete(id);
        t.fn();
        break;
      }
      await settle();
    },
  };
}

/** The un-awaited async boot, run out. Bounded rather than timed — there is no clock. */
const settle = async () => {
  for (let i = 0; i < 50; i += 1) await new Promise((r) => setImmediate(r));
};

const LIVE_MS = 4000;
const IDLE_MS = 30000;
const running = [{ id: 'd-1', workspace: 'beadcause', status: 'deploying', restarts: true, requestedAt: new Date().toISOString(), steps: [] }];
const done = [{ id: 'd-1', workspace: 'beadcause', status: 'ok', restarts: true, requestedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), steps: [] }];

await check('the acceptance criterion: an idle board holds a socket and sets no timeout', async () => {
  const b = board({ deploys: [] });
  await settle();
  assert.ok(b.asked.some((u) => u.startsWith('/api/deploys')), 'the strip never asked for the journal at all');
  assert.equal(b.parked(), 1, 'the board is not parked on the log');
  assert.deepEqual(b.waits(), [], `the strip is still on a clock: ${JSON.stringify(b.waits())}`);
});

await check('a deploy started somewhere else lights the strip, off the event and nothing else', async () => {
  const b = board({ deploys: [] });
  await settle();
  const before = b.asked.length;
  // The event the daemon now emits at the start. Its `status` is one the runner still
  // owns, which is how the page knows it is watching rather than reading history.
  b.set(running);
  await b.wake([{ type: 'deploy', id: 'd-1', workspace: 'beadcause', status: 'queued', seq: 2 }]);
  assert.ok(
    b.asked.slice(before).some((u) => u.startsWith('/api/deploys')),
    'the strip did not go and read the journal when the log said a deploy had begun'
  );
  // And now — and only now — it has a clock, because the steps inside a deploy are a
  // file being written and no event carries them.
  assert.deepEqual(b.waits(), [LIVE_MS], `expected the fast tick, got ${JSON.stringify(b.waits())}`);
});

await check('and puts the clock away again when it settles', async () => {
  const b = board({ deploys: running });
  await settle();
  assert.deepEqual(b.waits(), [LIVE_MS], 'a live deploy is not being watched');
  b.set(done);
  await b.fire(LIVE_MS);
  assert.deepEqual(b.waits(), [], `the strip kept a clock after the deploy ended: ${JSON.stringify(b.waits())}`);
});

await check('a page with no stream behind it keeps the idle tick — the failure this must not have', async () => {
  // An older service-worker shell: the HTML cached before stream.js existed, or a proxy
  // that answers /api/poll and keeps no log. Nothing will ever wake this page.
  const b = board({ stream: false, deploys: [] });
  await settle();
  assert.deepEqual(b.waits(), [IDLE_MS], `a board with nothing to wake it stopped refreshing: ${JSON.stringify(b.waits())}`);
});

await check('a stream that stops following puts the idle tick back', async () => {
  const b = board({ deploys: [] });
  await settle();
  assert.deepEqual(b.waits(), [], 'the page did not start out parked and clockless');
  await b.wakeWithoutALog();
  assert.deepEqual(
    b.waits(),
    [IDLE_MS],
    `the stream ended and the strip did not fall back to its own clock: ${JSON.stringify(b.waits())}`
  );
});

console.log(`\n${ran - failures}/${ran} ok\n`);
process.exit(failures ? 1 : 0);
