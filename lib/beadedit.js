/**
 * Editing a bead that is already real — the other half of `lib/verdict.js`'s ✎.
 *
 * The adjust verdict and this are the same six fields written by the same clamps, and
 * they are deliberately two acts rather than one, because the thing they refuse is
 * different:
 *
 * - **Adjust** (`POST /api/bead/adjust`) is a verdict on a *proposal*. It refuses a bead
 *   that is no longer `unendorsed`, and that refusal is the whole point of the file it
 *   lives in: between the endorsement queue being drawn on the phone and a thumb landing
 *   on a row, the bead may have been endorsed on the laptop, and rewriting work somebody
 *   has just agreed to over a stale list is what lib/verdict.js exists to prevent.
 * - **Edit** (here, `POST /api/bead/edit`) is the bead detail sheet's ✎ — you are looking
 *   at the bead you are editing, not at a row in a queue drawn a minute ago, and the
 *   staleness argument above does not apply to it at all. So it works on any open bead,
 *   endorsed or not, and it inherits none of that refusal.
 *
 * **What it does keep are the two protections that were never about endorsement.**
 * `isProtectedLabel` (lib/verdict.js) is imported rather than restated, so a form here
 * cannot set or clear `unendorsed`, `agent-filed`, `owner:`, `for:`, `ran:` or
 * `filed-while:` — and, more usefully, a seventh family added to that list next month
 * reaches this route for free rather than being a hole nobody notices. The argument for
 * each is written where it lives; the shape of the failure is the same for all of them
 * and is worth restating once: the ✎ posts *the label set the card is showing*, so
 * "remove what I no longer see" is how a removal is expressed, and a label the card never
 * offered you would be destroyed by omission on the first save. `owner:` in particular
 * moves through `POST /api/bead/owner` and nowhere else — which is why editing a P0's
 * title from a phone cannot quietly hand it back to nobody.
 *
 * **And it moves no marker of its own.** An unendorsed bead edited here is still
 * unendorsed afterwards; there is no `endorse: true` on this route, because endorsing is
 * `POST /api/bead/endorse` and the reason adjust carries the flag — "adjusted, and yes,
 * work on it" is one decision made in one tap on a queue row — is a fact about the queue
 * screen rather than about editing.
 *
 * **A closed bead is refused, and that is the only status that is.** A closed bead's
 * description is no longer a statement of what to do; it is the record of what was done,
 * read by the next session that finds the same thing filed again. Rewriting one silently
 * rewrites that record, and the useful move on a bead you want to say something about
 * after the fact is a comment, which is a door that already exists. This is also the one
 * refusal a client can predict, since the sheet already knows the bead's status.
 *
 * **A bead a session is actively working can be edited, and the thread says so.** This
 * was left open when the bead was filed and it is decided here, in the direction that
 * costs least when it is wrong. Refusing `in_progress` reads as the careful answer and
 * is not: an `in_progress` bead's next status is *closed*, so a "fix it later" that the
 * refusal implies never arrives — the window in which the bead could be corrected closes
 * without ever having opened, and a priority typed wrong at 02:00 stays wrong for good.
 * The real cost of allowing it is that the session already has its brief and will deliver
 * against the text it read, which no refusal here can undo either. So the edit lands and
 * `changeSummary` carries an extra sentence saying a session was working the bead at the
 * time, because the next thing to read that thread — a review round, a handback, the
 * window opened on the same bead tomorrow — is exactly who needs to know the bead no
 * longer says what the last worker was told.
 */
import { isHeld } from './endorse.js';
import { changeSummary, loadBead, normalizeEdits, updateFor } from './verdict.js';

const clean = (v) => String(v ?? '').trim();

/**
 * How the thread announces an edit, and why it is not the adjust's wording.
 *
 * `_Adjusted before endorsement:_` is a true sentence about a proposal and a false one
 * about a bead three weeks into being worked. The two prefixes are what make
 * `bd comments` readable as two different acts rather than as one act with a confusing
 * name — which matters most on the beads that have had both.
 */
export const EDIT_PREFIX = '_Edited:_';

/**
 * The clause appended when the bead was being worked as it was rewritten.
 *
 * Deliberately a sentence rather than a label: it is true of one moment and there is
 * nothing to clear afterwards. A label would have to be removed by something, and the
 * only honest remover is the merge that closes the bead.
 */
export const IN_PROGRESS_NOTE =
  'A session was working this bead at the time, so it may be running from the previous text.';

/** The statuses this route will not rewrite, and the refusal each gets. */
export function editRefusal(issue) {
  if (clean(issue?.status) === 'closed') {
    return Object.assign(
      new Error(
        `${clean(issue?.id)} is closed — a closed bead's description is the record of what was done, not an instruction; say it in a comment instead`
      ),
      { status: 409, closed: true }
    );
  }
  return null;
}

/** Whether a bead is claimed by a running session, which the thread note turns on. */
export const isInProgress = (issue) => clean(issue?.status).toLowerCase() === 'in_progress';

/**
 * Rewrite the editable fields of one live bead, and say on the thread what moved.
 *
 * One bead, not a list, and for `POST /api/bead/discuss`'s reason rather than a technical
 * one: the four verdicts take a list because "endorse these five" is a thing a busy week
 * produces, and this is the sheet for one bead you are looking at. A title given to six
 * beads is the client bug adjust already refuses; here there is no group to refuse.
 *
 * `updateFor` is what makes a sheet that posts the whole form on every save cheap — an
 * edit that re-sends the values already on the bead is no `bd` write at all, and
 * `changed: false` is the ordinary answer rather than an error.
 */
export async function editBead(bd, ws, id, { edits = {}, actor = null } = {}) {
  const issue = await loadBead(bd, ws, id);
  const refusal = editRefusal(issue);
  if (refusal) throw refusal;

  const { update, changed } = updateFor(issue, normalizeEdits(edits));
  const working = isInProgress(issue);
  if (changed.length) {
    await bd.update(ws, id, update, { actor });
    // The note is worth having and not worth failing over — the same trade `adjustOne`
    // makes, for the same reason: the fields are already rewritten, and losing the edit
    // to a comment that could not be written would undo nothing and report a failure
    // that did not happen.
    const summary = changeSummary(issue, update, EDIT_PREFIX);
    const note = working ? `${summary} ${IN_PROGRESS_NOTE}` : summary;
    if (summary) await bd.noteOnly(ws, id, note, { actor }).catch(() => {});
  }
  return {
    id,
    changed: changed.length > 0,
    fields: changed,
    title: clean(update.title || issue.title),
    status: clean(issue.status),
    inProgress: working,
    // Reported rather than acted on here, because the thing it is needed for is a cache
    // the server owns: a held bead's title, priority and labels are *what the
    // endorsement queue draws*, so editing one from the sheet leaves that list saying
    // something the bead no longer says. The route drops it — see `forgetQueue`.
    held: isHeld(issue),
  };
}
