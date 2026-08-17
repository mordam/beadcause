import * as cache from './cache.js';
import { MAX_ATTEMPTS } from './mergebead.js';
import { anyQueued, queueFor } from './mergeadvocate.js';
import { inFlight, keyOf } from './deploy.js';
import { loadLedger, shippedState } from './release.js';
import { whereLanded } from './repos.js';

/**
 * The two queues — and the one place that says where a bead is in either.
 *
 * The stages were all here before this file was, and that was the problem: they were
 * scattered across three modules that answer to three different clocks, and nothing
 * served them as one answer. `lib/mergequeue.js` writes attempts, downmerges, resolving
 * and refused into a merge-bead's notes. `lib/deploy.js` records `queued · pulling ·
 * building · deploying · ok · failed · unconfirmed · lost`. `lib/release.js` batches
 * merged-and-not-live work per repo and fires at the end of the settle window. Ask any
 * one of them where a bead is and you get a third of the answer.
 *
 * ## Why two queues and not one long one
 *
 * Because they are entered by different events, they are drained by different agents, and
 * a thing in one is never in the other:
 *
 * - **The merge queue** is entered when a pull request joins it — a worker files a
 *   merge-bead and stops (lib/mergebead.js) — and it is left by the *merge*. One entry per
 *   bead with an unmerged branch. The MergeAdvocate drains it, one branch at a time, with
 *   the whole board in front of it.
 * - **The release queue** is entered when a pull request **merges**, never before, and it
 *   is left by a deploy. Several merges batch into one release at the end of the settle
 *   window, because one `launchctl kickstart` makes all of them live at once — see
 *   `SETTLE_SECONDS` in lib/release.js.
 *
 * Drawing them as one ladder would say that a branch waiting on CI and a merge waiting on
 * a deploy are the same kind of waiting, and they are not: one is waiting on a decision
 * nobody has made yet, the other on a clock that is already running.
 *
 * ## Two rules that decide what exists at all
 *
 * **A repo with nothing to release creates no release entry.** No service, no webapp, no
 * declared deploy: there is no event that could ever move such an entry off the board, so
 * its merge entry simply disappears on merge, which is the truth about what happened. The
 * same argument `sweepReleases` already makes about not filing a ship bead nobody could
 * ever close — see `releasable`.
 *
 * **An entry leaves the board one release after it went live, not the moment it did.**
 * The moment a deploy lands is the moment you want to look at what it carried, and a
 * board that empties itself at exactly that moment is one you can only ever read too
 * late. So an entry released by the current release or by the one before it is still
 * returned, and one released two releases ago is gone. See `releasesSince`.
 *
 * ## What this file is not
 *
 * It reads. Nothing here merges, deploys, files a bead or writes a ledger, and the one
 * function that touches a tracker at all — `gatherMerges` — is deliberately not the one
 * that decides anything. `queues()` takes what it is given, exactly as `stageOf` in
 * lib/prstage.js takes its journal rather than opening one, which is what makes the whole
 * of the derivation testable without a tracker, a checkout or a network.
 */

/* -------------------------------------------------------------- the merge ladder */

/**
 * Where a branch can be on its way into `main`, in order.
 *
 * Five rungs, and each one is a state something in lib/mergequeue.js actually writes
 * down — there is no rung here for a step the queue takes and does not record, because a
 * stage nothing observes is a guess with a label on it. The `note` is the sentence a card
 * wears under the name; it is part of the payload rather than decoration, for the reason
 * `STAGES` in lib/prstage.js gives about its own: one word is not self-explanatory, and
 * the explanation must not be written twice.
 */
export const MERGE_STAGES = [
  {
    id: 'queued',
    label: 'Queued for merge',
    note: 'In the merge queue. Nothing has been tried yet.',
  },
  {
    id: 'downmerging',
    label: 'Downmerging',
    note: 'The base has been brought into the branch, and its checks are re-running against what will actually land.',
  },
  {
    id: 'conflicts',
    label: 'Resolving conflicts',
    note: 'The downmerge would not go in on its own, and a resolver session is on it.',
  },
  {
    id: 'gate',
    label: 'Gate tests',
    note: 'Waiting on the checks — judged against whatever the base is already failing.',
  },
  {
    id: 'issues',
    label: 'Resolving issues',
    note: 'Something refused it, or something outside the queue has to move before it can merge.',
  },
];

