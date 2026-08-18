/**
 * The review gate — what the merge queue does about a review, before it does anything else.
 *
 * bc-36xx.4. lib/mergebead.js holds the review *block* (bc-36xx.2) and what a verdict
 * means; lib/reviewadvocate.js is the agent that writes one; this is the decision the
 * queue makes off it, and lib/mergequeue.js is where that decision is acted on. One
 * module rather than four more branches inside the sweep, for `gateVerdict`'s reason in
 * lib/mergeadvocate.js: what is under test is a procedure that decides whether something
 * merges to `main` unattended, and every branch of it has to be drivable without a
 * network, a checkout or a tracker.
 *
 * ## Two gates in series, and they must not be collapsed into one
 *
 * This one asks *has a reviewer looked at it*. `gateVerdict` asks *are the checks green
 * and, where a space demands it, has Adam said it may land*. They are different
 * questions with different answers and Adam's answer to bc-0cop settles which is which:
 * where a space has `requireApproval` on, the ReviewAdvocate's approval is **necessary
 * and not sufficient** — he still admits it himself — and everywhere else the agent's
 * approval alone releases the pull request to the merge. So this gate runs first and
 * `gateVerdict` is left exactly as it was: nothing here touches the approval it reads,
 * and a test pins that the bead stamp is still what satisfies it.
 *
 * ## Off unless a workspace asks for it
 *
 * `reviewRequired` (lib/spaces.js), and it is off everywhere until something is actually
 * reviewing. The gate holds a pull request until a verdict appears, so turning it on in a
 * workspace where no ReviewAdvocate window ever opens does not slow the queue down — it
 * stops it, permanently and silently, on every branch at once. That is the whole reason
 * the switch exists rather than the gate simply being on: bc-36xx.5 is what opens the
 * reviewer's window, and until it has landed and been seen to work, `reviewRequired` on
 * is a wedged queue.
 *
 * ## What is gated, and what is deliberately not
 *
 * - **Worker deliveries only.** A merge-bead with a work bead behind it came through
 *   `bin/deliver.js`; one without is a pull request Adam opened himself and admitted
 *   through `/merge`, and gating that would be asking an agent to review a change he
 *   wrote and has already said he wants.
 * - **Not an admitted pull request.** `state.approved` is Adam's own approval, given to
 *   the queue (lib/mergeadmit.js). A person's look outranks an agent's, and `/merge` is
 *   the one thing in this queue that unsticks everything else — a review gate that
 *   ignored it would take that away at exactly the moment it is wanted, which is when the
 *   loop itself has gone wrong.
 */
import { commentsForWorker, reviewApproved, reviewEscalation } from './mergebead.js';

/**
 * What the gate says to do about one pull request.
 *
 * - `merge` — reviewed, approved, and the approval is for what is on the branch now. The
 *   sweep carries on to the downmerge and `gateVerdict` exactly as it did before.
 * - `review` — a reviewer is what this is waiting on. It costs no attempt, nothing is
 *   refused, and the branch is neither downmerged nor merged.
 * - `answer` — the reviewer asked for changes and the worker has not answered them.
 * - `escalate` — a refusal, or the round cap: this stops being the loop's problem and
 *   becomes a card.
 */
export const REVIEW_ACTS = ['merge', 'review', 'answer', 'escalate'];

/** The head of a branch, abbreviated the way every sentence here wants it. */
const short = (sha) => String(sha || '').trim().toLowerCase().slice(0, 8);

/**
 * Is this pull request review-gated at all?
 *
 * Three conditions and the header argues each: the workspace asked for it, a worker
 * delivered it, and Adam has not already admitted it. All three are about *whether the
 * question applies*, which is why they are here rather than inside `reviewOutcome` — a
 * gate that does not apply has no outcome, and folding "not gated" in as a fourth act
 * would make every caller test for it anyway.
 */
export function reviewGated(spec, state, policy) {
  if (!policy?.reviewRequired) return false;
  if (!spec?.bead) return false;
  if (state?.approved) return false;
  return true;
}

