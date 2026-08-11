/**
 * Hierarchy in the advocate's ready queue — an epic is not work, its children are.
 *
 * The incident this is written from: at 23:37:24 the beadcause advocate opened a
 * session on the epic bc-3zo9, and 1.3 seconds later opened a second on bc-3zo9.1,
 * that epic's first child. Both windows were briefed to write the same feature. The
 * epic session's only honest move was to write no code at all, so one of the two —
 * the more expensive one — was wasted, and nothing on the card said why.
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
 * ## Why child processes
 *
 * `OBSERVING` resolves once, at module load, so one process can only test one value
 * of it — the same reason test/observe.mjs is shaped this way. Most cases here run
 * with it **on**, because the queue is what the tick draws launches from and reading
 * it is the whole assertion; the one case about what the *card* says has to run with
 * it off, because the observer note is written before the note under test.
 *
 * Nothing here opens a window. Under the flag the tick stops before it could, and the
 * one case that runs without it is given a queue that is empty by the end of the
 * survey — the launch loop is only reached with something in it. The mirror image,
 * "flag off, does a window really open", is the test test/observe.mjs declines to
 * write for the reason it gives there, and this file declines it for the same one.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

/* --------------------------------------------------------------- the harness */

const CASES = new Map();
const test = (name, fn) => CASES.set(name, fn);

/** Run one named case in a child, with a clean env plus whatever it needs. */
function child(name, env = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicqueue-'));
  return execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], {
    encoding: 'utf8',
    // Built from scratch, and with a config dir of its own: a case must not be able
    // to read — or write — the advocates.json of the daemon running on this Mac.
    env: { PATH: process.env.PATH, HOME: process.env.HOME, BEADCAUSE_CONFIG_DIR: tmp, ...env },
  });
}

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, over = {}) => ({ id, title: id, priority: 2, issue_type: 'task', created_at: OLD, ...over });
const epic = (id, over = {}) => bead(id, { issue_type: 'epic', ...over });

/**
 * An advocate over a config that touches nothing, with a tracker that says what the
 * case needs it to.
 *
 * `children` is a map of parent id to the rows `bd list --parent` would return, and
 * every call to it is counted: "one `bd` call per epic per tick, and none at all for
 * anything else" is a claim about cost, and a claim about cost is a thing to assert
 * rather than a thing to write in a comment.
 */
