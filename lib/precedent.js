/**
 * `b7e-precedent` — the sibling bead that already did this shape of change, and the
 * patch it made.
 *
 * bc-dgx7.64 names four sessions that each needed the same thing — what an earlier
 * bead in their own family had already committed, as a template to copy — and built it
 * by hand, four different ways, two of which guessed the wrong sibling first:
 * `bc-khoe.30.22` grepped `git log --oneline --all` for a sibling's id substring and
 * found the *wrong* one (`.14` instead of `.15`) before running `git show <sha> --stat`
 * and six separate `git diff <sha>^1 <sha> -- <file>` calls to mirror each touched file
 * by hand; `bc-dgx7.53` tried `git show bc-dgx7.45 --stat` as though a bead id were a
 * git rev, got nothing, then fell back to `git log --oneline --all --grep=`.
 *
 * **Every commit in this repo is `<bead-id>: <title> (#<PR>)`** (the merge queue writes
 * it, see `lib/mergequeue.js`), so the search is exact rather than a grep for a
 * substring that might be a prefix of another id (`bc-khoe.30` is a prefix of
 * `bc-khoe.30.15`) or a body mention that is not the bead's own landing commit at all.
 * `landingCommitsFor` anchors on `^<id>: ` — the very start of the commit message — and
 * that anchor alone is what keeps `bc-khoe.30` from ever matching `bc-khoe.30.15`'s
 * commit; no separate word-boundary re-check is needed the way `lib/prior.js`'s
 * `commitsNaming` needs one for its anywhere-in-the-body pattern.
 *
 * **"Landed" means an ancestor of `main`, not merely a commit that exists somewhere.**
 * A branch this repo has dozens of unmerged branches, and `git log --all --grep` walks
 * every ref — so an anchored subject match on a ref that never reached `main` would
 * report an amount of work as precedent that a reader could not actually build on. Every
 * candidate is checked with `git merge-base --is-ancestor <sha> <base>` (`pickBase` from
 * `lib/notinmain.js`, the same "origin/main if this checkout has it, else main" fallback
 * `lib/prior.js` uses) before it is reported at all.
 *
 * **One anchored commit can still have two matches** — a pre-merge branch commit and
 * the squash-merge commit the merge queue makes from it, both starting with the same
 * `<id>: ` and both ancestors of `main` once merged (bc-dgx7.53 is the measured case:
 * `d9add0ef` on the branch, `20a28644` the merge of it, both reachable from `main`).
 * The merge commit is the one worth reporting — it is what the merge queue actually
 * wrote to `main`, and it is the only one of the two that reliably carries `(#<PR>)` —
 * so among the ancestors, whichever names a pull request wins; ties (or a repo with no
 * merge-queue convention at all) fall back to the most recently committed.
 *
 * **A sibling's files and a `--file` diff are always taken against the landing commit's
 * first parent**, `git diff <sha>^1 <sha>` — not `git show --stat`'s own default, which
 * is not guaranteed to mean the same thing for every commit shape this repo has ever
 * used. `<sha>^1` is well-defined for both an ordinary commit and a two-parent merge
 * (the merge queue's own shape), and it is the exact comparison bc-khoe.30.22 ran six
 * times by hand.
 */
import { git, ok } from './gitref.js';
import { pickBase } from './notinmain.js';
import { childrenFrom, treeUnder } from './ancestry.js';

/** How many commits `git log --grep` is asked for per candidate before this gives up. */
const COMMIT_SEARCH_LIMIT = 50;

/**
 * An anchored `git log --grep` pattern for "this commit's message opens with `<id>: `".
 *
 * A literal space, not `\s` — `--extended-regexp` is POSIX ERE, which has no `\s`; git
 * passes it straight to the system regex engine rather than interpreting a Perl escape,
 * so `\s` silently matches nothing at all rather than failing loudly (confirmed against
 * this repo's own history: `--grep=^bc-khoe\.30\.15:\s` finds zero commits that
 * `^bc-khoe\.30\.15: ` finds two of). `-E` is kept over `-P` because `-P` needs
 * libpcre-enabled git, which this repo does not require anywhere else.
 */
