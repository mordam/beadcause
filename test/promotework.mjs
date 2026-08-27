/**
 * What an epic's work *was* is a question for the tracker, not for a bead written days ago.
 *
 * bc-y8k4.1. A promotion bead is filed once — when every bead an epic's plan named has
 * closed — and its body is written at that moment and never again. The epic is not
 * finished at that moment: an advocate is re-entered on child events precisely so it can
 * file what the first plan missed, so work goes on closing under it for days. Measured on
 * bc-9d37: the promotion bead named four beads, the epic closed nine, and the most visible
 * behaviour change of the lot was among the five that landed afterwards.
 *
 * The image promoted is right either way — it is main's merge build. What goes stale is
 * what the release agent is told to *exercise in UAT*, and a promotion that tests the wrong
 * things and passes is worse than one that fails.
 *
 * So the assertions here are about one seam and its two ends:
 *
 *   - `landedWork` — the derivation. Every closed work bead in the subtree at the moment of
 *     asking, what it deliberately leaves out and why, and what is still open. An
 *     unreadable tracker is a stated error and never a short list.
 *   - `filePromotion`'s body — that it names the command rather than pretending its own
 *     snapshot is the test plan, and that a tracker that would not answer at filing time
 *     costs the snapshot and nothing else.
 *
 *     npm test
 *
 * No `bd`, no network, nothing written outside a temp config dir.
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);
const run = promisify(execFile);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and the
// daemon's own config is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-promotework-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { filePromotion, isWork, landedWork, whyNotWork, NOT_WORK } = await import(LIB('promote.js'));
const { validatePlan } = await import(LIB('plan.js'));

const WS = { name: 'alpha', dir: path.join(tmp, 'beads', 'alpha', '.beads') };

/* ------------------------------------------------------------------ fixtures */

const bead = (id, over = {}) => ({
  id,
  title: `${id} title`,
  status: 'closed',
  priority: 2,
  issue_type: 'task',
  assignee: '',
  labels: [],
  notes: '',
  ...over,
});

/**
 * A graph index of the shape `Bd.graph` answers with — `{ parents, beads }`, closed rows
 * included, which is the whole reason the derivation reads the export rather than a list.
 */
function index(rows, parentOf) {
  return {
    parents: new Map(Object.entries(parentOf)),
    beads: new Map(rows.map((r) => [r.id, r])),
    adopts: new Map(),
    edges: new Map(),
  };
}

/** The bc-9d37 shape: a plan that named four, an epic that closed nine. */
const NINE = index(
  [
    bead('x-1', { issue_type: 'epic', status: 'open' }),
    bead('x-1.6'),
    bead('x-1.7'),
    bead('x-1.8'),
    bead('x-1.9'),
    bead('x-1.11'),
    bead('x-1.12'),
    bead('x-1.13'),
    bead('x-1.14'),
    bead('x-1.17', { title: 'a handed-back row over a merged PR settles by itself' }),
  ],
  {
    'x-1.6': 'x-1',
    'x-1.7': 'x-1',
    'x-1.8': 'x-1',
    'x-1.9': 'x-1',
    'x-1.11': 'x-1',
    'x-1.12': 'x-1',
    'x-1.13': 'x-1',
    'x-1.14': 'x-1',
    'x-1.17': 'x-1',
  }
);

const plan = validatePlan(
  {
    groups: [
      {
        name: 'first',
        beads: ['x-1.6', 'x-1.7', 'x-1.8', 'x-1.9'],
        prs: [{ repo: 'alpha', title: 'the first four' }],
        prompt: 'Do the four beads the first plan named as one change.',
      },
    ],
  },
  { epic: 'x-1', children: null }
);

const fakeBd = (graph) => {
  const created = [];
  const labelled = [];
  return {
    created,
    labelled,
    graph: async () => (typeof graph === 'function' ? graph() : graph),
    create: async (_ws, spec) => {
      created.push(spec);
      return 'p-1';
    },
    addLabel: async (_ws, id, label) => labelled.push(`${id}:${label}`),
  };
};

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

