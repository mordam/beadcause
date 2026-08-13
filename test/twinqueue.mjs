/**
 * Two beads that are the same job get one session, not two.
 *
 * bc-9frx shut the proposal path — a proposed bead that matches an open one is flagged
 * on the card, and one nobody was shown is refused outright at the moment of approval.
 * It deliberately left this road open, and this suite is the road: two beads with the
 * same title need no proposal to exist. Filed by hand, brought in by `bd jira pull`, or
 * created by an approval that *was* flagged and that Adam tapped anyway — which
 * lib/server.js honours on purpose, because an informed tap is his call. Both are ready
 * by every filter the queue had, so both used to get a window, and the second session's
 * first act was to find the work already committed on the first one's branch.
 *
 * `withoutTwins` in lib/advocate.js is the filter, and there are two halves worth
 * asserting because either alone reads as done:
 *
 *   - **one window** — the count of `open` calls is the whole claim, and it is asserted
 *     as the list of ids so a failure says which bead got the second one;
 *   - **and the loser is visible as held**, on the card, with the id it is waiting
 *     behind. A queue that silently holds work back is indistinguishable from an
 *     advocate that has decided there is nothing to do, which is the third rule at the
 *     top of lib/advocate.js and the more expensive half of this bug.
 *
 * Three sources of "already under way", and only the third costs a `bd` call — so the
 * call is counted here, the way test/epicqueue.mjs counts `children`: cheapness is a
 * claim, and a claim belongs in an assertion rather than in a comment.
 *
 *     npm test
 *
 * As in test/epicqueue.mjs, `open` is injected: a tick that would have opened an iTerm
 * window pushes a bead id onto an array instead. No iTerm, no `bd`, no agent, and
 * nothing written outside a temp config dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-twinqueue-'));
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

/** The title the incident was written from — long enough that a word of drift is drift. */
const TITLE = 'The router never proxies a WebSocket upgrade to the backend';

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * `inProgress` is what `bd list --status=in_progress` answers; an Error instead of an
 * array is a tracker that will not answer at all, which has to hold nothing back.
 */
async function tick({ ready = [], inProgress = [], workers = [], overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: state, the activity file the launch stamps, and the worker
  // markers. Otherwise case N's worker is still in case N+1's queue.
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  if (workers.length) {
    fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: { workers, attempts: {} } }));
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
      // Enough that the cap is never what holds a launch back — a case asserting one
      // window must fail for its own reason, not for want of a slot.
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Other features with their own suites, each of which would otherwise run real
      // git or a real agent against a temp directory on every case here.
      propose: false,
      sessionLog: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const calls = { listStatus: [] };
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    // Only workers are shown, and only as claimed: `reconcile` asks about every worker
    // on every tick, and a worker whose bead reads closed would free its slot mid-case.
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async (_ws, status) => {
      calls.listStatus.push(status);
      if (inProgress instanceof Error) throw inProgress;
      return inProgress;
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  return { opened, calls, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const heldIds = (card) => card.heldByTwin.map((h) => h.id);
const whyFor = (card, id) => (card.heldByTwin.find((h) => h.id === id) || {}).why || '';

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

/**
 * The bug in the smallest queue that can hold it: the same bead, filed twice, both
 * ready, both past the settle window. Two windows before; one now.
 */
await check('two beads with one title get one session', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', TITLE), bead('x-2', TITLE, { created_at: '2020-06-01T00:00:00Z' })],
  });

  assert.deepEqual(opened, ['x-1'], 'one session, on the older of the two — this is the whole bug');
  assert.equal(card.queue, 1, 'and the second is out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['x-2'], 'held rather than vanished');
  assert.match(whyFor(card, 'x-2'), /x-1 is the same job/, `got: ${whyFor(card, 'x-2')}`);
});

/**
 * The same fact one tick later, and the shape the incident actually took: the first
 * window is already open, so its bead is nowhere in `bd ready` and only the worker list
 * knows the job is being done.
 */
await check('a session already working the job holds its twin', async () => {
  const { opened, card, calls } = await tick({
    ready: [bead('x-2', TITLE)],
    workers: [{ id: 'x-1', title: TITLE, at: new Date().toISOString(), attempt: 1 }],
  });

  assert.deepEqual(opened, [], 'no second window over work a session already has');
  assert.deepEqual(heldIds(card), ['x-2']);
  assert.match(whyFor(card, 'x-2'), /already working x-1/, `got: ${whyFor(card, 'x-2')}`);
  assert.deepEqual(calls.listStatus, ['in_progress'], 'one tracker call for the whole survey');
});

/**
 * The half neither free source can see: a bead claimed by something that is not this
 * advocate — a window opened by hand, by the launcher, or by a discuss session. It is
 * in progress and therefore out of `bd ready` entirely.
 */
await check('a bead somebody else claimed holds its twin too', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-2', TITLE)],
    inProgress: [{ id: 'x-1', title: TITLE, status: 'in_progress' }],
  });

  assert.deepEqual(opened, [], 'in_progress is what "an agent is on this" means, whoever put it there');
  assert.match(whyFor(card, 'x-2'), /x-1 is the same job, and is already in progress/, `got: ${whyFor(card, 'x-2')}`);
});

