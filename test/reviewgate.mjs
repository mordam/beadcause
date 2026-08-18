#!/usr/bin/env node
/**
 * The review gate: what the merge queue decides off a review, one state at a time.
 *
 *     npm test
 *     node test/reviewgate.mjs
 *
 * bc-36xx.4. test/mergequeue.mjs drives the same decisions through the sweep, which is
 * where they are acted on; this pins them as pure functions, which is where they are
 * *argued* — and the two halves matter separately because the expensive mistakes here are
 * not in the branching but in what each branch means.
 *
 * The four that would hurt most, in order:
 *
 * 1. **A resolver's downmerge does not reset an approval.** lib/mergequeue.js says a
 *    resolver may push to a queued pull request and it does — at sixty-odd merges a week
 *    nearly every approved branch is pushed to before it lands. A gate that counted those
 *    as changes would send every pull request round again forever, with nothing changed.
 * 2. **A worker's push does.** The other half of Adam's rule, and the one with teeth:
 *    this repo has no branch protection, so GitHub will not dismiss an approving review
 *    when new commits land, and without this an approval given for one diff gates the
 *    merge of another.
 * 3. **Everything unknown holds.** No sha on the approval, a compare that will not answer,
 *    a history that diverged: each of them is *we cannot say what was approved*, and each
 *    of them is one force-push away from being the way a diff gets past a reviewer.
 * 4. **A refusal escalates on round one.** Waiting the cap out would be asking a worker
 *    to answer comments nobody is going to accept.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const { REVIEW_ACTS, classifyCommits, judgeReview, pushedSince, reviewGated, reviewOutcome, reviewRefusal } = await import(
  LIB('reviewgate.js')
);
const { MAX_REVIEW_ROUNDS, reviewState, withReviewBlock } = await import(LIB('mergebead.js'));

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

console.log('\nthe review gate\n');

/* ------------------------------------------------------------------- the world */

const SPEC = { workspace: 'demo', bead: 'zz-work', repo: 'acme/widgets', number: 42, branch: 'work-a', base: 'main' };
const ON = { reviewRequired: true };

/** A review block, through the real serialiser — never hand-written YAML. */
const review = (state) => reviewState({ notes: withReviewBlock('', state) });

const APPROVED_AT = 'aaaaaaa';
const approved = (over = {}) =>
  review({ round: 1, verdict: 'approved', reviewer: 'somebody', reviewedSha: APPROVED_AT, approvedBy: 'somebody', ...over });

