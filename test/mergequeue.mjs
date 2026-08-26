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
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mergequeue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { sweepMergeQueue, describeMergeQueue, MERGES_PER_TICK, STRAND_SCAN_MAX, mergeReport, behindBase } = await import(LIB('mergequeue.js'));
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
function fakeBd({ rows = [], issues = {}, refuse = null, comments = {}, followups = [], graph = null } = {}) {
  const calls = { closes: [], comments: [], updates: [], reads: [], created: [], labelReads: [], cardReads: [] };
  return {
    calls,
    /**
     * The two writes a merge over open review findings costs — bc-9ntye.2. Both are on
     * every fake tracker here rather than on the two scenarios about them, because
     * `finish` reaches them from the ordinary merge path and a fake missing one would
     * fail a suite that is about something else entirely.
     */
    listLabelAny: async (ws, label) => {
      calls.labelReads.push(label);
      return followups;
    },
    create: async (ws, issue) => {
      const id = `zz-f${calls.created.length + 1}`;
      calls.created.push({ id, ...issue });
      return id;
    },
    /** The shape `homeIn` climbs to find a follow-up's parent. Empty is "no root anywhere". */
    graph: async () => graph || { beads: new Map(), parents: new Map(), adopts: new Map(), edges: new Map() },
    /**
     * **The `human` exclusion the real one does, and the reason this suite lied** —
     * bc-uxrix.
     *
     * `Bd.listAgent` runs `bd list --exclude-label human`, and until this line it did not.
     * Five take-a-card-back scenarios below hand `rows` a bead labelled `['human',
     * 'pr-delivery']` and got it back, so all five passed against a production wiring that
     * could not deliver such a row to `cardedFor` at all: the seam was tested and the wiring
     * was not, for as long as the reclaim has existed. Applying the filter here is what
     * makes those five fail honestly if the second read in `sweepMergeQueue` is ever taken
     * back out.
     */
    listAgent: async () => rows.filter((r) => !(r?.labels || []).some((l) => String(l).trim() === 'human')),
    /** The other half of the same read: this queue's own cards, by assignee — `Bd.listCards`. */
    listCards: async (ws, assignee) => {
      calls.cardReads.push(assignee);
      return rows.filter(
        (r) =>
          (r?.labels || []).some((l) => String(l).trim() === 'human') &&
          (!assignee || String(r?.assignee || '').trim().toLowerCase() === String(assignee).trim().toLowerCase())
      );
    },
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
    // The open pull requests in the checkout, when a scenario is about the strand report.
    // `null` leaves `prApi.list` off the fake entirely — see below.
    list = null,
  } = {}
) => {
  const calls = { merges: [], updates: [], comments: [], approvals: [], reviews: [], lists: [] };
  const api = {
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
  /**
   * The open pull requests in a checkout — `list`, lib/pr.js — and opt-in for `comment`'s
   * reason: the sweep guards on `typeof prApi?.list === 'function'`, so a scenario that is
   * not about strands gets a `prApi` without one and the strand block is skipped entirely,
   * exactly as it is for a caller that hands over no lister.
   */
  if (list) {
    api.list = async (dir, opts) => {
      calls.lists.push({ dir, ...opts });
      return list;
    };
  }
  /**
   * `mergeability`, lib/pr.js — one `view` at `timeoutMs: 0`, plus the one thing the raw
   * read cannot say: whether GitHub has answered at all. That reading is what the queue's
   * resolving sweep now turns on (bc-5mdsw), so a fake without it would leave every
   * scenario below asserting the old behaviour.
   *
   * Through `api.view` rather than the row closed over above, so a scenario that replaces
   * `view` — the rate-limited read further down — replaces both.
   */
  api.mergeability = async (dir, n) => {
    const pr = await api.view(dir, n);
    return {
      pr,
      waited: 0,
      unresolved: String(pr.state || '').toUpperCase() === 'OPEN' && String(pr.mergeable || '').toUpperCase() === 'UNKNOWN',
    };
  };
  return api;
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

/* --------------------------------- trusting the checks across a downmerge (bc-kbvhg) */

/*
 * `trustChecksAcrossDownmerge` is the repo saying it would rather not pay for a whole
 * gate run to re-prove a diff that did not change. `MAX_DOWNMERGES` is 3 and `main`
 * takes about forty merges a day here, so a branch that sits in the queue for two days
 * can pay three times over.
 *
 * What it must not become is a way to merge something nobody looked at, so every check
 * below is one of the three conditions, and each is written as a pair: the same branch
 * with the condition and without it. A guard that has only ever been seen passing is a
 * guard nobody knows the shape of.
 *
 * The policy is a plain option on the sweep, so `run` with no `policy` at all is the
 * default everywhere — which is what every check above this line is already asserting.
 */
const TRUSTING = { policy: { trustChecksAcrossDownmerge: true } };
const merging = () => fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });

await check('WITH THE POLICY ON, A CLEAN DOWNMERGE OF A PASSING BRANCH MERGES ON THE SAME TICK', async () => {
  const prApi = fakePr(openPr({ mergeState: 'BEHIND' }));
  const out = await run(merging(), prApi, TRUSTING);
  assert.deepEqual(prApi.calls.updates, [42], 'the base still went in — this skips the wait, not the downmerge');
  assert.equal(prApi.calls.merges.length, 1, 'it downmerged and then stopped, exactly as it does with the policy off');
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('and the identical branch with the policy off waits — which is what says the flag did it', async () => {
  // The pair to the check above, and the only difference between them is the option.
  // Without this one, "it merged" is equally true of a queue that stopped reading the
  // policy at all.
  const prApi = fakePr(openPr({ mergeState: 'BEHIND' }));
  const out = await run(merging(), prApi);
  assert.deepEqual(prApi.calls.updates, [42]);
  assert.equal(prApi.calls.merges.length, 0, 'the default changed — every repo just started skipping its re-run');
  assert.deepEqual(out.merged, []);
});

await check('the downmerge is still counted, so MAX_DOWNMERGES still bounds a branch that keeps being behind', async () => {
  // Merging on the tick makes a downmerge cheap; it must not make it unlimited. The
  // count is what stops a branch whose base moves every tick from downmerging for ever
  // in the case where it does *not* go on to merge.
  const bd = merging();
  await run(bd, fakePr(openPr({ mergeState: 'BEHIND' })), TRUSTING);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.ok(written, 'nothing was written back, so the next tick would downmerge from zero');
  assert.equal(queueState({ notes: written.notes }).downmerges, 1);
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'a downmerge that merged spent an attempt as well');
});

await check('A BRANCH THAT WAS NOT ALREADY PASSING TAKES THE OLD PATH — pending is not evidence', async () => {
  const pending = openPr({ mergeState: 'BEHIND', checks: { failed: [], failing: 0, pending: 2, total: 3, state: 'pending' } });
  const prApi = fakePr(pending);
  const out = await run(merging(), prApi, TRUSTING);
  assert.deepEqual(prApi.calls.updates, [42]);
  assert.equal(prApi.calls.merges.length, 0, 'it merged over checks that had not finished');
  assert.deepEqual(out.merged, []);
});

await check('and a head commit nothing ran on is not the same as one that passed — bc-ysqd.1, #480', async () => {
  // `state: 'none'` is the shape a push authored with the Actions token leaves behind:
  // failing is 0 and pending is 0, so anything asking "is it not failing" says yes about
  // a commit that was never tested. The condition here is `passing`, positively, for
  // exactly that reason.
  const nothing = openPr({ mergeState: 'BEHIND', checks: { failed: [], failing: 0, pending: 0, total: 0, state: 'none' } });
  const prApi = fakePr(nothing);
  await run(merging(), prApi, TRUSTING);
  assert.deepEqual(prApi.calls.updates, [42]);
  assert.equal(prApi.calls.merges.length, 0, 'a commit with zero checks was read as a commit that passed');
});

await check('a downmerge GitHub would not put in never reaches the verdict, policy or not', async () => {
  // `updateBranch` refusing is how this loop finds out the base did not go in cleanly.
  // The policy is about a downmerge that *worked*; nothing here may turn a refusal into
  // a merge on the strength of checks that were about the old base.
  const prApi = fakePr(openPr({ mergeState: 'BEHIND' }), { update: { updated: false, reason: 'the base moved under it' } });
  const out = await run(merging(), prApi, TRUSTING);
  assert.equal(prApi.calls.merges.length, 0);
  assert.deepEqual(out.waiting, ['zz-merge']);
});

await check('AND A CONFLICT IS STILL A RESOLVER — this never decides a conflict is fine', async () => {
  // The conflicted branch is handled above the downmerge, so the policy cannot reach it.
  // Pinned anyway, because "it skips the gate" is the sentence somebody will remember
  // about this setting, and the distance between that and "it skips the gate on a
  // conflict" is the whole safety of it.
  const dirty = openPr({ mergeState: 'BEHIND', mergeable: 'CONFLICTING' });
  const prApi = fakePr(dirty);
  const opened = [];
  const out = await run(merging(), prApi, { ...TRUSTING, openResolver: async (entry, dir) => (opened.push(dir), true) });
  assert.equal(opened.length, 1, 'a conflicted branch went somewhere other than a resolver');
  assert.equal(prApi.calls.merges.length, 0);
  assert.equal(prApi.calls.updates.length, 0, 'it asked GitHub to update a branch it already knew conflicts');
  assert.deepEqual(out.merged, []);
});

/* ================================= a verdict about a base that has moved (bc-xl7n.121)

   `gateVerdict`'s stale branch is a *wait*, and its own docblock names the downmerge as
   what ends it: "a branch whose checks predate the repair is behind the repaired base by
   construction." The git relationship is exactly that. The field the `BEHIND` arm above
   tests is not — `mergeStateStatus` only reaches `BEHIND` under a branch-protection rule
   `mordam/beadcause` does not have — so that arm never fired, nothing else re-runs a
   check, and the wait had no producer at all: twelve pull requests held for five days,
   four of them green, none of them on any screen.

   The sharpest case is the one these start with, and it is why a suite that only drove a
   red branch would have missed it: #717 was `test: SUCCESS`, `MERGEABLE` and `CLEAN`, held
   purely because its green run finished on the wrong side of a hold.
*/

/** A pull request whose checks ran at `OLD`, and a merge-bead whose hold lifted at `LIFTED`. */
const OLD = '2026-08-24T22:00:00Z';
const LIFTED = '2026-08-25T00:00:00Z';
const stalePr = (over = {}) => openPr({ checks: { ...GREEN, at: OLD }, ...over });
const staleBead = (queue = {}) => bead({ notes: withQueueBlock('', { attempts: 0, heldUntil: LIFTED, ...queue }) });
/** The git reading, injected — `behindBase` in lib/mergequeue.js. */
const drifted = (n) => async () => n;

await check('A GREEN, CLEAN PULL REQUEST WHOSE CHECKS PREDATE THE BASE GETS ITS BASE BROUGHT IN', async () => {
  const bd = fakeBd({ rows: [staleBead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(stalePr());
  const out = await run(bd, prApi, { behind: drifted(177) });
  assert.deepEqual(prApi.calls.updates, [42], 'the wait still has no producer');
  assert.deepEqual(out.updated, ['zz-merge']);
  // Not merged on the strength of the old run — that is the whole reason the guard exists.
  assert.equal(prApi.calls.merges.length, 0);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  assert.equal(queueState({ notes: written.notes }).downmerges, 1);
  // And still no attempt: nothing was asked of this branch's diff, so nothing refused it.
  assert.equal(queueState({ notes: written.notes }).attempts, 0, 'a wait spent one of the three attempts');
});

await check('a branch whose checks are current is not touched — this is not the BEHIND arm widened', async () => {
  // The failure the narrow fix avoids. `main` here moves twenty times an hour, so every
  // queued branch is behind it by the git reading; downmerging on that alone would hand
  // each one three fresh bases and three CI runs before ever judging it, which is exactly
  // what `MAX_DOWNMERGES` was written about.
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr({ checks: { ...GREEN, at: '2026-08-26T00:00:00Z' } }));
  const out = await run(bd, prApi, { behind: drifted(177) });
  assert.deepEqual(prApi.calls.updates, [], 'it downmerged a branch with nothing stale about it');
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('and neither is a stale one with nothing to bring in', async () => {
  const bd = fakeBd({ rows: [staleBead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(stalePr());
  const out = await run(bd, prApi, { behind: drifted(0) });
  assert.deepEqual(prApi.calls.updates, []);
  assert.deepEqual(out.merged, [], 'it merged on a verdict about a base that is gone');
  assert.deepEqual(out.stale, [42]);
});

await check('a checkout that cannot answer waits rather than guesses', async () => {
  // `null` is "could not tell" and it is not zero — a head this Mac has never fetched, a
  // base ref that is not here. Asking GitHub to update on a guess spends a write every
  // thirty seconds on a branch there may be nothing to do for.
  const bd = fakeBd({ rows: [staleBead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(stalePr());
  const out = await run(bd, prApi, { behind: async () => null });
  assert.deepEqual(prApi.calls.updates, []);
  assert.deepEqual(out.stale, [42]);
  assert.equal(queueState({ notes: bd.calls.updates.at(-1).notes }).attempts, 0);
});

await check('AND IT IS BOUNDED BY THE SAME COUNTER THE BEHIND ARM IS', async () => {
  const bd = fakeBd({
    rows: [staleBead({ downmerges: MAX_DOWNMERGES })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(stalePr());
  const out = await run(bd, prApi, { behind: drifted(177) });
  assert.deepEqual(prApi.calls.updates, [], 'it brought the base in a fourth time');
  assert.deepEqual(out.merged, [], 'and it must still not merge on the old run');
  assert.deepEqual(out.stale, [42], 'a branch nothing can move any more says so');
});

await check('a refused update is counted here, unlike the BEHIND arm, because it is not a race', async () => {
  // There a refusal is usually somebody else's merge landing a second earlier. Here git
  // has already said there is something to bring in, so an update GitHub will not perform
  // is a standing condition — and not counting it would spend a write every tick for ever.
  const bd = fakeBd({ rows: [staleBead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(stalePr(), { update: { updated: false, reason: 'the base moved under it' } });
  const out = await run(bd, prApi, { behind: drifted(177) });
  assert.deepEqual(out.waiting, ['zz-merge']);
  const after = queueState({ notes: bd.calls.updates.at(-1).notes });
  // COUNTED AGAINST THE BUDGET, AND NOT AS A DOWNMERGE — bc-johbj. The shipped version
  // wrote `downmerges: 1` here, so twelve pull requests GitHub had refused with a flat
  // 404 were on their way to being told their base had been brought in three times.
  assert.equal(after.downmergeRefusals, 1, 'the ask was not counted, so a standing refusal costs a write every tick');
  assert.equal(after.downmerges, 0, 'a refusal was recorded as a downmerge that never happened');
  assert.equal(after.downmergeRefusal, 'the base moved under it', 'the reason is gone, so nothing can say why');
});

await check('AND THE BOUND IS THE TWO TOGETHER, SO REFUSALS STILL CANNOT RUN FOR EVER', async () => {
  const bd = fakeBd({
    rows: [staleBead({ downmergeRefusals: MAX_DOWNMERGES })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(stalePr(), { update: { updated: false, reason: 'gh: Not Found (HTTP 404)' } });
  const out = await run(bd, prApi, { behind: drifted(177) });
  assert.deepEqual(prApi.calls.updates, [], 'it kept asking GitHub after the budget was spent');
  assert.deepEqual(out.stale, [42]);
});

await check('and a mixed budget spends both halves', async () => {
  const bd = fakeBd({
    rows: [staleBead({ downmerges: 2, downmergeRefusals: 1 })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(stalePr());
  const out = await run(bd, prApi, { behind: drifted(177) });
  assert.deepEqual(prApi.calls.updates, [], 'two downmerges plus one refusal is three asks and the budget is three');
  assert.deepEqual(out.stale, [42]);
});

await check('AN EXHAUSTED BRANCH THAT WAS NEVER ONCE DOWNMERGED DOES NOT CLAIM IT WAS', async () => {
  /* The sentence bc-johbj exists to stop. `MAX_DOWNMERGES` refusals used to leave the tick
     saying "Its base has been brought in 3 times already." about a base that had never
     gone in — an invisible indefinite wait replaced by a visible permanent dead end
     carrying a false explanation, which is worse than what it replaced. */
  const lines = [];
  const bd = fakeBd({
    rows: [staleBead({ downmergeRefusals: MAX_DOWNMERGES, downmergeRefusal: 'gh: Not Found (HTTP 404)' })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(stalePr());
  await run(bd, prApi, { behind: drifted(177), log: (m) => lines.push(String(m)) });
  const said = lines.find((l) => l.includes('#42')) || '';
  assert.doesNotMatch(said, /has been brought in/, said || 'no line about #42 at all');
  assert.match(said, /could not be brought in at all/, said);
  assert.match(said, /Not Found \(HTTP 404\)/, 'the refusal GitHub gave is the one fact that points at the cause');
});

await check('and one that really was downmerged says how many times, not the cap', async () => {
  const lines = [];
  const bd = fakeBd({
    rows: [staleBead({ downmerges: 2, downmergeRefusals: 1 })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(stalePr());
  await run(bd, prApi, { behind: drifted(177), log: (m) => lines.push(String(m)) });
  const said = lines.find((l) => l.includes('#42')) || '';
  assert.match(said, /brought in 2 times already/, said);
});

await check('the tick says out loud which pull requests are held on it', async () => {
  // For five days the only trace of this was one log line per tick per branch: a stale
  // refusal costs no attempt by design, so it never ejects to a card and never reaches
  // `givenUp`. Named rather than counted, because "which ones" was the unanswerable bit.
  const bare = { ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [] };
  const line = describeMergeQueue({ ...bare, stale: [652, 717, 718, 719] });
  assert.match(line, /4 held on checks older than the base \(#652, #717, #718 and 1 more\)/, line);
  // Optional, for `held`'s reason: a caller predating the field hands this a plain object.
  assert.equal(describeMergeQueue(bare), '');
});

/* ------------------------------------- and the reading itself, against real git */

await check('behindBase counts what the base has and the branch does not, from the checkout', async () => {
  const repo = fs.mkdtempSync(path.join(tmp, 'behind-'));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: repo, stdio: 'pipe' });
  g('init', '-b', 'main', '-q');
  fs.writeFileSync(path.join(repo, 'a'), 'a');
  g('add', '-A');
  g('commit', '-qm', 'one');
  const head = String(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo })).trim();
  // Two commits land on the base after the branch left it.
  for (const n of ['two', 'three']) {
    fs.writeFileSync(path.join(repo, n), n);
    g('add', '-A');
    g('commit', '-qm', n);
  }
  assert.equal(await behindBase(repo, head, 'main'), 2);
  assert.equal(await behindBase(repo, 'HEAD', 'main'), 0, 'the tip of the base is not behind it');
  // The four ways it cannot answer, and none of them may read as zero: a commit this
  // checkout has never seen, a base ref that is not here, a directory that is not a
  // repository, and a question with a piece missing.
  assert.equal(await behindBase(repo, 'f'.repeat(40), 'main'), null);
  assert.equal(await behindBase(repo, head, 'no-such-base'), null);
  assert.equal(await behindBase(path.join(tmp, 'nowhere'), head, 'main'), null);
  assert.equal(await behindBase(repo, '', 'main'), null);
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

/* ------------------------------------- the sweep can see its own cards (bc-uxrix) */

/**
 * The wiring under all five scenarios above, asserted rather than assumed.
 *
 * `Bd.listAgent` runs `--exclude-label human` and `raiseMergeCard` puts `human` on, so
 * until bc-uxrix a card left the only list this sweep read the moment it was raised, and
 * `cardedFor` could only ever return `[]` in the daemon. The five above passed anyway,
 * because the fake handed its rows back unfiltered — the seam was tested and the wiring
 * was not. `fakeBd.listAgent` now applies the same exclusion, so those five reach
 * `cardedFor` only by way of the second read, and this one says so out loud.
 */
await check('the reclaim reads the cards through their own list, not through listAgent', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  assert.deepEqual(await bd.listAgent(), [], 'the real listAgent could not deliver this row and now neither can the fake');
  const out = await run(bd, fakePr(openPr()));
  assert.deepEqual(out.restored, ['zz-merge'], 'and the second read is what gets it there');
  assert.deepEqual(bd.calls.cardReads, [MERGE_ASSIGNEE], 'narrowed to this queue own cards, not the whole inbox');
});

await check('a tracker with no card list reclaims nothing rather than guessing', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  delete bd.listCards;
  const out = await run(bd, fakePr(openPr()));
  assert.deepEqual(out.restored, [], 'a card it cannot read is a card it must not act on');
  assert.equal(bd.calls.updates.length, 0);
});

/**
 * bc-uxrix, answered by Adam 2026-08-24: **the reclaim is for cards the queue gave up on,
 * not cards a reviewer gave up on.**
 *
 * This is the exact shape of #655 on the day it was measured — green, clean, and vetoed —
 * and without the carve-out, making cards visible would have merged it over the reviewer's
 * refusal, unattended, as a side effect of a bug fix. `gateVerdict` does not consult the
 * review gate at all, so nothing further down would have caught it.
 */
const VETOED = withReviewBlock(withQueueBlock('', { attempts: 3, refused: 'waiting on a review.' }), {
  round: 1,
  verdict: 'refused',
  reviewer: 'NeanderthalMan',
  refused: 'the approach is wrong.',
});

await check('a card a reviewer vetoed is never taken back, however green the check has gone', async () => {
  const bd = fakeBd({ rows: [bead({ labels: CARDED, notes: VETOED })] });
  const prApi = fakePr(openPr());
  const out = await run(bd, prApi);
  assert.deepEqual(out.restored, [], 'a reviewer does not change their mind because a check went green');
  assert.equal(prApi.calls.merges.length, 0, 'and nothing merged over the refusal');
  assert.equal(bd.calls.updates.length, 0);
});

await check('and one that used up its rounds is the same decision, without the word refused', async () => {
  const capped = withReviewBlock(withQueueBlock('', { attempts: 3, refused: 'waiting on a review.' }), {
    round: MAX_REVIEW_ROUNDS,
    verdict: 'changes',
    reviewer: 'NeanderthalMan',
    comments: [{ id: 'c1', body: 'this is still wrong', severity: 'blocking' }],
  });
  const out = await run(fakeBd({ rows: [bead({ labels: CARDED, notes: capped })] }), fakePr(openPr()));
  assert.deepEqual(out.restored, [], 'two rounds is as many as this gets — that is an escalation, not a lapse');
});

await check('but a round still in progress is the queue own hold, and lapses like any other', async () => {
  const midLoop = withReviewBlock(withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }), {
    round: 1,
    verdict: 'changes',
    reviewer: 'NeanderthalMan',
    comments: [{ id: 'c1', body: 'a suggestion', severity: 'suggestion' }],
  });
  const out = await run(fakeBd({ rows: [bead({ labels: CARDED, notes: midLoop })] }), fakePr(openPr()));
  assert.deepEqual(out.restored, ['zz-merge'], 'nothing about a first-round comment says this will not be approved');
});

/* ------------------------------------------- the strand report (bc-91srt, bc-uxrix) */

const strandPr = (n) => ({ number: n, state: 'OPEN', isDraft: false });
const stillRed = { failed: ['test'], failing: 1, pending: 0, total: 3, state: 'failing' };

await check('a carded pull request is cover, not a strand', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  const said = [];
  // Its check is still red, so it stays a card — the point is what the strand report says
  // about it, not whether the reclaim takes it.
  const out = await run(bd, fakePr(openPr({ checks: stillRed }), { list: [strandPr(42), strandPr(77)] }), {
    log: (l) => said.push(l),
  });
  assert.deepEqual(out.stranded, [77], '#42 has a merge-bead — it is carded, which is a handover and not a strand');
  assert.ok(
    !said.some((l) => /#42 in .* is open and no merge-bead/.test(l)),
    `and the line the daemon repeated every tick is gone — said: ${said.join(' | ')}`
  );
});

await check('a repo known only through a card is still swept for strands', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) })],
  });
  const prApi = fakePr(openPr({ checks: stillRed }), { list: [strandPr(42), strandPr(99)] });
  const out = await run(bd, prApi);
  // Nothing is queued at all here — every merge-bead in the workspace is a card — and the
  // directory set used to be read off the queued half alone, so this reported nothing.
  assert.equal(prApi.calls.lists.length, 1, 'the card named the checkout');
  assert.deepEqual(out.stranded, [99]);
});

await check('and a card list that could not be read suppresses the report rather than crying strand', async () => {
  const bd = fakeBd({
    rows: [bead({ labels: CARDED, notes: withQueueBlock('', { attempts: 3, refused: '1 check failing (test).' }) }), bead({ id: 'zz-two' })],
  });
  bd.listCards = async () => {
    throw new Error('dolt: database is locked');
  };
  const said = [];
  const out = await run(bd, fakePr(openPr({ checks: stillRed }), { list: [strandPr(42)] }), { log: (l) => said.push(l) });
  assert.deepEqual(out.stranded, [], 'a cover set known to be short cannot tell a strand from a handover');
  assert.ok(
    said.some((l) => /could not be read/.test(l)),
    `and it says so — a report that went quiet reads as nothing being wrong: ${said.join(' | ')}`
  );
});

await check('the strand report says when it hit its own ceiling', async () => {
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: MAX_ATTEMPTS }) })] });
  const many = Array.from({ length: STRAND_SCAN_MAX }, (_, i) => strandPr(1000 + i));
  const said = [];
  const prApi = fakePr(openPr(), { list: many });
  await run(bd, prApi, { log: (l) => said.push(l) });
  assert.equal(prApi.calls.lists[0].limit, STRAND_SCAN_MAX, 'and it asks for a ceiling rather than taking the default of 40');
  assert.ok(
    said.some((l) => new RegExp(`at least ${STRAND_SCAN_MAX} open pull requests`).test(l)),
    `a partial answer presented as the whole one is the bug: ${said.join(' | ')}`
  );
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

/* --------------------------------- the resolver that ends without resolving */

/**
 * bc-5mdsw, and the two halves of one loop.
 *
 * A conflict a resolver *declines* is the honest ending its brief offers it — both sides
 * load-bearing, only Adam can say which wins — and until this landed the queue could not
 * tell that ending apart from work in progress. `resolving` came off only when the branch
 * stopped conflicting, a resolver spent no attempt, so a branch that never stopped
 * conflicting had no route to `MAX_ATTEMPTS` and no route to the card. #488 collected nine
 * windows on byte-identical state and escaped only because its conflict eventually turned
 * into a red check, which is a different path and one that does record.
 */
await check('A BRANCH GITHUB HAS NOT ANSWERED ABOUT YET IS NOT ONE ITS RESOLVER FIXED', async () => {
  // The read that produced eight "no longer conflicts" lines for one branch that kept
  // conflicting: GitHub answers UNKNOWN for every open pull request for a window right
  // after a merge lands, which is exactly when this sweep runs.
  const unknown = openPr({ mergeable: 'UNKNOWN', mergeState: 'UNKNOWN' });
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const prApi = fakePr(unknown);
  const out = await run(bd, prApi, { resolverOn: async () => false });
  assert.deepEqual(out.reclaimed, [], 'a non-answer was read as the resolver having finished');
  assert.deepEqual(out.refused, [], 'a non-answer was read as the resolver having given up');
  assert.equal(prApi.calls.merges.length, 0);
  assert.equal(bd.calls.updates.length, 0, 'it rewrote the state block over an answer it never got');
});

await check('A RESOLVER THAT ENDED WITHOUT RESOLVING SPENDS AN ATTEMPT', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 0, resolving: true, refused: 'the branch conflicts with its base' }) })] });
  const asked = [];
  const out = await run(bd, fakePr(dirty), { resolverOn: async (entry) => (asked.push(entry.spec.number), false) });
  assert.deepEqual(asked, [42], 'the registry was never asked whether a window is still on it');
  assert.deepEqual(out.refused, ['zz-merge']);
  const written = bd.calls.updates.find((u) => u.id === 'zz-merge');
  const state = queueState({ notes: written.notes });
  assert.equal(state.attempts, 1, 'the stand-down still spent nothing, so nothing carries it to a card');
  assert.equal(state.declined, true);
  assert.equal(state.resolving, false);
  // Factual, and the same sentence every tick — `record` counts the *same* refusal, so a
  // sentence that varied would restart the three attempts on each one.
  assert.match(state.refused, /still conflicts with .main. and no resolver is on it any more/);
});

await check('and one a resolver is still on is left exactly where it is', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const out = await run(bd, fakePr(dirty), { resolverOn: async () => true });
  assert.deepEqual(out.refused, []);
  assert.equal(bd.calls.updates.length, 0, 'it spent an attempt over a window that is still open');
});

await check('and with nothing wired up to ask, the flag stays exactly as it did before', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 1, resolving: true }) })] });
  const out = await run(bd, fakePr(dirty));
  // Not knowing whether a window is open must never be read as knowing that none is.
  assert.deepEqual(out.refused, []);
  assert.equal(bd.calls.updates.length, 0);
});