/* --------------------------------------------------------------- the derivation */

await check('the tracker names every closed work bead, not the four the plan knew about', async () => {
  const work = await landedWork(fakeBd(NINE), WS, 'x-1');
  assert.equal(work.error, '');
  assert.deepEqual(
    work.beads.map((b) => b.id),
    ['x-1.6', 'x-1.7', 'x-1.8', 'x-1.9', 'x-1.11', 'x-1.12', 'x-1.13', 'x-1.14', 'x-1.17'],
    'nine, and the last of them is the epic\'s most visible change'
  );
  assert.match(work.beads.at(-1).title, /settles by itself/, 'with its title, so the list can be read');
});

await check('ids sort numerically, so the tenth is not filed between the first and the second', async () => {
  const rows = [bead('x-1', { issue_type: 'epic', status: 'open' }), bead('x-1.2'), bead('x-1.10')];
  const work = await landedWork(fakeBd(index(rows, { 'x-1.2': 'x-1', 'x-1.10': 'x-1' })), WS, 'x-1');
  assert.deepEqual(work.beads.map((b) => b.id), ['x-1.2', 'x-1.10']);
});

await check('a grandchild counts — a group\'s beads may hang off a task, not off the epic', async () => {
  const rows = [bead('x-1', { issue_type: 'epic', status: 'open' }), bead('x-1.2'), bead('x-1.2.1')];
  const work = await landedWork(fakeBd(index(rows, { 'x-1.2': 'x-1', 'x-1.2.1': 'x-1.2' })), WS, 'x-1');
  assert.deepEqual(work.beads.map((b) => b.id), ['x-1.2', 'x-1.2.1'], 'a missing bead is the whole defect');
});

await check('nothing was built for a ship, promote, container or superseded bead', async () => {
  const rows = [
    bead('x-1', { issue_type: 'epic', status: 'open' }),
    bead('x-1.1'),
    bead('x-1.2', { labels: ['ship'] }),
    bead('x-1.3', { labels: ['promote'] }),
    bead('x-1.4', { labels: ['container'] }),
    bead('x-1.5', { labels: ['superseded-by:x-9'] }),
  ];
  const parents = Object.fromEntries(rows.slice(1).map((r) => [r.id, 'x-1']));
  const work = await landedWork(fakeBd(index(rows, parents)), WS, 'x-1');
  assert.deepEqual(work.beads.map((b) => b.id), ['x-1.1'], 'one of the six is work');
  assert.deepEqual(
    work.skipped.map((b) => `${b.id}:${b.why}`),
    ['x-1.2:ship', 'x-1.3:promote', 'x-1.4:container', 'x-1.5:superseded-by:x-9'],
    'and each one says which label took it out — "where is x-1.2" is the first question a list gets'
  );
});

/**
 * The exclusion that is *not* here, and the measurement that says so. bc-9d37.12 and
 * bc-9d37.14 are closed, still carry `unendorsed`, and are two of the nine beads
 * bc-y8k4.1 measured as this epic's landed work: a session working a neighbour fixed them
 * and nothing takes the label off. Excluding it drops two of the nine.
 */
await check('a closed `unendorsed` bead is landed work, because on this tracker it is', async () => {
  const rows = [bead('x-1', { issue_type: 'epic', status: 'open' }), bead('x-1.12', { labels: ['unendorsed', 'promoted'] })];
  const work = await landedWork(fakeBd(index(rows, { 'x-1.12': 'x-1' })), WS, 'x-1');
  assert.deepEqual(work.beads.map((b) => b.id), ['x-1.12']);
  assert.deepEqual(work.skipped, [], 'and it is not even reported as left out');
});

await check('but an open one is a discovery, not work in flight', async () => {
  const rows = [
    bead('x-1', { issue_type: 'epic', status: 'open' }),
    bead('x-1.2', { status: 'open', labels: ['unendorsed'] }),
    bead('x-1.3', { status: 'open' }),
  ];
  const work = await landedWork(fakeBd(index(rows, { 'x-1.2': 'x-1', 'x-1.3': 'x-1' })), WS, 'x-1');
  assert.deepEqual(work.open.map((b) => b.id), ['x-1.3'], 'workers file discoveries under a live epic constantly');
});

