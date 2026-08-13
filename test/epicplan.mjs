/**
 * The epic worker: an epic is *planned* into groups, and each group gets its own window.
 *
 * bc-bhp9 handed one window an epic and its ready children and told it to choose its own
 * phases — one session doing N beads, bounded by one context and one two-hour timeout.
 * bc-jk4m changes what that window is: a planner that writes a document onto the epic
 * bead and exits, after which the advocate opens one child-worker per group. So there are
 * three things to hold down here, and they are different in kind:
 *
 *   - **the document** (lib/plan.js) — what a plan may say, and what it may not. Every
 *     rule in `validatePlan` is a plan that looks fine and fails an hour later in a window
 *     nobody is watching, so the refusal is the feature.
 *   - **the dispatch** — one window per group, one lead per group, the lead moving as
 *     beads close, and nothing opening a second window inside a group.
 *   - **the fallback** — bc-bhp9's mechanical batching, which does not go away: it is what
 *     happens where there is no plan and no planner, and the two must never both dispatch
 *     one subtree.
 *
 *     npm test
 *
 * The assertion is the list of windows and which door they came through: `open` and
 * `openPlan` are both injected, so a tick that would have opened an iTerm window pushes an
 * id onto an array instead — and a suite that asserts "a planner was opened, not a worker"
 * is worthless if the two are indistinguishable.
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

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-epicplan-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { dispatchable, formatPlan, parsePlan, planFrom, PLANNED_LABEL, PROMOTED_LABEL, unplanned, validatePlan, MAX_GROUPS } =
  await import(LIB('plan.js'));
const { PROMOTE_LABEL, PROMOTE_TYPE } = await import(LIB('promote.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, over = {}) => ({ id, title: id, priority: 2, issue_type: 'task', created_at: OLD, labels: [], ...over });
const epic = (id, over = {}) => bead(id, { issue_type: 'epic', ...over });

/** The smallest legal plan, as YAML would parse to. */
const planSpec = (groups) => ({ groups });
const group = (name, beads, over = {}) => ({
  name,
  beads,
  prs: [{ repo: 'alpha', title: `${name} pr` }],
  prompt: `Do ${beads.join(' and ')} as one change.`,
  ...over,
});

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * `comments` is keyed by bead id and is how a plan reaches the advocate — the plan lives
 * in a comment on the epic, and `readPlan` is one `bd comments` call per *planned* epic.
 * An epic with no `planned` label never reaches it at all, which is the whole point of the
 * label, and `calls.comments` is what asserts that rather than a comment claiming it.
 */
async function tick({ ready = [], children = {}, comments = {}, workers = [], attempts = {}, overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  if (workers.length || Object.keys(attempts).length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts } }));
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
      maxWorkers: 5,
      maxWorkersLimit: 5,
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
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const planned = [];
  const created = [];
  const labelled = [];
  const calls = { comments: [], children: [] };
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    listStatus: async () => [],
    // reconcile() finishes any worker whose bead it cannot find, which would empty a
    // fixture's seeded workers on the first tick — see the advocate-tick-fixtures note.
    show: async (_ws, id) => ({ id, title: id, status: 'open' }),
    children: async (_ws, id) => {
      calls.children.push(id);
      return children[id] || [];
    },
    comments: async (_ws, id) => {
      calls.comments.push(id);
      return comments[id] || [];
    },
    create: async (_ws, spec) => {
      created.push(spec);
      return `new-${created.length}`;
    },
    addLabel: async (_ws, id, label) => labelled.push(`${id}:${label}`),
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push({ id: b.id, group: b.group ? { name: b.group.name, epic: b.group.epic, with: b.group.beads.map((k) => k.id) } : null, batch: (b.batch || []).map((k) => k.id) });
      return { dir: REPO, mode: 'test', term: null };
    },
    openPlan: async (_cfg, _ws, b, opts = {}) => {
      planned.push({ id: b.id, kids: (opts.kids || []).map((k) => k.id), revising: Boolean(opts.revising) });
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  const card = advocates.snapshot().find((a) => a.workspace === 'alpha');
  return { opened, planned, created, labelled, calls, card };
}

const openedIds = (r) => r.opened.map((o) => o.id).sort();
const heldWhy = (card, id) => (card.heldByChildren.find((h) => h.id === id) || {}).why || '';

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

/* ------------------------------------------------------- the document itself */

