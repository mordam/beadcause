/**
 * Five conflicting pull requests, two windows, and the other three in line.
 *
 * `test/resolvers.mjs` asserts the per-pull-request half of lib/resolvers.js: one press
 * is one session and so is two presses, which was the whole of bc-utyr. This suite is
 * the other half — the global cap — and it exists because the thing that broke the old
 * assumption is not a second press, it is a sweep. Until bc-9d37 the only way to open a
 * resolver was a tap, and a human taps one at a time; a merge that lands can conflict
 * five branches at once and hand all five over in the same tick. Five different pull
 * requests are five different keys, so every lock in that file is satisfied, and what
 * comes out is five iTerm windows each running this repo's full gate on one laptop.
 *
 * Four claims, and three of them fail silently:
 *
 *   - **five requests open two windows** — asserted as the count of launches, because a
 *     cap that answered correctly and opened anyway would pass a status assertion;
 *   - **the third opens when one of the first two is gone, and not before** — the queue
 *     draining is the whole feature. A queue that only drains when somebody presses a
 *     button is a queue that never drains, because nothing presses one for the sweep;
 *   - **a conflict that cleared while it waited is dropped, not opened** — an hour can
 *     pass in the queue. Another resolver pushes, `main` moves, Adam merges it from his
 *     phone: opening a window then is exactly the pointless window the button's own
 *     refusal exists to prevent;
 *   - **"I cannot tell" never frees a slot** — macOS refusing to answer, and a record
 *     with no handle to ask through, both hold. Freeing on either takes a window away
 *     from an agent mid-merge, which is bc-utyr's damage arrived at from the other side.
 *
 *     node test/resolverqueue.mjs
 *
 * No iTerm, no `gh`, no daemon, and no clock: `launch`, `recheck`, `say` and the
 * liveness `probe` are all injected, and every call is given its own `now`. A case that
 * would have opened a window pushes onto an array instead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before lib/session.js is reached through the import below: CONFIG_DIR resolves once, at
// module load, and the daemon's own config is not this suite's to read.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-resolverqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { resolveFor, find, remember, list, pending, pump, reset, MAX_LIVE } = await import(LIB('resolvers.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

const T0 = Date.parse('2026-08-12T09:15:00Z');
const MIN = 60000;
const HOUR = 60 * MIN;

const fresh = () => ({ opened: [], said: [], asked: [] });

/**
 * What the sweep does with one conflicting pull request: hand it over with a way to open
 * a window and a way to ask GitHub again later.
 */
function hand(state, number, { workspace = 'beadcause', now = T0, recheck = null, fail = null, term = `iterm-${number}` } = {}) {
  return resolveFor(
    workspace,
    number,
    async () => {
      if (fail) throw fail;
      state.opened.push(number);
      return { dir: `/repo/${number}`, mode: 'acceptEdits', term };
    },
    {
      branch: `worktree-${number}`,
      owner: 'Adam',
      now,
      recheck,
      say: async (handle, text) => {
        state.said.push({ handle, text });
        return 'sent';
      },
    }
  );
}

/** A liveness probe over a set of handles that are gone. Everything else is still there. */
const probeWhereGone = (state, gone) => async (handle) => {
  state.asked.push(handle);
  return !gone.includes(handle);
};

const numbers = (rows) => rows.map((r) => r.number);

/* ------------------------------------------------------------------ the cases */

/**
 * The acceptance criterion, in one case: a sweep hands over five, and two windows open.
 */
