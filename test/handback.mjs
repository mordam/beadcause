/**
 * The claim a window that is gone was still holding.
 *
 * A worker claims its bead as its first act — that is what stops a second window being
 * opened on top of it — and every ending the brief documents takes the claim off again.
 * The endings nobody chose take it off nowhere, and `reconcile` in lib/advocate.js used to
 * free the slot, charge the attempt, and leave `in_progress` on the bead for good. A
 * claimed bead is not in `bd ready`, so it was out of every queue this daemon builds,
 * permanently, on the strength of a session that did nothing.
 *
 * bc-bp32 is where that bit hardest. An epic *planner* claims its epic like any other
 * window, and `bin/plan.js` un-claims it as its last act, because the advocate reads plans
 * off epics **in `bd ready`**: a claimed epic makes its own plan invisible. So a planner
 * that died before that step left the epic claimed, its plan unread, and its children
 * falling back to one window each — degraded rather than stuck, and silent about it.
 *
 * Four claims:
 *
 *   - **a window that is gone gives the claim back**, on `unfinished`, `timeout` and
 *     `silent` — the three endings that leave a claimed bead behind;
 *   - **a window still typing keeps it**, because un-claiming under a live session is
 *     bc-vq78, and an *idle* window counts as gone: a worker's window holds exactly one
 *     turn, so a TUI sitting there after its agent fell over is a finished session;
 *   - **an ending the session reached for itself keeps it** — closed, delivered, handed
 *     back — because all three want the bead exactly where it is;
 *   - **and the epic dispatches again**: a dead planner's epic is back in `bd ready` before
 *     the same tick's survey, which reads its plan and gives its groups their windows.
 *
 *     node test/handback.mjs
 *
 * The tracker is a small mutable world rather than a table of canned answers, because the
 * point of the last two cases is that a write in `reconcile` changes what the survey a few
 * lines later reads. Canned answers would have to be told the answer changed, which is the
 * thing being tested. `open` and `openPlan` are injected, so a tick that would have opened
 * an iTerm window pushes an id onto an array instead. No iTerm, no `bd`, no agent.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-handback-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { formatPlan, validatePlan, PLANNED_LABEL } = await import(LIB('plan.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const now = () => new Date().toISOString();

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
const epic = (id, over = {}) => bead(id, { issue_type: 'epic', ...over });

/**
 * A Claude Code session record, as `~/.claude/sessions/<pid>.json`.
 *
 * This process's own pid, which is the only one a test can be sure is alive: liveness is
 * checked with signal 0, so a made-up number is filtered out before anything under test
 * sees it and every case would pass for the wrong reason.
 */
function plant(name, status = 'busy') {
  fs.writeFileSync(
    path.join(SESSIONS, `${process.pid}.json`),
    JSON.stringify({ pid: process.pid, sessionId: 'sess-1', name, cwd: REPO, status, startedAt: Date.now() })
  );
}

/** A worker record as advocates.json holds one — old enough to have timed out unless told otherwise. */
const worker = (id, over = {}) => ({ id, title: id, at: OLD, attempt: 1, ...over });

/** A delivery card as the inbox holds one — the `beadpr` block is what `cardsForDelivery` reads. */
const deliveryCard = (beadId, number = 42) => ({
  id: `${beadId}-q`,
  status: 'open',
  title: `Merge #${number}?`,
  description: ['```beadpr', `bead: ${beadId}`, `number: ${number}`, `url: https://example.invalid/pull/${number}`, '```'].join('\n'),
});

/** An advocate over a tracker that can be written to, and read back within the same tick. */
async function arena({ beads = [], workers = [], comments = {}, sessions = [], cards = [], overrides = {}, reopen = null } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
  for (const s of sessions) plant(...s);
  if (workers.length) fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts: {} } }));

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
  const planned = [];
  const reopened = [];
  const bd = {
    // What `bd ready` is: open, unclaimed, and not closed. The claim is exactly what takes
    // a bead out of it, which is the whole subject of this suite.
    ready: async () => [...world.values()].filter((b) => b.status === 'open'),
    listLabel: async () => cards,
    listStatus: async () => [],
    show: async (_ws, id) => world.get(id) || null,
    children: async (_ws, id) => [...world.values()].filter((b) => b.id.startsWith(`${id}.`)),
    comments: async (_ws, id) => comments[id] || [],
    create: async () => 'new-1',
    addLabel: async () => {},
    // `reopenAbandoned`, not `reopen`: bd 1.2.1 refuses to clear a claim from an actor
    // that is not the holder, which on this path is *every* hand-back, so the real one
    // steps over that guard with `--force` once it has established the window is gone
    // (bc-xl7n.85 — the argv and the escalation are test/reassignguard.mjs's). What this
    // fake stands in for is the write landing; the point of the cases below is which
    // endings reach for it.
    reopenAbandoned: async (_ws, id) => {
      reopened.push(id);
      if (reopen) await reopen(id);
      const row = world.get(id);
      if (row) row.status = 'open';
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push({ id: b.id, group: b.group ? b.group.name : null });
      return { dir: REPO, mode: 'test', term: null };
    },
    openPlan: async (_cfg, _ws, b) => {
      planned.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });

  return {
    opened,
    planned,
    reopened,
    world,
    tick: () => advocates.tick(),
    card: () => advocates.snapshot().find((a) => a.workspace === 'alpha'),
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

/* ---------------------------------------------------- the endings nobody chose */

await check('a window that timed out and is gone gives the claim back', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1')],
  });

  assert.deepEqual(r.reopened, ['x-1'], 'the claim came off');
  assert.equal(r.world.get('x-1').status, 'open', 'and the bead is in `bd ready` again');
  // The hand-back is in `reconcile`, which runs before the survey — so the bead is workable
  // on the same tick that freed the slot rather than thirty seconds later.
  assert.deepEqual(r.opened.map((o) => o.id), ['x-1'], 'and it went straight back out to a window');
});

