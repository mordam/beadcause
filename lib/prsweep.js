/**
 * What a merge leaves behind — the open pull requests it just put out of date.
 *
 * A merge into `main` is measured against every other open branch in the same repo,
 * and nothing about it asks their permission. Some of them stop fitting. Until this
 * existed the only thing that noticed was the PR board, which draws a red conflicts
 * chip whenever Adam next looks at it, and the fix waited on a tap on *Resolve
 * conflicts* — per pull request, remembered by a human, hours later.
 *
 * Everything the fix needs was already here. `mergeability` in lib/pr.js waits out
 * GitHub's UNKNOWN window; lib/resolvers.js serialises one resolver per pull request,
 * caps them at two and queues the rest; `conflictPromptFor` in lib/session.js is the
 * brief. This is the missing middle: given a merge that has already happened, which
 * pull requests conflict *now*, and which of those are ours to touch.
 *
 * **It does not merge anything, and it never will.** The merge into the base stays an
 * act somebody initiates — a tap on a card, `beadcause-deliver`, github.com. This
 * reacts to one that already happened, and the most it ever leaves behind is a branch
 * pushed and mergeable again.
 *
 * ## Four things it refuses to do, and the reasons are not the same reason
 *
 * 1. **An observer daemon sweeps nothing.** A spare-port instance shares these
 *    checkouts, and `POST /api/pr/conflicts` already refuses it for the same reason:
 *    opening an unattended session in a repo it is only visiting is not its to do. A
 *    sweep is worse than the tap, not better — the tap opens one window and somebody
 *    asked for it; this can open two and nobody did. Same for `openSessions: false`.
 * 2. **One repo, its own.** A merge in `athena-service` cannot conflict a pull request
 *    in `frontend-base`, so there is no loop over repos in this file at all: it takes
 *    one checkout and asks about that. The shape is the guarantee.
 * 3. **Only pull requests beadcause opened.** In a Climative workspace forty repos
 *    share one tracker and other engineers have branches open in all of them. Merging
 *    `main` into a teammate's branch and pushing it is not ours to do, whatever GitHub
 *    says about the merge base — so a pull request that is not ours is left alone, red
 *    chip and all, and the chip is the correct outcome there rather than a failure.
 *    See `oursOf` below for what the test actually is.
 * 4. **A draft is left alone too**, which is a decision rather than a rule inherited
 *    from anywhere. A draft is a branch somebody is still writing; its worktree is very
 *    likely locked by the session that opened it, and a resolver sent into a locked tree
 *    stands down at step 2 of its own brief. That is a window opened in order to be
 *    closed, which is the exact thing every refusal on this path exists to prevent. It
 *    costs nothing to wait: the next merge sweeps it again, and by then it is either
 *    ready for review or still nobody's business.
 *
 * ## The shape of the wait, which is the part that looks like a bug
 *
 * Right after a merge lands, GitHub reports `UNKNOWN` for the mergeability of *every*
 * other open pull request in the repo, for a few seconds, while it recomputes the merge
 * bases. A sweep that read the board once and believed it would find nothing at all —
 * reliably, every time, and look exactly like a feature that does not work. So nothing
 * here reads `mergeable` off a row: every candidate goes through `mergeability`, which
 * polls to a bounded deadline and reports `unresolved` when the answer never came. That
 * is a third state and it is not a conflict; a pull request GitHub would not answer
 * about is reported as such and left alone.
 *
 * ## And the order, which is about money rather than correctness
 *
 * Ownership is decided **before** mergeability, the opposite way round from how the
 * work reads. Both orders give the same answer; the costs are nothing alike. Ownership
 * is local — a `bd show` the sweep's own memo usually already holds, and one `git log`
 * over a ref — while `mergeability` is a network round trip that may sit out a
 * thirty-second poll before it says anything. A Climative repo with thirty teammate
 * branches open would spend a quarter of an hour finding out about pull requests it was
 * never going to touch. So the cheap question goes first, and the expensive one is only
 * ever asked about a branch this Mac has some business merging into.
 */