function landingPattern(id) {
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}: `;
}

/** The trailing `(#123)` a merge-queue commit subject carries, or `null`. */
function prNumberOf(subject) {
  const m = /\(#(\d+)\)\s*$/.exec(String(subject || ''));
  return m ? Number(m[1]) : null;
}

/**
 * Every commit on any ref whose subject opens with `<id>: `, newest first — a
 * superset of "landed", filtered down by `pickLandingCommit` below.
 *
 * Re-anchored in JS after `git log --grep` returns, for the same reason
 * `lib/prior.js`'s `commitsNaming` re-checks with `namesBead`: git's regex engine is not
 * guaranteed to be the one running this process.
 */
export async function landingCommitsFor(dir, id, { limit = COMMIT_SEARCH_LIMIT } = {}) {
  const out = await ok(
    git(dir, ['log', '--all', '--extended-regexp', `--grep=${landingPattern(id)}`, '--format=%H%x00%s%x00%cI', '-n', String(limit)])
  );
  if (!out) return [];
  const anchored = new RegExp(landingPattern(id));
  const rows = [];
  for (const line of String(out).trim().split('\n')) {
    if (!line) continue;
    const [sha = '', subject = '', date = ''] = line.split('\0');
    if (!anchored.test(subject)) continue;
    rows.push({ sha, subject, date: date || null, pr: prNumberOf(subject) });
  }
  return rows;
}

/**
 * Of the commits `landingCommitsFor` found, the one this bead actually landed as — or
 * `null` if none of them ever reached `base`.
 *
 * Filters to ancestors of `base` first (see the header — a match that exists only on an
 * unmerged branch is not precedent, it is one more unmerged branch), then prefers
 * whichever names a pull request (the merge commit), then the most recently committed.
 */
export async function pickLandingCommit(dir, rows, baseRef) {
  const landed = [];
  for (const row of rows) {
    // `--is-ancestor` prints nothing on success — it says everything through the exit
    // code — so this is a plain resolves/throws check, never `ok()`'s "was the output
    // truthy", which would read a genuine yes (empty stdout) as a no.
    const isAncestor = await git(dir, ['merge-base', '--is-ancestor', row.sha, baseRef])
      .then(() => true)
      .catch(() => false);
    if (isAncestor) landed.push(row);
  }
  if (!landed.length) return null;
  const withPr = landed.filter((r) => r.pr !== null);
  const pool = withPr.length ? withPr : landed;
  return pool.reduce((best, r) => (!best || (r.date || '') > (best.date || '') ? r : best), null);
}

/** Every file the landing commit touched, relative to its first parent. */
export async function filesTouched(dir, sha) {
  const out = await ok(git(dir, ['diff', '--name-only', `${sha}^1`, sha]));
  return out ? String(out).trim().split('\n').filter(Boolean) : [];
}

/** The same diff `--file` prints — one path, against the landing commit's first parent. */
export async function fileDiff(dir, sha, file) {
  return (await ok(git(dir, ['diff', `${sha}^1`, sha, '--', file]))) || '';
}

/**
 * Every sibling under `root`, id and title, excluding `root` and excluding `exclude`
 * (the bead itself — it is never its own precedent).
 *
 * `treeUnder` rather than one level of `childrenFrom`, on purpose: the default `root` is
 * this bead's own immediate parent, and a family several sessions deep (`bc-khoe.30`'s
 * children are themselves nested under other epics in places) is still "the family" one
 * level down. `--root` widens by naming a *different*, higher `root` — the shape of the
 * traversal underneath it does not change.
 */
export function siblingsUnder(index, root, exclude) {
  const children = childrenFrom(index.parents);
  return treeUnder(children, index.beads, root)
    .map((row) => ({ id: row.id, title: row.title || '' }))
    .filter((s) => s.id !== exclude);
}

/**
 * The whole answer for one bead: every sibling under its family that has *landed* work,
 * each with the commit it landed as, when, its pull request, and the files it touched.
 *
 * `root` is the id to search under — the caller resolves "immediate parent, unless
 * `--root` said otherwise". `beadId` is excluded from its own search even if `root`'s
 * subtree would otherwise include it (a bead re-parented oddly, or run with `--root`
 * naming its own parent).
 */
export async function precedentFor(dir, index, beadId, root, { base = 'main' } = {}) {
  const baseRef = await pickBase(dir, base);
  const siblings = root ? siblingsUnder(index, root, beadId) : [];
  const rows = [];
  for (const sib of siblings) {
    const candidates = await landingCommitsFor(dir, sib.id);
    if (!candidates.length) continue;
    const landed = baseRef ? await pickLandingCommit(dir, candidates, baseRef.ref) : null;
    if (!landed) continue;
    const files = await filesTouched(dir, landed.sha);
    rows.push({
      id: sib.id,
      title: sib.title,
      sha: landed.sha,
      pr: landed.pr,
      mergedAt: landed.date,
      files,
    });
  }
  rows.sort((a, b) => (b.mergedAt || '').localeCompare(a.mergedAt || ''));
  return { root, base: baseRef?.name || base, rows };
}

/** One block per landed sibling, for the non-`--json` report. */
export function describePrecedent(found, beadId) {
  const lines = [];
  if (!found.root) {
    lines.push(`${beadId} has no parent to search under — nothing to compare it against. Pass --root to name one.`);
    return lines;
  }
  if (!found.rows.length) {
    lines.push(`No sibling under ${found.root} has landed anything on ${found.base} yet.`);
    return lines;
  }
  for (const r of found.rows) {
    const pr = r.pr ? ` (#${r.pr})` : '';
    const when = r.mergedAt ? ` — ${r.mergedAt}` : '';
    lines.push(`${r.id}${pr}${when}`);
    lines.push(`  ${r.title}`);
    lines.push(`  ${r.sha}`);
    for (const f of r.files) lines.push(`    ${f}`);
    lines.push('');
  }
  return lines;
}

/**
 * Among `found.rows`, whichever landed sibling last touched `file` — the one `--file`
 * prints a diff for. `null` if none of them ever touched it.
 */
export function lastToTouch(found, file) {
  return found.rows.find((r) => r.files.includes(file)) || null;
}