await check('a bead nobody claimed needs no hand-back', async () => {
  const r = await tick({
    beads: [bead('x-1')],
    workers: [worker('x-1')],
  });

  assert.deepEqual(r.reopened, [], 'there is nothing to put back — `bd ready` already has it');
});

await check('an unanswered check-in gives the claim back as well', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    // Asked long enough ago to have run out of `checkinMinutes`, but launched recently
    // enough that the timeout is not what ends it.
    workers: [worker('x-1', { at: now(), asked: OLD })],
  });

  assert.deepEqual(r.reopened, ['x-1'], 'silence frees the slot, so it has to free the bead');
});

/* ------------------------------------------------------- the window that is not gone */

await check('a window still typing keeps its claim', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1')],
    sessions: [['Beadcause - x-1 something', 'busy']],
  });

  assert.deepEqual(r.reopened, [], 'this is bc-vq78 — a busy session is the one thing that makes the claim true');
});

/**
 * And the case the whole gate is for. A window whose agent fell over does not vanish: the
 * TUI sits there idle. Gating on the window's existence would hold the claim for as long as
 * nobody happened to close it, which on an unattended laptop is days.
 */
await check('an idle window is a finished window', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1')],
    sessions: [['Beadcause - x-1 something', 'idle']],
  });

  assert.deepEqual(r.reopened, ['x-1'], 'one turn, and the turn is over');
  assert.deepEqual(r.opened, [], 'and no second window while that one is still on screen — `withoutLiveSessions` holds it');
});

/* --------------------------------------------- the endings the session reached */

await check('a bead the session closed is left closed', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'closed' })],
    workers: [worker('x-1')],
  });

  assert.deepEqual(r.reopened, [], 'reopening a bead its own session closed would hand landed work to a new window');
});

await check('a delivered bead keeps its claim', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' })],
    workers: [worker('x-1')],
    sessions: [['Beadcause - x-1 something', 'idle']],
    cards: [deliveryCard('x-1')],
  });

  assert.deepEqual(r.reopened, [], 'the pull request is waiting on a tap — a second window would rebuild it');
});

await check('a bead handed back for a decision keeps its claim', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress', labels: ['human'] })],
    workers: [worker('x-1')],
    sessions: [['Beadcause - x-1 something', 'idle']],
  });

  assert.deepEqual(r.reopened, [], 'the question is on the bead and it is yours to answer');
});

/* --------------------------------------------------------------- when bd refuses */

await check('a tracker that refuses the write costs the tick nothing', async () => {
  const r = await tick({
    beads: [bead('x-1', { status: 'in_progress' }), bead('x-2')],
    workers: [worker('x-1')],
    reopen: async () => {
      throw new Error('dolt: database is locked');
    },
  });

  assert.equal(r.world.get('x-1').status, 'in_progress', 'still claimed, which is where it already was');
  assert.deepEqual(r.opened.map((o) => o.id), ['x-2'], 'and the rest of the tick ran');
});

/* -------------------------------------------------------------- the epic, bc-bp32 */

/**
 * The bead's own acceptance criterion. A planner window died before `bin/plan.js` could
 * hand the epic back, so tick one sees a claimed epic with a worker that has timed out —
 * and the plan it did manage to write is invisible, because a claimed epic is not in
 * `bd ready` and that is where plans are read from. Tick two is the proof it healed.
 */
await check('a dead planner does not stop its epic dispatching', async () => {
  const plan = validatePlan(
    { groups: [{ name: 'router', beads: ['x-1.1', 'x-1.2'], prs: [{ repo: 'alpha', title: 'router' }], prompt: 'Do both as one change.' }] },
    { epic: 'x-1', children: null }
  );
  const r = await tick({
    beads: [
      epic('x-1', { status: 'in_progress', priority: 1, labels: [PLANNED_LABEL] }),
      bead('x-1.1'),
      bead('x-1.2'),
    ],
    workers: [worker('x-1')],
    comments: { 'x-1': [{ text: formatPlan(plan) }] },
  });

  assert.deepEqual(r.reopened, ['x-1'], 'the epic came back');
  assert.deepEqual(r.opened.map((o) => o.id), ['x-1.1'], 'one window, for the one group in the plan');
  assert.equal(r.opened[0].group, 'router', 'briefed on the group the dead planner wrote');
  assert.deepEqual(r.planned, [], 'no second planner — the plan the dead one wrote was there to be read');
});

/**
 * The same shape without a plan, which is bc-bhp9's batching: the point is not that the
 * plan survived but that a claimed epic is out of every queue, and a batch head claims its
 * epic exactly as a planner does.
 */
await check('an epic with no plan comes back to be planned', async () => {
  const r = await tick({
    beads: [epic('x-1', { status: 'in_progress', priority: 1 }), bead('x-1.1'), bead('x-1.2')],
    workers: [worker('x-1')],
  });

  assert.deepEqual(r.reopened, ['x-1']);
  assert.deepEqual(r.planned, ['x-1'], 'a planner, this time one that may get as far as the hand-back itself');
  assert.deepEqual(r.opened, [], 'and the children are folded into it rather than taking a window each');
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