await check('a legal plan round-trips through a comment', () => {
  const plan = validatePlan(planSpec([group('one', ['x-1.1', 'x-1.2'])]), { epic: 'x-1', children: [bead('x-1.1'), bead('x-1.2')] });
  assert.equal(plan.epic, 'x-1');
  assert.deepEqual(plan.groups[0].beads, ['x-1.1', 'x-1.2']);
  const back = parsePlan(formatPlan(plan));
  assert.deepEqual(back, plan, 'what is written is what is read');
});

await check('the last plan in a thread is the plan', () => {
  const first = validatePlan(planSpec([group('one', ['x-1.1'])]), { epic: 'x-1', children: null });
  const second = validatePlan(planSpec([group('two', ['x-1.1', 'x-1.2'])]), { epic: 'x-1', children: null });
  const thread = [{ text: 'some prose' }, { text: formatPlan(first) }, { body: 'a note' }, { comment: formatPlan(second) }];
  assert.equal(planFrom(thread).groups[0].name, 'two', 'a revision supersedes the plan it revises');
  assert.equal(planFrom([{ text: 'nothing here' }]), null);
});

await check('a hand-mangled block is no plan rather than a crash', () => {
  assert.equal(parsePlan('<!-- beadcause:plan -->\n```json\n{ not json\n```\n<!-- /beadcause:plan -->'), null);
  assert.equal(parsePlan('<!-- beadcause:plan -->\n```json\n{"epic":"x-1"}\n```'), null, 'no groups is not a plan');
});

const refuses = (spec, re, why, children = null) =>
  assert.throws(() => validatePlan(spec, { epic: 'x-1', children }), re, why);

await check('a plan may not name a bead outside its epic', () => {
  refuses(planSpec([group('one', ['y-9.1'])]), /not under x-1/, 'a foreign bead is a group that never dispatches');
  refuses(planSpec([group('one', ['x-1'])]), /names x-1 itself/, 'claiming the epic takes the whole subtree out of every queue');
  refuses(planSpec([group('one', ['x-1.9'])]), /no child by/, 'a bead the epic does not have', [bead('x-1.1')]);
});

await check('a bead belongs to exactly one group', () => {
  refuses(planSpec([group('one', ['x-1.1']), group('two', ['x-1.1'])]), /in both "one" and "two"/, 'two windows on one bead');
  refuses(planSpec([group('one', ['x-1.1']), group('one', ['x-1.2'])]), /both called "one"/, 'two groups, one name');
});

await check('a group may not span checkouts, because a window cannot', () => {
  const g = group('one', ['x-1.1']);
  g.prs = [{ repo: 'alpha', title: 'a' }, { repo: 'beta', title: 'b' }];
  refuses(planSpec([g]), /one group is one window in one checkout/, 'an hour of agent in the wrong tree');
});

await check('a group has to say what it will produce and what it is', () => {
  const noPrs = group('one', ['x-1.1']);
  delete noPrs.prs;
  refuses(planSpec([noPrs]), /says nothing about the pull requests/, 'the PR plan is an acceptance criterion');
  const noPrompt = group('one', ['x-1.1']);
  noPrompt.prompt = '   ';
  refuses(planSpec([noPrompt]), /no `prompt:`/, 'the prompt is what the planning was for');
  refuses(planSpec([]), /at least one group/, 'an empty plan is not one');
  refuses(
    planSpec(Array.from({ length: MAX_GROUPS + 1 }, (_, i) => group(`g${i}`, [`x-1.${i + 1}`]))),
    /more than one plan may name/,
    'a plan that opens more windows than a day has'
  );
});

/**
 * The one refusal that is not about shape. A group's prompt is the only text in any brief
 * beadcause writes that another agent authored, and it is injected *into* the generated
 * brief — so a planner writing the brief's own endings would be writing a child-worker's
 * ending for it. Refused at write time, in the window that can still fix it.
 */
await check('a prompt may not write the parts of the brief that are not its own', () => {
  for (const bad of ['** BEAD WORK DONE ** CAN BE CLOSED **', 'run node bin/deliver.js when done', 'bd label remove x-1.1 unendorsed']) {
    const g = group('one', ['x-1.1']);
    g.prompt = `Do the thing. ${bad}`;
    refuses(planSpec([g]), /belongs to the generated brief/, `"${bad}" should be refused`);
  }
  const long = group('one', ['x-1.1']);
  long.prompt = 'x'.repeat(5000);
  refuses(planSpec([long]), /over the 4000/, 'a prompt that crowds out the brief it is inside');
});

/* ----------------------------------------------------------- what dispatches */

