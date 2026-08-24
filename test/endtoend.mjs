#!/usr/bin/env node
/**
 * The whole review loop, end to end: delivered, reviewed, answered, approved, merged.
 *
 *     npm test
 *     node test/endtoend.mjs
 *
 * bc-36xx.9 — the last bead of bc-36xx, and the one the epic exists for. Every other
 * suite in this family pins one decision with the rest of the world held still:
 * test/reviewgate.mjs judges a review block that somebody wrote by hand,
 * test/reviewsync.mjs translates a verdict nobody submitted, test/reviewanswer.mjs checks
 * answers to comments no reviewer ever raised, and test/mergequeue.mjs drives one tick at
 * a time over a bead it was handed pre-baked. Each of those is the right shape for what it
 * covers. What none of them can see is the **join**: whether the document one half writes
 * is the document the other half reads, one round after another, with nothing in between
 * putting the state right by hand.
 *
 * That is not a hypothetical failure mode here. bc-36xx.22 was exactly it — seven exported
 * functions, every one of them unit-tested and correct, and no caller anywhere between the
 * comment a reviewer wrote and the block the gate read. The loop was green in pieces and
 * did not close. So this suite is deliberately built the other way round from its
 * neighbours: **one mutable world, and nobody reaches into it except through the code
 * under test.**
 *
 * ## What is real here and what is not
 *
 * Real: `sweepMergeQueue` and its gate, `syncReviewVerdict`'s fold, `formatVerdict` and
 * `checkVerdict` (the reviewer's document), `checkAnswers`/`withAnswers`/`withReviewBlock`
 * (bin/answer.js's core, lifted out of its argv and its `git rev-parse`), `approvalNote`,
 * `approvalComment` and `mergeReport`. The tracker is a `Map` that actually keeps what is
 * written to it and hands back a fresh copy each tick, so a write that does not go through
 * `bd.update` does not survive to the next one. GitHub is an object that remembers what was
 * submitted to it.
 *
 * Not real, and deliberately: the windows. `openReview` and `openAnswer` record that a
 * window was owed, and then this file *plays* the agent that window would have opened, by
 * writing the same document through the same functions. The alternative is a suite that
 * spawns two Claude sessions per run, and the thing worth pinning is not that an agent can
 * be launched — lib/session.js has its own tests for that — but that the paperwork joins
 * up.
 *
 * ## This is not the only evidence, and it is the only *repeatable* evidence
 *
 * `reviewRequiredPerWorkspace` gained `{"beadcause": true}` on 2026-08-23 and the loop ran
 * live within the hour: #618 approved by `NeanderthalMan` at 16:11:58Z and merged six
 * seconds later, #617 the same at 16:14:35Z, and #539 taking the other branch with three
 * comments and a worker's window. That is worth more than anything here — and it is not a
 * test, because it cannot be re-run and it says nothing at all on a day when the queue is
 * empty. This suite is what keeps the join pinned in between.
 *
 * ## The five things that would hurt most, in order
 *
 * 1. **The loop closes at all.** Four ticks, two rounds, and the branch merges with both
 *    beads closed and nothing having been hand-corrected in between.
 * 2. **The two records of the approval are written together** — the review on GitHub and
 *    the stamp on the bead, in one tick, from one verdict. The known way for them to
 *    disagree is one of them being written and the other not.
 * 3. **Only the reviewer settles a comment.** A worker's answer moves the turn and does
 *    not clear anything; the loop ends when the *reviewer* agrees.
 * 4. **The two gates stay in series.** `reviewRequired` off and `requireApproval` on is a
 *    pull request that still waits for Adam with the agent's approval sitting on it.
 * 5. **The closing comment says an agent approved it**, which is Adam's standing rider on
 *    bc-0cop and the only thing on the page a person scrolling to the bottom will read.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-endtoend-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { sweepMergeQueue, mergeReport } = await import(LIB('mergequeue.js'));
const {
  MERGE_ASSIGNEE,
  MERGE_LABEL,
  commentsForReviewer,
  commentsForWorker,
  mergeBeadBody,
  queueState,
  reviewState,
  withQueueBlock,
  withReviewBlock,
} = await import(LIB('mergebead.js'));
const { formatVerdict } = await import(LIB('reviewadvocate.js'));
const { checkAnswers, parseAnswers, withAnswers, answerComment } = await import(LIB('reviewanswer.js'));
const { admittedState } = await import(LIB('mergeadmit.js'));
const { prPolicyFor } = await import(LIB('spaces.js'));

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\ndelivered, reviewed, answered, approved, merged — the whole loop\n');

/* =========================================================================== the world */

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