/** A `pr.commitsBetween` that answers with whatever this scenario is about. */
const fakePr = (answer) => {
  const calls = [];
  return {
    calls,
    commitsBetween: async (dir, from, to) => {
      calls.push({ dir, from, to });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
};

const commit = (sha, parents = 1) => ({ sha, parents, message: `something ${sha}`, login: 'somebody' });

/* --------------------------------------------------------- does it apply at all */

await check('every act it can return is one the sweep knows about', () => {
  // The vocabulary is a closed list for `REVIEW_VERDICTS`' reason one file over: the sweep
  // branches on it, and an act nothing has a branch for would fall through to the merge.
  const acts = [
    reviewOutcome({ review: review({}), head: 'beef1234' }),
    reviewOutcome({ review: approved(), head: APPROVED_AT }),
    reviewOutcome({ review: review({ round: 1, verdict: 'changes', comments: [{ id: 'c1', body: 'no' }] }), head: 'beef1234' }),
    reviewOutcome({ review: review({ round: 1, verdict: 'refused', refused: 'no' }), head: 'beef1234' }),
  ].map((o) => o.act);
  assert.deepEqual(acts, ['review', 'merge', 'answer', 'escalate']);
  for (const act of acts) assert.ok(REVIEW_ACTS.includes(act), act);
});

await check('a workspace that has not asked for a review is not gated', () => {
  assert.equal(reviewGated(SPEC, {}, {}), false);
  assert.equal(reviewGated(SPEC, {}, { reviewRequired: false }), false);
  assert.equal(reviewGated(SPEC, {}, ON), true);
});

await check('and a pull request Adam opened himself is never gated', () => {
  // Scope, from the bead: a merge-bead with a work bead behind it came through
  // bin/deliver.js. One without is a pull request he opened and admitted through /merge,
  // and asking an agent to review a change he wrote and has already asked for is a round
  // trip nobody wanted.
  assert.equal(reviewGated({ ...SPEC, bead: null }, {}, ON), false);
  assert.equal(reviewGated({ ...SPEC, bead: '' }, {}, ON), false);
});

await check('nor is one he has already admitted', () => {
  // `approved` on the queue's own block is Adam's approval given to the queue
  // (lib/mergeadmit.js). A person's look outranks an agent's, and /merge is the one thing
  // that unsticks this queue when the loop itself has gone wrong — a gate that ignored it
  // would take that away at exactly the moment it is wanted.
  assert.equal(reviewGated(SPEC, { approved: true }, ON), false);
});

/* ------------------------------------------------------------ nothing has looked */

await check('no verdict is a wait, not a refusal', () => {
  const out = reviewOutcome({ review: review({}), head: 'beef1234' });
  assert.equal(out.act, 'review');
  assert.match(out.why, /nothing has reviewed/);
  // The sentence the bead carries says what is being waited *for*. "Refused" over a pull
  // request whose only problem is that nobody has looked sends you hunting for a fault
  // that is not there — the distinction `awaitingApproval` keeps in `gateVerdict`.
  assert.match(reviewRefusal(out), /^waiting on a review:/);
});

await check('a block that will not parse reads as unreviewed, which holds the merge', () => {
  const broken = reviewState({ notes: '<!-- beadcause:review -->\n  : : not yaml : :\n<!-- /beadcause:review -->' });
  assert.equal(reviewOutcome({ review: broken, head: 'beef1234' }).act, 'review');
});

/* ------------------------------------------------------------------- the changes */

await check('comments the worker has not answered open the worker’s window', () => {
  const state = review({
    round: 1,
    verdict: 'changes',
    comments: [{ id: 'c1', body: 'this leaks a handle' }, { id: 'c2', body: 'and this one', answer: 'changed', note: 'fixed' }],
  });
  const out = reviewOutcome({ review: state, head: 'beef1234' });
  assert.equal(out.act, 'answer');
  assert.match(out.why, /1 comment is waiting on the worker/);
  assert.match(reviewRefusal(out), /^waiting on the worker:/);
});

await check('and once every comment is answered it is the reviewer’s turn again', () => {
  // Not the worker's: `resolved` is the reviewer's field and only the reviewer writes it,
  // so a worker that has answered everything is waiting rather than finished.
  const state = review({
    round: 1,
    verdict: 'changes',
    comments: [{ id: 'c1', body: 'this leaks a handle', answer: 'declined', note: 'it is closed by the caller' }],
  });
  const out = reviewOutcome({ review: state, head: 'beef1234' });
  assert.equal(out.act, 'review');
  assert.match(out.why, /answered every comment/);
});

/* -------------------------------------------------------------- the two escalations */

await check('a refusal escalates on round one, without waiting out the cap', () => {
  const state = review({ round: 1, verdict: 'refused', refused: 'this belongs in the other module entirely' });
  const out = reviewOutcome({ review: state, head: 'beef1234' });
  assert.equal(out.act, 'escalate');
  assert.match(out.why, /will not approve/);
  assert.match(out.why, /other module/);
  // An escalation is not a wait, so it carries no waiting sentence: it becomes a card.
  assert.equal(reviewRefusal(out), '');
});

await check('and two rounds without agreement escalates too', () => {
  const state = review({
    round: MAX_REVIEW_ROUNDS,
    verdict: 'changes',
    comments: [{ id: 'c1', body: 'still not this' }],
  });
  assert.equal(reviewOutcome({ review: state, head: 'beef1234' }).act, 'escalate');
});

await check('but approved at the cap escalates nothing', () => {
  const state = approved({ round: MAX_REVIEW_ROUNDS, reviewedSha: 'beef1234' });
  assert.equal(reviewOutcome({ review: state, head: 'beef1234' }).act, 'merge');
});

/* ------------------------------------------------------------------ the approval */

await check('approved for the commit that is on the branch merges', () => {
  assert.equal(reviewOutcome({ review: approved(), head: APPROVED_AT }).act, 'merge');
  // Seven characters is what `gh` hands back and forty is the full one; the review keeps
  // whichever it was given, so both ends have to match by prefix rather than by equality.
  assert.equal(reviewOutcome({ review: approved(), head: `${APPROVED_AT}0000000000000000000000000000000000` }).act, 'merge');
});

await check('AN APPROVAL WITH NO SHA ON IT DOES NOT MERGE', () => {
  // A block written before bc-36xx.10 landed reads as an empty sha, exactly as a garbled
  // one does, and both mean *we cannot say what was approved*. Holding is the direction
  // `reviewSha` in lib/mergebead.js commits to, because the alternative is an approval
  // gating the merge of whatever happens to be on the branch when the queue looks.
  const out = reviewOutcome({ review: approved({ reviewedSha: '' }), head: 'beef1234' });
  assert.equal(out.act, 'review');
  assert.match(out.why, /does not record which commit/);
  assert.equal(out.stale, true);
});

await check('nor does one whose branch head nobody could read', () => {
  assert.equal(reviewOutcome({ review: approved(), head: '' }).act, 'review');
});

await check('A RESOLVER’S DOWNMERGE LEAVES THE APPROVAL STANDING', () => {
  // Adam's rule: merging `main` in is not a change to the worker's proposal. This is the
  // branch the whole comparison exists for — without it every approved pull request that
  // was downmerged once would go round again, forever, unchanged.
  const since = { known: true, worker: [], merges: ['dddddddd'] };
  assert.equal(reviewOutcome({ review: approved(), head: 'dddddddd', since }).act, 'merge');
});

await check('AND A WORKER’S PUSH SENDS IT ROUND AGAIN, NAMING THE SHA IT WAS APPROVED AT', () => {
  const since = { known: true, worker: ['cccccccc'], merges: ['dddddddd'] };
  const out = reviewOutcome({ review: approved(), head: 'dddddddd', since });
  assert.equal(out.act, 'review');
  assert.equal(out.stale, true);
  assert.match(out.why, /1 commit has been pushed since aaaaaaa was approved/);
});

await check('and a comparison nobody could make holds it', () => {
  const out = reviewOutcome({ review: approved(), head: 'dddddddd', since: { known: false, worker: [], merges: [] } });
  assert.equal(out.act, 'review');
  assert.match(out.why, /could not be read/);
});

/* ------------------------------------------------------ whose commits are these */

await check('a merge commit is a downmerge and a single-parent commit is the worker’s', () => {
  const { worker, merges } = classifyCommits([commit('a1'), commit('b2', 2), commit('c3', 3), null, { parents: 1 }]);
  assert.deepEqual(worker, ['a1']);
  assert.deepEqual(merges, ['b2', 'c3']);
});

await check('the same sha at both ends costs no call at all', async () => {
  const prApi = fakePr({ status: 'ahead', commits: [] });
  const out = await pushedSince(prApi, '/tmp/x', APPROVED_AT, `${APPROVED_AT}beef`);
  assert.deepEqual(out, { known: true, worker: [], merges: [] });
  assert.equal(prApi.calls.length, 0, 'it asked GitHub about a branch that has not moved');
});

await check('a diverged or unreadable comparison is unknown, and unknown holds', async () => {
  for (const answer of [{ status: 'diverged', commits: [] }, { status: 'behind', commits: [] }, null, new Error('gh: 422')]) {
    const out = await pushedSince(fakePr(answer), '/tmp/x', APPROVED_AT, 'ffffffff');
    assert.equal(out.known, false, `a ${JSON.stringify(answer)?.slice(0, 24)} answer read as known`);
  }
  // `identical` is GitHub's own way of saying nothing moved, and it is a real answer.
  assert.deepEqual(await pushedSince(fakePr({ status: 'identical', commits: [] }), '/tmp/x', APPROVED_AT, 'ffffffff'), {
    known: true,
    worker: [],
    merges: [],
  });
});

/* ------------------------------------------------------------- the whole gate */

await check('judgeReview asks GitHub only where the answer could change', async () => {
  const quiet = fakePr({ status: 'ahead', commits: [] });
  // Nobody has reviewed it: there is no approval to be stale.
  await judgeReview(quiet, '/tmp/x', { review: review({}), head: 'beef1234' });
  // Approved, and the head is what was approved.
  await judgeReview(quiet, '/tmp/x', { review: approved(), head: APPROVED_AT });
  // Two rounds and no agreement: it is escalating, whatever has been pushed since.
  await judgeReview(quiet, '/tmp/x', { review: review({ round: MAX_REVIEW_ROUNDS, verdict: 'changes' }), head: 'beef1234' });
  assert.equal(quiet.calls.length, 0, 'the gate made a network call it did not need');

  const asked = fakePr({ status: 'ahead', commits: [commit('dddddddd', 2)] });
  const out = await judgeReview(asked, '/tmp/x', { review: approved(), head: 'dddddddd' });
  assert.equal(out.act, 'merge');
  assert.deepEqual(asked.calls, [{ dir: '/tmp/x', from: APPROVED_AT, to: 'dddddddd' }]);
});

/* ------------------------------------------------------------------------ done */

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
