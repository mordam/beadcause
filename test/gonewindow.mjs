/**
 * The window that disappeared — and the conversation that comes back into the next one.
 *
 * A worker window is closed by hand, or killed, or lost with its terminal. Before
 * bc-y7l2m nothing on this Mac noticed: the slot was held until `workerTimeoutMinutes`
 * — two hours — and then the bead was charged an attempt, its claim was forced off, and
 * the next window was briefed from scratch. Everything that agent had read and worked out
 * was sitting in a transcript on disk the whole time, and nothing ever opened it. Measured
 * on 2026-08-24: `bc-19vt` and `bc-dgx7.44` both stopped writing at 10:47 ADT and were
 * finished as `timeout` at 12:22 and 11:55, four hours of context thrown away between
 * them.
 *
 * The fix rests on one distinction, and this suite exists to hold it still: **a window
 * that is gone is not a window that is quiet.** `silent`, `timeout` and `lapsed` are all
 * read off a window still sitting on the screen, so the agent behind them may be wedged
 * mid-turn and resuming it would resume the wedge. A window whose live-session row is
 * *absent* stopped answering for a reason that says nothing about the agent at all.
 *
 * What is claimed here:
 *
 *   - **a vanished window is finished as `gone` within `goneMinutes`**, not at the
 *     two-hour timeout — the slot comes back and the claim goes back to the queue;
 *   - **the first disappearance costs the bead no attempt**, for `silent`'s reason made
 *     stronger: a window going away is evidence about the window, and `maxAttemptsPerBead`
 *     is 2, so charging Adam's closed terminals would retire beads for nothing;
 *   - **the conversation is parked with its ending**, and the sentence beside it does not
 *     claim anybody is waiting on anything;
 *   - **the same tick brings it back**, into the parked directory, on the parked session
 *     id, wearing `interruptedPrompt` — which says nothing was answered — and never
 *     `resumePrompt`, which says Adam answered;
 *   - **the trip count survives the round trip**, so the *second* disappearance is charged,
 *     is not parked, and falls through to the fresh brief;
 *   - **one tick of absence is not evidence.** The clock only starts, and a window seen
 *     again clears it;
 *   - **three things are never called gone**: a window that is merely quiet, a worker with
 *     no session id (matched by name, so `mine` is null for it nearly always), and every
 *     window on a Mac whose session list came back empty — a reader that failed is not
 *     forty agents dying at once;
 *   - **and it can be switched off**, back to exactly the two-hour timeout.
 *
 * The other sensor for the same fact — **Reclaim sessions** asking iTerm about a window by
 * id and being told it addresses nothing — reaches the same ending without waiting out any
 * clock, and is checked in test/reclaim.mjs beside the rest of that button.
 *
 *     node test/gonewindow.mjs
 *
 * Built like test/neverstarted.mjs — a small mutable tracker rather than canned answers,
 * because half of what is under test is that a write in `reconcile` changes what the survey
 * a few lines later reads. `open` is injected, so a tick that would have opened an iTerm
 * window pushes an object onto an array instead. No iTerm, no `bd`, no agent, no window.
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
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-gonewindow-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const PROJECTS = path.join(tmp, 'claude-projects');
const REPO = path.join(tmp, 'projects', 'alpha');
for (const d of [SESSIONS, PROJECTS, REPO]) fs.mkdirSync(d, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { slugFor } = await import(LIB('transcript.js'));
const { beadKey } = await import(LIB('parked.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
/** Uuid-shaped, because both `parkable` and `transcriptFile` refuse anything else. */
const GONE_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const NEXT_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const minutesAgo = (n) => new Date(Date.now() - n * 60_000).toISOString();

const bead = (id, over = {}) => ({
  id,
  title: id,
  priority: 2,
  issue_type: 'task',
  status: 'open',
  labels: [],
  created_at: OLD,
  ...over,
});

