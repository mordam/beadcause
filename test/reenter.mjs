#!/usr/bin/env node
/**
 * Re-entering the Epic Advocate: which epics are enrolled, what counts as movement, and the
 * three things that stop a window opening anyway.
 *
 *     npm test
 *     node test/reenter.mjs
 *
 * bc-goo.15 — the half of bc-rfnr.3 that was filed as delivered and was not. Until it,
 * `openEpicAdvocateSession` had exactly one caller (a button) while the agent's own brief
 * told it, every run, that it would be re-opened on child events. Three things are worth a
 * suite here and none of them is visible by reading one function:
 *
 * 1. **A first sight must be silent.** With no snapshot to compare against every child
 *    looks newly filed, so the failure mode of getting this wrong is a daemon that opens a
 *    window on every enrolled P0 the first time it runs — and beadcause restarts itself
 *    several times a day on its own merges, which is what makes the *persisted* snapshot
 *    load-bearing rather than an optimisation.
 * 2. **A held event must survive being held.** `reentryFor` hands back the snapshot as it
 *    is now; storing that while declining to open the window consumes the event, and the
 *    child that closed is then recorded as already-seen-closed forever. Nothing about that
 *    failure is visible — it is a window that never opens.
 * 3. **A stall is measured in windows, not timestamps.** `updated_at` is bumped by a
 *    comment and not by a session dying, so the state under test is "the tracker says
 *    in_progress and nothing on this Mac is in a window on it", which needs two sweeps.
 * 4. **The two endings the brief asks for look exactly like that stall.** A delivered bead
 *    and a handed-back bead are both left `in_progress`, assigned, with a lease that
 *    expires — so the sweep reported every worker that did what it was told, and the two
 *    halves have to be held apart from each other *and* from a window that really did die
 *    (bc-xl7n.98). Getting this wrong is not visible either: it is an unattended window
 *    opened on a bead nothing was wrong with.
 * 5. **And a child epic's `in_progress` is not a worker's claim at all.** It is what
 *    pressing Start on the root board writes, or what an advocate of its own leaves while
 *    it runs — so reporting it as a stall points the brief's prescription (`--status open
 *    --assignee ""`) points it straight at the root board (bc-xl7n.118).
 *
 * The tick half injects `openAdvocate`, so a case that would have opened an iTerm window
 * pushes a record onto an array instead. No iTerm, no `bd`, no agent, and nothing written
 * outside a temp config dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reenter-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const {
  advocatedRoots,
  handedBack,
  workerHolds,
  reentryFor,
  supervised,
  waitingOnMerge,
  waitingOnMergeCard,
  REENTER_DEFAULTS,
} = await import(LIB('reenter.js'));
const { pairKey } = await import(LIB('ancestry.js'));
const { ADVOCATE_LABEL, WAITING_OPEN, WAITING_CLOSE, forgetAdvocateOpened } = await import(LIB('epicadvocate.js'));
const { leaseLabel } = await import(LIB('lease.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

const OWNER = 'owner:adam@example.com';
const waiting = (line) => `${WAITING_OPEN}\n${line}\n${WAITING_CLOSE}`;

const bead = (id, over = {}) => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [],
  notes: '',
  ...over,
});
/** An owned, open, non-crash root whose advocate has written its sentence: enrolled. */
const p0 = (id, over = {}) =>
  bead(id, { priority: 0, issue_type: 'epic', labels: [OWNER], notes: waiting('a worker slot'), ...over });

/**
 * The other carrier, and the one bc-r2b5.1 is about: an epic somebody assigned, whose
 * window died before it ever wrote a sentence. Same root, no notes at all, `ADVOCATE_LABEL`
 * on it — which is exactly what the launch door leaves behind.
 */
const assigned = (id, over = {}) =>
  p0(id, { notes: '', labels: [OWNER, ADVOCATE_LABEL], ...over });

/**
 * `{ parents, beads, edges }` the way `Bd.graph` answers it, off a flat list of rows.
 *
 * `deps` is `[from, to, type]` triples, keyed the way lib/ancestry.js keys them — on the
 * *unordered* pair, because bd holds one edge per pair whatever its direction or type. The
 * delivery half of the stall test reads exactly that map, and a fixture that keyed it by
 * `from~to` would have made a reversed edge look like a different one rather than the same
 * one pointing the other way, which is the case worth pinning.
 */
function index(rows, parentOf = {}, deps = []) {
  const beads = new Map(rows.map((r) => [r.id, r]));
  const parents = new Map(Object.entries(parentOf));
  const edges = new Map(deps.map(([from, to, type = 'blocks']) => [pairKey(from, to), { type, from, to }]));
  return { parents, beads, edges };
}

/**
 * The shape every case below is about: one enrolled P0 with three children.
 *
 * `extra` rows sit *outside* the subtree — a delivery card is not a child of the epic the
 * work hangs off, and putting one under the P0 would have the stall cases quietly testing a
 * four-child tree.
 */
const subtree = (over = {}, deps = [], extra = []) =>
  index(
    [
      p0('x-1', over.p0 || {}),
      bead('x-1.1', over['x-1.1'] || {}),
      bead('x-1.2', over['x-1.2'] || {}),
      bead('x-1.3', over['x-1.3'] || {}),
      ...extra,
    ],
    { 'x-1.1': 'x-1', 'x-1.2': 'x-1', 'x-1.3': 'x-1' },
    deps
  );

/**
 * A bead of the kind bin/deliver.js files and parks the work behind — open and waiting.
 *
 * Labels are passed in rather than assumed, because the two are not labelled alike and the
 * difference is load-bearing: a `pr-delivery` card is `human` (it is a question), a
 * `merge-queue` bead is not (it is the queue's). The *work* bead is neither — `park` is
 * called with `label: false` precisely so nothing strands it in the inbox — which is what
 * makes the delivery half a real second answer rather than the `human` test twice.
 */
const card = (id, labels, over = {}) => bead(id, { labels, priority: 1, ...over });

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ------------------------------------------------------------- who is enrolled */

await check('enrolment is the assignment label or the waiting-on block, and nothing else', () => {
  assert.deepEqual(advocatedRoots(subtree()).map((r) => r.epic.id), ['x-1'], 'the sentence still enrols');
  // Neither carrier, no enrolment — an epic nobody has ever advocated is left alone, which
  // is what keeps this from opening windows on epics the owner never asked to supervise.
  assert.deepEqual(advocatedRoots(subtree({ p0: { notes: 'prose but no block' } })), []);
  assert.deepEqual(advocatedRoots(subtree({ p0: { notes: '' } })), []);
});

