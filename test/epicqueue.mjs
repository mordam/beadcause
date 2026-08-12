/**
 * Hierarchy in the advocate's ready queue — an epic is not work, its children are.
 *
 * The incident this is written from: at 23:37:24 the beadcause advocate opened a
 * session on the epic bc-3zo9, and 1.3 seconds later opened a second on bc-3zo9.1,
 * that epic's first child. Both windows were briefed to write the same feature. The
 * epic session's only honest move was to write no code at all — a live sibling
 * already held the first child and .2 through .5 chained behind it — so one of the
 * two was wasted, it was the more expensive one, and nothing on the card said why.
 *
 * `bd ready` cannot help here: hierarchy is not a dependency in bd, so an epic with
 * five open children is genuinely ready by bd's own semantics. The filter is ours, in
 * `heldByChildren`, and it has two halves worth testing separately:
 *
 *   - the **narrow** one, which does not care about types — a parent and its child
 *     must never be launched in the same tick;
 *   - the **epic** one, which costs a `bd list --parent` and catches the child that
 *     is *not* in the queue: in progress, blocked, or under the priority floor.
 *
 * And two things it must not do: swallow a leaf epic (an epic with nothing under it
 * is an ordinary bead with an ambitious type), or empty the queue because bd would
 * not answer.
 *
 *     npm test
 *
 * The assertion is the list of windows, not a proxy for it: `open` is injected, so a
 * tick that would have opened an iTerm window pushes a bead id onto an array instead.
 * That is the whole reason it is injectable — a suite asserting "no session was opened
 * on the epic" is worthless if the way it fails is by opening one.
 *
 * No iTerm, no `bd`, no agent, and nothing written outside a temp config dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load,
// and the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates, isDescendantOf } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, over = {}) => ({ id, title: id, priority: 2, issue_type: 'task', created_at: OLD, ...over });
const epic = (id, over = {}) => bead(id, { issue_type: 'epic', ...over });

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * Every `children` call is counted: "one `bd` call per epic per tick, and none at all
 * for anything else" is a claim about cost, and a claim about cost is worth asserting
 * rather than writing in a comment.
 */
async function tick({ ready = [], children = {}, listLabel = [], show = null, workers = [], overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: state, the activity file the launch stamps, and the
  // worker markers. Otherwise case N's worker is still in case N+1's queue.
  //
  // Quiesce first, and not only at the end of the suite: this runs between *every* case,
  // so the previous case's write of advocates.json has a commit scheduled 2000ms out that
  // would otherwise `git init` into `dir` while this loop is walking it. That is as many
  // chances to lose the race as there are cases, and the case that loses one keeps going
  // and then fails for a second, unrelated-looking reason.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  if (workers.length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts: {} } }));
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
      // Enough that the cap is never what holds a launch back — a case asserting no
      // window opened must fail for its own reason, not for want of a slot.
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Other features with their own suites, each of which would otherwise run real
      // git or a real agent against a temp directory on every case here.
      propose: false,
      sessionLog: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      // Since bc-jk4m an epic that would be batched is *planned* instead: the same
      // candidate test, a different brief, and one window per group afterwards rather than
      // one window for the lot. Batching did not go away — it is what happens when there
      // is no plan and no planner — so this suite turns planning off and asserts the
      // fallback, exactly as it was written. test/epicplan.mjs owns the branch above it.
      planEpics: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const calls = { children: [], listLabel: 0 };
  const bd = {
    ready: async () => ready,
    listLabel: async () => {
      calls.listLabel += 1;
      return listLabel;
    },
    show: async (_ws, id) => (show ? show(id) : null),
    children: async (_ws, id) => {
      calls.children.push(id);
      if (children[id] instanceof Error) throw children[id];
      return children[id] || [];
    },
  };

  // The batch is recorded beside the id, because "which window opened" is only half of
  // what batching changes — the other half is what that window was told it was holding,
  // and a batch that dispatches the right epic with an empty brief is the round-robin
  // with extra steps.
  const briefed = [];
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      briefed.push({ id: b.id, batch: (b.batch || []).map((k) => k.id) });
      return { dir: REPO, mode: 'test', term: null };
    },
    // Injected for the reason `open` is, and it matters more: the default is the real
    // `openPlanSession`, which drives iTerm. With planning off nothing should reach it, and
    // "should" is not what a suite asserts on.
    openPlan: async () => {
      throw new Error('openPlan must not be reached with planEpics off');
    },
  });
  await advocates.tick();
  const card = advocates.snapshot().find((a) => a.workspace === 'alpha');
  return { opened, briefed, calls, card, advocates };
}