/**
 * A Claude Code session record, as `~/.claude/sessions/<pid>.json`.
 *
 * This process's pid is the only number a test can be sure is alive — `liveSessions`
 * filters on a signal-0 check, so a made-up one never reaches the code under test, which
 * would make every case here pass for the wrong reason.
 */
function plant({ sessionId = GONE_ID, status = 'busy', name = '' } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId, name, cwd: REPO, status, startedAt: Date.now() })
  );
}

/** The transcript `prepareResume` looks for. Without one it refuses, and rightly: a
 * cleared transcript resumes into an empty conversation that reports success. */
function transcript(sessionId, dir = REPO) {
  const at = path.join(PROJECTS, slugFor(dir));
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, `${sessionId}.jsonl`), '{"type":"user"}\n');
}

/**
 * A worker record as advocates.json holds one, carrying the session id and directory a
 * park needs.
 *
 * **`at` is deliberately recent.** Every case here is about the ending that fires *before*
 * `workerTimeoutMinutes`, so a fixture old enough to have timed out would be answered by
 * the two-hour branch in every case where the new one correctly declines — and the suite
 * would then be asserting the old behaviour while appearing to assert the new.
 */
const worker = (id, over = {}) => ({
  id,
  title: id,
  at: minutesAgo(5),
  attempt: 1,
  sessionId: GONE_ID,
  dir: REPO,
  claimed: true,
  ...over,
});

/** An advocate over a tracker that can be written to and read back within the same tick. */
async function arena({
  beads = [],
  workers = [],
  attempts = {},
  session = null,
  parked = {},
  overrides = {},
  dispatch = true,
} = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  if (session) plant(session);
  if (workers.length || Object.keys(attempts).length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts } }));
  }
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify({ opened: {}, parked }, null, 2));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    claudeProjectsDir: PROJECTS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 5,
      maxWorkersLimit: 5,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // The clock under test. Three minutes is the default; the cases that want the
      // ending to fire hand `goneSince` a stamp older than that rather than sleeping.
      goneMinutes: 3,
      parkIdleWindows: true,
      // Off, or the park sweep would try to signal this process's own pid.
      closeFinishedSessions: false,
      // Features with their own suites, each of which would otherwise run real git, a real
      // `gh` or a real agent against a temp directory on every case here. `sessionLog`
      // being off is also what keeps `archiveFinished` from reaching for git.
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

  const world = new Map(beads.map((b) => [b.id, { ...b }]));
  const opened = [];
  const reopened = [];
  const events = [];
  const bd = {
    // What `bd ready` is: open, unclaimed, not closed. The claim is exactly what takes a
    // bead out of it — so a hand-back inside this tick is visible to the survey after it.
    // `dispatch: false` is how a case looks at the park record itself. The resume happens
    // at the dispatch seam and *drops* the record as it goes — correctly, since a record
    // left behind is a conversation two dispatches would both try to resume — so a tick
    // that reopens the window leaves nothing on disk to assert about.
    ready: async () => (dispatch ? [...world.values()].filter((b) => b.status === 'open') : []),
    listLabel: async () => [],
    listStatus: async () => [],
    show: async (_ws, id) => world.get(id) || null,
    children: async (_ws, id) => [...world.values()].filter((b) => b.id.startsWith(`${id}.`)),
    comments: async () => [],
    create: async () => 'new-1',
    addLabel: async () => {},
    heartbeat: async () => {},
    reopenAbandoned: async (_ws, id) => {
      reopened.push(id);
      const row = world.get(id);
      if (row) row.status = 'open';
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit: (e) => events.push(e) },
    open: async (_cfg, _ws, b, opts = {}) => {
      opened.push({ id: b.id, resume: opts.resume || null });
      return { dir: REPO, mode: 'test', term: null, sessionId: NEXT_ID };
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

  const readState = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
    } catch {
      return { opened: {}, parked: {} };
    }
  };
  const readSlots = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8')).alpha || {};
    } catch {
      return {};
    }
  };

  return {
    opened,
    reopened,
    events,
    world,
    readState,
    readSlots,
    tick: () => advocates.tick(),
    outcomes: (id) => events.filter((e) => e.id === id).map((e) => e.action),
    detail: (id, action) => (events.find((e) => e.id === id && e.action === action) || {}).detail || '',
  };
}

