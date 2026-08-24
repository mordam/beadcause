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
 * between this and the **delivery card's** Merge tap, which still merges where it stands.
 * The *PR board's* button is no longer on the other side of that line: since bc-02ldo it
 * comes through here (`admitToQueue`, below) like everything else.
 */
import { ownAddresseeLabels } from './addressee.js';
import { DELIVERY_LABEL, deliveryBlock, parseDelivery, slugOf } from './delivery.js';
import {
  MAX_ATTEMPTS,
  MERGE_ASSIGNEE,
  MERGE_LABEL,
  QUEUE_OPEN,
  isMergeBead,
  mergeBeadBody,
  mergeBeadTitle,
  queueState,
  withQueueBlock,
} from './mergebead.js';

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
    // Spelled out beside `resolving` rather than left to fall out of the rebuild: the two
    // are the halves of one state (bc-5mdsw) and a reset that named only one of them would
    // re-arm a bead that still refuses to open a resolver.
    declined: false,
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
      /**
       * The exclusion that is not in `queueFor` at all — bc-7qo.8.
       *
       * `sweepMergeQueue` reads the tracker exactly once, through `bd.listAgent`, and that
       * call passes `--exclude-label human`. So a merge-bead carrying the label never
       * reaches `queueFor` to be skipped by it: it is filtered out a layer earlier, where
       * nothing counts it. Measured 2026-08-16 in this workspace — with the flag, 257 rows
       * and no merge-beads at all; without it, 275 and the waiting one among them.
       *
       * That is invisible from `queueFor`'s three, which is exactly why it belongs here.
       * Reading the label as "queued and moving" is what made re-approval a no-op five
       * times over on one pull request: `admitPlan` saw the label and the assignee, took
       * the `approve` branch, and returned nothing to change. Counting it as *not* queued
       * sends the same act down the `admit` branch, which already strips `HUMAN_LABEL` —
       * so `/merge` becomes the recovery rather than a fifth recorded opinion.
       */
      const shunned = (row.labels || []).some((l) => String(l).trim() === HUMAN_LABEL);
      return {
        id: row.id,
        row,
        spec,
        state,
        /**
         * Is the queue going to **merge** this one on its own? `queueFor`'s three
         * exclusions plus the read's own, asked of a single row — a bead the queue is not
         * going to carry to a merge is a bead this has to re-arm.
         *
         * `declined` is the one entry here that `queueFor` does *not* exclude, and the
         * asymmetry is deliberate (bc-5mdsw). Such a bead is still in the queue's `queued`
         * bucket and the queue does still act on it — but the only act left is refusing it
         * once a tick until the attempts run out and it becomes a card, because a resolver
         * has already declined its conflict and no second one will be opened. Reading that
         * as *on the queue and moving* would make **Merge** record an approval and change
         * nothing, on the one bead whose whole point is that only you can unstick it. An
         * admission is exactly right there: `admittedState` drops the flag, and the next
         * tick opens a resolver on a conflict a human has now looked at.
         */
        queued: labelled && mine && !shunned && !state.resolving && !state.declined && state.attempts < MAX_ATTEMPTS,
        labelled,
        assigned: mine,
        shunned,
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
  const { state, labelled, assigned, shunned } = candidate;
  if (!labelled && !assigned) return 'it was a card in the inbox rather than a queue entry';
  if (!labelled) return 'the queue had handed it over, so nothing was going to look at it again';
  // Before the rest, because a bead can carry this *and* look perfectly queued — it is
  // the state where every other sentence here would be wrong and reassuring. See
  // `shunned` in `beadsAbout`.
  if (shunned)
    return `it carried the \`${HUMAN_LABEL}\` label as well as the queue's, which the queue's own read excludes — so it was invisible to it`;
  if (state.attempts >= MAX_ATTEMPTS) return `the queue had spent all ${MAX_ATTEMPTS} of its attempts on it`;
  if (state.resolving) return 'it was marked as one somebody else is already dealing with';
  if (state.declined)
    return 'a resolver had already given its conflict up, so nothing here was going to open another one — it was counting down to a card';
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

/**
 * The writes the plan describes, made — the half of admission that touches a tracker.
 *
 * `admitPlan` above is pure and stays pure; this is its executor, and it lives beside it
 * for lib/mergeraise.js's reason. That file is the door *out* and it both decides and
 * writes, in one place, because a handover is a sequence whose order is the whole of its
 * safety. This is the door back in and the argument is the same one: the state, the
 * assignee and the record are three writes that mean something only in that order, and a
 * second copy of them — one in `bin/merge.js` for the command, one in `lib/server.js` for
 * the button — is two copies that drift.
 *
 * bc-02ldo is what that drift cost. The app's Merge button called `pr.merge` and left no
 * tracker record at all while `/merge` filed a bead and let the queue merge, and the two
 * looked accidentally inconsistent rather than deliberately different: deluvia #53 and #54
 * went through the command and each left a merge-bead, #55 went through the button and its
 * approval exists nowhere. Both doors are this function now, so there is one behaviour to
 * be right about.
 *
 * **`bd` and the pull request are injected**, as everywhere on this layer: a test of the
 * sequence should need neither a tracker nor GitHub, and the server already holds one `bd`
 * for every workspace it serves. `prComment` is optional and is the note on the pull
 * request itself — a caller in a workspace of forty repos has to resolve the checkout
 * first, and the resolution is not this function's to guess (bc-l853.6).
 *
 * ## What throws, and what only warns
 *
 * The split is `bin/merge.js`'s and it is not cosmetic. A failure of the first two writes
 * — the bead's own state, and the assignee `queueFor` selects on — leaves a pull request
 * that is **not** on the queue, and a caller reporting success over that would be claiming
 * a merge nothing is going to make. Those throw, carrying `code` for the command's exit
 * status and `status` for the endpoint's. Everything after them is a record rather than a
 * mechanism — a comment, a note on the pull request, the dependency that parks the work
 * bead — and losing one is worth a line on somebody's console and never worth failing an
 * admission that has already taken effect.
 */
export async function admitToQueue(
  bd,
  ws,
  plan,
  { cfg = {}, view = {}, repo = '', bead = null, method = 'merge', by = 'Adam', rows = [], prComment = null, onWarn = () => {} } = {}
) {
  const first = (err) => String(err?.message || err || '').split('\n')[0];
  const fatal = (msg) => Object.assign(new Error(msg), { code: 5, status: 500 });
  const number = Number(view.number);
  const comment = admitComment(plan, { by });
  const warn = async (fn, why) => {
    try {
      await fn();
    } catch (err) {
      onWarn(`${why} — ${first(err)}`);
    }
  };

  if (plan.action === 'file') {
    /**
     * Nothing in the tracker is about this pull request, so the queue entry is made here —
     * the same bead `beadcause-deliver` files, with the block built from what GitHub says
     * rather than from what a session did, because there was no session.
     *
     * The work bead is optional and usually absent: this is the case where Adam opened the
     * pull request himself. `finish` in lib/mergequeue.js already handles a block that
     * names no bead — it closes the queue entry and stops — so the absence needs no
     * special handling anywhere but in the body, which must not claim to be closing a bead
     * that does not exist.
     */
    const delivery = {
      workspace: ws.name,
      bead,
      repo,
      number,
      url: view.url,
      branch: view.branch,
      base: view.base,
      method: String(method || 'merge'),
      title: view.title,
      summary: `Admitted to the merge queue by ${by}.`,
      tests: '',
      risk: '',
      left: '',
    };

    const body = bead
      ? mergeBeadBody(delivery, {})
      : [
          `**${repo || ws.name}** — pull request [#${number}](${view.url}) was admitted to the merge queue by ` +
            `${by}, and no work bead is named on it.`,
          '',
          `The queue brings \`${view.base}\` into \`${view.branch}\`, checks whatever \`${view.base}\` is not ` +
            `already failing, merges, and closes this bead. Nothing else closes with it.`,
          '',
          '_What the merge acts on, in the form the server reads it:_',
          deliveryBlock(delivery),
        ].join('\n');

    let filed;
    try {
      filed = await bd.create(ws, {
        title: mergeBeadTitle(delivery),
        body,
        type: 'task',
        // Above the work it gates, as bin/deliver.js files it, so a queue that is behind is
        // visible on the board rather than buried under the beads waiting on it.
        priority: 1,
        // Whose merge this is, when a tracker is shared — the same labels
        // `beadcause-deliver` puts on the merge-bead it files, and nothing at all on a
        // single-person install. Without them a queue entry filed into the Climative graph
        // belongs to nobody.
        labels: [...plan.addLabels, ...ownAddresseeLabels(cfg)],
        notes: withQueueBlock('', plan.state),
      });
    } catch (err) {
      throw fatal(`could not file a merge-bead in ${ws.name} — ${first(err)}`);
    }
    // `Bd.create` answers with the id itself.
    const id = typeof filed === 'string' ? filed : filed?.id;
    if (!id) throw fatal(`filed a merge-bead in ${ws.name} but bd said nothing about which`);

    try {
      await bd.assign(ws, id, MERGE_ASSIGNEE);
    } catch (err) {
      throw fatal(`filed ${id}, but could not assign it to ${MERGE_ASSIGNEE} — the queue will not see it (${first(err)})`);
    }

    if (bead) {
      // The work bead waits behind the queue entry, which is what stops anything closing it
      // while the branch is still in a pull request — the same dependency bin/deliver.js
      // makes, and the whole mechanism by which the merge is what finishes the work.
      await warn(() => bd.addDep(ws, bead, id), `${bead} is NOT parked behind ${id}`);
    }

    await warn(() => bd.comment(ws, id, comment), `${id} took no comment`);
    if (prComment) {
      await warn(
        () => prComment(number, `${by} admitted this to the beadcause merge queue as ${id}. The queue merges it once its gates pass.`),
        `could not comment on #${number}`
      );
    }
    return { action: 'file', id, filed: true, queued: true, comment };
  }

  /* An existing bead: relabelled and re-armed, or simply told about the approval. */

  const spec = plan.spec;
  /**
   * The bead's own row, out of the same list the plan was decided from — and a **refusal**
   * rather than a default when it is not there.
   *
   * `withQueueBlock` is a read-modify-write of the whole `notes` field: it cuts the queue
   * block out by its markers and keeps everything else. Handed `''` it keeps nothing, and
   * what it would silently destroy is the *review* block bc-36xx.2 puts in the same field
   * — the round count, the reviewer's comments and the worker's answers. A caller that
   * decided a plan from one list and executed it against another would lose all of that
   * and be told nothing, so the mismatch is worth an error nobody can miss.
   */
  const row = (rows || []).find((r) => r.id === plan.id);
  if (!row) {
    throw fatal(
      `${plan.id} is not in the rows this plan was made from, so its notes cannot be rewritten without losing whatever else is in them`
    );
  }

  /**
   * The description goes back to being a queue entry's, and only on `admit`.
   *
   * A raised card's body is written to be answered — *it could not merge, so it is yours,
   * answering Merge merges it* — and leaving that on a bead that is back in the queue is a
   * bead whose own description tells the next reader to do something nobody is going to do.
   * `mergeBeadBody` is the other half of the same pair, from the same `beadpr` block, so
   * the round trip is lossless.
   *
   * The **title** is deliberately left alone. A delivery card's title is the question it
   * asked, a merge-bead's is `Merge #N — bead: what`, and rewriting one into the other
   * would rename a bead in the middle of somebody's board for no gain — the label is what
   * says which of the two it is now.
   */
  const description =
    plan.action === 'admit' ? mergeBeadBody({ ...spec, title: row.title || '' }, { tests: spec.tests || '' }) : undefined;

  try {
    await bd.update(ws, plan.id, {
      description,
      notes: withQueueBlock(row.notes || '', plan.state),
      addLabels: plan.addLabels,
      removeLabels: plan.removeLabels,
    });
  } catch (err) {
    throw fatal(`could not put ${plan.id} back on the queue — ${first(err)}`);
  }

  if (plan.assignee) {
    try {
      await bd.assign(ws, plan.id, plan.assignee);
    } catch (err) {
      throw fatal(
        `${plan.id} carries the ${MERGE_LABEL} label now, but could not be assigned to ${plan.assignee} — ` +
          `the queue selects on the assignee, so it will not pick this up until that is fixed (${first(err)})`
      );
    }
  }

  await warn(() => bd.comment(ws, plan.id, comment), `${plan.id} took no comment`);

  if (plan.action === 'admit' && prComment) {
    await warn(
      () => prComment(number, `${by} approved this. It is back on the beadcause merge queue as ${plan.id}.`),
      `could not comment on #${number}`
    );
  }

  return { action: plan.action, id: plan.id, filed: false, queued: plan.action === 'admit', comment };
}
