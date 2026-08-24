/**
 * The window that opened and never ran its command.
 *
 * A dispatch types `source '<file>'` into a shell that is still running `~/.zshrc`, and
 * anything in there that reads the terminal reads those bytes instead — oh-my-zsh's
 * upgrade prompt ate the `s` and the window submitted `ource '<file>'`. That is
 * bc-xl7n.113.1. This suite is the other half, bc-xl7n.113.2: **nothing noticed.** The
 * window is alive, at a zsh prompt, with the bead's name on its tab, so the bead held a
 * worker slot for `workerTimeoutMinutes`, was then charged an attempt for a session that
 * never existed, and two of those retire a bead from the queue for good. 55 windows in
 * eighteen hours, at the point it was measured.
 *
 * The evidence is the launch's own three temp files, because `sessionCommand` removes the
 * prompt file *before* `claude` starts and the command file *after* it exits. Two files,
 * four states, one of them exact — `launchProgress` in lib/session.js.
 *
 * What is claimed here:
 *
 *   - **the four states**, read straight off a directory, including the one that must
 *     answer `unknown` rather than guess;
 *   - **a never-started window is finished within the grace**, not at the two-hour
 *     timeout: the slot comes back, the three files are cleaned up, and the bead is back
 *     out to a window on the same tick;
 *   - **and it costs no attempt** — the case that makes this worth more than tidy-up.
 *     `maxAttemptsPerBead` is 2 and nothing decrements it, so two launches lost to a
 *     shell prompt could retire a bead permanently. Here the bead is still being
 *     dispatched after three of them;
 *   - **an earlier real failure is still remembered**, because "no attempt" is *not
 *     charged* rather than *counter wiped*;
 *   - **the claim comes back** when there was one, and stays put when a live busy window
 *     says the claim is true;
 *   - **a running session, a finished one, and one inside the grace are all left alone**,
 *     as is a worker adopted from a daemon that predates the probe;
 *   - **delivered and handed-back sessions are unaffected**, which is the DO-NOT on the
 *     bead: both consumed their prompt file at line 2, an hour before they got there, so
 *     the probe separates them without knowing they exist;
 *   - **and the probe can be switched off**, back to exactly the behaviour above.
 *
 *     node test/neverstarted.mjs
 *
 * Built like test/handback.mjs, and for the same reason: the tracker is a small mutable
 * world rather than canned answers, because half the point is that a write in `reconcile`
 * changes what the survey a few lines later reads. `open` is injected, so a tick that
 * would have opened an iTerm window mints the same three temp files a real launch does and
 * pushes an id onto an array instead. No iTerm, no `bd`, no agent, no window.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-neverstarted-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
// Where the fixture's launches put their three files. Not `os.tmpdir()`: the real ones go
// there, this laptop has 82 of them lying around, and a suite that swept a directory it
// shares with a live daemon would be deleting another window's brief.
const TMPFILES = path.join(tmp, 'launch');
for (const d of [SESSIONS, REPO, TMPFILES]) fs.mkdirSync(d, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { discardLaunchFiles, launchProgress } = await import(LIB('session.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const now = () => new Date().toISOString();
const secondsAgo = (n) => new Date(Date.now() - n * 1000).toISOString();

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

/** A Claude Code session record, as `~/.claude/sessions/<pid>.json`. This process's pid is
 * the only number a test can be sure is alive — liveness is a signal-0 check, so a made-up
 * one is filtered out before anything under test sees it. */
function plant(name, status = 'busy') {
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'sess-1', name, cwd: REPO, status, startedAt: Date.now() })
  );
}

/**
 * The three files a launch mints, in whichever of the four states this case is about.
 *
 * `stamp` rather than a counter, because the paths go on the worker record and two cases
 * in one process must not be handed the same ones.
 */
let minted = 0;
function mint(state) {
  const stamp = `f${(minted += 1)}`;
  const files = {
    prompt: path.join(TMPFILES, `beadcause-${stamp}.md`),
    system: path.join(TMPFILES, `beadcause-sys-${stamp}.md`),
    command: path.join(TMPFILES, `beadcause-cmd-${stamp}.zsh`),
  };
  const write = (p) => fs.writeFileSync(p, 'x');
  // What the real launch always writes, all three of them, before the Apple event.
  if (state === 'never-started') for (const p of Object.values(files)) write(p);
  // Past line 2 and inside `claude`: the prompt is gone, the other two are still there.
  if (state === 'running') {
    write(files.system);
    write(files.command);
  }
  // Past the last line: the shell took all three away on its way out.
  if (state === 'finished') {
    /* nothing on disk */
  }
  // The state this daemon cannot produce, and the reason `launchProgress` reads two files
  // rather than one: somebody else's sweeper took the command file.
  if (state === 'orphan-prompt') write(files.prompt);
  return files;
}