/* ------------------------------------------------------------ the release ladder */

/**
 * Where a merge can be on its way to being live, in order.
 *
 * Seven rungs, and **three of them are not tracked yet**, which is a fact this table
 * carries rather than one a screen has to know. `npm run swap` replaces the backend every
 * open phone is talking to and writes nothing but `restart.json` — deliberately, because a
 * swap wearing a deploy record would show up in `listDeploys`, on this board and in a push
 * notification announcing a deploy nobody pressed Ship on (lib/deploy.js). So until
 * bc-khoe.8 records the router's handover as its own trail, `green`, `verifying` and
 * `swapping` are drawn as *not tracked* rather than guessed at.
 *
 * `tracked: false` and not simply leaving the three rungs out: a ladder that quietly
 * skipped from `deploying` to `live` would say the handover does not happen, where what is
 * true is that nothing here can see it. The two read identically on a screen and only one
 * of them is honest.
 */
export const RELEASE_STAGES = [
  {
    id: 'merged',
    label: 'Merged',
    note: 'Merged and on origin, waiting for a release. The settle window batches whatever lands close to it.',
    tracked: true,
  },
  {
    id: 'building',
    label: 'Building',
    note: 'A deploy is running: it has fetched, and it is building.',
    tracked: true,
  },
  {
    id: 'deploying',
    label: 'Deploying',
    note: 'The build is done and the deploy step is running.',
    tracked: true,
  },
  {
    id: 'green',
    label: 'Deployed to green',
    note: 'The new backend is up on the green port, not yet serving anybody.',
    tracked: false,
  },
  {
    id: 'verifying',
    label: 'Green verification',
    note: 'The health check against green, before any phone is handed to it.',
    tracked: false,
  },
  {
    id: 'swapping',
    label: 'Swapping to blue',
    note: 'The router moving every open phone across to the new backend.',
    tracked: false,
  },
  {
    id: 'live',
    label: 'Live',
    note: 'In what this repo is running.',
    tracked: true,
  },
];

/** Every rung's id, in ladder order — the two ladders, for anything that wants the words. */
export const MERGE_STAGE_IDS = MERGE_STAGES.map((s) => s.id);
export const RELEASE_STAGE_IDS = RELEASE_STAGES.map((s) => s.id);

/** A rung's row from either table, for a caller that wants the words. */
export const mergeStageInfo = (id) => MERGE_STAGES.find((s) => s.id === id) || null;
export const releaseStageInfo = (id) => RELEASE_STAGES.find((s) => s.id === id) || null;

/* --------------------------------------------------------------- the merge stage */

/**
 * Which rung of the merge ladder this branch is on.
 *
 * `state` is `queueState(issue)` from lib/mergebead.js — the block the tick rewrites every
 * pass. `row` is the board's row for the same pull request, or null: the queue's own block
 * says what the queue last *did*, and the row says what GitHub says *now*, and neither is
 * enough on its own. A branch whose block reads `downmerges: 1` and whose checks are
 * pending is not downmerging any more; a branch with an empty block whose checks are
 * running is not sitting in a queue.
 *
 * The order below is the order of the questions, and it is strongest-evidence-first for
 * `stageOf`'s reason: every branch is a fact somebody already established, and the first
 * one that answers wins.
 */
