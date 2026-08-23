#!/usr/bin/env node
/**
 * The two queues, and where a bead is in either — bc-khoe.6.
 *
 *     npm test
 *     node test/queues.mjs
 *
 * The stages all existed before lib/queues.js did, in three modules on three different
 * clocks: the merge queue writes attempts, downmerges, resolving and refused into a
 * merge-bead's notes; the deploy journal records `queued · pulling · building · deploying
 * · ok · failed · unconfirmed · lost`; the release queue batches merged-and-not-live work
 * behind the settle window. What nothing did was serve them as one answer, and that is
 * what this suite is about.
 *
 * Four things here are the sort that rot silently and none of them is visible by reading
 * one file:
 *
 * 1. **Each rung comes off evidence somebody wrote down.** Every case below builds the
 *    state a real pass of lib/mergequeue.js would have left, or the deploy record
 *    lib/deploy.js would have written, and asserts the rung that follows from it. A stage
 *    derived from something nothing records is a guess with a label on it.
 * 2. **The last three are `done` only where a handover says so.** `npm run swap` writes no
 *    deploy record on purpose, so *deployed to green*, *green verification* and *swapping
 *    to blue* come off the router's own trail (lib/handover.js, bc-khoe.8) — and where
 *    there is no trail to read they stay `untracked` rather than falling back to the
 *    position the entry has reached. A ladder that filled them in from the current stage
 *    would tick "green verification" over a verification nobody ran.
 * 3. **A repo with nothing to release gets no release entries at all**, and its merge
 *    entry disappears on merge rather than becoming something nothing could ever drain.
 * 4. **An entry leaves one release after it went live.** Off by one in either direction is
 *    a board you can only read too late, or one that keeps a fortnight of history.
 *
 * The derivation reaches no tracker, no checkout, no deploy journal on disk and no
 * network: every case builds its own board, journal and ledger. The last section boots
 * the real server against a `bd` that answers `[]`, a workspace with no remote and a
 * scratch config directory, because everything above it would still pass with the route
 * never wired up at all — it asks `gh` whether it is available, as the board always does,
 * and takes whatever answer it gets.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cleanupTmp } from './helpers/tmp.mjs';
import { boundPort } from './helpers/net.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-queues-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the release ledger the route reads lives under it.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  KEEP_RELEASES,
  MERGE_STAGES,
  MERGE_STAGE_IDS,
  RELEASE_STAGES,
  RELEASE_STAGE_IDS,
  mergeEntry,
  mergeStageOf,
  queues,
  releasable,
  releaseEntry,
  releaseStageOf,
  rungsFor,
} = await import('../lib/queues.js');
const { MAX_ATTEMPTS, queueState, withQueueBlock } = await import('../lib/mergebead.js');

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

/**
 * The queue's own state, as it actually reaches a reader.
 *
 * Round-tripped through `withQueueBlock` and `queueState` rather than written as a plain
 * object, because that is the only path a real merge-bead's block takes and it is where a
 * field name typed one way here and read another way there would show up.
 */
const state = (over = {}) => queueState({ notes: withQueueBlock('', over) });

/** A merge-bead, as `gatherMerges` hands one to `queues()`. */
const merge = (over = {}) => ({
  workspace: 'beadcause',
  id: 'bc-aaa.1',
  spec: { bead: 'bc-bbb.2', repo: 'adam/beadcause', number: 41, url: 'u/41', branch: 'b', base: 'main', ...over.spec },
  state: state(over.state || {}),
  ...(over.workspace ? { workspace: over.workspace } : {}),
  ...(over.id ? { id: over.id } : {}),
});

/** A board row, as lib/prboard.js assembles one: merged and on origin unless said otherwise. */
const row = (over = {}) => ({
  number: 41,
  title: 'a pull request',
  url: 'u/41',
  state: 'MERGED',
  merged: true,
  pushed: true,
  local: true,
  deployed: false,
  mergedAt: iso(30),
  mergeCommit: 'abcdef1234567890',
  beads: [{ id: 'bc-bbb.2', title: 'the work', status: 'open' }],
  ...over,
});

