#!/usr/bin/env node
/**
 * The release queue — what merged and is not running yet.
 *
 *     npm test
 *     node test/release.mjs
 *
 * `test/prship.mjs` proves Ship on one row. This is the queue *behind* that button: the
 * set of merges one deploy would make live, the number drawn over it, and the bead filed
 * per merge so "still owed: deploy" survives the notification that said it.
 *
 * Six failures are worth the file, and five of them are the same failure wearing
 * different hats — **saying something is shipped when nobody knows**:
 *
 * 1. **A flood on first sight.** The board carries three weeks of merged pull requests.
 *    A daemon meeting a repo for the first time — a new install, a new workspace, this
 *    feature's own first run — must file a watermark and *nothing else*, or the tracker
 *    gets a dozen beads for work that shipped a fortnight ago. Asserted first because it
 *    is the one that would have been noticed by Adam rather than by a test.
 * 2. **A duplicate.** Two ticks, one merge, one bead. Proved twice over: once through
 *    the ledger, and once with the ledger deleted underneath it, because the ledger is
 *    a watermark and not a lock — what actually stops a second bead is reading the
 *    tracker for a marker.
 * 3. **A close on evidence that is not evidence.** `unconfirmed` is the *ordinary*
 *    ending of a deploy that restarts the daemon asking for it, and it means the command
 *    ran with nobody left to say what happened. A queue that drained on it would be
 *    inventing the fact it exists to report. Same for `lost`, and same for a deploy that
 *    started *before* the merge landed.
 * 4. **A merge counted before it can be shipped.** A deploy fast-forwards to
 *    `origin/main`; a merge this Mac has not seen there yet could not be picked up by
 *    one, so it is not in the queue however merged GitHub says it is.
 * 5. **A bead nothing could ever close.** A repo with no declared deploy and no visible
 *    build has no event that would settle one, so none is filed there.
 * 6. **Shipping an empty queue.** Pressing Ship on a repo where everything merged is
 *    already live would, on this Mac, restart the daemon you are holding for nothing.
 * 7. **A bead filed where nobody will read it.** bc-arj0.5: the parent was knowable at
 *    filing time and was not being used, so these arrived flat and were swept into the
 *    unsorted backlog — 40% of the pile that exists for work nothing has decided a home
 *    for, made of beads that decide themselves. Both halves are asserted, and the second
 *    is the one a "simplification" would drop: the P0 above the merge's own bead where
 *    there is one, and **no parent at all** where there is not, rather than the backlog.
 *
 * The last third of the file is the endpoint, over real HTTP, against a real `createApp`
 * with a real git repo, a fake `gh` and a "deploy" that writes a file. Nothing here
 * restarts anything, opens a window, reaches the network, or touches a tracker of yours.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-release-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// both the deploy journal and this file's ledger live under it.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for `fn` to stop throwing, or give up. A deploy is another process. */
async function until(fn, { ms = 8000, every = 40 } = {}) {
  const deadline = Date.now() + ms;
  let last;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (Date.now() > deadline) throw last;
      await sleep(every);
    }
  }
}

const {
  LEDGER_PATH,
  SHIP_LABEL,
  decorateBoard,
  loadLedger,
  markerOf,
  owedFor,
  releaseFor,
  shipMarker,
  shipReason,
  shippedState,
  SHIPPED_LABEL,
  sweepReleases,
} = await import(LIB('release.js'));
const { UNENDORSED } = await import(LIB('endorse.js'));
const { UNSORTED_LABEL } = await import(LIB('homing.js'));
const { indexFrom, PARENT_EDGE } = await import(LIB('ancestry.js'));

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

/** A board row, in the shape lib/prboard.js hands out. Merged and not live by default. */
const row = (over = {}) => ({
  number: 1,
  title: 'zz-work: something small',
  url: 'https://github.com/acme/demo/pull/1',
  base: 'main',
  branch: 'worktree-something-work',
  author: 'someone',
  state: 'MERGED',
  merged: true,
  pushed: true,
  local: true,
  deployed: null,
  deployTracked: false,
  deployDeclared: true,
  mergeCommit: 'a'.repeat(40),
  mergedAt: ago(60),
  ...over,
});