await check('A CONFLICT ONE RESOLVER DECLINED IS NOT HANDED ANOTHER, AND EACH TICK COSTS AN ATTEMPT', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  let opened = 0;
  const opts = { openResolver: async () => (opened += 1, true), resolverOn: async () => false };

  // Tick one: the stand-down is noticed off the registry and the door is shut.
  const first = fakeBd({ rows: [bead({ notes: withQueueBlock('', { attempts: 0, resolving: true }) })] });
  await run(first, fakePr(dirty), opts);
  const after = first.calls.updates.find((u) => u.id === 'zz-merge').notes;
  assert.equal(queueState({ notes: after }).attempts, 1);

  // Tick two, on what tick one actually wrote — which is the only honest way to assert
  // that the sentence is stable, and a sentence that varied would restart the count.
  const second = fakeBd({ rows: [bead({ notes: after })] });
  const out = await run(second, fakePr(dirty), opts);
  assert.equal(opened, 0, 'a second window re-derives the same hand-back at the cost of a whole session');
  assert.deepEqual(out.raised, []);
  assert.deepEqual(out.refused, ['zz-merge']);
  const state = queueState({ notes: second.calls.updates.find((u) => u.id === 'zz-merge').notes });
  assert.equal(state.attempts, 2, 'the sentence is the same one, so the count carries');
  assert.equal(state.declined, true);
});