/** A deploy record, as lib/deploy.js writes one. */
const deploy = (over = {}) => ({ id: 'd1', key: 'beadcause', status: 'ok', startedAt: iso(10), ...over });

/** A board card, as `forRepo` builds one. */
const card = (over = {}) => ({
  key: 'beadcause',
  workspace: 'beadcause',
  repoName: null,
  repo: 'adam/beadcause',
  base: 'main',
  deployDeclared: true,
  deployTracked: false,
  error: null,
  prs: [],
  ...over,
});

/* ---------------------------------------------------------------- the merge ladder */

console.log('\nthe merge ladder — every rung off a state something actually writes\n');

check('a merge-bead nothing has touched is queued for merge', () => {
  assert.equal(mergeStageOf(state(), null), 'queued');
  assert.equal(mergeStageOf(state(), row({ state: 'OPEN', merged: false })), 'queued');
});

check('a downmerge shows as downmerging until its checks say something', () => {
  assert.equal(mergeStageOf(state({ downmerges: 1 }), null), 'downmerging');
  // …and the moment the re-run checks report, that is the newer fact.
  const running = row({ state: 'OPEN', merged: false, checks: { state: 'pending' } });
  assert.equal(mergeStageOf(state({ downmerges: 1 }), running), 'gate');
});

check('pending and failing checks are both the gate, because nothing has judged them yet', () => {
  for (const s of ['pending', 'failing']) {
    assert.equal(mergeStageOf(state(), row({ state: 'OPEN', merged: false, checks: { state: s } })), 'gate');
  }
});

check('a conflicted branch with a resolver on it is resolving conflicts', () => {
  // What lib/mergequeue.js writes on the conflicted path: the flag and the sentence.
  const s = state({ resolving: true, refused: 'the branch conflicts with its base' });
  assert.equal(mergeStageOf(s, null), 'conflicts');
  // And GitHub saying so is enough on its own, before anything has been written down.
  assert.equal(mergeStageOf(state(), row({ state: 'OPEN', merged: false, mergeable: 'CONFLICTING' })), 'conflicts');
});

check('the same flag with no refusal is an approval that was asked for, not a conflict', () => {
  // The awaitingApproval branch reuses `resolving` to mean "somebody has been asked" and
  // writes no refusal, because nothing refused: the checks are green and the space asks
  // for a review GitHub will not take from the author. Reading that as a conflict would
  // send you looking for a rebase that is not owed.
  assert.equal(mergeStageOf(state({ resolving: true }), null), 'issues');
});

check('a recorded refusal is resolving issues, and so is running out of attempts', () => {
  assert.equal(mergeStageOf(state({ attempts: 1, refused: 'a check main is passing is red here' }), null), 'issues');
  assert.equal(mergeStageOf(state({ attempts: MAX_ATTEMPTS }), null), 'issues');
});

check('a red check alone is not a refusal — only the tick may decide that', () => {
  // `gateVerdict` is the one thing allowed to say whether a red check is this branch's
  // fault, because `main` may already be failing it. Calling it `issues` here would
  // pre-empt that on every branch whose CI is red for a reason nobody has looked at.
  const red = row({ state: 'OPEN', merged: false, checks: { state: 'failing', failing: 1, failed: ['test'] } });
  assert.equal(mergeStageOf(state(), red), 'gate');
});

check('a held branch is not a branch with a problem — main is what is red', () => {
  // Both flags in one write, exactly as lib/mergequeue.js leaves the block.
  const s = state({ held: true, refused: '`main` is red (test), so the merge queue is holding — bc-arf8 is the fix.' });
  assert.equal(mergeStageOf(s, null), 'held');
  // Even mid-ladder: the hold is decided before anything else, so it outranks a downmerge
  // already in flight.
  assert.equal(mergeStageOf(state({ downmerges: 2, held: true, refused: 'x' }), null), 'held');
});