const card = (over = {}) => ({
  workspace: 'demo',
  repo: 'acme/demo',
  base: 'main',
  error: null,
  deployTracked: false,
  deployDeclared: true,
  deployHint: 'runs `writer`',
  prs: [row()],
  ...over,
});

const deploy = (over = {}) => ({ id: 'd-1', workspace: 'demo', status: 'ok', startedAt: ago(10), ...over });

/* ================================================================ what is shipped */

console.log('\nthe release queue — what counts as shipped\n');

await check(
  () => assert.equal(shippedState(row({ deployed: true }), []), true),
  'in the build that is running is shipped, whatever the journal says'
);
await check(
  () => assert.equal(shippedState(row(), [deploy()]), true),
  'a deploy that exited 0 after the merge landed is shipped'
);
await check(
  () => assert.equal(shippedState(row(), []), false),
  'merged, pushed, and no deploy since: not shipped'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ startedAt: ago(90) })]), false),
  'a deploy that started before the merge landed ships nothing'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ status: 'unconfirmed' })]), false),
  '`unconfirmed` never counts — the command ran and nobody outlived it to say what happened'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ status: 'lost' })]), false),
  '`lost` never counts either'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ status: 'failed' })]), false),
  'and neither does a deploy that failed'
);
await check(
  () => assert.equal(shippedState(row({ pushed: null }), [deploy()]), null),
  'a merge this Mac has not seen on origin is null, not false — no deploy could pick it up'
);
await check(
  () => assert.equal(shippedState(row({ merged: false, state: 'OPEN' }), [deploy()]), null),
  'an open pull request is not in the queue at all'
);
await check(
  () => assert.equal(shippedState(row(), [deploy({ workspace: 'other' })].filter((d) => d.workspace === 'demo')), false),
  "another repo's deploy is not this one's — the caller groups by workspace"
);

/* ------------------------------------------------------------------- the queue */

console.log('\nthe queue, and the number on the button\n');

const busy = card({
  prs: [
    row({ number: 4, mergedAt: ago(5) }),
    row({ number: 3, mergedAt: ago(30) }),
    row({ number: 2, mergedAt: ago(120), deployed: true }),
    row({ number: 9, state: 'OPEN', merged: false, mergedAt: null }),
  ],
});