import { beadsFor, candidateTiers, prefixFor } from './beadref.js';
import { OBSERVING, OBSERVING_NOTE } from './config.js';
import { ownerName } from './owner.js';
import * as pr from './pr.js';
import { authorOf } from './prauthor.js';
import { resolveFor } from './resolvers.js';
import { openConflictSession } from './session.js';

/** How many open pull requests to ask a repo for. A cap on the query, not on the answer. */
const QUERY_LIMIT = 40;

/**
 * How many pull requests are asked about at once.
 *
 * Six, the same as lib/prboard.js's sweep and for the same reason: each one is a `gh`
 * subprocess, which is a node process, and forty of those at once is a laptop that
 * notices. What is different here is that each of these may *wait* — `mergeability`
 * polls for up to thirty seconds — so the concurrency is what keeps a repo with a dozen
 * conflicted branches to one wait rather than a dozen of them end to end.
 */
const AT_ONCE = 6;

/** The one line of an error worth carrying on a result. */
const oneLine = (err) => String(err?.message || err || 'unknown error').split('\n')[0].trim();

/**
 * One pull request as everything downstream names it — the card, the log, the failure.
 *
 * `beads` is only ever set on the rows this sweep *acted* on, and it is the one field
 * here that is not off the pull request: it is what `oursOf` decided the branch carries.
 * lib/sweepcard.js needs it for two things a pull request number cannot supply — which
 * P0 the card it files belongs under (lib/homing.js), and what to call the branch on a
 * card somebody is reading three hours later.
 */
const brief = (row, beads = null) => ({
  number: row.number,
  branch: row.branch || '',
  title: row.title || '',
  url: row.url || '',
  ...(beads ? { beads: beads.map((b) => b.id).filter(Boolean) } : {}),
});

/**
 * `Promise.all` with a ceiling, order in the order out — the same helper lib/prboard.js
 * keeps for the same reason, and deliberately not imported from it: that one is private
 * to a file about drawing a board, and this file is about acting on one.
 */
async function atMost(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(n, items.length)) }, worker));
  return out;
}

/**
 * Is this pull request ours to merge a base into?
 *
 * Two tests, either of which is enough, and a pull request with neither is a human's:
 *
 * - **The tracker resolves a bead the pull request is *for*.** `beadsFor` is the one
 *   implementation of that question (lib/beadref.js), tiered so that a bead named in a
 *   delivery block or a branch tag outranks one merely mentioned in a body — which is
 *   the difference between the pull request a worker opened and the one whose
 *   description ends "this unblocks bc-2tr, which nothing here touched".
 * - **A session archived in this repo worked this exact branch.**
 *   `refs/beadcause/sessions/<bead>` is written when a session ends, it names the
 *   branch, and lib/prauthor.js matches on it. `matched: true` is the whole of what is
 *   accepted here: a session on the same bead that worked a *different* branch is a real
 *   answer for an attribution line and no evidence at all about this branch.
 *
 * The second is not decoration for the first, and the case it carries is a live one:
 * `beadsFor` verifies ids against the tracker, and embedded Dolt is single-writer with
 * twenty sessions sharing this laptop. A lock collision makes it answer `[]` for a pull
 * request a worker opened this morning — at which point, without the archive, the sweep
 * would decide our own branch belonged to a stranger and walk past it. So the ids the
 * row *names* (`candidateTiers`, the same tiers, before the tracker gets a vote) are
 * what the archive is searched under, and git answers when `bd` cannot.
 *
 * Never throws for a pull request's sake, and every uncertain answer is a **no**. The
 * cost of a wrong yes is a window opened on somebody else's branch; the cost of a wrong
 * no is a red chip that was already there.
 */
