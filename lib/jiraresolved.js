/**
 * A JIRA ticket that has been **resolved** — the epic closed, or left alone and told.
 *
 * Every other file in this epic is about a ticket that is *there*. This one is the only
 * thing in beadcause that reacts to a ticket that is **not**, and the reason it can is a
 * single read: the poll's JQL is `assignee = "<you>" AND resolution = EMPTY`
 * (lib/jirapoll.js), so a ticket somebody resolved and a ticket somebody reassigned to a
 * colleague are *indistinguishable from the poller* — both simply stop coming back. One
 * `GET /rest/api/3/issue/<KEY>` per vanished ticket is the whole of what tells them apart.
 *
 * ## Why this exists at all: an epic whose acceptance has already come true
 *
 * The epic lib/jiraepic.js files carries the acceptance *"<KEY> is resolved in JIRA — the
 * ticket is the source of truth for that, not this bead"*. So the day the ticket is
 * resolved, that bead's stated done-condition is met and the bead is still open, still
 * `unendorsed`, still in the endorsement queue, still offered to whoever is deciding what
 * to work on — forever. bc-jrvh put four answers to Adam and the one picked is **the
 * cancel split**, which is not a new policy at all: `cancelTicketAndEpic`
 * (lib/jiragate.js) already draws exactly this line for a ticket cancelled by hand.
 *
 * - **The epic is still unendorsed** → **close it**, with a reason naming the resolution.
 *   Nobody has read it, nothing has been worked, and a held bead closed with a reason is
 *   the honest record of something proposed and overtaken.
 * - **The epic has been endorsed** → **leave it completely alone**, and say once that the
 *   ticket resolved. By then it is real work: an advocate may have opened a session on
 *   it, there may be a branch, there may be children. **beadcause does not undo work
 *   because JIRA changed its mind** — the same sentence lib/jiragate.js is built on.
 *
 * ## What is *not* changed: a ticket reassigned away from you
 *
 * bc-uz6e's answer stands and this file is careful to keep it. A vanished ticket whose
 * `resolution` comes back **null** is still open — reassigned, or on a site that hides
 * the field — and nothing happens to its epic: not a close, not a comment, not a revoke.
 * That is why the answer is read off the presence of the resolution object rather than
 * off any name in it (`resolutionOf`, lib/jira.js): the "do nothing" case has to be the
 * one that is impossible to arrive at by accident.
 *
 * ## Written once, and the record is what makes that true
 *
 * A resolved ticket stays resolved, so every tick after the first would otherwise re-ask
 * JIRA and re-comment the same epic, once a minute, forever. lib/jiracancel.js has the
 * shape for this and the argument is the same one: a keyed record in `state.json` that
 * **nothing prunes on a timer**, because the thing it is about is not coming back on its
 * own. Keyed by the *ticket* — `<workspace>/<KEY>` — for lib/jiracancel.js's reason too:
 * the epic may not exist, and the ticket key is the one thing that is always there.
 *
 * The in-memory half is a backoff rather than a memory: a vanished ticket that answers
 * *still open* is re-asked at most every `RECHECK_MS`, not every minute. That is what
 * keeps a colleague's ticket from costing a GET a minute for as long as the epic exists,
 * while still noticing the day they resolve it.
 *
 * ## The three things that also vanish, and must not be mistaken for a resolution
 *
 * 1. **A workspace whose JIRA read failed.** `state !== 'ok'` is skipped outright. A
 *    failed read serves the *last good* answer (lib/sweep.js), and acting on the
 *    difference between two ticks either side of an outage would close epics for every
 *    ticket on a site that was merely unreachable.
 * 2. **A ticket cancelled in beadcause.** Cancelled tickets are filtered out of the sweep
 *    list (lib/jiracancel.js), so they vanish exactly like a resolved one — and their
 *    epic was already closed, by the tap that cancelled them.
 * 3. **A ticket the daemon never saw.** The candidates come from the *filer's* map, which
 *    is seeded from the tracker on the first authoritative read after a restart and holds
 *    every epic carrying a `jira-` ref — so this survives a restart, and does not invent
 *    a "vanishing" out of a poller that has only just started.
 *
 * The one case that seeding does **not** cover, said plainly because it is invisible from
 * here: the filer only makes that read when a workspace has at least one ticket it does
 * not already know (`fileFor`, and `sweep` skips a workspace whose list is empty). So a
 * workspace whose tickets are *all* resolved while the daemon is down comes back up with
 * an empty map and nothing to compare against, and its epics stay open. It is the same
 * shape as the rename's "a summary rewritten while the daemon was down", and the same
 * trade: the alternative is a full `bd list --all` per workspace per tick to answer a
 * question that is nearly always no. bc-0i27.23 holds it.
 *
 * ## And the way back, because a resolution can be reversed
 *
 * A ticket reopened in JIRA comes back through the poll, finds its epic by ref, and files
 * nothing new — the ref survives a close. Without something here that would leave the
 * ticket on screen with a closed bead that nothing would ever raise again, which is
 * precisely the state `beadifyTicket` exists to prevent on the cancel side. So a returning
 * ticket drops its record, and an epic **this sweep closed** is reopened. Only that one:
 * a bead closed by a person, or by a cancel, is not this file's to reopen.
 */