check('a pull request nobody has reviewed is waiting, not resolving issues', () => {
  const s = state({ reviewing: true, refused: 'waiting on a review: nothing has judged this yet' });
  assert.equal(mergeStageOf(s, null), 'review');
  assert.equal(mergeStageOf(state({ downmerges: 1, reviewing: true, refused: 'x' }), null), 'review');
});

check('every rung the ladder names is reachable, and no rung is named twice', () => {
  assert.deepEqual(MERGE_STAGE_IDS, ['queued', 'held', 'review', 'downmerging', 'conflicts', 'gate', 'issues']);
  assert.equal(new Set(MERGE_STAGE_IDS).size, MERGE_STAGES.length);
  const reached = new Set([
    mergeStageOf(state(), null),
    mergeStageOf(state({ held: true, refused: 'x' }), null),
    mergeStageOf(state({ reviewing: true, refused: 'x' }), null),
    mergeStageOf(state({ downmerges: 1 }), null),
    mergeStageOf(state({ resolving: true, refused: 'x' }), null),
    mergeStageOf(state(), row({ state: 'OPEN', merged: false, checks: { state: 'pending' } })),
    mergeStageOf(state({ attempts: MAX_ATTEMPTS }), null),
  ]);
  assert.deepEqual([...reached].sort(), [...MERGE_STAGE_IDS].sort());
});

check('every merge rung carries the sentence a card draws under it', () => {
  for (const s of MERGE_STAGES) assert.ok(s.label && s.note.length > 20, `${s.id} has no note`);
});

/* -------------------------------------------------------------- the release ladder */

console.log('\nthe release ladder — and the three rungs only a handover can fill\n');

check('a merge nobody has fetched is not in the release queue at all', () => {
  // `shippedState`'s rule: a deploy fast-forwards to origin/<base>, so a merge this Mac
  // has not seen there could not be carried by one.
  assert.equal(releaseStageOf(row({ pushed: null }), []), null);
  assert.equal(releaseStageOf(row({ pushed: false }), []), null);
  assert.equal(releaseStageOf(row({ merged: false, state: 'OPEN' }), []), null);
});

check('merged and on origin with no deploy running is merged', () => {
  assert.equal(releaseStageOf(row(), []), 'merged');
});

check('a deploy in flight puts it on the rung that deploy is on', () => {
  const at = iso(5);
  assert.equal(releaseStageOf(row(), [deploy({ status: 'building', startedAt: at })]), 'building');
  assert.equal(releaseStageOf(row(), [deploy({ status: 'deploying', startedAt: at })]), 'deploying');
  // `queued` and `pulling` are a deploy that has not started doing anything you could
  // watch, so the merge is still exactly where it was.
  assert.equal(releaseStageOf(row(), [deploy({ status: 'queued', startedAt: at })]), 'merged');
  assert.equal(releaseStageOf(row(), [deploy({ status: 'pulling', startedAt: at })]), 'merged');
});

check('a deploy that started before the merge is not carrying it', () => {
  assert.equal(releaseStageOf(row({ mergedAt: iso(5) }), [deploy({ status: 'building', startedAt: iso(30) })]), 'merged');
});

check('an ok deploy after the merge is live; failed and lost are not', () => {
  assert.equal(releaseStageOf(row(), [deploy({ status: 'ok' })]), 'live');
  assert.equal(releaseStageOf(row(), [deploy({ status: 'failed' })]), 'merged');
  assert.equal(releaseStageOf(row(), [deploy({ status: 'lost' })]), 'merged');
  // `unconfirmed` settles nothing for a repo whose running build is invisible — it is the
  // deploy journal saying the command ran with nobody left to report on it.
  assert.equal(releaseStageOf(row(), [deploy({ status: 'unconfirmed' })]), 'merged');
});