await check('the exclusions are the labels themselves, not a title match', () => {
  assert.deepEqual(NOT_WORK, ['ship', 'promote', 'container', 'card']);
  assert.equal(whyNotWork({ labels: [' ship '] }), 'ship', 'whitespace on a label is still that label');
  assert.equal(whyNotWork({ labels: ['human', 'p0'] }), '', 'a bead that went to Adam mid-flight is still work');
  assert.equal(whyNotWork({ labels: ['promoted'] }), '', 'the epic marker is one letter from the bead label');
  assert.equal(whyNotWork({}), '', 'and a row with no labels at all is work rather than a crash');
  assert.equal(isWork({ labels: ['ship'] }), false);
  assert.equal(isWork({ labels: [] }), true);
});

/**
 * bc-7qo.9's own acceptance criteria, modelled directly on its two named exemplars:
 * bc-xl7n.15 (a sweep card — closing it was a report and a tap) and bc-xl7n.35 (a bug a
 * session fixed in code), both closed under bc-9d37 carrying `inbox`/`tracker`/`unsorted`.
 * Neither carried `card` when they were filed, because the label did not exist yet — this
 * pins the label alone as what a *future* pair like them would be told apart by.
 */
await check('a card the daemon filed reads apart from work, by the label alone', () => {
  const daemonCard = { labels: ['inbox', 'tracker', 'unsorted', 'card'] };
  const codeThatLanded = { labels: ['inbox', 'tracker', 'unsorted'] };
  assert.equal(whyNotWork(daemonCard), 'card');
  assert.equal(isWork(daemonCard), false);
  assert.equal(whyNotWork(codeThatLanded), '', 'no `card` label, so it reads as work — same shape bc-xl7n.35 has today');
  assert.equal(isWork(codeThatLanded), true);
});

await check('open work is reported apart from the list rather than folded into it', async () => {
  const rows = [
    bead('x-1', { issue_type: 'epic', status: 'open' }),
    bead('x-1.1'),
    bead('x-1.2', { status: 'open' }),
    bead('x-1.3', { status: 'in_progress' }),
  ];
  const work = await landedWork(fakeBd(index(rows, { 'x-1.1': 'x-1', 'x-1.2': 'x-1', 'x-1.3': 'x-1' })), WS, 'x-1');
  assert.deepEqual(work.beads.map((b) => b.id), ['x-1.1'], 'only what closed is in main');
  assert.deepEqual(work.open.map((b) => b.id), ['x-1.2', 'x-1.3'], 'an epic promoted over open work is bc-4bet.2');
});

await check('a tracker that will not answer is an error, never a short list', async () => {
  const broken = await landedWork(fakeBd({ parents: new Map(), beads: new Map(), error: 'bd export timed out' }), WS, 'x-1');
  assert.deepEqual(broken.beads, []);
  assert.equal(broken.error, 'bd export timed out', 'the stand-in carries the reason it is a stand-in');

  const threw = await landedWork(
    fakeBd(() => {
      throw new Error('dolt is locked\nby another process');
    }),
    WS,
    'x-1'
  );
  assert.equal(threw.error, 'dolt is locked', 'one line of it, as everywhere else here');

  const none = await landedWork({ create: async () => 'p-1' }, WS, 'x-1');
  assert.match(none.error, /no tracker graph/, 'a bd with no graph is the same state, as in lib/homing.js');
});

await check('an epic with nothing under it is an empty list and no error', async () => {
  const work = await landedWork(fakeBd(index([bead('x-1', { issue_type: 'epic', status: 'open' })], {})), WS, 'x-1');
  assert.deepEqual(work.beads, []);
  assert.equal(work.error, '', 'which is a different sentence from "I could not find out"');
});

/* ------------------------------------------------------------------- the body */