export function mergeStageOf(state = {}, row = null) {
  const checks = String(row?.checks?.state || '');
  const conflicting = String(row?.mergeable || '').toUpperCase() === 'CONFLICTING';

  /**
   * `resolving` means *somebody has been asked*, and lib/mergequeue.js writes it for two
   * different somebodies. The conflict branch writes it with a refusal beside it ("the
   * branch conflicts with its base"); the approval branch writes it with none, because
   * nothing refused — the checks are green and the space asks for a review that GitHub
   * will not accept from the author (lib/mergeadmit.js). So the refusal is what tells the
   * two apart on the bead, and the row confirms it where there is one.
   */
  if (state.resolving) return conflicting || state.refused ? 'conflicts' : 'issues';
  // Out of attempts: it has stopped being the queue's problem and is a card of Adam's.
  if ((state.attempts || 0) >= MAX_ATTEMPTS) return 'issues';
  // A refusal on the block with no resolver on it — the queue will try again, and what it
  // is waiting for is whatever the sentence says.
  if (state.refused) return 'issues';
  if (conflicting) return 'conflicts';
  // Pending *or* failing: both are the gate having something to say. A failure only becomes
  // `issues` once the tick has actually refused over it, which is the branch above — until
  // then nothing has judged it, and saying otherwise would pre-empt `gateVerdict`, which is
  // the one thing allowed to decide whether a red check is this branch's fault.
  if (checks === 'pending' || checks === 'failing') return 'gate';
  // Last, because a downmerge is the *oldest* thing on the block: once its checks have
  // re-run there is something newer to say.
  if ((state.downmerges || 0) > 0) return 'downmerging';
  return 'queued';
}

/* ------------------------------------------------------------- the release stage */

/**
 * A deploy record's status, as a rung of the release ladder.
 *
 * Two of the eight words lib/deploy.js has map onto a rung of their own and six do not,
 * which is the point rather than an omission. `queued` and `pulling` are a deploy that has not started
 * doing anything you could watch, so the merge is still where it was — `merged`. `failed`
 * and `lost` never made anything live, so a merge whose deploy ended in one of them is
 * back to waiting for a release, which is `merged` again. `unconfirmed` is the ordinary
 * ending of a deploy that restarts the daemon that asked for it, and it settles nothing
 * by itself — for this repo the running build answers instead, and for every other one
 * the honest answer is that nobody knows.
 */
const STAGE_BY_STATUS = { building: 'building', deploying: 'deploying' };

/**
 * Which rung of the release ladder this merge is on.
 *
 * - `row` — the board's row, which already carries `merged`, `pushed` and `deployed`.
 * - `deploys` — this repo's records, newest first, the same journal `shippedState` reads.
 *
 * Null when the row is not in the release queue at all: not merged, or merged and not on
 * `origin` as this Mac has seen it. That second one is deliberate and it is
 * `shippedState`'s rule: a deploy fast-forwards to `origin/<base>`, so a merge this Mac
 * has not fetched could not be shipped by one and is not in a queue of what a deploy would
 * make live.
 */
export function releaseStageOf(row, deploys = []) {
  if (!row?.merged) return null;
  if (row.deployed !== true && row.pushed !== true) return null;
  if (row.deployed === true || shippedState(row, deploys) === true) return 'live';
  const running = runningRelease(row, deploys);
  return (running && STAGE_BY_STATUS[running.status]) || 'merged';
}

/**
 * The deploy that is carrying this merge right now, if one is.
 *
 * In flight, and started after the merge landed — the same clock `shippedState` uses and
 * the same conservative end of it: `startedAt` is stamped *before* the runner's
 * fast-forward, so a deploy that started earlier than the merge certainly is not carrying
 * it. A deploy that started a second later may or may not be; claiming it would be the
 * over-claim that file argues against, and the cost of not claiming it is one sweep of
 * saying `merged` about something that is about to be live.
 */
function runningRelease(row, deploys = []) {
  const merged = Date.parse(row?.mergedAt || '');
  if (!Number.isFinite(merged)) return null;
  return (
    (deploys || []).find(
      (d) => inFlight(d) && Number.isFinite(Date.parse(d.startedAt || '')) && Date.parse(d.startedAt) > merged
    ) || null
  );
}

/**
 * The deploy that made this merge live, or null.
 *
 * The *oldest* record that could have: a merge is live from the first release after it,
 * not from the most recent one, and counting back from the wrong end would keep every
 * entry on the board for ever. Two strengths of evidence, and they are the two
 * `shippedState` already distinguishes:
 *
 * - **The running build contains it** (`row.deployed`), which only beadcause can know
 *   about itself. Then any deploy that *ran* — `ok`, or the `unconfirmed` that is the
 *   ordinary ending of a restart — is the one that did it, because the process answering
 *   you came up out of one of them.
 * - **A deploy that exited 0 pulled after the merge landed.** For every other repo the
 *   running build is invisible and the journal is the whole of the evidence, so only `ok`
 *   counts. `unconfirmed` and `lost` settle nothing, ever.
 */
