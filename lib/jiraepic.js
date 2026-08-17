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
 * ## A ticket that stops arriving — nothing happens *here*, and that is the decision
 *
 * The query is `assignee = "<you>" AND resolution = EMPTY`, so a ticket stops coming back
 * for two quite different reasons — it was reassigned to a colleague, or it was
 * **resolved** — and from this file they are indistinguishable. Either way beadcause is
 * left holding an epic, possibly with children, possibly with a branch, and there is
 * deliberately no code *in this file* that reacts to a ticket's absence: nothing here
 * sweeps for epics whose ticket has gone, and nothing here revokes or closes one.
 *
 * **Reassigned: leave it alone.** bc-uz6e put the three answers to Adam (leave it, gate it
 * by putting `unendorsed` back on, or close it with a reason) and the answer was *leave it
 * alone: let the engineer reassign it.* That still stands, and nothing anywhere acts on it.
 *
 * **Resolved: lib/jiraresolved.js, and it is the cancel split.** bc-jrvh is the question
 * of an epic whose acceptance — *"<KEY> is resolved in JIRA"* — has come true while the
 * bead sits open and held in the endorsement queue for ever. The answer is the line
 * `cancelTicketAndEpic` already draws (lib/jiragate.js): **close it if it is still
 * unendorsed**, with a reason naming the resolution, and **leave it completely alone with
 * a comment if it has been endorsed**, because a half-finished branch is not undone by
 * JIRA changing its mind. Telling the two apart costs one `GET` per vanished ticket and
 * that read lives there, not here — this file's map is what it asks *which epic*, through
 * `knownFor` and `epicFor`.
 *
 * The consequence worth knowing is the good one, and it is unchanged: a ticket handed
 * *back* to you finds its epic by ref and files nothing new, because the ref is in the
 * tracker whether or not the ticket was in the last sweep.
 *
 * ## A summary that is rewritten — the title follows, while it is still ours
 *
 * A ticket being renamed is ordinary: a placeholder is triaged into a real title, a
 * summary is corrected, a component name changes. The poller sees it the minute it
 * happens and the inbox row redraws — so an epic filed once and never touched again ends
 * up disagreeing with the row above it about what the same ticket is called, and the
 * *bead* is the thing everything else hangs off. bc-yc16 is that gap and this is its
 * answer: **the title follows JIRA, but only while it is still the title beadcause
 * wrote.** Three refusals make that precise, and `renameFor` is all of them:
 *
 * 1. **Only a title this filer is the author of** (`ours`). Written when the epic is
 *    created, and inferred at every authoritative read: a bead whose title is *already*
 *    exactly what `epicTitle` would write for the ticket in hand is one beadcause could
 *    have written and nobody has since changed. A title that differs at that moment is
 *    somebody's edit — or a bead adopted by nets 2 and 3, which never had our title in
 *    the first place — and it is never rewritten, this tick or any later one.
 * 2. **Only an epic nobody is working** (`RENAMEABLE`). A closed epic's title is history,
 *    and an in-progress one is named on the window of a session running right now.
 * 3. **Only against the tracker.** A drift is noticed in memory — which is what keeps a
 *    quiet minute free — and then decided against a fresh `bd list --all`, exactly as a
 *    create is, because the title in memory is a minute old and the bead may have been
 *    edited by hand in that minute.
 *
 * **What it deliberately does not do is rewrite the description.** That body is the
 * snapshot of the ticket as it arrived — its status line, its assignee, the prose beside
 * them — and a sweep that rewrote it would eventually eat something a person had added
 * to it. The title is what every list, card and queue in this app draws; the body is
 * where the argument for leaving it alone is written down.
 *
 * The one thing it will not catch: a summary rewritten while the daemon was **down**. The
 * first read after a restart then finds a bead that disagrees with JIRA and no memory of
 * who wrote it, which is indistinguishable from a hand edit — so it refuses, forever, and
 * the epic keeps the name it had. That is the same staleness this section exists to fix,
 * left in place in the one case where following it might overwrite a person. Retitle the
 * bead to match the ticket and the next read adopts it back.
 *
 * ## The status line and the assignee — bc-0i27.22, and the answer is: never
 *
 * bc-yc16 answered the title and left the rest of `epicBody` alone on purpose; bc-0i27.22
 * asked whether the status and the assignee owed the same treatment and the answer is no,
 * for a different reason each. The status is a fact the poller already tells the truth
 * about somewhere better: `jiraRowHtml` and `/api/jira/ticket` (lib/jiraview.js) draw it
 * off the live ticket on every inbox poll, so the epic's frozen line is never the only copy
 * or the current one — a reader chasing today's status was never going to be reading it
 * here. The assignee is narrower still: the poll this epic exists because of is `assignee =
 * "<you>"`, so for as long as the ticket keeps arriving the name the body would show and
 * the name the query is filtering on are one fact, twice. The one way they diverge — the
 * ticket reassigned away — is bc-uz6e's decision already: nothing reacts to a ticket that
 * stops arriving, the epic is left exactly as it was, and a frozen assignee line is that
 * same abandonment, not a new staleness. Widening the "ours" test to a body a person may
 * have appended to would spend the guarantee `renameFor` exists to protect on a line whose
 * live value is already on screen.
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
 * A ticket whose *summary has moved* costs the same read, for the same reason and with the
 * same guard: the JIRA title beadcause has already declined to write is remembered, so an
 * epic that is not ours to rename asks the tracker once and then goes quiet again rather
 * than re-deciding the same refusal every minute for as long as the ticket exists.
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

