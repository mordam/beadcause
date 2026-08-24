#!/usr/bin/env node
/**
 * The tick: one pass over the merge queue, driven through every state GitHub can be in.
 *
 *     npm test
 *     node test/mergequeue.mjs
 *
 * bc-r941.3 and bc-r941.4. `sweepMergeQueue` is the only thing on this Mac that merges to
 * `main` unattended and the only thing that closes a work bead, so what it must do and —
 * more importantly — what it must *not* do are both worth pinning one state at a time.
 *
 * Everything effectful is injected, which is why this suite needs no git server, no fake
 * `gh` on PATH and no tracker: the module takes `prApi`, `resolve`, `openResolver`,
 * `raise` and `afterMerge` as arguments for exactly this reason. What is under test is a
 * decision procedure, and a decision procedure asserted through a subprocess is one you
 * can only cover the happy path of.
 *
 * The four assertions that matter most, in the order they would hurt:
 *
 * 1. **A pending check costs no attempt.** The retry budget exists to carry a *refusal*
 *    towards a card. If waiting spent one, a pull request whose CI is slow would be
 *    handed to Adam three ticks after it was filed, with nothing wrong with it.
 * 2. **Both beads close, merge-bead first.** The work bead depends on the merge-bead, so
 *    the other order is refused by the close gate — and the order reads backwards, which
 *    is precisely why it needs a test rather than a comment.
 * 3. **An epic work bead does not close.** `landHere` in bin/deliver.js carved that out
 *    (bc-arj0.3) and the carve-out travelled here with the close. It is the assertion
 *    that would silently disappear in a refactor.
 * 4. **A refused close is written down.** lib/owed.js, and bc-ec6: a bead reported as
 *    closed over a close that bd refused is the failure mode that took an afternoon to
 *    see, because everything upstream said it had worked.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mergequeue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { sweepMergeQueue, describeMergeQueue, MERGES_PER_TICK, mergeReport } = await import(LIB('mergequeue.js'));
const { MERGE_LABEL, MERGE_ASSIGNEE, MAX_ATTEMPTS, MAX_REVIEW_ROUNDS, mergeBeadBody, queueState, reviewState, withQueueBlock, withReviewBlock } =
  await import(LIB('mergebead.js'));
const { MAX_DOWNMERGES } = await import(LIB('mergequeue.js'));
const { formatVerdict } = await import(LIB('reviewadvocate.js'));
const { raiseMergeCard } = await import(LIB('mergeraise.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\none tick of the merge queue\n');

/* ------------------------------------------------------------------ the world */

const SPEC = {
  workspace: 'demo',
  bead: 'zz-work',
  repo: 'acme/widgets',
  number: 42,
  url: 'https://github.com/acme/widgets/pull/42',
  branch: 'work-a',
  base: 'main',
  method: 'merge',
};

/** A merge-bead row, as `bd.listAgent` would hand one over. */
const bead = (over = {}, spec = {}, notes = '') => ({
  id: 'zz-merge',
  title: 'Merge #42 — zz-work',
  status: 'open',
  labels: [MERGE_LABEL],
  assignee: MERGE_ASSIGNEE,
  description: mergeBeadBody({ ...SPEC, ...spec }),
  notes,
  ...over,
});

/**
 * A tracker that records rather than one that pretends.
 *
 * `closes` in order is the assertion for the two-beads-in-one-order case, and `refuse`
 * lets one close fail the way bd's close gate fails — which is the only way to reach the
 * `oweClose` path without a real tracker.
 */
function fakeBd({ rows = [], issues = {}, refuse = null, comments = {} } = {}) {
  const calls = { closes: [], comments: [], updates: [], reads: [] };
  return {
    calls,
    listAgent: async () => rows,
    show: async (ws, id) => issues[id] || null,
    close: async (ws, id, reason) => {
      if (refuse && refuse(id)) throw new Error(`cannot close ${id}: blocked by open issues [zz-blocker]`);
      calls.closes.push({ id, reason });
    },
    comment: async (ws, id, text) => calls.comments.push({ id, text }),
    update: async (ws, id, patch) => calls.updates.push({ id, ...patch }),
    // A merge-bead's comments — where a ReviewAdvocate's verdict actually lives
    // (bc-36xx.22). Empty for any id nobody stocked, which is every id in every test that
    // is not itself about folding a verdict in.
    comments: async (ws, id) => {
      calls.reads.push(id);
      return comments[id] || [];
    },
  };
}

/** A `gh` that answers with whatever state this scenario is about. */
const fakePr = (
  view,
  {
    merge = null,
    base = { failed: [] },
    update = { updated: true, reason: '' },
    comment = null,
    // bc-36xx.22: a second GitHub account nobody promised is the ordinary case, so the
    // default here is the one `reviewerFor` gives on a one-login Mac — null.
    reviewer = null,
    approve = { submitted: true, reviewer: 'NeanderthalMan', url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-1', at: '2026-08-23T00:00:00Z' },
    submitReview = { submitted: true, reviewer: 'NeanderthalMan', url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-1', at: '2026-08-23T00:00:00Z' },
  } = {}
) => {
  const calls = { merges: [], updates: [], comments: [], approvals: [], reviews: [] };
  return {
    calls,
    view: async () => view,
    baseChecks: async () => base,
    /**
     * bc-kan5f's report, and the reason it is opt-in rather than always here: `finish`
     * guards on `prApi?.comment`, so a scenario that is not about the report gets a
     * `prApi` without one and exercises the path every caller had before this landed.
     * Pass `comment: new Error(...)` to be the pull request that will not take it.
     */
    comment: async (dir, n, text) => {
      calls.comments.push({ dir, n, text });
      if (comment instanceof Error) throw comment;
    },
    updateBranch: async (dir, n) => {
      calls.updates.push(n);
      return update;
    },
    merge: async (dir, n, opts) => {
      calls.merges.push({ n, ...opts });
      if (merge instanceof Error) throw merge;
      return merge || { mergeCommit: 'abcdef1234' };
    },
    /** Who would review — `reviewerFor`, lib/pr.js. `null` is the one-login Mac. */
    reviewerFor: async () => reviewer,
    /** A bare approval — `approve`, lib/pr.js. */
    approve: async (dir, n, opts) => {
      calls.approvals.push({ dir, n, ...opts });
      return approve;
    },
    /** A review that may carry inline comments — `submitReview`, lib/pr.js. */
    submitReview: async (dir, n, opts) => {
      calls.reviews.push({ dir, n, ...opts });
      return submitReview;
    },
  };
};

const GREEN = { failed: [], failing: 0, pending: 0, total: 3, state: 'passing' };
const HEAD = 'aaaaaaa1';
const openPr = (over = {}) => ({
  state: 'OPEN',
  mergeable: 'MERGEABLE',
  mergeState: 'CLEAN',
  checks: GREEN,
  reviewDecision: null,
  mergedAt: null,
  // What is at the tip of the branch — the field the review gate compares an approval
  // against (bc-36xx.4). Every scenario below that is not about the review leaves it alone.
  headSha: HEAD,
  ...over,
});

const resolve = async () => ({ unit: { key: 'demo/widgets' }, dir: '/tmp/widgets', reason: '' });

const run = (bd, prApi, opts = {}) =>
  sweepMergeQueue(bd, { name: 'demo' }, { resolve, prApi, ...opts });

/* ------------------------------------------------------------- the happy path */

await check('a green, clean, up-to-date pull request merges', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(prApi.calls.merges.length, 1);
  assert.equal(prApi.calls.merges[0].method, 'merge', 'it merged with a method the bead did not ask for');
});

await check('and never with --delete-branch, which the worktree sweep depends on', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  await run(bd, prApi);
  // lib/tidy.js finds out a pull request landed by asking about its branch, so the
  // branch outliving the merge is load-bearing — the same argument bin/deliver.js made
  // when the merge was there.
  assert.equal(prApi.calls.merges[0].deleteBranch, false);
});