/** One tick, for the cases that only need one. */
async function tick(spec) {
  const a = await arena(spec);
  await a.tick();
  return a;
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

/* ------------------------------------------------------- the ending, and its cost */

await check('a window that is gone is finished as `gone`, not held to the two-hour timeout', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    // Some *other* session is alive, which is what proves the reader works. Without one,
    // `sessions.length` is zero and the belt below refuses to conclude anything.
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  assert.ok(a.outcomes('x-1').includes('gone'), `expected a gone ending — got ${a.outcomes('x-1').join(', ')}`);
  assert.ok(!a.outcomes('x-1').includes('timeout'), 'and not the ending it used to get two hours later');
  assert.match(a.detail('x-1', 'gone'), /its window is gone after \d+m/, 'the sentence says what happened');
  // Not "the list is empty": the same tick opens the resumed window, which takes a slot of
  // its own. What came back is the slot the *vanished* window was holding.
  assert.ok(
    !(a.readSlots().workers || []).some((w) => w.sessionId === GONE_ID),
    'the slot the gone window held came back'
  );
  assert.deepEqual(a.reopened, ['x-1'], 'and the claim went back to the queue');
});

await check('and the first disappearance costs the bead nothing', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  // `maxAttemptsPerBead` is 2 and nothing decrements it. A bead charged for a terminal
  // Adam closed would be two closed terminals away from being retired for good.
  assert.equal((a.readSlots().attempts || {})['x-1'], undefined, 'no attempt charged');
  assert.match(a.detail('x-1', 'gone'), /no attempt charged/, 'and the console says so');
});

await check('an earlier real failure is still remembered — "no attempt" is not charged, not wiped', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    attempts: { 'x-1': 1 },
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  assert.equal((a.readSlots().attempts || {})['x-1'], 1, 'the count it arrived with, unchanged');
});

/* ------------------------------------------------------------------- the park */

await check('the conversation is parked, with the ending that put it there', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
    dispatch: false,
  });
  const rec = a.readState().parked['alpha/x-1'];
  assert.ok(rec, `expected a park under alpha/x-1 — got ${JSON.stringify(Object.keys(a.readState().parked))}`);
  assert.equal(rec.sessionId, GONE_ID, 'it is the conversation, which is the whole point');
  assert.equal(rec.dir, REPO, 'and the tree it was standing in, which `--resume` alone would not give it');
  assert.equal(rec.ending, 'gone', 'so the resume knows which turn to write');
});

await check('and the sentence beside it does not claim anybody is waiting on anything', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
    dispatch: false,
  });
  // This row draws on the same console list as the handed-back ones. A line reading like a
  // question would send Adam looking for one that was never asked.
  const said = a.readState().parked['alpha/x-1'].waitingOn;
  assert.match(said, /disappeared/, said);
  assert.doesNotMatch(said, /asked you|waiting on you/, said);
});

/* ---------------------------------------------------------------- the resume */

await check('the same tick brings it back — same conversation, same tree', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  const back = a.opened.find((o) => o.id === 'x-1');
  assert.ok(back, `the bead was dispatched again — got ${JSON.stringify(a.opened)}`);
  assert.ok(back.resume, 'and as a resume rather than a fresh brief');
  assert.equal(back.resume.rec.sessionId, GONE_ID);
  assert.equal(back.resume.rec.dir, REPO);
  assert.ok(a.outcomes('x-1').includes('resumed-session'), 'said out loud, because a fresh session that reads as a resume is the failure to avoid');
});

