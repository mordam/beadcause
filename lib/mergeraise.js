/**
 * Handing a merge back — the third of the failure path's three outcomes.
 *
 * bc-r941.4. Adam's sentence was *on failure attempt to assess and resolve, or raise it
 * to user in actionable notification*, and the three outcomes are in that order for a
 * reason: **resolve it** (a resolver window, lib/resolvers.js), **retry it** (the attempt
 * budget in lib/mergebead.js), and only then **raise it**. This module is the last one.
 *
 * ## The merge-bead becomes the card
 *
 * Not "files a card", which was the obvious design and is wrong. A merge-bead is already
 * a blocker on the work bead — that is the whole mechanism — so filing a *second* bead
 * beside it would leave the work bead behind two of them, and answering either would be
 * reported as having closed a bead that neither could close. That is bc-ec6 exactly, and
 * `clearOpenCards` in bin/deliver.js is the scar tissue from it.
 *
 * So the queue entry is relabelled into the card it needs to be: `human` puts it in the
 * inbox, `pr-delivery` makes the four answers work, and the description is rewritten with
 * `deliveryBody` — the same body a worker used to file, from the same `beadpr` block that
 * was already on the bead. One bead, one blocker, one tap, and **Merge** answers it
 * through `resolveDeliveryFor` in lib/server.js, which is the door that already exists.
 *
 * The queue stops looking at it the moment it carries the `human` label, because
 * `queueFor` only ever wanted beads assigned to the merge advocate and this hands
 * ownership over. That is the intended reading: raised means it is not the queue's any
 * more.
 *
 * ## What the card must say
 *
 * The sentence that refused it, in the words of whatever refused — `bin/deliver.js`'s
 * `refused` vocabulary, which is why `deliveryBody` already has a parameter for it. Plus
 * the one thing a worker's card could never say, because a worker only ever tried once:
 * **how many times this was attempted and what happened each time.** A card that says
 * "checks failed" over a pull request the queue has tried three times reads as a first
 * look, and the natural response to it — press Merge — is the one that was already
 * refused.
 */
import { deliveryBody, DELIVERY_LABEL } from './delivery.js';
import { baselineNote } from './mergeadvocate.js';
import { MAX_ATTEMPTS, MERGE_LABEL, queueState, withQueueBlock } from './mergebead.js';

/** What the notification and the card open with, given how this got here. */
export function raiseOpening(state, why, { approval = false } = {}) {
  if (approval) return '';
  const tries = Number(state?.attempts) || 0;
  if (!tries) return String(why || '').trim();
  const count = `Tried ${tries} time${tries === 1 ? '' : 's'}${tries >= MAX_ATTEMPTS ? ' — that was the last' : ''}.`;
  return `${String(why || '').trim()} ${count}`.trim();
}

/**
 * Turn a merge-bead into the card that asks Adam, and say so on the pull request.
 *
 * Best-effort in the same way `clearOpenCards` is: the pull request is open and the work
 * is pushed by the time any of this runs, so a tracker that will not take a label is a
 * reason to leave the bead in the queue, not to fail a tick. It returns false in that
 * case, and the caller leaves the state alone — which means the next tick tries to raise
 * it again, which is the right retry to have.
 */
export async function raiseMergeCard(
  bd,
  ws,
  entry,
  why,
  { approval = false, baseline = [], shipHint = '', context = '', notify = null, prComment = null, owner = 'Adam' } = {}
) {
  const { issue, spec } = entry;
  const state = entry.state || queueState(issue);
  const refused = raiseOpening(state, why, { approval });
  const over = baselineNote(baseline);

  const body = deliveryBody(
    { ...spec, title: issue.title || spec.title || '' },
    {
      context: [context, over].filter(Boolean).join(' '),
      refused,
      approval,
      ship: shipHint,
    }
  );

  try {
    await bd.update(ws, issue.id, {
      description: body,
      // The queue's own state stays on the bead rather than being cleared. It is the
      // record of what was tried, it is what a resolver window reads when one is opened
      // later, and a card that lost it would be a card claiming to be a first look.
      notes: withQueueBlock(issue.notes || '', { ...state, at: new Date().toISOString(), resolving: false }),
      addLabels: ['human', DELIVERY_LABEL],
      // `merge-queue` comes off, and that removal is the handover: the label is what
      // `queueFor` selects on, so a bead that keeps it is a bead the queue will pick up
      // again underneath the person now looking at it.
      removeLabels: [MERGE_LABEL],
    });
  } catch {
    return false;
  }

  if (prComment) {
    await prComment(
      spec,
      approval
        ? `The beadcause merge queue stopped here: the checks are green, but this space asks for an approving review before anything merges. It is ${owner}'s call — see ${issue.id}.`
        : `The beadcause merge queue tried to merge this and could not: ${refused} It is ${owner}'s call now — see ${issue.id}.`
    ).catch(() => {});
  }

  if (notify) {
    await notify({
      workspace: ws?.name || ws,
      bead: issue.id,
      work: spec.bead,
      number: spec.number,
      url: spec.url,
      repo: spec.repo,
      title: issue.title || '',
      refused,
      approval,
    }).catch(() => {});
  }

  return true;
}