function releasedBy(row, deploys = []) {
  const merged = Date.parse(row?.mergedAt || '');
  if (!Number.isFinite(merged)) return null;
  const after = (deploys || [])
    .filter((d) => Number.isFinite(Date.parse(d.startedAt || '')) && Date.parse(d.startedAt) > merged)
    .slice()
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));
  const ran = row?.deployed === true ? RELEASED : OK_ONLY;
  return after.find((d) => ran.has(d.status)) || null;
}

/** What counts as a deploy having *happened*, at the two strengths above. */
const OK_ONLY = new Set(['ok']);
const RELEASED = new Set(['ok', 'unconfirmed']);

/**
 * How many releases have gone out since this one — 0 for the release that is live now.
 *
 * The number the board ages an entry out on, and it is a count of *releases* rather than
 * of days for the reason the rule is written that way: a repo that deploys twice an hour
 * and one that deploys twice a week should keep an entry visible for the same amount of
 * *work*, not the same amount of time.
 *
 * A record that ended `failed` or `lost` is not a release and is not counted. Nothing went
 * live in it, so counting it would age out an entry over a deploy that did not happen —
 * which is the one direction that loses the thing you were looking for.
 */
function releasesSince(rec, deploys = []) {
  const at = Date.parse(rec?.startedAt || '');
  if (!Number.isFinite(at)) return 0;
  return (deploys || []).filter(
    (d) => RELEASED.has(d.status) && Number.isFinite(Date.parse(d.startedAt || '')) && Date.parse(d.startedAt) > at
  ).length;
}

/** How long an entry stays after the release that made it live. See the header. */
export const KEEP_RELEASES = 1;

/* ------------------------------------------------------------------ the entries */

/** A merge-bead's spec and the board row for the same pull request, if the board has one. */
const rowFor = (card, number) => (card?.prs || []).find((p) => Number(p.number) === Number(number)) || null;

/**
 * One entry of the merge queue: what it is about, where it is, and how it got there.
 *
 * `bead` is the bead the work was *for* — the one that closes when this merges — and
 * `mergeBead` is the queue's own entry for it. Both, because they answer different
 * questions: the first is what a card is about, and the second is where you go to find out
 * why it has not merged.
 */
export function mergeEntry({ workspace, id, spec, state }, card = null) {
  const row = rowFor(card, spec?.number);
  const stage = mergeStageOf(state || {}, row);
  return {
    kind: 'merge',
    workspace,
    key: card?.key ?? workspace,
    where: whereOf(card, workspace),
    bead: spec?.bead || null,
    mergeBead: id,
    number: Number(spec?.number) || null,
    url: spec?.url || '',
    title: row?.title || '',
    branch: spec?.branch || '',
    base: spec?.base || 'main',
    stage,
    stageLabel: mergeStageInfo(stage)?.label || '',
    note: mergeStageInfo(stage)?.note || '',
    attempts: state?.attempts || 0,
    downmerges: state?.downmerges || 0,
    attemptsLeft: Math.max(0, MAX_ATTEMPTS - (state?.attempts || 0)),
    refused: state?.refused || null,
    approved: !!state?.approved,
    at: state?.at || null,
    // The rungs, drawn. Every merge rung is tracked, so this is `done`/`now`/`pending`
    // throughout — but it is the same shape the release entry hands back, because the two
    // are drawn by one card renderer (bc-khoe.7) and a card that had to know which queue it
    // was in to read its own payload would be two renderers wearing one name.
    rungs: rungsFor(MERGE_STAGES, stage),
  };
}

/**
 * One entry of the release queue: a merged pull request, in the batch it will ship with.
 *
 * `ago` is how many releases have gone out since the one that made it live — null while it
 * is still waiting for one. It is on the wire rather than being folded into a boolean
 * because it is what a screen sorts and greys by, and because "this went out in the
 * release before last" is a different sentence from "this is not live".
 */
