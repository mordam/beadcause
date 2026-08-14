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
 */
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './atomic.js';
import { CONFIG_DIR } from './config.js';
import { homeIn } from './homing.js';
import * as pr from './pr.js';
import { unitFor } from './repos.js';
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

/** The states a row can still move out of. Everything else is where it stopped. */
const LIVE = new Set(['working', 'queued']);

/** How a state is written on the card. The tick is the whole scan for most readers. */
const STATE_LABEL = {
  working: '⏳ a session is working on it',
  queued: '⏳ waiting for a resolver window',
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
 * The card: markdown, then a `decision` block, filed as the bead's description.
 *
 * **One option, and it closes.** Every other card in this app offers a choice because
 * there is one to make; here the choices are all on the pull requests themselves — pick a
 * side, merge it, close it — and an option that pretended to do any of those from a phone
 * would be a button that files a wish. What the card is for is knowing, and "Noted" is
 * the honest end of knowing. The free-text box is still there, as it is on every question,
 * for an answer that is a sentence rather than a tap.
 *
 * Nothing interpolated into the YAML is prose an agent wrote: the question is built from
 * counts and a repo name here, and the resolver's sentence — the one piece of text this
 * card carries that beadcause did not write — stays in the markdown above it, where a
 * stray quote is a stray quote rather than a block that will not parse and a card with no
 * buttons on it.
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
        .join('\n\n')}\n\n`
    : ''
}${closing}

\`\`\`decision
question: "${question(rec).replace(/"/g, "'")}"
options:
  - id: noted
    label: Noted
    response: "Noted — read the sweep of ${where}."
    hint: closes this card
\`\`\`
`;
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
  return { ...row, state: 'handed-back', note: '', said: await said(rec.dir, row.number, rec.at) };
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
function locate(cfg, rec) {
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
 *   it needs Adam, closed with a reason saying what happened. Either way the record is
 *   dropped: there is nothing left to chase.
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

    if (!moved && !done) continue;

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
    if (!tally(next).needing) {
      try {
        await bd.close(ws, id, settledReason(next));
        closed = true;
      } catch (err) {
        // A card that would not close is a card in the inbox saying everything is fine,
        // which is a tap to dismiss rather than a lost finding.
        out.push({ card: id, workspace: rec.workspace, amended, error: `could not close — ${oneLine(err.message || err)}` });
        keep(id, null);
        continue;
      }
    }
    keep(id, null);
    out.push({ card: id, workspace: rec.workspace, amended, closed, done: true, ...tally(next) });
  }
  return out;
}

/** One line for the daemon's log, or empty when there is nothing worth saying. */
export function describeSweepCard(o) {
  if (o.error) return `${o.card}: ${o.error}`;
  if (o.gone) return `dropped the follow-up of ${o.card} — ${o.workspace} is not a configured workspace any more`;
  if (o.closed) return `closed ${o.card} — every conflicting pull request came back mergeable`;
  if (o.done) return `${o.card} is finished — ${o.needing} still need${o.needing === 1 ? 's' : ''} you`;
  if (o.amended) return `amended ${o.card} — ${o.live} still working, ${o.needing} waiting on you`;
  return '';
}