/** A worker record as advocates.json holds one — old enough to have timed out unless told
 * otherwise, and old enough to be past the grace. */
const worker = (id, over = {}) => ({ id, title: id, at: OLD, attempt: 1, ...over });

/** A delivery card as the inbox holds one — the `beadpr` block is what `cardsForDelivery` reads. */
const deliveryCard = (beadId, number = 42) => ({
  id: `${beadId}-q`,
  status: 'open',
  title: `Merge #${number}?`,
  description: ['```beadpr', `bead: ${beadId}`, `number: ${number}`, `url: https://example.invalid/pull/${number}`, '```'].join('\n'),
});

/** An advocate over a tracker that can be written to, and read back within the same tick. */
async function arena({
  beads = [],
  workers = [],
  attempts = {},
  sessions = [],
  cards = [],
  overrides = {},
  launchState = 'never-started',
  // The iTerm handle `open`/`openPlan` report back — null by default, matching every
  // launch before bc-xl7n.113.2 existed and every case above this one that does not ask
  // about closing the window. Set it to exercise `closingNeverStartedFor`.
  term = null,
  // The closer lib/advocate.js's `reapNeverStarted` calls once a `never-started` window
  // is queued — the real one by default, which refuses to send an Apple event inside a
  // suite (`mayLaunch`) and reports why, exactly like every other case here that never
  // touches iTerm. Overridden by the cases that want to assert on the *decision* rather
  // than on the refusal.
  closeNeverStarted,
} = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  for (const s of sessions) plant(...s);
  if (workers.length || Object.keys(attempts).length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts } }));
  }

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

  const world = new Map(beads.map((b) => [b.id, { ...b }]));
  const opened = [];
  const reopened = [];
  const events = [];
  const bd = {
    // What `bd ready` is: open, unclaimed, not closed. The claim is exactly what takes a
    // bead out of it.
    ready: async () => [...world.values()].filter((b) => b.status === 'open'),
    listLabel: async () => cards,
    listStatus: async () => [],
    show: async (_ws, id) => world.get(id) || null,
    children: async (_ws, id) => [...world.values()].filter((b) => b.id.startsWith(`${id}.`)),
    comments: async () => [],
    create: async () => 'new-1',
    addLabel: async () => {},
    reopenAbandoned: async (_ws, id) => {
      reopened.push(id);
      const row = world.get(id);
      if (row) row.status = 'open';
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit: (e) => events.push(e) },
    // The one thing this fake does that test/handback.mjs's does not: it mints the three
    // files a real launch mints, in whichever state the case is about, and reports the
    // paths back the way `launch` now does. That is the whole seam under test.
    open: async (_cfg, _ws, b) => {
      const launchFiles = mint(launchState);
      opened.push({ id: b.id, launchFiles });
      return { dir: REPO, mode: 'test', term, launchFiles };
    },
    openPlan: async (_cfg, _ws, b) => {
      const launchFiles = mint(launchState);
      opened.push({ id: b.id, launchFiles });
      return { dir: REPO, mode: 'test', term, launchFiles };
    },
    ...(closeNeverStarted ? { closeNeverStarted } : {}),
  });

  return {
    opened,
    reopened,
    events,
    world,
    tick: () => advocates.tick(),
    card: () => advocates.snapshot().find((a) => a.workspace === 'alpha'),
    /** What ended, and how it was described. `finish` emits the outcome as the action. */
    endings: () => events.filter((e) => e.id && e.detail !== undefined).map((e) => ({ id: e.id, action: e.action, detail: e.detail })),
    outcomes: (id) => events.filter((e) => e.id === id).map((e) => e.action),
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

/* ------------------------------------------------------------- the four states */

await check('the two files answer the four states', async () => {
  assert.equal(launchProgress(mint('never-started')), 'never-started', 'both there — the shell never reached line 3');
  assert.equal(launchProgress(mint('running')), 'running', 'the prompt is consumed, `claude` is up');
  assert.equal(launchProgress(mint('finished')), 'finished', 'the command file took itself away on the way out');
});

await check('a prompt file with no command file beside it says nothing', async () => {
  // Not a state this daemon can produce, so it is somebody else's — and calling it
  // never-started would take a live window's slot away on the strength of a TMPDIR sweeper.
  assert.equal(launchProgress(mint('orphan-prompt')), 'unknown');
});

await check('no paths at all is unknown, not a failure', async () => {
  for (const files of [null, undefined, {}, { prompt: '/x' }, { command: '/x' }, { prompt: '', command: '' }]) {
    assert.equal(launchProgress(files), 'unknown', `${JSON.stringify(files)} must not read as a verdict`);
  }
});

await check('the three files are taken back, and it is idempotent', async () => {
  const files = mint('never-started');
  assert.equal(discardLaunchFiles(files), 3, 'all three were there');
  for (const p of Object.values(files)) assert.equal(fs.existsSync(p), false, `${path.basename(p)} is gone`);
  assert.equal(discardLaunchFiles(files), 0, 'and a second sweep is not an error');
  assert.equal(discardLaunchFiles(null), 0, 'nor is one with nothing to sweep');
});

/* ------------------------------------------------------- the window that never ran */

await check('a window that never ran its command is finished, not left to the timeout', async () => {
  const r = await arena({ beads: [bead('x-1')] });
  await r.tick();
  assert.equal(r.opened.length, 1, 'the tick opened a window');
  const files = r.opened[0].launchFiles;
  assert.equal(launchProgress(files), 'never-started', 'and the fixture left it never-started');

  // Age the record past the grace without waiting 45 seconds for it. This is what the
  // daemon's next tick sees.
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8'));
  state.alpha.workers[0].at = secondsAgo(60);
  fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify(state));

  const r2 = await arena({ beads: [bead('x-1')], workers: state.alpha.workers, launchState: 'finished' });
  await r2.tick();
  assert.deepEqual(r2.outcomes('x-1').slice(0, 1), ['never-started'], 'the ending names what happened');
  assert.match(r2.endings()[0].detail, /never ran the command/, 'and says so in words');
  for (const p of Object.values(files)) assert.equal(fs.existsSync(p), false, `${path.basename(p)} was cleaned up`);
  // `reconcile` runs before the survey, so the slot and the bead come back on the same
  // tick rather than thirty seconds later.
  assert.deepEqual(r2.opened.map((o) => o.id), ['x-1'], 'and it went straight back out to a window');
});

