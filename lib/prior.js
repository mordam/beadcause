/**
 * Has somebody already done this, or part of it, and where is that work sitting now?
 *
 * bc-zjab.10: four sessions asked exactly this question by hand, with a different tool
 * set each time. bc-zjab.1's second run guessed a worktree name, then ran `git status
 * --short`, `git rev-parse --abbrev-ref HEAD`, a remote check, `gh pr list` and finally
 * `git diff main...HEAD --stat` — most of a session's first phase — before concluding
 * attempt 1 had written the whole change, committed twice, never pushed, opened no pull
 * request and left no comment saying so. bc-5e85 was told by its own bead to wait for
 * bc-1eru; instead it ran four more calls and found PR #488's body naming bc-5e85 as the
 * thing it does *not* fix, so the work was owed after all. bc-y3qk.4 asked the same
 * question of its family with a third tool set, and its only hit was a *retired*
 * worktree. bc-bmry.4 got the sibling half free from a debrief and still ran three more
 * git calls to work out what was actually on the base.
 *
 * **This is not `b7e-landed` (bc-khoe.47), which answers "is it on main".** Every case
 * above was work that is *not* on main: unpushed commits on a live branch, an open pull
 * request, a retired worktree, a sibling's branch. This module says what exists and
 * leaves the verdict to the reader — a branch naming a bead is not proof the work is
 * missing (this repo carries dozens of unmerged branches, most of them superseded), and a
 * worktree naming it is not proof the work is done.
 *
 * ## What it reuses, and why there is so little new code here
 *
 * - **`tagOf`/`ownsBranch`/`worktreeBranches`/`commitsAhead`/`tipOf`/`pickBase`** —
 *   lib/notinmain.js. `ownsBranch` is the one rule the whole repo uses to say a branch
 *   belongs to a bead (the trailing tag, not a prose mention), and `worktreeBranches`
 *   already unions every `refs/heads/worktree-*` and `refs/remotes/origin/worktree-*`
 *   ref into one deduped list. `tipOf` and `pickBase` were private there; this file is
 *   the reason they are exported now.
 * - **`git worktree list --porcelain`** (parsed with lib/tidy.js's `parseWorktrees`)
 *   lists *both* live and retired worktrees in one call, because retiring a worktree is
 *   `git worktree move` and not `git worktree remove` — a retired entry stays registered,
 *   just under `.claude/worktrees-retired/` instead of `.claude/worktrees/`. So there is
 *   no second command for "and check the attic too"; the classification is a path prefix.
 *   (A worktree that was fully `git worktree remove`d, or an attic entry that has aged
 *   out — lib/tidy.js's `expireRetired` — leaves nothing here to find. That is not a bug
 *   in this reading: it is what "gone" looks like, same as bc-y3qk.4's own bead notes.)
 * - **lib/pr.js's `list(dir, { head })`** — the same call lib/notinmain.js's
 *   `githubState` makes, asked once per branch this bead owns.
 * - **lib/pr.js's `list(dir, { search })`** (added for this bead) — the bc-5e85 case:
 *   a bead named in the body of a pull request opened for a *different* branch, which
 *   `--head` can never find because it never reads the text.
 *
 * ## Commits naming the bead
 *
 * `git log --all --extended-regexp --grep=<word-bounded pattern>` — fast even on this
 * repo's several-thousand-commit history, because git's own grep is a single walk over
 * commit metadata, not a shell loop. The hits are re-filtered in JS with the same
 * word-boundary rule lib/reap.js's `namesBead` uses, as a defensive second check: git's
 * regex engine is not guaranteed to be the same one running this process, and a bead id
 * that is a prefix of another (`bc-zjab` inside `bc-zjab.10`) must not cross-match.
 */
import path from 'node:path';
import { git, ok, mainCheckout } from './gitref.js';
import { parseWorktrees } from './tidy.js';
import { tagOf, ownsBranch, worktreeBranches, commitsAhead, tipOf, pickBase } from './notinmain.js';
import { namesBead } from './reap.js';
import * as pr from './pr.js';

/** How many commit hits to show before saying "and more". Mirrors b7e-orient's CAP. */
export const COMMIT_CAP = 20;

/** How many commits `git log --grep` is asked for before this stops looking. */
const COMMIT_SEARCH_LIMIT = 50;