export function releaseEntry(row, card, deploys = [], ledger = {}) {
  const stage = releaseStageOf(row, deploys);
  if (!stage) return null;
  const rec = stage === 'live' ? releasedBy(row, deploys) : runningRelease(row, deploys);
  /**
   * Live, and nothing in the journal can say which release did it — so it is history
   * rather than a queue entry, and it is left off.
   *
   * This is the same hole `entry.since` fills in lib/release.js, met from the other side.
   * The board carries three weeks of merged pull requests and the journal keeps forty
   * deploys; a first run, a new install, or a repo whose records have aged out finds every
   * one of those merges *live* in the build that is running and no record of the deploy
   * that carried it. Calling that `ago: 0` would put three weeks of work on the board as
   * the current release, which is precisely the flood the watermark exists to stop.
   *
   * The rule is "one release past the one that made it live", and an entry nothing can
   * place is one nothing can say that about. Left off is the reading that cannot invent a
   * release; the cost is a merge that went out in the last release and whose record has
   * been pruned, which for a repo that deploys often is a merge far older than forty
   * deploys ago anyway.
   */
  if (stage === 'live' && !rec) return null;
  const handled = ledger?.[card?.key ?? card?.workspace]?.handled || {};
  return {
    kind: 'release',
    workspace: card?.workspace || null,
    key: card?.key ?? card?.workspace,
    where: whereOf(card, card?.workspace),
    // Every bead the pull request was for, which is `beadsFor`'s answer and not a guess of
    // this file's. First one leads, because a card has one line for it.
    bead: row?.beads?.[0]?.id || null,
    beads: (row?.beads || []).map((b) => b.id),
    // The ship bead, where one was filed. Null is ordinary — a merge that predates the
    // watermark, or a repo where filing is off. Same lookup `releaseFor` does.
    shipBead: handled[String(row?.number)]?.bead || null,
    number: row?.number ?? null,
    url: row?.url || '',
    title: row?.title || '',
    mergedAt: row?.mergedAt || null,
    sha: row?.mergeCommit ? String(row.mergeCommit).slice(0, 7) : '',
    stage,
    stageLabel: releaseStageInfo(stage)?.label || '',
    note: releaseStageInfo(stage)?.note || '',
    deploy: rec ? { id: rec.id, status: rec.status, startedAt: rec.startedAt || null } : null,
    ago: stage === 'live' ? releasesSince(rec, deploys) : null,
    rungs: rungsFor(RELEASE_STAGES, stage),
  };
}

/**
 * The ladder as a card draws it: every rung, and what is known about each one.
 *
 * Four states, and the fourth is the whole reason this is computed here rather than by
 * whatever draws it. `done` is behind the current rung, `now` is where it is, `pending` is
 * ahead of it — and `untracked` is a rung nothing observes, which is **never** `done` no
 * matter where the entry has got to. A screen that filled the ladder in from the current
 * stage would tick "green verification" the moment something went live, having verified
 * nothing, and that is exactly the claim bc-khoe.8 exists to make true rather than to
 * assume.
 */
export function rungsFor(stages, stage) {
  const at = stages.findIndex((s) => s.id === stage);
  return stages.map((s, i) => ({
    id: s.id,
    label: s.label,
    note: s.note,
    state: s.tracked === false ? 'untracked' : i < at ? 'done' : i === at ? 'now' : 'pending',
  }));
}

/** How a repo names itself on a line — `climative · athena-service`, or bare `beadcause`. */
const whereOf = (card, workspace) =>
  whereLanded(card?.workspace ?? workspace, card?.repoName ? { name: card.repoName } : null);

/**
 * Can this repo release anything at all?
 *
 * A repo beadcause can deploy, or one whose running build it can see. Anything else has no
 * event that could move a release entry along, so it gets none — its merge entry simply
 * disappears when the pull request merges, which is all that is true about it from here.
 * The same test `sweepReleases` makes before filing a ship bead, and for the same reason:
 * a queue entry nothing could ever drain is a chore this file invented rather than found.
 */
export const releasable = (card) => Boolean(card?.deployDeclared || card?.deployTracked);

/* -------------------------------------------------------------------- the answer */

