/**
 * The three things you can say about a JIRA ticket, from the row it arrives on.
 *
 * A ticket assigned to you becomes a row in the inbox (bc-0i27.3) and one held epic
 * behind it (bc-0i27.4). This is the gate in between: **approve**, **discuss**,
 * **cancel** — and the load-bearing property is the negative one. Until approve is
 * tapped, the epic and everything ingested under it carry `unendorsed`, which means no
 * advocate queues them and `openWorkSession` refuses them outright (lib/endorse.js). A
 * JIRA site can assign you fifty tickets in an afternoon and nobody has read any of them.
 *
 * ## Two of the three are not new, and that is the point
 *
 * **Approve is the endorsement queue's verdict, aimed at a ticket instead of a bead.**
 * `applyVerdict` (lib/verdict.js) is what takes the marker off, it already takes a list,
 * it is already idempotent, and it already reports per bead so a group where one lost a
 * Dolt lock race is not a failed request. Nothing here re-implements any of that. What
 * this file adds is the one thing a ticket needs and a bead does not: **which beads**.
 * Approving a ticket means the epic *and its children*, because approving an epic whose
 * work is still held is a ready queue that picks up a container and nothing to do in it.
 *
 * **Discuss is not here at all.** `POST /api/bead/discuss` already opens a thread on a
 * held bead with an agent that cannot resolve it (lib/discuss.js), and the endorsement
 * queue already draws that thread. The row's Discuss button hands you to it, on this
 * ticket's epic, rather than growing a second conversation surface on an inbox row —
 * which is precisely the "second approval system" bc-0i27.14 exists to refuse. The only
 * thing the row needs for that is the epic's id, and it carries one.
 *
 * **Cancel is the new act**, and its record is lib/jiracancel.js: keyed by the ticket,
 * never expiring, and nothing is written to JIRA. What is *here* is what cancel does to
 * the bead beside the record.
 *
 * ## What cancel does to the epic, and the one case where it does nothing
 *
 * A ticket you have cancelled must not go on sitting in the endorsement queue as a bead
 * you could still approve — that is the same ticket coming back through a different
 * screen. So a cancel closes the epic, with a reason that says why, and leaves the
 * `unendorsed` marker on it exactly as a revoke does (lib/verdict.js): the history of
 * what was proposed and turned down is worth having in three weeks, when the same ticket
 * is reassigned to you and the only useful question is whether anybody looked at it.
 *
 * **Unless it has already been endorsed** — then the epic is left completely alone. By
 * then it is real work: an advocate may have opened a session on it, there may be a
 * branch. This is bc-uz6e's answer applied to the other end of the same problem, and it
 * is the same reasoning: beadcause does not undo work because JIRA changed its mind.
 * The earmark is still written, because "stop proposing this ticket" is a separate claim
 * from "throw the work away", and the answer says which of the two happened.
 *
 * ## Finding the epic: memory first, and the tracker only when memory has none
 *
 * `epicFor` on the filer is an in-memory map read and costs nothing, which is why the
 * *row* is drawn from it. It can be empty for one honest reason — a daemon that has not
 * swept since it started — and a button that answered "no bead yet" in the first minute
 * after a restart would be a button that lies. So an act that cannot find the epic in
 * memory reads the tracker, once, the same authoritative `bd list --all` the filer makes
 * its own decisions against. That is the most expensive call in the app; it is here
 * behind a tap and never behind a timer.
 */
import { isHeld } from './endorse.js';
import { MAX_IDS, applyVerdict } from './verdict.js';
import { refFor, refIndex } from './jiraepic.js';
import { cancelTicket, cancelledRecord, uncancelTicket } from './jiracancel.js';

/**
 * What the close on a cancelled ticket's epic says.
 *
 * A fixed prefix for the reason `REVOKED_PREFIX` is one: this is a bead closed *without
 * the work having happened*, and `bd list --status closed` should read as a class of
 * thing rather than as six differently-worded closes.
 */
export const CANCELLED_PREFIX = 'Cancelled with its JIRA ticket';

/** The reason on the close, naming the ticket — the only way back to it in six months. */
export const cancelReason = (key) =>
  `${CANCELLED_PREFIX} — ${key} was cancelled in beadcause, so it is not work anybody is waiting on. ` +
  'Beadify the ticket to put it back.';

const clean = (v) => String(v ?? '').trim();

/**
 * This ticket's epic, as `{ id, held, row }` — memory first, then the tracker.
 *
 * `row` is the `bd list` row when the tracker was the one that answered and `null` when
 * memory was, because memory holds an id and a flag rather than a bead. Every caller
 * here wants the flag and only the cancel wants the row, so it is carried rather than
 * paid for twice.
 */
export async function findEpic(bd, workspace, key, { filer = null } = {}) {
  const name = workspace?.name || '';
  const remembered = filer?.epicFor?.(name, key) || null;
  if (remembered?.id) return { id: remembered.id, held: remembered.held, row: null };

  // Memory has nothing. Either this daemon has not swept yet, or the epic was filed by
  // another machine on a shared tracker — and both are answered by the same read the
  // filer makes its own decisions against.
  const rows = await bd.listAll(workspace);
  const row = refIndex(rows).get(refFor(key)) || null;
  if (!row?.id) return null;
  return { id: row.id, held: isHeld(row), row };
}