/* -------------------------------------- and the window left on screen (bc-xl7n.113.3) */

/**
 * `finish` recording `never-started` is the trigger; what happens to the window itself
 * is `reapNeverStarted` in lib/advocate.js, queued from `term` rather than a pid because
 * no `claude` ever started — see `closingNeverStartedFor` in lib/reap.js. Queueing and
 * closing land in the same tick here because `reapNeverStarted` runs right after
 * `reconcile`, in the same `tickOne`.
 */

/** The two-tick dance every case above this uses, with a `term` handle threaded through. */
async function agedWorker({ term }) {
  const r = await arena({ beads: [bead('x-1')], term });
  await r.tick();
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8'));
  state.alpha.workers[0].at = secondsAgo(60);
  fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify(state));
  return state.alpha.workers;
}

await check('a term handle is queued to close once the window is confirmed never-started', async () => {
  const workers = await agedWorker({ term: 'ITERM-SESS-1' });
  let asked = null;
  const r2 = await arena({
    beads: [bead('x-1')],
    workers,
    launchState: 'finished',
    term: 'ITERM-SESS-1',
    closeNeverStarted: async (rec) => {
      asked = rec;
      return { act: 'close', why: 'stub says it is safe' };
    },
  });
  await r2.tick();
  assert.deepEqual(r2.outcomes('x-1').slice(0, 1), ['never-started']);
  assert.deepEqual(asked, { id: 'x-1', title: 'x-1', term: 'ITERM-SESS-1', at: asked.at }, 'the record it was asked about');
  // Queued and closed in the same tick: `reapNeverStarted` runs right after `reconcile`.
  assert.equal(r2.card().closingWindows.length, 0, 'the injected closer said close, and it was taken off the list');
  assert.ok(r2.events.some((e) => e.action === 'closed' && e.id === 'x-1'), 'and the close is on the bus');
});