await check(() => assert.deepEqual(owedFor(busy, []).map((p) => p.number), [4, 3]), 'the queue is the merges that are not live, newest first');
await check(() => assert.equal(releaseFor(busy, []).count, 2), 'and the count is what the button wears');
await check(() => assert.equal(releaseFor(busy, []).can, 'deploy'), 'a declared repo can ship its queue in one press');
await check(
  () => assert.equal(releaseFor(card({ deployDeclared: false }), []).can, 'session'),
  'a repo that declared nothing says so instead of offering a batch it cannot do'
);
await check(
  () => assert.equal(releaseFor(busy, [], { demo: { handled: { 4: { bead: 'zz-abc' } } } }).prs[0].bead, 'zz-abc'),
  'a queued merge carries the ship bead filed for it'
);
await check(() => assert.equal(releaseFor(busy, [], {}).prs[0].bead, null), 'and null where none was filed, which is ordinary');
await check(
  () => assert.match(shipReason(releaseFor(busy, [])), /#4, #3/),
  'the deploy record says which merges it carried'
);

/* ------------------------------------------------------------- decorating a board */

const original = { repos: [busy, card({ workspace: 'bare', deployDeclared: false, prs: [row({ number: 7 })] })], counts: { open: 1 } };
const frozen = JSON.stringify(original);
const decorated = decorateBoard(original, {}, []);

await check(() => assert.equal(decorated.counts.ship, 3), 'the board carries the total, which is what the tab badge reads');
await check(() => assert.equal(decorated.counts.open, 1), 'and keeps the counts it already had');
await check(() => assert.equal(JSON.stringify(original), frozen), 'and never writes into the cached board it was handed');
await check(() => assert.equal(decorated.repos[0].release.count, 2), 'every card gets its own queue');

/* ------------------------------------------------------------------- the marker */

await check(() => assert.deepEqual(markerOf(`x\n${shipMarker('acme/demo', 12)}\ny`), { repo: 'acme/demo', number: 12 }), 'a ship bead names its pull request');
await check(() => assert.equal(markerOf('nothing here'), null), 'and prose that names none reads as none');
await check(() => assert.equal(markerOf('shipped: acme/demo#12'), null), 'a near-miss is not a marker');

/* ============================================================== filing the beads */

console.log('\nthe bead per merge\n');

/** A tracker that records what it was asked to do, and answers from what it has. */
function tracker(rows = []) {
  const t = {
    beads: [...rows],
    created: [],
    closed: [],
    labelled: [],
    failUpdates: false,
    n: 0,
    listLabel: async (ws, label) => t.beads.filter((b) => (b.labels || []).includes(label) && b.workspace === ws.name),
    create: async (ws, spec) => {
      t.n += 1;
      const id = `zz-${t.n}`;
      t.created.push({ ws: ws.name, id, spec });
      t.beads.push({ id, workspace: ws.name, description: spec.body, labels: spec.labels, status: 'open' });
      return id;
    },
    close: async (ws, id, reason) => {
      t.closed.push({ ws: ws.name, id, reason });
      t.beads = t.beads.filter((b) => b.id !== id);
    },
    // Every `--add-label` this sweep asks for, in order and with duplicates kept — the
    // only way to tell "labelled once" from "labelled again on every tick", which is the
    // difference the ledger gate exists to make.
    update: async (ws, id, { addLabels = [] } = {}) => {
      if (t.failUpdates) throw new Error('tracker is mid-write');
      for (const label of addLabels) t.labelled.push({ ws: ws.name, id, label });
    },
  };
  return t;
}

const CFG = {
  workspaces: [{ name: 'demo', dir: path.join(tmp, 'beads-demo') }, { name: 'bare', dir: path.join(tmp, 'beads-bare') }],
  release: { beads: true },
};

const forget = () => fs.rmSync(LEDGER_PATH, { force: true });

/* 1. First sight files nothing, however much has merged. */
forget();
{
  const bd = tracker();
  const board = { repos: [card({ prs: [row({ number: 1 }), row({ number: 2 }), row({ number: 3 })] })] };
  const out = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'the first sight of a repo files nothing — three weeks of history is not news');
  await check(() => assert.equal(out.watermarked[0]?.merged, 3), 'it says how much it decided not to file for');
  await check(() => assert.ok(loadLedger().demo.since), 'and writes the watermark that makes that decision once');
}

/* 2. A merge after the watermark gets exactly one bead, and only one. */
{
  const bd = tracker();
  const fresh = row({ number: 4, mergedAt: new Date().toISOString() });
  const board = { repos: [card({ prs: [row({ number: 1 }), fresh] })] };

  const first = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'a merge after the watermark is filed');
  await check(() => assert.equal(first.filed[0]?.number, 4), 'and it is the new one, not the one that predates it');

  const spec = bd.created[0].spec;
  await check(() => assert.ok(spec.labels.includes(SHIP_LABEL)), `the bead carries \`${SHIP_LABEL}\`, which is how it is found again`);
  await check(
    () => assert.ok(spec.labels.includes(UNENDORSED)),
    'and `unendorsed`, so nothing opens a session on it — shipping is a tap, not a session'
  );
  await check(() => assert.ok(!spec.labels.includes('human')), 'and not `human`: it is a chore, not a question with options');
  await check(() => assert.deepEqual(markerOf(spec.body), { repo: 'acme/demo', number: 4 }), 'its body names the pull request it is about');
  await check(() => assert.match(spec.title, /#4/), 'and so does its title');

  await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'a second tick over the same board files nothing more');

  // The ledger is a watermark, not a lock. What actually stops a duplicate is the
  // marker on the bead, and this is the only way to prove the two are independent.
  const saved = fs.readFileSync(LEDGER_PATH, 'utf8');
  const ledger = JSON.parse(saved);
  delete ledger.demo.handled['4'];
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(ledger));
  await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'and neither does one with the ledger entry torn out from under it');
  fs.writeFileSync(LEDGER_PATH, saved);

  /* 3. It closes itself when the merge is live — and on nothing weaker. */
  const bead = bd.created[0].id;
  await sweepReleases(bd, CFG, { repos: [card({ prs: [fresh] })] }, { deploys: [deploy({ status: 'unconfirmed', startedAt: new Date().toISOString() })] });
  await check(() => assert.equal(bd.closed.length, 0), 'an `unconfirmed` deploy closes nothing');

  const shipped = { repos: [card({ prs: [row({ number: 4, mergedAt: fresh.mergedAt, deployed: true })] })] };
  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.closed[0]?.id, bead), 'and being in the running build closes it');
  await check(() => assert.match(bd.closed[0]?.reason || '', /#4/), 'with a reason that says which merge went live');
  await check(() => assert.ok(loadLedger().demo.handled['4']?.shippedAt), 'the ledger records that it settled');

  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'and a settled merge is never filed again');
}

