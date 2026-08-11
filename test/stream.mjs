#!/usr/bin/env node
/**
 * The delta stream — one parked request per document, shared by every standing view.
 *
 *     npm test
 *     node test/stream.mjs
 *
 * `public/stream.js` is app.js's long-poll lifted out so the other four views can mount
 * it instead of each growing its own. That makes it worth a suite it never had while it
 * was one page's private loop: five views are about to depend on it, and every way it
 * can break is a view that looks completely normal and has silently stopped updating.
 *
 * What is checked, and why each one is the invisible kind of failure:
 *
 * 1. **The place in the log.** `seq` is where the payload on screen was true. Poll from
 *    the wrong one and you either re-fetch what you have or skip what you missed —
 *    neither shows on screen. Nothing parks from a place we do not have, because a
 *    `since=0` park can never be answered.
 *
 * 2. **One request, restarted.** Two overlapping parks double the daemon's held sockets
 *    per view, which on five views is the whole cost this was meant to remove.
 *
 * 3. **A quiet poll is not an empty inbox.** `questions: null` means the park timed out;
 *    `[]` means there is nothing to show. A consumer that confused them would blank the
 *    pane every quiet minute, so the module hands both through untouched and the view
 *    decides.
 *
 * 4. **Every failure falls back rather than stopping.** The one thing that must never
 *    happen is a view that has quietly gone deaf. A broken poll drops the place and the
 *    clock takes over; a refusal the page is already handling keeps it.
 *
 * 5. **Exactly one of the two is ever live.** A park and a clock at once is a `bd` sweep
 *    per tick on top of the stream, which is worse than the timer it replaced.
 *
 * 6. **A dark screen parks nothing.** A phone in a pocket holding a socket open all
 *    night is invisible from the screen — and coming back picks up from where it was.
 *
 * The real `public/stream.js` runs in a vm with a hand-made `document`, the way
 * test/warm.mjs runs the real warm layer: a test-only rewrite of this logic could pass
 * while the phone shipped something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

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
    console.log(`      ${err.message}`);
  }
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ the room */

/**
 * The real file, in a room with the two things it touches at load: a `window` to hang
 * itself off, and a `document` it can ask whether the screen is dark and register a
 * listener on. The listeners are kept so a test can raise `visibilitychange` itself —
 * that event is the module's entire waking behaviour and there is no other way in.
 */
