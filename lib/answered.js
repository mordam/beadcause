/**
 * What you already said about a bead, kept for the day it comes back.
 *
 * **The failure this exists for.** Answering a question closes the bead
 * (`bd.respond` — comment, then close), and a closed bead leaves the inbox. But a
 * decision whose chosen option is *go and build it* is a commission, not a full
 * stop: the session that picks the work up reopens the bead, and a reopened bead
 * that is still labelled `human` walks straight back into the inbox as a brand new
 * card. The card is rebuilt from the bead, so it carries the same decision block,
 * the same options and no trace whatsoever of the answer you gave an hour ago. So
 * you answer it again, identically, and the thread ends up with your answer on it
 * twice. That is exactly what happened to beadcause/bc-goo.2 on 2026-08-09: the same
 * four options answered at 13:33 and again at 14:35, an hour apart, because from the
 * phone the second card was indistinguishable from the first.
 *
 * **Why the card is what changes, rather than the arrival.** The other way to fix
 * this is to refuse the second arrival outright — the bead has been answered, so
 * keep it out of the inbox. That trades a duplicated answer for a lost question, and
 * it is the worse trade: a bead genuinely can come back with something new to ask,
 * and there is nothing in the tracker that tells the two cases apart. Beadcause's
 * whole premise is that a question in front of you is better than a question filed
 * quietly somewhere, so the bead still arrives — it just arrives saying what you
 * already told it, which is the fact that was missing.
 *
 * **Why beadcause's own state rather than the tracker.** The answer is on the bead
 * as a comment, and the list rows do not carry comments: finding it in `bd` would be
 * a `bd comments` call per inbox row per 25-second poll, for cards nobody has opened
 * (this is the same cost that keeps the reply poller down to the handful of threads
 * you are actually waiting on). Here the write happens exactly once, at the moment
 * you answer, and every reader after that is a lookup in a file already being read.
 *
 * One key, `answered` in state.json, keyed `workspace/id` like everything else that
 * lives there.
 */

/**
 * How long an answer is worth remembering.
 *
 * The record is only ever *read* when the bead is back in the inbox, so this is not
 * about the answer going stale — it is about the file not growing forever with beads
 * that were answered once and closed for good. A month is long past the point where
 * "you said this already" is the useful fact; a bead that comes back after that is a
 * new conversation and deserves to read as one.
 */
export const ANSWER_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** A hard cap under the TTL, so a bad clock cannot let the file grow without bound. */
export const ANSWER_MAX = 500;

/** Enough of an answer to recognise it by, on a card. */
const trim = (text, max = 400) => {
  const flat = String(text || '').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * Write down that this key has now been answered.
 *
 * Returns a new map — the caller merges it into state, so this stays a pure function
 * the tests can drive without a filesystem.
 *
 * `count` accumulates rather than resetting, because "you have answered this twice
 * already" is the sentence that actually stops the third one. The *text* kept is the
 * latest, since that is the answer standing right now; the older ones are on the
 * bead's own thread, which is where a full history belongs.
 */
export function recordAnswer(answered, key, response, now = new Date()) {
  const prior = (answered || {})[key];
  return {
    ...(answered || {}),
    [key]: {
      at: now.toISOString(),
      response: trim(response),
      count: (Number(prior?.count) || 0) + 1,
    },
  };
}

/**
 * What to tell the card about this key, or null for "nothing to say".
 *
 * Null for an unknown key and for a record that is not shaped like one — a
 * half-written state file must read as "no previous answer", because the failure
 * there is a card that quietly asserts you said something you did not.
 */
export function answeredBefore(answered, key) {
  const rec = (answered || {})[key];
  if (!rec || typeof rec !== 'object') return null;
  const at = typeof rec.at === 'string' ? rec.at : null;
  const response = typeof rec.response === 'string' ? rec.response : '';
  if (!at && !response) return null;
  return { at, response, count: Number(rec.count) || 1 };
}

/**
 * "an hour ago", for a log line and a push title.
 *
 * Coarse on purpose — this is the difference between *you answered this a minute ago*
 * (a card that came straight back, which is the reopen this exists for) and *you
 * answered this last week* (a bead with a genuinely new question on it). Minutes of
 * precision would be noise in both readings. Empty string for a timestamp that will
 * not parse, so the caller can leave the phrase out rather than print "undefined ago".
 */
export function answeredAgo(at, now = new Date()) {
  const then = Date.parse(at || '');
  if (!Number.isFinite(then)) return '';
  const mins = Math.max(0, Math.round((now.getTime() - then) / 60000));
  if (mins < 2) return 'just now';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/**
 * Drop what is too old to be worth saying, newest kept first.
 *
 * Deliberately *not* pruned against the live inbox, unlike `ringing` and `dismissed`.
 * Those describe beads that are on your screen now; this one exists precisely for the
 * beads that are not — an answered bead is closed and out of the sweep, and pruning
 * on absence would throw the record away moments before the reopen that needs it.
 */
export function pruneAnswered(answered, now = new Date()) {
  const cutoff = now.getTime() - ANSWER_TTL_MS;
  const rows = Object.entries(answered || {})
    .filter(([, rec]) => rec && typeof rec === 'object')
    .map(([key, rec]) => [key, rec, Date.parse(rec.at || '')])
    // A record with an unreadable timestamp is kept and sorted last rather than
    // dropped: it is still true that you answered, and the date is the smaller half
    // of what the card says.
    .filter(([, , at]) => !Number.isFinite(at) || at >= cutoff)
    // `at` is millisecond-resolution and a bulk-answer loop can tie two records on
    // it; untied, the slice below can evict a genuinely-newest answer instead of a
    // truly-older one, by accidental object order. key breaks the tie.
    .sort((a, b) => (Number.isFinite(b[2]) ? b[2] : 0) - (Number.isFinite(a[2]) ? a[2] : 0) || String(a[0]).localeCompare(String(b[0])))
    .slice(0, ANSWER_MAX);
  return Object.fromEntries(rows.map(([key, rec]) => [key, rec]));
}
