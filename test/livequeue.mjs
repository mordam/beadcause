/**
 * A bead somebody is already sitting in gets no second window.
 *
 * bc-vq78. Two sessions were open on climative/cl-xe2 at once — one busy and writing
 * files, the other handed the same bead with a plain brief and told by that brief that
 * claiming it "is what stops a second session being opened on top of you". The second
 * found out an hour in, by noticing files it had not written changing mtime. The bead
 * spanned ten repos and both windows shared the same uncommitted worktrees.
 *
 * The claim is not the guard it was advertised as: "request changes" reopens a bead and
 * drops its assignee while the session that built the branch is still sitting there,
 * `reconcile` lets a worker's slot go on a timeout without the window having gone
 * anywhere, and a restarted daemon forgets its workers outright. So the evidence here is
 * the window itself — a running process whose name carries the bead's id, which is what
 * `namesBead` already decides for the reaper.
 *
 * `withoutLiveSessions` in lib/advocate.js is the filter and `resight` is the read
 * before a launch. Five claims:
 *
 *   - **no window** over a bead a live session already names;
 *   - **and it is visible as held**, with the pid on it, because a queue that silently
 *     shrinks reads exactly like an advocate that has decided there is nothing to do;
 *   - **and a session that appears mid-tick still stops the launch**, because a window
 *     opened seconds ago carries no bead id until its first turn renames it;
 *   - **and a record whose process is gone holds nothing.** Nothing deletes those files
 *     on exit, so "a record exists" and "a session is running" are different questions;
 *   - **and a window that has never renamed at all still stops the launch, if its own
 *     command line names the bead** (bc-xl7n.114). A session reading code and running a
 *     slow suite for its first several minutes before its first rename is invisible to
 *     every claim above — `namesBead(s.name, …)` has nothing to match — and that is
 *     exactly when it looks quietest. The brief itself carries no such gap: it is on the
 *     process's own argv from the instant `claude` starts, so `resight` falls back to
 *     reading it, via `psLines` here rather than a real `ps` of this Mac.
 *
 *     node test/livequeue.mjs
 *
 * Built on test/prqueue.mjs's harness, which is the sibling filter's: `open` is
 * injected, so a tick that would have opened an iTerm window pushes a bead id onto an
 * array instead, and `prs` is injected too, so nothing here needs a `gh` on PATH. The
 * session records are written into a temp directory `claudeSessionsDir` points at, with
 * this process's own pid where a case needs a live one. No iTerm, no `bd`, no agent.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-livequeue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, title, over = {}) => ({
  id,
  title,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  ...over,
});

/**
 * A Claude Code session record, as `~/.claude/sessions/<pid>.json`.
 *
 * `pid` defaults to this process, which is the only pid a test can be sure is alive —
 * liveness is checked with signal 0, so a made-up number would be filtered out before
 * the filter under test ever saw it, and every case would pass for the wrong reason.
 */
function plant(name, { pid = process.pid, status = 'busy', cwd = REPO } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `sess-${pid}`, name, cwd, status, startedAt: Date.now() })
  );
}

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * `sessions` is a list of records to write before the tick, and `planted` a list to
 * write *during* it — from inside the forced open-PR read, which is the last thing that
 * happens before the launch is decided. That is how "a window opened after the snapshot"
 * is staged, and it is not a contrivance: the snapshot is taken once per tick for every
 * advocate, and a session renaming itself in that gap is the ordinary case.
 */
