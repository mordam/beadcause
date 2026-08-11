/**
 * Which kind of quiet a card arrived under — written down at the moment it arrived,
 * so the card can say so afterwards.
 *
 * **The failure this exists for.** `quietReasonFor` in lib/spaces.js decides whether
 * a bead may make a noise, and answers with *which* of the two reasons it may not:
 * `'filtered'` or `'muted'`. That answer reaches the server log and the Android
 * logcat line and stopped there. On screen the two are indistinguishable, and so is
 * the third case — a bead that rang normally and you missed the buzz. You widen the
 * filter, a pile of cards appears, and nothing on any of them says they had been
 * sitting there quietly the whole time rather than arriving in the last minute.
 *
 * **Why it is recorded rather than recomputed.** Asking `quietReasonFor` again at
 * render time answers a different question: *would this bead be quiet now*. For the
 * filtered half that answer is always `null` by the time you are looking, because
 * looking at the card means the filter is wide enough to show it — which is exactly
 * the moment the card most needs to say it was hidden. For the muted half it is
 * worse than useless: quiet hours end on a clock, so the same card would claim it
 * arrived quietly all evening and stop claiming it at 09:00, having changed nothing.
 * The reason is a fact about an arrival, and an arrival happens once.
 *
 * **What is kept, and why each field.** `reason` is the answer itself, and it is the
 * whole point — a card that says "this was quiet" without saying which kind is the
 * half-drawn state the space chip's 🔕 is already in. `at` is what stops the card
 * reading as a new arrival: "arrived quietly, three hours ago" is a different
 * sentence from a card that just landed, and the difference is the one the pile after
 * a widened filter turns on. `space` names what was muted, because *Work is muted*
 * is actionable and *this was muted* is not. `filter` is the filter as it stood
 * (`describeFilter`'s "Work / acme"), kept only for `'filtered'` — the filter has
 * almost certainly changed by the time you read it, which is why it has to be the
 * value from then and not a live read.
 *
 * **Arrivals only, never replies.** A reply is quiet on the same terms as the bead it
 * is on (see `checkReplies`) and nothing here records it. Two reasons: this record
 * says *how this card got here*, and a reply that arrived quietly onto a card you
 * were already shown loudly is not that; and the honest place for it is the row in
 * the thread, which would need a record per comment rather than per bead. So a bead
 * that rang and then went quiet under a narrowed filter keeps saying it rang, which
 * is true.
 *
 * One key, `quiet` in state.json, keyed `workspace/id` like everything else in there.
 */

import { describeFilter } from './spaces.js';

/** The two answers `quietReasonFor` can give. Anything else is not a kind of quiet. */
const REASONS = new Set(['filtered', 'muted']);

/**
 * The entry to store for a bead that has just arrived without making a noise.
 *
 * The sibling of `rangFor` in lib/ringing.js, and deliberately shaped like it: both
 * are written in the same loop, one per outcome, and the two maps are exclusive per
 * key by construction — see the save in `startPoller`.
 */
export function quietArrival(reason, q, filter, now = new Date()) {
  return {
    reason,
    at: now.toISOString(),
    space: q?.space || null,
    // Only for the filtered half. A muted bead matched the filter, so naming what
    // the filter was would be answering a question nobody asked with a value that
    // reads like a cause.
    filter: reason === 'filtered' ? describeFilter(filter) : null,
  };
}

/**
 * What to tell the card about this key, or null for "it made a noise".
 *
 * Null for an unknown key, for a record that is not shaped like one, and — the case
 * worth being strict about — for a `reason` this version does not recognise. The
 * card's whole job here is to name which of the two kinds it was, so a record it
 * cannot name must read as no record at all rather than as an unexplained "this was
 * quiet"; that is the half-drawn state the feature exists to leave behind.
 */
export function arrivedQuiet(quiet, key) {
  const rec = (quiet || {})[key];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  if (!REASONS.has(rec.reason)) return null;
  return {
    reason: rec.reason,
    at: typeof rec.at === 'string' ? rec.at : null,
    space: typeof rec.space === 'string' ? rec.space : null,
    filter: typeof rec.filter === 'string' ? rec.filter : null,
  };
}

/**
 * Keep only the beads still in the inbox.
 *
 * Pruned on absence, like `ringing` and `dismissed` and unlike `answered`: this is
 * only ever read to draw a card that is on screen, so a bead that has left the inbox
 * has nothing left to tell. A bead that comes back is a fresh arrival and gets a
 * fresh answer — including, quite legitimately, a different one.
 */
export function retainQuiet(quiet, liveKeys) {
  const live = liveKeys instanceof Set ? liveKeys : new Set(liveKeys || []);
  return Object.fromEntries(Object.entries(quiet || {}).filter(([key]) => live.has(key)));
}
