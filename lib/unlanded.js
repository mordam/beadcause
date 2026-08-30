/**
 * Where does this exist, if it is not on `main` yet — and what does it say there?
 *
 * bc-68ou.15. Four sessions each needed to read a symbol, a file or a hunk out of a
 * branch or pull request nobody has merged, and each paid for it by hand:
 *
 * - `bc-khoe.30.14` needed `public/releases.js`, which does not exist on `main` —
 *   `ls public/releases*` said "no matches found". It set `B=origin/worktree-releases-
 *   view-khoe7` and ran six-plus `git show` calls, one of them quoting the ref as
 *   `git show "${B}:test/panes.mjs"`, which failed with `fatal: ambiguous argument
 *   'worktree-releases-view-khoe7est/panes.mjs'` — the shell variable glued straight
 *   onto the path with the colon lost between them, and the read had to be redone.
 * - `bc-khoe.4` needed `viewHop`, which lives only on PR #520. `grep -n "viewHop"
 *   lib/*.js public/*.js test/*.mjs` found nothing (it is not on `main`), then `git grep
 *   -n "viewHop" origin/main` (still nothing, same reason), then `gh pr diff 520
 *   --name-only`, then a full `gh pr diff 520` piped through `grep`, then `sed -n
 *   '700,760p'` to read the function out of a diff by line offset.
 * - `bc-fh0sz` had to decide whether `lib/shutdown.js` (from `bc-1eru`'s branch) still
 *   existed anywhere; PR #488 had squashed it into a single file, so every one of `git
 *   log --diff-filter=A`, `git diff --name-only`, `gh pr view` and `gh api .../files`
 *   was needed before the answer — "gone" — was safe to write down.
 * - `bc-gdub` needed to know what a *sibling* worktree had written into a function it
 *   was about to change: `git log`, `git diff --stat`, then `git diff … | grep '^+' |
 *   grep -n 'bus\|app\.'` to find the sibling's own new line.
 *
 * Every one of these sessions already knew *which* branch or pull request mattered —
 * that is `b7e-prior`'s and `b7e-siblings`' question, not this one. What cost them round
 * trips was pulling a file, a hunk or a symbol *out* of it, across the frontier where
 * `grep`, `ls` and `wc` all answer "not there" and are correct, because the thing being
 * asked about was never checked out anywhere on disk.
 *
 * ## What this reuses
 *
 * `mainCheckout`, `git`, `ok`, `gitCode` — lib/gitref.js, the same plumbing every other
 * `b7e-*` command's `git` reads go through. `worktreeBranches`, `tipOf`, `pickBase` —
 * lib/notinmain.js, the same branch enumeration `b7e-prior` already searches by bead tag;
 * here every one of them is searched, because this question is not "which branch does
 * `<bead>` own" but "which branch, anybody's, has this". `pr.list`/`pr.view` —
 * lib/pr.js, for the PR number, state, merge state and checks a branch's row wants —
 * best-effort, exactly as `lib/prior.js`'s `pullRequestsFor` treats a `gh` failure.
 *
 * ## `ref:path` is never built by string interpolation into a shell
 *
 * The `${B}:test/panes.mjs` bug above was a *shell* gluing a variable and a literal
 * colon together wrong. Nothing here runs through a shell at all — `git()` (lib/gitref.js)
 * calls `execFile` with an argv array, and the one place a colon is needed
 * (`git cat-file -p <ref>:<path>`) is built with a plain JS template string and handed to
 * `execFile` as a single array element. There is no shell in between to glue it wrong a
 * second time.
 *
 * ## Symbol search vs. path search
 *
 * `looksLikePath` decides which: a query with a `/` in it, or ending in a short
 * extension, is a path (`public/releases.js`); anything else is a symbol, searched with
 * `git grep -w` (word-bounded, so `Hop` does not match inside `viewHopeless`). Passing
 * both — a symbol *and* a path — narrows the grep to that one path, which is the
 * `bc-gdub` shape: "what did this branch write into this file".
 *
 * A path query defaults to printing the whole file at every place it is found —
 * `bc-khoe.30.14`'s shape, where the file does not exist on `main` at all and the
 * question is simply "what does it say". `--diff` prints that place's change to the path
 * against `main` instead — the `bc-gdub` shape, where the file *does* exist elsewhere too
 * and only the delta is wanted. `--show` is the same "print the whole file" behaviour
 * made explicit, for a caller that wants to say so even though it is already the default.
 *
 * A query found nowhere — not on `main`, not in any branch's current tree — is reported
 * as `nowhere`, in so many words, rather than as an empty diff or an empty list a caller
 * could mistake for "found, but no differences". `bc-fh0sz`'s `lib/shutdown.js` is the
 * worked example: it once existed, on a branch since squashed away, and the honest
 * present-tense answer is that no live tree has it any more.
 *
 * ## `main` short-circuits the search, and this is load-bearing, not an optimisation
 *
 * The question this bead names is "if it is not on `main` yet" — once a symbol or a path
 * *is* on `main`, that is where it exists, and this repo has ~350 `worktree-*` branches:
 * once something has landed, every branch cut afterwards inherits it in its tree too, so
 * an unconditional sweep turns "found on main" into a report naming three hundred
 * branches that changed nothing about it, each paying for its own `gh pr list` — a real
 * first cut of this took over two minutes on `viewHop`, already landed by the time this
 * was tested, for exactly that reason. So a hit on `main` returns immediately; `--all`
 * overrides it for the caller who genuinely wants to know whether some branch also has an
 * *unlanded change* on top of what already merged.
 */