check('the running build is the strongest answer, and only beadcause can give it', () => {
  // A beadcause deploy SIGKILLs the process that asked for it, so its ordinary ending is
  // `unconfirmed`. What settles it is that the daemon answering you contains the merge.
  assert.equal(releaseStageOf(row({ deployed: true }), [deploy({ status: 'unconfirmed' })]), 'live');
});

check('the three handover rungs are untracked until a handover says otherwise', () => {
  const byHandover = RELEASE_STAGES.filter((s) => s.handover).map((s) => s.id);
  assert.deepEqual(byHandover, ['green', 'verifying', 'swapping']);
  // From every rung of the ladder, including the last one: a release the router recorded no
  // handover for stays untracked however far along it is, because the position it has
  // reached is not evidence that a health check ran.
  for (const id of RELEASE_STAGE_IDS) {
    const rungs = rungsFor(RELEASE_STAGES, id);
    for (const r of rungs.filter((x) => byHandover.includes(x.id))) {
      assert.equal(r.state, 'untracked', `${r.id} reads ${r.state} at stage ${id}`);
      assert.equal(r.at, null, `${r.id} carries a time nobody observed`);
    }
  }
});

check('and each one is done, with its own time, when the handover recorded it', () => {
  const observed = { green: iso(9), verifying: iso(8), swapping: iso(7) };
  const rungs = rungsFor(RELEASE_STAGES, 'live', observed);
  const by = Object.fromEntries(rungs.map((r) => [r.id, r]));
  for (const id of ['green', 'verifying', 'swapping']) {
    assert.equal(by[id].state, 'done', `${id} reads ${by[id].state}`);
    assert.equal(by[id].at, observed[id]);
  }
  // A rung the handover could not say anything about is still untracked, and is not filled
  // in from the two either side of it.
  const partial = rungsFor(RELEASE_STAGES, 'live', { swapping: iso(7) });
  assert.equal(partial.find((r) => r.id === 'verifying').state, 'untracked');
  assert.equal(partial.find((r) => r.id === 'swapping').state, 'done');
});

check('a positional rung behind the current one is done, ahead of it is pending', () => {
  const rungs = rungsFor(RELEASE_STAGES, 'deploying');
  const by = Object.fromEntries(rungs.map((r) => [r.id, r.state]));
  assert.equal(by.merged, 'done');
  assert.equal(by.building, 'done');
  assert.equal(by.deploying, 'now');
  assert.equal(by.live, 'pending');
});

check('a merge entry hands back the same ladder shape as a release entry', () => {
  // One card renderer draws both (bc-khoe.7). A card that had to know which queue it was
  // in to read its own payload would be two renderers wearing one name — so the `at` the
  // handover puts on a release rung is on every merge rung too, as null.
  const m = mergeEntry(merge(), null);
  assert.deepEqual(
    m.rungs.map((r) => Object.keys(r).sort()),
    m.rungs.map(() => ['at', 'id', 'label', 'note', 'state'])
  );
  const r = releaseEntry(row(), card(), [], {});
  assert.deepEqual(
    r.rungs.map((x) => Object.keys(x).sort()),
    r.rungs.map(() => ['at', 'id', 'label', 'note', 'state'])
  );
  assert.ok(m.rungs.every((r) => r.state !== 'untracked'), 'no merge rung waits on a handover');
  assert.ok(
    m.rungs.every((r) => r.at === null),
    'and none of them is observed, so none carries a time'
  );
});

/* ------------------------------------------------------------------ the handover */

console.log('\nthe handover — the three rungs the deploy journal cannot see\n');

/** A handover, as lib/handover.js records one at the promotion. */
const handover = (over = {}) => ({
  at: iso(4),
  spawnedAt: iso(6),
  healthyAt: iso(5),
  build: 'ab12cd34ef56',
  pid: 5150,
  port: 51999,
  reason: 'lib/ moved on disk',
  deploy: 'd1',
  ...over,
});