async function harness({ ready = [], children = {}, listLabel = [], show = null, workers = [], overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  const sessions = path.join(dir, 'claude-sessions');
  fs.mkdirSync(sessions, { recursive: true });
  if (workers.length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts: {} } }));
  }

  const cfg = {
    projectRoot: path.join(dir, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: sessions,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 2,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Everything that would reach a repo, an agent or a worktree.
      propose: false,
      sessionLog: false,
      tidyWorktrees: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

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

  const { createAdvocates } = await import(LIB('advocate.js'));
  const advocates = createAdvocates(cfg, { bd, bus: { emit() {} } });
  await advocates.tick();
  return { calls, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const queued = (card) => card.next.map((n) => n.id);
const heldIds = (card) => card.heldByChildren.map((h) => h.id);

/* ------------------------------------------------------------------ the cases */

/**
 * The bug, in the smallest queue that can hold it: an epic and its own first child,
 * both ready, both past the settle window.
 *
 * The queue is the assertion because the queue is what launches are drawn from —
 * `candidates` filters it further (busy, attempts, settle) and never adds to it — so
 * a queue of one is one window, and the id in it says which of the two it was.
 */
test('tick:one-window-for-a-parent-and-its-child', async () => {
  const { card, calls } = await harness({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' })] },
  });

  assert.equal(card.queue, 1, 'one window, not two — this is the whole bug');
  assert.deepEqual(queued(card), ['x-1.1'], 'and it is the child, which is where the work actually is');
  assert.deepEqual(heldIds(card), ['x-1'], 'the epic is held rather than vanished');
  assert.match(card.heldByChildren[0].why, /x-1\.1 is ready under it/, `got: ${card.heldByChildren[0].why}`);
  assert.deepEqual(calls.children, [], 'the child was in the queue — that answer was free, and no bd call was made');
});

/**
 * The same guard, one tick later. Without this the epic is simply picked up on the
 * tick after its child was — the incident with a pause in the middle.
 */
test('tick:a-session-on-a-child-holds-the-parent', async () => {
  const { card } = await harness({
    ready: [epic('x-1')],
    workers: [{ id: 'x-1.1', title: 'the child', at: new Date().toISOString(), attempt: 1 }],
    show: () => ({ id: 'x-1.1', status: 'in_progress' }),
  });

  assert.equal(card.queue, 0, 'no second window on the parent of a bead already being worked');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.match(card.heldByChildren[0].why, /working x-1\.1/, `got: ${card.heldByChildren[0].why}`);
});

/** The narrow case on its own: a parent that is not typed as an epic still waits. */
test('tick:an-untyped-parent-waits-too', async () => {
  const { card, calls } = await harness({ ready: [bead('x-1'), bead('x-1.2')] });

  assert.deepEqual(queued(card), ['x-1.2'], 'hierarchy is hierarchy whatever the parent is typed as');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.deepEqual(calls.children, [], 'and a plain task parent costs no bd call at all');
});

/**
 * The half `bd ready` cannot see: the child is open but not *ready* — in progress,
 * here — so nothing in the queue names it and only asking bd finds it.
 */
test('tick:an-epic-whose-child-is-not-in-the-queue', async () => {
  const { card, calls } = await harness({
    ready: [epic('x-1'), bead('x-2')],
    children: { 'x-1': [bead('x-1.1', { status: 'in_progress' }), bead('x-1.2', { status: 'closed' })] },
  });

  assert.deepEqual(queued(card), ['x-2'], 'the epic is its children until they are done');
  assert.match(card.heldByChildren[0].why, /1 open child issue/, `got: ${card.heldByChildren[0].why}`);
  assert.deepEqual(calls.children, ['x-1'], 'one call, for the one epic — x-2 is not an epic and was not asked about');
});

/**
 * What the cheap fix would have broken. Dropping `issue_type === 'epic'` outright was
 * one line; it also means an epic with nothing under it needs a human to retype it
 * before anything will ever pick it up.
 */
test('tick:a-leaf-epic-is-still-work', async () => {
  const { card } = await harness({
    ready: [epic('x-1'), epic('x-2')],
    children: { 'x-2': [bead('x-2.1', { status: 'closed' })] },
  });

  assert.deepEqual(queued(card).sort(), ['x-1', 'x-2'], 'no children, and all-children-closed, are both workable');
  assert.deepEqual(heldIds(card), []);
});

/** A tracker mid-write must not be able to empty the queue. */
test('tick:silence-from-bd-keeps-the-bead', async () => {
  const { card } = await harness({
    ready: [epic('x-1')],
    children: { 'x-1': new Error('dolt: database is locked') },
  });

  assert.deepEqual(queued(card), ['x-1'], 'cannot-tell keeps it — the old behaviour, on purpose');
  assert.deepEqual(heldIds(card), []);
});

/**
 * The dot is load-bearing. On a bare prefix `x-3z` would be read as the parent of
 * `x-3zo9`, and the advocate would hold back work on the strength of two ids that
 * merely start alike — the same trap lib/reap.js documents on `namesBead`.
 */
test('tick:ids-that-merely-start-alike-are-not-related', async () => {
  const { isDescendantOf } = await import(LIB('advocate.js'));
  assert.equal(isDescendantOf('bc-3zo9.1', 'bc-3zo9'), true);
  assert.equal(isDescendantOf('bc-3zo9.1.4', 'bc-3zo9'), true, 'a grandchild is still underneath it');
  assert.equal(isDescendantOf('bc-3zo9', 'bc-3z'), false, 'this is the one that would silently starve a queue');
  assert.equal(isDescendantOf('bc-3zo9', 'bc-3zo9'), false, 'a bead is not its own child');
  assert.equal(isDescendantOf('bc-3zo9', null), false);

  const { card } = await harness({ ready: [bead('x-3z'), bead('x-3zo9')] });
  assert.deepEqual(queued(card).sort(), ['x-3z', 'x-3zo9'], 'two windows, because these are two unrelated beads');
});

/**
 * The card, with the flag off — the half the observer note would otherwise cover.
 *
 * Two failures live here, and both read as "the advocate is idle": a queue one shorter
 * than `bd ready` with nothing on screen accounting for the difference, and — worse —
 * an advocate that decides there is nothing to do and goes off to *propose new work*
 * while the epic it just skipped sits there with its children open.
 *
 * `listLabel` is propose's first call, so counting it is how you tell which happened.
 * Safe to run unobserved: the survey empties the queue, and the launch loop is only
 * reached with something in it.
 */
test('card:an-empty-queue-says-why-and-proposes-nothing', async () => {
  const held = await harness({
    ready: [epic('x-1')],
    children: { 'x-1': [bead('x-1.1', { status: 'in_progress' })] },
    // Armed. A pass can only come from the guard, not from the feature being off.
    overrides: { propose: true },
    listLabel: [{ id: 'x-9', status: 'open' }],
  });

  assert.equal(held.card.queue, 0);
  assert.match(held.card.note, /waiting on its children/, `the card must say why, got: ${held.card.note}`);
  assert.doesNotMatch(held.card.note, /^clear/, 'a queue emptied by this filter is not a clear one');
  assert.equal(held.calls.listLabel, 0, 'nothing may be proposed over work that is only waiting on its own children');

  // The control, which is what makes the count above mean anything: the same config,
  // nothing held, and propose does run. It stops at the open ask `listLabel` returns
  // — one call, and no agent spawned.
  const idle = await harness({
    ready: [],
    overrides: { propose: true },
    listLabel: [{ id: 'x-9', status: 'open' }],
  });
  assert.equal(idle.calls.listLabel, 1, 'with nothing held it proposes as it always did');
  assert.match(idle.card.note, /clear|waiting on/, `got: ${idle.card.note}`);
});

/* --------------------------------------------------------------- the run loop */

const OBSERVED = new Set(['card:an-empty-queue-says-why-and-proposes-nothing']);

const only = process.argv[2];
if (only) {
  const fn = CASES.get(only);
  if (!fn) {
    console.error(`no such case: ${only}`);
    process.exit(2);
  }
  await fn();
  process.exit(0);
}

let failures = 0;
for (const name of CASES.keys()) {
  try {
    child(name, OBSERVED.has(name) ? {} : { BEADCAUSE_OBSERVE: '1' });
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim();
    if (out) console.error(out.split('\n').map((l) => `       ${l}`).join('\n'));
  }
}

console.log(`\n${CASES.size - failures}/${CASES.size} passed`);
process.exit(failures ? 1 : 0);
