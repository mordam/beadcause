/**
 * Cancel — the one local record in this app that is never allowed to expire.
 *
 * A JIRA ticket assigned to you arrives every minute, forever (lib/jirapoll.js), and
 * gets one held epic on the way past (lib/jiraepic.js). **Cancel is the answer that
 * says this ticket does not need a bead id at all** — somebody else's work, a duplicate,
 * a ticket that will be closed in JIRA next week and is nobody's problem here. It is
 * the third button on the row beside approve and discuss (lib/jiragate.js).
 *
 * ## Why it is a record here and not a write to JIRA
 *
 * Because *nothing in this path writes to JIRA* — see the README section and
 * `test/jira.mjs`, which asserts it against the module's own source. There is no label
 * to set, no transition to make, no comment to leave. A cancel is therefore something
 * beadcause knows about a ticket rather than something the ticket knows about itself,
 * and that is a deliberate trade rather than a shortcut: the day somebody wants JIRA
 * written to, it is a decision with an explicit allowlist behind it, not a side effect
 * of a button that already existed.
 *
 * ## The one rule that makes it work: it does not expire
 *
 * `state.json` already holds four kinds of keyed record — `dismissed`, `ringing`,
 * `answered`, `quiet` — and every one of them is dropped the moment the thing it is
 * about leaves the inbox. That is right for all four: `quiet` exists only to draw a
 * card that is on screen, and a record about a card nobody can see is dead weight.
 *
 * This one is the opposite, and getting it wrong is not a leak, it is a loop. The
 * poller re-answers with the same ticket every minute for as long as JIRA says it is
 * assigned to you. A cancel that were pruned when the row left the inbox would be
 * un-cancelled by the very next sweep, the epic would be filed again, and the row would
 * be back — **forever, once a minute**. So: nothing here prunes, nothing here takes a
 * clock, and there is deliberately no ttl to tune. lib/owed.js is the closest existing
 * shape and says the same thing about itself — keyed, written atomically, dropped only
 * when it stops meaning anything, never on a timer.
 *
 * The only thing that drops a record is **beadify** (bc-0i27.6), which is the reverse
 * of cancel and the reason cancel can afford to be this absolute: a decision you can
 * take back needs no expiry.
 *
 * ## Keyed by the ticket, never by the bead
 *
 * `<workspace>/<KEY>` — `climative/TECH-1`. Not by bead id, and the reason is that
 * **the bead may never have existed**: a ticket can be cancelled in the minute between
 * arriving and its epic being filed, or on a machine whose `bd create` was refused all
 * morning. Beadify has to be able to find the record with nothing in hand but the
 * ticket, which is the one thing that is always there. The bead id is *carried* on the
 * record when there was one, because that is what beadify reopens — but it is a field,
 * never the key.
 *
 * The workspace leads for the reason `jiraRows` namespaces its rows that way: JIRA is
 * configured per workspace, two workspaces may be pointed at one project, and a cancel
 * in one of them is not a cancel in the other.
 */
import { loadState, saveState } from './config.js';

/** The field in `state.json`. One spelling, in one place. */
export const STATE_KEY = 'jiraCancelled';

const clean = (v) => String(v ?? '').trim();

/** `climative` + `TECH-1` → `climative/TECH-1`. A workspace name never holds a slash. */
export const cancelKey = (workspace, key) => `${clean(workspace)}/${clean(key)}`;

/**
 * One stored record, normalised — or `null` if it is not one.
 *
 * A record with no workspace or no ticket key cannot be matched against anything, so it
 * is dropped on read rather than kept as a row that silently never applies.
 */
function normalize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const workspace = clean(rec.workspace);
  const key = clean(rec.key);
  if (!workspace || !key) return null;
  return {
    workspace,
    key,
    // The epic that was revoked when the cancel was taken, if there was one. Null is a
    // real answer — see the header — and beadify treats it as "file a fresh one".
    bead: clean(rec.bead) || null,
    at: clean(rec.at),
    // Who cancelled it. `null` means the daemon, which is what every record written
    // before this field existed also means.
    by: clean(rec.by) || null,
  };
}

