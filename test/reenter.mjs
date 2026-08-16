#!/usr/bin/env node
/**
 * Re-entering the P0 advocate: which P0s are enrolled, what counts as movement, and the
 * three things that stop a window opening anyway.
 *
 *     npm test
 *     node test/reenter.mjs
 *
 * bc-goo.15 — the half of bc-rfnr.3 that was filed as delivered and was not. Until it,
 * `openEpicAdvocateSession` had exactly one caller (a button) while the agent's own brief
 * told it, every run, that it would be re-opened on child events. Three things are worth a
 * suite here and none of them is visible by reading one function:
 *
 * 1. **A first sight must be silent.** With no snapshot to compare against every child
 *    looks newly filed, so the failure mode of getting this wrong is a daemon that opens a
 *    window on every enrolled P0 the first time it runs — and beadcause restarts itself
 *    several times a day on its own merges, which is what makes the *persisted* snapshot
 *    load-bearing rather than an optimisation.
 * 2. **A held event must survive being held.** `reentryFor` hands back the snapshot as it
 *    is now; storing that while declining to open the window consumes the event, and the
 *    child that closed is then recorded as already-seen-closed forever. Nothing about that
 *    failure is visible — it is a window that never opens.
 * 3. **A stall is measured in windows, not timestamps.** `updated_at` is bumped by a
 *    comment and not by a session dying, so the state under test is "the tracker says
 *    in_progress and nothing on this Mac is in a window on it", which needs two sweeps.
 *
 * The tick half injects `openAdvocate`, so a case that would have opened an iTerm window
 * pushes a record onto an array instead. No iTerm, no `bd`, no agent, and nothing written
 * outside a temp config dir.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reenter-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { advocatedP0s, reentryFor, REENTER_DEFAULTS } = await import(LIB('reenter.js'));
const { WAITING_OPEN, WAITING_CLOSE, forgetAdvocateOpened } = await import(LIB('epicadvocate.js'));
const { leaseLabel } = await import(LIB('lease.js'));
const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

const OWNER = 'owner:adam@example.com';
const waiting = (line) => `${WAITING_OPEN}\n${line}\n${WAITING_CLOSE}`;

const bead = (id, over = {}) => ({
  id,
  title: id,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  labels: [],
  notes: '',
  ...over,
});
/** An owned, open, non-crash P0 whose advocate has written its sentence: enrolled. */
const p0 = (id, over = {}) =>
  bead(id, { priority: 0, issue_type: 'epic', labels: [OWNER], notes: waiting('a worker slot'), ...over });

/** `{ parents, beads }` the way `Bd.graph` answers it, off a flat list of rows. */
function index(rows, edges = {}) {
  const beads = new Map(rows.map((r) => [r.id, r]));
  const parents = new Map(Object.entries(edges));
  return { parents, beads };
}

/** The shape every case below is about: one enrolled P0 with three children. */
const subtree = (over = {}) =>
  index(
    [
      p0('x-1', over.p0 || {}),
      bead('x-1.1', over['x-1.1'] || {}),
      bead('x-1.2', over['x-1.2'] || {}),
      bead('x-1.3', over['x-1.3'] || {}),
    ],
    { 'x-1.1': 'x-1', 'x-1.2': 'x-1', 'x-1.3': 'x-1' }
  );

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

/* ------------------------------------------------------------- who is enrolled */

await check('enrolment is the waiting-on block, and nothing else', () => {
  assert.deepEqual(advocatedP0s(subtree()).map((r) => r.p0.id), ['x-1']);
  // No sentence, no enrolment — a P0 nobody has ever advocated is left alone, which is
  // what keeps this from opening windows on P0s the owner never asked to supervise.
  assert.deepEqual(advocatedP0s(subtree({ p0: { notes: 'prose but no block' } })), []);
  assert.deepEqual(advocatedP0s(subtree({ p0: { notes: '' } })), []);
});

await check('the four `wantsAdvocate` refusals hold on this door too', () => {
  // The same gate the launch refuses on, so this can never queue a P0 the launch would
  // then throw about — see `advocateRefusal` in lib/session.js.
  assert.deepEqual(advocatedP0s(subtree({ p0: { priority: 1 } })), [], 'not a P0');
  assert.deepEqual(advocatedP0s(subtree({ p0: { status: 'closed' } })), [], 'closed');
  assert.deepEqual(advocatedP0s(subtree({ p0: { labels: [] } })), [], 'nobody owns it');
  assert.deepEqual(
    advocatedP0s(subtree({ p0: { labels: [OWNER, 'app-error'] } })),
    [],
    'a crash is not an epic'
  );
});

