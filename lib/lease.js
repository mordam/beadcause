/**
 * Which Mac is working a bead — the one claim two machines can both read.
 *
 * **The failure this exists for.** Under the federated shape (bc-y3qk) each engineer
 * runs their own daemon and their own advocate, and all of them read one Dolt tracker.
 * `candidates()` in lib/advocate.js filters on busy ids, attempt counts and settle
 * times, every one of which is *this process's own* knowledge. Nothing in the shared
 * graph says a machine is already on this. So the same ready bead is picked by two
 * advocates on two Macs, two windows open, and two branches carry the same work — which
 * is bc-thid's incident with the one guard that fixed it removed, because `findDuplicate`
 * compares against rows this daemon can see and `a.workers` is this daemon's worker list.
 *
 * **`bd update --claim` is not the answer, and the reason is the whole design.** It is
 * atomic, it does set `assignee` and `in_progress`, and it is atomic *against the local
 * Dolt* — which is the wrong scope. lib/sync.js pushes and pulls every `sync.seconds`
 * (two minutes by default), so a claim written on Mac A is invisible to Mac B until A has
 * pushed and B has pulled. Claim-then-check inside that window is not a lease at all: it
 * is two local writes that both succeed, and whichever syncs second silently takes a bead
 * the other already has a window open on. There is no serialisation point to move this to
 * — the merge in bin/deliver.js could be handed to GitHub *because GitHub serialises it*,
 * and Dolt offers nothing of the sort.
 *
 * So this is honestly eventually consistent, and it says so:
 *
 * 1. **The claim is a label, and it names the machine and the moment.**
 *    `held:<stamp>:<handle>` — `held:20260812T094200Z:adam@example.com`. A label because
 *    labels are rows: two machines writing two different ones is not a conflict Dolt has
 *    to resolve, it is two rows, and after a sync **both machines can see both claims**.
 *    That is the entire mechanism. A cell — assignee, status — would have been a genuine
 *    write conflict, and the loser's evidence would be gone.
 * 2. **The collision is detected after the fact, and the tiebreak is a string sort.**
 *    Earliest stamp wins, handle breaks a tie, and because the stamp leads the label that
 *    is exactly `labels.sort()[0]`. Both machines compute it from the same strings and
 *    cannot disagree — which is what makes "exactly one session survives, not two and not
 *    zero" true rather than hoped for. Two clocks can make the *fair* answer wrong; they
 *    cannot make the two machines answer differently, and only the second matters.
 * 3. **The loser stands down loudly.** lib/advocate.js's third rule is that every cap is
 *    loud, and this is the cap most able to be silent: a bead withheld with nothing on
 *    screen reads exactly like an advocate that has decided there is nothing to do. So
 *    the stand-down is a log line, a bus event, a pill on the card, and a message into the
 *    losing window.
 * 4. **A lease expires.** A Mac that sleeps mid-bead would otherwise park that work
 *    forever, and a permanently-held bead is strictly worse than the duplicate window
 *    this exists to prevent — a duplicate costs an hour, a park costs the bead. So a
 *    lease is good for `leaseMinutes` and a live advocate restamps it at half that; a
 *    holder that has gone away stops restamping and the bead comes back on its own.
 *
 * **A Mac that does not know who it is stakes nothing.** `cfg.me` is unset by default and
 * `handleFor` returns null with it unset, so no label is written, no bead is held, and a
 * single-person install is byte-for-byte what it was — the same guarantee lib/addressee.js
 * makes, for the same reason and out of the same setting.
 */
import { meHandles, normalizeHandle } from './addressee.js';

/** The label prefix. `held:<stamp>:<handle>`, and a bead may carry more than one. */
export const LEASE_PREFIX = 'held:';

/**
 * How long a claim is good for, and the switch that turns the whole thing off.
 *
 * Sixty minutes, restamped at thirty by any advocate still holding the worker — so the
 * question a stale lease answers is "has a daemon touched this in the last hour", which
 * is the closest a shared graph can get to "is that machine still there". Long enough
 * that a slow `bd` or a daemon restarted mid-session never drops a live claim; short
 * enough that a Mac closed at five o'clock has released its beads by six.
 *
 * Spread into lib/advocate.js's `DEFAULTS` the way `REAP_DEFAULTS` is, so the numbers
 * live beside the argument for them rather than in a list of twenty other constants.
 */
export const LEASE_DEFAULTS = {
  holdLeases: true,
  leaseMinutes: 60,
};

/** `2026-08-12T09:42:00.000Z` → `20260812T094200Z`. Sorts lexically in time order. */
export const stampOf = (at) => {
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toISOString().slice(0, 19).replace(/[-:]/g, '')}Z`;
};

const STAMP_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** …and back. Null for anything that is not one, which is how a typo holds nothing. */
export const timeOf = (stamp) => {
  const m = STAMP_RE.exec(String(stamp || ''));
  if (!m) return null;
  const iso = `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  return Number.isFinite(Date.parse(iso)) ? iso : null;
};

/**
 * This machine's handle, or null when it has not been told who it is.
 *
 * The first of `me` only, exactly as `ownAddresseeLabels` takes the first: `me` is a list
 * because one person answers to two addresses, but a machine is one machine and a lease
 * naming two of them would be two claims on one window.
 */
export const handleFor = (cfg) => meHandles(cfg)[0] || null;

/**
 * The label this machine would stake on a bead now, or null if it cannot stake one.
 *
 * Null for no handle — which is every install that has never heard of federation — and
 * null for a time that is not a time. Both mean "write nothing", never "write something
 * approximate": a lease nobody can parse is a bead held by a machine that does not exist.
 */