await check('no term handle: nothing is queued, and the closer is never asked — the acceptance criterion', async () => {
  const workers = await agedWorker({ term: null });
  let asked = false;
  const r2 = await arena({
    beads: [bead('x-1')],
    workers,
    launchState: 'finished',
    closeNeverStarted: async () => {
      asked = true;
      return { act: 'close', why: 'should never be reached' };
    },
  });
  await r2.tick();
  assert.deepEqual(r2.outcomes('x-1').slice(0, 1), ['never-started']);
  assert.equal(r2.card().closingWindows.length, 0, 'nothing to queue with no handle');
  assert.equal(asked, false, 'a session with no term handle is left alone');
});

await check('with no closer injected, the real one refuses inside a suite and the window stays queued', async () => {
  const workers = await agedWorker({ term: 'ITERM-SESS-2' });
  // No `closeNeverStarted` override: this is `closeNeverStartedWindow` for real, and
  // `mayLaunch` reads this process as a suite (argv[1] is `test/neverstarted.mjs`), so it
  // must not reach an Apple event — proven the same way test/reap.mjs proves it for the
  // function on its own, and here through the whole tick that would call it.
  const r2 = await arena({ beads: [bead('x-1')], workers, launchState: 'finished', term: 'ITERM-SESS-2' });
  await r2.tick();
  assert.deepEqual(r2.outcomes('x-1').slice(0, 1), ['never-started']);
  assert.equal(r2.card().closingWindows.length, 1, 'refused, not dropped — nothing was actually asked of iTerm');
  assert.equal(r2.card().closingWindows[0].term, 'ITERM-SESS-2');
  // And it is what a restart would find too — persisted with the workers, for the same
  // reason `closing` is.
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8'));
  assert.equal((onDisk.alpha.closingWindows || []).length, 1, 'on disk, not only in memory');
});

await check('a closer that says the window is already gone clears the queue quietly', async () => {
  const workers = await agedWorker({ term: 'ITERM-SESS-3' });
  const r2 = await arena({
    beads: [bead('x-1')],
    workers,
    launchState: 'finished',
    term: 'ITERM-SESS-3',
    closeNeverStarted: async () => ({ act: 'drop', why: 'the window is gone' }),
  });
  await r2.tick();
  assert.equal(r2.card().closingWindows.length, 0, 'dropped, not left forever');
  assert.equal(r2.events.some((e) => e.action === 'closed'), false, 'nothing was actually closed');
});

await check('and the same, for a name mismatch or a live claude process — dropped, never closed', async () => {
  for (const verdict of [
    { act: 'drop', why: 'that iTerm session no longer names x-1 — leaving it alone' },
    { act: 'drop', why: 'a claude process is running there now — it is no longer never-started' },
  ]) {
    const workers = await agedWorker({ term: 'ITERM-SESS-4' });
    const r2 = await arena({
      beads: [bead('x-1')],
      workers,
      launchState: 'finished',
      term: 'ITERM-SESS-4',
      closeNeverStarted: async () => verdict,
    });
    await r2.tick();
    assert.equal(r2.card().closingWindows.length, 0, verdict.why);
    assert.equal(r2.events.some((e) => e.action === 'closed'), false, verdict.why);
  }
});

await check('and it costs no attempt, three times over', async () => {
  // `maxAttemptsPerBead` is 2 and nothing decrements it, so if a lost launch were an
  // attempt this bead would be retired before the third round.
  let workers = [];
  let attempts = {};
  const seen = [];
  for (let round = 0; round < 3; round += 1) {
    const r = await arena({ beads: [bead('x-1')], workers, attempts, overrides: { maxAttemptsPerBead: 2 } });
    await r.tick();
    seen.push(r.opened.map((o) => o.id));
    const state = JSON.parse(fs.readFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'advocates.json'), 'utf8'));
    workers = (state.alpha.workers || []).map((w) => ({ ...w, at: secondsAgo(60) }));
    attempts = state.alpha.attempts || {};
  }
  assert.deepEqual(seen, [['x-1'], ['x-1'], ['x-1']], 'a bead nothing ever worked is still being dispatched');
  assert.deepEqual(attempts, {}, 'and the counter never moved');
});

