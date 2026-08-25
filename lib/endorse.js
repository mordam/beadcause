/**
 * Endorsement — the one label that decides whether anything may open a session on a bead.
 *
 * A worker that finds work mid-task files the bead itself (see bin/propose.js and the
 * brief in lib/session.js), and it arrives carrying `unendorsed`. That marker is not a
 * hint and not a sort order: **an unendorsed bead is not workable.** If it were merely
 * absent from the advocate's queue, then the first thing to hand it an id — a retry, a
 * tap, a future caller of `openWorkSession` written by someone who had not read this
 * file — would put an hour of unattended agent onto work nobody had looked at yet, and
 * "endorse it" would be a formality performed after the fact. Revoking it would mean
 * nothing.
 *
 * So the hold is two layers, and they are different in kind:
 *
 * 1. **A filter**, in `Bd.ready` and in the advocate's survey — the marker is out of
 *    every queue and out of every count that says how much work is waiting. This is
 *    what keeps layer 2 from ever being reached, which is why it is not the guarantee.
 * 2. **A refusal**, in `openWorkSession` — the launcher asks the tracker itself, and a
 *    held bead handed straight to it still cannot be worked. This *is* the guarantee,
 *    and it is deliberately not a filter: it fails loudly, on the bead, rather than by
 *    a window quietly not appearing.
 *
 * **A label, not a status.** bd's statuses already mean things — open, blocked,
 * deferred all say something about the dependency graph or the clock, and none of them
 * says "nobody has looked at this yet". A label is also the thing `bd ready`, `bd list`
 * and `bd human` can all filter on today, without a new bd release.
 *
 * The exceptions are you, and there are two of them. Tapping "work on this" on the phone
 * **endorses the bead and then opens it** (`POST /api/session`, lib/server.js): you are
 * present and choosing, and a refusal there would send you to another screen to press a
 * button and come back. **Answering a card with "…and endorse bc-x" performs it**
 * (`/api/respond`, read by lib/endorseanswer.js): the same reasoning, for a bead the
 * answer *names* rather than the one it is on, which is the half it did not cover until
 * bc-xl7n.76.3 — twice an answer said so and twice the marker stayed exactly where it
 * was. That second one goes through `applyVerdict` in lib/verdict.js rather than calling
 * `endorse` directly, so it fires the same `endorsement` event as the queue page and a
 * bead endorsed from an answer leaves every device's queue at the same moment.
 *
 * Both end here: `endorse` below is the only thing in the daemon that takes the marker
 * off, and a third caller that wrote the label itself would be the quiet path this file
 * exists to prevent.
 *
 * One of six places that decide whether something may run with nobody watching —
 * lib/authority.js is the map of all of them.
 *
 * **What this hold is not strong enough to be.** A marker a tap is designed to remove is
 * the wrong place to hang a promise that no tap should be able to break. lib/release.js
 * hung one there — ship beads were filed `unendorsed` so nothing would open a session on
 * one — and "Endorse all" took it off twenty-five of them in a single press. That guarantee
 * now keys on the `ship` label itself; see lib/shipbead.js for the incident and the shape.
 */
import { SHIP_LABEL } from './shipbead.js';
import { CONTAINER } from './container.js';

/** The marker. One string, one place, because three spellings is the same as no hold. */
export const UNENDORSED = 'unendorsed';

/**
 * What no advocate queue may contain: questions are yours rather than its, a held bead is
 * nobody's yet, a ship bead is nobody's *ever* — only a deploy closes one, and a deploy
 * is a tap (lib/shipbead.js) — and a container is not work at all, it is the standing root
 * other beads are filed under (lib/container.js). Passed at the call site in lib/advocate.js
 * so the survey reads truthfully, *and* forced on by `Bd.ready` so a caller cannot ask for
 * work it may not have.
 *
 * `ship` and `container` are here rather than in their own files' lists because this is the
 * list every queue already consults, and a second one would be a second place to forget.
 */
export const QUEUE_EXCLUDED = ['human', UNENDORSED, SHIP_LABEL, CONTAINER];

/** Does this bead carry the marker? Takes a `bd --json` row, or anything with `labels`. */
export const isHeld = (issue) =>
  (issue?.labels || []).some((label) => String(label).trim() === UNENDORSED);

/**
 * Why this bead may not be worked.
 *
 * `status: 409` so a request that asks for it gets a conflict rather than a 500, and
 * `unendorsed: true` so a caller can tell this refusal from a launch that failed —
 * the advocate has no business retrying this one, where iTerm refusing is worth a
 * second go.
 */
export const refusal = (id, why) =>
  Object.assign(new Error(`${id || 'that bead'} may not be worked — ${why}`), {
    status: 409,
    unendorsed: true,
  });

/**
 * The gate. Throws unless the tracker says this bead is endorsed.
 *
 * Three ways to fail, and all three are a refusal rather than a shrug, because the
 * alternative to "I cannot confirm this is endorsed" is opening a session anyway:
 *
 * - it carries the marker;
 * - there is no tracker here to ask, so the check could not be performed;
 * - the tracker has no bead by that id, so nothing can vouch for it.
 *
 * `bead` may be an id or a row. A row's own labels are trusted when it has them — the
 * advocate's queue rows come straight from `bd ready` — but the tracker is asked
 * regardless, because the point of this layer is to be right about a bead that reached
 * the launcher some other way, and a caller-supplied object proves nothing about it.
 * One `bd show` per session opened, against the twenty seconds an iTerm window takes,
 * is nothing.
 *
 * A `bd show` that throws (Dolt mid-write, most likely) propagates. That costs the
 * launch, and the next tick thirty seconds later asks again.
 */
export async function assertEndorsed(bd, workspace, bead) {
  const id = typeof bead === 'string' ? bead : bead?.id || '';
  if (isHeld(bead)) throw refusal(id, `it is ${UNENDORSED} — endorse it first`);
  if (typeof bd?.show !== 'function') {
    throw refusal(id, 'nothing here could ask the tracker whether it is endorsed');
  }
  const issue = await bd.show(workspace, id);
  if (!issue) throw refusal(id, 'the tracker has no bead by that id, so nothing can vouch for it');
  if (isHeld(issue)) throw refusal(id, `it is ${UNENDORSED} — endorse it first`);
  return issue;
}

/**
 * Take the marker off: the bead becomes ordinary work.
 *
 * Idempotent, and cheap when there is nothing to do — a bead that was never held is
 * `{ endorsed: false }` and no write at all, so the phone's "work on this" can call
 * this unconditionally without a `bd` write on every tap.
 *
 * `issueOrId` takes the row the caller already fetched, which is how `POST /api/session`
 * avoids a second `bd show` for a title it has in hand. Given a bare id it asks.
 *
 * Written as the daemon rather than as you, like every other label move here — see the
 * note on `commission` in lib/bd.js. What a bead's history wants a name against is a
 * sentence somebody said, and this is a bead moving between two queues.
 */
export async function endorse(bd, workspace, issueOrId) {
  const id = typeof issueOrId === 'string' ? issueOrId : issueOrId?.id || '';
  if (!id) throw refusal('', 'no bead id to endorse');
  const issue =
    typeof issueOrId === 'object' && Array.isArray(issueOrId?.labels)
      ? issueOrId
      : await bd.show(workspace, id);
  if (!isHeld(issue)) return { endorsed: false, id };
  await bd.removeLabel(workspace, id, UNENDORSED);
  return { endorsed: true, id };
}