const heldIds = (card) => card.heldByChildren.map((h) => h.id);

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
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ------------------------------------------------------------------ the cases */

/**
 * The bug, in the smallest queue that can hold it: an epic and its own first child,
 * both ready, both past the settle window. Two windows before; one now, and it is the
 * one with the work in it.
 *
 * Untouched by batching (bc-bhp9), and that is deliberate. One ready child is not a
 * round-robin — the suppression already spends one window on it, briefed on exactly the
 * bead it is doing. Batching a lone child would claim the epic, hand over a brief about
 * choosing phases when there is only one, and leave an epic to be handed back, all to do
 * the same single bead. `minBatchBeads` is the floor that keeps this case as it was.
 */
await check('one window for a parent and its child, and it is the child', async () => {
  const { opened, card, calls } = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' })] },
  });

  assert.deepEqual(opened, ['x-1.1'], 'one session, on the child — this is the whole bug');
  assert.equal(card.queue, 1, 'and the epic is out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['x-1'], 'held rather than vanished');
  assert.match(card.heldByChildren[0].why, /x-1\.1 is ready under it/, `got: ${card.heldByChildren[0].why}`);
  assert.deepEqual(calls.children, [], 'the child was in the queue — that answer was free, and cost no bd call');
});

/**
 * And the case batching is actually for: two ready siblings, which before bc-bhp9 went to
 * two windows on two ticks, each briefed on its own bead and neither in a position to see
 * that the two belonged in one change. Now one window gets both, and the epic — whose
 * intent is the thing that makes the pair make sense — is what it is opened on.
 */
await check('two ready siblings go to one window, on the epic that explains them', async () => {
  const { opened, briefed, card, calls } = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1'), bead('x-1.2')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' }), bead('x-1.2', { status: 'open' })] },
    overrides: { maxWorkers: 4 },
  });

  assert.deepEqual(opened, ['x-1'], 'one session, on the epic — the only thing that can see the whole subtree');
  assert.deepEqual(briefed, [{ id: 'x-1', batch: ['x-1.1', 'x-1.2'] }], 'and it was told both children are its work');
  assert.equal(card.queue, 1, 'both children are out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card).sort(), ['x-1.1', 'x-1.2'], 'folded rather than vanished');
  assert.match(card.heldByChildren[0].why, /batched under x-1/, `got: ${card.heldByChildren[0].why}`);
  assert.deepEqual(calls.children, ['x-1'], 'one call, to prove no open child is hiding outside this queue');
});

// A batch must not span checkouts either, but `placeFor` is gated on `multiRepo` and this
// suite is deliberately single-repo — every bead here resolves to `repo: null`, so the
// guard cannot be reached from this fixture. That case lives in test/repoqueue.mjs, which
// already has the approved-repo block and the real resolver behind it.

/** The floor itself, asserted from the other side: turn it off and the lone child batches. */
await check('minBatchBeads 1 batches a lone child too', async () => {
  const { opened, briefed } = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' })] },
    overrides: { minBatchBeads: 1 },
  });

  assert.deepEqual(opened, ['x-1'], 'the epic, carrying its one child');
  assert.deepEqual(briefed, [{ id: 'x-1', batch: ['x-1.1'] }]);
});