/* 4. A merge that has not reached origin is not the queue's business. */
forget();
{
  const bd = tracker();
  const unpushed = row({ number: 5, pushed: null, mergedAt: new Date().toISOString() });
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  await sweepReleases(bd, CFG, { repos: [card({ prs: [unpushed] })] }, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a merge this Mac has not seen on origin files nothing — no deploy could ship it');
}

/* 5. No declared deploy, no visible build: nothing here could ever close a bead. */
forget();
{
  const bd = tracker();
  const bare = card({ workspace: 'bare', deployDeclared: false, deployTracked: false, prs: [row({ number: 6, mergedAt: new Date().toISOString() })] });
  await sweepReleases(bd, CFG, { repos: [bare] }, { deploys: [] });
  await sweepReleases(bd, CFG, { repos: [bare] }, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a repo whose ship beadcause could never see files none');
  await check(() => assert.equal(loadLedger().bare, undefined), 'and gets no watermark either — there is nothing to watermark');
}

/* 6. The two ways the sweep is switched off, and the one way it refuses itself. */
forget();
{
  const bd = tracker();
  const board = { repos: [card({ prs: [row({ number: 7, mergedAt: new Date().toISOString() })] })] };
  const off = await sweepReleases(bd, { ...CFG, release: { beads: false } }, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), '`release.beads: false` files nothing and writes no ledger');
  await check(() => assert.match(off.skipped[0] || '', /filing is off/), 'and says why');

  fs.writeFileSync(LEDGER_PATH, '{ this is not json');
  const broken = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'an unreadable ledger files nothing at all');
  await check(
    () => assert.match(broken.error || '', /cannot be read/),
    'because a lost watermark would file every old merge again — so it says so and stops'
  );
  forget();
}

