/**
 * A bead whose work is already in an open pull request gets no session.
 *
 * The second half of bc-utyr. The advocate opened a worker on bc-dmt while #115 — the
 * pull request that *was* bc-dmt, built and delivered by the previous attempt — was open,
 * conflicting, and had two sessions resolving it. There was nothing left for a worker to
 * do, and the window was worse than wasted: a worker's brief tells it to run
 * `bin/deliver.js`, which **merges**, and a resolver's brief says outright that the merge
 * is a tap on the phone and is not its to make. Two live briefs disagreeing about who
 * merges is how a branch lands out from under a review.
 *
 * `withoutOpenPrs` in lib/advocate.js is the filter and lib/inflight.js is the read
 * behind it. Three claims, and only the first one fails loudly:
 *
 *   - **no window** over a bead an open pull request already carries;
 *   - **and it is visible as held**, with the pull request number on it, because a queue
 *     that silently shrinks reads exactly like an advocate that has decided there is
 *     nothing to do — the third rule at the top of lib/advocate.js;
 *   - **and GitHub failing holds nothing back.** A `gh` that times out must not be able
 *     to empty a queue, and a read that fails must not throw away the map it had.
 *
 *     node test/prqueue.mjs
 *
 * Built on test/twinqueue.mjs's harness, which is the sibling filter's: `open` is
 * injected, so a tick that would have opened an iTerm window pushes a bead id onto an
 * array instead, and `prs` is injected too, so nothing here needs a `gh` on PATH. No
 * iTerm, no `bd`, no agent, and nothing written outside a temp config dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { inflightWhy, describeInflight } = await import(LIB('inflight.js'));

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

/** What `openWork` hands back: bead id → the pull request carrying it. */
const carrying = (entries) => ({
  ok: true,
  reason: '',
  checked: entries.length,
  beads: new Map(entries.map(([id, over]) => [id, { number: 115, url: 'https://x/115', title: 'the PR', branch: 'b', draft: false, mergeable: 'CONFLICTING', ...over }])),
});

/** And what it hands back when GitHub would not answer. */
const cannotSay = (reason) => ({ ok: false, reason, checked: 0, beads: new Map() });

/**
 * One tick, over a tracker and a GitHub that say what the case needs them to.
 *
 * `prs` is a list of results, one per call, because the tick reads twice — once before
 * the survey and once, forced, immediately before a launch — and several cases turn on
 * the two disagreeing. A short list simply repeats its last entry.
 */
async function tick({ ready = [], prs = [carrying([])], overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: state, the activity file the launch stamps, and the worker
  // markers. Otherwise case N's worker is still in case N+1's queue.
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });

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
  const calls = [];
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
      calls.push(1);
      return prs[Math.min(calls.length - 1, prs.length - 1)];
    },
  });
  await advocates.tick();
  return { opened, reads: calls.length, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const heldIds = (card) => card.heldByPr.map((h) => h.id);
const whyFor = (card, id) => (card.heldByPr.find((h) => h.id === id) || {}).why || '';

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
await check('a bead whose pull request is open gets no session', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'Hold several chat sessions open at once')],
    prs: [carrying([['x-1', {}]])],
  });

  assert.deepEqual(opened, [], 'no window — this is bc-utyr');
  assert.equal(card.queue, 0, 'and it is out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['x-1'], 'held rather than vanished');
  assert.match(whyFor(card, 'x-1'), /#115/, `got: ${whyFor(card, 'x-1')}`);
  assert.equal(card.heldByPr[0].number, 115, 'the number travels, so the card can send you to the board');
});

/** And the bead beside it, which nothing is carrying, is still launched. */
await check('it holds only the bead the pull request names', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'Hold several chat sessions open at once'), bead('x-2', 'Something else entirely')],
    prs: [carrying([['x-1', {}]])],
  });

  assert.deepEqual(opened, ['x-2'], 'the unrelated bead still gets its window');
  assert.deepEqual(heldIds(card), ['x-1']);
});

/**
 * The state that made the incident expensive rather than merely wasteful: the pull
 * request is conflicting, so two sessions are already on it under a brief that forbids
 * merging, and the worker's brief tells it to merge.
 */
await check('a conflicting pull request says so, because that is what needs doing', async () => {
  const { card } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([['x-1', { mergeable: 'CONFLICTING' }]])],
  });
  assert.match(whyFor(card, 'x-1'), /conflicts with the base/, whyFor(card, 'x-1'));
});

await check('and a mergeable one says the other thing', async () => {
  const { card } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([['x-1', { mergeable: 'MERGEABLE' }]])],
  });
  assert.match(whyFor(card, 'x-1'), /waiting to be merged/, whyFor(card, 'x-1'));
});

