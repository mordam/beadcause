/**
 * Is a failing suite already known red — whose bead, at what base, and has `origin/main`
 * fixed it since? `bin/b7e-stillred` is the argv shell; this is the answering.
 *
 * `bc-dgx7.62`, filed by the session audit against six sessions on 2026-08-24
 * (`bc-ka5y.22`, `bc-ogicx.5`, `bc-9ntye.3`, `bc-beleq`, `bc-9ntye.5`, `bc-dgx7.52`) that
 * each spent five to forty minutes deciding, by six different methods, whether
 * `test/finishedepic.mjs` was a red they had caused or one already on file — a re-run
 * against the (routinely stale) main checkout, moving a live locked worktree's `HEAD` to
 * prove a point, `b7e-blame` run against *current* `origin/main` after the fix had
 * already landed under it, three separate `bd search` guesses at the tracker. Everything
 * needed to answer this was already on disk: `lib/gaterun.js` writes one JSONL record per
 * `b7e-gate` run to `.claude/gate-runs` in the *main checkout*, readable by every worktree
 * on this Mac, and the tracker already held the bead. This reads both, and reads `git`,
 * and never runs a suite and never builds a worktree — the two things that make
 * `lib/blame.js` and `lib/triage.js` slow and are also exactly what made every one of
 * those six sessions' own answer stale by the time it was typed.
 *
 * ## Why this is not `b7e-blame` again
 *
 * `b7e-blame` answers "is this red on `origin/main` *right now*" by actually running the
 * suite there — correct, and priced at a worktree checkout and a suite run, twice, every
 * time. This answers a narrower, cheaper question from records alone: has *any* gate run
 * on this Mac already seen this suite fail, and has anything touched its file on
 * `origin/main` since the base that run was taken against. That is not proof the suite is
 * fixed — a commit "touching" the file is not the same as a commit that fixes it, and
 * this says so rather than overclaiming — but it is the one question raised entirely from
 * what is already written down, in milliseconds, with nothing spawned that a caller has
 * to wait on.
 *
 * ## The base a run is placed against
 *
 * `lib/gaterun.js`'s `startRun` now stamps `mergeBase` — `HEAD`'s merge-base with
 * `origin/main` *as it stood when the run was taken* — beside the `sha` it already
 * recorded (`bc-dgx7.39`). A run written before that field existed, or one recorded
 * against a `--dir` fixture with no `origin` remote at all, falls back to computing the
 * same merge-base from the run's `sha` at read time instead — the answer is identical
 * either way, because a merge-base is a pure function of the commit graph and the run's
 * own commit never moves; storing it is what lets a caller ask the question with no `git`
 * call to `HEAD` other than the run's, not what changes the answer. `--base <ref>`
 * overrides this outright, for a caller who already knows the base is wrong (a rebase, a
 * force-push) and wants the comparison run against something else.
 *
 * ## What "fixed since" means, honestly
 *
 * `git log <base>..origin/main -- <suite>` is the whole of it: any commit on `origin/main`
 * since the base that touched the suite's own path. `bc-beleq`'s fix to
 * `test/finishedepic.mjs` (`ce36062d`) is exactly such a commit, and `bc-9ntye.5`'s six
 * separate `git` calls to confirm that by hand are what this collapses into one. A commit
 * that touches the file without fixing it (a rename, a comment) would also show up here —
 * this reports every such commit rather than deciding among them, so a caller with reason
 * to doubt one still has the subject lines to look at.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { git, ok } from './gitref.js';
import { runsDir, listRunFiles, readRun } from './gaterun.js';

export { REPO_ROOT } from './gate.js';

/* --------------------------------------------------------------------- reporting time */

/** How long ago, in the words a report can use — the same shape lib/resolvers.js's own `ago` uses, extended to days for a run that is genuinely old. */
export function ago(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'a moment ago';
  if (mins === 1) return 'a minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? 'a day ago' : `${days} days ago`;
}

const shortSha = (sha) => (sha ? sha.slice(0, 7) : null);

/* ------------------------------------------------------------------------ the records */

/**
 * Every recorded gate run on this Mac that failed `suite`, newest first — `readRun`
 * already tolerates a torn last line (a run still writing), so a run mid-flight is read
 * as "still running" rather than thrown away. Never spawns anything: `listRunFiles` and
 * `readRun` are plain filesystem reads.
 */
async function failuresOf(cwd, suite) {
  const dir = await runsDir(cwd);
  const files = listRunFiles(dir);
  return files.map((f) => readRun(f)).filter((r) => r.failed.includes(suite));
}

/* --------------------------------------------------------------------------- the base */

/**
 * The base to compare `origin/main` against: `--base <ref>` if the caller gave one
 * (resolved, so a bad ref reads as "no base" rather than a thrown error); else the most
 * recent failing run's own recorded `mergeBase`; else that run's `sha` re-merge-based
 * against `origin/main` right now, for a run written before `mergeBase` existed. `null`
 * when none of these resolve — nothing to compare `origin/main` against, not evidence
 * either way.
 */
async function resolveBase(cwd, explicitBase, lastFailure) {
  if (explicitBase) {
    const resolved = ((await ok(git(cwd, ['rev-parse', explicitBase]))) || '').trim();
    return resolved || null;
  }
  if (!lastFailure) return null;
  if (lastFailure.mergeBase) return lastFailure.mergeBase;
  if (!lastFailure.sha) return null;
  const computed = ((await ok(git(cwd, ['merge-base', lastFailure.sha, 'origin/main']))) || '').trim();
  return computed || null;
}