await check('the label enrols an epic whose advocate never wrote a sentence — bc-r2b5.1', () => {
  // **The whole of the bead, as one assertion.** Before it, the only record of an
  // assignment was the sentence the window is asked to write *before it exits*, so a
  // window that died in its first minute left nothing at all: the tap had happened, the
  // epic was not enrolled, and nothing would ever come back to it. Ten of forty open
  // epics carried the block on the day this was written.
  const dead = subtree({ p0: { notes: '', labels: [OWNER, ADVOCATE_LABEL] } });
  assert.deepEqual(advocatedRoots(dead).map((r) => r.epic.id), ['x-1'], 'assigned is enrolled, sentence or no sentence');
  // And the old carrier goes on working on its own, which is what makes this landable:
  // every epic enrolled today has the block and no label, and a rule that read only the
  // label would silently un-enrol all of them on the deploy that shipped it.
  const older = subtree({ p0: { labels: [OWNER] } });
  assert.deepEqual(advocatedRoots(older).map((r) => r.epic.id), ['x-1'], 'nothing already enrolled falls out');
});

await check('un-assigning takes both carriers off, and either one left keeps it enrolled', () => {
  // The off switch, and the reason `epicAdvocatePrompt` now spells out both gestures: an
  // advocate that erased its sentence and left the label on would go on being re-opened,
  // which reads from the outside as an un-assign that did not work.
  const both = subtree({ p0: { labels: [OWNER, ADVOCATE_LABEL] } });
  assert.deepEqual(advocatedRoots(both).map((r) => r.epic.id), ['x-1']);
  assert.deepEqual(advocatedRoots(subtree({ p0: { labels: [OWNER, ADVOCATE_LABEL], notes: '' } })).length, 1, 'label alone');
  assert.deepEqual(advocatedRoots(subtree({ p0: { labels: [OWNER] } })).length, 1, 'sentence alone');
  assert.deepEqual(advocatedRoots(subtree({ p0: { labels: [OWNER], notes: '' } })), [], 'and neither is the un-assign');
});

await check('the four `wantsAdvocate` refusals hold on this door too', () => {
  // The same gate the launch refuses on, so this can never queue a bead the launch would
  // then throw about — see `advocateRefusal` in lib/session.js.
  assert.deepEqual(
    advocatedRoots(subtree({ p0: { priority: 1, issue_type: 'task' } })),
    [],
    'neither an epic nor a P0'
  );
  // And the half bc-htoy changed, pinned in the same breath: dropping only the priority
  // leaves an enrolled P1 epic, which is now a first-class root rather than a refusal.
  assert.deepEqual(
    advocatedRoots(subtree({ p0: { priority: 1 } })).map((r) => r.epic.id),
    ['x-1'],
    'a P1 epic is enrolled — bc-htoy'
  );
  assert.deepEqual(advocatedRoots(subtree({ p0: { status: 'closed' } })), [], 'closed');
  assert.deepEqual(advocatedRoots(subtree({ p0: { labels: [] } })), [], 'nobody owns it');
  assert.deepEqual(
    advocatedRoots(subtree({ p0: { labels: [OWNER, 'app-error'] } })),
    [],
    'a crash is not an epic'
  );
});

await check('the brief gets direct children, the events get the whole subtree', () => {
  const deep = index(
    [p0('x-1'), bead('x-1.1', { issue_type: 'epic' }), bead('x-1.1.1'), bead('x-1.2')],
    { 'x-1.1': 'x-1', 'x-1.1.1': 'x-1.1', 'x-1.2': 'x-1' }
  );
  const [row] = advocatedRoots(deep);
  assert.deepEqual(row.kids.map((k) => k.id), ['x-1.1', 'x-1.2'], 'the brief says "children" and means children');
  assert.deepEqual(
    row.tree.map((k) => k.id).sort(),
    ['x-1.1', 'x-1.1.1', 'x-1.2'],
    'an epic whose children are epics has its movement a level down'
  );
});

await check('two enrolled epics come back in a decided order', () => {
  const two = index([p0('x-10'), p0('x-2')], {});
  assert.deepEqual(advocatedRoots(two).map((r) => r.epic.id), ['x-2', 'x-10'], 'numerically, not by export order');
});

/* --------------------------------------------------------------- what is news */

const treeOf = (idx) => advocatedRoots(idx)[0].tree;

await check('a first sight learns and says nothing', () => {
  const out = reentryFor(null, treeOf(subtree()));
  assert.equal(out.first, true);
  assert.equal(out.reason, null, 'every child looks new with nothing to compare against');
  assert.deepEqual(out.record.kids, { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' });
  assert.equal(out.record.at, null, 'and no window has been opened on it');
});

await check('a child that closed is the news', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' } };
  const out = reentryFor(prev, treeOf(subtree({ 'x-1.1': { status: 'closed' } })));
  assert.match(out.reason, /`x-1\.1` has closed under it/);
  assert.deepEqual(out.events.closed, ['x-1.1']);
  // The same close is not news twice: the snapshot now says closed.
  assert.equal(reentryFor(out.record, treeOf(subtree({ 'x-1.1': { status: 'closed' } }))).reason, null);
});

await check('a child that was filed is the news, and a child that started is not', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open' } };
  const out = reentryFor(prev, treeOf(subtree()));
  assert.match(out.reason, /`x-1\.3` was filed under it/);
  // `open → in_progress` is a worker window coming up, which is the system working. On a
  // subtree of thirty that flip is most of the traffic there is, and a supervisor woken by
  // it would be woken by dispatch rather than by anything needing judgement.
  const started = reentryFor({ kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' } }, treeOf(subtree({ 'x-1.1': { status: 'in_progress' } })), { busy: () => true });
  assert.equal(started.reason, null, 'a child being picked up is not an event');
});

await check('a child deleted out from under the P0 reads as closed, not as nothing', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open', 'x-1.9': 'open' } };
  const out = reentryFor(prev, treeOf(subtree()));
  assert.match(out.reason, /`x-1\.9` has closed under it/, 'something it planned is no longer there');
});

await check('several events in one sweep are one sentence', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open' } };
  const out = reentryFor(prev, treeOf(subtree({ 'x-1.1': { status: 'closed' } })));
  assert.match(out.reason, /`x-1\.1` has closed under it; `x-1\.3` was filed under it/, 'a burst collapses');
});

await check('four or more ids are a count, not a list', () => {
  const wide = index(
    [p0('x-1'), bead('x-1.1'), bead('x-1.2'), bead('x-1.3'), bead('x-1.4'), bead('x-1.5')],
    { 'x-1.1': 'x-1', 'x-1.2': 'x-1', 'x-1.3': 'x-1', 'x-1.4': 'x-1', 'x-1.5': 'x-1' }
  );
  const out = reentryFor({ kids: {} }, treeOf(wide));
  assert.match(out.reason, /and 2 more were filed under it/);
});

/* ------------------------------------------------------------------- a stall */

