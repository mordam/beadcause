/**
 * One card per sweep — what conflicted, what got fixed, and what needs Adam.
 *
 * lib/prsweep.js decides which open pull requests a merge put out of date and hands the
 * ones that are ours to lib/resolvers.js. What it cannot do is *say what happened*, and
 * the reason is not shyness: at the moment it returns, nothing has happened yet. It has
 * opened two windows and put a third in a queue, and the answer Adam wants — *is my
 * board clean again, and if not, which one needs me?* — arrives twenty minutes later, in
 * a window nobody is watching, one pull request at a time.
 *
 * So this is the other end of the sweep. One `human` card per sweep, naming every pull
 * request that conflicted and what became of it, amended in place as the resolvers
 * finish, and closed by itself when the answer turns out to be *nothing*.
 *
 * ## Filed at the start and amended, not held until the end
 *
 * The bead (bc-9d37.5) left this open and it is the whole shape of the file. Three
 * reasons for amending, and the third is the one that settled it:
 *
 * 1. **A held card is invisible exactly while it is interesting.** A sweep whose last
 *    resolver runs for twenty minutes says nothing for twenty minutes, and "two windows
 *    are open on this right now" is a state that only exists during them.
 * 2. **Held state is lost state.** Everything a held card would be built from lives in
 *    lib/resolvers.js's registry. Since bc-9d37.11 its *keys* outlive a restart, but the
 *    handles do not and cannot — a window handle is worth exactly as long as the iTerm
 *    holding it — so a restart still costs the daemon the ability to say anything about
 *    what those windows are doing, which is the whole of what a held card would show. And
 *    on this Mac a restart is not rare: a merge landing is what triggers one, and a merge
 *    landing is also what triggers the sweep. A card filed at the moment of the sweep is
 *    in the tracker from the first second.
 * 3. **Closing it again costs nothing.** When the last pull request comes back mergeable
 *    and none was handed back, the card closes itself with a reason saying so. That is
 *    what the epic actually asks for — "leaves those pull requests mergeable, or leaves a
 *    summary card saying which ones need Adam to pick a winner, with no tap in between" —
 *    and holding could not have both that and the card that names one still running.
 *
 * ## One card per conflicting *branch*, not per merge
 *
 * "One `human` card per sweep" was true for a year and it is the sentence bc-xl7n.36
 * corrected. A sweep runs per merge into the base, so a pull request that conflicts and is
 * then resolved gets exactly one card — the shape this file was designed for — while one
 * that conflicts and **stays** conflicting gets one per merge, forever, each naming the
 * same branch and saying the same sentence about it. Thirteen for #243 in seven hours,
 * once, which was two thirds of that day's unsorted backlog.
 *
 * So before filing, a sweep looks for an open card that already names one of its pull
 * requests and folds into that one instead: the rows are updated in place, the merge is
 * added to the card's list of them, and the title and the body stop naming a merge as the
 * cause and start counting the merges the branch has survived. `foldTarget` and `foldInto`
 * below; the reason the test is an overlap rather than a subset is on the first of them,
 * and it is the part with a wrong answer that looks right.
 *
 * Notice this is not the `bd.create` dedupe seam and could not have been. That one is
 * `duplicateOf`, which declines outright on anything labelled `human`, and it compares
 * titles — which here differ by exactly the merge number that is the problem.
 *
 * ## How a state is *learned*, which is the part with no obvious answer
 *
 * A resolver is an agent in an iTerm window. It does not report back, it cannot be made
 * to, and the one message its brief asks for lands in a window that closes when it stops.
 * So the four states here are each read off something that outlives the session:
 *
 * - **working** — lib/resolvers.js still holds a record for this pull request. That is
 *   the daemon's own registry, so it is free and it is exact.
 * - **queued** — it is in that file's queue, waiting for one of the two slots.
 * - **resolved** — the registry has let go and GitHub now says `MERGEABLE` (or the pull
 *   request merged, or was closed). The resolver pushed; the conflict is gone.
 * - **handed back** — the registry has let go and GitHub still says `CONFLICTING`. The
 *   session ended without making the branch mergeable, which is the honest ending its
 *   brief offers it: a conflict where both sides are load-bearing and only Adam can say
 *   which wins.
 *
 * Notice what is *not* used: the resolver's own claim about what it did. It is not asked
 * for one, and could not be believed over GitHub if it were. What the resolver's own
 * words are used for is the one thing GitHub cannot supply — **why** — and only on the
 * hand-back path. Its brief tells it to leave that reason on the pull request, prefixed
 * with `RESOLVER_SAYS`, precisely because the window is not a place a reason survives;
 * `resolverSaid` reads it back. A hand-back with no sentence is still reported, as the
 * fact without the reason, because a pull request that quietly stopped conflicting is
 * exactly the thing this card exists to stop being invisible.
 *
 * ## And what it will not do
 *
 * It merges nothing, opens no window, and touches no branch — it is a summary of work
 * lib/prsweep.js already did. The only writes it makes are to one bead of its own: file
 * it, amend it, close it. The pull requests it is about are never written to at all.
 *
 * That holds after bc-9d37.8, which made the card *answerable* — an option per branch
 * that is waiting, so Adam's sentence reaches a session on it instead of reaching nothing.
 * The option and the reading of the answer are here (`sweepCardBody`, `sweepAnswer`); the
 * act is `resolveSweepFor` in lib/server.js, beside the three other answers that write
 * something. That split is not tidiness: `resolveFor`'s registry, its cap of two and its
 * queue are module state in the daemon's own memory, so the only process that may open a
 * resolver is the daemon — and this file is imported by things that are not it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.js';
import { CARD_LABEL } from './card.js';
import { CONFIG_DIR } from './config.js';
import { homeIn } from './homing.js';
import * as pr from './pr.js';
import { allUnits, repoUnits, unitFor } from './repos.js';
import { find as findResolver, pending as pendingResolvers } from './resolvers.js';
import { RESOLVER_SAYS, resolveSessionDir } from './session.js';

/** The label that puts a bead in the inbox and takes it out of every advocate queue. */
const HUMAN_LABEL = 'human';

/**
 * What the card bead is worth.
 *
 * P2, the same as lib/notinmain.js's and for its reason: this is filed by the daemon
 * rather than chosen by Adam, and what a sweep turned up may not outrank the work he
 * picked. He can raise it in a tap, and the notification arrives either way.
 */
const CARD_PRIORITY = 2;

/** Where the follow-up records live. Not the card — the card is in the tracker. */
export const SWEEP_CARDS_PATH = path.join(CONFIG_DIR, 'sweep-cards.json');

/**
 * How long a record is followed before its unfinished rows are given up on.
 *
 * Four hours, which is lib/resolvers.js's queue TTL and lib/mergesweep.js's staleness
 * window, and it means here what it means there: past it nothing in the record is
 * describing the present. A pull request still `working` after four hours is a window
 * that was closed without the daemon noticing, or a GitHub that never answered — either
 * way the card should stop claiming a session is on it.
 *
 * It bounds the rows that are still *moving* and nothing else. A row waiting on Adam is
 * chased past it — see `WAITING_RECHECK_MS`, and bc-9d37.17 for what that cost: the card
 * this bug was found on had been open for thirty-eight hours over a pull request that
 * merged on the first of them, which is eight TTLs' worth of never asking.
 */
export const FOLLOW_TTL_MS = 4 * 60 * 60 * 1000;

/**
 * How often a row that is waiting on Adam is re-asked of GitHub — bc-9d37.17.
 *
 * **A row in `NEEDS_ADAM` is not a row nothing can change.** It is a row nothing *here*
 * can change: the pull request it names can still be merged or closed on github.com, or
 * rebased into fitting, by a hand that never touched this card. When that happens the
 * card is asking him to pick a winner among branches that have already landed, and no
 * answer he could type would be useful — the branch it is about is gone. Two such cards
 * accumulated inside a day, and neither could ever close, because `chaseRow` used to
 * return a non-live row unchanged and so never asked.
 *
 * A quarter of an hour rather than the cycle, and the arithmetic is the whole reason it
 * is a clock at all: the poll cycle is thirty seconds, a card can carry seven waiting
 * rows, and it is bounded by the card rather than by time — so chasing them every cycle
 * is 840 `gh pr view`s an hour for one card that is doing nothing. At this cadence it is
 * 28, and the worst a stale card can be is fifteen minutes stale, which is well inside
 * how long it takes him to pick it up off a phone.
 *
 * Not a config key, for `RECOVER_EVERY_MS`'s reason: there is no version of "how often
 * should the daemon re-read a question it already asked" that he wants a knob for, and
 * every knob is a row in the README's config table forever.
 */