await check('and three of those is the card the stand-down should have produced', async () => {
  const dirty = openPr({ mergeable: 'CONFLICTING', mergeState: 'DIRTY' });
  const spent = bead({ notes: withQueueBlock('', { attempts: MAX_ATTEMPTS, declined: true, refused: 'the branch still conflicts' }) });
  const bd = fakeBd({ rows: [spent] });
  const raised = [];
  const out = await run(bd, fakePr(dirty), { raise: async (entry, why) => (raised.push(why), 'zz-card') });
  assert.deepEqual(out.stuck, ['zz-merge']);
  assert.equal(raised.length, 1, 'the loop this bead is named for still has no exit');
});

await check('and the flag comes off the moment the branch stops conflicting', async () => {
  const bd = fakeBd({
    rows: [bead({ notes: withQueueBlock('', { attempts: 1, declined: true, refused: 'the branch still conflicts' }) })],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
  });
  const prApi = fakePr(openPr());
  await run(bd, prApi);
  // Adam resolved it himself, or `main` moved so that it no longer collides. Left standing,
  // the flag would refuse a resolver to a *new* conflict months later.
  assert.equal(prApi.calls.merges.length, 1);
  const written = bd.calls.updates.filter((u) => u.id === 'zz-merge');
  assert.ok(written.length, 'nothing took the sentence back');
  assert.equal(queueState({ notes: written[0].notes }).declined, false);
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

await check('and it tells a review that is happening from one that is only owed, and names what is in line', async () => {
  const bare = { ok: true, merged: [], updated: [], refused: [], raised: [], waiting: [] };
  // bc-xl7n.129. `awaiting` is true of a pull request a reviewer is reading right now and
  // of one nothing has ever looked at, so on its own the line cannot say which.
  assert.match(describeMergeQueue({ ...bare, reviewing: ['a'] }), /1 being reviewed/);
  assert.match(describeMergeQueue({ ...bare, answering: ['a', 'b'] }), /2 being answered/);
  // And the wait this bead is about: a window asked for and not opened, which for three
  // hours was reported as a window that had been.
  const line = describeMergeQueue({ ...bare, inLine: [539, 626, 627] });
  assert.match(line, /3 in line for a window \(#539, #626, #627\)/, line);
  const long = describeMergeQueue({ ...bare, inLine: [539, 626, 627, 629, 631] });
  assert.match(long, /5 in line for a window \(#539, #626, #627 and 2 more\)/, long);
  // Optional, for `held`'s reason: a caller predating the fields hands this a plain object.
  assert.equal(describeMergeQueue(bare), '');
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

await check('a window the Mac was too full to open is counted as in line, not as opened', async () => {
  // bc-xl7n.129. The door returns `'queued'` when `resolveFor` put the pull request in
  // line rather than opening a window — still truthy, so nothing that only asks yes-or-no
  // changed, and counted apart so the card can say what is waiting. Before this a queued
  // window and a live one were the same number, which is why 25 pull requests could sit in
  // line for three hours with every log line on the path reading as success.
  const rev = { round: 1, verdict: 'changes', reviewedSha: HEAD, comments: [{ id: 'c1', body: 'this leaks a handle' }] };
  const bd = fakeBd({ rows: [reviewed(rev)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON, openAnswer: async () => 'queued' });
  assert.deepEqual(out.answering, [], 'a window that never went up must not be reported as one that did');
  assert.deepEqual(out.inLine, [42], 'the pull request number, because the card names them and bead ids are not what is in line');
  assert.deepEqual(out.awaiting, ['zz-merge'], 'and it is still waiting on the worker either way');
  assert.match(describeMergeQueue(out), /1 in line for a window \(#42\)/, describeMergeQueue(out));
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

await check('AND A BRANCH GITHUB WOULD NOT UPDATE IS NOT REPORTED AS STRAIGHT THROUGH', async () => {
  // bc-johbj: nothing moved *because* the queue could not move it, and "straight through"
  // is the most misleading line the report has — it reads as a branch that needed nothing.
  const state = { attempts: 0, downmerges: 0, downmergeRefusals: 2, downmergeRefusal: 'gh: Not Found (HTTP 404)' };
  const bd = fakeBd({ rows: [bead({ notes: withQueueBlock('', state) })], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  await run(bd, prApi);
  const onPr = prApi.calls.comments[0].text;
  assert.doesNotMatch(onPr, /Straight through/, 'two refused updates were reported as a clean passage');
  assert.match(onPr, /could not be brought in/, onPr);
  assert.match(onPr, /Not Found \(HTTP 404\)/, 'the refusal is the half that says whose problem this is');
  assert.doesNotMatch(onPr, /base moved under it/, 'a refusal was described as a downmerge');
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

/* -------------------------------------- merging over open review findings (bc-9ntye.2) */

/**
 * An approval that still carries an unresolved suggestion — the state bc-9ntye makes
 * ordinary. The gate lets it through (approved is approved) and the findings have to
 * land somewhere; before bc-9ntye.2 they were closed with the merge-bead and gone.
 */
const APPROVED_WITH_OPEN = {
  ...APPROVED,
  comments: [
    { id: 'c1', path: 'lib/example.js', line: 42, body: 'this could be a Set', severity: 'suggestion' },
    { id: 'c2', body: 'why is the retry four', severity: 'question' },
  ],
};

await check('a merge over open findings files one follow-up with one child each', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(bd.calls.created.length, 3, 'one follow-up and one child per finding');
  assert.equal(bd.calls.created[1].parent, bd.calls.created[0].id);
  assert.match(bd.calls.labelReads[0], /^review-followup:/, 'and it asked whether this round was already filed');
});

await check('and every sentence the merge writes names the bead the findings went to', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  await run(bd, prApi, { policy: REVIEW_ON, autoEndorse: true });
  const follow = bd.calls.created[0].id;
  // The pull request page, the merge-bead's close reason and the work bead's comment —
  // the three places somebody finds out about this, and the epic asks for all three.
  assert.match(prApi.calls.comments.at(-1).text, new RegExp(follow), 'the report on the pull request');
  assert.ok(
    bd.calls.closes.some((c) => c.id === 'zz-merge' && new RegExp(follow).test(c.reason)),
    "the merge-bead's own close reason"
  );
  assert.ok(
    bd.calls.comments.some((c) => c.id === 'zz-work' && new RegExp(follow).test(c.text)),
    'and the comment on the work bead'
  );
});

/* --------------------------------- the landed card can name the follow-up (bc-9ntye.5) */

await check('the landed card is told the follow-up bead, which afterMerge never sees', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const prApi = fakePr(openPr());
  const cards = [];
  await run(bd, prApi, {
    policy: REVIEW_ON,
    autoEndorse: true,
    afterMerge: async () => {}, // present and empty: proves the card comes from a separate seam
    announceLanding: async (spec, issue, { findings }) => cards.push({ bead: spec.bead, findings }),
  });
  const follow = bd.calls.created[0].id;
  assert.equal(cards.length, 1, 'the card is announced exactly once');
  assert.equal(cards[0].bead, 'zz-work');
  assert.match(cards[0].findings, new RegExp(follow), 'the sentence names the bead the findings went to');
});

await check("a clean merge's card is unchanged", async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const cards = [];
  await run(bd, fakePr(openPr()), { announceLanding: async (spec, issue, { findings }) => cards.push(findings) });
  assert.deepEqual(cards, [''], 'nothing was owed, so the card says nothing was owed');
});

await check('announceLanding runs after afterMerge, in the order the two callbacks were named for', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const seen = [];
  await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    autoEndorse: true,
    afterMerge: async () => seen.push('afterMerge'),
    announceLanding: async () => seen.push('announceLanding'),
  });
  // afterMerge fires before `finish`, and `finish` is where the follow-up bead this card
  // wants to name is minted — so this order is not incidental, it is the whole fix.
  assert.deepEqual(seen, ['afterMerge', 'announceLanding']);
});

await check('a card that fails to send does not stand between the merge and either close', async () => {
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const out = await run(bd, fakePr(openPr()), {
    announceLanding: async () => {
      throw new Error('bus is down');
    },
  });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
});

await check('a pull request merged outside the queue never rings the phone', async () => {
  // The same door `markMerged` above proved is threaded to this path — `announceLanding`
  // is deliberately not, for the reason in lib/server.js's own comment: a merge Adam did
  // himself, from GitHub or the phone, is a tap of his and must not chime for it.
  const bd = fakeBd({ rows: [bead()], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  const cards = [];
  const prApi = fakePr(openPr({ state: 'MERGED', mergedAt: '2026-08-16T12:00:00Z', mergeCommit: 'a1b2c3d4e5' }));
  await run(bd, prApi, { announceLanding: async () => cards.push('rang') });
  assert.deepEqual(cards, []);
});

await check('the same verdict on the next tick files nothing a second time', async () => {
  // The failure this guards: `finish` is best-effort throughout, so a tick that died
  // between the filing and the close arrives back here at exactly this state.
  const bd = fakeBd({
    rows: [reviewed(APPROVED_WITH_OPEN)],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    followups: [{ id: 'zz-already', status: 'open' }],
  });
  await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true });
  assert.deepEqual(bd.calls.created, [], 'it filed a second copy of a whole review');
  assert.ok(
    bd.calls.closes.some((c) => c.id === 'zz-merge' && /zz-already/.test(c.reason)),
    'and it still named the one that exists'
  );
  assert.deepEqual(bd.calls.labelReads, ['review-followup:acme/widgets#42:r1'], 'keyed on the pull request and the round');
});

await check('a clean approval files nothing and costs no lookup at all', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true });
  assert.deepEqual(bd.calls.created, []);
  assert.deepEqual(bd.calls.labelReads, [], 'the guard is before the tracker, which is what keeps it off every merge');
});

await check('a tracker that will not file leaves the merge and both closes exactly as they were', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } } });
  bd.create = async () => {
    throw new Error('dolt: database is locked');
  };
  const out = await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work'], 'a lost follow-up must not cost a close');
});

/* ------------------------- telling the root's advocate about it (bc-9ntye.3) */

/**
 * A filed follow-up is open, unclaimed work under a root — which is already what
 * `bd ready` and the re-entry sweep mean. The one case neither covers is a root whose Epic
 * Advocate window is **live**: the sweep will not open a second one, and the live one read
 * `bd children` at the top of its turn and will not read them again. So the queue tells it.
 *
 * What these four pin is mostly the *silence*: told when there is an advocate, nothing at
 * all when there is not, never twice, and never in a way that could reach the two closes.
 */
const ADVOCATED = {
  beads: new Map([
    ['zz-epic', { id: 'zz-epic', issue_type: 'epic', status: 'open', title: 'a theme', labels: ['owner:someone@example.com', 'advocate-assigned'] }],
    ['zz-work', { id: 'zz-work', issue_type: 'task', priority: 2, status: 'open' }],
  ]),
  parents: new Map([['zz-work', 'zz-epic']]),
  adopts: new Map(),
  edges: new Map(),
};

await check('a follow-up under an advocated root tells that root\'s advocate, once', async () => {
  const asked = [];
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } }, graph: ADVOCATED });
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    autoEndorse: true,
    tellAdvocate: async (ask) => {
      asked.push(ask);
      return { state: 'told' };
    },
  });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.equal(asked.length, 1, 'the advocate was told once, or not at all');
  assert.equal(asked[0].root, 'zz-epic', 'it told the root the follow-up was parented onto');
  assert.equal(asked[0].title, 'a theme', "and named the epic, not only its id");
  assert.equal(asked[0].followUp.id, bd.calls.created[0].id);
});