await check('BOTH BEADS CLOSE, AND THE MERGE-BEAD GOES FIRST', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(bd, fakePr(openPr()));
  // The work bead depends on the merge-bead, so the other order is refused by the close
  // gate. It reads backwards — "close the work, then tidy up the queue entry" — which is
  // exactly why it is pinned.
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
  assert.match(bd.calls.closes[1].reason, /#42/, 'the work bead closed without saying what landed');
});

await check('and the sweep behind it runs, with the local main brought up', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const after = [];
  await run(bd, fakePr(openPr()), { afterMerge: async (entry, landed, where) => after.push({ id: entry.issue.id, dir: where.dir }) });
  // What `landHere` in bin/deliver.js used to do and why: this Mac's `main` is a commit
  // behind until something fetches, and every other open branch is now measured against
  // a base it has never seen (lib/mergesweep.js).
  assert.deepEqual(after, [{ id: 'zz-merge', dir: '/tmp/widgets' }]);
});

await check('a sweep that throws cannot un-merge what has merged', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    afterMerge: async () => {
      throw new Error('no checkout');
    },
  });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

/* ------------------------------------------------------------- bc-y738, live */

await check('a red check the base also has still merges, and the close says what it merged over', async () => {
  const red = openPr({ checks: { failed: ['test/reenter.mjs'], failing: 1, pending: 0, total: 3, state: 'failing' } });
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(red, { base: { failed: ['test/reenter.mjs'] } }));
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.match(bd.calls.closes[0].reason, /already failing: test\/reenter\.mjs/, 'it merged over a red check in silence');
});

await check('a red check the base does not have refuses, and spends an attempt', async () => {
  const red = openPr({ checks: { failed: ['lint'], failing: 1, pending: 0, total: 3, state: 'failing' } });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(red, { base: { failed: ['test/reenter.mjs'] } }));
  assert.deepEqual(out.refused, ['zz-merge']);
  assert.deepEqual(bd.calls.closes, [], 'it closed a bead over a merge that did not happen');
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.ok(written, 'nothing was written back, so the next tick starts from zero');
  assert.equal(queueState({ notes: written.notes }).attempts, 1);
  assert.match(queueState({ notes: written.notes }).refused, /lint/);
});

/* ---------------------------------------------------------------- the waits */

await check('A PENDING CHECK COSTS NO ATTEMPT — the budget is for refusals', async () => {
  const pending = openPr({ checks: { failed: [], failing: 0, pending: 2, total: 3, state: 'pending' } });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(pending));
  assert.deepEqual(out.waiting, ['zz-merge']);
  assert.deepEqual(out.refused, []);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(written, undefined, 'waiting spent an attempt, so slow CI reaches Adam as a failure');
});

await check('a behind branch is downmerged, and the tick stops there', async () => {
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({ rows: [bead()] });
  const prApi = fakePr(behind);
  const out = await run(bd, prApi);
  assert.deepEqual(out.updated, ['zz-merge']);
  assert.deepEqual(prApi.calls.updates, [42]);
  // Judging the checks now would be judging a diff that is being replaced as we look at
  // it: the update re-runs them against what is actually going to land.
  assert.equal(prApi.calls.merges.length, 0, 'it merged on the strength of checks that ran before the downmerge');
});

await check('AND IT STOPS DOWNMERGING RATHER THAN CHASING A BASE THAT KEEPS MOVING', async () => {
  // The one way this loop could starve a pull request forever: on a busy afternoon `main`
  // moves faster than CI finishes, so a queue that unconditionally downmerged-and-waited
  // would hand each branch a fresh base every tick and never once get as far as judging
  // it. Every individual tick would look sensible, which is what makes it hard to notice.
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({
    rows: [bead({ notes: withQueueBlock('', { attempts: 0, downmerges: MAX_DOWNMERGES }) })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(behind);
  const out = await run(bd, prApi);
  assert.equal(prApi.calls.updates.length, 0, 'it downmerged a fourth time');
  assert.deepEqual(out.merged, ['zz-merge'], 'and it never got as far as judging the branch');
});

await check('a downmerge is counted apart from an attempt — being unlucky is not being refused', async () => {
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({ rows: [bead()] });
  await run(bd, fakePr(behind));
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(queueState({ notes: written.notes }).downmerges, 1);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'a downmerge spent one of the three attempts');
});

await check('and a downmerge GitHub refuses is a wait, not an attempt', async () => {
  const behind = openPr({ mergeState: 'BEHIND' });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(behind, { update: { updated: false, reason: 'the base moved under it' } }));
  assert.deepEqual(out.waiting, ['zz-merge']);
  assert.equal(bd.calls.updates.length, 0);
});

/* --------------------------------------------------- taking a card back (bc-91srt) */

/**
 * The behavioural half of `cardedFor`. A carded bead is not in `queued` at all, so nothing
 * below the reclaim can reach it — which is exactly how #475 sat for a day with a green
 * check, and #433 and #438 sat conflicting with checks that passed.
 *
 * The bead is built by hand rather than through `raiseMergeCard` so the test states the
 * shape it depends on: `merge-queue` off, `human` and the delivery label on, and a
 * sentence in the queue block saying what the queue gave up over.
 */
const CARDED = ['human', 'pr-delivery'];

await check('a card whose check has gone green is taken back, with its attempts reset', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  const out = await run(bd, fakePr(openPr()));

  assert.deepEqual(out.restored, ['zz-merge'], 'it came back');
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.ok(written, 'and the bead was written');
  assert.deepEqual(written.addLabels, ['merge-queue'], 'the label the queue selects on is put back');
  assert.deepEqual(written.removeLabels, ['human', 'pr-delivery'], 'and the card comes out of the inbox');
  const state = queueState({ notes: written.notes });
  assert.equal(state.attempts, 0, 'a fresh budget — the old one was spent on a reason that has gone');
  assert.equal(state.refused, null, 'and the sentence with it');
  assert.equal(state.reclaims, 1, 'counted, because a flapping check must not do this for ever');
  // The line every other reclaim here draws: this says the queue may act, never that Adam
  // approved anything.
  assert.equal(state.approved, false, 'taking a card back must not fabricate an approval');
});

await check('a card that still conflicts is taken back too — that is the one thing the queue fixes', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: 'the branch conflicts with `main`.' }) })],
  });
  const out = await run(bd, fakePr(openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' })));
  assert.deepEqual(out.restored, ['zz-merge'], 'a conflict is work for a resolver, not a decision for Adam');
});

await check('a card whose check is still red stays a card', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  const red = { failed: ['test'], failing: 1, pending: 0, total: 3, state: 'failing' };
  const out = await run(bd, fakePr(openPr({ checks: red })));
  assert.deepEqual(out.restored, [], 'the handover was right and it stands');
  assert.equal(bd.calls.updates.length, 0, 'and nothing is written over it');
});

await check('and one already taken back too often is left alone, out loud', async () => {
  const said = [];
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, reclaims: 3, refused: '1 check failing (test).' }) })],
  });
  const out = await run(bd, fakePr(openPr()), { log: (l) => said.push(l) });
  assert.deepEqual(out.restored, [], 'the cap holds');
  assert.ok(
    said.some((l) => /taken back 3 times already/.test(l)),
    `a cap nobody is told about reads as the feature not working — said: ${said.join(' | ')}`
  );
});

await check('a merged pull request is never taken back, whatever its card says', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  const out = await run(bd, fakePr(openPr({ state: 'MERGED' })));
  assert.deepEqual(out.restored, []);
});

/* ------------------------------------------------------------ the conflict */