import { loadState, saveState } from './config.js';
import { isHeld } from './endorse.js';
import { RESOLUTION_FIELDS, issue as jiraIssue, resolutionOf } from './jira.js';
import { cancelledKeys, cancelKey } from './jiracancel.js';
import { REF_PREFIX } from './jiraepic.js';

/** The field in `state.json`. One spelling, in one place — as `STATE_KEY` is next door. */
export const STATE_KEY = 'jiraResolved';

/**
 * How long a vanished ticket that answered *still open* is left before it is asked again.
 *
 * Six hours, and the number is a cost rather than a correctness: the answer it is waiting
 * for — a colleague resolving a ticket that used to be yours — is not one anybody is
 * watching a clock for, and the alternative is a network round trip a minute, forever,
 * for every ticket that has ever been reassigned away from this account.
 */
export const RECHECK_MS = 6 * 60 * 60 * 1000;

/**
 * How many vanished tickets one workspace may be asked about on one tick.
 *
 * The first tick after a restart is the one this is for: the filer's map is seeded with
 * *every* epic in the tracker carrying a ref, which on a workspace with a year of them is
 * a lot of keys that are not in today's list. Five a minute drains any backlog within the
 * hour and never turns a restart into a burst against somebody's rate limit.
 */
export const MAX_CHECKS = 5;

/**
 * What the close on a resolved ticket's epic says.
 *
 * A fixed prefix for `CANCELLED_PREFIX`'s reason: a bead closed *without the work having
 * happened here* is a class of thing, and `bd list --status closed` should read as one
 * rather than as six differently-worded closes.
 */
export const RESOLVED_PREFIX = 'Closed with its JIRA ticket';

const clean = (v) => String(v ?? '').trim();

/** `climative` + `TECH-1` → `climative/TECH-1`. The same spelling the cancel record uses. */
export const resolvedKey = (workspace, key) => cancelKey(workspace, key);

/** `jira-TECH-1` → `TECH-1`. The inverse of `refFor`, for reading the filer's map back. */
export const keyOfRef = (ref) => {
  const s = clean(ref);
  return s.startsWith(REF_PREFIX) ? s.slice(REF_PREFIX.length) : '';
};

/**
 * The reason on the close, naming the resolution — the only way back to it in six months.
 *
 * The resolution is named because it is the fact that made this happen and it is the one
 * a person will want: *Done* and *Won't Do* are the same event to this file and very
 * different events to whoever finds the bead. The status rides along when the site gave
 * one, because a site that has renamed `Done` to something local is exactly the site
 * where the resolution name alone will not be recognised.
 */
export const resolvedReason = (key, resolution, status = '') =>
  `${RESOLVED_PREFIX} — ${clean(key)} was resolved in JIRA as *${clean(resolution) || 'resolved'}*` +
  `${clean(status) ? ` (${clean(status)})` : ''}, which is this bead's own acceptance. It was never endorsed, ` +
  'so nothing has been worked on it. Reopen it by hand if the ticket comes back and the work is still wanted.';

/**
 * What the comment on an endorsed epic says — and what it is careful not to imply.
 *
 * This is the half of the split where beadcause has decided to do nothing, so the comment
 * has to say *that* rather than merely report the resolution: a note saying "the ticket is
 * resolved" on a bead somebody has a branch open against reads as an instruction to stop,
 * and the answer on bc-jrvh was the opposite of that.
 */
export const resolvedNote = (key, resolution, url = '') =>
  `JIRA ${clean(key)} has been resolved as *${clean(resolution) || 'resolved'}*.` +
  `${clean(url) ? ` ${clean(url)}` : ''} This bead is **left alone deliberately**: it has already been endorsed, ` +
  'so it is work somebody has taken on — possibly with children, possibly with a branch — and beadcause does not ' +
  'undo work because JIRA changed its mind. Close it yourself if the resolution means the work is not wanted. ' +
  'Said once: nothing here will comment again for this ticket.';