/** A draft is work on a branch with somebody's intention attached. Still held. */
await check('a draft pull request holds too', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([['x-1', { draft: true, mergeable: 'UNKNOWN' }]])],
  });
  assert.deepEqual(opened, []);
  assert.match(whyFor(card, 'x-1'), /still a draft/, whyFor(card, 'x-1'));
});

/**
 * The forced read before a launch, and the reason it exists. A delivery that could not
 * merge opens a pull request and hands the bead back to `bd ready` in the same minute,
 * which is well inside the interval — so the read at the top of the tick is allowed to
 * be stale and the one before the launch is not.
 */
await check('a pull request opened since the tick began still stops the launch', async () => {
  const { opened, card, reads } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([]), carrying([['x-1', {}]])],
  });

  assert.equal(reads, 2, 'read once before the survey and once, forced, before the launch');
  assert.deepEqual(opened, [], 'the forced read is what caught it');
  assert.deepEqual(heldIds(card), ['x-1'], 'and the re-survey put it on the card');
});

/**
 * The other direction, and the one that would be a silent bug: a pull request that closed
 * between the two reads must give the bead back rather than hold it on a stale map. The
 * queue has a second bead in it deliberately — the forced read happens on the way to a
 * launch, and a tick with nothing left to launch returns before it, which is the same
 * shape `landed` already has and is why a held bead can wait out the interval rather than
 * the tick. Nothing is lost by that: the read is a courtesy to a launch that is about to
 * happen, and no launch is about to happen.
 */
await check('a pull request that closed between the reads gives the bead back', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a'), bead('x-2', 'b')],
    prs: [carrying([['x-1', {}]]), carrying([])],
  });

  assert.deepEqual(opened.sort(), ['x-1', 'x-2'], 'the second read released it, in the same tick');
  assert.deepEqual(heldIds(card), [], 'and nothing is left held on the card');
});

/**
 * A `gh` that will not answer must not be able to empty a queue — the same rule the twin
 * filter keeps about a tracker mid-write, for the same reason.
 */
await check('a gh that will not answer holds nothing back', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [cannotSay('gh pr list failed — could not resolve host')],
  });

  assert.deepEqual(opened, ['x-1'], 'the bead is launched, because nothing was established');
  assert.deepEqual(heldIds(card), []);
  assert.match(card.inflight.summary, /could not resolve host/, JSON.stringify(card.inflight));
});

/**
 * And it must not throw away what it already knew. A read that fails after a good one is
 * the case a naive "clear the map on error" would turn into a launched window.
 */
await check('a failed read keeps the map the last good one left', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([['x-1', {}]]), cannotSay('gh: timed out')],
  });

  assert.deepEqual(opened, [], 'still held, on the map from the read that worked');
  assert.deepEqual(heldIds(card), ['x-1']);
});

/**
 * A queue emptied by this filter is not a clear queue, and saying "clear" over one is
 * how an advocate ends up proposing new work while the old work sits in a pull request
 * nobody merged.
 */
await check('an empty queue says why it is empty', async () => {
  const { card } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([['x-1', {}]])],
  });
  assert.match(card.note, /already in an open pull request/, card.note);
  assert.doesNotMatch(card.note, /clear/, card.note);
});

/** Off is off: the switch has to actually stop the read, not just the filtering. */
await check('holdOpenPrs: false asks GitHub nothing at all', async () => {
  const { opened, card, reads } = await tick({
    ready: [bead('x-1', 'a')],
    prs: [carrying([['x-1', {}]])],
    overrides: { holdOpenPrs: false },
  });

  assert.equal(reads, 0, 'no gh traffic when the feature is off');
  assert.deepEqual(opened, ['x-1']);
  assert.deepEqual(heldIds(card), []);
});

/* --------------------------------------------------------- the sentences alone */

await check('inflightWhy names the number and what the pull request wants', async () => {
  assert.match(inflightWhy({ number: 42, mergeable: 'CONFLICTING' }), /#42 already carries this work and it conflicts/);
  assert.match(inflightWhy({ number: 42, mergeable: 'UNKNOWN' }), /and it is open/);
  assert.match(inflightWhy({ number: 42, mergeable: 'UNKNOWN', draft: true }), /still a draft/);
});

await check('describeInflight says nothing when nothing is held', async () => {
  assert.equal(describeInflight({ ok: true, reason: '' }, []), '');
  assert.match(describeInflight({ ok: true }, [{ id: 'x-1', number: 115 }]), /1 bead held behind an open pull request — x-1 \(#115\)/);
  assert.match(describeInflight({ ok: false, reason: 'no gh' }), /open-PR check skipped — no gh/);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