/**
 * Approve: the epic and its children become ordinary work, in one act.
 *
 * The children are asked for rather than assumed, and closed ones are dropped: an epic
 * that was approved last week and had a child revoked should not have that child
 * endorsed back into the queue by a second tap on the same button.
 *
 * `MAX_IDS` is lib/verdict.js's ceiling on one call and it is kept rather than worked
 * around — an epic with a hundred children is not a tap, it is a screen — and what is
 * over it is *counted and reported*, because a truncation nobody is told about is what
 * makes an approve that left work held read as one that worked.
 */
export async function approveTicket(bd, workspace, key, { filer = null } = {}) {
  const epic = await findEpic(bd, workspace, key, { filer });
  if (!epic) {
    throw Object.assign(new Error(`${key} has no bead yet — nothing to approve until its epic is filed`), {
      status: 409,
    });
  }

  // `--all` on the way in, so a closed child is visible and can be left out on purpose.
  const kids = await bd.children(workspace, epic.id).catch(() => []);
  const open = kids.filter((c) => clean(c.status) !== 'closed').map((c) => c.id);
  const wanted = [epic.id, ...open];
  const ids = wanted.slice(0, MAX_IDS);

  const out = await applyVerdict(bd, workspace, { verdict: 'endorse', ids });
  // Only once the epic itself actually moved: the row stops offering approve on the
  // strength of this, and a group where the epic was the one that failed must not.
  if (out.ok.some((r) => r.id === epic.id)) filer?.endorsedNow?.(workspace?.name || '', key);
  return { ...out, key: clean(key), epic: epic.id, children: open.length, truncated: wanted.length - ids.length };
}

/**
 * Cancel: the earmark that never expires, and the epic closed beside it.
 *
 * The earmark is written **first and unconditionally**. Everything else here is a `bd`
 * call that can fail — a lock race, a workspace mid-write — and the one outcome this
 * must never have is a cancel that reported a failure and stopped the ticket coming
 * back on some sweeps and not others. Getting the record down is the decision; closing
 * the epic is tidying up after it, and it says which of the two happened.
 */
export async function cancelTicketAndEpic(bd, workspace, key, { filer = null, actor = null } = {}) {
  const name = workspace?.name || '';
  let epic = null;
  try {
    epic = await findEpic(bd, workspace, key, { filer });
  } catch {
    // A tracker that would not answer costs the record its bead id, and nothing else.
    // Beadify handles a record with no bead: it files a fresh epic, which is what a
    // ticket with no findable bead needs anyway.
    epic = null;
  }

  const record = cancelTicket({ workspace: name, key, bead: epic?.id || null, by: actor });

  if (!epic) return { record, epic: null, bead: 'none' };
  if (!epic.held) return { record, epic: epic.id, bead: 'endorsed' };

  const row = epic.row;
  if (row && clean(row.status) === 'closed') return { record, epic: epic.id, bead: 'already-closed' };

  try {
    // `bd close`, not a revoke: the marker stays on for lib/verdict.js's reason — a
    // closed held bead is the honest history of something proposed and turned down.
    await bd.close(workspace, epic.id, cancelReason(clean(key)), { actor });
    return { record, epic: epic.id, bead: 'closed' };
  } catch (err) {
    // The earmark is already down, so the ticket is cancelled whatever bd thought of the
    // close. Reported rather than thrown for exactly that reason.
    return { record, epic: epic.id, bead: 'failed', error: String(err?.message || err).split('\n')[0] };
  }
}

/**
 * Beadify: the reverse of cancel, and the reason cancel can be this absolute.
 *
 * Three things, in order, and the middle one is what makes "one epic, not two" true.
 *
 * 1. **The earmark comes off**, so the next sweep sees the ticket again and the row
 *    comes back.
 * 2. **The epic that was closed is reopened**, rather than a fresh one being filed. It
 *    still carries `external_ref: jira-<KEY>` — a ref survives a close, which is what
 *    `test/jiraepicreal.mjs` asks the real `bd` — so the filer's first net finds it and
 *    files nothing. Reopening is therefore not an optimisation: without it the ticket
 *    would come back with its bead closed and no sweep would ever raise another.
 * 3. **The filer's memory of this workspace is dropped**, so the next tick makes an
 *    authoritative read rather than skipping the ticket off a map written before any of
 *    this happened.
 *
 * A ticket that was never cancelled is `restored: false` and no writes at all, which is
 * the truth and not an error — the same shape as a second tap on endorse.
 */
export async function beadifyTicket(bd, workspace, key, { filer = null } = {}) {
  const name = workspace?.name || '';
  const record = cancelledRecord(name, key);
  if (!record) return { restored: false, key: clean(key), bead: null, reopened: false };

  uncancelTicket(name, key);
  filer?.forget?.(name);

  let reopened = false;
  let error = null;
  if (record.bead) {
    try {
      const issue = await bd.show(workspace, record.bead);
      // Only a closed one. An epic somebody reopened by hand, or one that was never
      // closed because it had already been endorsed, is left exactly where it is.
      if (issue && clean(issue.status) === 'closed') {
        await bd.reopen(workspace, record.bead);
        reopened = true;
      }
    } catch (err) {
      // The earmark is already off, so the ticket is back either way. A bead that could
      // not be reopened is said out loud rather than silently leaving the ticket with a
      // closed epic nothing will ever replace.
      error = String(err?.message || err).split('\n')[0];
    }
  }
  return { restored: true, key: clean(key), bead: record.bead, reopened, ...(error ? { error } : {}) };
}