/**
 * The cap, and the thing it must not do. Four ready children against a cap of two: two go
 * in the brief, and the other two do *not* get windows of their own — a batch beside its
 * own leftover siblings is the bc-3zo9 incident again with extra steps. They wait for a
 * later tick, and the card distinguishes the two reasons so a queue three shorter than
 * `bd ready` still explains itself.
 */
await check('the batch is capped, and the overflow waits rather than racing its siblings', async () => {
  const kids = ['x-1.1', 'x-1.2', 'x-1.3', 'x-1.4'];
  const { opened, briefed, card } = await tick({
    ready: [epic('x-1'), ...kids.map((k) => bead(k))],
    children: { 'x-1': kids.map((k) => bead(k, { status: 'open' })) },
    overrides: { maxBatchBeads: 2, maxWorkers: 5 },
  });

  assert.deepEqual(opened, ['x-1'], 'one window for the subtree, whatever the cap is');
  assert.deepEqual(briefed[0].batch, ['x-1.1', 'x-1.2'], 'two in the brief, in pick order');
  assert.deepEqual(heldIds(card).sort(), kids, 'all four children are off the queue, not just the briefed two');
  const why = Object.fromEntries(card.heldByChildren.map((h) => [h.id, h.why]));
  assert.match(why['x-1.1'], /batched under x-1/, `got: ${why['x-1.1']}`);
  assert.match(why['x-1.3'], /waiting for room in x-1's batch/, `got: ${why['x-1.3']}`);
});

/**
 * The suppression that must survive batching. A window already open on a child means this
 * subtree is somebody's — and the batch head is exactly as forbidden as a second child
 * would be. This is `heldByChildren`'s second check still doing its job, and it is the one
 * rule batching may never relax: two windows must never hold one subtree.
 */
await check('a live session on a child blocks the batch, and the tick behaves as it did before', async () => {
  const fixture = {
    ready: [epic('x-1'), bead('x-1.1'), bead('x-1.2')],
    workers: [{ id: 'x-1.1', title: 'the child', at: new Date().toISOString(), attempt: 1 }],
    show: () => ({ id: 'x-1.1', status: 'in_progress' }),
    children: { 'x-1': [bead('x-1.1', { status: 'in_progress' }), bead('x-1.2', { status: 'open' })] },
  };
  const now = await tick(fixture);

  assert.ok(!now.opened.includes('x-1'), 'the epic gets no batch over a subtree a window is already sitting in');
  assert.ok(
    now.briefed.every((b) => !b.batch.length),
    'and nothing that did open is carrying a batch'
  );
  assert.ok(heldIds(now.card).includes('x-1'), 'the epic is held the old way instead');
  assert.deepEqual(now.calls.children, [], 'the batch never got as far as costing a bd call');

  // The control, and the reason this case does not simply assert an empty list. `x-1.2` is
  // a *sibling* of the worked bead, not an ancestor or a descendant of it, so no rule here
  // has ever held it back — it took its own window before batching existed and it still
  // does. Asserting `[]` would have been asserting a stricter rule than either design has.
  const before = await tick({ ...fixture, overrides: { batchEpicChildren: false } });
  assert.deepEqual(now.opened, before.opened, 'a blocked batch falls back to exactly the old behaviour');
});

/**
 * The switch back. Batching is a judgement about how work is best handed over, and if a
 * batch ever briefs badly the fix has to be reachable without an editor — so `false`
 * restores `heldByChildren`'s suppression exactly, child window and all.
 */
await check('batchEpicChildren false is the old suppression, unchanged', async () => {
  const { opened, briefed, card } = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' })] },
    overrides: { batchEpicChildren: false },
  });

  assert.deepEqual(opened, ['x-1.1'], 'the child again, on its own');
  assert.deepEqual(briefed, [{ id: 'x-1.1', batch: [] }], 'and with no batch on it');
  assert.deepEqual(heldIds(card), ['x-1'], 'the epic held, exactly as before');
});