/**
 * Every cancelled ticket, keyed `<workspace>/<KEY>`.
 *
 * An unreadable or wrong-shaped field reads as **nothing cancelled**, which is the
 * permissive direction and the deliberate one: the failure it produces is a ticket
 * coming back, which you can see and cancel again, where the other direction is a
 * ticket that silently never appears and cannot be got back from a screen.
 */
export function readCancelled() {
  const raw = loadState()[STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, rec] of Object.entries(raw)) {
    const norm = normalize(rec);
    if (norm) out[key] = norm;
  }
  return out;
}

/**
 * The keys alone, as a Set — what a sweep filters on.
 *
 * Separate from `readCancelled` because the two callers want different things: the
 * poll filters a few dozen tickets against this on every payload and wants one read
 * and a hash lookup, where a route wants the record itself.
 */
export const cancelledKeys = () => new Set(Object.keys(readCancelled()));

/** Is this exact ticket cancelled? One `state.json` read — use `cancelledKeys` in a loop. */
export const isCancelled = (workspace, key) => cancelKey(workspace, key) in readCancelled();

/** The record for one ticket, or null. Beadify's read: it needs the bead id off it. */
export const cancelledRecord = (workspace, key) => readCancelled()[cancelKey(workspace, key)] || null;

/**
 * Earmark this ticket. Idempotent, and the second call is the one that keeps the truth.
 *
 * A re-cancel overwrites rather than being refused: the second tap may carry a bead id
 * the first did not have — a ticket cancelled before its epic was filed, cancelled again
 * after — and the record that can be reversed is worth more than the record that came
 * first. Nothing about the timing of a cancel is load-bearing; that it is *there* is.
 */
export function cancelTicket({ workspace, key, bead = null, by = null, at = new Date().toISOString() }) {
  const rec = normalize({ workspace, key, bead, by, at });
  if (!rec) return null;
  const records = readCancelled();
  records[cancelKey(rec.workspace, rec.key)] = rec;
  saveState({ [STATE_KEY]: records });
  return rec;
}

/**
 * Take the earmark off — the whole of beadify's half of this file.
 *
 * Returns the record that was dropped, so the caller can reopen the epic it names, or
 * `null` when there was nothing to drop. That distinction is the difference between
 * "put this ticket back" and "this ticket was never away", and beadify says so.
 */
export function uncancelTicket(workspace, key) {
  const records = readCancelled();
  const k = cancelKey(workspace, key);
  const rec = records[k] || null;
  if (!rec) return null;
  delete records[k];
  saveState({ [STATE_KEY]: records });
  return rec;
}

/**
 * Drop every cancelled ticket out of a flat list of tickets — what the inbox draws.
 *
 * One read of `state.json` for the whole list, which is why this exists rather than a
 * predicate the caller maps: the inbox payload is rebuilt on every poll of every phone,
 * and a file read per ticket per client is the shape that turns a free thing costly.
 * The cheap case is cheaper still — no records at all is the array back, untouched.
 */
export function liveTickets(tickets, gone = cancelledKeys()) {
  if (!gone.size) return tickets || [];
  return (tickets || []).filter((t) => !gone.has(cancelKey(t?.workspace, t?.key)));
}

/**
 * The other half of `liveTickets` — the cancelled ones, with their record attached.
 *
 * The inbox does not draw these and must not: a cancelled ticket is not a row, on this
 * sweep or any sweep after a restart, and that is the whole of what the cancel means.
 * What it is *for* is the way back (bc-0i27.6) — beadify lives on a ticket's own view,
 * and a view you cannot reach is a button that does not exist. So they ride the payload
 * in a field of their own, behind a fold, counted by nothing.
 *
 * **Only the ones JIRA still says are yours.** The list is a filter over the poller's
 * answer rather than a walk of the records, so a ticket that was cancelled and has since
 * been reassigned to somebody else disappears from here — which is right: beadify on it
 * would lift an earmark on a ticket no sweep is going to return anyway, and the record
 * stays on disk for the day it comes back. It also means this costs one `state.json`
 * read for the whole list, exactly as `liveTickets` does.
 */
