/**
 * Admitting a pull request to the merge queue — the door back in.
 *
 * bc-okja. lib/mergeraise.js is the door *out*: a merge the queue could not make, or one
 * a space wants a review on first, stops being the queue's and becomes a card in Adam's
 * inbox — `merge-queue` off, `human` and `pr-delivery` on. That handover is deliberate
 * and it is one-way, which leaves a gap this module closes: **once Adam has decided the
 * thing should land, the only way to act on it was the Merge tap**, and that tap is
 * `pr.merge` straight through `resolveDeliveryFor` — no downmerge, no baseline
 * comparison, no queue behind it, and no other branch's business considered. It is the
 * position bc-r941 took the merge *out of*, kept as a button because a person pressing it
 * has looked.
 *
 * So this is the other answer to the same question: not "merge it now" but **"it is
 * approved — put it back in the queue"**. Everything the queue does then happens: the
 * base comes into the branch, the checks are judged against what `main` is already
 * failing, one merge per repo at a time, and both beads close together. What Adam
 * supplies is the one thing the queue cannot work out for itself — that the change is
 * wanted.
 *
 * ## Four states a pull request can be in, and one act
 *
 * - **A raised merge-bead** — the queue tried and handed it over, or it is waiting on a
 *   review. The bead is right there with its history on it; it needs its label, its
 *   assignee and a fresh state. Nothing is filed, for lib/mergeraise.js's reason in the
 *   other direction: a second bead beside it would leave the work bead behind two
 *   blockers.
 * - **A delivery card** — a space with `autoMerge` off (Climative here) files a question
 *   rather than a merge-bead, so the pull request has never been in a queue at all. Same
 *   bead, same `beadpr` block, same relabel. The card *becomes* the queue entry.
 * - **Already queued** — nothing to relabel. The approval is still recorded, because a
 *   space with `requireApproval` on would otherwise raise it as a card thirty seconds
 *   later and ask for the thing that has just been given.
 * - **Nothing open about it** — a pull request Adam opened himself, or one whose card was
 *   closed. There is nothing to relabel, so one is filed. The caller does that; what is
 *   decided here is only that it must.
 *
 * ## Why the approval goes on the bead
 *
 * `gateVerdict` takes an approval to mean GitHub's `reviewDecision === 'APPROVED'`, and
 * on this Mac that is a decision nobody can make: the pull requests are opened by workers
 * running under Adam's own `gh` token, and GitHub will not let an author approve their
 * own pull request. A `requireApproval` space would therefore wait for a review that
 * cannot exist. So the admission itself is the approval — `approved`, with who and when,
 * in the queue's own block in `notes` — and the gate takes either. The block is where it
 * belongs rather than a label for `queueState`'s reason: it is live state about one
 * attempt to merge, it is rewritten every tick, and it survives a claim and a reopen.
 *
 * ## What this deliberately does not do
 *
 * It does not merge, and it does not weaken a gate. An admitted pull request with a check
 * its base is not failing is refused exactly as before and comes back as a card — the
 * approval says the change is wanted, not that it works. That is the whole difference
 * between this and the button.
 */
import { DELIVERY_LABEL, parseDelivery, slugOf } from './delivery.js';
import { MAX_ATTEMPTS, MERGE_ASSIGNEE, MERGE_LABEL, QUEUE_OPEN, isMergeBead, queueState } from './mergebead.js';

/** What takes a bead out of the queue and into the inbox — lib/mergeraise.js's pair. */
export const HUMAN_LABEL = 'human';

/**
 * The queue state an admitted bead starts from.
 *
 * A **reset**, and every field of it is deliberate. `attempts` and `downmerges` go back to
 * nought because the budget counts what the queue tried on its own and this is a new
 * instruction from the person the last attempt was handed to; leaving them would admit a
 * pull request that is already out of attempts, which the next tick would hand straight
 * back. `refused` goes because it is the sentence about a state that no longer holds, and
 * `resolving` because "somebody has been asked about this" is exactly what has just
 * stopped being true.
 *
 * `baseline` survives, alone, because it is not the queue's opinion about this branch — it
 * is what `main` was already failing last time anybody looked, and it is worth having in
 * hand for the sentence on the card if this comes back. The tick recomputes it before it
 * is used for anything.
 */