await check('an attempt already charged is still remembered', async () => {
  // Not charged is not the same as wiped: a real failure before this launch must survive
  // it, or the counter would be reset by the very thing that must not touch it.
  const r = await tick({
    beads: [bead('x-1')],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('never-started') })],
    attempts: { 'x-1': 1 },
  });
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['never-started']);
  const state = JSON.parse(fs.readFileSync(path.join(process.env.BEADCAUSE_CONFIG_DIR, 'advocates.json'), 'utf8'));
  assert.deepEqual(state.alpha.attempts, { 'x-1': 1 }, 'the earlier one is untouched');
});

await check('the claim comes back if there was one', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('never-started') })],
  });
  assert.deepEqual(r.reopened, ['x-1'], 'a bead claimed before this launch went out is handed back');
});

await check('a bead nobody claimed needs no hand-back', async () => {
  const r = await tick({
    beads: [bead('x-1')],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('never-started') })],
  });
  assert.deepEqual(r.reopened, [], 'a window that never started never claimed anything');
});

await check('a live busy window keeps the claim', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('never-started') })],
    sessions: [['Beadcause - x-1 something', 'busy']],
  });
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['never-started'], 'this window still never started');
  assert.deepEqual(r.reopened, [], 'but a busy session naming the bead is what makes the claim true — bc-vq78');
});

/* ------------------------------------------------------ the windows left alone */

await check('a session that is running now keeps its slot', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('running') })],
    sessions: [['Beadcause - x-1 something', 'busy']],
  });
  assert.deepEqual(r.outcomes('x-1'), [], 'nothing ended');
  assert.deepEqual(r.opened, [], 'and its bead was not handed to a second window');
});

await check('inside the grace, nothing is concluded', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    // Launched a moment ago, never-started on disk — which is also what an ordinary launch
    // looks like for its first few seconds while `~/.zshrc` runs.
    workers: [worker('x-1', { at: now(), launchFiles: mint('never-started') })],
  });
  assert.deepEqual(r.outcomes('x-1'), [], 'the shell is still allowed to be slow');
});

await check('a prompt file nobody can explain is left to the timeout', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { launchFiles: mint('orphan-prompt') })],
  });
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['timeout'], 'unknown is not a verdict');
});

await check('a worker adopted from before the probe existed is left to the timeout', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1')],
  });
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['timeout'], 'an absent measurement is not a failed one');
});

await check('the probe can be switched off', async () => {
  // The same record twice. `worker` defaults `at` to 2020, so with the probe on it is both
  // past the grace and past `workerTimeoutMinutes` — which makes the ordering the assertion:
  // the probe answers first, and off it, the two-hour timeout is what is left.
  const on = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { launchFiles: mint('never-started') })],
  });
  assert.deepEqual(on.outcomes('x-1').slice(0, 1), ['never-started'], 'on, it answers before the timeout does');

  for (const off of [0, false]) {
    const r = await tick({
      beads: [bead('x-1', { status: 'in_progress' })],
      workers: [worker('x-1', { launchFiles: mint('never-started') })],
      overrides: { neverStartedSeconds: off },
    });
    assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['timeout'], `neverStartedSeconds: ${off} asks nothing`);
  }
});

/* ------------------------------------------- and the two endings it must not touch */

/**
 * The DO-NOT on bc-xl7n.113.2, and the reason it is free rather than defended: `delivered`
 * and `handback` both leave the bead open and the TUI on screen — which from every other
 * angle is exactly what a stalled window looks like — and both consumed their prompt file
 * at line 2, an hour before they got there. So there is no state in which the probe can
 * see one of them, and nothing in the probe knows they exist.
 */
await check('a delivered session is still delivered', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('finished') })],
    cards: [deliveryCard('x-1')],
    sessions: [['Beadcause - x-1 something', 'idle']],
  });
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['delivered'], 'the pull request is the ending');
  assert.deepEqual(r.reopened, [], 'and a delivered bead keeps its claim');
});

await check('a handed-back session is still handed back', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress', labels: ['human'] })],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('finished') })],
    sessions: [['Beadcause - x-1 something', 'idle']],
  });
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['handback'], 'the question on the bead is the ending');
});

await check('a bead its own session closed is still done', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'closed' })],
    workers: [worker('x-1', { at: secondsAgo(60), launchFiles: mint('never-started') })],
  });
  // The tracker's own answer outranks anything on a disk, which is why the probe sits
  // below the closed branch rather than above it.
  assert.deepEqual(r.outcomes('x-1').slice(0, 1), ['done'], 'closed is closed');
});

/* ----------------------------------------------------------------------- done */

await quiesce();
await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
