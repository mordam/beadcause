/**
 * One P1 epic per ticket, on arrival — linked by `external_ref`, held, and filed once.
 *
 * lib/jirapoll.js is what asks JIRA which tickets are yours and holds the answer. This is
 * what turns each of those into a bead: an **epic**, at **P1**, carrying
 * `external_ref: jira-<KEY>`, arriving `unendorsed`. It is the thing the rest of bc-0i27
 * hangs off — the children ingested under it (bc-0i27.5), the approve/discuss/cancel row
 * (bc-0i27.7) and the ticket view (bc-0i27.6) all address *this bead* rather than the
 * ticket, because a ticket has no id in any tracker and nothing about it can be answered.
 *
 * ## Idempotence is the whole of this file
 *
 * The poller re-answers with the same tickets every minute, forever, and a restart starts
 * from nothing. So "file an epic for each ticket" has to mean "and exactly one, for the
 * life of the ticket", or a quiet week produces ten thousand beads. Three nets, in order,
 * and they catch different things:
 *
 * 1. **`external_ref`.** `bd create --external-ref jira-TECH-1` is an existing field and
 *    an existing flag, and it is the link in both directions: from the bead to the ticket
 *    for anybody reading it, and from the ticket to the bead for the sweep that has to
 *    decide whether to create one. It is looked up *before* every create, against the
 *    tracker rather than against memory — see `refIndex` for why memory alone is not it.
 * 2. **A near-verbatim title** (lib/dupe.js). The second net exists for the reason
 *    lib/dupe.js exists: bc-j6x and bc-ec6 were the same bug filed twice on one day with
 *    byte-identical titles, both approved, both opened, because the instruction not to do
 *    it was a *prompt* and a prompt loses. Here it catches the epic an older build of
 *    this file filed before it wrote refs, and the one a second machine on a shared
 *    tracker filed while this one was off.
 * 3. **A title that opens with the ticket key.** `TECH-1 — …`, `TECH-1: …`, `[TECH-1] …`.
 *    That is what a person writes when they raise the bead by hand, and its summary need
 *    not resemble the ticket's at all, so net 2 cannot see it. Deliberately *opens with*
 *    rather than *mentions*: "Follow-up to TECH-1" is a bead about the ticket and is not
 *    the ticket's epic, and linking it would be worse than filing a second one.
 *
 * A bead caught by net 2 or 3 is **adopted rather than skipped**: the ref is written onto
 * it and a comment says so. Skipping would leave the ticket with no bead anything could
 * find by ref, which is the state nets 2 and 3 exist to get *out* of — and it would be
 * re-decided by fuzzy title matching on every restart, forever. A bead that already
 * carries some *other* `external_ref` is never adopted; it is somebody else's link.
 *
 * ## It arrives held
 *
 * `unendorsed` (lib/endorse.js), which is two layers and only one of them is a queue
 * filter: `openWorkSession` asks the tracker itself, so an epic handed straight to the
 * launcher still cannot be worked. That refusal is the guarantee. It matters more here
 * than for an agent's discovery — a JIRA site can assign you fifty tickets in an
 * afternoon and nobody has read any of them — and it is exactly the gate bc-0i27's step 6
 * asks for. `autoEndorse` (lib/spaces.js) is the existing per-space switch for a space
 * that wants these to skip the gate, and the note on the bead says plainly which of the
 * two happened, because a bead claiming to be waiting for a tap over a session already
 * running on it is the worse of the two errors.
 *
 * ## A ticket that stops arriving — nothing happens, and that is the decision
 *
 * The query is `assignee = "<you>"`, so a ticket reassigned to a colleague simply stops
 * coming back, and beadcause is left holding an epic — possibly with children, possibly
 * with a branch — for work that is no longer yours. bc-uz6e put the three answers to Adam
 * (leave it, gate it by putting `unendorsed` back on, or close it with a reason) and the
 * answer was **leave it alone: let the engineer reassign it.** So there is deliberately no
 * code here that reacts to a ticket's absence: nothing sweeps for epics whose ticket has
 * gone, and nothing revokes or closes one. A half-finished branch is not undone by JIRA
 * changing its mind.
 *
 * The consequence worth knowing is the good one: a ticket handed *back* to you finds its
 * epic by ref and files nothing new, because the ref is in the tracker whether or not the
 * ticket was in the last sweep.
 *
 * ## Who owns it — not the JIRA assignee
 *
 * `bd` takes `owner` from the git identity of the directory the command runs in, not from
 * anything passed to it, and for a work workspace that identity is already the work
 * address. So nothing here tries to force one: the JIRA assignee is recorded *on* the
 * bead — named in the description, and reachable through the ref — and the per-person
 * question is left to bc-y3qk, where it is a question about people rather than about
 * directories.
 *
 * ## What a sweep costs when nothing has arrived
 *
 * Nothing at all. `refIndex` holds each workspace's `ref → id` map, and a tick whose every
 * ticket is already in it makes no `bd` call of any kind. The map is only *trusted to
 * skip*, never to create: the moment a ticket is missing from it the tracker is re-read
 * (`bd list --all`, the authoritative answer, closed epics included) and the decision is
 * made against that. Two sessions filing at once, a bead deleted by hand, a `bd dolt
 * pull` bringing in the other machine's epic — all of those are wrong in memory and right
 * in the tracker, and only one of the two can be asked.
 *
 * A create that fails is not retried on the next tick: `RETRY_MS`. A ticket bd will never
 * accept — a title it refuses, a workspace whose Dolt is wedged — would otherwise buy a
 * full `bd list --all` of the workspace every minute for as long as the ticket exists.
 */
