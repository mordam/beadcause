#!/usr/bin/env node
/**
 * A worker that delivered is *recognised* as having delivered — bc-2uj4.5.4.
 *
 *     npm test
 *     node test/deliveredslot.mjs
 *
 * `delivered` is the ending that frees a worker's slot and puts its window on the closing
 * list. `reconcile` in lib/advocate.js reaches it through `deliveryFor`, and `deliveryFor`
 * asked one question: is there an open bead labelled **`pr-delivery`** about this work.
 *
 * That was the whole answer while a worker's delivery *was* a card in the inbox. Since
 * bc-r941 it is not. A worker files a **merge-bead** — `merge-queue`, one per pull request,
 * a blocker on the work bead by construction — and stops. A `pr-delivery` card is raised
 * later, and only on the failure path, when lib/mergeadvocate.js has tried three times and
 * the merge has become Adam's. So on any workspace whose workers take the merge-queue
 * route, asking for `pr-delivery` alone asks whether the merge *failed*, and a delivery
 * that is going perfectly well answers no.
 *
 * What that cost is not about labels. A worker that had done everything right fell through
 * every ending in `reconcile` to `workerTimeoutMinutes` — **two hours** — holding a slot
 * against `maxWorkers` and holding its window on the screen, with
 * `** BEAD WORK DONE ** CAN BE CLOSED **` sitting in it the whole time. That is most of the
 * pile of windows this bead was filed about. Measured on this Mac on 2026-08-23: 204
 * `releasing the slot` lines in the daemon log, and every `delivered as a pull request`
 * line in its entire history belonging to a workspace still on the older route. bc-zjab.12
 * filed its merge-bead at 15:07:20Z and was still on the slot list, in its window, an hour
 * later.
 *
 * Three claims, driven through a real advocate tick rather than a fixture, because
 * `deliveryFor` is a closure inside `createAdvocates` and the bug is in which question it
 * asks of a real `bd`:
 *
 *   - **a merge-bead ends the worker** — the slot is freed with `delivered`, and the
 *     window goes onto the closing list where lib/reap.js can signal it;
 *   - **a `pr-delivery` card still does**, because the failure path is not going away and
 *     a fix that traded one label for the other would be the same bug pointing the other
 *     way;
 *   - **a merge-bead about *another* bead does not**, which is the guard: the match is
 *     `openMergeBeadFor`'s, on the bead named inside the block, never on the label alone.
 *
 * Each of the first two also reads the sentence on the **parked row**, because the two
 * routes end differently and the row is where Adam sees which. A merge-bead is the queue's
 * to merge and nothing is waiting on him; a `pr-delivery` card is a tap he owes. Saying
 * "waiting on you" about the first would send him looking for a button that is not there —
 * and that sentence was right for as long as `delivered` meant only one thing.
 *
 * `closeGraceSeconds` is set an hour out on purpose. A closing entry carries this
 * process's own pid — the only pid a test can be sure is alive — and the grace is what
 * guarantees `reapClosing` never signals the suite that is running it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own state.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-deliveredslot-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { deliveryBlock, DELIVERY_LABEL } = await import(LIB('delivery.js'));
const { MERGE_LABEL } = await import(LIB('mergebead.js'));
const { beadKey } = await import(LIB('parked.js'));
const { loadState } = await import(LIB('config.js'));

/* ------------------------------------------------------------------ fixtures */

const LIVE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const minutesAgo = (m) => Date.now() - m * 60 * 1000;

/**
 * A bead carrying a delivery block, as both `bin/deliver.js` and lib/mergeadvocate.js
 * write one. The block is what `parseDelivery` reads and is the only thing that says which
 * work this is about — the label says which *kind* of bead it is, and nothing more.
 */
const carded = (id, label, bead, over = {}) => ({
  id,
  title: `Merge #42 — ${bead}`,
  status: 'open',
  labels: [label],
  description: deliveryBlock({
    workspace: 'alpha',
    bead,
    repo: 'mordam/alpha',
    number: 42,
    url: 'https://github.com/mordam/alpha/pull/42',
    branch: 'worktree-x-7',
    base: 'main',
    method: 'merge',
  }),
  ...over,
});

/** A Claude Code session record, as `~/.claude/sessions/<pid>.json`. This process's pid,
 *  because lib/claude.js liveness-checks every record before returning it. */
function plant({ status = 'idle', quietFor = 5 } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId: LIVE_ID,
      name: 'alpha - x-7 the delivered one',
      cwd: REPO,
      status,
      statusUpdatedAt: minutesAgo(quietFor),
      startedAt: minutesAgo(quietFor + 30),
    })
  );
}

/** The slot list, written the way a previous daemon left it — which is the only way a case
 *  here can have a worker without opening a window, and `open` throws in this suite. */
