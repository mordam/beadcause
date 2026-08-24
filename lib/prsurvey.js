/**
 * What the open pull requests are actually doing — and whether a red check is even
 * current. bc-4r10.19.
 *
 * Three sessions (bc-4r10.1, bc-khoe.30.6, bc-khoe.30.5) each hand-assembled a
 * different subset of this with raw `gh` calls, because the answer already exists in
 * lib/pr.js and lib/beadref.js and nothing exported it to a command. This is that
 * export: pure folding here, the `gh`/`bd` calls it composes stay in lib/pr.js and
 * lib/beadref.js, and bin/b7e-inflight is argv parsing and printing around it — the
 * same split as lib/siblings.js and bin/b7e-siblings.
 *
 * Named `prsurvey`, not `inflight` — lib/inflight.js already exists and answers a
 * different question (which *bead* is held behind an open PR, for the advocate). This
 * module is read *by* nobody upstream of a command line; it never decides whether a
 * session opens, so there is no reason for the two to share a name or a file.
 *
 * The one rule this file exists to enforce: **a red check is a fact about the
 * *branch* only when the branch is the thing that has changed since.** GitHub builds
 * `refs/pull/N/merge`, so a check run is a verdict against the base *as it stood when
 * the run fired* — bc-4r10.1's whole finding was a red check from three days and 593
 * commits ago, on a branch nothing had been pushed to since, being read as this
 * branch's own breakage. `stale` below is what tells the two apart, and it does it
 * from a number GitHub already answers (`commitsBetween`), not from a wall-clock
 * guess.
 *
 * **Unknown is a third answer, not a rounding error toward the other two.** A `gh`
 * call that fails — network, an unreached repo, a deleted branch's dangling sha — must
 * read as "could not tell", never silently as "no problem" (an empty result reading as
 * clean) or "not touched" (a files search reading as excluded). See `filesTouched`'s
 * caller below for the one case that actually happens in practice: `--files` narrowing
 * a PR whose diff could not be fetched is *kept*, flagged `filesUnknown`, rather than
 * dropped — bc-khoe.30.6's PRs did not stop touching `public/monitor.js` just because
 * this call had a bad five seconds.
 */
import { commitsBetween, filesTouched, list, listMergedSince, view, viewDetail } from './pr.js';
import { beadsFor, prefixFor } from './beadref.js';

/**
 * How many commits the base is ahead of the head — GitHub's own count, not a guess
 * from a local clock.
 *
 * `commitsBetween(dir, headSha, base)` asks GitHub to compare `headSha...base`, so
 * `total` is exactly the number of commits on `base` that are not reachable from
 * `headSha` — which is "how far behind" regardless of whether the two have also
 * diverged (a branch with unmerged commits of its own is the ordinary case, and
 * GitHub still answers `diverged` with the same list). `null` in, `null` out: the
 * caller could not compare (network, a branch whose sha has been garbage-collected
 * since the merge) and that is a fact to report, not zero to assume.
 */
export function behindOf(compare) {
  if (!compare || !Array.isArray(compare.commits)) return null;
  // `.commits` is a page, `.total` is the count — GitHub's compare endpoint stops
  // listing at 250 and reports the real figure in `total_commits` beside it, so
  // `commits.length` saturates at exactly 250 for every branch far enough behind to
  // be worth saying so about. bc-4r10.1's branch was 593 behind; measured on this
  // repo, `4ea4b599...main` is 348 and lists 250. Read the count.
  return Number.isFinite(compare.total) ? compare.total : compare.commits.length;
}

/**
 * Is a *completed* check verdict about a base that has since moved on?
 *
 * Deliberately not "is this check red" — pending checks are already their own state
 * (`checks.state === 'pending'`) and a stale marker on top of that would just be
 * restating "wait". This is the narrower claim bc-4r10.1 needed made explicit: the
 * run finished, and the base it ran against is no longer the tip of `main`.
 *
 * Only `failing` and `passing` are "completed" for this question. `pending` is
 * already its own state and a marker on top would just restate "wait"; `none` means
 * nothing ran at all, and there is no verdict there to be stale about.
 */
export function staleOf(checksState, behind) {
  if (checksState !== 'failing' && checksState !== 'passing') return false;
  return Number.isFinite(behind) && behind > 0;
}

/** Exact match against a pull request's touched files — no prefix, no glob. */
export function touchesAny(touched, files) {
  if (!Array.isArray(touched) || !files || !files.length) return false;
  return touched.some((f) => files.includes(f));
}