import { findDuplicate, liveCandidates } from './dupe.js';
import { UNENDORSED, isHeld } from './endorse.js';
import { homeIn } from './homing.js';
import { autoEndorseAllowed } from './spaces.js';

/** The `external_ref` namespace. bd's own example spells it this way — `jira-ABC-123`. */
export const REF_PREFIX = 'jira-';

/** Provenance, the way `agent-filed` is provenance: who decided this was work? JIRA did. */
export const TICKET_LABEL = 'jira-ticket';

/** As specified: the epic is P1. It is not agent-filed, so lib/filing.js's clamp is not its rule. */
export const EPIC_PRIORITY = 1;

/** How much of a JIRA summary reaches the title before it is cut. */
export const TITLE_MAX = 120;

/** How long a ticket whose create failed is left alone before it is tried again. */
export const RETRY_MS = 5 * 60 * 1000;

/** `TECH-1` → `jira-TECH-1`. One spelling, because two is the same as no link at all. */
export const refFor = (key) => `${REF_PREFIX}${String(key || '').trim()}`;

/** What a row carries, whatever bd's JSON called it. Absent is `''`, never `undefined`. */
export const refOn = (row) => String(row?.external_ref ?? row?.externalRef ?? '').trim();

/** Whitespace collapsed — a JIRA summary may carry a newline, and a bd title may not. */
const oneLine = (text) => String(text || '').replace(/\s+/g, ' ').trim();

/**
 * `TECH-1 — Fix the login redirect loop`.
 *
 * The key leads, and that is not decoration. It is what makes two tickets' epics
 * un-confusable to lib/dupe.js — two beads sharing every word of their summary score
 * below the threshold once their keys differ — and it is what `opensWithKey` reads, so a
 * bead somebody raised by hand under the same obvious convention is found rather than
 * duplicated. A ticket with no summary at all is still a title: the key.
 */
export function epicTitle(ticket) {
  const key = oneLine(ticket?.key);
  const summary = oneLine(ticket?.summary);
  if (!summary) return key;
  const room = Math.max(20, TITLE_MAX - key.length - 3);
  const cut = summary.length > room ? `${summary.slice(0, room - 1).trimEnd()}…` : summary;
  return key ? `${key} — ${cut}` : cut;
}

/**
 * Does this title *open with* the ticket's key — the third net.
 *
 * Anchored, and it is the anchor that makes the net safe. A title that merely mentions
 * `TECH-1` is very often a bead *about* the ticket rather than the ticket's own epic, and
 * adopting one of those would take the ref away from the bead that should have had it.
 * Leading brackets are allowed because `[TECH-1] …` is the other way everybody writes it.
 */
