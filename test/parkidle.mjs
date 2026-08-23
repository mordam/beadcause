/**
 * The idle sweep, driven through a real advocate record — which is the only way it could
 * have caught this.
 *
 * bc-2uj4.6. `parkIdle` in lib/advocate.js filtered the open-window register with
 * `openList(opened, a.workspace)`, and an advocate record carries *both* shapes: the
 * workspace object under `workspace` and its name under `name`. lib/parked.js is keyed
 * and filtered by the name — `registerOpen` in lib/session.js writes `workspace.name`,
 * and every one of its eight callers passes the string. So the filter compared an object
 * against a string on every record, matched nothing, and the loop body had never once
 * executed on this Mac: `state.parked` was `{}` for a fortnight, the daemon log contained
 * no `parked …` line in its entire history, and two resolver records from windows that
 * had closed hours earlier were still sitting in `state.opened`.
 *
 * The reason test/parked.mjs is green over the same code is the whole point of this file:
 * it calls `openList(opened, 'beadcause')` with a hand-made string, which is the one
 * argument the daemon never passes. So this suite refuses to build a fixture — it stands
 * up `createAdvocates`, runs a real tick, and lets `record(ws)` construct the advocate the
 * way the daemon does, object in `workspace` and string in `name`. Anything that reaches
 * for the wrong field is then a failing assertion rather than an empty list.
 *
 * Four claims, and the first two are the acceptance criteria:
 *
 *   - **a quiet window is parked** — out of `opened`, into `parked` under `<name>/<bead>`,
 *     with the record's own `workspace` field readable by the console's `parkedList`;
 *   - **a window whose process is gone is dropped** from the open register on the same
 *     sweep, which is what left two dead resolvers in the live file;
 *   - **a busy window is left alone**, because the sweep must never be the thing that
 *     closes a window mid-turn;
 *   - **the key is the name**, asserted directly against `beadKey('alpha', …)`, because
 *     `${object}/${id}` is a valid string and the old code wrote `[object Object]/bc-x`
 *     happily — that is why nothing ever threw;
 *   - **and the records the bug already wrote are adopted rather than orphaned**, because
 *     correcting the key without moving them would make seven live conversations on live
 *     branches unresumable, silently, as the fix's own first act.
 *
 *     node test/parkidle.mjs
 *
 * Built on test/livequeue.mjs's harness: `open`/`prs` are injected so no iTerm and no
 * `gh` are touched, and the live sessions come from a temp `claudeSessionsDir` with this
 * process's own pid where a case needs a live one. `closeGraceSeconds` is set an hour out
 * on purpose — a parked window goes onto the closing list carrying `process.pid`, and the
 * grace is what guarantees `reapClosing` never signals the suite that is running it.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-parkidle-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { beadKey, prKey } = await import(LIB('parked.js'));
const { loadState } = await import(LIB('config.js'));

/* ------------------------------------------------------------------ fixtures */

/**
 * Session ids have to look like session ids.
 *
 * `parkable` in lib/parked.js tests them against `/^[0-9a-fA-F-]{8,64}$/`, because the
 * value ends up on a command line as the argument to `--resume`. test/livequeue.mjs's
 * `sess-<pid>` would be rejected before any of this ran, and every case here would then
 * pass for the wrong reason.
 */
const LIVE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const DEAD_ID = 'bbbbbbbb-5555-6666-7777-888888888888';

/**
 * Epoch milliseconds, which is what a session record holds — `toIso` in lib/claude.js
 * takes `Number(ms)` and answers null for anything that is not a finite positive number.
 * An ISO string there reads as "it has not said when it went quiet", and `parkDecision`
 * falls back to the register row's own `at`; every case here would then be measuring the
 * wrong clock.
 */
const minutesAgo = (m) => Date.now() - m * 60 * 1000;

/**
 * A Claude Code session record, as `~/.claude/sessions/<pid>.json`.
 *
 * `pid` is this process, which is the only pid a test can be sure is alive — lib/claude.js
 * liveness-checks every record with signal 0 before returning it, so a made-up number
 * would be filtered out before `parkIdle` ever saw it.
 */
function plant({ sessionId = LIVE_ID, status = 'idle', quietFor = 45, name = '', cwd = REPO } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({
      pid: process.pid,
      sessionId,
      name,
      cwd,
      status,
      statusUpdatedAt: minutesAgo(quietFor),
      startedAt: minutesAgo(quietFor + 60),
    })
  );
}