await check('a stall needs two sweeps, and clears when somebody arrives', () => {
  const stalled = () => treeOf(subtree({ 'x-1.2': { status: 'in_progress' } }));
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' } };
  const t0 = Date.parse('2026-08-14T00:00:00Z');

  const first = reentryFor(seen, stalled(), { now: t0 });
  assert.equal(first.reason, null, 'the clock starts on the first look, so a launch cannot race it');
  assert.deepEqual(Object.keys(first.record.stalls), ['x-1.2']);

  const hour = reentryFor(first.record, stalled(), { now: t0 + 61 * 60000 });
  assert.match(hour.reason, /`x-1\.2` has been in progress for over 1h/);
  assert.deepEqual(hour.events.stalled, ['x-1.2']);

  assert.equal(
    reentryFor(hour.record, stalled(), { now: t0 + 600 * 60000 }).reason,
    null,
    'and it is reported once, not every sweep for a week'
  );
  assert.equal(
    reentryFor(first.record, stalled(), { now: t0 + 61 * 60000, busy: () => true }).reason,
    null,
    'somebody is in a window on it, so it is being worked rather than stalled'
  );
});

await check('a stall that resolved can stall again', () => {
  const t0 = Date.parse('2026-08-14T00:00:00Z');
  const stalled = () => treeOf(subtree({ 'x-1.2': { status: 'in_progress' } }));
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' } };
  const fired = reentryFor(reentryFor(seen, stalled(), { now: t0 }).record, stalled(), { now: t0 + 61 * 60000 });
  // Somebody picks it up: the clock and the report both drop out of the record.
  const picked = reentryFor(fired.record, stalled(), { now: t0 + 70 * 60000, busy: () => true });
  assert.deepEqual(picked.record.stalls, {});
  assert.deepEqual(picked.record.stalled, []);
  // Their window dies, and it is a fresh stall an hour later.
  const again = reentryFor(picked.record, stalled(), { now: t0 + 80 * 60000 });
  assert.equal(again.reason, null, 'the clock restarts');
  assert.match(reentryFor(again.record, stalled(), { now: t0 + 200 * 60000 }).reason, /in progress for over 1h/);
});

/* ------------------------------------- the two endings that are not stalls (bc-xl7n.98) */

const IN_PROGRESS = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' } };
const T0 = Date.parse('2026-08-18T00:00:00Z');
/** Two sweeps an hour apart, which is what a stall needs before it is reported at all. */
const twoSweeps = (make, opts = {}) => {
  const first = reentryFor(IN_PROGRESS, treeOf(make()), { ...opts, now: T0 });
  return reentryFor(first.record, treeOf(make()), { ...opts, now: T0 + 61 * 60000 });
};

await check("a handed-back child is not a stall — the question is Adam's to answer", () => {
  // bc-xl7n.25: the daemon's own log said it had handed the bead back, and the next sweep
  // reported it to this epic's advocate as in progress with nobody in a window on it. Both
  // sentences were true, and only one of them was worth a window.
  const asked = () => subtree({ 'x-1.2': { status: 'in_progress', labels: ['human'] } });
  assert.equal(twoSweeps(asked).reason, null, 'a question on the bead is not a dead window');
  assert.deepEqual(twoSweeps(asked).record.stalls, {}, 'and it is not on the clock either');

  // The free half is exactly one label, asked of the row the sweep already has in its hand.
  assert.equal(handedBack({ labels: ['human'] }), true);
  assert.equal(handedBack({ labels: ['owner:adam@example.com'] }), false);
  assert.equal(handedBack({}), false);

  // And the moment the answer lands the label comes off, so the clock starts again: a
  // window that died *after* its question was answered is a stall like any other.
  const answered = () => subtree({ 'x-1.2': { status: 'in_progress' } });
  assert.match(twoSweeps(answered).reason, /`x-1\.2` has been in progress for over 1h/);
});

await check('a delivered child is not a stall — its pull request is waiting on a tap', () => {
  // bc-8t3b: #426 open, the worktree live, a `pr-delivery` card open beside it — and the
  // work bead carrying no `human` label at all, because `park` is called with
  // `label: false`. The half above cannot see this one, which is why there are two.
  const delivery = () =>
    subtree(
      { 'x-1.2': { status: 'in_progress' } },
      [['x-1.2', 'q-1']],
      [card('q-1', ['human', 'pr-delivery'])]
    );
  assert.equal(
    handedBack(treeOf(delivery()).find((r) => r.id === 'x-1.2')),
    false,
    'the card is the `human` one; the work bead is deliberately not'
  );
  assert.equal(
    twoSweeps(delivery, { delivered: waitingOnMerge(delivery()) }).reason,
    null,
    'a pull request waiting on a tap is not a dead window'
  );

  // The queue's own bead is the other half of the same structure, and it is not `human`.
  const queued = () =>
    subtree({ 'x-1.2': { status: 'in_progress' } }, [['x-1.2', 'm-1']], [card('m-1', ['merge-queue'])]);
  assert.equal(twoSweeps(queued, { delivered: waitingOnMerge(queued()) }).reason, null);

  // And when the merge lands that bead closes, so the clock restarts — a window that died
  // after its delivery was answered is a stall like any other.
  const merged = () =>
    subtree(
      { 'x-1.2': { status: 'in_progress' } },
      [['x-1.2', 'm-1']],
      [card('m-1', ['merge-queue'], { status: 'closed' })]
    );
  assert.match(
    twoSweeps(merged, { delivered: waitingOnMerge(merged()) }).reason,
    /`x-1\.2` has been in progress for over 1h/,
    'an answered delivery holds nothing'
  );
});

await check('a child epic with an advocate of its own is not a stall — bc-xl7n.118', () => {
  // The third shape, and the only one where reporting it does damage rather than costing
  // a window. `in_progress` on a **root** is not a worker's claim: `boardMove` writes it
  // when Adam presses Start, deliberately in the tracker so the board is the same fact on
  // every device, and nothing takes it off but a close or a second Start. So a
  // board-started sub-epic has no worker, no lease, no `human` label and no delivery — the
  // three exclusions above all miss it — and the brief's prescription for a stall,
  // `bd update <id> --status open --assignee ""`, is that write's exact inverse.
  //
  // Measured on bc-xl7n.113, started from the board 2026-08-21T11:14:24Z and reported in
  // every `bc-xl7n` re-entry reason from 16:27:37Z on, four sweeps and counting, while its
  // own advocate ran it correctly the whole time.
  const supervisedKid = () =>
    subtree({ 'x-1.2': { status: 'in_progress', issue_type: 'epic', labels: [OWNER, ADVOCATE_LABEL] } });
  assert.equal(twoSweeps(supervisedKid).reason, null, 'somebody else is looking after it');
  assert.deepEqual(twoSweeps(supervisedKid).record.stalls, {}, 'and it is not on the clock either');

  // Free off the same row the sweep already holds, exactly like `handedBack`: one label,
  // no read. The label is what every route stamps — the board start, the sweep's own
  // launch and `POST /api/bead/advocate` all leave it behind — which is why the wider
  // class (any supervised sub-epic, however it got there) is the one excluded rather than
  // "is it on the board", a fact the tracker records nowhere but the status.
  assert.equal(supervised({ labels: [ADVOCATE_LABEL] }), true);
  assert.equal(supervised({ labels: [OWNER] }), false);
  assert.equal(supervised({}), false);

  // And the asymmetry that keeps the sweep honest: take the advocate off and nobody is
  // watching it but this epic, so the clock starts again.
  const unassigned = () =>
    subtree({ 'x-1.2': { status: 'in_progress', issue_type: 'epic', labels: [OWNER] } });
  assert.match(twoSweeps(unassigned).reason, /`x-1\.2` has been in progress for over 1h/);
});