export function admittedState(state, { by = '', at = '' } = {}) {
  return {
    attempts: 0,
    downmerges: 0,
    refused: null,
    at: at || null,
    baseline: Array.isArray(state?.baseline) ? state.baseline : [],
    resolving: false,
    approved: true,
    approvedBy: String(by || '').trim(),
    approvedAt: at || '',
  };
}

/** The same approval, recorded on a bead whose place in the queue is not being changed. */
export function approvedState(state, { by = '', at = '' } = {}) {
  return {
    ...(state || {}),
    approved: true,
    approvedBy: String(by || '').trim(),
    approvedAt: at || '',
  };
}

/**
 * Every open bead that is *about* this pull request, whatever kind of bead it is.
 *
 * Matched on the `beadpr` block rather than on labels, which is what makes one function
 * find all four states: a merge-bead, a raised merge-bead, a delivery card and a card
 * from before the queue existed all carry the same block written by the same serialiser,
 * and the labels are precisely the thing that differs between them.
 *
 * The two ways to be the same merge are `cardsForDelivery`'s and `openMergeBeadFor`'s, for
 * their reasons: the **pull request** (number and repo, since a number alone is unique
 * only within a repo) and the **work bead**, which the number misses when a session
 * abandoned its branch and delivered the same bead on a new one. Neither known is not
 * "match everything" — it is a caller with nothing to compare, and acting on that would
 * admit whatever happened to sort first.
 */
export function beadsAbout(rows, { repo = '', number = null, bead = null } = {}) {
  const n = Number(number);
  const wantNumber = Number.isInteger(n) && n > 0 ? n : null;
  const wantSlug = String(repo || '').trim().toLowerCase();
  const wantBead = String(bead || '').trim().toLowerCase() || null;
  if (!wantNumber && !wantBead) return [];

  const sameRequest = (d) => {
    if (!wantNumber || Number(d.number) !== wantNumber) return false;
    const slug = slugOf(d);
    return !slug || !wantSlug || slug === wantSlug;
  };
  const sameBead = (d) => !!wantBead && String(d.bead || '').trim().toLowerCase() === wantBead;

  return (rows || [])
    .filter((r) => r && r.id && String(r.status || '').toLowerCase() !== 'closed')
    .map((row) => ({ row, spec: parseDelivery([row.description, row.design, row.notes].filter(Boolean).join('\n\n')) }))
    .filter(({ spec }) => spec && !spec.error && (sameRequest(spec) || sameBead(spec)))
    .map(({ row, spec }) => {
      const state = queueState(row);
      const labelled = isMergeBead(row);
      const mine = String(row.assignee || '').trim().toLowerCase() === MERGE_ASSIGNEE;
      return {
        id: row.id,
        row,
        spec,
        state,
        /**
         * Is the queue going to look at this one on its next tick? `queueFor`'s three
         * exclusions, asked of a single row — a bead the queue skips is a bead this has
         * to re-arm, and the two must agree about which those are.
         */
        queued: labelled && mine && !state.resolving && state.attempts < MAX_ATTEMPTS,
        labelled,
        assigned: mine,
        /**
         * Has the queue ever held this bead? Off the state block in `notes`, which is the
         * only thing that still says so once `raiseMergeCard` has taken the label off.
         *
         * It is what breaks the tie between a raised merge-bead and a delivery card,
         * which after a raise carry identical labels: the one with the queue's own
         * history on it is the one to put back, because that history is what the next
         * card would have to say and a fresh entry beside it would claim to be a first
         * look at a pull request that has been tried three times.
         */
        touched: String(row.notes || '').includes(QUEUE_OPEN),
      };
    })
    .sort(
      (a, b) =>
        Number(b.labelled) - Number(a.labelled) ||
        Number(b.touched) - Number(a.touched) ||
        String(a.id).localeCompare(String(b.id))
    );
}