const DELIVERED = 'aaaaaaa1';
const ANSWERED = 'bbbbbbb2';
const REVIEWER = { login: 'NeanderthalMan', user: '', slug: 'acme/widgets', permission: 'write' };

/**
 * A tracker that keeps what is written to it.
 *
 * The one thing that makes this suite different from test/mergequeue.mjs, and the whole
 * reason it can be called end to end: `update` really replaces `notes`, `comment` really
 * appends, and `listAgent` hands back a **copy** per tick. The copy is what enforces the
 * property under test — anything the sweep works out and does not write through
 * `bd.update` is gone by the next tick, exactly as it would be against a real bd.
 */
function tracker(seed = []) {
  const beads = new Map(seed.map((b) => [b.id, { ...b }]));
  const threads = new Map();
  const calls = { closes: [], comments: [], updates: [] };
  return {
    calls,
    beads,
    /** What is on a bead right now — the test's own read, never the code's. */
    at: (id) => beads.get(id),
    /** Somebody other than the queue writing a comment: a reviewer, or a worker. */
    say: (id, text) => {
      if (!threads.has(id)) threads.set(id, []);
      threads.get(id).push({ text });
    },
    listAgent: async () => [...beads.values()].map((b) => ({ ...b })),
    show: async (ws, id) => {
      const row = beads.get(id);
      return row ? { ...row } : null;
    },
    close: async (ws, id, reason) => {
      calls.closes.push({ id, reason });
      const row = beads.get(id);
      if (row) row.status = 'closed';
    },
    comment: async (ws, id, text) => {
      calls.comments.push({ id, text });
      if (!threads.has(id)) threads.set(id, []);
      threads.get(id).push({ text });
    },
    update: async (ws, id, patch) => {
      calls.updates.push({ id, ...patch });
      const row = beads.get(id);
      if (row) Object.assign(row, patch);
    },
    comments: async (ws, id) => (threads.get(id) || []).map((c) => ({ ...c })),
  };
}

/** A GitHub that remembers what was submitted to it. */
function github(head = DELIVERED) {
  const calls = { merges: [], comments: [], approvals: [], reviews: [], updates: [] };
  const pr = {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    mergeState: 'CLEAN',
    checks: { failed: [], failing: 0, pending: 0, total: 3, state: 'passing' },
    reviewDecision: null,
    mergedAt: null,
    headSha: head,
  };
  return {
    calls,
    pr,
    /** The worker pushing what it changed — a single-parent commit, so the gate counts it. */
    push: (sha) => {
      pr.headSha = sha;
    },
    view: async () => ({ ...pr }),
    baseChecks: async () => ({ failed: [] }),
    updateBranch: async (dir, n) => {
      calls.updates.push(n);
      return { updated: true, reason: '' };
    },
    merge: async (dir, n, opts) => {
      calls.merges.push({ n, ...opts });
      pr.state = 'MERGED';
      pr.mergedAt = '2026-08-23T12:00:00Z';
      return { mergeCommit: 'f00dcafe99' };
    },
    comment: async (dir, n, text) => calls.comments.push({ n, text }),
    reviewerFor: async () => REVIEWER,
    approve: async (dir, n, opts) => {
      calls.approvals.push({ n, ...opts });
      return {
        submitted: true,
        reviewer: REVIEWER.login,
        url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-9',
        at: '2026-08-23T11:00:00Z',
      };
    },
    submitReview: async (dir, n, opts) => {
      calls.reviews.push({ n, ...opts });
      return {
        submitted: true,
        reviewer: REVIEWER.login,
        url: 'https://github.com/acme/widgets/pull/42#pullrequestreview-8',
        at: '2026-08-23T10:00:00Z',
      };
    },
  };
}

/**
 * The two beads a delivery leaves behind: the work bead the worker was opened for, and the
 * merge-bead `bin/deliver.js` files and makes it depend on.
 */
