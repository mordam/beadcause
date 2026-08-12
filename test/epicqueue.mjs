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

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  return { opened, calls, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
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
