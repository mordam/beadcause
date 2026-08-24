/**
 * Folding a ReviewAdvocate's verdict onto the merge-bead's review block — the step nothing
 * performed before bc-36xx.22.
 *
 * lib/reviewadvocate.js owns what a reviewer *writes*: a comment on the merge-bead, with a
 * fenced JSON verdict between `VERDICT_OPEN`/`VERDICT_CLOSE`. lib/mergebead.js owns what
 * the queue's gate *reads*: `<!-- beadcause:review -->`, a different block in the same
 * bead's `notes`. `verdictFrom`, `approve` and `approvedReview` all existed and none of them
 * had a caller — a reviewer could write a verdict for ever and the gate would never see it.
 * This is the translation between the two, kept pure for the reason every other decision
 * procedure in this loop is: what is under test is *which* verdict is fresh and what it
 * becomes, not the tracker write or the GitHub call around it (both of those are
 * lib/mergequeue.js's job, the same split `reviewgate.js` keeps from `mergequeue.js`
 * itself).
 *
 * ## "Fresh" is a round the block has not recorded, not "the last comment"
 *
 * `verdictFrom` already picks the newest comment that parses as a verdict — a reviewer
 * re-runs across rounds and the earlier ones stay on the bead as history, exactly as
 * `planFrom` takes the last plan. But the newest *comment* is not always a verdict for a
 * round the block has not seen: a tick that runs between the write and the next one would
 * otherwise fold the same verdict in twice. `reviewState.round` counts rounds *completed*
 * (lib/mergebead.js), so a verdict is fresh exactly when its own `round` is greater than
 * that — and a verdict `checkVerdict` cannot even validate, or one with no round on it at
 * all, is nothing new, the same holding direction `reviewState` itself takes on a block it
 * cannot parse: a comment somebody hand-edited on a phone must not be able to move a gate.
 *
 * ## Never `verdict: 'refused'`
 *
 * `REVIEW_VERDICTS` in lib/mergebead.js has three values and a ReviewAdvocate's own format
 * can only ever produce two of them: `checkVerdict` validates `approved` (a boolean) and,
 * when it is false, `why` — there is no field for "and I will never approve this at all".
 * The flat refusal is a state the round cap already reaches on its own
 * (`reviewEscalation`, lib/mergebead.js, two `changes` rounds with no agreement) without
 * this needing to invent a way to say it sooner.
 */
import { checkVerdict, verdictFrom } from './reviewadvocate.js';

/**
 * The newest verdict a merge-bead's comments carry that its review block has not already
 * recorded, or `null`.
 *
 * Takes `comments` (as `bd comments` hands them back) and the *current* `reviewState(issue)`
 * rather than the bead itself, so a caller that already has both in hand — the sweep reads
 * the block once per tick regardless — spends no second parse getting them here.
 */
export function freshVerdict(comments, state) {
  const raw = verdictFrom(comments);
  if (!raw) return null;
  const { verdict } = checkVerdict(raw);
  if (!verdict || !verdict.round) return null;
  const recorded = Number(state?.round) || 0;
  return verdict.round > recorded ? verdict : null;
}

/** One of a verdict's comments (lib/reviewadvocate.js's `{id, file, line, severity, what, why}`), in the review block's shape. */
const toReviewComment = (c) => ({
  id: c.id,
  path: c.file,
  line: c.line,
  body: c.what,
  severity: c.severity,
  why: c.why,
});

/**
 * The review-block state a fresh verdict becomes, before anything is submitted to GitHub —
 * everything `withReviewBlock` needs except the approval's own provenance, which is not
 * known until the review has actually gone out (`approvedReview`, lib/reviewadvocate.js,
 * is what adds that once it has).
 *
 * `comments` replaces the block's list wholesale rather than merging into it, and that is
 * the verdict's own shape rather than a simplification: `reviewAdvocatePrompt`'s second
 * round asks the reviewer to restate every comment still standing in its fresh JSON —
 * "persuaded? drop it. not persuaded? keep it, with what the answer did not settle" — so
 * the verdict a round produces is already the complete, current list. A worker's answer to
 * a dropped comment is exactly that: dropped, not carried forward as an orphan the next
 * round can no longer see raised anywhere.
 *
 * `reviewedSha` is asked for rather than read off the verdict, because a reviewer says
 * nothing about which commit it read — that is the branch's head at the moment the sweep
 * folds this in, which is the same sha `judgeReview` is about to compare against.
 */
export function reviewFromVerdict(verdict, { headSha = '', reviewer = '' } = {}) {
  return {
    round: verdict.round,
    verdict: verdict.approved ? 'approved' : 'changes',
    reviewer,
    reviewedSha: headSha,
    refused: verdict.approved ? null : verdict.why,
    comments: (verdict.comments || []).map(toReviewComment),
  };
}

/**
 * A verdict's comments, in the shape GitHub's reviews endpoint takes for an inline one —
 * `lib/pr.js`'s `submitReview`. Only the ones a reviewer actually pointed at a line: a
 * comment with no `file`/`line` is real (a `question` about the diff as a whole is
 * ordinary) and simply cannot be anchored to one, so `submitReview` would drop it anyway —
 * filtered here instead so a caller can tell "a bare review" from "an inline one" without
 * re-deriving `inlineComment`'s own rule.
 */
export function inlineComments(verdict) {
  return (verdict.comments || [])
    .filter((c) => c.file && Number.isInteger(c.line) && c.line > 0)
    .map((c) => ({
      path: c.file,
      line: c.line,
      body: `**${c.severity}** — ${c.what}${c.why ? ` ${c.why}` : ''}`,
    }));
}