await check('the brief gets direct children, the events get the whole subtree', () => {
  const deep = index(
    [p0('x-1'), bead('x-1.1', { issue_type: 'epic' }), bead('x-1.1.1'), bead('x-1.2')],
    { 'x-1.1': 'x-1', 'x-1.1.1': 'x-1.1', 'x-1.2': 'x-1' }
  );
  const [row] = advocatedP0s(deep);
  assert.deepEqual(row.kids.map((k) => k.id), ['x-1.1', 'x-1.2'], 'the brief says "children" and means children');
  assert.deepEqual(
    row.tree.map((k) => k.id).sort(),
    ['x-1.1', 'x-1.1.1', 'x-1.2'],
    'a P0 whose children are epics has its movement a level down'
  );
});

await check('two enrolled P0s come back in a decided order', () => {
  const two = index([p0('x-10'), p0('x-2')], {});
  assert.deepEqual(advocatedP0s(two).map((r) => r.p0.id), ['x-2', 'x-10'], 'numerically, not by export order');
});

/* --------------------------------------------------------------- what is news */

const treeOf = (idx) => advocatedP0s(idx)[0].tree;

await check('a first sight learns and says nothing', () => {
  const out = reentryFor(null, treeOf(subtree()));
  assert.equal(out.first, true);
  assert.equal(out.reason, null, 'every child looks new with nothing to compare against');
  assert.deepEqual(out.record.kids, { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' });
  assert.equal(out.record.at, null, 'and no window has been opened on it');
});

await check('a child that closed is the news', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' } };
  const out = reentryFor(prev, treeOf(subtree({ 'x-1.1': { status: 'closed' } })));
  assert.match(out.reason, /`x-1\.1` has closed under it/);
  assert.deepEqual(out.events.closed, ['x-1.1']);
  // The same close is not news twice: the snapshot now says closed.
  assert.equal(reentryFor(out.record, treeOf(subtree({ 'x-1.1': { status: 'closed' } }))).reason, null);
});

await check('a child that was filed is the news, and a child that started is not', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open' } };
  const out = reentryFor(prev, treeOf(subtree()));
  assert.match(out.reason, /`x-1\.3` was filed under it/);
  // `open → in_progress` is a worker window coming up, which is the system working. On a
  // subtree of thirty that flip is most of the traffic there is, and a supervisor woken by
  // it would be woken by dispatch rather than by anything needing judgement.
  const started = reentryFor({ kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' } }, treeOf(subtree({ 'x-1.1': { status: 'in_progress' } })), { busy: () => true });
  assert.equal(started.reason, null, 'a child being picked up is not an event');
});

await check('a child deleted out from under the P0 reads as closed, not as nothing', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open', 'x-1.9': 'open' } };
  const out = reentryFor(prev, treeOf(subtree()));
  assert.match(out.reason, /`x-1\.9` has closed under it/, 'something it planned is no longer there');
});

await check('several events in one sweep are one sentence', () => {
  const prev = { kids: { 'x-1.1': 'open', 'x-1.2': 'open' } };
  const out = reentryFor(prev, treeOf(subtree({ 'x-1.1': { status: 'closed' } })));
  assert.match(out.reason, /`x-1\.1` has closed under it; `x-1\.3` was filed under it/, 'a burst collapses');
});

await check('four or more ids are a count, not a list', () => {
  const wide = index(
    [p0('x-1'), bead('x-1.1'), bead('x-1.2'), bead('x-1.3'), bead('x-1.4'), bead('x-1.5')],
    { 'x-1.1': 'x-1', 'x-1.2': 'x-1', 'x-1.3': 'x-1', 'x-1.4': 'x-1', 'x-1.5': 'x-1' }
  );
  const out = reentryFor({ kids: {} }, treeOf(wide));
  assert.match(out.reason, /and 2 more were filed under it/);
});

/* ------------------------------------------------------------------- a stall */

await check('a stall needs two sweeps, and clears when somebody arrives', () => {
  const stalled = () => treeOf(subtree({ 'x-1.2': { status: 'in_progress' } }));
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' } };
  const t0 = Date.parse('2026-08-14T00:00:00Z');

  const first = reentryFor(seen, stalled(), { now: t0 });
  assert.equal(first.reason, null, 'the clock starts on the first look, so a launch cannot race it');
  assert.deepEqual(Object.keys(first.record.stalls), ['x-1.2']);

  const hour = reentryFor(first.record, stalled(), { now: t0 + 61 * 60000 });
  assert.match(hour.reason, /`x-1\.2` has been in progress for over 1h/);
  assert.deepEqual(hour.events.stalled, ['x-1.2']);

  assert.equal(
    reentryFor(hour.record, stalled(), { now: t0 + 600 * 60000 }).reason,
    null,
    'and it is reported once, not every sweep for a week'
  );
  assert.equal(
    reentryFor(first.record, stalled(), { now: t0 + 61 * 60000, busy: () => true }).reason,
    null,
    'somebody is in a window on it, so it is being worked rather than stalled'
  );
});

await check('a stall that resolved can stall again', () => {
  const t0 = Date.parse('2026-08-14T00:00:00Z');
  const stalled = () => treeOf(subtree({ 'x-1.2': { status: 'in_progress' } }));
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' } };
  const fired = reentryFor(reentryFor(seen, stalled(), { now: t0 }).record, stalled(), { now: t0 + 61 * 60000 });
  // Somebody picks it up: the clock and the report both drop out of the record.
  const picked = reentryFor(fired.record, stalled(), { now: t0 + 70 * 60000, busy: () => true });
  assert.deepEqual(picked.record.stalls, {});
  assert.deepEqual(picked.record.stalled, []);
  // Their window dies, and it is a fresh stall an hour later.
  const again = reentryFor(picked.record, stalled(), { now: t0 + 80 * 60000 });
  assert.equal(again.reason, null, 'the clock restarts');
  assert.match(reentryFor(again.record, stalled(), { now: t0 + 200 * 60000 }).reason, /in progress for over 1h/);
});

await check('the rate limit is stated in the module that argues for it', () => {
  assert.equal(REENTER_DEFAULTS.reenterAdvocates, true, 'on by default, or bc-rfnr.3 is still undelivered');
  assert.ok(REENTER_DEFAULTS.reenterCooldownMinutes >= 60, 'a floor under an hour is not a rate limit');
  assert.ok(REENTER_DEFAULTS.reenterIntervalMinutes >= 1);
  assert.ok(REENTER_DEFAULTS.reenterStallMinutes >= 30);
});

/* --------------------------------------------------------------------- a tick */

/**
 * One advocate tick over a graph that says what the case needs it to.
 *
 * `advocated` and `lastReenterAt` are seeded through advocates.json rather than by running
 * two ticks, because that is what a restart hands the daemon and because it is the only way
 * to drive a cooldown without waiting three hours.
 */
async function tick({
  graph = subtree(),
  advocated = null,
  lastReenterAt = null,
  workers = [],
  sessions = [],
  paused = false,
  overrides = {},
  refuse = null,
  ready = [],
  ticks = 1,
} = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) await removeTree(path.join(SESSIONS, f));
  for (const s of sessions) fs.writeFileSync(path.join(SESSIONS, `${s.pid}.json`), JSON.stringify(s));
  if (advocated || lastReenterAt || workers.length || paused) {
    fs.writeFileSync(
      path.join(dir, 'advocates.json'),
      JSON.stringify({ alpha: { workers, paused, advocated: advocated || {}, lastReenterAt } })
    );
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
      flagNotInMain: false,
      // Shells out to `gh` and `git` against a temp directory otherwise, which is noise.
      holdOpenPrs: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  forgetAdvocateOpened();
  const advocates_ = [];
  const workers_ = [];
  const planners_ = [];
  const calls = { graph: 0, cached: 0, comments: [] };
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    listStatus: async () => [],
    show: async (_ws, id) => ({ id, title: id, status: 'open' }),
    children: async () => [],
    comments: async (_ws, id) => {
      calls.comments.push(id);
      return [];
    },
    /**
     * Counted in two piles, because two unrelated things read the graph on a tick and
     * one counter cannot answer for both — which is the whole of bc-68ou.7.
     *
     * `reenter` reads it *waiting*: it wants the export, and it is that cost the
     * interval gate and the off switch exist to bound. `rosterFor` reads it with
     * `wait: false` on every tick, taking whatever `Bd.graph`'s one-minute cache has
     * on hand and never blocking — the roster is a display, and it is deliberately
     * rebuilt whole rather than accumulated. The two landed a day apart on branches
     * neither of which could see the other, so this suite's single `calls.graph`
     * started counting the roster's reads as the sweep's and reported four exports in
     * three ticks where the sweep had made one.
     *
     * So `graph` is the sweep's pile and `cached` is the roster's, and the cases below
     * assert both: an assertion that ignored the roster would go quietly wrong again
     * the day the roster starts waiting.
     */
    graph: async (_ws, opts = {}) => {
      if (opts.wait === false) calls.cached += 1;
      else calls.graph += 1;
      return graph;
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    // Both of the other doors, stubbed: the defaults drive iTerm, and a fixture that
    // reaches one opens a real window on Adam's Mac. See the advocate-tick-fixtures note.
    // Recorded rather than thrown from, because one case below is precisely about a worker
    // that must *not* be opened and an assertion says that better than a stack trace.
    open: async (_cfg, _ws, b) => {
      workers_.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    openPlan: async (_cfg, _ws, b) => {
      planners_.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    openAdvocate: async (_cfg, ws, row, opts = {}) => {
      if (refuse) throw Object.assign(new Error(refuse), { status: 409 });
      advocates_.push({
        workspace: ws.name,
        id: row.id,
        reason: opts.reason || '',
        kids: (opts.kids || []).map((k) => k.id),
        plan: opts.plan,
      });
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  for (let i = 0; i < ticks; i += 1) await advocates.tick();
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8'));
  const card = advocates.snapshot().find((x) => x.workspace === 'alpha') || {};
  return { opened: advocates_, workers: workers_, planners: planners_, calls, card, state: saved.alpha || {} };
}

const SEEN = { kids: { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' }, at: null };
const LONG_AGO = '2020-01-01T00:00:00Z';

await check('the first tick a daemon ever runs opens nothing and remembers everything', async () => {
  const r = await tick();
  assert.deepEqual(r.opened, [], 'a first sight is silent');
  assert.deepEqual(r.state.advocated['x-1'].kids, { 'x-1.1': 'open', 'x-1.2': 'open', 'x-1.3': 'open' });
  assert.ok(r.state.lastReenterAt, 'and the clock is persisted, so a restart does not re-sweep instantly');
});

await check('a child closing re-opens the advocate, with the reason on the brief', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': SEEN },
  });
  assert.equal(r.opened.length, 1);
  assert.equal(r.opened[0].id, 'x-1');
  assert.equal(r.opened[0].workspace, 'alpha');
  assert.match(r.opened[0].reason, /`x-1\.1` has closed under it/);
  assert.deepEqual(r.opened[0].kids, ['x-1.2', 'x-1.3', 'x-1.1'], 'open children first, closed tail last');
  assert.deepEqual(r.calls.comments, ['x-1'], 'the plan is read for the P0 getting a window and no other');
  assert.ok(r.state.advocated['x-1'].at, 'and the cooldown clock is stamped');
});

await check('the sweep looks on an interval, not on every tick', async () => {
  const r = await tick({ graph: subtree({ 'x-1.1': { status: 'closed' } }), advocated: { 'x-1': SEEN }, ticks: 3 });
  assert.equal(r.calls.graph, 1, 'three ticks, one export — the tick is every 30 seconds');
  assert.equal(r.calls.cached, 3, 'the roster still rebuilds every tick, off the cache, and pays no export for it');
  assert.equal(r.opened.length, 1);
});

await check('one window per tick, and the P0 that did not get it keeps its event', async () => {
  const two = index(
    [p0('x-1'), bead('x-1.1', { status: 'closed' }), p0('x-2'), bead('x-2.1', { status: 'closed' })],
    { 'x-1.1': 'x-1', 'x-2.1': 'x-2' }
  );
  const r = await tick({
    graph: two,
    advocated: { 'x-1': { kids: { 'x-1.1': 'open' } }, 'x-2': { kids: { 'x-2.1': 'open' } } },
  });
  assert.deepEqual(r.opened.map((o) => o.id), ['x-1'], 'one at a time');
  assert.deepEqual(
    r.state.advocated['x-2'].kids,
    { 'x-2.1': 'open' },
    'x-2 still believes its child is open, so the next sweep opens a window for it'
  );
});

await check('inside the cooldown nothing opens, and the event is not consumed', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: new Date().toISOString() } },
  });
  assert.deepEqual(r.opened, [], 'three hours between two automatic windows on one P0');
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'the close is still news when the floor lapses');
});