check('a release the router handed over puts a time under all three rungs', () => {
  const rec = deploy({ id: 'd1', status: 'ok' });
  const h = handover({ deploy: 'd1' });
  const e = releaseEntry(row(), card(), [rec], {}, [h]);
  assert.equal(e.stage, 'live');
  const by = Object.fromEntries(e.rungs.map((r) => [r.id, r]));
  assert.deepEqual(
    ['green', 'verifying', 'swapping'].map((id) => [by[id].state, by[id].at]),
    [
      ['done', h.spawnedAt],
      ['done', h.healthyAt],
      ['done', h.at],
    ]
  );
  // And the record itself, because which backend took over on which port is the sentence
  // you want when a swap is what you are looking into.
  assert.deepEqual(e.handover, { at: h.at, build: h.build, pid: h.pid, port: h.port });
});

check('a handover for another release says nothing about this one', () => {
  // The attribution is by deploy id, never by "the last swap that happened". The router
  // swaps on its own whenever `lib/` moves, so there are more handovers than releases.
  const e = releaseEntry(row(), card(), [deploy({ id: 'd1' })], {}, [handover({ deploy: 'd-somebody-else' })]);
  assert.equal(e.handover, null);
  assert.equal(e.rungs.find((r) => r.id === 'swapping').state, 'untracked');
});

check('a swap the router did on its own is attributed to no release at all', () => {
  // `deploy: null` is the ordinary case — `npm run swap` by hand, and every automatic one.
  // A release must not pick one of those up because it happens to be the only handover
  // there is.
  const e = releaseEntry(row(), card(), [deploy({ id: 'd1' })], {}, [handover({ deploy: null })]);
  assert.equal(e.handover, null);
});

check('the handover is the stronger evidence when the journal has not settled yet', () => {
  // A beadcause deploy SIGKILLs the runner that asked for it, so the record sits at
  // `deploying` from the kickstart until something sweeps it — while the new backend is
  // already the one every phone is talking to. `deploying` there is a sentence about
  // bookkeeping; the handover is a sentence about the port.
  const rec = deploy({ id: 'd1', status: 'deploying', startedAt: iso(6) });
  assert.equal(releaseStageOf(row(), [rec]), 'deploying');
  assert.equal(releaseStageOf(row(), [rec], [handover({ deploy: 'd1' })]), 'swapping');
  // It stops at swapping: what is *running* is a question for the board and the ledger.
  assert.equal(releaseStageOf(row({ deployed: true }), [rec], [handover({ deploy: 'd1' })]), 'live');
});

check('a handover cannot advance a release no deploy is carrying', () => {
  // Nothing in flight, so there is no deploy for a handover to be attributed to, and a
  // merge waiting for the settle window must not read as one that is being swapped in.
  assert.equal(releaseStageOf(row(), [], [handover({ deploy: 'd1' })]), 'merged');
  const settled = deploy({ id: 'd1', status: 'failed', startedAt: iso(6) });
  assert.equal(releaseStageOf(row(), [settled], [handover({ deploy: 'd1' })]), 'merged');
});

check('the whole answer carries the times, so a card needs nothing else', () => {
  const rec = deploy({ id: 'd1', status: 'ok' });
  const out = queues(
    { repos: [card({ prs: [row()] })] },
    { merges: [], deploys: [rec], ledger: {}, handovers: [handover({ deploy: 'd1' })] }
  );
  const entry = out.repos[0].release[0];
  assert.equal(entry.rungs.filter((r) => r.state === 'untracked').length, 0, 'nothing is untracked once it is observed');
  assert.equal(entry.handover.pid, 5150);
});

/* --------------------------------------------------------------------- the entries */

console.log('\nthe entries — each one naming its bead and its pull request\n');