/**
 * The statuses whose title is still a sweep's to write. `open`, and nothing else.
 *
 * The two exclusions are different arguments. A **closed** epic's title is history: the
 * work is finished, and what it was called while it was being done is part of the record
 * rather than a field to keep current. An **in-progress** one is worse to touch — a
 * session is running under it, its window and its branch were named from it, and a
 * container that renames itself halfway through reads to whoever is watching as a
 * different bead. Anything bd grows later is refused by default, which for a write nobody
 * asked for is the right direction to be wrong in.
 */
export const RENAMEABLE = new Set(['open']);

/**
 * The rename this ticket's epic is owed, or `null` — the whole of the decision, no I/O.
 *
 * `row` is the bead as the tracker has it *now*; `rec` is what this filer last knew about
 * it — the title it read or wrote, and whether that exact string is its own (`ours`).
 * Pure and exported for the same reason `existingFor` is: whether a bead may be rewritten
 * is the whole of this feature's correctness, and a test of it should not need a tracker.
 *
 * `from !== rec.title` is the one that looks redundant and is not. The drift that brings
 * us here was noticed against a map that is up to a minute old, and a minute is long
 * enough for somebody to have retitled the bead by hand — so the title we were told is
 * ours has to still be the title that is there.
 */
export function renameFor(row, ticket, rec = null) {
  const to = epicTitle(ticket);
  const from = String(row?.title || '');
  if (!to || to === from) return null;
  if (!rec?.ours || from !== rec.title) return null;
  if (!RENAMEABLE.has(String(row?.status || 'open'))) return null;
  return { from, to };
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
      `**Filed under ${homed}.** A bead with nothing decided above it is not workable (bc-rfnr.7) and a ticket ` +
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
   * workspace → `ref → { id, held, title, ours, declined }`, the last authoritative read.
   * Trusted to *skip*, never to create.
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
   *
   * `title` and `ours` are the rename's half of it (`renameFor`): the title as this filer
   * last saw it, and whether that exact string is one it wrote. They ride along for the
   * same reason `held` does — the read that would answer them is already being made — and
   * `title` is also what makes a *drift* free to notice: comparing two strings in memory
   * is what tells a quiet tick that a summary has moved without asking bd anything.
   *
   * `declined` is the JIRA title already refused for this epic, and it is a cost guard
   * rather than a fact about the bead: without it, an epic that is not ours would drift
   * from JIRA for ever and buy a full `bd list --all` of its workspace every single tick.
   * It is keyed on the *title* refused rather than on a clock, so the next thing JIRA
   * does asks again — and the one consequence to know is that an epic refused because a
   * session was working it is not re-offered when that session ends, only when the
   * summary moves again. A title nobody has changed since is not news.
   */
  const known = new Map();
  /** `<workspace>::<key>` → when its create last failed. See `RETRY_MS`. */
  const failedAt = new Map();

  const seen = (name) => known.get(name) || new Map();
  const remember = (name, ref, { id, held, title = '', ours = false, declined = '' }) => {
    if (!known.has(name)) known.set(name, new Map());
    known.get(name).set(ref, { id, held: Boolean(held), title: String(title || ''), ours: Boolean(ours), declined });
  };

  /**
   * File, adopt or rename one ticket's epic, against rows already read. Never throws.
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
      // The ticket already has its bead, so the only thing left to ask is whether the
      // summary has been rewritten since — and whether this is a title we may follow it
      // with. `rec` was re-seeded from these very rows a moment ago (`fileFor`), so what
      // `renameFor` is handed is the tracker's answer rather than the map's.
      const rec = seen(name).get(ref) || null;
      const rename = renameFor(found.row, ticket, rec);
      if (!rename) {
        remember(name, ref, {
          id: found.row.id,
          held: isHeld(found.row),
          title: found.row.title,
          ours: Boolean(rec?.ours),
          // Refused once, and remembered as refused: see `declined` above. A ticket whose
          // epic somebody has retitled by hand must not re-read its workspace every tick.
          declined: epicTitle(ticket),
        });
        return null;
      }
      await bd.update(workspace, found.row.id, { title: rename.to });
      // Said out loud, for the reason an adoption is: this is beadcause rewriting a field
      // on a bead a person reads, and a rename nobody was told about is the one that
      // reads as the tracker having quietly disagreed with itself.
      await bd
        .comment(
          workspace,
          found.row.id,
          `Renamed to follow JIRA ${ticket.key}, whose summary has changed — was “${rename.from}”.` +
            `${ticket.url ? ` ${ticket.url}` : ''} beadcause wrote the old title and nothing had edited it ` +
            'since, so this bead was still following the ticket. Retitle it by hand if you want it to stop: ' +
            'a title beadcause did not write is never rewritten.'
        )
        .catch(() => {});
      remember(name, ref, { id: found.row.id, held: isHeld(found.row), title: rename.to, ours: true });
      return { workspace: name, key: ticket.key, id: found.row.id, ref, renamed: rename, title: rename.to };
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
      //
      // And its own title, which is emphatically **not** ours: this is a bead a person
      // raised, so its name is theirs and a summary changing in JIRA never rewrites it.
      remember(name, ref, { id: found.row.id, held: isHeld(found.row), title: found.row.title, ours: false });
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
    // Ours, in the one case where there is nothing to infer: this process wrote that
    // string, one line ago, out of the ticket in hand.
    remember(name, ref, { id, held: !issue.endorsed, title: issue.title, ours: true });
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
    const renamed = [];
    // One row per key before anything else looks at the list. JIRA does not answer with
    // the same issue twice, but the whole of this file is a claim about what happens when
    // something upstream is wrong — and two rows for one key would defeat every net at
    // once, because both would be decided against the same pre-create snapshot.
    const keyed = [...new Map(tickets.filter((t) => t?.key).map((t) => [t.key, t])).values()];
    // The free path, and the reason a quiet minute costs nothing: everything this poller
    // is holding is already in the map, so there is no `bd` call to make.
    const missing = keyed.filter((t) => !seen(name).has(refFor(t.key)));
    // The second reason to go back to the tracker, and it is two string comparisons per
    // ticket rather than a call: the summary has moved since the title we last saw, and
    // it has not already been considered and refused. Whether it may be *followed* is
    // decided against the rows, never against this — see `renameFor`.
    const drifted = keyed.filter((t) => {
      const rec = seen(name).get(refFor(t.key));
      if (!rec?.title) return false;
      const want = epicTitle(t);
      return want !== rec.title && want !== rec.declined;
    });
    const wanted = [...missing, ...drifted];
    const due = wanted.filter((t) => {
      const at = failedAt.get(`${name}::${t.key}`);
      return !at || now - at >= RETRY_MS;
    });
    if (!due.length) return { workspace: name, filed, failed, renamed, read: false, held: wanted.length - due.length };

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
      return { workspace: name, filed, failed: unread, renamed, read: false, held: wanted.length - due.length };
    }

    // Every ref in the tracker, not merely the ones we were about to look for: a
    // workspace whose epics were all filed by yesterday's daemon costs one read on the
    // first tick after a restart and nothing afterwards.
    //
    // `ours` is decided here, once, against the tracker — and the order of the two
    // questions is the whole of bc-yc16's guarantee. A title that has not moved since we
    // last looked keeps whatever answer it already had, which is what lets an epic this
    // daemon renamed a minute ago be renamed again. A title that *has* moved is only ours
    // if it now says exactly what `epicTitle` would say for the ticket in hand: on the
    // first read after a restart that is the honest test of "beadcause wrote this", and
    // for a bead somebody has retitled it is the refusal. `declined` goes with it — a
    // refusal recorded against a title that is no longer there means nothing.
    const byRef = new Map(keyed.map((t) => [refFor(t.key), t]));
    for (const [ref, row] of refIndex(rows)) {
      const prev = seen(name).get(ref);
      const unmoved = Boolean(prev) && prev.title === row.title;
      const ticket = byRef.get(ref);
      remember(name, ref, {
        id: row.id,
        held: isHeld(row),
        title: row.title,
        ours: unmoved ? prev.ours : Boolean(ticket) && row.title === epicTitle(ticket),
        declined: unmoved ? prev.declined : '',
      });
    }

    for (const ticket of due) {
      try {
        const out = await fileOne(cfg, workspace, ticket, rows);
        failedAt.delete(`${name}::${ticket.key}`);
        if (out?.renamed) renamed.push(out);
        else if (out) filed.push(out);
      } catch (err) {
        failedAt.set(`${name}::${ticket.key}`, now);
        failed.push({ workspace: name, key: ticket.key, error: String(err?.message || err).split('\n')[0] });
      }
    }
    return { workspace: name, filed, failed, renamed, read: true, held: wanted.length - due.length };
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
        // Separate from `filed`, and not merely for the log: what a caller does with a
        // filing is not what it does with a rename — nothing new exists to ingest under,
        // and the queue that has to be told is the one already drawing the old title.
        renamed: out.flatMap((o) => o.renamed || []),
      };
    },
  };
}