async function tick({ ready = [], sessions = [], planted = [], overrides = {}, psLines = async () => [] } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: state, the activity file the launch stamps, and the session
  // records. Otherwise case N's window is still holding case N+1's bead.
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  for (const s of sessions) plant(...s);

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
      // Other features with their own suites, each of which would otherwise run real git,
      // a real `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  let reads = 0;
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    prs: async () => {
      reads += 1;
      // The forced read, immediately before the launch — and so the last moment a
      // window can open without the tick's own snapshot having seen it.
      if (reads === 2) for (const s of planted) plant(...s);
      return { ok: true, reason: '', checked: 0, beads: new Map() };
    },
    psLines,
  });
  await advocates.tick();
  return { opened, advocates, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const heldIds = (card) => card.heldByLive.map((h) => h.id);
const whyFor = (card, id) => (card.heldByLive.find((h) => h.id === id) || {}).why || '';

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

/** The incident, in the smallest queue that can hold it. */
await check('a bead a live session is working gets no second window', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'Give each opened chat a tab')],
    sessions: [['Beadcause - x-1 give each chat a tab']],
  });

  assert.deepEqual(opened, [], 'no window — this is bc-vq78');
  assert.equal(card.queue, 0, 'and it is out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['x-1'], 'held rather than vanished');
  assert.match(whyFor(card, 'x-1'), new RegExp(`pid ${process.pid}`), whyFor(card, 'x-1'));
  assert.equal(card.heldByLive[0].pid, process.pid, 'the pid travels, so the card names the window');
});

/** And the bead beside it, which nobody is in, is still launched. */
await check('it holds only the bead the session names', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a'), bead('x-2', 'b')],
    sessions: [['Beadcause - x-1 a']],
  });

  assert.deepEqual(opened, ['x-2'], 'the unrelated bead still gets its window');
  assert.deepEqual(heldIds(card), ['x-1']);
});

/**
 * The reported window was busy, but idle is not finished: an interactive session says its
 * last word and goes back to waiting, so a delivered or handed-back worker sits there
 * idle with its worktree full of uncommitted work. Opening a second window into that is
 * the same collision with a quieter first half.
 */
await check('an idle window holds it too', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    sessions: [['Beadcause - x-1 a', { status: 'idle' }]],
  });

  assert.deepEqual(opened, []);
  assert.match(whyFor(card, 'x-1'), /already has it open/, whyFor(card, 'x-1'));
});

/**
 * `namesBead` and not a substring, because a bead's subtasks are `<id>.1` — a parent id
 * is a prefix of every child's, so `includes` would hold an epic behind a window working
 * one of its children and hold every child behind a window working a sibling.
 */
await check('a session on a subtask does not hold the parent', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'the parent')],
    sessions: [['Beadcause - x-1.2 a subtask of it']],
  });

  assert.deepEqual(opened, ['x-1'], 'x-1.2 is a different bead');
  assert.deepEqual(heldIds(card), []);
});

/** A window with no name yet names no bead, and holds nothing. */
await check('an unnamed session holds nothing', async () => {
  const { opened } = await tick({ ready: [bead('x-1', 'a')], sessions: [['']] });
  assert.deepEqual(opened, ['x-1']);
});

/**
 * bc-xl7n.114. A window that has never renamed at all — no session record naming the
 * bead, nothing this daemon remembers launching — but whose own command line already
 * carries "alpha/x-1", the way `sessionCommand` in lib/session.js actually invokes
 * `claude`. Still no second window: the process itself is evidence, and it needs no
 * rename to be read.
 */
await check('a live process naming the bead on its own command line holds it too', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    psLines: async () => [{ pid: process.pid, args: 'claude -- You are working bead **alpha/x-1**, opened automatically' }],
  });
  assert.deepEqual(opened, [], 'no second window on a bead a live process already names');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.match(whyFor(card, 'x-1'), /own command line/);
});

/**
 * And the false positive this has to refuse: a bare id, unqualified by the workspace,
 * appearing in a process's argv for reasons that have nothing to do with claiming the
 * bead — a memory note, a doc, a comment quoted back at the model in its own context.
 * Only "alpha/x-1" is evidence; "x-1" alone is not.
 */
await check('a bare id on some other process argv holds nothing', async () => {
  const { opened } = await tick({
    ready: [bead('x-1', 'a')],
    psLines: async () => [{ pid: process.pid, args: 'claude -- a memory note that happens to mention x-1 in passing' }],
  });
  assert.deepEqual(opened, ['x-1'], 'the bare id is not a claim on the bead');
});

/**
 * Records outlive their process — nothing deletes them on exit — so "a record exists" and
 * "a session is running" are different questions, and answering the first would hold a
 * bead behind a window that closed on Tuesday.
 */