check('a merge entry names both beads, because they answer different questions', () => {
  const e = mergeEntry(merge({ state: { attempts: 1, refused: 'GitHub said no' } }), card());
  assert.equal(e.bead, 'bc-bbb.2', 'the bead the work was for');
  assert.equal(e.mergeBead, 'bc-aaa.1', 'the queue’s own entry');
  assert.equal(e.number, 41);
  assert.equal(e.stage, 'issues');
  assert.equal(e.attemptsLeft, MAX_ATTEMPTS - 1);
  assert.equal(e.refused, 'GitHub said no');
});

check('a release entry names the work bead, the ship bead and the deploy', () => {
  const led = { beadcause: { handled: { 41: { bead: 'bc-ship.9' } } } };
  const rec = deploy({ id: 'd7', status: 'ok' });
  const e = releaseEntry(row(), card(), [rec], led);
  assert.equal(e.stage, 'live');
  assert.equal(e.bead, 'bc-bbb.2');
  assert.equal(e.shipBead, 'bc-ship.9');
  assert.deepEqual(e.deploy, { id: 'd7', status: 'ok', startedAt: rec.startedAt });
  assert.equal(e.sha, 'abcdef1');
});

check('a ship bead nobody filed is null rather than missing', () => {
  const e = releaseEntry(row(), card(), [deploy()], {});
  assert.equal(e.shipBead, null);
});

/* ------------------------------------------------------------ the two rules of what exists */

console.log('\nwhat exists at all — the two rules\n');

check('a repo with nothing to release gets no release entries', () => {
  const nothing = card({ deployDeclared: false, deployTracked: false, prs: [row()] });
  assert.equal(releasable(nothing), false);
  const out = queues({ repos: [nothing] }, { merges: [merge()], deploys: [], ledger: {} });
  assert.equal(out.repos[0].release.length, 0, 'a queue nothing could ever drain');
  assert.equal(out.repos[0].merge.length, 1, 'but its merge queue is still a merge queue');
  assert.equal(out.counts.release, 0);
});

check('and a repo it can only watch, never deploy, still releases', () => {
  // beadcause's own case before a declaration exists: nothing here can run a deploy, but
  // the running build answers whether a merge is live, so an entry can be drained.
  const watched = card({ deployDeclared: false, deployTracked: true, prs: [row()] });
  assert.equal(releasable(watched), true);
  const out = queues({ repos: [watched] }, { merges: [], deploys: [], ledger: {} });
  assert.equal(out.repos[0].release.length, 1);
});

check('an entry that went live in the previous release is still returned', () => {
  const rec = deploy({ id: 'd1', status: 'ok', startedAt: iso(20) });
  const next = deploy({ id: 'd2', status: 'ok', startedAt: iso(5) });
  const live = row({ mergedAt: iso(40) });
  // Newest first, as the journal is read.
  const out = queues({ repos: [card({ prs: [live] })] }, { merges: [], deploys: [next, rec], ledger: {} });
  assert.equal(out.repos[0].release.length, 1);
  assert.equal(out.repos[0].release[0].ago, 1, 'one release has gone out since the one that shipped it');
});

check('and one that went live two releases ago is not', () => {
  const rec = deploy({ id: 'd1', status: 'ok', startedAt: iso(30) });
  const next = deploy({ id: 'd2', status: 'ok', startedAt: iso(20) });
  const third = deploy({ id: 'd3', status: 'ok', startedAt: iso(5) });
  const live = row({ mergedAt: iso(40) });
  const out = queues({ repos: [card({ prs: [live] })] }, { merges: [], deploys: [third, next, rec], ledger: {} });
  assert.equal(out.repos[0].release.length, 0);
  assert.equal(KEEP_RELEASES, 1, 'the rule is one release, and it is written down once');
});