export const WAITING_RECHECK_MS = 15 * 60 * 1000;

/**
 * How often the inbox is swept for cards that have lost their record — see
 * `recoverSweepCards`. Half an hour, and deliberately not the poll cycle.
 *
 * This is a backstop for something going wrong rather than part of the ordinary path, it
 * costs one `bd human list` per workspace that has a repo, and a card it finds has by
 * definition been sitting there unchased already. Not a config key: there is no version of
 * "how often should the daemon check for its own bookkeeping failures" that Adam wants a
 * knob for, and every knob is a row in the README's config table forever.
 */
export const RECOVER_EVERY_MS = 30 * 60 * 1000;

/**
 * The state a row carries in a record rebuilt from its own card — see `recoverSweepCards`.
 *
 * It says one thing: *nothing here knows what this row is any more, ask GitHub*. That is
 * why it has to be in `LIVE`, and it still has to be now that `chaseRow` asks about a
 * `NEEDS_ADAM` row too (bc-9d37.17). What it asks about one of those is narrow — has this
 * pull request ended — and a branch that still conflicts comes back *unchanged*. So a row
 * recovered straight into `handed-back` would keep the state and the missing sentence it
 * was read off a stale card with, for as long as the branch went on conflicting. Only a
 * `LIVE` row gets the full derivation, and a rebuilt row is one nothing knows anything
 * about.
 *
 * It is never rendered. `followSweepCards` holds the amendment back while any row is still
 * in it, so what Adam sees is the card as it was until the cycle that can say what is
 * actually true — and if GitHub will not answer at all, the ordinary TTL turns it into
 * `unknown`, which is the honest version of the same sentence.
 *
 * The one rough edge, and it is deliberately left rough: a row in this state is not in
 * `NEEDS_ADAM`, so an *Answer #n* tapped in the one cycle between a card being recovered
 * and being chased is refused with "it is not one of the ones waiting on you any more",
 * which is not quite true — it is one nothing has re-checked yet. Treating it as waiting
 * would be worse: it would open a resolver window on a branch that may already be
 * mergeable, and a wasted window costs more than a refusal you can retry in two minutes.
 */
const RECOVERING = 'recovering';

/** The states a row can still move out of. Everything else is where it stopped. */
const LIVE = new Set(['working', 'queued', RECOVERING]);

/** How a state is written on the card. The tick is the whole scan for most readers. */
const STATE_LABEL = {
  working: '⏳ a session is working on it',
  queued: '⏳ waiting for a resolver window',
  [RECOVERING]: '⏳ being re-checked — the follow-up record was rebuilt from this card',
  resolved: '✅ mergeable again',
  merged: '✅ merged while it was being worked',
  closed: '— closed while it was being worked',
  'handed-back': '⚠️ **handed back** — the session stopped and it still conflicts',
  failed: '⚠️ **no window opened**',
  unknown: '⚠️ nothing here can say — the window is gone and GitHub would not answer',
};

/** Terminal, and needing Adam. The card stays open for exactly these. */
const NEEDS_ADAM = new Set(['handed-back', 'failed', 'unknown']);

const oneLine = (v) => String(v ?? '').split('\n')[0].trim();

/**
 * Every merge this card has been folded through, oldest first. Never empty on a real one.
 *
 * A card filed before bc-xl7n.36 has an `after` and no `merges` at all, and it is read here
 * as the one merge it was filed for — the record on disk outlives a restart and a card
 * mid-flight must not lose its title to a field that did not exist when it was written.
 */
const mergesOf = (rec) =>
  Array.isArray(rec?.merges) && rec.merges.length
    ? rec.merges.map(Number).filter(Number.isInteger)
    : Number.isInteger(rec?.after)
      ? [rec.after]
      : [];

/** Everything being followed, keyed by card id. An unreadable file reads as nothing. */
export function readSweepCards() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(SWEEP_CARDS_PATH, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [id, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    if (!rec.card || !rec.workspace || !Array.isArray(rec.prs)) continue;
    out[id] = rec;
  }
  return out;
}

function writeSweepCards(records) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(SWEEP_CARDS_PATH, records);
}

/**
 * Remember a card, or forget one. Never throws.
 *
 * The card is already in the tracker by the time this is called, so a config directory
 * that will not take the file costs the *follow-up* and not the card: what Adam sees is
 * a card that keeps saying two sessions are working, which is worse than the truth and
 * much better than nothing. lib/mergesweep.js makes the same trade for the same reason.
 */