await check('a dead window with no pull request and no question is still reported', () => {
  // The failure the sweep exists for, and the one thing neither half above may swallow.
  const dead = () => subtree({ 'x-1.2': { status: 'in_progress' } });
  assert.match(twoSweeps(dead, { delivered: waitingOnMerge(dead()) }).reason, /in progress for over 1h/);

  // A blocker that is not a delivery is not one: a bead waiting on an ordinary question,
  // or on another piece of work, is still a claim nobody is in a window on.
  const other = () =>
    subtree({ 'x-1.2': { status: 'in_progress' } }, [['x-1.2', 'q-9']], [card('q-9', ['human'])]);
  assert.match(
    twoSweeps(other, { delivered: waitingOnMerge(other()) }).reason,
    /in progress for over 1h/,
    'the label on the blocker is what says "delivery" — not the bare fact of being blocked'
  );
});

await check('what `waitingOnMerge` will and will not call a delivery', () => {
  const row = (id) => ({ id });
  const built = (deps, extra) =>
    waitingOnMerge(subtree({ 'x-1.2': { status: 'in_progress' } }, deps, extra));

  assert.equal(built([['x-1.2', 'q-1']], [card('q-1', ['human', 'pr-delivery'])])(row('x-1.2')), true);
  assert.equal(built([['x-1.2', 'm-1']], [card('m-1', ['merge-queue'])])(row('x-1.2')), true);

  // Closed: the card was answered or the merge landed, and this bead is on its own again.
  assert.equal(
    built([['x-1.2', 'q-1']], [card('q-1', ['human', 'pr-delivery'], { status: 'closed' })])(row('x-1.2')),
    false
  );
  // A `relates-to` to a delivery card is a mention, not a park. Only the edge `bd dep add`
  // writes takes a bead out of the queue, so only that edge answers here.
  assert.equal(
    built([['x-1.2', 'q-1', 'relates-to']], [card('q-1', ['human', 'pr-delivery'])])(row('x-1.2')),
    false
  );
  // Direction: the *work* is parked behind the card, never the other way about. The pair
  // key is unordered, so this is the case a `from~to` key would quietly have got right for
  // the wrong reason.
  assert.equal(
    built([['q-1', 'x-1.2']], [card('q-1', ['human', 'pr-delivery'])])(row('x-1.2')),
    false,
    'a card blocked by the work is not the work blocked by a card'
  );
  // A blocker the index has never heard of cannot be read as open: the card is filed into
  // the same workspace as the work by construction, so a miss here is a broken export.
  assert.equal(built([['x-1.2', 'gone']], [])(row('x-1.2')), false);

  // An index with no edges at all — `Bd.graph` after a failed export, and every fixture in
  // this file that only ever cared about parents — answers "nothing is delivered", which
  // is the direction where a real stall is still reported.
  assert.equal(waitingOnMerge({ beads: new Map(), edges: new Map() })(row('x-1.2')), false);
  assert.equal(waitingOnMerge(null)(row('x-1.2')), false);
  assert.equal(waitingOnMerge({ beads: new Map([['x-1.2', bead('x-1.2')]]) })(row('x-1.2')), false);
});

/* ---------------------------------------------------------- bc-xl7n.99: which card, by id

   `waitingOnMerge` only ever answered the boolean `reentryFor` needs. The id was sitting
   right there in the same walk, unread — `epicAdvocatePrompt`'s child list wants to say
   what a delivered child is waiting on, not only that it is. Same fixtures, same edge
   walk, so a divergence between the two would be a real bug rather than a new one. */

await check('`waitingOnMergeCard` answers the same question as `waitingOnMerge`, by id', () => {
  const row = (id) => ({ id });
  const built = (deps, extra) =>
    waitingOnMergeCard(subtree({ 'x-1.2': { status: 'in_progress' } }, deps, extra));

  assert.equal(built([['x-1.2', 'q-1']], [card('q-1', ['human', 'pr-delivery'])])(row('x-1.2')), 'q-1');
  assert.equal(built([['x-1.2', 'm-1']], [card('m-1', ['merge-queue'])])(row('x-1.2')), 'm-1');

  // Everywhere `waitingOnMerge` answers false, this answers null rather than an empty
  // string or `undefined` — a caller templating it straight into a sentence must not print
  // the word "null" or "undefined" for a bead that is not parked at all.
  assert.equal(
    built([['x-1.2', 'q-1']], [card('q-1', ['human', 'pr-delivery'], { status: 'closed' })])(row('x-1.2')),
    null
  );
  assert.equal(built([['x-1.2', 'gone']], [])(row('x-1.2')), null);
  assert.equal(waitingOnMergeCard({ beads: new Map(), edges: new Map() })(row('x-1.2')), null);
  assert.equal(waitingOnMergeCard(null)(row('x-1.2')), null);
});

await check('the rate limit is stated in the module that argues for it', () => {
  assert.equal(REENTER_DEFAULTS.reenterAdvocates, true, 'on by default, or bc-rfnr.3 is still undelivered');
  assert.ok(REENTER_DEFAULTS.reenterCooldownMinutes >= 60, 'a floor under an hour is not a rate limit');
  assert.ok(REENTER_DEFAULTS.reenterIntervalMinutes >= 1);
  assert.ok(REENTER_DEFAULTS.reenterStallMinutes >= 30);
});

/* --------------------------------------------------------------------- a tick */

/**
 * One advocate tick over a graph that says what the case needs it to.
 *
 * `advocated` and `lastReenterAt` are seeded through advocates.json rather than by running
 * two ticks, because that is what a restart hands the daemon and because it is the only way
 * to drive a cooldown without waiting three hours.
 */