await check('the filed body sends the reader to the tracker, with the command to run', async () => {
  const bd = fakeBd(NINE);
  const r = await filePromotion(bd, WS, { id: 'x-1', title: 'the epic', labels: [] }, plan);
  assert.equal(r.filed, 'p-1');
  const { body } = bd.created[0];
  assert.match(body, /beadcause-promotework -w alpha -e x-1/, 'the command, with this workspace and this epic in it');
  assert.match(body, /Ask the tracker what to test/);
  assert.match(body, /passes is worse than one that fails/, 'and why, because a card that only instructs gets skipped');
});

await check('and it names what had landed by then — including work the plan never mentioned', async () => {
  const bd = fakeBd(NINE);
  await filePromotion(bd, WS, { id: 'x-1', title: 'the epic', labels: [] }, plan);
  const { body } = bd.created[0];
  assert.match(body, /What had landed when this was filed\*\* \(9, and there may be more by now\)/);
  assert.match(body, /x-1\.17/, 'the plan named four; the tracker knew nine');
  assert.match(body, /\*\*Repos\*\* \(one image each\): `alpha`/, 'the plan is still the only source for the repos');
  assert.match(body, /- \*\*first\*\* — x-1\.6, x-1\.7, x-1\.8, x-1\.9 → 1 PR in `alpha`/, 'and for how it was grouped');
});

await check('a title too long to read is clipped rather than dropped', async () => {
  const long = 'a'.repeat(200);
  const rows = [bead('x-1', { issue_type: 'epic', status: 'open' }), bead('x-1.6', { title: long })];
  const bd = fakeBd(index(rows, { 'x-1.6': 'x-1' }));
  await filePromotion(bd, WS, { id: 'x-1', title: 'the epic', labels: [] }, plan);
  const line = bd.created[0].body.split('\n').find((l) => l.startsWith('- `x-1.6`'));
  assert.ok(line.length < 120, `got ${line.length} chars`);
  assert.match(line, /…$/, 'and says it was clipped');
});

await check('a tracker that would not answer at filing time costs the snapshot and nothing else', async () => {
  const bd = fakeBd({ parents: new Map(), beads: new Map(), error: 'bd export timed out' });
  const r = await filePromotion(bd, WS, { id: 'x-1', title: 'the epic', labels: [] }, plan);
  assert.equal(r.filed, 'p-1', 'the bead is still filed — a promotion nobody files is worse than a thin one');
  const { body } = bd.created[0];
  assert.match(body, /the tracker could not be read when this was filed — bd export timed out/);
  assert.match(body, /- `x-1\.6`/, 'so it falls back to the plan');
  assert.match(body, /beadcause-promotework -w alpha -e x-1/, 'and still says where the real answer is');
});

await check('the guarantee is unchanged — one per epic, by the label on the epic', async () => {
  const bd = fakeBd(NINE);
  const already = await filePromotion(bd, WS, { id: 'x-1', title: 'the epic', labels: ['promoted'] }, plan);
  assert.deepEqual(already, { already: true });
  assert.deepEqual(bd.created, [], 'nothing derived, nothing read, nothing filed');

  const fresh = fakeBd(NINE);
  await filePromotion(fresh, WS, { id: 'x-1', title: 'the epic', labels: [] }, plan);
  assert.deepEqual(fresh.labelled, ['x-1:promoted'], 'and the label goes on after the bead, never before');
});

/* -------------------------------------------------------------------- the bin */

await check('beadcause-promotework refuses an unknown workspace rather than guessing one', async () => {
  const r = await run(process.execPath, [path.join(ROOT, 'bin', 'promotework.js'), '-w', 'nope', '-e', 'x-1'], {
    env: { ...process.env, BEADCAUSE_CONFIG_DIR: process.env.BEADCAUSE_CONFIG_DIR },
  }).catch((err) => err);
  assert.equal(r.code, 1, 'usage, and the exit code says so');
  assert.match(r.stderr, /usage: beadcause-promotework -w <workspace> -e <epic>/);
  assert.match(r.stderr, /-b <promotion bead> works too/, 'because a release agent holds the promotion bead, not the epic');
});

/* --------------------------------------------------------------------- report */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
console.log('all good');