const delivered = () => [
  { id: 'zz-work', title: 'the work', status: 'open', issue_type: 'task', labels: [], notes: '' },
  {
    id: 'zz-merge',
    title: 'Merge #42 — zz-work',
    status: 'open',
    issue_type: 'task',
    labels: [MERGE_LABEL],
    assignee: MERGE_ASSIGNEE,
    description: mergeBeadBody(SPEC),
    notes: '',
    created: '2026-08-23T09:00:00Z',
  },
];

const resolve = async () => ({ unit: { key: 'demo/widgets' }, dir: '/tmp/widgets', reason: '' });

/**
 * One tick of the daemon, with the two windows it can open recorded rather than opened.
 *
 * `opened` is the whole of the fake: what the loop is actually asserted on is which agent
 * the queue says is owed a turn, and lib/session.js is where opening one is tested.
 */
function tick(bd, gh, opts = {}) {
  const opened = { review: [], answer: [] };
  const raised = [];
  return sweepMergeQueue(bd, { name: 'demo' }, {
    resolve,
    prApi: gh,
    owner: 'Adam',
    openReview: async (entry) => {
      opened.review.push(entry.issue.id);
      return true;
    },
    openAnswer: async (entry) => {
      opened.answer.push(entry.issue.id);
      return true;
    },
    raise: async (entry, why, o) => {
      raised.push({ id: entry.issue.id, why, ...o });
      return true;
    },
    ...opts,
  }).then((out) => ({ ...out, opened, raised }));
}

/* ------------------------------------------------------ the two agents, played straight */

/** What a ReviewAdvocate window does: one comment on the merge-bead, in its own format. */
const reviews = (bd, verdict) => bd.say('zz-merge', formatVerdict(verdict, { owner: 'Adam' }));

/**
 * What the reopened worker does — bin/answer.js with its argv, its `git rev-parse` and its
 * `process.exit` taken off, and nothing else changed. Every refusal `checkAnswers` can
 * make is therefore reachable from here, which is the point of going through it rather
 * than writing the answers onto the block directly.
 */
async function answers(bd, yaml, { sha = '' } = {}) {
  const row = await bd.show('demo', 'zz-merge');
  const state = reviewState(row);
  const { answers: parsed, error } = checkAnswers(parseAnswers(yaml), state);
  if (error) throw new Error(`the worker's answers were refused: ${error}`);
  const next = withAnswers(state, parsed);
  await bd.update('demo', 'zz-merge', { notes: withReviewBlock(row.notes, next) });
  await bd.comment('demo', 'zz-merge', answerComment(parsed, { round: state.round, sha }));
  return parsed;
}

/* ======================================================================== round one */

/**
 * The verdict a reviewer writes on the first pass. Two comments and only one of them
 * blocking, because the pair is what makes the severity assertions mean anything: a round
 * trip that flattened them would still look right with one comment on it.
 */
const ROUND_ONE = {
  pr: 42,
  bead: 'zz-work',
  round: 1,
  approved: false,
  why: 'the handle is not released on the error path',
  comments: [
    {
      id: 'c1',
      file: 'lib/widget.js',
      line: 88,
      severity: 'blocking',
      what: 'this leaks the handle when the parse throws',
      why: 'the finally never runs, so the next caller blocks forever',
    },
    {
      id: 'c2',
      file: 'lib/widget.js',
      line: 12,
      severity: 'suggestion',
      what: 'this name reads as a boolean and is a count',
      why: '',
    },
  ],
};

const ROUND_TWO = { pr: 42, bead: 'zz-work', round: 2, approved: true, why: '', comments: [] };

/**
 * The whole loop in one function, so the cases below can each assert a different thing
 * about the *same* passage rather than each staging their own approximation of it.
 *
 * Returns everything a case might want to look at: every tick's result, the tracker, and
 * GitHub. Nothing in here corrects the state between ticks — the only writes are the two
 * agents' own documents, through their own code.
 */