/* 7. A tracker that will not answer is a tick that did nothing, not a duplicate. */
{
  const bd = tracker();
  const board = { repos: [card({ prs: [row({ number: 8, mergedAt: new Date().toISOString() })] })] };
  await sweepReleases(bd, CFG, board, { deploys: [] });
  bd.listLabel = async () => {
    throw new Error('database is busy');
  };
  const busySweep = await sweepReleases(bd, CFG, board, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a workspace mid-write files nothing this tick');
  await check(() => assert.match(busySweep.skipped[0] || '', /could not read its ship beads/), 'and says which one, rather than throwing');
}

/* ========================================================= where the bead is filed */

console.log('\nunder the P0 the merge came from — bc-arj0.5\n');

/**
 * The graph the sweep reads to answer "which P0 is this merge's work under". A themed P0
 * with a task under it, the unsorted backlog, and a bead nothing has decided.
 */
const gRow = (id, extra = {}) =>
  JSON.stringify({ id, title: `bead ${id}`, status: 'open', priority: 2, labels: [], dependencies: [], ...extra });
const GRAPH = indexFrom(
  [
    gRow('zz-epic', { priority: 0 }),
    gRow('zz-epic.1', { dependencies: [{ issue_id: 'zz-epic.1', depends_on_id: 'zz-epic', type: PARENT_EDGE }] }),
    gRow('zz-pile', { priority: 0, labels: [UNSORTED_LABEL] }),
    gRow('zz-loose'),
  ].join('\n')
);

/** The tracker above, plus the shape the sweep reads — counting how often it is asked. */
const homing = (rows = []) => {
  const t = tracker(rows);
  t.exports = 0;
  t.graph = async () => {
    t.exports += 1;
    return GRAPH;
  };
  return t;
};

/** A merged row that lib/prboard.js resolved to `id` — the field `beadsFor` fills in. */
const forBead = (number, id) =>
  row({ number, mergedAt: new Date().toISOString(), beads: id ? [{ id, title: `bead ${id}`, status: 'closed' }] : [] });

forget();
{
  const bd = homing();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const out = await sweepReleases(bd, CFG, { repos: [card({ prs: [forBead(20, 'zz-epic.1')] })] }, { deploys: [] });

  await check(
    () => assert.equal(bd.created[0]?.spec.parent, 'zz-epic'),
    'THE SHIP BEAD IS FILED UNDER THE P0 OF THE BEAD ITS PULL REQUEST WAS FOR'
  );
  await check(
    () => assert.notEqual(bd.created[0]?.spec.parent, 'zz-epic.1'),
    'and never under the bead itself — that task closes, and its open child is then held forever'
  );
  await check(() => assert.equal(out.filed[0]?.parent, 'zz-epic'), 'the result says where it went, which is what the log line prints');
}

forget();
{
  const bd = homing();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const out = await sweepReleases(
    bd,
    CFG,
    { repos: [card({ prs: [forBead(21, ''), forBead(22, 'zz-loose')] })] },
    { deploys: [] }
  );

  // The half of bc-arj0.5 that is *not* "find the parent": the unsorted backlog is the
  // pile of work nobody has decided a home for, and a bead that closes itself when a
  // deploy lands is not asking that question. Thirty a week of them buries the ones that
  // are. So an unknowable P0 files the parentless bead this always filed.
  await check(
    () => assert.deepEqual(bd.created.map((c) => c.spec.parent || ''), ['', '']),
    'A PULL REQUEST WITH NO KNOWABLE P0 IS FILED FLAT — NEVER INTO THE UNSORTED BACKLOG'
  );
  await check(
    () => assert.ok(!bd.created.some((c) => c.spec.parent === 'zz-pile')),
    'not even when a backlog P0 is right there, labelled and open'
  );
  await check(() => assert.deepEqual(out.filed.map((f) => f.parent), [null, null]), 'and the result says so rather than naming a home');
}

forget();
{
  // `Bd.create` drops the cached shape whenever it is given a parent — a bead born under
  // a P0 is one the cache has never heard of, and lib/underroot.js would draw a pill on it
  // for the rest of the minute. So each filing invalidates what the next one wants, and
  // without the sweep's own memo a tick filing four beads pays for four `bd export`s.
  const bd = homing();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const many = [30, 31, 32, 33].map((n) => forBead(n, 'zz-epic.1'));
  await sweepReleases(bd, CFG, { repos: [card({ prs: many })] }, { deploys: [] });

  await check(() => assert.equal(bd.created.length, 4), 'four merges, four beads');
  await check(() => assert.equal(bd.exports, 1), 'ONE SHAPE PER WORKSPACE PER TICK, HOWEVER MANY BEADS IT FILES');
  await check(
    () => assert.deepEqual(new Set(bd.created.map((c) => c.spec.parent)), new Set(['zz-epic'])),
    'and every one of them lands under the P0 anyway'
  );
}

forget();
{
  // bd's hierarchy rules are bd's — a P0 that is a `bug` rather than an epic refuses a
  // child — and the record that a merge is sitting unshipped is worth more than the
  // parent nothing here chose. Same trade as lib/filing.js, one seam along.
  const bd = homing();
  const real = bd.create;
  bd.create = async (ws, spec) => {
    if (spec.parent) throw new Error('Error: bugs cannot have children');
    return real(ws, spec);
  };
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const out = await sweepReleases(bd, CFG, { repos: [card({ prs: [forBead(23, 'zz-epic.1')] })] }, { deploys: [] });

  await check(() => assert.equal(bd.created.length, 1), 'A PARENT BD REFUSES COSTS THE PARENT, NEVER THE BEAD');
  await check(() => assert.equal(bd.created[0]?.spec.parent, ''), 'it is filed flat on the second try');
  await check(() => assert.equal(out.filed[0]?.parent, null), 'and does not claim a home it did not get');
  await check(() => assert.match(out.skipped.join('\n'), /would not go under zz-epic/), 'the sweep says which parent was refused');
}

forget();
{
  // The tracker every existing caller has: no `graph`, so `homeIn` answers `''` without
  // asking anything. The bead is exactly what it was before this existed.
  const bd = tracker();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  await sweepReleases(bd, CFG, { repos: [card({ prs: [forBead(24, 'zz-epic.1')] })] }, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 1), 'a tracker that cannot answer the question still files the bead');
  await check(() => assert.equal(bd.created[0]?.spec.parent || '', ''), 'with no parent, which is what it always did');
}