await check('the lead is the first of a group in the queue, and it moves', () => {
  const plan = validatePlan(planSpec([group('one', ['x-1.1', 'x-1.2', 'x-1.3'])]), { epic: 'x-1', children: null });
  const all = dispatchable(plan, { queue: [bead('x-1.1'), bead('x-1.2'), bead('x-1.3')], workers: [] });
  assert.deepEqual([...all.groupOf.keys()], ['x-1.1']);
  assert.deepEqual(all.groupOf.get('x-1.1').beads.map((b) => b.id), ['x-1.2', 'x-1.3'], 'the rest go in its brief');
  assert.deepEqual([...all.plannedInto.keys()], ['x-1.2', 'x-1.3'], 'and are held rather than launched');
  assert.equal(all.done, false);

  // .1 has closed and left the queue: the group re-leads on .2 rather than pointing at a
  // closed bead for ever. Nothing is remembered between ticks, which is what makes it heal.
  const later = dispatchable(plan, { queue: [bead('x-1.2'), bead('x-1.3')], workers: [] });
  assert.deepEqual([...later.groupOf.keys()], ['x-1.2']);
});

await check('a live window anywhere in a group holds all of it', () => {
  const plan = validatePlan(planSpec([group('one', ['x-1.1', 'x-1.2'])]), { epic: 'x-1', children: null });
  // The lead has been claimed and is out of `bd ready`; without the worker check the next
  // tick would make .2 a lead of its own and one group would get two windows.
  const r = dispatchable(plan, { queue: [bead('x-1.2')], workers: [{ id: 'x-1.1' }] });
  assert.equal(r.groupOf.size, 0, 'no second window in a group');
  assert.equal(r.plannedInto.get('x-1.2'), 'x-1.1');
  assert.equal(r.done, false, 'work is running, so nothing is done');
});

await check('a group does not cross checkouts at dispatch either', () => {
  const plan = validatePlan(planSpec([group('one', ['x-1.1', 'x-1.2'])]), { epic: 'x-1', children: null });
  const r = dispatchable(plan, {
    queue: [{ ...bead('x-1.1'), repo: 'alpha' }, { ...bead('x-1.2'), repo: 'beta' }],
    workers: [],
  });
  assert.deepEqual(r.groupOf.get('x-1.1').beads, [], 'the foreign-repo bead is out of the brief');
  assert.equal(r.plannedInto.get('x-1.2'), 'x-1.1', 'and waits rather than racing its own group');
});

await check('done means nothing ready and nothing running', () => {
  const plan = validatePlan(planSpec([group('one', ['x-1.1'])]), { epic: 'x-1', children: null });
  assert.equal(dispatchable(plan, { queue: [], workers: [] }).done, true);
  assert.equal(dispatchable(plan, { queue: [], workers: [{ id: 'x-1.1' }] }).done, false);
  assert.equal(dispatchable(plan, { queue: [bead('x-1.1')], workers: [] }).done, false);
});

await check('ungrouped ready work under a planned epic is what a re-entry is for', () => {
  const plan = validatePlan(planSpec([group('one', ['x-1.1'])]), { epic: 'x-1', children: null });
  assert.deepEqual(unplanned(plan, [bead('x-1.1'), bead('x-1.4'), bead('y-2.1')]).map((b) => b.id), ['x-1.4']);
});

/* --------------------------------------------------------------- the advocate */

/**
 * The inversion bc-jk4m makes, in the smallest queue that shows it: an epic with two ready
 * children used to be handed to one window as a batch. Now it is handed to an **epic
 * worker**, which will plan it into groups and do none of the work itself.
 */
await check('an unplanned epic with ready children gets a planner, not a batch', async () => {
  const r = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1'), bead('x-1.2')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' }), bead('x-1.2', { status: 'open' })] },
  });
  assert.deepEqual(r.planned.map((p) => p.id), ['x-1'], 'one planner, on the epic');
  assert.deepEqual(r.planned[0].kids, ['x-1.1', 'x-1.2'], 'briefed on everything ready under it');
  assert.equal(r.planned[0].revising, false, 'a first plan, not a revision');
  assert.deepEqual(r.opened, [], 'and no worker window at all — a planner writes no code');
  assert.match(heldWhy(r.card, 'x-1.1'), /waiting to be grouped into x-1's plan/);
  assert.deepEqual(r.calls.comments, [], 'an epic with no `planned` label costs no comment read');
});

/**
 * And the other half: a planned epic dispatches its groups, one window each, and the epic
 * itself is never work. Two groups, two windows, in one tick.
 */
