/**
 * The third reason a bead may not be worked: it is already closed.
 *
 * On 2026-08-12 a worker window was handed a full worker brief for bc-ikj6 — "opened
 * automatically by the beadcause advocate because it came up ready" — seventy-eight
 * minutes after bin/deliver.js closed it and #173 had merged. `bd ready` cannot return a
 * closed bead and `survey()` is built from it, so no fresh survey queued that window; the
 * launch path could not be established from what was left on disk, and that is exactly
 * why this is a refusal at the door rather than one more filter upstream. A guard that
 * only holds when you can name the route is a guard that holds until the day you cannot.
 *
 * **The wasted window is the harmless half.** The worker brief opens with *claim it
 * before you touch anything*, and `bd update <id> --claim` sets `in_progress`. On a
 * closed bead that **resurrects merged work**: it reopens the bead, puts it back in front
 * of the next advocate tick, and that tick can open another window on it. A session that
 * simply obeys its brief in order does this before it ever reads the close reason. The
 * window that found bc-ikj6 escaped only because it happened to run `bd show` first and
 * noticed `[CLOSED]`. So the loop is the bug, and closing the loop needs the refusal to
 * sit in front of the claim rather than beside it.
 *
 * Two layers, and they are lib/endorse.js's two for lib/endorse.js's reason:
 *
 * 1. **A refusal**, here, in `openWorkSession` and `openPlanSession` — the only doors
 *    into an unattended session. It reads the row `assertEndorsed` has already fetched
 *    from the tracker, so it costs nothing and it cannot be fooled by a stale queue row,
 *    which is the whole point: the bead closed *after* the queue was built.
 * 2. **A sentence in the brief**, in `workPromptFor` — because the refusal only covers
 *    the doors this daemon owns. A window opened by hand, resumed, or launched by
 *    something written later still starts by reading its brief, and the brief now says
 *    what to do when `bd show` says closed instead of leaving "claim it" as the first
 *    instruction on the page.
 *
 * **Only `closed`.** `in_progress` is deliberately workable: attempt 2 on a bead the
 * previous window claimed and left is an ordinary retry, and refusing it would turn every
 * abandoned session into a bead nothing may ever pick up again. Everything else — blocked,
 * deferred — is a queue question that `bd ready` already answers, and answering it twice
 * here would be a second opinion with no incident behind it.
 */

/** Is this bead finished? Takes a `bd --json` row, or anything with a `status`. */
export const isClosed = (issue) => String(issue?.status || '').trim().toLowerCase() === 'closed';

/**
 * Why this bead may not be worked.
 *
 * `status: 409` and a named boolean, matching lib/endorse.js and lib/superseded.js field
 * for field: a caller can tell this from a launch that failed, and the advocate has no
 * business retrying it — where iTerm refusing is worth a second go.
 */
export const refusal = (id, reason) =>
  Object.assign(
    new Error(
      `${id || 'that bead'} may not be worked — it is already closed${reason ? ` (${reason})` : ''}`
    ),
    { status: 409, closed: true }
  );

/**
 * The gate, given a row the caller has already read from the tracker.
 *
 * Takes no `bd` and makes no call, for `assertNotSuperseded`'s reason: it sits
 * immediately after `assertEndorsed`, which has just paid for the `bd show`, and hands
 * over what it read. Trusting a *caller-supplied* row would be the hole lib/endorse.js
 * closes; trusting the row the tracker itself just returned is the same fact already
 * fetched, and a second `bd show` would only ask it again a millisecond later.
 *
 * The close reason rides into the message when the tracker gave one, because the sentence
 * a human reads in a log is "it is already closed (landed as #173)" rather than a bead id
 * they then have to go and look up.
 */
export function assertStillOpen(issue) {
  if (isClosed(issue)) throw refusal(issue?.id, closeReasonOf(issue));
  return issue;
}

/**
 * The close reason, trimmed to one line, or empty.
 *
 * bd spells it `close_reason` in `--json` and `closeReason` through some wrappers; both
 * are read because the alternative is a message that silently loses the only sentence
 * anyone actually wants from a closed bead.
 */
export const closeReasonOf = (issue) =>
  String(issue?.close_reason || issue?.closeReason || '')
    .split('\n')[0]
    .trim();
