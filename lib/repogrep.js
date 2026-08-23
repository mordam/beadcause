/**
 * Search this repo's own files — the roots and exclusions already decided.
 * `bin/b7e-grep` is the argv parsing and printing; this is the walking and matching.
 *
 * bc-4r10.21 is a session-audit bead naming the same shape a sixth time: `bc-4r10.9`
 * (importers of `incident.js`/`vulnscan.js`), `bc-eqn1.2` (importers of `controls.js`),
 * `bc-4r10.1` (twice — "does anything on main reference `controls.js`"), `bc-ka5y.15.5`
 * (the seven `*Event` exports of `lib/news.js`), `bc-7wwbb` (`p0board`) and `bc-4r10.4`
 * (`gap`) each hand-wrote `grep -rn <pat> --include=*.js --include=*.mjs ...` and each got
 * `(eval):1: no matches found: --include=*.js` — zsh glob-expands the unquoted
 * `--include=*.js` before `grep` ever runs, finds no file by that literal name (nothing
 * is), and kills the whole line with nothing on stdout to explain why. The six retries
 * diverged from there: one quoted the includes, one dropped them and listed `lib bin test
 * scripts android` by hand, one added an `--exclude-dir` chain, one switched to
 * `--exclude=` on filenames — six different workarounds for one bug, none of them shared.
 *
 * **Why this never hits that bug at all, rather than working around it better.** This
 * never shells out to a system `grep` and never builds a command line for a shell to
 * reparse — it reads files with `fs` and matches with a JS `RegExp`. So there is no
 * `--include`/`--exclude` flag here to begin with, and nothing for an unquoted `*` in a
 * *flag value* to break: `--in` takes a fixed, closed set of comma-separated names
 * (`ROOT_KEYS` below), never a glob.
 *
 * **The root set is fixed for the reason the six sessions each guessed it differently.**
 * `bc-eqn1.2`'s quoted retry ran from `.`, and two of its hits turned out to belong to a
 * *live sibling worktree's own copy* of the same files
 * (`.claude/worktrees/epic-done-ka5y152/test/servicescope.mjs`), which it then had to
 * notice and discount by eye. `collectFiles` below never descends into `.claude/` at all
 * (nor `node_modules`, `.git`, `public/vendor`, `.coverage`, `dist`, or android's own
 * `.gradle`/`build` output and packaged `.apk` — the same list `.gitignore` already
 * settled on for exactly these being generated or third-party, not source), so a sibling
 * worktree nested under it — this repo's own convention, see the worktree list in every
 * session's own `SessionStart` context — can never leak into a result.
 *
 * **Which tree "this repo" means is resolved from `cwd`, not from where this script
 * happens to live on disk.** `bin/` of the *main checkout* is on every agent's `PATH`
 * (`lib/foundation.js`), so the file that actually runs is always the main checkout's copy
 * of `bin/b7e-grep` — but the process's own `cwd` is wherever the caller is, worktree or
 * not, and `git rev-parse --show-toplevel` from there answers with *that worktree's own*
 * root, never the main checkout's. That is `repoRoot()` below, and it is what makes
 * running from inside a worktree search that worktree's own files (uncommitted edits
 * included) instead of always answering from the main checkout regardless of where the
 * agent actually is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Used only when `cwd` is not inside any git worktree at all — this file's own checkout. */
const FALLBACK_ROOT = path.join(HERE, '..');

/** `--in` root keys that name a directory, walked recursively. */
export const ROOT_DIRS = Object.freeze({
  lib: 'lib',
  bin: 'bin',
  test: 'test',
  scripts: 'scripts',
  public: 'public',
  android: 'android',
});
/** `readme` names a single file, not a directory — kept out of `ROOT_DIRS` for that reason. */
const README_KEY = 'readme';
const README_FILE = 'README.md';

/** Every key `--in` accepts. With none given, `collectFiles` searches all of these. */
export const ROOT_KEYS = Object.freeze([...Object.keys(ROOT_DIRS), README_KEY]);

/**
 * Directory names never walked into, wherever they appear under a root: `node_modules`,
 * `.git` and `.claude` are never source; `.coverage` and `dist` are `scripts/coverage.mjs`
 * output; `.gradle` and `build` (and its sibling `app/build`) are android's own generated
 * output, the same three `.gitignore` already excludes for `android/`. A directory
 * literally named `build` under `lib/`, `bin/`, `test/`, `scripts/` or `public/` would
 * also be skipped by this — there is none, and if one is ever added on purpose this list
 * is the one-line fix.
 */
const SKIP_DIR_NAMES = new Set(['node_modules', '.git', '.claude', '.coverage', 'dist', '.gradle', '.idea', 'build']);
/** Repo-relative paths never walked into — checked as an exact relative path, not a name. */
const SKIP_PATHS = new Set(['public/vendor']);
/** The packaged app and the manifest beside it (`lib/update.js`) — binary, and rebuilt, not read. */
const APK_RE = /\.apk(\.json)?$/i;