await check('past the cooldown the held event opens the window it was waiting for', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.equal(r.opened.length, 1);
  assert.match(r.opened[0].reason, /`x-1\.1` has closed under it/);
});

await check('never two on one P0 — a live session naming it holds the window', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    // `process.pid` because lib/claude.js liveness-checks every record before returning it,
    // so a made-up pid is filtered out before the code under test sees it.
    sessions: [{ pid: process.pid, sessionId: 's1', name: 'Beadcause - x-1 taking stock', cwd: REPO, status: 'idle' }],
  });
  assert.deepEqual(r.opened, [], 'one advocate per P0, whatever opened it');
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'and the event waits for that window to end');
});

await check('a dead session record holds nothing', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    sessions: [{ pid: 999999, sessionId: 's1', name: 'Beadcause - x-1 taking stock', cwd: REPO, status: 'idle' }],
  });
  assert.equal(r.opened.length, 1, 'a stale record is not a window');
});

await check('a live lease on the P0 holds it — that window is on another Mac', async () => {
  // The one guard here whose evidence cannot be seen on this laptop at all: every other
  // check reads a process table or a file in this process. A `held:` label is a claim in
  // the shared tracker, and a second supervisor arguing about the same subtree from two
  // machines is exactly what lib/lease.js exists to prevent.
  const r = await tick({
    graph: subtree({ p0: { labels: [OWNER, leaseLabel('other-mac', new Date())] }, 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'and the event waits for the lease to lapse');
  // A lease from a fortnight ago is not a window.
  const stale = await tick({
    graph: subtree({
      p0: { labels: [OWNER, leaseLabel('other-mac', new Date(Date.parse('2020-01-01T00:00:00Z')))] },
      'x-1.1': { status: 'closed' },
    }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.equal(stale.opened.length, 1);
});

await check('a stalled child is not stalled while this advocate holds a worker on it', async () => {
  // The stall clock's own `busy` answer, driven through the tick rather than the pure
  // function: a worker in `a.workers` is a window that has not named itself yet, which is
  // the case a session-records read cannot see.
  const stalling = subtree({ 'x-1.2': { status: 'in_progress' } });
  const seen = { kids: { 'x-1.1': 'open', 'x-1.2': 'in_progress', 'x-1.3': 'open' }, stalls: { 'x-1.2': 1 }, at: LONG_AGO };
  const held = await tick({
    graph: stalling,
    advocated: { 'x-1': seen },
    // `at` is now rather than the fixtures' usual constant, or reconcile reaps it before
    // the sweep runs — see the advocate-tick-fixtures note.
    workers: [{ id: 'x-1.2', title: 'x-1.2', at: new Date().toISOString(), batch: [], attempt: 1 }],
  });
  assert.deepEqual(held.opened, [], 'somebody is in a window on it, so it is being worked');
  const loose = await tick({ graph: stalling, advocated: { 'x-1': seen } });
  assert.equal(loose.opened.length, 1, 'and with nobody on it, an hour old, it is a stall');
  assert.match(loose.opened[0].reason, /in progress for over 1h/);
});

await check('a paused advocate opens no windows of any kind', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    paused: true,
  });
  assert.deepEqual(r.opened, [], 'paused means open no more sessions, and this opens one');
});

await check('the off switch is off', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    overrides: { reenterAdvocates: false },
  });
  assert.deepEqual(r.opened, [], 'and beadcause is back to a button');
  assert.equal(r.calls.graph, 0, 'off costs nothing, not even the export');
  // The roster's read is not the sweep's and is not switched off with it: an advocate
  // with `reenterAdvocates: false` still draws its EpicAdvocate section, and that read
  // costs whatever the cache already holds. See the note on the fake's `graph`.
  assert.equal(r.calls.cached, 1, 'and the roster is unaffected — it is a different feature');
});

