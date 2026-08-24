/**
 * Every bead id quoted in this repo's own tree, joined to what the tracker now says about
 * it. `bin/b7e-cites` is the argv parsing and printing; this is the walk, the matching and
 * the "is this worth a second look" judgement, pure.
 *
 * bc-4r10.22 is the session audit naming the same discovery four times, each by accident.
 * `bc-4r10.9` grepped for one string across three files and found `lib/incident.js:41` —
 * "(bc-228x has not settled whose boundary this is)" — long after bc-228x had closed.
 * `bc-4r10.4` found `lib/policies.js` still crediting itself with work it no longer owned,
 * and filed a bead about it rather than fixing it in place. `bc-eqn1.2` hit a doc comment
 * saying clauses were "still to come" while writing those very clauses. `bc-4r10.1` found
 * `test/servicescope.mjs:25` still saying two files "are landing on" main after both had —
 * read unchanged by three later sessions. Four accidental discoveries, no sweep. This is
 * the sweep: `lib/mentions.js` already has the id matcher (built for prose, over bead
 * fields, for `scripts/relate-sweep.mjs`), and `lib/bd.js` already has the status; this
 * joins them over the working tree.
 *
 * **The file walk is its own copy, not an import.** `bc-4r10.21` (`b7e-grep`,
 * `lib/repogrep.js`) settled the same roots and the same exclusions two hours before this
 * bead was picked up, and its PR (#633) was still on the merge queue — not yet on `main` —
 * when this was written. Importing it would have made this branch depend on another
 * session's unmerged work landing first, which is exactly the fragile order this repo's
 * own delivery model refuses to assume. Duplicating ~30 lines here costs nothing a
 * consolidation pass can't undo once both have landed; depending on an unmerged branch
 * costs a build that only works in the order the two happen to merge.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mentionsIn, prefixOf } from './mentions.js';

/** Directories walked recursively when no path is given. */
export const ROOT_DIRS = Object.freeze(['lib', 'bin', 'test', 'scripts', 'public', 'android']);
/** Scanned as a single file, not a directory. */
export const README_FILE = 'README.md';

/**
 * Same exclusions `lib/repogrep.js` settled on, for the same reasons: `node_modules`,
 * `.git` and `.claude` are never source (the last is what keeps a sibling worktree's own
 * copy of a file from ever being a second hit — see acceptance criteria on bc-4r10.22);
 * `.coverage`/`dist` are `scripts/coverage.mjs` output; `.gradle`/`.idea`/`build` are
 * android's own generated output.
 */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.claude', '.coverage', 'dist', '.gradle', '.idea', 'build']);
const SKIP_PATHS = new Set(['public/vendor']);
const APK_RE = /\.apk(\.json)?$/i;

/**
 * This process's own worktree root — `git rev-parse --show-toplevel` from `cwd` — so a
 * session working inside `.claude/worktrees/<name>` scans that worktree's own files,
 * uncommitted edits included, never the main checkout's regardless of which copy of
 * `bin/b7e-cites` actually ran (`bin/` of the main checkout is what's on `PATH`). Falls
 * back to `fallback` when `cwd` is not inside a git worktree at all.
 */
export function repoRoot(cwd = process.cwd(), fallback = cwd) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return fallback;
  }
}

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

function walk(root, absDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // this root doesn't exist here — not an error, just nothing to add
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue; // never followed — a worktree's node_modules is one
    const abs = path.join(absDir, e.name);
    const rel = toRel(root, abs);
    if (e.isDirectory()) {
      if (SKIP_DIR_NAMES.has(e.name) || SKIP_PATHS.has(rel)) continue;
      walk(root, abs, out);
    } else if (e.isFile()) {
      if (APK_RE.test(e.name)) continue;
      out.push(rel);
    }
  }
}

/**
 * Every file under the fixed roots, repo-relative and forward-slashed, deduplicated and
 * sorted — the whole tree `b7e-cites` scans with no path given. `paths`, when given,
 * replaces the fixed roots: each entry is walked if it is a directory, added directly if
 * it is a file, and silently dropped if it is neither (a typo'd path is not this
 * function's job to complain about).
 */
export function collectFiles(root, paths = null) {
  const seen = new Set();
  const files = [];
  const add = (rel) => {
    if (seen.has(rel)) return;
    seen.add(rel);
    files.push(rel);
  };

  if (paths && paths.length) {
    for (const p of paths) {
      const abs = path.resolve(root, p);
      let stat;
      try {
        stat = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink()) continue;
      const rel = toRel(root, abs);
      if (stat.isDirectory()) {
        const out = [];
        walk(root, abs, out);
        out.forEach(add);
      } else if (stat.isFile()) {
        add(rel);
      }
    }
    return files.sort();
  }

  for (const dir of ROOT_DIRS) {
    const out = [];
    walk(root, path.join(root, dir), out);
    out.forEach(add);
  }
  const readmeAbs = path.join(root, README_FILE);
  try {
    if (fs.statSync(readmeAbs).isFile()) add(README_FILE);
  } catch {
    /* no README here */
  }
  return files.sort();
}