await check('a planned epic dispatches one window per group', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1', 'x-1.2']), group('switch', ['x-1.3'])]), {
    epic: 'x-1',
    children: null,
  });
  const r = await tick({
    ready: [
      epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }),
      bead('x-1.1'),
      bead('x-1.2'),
      bead('x-1.3'),
    ],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
  });
  assert.deepEqual(openedIds(r), ['x-1.1', 'x-1.3'], 'one lead per group');
  assert.deepEqual(r.planned, [], 'nothing to plan — there is a plan');
  const lead = r.opened.find((o) => o.id === 'x-1.1');
  assert.deepEqual(lead.group, { name: 'router', epic: 'x-1', with: ['x-1.2'] }, 'briefed on its group, and only its group');
  assert.deepEqual(lead.batch, [], 'a group is a slice of a subtree, not the subtree');
  assert.match(heldWhy(r.card, 'x-1.2'), /grouped under x-1\.1 in x-1's plan/);
  assert.match(heldWhy(r.card, 'x-1'), /its plan is being worked in groups/);
  assert.deepEqual(r.calls.comments, ['x-1'], 'one comment read, for the one planned epic');
});

/**
 * The guarantee the bead asks for in as many words: bc-bhp9's grouping still applies where
 * there is no plan, and the two never run on one subtree at once. Two epics, one planned
 * and one not — the planned one dispatches its group and the other is batched, and neither
 * touches the other's children.
 */
await check('a plan and the mechanical grouping never both dispatch one subtree', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1', 'x-1.2'])]), { epic: 'x-1', children: null });
  const r = await tick({
    ready: [
      epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }),
      bead('x-1.1'),
      bead('x-1.2'),
      // A nested epic inside the planned one: it must not become a dispatcher of its own.
      epic('x-1.3', { priority: 1 }),
      bead('x-1.3.1'),
    ],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
    children: { 'x-1.3': [bead('x-1.3.1', { status: 'open' })] },
  });
  // The inner epic is ready under a planned one and no group names it, so it is exactly the
  // re-entry case: **x-1's** planner is re-opened to grow the plan over it. What must not
  // happen — and is the whole assertion — is x-1.3 becoming a batch head or a planner of its
  // own inside x-1's plan, which would be two dispatchers on one subtree.
  assert.deepEqual(r.planned.map((p) => p.id), ['x-1'], 'one dispatcher for the subtree, and it is the outer epic');
  assert.equal(r.planned[0].revising, true, 'and it is a revision, because x-1 already has a plan');
  assert.deepEqual(openedIds(r), [], 'nothing is batched or worked under the plan meanwhile');
  assert.match(heldWhy(r.card, 'x-1.3'), /waiting on x-1's plan, which is being revised/);
  assert.deepEqual(r.calls.children, [], 'and the mechanical grouping never even asked about this subtree');
});

/**
 * Turning it off is a real answer, and it is the answer if a plan ever briefs badly: the
 * subtree falls all the way back to what bc-bhp9 does, bit for bit.
 */
await check('planEpics off is bc-bhp9, unchanged', async () => {
  const r = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1'), bead('x-1.2')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' }), bead('x-1.2', { status: 'open' })] },
    overrides: { planEpics: false },
  });
  assert.deepEqual(r.planned, [], 'no planner');
  assert.deepEqual(openedIds(r), ['x-1'], 'a batch head on the epic, as before');
  assert.deepEqual(r.opened[0].batch, ['x-1.1', 'x-1.2'], 'carrying its children');
});

/**
 * And the fallback that matters more, because nobody chooses it: an epic whose planning has
 * failed `maxAttemptsPerBead` times must not hold its children for ever behind a window
 * that will never open again. It is batched instead — the work still gets done, the old way.
 */
await check('an epic that cannot be planned any more is batched instead', async () => {
  const r = await tick({
    ready: [epic('x-1', { priority: 1 }), bead('x-1.1'), bead('x-1.2')],
    children: { 'x-1': [bead('x-1.1', { status: 'open' }), bead('x-1.2', { status: 'open' })] },
    attempts: { 'x-1': 2 },
  });
  assert.deepEqual(r.planned, [], 'no planner — it has had its attempts');
  // The epic itself is out of `candidates` on the same attempts count, so nothing opens at
  // all this tick; what matters is that the children are folded into a *batch* rather than
  // held for a planner, so the next thing that happens to them is bc-bhp9's.
  assert.match(heldWhy(r.card, 'x-1.1'), /batched under x-1/, `got: ${heldWhy(r.card, 'x-1.1')}`);
});