/**
 * This process's own worktree root: `git rev-parse --show-toplevel` from `cwd`, so a
 * session working inside `.claude/worktrees/<name>` gets that worktree's own files, never
 * the main checkout's regardless of which copy of this script actually executed. Falls
 * back to the checkout this file itself lives in when `cwd` is not inside a git worktree
 * at all (there is no other answer to give).
 */
export function repoRoot(cwd = process.cwd()) {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return FALLBACK_ROOT;
  }
}

const toRel = (root, abs) => path.relative(root, abs).split(path.sep).join('/');

/** Every file under `absDir`, repo-relative and forward-slashed, appended to `out`. */
function walk(root, absDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return; // the root doesn't have this directory at all — not an error, just nothing here
  }
  for (const e of entries) {
    // Never followed: a worktree's own `node_modules` is a symlink (bc-oqu7/bc-mf9s put
    // `public/vendor` itself behind one too, before it became a real directory of links),
    // and following one risks a cycle this walk has no visited-set to catch.
    if (e.isSymbolicLink()) continue;
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
 * Every file `--in`'s keys (or, with none given, all of `ROOT_KEYS`) resolve to under
 * `root`, repo-relative, forward-slashed, deduplicated and sorted. `keys` entries not in
 * `ROOT_KEYS` are silently ignored here — `bin/b7e-grep` validates argv before this is
 * ever called, and a caller of the library is trusted the same way `lib/affected.js`
 * trusts its own callers.
 */
export function collectFiles(root, keys) {
  const use = keys && keys.length ? keys : ROOT_KEYS;
  const seen = new Set();
  const files = [];
  for (const key of use) {
    if (key === README_KEY) {
      const abs = path.join(root, README_FILE);
      if (!seen.has(README_FILE) && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        seen.add(README_FILE);
        files.push(README_FILE);
      }
      continue;
    }
    const dir = ROOT_DIRS[key];
    if (!dir) continue;
    const out = [];
    walk(root, path.join(root, dir), out);
    for (const f of out) {
      if (!seen.has(f)) {
        seen.add(f);
        files.push(f);
      }
    }
  }
  return files.sort();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `patterns` compiled to `RegExp`s — literal-escaped first when `fixed` is set, both
 * flavours sharing one `i` flag when `ignoreCase` is set. Multiple patterns are matched
 * as alternatives (OR), never combined into one — so a caller never has to build the
 * `(a|b|c)` themselves, or worry about one pattern's own `|` colliding with another's.
 * Throws with a `BAD_PATTERN`-coded `Error` naming the offending pattern on an invalid
 * regex, rather than letting `new RegExp` throw a message with no idea which pattern.
 */
export function compilePatterns(patterns, { fixed = false, ignoreCase = false } = {}) {
  const flags = ignoreCase ? 'i' : '';
  return patterns.map((p) => {
    const src = fixed ? escapeRe(p) : p;
    try {
      return new RegExp(src, flags);
    } catch (err) {
      const wrapped = new Error(`bad pattern ${JSON.stringify(p)}: ${err.message}`);
      wrapped.code = 'BAD_PATTERN';
      throw wrapped;
    }
  });
}

/**
 * Is this file binary — a NUL byte anywhere in its first 8000 bytes, the same heuristic
 * `grep` itself uses to decide whether to say "binary file matches" instead of printing
 * lines. Nothing under the roots this walks is expected to *be* binary (`android/`'s own
 * `.jar`/`.wav` files are the only ones found when this was built), but a `.png` dropped
 * into `public/` tomorrow should be skipped rather than dumped as mojibake, and this is
 * cheaper and more honest than a hardcoded extension list.
 */
function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * The whole answer for one root, one list of patterns and the options above:
 * `{ results: [{ file, hits: [{ line, text }] }], total, filesSearched }`. `results` only
 * carries files with at least one hit, in the same sorted order `collectFiles` returns —
 * files are read in that order too, so output is deterministic run to run. A file that
 * can't be read (permissions, a symlink that raced away between the walk and the read) or
 * that looks binary is skipped, not an error — the same "absent, not failed" reading
 * `collectFiles` gives a root directory that doesn't exist.
 */
export function search(root, patterns, opts = {}) {
  const regexes = compilePatterns(patterns, opts);
  const files = collectFiles(root, opts.keys);
  const results = [];
  let total = 0;
  for (const rel of files) {
    let buf;
    try {
      buf = fs.readFileSync(path.join(root, rel));
    } catch {
      continue;
    }
    if (looksBinary(buf)) continue;
    const lines = buf.toString('utf8').split('\n');
    const hits = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].replace(/\r$/, '');
      if (regexes.some((re) => re.test(line))) hits.push({ line: i + 1, text: line });
    }
    if (hits.length) {
      results.push({ file: rel, hits });
      total += hits.length;
    }
  }
  return { results, total, filesSearched: files.length };
}