export function leaseLabel(handle, at = new Date()) {
  const h = normalizeHandle(handle);
  const stamp = stampOf(at);
  if (!h || !stamp) return null;
  return `${LEASE_PREFIX}${stamp}:${h}`;
}

/**
 * Every claim on a bead, read off its labels, in the order the tiebreak takes them.
 *
 * The sort is on the label string and that is not a shortcut — it is the tiebreak
 * itself. The stamp leads the label and is fixed-width, so a lexical sort is
 * (time, then handle), which is the rule both machines have to agree about. Anything
 * malformed is dropped rather than sorted to the front, because a label that does not
 * parse is not a machine, and the one thing worse than two windows on a bead is a bead
 * nobody may open because of a typo.
 */
export function leasesOf(labels) {
  const out = [];
  for (const raw of Array.isArray(labels) ? labels : []) {
    const label = String(raw ?? '').trim();
    if (!label.toLowerCase().startsWith(LEASE_PREFIX)) continue;
    const rest = label.slice(LEASE_PREFIX.length);
    const cut = rest.indexOf(':');
    if (cut <= 0) continue;
    const at = timeOf(rest.slice(0, cut));
    const handle = normalizeHandle(rest.slice(cut + 1));
    if (!at || !handle) continue;
    out.push({ label, handle, at });
  }
  return out.sort((x, y) => (x.label < y.label ? -1 : x.label > y.label ? 1 : 0));
}

const minsSince = (at, now) => (new Date(now).getTime() - new Date(at).getTime()) / 60000;

/** How long a lease lives, clamped — a nonsense config must not mean "forever". */
export const leaseLife = (minutes) => {
  const n = Math.floor(Number(minutes));
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 60) : LEASE_DEFAULTS.leaseMinutes;
};

/** Is this claim still worth anything? A lease older than its life is not a holder. */
export const isLive = (lease, { now = new Date(), minutes = LEASE_DEFAULTS.leaseMinutes } = {}) =>
  Boolean(lease?.at) && minsSince(lease.at, now) < leaseLife(minutes);

/**
 * Is it time this machine restamped its own claim?
 *
 * Half the life, which is the only number that is right for both halves of what a
 * restamp is for: often enough that no live session ever loses its bead to the clock
 * (two chances to renew before it lapses, so one missed tick costs nothing), and rare
 * enough that it is not a Dolt write every thirty seconds per open window — every write
 * here is a commit, and a commit per tick per worker is what a sync would then have to
 * carry between two Macs all day.
 */
export const renewDue = (lease, { now = new Date(), minutes = LEASE_DEFAULTS.leaseMinutes } = {}) =>
  !lease?.at || minsSince(lease.at, now) >= leaseLife(minutes) / 2;

/**
 * What this machine should conclude from a bead's labels.
 *
 * One function rather than four, because the four answers are one decision and splitting
 * them is how a caller comes to stand down from a bead it has itself won. `handle` is
 * this machine's, or null — and with it null every field below is the "nothing to see"
 * answer, which is the whole of the single-person guarantee.
 *
 *   `holder`  the live claim that wins, or null — the machine that gets to work it
 *   `mine`    this machine's own live claim on it, or null
 *   `lost`    there is a holder, and it is somebody else: stand down
 *   `won`     there is a holder, it is us, and somebody else claimed it too
 *   `stale`   claims past their life, which hold nothing and are ours to tidy
 */
export function leaseVerdict(labels, handle, { now = new Date(), minutes = LEASE_DEFAULTS.leaseMinutes } = {}) {
  const me = normalizeHandle(handle || '');
  const all = leasesOf(labels);
  const live = all.filter((l) => isLive(l, { now, minutes }));
  const stale = all.filter((l) => !isLive(l, { now, minutes }));
  const holder = live[0] || null;
  const mine = me ? live.find((l) => l.handle === me) || null : null;
  return {
    all,
    live,
    stale,
    holder,
    mine,
    // No handle means no opinion: a machine that cannot say who it is cannot be the one
    // somebody else is not. The same branch `addressedElsewhere` refuses to enter.
    lost: Boolean(me && holder && holder.handle !== me),
    won: Boolean(me && holder && holder.handle === me && live.length > 1),
  };
}

/** "adam@example.com's Mac claimed it 4m ago" — the tooltip, the log line, the pill. */
export function describeLease(lease, { now = new Date() } = {}) {
  if (!lease) return 'nobody holds it';
  const mins = Math.max(0, Math.round(minsSince(lease.at, now)));
  const since = mins < 1 ? 'just now' : mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`;
  return `${lease.handle}'s Mac claimed it ${since}`;
}

/**
 * Why a window is being stood down, in one line. Names both machines' positions.
 *
 * `opts.over` is the bead the claim is actually on when it is not this window's own — an
 * ancestor of it, which is bc-etbq: one window responsible for a subtree leases the top of
 * it, and every window another Mac opens inside that subtree loses to the one label. The
 * sentence has to say which bead the claim hangs on, because the reader's next move is to
 * go and look at its labels.
 */
export const standDownWhy = (holder, mine, opts = {}) =>
  opts.over
    ? `${describeLease(holder, opts)} on ${opts.over}, which is above this one — the subtree is theirs, not ours`
    : `${describeLease(holder, opts)} and ${mine ? "this Mac's claim came later" : 'this Mac has no claim on it'} — it is theirs, not ours`;
