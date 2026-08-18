/**
 * An epic whose children have all closed, and nobody has said whether the theme is done.
 *
 * bc-xl7n.74. `batchesFor` (lib/advocate.js) skips an epic whose ready children are below
 * `minBatchBeads` — and an epic with **zero** ready children is always below it, whatever
 * the floor is set to. That epic falls through the hierarchy filter and is dispatched as
 * an ordinary ready bead, exactly the case bc-xl7n.14 fixed for a *standing root* by
 * giving containers a machine-readable label. This is the other shape: not a root with
 * nothing under it yet, but a **themed** epic that had a definition of done, reached it,
 * and now has nothing open underneath it. `bc-xl7n.8` is the worked example — 3/3 children
 * closed, `bd show` itself already saying "eligible for close" — and the advocate opened a
 * worker window on it anyway. A worker's one sanctioned ending is `bin/deliver.js`, which
 * needs a branch to push, and a finished epic has none: `bin/deliver.js` exits 2 with "no
 * commits that origin/main does not". The window's only honest ending was a hand-written
 * card, which is a whole session spent producing the one tap this file now offers for free.
 *
 * The shape is lib/superseded.js's and lib/inmain.js's, because it is the same shape: a
 * fact a sweep can establish, a decision that stays with Adam, and no session spent on it.
 * One line on the thread, an ask with a `decision` block appended to the notes so the
 * judgement is one tap from a phone, and the `human` label — which is also the whole of the
 * saving, because `bd ready` excludes `human` and an advocate that cannot see a bead cannot
 * open a session on it. **The card is the bead itself**: answering a `human` bead closes it
 * (`respond` in lib/bd.js), so one tap really is the close.
 *
 * Unlike lib/inmain.js, the close **is** offered here, and deliberately: that file's
 * `closeOffer` withholds it from every epic on principle — "an epic finishes when its theme
 * does, not when a branch sharing its name lands" — because a branch match is coincidental
 * evidence about a bead that happens to mention a ref. "Every child this tracker knows about
 * is closed" is not coincidental in the same way; it is the exact fact bd's own `bd show`
 * already reports as "eligible for close". Recommending the close costs nothing — tapping
 * an option only pre-fills the answer box — and the other option hands the epic straight
 * back to `bd ready` with the finding on it, so a wrong guess here costs one tap to undo,
 * never a stranded epic.
 *
 * **Direct children only, matching the very check that lets this fall through.**
 * `batchesFor`'s and `heldByChildren`'s epic branch both read `bd.children`, which is one
 * level — a grandchild that is open with no live worker on it is a gap those two already
 * accept (a stale claim, or a reclaim) rather than a gap worth a `bd export` per epic per
 * sweep. Asking the identical question here means this sweep and the dispatch path it
 * guards can never disagree about which epics qualify.
 *
 * Nothing here closes, reopens, merges or deploys anything. It reads the tracker and writes
 * three lines to one bead, and every failure is a returned sentence rather than a throw — a
 * sweep is a courtesy on top of the advocate's tick and may not take the tick down with it.
 */

/** The label that puts a bead in the inbox and takes it out of every advocate queue. */
const HUMAN_LABEL = 'human';

/** bd's word for a bead that holds work under it rather than being work. */
const EPIC = 'epic';

/** Where the sweep leaves its fingerprint, so it can tell its own work from a rewrite. */
const ASK_MARK = '<!-- beadcause:finishedepic -->';

/**
 * Has this epic already been asked about? Read off the row `bd ready` returned.
 *
 * Three fields, lib/superseded.js's set: the notes are where the card actually lives, and
 * description/design are checked because a bead is somebody's to edit — an ask moved by
 * hand is still an ask, and asking again over the top of it would be the sweep arguing
 * with a human.
 */
export const alreadyAsked = (issue) =>
  [issue?.description, issue?.design, issue?.notes].some((f) => String(f || '').includes(ASK_MARK));

/**
 * The line on the thread. Short: the card carries the reasoning, this carries the fact.
 */
export const finishedEpicComment = (open, total) =>
  `Every one of its ${total} child${total === 1 ? '' : 'ren'} is closed and none is open. Asking whether the ` +
  `theme is finished — see the card in the inbox. Nothing has been closed.`;

/**
 * The card: markdown with a `decision` block in it, appended to the notes.
 *
 * The close is recommended and the other option is a commission (`closes: false`), exactly
 * lib/superseded.js's shape — see the header for why an epic gets the offer here where
 * lib/inmain.js withholds it. Nothing interpolated into the block comes from arbitrary
 * prose: `id` is a bead id and `total` is a count, so nothing here needs quoting the way a
 * branch name or a commit subject would.
 */
