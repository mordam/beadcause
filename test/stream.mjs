#!/usr/bin/env node
/**
 * The delta stream — every standing view on the event log, and no view on a clock.
 *
 *     npm test
 *     node test/stream.mjs
 *
 * `public/stream.js` is one long poll on `/api/poll`, mounted by all six standing
 * views — five pages and the mirror pane, which shares the advocates page's document
 * and follows the log on its own sequence for its own reason (bc-2ml3).
 * Before it, the inbox followed the log with a loop written inside `app.js` and
 * the other four re-asked for their whole payload on a `setInterval` — ten seconds on
 * /admin, twenty on /monitor, sixty on /prs, and never on the chat launcher, which
 * simply went stale. Two of those timers pulled a `bd` sweep across every workspace
 * behind them, whether or not anything had moved.
 *
 * Six things are worth holding, and each of them fails silently if it breaks:
 *
 * 1. **The first request learns a sequence and every one after it parks.** A poll with
 *    no `since` answers immediately by design. If the loop ever sent a second one it
 *    would be a busy loop against the daemon rather than a parked socket — and it would
 *    look, from the outside, exactly like a page that was refreshing nicely.
 *
 * 2. **A view that draws no questions says so.** `want=presence` is what makes a park
 *    free: without it the daemon sweeps `bd` to build an inbox the parked view throws
 *    away, so four converted views would have put four sweeps per event on the Mac —
 *    the timer's bill arriving by another route.
 *
 * 3. **A broken poll comes back.** The four views have no timer behind them any more,
 *    so a stream that gave up would be a screen that has quietly stopped refreshing:
 *    the one failure mode this whole change must not introduce. The inbox is the
 *    exception, and asks for no retry, because it falls back to its own timer.
 *
 * 4. **A stop is a stop.** A page going into a pocket aborts the request rather than
 *    leaving a socket held, and an answer that lands after the page moved on is
 *    dropped rather than applied over a newer list.
 *
 * 5. **Presence is not news.** A thumb moving on somebody else's phone wakes every
 *    parked poll on purpose — that is how the mirror works — and a view that refetched
 *    for it would have rebuilt the timer out of somebody else's scrolling.
 *
 * 6. **The timers are gone and stayed gone.** Asserted against the four files, because
 *    the cheapest way for this to regress is somebody putting one back to fix a
 *    staleness they did not realise had a cause.
 *
 * The behavioural half runs the real `public/stream.js` in a vm against a scripted
 * `api`, the way test/warm.mjs runs the real warm layer: a reimplementation of the loop
 * here could pass while the phone shipped something else.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
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
    console.log(`      ${String(err.message).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

console.log('\ndelta stream');

/* ============================================================== the client half */

/**
 * The real file, in a room with the handful of globals it touches.
 *
 * `document` is a stub with the one listener the file registers and a `hidden` flag the
 * test can flip, because the visibility rule is half of what stops a phone in a pocket
 * holding a socket open.
 */
function mount() {
  const window = { beadcause: {} };
  const listeners = [];
  const document = {
    hidden: false,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  };
  const ctx = vm.createContext({
    window,
    document,
    setTimeout,
    clearTimeout,
    AbortController,
    URLSearchParams,
    Promise,
    JSON,
    Number,
    Boolean,
    String,
    Array,
    Set,
    Math,
    console,
  });
  vm.runInContext(read('public/stream.js'), ctx, { filename: 'stream.js' });
  return {
    stream: window.beadcause.stream,
    document,
    /** Fire whatever the file hung on `visibilitychange`. */
    visibility: () => listeners.filter((l) => l.type === 'visibilitychange').forEach((l) => l.fn()),
  };
}

/** Let every already-resolved promise and every zero-delay timer run. */
const settle = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/**
 * An `api` that answers from a script and records what it was asked.
 *
 * Each entry is either a payload to resolve with or an `Error` to throw; running off
 * the end parks forever, which is what a real poll does and what lets a test assert
 * that no *further* request was made.
 */