export async function oursOf(bd, ws, dir, prefix, row, seen, author = authorOf) {
  let beads = [];
  try {
    beads = await beadsFor(bd, ws, prefix, row, seen);
  } catch {
    beads = [];
  }
  if (beads.length) return { ours: true, why: `carries ${beads.map((b) => b.id).join(', ')}`, beads };

  const nobody = { ours: false, why: 'no bead named and no session archived for this branch', beads: [] };
  const named = candidateTiers(row, prefix).flat();
  if (!named.length) return nobody;
  let found;
  try {
    found = await author(dir, { ...row, beads: named });
  } catch {
    return { ...nobody, why: 'no bead this tracker would confirm, and the archive could not be read' };
  }
  if (found?.kind === 'session' && found.matched) {
    return {
      ours: true,
      why: `a session archived under ${found.bead} worked ${row.branch}`,
      // The bead is carried through so the brief can name it. The tracker would not
      // confirm it, but the archive says a session of ours worked this branch under it,
      // and a resolver told which bead it is on starts further along than one that is not.
      beads: found.bead ? [{ id: found.bead, title: '', status: '' }] : [],
    };
  }
  return nobody;
}

/**
 * The question a queued pull request is asked at the moment its window would open.
 *
 * `resolveFor` takes this because a queued entry can wait an hour, and everything that
 * clears a conflict — another resolver pushing, a merge from the phone — is more likely
 * to happen during that hour than before it. Asked through `mergeability` rather than a
 * bare `view` for the same reason the first read is: a slot freeing seconds after some
 * other merge landed finds `UNKNOWN` too.
 */
const stillConflicting = (dir, number, ask) => async () => {
  const { pr: latest } = await ask(dir, number);
  if (latest.state !== 'OPEN') {
    return `#${number} was ${
      latest.state === 'MERGED' ? 'merged' : 'closed'
    } while it waited for a window — no conflict left to resolve`;
  }
  if (latest.mergeable !== 'CONFLICTING') {
    return `#${number} stopped conflicting while it waited for a window — nothing needs rebasing`;
  }
  return true;
};

/** The empty result, so every field exists whatever happened. Callers read it, not `undefined`. */
const blank = (key, base, after) => ({
  key,
  repo: null,
  base: String(base || ''),
  after: Number.isInteger(after) ? after : null,
  /** A sentence when the whole sweep was declined, null when it ran. */
  refused: null,
  /** A sentence when it ran and could not finish — `gh` unreachable, no such checkout. */
  error: null,
  open: 0,
  checked: 0,
  conflicting: [],
  mergeable: [],
  unresolved: [],
  theirs: [],
  drafts: [],
  handed: [],
  queued: [],
  reused: [],
  /** Something already has it and cannot be spoken to — a window, not a failure. */
  unreachable: [],
  failed: [],
  trouble: [],
  waitedMs: 0,
});