await check('a root nothing advocates is told nothing — an open bead under it is already bd ready', async () => {
  const asked = [];
  const bare = {
    ...ADVOCATED,
    // Open, owned, a root: `wantsAdvocate` says yes and there is still no advocate on it.
    beads: new Map([...ADVOCATED.beads].map(([id, row]) => [id, id === 'zz-epic' ? { ...row, labels: ['owner:someone@example.com'] } : row])),
  };
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } }, graph: bare });
  await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true, tellAdvocate: async (a) => asked.push(a) });
  assert.equal(bd.calls.created.length, 3, 'the follow-up is filed either way');
  assert.deepEqual(asked, [], 'it typed into a window about an epic that has no advocate');
});

await check('a merge that filed nothing reads no graph and tells nobody', async () => {
  const asked = [];
  const bd = fakeBd({ rows: [reviewed(APPROVED)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } }, graph: ADVOCATED });
  let graphs = 0;
  const graph = bd.graph;
  bd.graph = async (...a) => {
    graphs += 1;
    return graph(...a);
  };
  await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true, tellAdvocate: async (a) => asked.push(a) });
  assert.deepEqual(asked, []);
  assert.equal(graphs, 0, 'a clean approval paid for a graph read it had no use for');
});

await check('a follow-up an earlier tick filed is not announced a second time', async () => {
  // The same guard `finish`'s own idempotence has, one step out: a tick that died between
  // the filing and the close arrives back here, and the advocate has already been told.
  const asked = [];
  const bd = fakeBd({
    rows: [reviewed(APPROVED_WITH_OPEN)],
    issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } },
    graph: ADVOCATED,
    followups: [{ id: 'zz-already', status: 'open' }],
  });
  await run(bd, fakePr(openPr()), { policy: REVIEW_ON, autoEndorse: true, tellAdvocate: async (a) => asked.push(a) });
  assert.deepEqual(bd.calls.created, []);
  assert.deepEqual(asked, [], 'it typed the same paragraph into a window that had already acted on it');
});

await check('an advocate that could not be reached costs neither the merge nor a close', async () => {
  const bd = fakeBd({ rows: [reviewed(APPROVED_WITH_OPEN)], issues: { 'zz-work': { id: 'zz-work', issue_type: 'task' } }, graph: ADVOCATED });
  const out = await run(bd, fakePr(openPr()), {
    policy: REVIEW_ON,
    autoEndorse: true,
    tellAdvocate: async () => {
      throw new Error('Not authorised to send Apple events to iTerm2.');
    },
  });
  assert.deepEqual(out.merged, ['zz-merge']);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work'], 'an unreachable window must not cost a close');
  assert.ok(
    bd.calls.closes.some((c) => c.id === 'zz-merge' && new RegExp(bd.calls.created[0].id).test(c.reason)),
    'and the merge still named where the findings went'
  );
});

/* ------------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