/** A NUL in the first 8000 bytes — the same heuristic `grep` itself uses. */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i += 1) if (buf[i] === 0) return true;
  return false;
}

/**
 * One row per line, per id — every place `files` names a bead id under `prefix`.
 *
 * Reuses `mentionsIn` (`lib/mentions.js`) one line at a time rather than re-deriving the
 * id shape: it already gets the dotted child suffix right (`bc-arj0.4`, not just
 * `bc-arj0`) and already refuses to run with no prefix. Calling it per line rather than
 * once over the whole file is what turns "this id is mentioned somewhere" into "this id
 * is mentioned *here*" — `path:line` is the whole point of a citation.
 *
 * `only`, when given, keeps a line only if it names exactly that one id (case-folded) —
 * `--bead <id>` mode, which asks "where is *this* id quoted" rather than "what does this
 * prefix's family look like". A line naming the id twice still contributes one row per
 * line (`mentionsIn` dedupes within its input), which reads as one citation, not two.
 */
export function citationsIn(root, files, prefix, { only = null } = {}) {
  const wantOnly = only ? String(only).toLowerCase() : null;
  const out = [];
  for (const rel of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(root, rel));
    } catch {
      continue; // gone between the walk and the read — not this scan's problem
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].replace(/\r$/, '');
      const ids = mentionsIn(line, prefix);
      if (!ids.length) continue;
      for (const id of ids) {
        if (wantOnly && id !== wantOnly) continue;
        out.push({ file: rel, line: i + 1, id, text: line.trim() });
      }
    }
  }
  return out;
}

/**
 * The closed list `--stale`'s second case is built from — phrases that only make sense
 * about a bead that has not landed yet. Every one of them is lifted from an actual
 * citation four sessions each found by accident and none swept for: "bc-228x **has not
 * settled** whose boundary this is" (`lib/incident.js`, bc-4r10.9), "the clauses are
 * **still to come**" (bc-eqn1.2), "lib/controls.js (bc-4r10.1) ... **are landing on**
 * main" (`test/servicescope.mjs`, bc-4r10.1). The originating bead's own acceptance text
 * was truncated mid-word after "is landing, ha…" before this list could be copied
 * verbatim (checked with `bd show --json`, not just the wrapped terminal view — it is cut
 * off in the stored description itself), so `has not landed` / `hasn't landed` below is a
 * reconstruction from the pattern the other three set, not a recovered quote.
 *
 * A phrase alone is never enough — "bc-228x has not settled" about a bead still genuinely
 * open is an accurate sentence, not a stale one. `staleFilter` below is what pairs a
 * pending phrase with a bead that has since closed; this list only says what "pending
 * language" looks like.
 */
export const PENDING_PHRASES = Object.freeze([
  /\bhas(?:n'?t| not) settled\b/i,
  /\bnot yet settled\b/i,
  /\bstill to come\b/i,
  /\b(?:is|are) landing\b/i,
  /\blanding on\b/i,
  /\bhas(?:n'?t| not) landed\b/i,
  /\bnot yet landed\b/i,
  /\bnot yet on main\b/i,
  /\bstill open\b/i,
]);

/** Does this quoting line use one of the closed list of "this hasn't happened yet" phrases? */
export const isPending = (text) => PENDING_PHRASES.some((re) => re.test(String(text || '')));

/**
 * Joins a citation row to what the tracker says about its id — `status`/`title` from
 * `statusById` (built by `bin/b7e-cites` from a single batched `bd show`), `'unknown'`
 * and a null title for an id the map has no entry for at all. Pure, so the join is
 * testable with a hand-built map and no `bd` in the loop.
 */
export function withStatus(rows, statusById) {
  return rows.map((r) => {
    const found = statusById.get(r.id);
    return found ? { ...r, status: found.status, title: found.title } : { ...r, status: 'unknown', title: null };
  });
}

/**
 * `--stale`'s whole rule: an id the tracker has no record of at all, or a pending phrase
 * about a bead that has since closed. Anything open, in progress or otherwise live is
 * left out even when the wording sounds tentative — an open bead saying it "has not
 * settled" is not wrong yet.
 */
export const staleFilter = (rows) => rows.filter((r) => r.status === 'unknown' || (r.status === 'closed' && isPending(r.text)));

/** `bc` from `bc-arj0.4` — re-exported so callers touch one module for both halves. */
export { prefixOf };