async function wholeLoop({ policy = { reviewRequired: true }, admit = null } = {}) {
  const bd = tracker(delivered());
  const gh = github();
  const ticks = [];

  /* 1. Delivered, and nothing has read it. */
  ticks.push(await tick(bd, gh, { policy }));

  /* The ReviewAdvocate's first pass. */
  reviews(bd, ROUND_ONE);
  ticks.push(await tick(bd, gh, { policy }));

  /* The worker, reopened on its own branch, answers and pushes. */
  await answers(
    bd,
    ['- id: c1', '  answer: changed', '  note: the handle is closed in a finally now', '- id: c2', '  answer: declined', '  note: it is a count elsewhere too; renaming it here would split the vocabulary'].join('\n'),
    { sha: ANSWERED }
  );
  gh.push(ANSWERED);
  ticks.push(await tick(bd, gh, { policy }));

  /* The ReviewAdvocate's second pass: persuaded, and nothing carried forward. */
  reviews(bd, ROUND_TWO);
  ticks.push(await tick(bd, gh, { policy }));

  /* And, where the space asks for it, Adam's own admission after the agent's approval. */
  if (admit) {
    await bd.update('demo', 'zz-merge', {
      notes: withQueueBlock(bd.at('zz-merge').notes, admittedState(queueState(bd.at('zz-merge')), { by: admit, at: '2026-08-23T11:30:00Z' })),
    });
    ticks.push(await tick(bd, gh, { policy }));
  }

  return { bd, gh, ticks };
}

/* ================================================================== 1. the loop closes */

await check('THE WHOLE LOOP CLOSES: delivered → reviewed → answered → approved → merged', async () => {
  const { bd, gh, ticks } = await wholeLoop();

  // Tick 1 — nobody has looked. Not merged, and not even downmerged: the gate sits above
  // the downmerge so the diff does not move under a reviewer who has not read it yet.
  assert.deepEqual(ticks[0].merged, [], 'it merged a pull request nothing had reviewed');
  assert.deepEqual(gh.calls.updates, [], 'it brought the base into a branch nobody had reviewed');
  assert.deepEqual(ticks[0].opened.review, ['zz-merge'], 'no reviewer was asked for');

  // Tick 2 — the verdict is folded in and the worker owes answers.
  assert.deepEqual(ticks[1].merged, []);
  assert.deepEqual(ticks[1].opened.answer, ['zz-merge'], 'the worker was never reopened to answer');

  // Tick 3 — answered, so it is the reviewer's turn again.
  assert.deepEqual(ticks[2].merged, []);
  assert.deepEqual(ticks[2].opened.review, ['zz-merge'], 'the answered comments never went back to a reviewer');

  // Tick 4 — approved, and it lands.
  assert.deepEqual(ticks[3].merged, ['zz-merge'], 'two rounds ended in agreement and it still did not merge');
  assert.equal(gh.calls.merges.length, 1);
  assert.equal(gh.calls.merges[0].method, 'merge');
  assert.equal(gh.calls.merges[0].deleteBranch, false, 'the branch was deleted, and lib/tidy.js reads it after the merge');

  // Both beads, merge-bead first, because the work bead depends on it.
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
  assert.equal(bd.at('zz-work').status, 'closed');
});

await check('and nothing was refused, carded or hand-corrected on the way through', async () => {
  const { bd, ticks } = await wholeLoop();
  assert.deepEqual(ticks.flatMap((t) => t.refused), [], 'a wait was counted as a refusal');
  assert.deepEqual(ticks.flatMap((t) => t.raised), [], 'the loop reached a person, which is the failure this epic is for');
  // The retry budget is for refusals. Three rounds of waiting must leave it untouched, or
  // a pull request whose reviewer is thinking becomes a card on the third tick.
  assert.equal(queueState(bd.at('zz-merge')).attempts, 0, 'waiting on a review spent an attempt');
});

/* ======================================================= 2. both records, one tick */