/**
 * Nesting. Pick order can reach an inner epic first, and if it claimed the batch the outer
 * one would be held by `heldByChildren` — a subtree split across two ticks for no reason
 * but sort order. Shallowest first makes the answer a property of the tree instead.
 */
await check('the outermost epic in a nest carries the subtree', async () => {
  const { opened, briefed, card } = await tick({
    ready: [bead('x-1.1.1'), epic('x-1.1', { priority: 1 }), epic('x-1')],
    children: {
      'x-1': [epic('x-1.1', { status: 'open' }), bead('x-1.1.1', { status: 'open' })],
      'x-1.1': [bead('x-1.1.1', { status: 'open' })],
    },
    overrides: { maxWorkers: 4 },
  });

  assert.deepEqual(opened, ['x-1'], 'one window, on the outermost epic');
  assert.deepEqual(briefed[0].batch.sort(), ['x-1.1', 'x-1.1.1'], 'carrying the whole subtree under it');
  assert.deepEqual(heldIds(card).sort(), ['x-1.1', 'x-1.1.1'], 'and the inner epic is folded in, not a head of its own');
});

/**
 * The mirror of the suppression, and the hole batching opens in it.
 *
 * Before bc-bhp9 a live worker held a *leaf*, so "is a session working something under
 * this bead" was the only direction worth asking. A batch head holds an epic and claims
 * it, which takes the epic out of `bd ready` — and its children are still ready. Nothing
 * asked whether a session was working something *above* a bead, so the batch's own
 * siblings came back round as individually launchable the very next tick: a batch window
 * writing the subtree, and up to N more windows opened underneath it. That is bc-3zo9
 * again, caused by the fix for it.
 *
 * `isDescendantOf(bead.id, w.id)` is the whole check — the same helper, arguments swapped.
 */
await check('a session holding an ancestor holds the beads underneath it', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1.1'), bead('x-1.2')],
    workers: [{ id: 'x-1', title: 'the epic', at: new Date().toISOString(), attempt: 1, batch: ['x-1.1', 'x-1.2'] }],
    show: () => ({ id: 'x-1', status: 'in_progress' }),
  });

  assert.deepEqual(opened, [], 'no window underneath a batch already working this subtree');
  assert.deepEqual(heldIds(card).sort(), ['x-1.1', 'x-1.2'], 'both held');
  assert.match(card.heldByChildren[0].why, /working x-1 above it/, `got: ${card.heldByChildren[0].why}`);

  // And the line this must not cross, which test/twinqueue.mjs owns from the other side:
  // the same shape with a worker that is *not* a batch head. A session on a plain parent
  // has been handed one bead, not the subtree — an epic is not the work, its children are
  // — so the child is still launched. `batch` is the entire difference between the two,
  // and asking the ancestor question unqualified broke this case.
  const plain = await tick({
    ready: [bead('x-1.1'), bead('x-1.2')],
    workers: [{ id: 'x-1', title: 'a plain parent', at: new Date().toISOString(), attempt: 1 }],
    show: () => ({ id: 'x-1', status: 'in_progress' }),
    overrides: { maxWorkers: 4 },
  });
  assert.deepEqual(plain.opened.sort(), ['x-1.1', 'x-1.2'], 'a plain parent holds nothing underneath it');
  assert.deepEqual(heldIds(plain.card), [], 'and nothing was held on the strength of a session above them');
});

/**
 * The same hole one level in, and the reason the ancestor check cannot live only in
 * `heldByChildren`. A batch head is pushed straight onto the workable list — that is what
 * makes it a batch head — so it never reaches the suppression at all. An inner epic under
 * a live batch would therefore become a batch head of its own: two windows, both briefed
 * on overlapping subtrees, which is the incident with the fix applied twice.
 *
 * So `batchesFor` has to ask the ancestor question itself, on the same terms.
 */