await check('and it is told nothing was answered — never that Adam answered', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  const said = a.opened.find((o) => o.id === 'x-1').resume.prompt;
  assert.match(said, /Your window disappeared/, said.slice(0, 120));
  assert.match(said, /Nothing was answered/i, 'the fact the whole turn turns on');
  assert.doesNotMatch(said, /answered\.\*\*/, 'and not the turn that delivers an answer');
  // The claim was forced off by `handBack` a few lines earlier and nothing puts it back —
  // the "claim it first" line lives in the fresh brief this agent is deliberately not sent.
  assert.match(said, /--claim/, 'so the turn has to ask for it');
  assert.match(said, /Do not start over/, 'the whole reason resuming beats re-briefing');
});

/**
 * bc-xl7n.147. `gone` is not the only ending that reaches this branch — `parkIdle`
 * (lib/advocate.js) writes `idle` for exactly the same reason: nobody answered, nobody
 * decided anything. Before this fix its record carried no `ending` at all, which
 * `resumeFor` read as "not gone" and handed the resumed agent `resumePrompt` — **Adam
 * answered** — quoting an answer that was never given. Seeded directly into `parked`
 * rather than produced by a real idle sweep: that mechanism is test/parkidle.mjs's, this
 * is about what the *dispatch* does with the record once it exists.
 */
await check('an idle park is told nothing was answered — never that Adam answered', async () => {
  transcript(GONE_ID);
  const key = beadKey('alpha', 'x-1');
  const a = await tick({
    beads: [bead('x-1', { status: 'open' })],
    parked: {
      [key]: {
        at: minutesAgo(20),
        sessionId: GONE_ID,
        dir: REPO,
        workspace: 'alpha',
        bead: 'x-1',
        kind: 'worker',
        title: 'x-1',
        waitingOn: 'it went quiet — nothing has come back to it',
        ending: 'idle',
        resumes: 0,
      },
    },
  });
  const back = a.opened.find((o) => o.id === 'x-1');
  assert.ok(back, `the bead was dispatched — got ${JSON.stringify(a.opened)}`);
  assert.ok(back.resume, 'and as a resume, not a fresh brief');
  const said = back.resume.prompt;
  assert.match(said, /went quiet/i, said.slice(0, 120));
  assert.match(said, /Nothing was answered/i, 'the fact the whole turn turns on');
  assert.doesNotMatch(said, /Adam answered/, 'the exact failure bc-xl7n.147 is about');
  assert.doesNotMatch(
    said,
    /Your window disappeared/,
    'that sentence is true only of `gone` — this window was closed on purpose, not lost'
  );
  assert.match(said, /--claim/, 'the claim was forced off the same as `gone`, so the turn asks for it back');
});

await check('a park with no transcript behind it opens fresh, and says so', async () => {
  // No `transcript()` call: the one failure mode that is otherwise invisible, because
  // `--resume` on a cleared id comes up empty and reports success.
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9), sessionId: NEXT_ID })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  const back = a.opened.find((o) => o.id === 'x-1');
  assert.ok(back, 'the bead is still dispatched');
  assert.equal(back.resume, null, 'just not as a resume');
});

/* ------------------------------------------------------------- and not forever */

await check('the trip count survives into the next window', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  const row = (a.readSlots().workers || []).find((w) => w.id === 'x-1');
  assert.ok(row, 'the resumed window took a slot');
  assert.equal(row.resumes, 1, 'carrying the trip, because the record it came from was dropped');
});

await check('a conversation whose resumed window also disappears is not brought back again', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    // The state the case above leaves behind: one trip already made.
    workers: [worker('x-1', { goneSince: minutesAgo(9), resumes: 1 })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  assert.ok(a.outcomes('x-1').includes('gone'), 'it still ends as gone');
  assert.equal(a.readState().parked['alpha/x-1'], undefined, 'but nothing is parked, so nothing resumes');
  assert.equal((a.readSlots().attempts || {})['x-1'], 1, 'and this one is charged — it is no longer an accident being repaired');
  const back = a.opened.find((o) => o.id === 'x-1');
  assert.ok(back && !back.resume, 'the next window gets the fresh brief the attempt counter was always arranging');
});