await check('a conflicted branch opens a resolver rather than being retried', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead()] });
  const seen = [];
  const out = await run(bd, fakePr(dirty), { openResolver: async (entry, dir) => (seen.push(dir), true) });
  assert.deepEqual(out.raised, ['zz-merge']);
  assert.deepEqual(seen, ['/tmp/widgets']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  // Marked, so the next tick leaves it alone: lib/resolvers.js allows one window per pull
  // request and a queue that picked it up again would open the second.
  assert.equal(queueState({ notes: written.notes }).resolving, true);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'opening a resolver spent an attempt');
});

await check('and one already being resolved is left alone while it still conflicts', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const prApi = fakePr(dirty);
  const out = await run(bd, prApi, { openResolver: async () => true });
  assert.equal(out.queued, 0);
  assert.equal(prApi.calls.merges.length, 0);
  // And no second window: the flag is what lib/resolvers.js's one-per-pull-request rule
  // looks like from in here, and a resolver still in that tree is bc-utyr waiting to happen.
  assert.deepEqual(out.reclaimed, []);
});

/**
 * bc-91ft, and the assertion that fails against the version that shipped.
 *
 * `resolving` was written when the window opened and nothing anywhere wrote it back, so a
 * branch the resolver had *fixed* — pushed, green, MERGEABLE — stayed invisible to the
 * queue until Adam approved it a second time. This is that exact state: flagged bead,
 * clean pull request. It has to merge.
 */
await check('A BRANCH ITS RESOLVER FIXED COMES BACK ON ITS OWN, WITH NO SECOND APPROVAL', async () => {
  const bd = fakeBd({
    rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true, refused: 'the branch conflicts with its base' }) })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  assert.deepEqual(out.reclaimed, ['zz-merge']);
  assert.equal(out.queued, 1);
  assert.equal(prApi.calls.merges.length, 1, 'the queue still could not see a branch its resolver had fixed');
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  const state = queueState({ notes: written.notes });
  assert.equal(state.resolving, false);
  // The sentence went with the state it was about — `admittedState`'s reasoning, and the
  // reason a reclaimed bead does not read as one that is still refusing to merge.
  assert.equal(state.refused, null);
  // The budget is untouched: reclaiming is not an attempt, and a bead that came back with
  // one attempt already spent must not arrive looking like a fresh one either.
  assert.equal(state.attempts, 1);
});

await check('and an unreadable pull request leaves the flag exactly where it is', async () => {
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const prApi = fakePr(openPr());
  prApi.view = async () => {
    throw new Error('gh: API rate limit exceeded');
  };
  const out = await run(bd, prApi);
  // Unknown is not "the resolver finished". A rate limit costs a tick; the other direction
  // merges a branch somebody may still be mid-merge in.
  assert.deepEqual(out.reclaimed, []);
  assert.equal(prApi.calls.merges.length, 0);
  assert.equal(bd.calls.updates.length, 0, 'it rewrote the state block over an answer it never got');
});

await check('a conflict with nowhere to open a window is a refusal that says so', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead()] });
  const out = await run(bd, fakePr(dirty), { openResolver: async () => false });
  assert.deepEqual(out.refused, ['zz-merge']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.match(queueState({ notes: written.notes }).refused, /conflicts with/);
});

/* ------------------------------------------- the window that delivered it */

await check('THE WINDOW THAT DELIVERED IT IS TOLD ITS BRANCH LANDED', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const marked = [];
  await run(bd, fakePr(openPr()), { markMerged: async (id) => marked.push(id) });
  // The *work* bead, not the merge-bead: the window is named after the work, and its
  // name is the only thing tying a session to a bead (lib/reap.js `namesBead`). The
  // worker renamed itself `QUEUED-` when it handed the branch over, which was all it
  // could honestly claim; this is the moment anything knows better.
  assert.deepEqual(marked, ['zz-work']);
});

await check('and it happens before the closes, because the reaper is right behind them', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const order = [];
  const bdSpy = { ...bd, close: async (...a) => { order.push(`close ${a[1]}`); return bd.close(...a); } };
  await run(bdSpy, fakePr(openPr()), { markMerged: async (id) => order.push(`rename ${id}`) });
  // Closing the work bead is what makes the window reapable — `sweepCandidate` wants a
  // finished name and a closed bead. Rename after the close and the race is real: the
  // window can be gone before it is told what happened to its branch.
  assert.equal(order[0], 'rename zz-work', `renamed too late — ${order.join(', ')}`);
});

await check('an epic window is renamed too, even though its bead stays open', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'epic' } } });
  const marked = [];
  await run(bd, fakePr(openPr()), { markMerged: async (id) => marked.push(id) });
  // The prefix is a claim about the *session*, not about the bead's lifecycle. The epic
  // stays open because its theme is not done; the window that wrote the branch is just
  // as finished as any other, and one left saying `QUEUED-` reads as still waiting on a
  // queue that is done with it.
  assert.deepEqual(marked, ['zz-work']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge']);
});

await check('a rename that throws cannot un-merge what has merged', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    markMerged: async () => {
      throw new Error('no ~/.claude here');
    },
  });
  // Same argument the sweep above makes: a window wearing the wrong name is a cosmetic
  // fault, and a merge that reports itself as not having happened is not.
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

await check('a pull request merged outside the queue renames it too', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const marked = [];
  // Adam tapping merge on his phone is the ordinary way this happens, and the window is
  // no less finished for the queue not having been the one to press it.
  const prApi = fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-15T12:00:00Z', mergeCommit: 'abcdef123456' }));
  await run(bd, prApi, { markMerged: async (id) => marked.push(id) });
  assert.deepEqual(marked, ['zz-work']);
});

/* -------------------------------------------------------------- the epic */

await check('AN EPIC WORK BEAD DOES NOT CLOSE ON A MERGE', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'epic' } } });
  await run(bd, fakePr(openPr()));
  // bc-arj0.3, carried over from `landHere`: an epic is finished when its theme is, and a
  // branch that shared its name merging is no evidence about that.
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge'], 'the epic closed on a branch merging');
  assert.ok(
    bd.calls.comments.some((c) => c.id === 'zz-work' && /stays \*\*open\*\*/.test(c.text)),
    'and nothing on it says why it is still open'
  );
});

/* ---------------------------------------------- a close bd will not take */

await check('a refused close is written down, not reported as done', async () => {
  const owedPath = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'owed-closes.json');
  fs.rmSync(owedPath, { force: true });
  const bd = fakeBd({
    rows: [bead()],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    refuse: (id) => id === 'zz-work',
  });
  await run(bd, fakePr(openPr()));
  const owed = fs.existsSync(owedPath) ? JSON.parse(fs.readFileSync(owedPath, 'utf8')) : {};
  assert.ok(Object.keys(owed).some((k) => k.endsWith('zz-work')), `nothing was written down: ${JSON.stringify(owed)}`);
  assert.ok(
    bd.calls.comments.some((c) => c.id === 'zz-work' && /did \*\*not\*\* close/.test(c.text)),
    'and the bead was not told, so it reads as closed work that is open'
  );
});

/* ------------------------------------------------------- already gone */

await check('a pull request merged on github.com finishes the bookkeeping', async () => {
  const bd = fakeBd({
    rows: [bead()],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-14T10:00:00Z', mergeCommit: 'deadbeef99' }));
  const out = await run(bd, prApi);
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(prApi.calls.merges.length, 0, 'it tried to merge a pull request that was already merged');
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

await check('and one closed without merging closes the queue entry only', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr({ state: 'CLOSED' })));
  // A decline puts the work back in the queue. Closing the work bead here would be
  // recording as finished the one outcome that means "start again".
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge']);
  assert.deepEqual(out.merged, []);
});

/* ------------------------------------------------------------ handing over */

await check('one out of attempts is handed over before anything else in the tick', async () => {
  const spent = bead({ id: 'zz-stuck', notes: withQueueBlock('', { attempts: MAX_ATTEMPTS, refused: 'lint is red.' }) });
  const bd = fakeBd({ rows: [spent] });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), { raise: async (entry, why) => (raised.push({ id: entry.issue.id, why }), true) });
  assert.deepEqual(out.raised, ['zz-stuck']);
  assert.match(raised[0].why, /3 times/);
  assert.match(raised[0].why, /lint is red/, 'the card does not carry what actually stopped it');
});

