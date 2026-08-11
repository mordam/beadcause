/**
 * What is still making a noise on the phone — and what to do about it when the
 * inbox filter narrows.
 *
 * Narrowing the filter silences what comes *next*: `quietReasonFor` in lib/spaces.js
 * sees to that, and it is the whole of what the filter used to do. It says nothing
 * about the notifications already sitting in the shade for beads the new filter
 * excludes — which are precisely the ones you have just decided you do not want to
 * think about. Leaving them is the mess this closes.
 *
 * Three pieces of state, all in state.json, all owned by this file's callers:
 *
 *   - `ringing` — keyed `workspace/id`, one entry per bead whose notification this
 *     daemon actually caused and has not cancelled. Written when a push is *not*
 *     quiet, dropped when the bead leaves the inbox. It is a record of the shade,
 *     not of the tracker.
 *   - `ringingDeclined` — the keys you have said "leave them" about. Declining has to
 *     be remembered or the next sweep asks the same question again, which is worse
 *     than never asking.
 *   - `shadeSeen` — when a client that *owns* a notification shade last polled. See
 *     `shadeReachable`: without one, there is nothing this feature can offer.
 *
 * **The honest limit, written down where the code is rather than only in the bead:
 * an ntfy notification already delivered to the phone cannot be recalled.** ntfy is
 * a one-way relay; the server has no handle on a message it has published. What can
 * actually be cleared is the Android shell's own tray — it holds a live connection
 * and cancels on an event (see `dismissed` in WatchService.kt) — so that shell is the
 * only surface this can act on, and the ask is not offered when nothing has been
 * watching. Offering it anyway would be a button that reports success and clears
 * nothing.
 *
 * The inbox has no unread marker of its own to clear either, and must not grow one
 * here: the badge counts beads that are *open*, a dismissal leaves them open on
 * purpose, and a count that dropped would be claiming a decision nobody made.
 *
 * **`ringing` is this daemon's belief about the shade, not the shade itself.** It can
 * be wrong in one direction: the Android tray is in-memory (see Tray.kt), so a phone
 * that restarted the app, or a row you swiped away yourself, leaves a record here for
 * something that is no longer on screen. The consequence is bounded and one-way — a
 * count that is too high, and a `dismissed` event that cancels nothing. The opposite
 * error is the one that would matter, and it cannot happen: nothing is recorded unless
 * this daemon actually made a noise about it.
 */

import { matchesFilter, spaceFor } from './spaces.js';

/**
 * How long a shade stays believable after the last poll from the client holding it.
 *
 * Generous on purpose. A phone that is off the tailnet for the weekend still has
 * yesterday's notifications in its shade, and the dismissal reaches it when it comes
 * back — so the window is about whether the Android shell is *in use at all*, not
 * about whether it is reachable this second. Two weeks of silence is an app that has
 * been uninstalled, and then the ask has nothing to act on and should stop appearing.
 */
export const SHADE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Is there a notification shade this daemon can actually clear?
 *
 * The one question that decides whether any of this is offered. `shadeSeen` is only
 * ever written by a poll that says it owns a shade — the Android watcher passes
 * `shade=1`, and nothing else does — so an install where ntfy is the only surface
 * never has one, and never sees a prompt promising to clear something it cannot.
 */
export function shadeReachable(shadeSeen, now = new Date()) {
  const at = Date.parse(shadeSeen || '');
  if (!Number.isFinite(at)) return false;
  // A timestamp in the future is a clock that has been set backwards since it was
  // written, not a shade from tomorrow. Believe it rather than expiring it — the
  // failure to avoid is a prompt that never appears again.
  return now.getTime() - at < SHADE_TTL_MS;
}

/**
 * The entry to store for a bead that has just made a noise.
 *
 * Its opposite number is `quietArrival` in lib/hushed.js, written in the same loop for
 * the beads that made none. The two maps are exclusive per key by construction, which
 * is what lets the card read one of them and say "arrived quietly" without ever
 * contradicting a notification that really did go out.
 *
 * `foundation` is carried because the ask has to leave those alone — see
 * `excludedRinging` — and asking `bd` again later to find out which channel a bead
 * was in would be a sweep per prompt for something we knew at push time.
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

/**
 * The beads that are ringing and are now outside the filter.
 *
 * The filter test is `matchesFilter`, the same one the push path uses, so a bead the
 * filter would have kept quiet is exactly a bead the filter now offers to quieten —
 * the two cannot drift into disagreeing about what "excluded" means. The space is
 * derived from the workspace rather than stored, because a workspace can be moved
 * between spaces after a notification is posted and the filter has to be judged
 * against the setup that exists now.
 *
 * **Foundation requests are never in this list.** The inbox draws that channel above
 * the list and outside every filter on it (see `requestsHtml` in public/app.js), so a
 * request is still on your screen no matter how far the filter is narrowed — you have
 * not decided to stop thinking about it, and clearing its notification would be
 * acting on a decision nobody made. The push path used to quieten them anyway, which
 * this comment called out as a separate inconsistency; bc-8on settled it the other
 * way, so `quietReasonFor` now exempts the channel too and all three surfaces agree
 * that the filter does not reach it.
 */
export function excludedRinging(cfg, ringing, filter) {
  return Object.entries(ringing || {})
    .filter(([, r]) => r && !r.foundation)
    .filter(([, r]) => !matchesFilter(filter, { workspace: r.workspace, space: spaceFor(cfg, r.workspace)?.name || null }))
    .map(([key, r]) => ({ key, workspace: r.workspace, id: r.id }));
}

/**
 * Declining is remembered per bead, and only while that bead is still excluded.
 *
 * So widening the filter forgets it: the question became moot the moment the bead
 * came back into view, and narrowing again later is a new situation that deserves a
 * fresh ask rather than a silence inherited from last week. Answered beads fall out
 * for free — they are no longer ringing, so they are no longer excluded-and-ringing.
 */
export function pruneDeclined(declined, excluded) {
  const still = new Set((excluded || []).map((e) => e.key));
  return [...new Set(declined || [])].filter((key) => still.has(key));
}

/**
 * What to put in front of you, or null for "say nothing".
 *
 * Null in three distinct situations, and they are worth keeping distinct because
 * only one of them is a bug when it is wrong: nothing is ringing outside the filter
 * (the ordinary case — a filter change with nothing to clear must be silent); every
 * excluded bead is one you already declined (the re-ask this guards against); or
 * there is no shade to clear at all.
 */
export function dismissAsk({ cfg, ringing, declined, filter, shadeSeen, now = new Date() }) {
  if (!shadeReachable(shadeSeen, now)) return null;
  const seen = new Set(declined || []);
  const keys = excludedRinging(cfg, ringing, filter)
    .filter((e) => !seen.has(e.key))
    .map((e) => e.key);
  if (!keys.length) return null;
  // `count` as well as the keys, because the prompt has to name how many and the
  // client must not be the thing that decides what "how many" means.
  return { count: keys.length, keys };
}