/** Every commit on `origin/main` since `base` that touched `suite`'s own path, newest first, or `null` if the range could not be read at all (no `origin/main` locally, an unresolvable `base`). */
async function commitsSinceBase(cwd, base, suite) {
  if (!base) return null;
  const out = await ok(git(cwd, ['log', '--format=%h%x00%s', `${base}..origin/main`, '--', suite]));
  if (out === null) return null;
  return out
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [sha, subject] = line.split('\0');
      return { sha, subject };
    });
}

/* ------------------------------------------------------------------------- the tracker */

/** The first balanced JSON array in `text` — `bd`'s own `--json` output is clean, but a stray warning line ahead of it must not throw this away. */
function firstJsonArray(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    /* fall through to slicing */
  }
  const start = trimmed.indexOf('[');
  const end = trimmed.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return [];
  try {
    const parsed = JSON.parse(trimmed.slice(start, end + 1));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The open bead that already names this suite, if the tracker has one — `bd search`
 * against the suite's own basename (without extension), the same word `bc-ka5y.22`
 * searched by hand. Best-effort in every direction that is not this suite's own fault:
 * no `bd` on `PATH`, no workspace resolving from `cwd`, or nothing found all read the
 * same as "no bead on file," because a caller acting on this answer cannot tell an
 * absent tracker from an absent match and should not have to.
 */
async function findBead(cwd, suite) {
  const query = path.basename(suite, path.extname(suite));
  if (!query) return null;
  let out;
  try {
    out = execFileSync('bd', ['search', query, '--status', 'open', '--limit', '5', '--json'], {
      cwd,
      encoding: 'utf8',
      timeout: 15000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
  const rows = firstJsonArray(out);
  if (!rows.length) return null;
  // A row whose title actually names the suite's own path is a better match than one `bd
  // search` merely matched the basename word against loosely.
  const named = rows.find((r) => typeof r.title === 'string' && r.title.includes(suite));
  const row = named || rows[0];
  return row && row.id ? { id: row.id, title: row.title || '' } : null;
}

/* ---------------------------------------------------------------------------- the ask */

/**
 * One suite's answer: `{ suite, verdict, failureCount, last, base, commitsSinceBase,
 * bead }`.
 *
 * `verdict` is one of: `no-record` (no gate run on this Mac has ever recorded this
 * failing — nothing here to say), `unclear-base` (it has failed, but no base could be
 * resolved to compare `origin/main` against — a run older than `mergeBase` existed, with
 * no `--base` given, and its own `sha` no longer merge-bases against `origin/main`
 * either), `still-red` (failed here, and no commit has touched its path on `origin/main`
 * since the base — nothing says it is fixed), `fixed-on-main` (failed here, and at least
 * one commit has touched its path on `origin/main` since the base — likely fixed; merge
 * it rather than re-deriving this).
 *
 * Never spawns a suite and never builds a `git worktree` — every read here is either a
 * filesystem read of an already-written JSONL record, a bounded `git` plumbing call
 * (`rev-parse`, `merge-base`, `log`), or a `bd search`.
 */
export async function stillRed(cwd, suite, { base: explicitBase } = {}) {
  const records = await failuresOf(cwd, suite);
  const last = records[0] || null;
  const base = await resolveBase(cwd, explicitBase, last);
  const commits = await commitsSinceBase(cwd, base, suite);
  const bead = await findBead(cwd, suite);

  let verdict;
  if (!last) verdict = 'no-record';
  else if (!base) verdict = 'unclear-base';
  else if (commits && commits.length) verdict = 'fixed-on-main';
  else verdict = 'still-red';

  return {
    suite,
    verdict,
    failureCount: records.length,
    last: last ? { runId: last.runId, worktree: last.worktree, sha: last.sha, at: last.startedAt } : null,
    base,
    commitsSinceBase: commits || [],
    bead,
  };
}

/** Every suite in `suites`, against `cwd`, in argument order. */
export async function stillRedAll(cwd, suites, opts = {}) {
  const results = [];
  for (const suite of suites) results.push(await stillRed(cwd, suite, opts));
  return results;
}

/* ----------------------------------------------------------------------- reporting */

/** One line, no colour. */
export function verdictLine(r) {
  const beadNote = r.bead ? ` — see ${r.bead.id}: ${r.bead.title}` : '';
  const lastNote = r.last
    ? ` (last: ${r.last.worktree} ${r.last.runId}, ${ago(Date.now() - Date.parse(r.last.at))}, at ${shortSha(r.last.sha)})`
    : '';
  switch (r.verdict) {
    case 'no-record':
      return `${r.suite}: no recorded gate run on this Mac has failed this — nothing on file${beadNote}`;
    case 'unclear-base':
      return `${r.suite}: red in ${r.failureCount} run(s) here${lastNote} — no base to compare against origin/main${beadNote}`;
    case 'fixed-on-main':
      return `${r.suite}: fixed on main since your base — merge origin/main (base ${shortSha(r.base)}, ${
        r.commitsSinceBase.length
      } commit(s) touched it since)${lastNote}${beadNote}`;
    case 'still-red':
      return `${r.suite}: red in ${r.failureCount} run(s) here${lastNote} — no fix on origin/main since your base (${shortSha(
        r.base,
      )})${beadNote}`;
    default:
      return `${r.suite}: ${r.verdict}`;
  }
}

/** `0` if nothing here needs attention (no record at all, or already fixed on main), `1` otherwise. */
export function exitCodeFor(results) {
  return results.every((r) => r.verdict === 'no-record' || r.verdict === 'fixed-on-main') ? 0 : 1;
}