/* ================================================ the work bead wears `shipped` */

console.log('\nthe work bead behind the merge — bc-68ou.6\n');

/** The same merged row, now live in the running build. */
const live = (number, id) => ({ ...forBead(number, id), deployed: true });

forget();
{
  const bd = tracker();
  const seen = { repos: [card({ prs: [] })] };
  await sweepReleases(bd, CFG, seen, { deploys: [] });

  const merged = { repos: [card({ prs: [forBead(40, 'zz-work.1')] })] };
  await sweepReleases(bd, CFG, merged, { deploys: [] });
  await check(() => assert.equal(bd.labelled.length, 0), 'a merge that is not live yet labels nothing — merged is not shipped');

  const shipped = { repos: [card({ prs: [live(40, 'zz-work.1')] })] };
  const out = await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(
    () => assert.deepEqual(bd.labelled, [{ ws: 'demo', id: 'zz-work.1', label: SHIPPED_LABEL }]),
    `and a merge that is live labels the bead it was for \`${SHIPPED_LABEL}\``
  );
  await check(() => assert.deepEqual(out.marked[0]?.beads, ['zz-work.1']), 'the sweep reports which bead it marked');
  await check(() => assert.equal(out.marked[0]?.number, 40), 'and which merge made it live');

  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.labelled.length, 1), 're-running the sweep over the same deploy writes nothing at all');

  await check(() => assert.equal(bd.closed.length, 1), 'the ship bead closed, and it is the only thing that closed');
  await check(
    () => assert.equal(bd.beads.filter((b) => b.status === 'open' && (b.labels || []).includes(SHIPPED_LABEL)).length, 0),
    'nothing here ever changed a work bead’s status — lib/landed.js closes it at the merge'
  );
}

/* Several beads before the colon is one merge that shipped both. */
forget();
{
  const bd = tracker();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const two = row({
    number: 41,
    mergedAt: new Date().toISOString(),
    deployed: true,
    title: 'zz-work.2, zz-work.3: two beads, one merge',
    beads: [
      { id: 'zz-work.2', title: 'first', status: 'closed' },
      { id: 'zz-work.3', title: 'second', status: 'closed' },
    ],
  });
  const out = await sweepReleases(bd, CFG, { repos: [card({ prs: [two] })] }, { deploys: [] });
  await check(
    () => assert.deepEqual(bd.labelled.map((l) => l.id), ['zz-work.2', 'zz-work.3']),
    'every bead the merge was for is labelled, not just the first — `beadOf` takes one home, a label is a fact about each'
  );
  await check(() => assert.deepEqual(out.marked[0]?.beads, ['zz-work.2', 'zz-work.3']), 'and both are reported on one line');
}

/* A pull request nobody tied to a bead labels nothing, and says nothing. */
forget();
{
  const bd = tracker();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const out = await sweepReleases(bd, CFG, { repos: [card({ prs: [live(42, null)] })] }, { deploys: [] });
  await check(() => assert.equal(bd.labelled.length, 0), 'a merge that resolved to no bead labels nothing rather than guessing');
  await check(() => assert.equal(out.marked.length, 0), 'and reports nothing, because nothing happened');
}

/* Three weeks of history at first sight is not news here either. */
forget();
{
  const bd = tracker();
  const old = { ...forBead(43, 'zz-work.4'), mergedAt: ago(60 * 24 * 21), deployed: true };
  await sweepReleases(bd, CFG, { repos: [card({ prs: [old] })] }, { deploys: [] });
  await sweepReleases(bd, CFG, { repos: [card({ prs: [old] })] }, { deploys: [] });
  await check(() => assert.equal(bd.labelled.length, 0), 'a merge that predates the watermark is never labelled — forward-only, no backfill');
}