/**
 * How wide the sweep may go, and how much of it may be in the air at once.
 *
 * `OPEN_LIMIT` is a ceiling that must be *above* the answer rather than a page size:
 * this repo had 43 open pull requests and 661 in total on 2026-08-23, so 400 is far
 * past any plausible open count while still being a number `gh` will refuse to exceed
 * silently — and `sweepFor` compares the rows it got against it, so a repo that ever
 * does exceed it is reported truncated rather than trimmed.
 *
 * `DEFAULT_SINCE_DAYS` is the merged half of a `--bead`/`--files` survey. Every merged
 * pull request back to the repo's first one is not the question either flag asks —
 * "who else is mid-edit on this file" and "which pull request delivered this bead" are
 * both about recent history — and it is not free: 278 pull requests merged here in the
 * seven days to 2026-08-23, and `--files` costs one `gh pr diff` each. A fortnight
 * covers the case the acceptance criteria name (#433 merged four days before this was
 * written) with room to spare, and `--since` widens it for anyone who needs more.
 *
 * `DIFF_CONCURRENCY` exists because the old code fired one `gh` process per row with no
 * bound at all. Twelve is a compromise measured rather than guessed: `--files
 * public/monitor.js` over 45 open + 612 merged took 1m39s on 2026-08-23, which is the
 * price of an answer that contains #433 instead of a fast one that does not. `--since`
 * is the dial for anyone who wants the cheap version.
 */
export const OPEN_LIMIT = 400;
export const DEFAULT_SINCE_DAYS = 14;
const DIFF_CONCURRENCY = 12;