export function cancelledTickets(tickets, gone = readCancelled()) {
  const keys = Object.keys(gone);
  if (!keys.length) return [];
  return (tickets || [])
    .map((t) => ({ ticket: t, record: gone[cancelKey(t?.workspace, t?.key)] || null }))
    .filter((r) => r.record)
    .map((r) => ({ ...r.ticket, cancelled: r.record }));
}

/**
 * The same filter over the poller's per-workspace results — what the epic filer acts on.
 *
 * Two shapes rather than one clever function that takes either, because they are two
 * different decisions arriving at the same answer: *do not draw this row*, and *do not
 * file a bead for this ticket*. Both are load-bearing and only the second is the loop —
 * a cancel that reached the screen but not the filer would earmark a ticket that goes on
 * getting an epic every restart.
 *
 * The workspace comes off the *result* rather than off each ticket: a failed read serves
 * the last good answer, whose rows were stamped by the same poller, and the two agree —
 * but the result's name is the one the sweep is about to hand to `fileFor`.
 */
export function liveResults(results) {
  const gone = cancelledKeys();
  if (!gone.size) return results || [];
  return (results || []).map((r) =>
    Array.isArray(r?.tickets)
      ? { ...r, tickets: r.tickets.filter((t) => !gone.has(cancelKey(r.workspace ?? t?.workspace, t?.key))) }
      : r
  );
}

/**
 * The records the poller cannot match — the leftovers, and the reason this file has a
 * third list rather than two.
 *
 * `cancelledTickets` above is a filter over the poller's answer, deliberately, and that
 * is what makes it blind to its own store: a ticket that was cancelled and has since
 * been resolved, reassigned, or moved into a project this workspace is no longer pointed
 * at drops straight out of the fold, and its record stays on disk for ever with no screen
 * anywhere that can name it, count it, or drop it. Nothing here expires — see the header,
 * and that is still right — so *invisible* and *permanent* were the same property until
 * this existed. This is the other half: **the records with no ticket left**.
 *
 * It is a walk of the store rather than a filter over the tickets, which is the opposite
 * of every other list in this file and the only way to see something the poller never
 * mentions. Still one `state.json` read for the whole list, and still nothing at all on
 * the empty path.
 *
 * **A workspace JIRA could not be asked this minute does not land here**, because
 * lib/jirapoll.js serves that workspace's last good answer rather than an empty one —
 * which is what makes a listing safe to draw at all, and it is the same property
 * `liveResults` above leans on. A workspace switched *off*, or dropped from the config,
 * does land here, and that is exactly the case this list exists for.
 *
 * Most recently cancelled first, for the reason the fold sorts the live ones that way:
 * the record you are looking for is nearly always the one you took most recently.
 *
 * **Records too broken to key are not here, and need no button.** `readCancelled` drops
 * anything with no workspace or no ticket on read, and every write in this file saves the
 * normalised map back — so the first cancel or beadify after one appears prunes it, and a
 * record that cannot be matched against any ticket was never suppressing one anyway.
 */
export function strandedCancels(tickets, gone = readCancelled()) {
  const keys = Object.keys(gone);
  if (!keys.length) return [];
  const seen = new Set((tickets || []).map((t) => cancelKey(t?.workspace, t?.key)));
  return keys
    .filter((k) => !seen.has(k))
    .map((k) => gone[k])
    .sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
}

/**
 * Is this ticket one the poller still says is yours? The guard on dropping a record.
 *
 * The rule bc-0i27.19 asks for is that nothing may un-cancel a *live* ticket, and the
 * button that drops a record is only ever drawn beside one `strandedCancels` returned —
 * but the payload it was drawn from is up to a minute old, and a ticket reassigned back
 * to you inside that minute would be quietly un-cancelled by a tap aimed at a dead
 * record. So the act re-asks at the moment of the write, against the poller's answer as
 * it is then. See `forgetCancel` in lib/jiragate.js, which is the only caller.
 */
export const inSweep = (tickets, workspace, key) =>
  (tickets || []).some((t) => cancelKey(t?.workspace, t?.key) === cancelKey(workspace, key));