/**
 * Which of the commits between two shas are somebody bringing the base in, and which are
 * the worker changing its own proposal.
 *
 * **A merge commit is a downmerge and a single-parent commit is the worker's**, and that
 * is Adam's rule expressed as the only thing about a commit this can actually see. His
 * answer (bc-36xx.4): *only a worker's push resets the review; a resolver's downmerge
 * leaves the approval standing, because merging `main` in is not a change to the worker's
 * proposal.* Neither `git` nor GitHub records which agent pushed — every session on this
 * Mac pushes as the same identity, and the resolver's downmerge and the queue's
 * `updateBranch` both arrive as merge commits — so the shape of the commit is the whole
 * of the available evidence, and it happens to be exactly the property the rule is about.
 *
 * The accepted residual risk is recorded on bc-36xx.4 and is Adam's call: a resolver that
 * resolves a conflict badly ships code no reviewer saw. A worker that merges `main` into
 * its own branch by hand falls the same way, and that is the same trade rather than a
 * second one — what it pushed *was* a downmerge.
 */
export function classifyCommits(commits) {
  const list = Array.isArray(commits) ? commits : [];
  const worker = [];
  const merges = [];
  for (const c of list) {
    if (!c) continue;
    const sha = String(c.sha || c.oid || '').trim().toLowerCase();
    if (!sha) continue;
    (Number(c.parents) >= 2 ? merges : worker).push(sha);
  }
  return { worker, merges };
}

/**
 * What has been pushed to this branch since the commit a verdict was given for.
 *
 * `{ known, worker, merges }`, and **`known: false` holds the merge** — it is the same
 * direction `reviewState` takes over a block that will not parse, and for the same
 * reason: everything this cannot establish about a review is a reason not to merge over
 * one. GitHub answering `diverged` or `behind` is a branch whose history was rewritten
 * under an approval, which is precisely the case a force-push would use to slip a diff
 * past a reviewer.
 *
 * Asked only when the head has actually moved, which is what keeps it off the common
 * path: an approved pull request that nobody has pushed to costs no call at all, because
 * `from === to` is answered here.
 */
export async function pushedSince(prApi, dir, from, to) {
  const a = String(from || '').trim().toLowerCase();
  const b = String(to || '').trim().toLowerCase();
  if (!a || !b) return { known: false, worker: [], merges: [] };
  if (a === b || b.startsWith(a) || a.startsWith(b)) return { known: true, worker: [], merges: [] };

  let cmp = null;
  try {
    cmp = await prApi.commitsBetween(dir, a, b);
  } catch {
    cmp = null;
  }
  if (!cmp) return { known: false, worker: [], merges: [] };
  const status = String(cmp.status || '').toLowerCase();
  if (status === 'identical') return { known: true, worker: [], merges: [] };
  if (status !== 'ahead') return { known: false, worker: [], merges: [] };
  return { known: true, ...classifyCommits(cmp.commits) };
}

/**
 * The gate's decision, given the review, the head of the branch, and what has been pushed
 * since the verdict was written.
 *
 * Pure. `since` is what `pushedSince` above hands back, and it is only consulted where it
 * can change the answer — an approval whose sha matches the head does not need it, and
 * neither does a pull request nobody has judged.
 *
 * The order of the branches is the order in which each makes the next meaningful:
 *
 * 1. **Escalation** — a refusal, or two rounds that did not agree. Both are the loop
 *    ending rather than continuing, and a refusal escalates on round one deliberately:
 *    waiting the cap out would be asking a worker to answer comments nobody is going to
 *    accept (`reviewEscalation`, lib/mergebead.js).
 * 2. **Approved** — and then whether the approval is still about what is on the branch.
 * 3. **Changes** — the worker's turn if it has comments it has not answered, the
 *    reviewer's if it has answered them all.
 * 4. **Nothing yet** — the state every pull request starts in.
 */