/**
 * One stored record, normalised — or `null` if it is not one.
 *
 * lib/jiracancel.js's shape, field for field, and dropped on read for the same reason: a
 * record with no workspace or no key cannot be matched against anything, so keeping it
 * would be keeping a row that silently never applies.
 */
function normalize(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const workspace = clean(rec.workspace);
  const key = clean(rec.key);
  if (!workspace || !key) return null;
  return {
    workspace,
    key,
    // The epic this was about, when there was one. `null` is a real answer — an epic
    // deleted by hand, a ref pointing at a bead the tracker no longer has.
    bead: clean(rec.bead) || null,
    // What was actually done, and it is what the way back reads: only `closed` is
    // reopened when the ticket returns.
    action: clean(rec.action) || 'none',
    resolution: clean(rec.resolution) || null,
    at: clean(rec.at),
  };
}

/**
 * Every resolved ticket beadcause has already acted on, keyed `<workspace>/<KEY>`.
 *
 * An unreadable or wrong-shaped field reads as **nothing recorded**, and that direction is
 * chosen the same way lib/jiracancel.js chooses the other one. Here the permissive failure
 * is a second look at a ticket JIRA will answer identically — one GET, and a `bd show`
 * that finds the epic already closed and says so — where the strict failure would be an
 * epic that stays open forever with nothing left to notice it.
 */
export function readResolved() {
  const raw = loadState()[STATE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, rec] of Object.entries(raw)) {
    const norm = normalize(rec);
    if (norm) out[key] = norm;
  }
  return out;
}

/** The record for one ticket, or null. */
export const resolvedRecord = (workspace, key) => readResolved()[resolvedKey(workspace, key)] || null;

/** Write one down. Idempotent: a second call for the same ticket overwrites the first. */
export function recordResolved({ workspace, key, bead = null, action = 'none', resolution = null, at = new Date().toISOString() }) {
  const rec = normalize({ workspace, key, bead, action, resolution, at });
  if (!rec) return null;
  const records = readResolved();
  records[resolvedKey(rec.workspace, rec.key)] = rec;
  saveState({ [STATE_KEY]: records });
  return rec;
}

/** Drop one — what a ticket coming back through the poll does. Returns what was dropped. */
export function forgetResolved(workspace, key) {
  const records = readResolved();
  const k = resolvedKey(workspace, key);
  const rec = records[k] || null;
  if (!rec) return null;
  delete records[k];
  saveState({ [STATE_KEY]: records });
  return rec;
}

/**
 * What is owed to this epic, from its row alone — the whole of the decision, no I/O.
 *
 * Pure and exported for `renameFor`'s reason: which of the two halves of the split a bead
 * falls into is the whole of this feature's correctness, and a test of it should not need
 * a tracker. The row is the tracker's answer *now* and never the filer's memory, and that
 * is load-bearing rather than tidy — memory can be a minute stale in exactly the direction
 * that matters here, and an epic endorsed on the other machine still reads `held` in it.
 * Closing on that would be closing work somebody had just approved.
 *
 * - `null` row → `gone`. The ref pointed at a bead the tracker does not have.
 * - closed → `already-closed`. Nothing to do and nothing to say; the record still goes
 *   down, so this is asked once rather than every tick.
 * - `unendorsed` → `close`.
 * - anything else → `comment`.
 */
export function actionFor(row) {
  if (!row?.id) return 'gone';
  if (clean(row.status) === 'closed') return 'already-closed';
  return isHeld(row) ? 'close' : 'comment';
}

/**
 * The sweep: which epics have had their ticket resolved out from under them.
 *
 * `bd` and `fetchImpl` are injected for the reason they are in lib/jirapoll.js and
 * lib/jiraepic.js — every path worth testing here is a failure, and none of them can be
 * produced for real from inside a test.
 */
