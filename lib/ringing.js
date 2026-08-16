/**
 * What is still making a noise on the phone.
 *
 * One piece of state, in state.json, owned by this file's callers:
 *
 *   - `ringing` — keyed `workspace/id`, one entry per bead whose notification this
 *     daemon actually caused and has not cancelled. Written when a push is *not*
 *     quiet, dropped when the bead leaves the inbox. It is a record of the shade,
 *     not of the tracker.
 *
 * Narrowing the inbox filter silences what comes *next*: `quietReasonFor` in
 * lib/spaces.js sees to that, and it is the whole of what the filter does. It says
 * nothing about the notifications already sitting in the shade for beads the new
 * filter excludes, and — since bc-ka5y.1 — nothing offers to clear them either. They
 * stay unread until the filter is widened, silently. There used to be a pane on the
 * inbox that counted them and offered both answers; it is gone, along with the
 * `shadeSeen`/`ringingDeclined` bookkeeping that existed to stop it asking twice.
 *
 * **The honest limit, written down where the code is rather than only in the bead:
 * an ntfy notification already delivered to the phone cannot be recalled.** ntfy is
 * a one-way relay; the server has no handle on a message it has published. What can
 * actually be cleared is the Android shell's own tray — it holds a live connection
 * and cancels on an event (see `dismissed` in WatchService.kt) — so that shell is the
 * only surface anything here can act on.
 *
 * The inbox has no unread marker of its own to clear either, and must not grow one
 * here: the badge counts beads that are *open*, and a count that dropped would be
 * claiming a decision nobody made.
 *
 * **`ringing` is this daemon's belief about the shade, not the shade itself.** It can
 * be wrong in one direction: the Android tray is in-memory (see Tray.kt), so a phone
 * that restarted the app, or a row you swiped away yourself, leaves a record here for
 * something that is no longer on screen. The consequence is bounded and one-way — a
 * record that is stale, and a `dismissed` event that cancels nothing. The opposite
 * error is the one that would matter, and it cannot happen: nothing is recorded unless
 * this daemon actually made a noise about it.
 */

/**
 * The entry to store for a bead that has just made a noise.
 *
 * Its opposite number is `quietArrival` in lib/hushed.js, written in the same loop for
 * the beads that made none. The two maps are exclusive per key by construction, which
 * is what lets the card read one of them and say "arrived quietly" without ever
 * contradicting a notification that really did go out.
 *
 * `foundation` is carried because the channel is drawn above the list and outside
 * every filter on it (see `requestsHtml` in public/app.js), so anything reasoning
 * about what the filter reaches has to be able to tell the two apart — and asking
 * `bd` again later to find out which channel a bead was in would be a sweep for
 * something we knew at push time.
 */
export function rangFor(q, now = new Date()) {
  return {
    workspace: q.workspace,
    id: q.id,
    foundation: Boolean(q.foundation),
    at: now.toISOString(),
  };
}

/** Keep only the beads still in the inbox. Anything else has had its row cancelled. */
export function retain(ringing, liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  return Object.fromEntries(Object.entries(ringing || {}).filter(([key]) => live.has(key)));
}

/** Forget these keys — they have been cleared, or answered, or set aside. */
export function drop(ringing, keys) {
  const gone = new Set(keys || []);
  return Object.fromEntries(Object.entries(ringing || {}).filter(([key]) => !gone.has(key)));
}