/** A word-boundary, case-sensitive `git log --grep` pattern for one bead id. */
function grepPattern(id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `(^|[^A-Za-z0-9_.-])${escaped}([^A-Za-z0-9_.-]|$)`;
}

/**
 * Every commit, on any ref, whose subject or body names this bead — newest first.
 *
 * `%B` (the full message) rather than `%s` (just the subject), because a delivery's
 * "why" often sits in the body and not the first line, and this is the one place in the
 * repo that already pays for `--grep` to look at both. Re-checked with `namesBead` in
 * JS because `--grep`'s own match is not itself proof — see the header.
 */
export async function commitsNaming(main, id, { limit = COMMIT_SEARCH_LIMIT } = {}) {
  const out = await ok(
    git(main, ['log', '--all', '--extended-regexp', `--grep=${grepPattern(id)}`, '--format=%H%x00%s%x00%cI', '-n', String(limit)])
  );
  if (!out) return [];
  const rows = [];
  for (const line of String(out).trim().split('\n')) {
    if (!line) continue;
    const [sha = '', subject = '', date = ''] = line.split('\0');
    if (!namesBead(subject, id)) continue;
    rows.push({ sha, subject, date: date || null });
  }
  return rows;
}

/**
 * Every worktree — live or retired — whose branch this bead owns, plus every branch of
 * its own, whether or not a worktree currently exists for it.
 *
 * One row per branch. A branch with no worktree entry (removed, or aged out of the
 * attic) still gets a row if the ref itself is still there — that is the "unpushed
 * commits on a live branch with no worktree left" case as much as the "worktree still
 * sitting there" case, and both answer the same question.
 */