check('a deploy that failed is not a release, so it ages nothing out', () => {
  const rec = deploy({ id: 'd1', status: 'ok', startedAt: iso(30) });
  const broke = deploy({ id: 'd2', status: 'failed', startedAt: iso(20) });
  const lost = deploy({ id: 'd3', status: 'lost', startedAt: iso(10) });
  const live = row({ mergedAt: iso(40) });
  const out = queues({ repos: [card({ prs: [live] })] }, { merges: [], deploys: [lost, broke, rec], ledger: {} });
  assert.equal(out.repos[0].release.length, 1, 'nothing went live in either of those');
  assert.equal(out.repos[0].release[0].ago, 0);
});

check('live with no record of which release did it is history, not a queue entry', () => {
  // The other side of `entry.since` in lib/release.js. A first run finds three weeks of
  // merges live in the build that is running and no deploy record for any of them; calling
  // that "the current release" would put the lot on the board at once.
  const old = row({ deployed: true, mergedAt: iso(60 * 24 * 20) });
  const out = queues({ repos: [card({ deployTracked: true, prs: [old] })] }, { merges: [], deploys: [], ledger: {} });
  assert.equal(out.repos[0].release.length, 0);
  // …and the moment there is a record, it is placed and kept.
  const withRec = queues(
    { repos: [card({ deployTracked: true, prs: [old] })] },
    { merges: [], deploys: [deploy({ status: 'unconfirmed', startedAt: iso(5) })], ledger: {} }
  );
  assert.equal(withRec.repos[0].release[0].ago, 0);
});

check('a merge still waiting for a release is kept however long it waits', () => {
  const out = queues({ repos: [card({ prs: [row({ mergedAt: iso(60 * 24 * 14) })] })] }, { merges: [], deploys: [], ledger: {} });
  assert.equal(out.repos[0].release.length, 1);
  assert.equal(out.repos[0].release[0].ago, null, 'null is waiting, not aged out');
});

/* ------------------------------------------------------------------- one answer */

console.log('\none answer, keyed by repo\n');

check('both queues come back per repo, with a count over the lot', () => {
  const a = card({ key: 'climative/athena', workspace: 'climative', repo: 'Climative/athena', repoName: 'athena', prs: [row()] });
  const b = card({ key: 'climative/hermes', workspace: 'climative', repo: 'Climative/hermes', repoName: 'hermes', prs: [] });
  const m = merge({ workspace: 'climative', id: 'cl-1', spec: { repo: 'Climative/hermes', number: 7 } });
  const out = queues({ repos: [a, b] }, { merges: [m], deploys: [], ledger: {} });
  assert.deepEqual(
    out.repos.map((r) => r.key),
    ['climative/athena', 'climative/hermes']
  );
  assert.equal(out.repos[0].release.length, 1);
  assert.equal(out.repos[1].merge.length, 1, 'the slug is what placed it');
  assert.equal(out.repos[0].merge.length, 0, 'and not on the other forty');
  assert.deepEqual(out.counts, { merge: 1, release: 1 });
  assert.equal(out.repos[0].where, 'climative · athena');
});

check('a merge-bead naming a repo that is not on the board is an orphan, not a drop', () => {
  const out = queues({ repos: [card()] }, { merges: [merge({ spec: { repo: 'someone/else', number: 9 } })], deploys: [], ledger: {} });
  assert.equal(out.orphans.length, 1);
  assert.equal(out.orphans[0].number, 9);
  assert.equal(out.counts.merge, 1, 'an orphan is still in the queue');
  assert.equal(out.repos[0].merge.length, 0);
});

check('a bead with no slug lands on a workspace that is one repo, and orphans where it is forty', () => {
  const bare = merge({ spec: { repo: null, number: 3 } });
  const one = queues({ repos: [card()] }, { merges: [bare], deploys: [], ledger: {} });
  assert.equal(one.repos[0].merge.length, 1, 'the workspace name is the answer where it is the only repo');

  const many = queues(
    {
      repos: [
        card({ key: 'beadcause/a', repo: 'adam/a', repoName: 'a' }),
        card({ key: 'beadcause/b', repo: 'adam/b', repoName: 'b' }),
      ],
    },
    { merges: [bare], deploys: [], ledger: {} }
  );
  assert.equal(many.orphans.length, 1, 'a guess between two checkouts is worth less than a line');
  assert.equal(many.repos[0].merge.length + many.repos[1].merge.length, 0);
});