await check('a refused launch backs off for the cooldown and keeps the event', async () => {
  const r = await tick({
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    refuse: 'x-1 may not have a P0 advocate — nobody owns it',
  });
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'the event survives a launch that threw');
  assert.notEqual(r.state.advocated['x-1'].at, LONG_AGO, 'and it is not re-argued every ten minutes');
});

await check('a graph that would not answer changes nothing', async () => {
  // `Bd.graph` swallows its own failures and hands back an empty index carrying `error`.
  // Reading that as "nothing is enrolled" would prune every snapshot, and the next
  // successful sweep would then read a whole subtree as newly filed.
  const r = await tick({
    graph: { parents: new Map(), beads: new Map(), error: 'bd export timed out' },
    advocated: { 'x-1': SEEN },
  });
  assert.deepEqual(r.opened, []);
  assert.deepEqual(r.state.advocated['x-1'].kids, SEEN.kids, 'the snapshot is left exactly as it was');
});

await check('a P0 that is no longer enrolled is forgotten', async () => {
  const r = await tick({
    graph: subtree({ p0: { notes: 'the advocate took its sentence off' }, 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
  });
  assert.deepEqual(r.opened, [], 'un-enrolling is the off switch that costs no new control');
  assert.deepEqual(r.state.advocated, {}, 'and it comes back as a first sight, which is silent');
});

await check('the window it just opened holds the same bead out of the queue', async () => {
  // The collision this closes is the worst failure in the file (bc-vq78): two windows in
  // one worktree. A window carries no bead id in its name until its first turn has run, so
  // for about a minute the launch has happened and nothing on disk says so — and a P0 in
  // `bd ready` is a bead the survey will happily open a *worker* on in that minute. It was
  // a second or two wide while only a tap could open an advocate; a sweep makes it real.
  const queued = [{ id: 'x-1', title: 'x-1', priority: 0, issue_type: 'epic', status: 'open', created_at: '2020-01-01T00:00:00Z', labels: [OWNER] }];
  const args = {
    graph: subtree({ 'x-1.1': { status: 'closed' } }),
    advocated: { 'x-1': { ...SEEN, at: LONG_AGO } },
    ready: queued,
  };
  // The control first, or this asserts nothing: with the sweep off, that queue row is a
  // bead the advocate opens a window on.
  const control = await tick({ ...args, overrides: { reenterAdvocates: false } });
  assert.deepEqual(control.opened, []);
  assert.deepEqual(control.workers, ['x-1'], 'the row does reach a launch when nothing is holding it');

  const r = await tick(args);
  assert.deepEqual(r.opened.map((o) => o.id), ['x-1'], 'the advocate was re-opened');
  assert.deepEqual(r.workers, [], 'and no second window went into the same checkout');
  assert.deepEqual(r.planners, []);
  assert.match(
    (r.card.heldByLive || []).map((h) => h.why).join(' '),
    /has not named itself yet/,
    'held, and said out loud — the card carries every other hold this way'
  );
});

/* ------------------------------------------------------------ what source says */

await check('the sweep is below the three lines that stop the tick', async () => {
  // The one thing here a behaviour test cannot see cheaply, and the mistake would look
  // entirely correct: moved above the `OBSERVING`/paused/quiet returns, an observer
  // instance opens windows and a paused advocate keeps supervising.
  const src = fs.readFileSync(LIB('advocate.js'), 'utf8');
  const from = src.indexOf('  async function tickOne(a, sessions) {');
  assert.ok(from > 0, 'tickOne has been renamed — re-point this check');
  const body = src.slice(from, src.indexOf('\n  }\n', from));
  const at = body.indexOf('await reenter(a)');
  assert.ok(at > 0, 'nothing re-opens the P0 advocate — this is bc-goo.15 regressing');
  assert.ok(body.indexOf('if (OBSERVING) return note(a,') < at, 'an observer instance must open no windows');
  assert.ok(body.indexOf('if (a.paused) return note(a,') < at, 'paused means open no more sessions');
  assert.ok(body.indexOf('if (a.quiet) {') < at, 'quiet hours mean it too');
  // And above the queue: a P0 advocate takes no worker slot, so a repo at its limit — the
  // state where supervision is worth the most — must still be able to get one.
  //
  // Matched on `const free = a.limit -` rather than on the whole line, because the whole
  // line is not what this check is about and pinning it made the suite red for a rename
  // that was entirely correct: `a.workers.length` became `codersOf(a).length` on main,
  // `indexOf` returned -1, and `at < -1` failed while `reenter` was still sitting exactly
  // where it belongs. A static read should name the thing it means and no more of the
  // line than that.
  const queueAt = body.indexOf('const free = a.limit -');
  assert.ok(queueAt > 0, 'the worker-slot arithmetic has moved or been renamed — re-point this check');
  assert.ok(at < queueAt, 'it has become queue work');
});

await check('the default for the injectable is the real door', async () => {
  const src = fs.readFileSync(LIB('advocate.js'), 'utf8');
  assert.match(src, /openAdvocate = openEpicAdvocateSession/, 'the sweep is wired to a stub in production');
  assert.match(src, /rememberAdvocateOpened\(`\$\{a\.name\}\/\$\{p0\.id\}`\)/, 'the card will offer a second window');
});

/* ---------------------------------------------------------------------- done */

await quiesce();
await removeTree(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
console.log('all good');