/* A label the tracker refused is retried, and costs the merge nothing permanently. */
forget();
{
  const bd = tracker();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const shipped = { repos: [card({ prs: [live(44, 'zz-work.5')] })] };

  bd.failUpdates = true;
  const failed = await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.match(failed.skipped.join('\n'), /could not label the work behind #44/), 'a tracker mid-write is reported, not swallowed');
  await check(() => assert.equal(loadLedger().demo.handled['44']?.shippedAt || null, null), 'and nothing is stamped, so the merge is still unsettled');

  bd.failUpdates = false;
  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.labelled.length, 1), 'the next tick asks again and the label lands');
  await check(() => assert.ok(loadLedger().demo.handled['44']?.shippedAt), 'and only then does the ledger record it settled');
}

/* Merged and deployed between two sweeps: no ship bead was ever filed for it. */
forget();
{
  const bd = tracker();
  await sweepReleases(bd, CFG, { repos: [card({ prs: [] })] }, { deploys: [] });
  const shipped = { repos: [card({ prs: [live(45, 'zz-work.6')] })] };
  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.created.length, 0), 'a merge already live when first seen files no ship bead, as it always did');
  await check(() => assert.equal(bd.labelled.length, 1), 'but the work bead is still labelled — that is the fact the label is about');

  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await sweepReleases(bd, CFG, shipped, { deploys: [] });
  await check(() => assert.equal(bd.labelled.length, 1), 'and it is recorded, so it does not pay for the label again on every tick');
  await check(() => assert.equal(loadLedger().demo.handled['45']?.filedAt || null, null), 'the record says outright that no bead was ever filed');
}

/* ================================================================== the endpoint */

console.log('\nshipping the queue, over HTTP\n');

forget();
fs.rmSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'deploys'), { recursive: true, force: true });

const BIN = path.join(tmp, 'bin');
fs.mkdirSync(BIN, { recursive: true });

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

/** `demo` declares a deploy; `bare` is every repo that has declared nothing. */
const repos = {};
for (const name of ['demo', 'bare']) {
  const origin = path.join(tmp, `${name}.git`);
  const dir = path.join(tmp, name);
  git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
  git(tmp, 'clone', '--quiet', origin, dir);
  git(dir, 'config', 'user.email', 't@e');
  git(dir, 'config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  git(dir, 'add', 'file.txt');
  git(dir, 'commit', '--quiet', '-m', 'one');
  git(dir, 'push', '--quiet', '-u', 'origin', 'main');
  repos[name] = { dir, origin, head: git(dir, 'rev-parse', 'HEAD') };
}

const GH_STATE = path.join(tmp, 'gh-state.json');
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/usr/bin/env node
const fs = require('node:fs');
const state = JSON.parse(fs.readFileSync(${JSON.stringify(GH_STATE)}, 'utf8'));
const args = process.argv.slice(2);
const out = (s) => { process.stdout.write(s); process.exit(0); };
if (args[0] === 'auth' && args[1] === 'status') out('Logged in to github.com\\n');
if (args[0] === 'repo' && args[1] === 'view') out(JSON.stringify({ nameWithOwner: 'acme/' + require('node:path').basename(process.cwd()) }));
if (args[0] === 'pr' && args[1] === 'list') out(JSON.stringify(state[require('node:path').basename(process.cwd())] || []));
process.stderr.write('unknown gh invocation: ' + args.join(' ') + '\\n');
process.exit(1);
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const rawPR = (over = {}) => ({
  number: 1,
  url: 'https://github.com/acme/demo/pull/1',
  title: 'zz-work: something small',
  state: 'MERGED',
  isDraft: false,
  mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN',
  headRefName: 'worktree-something-work',
  baseRefName: 'main',
  additions: 4,
  deletions: 1,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: ago(60),
  mergeCommit: { oid: repos.demo.head },
  body: '',
  author: { login: 'someone' },
  createdAt: ago(180),
  updatedAt: ago(60),
  ...over,
});

fs.writeFileSync(
  GH_STATE,
  JSON.stringify({
    demo: [rawPR(), rawPR({ number: 2, title: 'zz-work: and another' })],
    bare: [rawPR({ number: 3, mergeCommit: { oid: repos.bare.head }, title: 'zz-work: the same, elsewhere' })],
  })
);

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === 'list') { process.stdout.write(JSON.stringify([{ id: 'zz-a1b' }])); process.exit(0); }
process.stdout.write('[]');
`,
  { mode: 0o755 }
);

/** Restarts nothing; leaves a file behind so "it ran" is a fact on disk. */
const DEPLOYED = path.join(tmp, 'deployed.txt');
fs.writeFileSync(
  path.join(BIN, 'writer'),
  `#!/usr/bin/env node