await check('THE TWO RECORDS OF THE APPROVAL ARE WRITTEN TOGETHER, FROM ONE VERDICT', async () => {
  // Driven a tick at a time rather than through `wholeLoop`, because what is under test is
  // the *boundary*: the two records must not straddle a tick. The known failure mode is one
  // of them landing without the other — a review submitted to GitHub that the bead does not
  // carry is a pull request the gate holds forever with a green tick on it, and a stamp with
  // no review behind it is the queue merging on a review nobody can go and read.
  const bd = tracker(delivered());
  const gh = github();
  const policy = { reviewRequired: true };
  await tick(bd, gh, { policy });
  reviews(bd, ROUND_ONE);
  await tick(bd, gh, { policy });
  await answers(bd, ['- id: c1', '  answer: changed', '- id: c2', '  answer: declined', '  note: it is a count elsewhere too'].join('\n'));
  gh.push(ANSWERED);
  await tick(bd, gh, { policy });

  // Before the tick that folds the approving verdict in: neither record exists.
  reviews(bd, ROUND_TWO);
  assert.equal(gh.calls.approvals.length, 0, 'GitHub already had an approving review');
  assert.notEqual(reviewState(bd.at('zz-merge')).verdict, 'approved', 'the bead was already stamped');

  const out = await tick(bd, gh, { policy });

  // After it: both, and the merge on the same pass.
  assert.equal(gh.calls.approvals.length, 1, 'no approving review was submitted to GitHub');
  assert.match(gh.calls.approvals[0].body, /Approved.*by the ReviewAdvocate — an agent, not Adam/s);

  const rev = reviewState(bd.at('zz-merge'));
  assert.equal(rev.verdict, 'approved');
  assert.equal(rev.round, 2);
  assert.equal(rev.approvedBy, REVIEWER.login, 'the stamp does not name the identity the review went out as');
  // The stamp is for the commit that is actually on the branch — not the one that was
  // there when the review was asked for, which the worker has since replaced.
  assert.equal(rev.reviewedSha, ANSWERED);
  assert.equal(rev.approvalUrl, 'https://github.com/acme/widgets/pull/42#pullrequestreview-9');
  assert.deepEqual(out.merged, ['zz-merge']);
});

await check('and the disclaimer goes under it, naming the login as an agent’s', async () => {
  const { gh } = await wholeLoop();
  // `approve()` carries it as its trailing note, since a bare approval needs no second
  // comment. It is the one thing on this pull request Adam asked for by name.
  assert.match(gh.calls.approvals[0].note, /That approval is an agent's, not Adam's/);
  assert.match(gh.calls.approvals[0].note, /`NeanderthalMan` is the account/);
  assert.match(gh.calls.approvals[0].note, /Nobody at a keyboard approved this/);
});

/* ============================================== 3. what a round trip has to preserve */

await check('THE ROUND TRIP KEEPS severity AND why — the field the worker’s judgement turns on', async () => {
  const bd = tracker(delivered());
  const gh = github();
  const policy = { reviewRequired: true };
  await tick(bd, gh, { policy });
  reviews(bd, ROUND_ONE);
  await tick(bd, gh, { policy });

  const rev = reviewState(bd.at('zz-merge'));
  assert.equal(rev.comments.length, 2);
  const [c1, c2] = rev.comments;
  // bc-36xx.18 (#560). A block that flattened these would hand the reopened worker two
  // comments it cannot tell apart, and the one judgement it has to make each round is
  // which of them it may decline.
  assert.equal(c1.severity, 'blocking');
  assert.equal(c2.severity, 'suggestion');
  assert.match(c1.why, /the finally never runs/);
  assert.equal(c1.path, 'lib/widget.js');
  assert.equal(c1.line, 88);
  assert.equal(c1.body, 'this leaks the handle when the parse throws');

  // And the same comments reached GitHub anchored to their lines, as a real review
  // requesting changes rather than a bare refusal.
  assert.equal(gh.calls.reviews.length, 1);
  assert.equal(gh.calls.reviews[0].event, 'REQUEST_CHANGES');
  assert.deepEqual(gh.calls.reviews[0].comments.map((c) => c.line), [88, 12]);
  assert.match(gh.calls.reviews[0].comments[0].body, /^\*\*blocking\*\*/);
});

await check('ONLY THE REVIEWER SETTLES A COMMENT — a worker’s answer moves the turn, nothing else', async () => {
  const bd = tracker(delivered());
  const gh = github();
  const policy = { reviewRequired: true };
  await tick(bd, gh, { policy });
  reviews(bd, ROUND_ONE);
  await tick(bd, gh, { policy });
  await answers(bd, ['- id: c1', '  answer: changed', '- id: c2', '  answer: declined', '  note: it is a count elsewhere too'].join('\n'));

  const rev = reviewState(bd.at('zz-merge'));
  assert.deepEqual(commentsForWorker(rev), [], 'the worker still owes an answer it has given');
  assert.equal(commentsForReviewer(rev).length, 2, 'a change the worker made closed itself');
  assert.equal(rev.comments.every((c) => !c.resolved), true, 'the worker resolved a comment, which is the reviewer’s field');
  assert.equal(rev.verdict, 'changes', 'answering the comments changed the verdict');

  // And so the queue asks the reviewer, not the worker — including about the one the
  // worker says it changed. Adam's rule: a change is a change somebody has to check.
  const out = await tick(bd, gh, { policy });
  assert.deepEqual(out.opened.review, ['zz-merge']);
  assert.deepEqual(out.opened.answer, []);
  assert.deepEqual(out.merged, []);
});