export function opensWithKey(title, key) {
  const k = oneLine(key);
  if (!k) return false;
  const escaped = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^[\\s\\[(]*${escaped}\\b`, 'i').test(String(title || ''));
}

/** `ref → row` over whatever bd listed. Rows with no ref are not in it. */
export function refIndex(rows) {
  const index = new Map();
  for (const row of rows || []) {
    const ref = refOn(row);
    // First wins: `bd list` answers oldest-first, so two beads that somehow carry one ref
    // resolve to the older one on every machine rather than to whichever came back first.
    if (ref && row?.id && !index.has(ref)) index.set(ref, row);
  }
  return index;
}

/**
 * The bead this ticket already has, or null — all three nets, in order.
 *
 * Pure, and separate from everything that writes, because *what counts as already filed*
 * is the whole of this feature's correctness and a test of it should not need a tracker.
 */
export function existingFor(ticket, rows) {
  const ref = refFor(ticket?.key);
  const byRef = refIndex(rows).get(ref);
  if (byRef) return { row: byRef, how: 'ref' };

  // Only beads, never the advocate's pending proposals: a proposal's row id belongs to a
  // *question*, and adopting one would write a ticket's ref onto something whose answer
  // creates beads. `liveCandidates` splits them for exactly this reason.
  const candidates = liveCandidates(rows, { pending: false });
  // Never a bead somebody else has already linked to something. Two refs is not a thing a
  // bead can carry, and taking one away to make room is not this file's call to make.
  const linked = new Set((rows || []).filter((r) => refOn(r)).map((r) => r?.id));
  const free = candidates.filter((c) => !linked.has(c.id));

  const dupe = findDuplicate(epicTitle(ticket), free);
  if (dupe) return { row: dupe, how: 'title' };

  const opener = free.find((c) => opensWithKey(c.title, ticket?.key));
  return opener ? { row: opener, how: 'key' } : null;
}

/**
 * What the bead says about where it came from — written for somebody with no memory of
 * the ticket arriving, which is everybody by the next morning.
 *
 * The JIRA assignee is named here rather than forced into `owner`: see the header. It is
 * `you` when the site will not say who — Atlassian Cloud anonymises users on GDPR-strict
 * sites — because the query that found this ticket was "assigned to me", so an empty name
 * is a fact about the site rather than about the ticket.
 */
export function epicBody(ticket) {
  const key = oneLine(ticket?.key);
  const who = oneLine(ticket?.assignee) || 'you';
  const lines = [];
  if (oneLine(ticket?.summary)) lines.push(oneLine(ticket.summary), '');
  lines.push(
    `**${key}** in JIRA — ${ticket?.status ? `currently *${oneLine(ticket.status)}*, ` : ''}assigned to ${who}.` +
      (ticket?.url ? ` ${ticket.url}` : '')
  );
  lines.push(
    '',
    'Filed by beadcause the moment the ticket arrived, because JIRA is switched on for ' +
      `\`${oneLine(ticket?.workspace) || 'this workspace'}\` and this ticket is assigned to you. This epic is ` +
      'what everything else about the ticket hangs off — the work ingested under it, the discussion, and ' +
      'the decision to cancel it all address this bead, because a ticket has no id in any tracker.'
  );
  lines.push(
    '',
    `Linked to the ticket by \`external_ref: ${refFor(key)}\`, which is looked up before anything is ` +
      'created. That is what makes a second sweep, a restart or a re-ingestion cost nothing: there is ' +
      'exactly one of these, forever.'
  );
  return lines.join('\n');
}

/**
 * The provenance note — and the one sentence on it that has to be right.
 *
 * lib/filing.js makes this argument at length and it is the same one: a held bead tells
 * its reader that nothing will touch it until they say so, and an auto-endorsed bead has
 * to say the opposite *plainly*, because its reader is no longer somebody deciding
 * whether to allow it — they are somebody finding out it was allowed, possibly after a
 * session has already run on it.
 */
export function epicNotes(ticket, { endorsed = false, homed = '', adopted = null } = {}) {
  const lines = [
    `_Filed by beadcause from JIRA, when ${oneLine(ticket?.key) || 'the ticket'} arrived assigned to you._ ` +
      (endorsed
        ? 'It arrived **endorsed**: auto-endorsement is on for this repo, so nobody read it before it ' +
          'became workable and an advocate may open a session on it. Turn that off on the space details ' +
          "screen — on this repo's own row, or on the space above it — if you want the tap back."
        : `It is \`${UNENDORSED}\`: nothing will open a session on it until you endorse it.`),
  ];
  if (adopted) {
    lines.push(
      '',
      `**Adopted rather than filed.** This bead already existed and ${adopted}, so beadcause linked it ` +
        'to the ticket instead of raising a second epic beside it. If they are not the same work, take ' +
        'the reference off and the next sweep files a fresh one.'
    );
  }
  if (homed) {
    lines.push(
      '',
      `**Filed under ${homed}.** A bead with no P0 above it is not workable (bc-rfnr.7) and a ticket ` +
        'names no home, so the filing seam picked the nearest honest one. Move it if it belongs ' +
        'somewhere better — adopting it elsewhere needs no other change.'
    );
  }
  return lines.join('\n');
}

/**
 * One ticket → the arguments `Bd.create` takes. Pure: no tracker, no clock, no config.
 *
 * Separate from the filing for lib/filing.js's reason — this is the whole of the decision
 * and none of the I/O, so a test asking whether the marker goes on does not need a `bd`.
 */
export function epicIssue(ticket, { endorsed = false, home = null } = {}) {
  return {
    title: epicTitle(ticket),
    type: 'epic',
    priority: EPIC_PRIORITY,
    body: epicBody(ticket),
    acceptance: `${oneLine(ticket?.key) || 'The ticket'} is resolved in JIRA — the ticket is the source of truth for that, not this bead.`,
    notes: epicNotes(ticket, { endorsed, homed: home?.why || '' }),
    externalRef: refFor(ticket?.key),
    parent: String(home?.parent || '').trim(),
    // The marker first, so a reader of `bd show` sees why it is not being worked before
    // anything else. `jira-ticket` is not conditional on anything: it is what an epic
    // filed this way can still be audited by after the hold has come off, exactly as
    // `agent-filed` is in lib/filing.js.
    labels: [...(endorsed ? [] : [UNENDORSED]), TICKET_LABEL],
    endorsed,
  };
}

/** What the comment on an adopted bead says — the how, in the words of the net that caught it. */
const ADOPTION = {
  title: 'its title is all but identical to the ticket summary',
  key: 'its title opens with the ticket key',
};

/**
 * The filer: one epic per ticket, and the memory that makes a quiet tick free.
 *
 * `bd` is injected for the reason it is everywhere else here — the paths worth testing
 * are the ones you cannot produce for real from inside a test.
 */
export function createEpicFiler({ bd = null } = {}) {
  /**
   * workspace → `ref → { id, held }`, the last authoritative read. Trusted to *skip*,
   * never to create.
   *
   * `held` rides along because the row on the phone needs it and there is nowhere
   * cheaper to get it: every authoritative pass is already a `bd list --all`, whose rows
   * carry labels, so the marker costs one `isHeld` per row and no extra call at all. It
   * is what lets a ticket row say *approved* instead of offering approve a second time.
   *
   * It can go stale in exactly one direction, and the direction is the harmless one: a
   * quiet tick makes no `bd` call, so an epic endorsed on the laptop still reads as held
   * here until the next read. The cost of that is a row still offering approve on work
   * that is already workable — and endorsing is the one verdict that is idempotent by
   * construction (lib/verdict.js), so the tap is a 200 saying nothing happened. The
   * opposite error would matter, and it cannot happen: nothing clears `held` but an
   * endorsement this daemon performed or a read that saw the marker gone.
   */
  const known = new Map();
  /** `<workspace>::<key>` → when its create last failed. See `RETRY_MS`. */
  const failedAt = new Map();

  const seen = (name) => known.get(name) || new Map();
  const remember = (name, ref, id, held) => {
    if (!known.has(name)) known.set(name, new Map());
    known.get(name).set(ref, { id, held: Boolean(held) });
  };

  /**
   * File or adopt one ticket, against rows already read. Never throws.
   *
   * The parent is the one field this drops rather than lose the epic over, and the trade
   * is lib/filing.js's: nothing here chose it, lib/homing.js did, and bd refusing a child
   * under a P0 that is a `bug` rather than an epic must not cost the ticket its bead.
   */
  async function fileOne(cfg, workspace, ticket, rows) {
    const name = workspace?.name || '';
    const ref = refFor(ticket.key);
    const found = existingFor(ticket, rows);

    if (found && found.how === 'ref') {
      remember(name, ref, found.row.id, isHeld(found.row));
      return null;
    }

    if (found) {
      // Adopted: the ref is written on, and said out loud on the bead. A link nobody was
      // told about is the one that reads as beadcause having quietly decided something.
      await bd.update(workspace, found.row.id, { externalRef: ref });
      await bd
        .comment(
          workspace,
          found.row.id,
          `Linked to JIRA ${ticket.key} — ${ADOPTION[found.how]}, so this is being treated as that ticket's ` +
            `epic rather than a second one being filed beside it.${ticket.url ? ` ${ticket.url}` : ''} ` +
            'Take the reference off if they are not the same work; the next sweep will file a fresh epic.'
        )
        .catch(() => {});
      // Its own hold, not a fresh one: adoption writes a reference onto a bead somebody
      // else raised and does not put the marker on. A bead already being worked stays
      // being worked, and the row says so rather than offering to approve it.
      remember(name, ref, found.row.id, isHeld(found.row));
      return { workspace: name, key: ticket.key, id: found.row.id, ref, adopted: found.how, title: found.row.title };
    }

    const home = await homeIn(bd, workspace);
    let issue = epicIssue(ticket, { endorsed: autoEndorseAllowed(cfg, name), home });
    let id = null;
    try {
      id = await bd.create(workspace, issue);
    } catch (err) {
      if (!issue.parent) throw err;
      console.log(
        `[jira] ${name}: would not take "${issue.title}" under ${issue.parent} — ` +
          `${String(err?.message || err).split('\n')[0]}. Filing it with no parent instead.`
      );
      // Rebuilt rather than patched: the note carries a "Filed under <x>" sentence that
      // would be a lie on a bead filed under nothing.
      issue = epicIssue(ticket, { endorsed: issue.endorsed, home: null });
      id = await bd.create(workspace, issue);
    }
    if (!id) throw new Error('bd create returned no id');
    remember(name, ref, id, !issue.endorsed);
    return { workspace: name, key: ticket.key, id, ref, adopted: null, title: issue.title, endorsed: issue.endorsed };
  }

  /**
   * One workspace's tickets. Never throws — a workspace whose tracker is mid-write is a
   * line in `failed` and the next tick's problem, not the end of the sweep.
   */
  async function fileFor(cfg, workspace, tickets, now) {
    const name = workspace?.name || '';
    const filed = [];
    const failed = [];
    // One row per key before anything else looks at the list. JIRA does not answer with
    // the same issue twice, but the whole of this file is a claim about what happens when
    // something upstream is wrong — and two rows for one key would defeat every net at
    // once, because both would be decided against the same pre-create snapshot.
    const keyed = [...new Map(tickets.filter((t) => t?.key).map((t) => [t.key, t])).values()];
    // The free path, and the reason a quiet minute costs nothing: everything this poller
    // is holding is already in the map, so there is no `bd` call to make.
    const missing = keyed.filter((t) => !seen(name).has(refFor(t.key)));
    const due = missing.filter((t) => {
      const at = failedAt.get(`${name}::${t.key}`);
      return !at || now - at >= RETRY_MS;
    });
    if (!due.length) return { workspace: name, filed, failed, read: false, held: missing.length - due.length };

    // Authoritative, and closed epics are in it: "exactly one, forever" is a claim about
    // the whole tracker, and a ticket whose epic was finished last month must not get a
    // second one because the first no longer shows up in a list of open work.
    let rows = [];
    try {
      rows = await bd.listAll(workspace);
    } catch (err) {
      // Nothing is filed off a read that failed. The alternative — creating because we
      // could not see — is precisely the duplicate this file exists to prevent.
      const why = String(err?.message || err).split('\n')[0];
      const unread = due.map((t) => ({ workspace: name, key: t.key, error: why }));
      return { workspace: name, filed, failed: unread, read: false, held: missing.length - due.length };
    }

    // Every ref in the tracker, not merely the ones we were about to look for: a
    // workspace whose epics were all filed by yesterday's daemon costs one read on the
    // first tick after a restart and nothing afterwards.
    for (const [ref, row] of refIndex(rows)) remember(name, ref, row.id, isHeld(row));

    for (const ticket of due) {
      try {
        const out = await fileOne(cfg, workspace, ticket, rows);
        failedAt.delete(`${name}::${ticket.key}`);
        if (out) filed.push(out);
      } catch (err) {
        failedAt.set(`${name}::${ticket.key}`, now);
        failed.push({ workspace: name, key: ticket.key, error: String(err?.message || err).split('\n')[0] });
      }
    }
    return { workspace: name, filed, failed, read: true, held: missing.length - due.length };
  }

  return {
    /** Forget one workspace's map, or all of them — for a caller that knows the tracker moved. */
    forget(name = null) {
      if (name === null) {
        known.clear();
        failedAt.clear();
        return;
      }
      known.delete(name);
      for (const k of [...failedAt.keys()]) if (k.startsWith(`${name}::`)) failedAt.delete(k);
    },

    /** What this filer believes one workspace's `ref → id` map to be. For the tests and the log. */
    knownFor(name) {
      return new Map([...seen(name)].map(([ref, rec]) => [ref, rec.id]));
    },

    /**
     * The epic this ticket has, as `{ id, held }` — or `null` if this filer has not seen
     * one. **In memory only, and never a `bd` call.**
     *
     * What the ticket row is drawn from: an id it can address approve, discuss and
     * cancel at, and whether the hold is still on. `null` is honest and common — a
     * daemon that has not swept yet, a workspace whose `bd create` is failing — and the
     * row draws it as a ticket whose bead has not arrived rather than as an error.
     *
     * Deliberately not a lookup that falls back to the tracker. This is read once per
     * ticket on every inbox payload, which is every poll of every phone, and a `bd list
     * --all` behind that would be the most expensive call in the app on a timer. The
     * routes that *act* on the epic look it up properly (lib/jiragate.js); this one only
     * draws it.
     */
    epicFor(name, key) {
      const rec = seen(name).get(refFor(key));
      return rec ? { id: rec.id, held: rec.held } : null;
    },

    /**
     * Say that this ticket's epic is no longer held — after an approve went through.
     *
     * Without it the row would go on offering approve until the next authoritative read,
     * which on a machine whose tickets are all already filed is *never*: the free path
     * exists precisely so a quiet tick makes no `bd` call. So the one thing that knows
     * the marker came off tells the memory that it did.
     */
    endorsedNow(name, key) {
      const rec = seen(name).get(refFor(key));
      if (rec) rec.held = false;
      return Boolean(rec);
    },

    /**
     * Every workspace whose JIRA read succeeded, in turn. Never throws.
     *
     * `results` is `sweep()`'s own output from lib/jirapoll.js, and only `state: 'ok'` is
     * acted on: a failed read is serving the *last good* answer, which is a list this has
     * already been through, so filing off it would buy nothing and a workspace whose JIRA
     * has been down for a day would keep re-deciding the same tickets.
     *
     * In turn rather than in parallel, unlike the poll itself, and the difference is what
     * is at the other end: that is one HTTP GET per site and this is `bd create`, which
     * takes embedded Dolt's single write lock. Two workspaces creating at once would
     * queue on that lock anyway, having first paid four retries each for the privilege.
     */
    async sweep(cfg, workspaces = [], results = [], { now = Date.now() } = {}) {
      const byName = new Map((workspaces || []).map((w) => [w?.name || '', w]));
      const out = [];
      for (const r of results || []) {
        if (r?.state !== 'ok' || !r.tickets?.length) continue;
        const workspace = byName.get(r.workspace);
        if (!workspace) continue;
        out.push(await fileFor(cfg, workspace, r.tickets, now));
      }
      return {
        results: out,
        filed: out.flatMap((o) => o.filed),
        failed: out.flatMap((o) => o.failed),
      };
    },
  };
}