function scripted(answers) {
  const asked = [];
  const api = (url, opts = {}) => {
    asked.push(url);
    const next = answers.shift();
    if (next === undefined) {
      // Park, and honour the abort — a stop has to end the loop rather than wait it out.
      return new Promise((_, reject) => {
        opts.signal?.addEventListener?.('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
      });
    }
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  };
  return { api, asked };
}

await check('the first request learns a sequence and every one after it parks', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([
    { seq: 7, events: [] },
    { seq: 9, events: [{ type: 'created' }] },
  ]);
  const h = stream.follow({ api, want: 'presence', cold: true, visibility: false });
  h.start();
  await settle();
  assert.equal(asked.length, 3, `asked ${asked.length} times, not three`);
  // The cold one: no `since` at all, so the daemon answers rather than parking.
  assert.ok(!asked[0].includes('since='), `the first request parked instead of asking: ${asked[0]}`);
  // And from then on, always one — including from a sequence of zero, which is a real
  // place in the log on a daemon that has not emitted anything yet.
  assert.ok(asked[1].includes('since=7&wait='), asked[1]);
  assert.ok(asked[2].includes('since=9&wait='), asked[2]);
  h.stop();
});

await check('a view that draws no questions asks the daemon not to sweep for it', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([{ seq: 3, events: [] }]);
  const h = stream.follow({ api, want: 'presence', cold: true, visibility: false });
  h.start();
  await settle();
  for (const url of asked) assert.ok(url.includes('want=presence'), `a park that costs a bd sweep: ${url}`);
  h.stop();
});

await check('the inbox never sends a cold poll — its own would be an immediate answer and a sweep', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([{ seq: 4, events: [] }]);
  // `cold: false` with nothing to start from is the inbox before its first fetch: there
  // is nothing to follow, so the timer is the refresh and this must not ask at all.
  const h = stream.follow({ api, cold: false, visibility: false });
  h.start();
  await settle();
  assert.equal(asked.length, 0, `it polled with no sequence: ${asked[0]}`);
  // And once a fetch has given it one, it parks from there rather than starting cold.
  h.seq = 12;
  h.start();
  await settle();
  assert.ok(asked[0].includes('since=12&wait='), asked[0]);
  h.stop();
});

await check('every answered poll reaches the view, with its events and its resync flag', async () => {
  const { stream } = mount();
  const woke = [];
  const { api } = scripted([
    { seq: 2, events: [{ type: 'presence' }] },
    { seq: 5, resync: true, events: [] },
  ]);
  const h = stream.follow({
    api,
    cold: true,
    visibility: false,
    onWake: (w) => woke.push(w),
  });
  h.start();
  await settle();
  assert.equal(woke.length, 2);
  assert.deepEqual(woke[0].events, [{ type: 'presence' }]);
  assert.equal(woke[0].resync, false);
  assert.equal(woke[1].resync, true, 'the resync signal did not reach the view');
  assert.equal(h.seq, 5, 'the sequence is not the one the last answer carried');
  h.stop();
});

await check('a broken poll comes back — the four views have no timer behind them', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([{ seq: 1, events: [] }, new Error('network went')]);
  const settled = [];
  const h = stream.follow({
    api,
    cold: true,
    visibility: false,
    retryMs: 20,
    onSettle: () => settled.push(asked.length),
  });
  h.start();
  await settle(60);
  assert.ok(asked.length >= 3, `it gave up after ${asked.length} requests`);
  // The retry forgets the sequence it was holding — the daemon may have restarted
  // underneath it — but it asks from zero rather than cold. That is the difference
  // between parking and busy-looping: a `since=0` waits for the next event like any
  // other, and the daemon answers `resync` if the log has already moved past it, which
  // is exactly the signal the view needs to go and refetch everything.
  assert.ok(asked[2].includes('since=0&wait='), asked[2]);
  h.stop();
  const after = asked.length;
  await settle(60);
  assert.equal(asked.length, after, 'a stopped stream kept retrying');
});

await check('and it backs off while the failures continue, rather than hammering', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([new Error('gone'), new Error('gone'), new Error('gone'), new Error('gone')]);
  const h = stream.follow({ api, cold: true, visibility: false, retryMs: 10 });
  h.start();
  // Four attempts at a flat 10ms would all be inside this window; doubling puts the
  // fourth at 70ms and the fifth at 150. A daemon down for an hour — a deploy, a laptop
  // asleep — must not be asked twelve times a minute for the whole hour.
  await settle(60);
  assert.ok(asked.length <= 4, `it retried ${asked.length} times in 60ms without backing off`);
  assert.ok(asked.length >= 2, 'it did not retry at all');
  h.stop();
});