/**
 * Both queues, keyed by repo — one answer, built from things somebody else has read.
 *
 * - `board` — `collectBoard`'s, narrowed to the account if the caller narrows it.
 * - `merges` — every open merge-bead on the Mac, as `{workspace, id, spec, state}`. That
 *   is `queueFor()`'s entry shape with the workspace and the bead id lifted out of it, so
 *   the caller can gather it however it likes and this file never touches a tracker.
 * - `deploys` — the journal, newest first, ungrouped: grouped here by `keyOf`, for
 *   `byRepo`'s reason in lib/release.js — a `fly deploy` of one Climative service says
 *   nothing about the thirty-nine beside it.
 * - `ledger` — the release ledger, for the ship bead on a release entry. Read from disk
 *   when the caller does not pass one, because every caller wants it and no caller wants
 *   to think about it.
 *
 * A repo with an error on its card still gets its entries. The board puts a failure *in*
 * the card rather than dropping it, and a repo whose `gh` call failed is exactly the one
 * whose merge queue you want to be able to see.
 */
export function queues(board, { merges = [], deploys = [], ledger = null, at = new Date().toISOString() } = {}) {
  const led = ledger || loadLedger() || {};
  const grouped = byRepo(deploys);
  const cards = board?.repos || [];
  const owner = placeMerges(cards, merges);

  const repos = cards.map((card) => {
    const key = card.key ?? card.workspace;
    const mine = grouped.get(key) || [];
    const merge = merges
      .filter((m) => owner.get(m) === card)
      .map((m) => mergeEntry(m, card))
      .sort((a, b) => (b.number || 0) - (a.number || 0));
    const release = releasable(card)
      ? (card.prs || [])
          .map((row) => releaseEntry(row, card, mine, led))
          .filter(Boolean)
          // The ageing-out, and the only place it happens. `ago` is null while a merge is
          // still waiting, so a queue that has not shipped in a fortnight keeps every one
          // of them — which is right: nothing has released them.
          .filter((e) => e.ago === null || e.ago <= KEEP_RELEASES)
          .sort((a, b) => String(b.mergedAt || '').localeCompare(String(a.mergedAt || '')))
      : [];
    return {
      key,
      workspace: card.workspace,
      repo: card.repo || null,
      where: whereOf(card, card.workspace),
      base: card.base || 'main',
      deployDeclared: !!card.deployDeclared,
      deployTracked: !!card.deployTracked,
      releasable: releasable(card),
      error: card.error || null,
      merge,
      release,
    };
  });

  /**
   * Merge-beads whose repo is not on this board, listed rather than dropped.
   *
   * Three ways to get here and all of them are states somebody has to be able to see: an
   * account that does not name this repo, a `gh` that would not answer so the board is
   * empty, and a merge-bead naming a checkout that is not on this Mac at all. Dropping
   * them would make a branch that cannot merge look like a branch that already has.
   */
  const orphans = merges.filter((m) => !owner.has(m)).map((m) => mergeEntry(m, null));

  return {
    at,
    repos,
    orphans,
    counts: {
      merge: repos.reduce((n, r) => n + r.merge.length, 0) + orphans.length,
      release: repos.reduce((n, r) => n + r.release.length, 0),
    },
  };
}

/**
 * Which card each merge-bead belongs to — decided once, for the whole board.
 *
 * Two rules, in this order, and the second is why this is a pass over the board rather
 * than a predicate a card could ask on its own:
 *
 * 1. **The GitHub slug**, where the bead names one and a card in that workspace is it.
 *    Exact, and it is the only rule that is safe in a workspace of forty repos — a
 *    merge-bead for `Climative/athena-service` must not land on `architecture`'s card,
 *    which is the mistake `unitForDelivery` exists to stop one layer up.
 * 2. **The one card**, where the bead names no slug and the workspace has exactly one.
 *    A bead filed before repo keys existed, or one opened by hand, carries none at all,
 *    and for a workspace that is one repo the workspace name *is* the answer.
 *
 * Anything else is an orphan, deliberately: a guess between two of forty checkouts is
 * worth less than a line saying which pull request nothing could place.
 */