await check('a declined comment survives into the round that approves over it', async () => {
  // The worker declined c2 and the reviewer approved anyway, which is ordinary and must
  // stay legible: the decline and its reason are on the bead where the next reader lands.
  const { bd } = await wholeLoop();
  // The bead's whole thread, whoever wrote to it — the reviewer's verdicts, the worker's
  // reply and the queue's report all land in the one place a person opens.
  const said = (await bd.comments('demo', 'zz-merge')).map((c) => c.text).join('\n');
  assert.match(said, /1 changed, 1 declined/, 'the worker’s reply never reached the bead');
  assert.match(said, /would split the vocabulary/, 'the reason it was declined is not on the bead');
  assert.match(said, /Approved on #42 by the ReviewAdvocate/, 'the approving verdict is not on the bead');
});

/* ========================================================= 4. the two gates, in series */

await check('requireApproval OFF: the agent’s approval alone releases the pull request', async () => {
  const { ticks, gh } = await wholeLoop({ policy: { reviewRequired: true, requireApproval: false } });
  assert.deepEqual(ticks[3].merged, ['zz-merge']);
  assert.equal(gh.calls.merges.length, 1);
  assert.deepEqual(ticks.flatMap((t) => t.raised), [], 'it asked Adam in a space that does not ask for him');
});

await check('requireApproval ON: THE AGENT’S APPROVAL IS NECESSARY AND NOT SUFFICIENT', async () => {
  const { bd, gh, ticks } = await wholeLoop({ policy: { reviewRequired: true, requireApproval: true } });

  // Reviewed, approved, green, clean — and it still does not merge, because the space asks
  // for a person and an agent is not one. Adam's answer to bc-0cop.
  assert.deepEqual(ticks[3].merged, [], 'an agent’s approval released a pull request a space wanted Adam to admit');
  assert.equal(gh.calls.merges.length, 0);
  assert.deepEqual(ticks[3].raised.map((r) => r.approval), [true], 'it did not ask him, or asked for the wrong thing');
  // Not a refusal: nothing was asked of the branch, so nothing failed it and no attempt
  // was spent waiting for a tap.
  assert.deepEqual(ticks[3].refused, []);
  assert.equal(queueState(bd.at('zz-merge')).attempts, 0);

  // And the review is on it the whole time — it is the approval gate holding it, not the
  // review gate, which is what makes the two separable at all.
  assert.equal(reviewState(bd.at('zz-merge')).verdict, 'approved');
});

await check('…and his admission is what lets the same pull request through', async () => {
  const { bd, gh, ticks } = await wholeLoop({ policy: { reviewRequired: true, requireApproval: true }, admit: 'Adam' });
  assert.deepEqual(ticks[4].merged, ['zz-merge'], 'the admission did not release it');
  assert.equal(gh.calls.merges.length, 1);
  assert.deepEqual(bd.calls.closes.map((c) => c.id), ['zz-merge', 'zz-work']);
  // Both gates satisfied, each by its own record: the stamp in the queue block is his and
  // the stamp in the review block is the agent's, and neither stood in for the other.
  assert.equal(queueState(bd.at('zz-merge')).approvedBy, 'Adam');
  assert.equal(reviewState(bd.at('zz-merge')).approvedBy, REVIEWER.login);
});

await check('and the review gate alone stops it, with no approval gate anywhere near it', async () => {
  // The other half of "in series": a space asking for neither Adam nor a downmerge still
  // holds a pull request nobody has read. The review gate is not the approval gate wearing
  // another name.
  const bd = tracker(delivered());
  const gh = github();
  const out = await tick(bd, gh, { policy: { reviewRequired: true, requireApproval: false } });
  assert.deepEqual(out.merged, []);
  assert.deepEqual(out.awaiting, ['zz-merge']);
  assert.match(queueState(bd.at('zz-merge')).refused, /waiting on a review/);
});

await check('a pull request Adam opened himself is not review-gated at all', async () => {
  // Scope, and the reason the gate keys on the work bead: a merge-bead with one behind it
  // came through bin/deliver.js. One without is his own pull request, and asking an agent
  // to review a change he wrote and has already admitted is not what this is for.
  const rows = delivered();
  rows[1].description = mergeBeadBody({ ...SPEC, bead: null });
  const bd = tracker(rows);
  const gh = github();
  const out = await tick(bd, gh, { policy: { reviewRequired: true } });
  assert.deepEqual(out.merged, ['zz-merge']);
});

/* ================================================ 5. what the closing comment says */

await check('THE CLOSING COMMENT ON THE PULL REQUEST SAYS AN AGENT APPROVED IT', async () => {
  const { gh } = await wholeLoop();
  // The last comment on the thread, and Adam's standing rider on bc-0cop: *the last
  // comment on the PR should describe who is actually approving (ie an agent, not me)*.
  const closing = gh.calls.comments.at(-1).text;
  assert.match(closing, /Merged into `main` as `f00dcafe`/, 'the report does not say what merged where');
  assert.match(closing, /Approved by an agent, not Adam/, 'the closing comment leaves who approved it to be guessed at');
  assert.match(closing, /review-advocate/, 'it does not name which agent');
  assert.match(closing, /submitted as `NeanderthalMan`/, 'the login on the green tick is not tied to the agent behind it');
  assert.match(closing, /not somebody at a keyboard/);
  assert.match(closing, /pullrequestreview-9/, 'the review it is describing cannot be reached from it');
});

await check('and where Adam admitted it too, the comment carries both approvals apart', async () => {
  const { gh } = await wholeLoop({ policy: { reviewRequired: true, requireApproval: true }, admit: 'Adam' });
  const closing = gh.calls.comments.at(-1).text;
  // Two gates, two lines, and the pair is what "necessary and not sufficient" looks like
  // written down on the page somebody actually reads.
  assert.match(closing, /Approved by Adam/, 'his own admission is not reported');
  assert.match(closing, /Approved by an agent, not Adam/, 'the agent’s review is not reported');
});

await check('an approval with no GitHub account behind it says so rather than naming a login', async () => {
  // The one-login Mac. `approvedReview` records it as approved with no `approvalUrl`, and
  // the report must not turn the agent kind into a plausible-looking reviewer name.
  const text = mergeReport(SPEC, {
    landed: { mergeCommit: 'f00dcafe99' },
    state: {},
    review: { verdict: 'approved', round: 1, approvedBy: 'review-advocate', approvalUrl: '' },
    owner: 'Adam',
  });
  assert.match(text, /Approved by an agent, not Adam/);
  assert.match(text, /no second GitHub account/);
  assert.doesNotMatch(text, /submitted as/, 'it claimed a submission that never happened');
});

await check('and a merge nobody reviewed claims no approval at all', async () => {
  const text = mergeReport(SPEC, { landed: { mergeCommit: 'f00dcafe99' }, state: {}, review: { round: 0, verdict: null }, owner: 'Adam' });
  assert.doesNotMatch(text, /Approved by/, 'the report invented an approval');
});

/* ============================================== 6. the default that was asked about */

await check('requireApproval’s default is still false, and the file says why it was left there', async () => {
  // bc-36xx.9's other half. The question — should the default flip now that something
  // reviews every pull request? — was asked and answered *no*, and what is owed is that the
  // next reader can see it was settled rather than never considered. Asserted rather than
  // left to a comment nobody re-reads, because the value and its reason are the deliverable.
  const source = fs.readFileSync(path.join(HERE, '..', 'lib', 'config.js'), 'utf8');
  const shipped = /^\s*requireApproval: (true|false),/m.exec(source);
  assert.ok(shipped, 'the default is no longer written as a literal, so this check cannot see it');
  assert.equal(shipped[1], 'false', 'the default was flipped, which is not what bc-36xx.9 decided');
  assert.match(source, /^\s*reviewRequired: false,/m, 'the agent gate was turned on by default, which wedges every queue');

  // And the resolution on top of it, since a default nothing reads is not a default:
  // nothing configured anywhere is a workspace that does not wait for Adam.
  assert.equal(prPolicyFor({}, 'demo').requireApproval, false);
  assert.equal(prPolicyFor({}, 'demo').reviewRequired, false);

  const above = source.slice(Math.max(0, shipped.index - 2000), shipped.index);
  assert.match(above, /bc-36xx\.9/, 'nothing above the default records that the question was asked');
  assert.match(above, /agent/i, 'the reason is recorded without the distinction it turns on');
});

/* ------------------------------------------------------------------------------- done */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