await check('the inbox asks for no retry — it has a timer of its own to fall back to', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([new Error('network went')]);
  let settled = 0;
  const h = stream.follow({ api, cold: true, visibility: false, retryMs: 0, onSettle: () => (settled += 1) });
  h.start();
  await settle(40);
  assert.equal(settled, 1, 'onSettle is where the fallback goes and it fired ' + settled + ' times');
  assert.equal(asked.length, 1, 'it retried when it was told not to');
});

await check('a stop aborts the parked request rather than leaving a socket held', async () => {
  const { stream } = mount();
  const { api, asked } = scripted([{ seq: 6, events: [] }]);
  let settled = 0;
  const h = stream.follow({ api, cold: true, visibility: false, onSettle: () => (settled += 1) });
  h.start();
  await settle();
  assert.equal(asked.length, 2, 'it is not parked');
  h.stop();
  await settle();
  assert.equal(settled, 1, 'the abort did not end the loop');
  assert.equal(asked.length, 2, 'it re-parked after being stopped');
});

await check('a screen that has gone dark stops, and coming back picks the log up again', async () => {
  const { stream, document, visibility } = mount();
  const { api, asked } = scripted([{ seq: 8, events: [] }]);
  const h = stream.follow({ api, cold: true });
  h.start();
  await settle();
  assert.equal(asked.length, 2);
  document.hidden = true;
  visibility();
  await settle();
  const parked = asked.length;
  document.hidden = false;
  visibility();
  await settle();
  assert.ok(asked.length > parked, 'coming back did not re-park');
  h.stop();
});

await check('something that keeps no log is left alone, not asked at full speed', async () => {
  const { stream } = mount();
  // An old daemon, a proxy, a stub in a browser check: it answers `{}` at once and
  // forever. Without the guard, `cold` would send a second request the instant the
  // first came back — a spin loop for as long as the page stayed open, which is worse
  // than any timer this change deleted. A *zero* sequence is the opposite case and must
  // still park, so both are here.
  const nolog = scripted([{}, {}, {}, {}]);
  const a = stream.follow({ api: nolog.api, cold: true, visibility: false, retryMs: 0 });
  a.start();
  await settle(30);
  assert.equal(nolog.asked.length, 1, `it asked ${nolog.asked.length} times of something with no log`);

  const zero = scripted([{ seq: 0, events: [] }]);
  const b = stream.follow({ api: zero.api, cold: true, visibility: false, retryMs: 0 });
  b.start();
  await settle(30);
  assert.equal(zero.asked.length, 2, 'a daemon that has emitted nothing yet is a place in the log, not the absence of one');
  assert.ok(zero.asked[1].includes('since=0&wait='), zero.asked[1]);
  b.stop();
});

await check('presence is not news, and the finer question is answerable too', () => {
  const { stream } = mount();
  assert.equal(stream.moved([{ type: 'presence' }, { type: 'presence' }]), false);
  assert.equal(stream.moved([{ type: 'presence' }, { type: 'answered' }]), true);
  assert.equal(stream.moved([]), false);
  assert.equal(stream.moved(undefined), false, 'a missing events array must read as "nothing moved"');
  assert.equal(stream.touched([{ type: 'deploy' }], ['merged', 'deploy']), true);
  assert.equal(stream.touched([{ type: 'commented' }], ['merged', 'deploy']), false);
  assert.equal(stream.touched([{ type: 'merged' }], 'merged'), true, 'one type, not in an array');
});