await check('and so is one whose block will not parse — silence is the failure this replaces', async () => {
  const broken = bead({ id: 'zz-broken', description: '```beadpr\n: : nope : :\n```' });
  const bd = fakeBd({ rows: [broken] });
  const raised = [];
  await run(bd, fakePr(openPr()), { raise: async (entry, why) => (raised.push(why), true) });
  assert.equal(raised.length, 1);
  assert.ok(raised[0], 'it was handed over with no sentence saying why');
});

await check('a missing approval is raised once, not every tick', async () => {
  const bd = fakeBd({ rows: [bead()] });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: { requireApproval: true },
    raise: async (entry, why, opts) => (raised.push(opts), true),
  });
  assert.deepEqual(out.waiting, ['zz-merge']);
  assert.equal(raised.length, 1);
  assert.equal(raised[0].approval, true, 'a wait was raised as a refusal');
  // Marked, so the second tick does not file the same card again.
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(queueState({ notes: written.notes }).resolving, true);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'waiting for a human spent an attempt');
});

await check('no checkout for the repo is a refusal that names the repo', async () => {
  const bd = fakeBd({ rows: [bead()] });
  const out = await sweepMergeQueue(bd, { name: 'demo' }, {
    resolve: async () => ({ unit: null, dir: '', reason: 'no approved demo repo is acme/widgets' }),
    prApi: fakePr(openPr()),
  });
  assert.deepEqual(out.refused, ['zz-merge']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.match(queueState({ notes: written.notes }).refused, /acme\/widgets/);
});

/* ------------------------------------------------------------- the limit */

await check('a tick merges at most MERGES_PER_TICK, and says what it left', async () => {
  const rows = [bead({ id: 'zz-m1' }), bead({ id: 'zz-m2' }), bead({ id: 'zz-m3' })];
  const bd = fakeBd({
    rows,
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  // Every merge moves the base under every other branch in the queue, so the third would
  // be judged against checks that ran two merges ago — the stale baseline this whole
  // queue exists to fix, reintroduced inside one pass.
  assert.equal(prApi.calls.merges.length, MERGES_PER_TICK);
  assert.equal(out.merged.length, MERGES_PER_TICK);
  assert.ok(out.waiting.includes('zz-m3'), 'the one it did not get to is not reported at all');
});

/* ---------------------------------------------------- the base is red (bc-arf8) */

/**
 * The hold. `holdFor` is the seam lib/server.js hangs lib/redbase.js off, and what these
 * pin is not the decision — test/redbase.mjs does that — but the *shape of the wait*:
 * nothing merges, nothing is spent, nothing is handed over, and the one pull request that
 * can end the hold still goes through.
 */
const HOLD = { bead: 'zz-hold', key: 'demo/widgets', base: 'main', failed: ['test/reenter.mjs'] };
const holding = () => async () => HOLD;

await check('A RED BASE HOLDS THE MERGE RATHER THAN LANDING ON TOP OF IT', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi, { holdFor: holding() });
  // The whole bead: on 2026-08-17 `main` was red from 13:49 and ten merges landed on top
  // of it, each inheriting the red, because the gate only ever asked whether the *branch*
  // broke something.
  assert.equal(prApi.calls.merges.length, 0, 'it merged onto a red base');
  assert.deepEqual(out.held, ['zz-merge']);
  assert.deepEqual(out.merged, []);
  assert.deepEqual(bd.calls.closes, [], 'a held pull request closed a bead');
});

await check('and it costs no attempt, because nothing was refused', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(bd, fakePr(openPr()), { holdFor: holding() });
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  const state = queueState({ notes: written.notes });
  // A hold is a wait exactly as a pending check is: the retry budget carries *refusals*
  // towards a card, and a base that is red for three ticks is not three strikes against
  // a branch that has done nothing.
  assert.equal(state.attempts, 0);
  assert.match(state.refused, /is red/, 'the state block does not say why it is sitting there');
  assert.match(state.refused, /zz-hold/, 'and it does not name the bead that is the fix');
});

await check('AND IT IS NOT HANDED OVER — raiseMergeCard is a one-way door', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), {
    holdFor: holding(),
    raise: async (entry) => {
      raised.push(entry.issue.id);
      return true;
    },
  });
  // `raiseMergeCard` takes `merge-queue` off the bead, which is a handover to Adam. A
  // hold that raised would turn a two-minute red into a queue full of pull requests that
  // never come back on their own — the exact opposite of a hold that lifts by itself.
  assert.deepEqual(raised, []);
  assert.deepEqual(out.raised, []);
});

await check('THE FIX ITSELF STILL MERGES, OR THE REPO WEDGES', async () => {
  // The deadlock the bead was written around: the pull request that fixes the base has to
  // land while the hold is on. `exemptFrom` is the one exemption and this is it end to end.
  const rows = [bead({ id: 'zz-merge' }, { bead: 'zz-hold' })];
  const bd = fakeBd({ rows, issues: { 'zz-hold': { id: 'zz-hold', issue_type: 'bug' } } });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi, { holdFor: holding() });
  assert.equal(prApi.calls.merges.length, 1, 'the fix for the red base was held by its own hold');
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(out.held, []);
});

await check('a hold does not stop a pull request that already went from closing its beads', async () => {
  // Before the hold in the order of the loop, and deliberately: Adam merging the fix from
  // the pull request board is the escape hatch the bead's own body points at, and a hold
  // that swallowed it would strand exactly that merge.
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-18T09:00:00Z', mergeCommit: 'feedface99' })), {
    holdFor: holding(),
  });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

await check('and it stops the downmerge too, not only the merge', async () => {
  // Bringing a red base into a branch re-runs its checks against a base that is about to
  // move again the moment the fix lands. The wait is cheaper than the CI.
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr({ mergeState: 'BEHIND' }));
  const out = await run(bd, prApi, { holdFor: holding() });
  assert.equal(prApi.calls.updates.length, 0);
  assert.deepEqual(out.held, ['zz-merge']);
});

await check('and no resolver is opened on a conflict nobody could merge anyway', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const opened = [];
  const out = await run(bd, fakePr(openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' })), {
    holdFor: holding(),
    openResolver: async (entry) => {
      opened.push(entry.issue.id);
      return true;
    },
  });
  // A resolver is one of the two windows this Mac has. Spending one on a rebase that will
  // need doing again after the fix lands is the wrong use of it.
  assert.deepEqual(opened, []);
  assert.deepEqual(out.held, ['zz-merge']);
});