async function tick({
  graph = subtree(),
  advocated = null,
  lastReenterAt = null,
  workers = [],
  sessions = [],
  paused = false,
  overrides = {},
  refuse = null,
  ready = [],
  ticks = 1,
  labelFails = false,
} = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) await removeTree(path.join(SESSIONS, f));
  for (const s of sessions) fs.writeFileSync(path.join(SESSIONS, `${s.pid}.json`), JSON.stringify(s));
  if (advocated || lastReenterAt || workers.length || paused) {
    fs.writeFileSync(
      path.join(dir, 'advocates.json'),
      JSON.stringify({ alpha: { workers, paused, advocated: advocated || {}, lastReenterAt } })
    );
  }

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    advocates: {
      enabled: true,
      workspaces: '*',
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Features with their own suites, each of which would otherwise run real git, a real
      // `gh` or a real agent against a temp directory on every case here.
      propose: false,
      sessionLog: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      flagNotInMain: false,
      // Shells out to `gh` and `git` against a temp directory otherwise, which is noise.
      holdOpenPrs: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  forgetAdvocateOpened();
  const advocates_ = [];
  const workers_ = [];
  const planners_ = [];
  const calls = { graph: 0, cached: 0, comments: [], labels: [] };
  const bd = {
    /**
     * The assignment write, recorded rather than performed — bc-r2b5.1. Failing soft is
     * asserted separately (`labelFails`), because a label write that throws must not undo
     * a window that is already open.
     */
    addLabel: async (_ws, id, label) => {
      if (labelFails) throw new Error('bd: the tracker is mid-write');
      calls.labels.push([id, label]);
    },
    ready: async () => ready,
    listLabel: async () => [],
    listStatus: async () => [],
    show: async (_ws, id) => ({ id, title: id, status: 'open' }),
    /**
     * Off the graph fixture rather than a flat `[]` — bc-jvt0.4.
     *
     * This used to answer "no children" for every epic, including the one this whole file
     * is about, which the suite's own `subtree()` gives three. Nothing noticed while the
     * only reader was `heldByChildren`'s open-children check, because none of them is open
     * in the cases that reach it. Its fourth check reads `children.length` — an epic with
     * *nothing at all* under it is one nobody has decided the shape of — and read x-1 as
     * childless, so the control half of the launch case below stopped launching. The
     * fixture was wrong rather than the check: `parents` already says what is under x-1.
     */
    children: async (_ws, id) =>
      [...(graph.parents || new Map()).entries()]
        .filter(([, parent]) => parent === id)
        .map(([kid]) => graph.beads?.get(kid) || { id: kid, status: 'open' }),
    comments: async (_ws, id) => {
      calls.comments.push(id);
      return [];
    },
    /**
     * Counted in two piles, because two unrelated things read the graph on a tick and
     * one counter cannot answer for both — which is the whole of bc-68ou.7.
     *
     * `reenter` reads it *waiting*: it wants the export, and it is that cost the
     * interval gate and the off switch exist to bound. `rosterFor` reads it with
     * `wait: false` on every tick, taking whatever `Bd.graph`'s one-minute cache has
     * on hand and never blocking — the roster is a display, and it is deliberately
     * rebuilt whole rather than accumulated. The two landed a day apart on branches
     * neither of which could see the other, so this suite's single `calls.graph`
     * started counting the roster's reads as the sweep's and reported four exports in
     * three ticks where the sweep had made one.
     *
     * So `graph` is the sweep's pile and `cached` is the roster's, and the cases below
     * assert both: an assertion that ignored the roster would go quietly wrong again
     * the day the roster starts waiting.
     */
    graph: async (_ws, opts = {}) => {
      if (opts.wait === false) calls.cached += 1;
      else calls.graph += 1;
      return graph;
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    // Both of the other doors, stubbed: the defaults drive iTerm, and a fixture that
    // reaches one opens a real window on Adam's Mac. See the advocate-tick-fixtures note.
    // Recorded rather than thrown from, because one case below is precisely about a worker
    // that must *not* be opened and an assertion says that better than a stack trace.
    open: async (_cfg, _ws, b) => {
      workers_.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    openPlan: async (_cfg, _ws, b) => {
      planners_.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    openAdvocate: async (_cfg, ws, row, opts = {}) => {
      if (refuse) throw Object.assign(new Error(refuse), { status: 409 });
      advocates_.push({
        workspace: ws.name,
        id: row.id,
        reason: opts.reason || '',
        kids: (opts.kids || []).map((k) => k.id),
        plan: opts.plan,
      });
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  for (let i = 0; i < ticks; i += 1) await advocates.tick();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8'));
  const card = advocates.snapshot().find((x) => x.workspace === 'alpha') || {};
  return { opened: advocates_, workers: workers_, planners: planners_, calls, card, state: saved.alpha || {} };
}

const SEEN = { kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' }, at: null };
const LONG_AGO = '2020-01-01T00:00:00Z';

await check('the first tick a daemon ever runs opens nothing and remembers everything', async () => {
  const r = await tick();
  assert.deepEqual(r.opened, [], 'a first sight is silent');
  assert.deepEqual(r.state.advocated['x-1'].kids, { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' });
  assert.ok(r.state.lastReenterAt, 'and the clock is persisted, so a restart does not re-sweep instantly');
});

await check('a child closing re-opens the advocate, with the reason on the brief', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': SEEN },
  });
  assert.equal(r.opened.length, 1);
  assert.equal(r.opened[0].id, 'x-1');
  assert.equal(r.opened[0].workspace, 'alpha');
  assert.match(r.opened[0].reason, /`x-1\.1` has closed under it/);
  assert.deepEqual(r.opened[0].kids, ['x-1.2', 'x-1.3', 'x-1.1'], 'open children first, closed tail last');
  assert.deepEqual(r.calls.comments, ['x-1'], 'the plan is read for the P0 getting a window and no other');
  assert.ok(r.state.advocated['x-1'].at, 'and the cooldown clock is stamped');
});

await check('the tap survives a window that died before writing anything — bc-r2b5.1', async () => {
  // **The acceptance, driven end to end and with no waiting-on block anywhere in it.**
  // The state under test is the one the button leaves behind and nothing else touched: the
  // label is on the epic, `notes` is empty because the window that was opened never got as
  // far as its own last instruction, and a child has since closed. Before this bead that
  // epic was invisible to the sweep and the only way back was a second tap.
  const dead = index(
    [assigned('x-1'), bead('x-1.1', { status: 'closed' }), bead('x-1.2'), bead('x-1.3')],
    { 'x-1.1': 'x-1', 'x-1.2': 'x-1', 'x-1.3': 'x-1' }
  );
  const r = await tick({ graph: dead, advocated: { 'x-1': SEEN } });
  assert.equal(r.opened.length, 1, 'the epic is still assigned, so the next qualifying event re-opens it');
  assert.equal(r.opened[0].id, 'x-1');
  assert.match(r.opened[0].reason, /`x-1\.1` has closed under it/);
  // And nothing re-writes a label the epic already carries — this is a `bd` spawn, and the
  // sweep runs on every enrolled epic every ten minutes.
  assert.deepEqual(r.calls.labels, [], 'an epic already assigned costs no write');
});

await check("the sweep's own launch records the assignment too", async () => {
  // The second door. An epic enrolled by its sentence alone is upgraded to the carrier
  // that survives a window dying — which is the point of the label, and it is the door
  // Adam is not standing at, so nothing else would ever write it there.
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': SEEN },
  });
  assert.equal(r.opened.length, 1);
  assert.deepEqual(r.calls.labels, [['x-1', ADVOCATE_LABEL]], 'the launch is what records the assignment');
});

await check('a label write that fails does not undo the window that is already open', async () => {
  // The direction that matters: the window is up, and throwing over the top of it would
  // consume the event, back the epic off for three hours and say nothing happened.
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': SEEN },
    labelFails: true,
  });
  assert.equal(r.opened.length, 1, 'the launch stands');
  assert.ok(r.state.advocated['x-1'].at, 'and the cooldown is stamped, so it is not re-argued in ten minutes');
});

await check('the reason a window is being held rides the record the card reads', async () => {
  // bc-r2b5.1's other half. Three of the five hold reasons are things only a tick can see
  // — its own one-window budget, a worker this advocate is holding, a lease on another
  // Mac — so the board card reports what the sweep decided rather than re-deriving it.
  const held = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: new Date().toISOString() } },
  });
  assert.deepEqual(held.opened, [], 'inside the cooldown');
  assert.match(held.state.advocated['x-1'].hold.why, /its last one was \d+m ago and the floor is 180m/);
  assert.ok(held.state.advocated['x-1'].hold.at, 'and when that was decided, because it is persisted and can go stale');
  assert.deepEqual(held.state.advocated['x-1'].kids, SEEN.kids, 'the event still survives being held');

  // A pause is the first of the five, and it must win over the cooldown beside it.
  const paused = await tick({
    graph: subtree({ p0: { labels: [OWNER, 'advocate-paused'] }, 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.equal(paused.state.advocated['x-1'].hold.why, 'it is paused');

  // And a window that opens clears it, rather than leaving yesterday's reason on a card
  // that is drawing a live session.
  const ran_ = await tick({ graph: subtree({ 'x-1.1': { status: 'closed' } }), advocated: { 'x-1': { ...SEEN, at: LONG_AGO } } });
  assert.equal(ran_.opened.length, 1);
  assert.equal(ran_.state.advocated['x-1'].hold, undefined, 'nothing is being held — a window just opened');
});

await check('the sweep looks on an interval, not on every tick', async () => {
  const r = await tick({ graph: subtree({ 'x-1.1': { status: 'closed' } }), advocated: { 'x-1': SEEN }, ticks: 3 });
  assert.equal(r.calls.graph, 1, 'three ticks, one export — the tick is every 30 seconds');
  assert.equal(r.calls.cached, 3, 'the roster still rebuilds every tick, off the cache, and pays no export for it');
  assert.equal(r.opened.length, 1);
});

await check('one window per tick, and the P0 that did not get it keeps its event', async () => {
  const two = index(
    [p0('x-1'), bead('x-1.1', { status: 'closed' }), p0('x-2'), bead('x-2.1', { status: 'closed' })],
    { 'x-1.1': 'x-1', 'x-2.1': 'x-2' }
  );
  const r = await tick({
    graph: two,
    advocated: { 'x-1': { kids: { 'x-1.1': 'open' } }, 'x-2': { kids: { 'x-2.1': 'open' } } },
  });
  assert.deepEqual(r.opened.map((o) => o.id), ['x-1'], 'one at a time');
  assert.deepEqual(
    r.state.advocated['x-2'].kids,
    { 'x-2.1': 'open' },
    'x-2 still believes its child is open, so the next sweep opens a window for it'
  );
});

await check('inside the cooldown nothing opens, and the event is not consumed', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: new Date().toISOString() } },
  });
  assert.deepEqual(r.opened, [], 'three hours between two automatic windows on one P0');
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'the close is still news when the floor lapses');
});