await check('and "would `bd` answer /api/work differently" is one judgement, not two', () => {
  const { stream } = mount();
  // The advocates page asks this to decide whether to sweep; the inbox asks it about the
  // copy it holds *for* that page (bc-xxzz). Both directions matter. A roster-only
  // advocate action is already on the poll, so sweeping for it is the timer's bill
  // arriving by another route — and treating a claimed bead as roster-only would hand the
  // advocates tab a warm payload missing exactly the row you tapped through to see.
  for (const action of ['checked-in', 'surveying', 'idle', 'paused', 'resumed', 'forgot', 'limit']) {
    assert.equal(stream.workMoved([{ type: 'advocate', action }]), false, `${action} rides the poll already`);
  }
  assert.equal(stream.workMoved([{ type: 'presence' }]), false);
  assert.equal(stream.workMoved([{ type: 'advocate', action: 'opened' }]), true, 'a session opening moves a row');
  assert.equal(stream.workMoved([{ type: 'claimed' }]), true);
  assert.equal(stream.workMoved([{ type: 'presence' }, { type: 'advocate', action: 'idle' }, { type: 'merged' }]), true);
  assert.equal(stream.workMoved([]), false);
  assert.equal(stream.workMoved(undefined), false, 'a missing events array must read as "nothing moved"');
  // An advocate event with no action at all is not one of the free ones — an unknown
  // shape has to fall on the side that goes and asks.
  assert.equal(stream.workMoved([{ type: 'advocate' }]), true);
});

/* =========================================================== the six views half */

/**
 * Every mount of the shared loop.
 *
 * Seven rather than five, and two of them are second and third scripts on a page already
 * here: `monitor.html` carries three panes and each follows the log for its own reason.
 * The mirror's is a phone moving, with its own sequence — it was left hand-rolled when
 * the other five were converted, see bc-2ml3 and the note at `feed()` in mirror.js for
 * why the three rules it looked to invert turned out not to. The board's is a pull
 * request moving, and it arrived on that page with bc-d4d5 rather than being written
 * there; it was already following the log as a page of its own.
 */
const VIEWS = [
  { page: 'public/index.html', script: 'public/app.js', id: 'inbox' },
  { page: 'public/admin.html', script: 'public/admin.js', id: 'admin' },
  { page: 'public/monitor.html', script: 'public/monitor.js', id: 'advocates' },
  { page: 'public/monitor.html', script: 'public/prs.js', id: 'prs' },
  { page: 'public/console.html', script: 'public/console.js', id: 'console' },
  { page: 'public/monitor.html', script: 'public/mirror.js', id: 'mirror' },
  // The seventh, and it was not one of the five bc-rk2o converted — that bead's table
  // listed the views with tabs and the endorsement queue has never had one, so it kept
  // its 45-second full refetch for as long as this file has existed (bc-bsgn). It is the
  // most expensive refetch of the lot: every workspace swept, then a `bd show` per row.
  { page: 'public/endorse.html', script: 'public/endorse.js', id: 'endorse' },
];

await check('every standing page loads the file, before the script that mounts it', () => {
  for (const v of VIEWS) {
    const html = read(v.page);
    const at = html.indexOf('/stream.js');
    assert.ok(at > 0, `${v.page} does not load /stream.js`);
    const mine = html.indexOf(`/${path.basename(v.script)}`);
    assert.ok(at < mine, `${v.page} loads its own script before /stream.js`);
  }
});

await check('the service worker ships it, or a cached page never refreshes at all', () => {
  const sw = read('public/sw.js');
  assert.ok(/^\s*'\/stream\.js',/m.test(sw), '/stream.js is not in the shell');
  // The version has to move with it. This is the strictest case there is for that: the
  // timers are deleted in the same change, so a page cached without the file is not
  // slower, it is silently frozen.
  const version = sw.match(/const CACHE = '(beadcause-v(\d+))'/);
  assert.ok(version, 'the cache version is unreadable');
  assert.ok(Number(version[2]) >= 28, `the cache version is still ${version[1]}`);
});