/**
 * What a looser comparison would have cost. These two are opposite beads sharing six of
 * seven words — the pair `DUPE_THRESHOLD` was chosen off, in lib/dupe.js — and merging
 * them refuses a genuine bead rather than a duplicate one.
 */
await check('two beads that merely read alike are two pieces of work', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('x-1', 'The router never proxies a WebSocket upgrade'),
      bead('x-2', 'The router never proxies a WebSocket downgrade', { created_at: '2020-06-01T00:00:00Z' }),
    ],
  });

  assert.deepEqual(opened, ['x-1', 'x-2'], 'both, and the threshold is the reason');
  assert.deepEqual(heldIds(card), [], 'nothing held');
});

/**
 * Three copies must collapse to one, not to none. The comparison is against what has
 * *survived* the pass and never against the raw queue — otherwise the third copy is
 * judged against the second, which is itself held, and the first is the only bead in
 * the tick that never gets compared to anything.
 */
await check('three copies collapse to one, not to none', async () => {
  const { opened, card } = await tick({
    ready: [
      bead('x-1', TITLE),
      bead('x-2', TITLE, { created_at: '2020-06-01T00:00:00Z' }),
      bead('x-3', TITLE, { created_at: '2020-09-01T00:00:00Z' }),
    ],
  });

  assert.deepEqual(opened, ['x-1'], 'exactly one window');
  assert.deepEqual(heldIds(card).sort(), ['x-2', 'x-3'], 'and both of the others say why');
});

/**
 * A tracker mid-write must not empty the queue. The `bd` half is the only one that can
 * fail, and its failure is "cannot tell" — so the two free halves still hold what they
 * can see, and everything else is launched.
 */
await check('a bd that will not answer holds nothing back', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-2', TITLE), bead('x-3', 'Something else entirely, unrelated to routing')],
    workers: [{ id: 'x-1', title: TITLE, at: new Date().toISOString(), attempt: 1 }],
    inProgress: new Error('dolt: database locked'),
  });

  assert.deepEqual(opened, ['x-3'], 'the unrelated bead is launched despite the tracker being down');
  assert.deepEqual(heldIds(card), ['x-2'], 'and the worker half, which needs no tracker, still holds its twin');
});

/**
 * Where this filter must give way to the other one. A subtask routinely restates its
 * parent's title almost word for word, so the comparison would fire on a pair the
 * hierarchy rule has an opinion about — and hierarchy is `heldByChildren`'s business,
 * which runs ahead of this and answers first.
 *
 * The verdict on this pair changed with bc-zgfo and the *ownership* did not, which is
 * what this case is really pinning. It used to be launched: `heldByChildren` fired its
 * upward check only against a batch head, so a session on a plain parent held nothing and
 * the child went out. Now any live ancestor holds it. Either way the reason must be the
 * hierarchy and not the shared title — a bead held as a duplicate of its own parent is a
 * wrong sentence on the card and, if the pair ever came apart, a wrong decision.
 */
await check('a child held under its parent is held by the hierarchy, not by the shared title', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1.1', TITLE)],
    workers: [{ id: 'x-1', title: TITLE, at: new Date().toISOString(), attempt: 1 }],
  });

  assert.deepEqual(opened, [], 'a live session above it holds it, since bc-zgfo');
  assert.deepEqual(heldIds(card), [], 'and not on the strength of a shared title — this filter said nothing');
  assert.deepEqual(
    card.heldByChildren.map((h) => h.id),
    ['x-1.1'],
    'the hierarchy owns this pair, and is what the card says'
  );
  assert.match(card.heldByChildren[0].why, /working x-1 above it/, card.heldByChildren[0].why);
});

/**
 * And the give-way itself, which the case above can no longer demonstrate now that the
 * hierarchy holds that pair before this filter is reached. Same shared title, no ancestry:
 * `x-2` is a sibling of the live worker's bead, not underneath it, so `heldByChildren`
 * passes it through and the twin comparison is what actually rules — which is the whole
 * point of keeping a case where this filter is the one doing the work.
 */
await check('and a twin that is nobody’s child is still this filter’s to hold', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-2', TITLE)],
    workers: [{ id: 'x-1', title: TITLE, at: new Date().toISOString(), attempt: 1 }],
  });

  assert.deepEqual(opened, [], 'the same job by another id does not get a second window');
  assert.deepEqual(heldIds(card), ['x-2'], 'and this time it is the title that held it');
  assert.deepEqual(card.heldByChildren, [], 'the hierarchy had nothing to say about a sibling');
});

/**
 * The cost claim: nothing is asked of the tracker when there is no queue for the answer
 * to change. An advocate ticks every thirty seconds, for the life of the daemon.
 */
await check('an empty queue costs no tracker call', async () => {
  const { opened, calls } = await tick({ ready: [] });

  assert.deepEqual(opened, []);
  assert.deepEqual(calls.listStatus, [], 'no queue, no question');
});

/* --------------------------------------------------------------------- report */

console.log(`\n${failures ? `${failures} of ${ran} checks failed` : `all ${ran} checks passed`}`);
try {
  await cleanupTmp(tmp);
} catch {
  /* a temp directory that will not go is not a failure of the thing under test */
}
process.exit(failures ? 1 : 0);