/**
 * What to do about this pull request, as a plan the caller executes and a test can drive
 * without a tracker.
 *
 * Pure, for `gateVerdict`'s reason: the decision — which bead, which labels, whether
 * anything is filed at all — is the part worth being sure about, and a test of it should
 * not need a `bd`, a checkout or a pull request. The writes it describes are three
 * (`update`, `assignee`, `comment`) and the caller makes them in that order.
 *
 * `others` is never empty by accident: two open beads about one pull request is the pile
 * `clearOpenCards` exists to prevent, and a command that silently picks one of them and
 * says nothing is how the other stays open forever, blocking the work bead's close.
 */
export function admitPlan(rows, { repo = '', number = null, bead = null, by = 'Adam', at = '' } = {}) {
  const found = beadsAbout(rows, { repo, number, bead });
  const others = found.slice(1).map((c) => c.id);

  if (!found.length) {
    return {
      action: 'file',
      id: null,
      spec: null,
      state: admittedState(null, { by, at }),
      addLabels: [MERGE_LABEL],
      removeLabels: [],
      assignee: MERGE_ASSIGNEE,
      others,
      why: 'nothing open in this workspace is about this pull request, so there is no queue entry to re-arm',
    };
  }

  const chosen = found[0];

  if (chosen.queued) {
    return {
      action: 'approve',
      id: chosen.id,
      spec: chosen.spec,
      state: approvedState(chosen.state, { by, at }),
      addLabels: [],
      removeLabels: [],
      assignee: null,
      others,
      why: 'it is already on the queue and moving — the approval is recorded and nothing else changes',
    };
  }

  return {
    action: 'admit',
    id: chosen.id,
    spec: chosen.spec,
    state: admittedState(chosen.state, { by, at }),
    // The exact inverse of `raiseMergeCard`'s handover, and it has to be exact: the
    // label is what `queueFor` selects on, and `human` is what keeps the bead in the
    // inbox as a question nobody is going to answer twice.
    addLabels: [MERGE_LABEL],
    removeLabels: [HUMAN_LABEL, DELIVERY_LABEL],
    assignee: MERGE_ASSIGNEE,
    others,
    why: admitWhy(chosen),
  };
}

/** Why this bead was not going to move on its own — the sentence the comment opens with. */
function admitWhy(candidate) {
  const { state, labelled, assigned } = candidate;
  if (!labelled && !assigned) return 'it was a card in the inbox rather than a queue entry';
  if (!labelled) return 'the queue had handed it over, so nothing was going to look at it again';
  if (state.attempts >= MAX_ATTEMPTS) return `the queue had spent all ${MAX_ATTEMPTS} of its attempts on it`;
  if (state.resolving) return 'it was marked as one somebody else is already dealing with';
  if (!assigned) return 'it carried the label but not the assignee, so the queue never picked it up';
  return 'it was not in a state the queue would act on';
}

/**
 * What the bead says happened, in one comment.
 *
 * Written here rather than at the call site because it is the record of a *decision* and
 * the only place it exists: an admission leaves almost no trace otherwise — a label moved
 * and a YAML block rewritten — and six months on the question about a merged pull request
 * is always "who said this could land". The sentence names the person, and it names what
 * the queue will still refuse, because an approval that reads as a promise to merge makes
 * the card that comes back look like a bug.
 */
export function admitComment(plan, { by = 'Adam', tick = 'its next tick' } = {}) {
  const who = String(by || 'Adam').trim() || 'Adam';
  if (plan.action === 'approve') {
    return (
      `**${who} approved this.** It is already on the merge queue, so nothing was moved — the approval is ` +
      `recorded on this bead so a space that asks for one is satisfied without a review GitHub will not accept ` +
      `from the author of the branch.`
    );
  }
  const back = plan.action === 'file' ? 'It is on the merge queue' : 'It is back on the merge queue';
  return (
    `**${who} approved this merge**, and ${plan.why}. ${back}: on ${tick} the base comes into the branch, the ` +
    `checks are judged against whatever the base is already failing, and it merges. ` +
    `**The gates still apply** — a check this branch broke, or a conflict nothing can resolve, comes back here ` +
    `as a card rather than merging on the strength of the approval.`
  );
}