await check('five conflicting pull requests open two windows and three wait', async () => {
  const state = fresh();
  const out = [];
  for (const n of [115, 116, 117, 118, 119]) out.push(await hand(state, n));

  assert.equal(MAX_LIVE, 2, 'the cap this suite is written against');
  assert.deepEqual(state.opened, [115, 116], 'two windows, and they are the first two');
  assert.equal(out.filter((r) => r.opened).length, 2);
  assert.deepEqual(numbers(pending()), [117, 118, 119], 'the rest are in line, in the order they arrived');
  assert.deepEqual(
    pending().map((r) => r.place),
    [1, 2, 3]
  );
  assert.match(out[4].note, /#119 is 3rd in line/, out[4].note);
  assert.match(out[4].note, /2 resolvers are already running/, 'the sentence counts from MAX_LIVE, not from a number typed into it');
  assert.equal(out[2].queued.branch, 'worktree-117', 'and it remembers which branch it is holding a place for');
  assert.equal(typeof out[2].queued.launch, 'undefined', 'the closures do not leave this file');
});

/**
 * The other half of it: the third opens **when one of the first two is gone**, and the
 * drain is what learns that. Nothing presses a button on a queued entry's behalf.
 */
await check('the third window opens only once one of the first two has closed', async () => {
  const state = fresh();
  for (const n of [115, 116, 117]) await hand(state, n);

  const nothing = await pump({ probe: probeWhereGone(state, []), now: T0 + 10 * MIN });
  assert.deepEqual(state.opened, [115, 116], 'both windows are still open, so nothing started');
  assert.deepEqual(nothing.opened, []);
  assert.equal(nothing.waiting, 1, 'and #117 is still in line');
  assert.deepEqual(state.asked.sort(), ['iterm-115', 'iterm-116'], 'both were asked, and asked without being typed into');

  const moved = await pump({ probe: probeWhereGone(state, ['iterm-115']), now: T0 + 20 * MIN });
  assert.deepEqual(state.opened, [115, 116, 117], '#117 got the freed window');
  assert.deepEqual(numbers(moved.opened), [117]);
  assert.deepEqual(moved.freed.map((f) => f.number), [115]);
  assert.deepEqual(pending(), [], 'nothing left in line');
  assert.equal(find('beadcause', 115, T0 + 20 * MIN), null, 'the closed window is forgotten');
  assert.equal(find('beadcause', 117, T0 + 20 * MIN).term, 'iterm-117', 'and the new one is remembered by its own handle');
});

/**
 * An hour can pass in the queue, and GitHub is the only thing that knows whether the
 * conflict is still there. Asked at the moment of the launch, never trusted from before.
 */
await check('a queued conflict that cleared while it waited is dropped rather than opened', async () => {
  const state = fresh();
  await hand(state, 115);
  await hand(state, 116);
  await hand(state, 117, { recheck: async () => '#117 merged while it was waiting' });
  await hand(state, 118, { recheck: async () => true });

  const out = await pump({ probe: probeWhereGone(state, ['iterm-115']), now: T0 + 30 * MIN });

  assert.deepEqual(state.opened, [115, 116, 118], 'no window for #117, and #118 took the slot it did not use');
  assert.deepEqual(
    out.dropped.map((d) => [d.number, d.why]),
    [[117, '#117 merged while it was waiting']],
    'and the reason GitHub gave is what comes back'
  );
  assert.deepEqual(pending(), []);
});

/** A bare `false` is still a no — it just has to say something for itself. */
await check('a recheck that answers no without a reason still drops the entry', async () => {
  const state = fresh();
  await hand(state, 115);
  await hand(state, 116);
  await hand(state, 117, { recheck: async () => false });

  const out = await pump({ probe: probeWhereGone(state, ['iterm-116']), now: T0 + 5 * MIN });
  assert.deepEqual(state.opened, [115, 116]);
  assert.match(out.dropped[0].why, /no longer reports #117 as conflicting/, out.dropped[0].why);
});

/**
 * GitHub unreachable for a moment is not the conflict having cleared. Dropping on it is
 * the same mistake as reading a macOS refusal as a closed window — so it keeps its place.
 */
await check('a recheck that throws keeps its place in the line', async () => {
  const state = fresh();
  let asks = 0;
  await hand(state, 115);
  await hand(state, 116);
  await hand(state, 117, {
    recheck: async () => {
      asks += 1;
      if (asks === 1) throw new Error('gh: could not reach api.github.com');
      return true;
    },
  });
  await hand(state, 118, { recheck: async () => true });

  const stuck = await pump({ probe: probeWhereGone(state, ['iterm-115']), now: T0 + 5 * MIN });
  assert.deepEqual(state.opened, [115, 116], 'nothing opened on the strength of a question nobody answered');
  assert.deepEqual(numbers(pending()), [117, 118], 'and #118 did not overtake it — asking it would fail the same way');
  assert.deepEqual(stuck.dropped, []);

  const later = await pump({ probe: probeWhereGone(state, ['iterm-115']), now: T0 + 6 * MIN });
  assert.deepEqual(state.opened, [115, 116, 117], 'the next drain asks again, and this time gets an answer');
  assert.deepEqual(numbers(later.opened), [117]);
  assert.deepEqual(numbers(pending()), [118], 'one slot, one window — #118 keeps waiting');
});

/**
 * The rule the whole file is built on, arrived at from the queue's side: a refusal from
 * macOS says nothing about the session, and freeing a slot on one takes a window away
 * from an agent that is in the middle of a merge.
 */
await check('macOS refusing to answer holds the slot', async () => {
  const state = fresh();
  await hand(state, 115);
  await hand(state, 116);
  await hand(state, 117);

  const out = await pump({
    now: T0 + 5 * MIN,
    probe: async (handle) => {
      state.asked.push(handle);
      throw Object.assign(new Error('macOS blocked beadcause from controlling iTerm.'), { status: 403 });
    },
  });

  assert.deepEqual(state.opened, [115, 116], 'no window opened on the strength of a refusal');
  assert.deepEqual(out.freed, []);
  assert.equal(out.waiting, 1);
  assert.ok(find('beadcause', 115, T0 + 5 * MIN), 'and both records are still believed');
  assert.ok(find('beadcause', 116, T0 + 5 * MIN));
});

/**
 * The third state, from the queue's side. A record with no handle cannot be asked at
 * all, so it is not asked — and it holds until it ages out on its own at `BLIND_MS`.
 */
await check('a session with no handle is never probed, and holds until it ages out', async () => {
  const state = fresh();
  await hand(state, 115, { term: null });
  await hand(state, 116);
  await hand(state, 117);

  const held = await pump({ probe: probeWhereGone(state, []), now: T0 + 12 * MIN });
  assert.deepEqual(state.asked, ['iterm-116'], 'only the one there was something to ask through');
  assert.deepEqual(state.opened, [115, 116]);
  assert.equal(held.waiting, 1);

  const aged = await pump({ probe: probeWhereGone(state, []), now: T0 + 31 * MIN });
  assert.deepEqual(state.opened, [115, 116, 117], 'past the blind window the slot is free and #117 takes it');
  assert.deepEqual(aged.waiting, 0);
});

/**
 * A second ask about something already in line is the same question a second press asks
 * — *is anything happening?* — and its place is the answer. Two entries would be two
 * windows for one pull request, which is the bug this file is named after.
 */
await check('asking again about a queued pull request answers its place rather than queueing it twice', async () => {
  const state = fresh();
  for (const n of [115, 116, 117, 118]) await hand(state, n);

  const again = await hand(state, 118, { now: T0 + MIN });
  assert.equal(again.queued.place, 2, JSON.stringify(again.queued));
  assert.match(again.note, /#118 is 2nd in line/, again.note);
  assert.deepEqual(numbers(pending()), [117, 118], 'one entry, not two');
  assert.deepEqual(state.said, [], 'and nothing was typed anywhere — there is no session to speak to yet');
});

/**
 * The cap must not get between a press and the session that already has the pull
 * request. That answer is about this pull request in particular, and it is right whether
 * or not the Mac is full — queueing it would be a window opened later for work in hand.
 */
await check('a live session is still told, even with the Mac full', async () => {
  const state = fresh();
  await hand(state, 115);
  await hand(state, 116);
  const out = await hand(state, 115, { now: T0 + 4 * MIN });

  assert.deepEqual(state.opened, [115, 116], 'nothing new opened');
  assert.ok(out.reused, JSON.stringify(out));
  assert.equal(state.said.length, 1, 'the session with it was told, the same as on an idle Mac');
  assert.deepEqual(pending(), [], 'and nothing was put in line');
});

/**
 * The queue is a claim about the present too. Four hours on, the closure it is holding
 * describes a conflict nobody has looked at since — and the next merge's sweep will ask
 * GitHub, which is a better source than this.
 */
await check('an entry nobody reached in four hours is dropped', async () => {
  const state = fresh();
  for (const n of [115, 116, 117]) await hand(state, n);

  const out = await pump({ probe: probeWhereGone(state, []), now: T0 + 4 * HOUR + MIN });
  assert.deepEqual(state.opened, [115, 116], 'and it was not opened on the way out');
  assert.deepEqual(
    out.dropped.map((d) => d.number),
    [117]
  );
  assert.match(out.dropped[0].why, /four hours/, out.dropped[0].why);
  assert.deepEqual(pending(), []);
});

/**
 * A window that would not open is one window, not the end of the queue. The four behind
 * it still should get theirs.
 */
await check('a launch that throws in the drain does not take the rest of the line with it', async () => {
  const state = fresh();
  await hand(state, 115);
  await hand(state, 116);
  await hand(state, 117, { fail: new Error('iTerm would not open') });
  await hand(state, 118);

  const out = await pump({ probe: probeWhereGone(state, ['iterm-115']), now: T0 + 5 * MIN });
  assert.deepEqual(state.opened, [115, 116, 118], '#118 got the window #117 could not use');
  assert.deepEqual(
    out.failed.map((f) => [f.number, f.why]),
    [[117, 'iTerm would not open']]
  );
  assert.equal(find('beadcause', 117, T0 + 5 * MIN), null, 'nothing remembered from a window that never opened');
});

/**
 * Two drains at once are one drain. They are asking the same question — *is there room
 * now* — and running both is how one queued entry gets two windows.
 */
await check('two drains at once start one window', async () => {
  const state = fresh();
  for (const n of [115, 116, 117]) await hand(state, n);

  const probe = probeWhereGone(state, ['iterm-115']);
  const [a, b] = await Promise.all([pump({ probe, now: T0 + 5 * MIN }), pump({ probe, now: T0 + 5 * MIN })]);

  assert.deepEqual(state.opened, [115, 116, 117], 'one window for #117, not two');
  assert.equal(a, b, 'the second caller was handed the drain already running');
});

/** Two repos each have a #115, and a full Mac is full of both. */
await check('the cap is global — it counts windows, not pull requests in one repo', async () => {
  const state = fresh();
  await hand(state, 115, { workspace: 'beadcause' });
  await hand(state, 115, { workspace: 'sophab', term: 'iterm-sophab' });
  const out = await hand(state, 115, { workspace: 'deluvia' });

  assert.equal(state.opened.length, 2, 'two windows across three repos');
  assert.ok(out.queued, JSON.stringify(out));
  assert.deepEqual(
    pending().map((r) => r.workspace),
    ['deluvia'],
    'and the queue keys on the repo as well as the number'
  );
});

/** Nothing is waiting, so nothing is asked: a drain on an idle Mac costs no `osascript`. */
await check('an empty queue asks nothing', async () => {
  const state = fresh();
  await hand(state, 115);
  const out = await pump({ probe: probeWhereGone(state, ['iterm-115']), now: T0 + MIN });

  assert.deepEqual(state.asked, [], 'the probe is for freeing a slot somebody is waiting for');
  assert.ok(find('beadcause', 115, T0 + MIN), 'so a live record is left exactly as it was');
  assert.deepEqual(out, { opened: [], freed: [], dropped: [], failed: [], waiting: 0 });
});

/** And the queue is process-lifetime state like the rest of the file: `reset` clears it. */
await check('reset empties the line as well as the map', async () => {
  const state = fresh();
  for (const n of [115, 116, 117]) await hand(state, n);
  assert.equal(pending().length, 1);
  assert.equal(list(T0).length, 2);
  reset();
  assert.deepEqual(pending(), []);
  assert.equal(list(T0).length, 0);
  remember('beadcause', 115, { term: 'a' }, new Date(T0));
  assert.equal(list(T0).length, 1, 'and it is usable again afterwards');
});

/* ------------------------------------------- the probe, and why it is safe to repeat */

/**
 * Every case above injects the probe, which is the only way to assert a queue without an
 * iTerm — and it means nothing above would notice if the real one started raising
 * windows. It runs every twenty seconds against a session an agent is working in, so
 * "it touches nothing" is a property worth pinning to the two arguments that make it
 * true. `test/focus.mjs` owns the rest of that script; this is the mode `sessionAlive`
 * asks for.
 */
const sessionJs = fs.readFileSync(LIB('session.js'), 'utf8');
const focusScript = fs.readFileSync(path.join(HERE, '..', 'scripts', 'focus-session.applescript'), 'utf8');
const aliveBody = sessionJs.slice(sessionJs.indexOf('export function sessionAlive'));

await check('the liveness probe asks for no bounds and no focus', async () => {
  assert.match(
    aliveBody.slice(0, 400),
    /\[FOCUS_SCRIPT, String\(handle\), '', 'quiet'\]/,
    'a rectangle here resizes a window somebody is working in, and `front` raises iTerm over whatever they are doing'
  );
  assert.ok(/if bringFront then/.test(focusScript), 'the script raises the window unconditionally');
  assert.ok(/if \(count of rect\) is 4 then/.test(focusScript), 'the script sets bounds unconditionally');
});

await check('and only the word missing means the window is gone', async () => {
  assert.match(aliveBody.slice(0, 900), /\.trim\(\) !== 'missing'/, 'anything it cannot read must count as still there');
  assert.ok(/return "missing"/.test(focusScript), 'the script no longer says it');
  // The refusal path is the one that must not resolve at all: `false` here is a slot
  // taken from an agent mid-merge, which is bc-utyr's damage from the other side.
  assert.match(aliveBody.slice(0, 900), /const blocked = itermBlocked\(detail\);[\s\S]*return reject\(blocked\)/);
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