/** `fn` over every item, at most `n` in flight, answers in the input's order. */
async function mapLimited(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next;
      next += 1;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * Could this row *possibly* resolve to `beadId`? — the cheap half of `--bead`.
 *
 * `beadsFor` is the authority and still decides, but it shells `bd show` per distinct
 * id and a `--bead` sweep now spans several hundred rows. Every id `candidateTiers`
 * can produce comes from one of four places, and three of them are literal text in the
 * row; the fourth is the branch-tail guess (`worktree-…-jin` → `<prefix>-jin`), which
 * is why that is reconstructed here rather than searched for. So this is a superset of
 * what `beadsFor` could answer — it never narrows the result, it only decides who is
 * worth asking the tracker about.
 */
export function mentionsBead(row, prefix, beadId) {
  const id = String(beadId || '').toLowerCase();
  if (!id) return false;
  const hay = `${row.title || ''}\n${row.branch || ''}\n${row.body || ''}`.toLowerCase();
  if (hay.includes(id)) return true;
  const tail = String(row.branch || '').split('-').pop();
  return !!prefix && /^[a-z0-9]{2,10}$/i.test(tail || '') && `${prefix}-${tail}`.toLowerCase() === id;
}

/**
 * The pull requests a sweep starts from — and, beside them, what the sweep did *not*
 * cover.
 *
 * **This is the comment's own bug, so it is written out.** The first version asked
 * `list(dir, { state: beadId || files ? 'all' : 'open', limit: 100 })` and returned the
 * page it got as if it were the answer. On this repo `gh pr list --state all --limit
 * 100` stops at #562 out of 661, so `--files public/monitor.js` printed five pull
 * requests and omitted #433 — the one the acceptance criteria name by number — while
 * `--bead` on anything older printed "(nothing matches)" and exited 0. A truncated
 * sweep read exactly like a complete one, which is the same "unknown rounded to a
 * comfortable answer" this file's header refuses everywhere else.
 *
 * So the sweep is now built from two calls whose coverage is *checkable*, and it says
 * which:
 *
 * - **open** — `list(state: 'open')` at a limit above any real open count, and a full
 *   page is treated as evidence of more rather than as the answer;
 * - **merged, within a window** — `listMergedSince`, which already bisects its own
 *   date range when a slice comes back full and already reports `complete`/`cap`
 *   (lib/landed.js asks it the same question for the same reason).
 *
 * `scope.complete: false` is the honest half: the caller prints it, and nobody reads a
 * short list as a whole one. A single `<number>` needs neither call and is always
 * complete — `view` is not a page of anything.
 *
 * **Open plus merged is not "every state", and the scope line is why that is allowed.**
 * A pull request closed *without* merging is in neither half. That is a narrowing, and
 * the difference between this narrowing and the one that was wrong is that this one is
 * printed: every run leads with "searched N open + M merged in the last D days", so an
 * empty answer is read against the sweep that produced it rather than against an
 * imagined complete one. Ask for a closed-unmerged pull request by number.
 */
export async function sweepFor(dir, { number = null, beadId = null, files = null, sinceDays = DEFAULT_SINCE_DAYS, openLimit = OPEN_LIMIT } = {}) {
  if (number) {
    return { rows: [await view(dir, number)], scope: { mode: 'one', open: 1, merged: 0, since: null, sinceDays: null, complete: true, cap: null } };
  }

  const open = await list(dir, { state: 'open', limit: openLimit });
  // A full page is evidence GitHub had more to say, never the answer — this is the whole
  // of what the old `limit: 100` did not do. `openLimit` is a parameter only so a test
  // can reach this line with four rows instead of four hundred.
  const openComplete = open.length < openLimit;

  if (!beadId && (!files || !files.length)) {
    return { rows: open, scope: { mode: 'open', open: open.length, merged: 0, since: null, sinceDays: null, complete: openComplete, cap: openComplete ? null : openLimit } };
  }

  // A bead can name a pull request that already merged, and the collision bc-khoe.30.6
  // was hunting was in a pull request whose worktree had already been retired — so the
  // merged half is not optional for either flag. It is bounded by date, not by a row
  // count, because a date is a fact a caller can read off the output and widen.
  const since = Date.now() - Math.max(1, Number(sinceDays) || DEFAULT_SINCE_DAYS) * 86400000;
  const merged = await listMergedSince(dir, { since });
  const byNumber = new Map();
  for (const r of [...open, ...merged.rows]) if (!byNumber.has(r.number)) byNumber.set(r.number, r);

  return {
    rows: [...byNumber.values()],
    scope: {
      mode: 'window',
      open: open.length,
      merged: merged.rows.length,
      since: new Date(since).toISOString(),
      sinceDays: Math.max(1, Number(sinceDays) || DEFAULT_SINCE_DAYS),
      complete: openComplete && merged.complete,
      cap: openComplete ? merged.cap : openLimit,
    },
  };
}

/**
 * One row's full picture: the PR as `pr.js` already normalises it, plus the bead(s)
 * it names, the behind-count, and staleness — everything a caller of this module
 * needs to stop treating a red check as a fact about the diff.
 *
 * **Only survivors get here.** The behind-count is one `gh api compare` and the beads
 * are one `bd show` per distinct id, and paying either over a several-hundred-row
 * sweep to then throw the row away in a filter is how the old fixed page size came to
 * look affordable. Narrow first; enrich what is left.
 *
 * `listMergedSince` answers with `MERGED_FIELDS`, which carries no `headRefOid` and no
 * check rollup — the board never needed either about a merge. A row that reaches here
 * without a head sha is therefore re-read in full with `viewDetail`, one call, so that
 * a merged row prints the same sha and the same check line as an open one instead of
 * a blank where the sha should be.
 *
 * `beads` is `[]` rather than unset when there is no tracker to ask (`prefix` null) —
 * an absent answer and a checked-and-found-nothing answer must print differently
 * downstream, and only the caller that has a `bd`/`ws` can tell them apart, so this
 * never guesses at which one it got.
 */
async function rowFor(dir, prRow, { bd, ws, prefix, seen, touched = null, filesUnknown = false }) {
  let full = prRow;
  if (!prRow.headSha) {
    try {
      full = { ...(await viewDetail(dir, prRow.number)), body: prRow.body ?? '' };
    } catch {
      full = prRow;
    }
  }

  const beads = prefix ? await beadsFor(bd, ws, prefix, full, seen) : [];

  const compare = await commitsBetween(dir, full.headSha, full.base || 'main').catch(() => null);
  const behind = behindOf(compare);
  // Staleness is a claim about a verdict that could still change — "this red is about a
  // base that has moved, so re-run it before believing it". Nothing about a MERGED or
  // CLOSED pull request is going to be re-run, and the marker there would only be noise
  // in a survey whose merged half exists to show a collision, not to be judged.
  const stale = full.state === 'OPEN' && staleOf(full.checks.state, behind);

  return {
    number: full.number,
    url: full.url,
    title: full.title,
    branch: full.branch,
    base: full.base,
    state: full.state,
    draft: full.draft,
    mergeable: full.mergeable,
    mergeState: full.mergeState,
    headSha: full.headSha,
    updatedAt: full.updatedAt || null,
    mergedAt: full.mergedAt || null,
    beads,
    checks: full.checks,
    behind,
    stale,
    touchedFiles: touched,
    filesUnknown,
  };
}

/**
 * The rows this command prints, over one repo checkout.
 *
 * Three shapes, matching the bead's "Takes" line exactly: one number (`view`), every
 * open pull request, or `--bead`/`--files` over open plus recently-merged — see
 * `sweepFor` for what "recently" means and for why a fixed page of 100 was wrong.
 *
 * The order is narrow-then-enrich, and it is load-bearing rather than tidy: `--bead`
 * throws away every row that could not name that bead by text before a single `bd show`
 * is made, and `--files` runs its diffs at a bounded concurrency and keeps only what
 * matched, so the compare call behind every behind-count is paid once per *answer*
 * rather than once per candidate.
 *
 * **Never returns an empty `rows` for "nothing to report" and a failure the same way.**
 * `reachable: false` is the unknown-not-clean rule at the top of this file, applied to
 * the whole sweep rather than one row: no usable `gh`, no GitHub repo visible from
 * `dir`, or one of the sweep's own calls failing (a transient GraphQL blip is a real,
 * measured shape here — see lib/pr.js's `isTransientErr`). A caller must not read
 * `{ reachable: false, rows: [] }` as "no open pull requests"; it means this could not
 * ask. `scope.complete: false` is the weaker cousin of the same rule: it *did* ask, and
 * what came back is known not to be all of it.
 */
export async function inflightRows(dir, { number = null, beadId = null, files = null, sinceDays = DEFAULT_SINCE_DAYS, openLimit = OPEN_LIMIT, bd = null, ws = null, available } = {}) {
  const ok = available ? await available() : { ok: true, reason: '' };
  if (!ok.ok) return { reachable: false, reason: ok.reason, scope: null, rows: [] };

  const prefix = bd && ws ? await prefixFor(bd, ws) : null;
  const seen = new Map();

  let sweep;
  try {
    sweep = await sweepFor(dir, { number, beadId, files, sinceDays, openLimit });
  } catch (err) {
    return { reachable: false, reason: String(err?.message || err || 'gh refused the list'), scope: null, rows: [] };
  }

  let candidates = sweep.rows;
  if (beadId) candidates = candidates.filter((r) => mentionsBead(r, prefix, beadId));

  let narrowed = candidates.map((r) => ({ row: r, touched: null, filesUnknown: false }));
  if (files && files.length) {
    narrowed = await mapLimited(candidates, DIFF_CONCURRENCY, async (r) => {
      try {
        return { row: r, touched: await filesTouched(dir, r.number), filesUnknown: false };
      } catch {
        return { row: r, touched: null, filesUnknown: true };
      }
    });
    // A row whose diff could not be fetched is KEPT, flagged, never dropped — dropping
    // it would read exactly like "confirmed not to touch these files", which is the one
    // thing this has no grounds to say. See the header note.
    narrowed = narrowed.filter((c) => c.filesUnknown || touchesAny(c.touched, files));
  }

  let rows = await Promise.all(narrowed.map((c) => rowFor(dir, c.row, { bd, ws, prefix, seen, touched: c.touched, filesUnknown: c.filesUnknown })));

  // The tracker has the last word on `--bead`: `mentionsBead` above only decided who was
  // worth a `bd show`, and an id written in a body that no tracker has is not a match.
  if (beadId) rows = rows.filter((r) => r.beads.some((b) => b.id === beadId));

  rows.sort((a, b) => b.number - a.number);
  return { reachable: true, reason: '', scope: sweep.scope, rows };
}

/**
 * One line saying what was actually searched — printed above the rows, always, because
 * the size of a sweep is the context its emptiness has to be read in.
 *
 * "(nothing matches)" under a sweep of 43 open pull requests means something; under a
 * sweep that GitHub cut off it means nothing at all, and the old code could not tell
 * the reader which one they were looking at.
 */
export function describeScope(scope) {
  if (!scope) return '';
  if (scope.mode === 'one') return '';
  const cut = scope.complete ? '' : ` — INCOMPLETE: GitHub capped this sweep (${scope.cap}); widen or narrow it, and do not read the result as all of them`;
  if (scope.mode === 'open') return `searched ${scope.open} open pull request${scope.open === 1 ? '' : 's'}${cut}`;
  return `searched ${scope.open} open + ${scope.merged} merged in the last ${scope.sinceDays} days (since ${String(scope.since).slice(0, 10)})${cut}`;
}

/** One line of check-state prose, the staleness rule spelled out rather than a bare verdict. */
export function describeChecks(row) {
  const { checks, behind, stale } = row;
  const at = checks.at || 'unknown time';
  const against = row.headSha ? row.headSha.slice(0, 8) : 'unknown sha';
  const behindTxt = behind === null ? 'behind main: unknown (could not compare)' : `${behind} commit${behind === 1 ? '' : 's'} behind ${row.base || 'main'}`;
  // The behind-count rides along even where there is no verdict to qualify. "How far
  // behind is this" is the other half of the question this command exists for — a PR
  // with no checks at all and 280 commits of drift under it is worth knowing about,
  // and the first version dropped the number the moment there was no red to attach it
  // to.
  if (checks.state === 'none') return `no checks reported — ${behindTxt}`;
  if (checks.state === 'pending') return `${checks.pending}/${checks.total} checks still running — ${behindTxt}`;
  if (checks.state === 'failing') {
    const names = checks.failed.length ? ` (${checks.failed.join(', ')})` : '';
    const base = `${checks.failing} failing${names} — ran ${at} against ${against}, ${behindTxt}`;
    return stale
      ? `${base} — STALE: this base has moved since, so the red is not (yet) a fact about this branch's own diff`
      : base;
  }
  return `passing — ran ${at} against ${against}, ${behindTxt}`;
}