await check('no batch forms underneath a live batch head', async () => {
  // Two grandchildren, not one, so the inner epic clears `minBatchBeads` and this case
  // actually reaches the guard it is about. With one it would pass on the floor instead,
  // which is a test that goes green for a reason unrelated to the bug it documents.
  const inner = { ready: [epic('x-1.1'), bead('x-1.1.1'), bead('x-1.1.2')], children: { 'x-1.1': [bead('x-1.1.1', { status: 'open' }), bead('x-1.1.2', { status: 'open' })] }, overrides: { maxWorkers: 4 } };

  const armed = await tick(inner);
  assert.deepEqual(armed.opened, ['x-1.1'], 'the control: with no worker above it, this epic does batch');

  const { opened, card } = await tick({
    ...inner,
    workers: [{ id: 'x-1', title: 'the outer batch', at: new Date().toISOString(), attempt: 1, batch: ['x-1.1'] }],
    show: () => ({ id: 'x-1', status: 'in_progress' }),
  });

  assert.deepEqual(opened, [], 'the whole subtree belongs to the window already in it');
  assert.deepEqual(heldIds(card).sort(), ['x-1.1', 'x-1.1.1', 'x-1.1.2'], 'all held, none promoted to a batch head');
});

/**
 * The worker record. `id` staying the epic is what lets every single-id thing downstream
 * — the done marker, the check-in, the attempt count, `reclaim`, and the `isDescendantOf`
 * suppression itself — keep working without knowing batches exist. If `id` ever became
 * the batch, all five would need to learn about it at once.
 */
