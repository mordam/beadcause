#!/usr/bin/env node
/**
 * A dispatched group leaves a mark on its epic — bc-zjab.3.
 *
 *     npm test
 *     node test/plandispatch.mjs
 *
 * The failure this exists for is not a crash and not a wrong answer: it is that **a plan
 * that was obeyed and a plan that was ignored look identical from the tracker.** Measured
 * on bc-y3qk — the plan said two groups, the daemon opened five windows two minutes later,
 * one per bead, and every surface a planner can reach said it had worked: the `planned`
 * label was on the epic, the plan comment parsed, the epic was open and unassigned, and the
 * children were `in_progress`, which is what a dispatched group looks like too. The only
 * evidence anywhere was the *wording* of one log line.
 *
 * So there are three things to hold down, and they are different in kind:
 *
 *   - **the label itself** — a pure function of the group's name, and it has to survive
 *     being a bd label: bd splits a label on the comma and normalises nothing else, so a
 *     group name written through unchanged would silently become two labels.
 *   - **the write** — the epic gets it when a group takes a window, and only then. A bead
 *     dispatched on its own must leave no mark at all, because the absence *is* the
 *     diagnosis: `planned` with nothing beside it is the bc-y3qk shape.
 *   - **the brief** — a planner is told to look for it (lib/session.js `planPromptFor`).
 *     That prose spells the prefix out rather than importing it, because lib/advocate.js
 *     imports lib/session.js and the reverse would be a cycle, so the pin is here: a brief
 *     naming a label nothing writes is worse than a brief that said nothing.
 *
 * test/epicplan.mjs owns the dispatch decision itself — which windows open, one lead per
 * group, the fallback to batching. This file owns only what the decision records.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-plandispatch-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates, dispatchLabel, DISPATCHED_PREFIX } = await import(LIB('advocate.js'));
const { formatPlan, PLANNED_LABEL, validatePlan } = await import(LIB('plan.js'));
const { planPromptFor } = await import(LIB('session.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, over = {}) => ({ id, title: id, priority: 2, issue_type: 'task', created_at: OLD, labels: [], ...over });
const epic = (id, over = {}) => bead(id, { issue_type: 'epic', ...over });

const group = (name, beads) => ({
  name,
  beads,
  prs: [{ repo: 'alpha', title: `${name} pr` }],
  prompt: `Do ${beads.join(' and ')} as one change.`,
});

/**
 * One tick, over a tracker that says what the case needs it to — the same shape
 * test/epicplan.mjs uses, narrowed to what this file asserts.
 *
 * `labelled` is the assertion: every `bd label add` the tick made, as `<id>:<label>`. The
 * mark is a write to the tracker and nothing else, so the only honest way to assert it is
 * to record the writes.
 */
async function tick({ ready = [], children = {}, comments = {}, workers = [], rows = [], addLabel = null, overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  if (workers.length) fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts: {} } }));

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
      flagFinishedEpics: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const labelled = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    listStatus: async () => [],
    // reconcile() finishes any worker whose bead it cannot find, which would empty a
    // fixture's seeded workers on the first tick — see the advocate-tick-fixtures note.
    show: async (_ws, id) => ({ id, title: id, status: 'open' }),
    children: async (_ws, id) => children[id] || [],
    comments: async (_ws, id) => comments[id] || [],
    create: async () => 'new-1',
    addLabel: async (ws, id, label) => {
      labelled.push(`${id}:${label}`);
      if (addLabel) await addLabel(ws, id, label);
    },
    graph: async () => ({ parents: new Map(), beads: new Map(rows.map((b) => [b.id, b])), adopts: new Map(), edges: new Map() }),
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push({ id: b.id, group: b.group ? b.group.name : null });
      return { dir: REPO, mode: 'test', term: null };
    },
    openPlan: async () => {
      throw new Error('no case here plans an epic — openPlan must not be reached');
    },
  });
  await advocates.tick();
  // The persisted records, not the in-memory ones: `persist` is what a restart reads back,
  // so a field that does not survive `JSON.stringify` is a field the daemon loses on its
  // own merge. See `workerHolds` — the ids it reads have to be here an hour later.
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8'));
  return { opened, labelled, workers: saved.alpha?.workers || [] };
}