export function finishedEpicAsk(id, total) {
  return `${ASK_MARK}
## Every child of ${id} is closed

All ${total} child${total === 1 ? '' : 'ren'} of this epic ${total === 1 ? 'is' : 'are'} closed, and nothing under
it is open. \`bd show\` already reads this as "eligible for close" — that is a fact about the
tracker, and whether the *theme* is actually finished is a judgement only you can make.

**Nothing has been closed and nothing will be.** What this label is doing is keeping a
worker window from being opened on an epic that has no diff left to deliver — a worker's
only ending is \`bin/deliver.js\`, and there is nothing here for it to push. If this stays
open and unanswered, nothing else happens to it: no session, no notification, just a bead
sitting out of the queue until you tap one of these.

\`\`\`decision
question: Every child of ${id} is closed — is the epic finished?
options:
  - id: close
    label: Close it — the theme is done
    response: "All ${total} child${total === 1 ? '' : 'ren'} are closed. Closing the epic as finished."
    hint: Nothing left to deliver
    recommended: true
  - id: keep
    label: Keep it open — more belongs here
    response: "Not finished — more belongs under this epic than what has closed so far. Handing it back as ordinary work with nothing open underneath it yet."
    hint: Back to bd ready, still with no open child
    closes: false
\`\`\`
`;
}

/**
 * Is this row worth asking `bd.children` about at all?
 *
 * `bd.ready` has already done most of the work: a container, a ship bead, an unendorsed
 * one, a superseded one and anything already in the inbox never reach here, because they
 * never reach `bd ready`. All that is left to check is the type and the fingerprint.
 */
function isCandidate(row) {
  if (String(row?.issue_type || row?.type || '').toLowerCase() !== EPIC) return false;
  if (alreadyAsked(row)) return false;
  return true;
}

/**
 * Sweep one workspace. Returns what it flagged and what it did not.
 *
 * `rows` exists for the tests and for a caller that has already read `bd ready` this tick;
 * everything else pays for one. `bd.ready` is the right list to walk rather than an
 * approximation of one: it is exactly the queue `batchesFor` and the ordinary dispatch path
 * build their own picture from, so an epic that qualifies here is an epic that would
 * otherwise have been handed to `heldByChildren` and found workable.
 */
export async function sweepFinishedEpics(bd, ws, { rows = null } = {}) {
  const out = { ok: false, reason: '', checked: 0, flagged: [], skipped: [] };

  let beads = rows;
  if (!beads) {
    try {
      beads = await bd.ready(ws);
    } catch (err) {
      out.reason = `could not read the ready queue — ${String(err.message || err).split('\n')[0]}`;
      return out;
    }
  }

  out.ok = true;
  for (const bead of beads || []) {
    if (!isCandidate(bead)) continue;
    out.checked += 1;

    let children;
    try {
      children = await bd.children(ws, bead.id);
    } catch (err) {
      out.skipped.push({ id: bead.id, why: `could not read its children — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }
    const total = (children || []).length;
    // No children at all is not "finished" — it is a standing root a survey has not
    // reached yet, or an epic brand new this tick. Nothing to say about either.
    if (!total) {
      out.skipped.push({ id: bead.id, why: 'no children at all — nothing to declare finished', quiet: true });
      continue;
    }
    const open = (children || []).filter((c) => c && c.status !== 'closed');
    if (open.length) {
      out.skipped.push({ id: bead.id, why: `${open.length} child${open.length === 1 ? '' : 'ren'} still open`, quiet: true });
      continue;
    }

    try {
      await bd.comment(ws, bead.id, finishedEpicComment(open.length, total));
    } catch {
      // The ask below is the part that matters — the comment is only the record.
    }

    try {
      // The ask, then the label, in that order: the notes are where the card's body and
      // its `decision` block are read from (lib/decision.js), and the label *is* "it is
      // in the inbox". A card that appeared before its options were written would be a
      // question with no answers.
      await bd.appendNotes(ws, bead.id, finishedEpicAsk(bead.id, total));
      await bd.addLabel(ws, bead.id, HUMAN_LABEL);
    } catch (err) {
      out.skipped.push({ id: bead.id, why: `could not put it in the inbox — ${String(err.message || err).split('\n')[0]}` });
      continue;
    }

    out.flagged.push({ id: bead.id, title: bead.title || '', total });
  }

  return out;
}

/** One line for the log and the card. Empty when the sweep found nothing worth saying. */
export function describeFinishedEpics(result) {
  if (!result.ok) return result.reason ? `finished-epic sweep skipped — ${result.reason}` : '';
  if (!result.flagged.length) return '';
  const named = result.flagged.map((f) => `${f.id} (${f.total}/${f.total} closed)`).join(', ');
  return `flagged ${result.flagged.length} finished epic${result.flagged.length === 1 ? '' : 's'} — ${named}`;
}