export async function branchesFor(main, id) {
  const names = (await worktreeBranches(main)).filter((b) => ownsBranch(id, b));
  if (!names.length) return [];

  const wtEntries = parseWorktrees((await ok(git(main, ['worktree', 'list', '--porcelain']))) || '');
  const worktreesRoot = path.join(main, '.claude', 'worktrees');
  const retiredRoot = path.join(main, '.claude', 'worktrees-retired');
  const under = (p, root) => p === root || p.startsWith(root + path.sep);

  const baseRef = await pickBase(main, 'main');

  const rows = [];
  for (const branch of names) {
    const local = Boolean(await ok(git(main, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])));
    const remote = Boolean(await ok(git(main, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`])));

    const wt = wtEntries.find((w) => w.branch === branch);
    let worktree = null;
    if (wt) {
      const resolved = path.resolve(wt.path);
      const state = under(resolved, path.resolve(worktreesRoot))
        ? 'live'
        : under(resolved, path.resolve(retiredRoot))
          ? 'retired'
          : 'other';
      worktree = { state, path: wt.path, locked: Boolean(wt.locked) };
    }

    const tip = await tipOf(main, branch);
    let ahead = null;
    if (tip && baseRef) {
      const a = await commitsAhead(main, tip.sha, baseRef.ref);
      if (a) ahead = a;
    }

    rows.push({
      branch,
      local,
      remote,
      pushed: remote,
      worktree,
      tip: tip?.sha || null,
      ahead: ahead?.ahead ?? null,
      subject: ahead?.subject || '',
      committedAt: ahead?.committedAt ? new Date(ahead.committedAt).toISOString() : null,
      base: baseRef?.name || null,
    });
  }
  return rows;
}

/**
 * Every pull request this bead's own branches have, plus every pull request naming it
 * in a title or body that is *not* already covered by that first set — the bc-5e85 case.
 *
 * `pr.available()` is checked once; a repo with no `gh`, no auth, or no GitHub remote at
 * all gets `{ ok: false, reason }` back rather than a thrown error, same as every other
 * caller of lib/pr.js.
 */
export async function pullRequestsFor(main, id, branches) {
  const avail = await pr.available();
  if (!avail.ok) return { ok: false, reason: avail.reason, rows: [] };

  const byNumber = new Map();

  for (const branch of branches) {
    let rows;
    try {
      rows = await pr.list(main, { state: 'all', head: branch, limit: 20 });
    } catch {
      continue; // one branch's PR lookup failing must not lose every other branch's
    }
    for (const r of rows) {
      if (r.branch !== branch) continue;
      byNumber.set(r.number, { ...r, why: `its own branch, ${branch}` });
    }
  }

  try {
    const rows = await pr.list(main, { state: 'all', search: `${id} in:title,body`, limit: 20 });
    for (const r of rows) {
      if (byNumber.has(r.number)) continue;
      if (!namesBead(`${r.title}\n${r.body}`, id)) continue; // gh's search is not word-bounded
      byNumber.set(r.number, { ...r, why: branches.includes(r.branch) ? `its own branch, ${r.branch}` : 'names it in the title or body' });
    }
  } catch {
    /* the per-branch reads above still stand even if the broader search fails */
  }

  return { ok: true, rows: [...byNumber.values()].sort((a, b) => (b.number || 0) - (a.number || 0)) };
}

/**
 * Everything this module knows how to say about one bead: worktrees+branches, commits,
 * pull requests. `main` is the checkout to run every git/gh call in — always the *main*
 * checkout (`mainCheckout` below resolves it from any worktree), because a worktree's
 * own view of `refs/remotes/origin/*` can lag it.
 */
export async function priorWork(dir, id) {
  const main = await mainCheckout(dir);
  const branches = await branchesFor(main, id);
  const commits = await commitsNaming(main, id);
  const prs = await pullRequestsFor(main, id, branches.map((b) => b.branch));
  return { id, main, branches, commits, prs };
}

/** True when `priorWork` found nothing at all worth reporting — the "untouched" case. */
export function isEmpty(found) {
  return found.branches.length === 0 && found.commits.length === 0 && (found.prs.rows || []).length === 0;
}

/** One printed report for one bead's `priorWork` result. */
export function describePrior(found) {
  const lines = [];
  const tag = tagOf(found.id);
  lines.push(`## ${found.id}`);

  if (isEmpty(found)) {
    lines.push(
      found.prs.ok
        ? `No worktree, branch, commit or pull request anywhere names ${found.id} (branch tag "${tag}").`
        : `No worktree, branch or commit anywhere names ${found.id} (branch tag "${tag}"); pull requests could not be checked — ${found.prs.reason}.`
    );
    return lines;
  }

  if (found.branches.length) {
    lines.push(`\n${found.branches.length} branch${found.branches.length === 1 ? '' : 'es'} owning the tag "${tag}":`);
    for (const b of found.branches) {
      const where = b.worktree
        ? `${b.worktree.state} worktree${b.worktree.locked ? ', locked' : ''} at ${b.worktree.path}`
        : 'no worktree (removed, or aged out of the attic)';
      const refs = `${b.local ? 'local' : 'no local ref'}${b.remote ? ', pushed to origin' : ', not pushed'}`;
      const ahead =
        b.ahead === null
          ? 'could not measure how far ahead of main it is'
          : b.ahead === 0
            ? `nothing ahead of ${b.base}`
            : `${b.ahead} commit${b.ahead === 1 ? '' : 's'} ahead of ${b.base}${b.subject ? ` — newest: "${b.subject}"` : ''}${b.committedAt ? ` (${b.committedAt})` : ''}`;
      lines.push(`  ${b.branch} — ${where}; ${refs}; ${ahead}`);
    }
  }

  if (found.commits.length) {
    const shown = found.commits.slice(0, COMMIT_CAP);
    lines.push(`\n${found.commits.length} commit${found.commits.length === 1 ? '' : 's'} on any ref naming ${found.id}:`);
    for (const c of shown) lines.push(`  ${c.sha.slice(0, 8)} ${c.subject}`);
    if (found.commits.length > shown.length) lines.push(`  … and ${found.commits.length - shown.length} more`);
  }

  if (!found.prs.ok) {
    lines.push(`\nPull requests could not be checked — ${found.prs.reason}.`);
  } else if (found.prs.rows.length) {
    lines.push(`\n${found.prs.rows.length} pull request${found.prs.rows.length === 1 ? '' : 's'}:`);
    for (const p of found.prs.rows) {
      lines.push(`  #${p.number} [${p.state}] ${p.title} — ${p.why} — ${p.url}`);
    }
  } else {
    lines.push(`\nNo pull request open or merged names ${found.id}.`);
  }

  return lines;
}