/** A row in the open-window register, exactly as `registerOpen` in lib/session.js writes it. */
const openRow = (sessionId, over = {}) => ({
  at: new Date(minutesAgo(90)).toISOString(),
  sessionId,
  dir: REPO,
  // The string, because that is what every caller of `registerOpen` passes: `launch` is
  // given `workspace.name` at all eight of its call sites in lib/session.js.
  workspace: 'alpha',
  bead: null,
  pr: null,
  kind: 'worker',
  title: 'a window',
  ...over,
});

/**
 * One tick, with an open register already on disk and whatever live sessions the case
 * needs — and nothing else running.
 */
async function tick({ opened = {}, parked = {}, session = null, workers = null } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case. `quiesce` + `removeTree` rather than a bare recursive
  // `rmSync`: every write of `advocates.json` schedules a common-repo commit 2000ms out
  // whose `git init` lands in CONFIG_DIR, and rmdir on a directory that gained a file
  // since it was read is ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  if (session) plant(session);

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
      // The sweep under test, and the grace that keeps it from signalling this process.
      // A parked window is pushed onto the closing list carrying its pid — which here is
      // the suite's own — and `decide` in lib/reap.js waits out `closeGraceSeconds`
      // before the first SIGTERM. An hour is a fortnight of slack past one tick.
      parkIdleWindows: true,
      closeFinishedSessions: true,
      closeGraceSeconds: 3600,
      parkIdleMinutes: 10,
      // Other features with their own suites, each of which would otherwise run real
      // git, a real `gh` or a real agent against a temp directory on every case here.
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
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ opened, parked }, null, 2));
  // The slot list, written the way a previous daemon left it — `workers` is one of the
  // three fields an advocate record adopts from `advocates.json` on boot, precisely so
  // that the windows it opened survive a restart. That adoption is the only way a case
  // here can have a worker without opening a window, and `open` throws in this suite.
  if (workers) fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers } }, null, 2));

  const advocates = createAdvocates(cfg, {
    bd: {
      ready: async () => [],
      listLabel: async () => [],
      show: async (_ws, id) => ({ id, status: 'in_progress' }),
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
  // `persist()` runs at the end of every tick, so the slot list on disk is what this tick
  // decided about it — which is where a worker row that re-bound onto the wrong window is
  // visible, and the only place it is.
  let slots = {};
  try {
    slots = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8')).alpha || {};
  } catch {
    /* a case with no workers wrote none */
  }
  return {
    state: loadState(),
    slots,
    card: advocates.snapshot().find((a) => a.workspace === 'alpha'),
  };
}

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

console.log('\nthe idle sweep, through a real advocate record\n');

/* ------------------------------------------------------------------ the cases */

/** The incident: a quiet window with an open bead, which nothing else can close. */
await check('a window quiet for longer than the grace is parked', async () => {
  const { state, card } = await tick({
    opened: { [LIVE_ID]: openRow(LIVE_ID, { bead: 'x-1', title: 'x-1 the quiet one' }) },
    session: { sessionId: LIVE_ID, status: 'idle', quietFor: 45 },
  });

  const key = beadKey('alpha', 'x-1');
  assert.equal(key, 'alpha/x-1', 'the key is built from the name, not from the workspace object');
  assert.ok(state.parked[key], `parked under ${key} — got ${JSON.stringify(Object.keys(state.parked))}`);
  assert.equal(state.parked[key].sessionId, LIVE_ID, 'and it is the conversation, which is the whole safety argument');
  assert.equal(state.parked[key].workspace, 'alpha', 'the record carries the name, so every reader can filter it');
  assert.equal(state.opened[LIVE_ID], undefined, 'and it left the open register in the same write');
  // The console's own read of the store, which was permanently empty for the same reason.
  assert.deepEqual(
    (card.parked || []).map((p) => p.key),
    [key],
    'and it shows on the card — `parkedList` is filtered by the same name'
  );
});

/** The half that had two dead resolvers stranded in the live state file for hours. */
await check('a window whose process is gone is dropped from the open register', async () => {
  const { state } = await tick({
    opened: {
      [DEAD_ID]: openRow(DEAD_ID, { pr: '342', title: 'rebase 342 alpha' }),
      [LIVE_ID]: openRow(LIVE_ID, { bead: 'x-1', title: 'x-1 the quiet one' }),
    },
    session: { sessionId: LIVE_ID, status: 'idle', quietFor: 45 },
  });

  assert.equal(state.opened[DEAD_ID], undefined, 'no live session with that id — there is nothing to park');
  assert.equal(state.parked[prKey('alpha', '342')], undefined, 'and nothing is parked for it, because nothing was there');
  // Both halves on one sweep: the drop must not be what stops the park happening.
  assert.ok(state.parked[beadKey('alpha', 'x-1')], 'the park beside it still happened');
});

/** The guard that matters most, and the cheapest one. */
await check('a window that is working is left exactly where it is', async () => {
  const { state } = await tick({
    opened: { [LIVE_ID]: openRow(LIVE_ID, { bead: 'x-2', title: 'x-2 mid-turn' }) },
    session: { sessionId: LIVE_ID, status: 'busy', quietFor: 45 },
  });

  assert.deepEqual(state.parked, {}, 'nothing parked');
  assert.ok(state.opened[LIVE_ID], 'and it keeps its place in the register');
});

/** And silence that has not lasted long enough is still silence mid-turn. */
await check('a window quiet for less than the grace is left alone', async () => {
  const { state } = await tick({
    opened: { [LIVE_ID]: openRow(LIVE_ID, { bead: 'x-3', title: 'x-3 just paused' }) },
    session: { sessionId: LIVE_ID, status: 'idle', quietFor: 2 },
  });

  assert.deepEqual(state.parked, {}, 'two minutes is a gap between turns, not an ending');
  assert.ok(state.opened[LIVE_ID], 'and it is still open, so the next sweep asks again');
});

/**
 * The other half of the fix: the parks the broken code did manage to write.
 *
 * `parkWorker` was reached all fortnight — a handed-back worker really was recorded — but
 * under `[object Object]/<bead>`, which no reader scoped to a workspace can see. Seven of
 * those were sitting in the live state file when this was written, four of them for beads
 * whose worktrees are still open.
 */
await check('a park written under the broken key is adopted, not orphaned', async () => {
  const stray = {
    at: new Date(minutesAgo(200)).toISOString(),
    sessionId: DEAD_ID,
    dir: REPO,
    // Exactly what `String(<workspace object>)` produced. Truthy, so it passed `parkable`
    // and every guard downstream; equal to no workspace name, so it matched no reader.
    workspace: '[object Object]',
    bead: 'x-9',
    kind: 'worker',
    title: 'x-9 handed back',
    waitingOn: 'it asked you a question — answering the bead brings this session back',
    resumes: 1,
  };
  const elsewhere = { ...stray, dir: '/nowhere/at/all', bead: 'z-9' };

  const { state, card } = await tick({
    parked: { '[object Object]/x-9': stray, '[object Object]/z-9': elsewhere },
  });

  const key = beadKey('alpha', 'x-9');
  assert.ok(state.parked[key], `adopted to ${key} — got ${JSON.stringify(Object.keys(state.parked))}`);
  assert.equal(state.parked[key].workspace, 'alpha', 'and the record says so, so `parkedList` can find it');
  assert.equal(state.parked[key].sessionId, DEAD_ID, 'it is the same conversation — that is the whole point');
  assert.equal(state.parked[key].resumes, 1, 'and its trip count survives, because it is a fact about the loop');
  assert.equal(state.parked['[object Object]/x-9'], undefined, 'the broken key is gone, not duplicated');
  assert.deepEqual(
    (card.parked || []).map((p) => p.key),
    [key],
    'and the console can draw it, which it never could before'
  );

  // The narrowness that makes it safe: a record whose directory belongs to no workspace
  // this advocate owns is somebody else's to place, or nobody's, and is left where it is.
  assert.ok(state.parked['[object Object]/z-9'], 'a record that cannot be placed is left alone to age out');
});

/* ------------------------------------------- bc-2uj4.5.4: the two unbounded waits */

/** A worker row as `closingFor` and `parkIdle` read one, with the id its launch minted. */
const workerRow = (over = {}) => ({
  id: 'x-7',
  title: 'x-7 the delivered one',
  // Recent, so `workerTimeoutMinutes` is nowhere near — the whole point of these cases is
  // what happens in the two hours *before* that clock is the thing that frees the window.
  at: new Date(minutesAgo(30)).toISOString(),
  sessionId: LIVE_ID,
  pid: process.pid,
  claimed: true,
  ...over,
});

/**
 * The yield is right for the first few minutes: `reconcile` can say "delivered as a pull
 * request" where this sweep can only say "it went quiet".
 */
await check('a worker window quiet for less than the worker grace is left to reconcile', async () => {
  const { state } = await tick({
    opened: { [LIVE_ID]: openRow(LIVE_ID, { bead: 'x-7', title: 'x-7 the delivered one' }) },
    session: { sessionId: LIVE_ID, status: 'idle', quietFor: 12 },
    workers: [workerRow()],
  });

  assert.deepEqual(state.parked, {}, 'twelve minutes is still reconcile’s to name');
  assert.ok(state.opened[LIVE_ID], 'and the window keeps its place in the register');
});

/**
 * And then it stops yielding. The incident: `bc-zjab.12` went idle at 15:08Z with
 * `** BEAD WORK DONE ** CAN BE CLOSED **` on screen and was parked at 16:05Z — 58 minutes
 * — because `reconcile` could not classify its ending and has no clock shorter than
 * `workerTimeoutMinutes`, which is two hours. `timeout` is not in `REAPABLE`, so even that
 * ending closes nothing; the window came back to this sweep anyway, two hours late.
 */
await check('a worker window quiet past the worker grace is parked anyway', async () => {
  const { state } = await tick({
    opened: { [LIVE_ID]: openRow(LIVE_ID, { bead: 'x-7', title: 'x-7 the delivered one' }) },
    session: { sessionId: LIVE_ID, status: 'idle', quietFor: 45 },
    workers: [workerRow()],
  });

  const key = beadKey('alpha', 'x-7');
  assert.ok(state.parked[key], `parked under ${key} — got ${JSON.stringify(Object.keys(state.parked))}`);
  assert.equal(state.parked[key].sessionId, LIVE_ID, 'and by id, so the conversation can be brought back');
  assert.equal(state.opened[LIVE_ID], undefined, 'and it left the open register in the same write');
});

/**
 * The re-bind, which is the other half of the same pile.
 *
 * `reconcile` used to find a worker's window with `sessions.find((s) => namesBead(s.name,
 * w.id))` and then overwrite `w.pid` and `w.sessionId` from it. A name is a string the
 * *session* writes about itself, and a reviewer, a resolver and an Epic Advocate all quote
 * the bead they are about. Measured on this Mac: the worker row for `bc-zjab.12` carried
 * the pid and session id of `beadcause - review PR 617 (bc-zjab.12)`. The review window is
 * then a window the advocate holds a slot for, so this sweep steps over it and nothing
 * closes it — and when the bead closes, `closingFor` aims a SIGTERM at a review that is
 * halfway through, with guard 2 in lib/reap.js comparing the reviewer against itself.
 *
 * Here the live window is the reviewer and the worker's own session is gone. The slot list
 * on disk is where the re-bind is visible, so that is what is asserted: the row must still
 * address the conversation its launch minted, and must carry no pid at all, because the
 * window it addresses has closed.
 */
await check('a window that only quotes the worker’s bead in its title is not adopted as the worker', async () => {
  const REVIEWER = 'cccccccc-9999-aaaa-bbbb-cccccccccccc';
  const { state, slots } = await tick({
    opened: { [REVIEWER]: openRow(REVIEWER, { pr: '617', kind: 'review-advocate', title: 'review 617 alpha' }) },
    session: { sessionId: REVIEWER, status: 'idle', quietFor: 45, name: 'alpha - review PR 617 (x-7)' },
    // The worker's own session id, and no session record carrying it — its window closed.
    workers: [workerRow({ sessionId: DEAD_ID, pid: null })],
  });

  const row = (slots.workers || []).find((w) => w.id === 'x-7');
  assert.ok(row, 'the worker is still on the slot list — nothing here should finish it');
  assert.equal(row.sessionId, DEAD_ID, 'and it still addresses the conversation its launch minted');
  assert.ok(!row.pid, `and carries no pid, because its window is gone — got ${row.pid}`);

  // Which is what leaves the reviewer's window closable at all: a window the advocate
  // holds a slot for is one this sweep defers to.
  const key = prKey('alpha', '617');
  assert.ok(state.parked[key], `the reviewer is parked under ${key} — got ${JSON.stringify(Object.keys(state.parked))}`);
  assert.equal(state.parked[key].sessionId, REVIEWER, 'and it is the reviewer’s conversation, not the worker’s');
});

/* --------------------------------------------------------------------- teardown */

await quiesce();
await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
