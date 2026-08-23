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
import { commitsBetween, filesTouched, list, view } from './pr.js';
import { beadsFor, prefixFor } from './beadref.js';

/**
 * How many commits the base is ahead of the head — GitHub's own count, not a guess
 * from a local clock.
 *
 * `commitsBetween(dir, headSha, base)` asks GitHub to compare `headSha...base`, so
 * `commits` is exactly the commits on `base` that are not reachable from `headSha` —
 * which is "how far behind" in commit count regardless of whether the two have also
 * diverged (a branch with unmerged commits of its own is the ordinary case, and
 * GitHub still answers `diverged` with the same list). `null` in, `null` out: the
 * caller could not compare (network, a branch whose sha has been garbage-collected
 * since the merge) and that is a fact to report, not zero to assume.
 */
export function behindOf(compare) {
  if (!compare || !Array.isArray(compare.commits)) return null;
  return compare.commits.length;
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
 * One row's full picture: the PR as `pr.js` already normalises it, plus the bead(s)
 * it names, the behind-count, and staleness — everything a caller of this module
 * needs to stop treating a red check as a fact about the diff.
 *
 * `beads` is `[]` rather than unset when there is no tracker to ask (`prefix` null) —
 * an absent answer and a checked-and-found-nothing answer must print differently
 * downstream, and only the caller that has a `bd`/`ws` can tell them apart, so this
 * never guesses at which one it got.
 */
async function rowFor(dir, prRow, { bd, ws, prefix, seen, files }) {
  const beads = prefix ? await beadsFor(bd, ws, prefix, prRow, seen) : [];

  const compare = await commitsBetween(dir, prRow.headSha, prRow.base || 'main').catch(() => null);
  const behind = behindOf(compare);
  const stale = staleOf(prRow.checks.state, behind);

  let touched = null;
  let filesUnknown = false;
  if (files && files.length) {
    try {
      touched = await filesTouched(dir, prRow.number);
    } catch {
      filesUnknown = true;
    }
  }

  return {
    number: prRow.number,
    url: prRow.url,
    title: prRow.title,
    branch: prRow.branch,
    base: prRow.base,
    state: prRow.state,
    draft: prRow.draft,
    mergeable: prRow.mergeable,
    mergeState: prRow.mergeState,
    headSha: prRow.headSha,
    updatedAt: prRow.updatedAt || null,
    beads,
    checks: prRow.checks,
    behind,
    stale,
    touchedFiles: touched,
    filesUnknown,
  };
}

/**
 * The rows this command prints, over one repo checkout.
 *
 * Three shapes for `base_rows`, matching the bead's "Takes" line exactly: one number
 * (`view`), everything (`list`, `state: 'open'` unless a filter needs the merged/closed
 * ones too), or `--bead`/`--files` narrowing what `list` already returned. `--bead` and
 * `--files` both search `state: 'all'` — a bead can name a PR that already merged
 * (lib/beadref.js is asked the same question by lib/landed.js for exactly that reason),
 * and a `--files` survey is the "who else is touching this" question bc-khoe.30.6 asked,
 * which cares about DIRTY open PRs specifically but is not wrong to also surface a
 * recently-merged collision.
 *
 * **Never returns an empty `rows` for "nothing to report" and a failure the same way.**
 * `reachable: false` is the unknown-not-clean rule at the top of this file, applied to
 * the whole sweep rather than one row: no usable `gh`, no GitHub repo visible from
 * `dir`, or the one `list`/`view` call itself failing (a transient GraphQL blip is a
 * real, measured shape here — see lib/pr.js's `isTransientErr`). A caller must not read
 * `{ reachable: false, rows: [] }` as "no open pull requests"; it means this could not
 * ask.
 */
export async function inflightRows(dir, { number = null, beadId = null, files = null, bd = null, ws = null, available } = {}) {
  const ok = available ? await available() : { ok: true, reason: '' };
  if (!ok.ok) return { reachable: false, reason: ok.reason, rows: [] };

  const prefix = bd && ws ? await prefixFor(bd, ws) : null;
  const seen = new Map();

  let baseRows;
  try {
    if (number) baseRows = [await view(dir, number)];
    else baseRows = await list(dir, { state: beadId || files ? 'all' : 'open', limit: 100 });
  } catch (err) {
    return { reachable: false, reason: String(err?.message || err || 'gh refused the list'), rows: [] };
  }

  let rows = await Promise.all(baseRows.map((r) => rowFor(dir, r, { bd, ws, prefix, seen, files })));

  if (beadId) rows = rows.filter((r) => r.beads.some((b) => b.id === beadId));
  if (files && files.length) {
    // A row whose diff could not be fetched is KEPT, flagged, never dropped — dropping
    // it would read exactly like "confirmed not to touch these files", which is the one
    // thing this has no grounds to say. See the header note.
    rows = rows.filter((r) => r.filesUnknown || touchesAny(r.touchedFiles, files));
  }

  return { reachable: true, reason: '', rows };
}

/** One line of check-state prose, the staleness rule spelled out rather than a bare verdict. */
export function describeChecks(row) {
  const { checks, behind, stale } = row;
  if (checks.state === 'none') return 'no checks reported';
  if (checks.state === 'pending') return `${checks.pending}/${checks.total} checks still running`;
  const at = checks.at || 'unknown time';
  const against = row.headSha ? row.headSha.slice(0, 8) : 'unknown sha';
  const behindTxt = behind === null ? 'behind main: unknown (could not compare)' : `${behind} commit${behind === 1 ? '' : 's'} behind ${row.base || 'main'}`;
  if (checks.state === 'failing') {
    const names = checks.failed.length ? ` (${checks.failed.join(', ')})` : '';
    const base = `${checks.failing} failing${names} — ran ${at} against ${against}, ${behindTxt}`;
    return stale
      ? `${base} — STALE: this base has moved since, so the red is not (yet) a fact about this branch's own diff`
      : base;
  }
  return `passing — ran ${at} against ${against}, ${behindTxt}`;
}