await check('the worker record keys on the epic and carries the batch beside it', async () => {
  const { advocates } = await tick({
    ready: [epic('x-1'), bead('x-1.1'), bead('x-1.2')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' }), bead('x-1.2', { status: 'open' })] },
  });

  const card = advocates.snapshot().find((a) => a.workspace === 'alpha');
  assert.equal(card.workers.length, 1, 'one worker for the batch, so one slot');
  assert.equal(card.workers[0].id, 'x-1', 'keyed on the epic');
  assert.deepEqual(card.workers[0].batch, ['x-1.1', 'x-1.2'], 'with the batch alongside it');
});

/**
 * The same guard one tick later. Without it the epic is simply picked up on the tick
 * after its child was — the incident with a pause in the middle.
 */
await check('a session already working a child holds the parent', async () => {
  const { opened, card } = await tick({
    ready: [epic('x-1')],
    workers: [{ id: 'x-1.1', title: 'the child', at: new Date().toISOString(), attempt: 1 }],
    show: () => ({ id: 'x-1.1', status: 'in_progress' }),
  });

  assert.deepEqual(opened, [], 'no second window over a bead already being worked');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.match(card.heldByChildren[0].why, /working x-1\.1/, `got: ${card.heldByChildren[0].why}`);
});

/** The narrow case on its own: a parent that is not typed as an epic still waits. */
await check('an untyped parent waits for its child too', async () => {
  const { opened, card, calls } = await tick({ ready: [bead('x-1'), bead('x-1.2')] });

  assert.deepEqual(opened, ['x-1.2'], 'hierarchy is hierarchy whatever the parent is typed as');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.deepEqual(calls.children, [], 'and a plain task parent costs no bd call at all');
});

/**
 * The half `bd ready` cannot see: the child is open but not *ready* — in progress,
 * here — so nothing in the queue names it and only asking bd finds it.
 */
await check('an epic whose only open child is not in the queue', async () => {
  const { opened, card, calls } = await tick({
    ready: [epic('x-1'), bead('x-2')],
    children: { 'x-1': [bead('x-1.1', { status: 'in_progress' }), bead('x-1.2', { status: 'closed' })] },
  });

  assert.deepEqual(opened, ['x-2'], 'an epic is its children until they are done');
  assert.match(card.heldByChildren[0].why, /1 open child issue/, `got: ${card.heldByChildren[0].why}`);
  assert.deepEqual(calls.children, ['x-1'], 'one call for the one epic — x-2 is not an epic and was not asked about');
});

/**
 * What the cheap fix would have broken. Dropping `issue_type === 'epic'` outright was
 * one line; it also means an epic with nothing under it needs a human to retype it
 * before anything will ever pick it up.
 */
await check('a leaf epic, and one whose children are all closed, are still work', async () => {
  const { opened, card } = await tick({
    ready: [epic('x-1'), epic('x-2')],
    children: { 'x-2': [bead('x-2.1', { status: 'closed' })] },
  });

  assert.deepEqual(opened.sort(), ['x-1', 'x-2'], 'both are workable, and both got a window');
  assert.deepEqual(heldIds(card), []);
});

/** A tracker mid-write must not be able to empty the queue. */
await check('silence from bd keeps the bead', async () => {
  const { opened, card } = await tick({
    ready: [epic('x-1')],
    children: { 'x-1': new Error('dolt: database is locked') },
  });

  assert.deepEqual(opened, ['x-1'], 'cannot-tell keeps it — the old behaviour, on purpose');
  assert.deepEqual(heldIds(card), []);
});

/**
 * The dot is load-bearing. On a bare prefix `x-3z` would be read as the parent of
 * `x-3zo9` and the advocate would hold back work on the strength of two ids that
 * merely start alike — the trap lib/reap.js documents on `namesBead`.
 */
await check('ids that merely start alike are not parent and child', async () => {
  assert.equal(isDescendantOf('bc-3zo9.1', 'bc-3zo9'), true);
  assert.equal(isDescendantOf('bc-3zo9.1.4', 'bc-3zo9'), true, 'a grandchild is still underneath it');
  assert.equal(isDescendantOf('bc-3zo9', 'bc-3z'), false, 'this is the one that would silently starve a queue');
  assert.equal(isDescendantOf('bc-3zo9', 'bc-3zo9'), false, 'a bead is not its own child');
  assert.equal(isDescendantOf('bc-3zo9', null), false);

  const { opened } = await tick({ ready: [bead('x-3z'), bead('x-3zo9')] });
  assert.deepEqual(opened.sort(), ['x-3z', 'x-3zo9'], 'two windows, because these are two unrelated beads');
});

/**
 * The card. Two failures live here and both read as "the advocate is idle": a queue
 * one shorter than `bd ready` with nothing on screen accounting for the difference,
 * and — worse — an advocate that decides there is nothing to do and goes off to
 * *propose new work* while the epic it just skipped sits there with its children open.
 *
 * `listLabel` is propose's first call, so counting it is how you tell which happened.
 */
await check('an emptied queue says why, and proposes nothing over it', async () => {
  const held = await tick({
    ready: [epic('x-1')],
    children: { 'x-1': [bead('x-1.1', { status: 'in_progress' })] },
    // Armed. A pass can only come from the guard, not from the feature being off.
    overrides: { propose: true },
    listLabel: [{ id: 'x-9', status: 'open' }],
  });

  assert.deepEqual(held.opened, []);
  assert.equal(held.card.queue, 0);
  assert.match(held.card.note, /waiting on its children/, `the card must say why, got: ${held.card.note}`);
  assert.doesNotMatch(held.card.note, /^clear/, 'a queue emptied by this filter is not a clear one');
  assert.equal(held.calls.listLabel, 0, 'nothing may be proposed over work only waiting on its own children');

  // The control, which is what makes the count above mean anything: same config,
  // nothing held, and propose does run. It stops at the open ask `listLabel` returns
  // — one call, and no agent spawned.
  const idle = await tick({ ready: [], overrides: { propose: true }, listLabel: [{ id: 'x-9', status: 'open' }] });
  assert.equal(idle.calls.listLabel, 1, 'with nothing held it proposes as it always did');
});

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