import { git, ok, gitCode, mainCheckout } from './gitref.js';
import { worktreeBranches, tipOf, pickBase } from './notinmain.js';
import * as pr from './pr.js';

/** How many matching lines to show per place before saying "and more". */
export const MAX_HITS = 20;

/** A query names a path, not a symbol, when it has a slash or a short file extension. */
export function looksLikePath(query) {
  const q = String(query || '');
  return q.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(q);
}

/** Escape a literal string for use inside a git/PCRE-ish `-e` pattern. */
function literalPattern(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Does `file` exist in `ref`'s tree? Never throws — a missing ref or path is `false`. */
export async function pathExists(dir, ref, file) {
  const { code } = await gitCode(dir, ['cat-file', '-e', `${ref}:${file}`]);
  return code === 0;
}

/**
 * The whole of one file, at one ref — `null` if either the ref or the path is missing.
 *
 * `${ref}:${file}` is git's own object-spec syntax (see the module doc on why building
 * it as a plain JS string is safe here and was not in the bug this bead is named for).
 */
export async function readAt(dir, ref, file) {
  return await ok(git(dir, ['cat-file', '-p', `${ref}:${file}`]));
}

/**
 * Every line matching `symbol` (word-bounded) in `ref`'s tree, optionally scoped to one
 * path — `{file, line, text}`, capped at `MAX_HITS`. `[]` for no matches or a ref/path
 * git cannot read; a search must fail open, the same contract every other `b7e-*` reader
 * keeps.
 */
export async function grepAt(dir, ref, symbol, { file = null, limit = MAX_HITS } = {}) {
  const args = ['grep', '-n', '-I', '-w', '-e', literalPattern(symbol), ref];
  if (file) args.push('--', file);
  const out = await ok(git(dir, args));
  if (!out) return [];
  const rows = [];
  let overflow = 0;
  for (const line of String(out).trim().split('\n')) {
    if (!line) continue;
    // `git grep -n <ref>` prints `<ref>:<file>:<line>:<text>` — split on the first three
    // colons only, since `<text>` is free-form and may itself contain colons.
    const m = line.match(/^[^:]*:([^:]+):(\d+):(.*)$/);
    if (!m) continue;
    if (rows.length >= limit) {
      overflow += 1;
      continue;
    }
    rows.push({ file: m[1], line: Number(m[2]), text: m[3] });
  }
  return overflow ? Object.assign(rows, { overflow }) : rows;
}

/** The unified diff of one path between `base` and `ref` — `''` when there is none. */
export async function diffAt(dir, base, ref, file) {
  return (await ok(git(dir, ['diff', `${base}...${ref}`, '--', file]))) || '';
}

/**
 * What GitHub knows about the pull request on `branch`, or `null` — no open/merged PR,
 * `gh` unavailable, or the lookup failed. Best-effort: a place this exists is still worth
 * reporting even when its PR status cannot be read, same as `lib/prior.js`'s
 * `pullRequestsFor`.
 */
export async function prFor(dir, branch) {
  const avail = await pr.available();
  if (!avail.ok) return null;
  try {
    const rows = await pr.list(dir, { state: 'all', head: branch, limit: 5 });
    return rows.find((r) => r.branch === branch) || null;
  } catch {
    return null;
  }
}

/** Resolve `--pr <n>` to the branch it is open against. Throws if `gh` cannot answer. */
export async function resolvePr(dir, number) {
  const avail = await pr.available();
  if (!avail.ok) throw new Error(`gh not available — ${avail.reason}`);
  return await pr.view(dir, String(number));
}

/**
 * Everywhere `query` (a symbol, a path, or a symbol scoped to a path via `pathHint`)
 * exists — `main`, plus every branch this checkout knows about, or — when `branch`/
 * `prNumber` pins one down — just that one place.
 *
 * A pin skips the search entirely, the "pin it when the answer is already known" case:
 * `main` is not checked either, because the caller has already said where to look.
 *
 * Returns `{ query, isPath, places }`. Each place in `places` is `{ where: 'main' |
 * 'branch', branch, tip, pr, hits }` for a symbol, or `{ where, branch, tip, pr, path,
 * content | diff }` for a path — `places` is `[]` when nothing anywhere has it.
 */
export async function unlandedFor(dir, query, { pathHint = null, branch: pinBranch = null, prNumber = null, diff = false, all = false } = {}) {
  const main = await mainCheckout(dir);
  // A pathHint always means "a symbol, scoped to one path" (the "both" case) — content
  // mode (dumping or diffing the whole file) is only for a bare path with nothing to
  // grep for, one positional argument on its own.
  const isPath = !pathHint && looksLikePath(query);
  const symbol = isPath ? null : query;
  const scopePath = isPath ? query : pathHint;

  const baseRef = (await pickBase(main, 'main'))?.ref || 'main';

  let targetBranch = pinBranch;
  if (!targetBranch && prNumber != null) {
    const row = await resolvePr(main, prNumber);
    targetBranch = row.branch;
    if (!targetBranch) throw new Error(`PR #${prNumber} has no headRefName — cannot resolve a branch`);
  }
  const pinned = Boolean(targetBranch);

  const places = [];

  const addPlace = async (where, branch, ref) => {
    if (isPath) {
      const has = await pathExists(main, ref, scopePath);
      if (!has) return;
      const place = { where, branch, tip: ref, path: scopePath };
      if (diff) place.diff = await diffAt(main, baseRef, ref, scopePath);
      else place.content = await readAt(main, ref, scopePath);
      places.push(place);
    } else {
      const hits = await grepAt(main, ref, symbol, { file: scopePath });
      if (!hits.length) return;
      places.push({ where, branch, tip: ref, hits });
    }
  };

  if (pinned) {
    const tip = await tipOf(main, targetBranch);
    if (!tip) throw new Error(`no such branch: ${targetBranch}`);
    await addPlace('branch', targetBranch, tip.sha);
  } else {
    await addPlace('main', null, 'HEAD');
    // See the module doc: once it is on main, that is where it exists, and searching
    // every one of ~350 worktree branches for a hit every one of them already inherits
    // is minutes of `gh` calls to say nothing new. `--all` is the escape hatch.
    if (!places.length || all) {
      const branches = await worktreeBranches(main);
      for (const branch of branches) {
        // eslint-disable-next-line no-await-in-loop -- one branch's tree at a time
        const tip = await tipOf(main, branch);
        if (!tip) continue;
        // eslint-disable-next-line no-await-in-loop -- likewise
        await addPlace('branch', branch, tip.sha);
      }
    }
  }

  for (const p of places) {
    if (p.where !== 'branch') continue;
    // eslint-disable-next-line no-await-in-loop -- one branch's PR lookup at a time
    p.pr = await prFor(main, p.branch);
  }

  return { query, pathHint, isPath, places };
}

/** True when `unlandedFor` found the query nowhere at all. */
export function isEmpty(found) {
  return found.places.length === 0;
}

const dim = (s) => `\x1b[2m${s}\x1b[0m`;

/** One place's header line: `#520 [OPEN, CONFLICTING] worktree-foo (abc1234)`, or `main`. */
function placeHeader(p) {
  if (p.where === 'main') return 'main';
  const tip = p.tip ? p.tip.slice(0, 8) : '?';
  if (!p.pr) return `${p.branch} (no PR, ${tip})`;
  return `#${p.pr.number} [${p.pr.state}${p.pr.mergeState ? `, ${p.pr.mergeState}` : ''}] ${p.branch} (${tip})`;
}

/** One printed report for one `unlandedFor` result. */
export function describeUnlanded(found) {
  const lines = [];
  const label = found.pathHint ? `${found.query} in ${found.pathHint}` : found.query;
  lines.push(`## ${label}`);

  if (isEmpty(found)) {
    lines.push(
      found.isPath
        ? `nowhere — not on main, and no branch's current tree has ${found.query} either.`
        : `nowhere — not on main, and no branch's current tree names ${found.query}.`
    );
    return lines;
  }

  for (const p of found.places) {
    lines.push('');
    lines.push(placeHeader(p));
    if (found.isPath) {
      if (p.diff !== undefined) {
        lines.push(p.diff ? p.diff.replace(/\n$/, '') : dim('  (no difference from main)'));
      } else {
        const body = p.content ?? '';
        const lineCount = body ? body.split('\n').length - (body.endsWith('\n') ? 1 : 0) : 0;
        lines.push(dim(`  ${p.path} — ${lineCount} line${lineCount === 1 ? '' : 's'}`));
        lines.push(body.replace(/\n$/, ''));
      }
    } else {
      for (const h of p.hits) lines.push(`  ${h.file}:${h.line}: ${h.text}`);
      if (p.hits.overflow) lines.push(dim(`  … and ${p.hits.overflow} more`));
    }
  }
  return lines;
}