require('node:fs').appendFileSync(${JSON.stringify(DEPLOYED)}, 'ran\\n');
`,
  { mode: 0o755 }
);

const beadsDir = (name) => {
  const d = path.join(tmp, 'beads', name, '.beads');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

const { createApp, listen } = await import(LIB('server.js'));
const { listDeploys } = await import(LIB('deploy.js'));

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'release-token',
  actor: 'beadcause-test',
  bdBin: FAKE_BD,
  workspaces: [
    { name: 'demo', dir: beadsDir('demo') },
    { name: 'bare', dir: beadsDir('bare') },
  ],
  sessionDirs: { demo: repos.demo.dir, bare: repos.bare.dir },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
  pr: { base: 'main' },
  release: { beads: false, seconds: 3600 },
  deploys: { demo: { command: [path.join(BIN, 'writer')], dir: repos.demo.dir, pull: false, graceMs: 0, restarts: false } },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);
cfg.port = port;

const request = (method, pathname, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'content-type': 'application/json',
          ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}),
          'x-beadcause-token': cfg.token,
        },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(out || '{}') }));
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

const post = (p, body) => request('POST', p, body);
const get = (p) => request('GET', p);

const board = await get('/api/prs?refresh=1');
const cardOf = (name) => (board.json.repos || []).find((r) => r.workspace === name);

await check(() => assert.equal(board.status, 200), 'the board loads');
await check(() => assert.equal(cardOf('demo')?.release?.count, 2), 'and every card carries its own queue');
await check(() => assert.equal(board.json.counts?.ship, 3), 'and the board carries the total the tab badge reads');
await check(() => assert.match(cardOf('demo')?.release?.hint || '', /writer/), 'the queue names the command the button will run');
await check(() => assert.equal(cardOf('bare')?.release?.can, 'session'), 'a repo that declared nothing cannot batch, and says so');

const refused = await post('/api/release/ship', { workspace: 'bare' });
await check(() => assert.equal(refused.status, 409), 'and refuses to ship its queue in one press');
await check(() => assert.match(refused.json.error || '', /no deploy/), `naming the reason — "${refused.json.error}"`);
await check(() => assert.equal(fs.existsSync(DEPLOYED), false), 'nothing has been deployed yet');

const shipped = await post('/api/release/ship', { workspace: 'demo' });
await check(() => assert.equal(shipped.status, 200), 'a repo that declared one ships the whole queue');
await check(() => assert.equal(shipped.json.release?.count, 2), 'and says how many merges it carried');
await check(() => assert.match(shipped.json.deploy?.reason || '', /#1/), 'the deploy record names them, for whoever reads it later');

const second = await post('/api/release/ship', { workspace: 'demo' });
await check(() => assert.equal(second.status, 409), 'a second press while it is running is refused');

await until(() => {
  const rec = listDeploys({ limit: 10 }).find((r) => r.id === shipped.json.deploy.id);
  assert.equal(rec?.status, 'ok');
});
await check(() => assert.equal(fs.readFileSync(DEPLOYED, 'utf8').trim(), 'ran'), 'the deploy ran exactly once for the whole queue');

const after = await get('/api/prs?refresh=1');
await check(
  () => assert.equal((after.json.repos || []).find((r) => r.workspace === 'demo')?.release?.count, 0),
  'and the queue is empty afterwards — one deploy shipped both'
);
const empty = await post('/api/release/ship', { workspace: 'demo' });
await check(() => assert.equal(empty.status, 409), 'so pressing Ship again refuses rather than restarting the daemon for nothing');
await check(() => assert.match(empty.json.error || '', /already live/), `saying why — "${empty.json.error}"`);

for (const s of servers) s.close(s.front ? () => s.front.close() : undefined);
app.close?.();

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} passed\x1b[0m`}\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