/** The plan every dispatch case here works from: two groups, two beads apiece. */
const TWO_GROUPS = validatePlan(
  { groups: [group('the brief and the mark', ['x-1.1', 'x-1.2']), group('log timestamps', ['x-1.3'])] },
  { epic: 'x-1', children: [bead('x-1.1'), bead('x-1.2'), bead('x-1.3')] }
);

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

/* ------------------------------------------------------------------ the label */

await check('the label is the group, slugged, under one prefix', () => {
  assert.equal(dispatchLabel('the review gate and the round cap'), 'dispatched:the-review-gate-and-the-round-cap');
  assert.ok(dispatchLabel('anything').startsWith(DISPATCHED_PREFIX), 'one prefix, so a reader can find them all');
});

await check('it survives being a bd label — no comma, no space, no case', () => {
  // bd splits a label on the comma and normalises nothing else (measured against the real
  // binary), so a name written through unchanged would arrive as two labels and neither of
  // them would be the group.
  const label = dispatchLabel('The brief, and the mark — done TOGETHER');
  assert.ok(!label.includes(','), `a comma would be two labels: ${label}`);
  assert.ok(!/\s/.test(label), `whitespace has no place in a label: ${label}`);
  assert.equal(label, label.toLowerCase(), 'case survives bd, so it must not survive us');
  assert.ok(/^dispatched:[a-z0-9-]+$/.test(label), label);
});

await check('it is idempotent, so a re-dispatched group re-stamps rather than accumulates', () => {
  const once = dispatchLabel('the brief and the mark');
  assert.equal(dispatchLabel(once.slice(DISPATCHED_PREFIX.length)), once, 'the slug of a slug is the slug');
  assert.equal(dispatchLabel('the brief and the mark'), once);
});

await check('a name of nothing but punctuation still records a dispatch', () => {
  // The group dispatched; a bare `dispatched:` would read as a broken label rather than as
  // the fact it is recording.
  assert.equal(dispatchLabel('!!! ???'), 'dispatched:group');
  assert.equal(dispatchLabel(''), 'dispatched:group');
  assert.equal(dispatchLabel(null), 'dispatched:group');
});

await check('a very long group name is cut short of a label nobody can read', () => {
  const label = dispatchLabel('a group whose name is a whole paragraph about what it is for and why'.repeat(3));
  assert.ok(label.length <= DISPATCHED_PREFIX.length + 48, label);
  assert.ok(!label.endsWith('-'), `a cut must not leave a dangling dash: ${label}`);
});

/* --------------------------------------------------------------- the write */

await check('a group that takes a window marks its epic', async () => {
  const { opened, labelled } = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }), bead('x-1.1'), bead('x-1.2'), bead('x-1.3')],
    comments: { 'x-1': [{ text: formatPlan(TWO_GROUPS) }] },
  });

  assert.deepEqual(
    opened.map((o) => o.group).sort(),
    ['log timestamps', 'the brief and the mark'],
    'one window per group — the dispatch itself is test/epicplan.mjs, this is the premise'
  );
  assert.deepEqual(
    labelled.sort(),
    ['x-1:dispatched:log-timestamps', 'x-1:dispatched:the-brief-and-the-mark'],
    'the mark goes on the epic whose plan named the group, one per group'
  );
});