/** What the daemon's log gets: one line, and only when there was something to say. */
function said(out) {
  return [
    out.handed.length ? `opened ${out.handed.map((r) => `#${r.number}`).join(', ')}` : '',
    out.queued.length ? `queued ${out.queued.map((r) => `#${r.number}`).join(', ')}` : '',
    out.reused.length ? `told the session already on ${out.reused.map((r) => `#${r.number}`).join(', ')}` : '',
    out.unreachable.length
      ? `left ${out.unreachable.map((r) => `#${r.number}`).join(', ')} to the window already on ${out.unreachable.length === 1 ? 'it' : 'them'}`
      : '',
    out.failed.length ? `could not open ${out.failed.map((r) => `#${r.number}`).join(', ')}` : '',
    out.theirs.length ? `left ${out.theirs.length} not ours alone` : '',
    out.drafts.length ? `${out.drafts.length} draft${out.drafts.length === 1 ? '' : 's'} skipped` : '',
    out.unresolved.length ? `GitHub would not answer about ${out.unresolved.map((r) => `#${r.number}`).join(', ')}` : '',
    out.trouble.length ? `${out.trouble.length} could not be read` : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * Sweep one repo for the pull requests a merge has just put into conflict, and hand the
 * ones that are ours to lib/resolvers.js.
 *
 * `ws` is the workspace (its tracker is what a bead is looked up in), `unit` is the repo
 * within it — `unit.key` is what the resolver serialises on, because a pull request
 * number is only unique within a repo and two Climative services both have a #1. `dir`
 * is the checkout. `after` is the number of the pull request whose merge set this off,
 * and it is not bookkeeping: it is what the resolver's brief says instead of claiming
 * Adam pressed a button (see `sweptAfter` in `conflictPromptFor`). `base` narrows the
 * candidates to pull requests actually aimed at the branch that moved — a stacked pull
 * request based on a feature branch is not affected by a merge into `main`, and opening
 * a resolver for it would merge the wrong base in.
 *
 * **It never throws.** Every caller is a merge that has already succeeded, and turning a
 * landed merge into an error because `gh` blinked would be the sweep doing more damage
 * than the conflicts it exists to clear. Failures land *in* the result: `refused` for
 * the two configured refusals, `error` for a sweep that could not run, `trouble` for the
 * pull requests it could not read, `failed` for the windows that would not open.
 *
 * The handover is deliberately **sequential**. `resolveFor`'s lock is per pull request,
 * so the global cap of two live resolvers is the one thing two concurrent calls could
 * both walk past — they would each read a count of one and each open a window. One at a
 * time costs nothing here (the launch is the slow part and it is bounded at two anyway)
 * and it is what makes the cap mean what it says.
 *
 * Everything reaching GitHub or iTerm is a parameter with a real default, for the reason
 * `say` and `probe` are parameters in lib/resolvers.js: the decisions in this file are
 * worth a test, and nothing in this repo's tests may open a window. `say` is the one
 * that is passed *through* rather than used here — it is how a session that already has
 * a pull request gets told, and it is only forwarded when a caller gives one, so the
 * default stays `resolveFor`'s own.
 */
export async function sweepConflicts(
  bd,
  cfg,
  {
    ws = null,
    unit = null,
    dir = '',
    after = null,
    base = '',
    limit = QUERY_LIMIT,
    atOnce = AT_ONCE,
    list = pr.list,
    mergeability = pr.mergeability,
    slugFor = pr.slugFor,
    author = authorOf,
    resolve = resolveFor,
    open = openConflictSession,
    say = null,
  } = {}
) {
  const key = unit?.key || ws?.name || '';
  const out = blank(key, base, after);
  const started = Date.now();

  // Both refusals ahead of every read, unlike `/api/pr/conflicts` — which checks the
  // pull request first so that "openSessions is disabled" is never the answer to a
  // question about a conflict that is not there. Nobody asked this one anything, so
  // there is no question to answer well: the honest order is cheapest-first.
  if (OBSERVING) return { ...out, refused: OBSERVING_NOTE };
  if (cfg?.openSessions === false) return { ...out, refused: 'openSessions is disabled in config' };
  if (!ws || !dir) return { ...out, refused: 'no workspace or checkout to sweep' };

  let rows;
  try {
    rows = await list(dir, { state: 'open', limit });
  } catch (err) {
    return { ...out, error: oneLine(err), waitedMs: Date.now() - started };
  }
  out.open = rows.length;

  const candidates = rows.filter((row) => {
    // The merge that caused this. GitHub still lists it open for a moment after a merge,
    // and it is the one pull request in the repo that certainly needs nothing.
    if (out.after && row.number === out.after) return false;
    // Aimed somewhere else. A merge into `main` says nothing about a branch based on
    // `release-2`, and `conflictPromptFor` would send a resolver to merge `main` into it.
    if (out.base && row.base && row.base !== out.base) return false;
    return true;
  });
  out.checked = candidates.length;

  const prefix = await prefixFor(bd, ws).catch(() => null);
  /** `beadsFor`'s memo, shared across the whole sweep — half a dozen rows naming one bead is normal. */
  const seen = new Map();

  const mine = [];
  for (const row of candidates) {
    if (row.draft) {
      out.drafts.push(brief(row));
      continue;
    }
    let verdict;
    try {
      verdict = await oursOf(bd, ws, dir, prefix, row, seen, author);
    } catch (err) {
      out.trouble.push({ ...brief(row), why: oneLine(err) });
      continue;
    }
    if (!verdict.ours) {
      out.theirs.push({ ...brief(row), why: verdict.why });
      continue;
    }
    mine.push({ row, beads: verdict.beads, why: verdict.why });
  }

  // Now the expensive question, and only about branches we would act on. `mergeability`
  // is what makes this a sweep rather than a re-read of the board: the row's own
  // `mergeable` is whatever GitHub said before the merge landed, which for the pull
  // requests this exists to find is the one answer guaranteed to be out of date.
  const measured = await atMost(mine, atOnce, async (entry) => {
    try {
      const { pr: latest, unresolved } = await mergeability(dir, entry.row.number);
      return { ...entry, latest, unresolved };
    } catch (err) {
      return { ...entry, error: oneLine(err) };
    }
  });

  const conflicting = [];
  for (const m of measured) {
    if (m.error) {
      out.trouble.push({ ...brief(m.row), why: m.error });
      continue;
    }
    if (m.unresolved) {
      // Not a conflict. `UNKNOWN` is the absence of GitHub having said anything, and a
      // window opened on the strength of one is a window opened on a guess.
      out.unresolved.push(brief(m.row));
      continue;
    }
    if (m.latest.state !== 'OPEN') continue; // Merged or closed while we were asking.
    if (m.latest.mergeable !== 'CONFLICTING') {
      out.mergeable.push(brief(m.row));
      continue;
    }
    conflicting.push(m);
    out.conflicting.push({ ...brief(m.row), why: m.why });
  }

  if (!conflicting.length) {
    out.waitedMs = Date.now() - started;
    return out;
  }

  // One `gh` for the whole sweep, and only once there is a brief to write: the slug is
  // what `conflictPromptFor` names the repo as, and a sweep that found nothing should
  // cost nothing.
  out.repo = await slugFor(dir).catch(() => null);

  for (const c of conflicting) {
    const row = {
      ...c.latest,
      repo: out.repo || null,
      repoName: unit?.repo?.name || null,
      beads: c.beads,
    };
    let outcome;
    try {
      outcome = await resolve(key, row.number, () => open(cfg, ws, row, { dir, sweptAfter: out.after }), {
        branch: row.branch,
        owner: ownerName(cfg),
        recheck: stillConflicting(dir, row.number, mergeability),
        // The same fact the brief gets, for the same reason and the other half of the
        // same path: a pull request that already has a resolver is told *why it is being
        // asked again*, and "Adam pressed Resolve conflicts" is false of every window
        // this loop is responsible for. See `nudgeMessage` in lib/resolvers.js (bc-9d37.6).
        sweptAfter: out.after,
        // Only when a caller supplied one — `resolveFor`'s own default is
        // `messageSession`, and passing `null` through would replace it with nothing
        // and turn "a session already has this" into a TypeError.
        ...(say ? { say } : {}),
      });
    } catch (err) {
      // A throw travels out of `resolveFor` untouched on the un-queued path — iTerm
      // refusing the Apple event, a checkout that has moved. One window that did not
      // open, and the ones behind it still should.
      out.failed.push({ ...brief(row, c.beads), why: oneLine(err) });
      continue;
    }
    // `held` says the reason nothing opened is that something already has it — and the
    // sweep, unlike a thumb, must not file that as a failure. It is the ordinary state of
    // a branch a previous sweep already handed over, and after a daemon restart it is the
    // *only* state it can be in, because the handle went with the process. Calling it
    // `could not open` is what let bc-9d37.11 read as thirteen unlucky sweeps instead of
    // one missing file.
    if (outcome.error && outcome.held) out.unreachable.push({ ...brief(row, c.beads), why: outcome.error });
    else if (outcome.error) out.failed.push({ ...brief(row, c.beads), why: outcome.error });
    else if (outcome.reused) out.reused.push({ ...brief(row, c.beads), note: outcome.note || '' });
    else if (outcome.queued) out.queued.push({ ...brief(row, c.beads), place: outcome.queued.place, note: outcome.note || '' });
    else out.handed.push({ ...brief(row, c.beads), opened: outcome.opened || null });
  }

  out.waitedMs = Date.now() - started;
  const line = said(out);
  if (line) console.log(`[prsweep] ${key}${out.after ? ` after #${out.after}` : ''}: ${line}`);
  return out;
}