await check('past the cooldown the held event opens the window it was waiting for', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.equal(r.opened.length, 1);
  assert.match(r.opened[0].reason, /`x-1\.1` has closed under it/);
});

await check('never two on one P0 — a live session naming it holds the window', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    // `process.pid` because lib/claude.js liveness-checks every record before returning it,
    // so a made-up pid is filtered out before the code under test sees it.
    sessions: [{ pid: process.pid, sessionId: 's1', name: 'Beadcause - x-1 taking stock', cwd: REPO, status: 'idle' }],
  });
  assert.deepEqual(r.opened, [], 'one advocate per P0, whatever opened it');
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'and the event waits for that window to end');
});

await check('a dead session record holds nothing', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    sessions: [{ pid: 999999, sessionId: 's1', name: 'Beadcause - x-1 taking stock', cwd: REPO, status: 'idle' }],
  });
  assert.equal(r.opened.length, 1, 'a stale record is not a window');
});

await check('a live lease on the P0 holds it — that window is on another Mac', async () => {
  // The one guard here whose evidence cannot be seen on this laptop at all: every other
  // check reads a process table or a file in this process. A `held:` label is a claim in
  // the shared tracker, and a second supervisor arguing about the same subtree from two
  // machines is exactly what lib/lease.js exists to prevent.
  const r = await tick({
    graph: subtree({ p0: { labels: [OWNER, leaseLabel('other-mac', new Date())] }, 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'and the event waits for the lease to lapse');
  // A lease from a fortnight ago is not a window.
  const stale = await tick({
    graph: subtree({
      p0: { labels: [OWNER, leaseLabel('other-mac', new Date(Date.parse('2020-01-01T00:00:00Z')))] },
      'x-1.1': { status: 'closed' },
    }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.equal(stale.opened.length, 1);
});

await check('a stalled child is not stalled while this advocate holds a worker on it', async () => {
  // The stall clock's own `busy` answer, driven through the tick rather than the pure
  // function: a worker in `a.workers` is a window that has not named itself yet, which is
  // the case a session-records read cannot see.
  const stalling = subtree({ 'x-1.2': { status: 'in_progress' } });
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' }, stalls: { 'x-1.2': 1 }, at: LONG_AGO };
  const held = await tick({
    graph: stalling,
    advocated: { 'x-1': seen },
    // `at` is now rather than the fixtures' usual constant, or reconcile reaps it before
    // the sweep runs — see the advocate-tick-fixtures note.
    workers: [{ id: 'x-1.2', title: 'x-1.2', at: new Date().toISOString(), batch: [], attempt: 1 }],
  });
  assert.deepEqual(held.opened, [], 'somebody is in a window on it, so it is being worked');
  const loose = await tick({ graph: stalling, advocated: { 'x-1': seen } });
  assert.equal(loose.opened.length, 1, 'and with nobody on it, an hour old, it is a stall');
  assert.match(loose.opened[0].reason, /in progress for over 1h/);
});

await check('the three ways one window stands for a bead — bc-2uj4.9', () => {
  // The pure half of `busy`'s first arm. A window is briefed on beads that are not its
  // `id` in two different ways, and until bc-2uj4.9 only one of them was written down.
  const plain = { id: 'x-1.1', batch: [] };
  const head = { id: 'x-1.1', batch: ['x-1.2', 'x-1.3'] };
  const lead = { id: 'x-1.1', batch: [], group: { epic: 'x-1', name: 'the board', beads: ['x-1.2'] } };

  assert.equal(workerHolds([plain], 'x-1.1'), true, 'its own bead');
  assert.equal(workerHolds([plain], 'x-1.2'), false, 'and nobody else’s');
  assert.equal(workerHolds([head], 'x-1.3'), true, 'a batch head is briefed on every id in it');
  assert.equal(workerHolds([lead], 'x-1.2'), true, "a group's lead is briefed on the group's other beads");
  assert.equal(workerHolds([lead], 'x-1.3'), false, 'a group is a slice of the subtree, not the subtree');

  // The two shapes a record can have from before this landed, and neither may throw: a
  // daemon reads `advocates.json` back across its own restart, so every worker open when
  // this merged comes back with a `group` that has no `beads` — or none at all.
  assert.equal(workerHolds([{ id: 'x-1.1', group: { epic: 'x-1', name: 'the board' } }], 'x-1.2'), false);
  assert.equal(workerHolds([{ id: 'x-1.1' }], 'x-1.2'), false);
  assert.equal(workerHolds([null, undefined], 'x-1.2'), false);
  assert.equal(workerHolds(null, 'x-1.2'), false, 'and an advocate with no workers holds nothing');
});

await check("a plan group's other bead is not a stall while the group's window is live", async () => {
  // The bug itself, through the tick. One window carries the whole group and marks every
  // bead of it `in_progress`, but only the **lead** is `w.id`, only the lead is named in
  // the session, and only the lead gets the fresh lease — so before bc-2uj4.9 all three of
  // `busy`'s arms missed `x-1.2` and an hour later the sweep reported it stalled and
  // re-opened a P0 advocate over a bead that was mid-delivery. Measured on bc-rfnr.9.
  const stalling = subtree({ 'x-1.2': { status: 'in_progress' } });
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' }, stalls: { 'x-1.2': 1 }, at: LONG_AGO };
  // `at` is now, or reconcile reaps the worker before the sweep runs — see the
  // advocate-fixture-live-sessions note.
  const worker = (group) => [{ id: 'x-1.1', title: 'x-1.1', at: new Date().toISOString(), batch: [], attempt: 1, group }];

  const held = await tick({
    graph: stalling,
    advocated: { 'x-1': seen },
    workers: worker({ epic: 'x-1', name: 'the board', beads: ['x-1.2'] }),
  });
  assert.deepEqual(held.opened, [], 'the lead’s window is working x-1.2 as well, so nobody is missing');

  // And the ids are what answer it, not the group's mere presence: a record written before
  // bc-2uj4.9 landed carries `group` without them, and that bead is still a stall — which
  // is the correct reading, because nothing on it can say the window covers x-1.2.
  const legacy = await tick({
    graph: stalling,
    advocated: { 'x-1': seen },
    workers: worker({ epic: 'x-1', name: 'the board' }),
  });
  assert.equal(legacy.opened.length, 1);
  assert.match(legacy.opened[0].reason, /in progress for over 1h/);
});

await check('a live lease on a *child* holds the stall too — that window is on another Mac', async () => {
  // The arm of `busy` the sweep's own sentence has always claimed and could not check: the
  // tree rows it is asked about are `treeUnder`'s, which carry no labels, so `leasesOf`
  // answered `[]` for every child however fresh the lease was. `labelled` in lib/reenter.js
  // is what puts them back. The epic itself never had the gap — `busy(epic)` is handed a
  // bead off the index — which is why nothing here caught it before.
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' }, stalls: { 'x-1.2': 1 }, at: LONG_AGO };
  const leased = await tick({
    graph: subtree({ 'x-1.2': { status: 'in_progress', labels: [leaseLabel('other-mac', new Date())] } }),
    advocated: { 'x-1': seen },
  });
  assert.deepEqual(leased.opened, [], 'another Mac is in a window on it');
  // And a lease from a fortnight ago is not a window, so the stall stands.
  const stale = await tick({
    graph: subtree({
      'x-1.2': { status: 'in_progress', labels: [leaseLabel('other-mac', new Date(Date.parse('2020-01-01T00:00:00Z')))] },
    }),
    advocated: { 'x-1': seen },
  });
  assert.equal(stale.opened.length, 1);
  assert.match(stale.opened[0].reason, /in progress for over 1h/);
});

await check('the two endings hold the stall through the whole tick, and nothing else does', async () => {
  // The seam this bead is actually about: `waitingOnMerge` is built inside `reenter` off
  // the index it already has, so a case that only drove `reentryFor` would pass with the
  // daemon still opening the window.
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' }, stalls: { 'x-1.2': 1 }, at: LONG_AGO };

  const asked = await tick({
    graph: subtree({ 'x-1.2': { status: 'in_progress', labels: ['human'] } }),
    advocated: { 'x-1': seen },
  });
  assert.deepEqual(asked.opened, [], 'a question on the bead is Adam\'s to answer, not a supervisor\'s');

  const delivered = await tick({
    graph: subtree(
      { 'x-1.2': { status: 'in_progress' } },
      [['x-1.2', 'q-1']],
      [card('q-1', ['human', 'pr-delivery'])]
    ),
    advocated: { 'x-1': seen },
  });
  assert.deepEqual(delivered.opened, [], 'a pull request waiting on a tap is not a dead window');

  const bare = await tick({ graph: subtree({ 'x-1.2': { status: 'in_progress' } }), advocated: { 'x-1': seen } });
  assert.equal(bare.opened.length, 1, 'and the failure the sweep exists for still opens one');
  assert.match(bare.opened[0].reason, /in progress for over 1h/);
});

await check('a paused advocate opens no windows of any kind', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    paused: true,
  });
  assert.deepEqual(r.opened, [], 'paused means open no more sessions, and this opens one');
});

await check('the off switch is off', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    overrides: { reenterAdvocates: false },
  });
  assert.deepEqual(r.opened, [], 'and beadcause is back to a button');
  assert.equal(r.calls.graph, 0, 'off costs nothing, not even the export');
  // The roster's read is not the sweep's and is not switched off with it: an advocate
  // with `reenterAdvocates: false` still draws its EpicAdvocate card, and that read
  // costs whatever the cache already holds. See the note on the fake's `graph`.
  assert.equal(r.calls.cached, 1, 'and the roster is unaffected — it is a different feature');
});