await check('maxResumes 0 is the off switch for carrying conversations over at all', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
    overrides: { maxResumes: 0 },
  });
  assert.ok(a.outcomes('x-1').includes('gone'), 'the ending is unaffected — only the carry-over is');
  assert.equal(a.readState().parked['alpha/x-1'], undefined, 'nothing parked');
});

await check('a planner is not parked — the set of children it was planning has moved', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9), planning: true })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
    dispatch: false,
  });
  // `launch` refuses to resume a planner outright, so a record here would be one the
  // console lists as a conversation waiting to come back that nothing will ever open.
  assert.ok(a.outcomes('x-1').includes('gone'), 'the ending is the same');
  assert.equal(a.readState().parked['alpha/x-1'], undefined, 'the park is not');
});

/* --------------------------------------------------- what is never called gone */

await check('one tick of absence only starts the clock', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    // No `goneSince`: this tick is the first that cannot see the window.
    workers: [worker('x-1')],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
  });
  assert.ok(!a.outcomes('x-1').includes('gone'), 'a list being rewritten can be read a moment short');
  const row = (a.readSlots().workers || []).find((w) => w.id === 'x-1');
  assert.ok(row, 'the slot is held');
  assert.ok(row.goneSince, 'and the first sighting is stamped, so the next ticks can add up');
});

await check('a window seen again clears the clock', async () => {
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    // The window is right there, and busy.
    session: { sessionId: GONE_ID, status: 'busy' },
  });
  assert.ok(!a.outcomes('x-1').includes('gone'), 'it is not gone, whatever the stale stamp said');
  const row = (a.readSlots().workers || []).find((w) => w.id === 'x-1');
  assert.equal(row.goneSince, null, 'and the clock is reset, so a later absence starts from then');
});

await check('a window that is merely quiet is left to the endings that were always its own', async () => {
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: { sessionId: GONE_ID, status: 'idle' },
  });
  // The distinction the whole feature rests on: this agent may be wedged mid-turn, and
  // resuming a wedge reproduces it. `silent` and `timeout` are still the right answers.
  assert.ok(!a.outcomes('x-1').includes('gone'), 'idle is not absent');
  assert.equal(a.readState().parked['alpha/x-1'], undefined, 'and nothing of it is carried over');
});

await check('a worker with no session id is never called gone — it is matched by name', async () => {
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    // Adopted from a daemon that predates minted ids. `mine` is null for it whenever the
    // window has renamed itself, which is nearly always: a rule reading absence off that
    // would kill every adopted window on the Mac.
    workers: [worker('x-1', { sessionId: null, goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy', name: 'alpha - x-1 a window' },
  });
  assert.ok(!a.outcomes('x-1').includes('gone'), `got ${a.outcomes('x-1').join(', ')}`);
});

await check('an empty session list is a reader that failed, not a Mac where everything died', async () => {
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { goneSince: minutesAgo(9) })],
    session: null,
  });
  assert.ok(!a.outcomes('x-1').includes('gone'), 'no rows at all proves nothing about any one window');
});

await check('and the whole thing switches off, back to the two-hour timeout', async () => {
  transcript(GONE_ID);
  const a = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    // `at` old enough for the two-hour branch, because that is the branch this case is
    // about: with the new one off, the ending has to be the one that was there before.
    workers: [worker('x-1', { at: OLD, goneSince: minutesAgo(9) })],
    session: { sessionId: 'cccccccc-1111-2222-3333-444444444444', status: 'busy' },
    overrides: { goneMinutes: 0 },
  });
  assert.ok(!a.outcomes('x-1').includes('gone'), 'no gone ending');
  assert.ok(a.outcomes('x-1').includes('timeout'), 'the ending it had before this existed');
  assert.equal(a.readState().parked['alpha/x-1'], undefined, 'and no park, because timeout never parked');
});

/* ------------------------------------------------------------------------- end */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
