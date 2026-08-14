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
 *    lib/resolvers.js's registry, which is in memory and forgotten by any restart — by
 *    design, because a window handle is worth exactly as long as the iTerm holding it. A
 *    card filed at the moment of the sweep is in the tracker from the first second.
 * 3. **Closing it again costs nothing.** When the last pull request comes back mergeable
 *    and none was handed back, the card closes itself with a reason saying so. That is
 *    what the epic actually asks for — "leaves those pull requests mergeable, or leaves a
 *    summary card saying which ones need Adam to pick a winner, with no tap in between" —
 *    and holding could not have both that and the card that names one still running.
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
 */
export const FOLLOW_TTL_MS = 4 * 60 * 60 * 1000;

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
 * why it has to be in `LIVE` — `chaseRow` returns a non-live row unchanged, so a row
 * recovered straight into `handed-back` would be a row nothing ever asked about again, and
 * the card would sit in the inbox exactly as it did with no record at all.
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
 * `handed`, `queued`, `reused` and `failed` are exactly the four outcomes lib/prsweep.js
 * can reach for a conflicting pull request, so between them they name every branch the
 * sweep acted on and nothing it left alone. `reused` — a session that already had this
 * one, told rather than opened — is `working` here rather than a state of its own: from
 * a card's point of view a session that was already on it and a session just opened for
 * it are the same fact.
 */
export function rowsOf(result) {
  const rows = [
    ...(result.handed || []).map((r) => rowOf(r, 'working')),
    ...(result.reused || []).map((r) => rowOf(r, 'working', { note: r.note })),
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

/** The title of the card. Fixed at filing and never amended — the merge does not change. */
export const sweepCardTitle = (rec) =>
  `${rec.after ? `#${rec.after}` : 'A merge'} left ${rec.prs.length} conflicting pull request${
    rec.prs.length === 1 ? '' : 's'
  } behind it in ${rec.repo || rec.key || rec.workspace}`;

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
  const merge = rec.after ? `#${rec.after}` : 'A merge';
  const parts = [
    needing ? `${needing} need${needing === 1 ? 's' : ''} you` : '',
    settled ? `${settled} resolved ${settled === 1 ? 'itself' : 'themselves'}` : '',
    live ? `${live} still being worked` : '',
  ].filter(Boolean);
  return `${merge} conflicted ${rec.prs.length} pull request${rec.prs.length === 1 ? '' : 's'} in ${where} — ${parts.join(', ')}.`;
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

  return `## ${merge} merged into \`${rec.base || 'main'}\`, and ${rows.length} branch${
    rows.length === 1 ? '' : 'es'
  } behind it stopped fitting

Every open pull request in \`${where}\` is measured against a base it has never seen the
moment something lands in it. beadcause opened a resolver on each of the ones that conflict
and that are ours — merge the base in, resolve it, run the repo's own gate, push — and
**nothing in this sweep merges anything into \`${rec.base || 'main'}\`**. That is still a tap
you make.

${lines.join('\n')}

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
 * Without this the answer would be invisible to the follow-up: `chaseRow` only chases the
 * two live states, so a row left at `handed-back` is one nothing ever asks about again,
 * and the card would keep saying a session stopped on it while a session was working on
 * it. Returns the amended record, or null when there is nothing here by that id — a card
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
export const settledReason = (rec) =>
  `Every pull request ${rec.after ? `#${rec.after}` : 'the merge'} conflicted in ${
    rec.repo || rec.key || rec.workspace
  } is mergeable again or gone — ${(rec.prs || []).map((r) => `#${r.number}`).join(', ')}. Nothing needed you.`;

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
 * Never throws. A tracker that refuses the create costs the card and not the sweep, whose
 * windows are already open.
 */
export async function fileSweepCard(bd, ws, result, { unit = null, dir = '', now = Date.now() } = {}) {
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
    prs,
  };

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
      labels: [HUMAN_LABEL],
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
 */
export async function chaseRow(rec, row, { mergeability = pr.mergeability, said = resolverSaid, now = Date.now() } = {}) {
  if (!LIVE.has(row.state)) return row;

  if (findResolver(rec.key, row.number, now)) {
    return row.state === 'working' ? row : { ...row, state: 'working', note: '' };
  }
  if (pendingResolvers().some((e) => e.workspace === rec.key && Number(e.number) === row.number)) {
    return row.state === 'queued' ? row : { ...row, state: 'queued', note: '' };
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

  const state = String(latest.state || '').toUpperCase();
  if (state === 'MERGED') return { ...row, state: 'merged', note: '' };
  if (state !== 'OPEN') return { ...row, state: 'closed', note: '' };
  if (latest.mergeable !== 'CONFLICTING') return { ...row, state: 'resolved', note: '' };
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
 * The card's own title, read back — `#249 left 2 conflicting pull requests behind it in X`.
 *
 * `sweepCardTitle` writes it and never amends it, which is what makes it usable as an
 * identifier: a card in the inbox whose title matches this shape was filed by this file,
 * and the merge number and the repo it names are still the ones it was filed for.
 */
const CARD_TITLE_RE = /^(?:#(\d+)|A merge) left (\d+) conflicting pull requests? behind it in (.+)$/;

/** The base, off the card's own heading. ``## #249 merged into `main`, and 2 branches…`` */
const CARD_BASE_RE = /^## (?:#\d+|A pull request) merged into `([^`]+)`/m;

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
  if (!prs.length || prs.length !== Number(head[2])) return null;

  const where = String(head[3]).trim();
  const unit = repoUnits(cfg || {}, workspace).find((u) => (u.repo?.name || '') === where) || null;
  const filed = Date.parse(bead?.created_at || '');

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
    after: head[1] ? Number(head[1]) : null,
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
 *   row plus one `gh pr view` for each row the registry has let go of. No `bd` at all —
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
  { now = Date.now(), ttlMs = FOLLOW_TTL_MS, chase = chaseRow, mergeability = pr.mergeability, said = resolverSaid } = {}
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

    let prs = rec.prs;
    if (dir && !expired) {
      prs = [];
      for (const row of rec.prs) prs.push(await chase({ ...rec, dir }, row, { now, mergeability, said }));
    }
    // A record past its window, or one whose checkout has gone, stops claiming that a
    // session is working: the card is finished off saying so rather than left asserting
    // something nothing can check.
    if (expired || !dir) prs = prs.map((r) => (LIVE.has(r.state) ? { ...r, state: 'unknown' } : r));

    const moved = prs.some((r, i) => r.state !== rec.prs[i].state || r.said !== rec.prs[i].said);
    const next = { ...rec, dir: dir || rec.dir, prs };
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