function keep(id, rec) {
  try {
    const records = readSweepCards();
    if (rec) records[id] = rec;
    else delete records[id];
    writeSweepCards(records);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ the rows */

/** One pull request as the record and the card both name it. */
const rowOf = (entry, state, extra = {}) => ({
  number: Number(entry.number),
  branch: String(entry.branch || ''),
  title: String(entry.title || ''),
  url: String(entry.url || ''),
  /** What lib/prsweep.js decided the branch carries. Empty is legal and common enough. */
  beads: (entry.beads || []).map(String).filter(Boolean),
  state,
  /** What lib/resolvers.js said at the time — its place in the queue, or why it failed. */
  note: oneLine(extra.note || ''),
  /** The resolver's own sentence, once there is one. Only ever set on a hand-back. */
  said: oneLine(extra.said || ''),
});

/**
 * The rows of a sweep, in the order the card reads best: what needs somebody first.
 *
 * `handed`, `queued`, `reused`, `unreachable` and `failed` are exactly the five outcomes
 * lib/prsweep.js can reach for a conflicting pull request, so between them they name every
 * branch the sweep acted on and nothing it left alone. `reused` — a session that already
 * had this one, told rather than opened — is `working` here rather than a state of its own:
 * from a card's point of view a session that was already on it and a session just opened
 * for it are the same fact.
 *
 * **`unreachable` is `working` for the same reason, and it is the one that had to be
 * argued.** It means something already has the branch and this daemon has no handle to
 * type into — usually because it restarted, which on this Mac happens every time a merge
 * lands (bc-9d37.11). The temptation is to call that `failed`, since nothing was opened
 * and nobody was told. But the card answers *what is happening to my branch*, and what is
 * happening is a resolver working on it. `failed` is in `NEEDS_ADAM`; this must not be, or
 * every merge would hand Adam back a branch that is fine. The note carries the caveat.
 */
export function rowsOf(result) {
  const rows = [
    ...(result.handed || []).map((r) => rowOf(r, 'working')),
    ...(result.reused || []).map((r) => rowOf(r, 'working', { note: r.note })),
    ...(result.unreachable || []).map((r) => rowOf(r, 'working', { note: r.why })),
    ...(result.queued || []).map((r) => rowOf(r, 'queued', { note: r.note })),
    ...(result.failed || []).map((r) => rowOf(r, 'failed', { note: r.why })),
  ];
  return rows.sort((a, b) => a.number - b.number);
}

/* ------------------------------------------------------------------ the card */

/** `#12 \`branch\` — title (bc-abcd)`, as a link when GitHub gave one. */
function name(row) {
  const label = `#${row.number}`;
  const link = row.url ? `[${label}](${row.url})` : `**${label}**`;
  const beads = (row.beads || []).length ? ` (${row.beads.join(', ')})` : '';
  const rest = [row.branch ? `\`${row.branch}\`` : '', row.title || ''].filter(Boolean).join(' — ');
  return `${rest ? `${link} ${rest}` : link}${beads}`;
}

/**
 * The title of the card, which is all a phone shows in a list.
 *
 * Not a function of the states — a card that says *3 conflicting pull requests* still says
 * it when two of them have resolved themselves, because the title names what the sweep
 * found and the body names what became of it, and a title that churned every cycle would
 * be a different-looking card each time you glanced at the inbox.
 *
 * It *is* a function of how many merges have been folded into it (bc-xl7n.36). Once a
 * second one has, "#231 left this behind it" is no longer the fact worth leading with —
 * the branch outlasting thirteen merges is — so the title stops naming the merge as the
 * cause and starts naming it as the point the count is measured from.
 */
export const sweepCardTitle = (rec) => {
  const n = (rec.prs || []).length;
  const what = `${n} conflicting pull request${n === 1 ? '' : 's'}`;
  const where = rec.repo || rec.key || rec.workspace;
  const merges = mergesOf(rec);
  if (merges.length > 1)
    return `${what} in ${where} ${n === 1 ? 'has' : 'have'} survived ${merges.length} merges since #${merges[0]}`;
  return `${rec.after ? `#${rec.after}` : 'A merge'} left ${what} behind it in ${where}`;
};

/**
 * How many rows are in each of the three buckets a sentence wants to talk about.
 *
 * `settled` and not `done`: these three are spread onto the outcome `followSweepCards`
 * returns, which has a `done` of its own meaning "this card is finished with" — and a
 * count landing on top of a boolean is a field that is `0` exactly when it is true.
 */
export function tally(rec) {
  const rows = rec.prs || [];
  return {
    live: rows.filter((r) => LIVE.has(r.state)).length,
    needing: rows.filter((r) => NEEDS_ADAM.has(r.state)).length,
    settled: rows.filter((r) => !LIVE.has(r.state) && !NEEDS_ADAM.has(r.state)).length,
  };
}

/** The one-line question, which is all a phone shows before it is opened. */
function question(rec) {
  const { live, needing, settled } = tally(rec);
  const where = rec.repo || rec.key || rec.workspace;
  const merges = mergesOf(rec);
  const n = rec.prs.length;
  const these = `${n} pull request${n === 1 ? '' : 's'}`;
  const parts = [
    needing ? `${needing} need${needing === 1 ? 's' : ''} you` : '',
    settled ? `${settled} resolved ${settled === 1 ? 'itself' : 'themselves'}` : '',
    live ? `${live} still being worked` : '',
  ].filter(Boolean);
  const lead =
    merges.length > 1
      ? `${these} in ${where} ${n === 1 ? 'has' : 'have'} conflicted through ${merges.length} merges since #${merges[0]}`
      : `${rec.after ? `#${rec.after}` : 'A merge'} conflicted ${these} in ${where}`;
  return `${lead} — ${parts.join(', ')}.`;
}

/**
 * The marker an answer carries when it is an instruction for one pull request.
 *
 * `RESOLVE #14: take main's renderRow` — the option below writes the prefix into the box
 * and Adam types the sentence after it. Exactly the shape lib/delivery.js uses for
 * `MERGE:` and `CHANGES:`, and for its reason: the phone sends an option id beside the
 * text, but an ntfy action button and a Slack button can only send text, so the words
 * themselves have to be able to say which act this is. See `sweepAnswer`.
 */
export const RESOLVE_MARKER = 'RESOLVE';
const RESOLVE_RE = /^RESOLVE\s*#(\d+)\s*:?[ \t]*/i;

/** The id of the option for one row, and the only place its shape is written down. */
const resolveOptionId = (number) => `resolve-${Number(number)}`;

/**
 * Anything of GitHub's that gets interpolated into the YAML block, made safe for it.
 *
 * A branch name may legally contain a double quote and a title may contain anything at
 * all, and one of those inside a double-quoted scalar is a block that will not parse —
 * which on a phone is a card with no buttons on it. Quotes become the single kind and
 * newlines become spaces, which is what `question` already does to its own sentence.
 */
const yamlSafe = (v) => String(v ?? '').replace(/"/g, "'").replace(/\s+/g, ' ').trim();

/**
 * The card: markdown, then a `decision` block, filed as the bead's description.
 *
 * **One option per branch that is waiting, and then Noted.** Every choice this card could
 * offer about a pull request — pick a side, merge it, close it — is still one that would
 * be a button filing a wish, and none of them is here. What *is* here (bc-9d37.8) is the
 * one act a phone can honestly perform: send the decision back to a session on that
 * branch. A resolver stops and hands back for exactly one reason — both sides are
 * load-bearing and only Adam can say which wins — so the card that reports it is the
 * natural place to say it, and until this the answer he typed was read by nothing.
 *
 * **Those options do not close the card**, and that is semantics rather than convenience.
 * The card amends itself as rows finish and closes itself when they all come back
 * mergeable; an option that puts a row back to `working` is starting that loop again, and
 * a closed card cannot report the end of it. `closes: false` is the commission path
 * `/api/respond` already has.
 *
 * "Noted" stays, last, and still closes: reading the card and doing nothing about it is a
 * real answer, and it is the only one when nothing is waiting.
 *
 * Nothing interpolated into the YAML is prose an agent wrote — the rule this file has
 * always kept. The question is built from counts and a repo name, the options from
 * numbers and a branch name run through `yamlSafe`, and the resolver's own sentence — the
 * one piece of text this card carries that beadcause did not write — stays in the
 * markdown above, where a stray quote is a stray quote rather than a card with no buttons
 * on it.
 */
export function sweepCardBody(rec) {
  const rows = rec.prs || [];
  const { live, needing } = tally(rec);
  const where = rec.repo || rec.key || rec.workspace;
  const merge = rec.after ? `#${rec.after}` : 'A pull request';
  const handed = rows.filter((r) => NEEDS_ADAM.has(r.state));

  const lines = rows.map((r) => {
    const said = r.said ? ` — *“${r.said}”*` : '';
    // The note is lib/resolvers.js's sentence from the moment the sweep ran — a place in
    // the queue, or why a window would not open — and it is only true of the state it was
    // written for. A row that has since moved carries it no further: "mergeable again —
    // #212 is 1st in line" is two facts from different minutes read as one fact.
    const note = !said && r.note && (r.state === 'queued' || r.state === 'failed') ? ` — ${r.note}` : '';
    return `- ${name(r)}\n  ${STATE_LABEL[r.state] || r.state}${said}${note}`;
  });

  const closing = live
    ? `**${live} of these ${live === 1 ? 'is' : 'are'} still moving.** This card is amended as each one ` +
      `finishes, and it closes itself if they all come back mergeable — so an open card means either ` +
      `something is still running or something is waiting on you.`
    : needing
      ? `**Nothing else is going to happen on ${needing === 1 ? 'it' : 'them'} on its own.** No further window ` +
        `will open for ${needing === 1 ? 'it' : 'them'} until the next merge into \`${rec.base || 'main'}\` sweeps ` +
        `${needing === 1 ? 'it' : 'them'} again, so the branch stays as it is until you say which side wins.`
      : `Everything the sweep touched came back mergeable.`;

  const merges = mergesOf(rec);
  const branches = `${rows.length} branch${rows.length === 1 ? '' : 'es'}`;
  const heading =
    merges.length > 1
      ? `## ${merges.length} merges have landed in \`${rec.base || 'main'}\` since #${merges[0]}, and ${branches} still ${
          rows.length === 1 ? 'does' : 'do'
        } not fit`
      : `## ${merge} merged into \`${rec.base || 'main'}\`, and ${branches} behind it stopped fitting`;

  return `${heading}

Every open pull request in \`${where}\` is measured against a base it has never seen the
moment something lands in it. beadcause opened a resolver on each of the ones that conflict
and that are ours — merge the base in, resolve it, run the repo's own gate, push — and
**nothing in this sweep merges anything into \`${rec.base || 'main'}\`**. That is still a tap
you make.

${lines.join('\n')}${foldedNote(rec)}

${
  handed.length
    ? `### What is waiting on you\n\n${handed
        .map(
          (r) =>
            `**#${r.number}** — ${
              r.state === 'failed'
                ? `no resolver window ever opened for it${r.note ? ` (${r.note})` : ''}`
                : r.state === 'unknown'
                  ? 'nothing here can say what became of it'
                  : `the session stopped without making \`${r.branch || 'the branch'}\` mergeable`
            }.${
              r.said
                ? ` It said: *“${r.said}”*.`
                : r.state === 'handed-back'
                  ? ' It left no reason on the pull request, so the branch is the only evidence.'
                  : ''
            } The branch is untouched and nothing has been merged, closed or pushed.`
        )
        .join('\n\n')}\n\n${handBackHelp(handed)}\n\n`
    : ''
}${closing}

\`\`\`decision
question: "${question(rec).replace(/"/g, "'")}"
options:
${handed
  .map(
    (r) =>
      `  - id: ${resolveOptionId(r.number)}
    label: "Answer #${r.number}"
    response: "${RESOLVE_MARKER} #${r.number}: "
    hint: "opens a session on ${yamlSafe(r.branch || 'the branch')} carrying what you write — this card stays open"
    closes: false`
  )
  .join('\n')}${handed.length ? '\n' : ''}  - id: noted
    label: Noted
    response: "Noted — read the sweep of ${yamlSafe(where)}."
    hint: closes this card
\`\`\`
`;
}

/**
 * The paragraph a card grows once a second merge has been folded into it — bc-xl7n.36.
 *
 * Without it the card is quietly lying about its own age: it names one merge in the
 * heading and reports states that were learned five merges later, and a reader with no way
 * to tell would take *the session stopped without making it mergeable* for something that
 * happened once rather than something that has now happened six times.
 *
 * It also says out loud what stopped happening, because the absence is the feature. A
 * branch that keeps conflicting used to file an identical card per merge — thirteen for
 * one pull request in seven hours, which was 65% of the unsorted backlog for that day —
 * and the fix is invisible from the inbox unless the one surviving card admits it ate the
 * other twelve.
 */
function foldedNote(rec) {
  const merges = mergesOf(rec);
  if (merges.length < 2) return '';
  const n = (rec.prs || []).length;
  const these = n === 1 ? 'this branch' : 'these branches';
  const stands = n === 1 ? 'this branch stands' : 'these branches stand';
  return [
    '',
    '',
    `**One card per conflicting branch, not one per merge.** Every merge into \`${rec.base || 'main'}\` measures`,
    `${these} again, and one that keeps conflicting would otherwise file an identical card each time. So a sweep`,
    'that lands on a pull request an open card already names is folded into that card instead of filing beside',
    `it. The ${merges.length} merges folded in here, oldest first: ${merges.map((m) => `#${m}`).join(', ')}.`,
    `What you are reading is where ${stands} now, not ${merges.length} copies of the first report.`,
  ].join('\n');
}

/**
 * How to actually answer, said on the card, because a button whose meaning you have to
 * guess is one you do not press.
 *
 * Two sentences, and which one depends on the only thing that changes what a typed answer
 * can mean: whether there is one branch waiting or several. With one, a bare sentence is
 * unambiguous and the tap is optional. With several it is not — "take main's version" over
 * three pull requests is an instruction to nobody in particular — so the tap is what names
 * the branch, and the marker it writes is what carries that name to the daemon.
 */
function handBackHelp(handed) {
  if (handed.length === 1) {
    return (
      `**Say which side wins and it goes back to a session.** Type it and send it — ` +
      `with one branch waiting, a plain sentence is enough. A window opens on \`${
        handed[0].branch || 'the branch'
      }\` carrying exactly what you wrote, as the decision rather than as a suggestion, and this card ` +
      `stays open to report how it goes. *Noted* closes it instead and opens nothing.`
    );
  }
  return (
    `**Say which side wins and it goes back to a session.** Tap the one you are answering about — ` +
    `that writes \`${RESOLVE_MARKER} #n:\` into the box — then type the decision after it and send it. ` +
    `A window opens on that branch carrying exactly what you wrote, and this card stays open to report ` +
    `how it goes. With ${handed.length} waiting, the tap is what says which one you mean; *Noted* ` +
    `closes the card instead and opens nothing.`
  );
}

/**
 * What an answer to a sweep card is asking for — one pull request and one sentence, or null.
 *
 * Three ways in, and they narrow rather than compete:
 *
 * 1. **The option id**, which is what the phone sends beside the text and the only one of
 *    the three that cannot be ambiguous. The marker is stripped off the sentence if the
 *    words still carry it, which they do unless Adam deleted the prefix the tap wrote.
 * 2. **The marker in the text**, for the surfaces that can only send text — an ntfy action
 *    button, a Slack button, an answer typed with the prefix by hand.
 * 3. **A bare sentence, and only when exactly one row is waiting.** Then there is nothing
 *    to disambiguate and requiring the tap would be ceremony. With two or more this
 *    returns null and the answer is an ordinary one, because guessing which pull request
 *    a sentence is about is the one thing this must never do.
 *
 * A tapped option always answers *something*, even when what it answers is "you wrote no
 * instruction" — `wanted` carries the number and an empty `note`, and the caller says so
 * rather than opening a window on a decision nobody made.
 */
export function sweepAnswer(rec, response, optionId = '') {
  const waiting = (rec?.prs || []).filter((r) => NEEDS_ADAM.has(r.state));
  const text = String(response || '').trim();

  const tapped = String(optionId || '').trim().match(/^resolve-(\d+)$/);
  if (tapped) return { number: Number(tapped[1]), note: text.replace(RESOLVE_RE, '').trim(), waiting };

  const marked = text.match(RESOLVE_RE);
  if (marked) return { number: Number(marked[1]), note: text.slice(marked[0].length).trim(), waiting };

  // Only ever from the box. An option that is not a resolve one — Noted, today — is an
  // answer about the card and not about a branch, and must not be read as a bare sentence.
  if (optionId) return null;
  if (waiting.length !== 1 || !text) return null;
  return { number: waiting[0].number, note: text, waiting };
}

/**
 * Put a row back in motion in the record, once a window has actually been opened for it.
 *
 * Without this the answer would be invisible to the follow-up. `chaseRow` does ask GitHub
 * about a `handed-back` row (bc-9d37.17), but only whether it has ended: a branch that
 * still conflicts comes back handed-back, and a branch a resolver is halfway through is a
 * branch that still conflicts. So the card would keep saying a session stopped on it while
 * a session was working on it. Returns the amended record, or null when there is nothing
 * here by that id — a card
 * answered after its record was dropped, which the caller reports rather than pretends.
 */
export function markResolving(id, number, state, note = '') {
  const records = readSweepCards();
  const rec = records[id];
  if (!rec) return null;
  const prs = (rec.prs || []).map((r) =>
    Number(r.number) === Number(number) ? { ...r, state, note: oneLine(note), said: '' } : r
  );
  const next = { ...rec, prs };
  // `keep` never throws and its failure costs the follow-up rather than the act: the
  // window is open either way, and a card frozen at "handed back" is stale rather than
  // wrong. Same trade the rest of this file makes about that file.
  keep(id, next);
  return next;
}

/**
 * The close reason when the sweep finished and none of it needed anybody.
 *
 * "No longer conflicts" rather than "is mergeable again", because a row can settle by
 * being merged or closed while its resolver was working, and a reason claiming a closed
 * pull request is mergeable would be a small lie in the one sentence anybody reads back
 * off a closed card.
 */
export const settledReason = (rec) => {
  const merges = mergesOf(rec);
  const cause =
    merges.length > 1
      ? `across the ${merges.length} merges since #${merges[0]}`
      : merges.length
        ? `after #${merges[0]}`
        : 'when the merge landed';
  return `Every pull request that conflicted in ${
    rec.repo || rec.key || rec.workspace
  } ${cause} is mergeable again or gone — ${(rec.prs || [])
    .map((r) => `#${r.number}`)
    .join(', ')}. Nothing needed you.`;
};

/* ----------------------------------------------------------------- the fold */

/**
 * The open card this sweep belongs on, if there is one — bc-xl7n.36.
 *
 * A card is filed per *sweep*, and a sweep runs per merge, which is the right shape for
 * the case it was designed around: a merge conflicts a branch, a resolver fixes it, the
 * card closes itself. It is the wrong shape for a branch that conflicts and **stays**
 * conflicting, because every subsequent merge conflicts it again and files another card
 * saying the same sentence about the same branch. Measured once: thirteen cards for
 * pull request #243 in seven hours, eleven of them naming it and nothing else, which was
 * 65% of that day's unsorted backlog.
 *
 * **The test is an overlap and not a subset**, which is the one part of this with a wrong
 * answer that looks right. "Fold when the open card's rows are a subset of this sweep's"
 * is the obvious rule and it re-splits on the first sweep that finds *fewer*: card {243},
 * sweep {243, 300} folds and the card becomes {243, 300}; the next sweep is {243} again,
 * which is not a superset, so it files a second card about #243 and the whole thing is
 * back. Overlap has no such state — a pull request is on the card that already names it,
 * for as long as that card is open, whatever else joins or leaves.
 *
 * Narrowed to the same workspace, the same repo unit and the same base, because those are
 * the three things that make two rows about the same pull request the same pull request.
 * Ties break on the greatest overlap and then on the newest record: with two open cards
 * naming a branch — possible only across a restart that lost the follow-up file — the one
 * describing the most of this sweep is the one worth amending.
 */
export function foldTarget(records, rec) {
  const numbers = new Set((rec.prs || []).map((r) => Number(r.number)));
  let best = null;
  for (const [id, open] of Object.entries(records || {})) {
    if (!open || open.workspace !== rec.workspace || open.key !== rec.key) continue;
    if (String(open.base || 'main') !== String(rec.base || 'main')) continue;
    const overlap = (open.prs || []).filter((r) => numbers.has(Number(r.number))).length;
    if (!overlap) continue;
    const at = Date.parse(open.at || '') || 0;
    if (!best || overlap > best.overlap || (overlap === best.overlap && at > best.at)) best = { id, overlap, at };
  }
  return best?.id || '';
}

/**
 * This sweep's rows folded onto an open card's, and the merge added to its list.
 *
 * The fresh row wins wherever the two name the same pull request — the sweep has just
 * acted on it, so `working` or `queued` or `failed` is the newer truth and the older
 * `handed-back` is a state a window has since been opened out of. Two fields survive that
 * anyway, and both because they are facts about the *branch* rather than about a moment:
 * the beads it carries, which lib/prsweep.js does not always find twice, and the
 * resolver's own sentence, but only onto a state that still needs Adam. Carrying `said`
 * onto a row that is `working` again would put a reason for stopping beside a session
 * that is running — which is exactly what `markResolving` clears it for.
 *
 * `at` moves to now, and it has to: it is both the follow-up's four-hour window and the
 * floor `resolverSaid` reads comments from, and a card being actively re-swept that kept
 * its original `at` would expire mid-flight and start saying *nothing here can say*.
 */
export function foldInto(open, rec, { now = Date.now() } = {}) {
  const fresh = new Map((rec.prs || []).map((r) => [Number(r.number), r]));
  const rows = (open.prs || []).map((was) => {
    const next = fresh.get(Number(was.number));
    if (!next) return was;
    return {
      ...next,
      beads: (next.beads || []).length ? next.beads : was.beads || [],
      said: !next.said && was.said && NEEDS_ADAM.has(next.state) ? was.said : next.said,
    };
  });
  const seen = new Set(rows.map((r) => Number(r.number)));
  const added = (rec.prs || []).filter((r) => !seen.has(Number(r.number)));
  const merges = mergesOf(open);
  for (const m of mergesOf(rec)) if (!merges.includes(m)) merges.push(m);
  return {
    ...open,
    dir: rec.dir || open.dir,
    repo: open.repo || rec.repo,
    at: new Date(now).toISOString(),
    merges,
    prs: [...rows, ...added].sort((a, b) => a.number - b.number),
  };
}

/**
 * Is the card we are about to fold into still in the inbox? Asked, and doubted.
 *
 * The opposite call to `stillOpen` further down, deliberately. That one holds a record
 * over a `bd` that would not answer, because dropping it would kill the buttons on a card
 * still on Adam's phone. Here a wrong answer *loses this sweep's report entirely* —
 * amending a closed bead writes into something nothing will show him — so anything short
 * of a definite "open" files a new card instead. The cost of being wrong that way is one
 * duplicate card, which is the thing this whole path is about and still much cheaper than
 * a silent one.
 */
async function foldable(bd, ws, id) {
  try {
    const issue = await bd.show(ws, id);
    return !!issue && String(issue.status || 'open').toLowerCase() !== 'closed';
  } catch {
    return false;
  }
}

/* ---------------------------------------------------------------- the filing */

/**
 * File the card for one sweep, if it did anything worth a card.
 *
 * **A sweep that found nothing files nothing**, which is most of them: a merge into a repo
 * whose other branches still fit conflicts nobody, and a card saying so every time would
 * be the inbox reporting the weather. The test is `rowsOf` — the four outcomes a
 * conflicting pull request can reach — and not `conflicting`, so a sweep that found
 * conflicts and could not act on any of them still files (those are `failed` rows, and a
 * window that would not open is exactly the thing nothing else would ever mention).
 *
 * Everything the sweep *left alone* — a teammate's branch, a draft, a pull request GitHub
 * would not answer about — is deliberately not on the card. Those are not outcomes of the
 * sweep; they are the board's ordinary contents, the red chip is the right surface for
 * them, and a card that listed them would bury the two rows that matter under the twelve
 * that do not.
 *
 * **And a sweep whose branches are already on an open card amends that card instead** —
 * bc-xl7n.36, and see `foldTarget` for why this is not the dedupe seam in `bd.create`.
 * That one is `duplicateOf`, which returns null the moment `labels` contains `human`: an
 * inbox card is addressed to somebody, and two of them are two things to answer rather
 * than one thing filed twice, so refusing to file a question because a question like it
 * exists would be the wrong call everywhere else. The duplication here is not two cards
 * that resemble each other, it is *the same branch reported again*, and the row set is
 * what says so — nothing a title comparison could have seen, since the titles differ by
 * the merge number that is the whole problem.
 *
 * Never throws. A tracker that refuses the create costs the card and not the sweep, whose
 * windows are already open.
 */
export async function fileSweepCard(bd, ws, result, { unit = null, dir = '', now = Date.now(), fold = true } = {}) {
  const prs = rowsOf(result || {});
  if (!prs.length) return null;

  const rec = {
    card: '',
    workspace: ws?.name || '',
    key: unit?.key || result?.key || ws?.name || '',
    dir: String(dir || ''),
    repo: result?.repo || unit?.repo?.name || '',
    after: Number.isInteger(result?.after) ? result.after : null,
    base: String(result?.base || 'main'),
    at: new Date(now).toISOString(),
    merges: Number.isInteger(result?.after) ? [result.after] : [],
    prs,
  };

  if (fold) {
    const records = readSweepCards();
    const into = foldTarget(records, rec);
    if (into && (await foldable(bd, ws, into))) {
      const next = foldInto(records[into], rec, { now });
      try {
        await bd.update(ws, into, { title: sweepCardTitle(next), description: sweepCardBody(next) });
      } catch (err) {
        // The sweep's own report is lost for this merge, and that is survivable in a way
        // the same failure on a *first* card is not: the card being amended is still open
        // and still names every branch this sweep found, so the inbox is stale rather than
        // silent, and the next merge into the base folds again and catches it up.
        return { error: `could not amend the open sweep card ${into} — ${oneLine(err.message || err)}` };
      }
      // The record before anything else can read it. Its failure is the same trade as
      // below — the card says what the sweep did either way; what is lost is the chasing.
      const kept = keep(into, next);
      return { card: into, record: next, followed: kept, folded: true };
    }
  }

  // Under the P0 the first conflicting bead descends from, or the unsorted backlog — see
  // lib/homing.js. A parentless `human` card is not merely held by the dispatch gate, it
  // is not drawn on the phone at all, which would make this whole file a report into a
  // void.
  const { parent } = await homeIn(bd, ws, { from: prs.flatMap((r) => r.beads)[0] || '' });
  let card;
  try {
    card = await bd.create(ws, {
      title: sweepCardTitle(rec),
      body: sweepCardBody(rec),
      priority: CARD_PRIORITY,
      type: 'task',
      // CARD_LABEL (lib/card.js, bc-7qo.9): closing this bead is always a report and a
      // tap, never code, which is what tells `landedWork` (lib/promote.js) apart from
      // work an epic actually shipped.
      labels: [HUMAN_LABEL, CARD_LABEL],
      parent,
    });
  } catch (err) {
    return { error: `could not file the sweep card — ${oneLine(err.message || err)}` };
  }
  if (!card) return { error: 'the tracker took the sweep card and gave back no id' };

  rec.card = card;
  // The record second, and its failure is survivable: the card exists and says what the
  // sweep did. What is lost is the amending, and what Adam sees then is a card frozen at
  // "two sessions are working on it", which is stale rather than wrong.
  const kept = keep(card, rec);
  return { card, record: rec, followed: kept };
}

/* -------------------------------------------------------------- the follow-up */

/**
 * The resolver's own sentence about why it stopped, off the pull request.
 *
 * The window is not a place a reason survives — it closes when the session stops and
 * nobody is watching it — so `conflictPromptFor` tells a resolver that stops without the
 * branch mergeable to say so on the pull request, in one line beginning `RESOLVER_SAYS`.
 * This reads the newest of those written since the sweep began.
 *
 * `since` is what stops a comment from *last* week's conflict being quoted as this
 * week's reason, which would be a confident falsehood with a timestamp to make it
 * convincing. Anything unparseable is dropped rather than kept: a comment that cannot be
 * dated cannot be shown to be this sweep's.
 */
export async function resolverSaid(dir, number, since, { comments = pr.comments } = {}) {
  let rows;
  try {
    rows = await comments(dir, number);
  } catch {
    return '';
  }
  const floor = Date.parse(since || '');
  const mine = (rows || [])
    .filter((c) => String(c.body || '').includes(RESOLVER_SAYS))
    .filter((c) => {
      const at = Date.parse(c.at || '');
      return Number.isFinite(at) && (!Number.isFinite(floor) || at >= floor);
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const last = mine[mine.length - 1];
  if (!last) return '';
  const after = String(last.body).slice(String(last.body).indexOf(RESOLVER_SAYS) + RESOLVER_SAYS.length);
  return oneLine(after).slice(0, 400);
}

/**
 * What has become of one row, asked of the two things that outlive the session.
 *
 * The registry first, because it is free and exact and answers for the whole of a
 * resolver's life. GitHub second, and only once the registry has let go — which is the
 * one moment its answer means something: while a session is mid-merge, `CONFLICTING` is
 * what the branch is *supposed* to say.
 *
 * Returns the row unchanged when nothing has moved, so the caller's "did anything change"
 * test is an identity comparison rather than a diff.
 *
 * **Two kinds of row are asked about, and only one of them is asked about the registry.**
 * A `LIVE` row is one something here is still doing, so the registry answers first and
 * GitHub second. A `NEEDS_ADAM` row is one nothing here will do anything more about — and
 * that is exactly why it is asked of GitHub too, and it is a real change to a state
 * documented as his-answer-only (bc-9d37.17). *He* is not the only thing that can end
 * such a row: the pull request can merge, close, or come back mergeable on github.com,
 * and then the question on the card is dead and no answer to it is worth typing. Only
 * GitHub is asked about one, never the registry — a registry entry left over from the
 * resolver that already handed the row back would read as a session working on it and
 * put a settled question back on the card as a live one.
 *
 * A waiting row GitHub still calls conflicting comes back *unchanged*, rather than being
 * re-derived into `handed-back`: it is already the state it is in, `failed` and `unknown`
 * must stay the different sentences they are, and re-deriving would cost a second `gh`
 * call for the resolver's comment every time it said the same thing.
 */
export async function chaseRow(rec, row, { mergeability = pr.mergeability, said = resolverSaid, now = Date.now() } = {}) {
  const waiting = NEEDS_ADAM.has(row.state);
  if (!LIVE.has(row.state) && !waiting) return row;

  if (!waiting) {
    if (findResolver(rec.key, row.number, now)) {
      return row.state === 'working' ? row : { ...row, state: 'working', note: '' };
    }
    if (pendingResolvers().some((e) => e.workspace === rec.key && Number(e.number) === row.number)) {
      return row.state === 'queued' ? row : { ...row, state: 'queued', note: '' };
    }
  }

  let latest;
  try {
    const answer = await mergeability(rec.dir, row.number, { timeoutMs: 0 });
    latest = answer.pr;
    // `UNKNOWN` is the absence of GitHub having said anything, and it is not a hand-back.
    // Left as it was and asked again next cycle; the TTL is what stops that being forever.
    if (answer.unresolved) return row;
  } catch {
    return row;
  }

  // `said` is cleared alongside `note` for the reason `sweepCardBody` gives about the
  // note: the resolver's sentence is only true of the hand-back it was written for, and a
  // row that has since merged carrying *“you have to pick a side here”* reads as a fact
  // about the merge. Only a waiting row can have one to clear.
  const state = String(latest.state || '').toUpperCase();
  if (state === 'MERGED') return { ...row, state: 'merged', note: '', said: '' };
  if (state !== 'OPEN') return { ...row, state: 'closed', note: '', said: '' };
  if (latest.mergeable !== 'CONFLICTING') return { ...row, state: 'resolved', note: '', said: '' };
  // Still conflicting, and already his. Unchanged — see the note above about re-deriving.
  if (waiting) return row;
  // `filedAt` and not `at` on a rebuilt record: `at` is when the *record* was written and
  // a recovered one was written a minute ago, which would filter out the very comment the
  // resolver left when the card was filed hours before. See `recoverSweepCards`.
  return { ...row, state: 'handed-back', note: '', said: await said(rec.dir, row.number, rec.filedAt || rec.at) };
}

/**
 * The workspace this card is in and the checkout it is about, as they are *now*.
 *
 * Both re-resolved every cycle rather than trusted from the record, and for different
 * reasons: the workspace is what `bd` is run against and a record can outlive one being
 * renamed or dropped from the config, while a checkout can be moved or retired between
 * cycles. No workspace is the end of the record — nothing can be written to a tracker
 * that is not configured — and no checkout only ends the *chasing*, since the card can
 * still be amended to say so.
 */
export function locate(cfg, rec) {
  const ws = (cfg?.workspaces || []).find((w) => w.name === rec.workspace) || null;
  if (!ws) return { ws: null, dir: '' };
  if (rec.dir && fs.existsSync(rec.dir)) return { ws, dir: rec.dir };
  const unit = unitFor(cfg, rec.key);
  if (unit?.repo?.dir) return { ws, dir: unit.repo.dir };
  try {
    return { ws, dir: resolveSessionDir(cfg, ws) };
  } catch {
    return { ws, dir: '' };
  }
}

/**
 * Is the card still in the inbox? Asked of the tracker, and only to bound a record.
 *
 * The one thing that ends a record whose rows have all stopped and one of which is
 * waiting on Adam. He may answer it — which puts a row back to `working` and is handled
 * by every other path here — or he may tap *Noted*, or dismiss it, and both of those
 * close the bead and leave nothing to chase. Anything but a definite "closed" holds the
 * record, including a `bd` that would not answer: dropping it on a busy tracker would
 * kill the buttons on a card that is still on his phone.
 */
async function stillOpen(bd, ws, id) {
  try {
    const issue = await bd.show(ws, id);
    if (!issue) return false;
    return String(issue.status || 'open').toLowerCase() !== 'closed';
  } catch {
    return true;
  }
}

/* --------------------------------------------------------------- the recovery */

/**
 * The card's own title, read back. **Both shapes `sweepCardTitle` writes**, because since
 * bc-xl7n.36 the title is a function of how many merges have been folded into the card:
 *
 *     #249 left 2 conflicting pull requests behind it in X
 *     1 conflicting pull request in X has survived 5 merges since #244
 *
 * A card matching either was filed by this file, and the count it gives is what the body's
 * rows are checked against. The folded shape names only the *oldest* merge, which is why
 * the rest are read out of `foldedNote` below rather than out of here.
 */
const CARD_TITLE_RE =
  /^(?:(?:#(\d+)|A merge) left (\d+) conflicting pull requests? behind it in (.+)|(\d+) conflicting pull requests? in (.+?) (?:has|have) survived \d+ merges since #(\d+))$/;

/** The base, off the card's own heading — again in both of the shapes `sweepCardBody` writes. */
const CARD_BASE_RE = /^## (?:(?:#\d+|A pull request) merged into|\d+ merges have landed in) `([^`]+)`/m;

/** Every merge folded into the card, oldest first, off `foldedNote`'s own sentence. */
const CARD_MERGES_RE = /merges folded in here, oldest first: ((?:#\d+(?:, )?)+)\./;

/** One row, over the two lines `sweepCardBody` gives it: the name, then the state. */
const CARD_ROW_RE = /^- (?:\[#(\d+)\]\(([^)\s]*)\)|\*\*#(\d+)\*\*)([^\n]*)\n[ \t]+([^\n]*)$/gm;

/** A trailing ` (bc-abcd, bc-efgh.1)` is `name()`'s bead list; anything else is the title. */
const CARD_BEADS_RE = /\s\(([a-z]+-[a-z0-9]+(?:\.\d+)*(?:, [a-z]+-[a-z0-9]+(?:\.\d+)*)*)\)$/;

/** The resolver's own sentence, as `sweepCardBody` quotes it on the state line. */
const CARD_SAID_RE = /\s—\s\*“([^”]*)”\*/;

/**
 * One row of a card, read back off the two lines it was written as.
 *
 * The state is deliberately *not* read back. What the card says a row was is what was true
 * when the record was last written, which for a card that has lost its record is the one
 * fact we already know is stale — and a `handed-back` read back off the card would be a
 * row `chaseRow` never asks about again. Every recovered row starts at `RECOVERING` and
 * GitHub says what it is. What *is* read back is the row's identity: the number is what
 * GitHub is asked about, and the branch is what an *Answer #n* button opens a window on.
 */
function rowFromCard(m) {
  const number = Number(m[1] || m[3]);
  if (!Number.isInteger(number) || number <= 0) return null;
  let rest = String(m[4] || '').trim();
  let branch = '';
  const tick = /^`([^`]*)`/.exec(rest);
  if (tick) {
    branch = tick[1];
    rest = rest.slice(tick[0].length).replace(/^\s*—\s*/, '');
  }
  let beads = [];
  const tail = CARD_BEADS_RE.exec(rest);
  if (tail) {
    beads = tail[1].split(',').map((b) => b.trim());
    rest = rest.slice(0, tail.index);
  }
  return {
    number,
    branch,
    title: rest.trim(),
    url: String(m[2] || ''),
    beads,
    state: RECOVERING,
    note: '',
    // Kept off the card so the resolver's sentence survives even where GitHub will not
    // answer. `chaseRow` overwrites it with the live one the moment it can.
    said: (CARD_SAID_RE.exec(String(m[5] || '')) || [])[1] || '',
  };
}

/**
 * A record, rebuilt from the card it was lost from. `null` when the card does not read
 * back whole — see `recoverSweepCards` for why that is a refusal and not a best effort.
 */
export function recordFromCard(bead, cfg, workspace, { now = Date.now() } = {}) {
  const head = CARD_TITLE_RE.exec(String(bead?.title || '').trim());
  if (!head) return null;
  const body = String(bead?.description || '');

  const prs = [];
  CARD_ROW_RE.lastIndex = 0;
  for (let m; (m = CARD_ROW_RE.exec(body)); ) {
    const row = rowFromCard(m);
    if (row) prs.push(row);
  }
  // The title counts the rows and the body lists them, and the two were written in the
  // same breath. A mismatch means the body is not the one this title belongs to — a card
  // hand-edited, or a body from a format this parser predates — and half a record is worse
  // than none: it would close a card on behalf of pull requests it never asked about.
  // Either half of `CARD_TITLE_RE` — the plain shape counts in group 2 and names the repo
  // in 3, the folded one counts in 4 and names it in 5.
  const folded = head[4] !== undefined;
  if (!prs.length || prs.length !== Number(folded ? head[4] : head[2])) return null;

  const where = String(folded ? head[5] : head[3]).trim();
  const unit = repoUnits(cfg || {}, workspace).find((u) => (u.repo?.name || '') === where) || null;
  const filed = Date.parse(bead?.created_at || '');

  /**
   * Every merge this card has been folded through, oldest first.
   *
   * Rebuilt rather than dropped, because it is what the title and the heading are written
   * out of: a folded card recovered without them would be amended back into
   * "#244 left 1 conflicting pull request behind it", which is the card claiming to be
   * about one merge when it has eaten twelve — the exact sentence bc-xl7n.36 removed.
   * `foldedNote` prints the list in full for a human to read, which makes it readable
   * here too; a card folded only once has no note and its one merge is in the title.
   */
  const listed = (CARD_MERGES_RE.exec(body) || [])[1] || '';
  const merges = listed
    ? listed.split(',').map((m) => Number(m.trim().replace('#', ''))).filter(Number.isInteger)
    : [Number(folded ? head[6] : head[1])].filter(Number.isInteger);

  return {
    card: String(bead.id),
    workspace,
    // The unit key when the repo name resolves to one, and the bare workspace otherwise —
    // which is what `fileSweepCard` writes for a single-repo workspace, where the card
    // names the GitHub repo and the key is the workspace.
    key: unit?.key || workspace,
    // Left empty on purpose: `locate` re-resolves the checkout every cycle anyway, and the
    // path is the one thing the card does not name.
    dir: '',
    repo: where,
    // The merge the card is *about*, which for a folded card is the oldest of them —
    // `mergesOf` reads a pre-bc-xl7n.36 record the same way round.
    after: merges.length ? merges[0] : null,
    merges,
    base: (CARD_BASE_RE.exec(body) || [])[1] || 'main',
    at: new Date(now).toISOString(),
    // When the *card* was filed, which is not when this record was written. The TTL runs
    // off `at`, so a card recovered four hours after filing gets a full window to be chased
    // in rather than expiring on the cycle it came back; `resolverSaid` runs off this, so
    // the comment the resolver left at filing time is still inside its window.
    filedAt: Number.isFinite(filed) ? new Date(filed).toISOString() : new Date(now).toISOString(),
    recovered: true,
    prs,
  };
}

/**
 * Put back the record of every open sweep card that has lost one.
 *
 * **A card that outlives its record can never close.** `followSweepCards` iterates the
 * records and nothing else, so a card with none is never visited: never amended, never
 * closed, and — since bc-9d37.8 — its *Answer #n* buttons do nothing either, because
 * `resolveSweepFor` reads the same record to find out which branch to open a window on.
 * It sits in the inbox saying it closes itself when they all come back mergeable, which
 * for that card is untrue. Eight of the thirteen cards filed on 2026-08-14 were in exactly
 * that state (bc-xl7n.35), and what they lost is recoverable from nowhere but the card.
 *
 * So the card is the backstop, and it can be: it names the merge, the repo, the base, and
 * every pull request with its branch, because it was written for a human to read. What it
 * cannot say is what those pull requests are *now* — the states on it are exactly as stale
 * as the missing record implies — so every rebuilt row starts at `RECOVERING` and the
 * ordinary chase decides. A card whose rows have all settled then closes itself on the next
 * cycle, which is the point: the fix is what clears the inbox, rather than a hand.
 *
 * **Nothing is written to the tracker here.** The only write is the record file, and the
 * only cost is one `bd human list` per workspace that has a repo — which is why the caller
 * runs it on a clock of its own rather than every cycle. An orphaned card is made by
 * something going wrong, it is rare, and it has already been sitting there; another half
 * hour costs nothing, and a tracker read per workspace every two minutes for a thing that
 * is nearly always empty would cost the poll cycle rather more.
 */
export async function recoverSweepCards(bd, cfg, { now = Date.now() } = {}) {
  const records = readSweepCards();
  const out = [];
  const seen = new Set();
  for (const unit of allUnits(cfg || {})) {
    if (seen.has(unit.workspace)) continue;
    seen.add(unit.workspace);
    const ws = (cfg?.workspaces || []).find((w) => w.name === unit.workspace);
    if (!ws) continue;

    let beads;
    try {
      beads = await bd.listHuman(ws);
    } catch (err) {
      // One workspace's tracker being busy is not the others' problem, and the scan runs
      // again on its own clock. Reported rather than thrown: this is called from the poll
      // cycle, where a rejection is the daemon's problem and not the inbox's.
      out.push({ workspace: ws.name, error: `could not read the inbox — ${oneLine(err.message || err)}` });
      continue;
    }

    for (const bead of beads || []) {
      const id = String(bead?.id || '');
      if (!id || records[id]) continue;
      if (!CARD_TITLE_RE.test(String(bead?.title || '').trim())) continue;
      const rec = recordFromCard(bead, cfg, ws.name, { now });
      if (!rec) {
        // Said rather than skipped silently. A card this file filed and cannot read back is
        // one nothing will ever close, and nothing else in the system would mention it.
        out.push({ card: id, workspace: ws.name, unreadable: true });
        continue;
      }
      if (!keep(id, rec)) {
        out.push({ card: id, workspace: ws.name, error: 'the record could not be written back' });
        continue;
      }
      records[id] = rec;
      out.push({ card: id, workspace: ws.name, recovered: true, rows: rec.prs.length });
    }
  }
  return out;
}

/**
 * Chase every open card, amend the ones that moved, and close the ones that settled.
 *
 * Called from the same place in the poll cycle that drains the merge records — it *is*
 * the other half of that sweep — and it never throws, for that reason: what reaches the
 * cycle's catch should be a bug and not a `gh` that blinked.
 *
 * Three things happen to a record, and only one of them is a write to the tracker:
 *
 * - **Nothing moved.** The commonest outcome by far, and it costs one registry lookup per
 *   row plus one `gh pr view` for each row the registry has let go of — and, on a clock of
 *   its own rather than every cycle, one more for each row waiting on Adam, which is
 *   `WAITING_RECHECK_MS`. No `bd` at all —
 *   an amendment per cycle saying the same thing would be a tracker write every two
 *   minutes and a bus event behind it, which is a phone woken up to be told nothing.
 * - **Something moved and something is still moving.** The card is amended in place, so
 *   it stays one card.
 * - **Everything has stopped.** The card is amended one last time and then, if nothing on
 *   it needs Adam, closed with a reason saying what happened — and the record dropped,
 *   because there is nothing left to chase. If something *does* need him the record is
 *   kept instead: since bc-9d37.8 his answer can put a row back to `working`, and it is
 *   the record that says which repo and which branch to open a window on. That one is
 *   bounded by the card rather than by a clock — see `stillOpen`.
 *
 * Returns one outcome per card so the caller can log it and wake the phones that are
 * parked on `/api/poll` — a card filed or amended is a genuinely different inbox, and a
 * sweep that emitted nothing would reach the browser only when something else happened to
 * move.
 */
export async function followSweepCards(
  bd,
  cfg,
  {
    now = Date.now(),
    ttlMs = FOLLOW_TTL_MS,
    waitingMs = WAITING_RECHECK_MS,
    chase = chaseRow,
    mergeability = pr.mergeability,
    said = resolverSaid,
  } = {}
) {
  const records = readSweepCards();
  const ids = Object.keys(records);
  if (!ids.length) return [];

  const out = [];
  for (const id of ids) {
    const rec = records[id];
    const { ws, dir } = locate(cfg, rec);
    if (!ws) {
      // Nothing to write to. Dropped rather than carried, the same call lib/mergesweep.js
      // makes about a record naming a workspace that is not configured any more: what is
      // left of it is a bead in a tracker this daemon cannot address.
      keep(id, null);
      out.push({ card: id, workspace: rec.workspace, gone: true });
      continue;
    }
    const expired = Number.isFinite(Date.parse(rec.at)) && now - Date.parse(rec.at) > ttlMs;
    /**
     * Whether the rows waiting on Adam are due to be re-asked — see `WAITING_RECHECK_MS`.
     *
     * A record with no `askedAt` is due, which is every record written before this
     * existed and every record on its first cycle. That is the right default twice over:
     * a card that has been waiting since yesterday is the case this is for, and asking
     * once too often costs one `gh pr view`.
     */
    const asking = !Number.isFinite(Date.parse(rec.askedAt)) || now - Date.parse(rec.askedAt) >= waitingMs;

    let prs = rec.prs;
    let asked = false;
    if (dir) {
      prs = [];
      for (const row of rec.prs) {
        // Two clocks, because the two kinds of row stop for different reasons. A row that
        // is still moving is given up on at the TTL. A row waiting on him is chased for as
        // long as the card is open — the TTL cannot bound it, since the thing being
        // watched for is a merge that may happen at any point in that wait — but on a
        // cadence of its own rather than every cycle.
        const skip = NEEDS_ADAM.has(row.state) ? !asking : expired;
        if (skip) {
          prs.push(row);
          continue;
        }
        if (NEEDS_ADAM.has(row.state)) asked = true;
        prs.push(await chase({ ...rec, dir }, row, { now, mergeability, said }));
      }
    }
    // A record past its window, or one whose checkout has gone, stops claiming that a
    // session is working: the card is finished off saying so rather than left asserting
    // something nothing can check.
    if (expired || !dir) prs = prs.map((r) => (LIVE.has(r.state) ? { ...r, state: 'unknown' } : r));

    const moved = prs.some((r, i) => r.state !== rec.prs[i].state || r.said !== rec.prs[i].said);
    const next = { ...rec, dir: dir || rec.dir, prs, ...(asked ? { askedAt: new Date(now).toISOString() } : {}) };
    const done = !prs.some((r) => LIVE.has(r.state));
    const needing = tally(next).needing;

    /**
     * A rebuilt record with a row GitHub has not answered for yet — see
     * `recoverSweepCards`. Held rather than amended, because `RECOVERING` is not a fact
     * about a pull request: it is this file admitting it does not know one. Writing it
     * onto the card would replace a stale sentence with a sentence about our own
     * bookkeeping, and wake a phone to do it. The record is kept and the next cycle asks
     * again; a GitHub that never answers is ended by the TTL above, which turns the row
     * into `unknown` — the same admission, but as a thing Adam can act on.
     */
    if (prs.some((r) => r.state === RECOVERING)) {
      keep(id, next);
      continue;
    }

    /**
     * We asked GitHub about the rows waiting on him and it said the same thing. Nothing
     * has moved and nothing is written to any tracker — but the *clock* has to be written
     * down, or every cycle is the first cycle and `WAITING_RECHECK_MS` throttles nothing.
     * Before the two `continue`s below, because those are the quiet outcomes it is for.
     *
     * `keep` is a read-modify-write of the whole map and several writers share it
     * (bc-xl7n.35), so this is one more of those — but it is the same operation every
     * other path here already performs, on the quarter-hour rather than the cycle, and a
     * lost one costs a card being re-asked about once. The window is not widened.
     */
    if (asked && !moved) keep(id, next);

    if (!moved && !done) continue;
    /**
     * Stopped, and still waiting on Adam — which is no longer the end of the record.
     *
     * It used to be: nothing moves on its own from `handed-back`, so the record was
     * dropped and the card left open as a thing to read. Since bc-9d37.8 his *answer*
     * moves it — back to `working`, on a window opened for it — and the record is the
     * only thing that can say which repo, which checkout and which branch that is. So it
     * is kept while the card is, and the card is what bounds it: a clock cannot, because
     * a card answered five hours later must not find its own button dead.
     *
     * And since bc-9d37.17 his answer is not the only thing that moves it: the pull
     * request merging or closing on github.com does too, which is what the chase above
     * now asks about. So this branch is reached with rows that have already been re-asked
     * on this cycle, and a card whose last waiting row ended that way falls through to
     * the close below instead of arriving here at all.
     *
     * One `bd show` per cycle per waiting card, and only when nothing else moved. That is
     * the cost of the loop being closed, and it is paid on the rare card rather than the
     * common one — a sweep whose resolvers all worked never reaches here. A tracker that
     * will not answer is not evidence the card is gone, so it holds.
     */
    if (!moved && done && needing) {
      if (await stillOpen(bd, ws, id)) continue;
      keep(id, null);
      out.push({ card: id, workspace: rec.workspace, gone: true });
      continue;
    }

    let amended = false;
    if (moved) {
      try {
        await bd.update(ws, id, { description: sweepCardBody(next) });
        amended = true;
      } catch (err) {
        // The card is stale for a cycle and the record still says what is true, so the
        // next cycle tries again. Nothing is dropped over a tracker that was busy.
        out.push({ card: id, workspace: rec.workspace, error: `could not amend — ${oneLine(err.message || err)}` });
        continue;
      }
    }

    if (!done) {
      keep(id, next);
      out.push({ card: id, workspace: rec.workspace, amended, ...tally(next) });
      continue;
    }

    let closed = false;
    if (!needing) {
      try {
        await bd.close(ws, id, settledReason(next));
        closed = true;
      } catch (err) {
        // Kept and retried next cycle, exactly as the amend failure above is. It used to
        // be dropped, on the reasoning that a card in the inbox saying everything is fine
        // is a tap to dismiss rather than a lost finding — but that is a card orphaned by
        // one busy `bd`, and an orphan is the thing this file may not make (bc-xl7n.35).
        // The rows have all settled, so the retry is one `bd close` per cycle and stops
        // the first time it works.
        out.push({ card: id, workspace: rec.workspace, amended, error: `could not close — ${oneLine(err.message || err)}` });
        keep(id, next);
        continue;
      }
    }
    // Kept while something on it is waiting on him, for the reason above: his answer is
    // the one thing that can still move this record, and it needs the record to land in.
    keep(id, needing ? next : null);
    out.push({ card: id, workspace: rec.workspace, amended, closed, done: true, ...tally(next) });
  }
  return out;
}

/** One line for the daemon's log, or empty when there is nothing worth saying. */
export function describeSweepCard(o) {
  if (o.error) return `${o.card ? `${o.card}: ` : ''}${o.error}`;
  if (o.recovered)
    return `rebuilt the follow-up of ${o.card} from the card itself — ${o.rows} pull request${
      o.rows === 1 ? '' : 's'
    } to re-check`;
  if (o.unreadable) return `${o.card} looks like a sweep card but will not read back — nothing can close it`;
  if (o.gone) return `dropped the follow-up of ${o.card} — ${o.workspace} is not a configured workspace any more`;
  if (o.closed) return `closed ${o.card} — every conflicting pull request came back mergeable`;
  if (o.done) return `${o.card} is finished — ${o.needing} still need${o.needing === 1 ? 's' : ''} you`;
  if (o.amended) return `amended ${o.card} — ${o.live} still working, ${o.needing} waiting on you`;
  return '';
}