export function createResolvedSweep({ bd = null, fetchImpl = undefined } = {}) {
  /** `<workspace>::<KEY>` → when JIRA last answered *still open* for it. See `RECHECK_MS`. */
  const askedAt = new Map();

  /**
   * Ask JIRA about one vanished ticket and do what its answer says. Never throws.
   *
   * The order is the one that survives a failure halfway: JIRA is asked first, then the
   * tracker is read, then the write happens, and the record goes down **after** the write
   * rather than before it. A record written first would mean a `bd` that lost a lock race
   * left a ticket permanently marked as dealt with — which is the one failure nothing
   * downstream could ever notice, because the next tick would skip it.
   */
  async function checkOne(workspace, key, epicId, settings, now) {
    const name = workspace?.name || '';
    const answer = await jiraIssue(settings, key, { fields: RESOLUTION_FIELDS, fetchImpl });
    const { resolved, resolution, status } = resolutionOf(answer);
    // Asked, and answered *still open*: reassigned, or a site that will not say. Nothing
    // happens to the epic — bc-uz6e — and the backoff is what stops this being a network
    // round trip a minute for the rest of the ticket's life.
    //
    // Only on this branch, deliberately. A *resolved* answer is either recorded a few
    // lines down and never asked again, or it is a `bd` call that threw — and a close that
    // lost a Dolt lock race must come back on the next tick rather than in six hours.
    if (!resolved) {
      askedAt.set(`${name}::${key}`, now);
      return { workspace: name, key, resolved: false, action: 'none', bead: epicId || null };
    }

    // Authoritative, always, and never the filer's map: see `actionFor`. This is one `bd`
    // spawn behind an event that happens a handful of times a week.
    const row = epicId ? await bd.show(workspace, epicId) : null;
    const action = actionFor(row);
    const url = `${clean(settings?.url).replace(/\/+$/, '')}/browse/${key}`;

    if (action === 'close') await bd.close(workspace, row.id, resolvedReason(key, resolution, status));
    else if (action === 'comment') await bd.comment(workspace, row.id, resolvedNote(key, resolution, settings?.url ? url : ''));

    recordResolved({ workspace: name, key, bead: row?.id || epicId || null, action, resolution });
    return { workspace: name, key, resolved: true, resolution, status, action, bead: row?.id || epicId || null };
  }

  /**
   * One workspace's vanished tickets, against the answer the poller just got. Never throws.
   *
   * The candidates are computed in memory and cost nothing: the filer's map is already
   * built, the ticket keys are already in hand, and a workspace whose every epic still has
   * its ticket makes no call of any kind — no JIRA read, no `bd` spawn, and not even the
   * `settingsFor` that would be needed to make one.
   */
  async function sweepOne(cfg, workspace, result, { filer, settings, records, gone, now }) {
    const name = workspace?.name || '';
    const live = new Set((result.tickets || []).map((t) => clean(t?.key)).filter(Boolean));
    const known = filer?.knownFor?.(name) || new Map();

    // The way back, first, because it is free: a ticket that has come back through the
    // poll drops its record, and an epic *this sweep* closed is reopened. Anything else
    // that closed the bead — a person, a cancel — is not ours to undo.
    const restored = [];
    for (const key of live) {
      const rec = records[resolvedKey(name, key)];
      if (!rec) continue;
      forgetResolved(name, key);
      askedAt.delete(`${name}::${key}`);
      if (rec.action !== 'close' || !rec.bead) {
        restored.push({ workspace: name, key, bead: rec.bead, reopened: false });
        continue;
      }
      let reopened = false;
      try {
        const row = await bd.show(workspace, rec.bead);
        // Only a closed one. An epic somebody has already reopened by hand is left
        // exactly where it is, and its status is theirs rather than this sweep's.
        if (row && clean(row.status) === 'closed') {
          await bd.reopen(workspace, rec.bead);
          await bd
            .comment(
              workspace,
              rec.bead,
              `Reopened: JIRA ${key} is assigned to you and unresolved again, so this epic is back. ` +
                `It was closed when the ticket resolved (${rec.resolution || 'resolved'}).`
            )
            .catch(() => {});
          reopened = true;
        }
      } catch {
        // The record is already off, so the ticket is back either way and the next tick
        // treats this epic as an ordinary one. A bead that could not be reopened is worth
        // a line in the result and not worth failing the sweep over.
      }
      restored.push({ workspace: name, key, bead: rec.bead, reopened });
    }

    // Vanished: an epic this daemon knows the ref of, whose ticket was not in an answer
    // JIRA gave successfully. Cancelled ones are not vanished, they are *hidden*, and
    // their epic was closed by the tap that hid them.
    const candidates = [...known.keys()]
      .map((ref) => ({ ref, key: keyOfRef(ref), id: known.get(ref) }))
      .filter(({ key }) => key && !live.has(key))
      .filter(({ key }) => !gone.has(cancelKey(name, key)))
      .filter(({ key }) => !records[resolvedKey(name, key)])
      .filter(({ key }) => {
        const at = askedAt.get(`${name}::${key}`);
        return !at || now - at >= RECHECK_MS;
      });

    if (!candidates.length) return { workspace: name, checked: [], restored, failed: [], asked: 0, held: 0 };

    // Only now is it worth resolving the site — three `bd config get` spawns on a cold
    // memo, and a workspace with nothing vanished must not pay them on a timer.
    let site = null;
    try {
      site = await settings(workspace);
    } catch (err) {
      const why = String(err?.message || err).split('\n')[0];
      return { workspace: name, checked: [], restored, failed: [{ workspace: name, key: null, error: why }], asked: 0, held: candidates.length };
    }
    // Switched off between the poll and here, or configured wrong. Either way there is no
    // read to make, and a workspace whose JIRA is misconfigured is already reported as
    // trouble by the poller — saying it twice would be two cards for one fault.
    if (!site?.enabled || site.problem) {
      return { workspace: name, checked: [], restored, failed: [], asked: 0, held: candidates.length };
    }

    const due = candidates.slice(0, MAX_CHECKS);
    const checked = [];
    const failed = [];
    for (const { key, id } of due) {
      try {
        checked.push(await checkOne(workspace, key, id, site, now));
      } catch (err) {
        // Not recorded and not backed off: a GET that failed is a question still unasked,
        // and the next tick asks it again. The one thing it must not do is look like an
        // answer of *no*.
        failed.push({ workspace: name, key, error: String(err?.message || err).split('\n')[0] });
      }
    }
    return { workspace: name, checked, restored, failed, asked: due.length, held: candidates.length - due.length };
  }

  return {
    /** Forget the backoff — for a caller that knows the site moved. The records stay. */
    forget(name = null) {
      if (name === null) return askedAt.clear();
      for (const k of [...askedAt.keys()]) if (k.startsWith(`${name}::`)) askedAt.delete(k);
    },

    /** What this sweep believes about one ticket. In memory only — the record is on disk. */
    askedFor(name, key) {
      return askedAt.get(`${name}::${clean(key)}`) ?? null;
    },

    /**
     * Every workspace whose JIRA read succeeded, in turn. Never throws.
     *
     * `results` is `sweep()`'s own output from lib/jirapoll.js and **only `state: 'ok'`**
     * is acted on, which is the single most important line in this file: a failed read
     * serves the last good answer, and a workspace whose site was unreachable for a minute
     * must not have every one of its epics read as a vanished ticket.
     *
     * In turn rather than in parallel, for lib/jiraepic.js's reason: what is at the other
     * end of the writes is embedded Dolt's single write lock, and two workspaces closing
     * beads at once would queue on it having first paid the retries for the privilege.
     */
    async sweep(cfg, workspaces = [], results = [], { filer = null, settings = null, now = Date.now() } = {}) {
      const byName = new Map((workspaces || []).map((w) => [w?.name || '', w]));
      const resolve = settings || ((workspace) => Promise.reject(new Error(`no JIRA settings for ${workspace?.name || ''}`)));
      const usable = (results || []).filter((r) => r?.state === 'ok' && byName.has(r.workspace));
      if (!usable.length) return { results: [], closed: [], commented: [], restored: [], failed: [] };

      // One `state.json` read for the whole sweep rather than one per workspace: the same
      // trade `liveTickets` makes, and for the same reason — this runs on a timer.
      const records = readResolved();
      const gone = cancelledKeys();
      const out = [];
      for (const r of usable) {
        try {
          out.push(await sweepOne(cfg, byName.get(r.workspace), r, { filer, settings: resolve, records, gone, now }));
        } catch (err) {
          // A workspace that threw is a line in `failed` and the next tick's problem. The
          // sweep runs inside the poll cycle and must not be able to stop it.
          out.push({
            workspace: r.workspace,
            checked: [],
            restored: [],
            failed: [{ workspace: r.workspace, key: null, error: String(err?.message || err).split('\n')[0] }],
            asked: 0,
            held: 0,
          });
        }
      }
      const acted = out.flatMap((o) => o.checked).filter((c) => c.resolved);
      return {
        results: out,
        // Split by what was actually done, because the caller does different things with
        // them: a close takes a bead out of the endorsement queue and a comment does not.
        closed: acted.filter((c) => c.action === 'close'),
        commented: acted.filter((c) => c.action === 'comment'),
        restored: out.flatMap((o) => o.restored).filter((r) => r.reopened),
        failed: out.flatMap((o) => o.failed),
      };
    },
  };
}