function placeMerges(cards, merges) {
  const owner = new Map();
  const bySlug = new Map();
  const perWorkspace = new Map();
  for (const card of cards) {
    const slug = String(card?.repo || '').trim().toLowerCase();
    // `::` rather than any exotic separator: a workspace name is a directory-ish word and
    // a slug is `owner/repo`, so neither can contain it, and a key you can print is one a
    // failing test can be read from.
    if (slug) bySlug.set(`${card.workspace}::${slug}`, card);
    // `null` for a workspace seen twice — "the one card" has no answer there.
    perWorkspace.set(card.workspace, perWorkspace.has(card.workspace) ? null : card);
  }
  for (const m of merges) {
    const ws = String(m?.workspace || '');
    const want = String(m?.spec?.repo || '').trim().toLowerCase();
    if (want) {
      const exact = bySlug.get(`${ws}::${want}`);
      if (exact) owner.set(m, exact);
      continue;
    }
    const only = perWorkspace.get(ws);
    if (only) owner.set(m, only);
  }
  return owner;
}

/* ------------------------------------------------------- reading the merge queue */

/** How long a gathered merge queue is kept before anybody pays for it again. */
const MERGES_MS = 20_000;

const MERGES_KEY = 'queues:merges';

/**
 * Every open merge-bead on the Mac, in the shape `queues()` takes.
 *
 * The one function here that reads a tracker, and it is separate from everything above
 * for that reason alone. Three things about the cost, because this is behind a GET a
 * phone polls:
 *
 * 1. **The cheap no first.** `anyQueued` answers off `bd.graph()`, which is one `bd
 *    export` per workspace per minute and is already kept warm by the P0 board — see the
 *    header on it. The real read is `bd.listAgent`, a subprocess per workspace, and on an
 *    idle laptop nine of those would answer *nothing queued* every time.
 * 2. **A failed graph read is a yes**, `anyQueued`'s own rule: unknown falls through to
 *    the real read, which costs a spawn rather than hiding a queue.
 * 3. **Kept for twenty seconds**, on lib/cache.js, so a screen polling this and the board
 *    beside it does not spawn a `bd` per poll. Shorter than the board's own 25s window
 *    because a merge-bead appears the moment a worker delivers and the first thing anybody
 *    does after delivering is look for it.
 *
 * A workspace whose tracker will not answer lands in `errors` rather than throwing: nine
 * workspaces and one busy Dolt must still be eight queues you can read.
 */
export async function gatherMerges(bd, cfg, { refresh = false } = {}) {
  const got = await cache.read(MERGES_KEY, () => sweepMerges(bd, cfg), { freshMs: MERGES_MS, refresh });
  return { ...got.value, kept: cache.combine([got]) };
}

async function sweepMerges(bd, cfg) {
  const errors = [];
  const per = await Promise.all(
    (cfg?.workspaces || []).map(async (ws) => {
      try {
        if (!anyQueued(await bd.graph(ws).catch(() => null))) return [];
        const { queued, stuck, broken, resolving } = queueFor(await bd.listAgent(ws));
        // All four populations, because all four are *in* the queue — one that dropped
        // `stuck` would say a branch out of attempts had merged. `broken` carries no spec
        // at all, so it is the one shape here that has to be built by hand: a merge-bead
        // whose block will not parse is exactly the entry nobody can see any other way.
        return [
          ...[...queued, ...resolving, ...stuck].map((e) => ({
            workspace: ws.name,
            id: e.issue.id,
            spec: e.spec,
            state: e.state,
          })),
          ...broken.map((e) => ({
            workspace: ws.name,
            id: e.issue.id,
            spec: null,
            state: { ...e.state, refused: e.why || 'its beadpr block will not parse' },
          })),
        ];
      } catch (err) {
        errors.push({ workspace: ws.name, error: String(err?.message || err).split('\n')[0] });
        return [];
      }
    })
  );
  return { merges: per.flat(), errors };
}

/** Drop the kept merge queue — for anything that has just changed what a read would find. */
export const forgetMerges = () => cache.drop(MERGES_KEY);

/** Deploy records grouped by the repo they belong to, order preserved (newest first). */
function byRepo(deploys) {
  const map = new Map();
  for (const d of deploys || []) {
    const k = keyOf(d);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(d);
  }
  return map;
}