await check("a group's lead records the group's other beads, so nothing reads them as unattended", async () => {
  // bc-2uj4.9. The lead's window is briefed on every bead of its group and marks them all
  // `in_progress`, but `dispatchable` gives the lead `batch: []` — a group is held through
  // `plannedInto`, which filters the ready queue and writes nothing on the worker. So the
  // ids have to be on the record, or `workerHolds` cannot see the one window that is on
  // them and the re-entry sweep reports a stall against a bead mid-delivery.
  const { opened, workers } = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }), bead('x-1.1'), bead('x-1.2'), bead('x-1.3')],
    comments: { 'x-1': [{ text: formatPlan(TWO_GROUPS) }] },
  });
  assert.equal(opened.length, 2, 'two groups, two windows — the premise');

  const pair = workers.find((w) => w.group?.name === 'the brief and the mark');
  assert.ok(pair, 'the two-bead group took a window');
  assert.equal(pair.id, 'x-1.1', 'the lead is what `w.id` still says');
  assert.deepEqual(pair.group.beads, ['x-1.2'], 'and the other bead of the group is on the record, as an id');
  assert.deepEqual(pair.batch, [], 'not in `batch` — `heldByChildren` keys its upward guard on that length');
  assert.equal(pair.group.epic, 'x-1');

  const alone = workers.find((w) => w.group?.name === 'log timestamps');
  assert.deepEqual(alone.group.beads, [], 'a group of one has no other beads, and says so rather than saying null');

  // And an ordinary window is not a group at all, so there is nothing here to mistake for one.
  const plain = await tick({ ready: [bead('y-2')] });
  assert.equal(plain.workers[0].group, null);
});

await check('a bead dispatched on its own leaves no mark, which is the whole diagnosis', async () => {
  const { opened, labelled } = await tick({ ready: [bead('y-2')] });
  assert.deepEqual(opened.map((o) => o.id), ['y-2']);
  assert.deepEqual(labelled, [], 'an ordinary window is not a group, and must not look like one');
});

await check('the children of a planned epic going out ungrouped is exactly what is not marked', async () => {
  // The bc-y3qk shape: the plan is on the bead but nothing read it — here because the epic
  // never reached the queue, so `plansFor` never saw it and the children were ordinary
  // ready work. That is the outcome a planner could not tell from success.
  const { opened, labelled } = await tick({
    ready: [bead('x-1.1'), bead('x-1.2'), bead('x-1.3')],
    comments: { 'x-1': [{ text: formatPlan(TWO_GROUPS) }] },
  });
  assert.deepEqual(opened.map((o) => o.id).sort(), ['x-1.1', 'x-1.2', 'x-1.3']);
  assert.deepEqual(opened.map((o) => o.group), [null, null, null]);
  assert.deepEqual(labelled, [], 'no group took a window, so the epic says nothing — and that is readable');
});

await check('a tracker that will not take the mark does not cost the window', async () => {
  const { opened, labelled } = await tick({
    ready: [epic('x-1', { priority: 1, labels: [PLANNED_LABEL] }), bead('x-1.1'), bead('x-1.2'), bead('x-1.3')],
    comments: { 'x-1': [{ text: formatPlan(TWO_GROUPS) }] },
    addLabel: async () => {
      throw new Error('bd is not answering');
    },
  });
  assert.equal(opened.length, 2, 'the windows are open; a record is not worth taking one back for');
  assert.equal(labelled.length, 2, 'and both writes were attempted rather than one aborting the other');
});

/* --------------------------------------------------------------- the brief */

await check('the planner is told to look for the mark, and told what its absence means', () => {
  const brief = planPromptFor('alpha', { id: 'x-1', title: 'An epic' }, [bead('x-1.1')], 'Adam');
  assert.ok(
    brief.includes(DISPATCHED_PREFIX),
    'the brief spells the prefix out (no import — lib/advocate.js imports lib/session.js), so this is the pin'
  );
  assert.ok(brief.includes(`bd show x-1`), 'and says where to look');
  assert.ok(/one label per group/.test(brief), 'one per group, so a partial dispatch reads as one');
  assert.ok(
    /invisible from every other\nsurface/.test(brief) || /invisible from every other surface/.test(brief),
    'a planner that is not told the other surfaces lie will believe the first one it checks'
  );
  assert.ok(/opened a session on <bead> for "<group>"/.test(brief), 'the log wording is the fallback where the marks are missing');
});

/* --------------------------------------------------------------------- done */

await quiesce();
await removeTree(tmp);
console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