await check('all seven views mount the shared stream, and none of them writes its own', () => {
  for (const v of VIEWS) {
    const src = read(v.script);
    // Optional chaining allowed and, on the inbox, required: a page served from a
    // service worker cached before this file existed has no `beadcause.stream`, and a
    // bare call there would be a TypeError in the first lines of app.js's own IIFE —
    // a blank inbox rather than a slow one.
    assert.ok(/\.stream\??\.follow\??\.?\(/.test(src), `${v.script} does not mount the shared stream`);
    // The loop lives in one file. A second `/api/poll?since=` anywhere else is the
    // next hand-rolled long-poll this was written to prevent — and the mirror is here
    // because it was exactly that, missed for a while because it is not the only
    // script on its page.
    assert.ok(!/\/api\/poll\?since=/.test(src), `${v.script} has a long poll of its own`);
  }
});

await check('the converted views have no wall-clock refresh left', () => {
  for (const f of ['public/admin.js', 'public/monitor.js', 'public/prs.js', 'public/console.js', 'public/endorse.js']) {
    const code = read(f)
      // Comments are where the deleted timers are explained, and the explanations name
      // them. Stripped so the assertion is about the code.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    assert.ok(!/setInterval\s*\(/.test(code), `${f} still refreshes on a setInterval`);
  }
});

await check('the queue wakes for what can change it, and not for somebody else scrolling', () => {
  const { stream } = mount();
  // Both halves of a discussion are news here on purpose: the dispatch and the comment
  // that comes back, because the folded row draws a 💬 count and a bead you asked three
  // questions about last night must not read as one nobody has opened.
  for (const type of ['created', 'endorsement', 'amended', 'commented', 'discussion']) {
    assert.equal(stream.queueMoved([{ type }]), true, `a ${type} event leaves the queue cold`);
  }
  // The negative is the one worth having. This page refetches by sweeping every
  // workspace and then reading a bead per row, so a wake for a thumb moving on somebody
  // else's phone would be the 45-second timer back, arriving by a worse route.
  for (const type of ['presence', 'advocate', 'terminal', 'answered']) {
    assert.equal(stream.queueMoved([{ type }]), false, `a ${type} event pulls a bd sweep of every workspace`);
  }
  assert.equal(stream.queueMoved([]), false);
  assert.equal(stream.queueMoved(undefined), false, 'a missing events array must read as "nothing moved"');
});

await check('and both pages that hold the queue ask that one question, not two lists', () => {
  // The drift this prevents is invisible: an inbox that thought a filing was nothing
  // would go on handing /endorse a warm payload missing exactly the bead you are being
  // asked about. Same argument as `boardMoved`, which is the neighbour it sits beside.
  for (const f of ['public/endorse.js', 'public/app.js']) {
    assert.ok(/stream\??\.queueMoved\??\.?\(/.test(read(f)), `${f} does not ask stream.queueMoved`);
    assert.ok(
      !/'endorsement'\s*,\s*'amended'/.test(read(f)),
      `${f} keeps a copy of the queue's event list — there is one, in public/stream.js`
    );
  }
});

await check('a wake the queue cannot act on is deferred, not dropped', () => {
  const src = read('public/endorse.js');
  // Two halves, and only the second is easy to leave out. Returning early while you are
  // mid-sentence is right — a repaint would take the sentence away — but a page that
  // never comes back to it is a queue that stays wrong for as long as you keep typing,
  // with nothing on the screen saying so, just before you make decisions off it.
  assert.ok(/stale = true;/.test(src), 'endorse.js drops a wake it could not act on');
  assert.ok(/function catchUp\(\)/.test(src), 'endorse.js has no catch-up for a deferred wake');
  assert.ok(/setTimeout\(catchUp, 0\)/.test(src), 'nothing ever takes the deferred wake');
});

await check('the non-inbox views park without asking the daemon to sweep bd for them', () => {
  for (const f of [
    'public/admin.js',
    'public/monitor.js',
    'public/prs.js',
    'public/console.js',
    'public/mirror.js',
    'public/endorse.js',
  ]) {
    assert.ok(/want:\s*'presence'/.test(read(f)), `${f} parks on a poll that sweeps every workspace`);
  }
});

await check('/admin no longer pulls a bd sweep behind it for one boolean', () => {
  const admin = read('public/admin.js');
  // `/api/work` is `collectWork` — three `bd` calls per workspace. This page asked for
  // it every ten seconds to read `observing`, which the poll now carries for free.
  assert.ok(!/api\(['"]\/api\/work['"]\)/.test(admin), '/admin fetches /api/work again');
  const warm = read('public/warm.js');
  const adminView = warm.match(/\{ id: 'admin', paths: \[([^\]]*)\]/);
  assert.ok(adminView, "the warm layer's admin view is unreadable");
  assert.ok(!adminView[1].includes('/api/work'), '/api/work is back under the admin view, so /monitor arrives cold from it');
});

/* ------------------------------------------------------------------------- done */

console.log(`\n${ran - failures}/${ran} ok\n`);
process.exit(failures ? 1 : 0);