function load({ hidden = false } = {}) {
  const listeners = [];
  const window = { beadcause: {} };
  const document = {
    hidden,
    addEventListener: (type, fn) => listeners.push([type, fn]),
    removeEventListener: (type, fn) => {
      const i = listeners.findIndex(([t, f]) => t === type && f === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
  const ctx = vm.createContext({
    window,
    document,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    AbortController,
    encodeURIComponent,
    JSON,
    Number,
    Boolean,
    Array,
    Error,
    TypeError,
    Promise,
  });
  vm.runInContext(read('public/stream.js'), ctx, { filename: 'stream.js' });
  return {
    stream: ctx.window.beadcause.stream,
    document,
    listenerCount: () => listeners.length,
    /** Raise `visibilitychange` on everything still listening for it. */
    wake: () => {
      for (const [type, fn] of [...listeners]) if (type === 'visibilitychange') fn();
    },
  };
}

/**
 * A daemon that never answers until told to.
 *
 * The poll is a request that is *supposed* to sit there, so a fixture that resolves on
 * its own would make every "is it parked?" assertion meaningless. `answer()` and
 * `fail()` are the only two ways one completes, and an abort rejects the way `fetch`
 * does, because the module's error branch turns on `err.name === 'AbortError'`.
 */
function daemon() {
  const asked = [];
  let settle = null;
  const api = (path, init = {}) => {
    asked.push(path);
    return new Promise((resolve, reject) => {
      const mine = { resolve, reject };
      settle = mine;
      init.signal?.addEventListener('abort', () => {
        // An aborted request is no longer parked — checked by identity, so a late
        // abort of the one before cannot clear the one that has since started.
        if (settle === mine) settle = null;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    });
  };
  return {
    asked,
    api,
    get parked() {
      return Boolean(settle);
    },
    answer(data) {
      const s = settle;
      settle = null;
      s.resolve(data);
    },
    fail(err) {
      const s = settle;
      settle = null;
      s.reject(err);
    },
  };
}

/* ------------------------------------------------------- 1. the place in the log */

await check('nothing parks from a place we do not have — a since=0 poll could never be answered', async () => {
  const { stream } = load();
  const d = daemon();
  const s = stream.mount({ api: d.api, onFallback: () => {} });
  s.schedule();
  await tick(10);
  assert.deepEqual(d.asked, [], 'parked without knowing where in the log it was');
  assert.equal(s.canFollow(), false);
});

await check('a cold fetch handing over its sequence is what starts the follow', async () => {
  const { stream } = load();
  const d = daemon();
  const s = stream.mount({ api: d.api, onFallback: () => {} });
  s.seq = 42;
  s.schedule();
  await tick(10);
  assert.deepEqual(d.asked, ['/api/poll?since=42&wait=25']);
});

await check('and every following park is from the sequence the last answer carried', async () => {
  const { stream } = load();
  const d = daemon();
  const seen = [];
  const s = stream.mount({ api: d.api, onPoll: (data) => seen.push(data.seq) });
  s.seq = 7;
  s.schedule();
  await tick(5);
  d.answer({ seq: 8, questions: null, events: [] });
  await tick(5);
  d.answer({ seq: 11, questions: null, events: [] });
  await tick(5);
  assert.deepEqual(d.asked, ['/api/poll?since=7&wait=25', '/api/poll?since=8&wait=25', '/api/poll?since=11&wait=25']);
  assert.deepEqual(seen, [8, 11]);
  assert.equal(s.seq, 11);
});

await check('a cold load landing mid-park drops the answer rather than winding the log back', async () => {
  const { stream } = load();
  const d = daemon();
  const seen = [];
  const s = stream.mount({ api: d.api, onPoll: (data) => seen.push(data.seq) });
  s.seq = 7;
  s.schedule();
  await tick(5);
  // A `load()` came back while we were parked and it knows a later place than this
  // answer does. Adopting the stale one would re-ask for events already on screen.
  s.seq = 30;
  d.answer({ seq: 8, questions: [], events: [] });
  await tick(10);
  assert.deepEqual(seen, [], 'adopted an answer about a place we had already left');
  assert.equal(s.seq, 30);
});

await check('a daemon too old to send a sequence is followed once and then handed to the clock', async () => {
  const { stream } = load();
  const d = daemon();
  let swept = 0;
  const s = stream.mount({ api: d.api, onFallback: () => (swept += 1), fallbackMs: () => 15 });
  s.seq = 3;
  s.schedule();
  await tick(5);
  d.answer({ questions: null });
  await tick(40);
  assert.equal(d.asked.length, 1, 'kept polling a log with no sequence in it');
  assert.ok(swept > 0, 'the view was left with no refresh at all');
});

/* ------------------------------------------------------ 2. one request, restarted */

await check('one park at a time — scheduling again over a live follow does not open a second', async () => {
  const { stream } = load();
  const d = daemon();
  const s = stream.mount({ api: d.api, onPoll: () => {} });
  s.seq = 5;
  s.schedule();
  await tick(5);
  s.schedule();
  s.schedule();
  await tick(10);
  assert.equal(d.asked.length, 1);
  assert.equal(s.following, true);
});

/* ------------------------------------------ 3. a quiet poll is not an empty inbox */

await check('the two are handed through as they arrived — null is a timeout, [] is an empty channel', async () => {
  const { stream } = load();
  const d = daemon();
  const seen = [];
  const s = stream.mount({ api: d.api, onPoll: (data) => seen.push(data.questions) });
  s.seq = 1;
  s.schedule();
  await tick(5);
  d.answer({ seq: 2, questions: null });
  await tick(5);
  d.answer({ seq: 3, questions: [] });
  await tick(5);
  assert.deepEqual(seen, [null, []]);
});

await check('resync is raised on its own, before the answer, for a view whose payload is not on the poll', async () => {
  const { stream } = load();
  const d = daemon();
  const order = [];
  const s = stream.mount({
    api: d.api,
    onResync: () => order.push('resync'),
    onPoll: () => order.push('poll'),
  });
  s.seq = 4;
  s.schedule();
  await tick(5);
  d.answer({ seq: 9, resync: true, questions: null, events: [] });
  await tick(5);
  assert.deepEqual(order, ['resync', 'poll']);
});

await check('a view that reads no questions says so, so an event costs the daemon no bd sweep', async () => {
  const { stream } = load();
  const d = daemon();
  const s = stream.mount({ api: d.api, want: 'presence', shade: true, wait: 40, onPoll: () => {} });
  s.seq = 2;
  s.schedule();
  await tick(5);
  assert.deepEqual(d.asked, ['/api/poll?since=2&wait=40&want=presence&shade=1']);
});

/* -------------------------------------------------- 4. every failure falls back */

await check('a broken poll loses the place and the clock takes over', async () => {
  const { stream } = load();
  const d = daemon();
  let swept = 0;
  const s = stream.mount({ api: d.api, onFallback: () => (swept += 1), fallbackMs: () => 15 });
  s.seq = 6;
  s.schedule();
  await tick(5);
  d.fail(new Error('Failed to fetch'));
  await tick(40);
  assert.equal(s.seq, 0, 'kept a place it can no longer trust');
  assert.equal(s.canFollow(), false);
  assert.ok(swept > 0, 'the view stopped refreshing entirely');
});

await check('a refusal the page is already handling keeps the place instead of adding a sweep to it', async () => {
  const { stream } = load();
  const d = daemon();
  const s = stream.mount({
    api: d.api,
    onFallback: () => {},
    fallbackMs: () => 1000,
    keepPlace: (err) => err?.message === 'token rejected',
  });
  s.seq = 6;
  s.schedule();
  await tick(5);
  d.fail(new Error('token rejected'));
  await tick(10);
  assert.equal(s.seq, 6);
});

await check('a view with no clock to fall back to simply stops, rather than spinning', async () => {
  const { stream } = load();
  const d = daemon();
  // console.js today: no refresh loop at all. Mounting without `onFallback` must not
  // invent one, and must not busy-loop on a poll it cannot make.
  const s = stream.mount({ api: d.api });
  s.seq = 6;
  s.schedule();
  await tick(5);
  d.fail(new Error('Failed to fetch'));
  await tick(40);
  assert.equal(d.asked.length, 1);
});

/* ------------------------------------------- 5. exactly one of the two is ever live */

await check('a view that cannot follow is on the clock, and one that can is not', async () => {
  const { stream } = load();
  const d = daemon();
  let allowed = false;
  let swept = 0;
  const s = stream.mount({
    api: d.api,
    ready: () => allowed,
    onFallback: () => (swept += 1),
    fallbackMs: () => 15,
    onPoll: () => {},
  });
  s.seq = 9;
  s.schedule();
  await tick(40);
  assert.equal(d.asked.length, 0, 'parked while the view said it was not ready');
  assert.ok(swept > 0, 'and did not fall back either');
  // The scope changed to one the log carries.
  const sweptBefore = swept;
  allowed = true;
  s.schedule();
  await tick(40);
  assert.equal(d.asked.length, 1, 'did not pick the log up');
  assert.equal(swept, sweptBefore, 'the clock is still running underneath the park');
});

await check('and the park is dropped rather than left to time out when the view stops being drawn', async () => {
  const { stream } = load();
  const d = daemon();
  let allowed = true;
  const s = stream.mount({ api: d.api, ready: () => allowed, onFallback: () => {}, fallbackMs: () => 1000, onPoll: () => {} });
  s.seq = 9;
  s.schedule();
  await tick(5);
  assert.equal(d.parked, true);
  allowed = false;
  s.schedule();
  await tick(10);
  assert.equal(d.parked, false, 'left a socket held open on a list nobody is looking at');
  assert.equal(s.following, false);
});

/* --------------------------------------------------- 6. a dark screen parks nothing */

await check('a screen that is already dark parks nothing', async () => {
  const { stream } = load({ hidden: true });
  const d = daemon();
  const s = stream.mount({ api: d.api, onPoll: () => {} });
  s.seq = 5;
  s.schedule();
  await tick(10);
  assert.deepEqual(d.asked, []);
});

await check('a screen going dark drops the socket, and coming back picks the log up from where it was', async () => {
  const room = load();
  const d = daemon();
  const s = room.stream.mount({ api: d.api, onPoll: () => {} });
  s.seq = 5;
  s.schedule();
  await tick(5);
  assert.equal(d.parked, true);
  room.document.hidden = true;
  room.wake();
  await tick(10);
  assert.equal(d.parked, false, 'a phone in a pocket held the socket open');
  assert.equal(s.seq, 5, 'lost its place while the screen was off');
  room.document.hidden = false;
  room.wake();
  await tick(10);
  assert.deepEqual(d.asked, ['/api/poll?since=5&wait=25', '/api/poll?since=5&wait=25']);
});

await check('and the clock still refuses to sweep behind a dark screen', async () => {
  const room = load({ hidden: true });
  const d = daemon();
  let swept = 0;
  const s = room.stream.mount({ api: d.api, ready: () => false, onFallback: () => (swept += 1), fallbackMs: () => 15 });
  s.schedule();
  await tick(50);
  assert.equal(swept, 0);
});

await check('a page handing over lets go of both paths and the listener with them', async () => {
  const room = load();
  const d = daemon();
  let swept = 0;
  const s = room.stream.mount({ api: d.api, onFallback: () => (swept += 1), fallbackMs: () => 15 });
  s.seq = 5;
  s.schedule();
  await tick(5);
  const before = room.listenerCount();
  s.stop();
  await tick(40);
  assert.equal(d.parked, false);
  assert.equal(swept, 0);
  assert.equal(room.listenerCount(), before - 1);
  s.schedule();
  await tick(30);
  assert.equal(d.asked.length, 1, 'a stopped stream started again');
});

await check('a mount with nothing to poll through is a mistake worth throwing on', () => {
  const { stream } = load();
  assert.throws(() => stream.mount({}), /api/);
});

/* ------------------------------------------------------------------- the wiring */

await check('app.js follows the log through the shared module and holds no loop of its own', () => {
  const app = read('public/app.js');
  assert.ok(app.includes('window.beadcause?.stream?.mount?.('), 'app.js does not mount the shared stream');
  // The loop, not the word: `/api/poll` must not be fetched from this file any more,
  // because a second copy of the park is exactly what this change removed.
  assert.ok(!/api\(`\/api\/poll/.test(app), 'app.js still polls /api/poll itself');
});

await check('the inbox loads it, and before the script that mounts it', () => {
  const html = read('public/index.html');
  assert.ok(html.includes('/stream.js'), 'index.html does not load stream.js');
  assert.ok(html.indexOf('/stream.js') < html.indexOf('/app.js'), 'index.html loads app.js first');
});

await check('the service worker ships it, or a cached inbox is back on a timer', () => {
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/stream.js'"), 'not in SHELL');
  // The version is what makes the new file and the page that mounts it arrive together.
  assert.ok(/const CACHE = 'beadcause-v(2[8-9]|[3-9]\d)'/.test(sw), 'CACHE was not bumped past v27');
});

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