/**
 * Re-entry, which is the substance of the bead: no window is held open for the life of an
 * epic. A bead that appears under a planned epic and is in no group re-opens the planner,
 * and the ungrouped bead is held while that happens rather than being worked out from under
 * the plan it is about to join.
 */
await check('a bead nobody grouped re-opens the planner', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1'])]), { epic: 'x-1', children: null });
  const r = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }), bead('x-1.4')],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
  });
  assert.deepEqual(r.planned.map((p) => p.id), ['x-1'], 'the planner is re-entered');
  assert.deepEqual(r.planned[0].kids, ['x-1.4']);
  assert.equal(r.planned[0].revising, true, 'and it is told it is revising, so it keeps the groups already running');
  assert.deepEqual(r.opened, [], 'nothing opened on the ungrouped bead meanwhile');
  assert.match(heldWhy(r.card, 'x-1.4'), /waiting on x-1's plan, which is being revised/);
});

await check('and it is released rather than held for ever once planning has run out', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1'])]), { epic: 'x-1', children: null });
  const r = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }), bead('x-1.4')],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
    attempts: { 'x-1': 2 },
  });
  assert.deepEqual(r.planned, [], 'no planner is coming');
  assert.deepEqual(openedIds(r), ['x-1.4'], 'so the bead is worked on its own rather than waiting on one');
});

/* ----------------------------------------------------------- the promotion bead */

/**
 * When every bead a plan named has closed, the epic's work is in main — beads close on
 * merge — and what is left is not a window but a release. The bead filed for that is
 * deliberately not lib/release.js's per-merge `ship` bead; see lib/promote.js.
 */
await check('a plan with nothing left files a promotion bead, once', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1', 'x-1.2'])]), { epic: 'x-1', children: null });
  const r = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] })],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
  });
  assert.equal(r.created.length, 1, 'one bead');
  const filed = r.created[0];
  assert.match(filed.title, /^Promote x-1 —/);
  assert.equal(filed.type, PROMOTE_TYPE);
  assert.ok(filed.labels.includes(PROMOTE_LABEL), 'found by label, not by title');
  assert.ok(!filed.labels.includes('ship'), 'and never confusable with a per-merge ship bead');
  assert.ok(filed.labels.includes('unendorsed'), 'nothing opens a window on it unlooked-at');
  assert.match(filed.body, /alpha/, 'it names the repo whose image has to be promoted');
  assert.match(filed.body, /x-1\.1, x-1\.2/, 'and the beads it covers');
  assert.ok(r.labelled.includes(`x-1:${PROMOTED_LABEL}`), 'the epic is marked, which is what makes it once');
  assert.deepEqual(r.opened, [], 'and no window is opened on a done epic');
  assert.match(heldWhy(r.card, 'x-1'), /every bead in its plan is closed/);
});

await check('an epic already marked promoted files nothing', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1'])]), { epic: 'x-1', children: null });
  const r = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL, PROMOTED_LABEL] })],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
  });
  assert.deepEqual(r.created, [], 'the label is the guarantee, and it survives a daemon restart');
});

await check('a planned epic whose groups are still running is not promoted', async () => {
  const plan = validatePlan(planSpec([group('router', ['x-1.1'])]), { epic: 'x-1', children: null });
  const r = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] })],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
    // `at` is now, not `OLD`: a worker older than `workerTimeoutMinutes` is reaped by the
    // reconcile at the top of the tick, and a fixture whose window is swept before the
    // survey runs is testing the reaper rather than the thing it meant to.
    workers: [{ id: 'x-1.1', title: 'x-1.1', at: new Date().toISOString(), attempt: 1, batch: [] }],
  });
  assert.deepEqual(r.created, [], 'a window is still open on its work');
});

/**
 * A label with no plan behind it is the one inconsistent state bin/plan.js can leave (it
 * writes the comment first, so it should not arise) and it has to be harmless: the epic
 * falls through to the mechanical grouping exactly as an unplanned one would.
 */
await check('a `planned` label with no plan behind it changes nothing', async () => {
  const r = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }), bead('x-1.1'), bead('x-1.2')],
    comments: { 'x-1': [{ text: 'no plan in here' }] },
    children: { 'x-1': [bead('x-1.1', { status: 'open' }), bead('x-1.2', { status: 'open' })] },
  });
  assert.deepEqual(r.created, [], 'nothing promoted off a plan that is not there');
  assert.deepEqual(r.planned.map((p) => p.id), ['x-1'], 'and it is planned like any other unplanned epic');
});

/* ---------------------------------------------------------------------- done */

await quiesce();
await removeTree(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
console.log('all good');