export function reviewOutcome({ review = null, head = '', since = null } = {}) {
  const escalation = reviewEscalation(review);
  if (escalation) return { act: 'escalate', why: escalation, stale: false };

  if (reviewApproved(review)) {
    const at = String(review?.reviewedSha || '');
    /**
     * An approval that cannot say what it was for is not an approval this can act on.
     *
     * The holding direction, and `reviewSha`'s own docblock in lib/mergebead.js commits
     * to it: a block written before the field existed reads as empty here, exactly as a
     * garbled one does, and both mean *we cannot say what was approved*. This repo has no
     * branch protection, so GitHub does not dismiss an approving review when new commits
     * land — an approval nobody can match to a commit is one that would gate the merge of
     * whatever happens to be on the branch by the time the queue looks.
     */
    if (!at || !head) {
      return {
        act: 'review',
        why: 'the approval does not record which commit it was given for, so it cannot be matched to what is on the branch now.',
        stale: true,
      };
    }
    if (head.startsWith(at) || at.startsWith(head)) return { act: 'merge', why: '', stale: false };
    if (!since?.known) {
      return {
        act: 'review',
        why: `the branch has moved since ${short(at)} was approved and what moved it could not be read, so the approval no longer stands.`,
        stale: true,
      };
    }
    if (since.worker.length) {
      const n = since.worker.length;
      return {
        act: 'review',
        why:
          `${n} commit${n === 1 ? '' : 's'} ha${n === 1 ? 's' : 've'} been pushed since ${short(at)} was approved, ` +
          `so the approval is for a diff that is no longer the one on the branch.`,
        stale: true,
      };
    }
    /**
     * Only downmerges since the approval, so the approval stands — and this is the branch
     * the whole comparison exists for. lib/mergequeue.js says a resolver may push to a
     * queued pull request and it does; at sixty-odd merges a week nearly every approved
     * branch is pushed to before it lands, and a gate that counted those as changes would
     * send every pull request round again forever without a single one of them having
     * been changed.
     */
    return { act: 'merge', why: '', stale: false };
  }

  if (review?.verdict === 'changes') {
    const owed = commentsForWorker(review);
    if (owed.length) {
      return {
        act: 'answer',
        why: `the reviewer asked for changes and ${owed.length} comment${owed.length === 1 ? ' is' : 's are'} waiting on the worker.`,
        stale: false,
      };
    }
    return {
      act: 'review',
      why: `the worker has answered every comment from round ${review.round || 1}, and the reviewer has not looked yet.`,
      stale: false,
    };
  }

  return { act: 'review', why: 'nothing has reviewed this pull request yet.', stale: false };
}

/**
 * The whole gate for one pull request — the decision, and the one call it sometimes costs.
 *
 * The call is made **only where it can change the answer**: an approval whose sha is the
 * head of the branch is answered without asking anybody, and so is every pull request
 * that has no approval to be stale. That is what keeps a review gate off the tick's
 * budget — a queue of six approved-and-untouched branches costs six `gh pr view`s it was
 * already making and nothing else at all.
 */
export async function judgeReview(prApi, dir, { review = null, head = '' } = {}) {
  const at = String(review?.reviewedSha || '');
  const tip = String(head || '').trim().toLowerCase();
  const needsCompare =
    reviewApproved(review) && at && tip && !(tip.startsWith(at) || at.startsWith(tip)) && !reviewEscalation(review);
  const since = needsCompare ? await pushedSince(prApi, dir, at, tip) : null;
  return reviewOutcome({ review, head: tip, since });
}

/**
 * The sentence the merge-bead carries while the gate is holding it, or `''` when it is
 * not holding it at all.
 *
 * Written as *what is being waited for* rather than as a refusal, because it is not one —
 * nothing was asked of this branch and nothing failed. The distinction is the same one
 * `awaitingApproval` keeps in `gateVerdict` and it matters for the same reason: a card or
 * a board reading "refused" over a pull request whose only problem is that nobody has
 * looked at it yet sends you hunting for a fault that does not exist.
 */
export function reviewRefusal(outcome) {
  if (!outcome || outcome.act === 'merge' || outcome.act === 'escalate') return '';
  const lead = outcome.act === 'answer' ? 'waiting on the worker' : 'waiting on a review';
  return `${lead}: ${outcome.why}`;
}