await check('a record whose process is gone holds nothing', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    sessions: [['Beadcause - x-1 a', { pid: 999999 }]],
  });

  assert.deepEqual(opened, ['x-1'], 'the pid is dead, so the window is not there');
  assert.deepEqual(heldIds(card), []);
});

/**
 * The read before the launch, and the reason it exists. A window opened seconds ago
 * carries no bead id at all until its first turn renames it, so the snapshot at the top
 * of the tick is allowed to be stale and the read before a window opens is not.
 */
await check('a session that appears mid-tick still stops the launch', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    planted: [['Beadcause - x-1 a']],
  });

  assert.deepEqual(opened, [], 'the forced read is what caught it');
  assert.deepEqual(heldIds(card), ['x-1'], 'and the re-survey put it on the card');
});

/**
 * A queue emptied by this filter is not a clear queue. An advocate that said "clear" over
 * one would go on to propose new work while a session it had forgotten about sat in the
 * bead it was proposing beside.
 */
await check('an empty queue says why it is empty', async () => {
  const { card } = await tick({
    ready: [bead('x-1', 'a')],
    sessions: [['Beadcause - x-1 a']],
  });

  assert.match(card.note, /session already open/, card.note);
  assert.doesNotMatch(card.note, /clear/, card.note);
});

/**
 * And the other half of bc-7qo.19: the daemon noticing a window it did not open.
 *
 * The refusal in lib/onewindow.js stops *this daemon* adding to a pile. Nothing can stop a
 * shell that outlived its own `claude` and re-ran the command, which is where the three
 * windows on bc-7qo.11 came from — so the second guarantee is that the pile is *said*,
 * rather than a log that reads "at its limit of 2 session(s)" with three windows on one
 * bead.
 *
 * Driven over two ticks, because a duplicate is only visible once the daemon has a worker
 * to compare against: the first tick opens the window with an empty process table, the
 * second one runs with two live processes naming its bead.
 */
await check('a bead with two live windows on it is reported, once, naming the pids', async () => {
  let table = [];
  const { opened, advocates } = await tick({ ready: [bead('x-1', 'a')], psLines: async () => table });
  assert.deepEqual(opened, ['x-1'], 'the first tick opened the window it is about to find two of');

  table = [
    { pid: 4242, args: 'claude -- You are working bead **alpha/x-1**, opened automatically' },
    { pid: 4243, args: 'claude -- You are working bead **alpha/x-1**, opened automatically' },
  ];
  const said = [];
  const realError = console.error;
  console.error = (...args) => said.push(args.join(' '));
  try {
    await advocates.tick();
    await advocates.tick();
  } finally {
    console.error = realError;
  }

  const lines = said.filter((l) => /has 2 live windows/.test(l));
  assert.equal(lines.length, 1, `said once per spell, not once per tick — got ${said.length} error line(s)`);
  assert.match(lines[0], /x-1/);
  assert.match(lines[0], /pid 4242, 4243/, 'the pids, because that is what a reader has to go on');
});

await check('and one window on it is not two, however much prose the argv carries', async () => {
  let table = [];
  const { advocates } = await tick({ ready: [bead('x-1', 'a')], psLines: async () => table });
  table = [
    { pid: 4242, args: 'claude -- You are working bead **alpha/x-1**, opened automatically' },
    // The false positive `linesNameBead` exists for: a brief carries its whole memory
    // store, and a memory note quotes bead ids as examples.
    { pid: 4243, args: 'claude -- a memory note that mentions x-1 and other/x-1 in passing' },
    { pid: 4244, args: 'claude -- You are working bead **alpha/x-1.2**, opened automatically' },
  ];
  const said = [];
  const realError = console.error;
  console.error = (...args) => said.push(args.join(' '));
  try {
    await advocates.tick();
  } finally {
    console.error = realError;
  }
  assert.deepEqual(
    said.filter((l) => /live windows/.test(l)),
    []
  );
});

/** Off is off. */
await check('holdLiveSessions: false launches anyway', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    sessions: [['Beadcause - x-1 a']],
    overrides: { holdLiveSessions: false },
  });

  assert.deepEqual(opened, ['x-1']);
  assert.deepEqual(heldIds(card), []);
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