await check('a refused launch backs off for the cooldown and keeps the event', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    refuse: 'x-1 may not have an Epic Advocate — nobody owns it',
  });
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'the event survives a launch that threw');
  assert.notEqual(r.state.advocated['x-1'].at, LONG_AGO, 'and it is not re-argued every ten minutes');
});

await check('a graph that would not answer changes nothing', async () => {
  // `Bd.graph` swallows its own failures and hands back an empty index carrying `error`.
  // Reading that as "nothing is enrolled" would prune every snapshot, and the next
  // successful sweep would then read a whole subtree as newly filed.
  const r = await tick({
    graph: { parents: new Map(), beads: new Map(), error: 'bd export timed out' },
    advocated: { 'x-1': SEEN },
  });
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'the snapshot is left exactly as it was');
});

await check('an epic that is no longer enrolled is forgotten', async () => {
  const r = await tick({
    graph: subtree({ p0: { notes: 'the advocate took its sentence off' }, 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.deepEqual(r.opened, [], 'un-enrolling is the off switch that costs no new control');
  assert.deepEqual(r.state.advocated, {}, 'and it comes back as a first sight, which is silent');
});

await check('the window it just opened holds the same bead out of the queue', async () => {
  // The collision this closes is the worst failure in the file (bc-vq78): two windows in
  // one worktree. A window carries no bead id in its name until its first turn has run, so
  // for about a minute the launch has happened and nothing on disk says so — and a P0 in
  // `bd ready` is a bead the survey will happily open a *worker* on in that minute. It was
  // a second or two wide while only a tap could open an advocate; a sweep makes it real.
  const queued = [{ id: 'x-1', title: 'x-1', priority: 0, issue_type: 'epic', status: 'open', created_at: '2020-01-01T00:00:00Z', labels: [OWNER] }];
  // **Every child closed, and this case is the only one in the file that needs it.** The
  // subject here is `heldByLive` — a window that is up and has not named itself yet — so
  // x-1 has to be a bead the survey would otherwise launch, and `heldByChildren` holds an
  // epic with an open child for its own unrelated reason. It used to be a leaf by accident,
  // because the fake `bd.children` answered `[]` for everything; now it answers off the
  // graph, so the fixture has to say what it means. Not childless either — an epic with
  // *nothing* under it is one bc-jvt0.4 holds until its advocate has judged it.
  const args = {
    graph: subtree({
      'x-1.1': { status: 'closed' },
      'x-1.2': { status: 'closed' },
      'x-1.3': { status: 'closed' },
    }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    ready: queued,
  };
  // The control first, or this asserts nothing: with the sweep off, that queue row is a
  // bead the advocate opens a window on.
  const control = await tick({ ...args, overrides: { reenterAdvocates: false } });
  assert.deepEqual(control.opened, []);
  assert.deepEqual(control.workers, ['x-1'], 'the row does reach a launch when nothing is holding it');

  const r = await tick(args);
  assert.deepEqual(r.opened.map((o) => o.id), ['x-1'], 'the advocate was re-opened');
  assert.deepEqual(r.workers, [], 'and no second window went into the same checkout');
  assert.deepEqual(r.planners, []);
  assert.match(
    (r.card.heldByLive || []).map((h) => h.why).join(' '),
    /has not named itself yet/,
    'held, and said out loud — the card carries every other hold this way'
  );
});

await check('a repo at its worker limit still gets an Epic Advocate', async () => {
  // The property the static read below used to own, asserted by driving it instead. An
  // Epic Advocate takes no worker slot and competes for none, so `reenter` runs above
  // `if (free <= 0) return` — and a repo at its limit is the state where supervision is
  // worth the most, because every window it has is already busy. Every other tick case in
  // this file runs an advocate with a slot to spare, so that state was reached only by a
  // string match on the arithmetic — a line that gets renamed, and did. See bc-t5k0.
  //
  // A child of the enrolled epic rather than a bead of its own: the queue row has to be
  // under a root or `withoutOrphans` takes it out before any of this is reached, and it
  // has to be a task or it is a *planner*, which `maxWorkers` does not ration.
  const queued = [
    { id: 'x-1.2', title: 'x-1.2', priority: 2, issue_type: 'task', status: 'open', created_at: LONG_AGO, labels: [] },
  ];
  const args = {
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    ready: queued,
  };
  // The control first, or the second half asserts nothing: with the one slot free, that
  // queue row is a bead the advocate opens a worker window on.
  const spare = await tick(args);
  assert.deepEqual(spare.workers, ['x-1.2'], 'the row does reach a launch when the repo has a slot');
  assert.deepEqual(spare.opened.map((o) => o.id), ['x-1'], 'and the advocate gets its window beside it');

  // And now with that slot taken. `maxWorkers` defaults to 1, so one worker is the limit;
  // `at` is now rather than LONG_AGO, or `reconcile` reaps it before the tick reaches the
  // sweep — see the advocate-tick-fixtures note.
  const full = await tick({
    ...args,
    workers: [{ id: 'y-9', title: 'y-9', at: new Date().toISOString(), batch: [], attempt: 1 }],
  });
  assert.deepEqual(full.workers, [], 'the queue is held — the repo is at its limit');
  assert.deepEqual(
    full.opened.map((o) => o.id),
    ['x-1'],
    'and the advocate was re-opened anyway — it is not queue work'
  );
});

/* ------------------------------------------------------------ what source says */

await check('the sweep is below the three lines that stop the tick', async () => {
  // The one thing here a behaviour test cannot see cheaply, and the mistake would look
  // entirely correct: moved above the `OBSERVING`/paused/quiet returns, an observer
  // instance opens windows and a paused advocate keeps supervising.
  const src = fs.readFileSync(LIB('advocate.js'), 'utf8');
  const from = src.indexOf('  async function tickOne(a, sessions) {');
  assert.ok(from > 0, 'tickOne has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n  }\n', from));
  const at = body.indexOf('await reenter(a)');
  assert.ok(at > 0, 'nothing re-opens the Epic Advocate — this is bc-goo.15 regressing');
  assert.ok(body.indexOf('if (OBSERVING) return note(a,') < at, 'an observer instance must open no windows');
  assert.ok(body.indexOf('if (a.paused) return note(a,') < at, 'paused means open no more sessions');
  assert.ok(body.indexOf('if (a.quiet) {') < at, 'quiet hours mean it too');
  // The fourth thing this used to assert — that `reenter` is above the queue, because an
  // Epic Advocate takes no worker slot — is the tick case above, and deliberately not here.
  // It was a string match on `const free = a.limit - a.workers.length`; `a.workers.length`
  // became `codersOf(a).length` on main, `indexOf` returned -1, `at < -1` was false, and
  // the suite went red saying "it has become queue work" while `reenter` sat exactly where
  // it belongs. bc-xl7n.39 shortened the match and added a `queueAt > 0` guard, which turns
  // the next rename into "re-point this check" rather than into a false regression report
  // — honest, but still a red for a correct edit, and still no evidence about the property.
  // Driving a repo at its limit costs one more tick, survives every rename, and is the only
  // form of this that fails when `reenter` is *gated* on a slot rather than moved. bc-t5k0.
  //
  // What is left here is the part a behaviour test genuinely cannot reach in-process:
  // `OBSERVING` is read from the environment once at module load.
});

await check('the default for the injectable is the real door', async () => {
  const src = fs.readFileSync(LIB('advocate.js'), 'utf8');
  assert.match(src, /openAdvocate = openEpicAdvocateSession/, 'the sweep is wired to a stub in production');
  assert.match(src, /rememberAdvocateOpened\(`\$\{a\.name\}\/\$\{epic\.id\}`\)/, 'the card will offer a second window');
});

/* ---------------------------------------------------------------------- done */

await quiesce();
await removeTree(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
console.log('all good');