const workerRow = () => ({
  id: 'x-7',
  title: 'x-7 the delivered one',
  // Well inside `workerTimeoutMinutes`, or every case here would pass on the clock the
  // fix exists to stop mattering.
  at: new Date(minutesAgo(15)).toISOString(),
  sessionId: LIVE_ID,
  // Both required by `parkWorker`: the id addresses the conversation and the directory is
  // what `--resume` is run *in*, which is the branch and the uncommitted edits the
  // transcript cannot carry. A row missing either is one it declines to park.
  dir: REPO,
  pid: process.pid,
  claimed: false,
});

/** One tick, with a slot list and whatever the tracker is holding. */
async function tick({ rows = [] } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // CONFIG_DIR, and rmdir on a directory that gained a file since it was read is ENOTEMPTY.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  plant();

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      closeFinishedSessions: true,
      // An hour of slack past one tick, so nothing here signals the suite's own pid.
      closeGraceSeconds: 3600,
      // On, because it is also the switch on `parkWorker` — the half that writes the
      // parked row whose sentence these cases read. The idle sweep beside it cannot reach
      // this window and so cannot be a second route to the same closing list: it needs
      // `parkIdleMinutes` of silence and every case here plants five.
      parkIdleWindows: true,
      parkIdleMinutes: 10,
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers: [workerRow()] } }, null, 2));

  const advocates = createAdvocates(cfg, {
    bd: {
      ready: async () => [],
      // The work bead as a delivered one actually reads: still open, and `blocked` by the
      // merge-bead that is the whole reason a worker may not close its own work.
      show: async (_ws, id) => ({ id, status: 'blocked', labels: [] }),
      listLabel: async (_ws, label) => rows.filter((r) => (r.labels || []).includes(label)),
      children: async () => [],
      listStatus: async () => [],
      graph: async () => ({ beads: new Map() }),
    },
    bus: { emit() {} },
    open: async () => {
      throw new Error('nothing in this suite should open a window');
    },
    openPlan: async () => {
      throw new Error('nothing in this suite should open a planner');
    },
    openAdvocate: async () => {
      throw new Error('nothing in this suite should open a P0 advocate');
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    terminals: () => [],
  });
  await advocates.tick();
  return {
    card: advocates.snapshot().find((a) => a.workspace === 'alpha'),
    parked: loadState().parked || {},
  };
}

/** What the parked row for x-7 says it is waiting for — the sentence Adam reads. */
const sentenceOf = (parked) => parked[beadKey('alpha', 'x-7')]?.waitingOn || '';

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

console.log('\na worker that delivered is recognised as having delivered\n');

/* ------------------------------------------------------------------ the cases */

/** The incident. The route every beadcause worker takes, and the one nothing was reading. */
await check('an open merge-bead ends the worker and hands its window to the reaper', async () => {
  const { card, parked } = await tick({ rows: [carded('m-1', MERGE_LABEL, 'x-7')] });

  assert.deepEqual(
    card.workers.map((w) => w.id),
    [],
    'the slot is free — a delivered worker is not one still working'
  );
  assert.deepEqual(
    (card.closing || []).map((c) => c.id),
    ['x-7'],
    'and its window is on the closing list, which is the only route by which it ever closes'
  );
  // And the row says the true thing. The queue's route is not waiting on Adam — the
  // merge-bead is a blocker the queue clears by merging — so the older sentence would send
  // him looking for a tap that is not there.
  assert.match(
    sentenceOf(parked),
    /on the merge queue/,
    `the parked row names the queue — got ${JSON.stringify(sentenceOf(parked))}`
  );
});

/** The older route, which is the failure path and is not going away. */
await check('a pr-delivery card still ends the worker', async () => {
  const { card, parked } = await tick({ rows: [carded('d-1', DELIVERY_LABEL, 'x-7')] });

  assert.deepEqual(card.workers.map((w) => w.id), [], 'the slot is free');
  assert.deepEqual((card.closing || []).map((c) => c.id), ['x-7'], 'and the window is closable');
  assert.match(
    sentenceOf(parked),
    /waiting on you/,
    `a card really is a tap Adam owes — got ${JSON.stringify(sentenceOf(parked))}`
  );
});

/** The guard: the label says what kind of bead this is, never which work it is about. */
await check('a merge-bead about another bead leaves this worker exactly where it is', async () => {
  const { card } = await tick({ rows: [carded('m-2', MERGE_LABEL, 'x-9')] });

  assert.deepEqual(
    card.workers.map((w) => w.id),
    ['x-7'],
    'somebody else’s merge is not this worker’s ending'
  );
  assert.deepEqual((card.closing || []).map((c) => c.id), [], 'and nothing is queued to be signalled');
});

/* --------------------------------------------------------------------- teardown */

await quiesce();
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