await check('the state block is written once, not on every tick of a long red', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(bd, fakePr(openPr()), { holdFor: holding() });
  const first = bd.calls.updates.find((u) => u.id === 'zz-merge');
  // Second tick, same hold, and the bead already carries the sentence.
  const again = fakeBd({ rows: [bead({}, {}, first.notes)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(again, fakePr(openPr()), { holdFor: holding() });
  assert.deepEqual(out.held, ['zz-merge']);
  assert.deepEqual(again.calls.updates, [], 'a base red for an hour is 120 writes per bead');
});

await check('AND THE SENTENCE IS TAKEN BACK ON THE TICK THE HOLD LIFTS', async () => {
  // The one refusal the queue has to withdraw. Everything else here is overwritten by the
  // next verdict on the same branch; a branch that was only ever *held* has had no verdict,
  // so `main is red` would sit on it reading as this branch's own problem — and draw it as
  // "Resolving issues" on the queues board — until the base came back AND something judged
  // it. Held on one tick, green on the next.
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(bd, fakePr(openPr()), { holdFor: holding() });
  const notes = bd.calls.updates.find((u) => u.id === 'zz-merge').notes;
  assert.equal(queueState({ notes }).held, true);

  const after = fakeBd({ rows: [bead({}, {}, notes)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const out = await run(after, prApi, { holdFor: async () => null });
  const cleared = after.calls.updates.find((u) => u.id === 'zz-merge');
  assert.ok(cleared, 'the hold sentence was left on a bead nothing is holding');
  assert.equal(queueState({ notes: cleared.notes }).held, false);
  assert.equal(queueState({ notes: cleared.notes }).refused, null);
  // And it is judged on the same pass rather than waiting a further tick.
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(prApi.calls.merges.length, 1);
});

await check('a holdFor that throws holds nothing — the queue is not the base watch', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi, {
    holdFor: async () => {
      throw new Error('gh: rate limited');
    },
  });
  // The safe direction here is the *opposite* of the one lib/redbase.js takes about
  // filing: a watch that cannot answer must not stop a queue that is otherwise working,
  // because the gate below it still refuses anything the branch itself broke.
  assert.equal(prApi.calls.merges.length, 1);
  assert.deepEqual(out.held, []);
});

/* ----------------------------------------------------------------- the note */

await check('the line it hands the card says what happened, or nothing at all', async () => {
  assert.equal(describeMergeQueue({ ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [] }), '');
  assert.match(describeMergeQueue({ ok: true, merged: ['a'], updated: [], refused: ['b'], raised: [], waiting: [] }), /merged 1/);
  // A tick whose only news is a branch coming back from its resolver still has news.
  assert.match(
    describeMergeQueue({ ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [], reclaimed: ['a'] }),
    /back from a resolver/
  );
  // And a tick whose only news is that it is holding: "0 merged" is not a sentence, and
  // a queue that says nothing while the base is red is the state bc-arf8 replaces.
  assert.match(
    describeMergeQueue({ ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [], held: ['a', 'b'] }),
    /2 held — the base is red/
  );
  assert.match(describeMergeQueue({ ok: false, reason: 'bd list failed' }), /bd list failed/);
});

/* ============================================================== the review gate

   bc-36xx.4. test/reviewgate.mjs pins the decision as a pure function; these are the
   same decisions reaching `main` — what the sweep actually does about each one, and
   which of the things below it it declines to do first.
*/

/** A merge-bead carrying a review block, and optionally the queue's own state. */
const reviewed = (rev, queue = null) => bead({}, {}, withReviewBlock(queue ? withQueueBlock('', queue) : '', rev));
const REVIEW_ON = { reviewRequired: true };
const APPROVED = { round: 1, verdict: 'approved', reviewer: 'somebody', reviewedSha: HEAD, approvedBy: 'somebody' };

await check('NOTHING WITH NO VERDICT ON IT IS MERGED, OR EVEN DOWNMERGED', async () => {
  const bd = fakeBd({ rows: [reviewed({ round: 0 })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr({ mergeState: 'BEHIND' }));
  const out = await run(bd, prApi, { policy: REVIEW_ON });
  assert.deepEqual(out.merged, [], 'it merged a pull request nothing had reviewed');
  // And it did not bring the base in either. The gate sits above the downmerge on
  // purpose: updating the branch re-runs its checks and moves the diff under the
  // reviewer, for a merge that is not going to happen this tick anyway.
  assert.deepEqual(prApi.calls.updates, []);
  assert.deepEqual(out.awaiting, ['zz-merge']);
  // A wait, so no attempt is spent — the same rule a pending check gets.
  assert.equal(queueState({ notes: bd.calls.updates.at(-1).notes }).attempts, 0);
  assert.match(bd.calls.updates.at(-1).notes, /waiting on a review/);
});

await check('and an approval for the commit on the branch lets it through', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON });
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('a pull request with no work bead behind it is not review-gated at all', async () => {
  // Scope: a merge-bead with a work bead came through bin/deliver.js. One without is a
  // pull request Adam opened himself, and it goes to the queue exactly as it did before.
  const bd = fakeBd({ rows: [bead({}, { bead: null })] });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON });
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('nor is one Adam has already admitted', async () => {
  const bd = fakeBd({
    rows: [reviewed({ round: 0 }, { attempts: 0, approved: true, approvedBy: 'adam' })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON });
  assert.deepEqual(out.merged, ['zz-merge'], '/merge is what unsticks this queue, and the gate must not take it away');
});

await check('THE TWO GATES ARE IN SERIES AND NEITHER SUBSTITUTES FOR THE OTHER', async () => {
  // Reviewed, and the space does not ask for Adam: it merges.
  let bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  assert.deepEqual((await run(bd, fakePr(openPr()), { policy: REVIEW_ON })).merged, ['zz-merge']);

  // Reviewed, and the space *does*: the agent's approval is necessary and not sufficient,
  // so it stops at `gateVerdict`'s approval branch and asks him. Adam's answer to bc-0cop.
  bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const asked = [];
  let out = await run(bd, fakePr(openPr()), {
    policy: { ...REVIEW_ON, requireApproval: true },
    raise: async (entry, why, opts) => {
      asked.push(opts);
      return true;
    },
  });
  assert.deepEqual(out.merged, []);
  assert.deepEqual(asked.map((o) => o.approval), [true], 'it did not ask him, or asked for the wrong thing');

  // Unreviewed, and the space does not ask for Adam: still no merge. The review gate is
  // not the approval gate wearing another name.
  bd = fakeBd({ rows: [reviewed({ round: 0 })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON });
  assert.deepEqual(out.merged, []);
  assert.deepEqual(out.awaiting, ['zz-merge']);
});

await check('AND THE BEAD STAMP IS STILL WHAT SATISFIES requireApproval', async () => {
  // lib/mergeadvocate.js is deliberately untouched by this bead. GitHub will not take an
  // approving review from the author of the branch, so `reviewDecision` can never say
  // APPROVED here; what releases it is `approved` on the merge-bead, written by
  // lib/mergeadmit.js. Pinned because a review gate landing next to it is exactly the
  // change that would look like a reason to move it.
  const bd = fakeBd({
    rows: [reviewed(APPROVED, { attempts: 0, approved: true, approvedBy: 'adam' })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const out = await run(bd, fakePr(openPr({ reviewDecision: null })), {
    policy: { ...REVIEW_ON, requireApproval: true },
  });
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('A RESOLVER’S DOWNMERGE AFTER AN APPROVAL LEAVES IT STANDING', async () => {
  // #363 and #401 both had a resolver push to them after they were queued, and this repo
  // has no branch protection — so GitHub does not dismiss the review and the queue has to
  // decide for itself. A merge commit is the base being brought in, which is not a change
  // to the worker's proposal.
  const bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr({ headSha: 'dddddddd' }));
  prApi.commitsBetween = async () => ({
    status: 'ahead',
    commits: [{ sha: 'dddddddd', parents: 2, message: "Merge branch 'main' into work-a" }],
  });
  const out = await run(bd, prApi, { policy: REVIEW_ON });
  assert.deepEqual(out.merged, ['zz-merge'], `${HEAD} was approved and only a downmerge followed it`);
});

await check('AND A WORKER’S PUSH AFTER AN APPROVAL CLEARS IT', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr({ headSha: 'cccccccc' }));
  prApi.commitsBetween = async (dir, from, to) => {
    assert.equal(from, HEAD, 'it compared against something other than the approved commit');
    assert.equal(to, 'cccccccc');
    return { status: 'ahead', commits: [{ sha: 'cccccccc', parents: 1, message: 'answering the review' }] };
  };
  const out = await run(bd, prApi, { policy: REVIEW_ON });
  assert.deepEqual(out.merged, []);
  assert.deepEqual(out.awaiting, ['zz-merge']);
  // Off the parsed block rather than the raw notes: YAML folds a long sentence over two
  // lines, and a test matching the text as written would be asserting the line width.
  assert.match(queueState({ notes: bd.calls.updates.at(-1).notes }).refused, /pushed since aaaaaaa1 was approved/);
});

await check('AND A PULL REQUEST NOBODY HAS JUDGED OPENS THE REVIEWER’S WINDOW', async () => {
  // bc-36xx.5, and it is the other half of the door below: `review` is *nothing has
  // looked at this*, which is the state every delivery starts in and the state it comes
  // back to each time the worker has answered everything.
  const bd = fakeBd({ rows: [reviewed({ round: 0 })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const opened = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    openReview: async (entry, dir, outcome) => opened.push({ id: entry.issue.id, dir, why: outcome?.why }),
  });
  assert.deepEqual(opened.map((o) => [o.id, o.dir]), [['zz-merge', '/tmp/widgets']]);
  // The gate's own sentence rides along, because it is what the brief opens with: asking
  // for a first look and asking for a second one after the worker answered are two
  // different reviews, and the gate is the only thing here that knows which this is.
  assert.match(opened[0].why, /nothing has reviewed this pull request yet/);
  assert.deepEqual(out.reviewing, ['zz-merge']);
  assert.deepEqual(out.merged, []);
  // Still counted as awaiting rather than as something that happened: the window going up
  // does not make the pull request reviewed, and the board should say what it is waiting on.
  assert.deepEqual(out.awaiting, ['zz-merge']);
});

await check('and a tick that cannot open one refuses nothing and spends no attempt', async () => {
  // The whole failure direction. A reviewer that could not be opened this tick is still a
  // pull request waiting on a review, which is true again in thirty seconds — turning it
  // into a refusal would spend attempts on a branch nothing was ever asked of.
  const bd = fakeBd({ rows: [reviewed({ round: 0 })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    openReview: async () => {
      throw new Error('iTerm is not running');
    },
  });
  assert.deepEqual(out.reviewing, []);
  assert.deepEqual(out.awaiting, ['zz-merge']);
  assert.deepEqual(out.refused, []);
  assert.equal(queueState({ notes: bd.calls.updates.at(-1).notes }).attempts, 0);
});

await check('the reviewer is not opened while the worker is the one who owes an answer', async () => {
  // One window per pull request is `resolveFor`'s job in lib/server.js, but the two doors
  // must not both be *reached* either: a branch whose comments are unanswered wants the
  // author, not a second opinion on a diff that is about to change.
  const rev = {
    round: 1,
    verdict: 'changes',
    reviewedSha: HEAD,
    comments: [{ id: 'c1', body: 'this leaks a handle' }],
  };
  const bd = fakeBd({ rows: [reviewed(rev)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const reviewers = [];
  const workers = [];
  await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    openReview: async () => reviewers.push(1),
    openAnswer: async () => workers.push(1),
  });
  assert.deepEqual(reviewers, [], 'it opened a reviewer on a branch the worker has not answered yet');
  assert.equal(workers.length, 1);
});

await check('…and the reviewer is opened again once every comment has been answered', async () => {
  const rev = {
    round: 1,
    verdict: 'changes',
    reviewedSha: HEAD,
    comments: [{ id: 'c1', body: 'this leaks a handle', answer: 'changed', note: 'it is closed in the finally now' }],
  };
  const bd = fakeBd({ rows: [reviewed(rev)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const opened = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    openReview: async (entry, dir, outcome) => opened.push(outcome?.why),
    openAnswer: async () => assert.fail('it asked the worker to answer comments it has already answered'),
  });
  assert.equal(opened.length, 1);
  assert.match(opened[0], /answered every comment from round 1/);
  assert.deepEqual(out.reviewing, ['zz-merge']);
});

await check('a pull request nobody need review opens no reviewer at all', async () => {
  // The gate not applying is not the same as the gate saying `review`: an approved branch
  // and an un-gated workspace must both cost nothing.
  const approvedBd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const opened = [];
  const openReview = async () => opened.push(1);
  await run(approvedBd, fakePr(openPr()), { policy: REVIEW_ON, openReview });
  const offBd = fakeBd({ rows: [reviewed({ round: 0 })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(offBd, fakePr(openPr()), { openReview });
  assert.deepEqual(opened, [], 'a window was opened on a branch no review was wanted for');
});

await check('comments waiting on the worker open the worker’s window', async () => {
  const rev = {
    round: 1,
    verdict: 'changes',
    reviewedSha: HEAD,
    comments: [{ id: 'c1', body: 'this leaks a handle' }],
  };
  const bd = fakeBd({ rows: [reviewed(rev)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const opened = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    openAnswer: async (entry, dir) => opened.push({ id: entry.issue.id, dir }),
  });
  assert.deepEqual(opened, [{ id: 'zz-merge', dir: '/tmp/widgets' }]);
  assert.deepEqual(out.answering, ['zz-merge']);
  assert.deepEqual(out.merged, []);
  // No flag is written for it: whether the window is owed is the review block itself —
  // a comment with no answer on it — and it stops being true when the worker writes one.
  assert.match(bd.calls.updates.at(-1).notes, /waiting on the worker/);
});

await check('a refusal becomes a card, without waiting out the round cap', async () => {
  const rev = { round: 1, verdict: 'refused', refused: 'this belongs in the other module entirely' };
  const bd = fakeBd({ rows: [reviewed(rev)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    raise: async (entry, why, opts) => {
      raised.push({ why, opts });
      return true;
    },
  });
  assert.deepEqual(out.raised, ['zz-merge']);
  assert.equal(raised.length, 1);
  assert.match(raised[0].why, /other module/);
  // `review: true` is what makes the card open with the reviewer's sentence rather than
  // with an attempt tally about a merge nobody has tried — lib/mergeraise.js.
  assert.equal(raised[0].opts.review, true);
});

await check('and so does a second round that did not agree', async () => {
  const rev = {
    round: MAX_REVIEW_ROUNDS,
    verdict: 'changes',
    comments: [{ id: 'c1', body: 'still not this' }],
  };
  const bd = fakeBd({ rows: [reviewed(rev)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const raised = [];
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    raise: async (e, why, opts) => {
      raised.push({ why, opts });
      return true;
    },
  });
  assert.deepEqual(out.raised, ['zz-merge']);
  assert.match(raised[0].why, /did not agree in 2 rounds/);
});

/* ------------------------------------------- a veto, with a queue behind it (bc-i9nz7)

   Adam's instruction is two claims joined by "while": a veto is *dequeued and dealt with
   separately* **while** *the merge queue continues to drain*. They fail independently, so
   they are pinned independently — and the two above assert the raise with a spy, which
   cannot tell an escalation that hands the bead over from one that merely says it did.

   Here the real `raiseMergeCard` is wired in, so the dequeue under test is `merge-queue`
   actually coming off the bead, and the veto sits at the *head* of the queue, which is
   the arrangement where a `break` in place of the `continue` would look exactly like a
   quiet afternoon.
*/

await check('A VETO IS DEQUEUED FOR REAL — THE LABEL COMES OFF THE BEAD', async () => {
  const stuck = { round: MAX_REVIEW_ROUNDS, verdict: 'changes', comments: [{ id: 'c1', body: 'still not this' }] };
  const bd = fakeBd({ rows: [reviewed(stuck)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    raise: (entry, why, opts) => raiseMergeCard(bd, { name: 'demo' }, entry, why, opts),
  });
  assert.deepEqual(out.raised, ['zz-merge']);
  const card = bd.calls.updates.find((u) => u.id === 'zz-merge' && u.removeLabels);
  assert.ok(card, 'nothing took the queue label off, so the next tick picks it up again under the person reading it');
  assert.deepEqual(card.removeLabels, [MERGE_LABEL]);
  assert.ok(card.addLabels.includes('human'), 'it left the queue without landing anywhere a person looks');
  assert.deepEqual(out.merged, [], 'a vetoed pull request merged anyway');
});

await check('AND THE QUEUE BEHIND IT STILL DRAINS IN THE SAME SWEEP', async () => {
  // Three queued, the vetoed one first — `queued.sort` above orders the tick by bead id,
  // so the name is what puts it at the head, and the head is where a `break` in place of
  // the `continue` would cost the whole rest of the sweep. It costs its own pull request
  // and nothing else's, and it does not spend one of the tick's merge slots either.
  const stuck = { round: MAX_REVIEW_ROUNDS, verdict: 'changes', comments: [{ id: 'c1', body: 'still not this' }] };
  const rows = [
    bead({ id: 'zz-aveto' }, { number: 61, bead: 'zz-w61' }, withReviewBlock('', stuck)),
    bead({ id: 'zz-m1' }, { number: 62, bead: 'zz-w62' }, withReviewBlock('', APPROVED)),
    bead({ id: 'zz-m2' }, { number: 63, bead: 'zz-w63' }, withReviewBlock('', APPROVED)),
  ];
  const bd = fakeBd({
    rows,
    issues: {
      'zz-w61': { id: 'zz-w61', issue_type: 'task' },
      'zz-w62': { id: 'zz-w62', issue_type: 'task' },
      'zz-w63': { id: 'zz-w63', issue_type: 'task' },
    },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi, {
    policy: REVIEW_ON,
    raise: (entry, why, opts) => raiseMergeCard(bd, { name: 'demo' }, entry, why, opts),
  });

  assert.deepEqual(out.raised, ['zz-aveto']);
  assert.deepEqual(out.merged, ['zz-m1', 'zz-m2'], 'the veto took the rest of the queue down with it');
  assert.deepEqual(prApi.calls.merges.map((m) => m.n), [62, 63]);
  assert.equal(prApi.calls.merges.length, MERGES_PER_TICK, 'the veto spent one of the tick’s merge slots');

  // And the two behind it went all the way through, rather than being merged and left
  // half-filed: a drain that stops short of the close is the failure this queue replaces.
  assert.deepEqual(
    bd.calls.closes.map((c) => c.id),
    ['zz-m1', 'zz-w62', 'zz-m2', 'zz-w63']
  );
  // The vetoed bead is the one thing that did not close — it is a card now, and a card is
  // open work by definition.
  assert.equal(bd.calls.closes.some((c) => c.id === 'zz-aveto' || c.id === 'zz-w61'), false);
});

await check('THE WAITING SENTENCE IS TAKEN BACK THE MOMENT IT STOPS BEING TRUE', async () => {
  // The hold's lesson (bc-arf8), applied to the other thing this queue waits on that is
  // not about the branch: every other refusal is overwritten by the next verdict, but a
  // branch that was only ever waiting for a reviewer has no verdict to write over it —
  // so `nothing has reviewed this` would sit on the bead reading as its own problem.
  const queued = { attempts: 0, reviewing: true, refused: 'waiting on a review: nothing has reviewed this pull request yet.' };
  const bd = fakeBd({ rows: [reviewed(APPROVED, queued)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON });
  // Cleared *and* judged on the same pass, rather than costing the merge one more tick.
  assert.deepEqual(out.merged, ['zz-merge']);
  const cleared = bd.calls.updates.find((u) => !queueState({ notes: u.notes }).reviewing);
  assert.ok(cleared, 'the reviewing sentence was never taken back');
  assert.equal(queueState({ notes: cleared.notes }).refused, null);
});

await check('a review is one sentence per bead, not one every tick', async () => {
  const already = { attempts: 0, reviewing: true, refused: 'waiting on a review: nothing has reviewed this pull request yet.' };
  const bd = fakeBd({ rows: [reviewed({ round: 0 }, already)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON });
  assert.deepEqual(out.awaiting, ['zz-merge']);
  assert.deepEqual(bd.calls.updates, [], 'it rewrote a sentence that had not changed');
});

/* ================================================= folding a verdict onto the block

   bc-36xx.22. `verdictFrom`, `approve` and `approvedReview` all existed and none of them
   had a caller: a ReviewAdvocate could write a verdict comment for ever and the gate above
   would keep reading a block nobody had touched. These are the sweep actually reading one
   in — the comment a reviewer leaves is a different document from the block the gate reads
   (lib/reviewadvocate.js's header), and this is what turns the first into the second.
*/

/** A verdict comment, exactly as a ReviewAdvocate would leave one — lib/reviewadvocate.js. */
const verdictComment = (v) => ({ text: formatVerdict(v, { owner: 'Adam' }) });

await check('AN APPROVING VERDICT IS FOLDED ONTO THE BLOCK AND MERGES THE SAME TICK', async () => {
  const verdict = { pr: 42, bead: 'zz-work', round: 1, approved: true, comments: [] };
  const bd = fakeBd({
    rows: [reviewed({ round: 0 })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    comments: { 'zz-merge': [verdictComment(verdict)] },
  });
  const prApi = fakePr(openPr(), { reviewer: { login: 'NeanderthalMan', user: '', slug: 'acme/widgets', permission: 'write' } });
  const out = await run(bd, prApi, { policy: REVIEW_ON, owner: 'Adam' });

  // A bare approval, no comments to anchor — `approve()`, not `submitReview()`.
  assert.equal(prApi.calls.approvals.length, 1, 'it did not submit a real review under the reviewer identity');
  assert.equal(prApi.calls.reviews.length, 0);
  assert.match(prApi.calls.approvals[0].body, /Approved.*by the ReviewAdvocate/s);
  assert.match(prApi.calls.approvals[0].note, /agent's, not Adam's/);

  // The block was written for the commit actually on the branch — reviewedSha comes from
  // the branch's head, not from anything the verdict itself said.
  const written = bd.calls.updates.find((u) => reviewState({ notes: u.notes }).round === 1);
  assert.ok(written, 'the review block was never written');
  const rev = reviewState({ notes: written.notes });
  assert.equal(rev.verdict, 'approved');
  assert.equal(rev.reviewedSha, HEAD);
  assert.equal(rev.approvedBy, 'NeanderthalMan');
  assert.equal(rev.approvalUrl, prApi.calls.approvals.length ? 'https://github.com/acme/widgets/pull/42#pullrequestreview-1' : '');

  // Folded and judged on the same pass, exactly as the hold and the staleness cases are —
  // a merge does not cost the queue a whole extra tick just because the verdict just landed.
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('A CHANGES VERDICT WITH INLINE COMMENTS GOES OUT AS submitReview, NEVER refused', async () => {
  const verdict = {
    pr: 42,
    bead: 'zz-work',
    round: 1,
    approved: false,
    why: 'the lock is never released on the error path',
    comments: [{ id: 'c1', file: 'lib/example.js', line: 42, severity: 'blocking', what: 'this leaks a handle', why: 'the finally never runs' }],
  };
  const bd = fakeBd({
    rows: [reviewed({ round: 0 })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    comments: { 'zz-merge': [verdictComment(verdict)] },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi, { policy: REVIEW_ON });

  // `approve()` has no way to carry an inline comment — this must go out as a real review,
  // requesting changes, since #533.
  assert.equal(prApi.calls.approvals.length, 0);
  assert.equal(prApi.calls.reviews.length, 1);
  assert.equal(prApi.calls.reviews[0].event, 'REQUEST_CHANGES');
  assert.deepEqual(prApi.calls.reviews[0].comments, [{ path: 'lib/example.js', line: 42, body: '**blocking** — this leaks a handle the finally never runs' }]);
  // Nothing on GitHub could be mistaken for a person's approval here, so no disclaimer.
  assert.equal(prApi.calls.comments.length, 0);

  const written = bd.calls.updates.find((u) => reviewState({ notes: u.notes }).round === 1);
  const rev = reviewState({ notes: written.notes });
  assert.equal(rev.verdict, 'changes');
  assert.notEqual(rev.verdict, 'refused', 'a single comment escalated the pull request straight to a card');
  assert.equal(rev.comments.length, 1);
  assert.equal(rev.comments[0].answer, '', 'a fresh comment arrived pre-answered');

  // Unanswered and blocking: the worker's window, not a second reviewer.
  assert.deepEqual(out.merged, []);
  assert.deepEqual(out.answering, [], 'no openAnswer was wired up for this scenario, so nothing should claim it opened one');
  assert.deepEqual(out.awaiting, ['zz-merge']);
});

await check('recorded as approved even with no second GitHub account to submit it as', async () => {
  const verdict = { pr: 42, bead: 'zz-work', round: 1, approved: true, comments: [] };
  const bd = fakeBd({
    rows: [reviewed({ round: 0 })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    comments: { 'zz-merge': [verdictComment(verdict)] },
  });
  const prApi = fakePr(openPr(), {
    reviewer: null,
    approve: { submitted: false, reviewer: '', url: '', at: '', reason: 'there is no second GitHub account here' },
  });
  const out = await run(bd, prApi, { policy: REVIEW_ON });

  const written = bd.calls.updates.find((u) => reviewState({ notes: u.notes }).round === 1);
  const rev = reviewState({ notes: written.notes });
  assert.equal(rev.verdict, 'approved');
  // `approvedReview`'s own fallback: recorded rather than refused, and attributed to the
  // agent kind rather than to a login that was never submitted.
  assert.equal(rev.approvedBy, 'review-advocate');
  assert.equal(rev.approvalUrl, '');
  assert.deepEqual(out.merged, ['zz-merge'], 'an approval nobody could submit to GitHub still gates the merge locally');
});

await check('a verdict for a round the block already has is not folded in twice', async () => {
  const verdict = { pr: 42, bead: 'zz-work', round: 1, approved: true, comments: [] };
  const already = { round: 1, verdict: 'approved', reviewer: 'somebody', reviewedSha: HEAD, approvedBy: 'somebody' };
  const bd = fakeBd({
    rows: [reviewed(already)],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    comments: { 'zz-merge': [verdictComment(verdict)] },
  });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi, { policy: REVIEW_ON });

  assert.equal(prApi.calls.approvals.length, 0, 're-submitted a review the block already recorded');
  assert.equal(prApi.calls.reviews.length, 0);
  // It still merges — the block already says approved for the commit on the branch —
  // just not by way of a second submission.
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('a verdict comment that will not parse holds the merge rather than crashing the tick', async () => {
  // Two comments sharing an id: checkVerdict refuses it outright, so this is not a verdict
  // this can fold in — the same holding direction reviewState itself takes on a block it
  // cannot parse.
  const broken = {
    pr: 42,
    bead: 'zz-work',
    round: 1,
    approved: false,
    why: 'x',
    comments: [{ id: 'c1', what: 'a' }, { id: 'c1', what: 'b' }],
  };
  const bd = fakeBd({
    rows: [reviewed({ round: 0 })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    comments: { 'zz-merge': [verdictComment(broken)] },
  });
  const prApi = fakePr(openPr());
  const opened = [];
  const out = await run(bd, prApi, { policy: REVIEW_ON, openReview: async () => opened.push(1) });

  assert.equal(prApi.calls.approvals.length, 0);
  assert.equal(prApi.calls.reviews.length, 0);
  assert.deepEqual(out.merged, []);
  assert.deepEqual(out.reviewing, ['zz-merge'], 'a verdict that could not be read did not re-open the reviewer');
  assert.equal(opened.length, 1);
});


/* --------------------------------------------------------------- the report */

/*
 * bc-kan5f. A merge used to leave nothing on the pull request but the merge itself, so
 * the whole passage — how many windows it took, how many times `main` moved under it,
 * what the base was already failing — existed only in a bead somebody had to know to
 * look up. These pin the two halves that could go wrong quietly: what the report is
 * allowed to *claim*, and that failing to post one can never cost a close.
 */

await check('the report reaches the pull request and the bead, and names the passage', async () => {
  const state = { attempts: 2, downmerges: 3, approved: true, approvedBy: 'adam', approvedAt: '2026-08-19T00:00:00Z' };
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', state) })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);

  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(prApi.calls.comments.length, 1, 'nothing was posted to the pull request');
  const onPr = prApi.calls.comments[0].text;
  assert.match(onPr, /Merged into `main` as `abcdef12`/, 'the report does not say what merged where');
  assert.match(onPr, /2 attempts/, 'the attempts are not reported');
  assert.match(onPr, /base moved under it 3 times/, 'the downmerges are not reported — the most useful fact on a busy day');
  assert.match(onPr, /Approved by adam/, 'who approved it is not carried');
  assert.ok(
    bd.calls.comments.some((c) => c.id === 'zz-merge' && /Merged into `main`/.test(c.text)),
    'the bead never got the same report'
  );
});

await check('and it points at the advocate rather than paraphrasing it', async () => {
  // The one thing this report must not become: a summary of somebody else's account,
  // written by a process that did not watch the merge. The queue knows the passage; the
  // conflicts and the suites are the advocate's, and stay the advocate's.
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 0, downmerges: 0 }) })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  await run(bd, prApi);
  const onPr = prApi.calls.comments[0].text;
  assert.match(onPr, /Straight through/, 'a clean passage is not described as one');
  assert.match(onPr, /reports its own half only/, 'nothing says whose account this is and is not');
  // Not "the word conflict never appears" — the disclaimer names conflicts precisely to
  // say they are the advocate's. What must never appear is a *measurement* of one, or of
  // anything else the queue did not take itself: a count of conflicts, or a suite tally.
  assert.doesNotMatch(onPr, /\d+\s+conflicts?\b/i, 'the queue reported a conflict count it has no way to know');
  assert.doesNotMatch(onPr, /\b\d+\s*\/\s*\d+\b/, 'the queue reported a suite tally, which is the advocate’s measurement');
});

await check('a merge that happened elsewhere does not get reported as the queue’s', async () => {
  // Adam's thumb on the phone. The bookkeeping still runs, and the attempts and
  // downmerges still happened — but "merged by the beadcause merge queue" would be the
  // queue taking credit for a tap.
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, downmerges: 0 }) })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-19T01:00:00Z', mergeCommit: 'facefeed11' }));
  await run(bd, prApi);
  const onPr = prApi.calls.comments[0].text;
  assert.match(onPr, /outside the queue/, 'the report does not say it landed elsewhere');
  assert.doesNotMatch(onPr, /by the beadcause merge queue/, 'the queue took credit for a merge it did not make');
  assert.match(onPr, /One attempt/, 'the passage it did have is thrown away');
});

await check('a pull request that will not take the report still gets both closes', async () => {
  // The rule the whole close sequence is written to: the merge has happened, and nothing
  // after it may un-happen it. A comment that cannot post is a small loss; a comment that
  // throws into this path strands a merged pull request with two open beads.
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 0 }) })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr(), { comment: new Error('gh: could not post a comment') });
  const out = await run(bd, prApi);
  assert.deepEqual(out.merged, ['zz-merge'], 'a failed comment was counted as a failed merge');
  assert.deepEqual(
    bd.calls.closes.map((c) => c.id),
    ['zz-merge', 'zz-work'],
    'both beads did not close, merge-bead first, over a comment that failed'
  );
});

await check('mergeReport invents nothing when it knows nothing', () => {
  // Called with an empty state — which is what a bead somebody hand-edited into invalid
  // YAML reads as. Every number here comes from somewhere, so no number is the honest
  // output rather than a zero presented as a measurement.
  const text = mergeReport({ number: 7, base: 'main', bead: 'zz-work' }, {});
  assert.match(text, /Straight through/);
  assert.doesNotMatch(text, /\battempts\b/, 'it reported an attempt count it was never given');
  assert.doesNotMatch(text, /from reaching the queue/, 'it timed a passage with no start');
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