check('a repo whose card carries an error still shows its queues', () => {
  // The board puts a failure *in* the card rather than dropping it, and a repo whose `gh`
  // call failed is exactly the one whose merge queue you want to be able to see.
  const broken = card({ error: 'gh: could not reach GitHub', prs: [] });
  const out = queues({ repos: [broken] }, { merges: [merge()], deploys: [], ledger: {} });
  assert.equal(out.repos[0].error, 'gh: could not reach GitHub');
  assert.equal(out.repos[0].merge.length, 1);
});

check('a deploy of one repo says nothing about the thirty-nine beside it', () => {
  const a = card({ key: 'climative/athena', workspace: 'climative', repo: 'Climative/athena', repoName: 'athena', prs: [row()] });
  const b = card({ key: 'climative/hermes', workspace: 'climative', repo: 'Climative/hermes', repoName: 'hermes', prs: [row({ number: 8 })] });
  const out = queues({ repos: [a, b] }, { merges: [], deploys: [deploy({ key: 'climative/athena' })], ledger: {} });
  assert.equal(out.repos[0].release[0].stage, 'live');
  assert.equal(out.repos[1].release[0].stage, 'merged', 'a deploy of athena is not a deploy of hermes');
});

check('an empty board is an empty answer rather than a throw', () => {
  const out = queues(null, { merges: [], deploys: [], ledger: {} });
  assert.deepEqual(out.repos, []);
  assert.deepEqual(out.counts, { merge: 0, release: 0 });
});

/* ------------------------------------------------------------ against the real server */

console.log('\nand the door onto it, against the real server\n');

const wsdir = path.join(tmp, 'ws');
fs.mkdirSync(path.join(wsdir, '.beads'), { recursive: true });

// A `bd` that answers everything with an empty list. The claim here is the shape and the
// wiring — that the route exists, needs the token, and composes the two queues without
// throwing on a Mac where nothing is queued. What is *in* the queues is every check above.
const FAKE = path.join(tmp, 'bd');
fs.writeFileSync(FAKE, "#!/usr/bin/env node\nprocess.stdout.write('[]');\n", { mode: 0o755 });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'queues-token',
  actor: 'beadcause-test',
  bdBin: FAKE,
  workspaces: [{ name: 'demo', dir: wsdir }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import('../lib/server.js');
const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const get = (pathname, headers = { 'x-beadcause-token': cfg.token }) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (out += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, json: JSON.parse(out || '{}') }));
    });
    req.on('error', reject);
    req.end();
  });

const answered = await get('/api/queues');
check('GET /api/queues answers 200', () => assert.equal(answered.status, 200));
check('with both queues and a count over them', () => {
  assert.ok(Array.isArray(answered.json.repos), `got ${JSON.stringify(answered.json).slice(0, 160)}`);
  assert.ok(Array.isArray(answered.json.orphans));
  assert.deepEqual(Object.keys(answered.json.counts).sort(), ['merge', 'release']);
  // A workspace with no `gh` remote is the ordinary shape of this fixture, and it is an
  // answer rather than a 500 — the same rule every other board route keeps.
  assert.ok('unavailable' in answered.json);
  assert.ok(Array.isArray(answered.json.errors));
});
const bare = await get('/api/queues', {});
check('and it is behind the token like everything else under /api/', () => assert.equal(bare.status, 401));

for (const s of servers) s.close();
await cleanupTmp(tmp);

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32mall ${ran} checks passed\x1b[0m`}\n`);
process.exit(failures ? 1 : 0);
