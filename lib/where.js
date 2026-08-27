/**
 * Every surface a printed figure appears on — grouped, so a session can see at a glance
 * whether they agree — instead of one hand-rolled `grep` per surface, retried with a
 * different exclusion set each time. `bin/b7e-where` is the argv parsing and printing;
 * this is the walk, the grouping and the verdict, pure.
 *
 * bc-dgx7.16 is the session audit: six sophab sessions (sp-0hw, sp-clh, sp-oyg, sp-mgq,
 * sp-j8f, sp-weu) each did this by hand. Four of them opened with an unquoted
 * `--include=*.py` and got zsh's silent `(eval):1: no matches found` — a shell glob-
 * expansion failure this never risks, because it never shells out to a system `grep` and
 * never builds a command line for a shell to reparse: it reads files with `fs` and
 * matches with a JS `RegExp`, the same defence `lib/repogrep.js` (`b7e-grep`) and
 * `lib/cites.js` (`b7e-cites`) already documented for the same reason. Each of the six
 * then walked the surfaces one at a time, in separate calls, and `sp-clh` had to search
 * both `2x10` and `2×10` by hand — the E-sheets and S-sheets spell the same board two
 * different ways, and that spelling difference is exactly how `sp-ghq`'s defect hid.
 *
 * **The surface list is NOT a fixed set of this repo's own directories, unlike
 * `lib/repogrep.js`/`lib/cites.js`.** Those two intentionally only ever search
 * *beadcause's own* `lib`/`bin`/`test`/`scripts`/`public`/`android` — this tool is meant
 * to run from inside whatever repo the calling session is actually working in (sophab,
 * named in the bead this was filed from, or any other), so the four surfaces below are
 * *classified by convention* (a path segment named `test`/`tests`, a `.md` extension, a
 * `.html` extension or a `static`/`public`/`pages`/`templates` directory, everything
 * else) rather than named as fixed directories. `bin/` of the main checkout is on every
 * session's `PATH` regardless of which repo it is actually sitting in (`lib/foundation.js`
 * prefixes it) — see the memory note this is built against,
 * `a-worktree-aware-bin-resolves-root-from-cwd-not-here` — so root is always resolved
 * from `process.cwd()`, never from where this script itself lives on disk.
 *
 * **The file list is `git ls-files`, not a hand-walked tree.** Unlike `lib/repogrep.js`'s
 * own hardcoded `SKIP_DIR_NAMES`, an arbitrary target repo's generated-output
 * directories (sophab's own `out/`, its `out_`-prefixed siblings, `plans/`, `.venv/`,
 * `__pycache__/`) are not
 * knowable in advance — but its own `.gitignore` already lists them. `--cached --others
 * --exclude-standard` gets every tracked file plus every untracked-but-not-ignored one
 * (a session's own uncommitted edits, findable the moment they're saved), honouring
 * whatever `.gitignore` the target repo already has, with no exclusion list of our own to
 * keep in sync. Falls back to a small hardcoded walk only when `cwd` is not inside a git
 * repository at all — see `listFiles` below.
 *
 * **This never depends on `lib/repogrep.js`.** That file (`bc-4r10.21`) was still on the
 * merge queue, not yet on `main`, when this was written — importing it would make this
 * branch's own tests, and its eventual merge order, depend on which of the two PRs
 * happens to land first. `repoRoot` below is a small, deliberate duplicate of the same
 * ~15-line `git rev-parse --show-toplevel` helper `lib/repogrep.js` and `lib/cites.js`
 * both already carry independently, for the reason each of them documents. A later
 * consolidation once all three have landed is cheap; a build that only passes in one
 * merge order is not.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* --------------------------------------------------------------- root & file list */

/**
 * This process's own repo root — `git rev-parse --show-toplevel` from `cwd` — so a
 * session working inside a worktree (of beadcause, of sophab, of anything) is answered
 * with *that worktree's own* root, never the main checkout's, regardless of which copy
 * of `bin/b7e-where` actually ran. Falls back to `fallback` when `cwd` is not inside a
 * git repository at all.
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

/** Used only when `root` is not a git repository at all — no `.gitignore` to trust. */
const FALLBACK_SKIP_DIR_NAMES = new Set([
  'node_modules', '.git', '.claude', '.venv', 'venv', '__pycache__',
  '.pytest_cache', 'dist', 'build', '.gradle', '.idea', 'coverage', '.coverage',
]);

function walkFallback(root, absDir, out) {
  let entries;
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isSymbolicLink()) continue;
    const abs = path.join(absDir, e.name);
    if (e.isDirectory()) {
      if (FALLBACK_SKIP_DIR_NAMES.has(e.name)) continue;
      walkFallback(root, abs, out);
    } else if (e.isFile()) {
      out.push(toRel(root, abs));
    }
  }
}

/**
 * Every file under `root`, repo-relative and forward-slashed, sorted: tracked files plus
 * untracked-but-not-`.gitignore`d ones, via `git ls-files -z --cached --others
 * --exclude-standard`. A nested git repository (a worktree parked under `root`, e.g.) is
 * never descended into — `git ls-files` treats it as a gitlink, not a directory to walk —
 * so a sibling worktree's own copy of a file can never leak into a result. Falls back to
 * `walkFallback` (a small fixed skip-list, not `.gitignore`-aware) only when `root` is not
 * a git repository at all.
 */
export function listFiles(root) {
  try {
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 },
    );
    return out.split('\0').filter(Boolean).sort();
  } catch {
    const files = [];
    walkFallback(root, root, files);
    return files.sort();
  }
}

/* --------------------------------------------------------------- surface classification */

const TEST_PATH_RE = /(^|\/)tests?(\/|$)/i;
const TEST_NAME_RE = /(^|[._-])test([._-]|$)|\.spec\.\w+$/i;
const MARKUP_EXT_RE = /\.(html?|jinja2?|hbs)$/i;
const MARKUP_DIR_RE = /(^|\/)(static|public|pages|templates|views)(\/|$)/i;

/**
 * Which of the four surfaces `rel` (a repo-relative, forward-slashed path) belongs to.
 * Order matters: a file under a `test`/`tests` directory is `tests` even if it is also a
 * `.md` or `.html` file (a fixture belongs with the other tests, not with the docs or
 * markup it happens to resemble) — that is the one place this is not a simple
 * extension/directory lookup.
 */
export function classifySurface(rel) {
  if (TEST_PATH_RE.test(rel) || TEST_NAME_RE.test(path.basename(rel))) return 'tests';
  const ext = path.extname(rel).toLowerCase();
  if (ext === '.md' || ext === '.rst') return 'docs';
  if (MARKUP_EXT_RE.test(rel) || MARKUP_DIR_RE.test(rel)) return 'servedMarkup';
  return 'source';
}

export const SURFACE_LABELS = Object.freeze({
  source: 'source',
  docs: 'docs',
  tests: 'tests',
  servedMarkup: 'served markup',
});
export const SURFACE_ORDER = Object.freeze(['source', 'docs', 'tests', 'servedMarkup']);

/** A docs file this repo treats as the registered "does this figure agree" ledger. */
const AUDIT_DOC_RE = /audit/i;
export function isAuditDoc(rel) {
  return classifySurface(rel) === 'docs' && AUDIT_DOC_RE.test(path.basename(rel));
}

/* --------------------------------------------------------------- pattern & search */

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `term`, compiled to a `RegExp` that matches either spelling of a figure like `2x10` /
 * `2×10` — every literal `x`, `X` or `×` in `term` becomes the class `[x×X]`, so a search
 * for one spelling finds the other without the caller having to know which sheet used
 * which glyph. This is the one normalisation the bead itself asks for by name; nothing
 * else about `term` is touched. `term` is treated as a literal string (regex-escaped)
 * unless `regex` is set, for a caller that wants a real pattern.
 */
export function buildPattern(term, { regex = false, ignoreCase = false } = {}) {
  const src = regex ? term : escapeRe(term).replace(/[x×X]/g, '[x×X]');
  return new RegExp(src, ignoreCase ? 'i' : '');
}

const BINARY_SNIFF_BYTES = 8000;
function looksBinary(buf) {
  const n = Math.min(buf.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * `term` found in every file under `root` (via `listFiles`), grouped by
 * `classifySurface`. Returns `{ term, root, filesSearched, bySurface, surfaceFileCounts,
 * auditDoc, verdict }`:
 *
 *   - `bySurface[<key>]`: `[{ file, hits: [{ line, text }] }]`, only files with a hit,
 *     sorted the same way `listFiles` returned them.
 *   - `surfaceFileCounts[<key>]`: how many files in the whole repo classify to that
 *     surface, hit or not — what `verdict` uses to tell "this surface has files but none
 *     of them matched" from "this repo has no such surface at all".
 *   - `auditDoc`: `{ file, hits }` for the first doc file `isAuditDoc` names, or `null`.
 *   - `verdict`: one line naming which surfaces (of the ones that exist in this repo)
 *     have a hit and which don't. This is presence, not value comparison — the same
 *     "good enough to replace the hand grep, not a substitute for reading the file"
 *     tradeoff `bin/b7e-def`'s own doc comment makes; it cannot tell you a value printed
 *     on two surfaces disagrees, only that one surface never mentions it at all.
 */
export function searchSurfaces(root, term, opts = {}) {
  const re = buildPattern(term, opts);
  const files = listFiles(root);
  const bySurface = { source: [], docs: [], tests: [], servedMarkup: [] };
  const surfaceFileCounts = { source: 0, docs: 0, tests: 0, servedMarkup: 0 };
  let auditDoc = null;

  for (const rel of files) {
    const surface = classifySurface(rel);
    surfaceFileCounts[surface] += 1;
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
      if (re.test(line)) hits.push({ line: i + 1, text: line });
    }
    if (!hits.length) continue;
    bySurface[surface].push({ file: rel, hits });
    if (!auditDoc && isAuditDoc(rel)) auditDoc = { file: rel, hits };
  }

  const present = SURFACE_ORDER.filter((k) => surfaceFileCounts[k] > 0);
  const hit = present.filter((k) => bySurface[k].length > 0);
  const missing = present.filter((k) => bySurface[k].length === 0);
  let verdict;
  if (!present.length) {
    verdict = 'no source, docs, tests or served markup found under this root at all';
  } else if (!hit.length) {
    verdict = `${term} not found on any surface (checked: ${present.map((k) => SURFACE_LABELS[k]).join(', ')})`;
  } else if (!missing.length) {
    verdict = `${term} found on every surface that exists here: ${hit.map((k) => SURFACE_LABELS[k]).join(', ')}`;
  } else {
    verdict = `${term} found in ${hit.map((k) => SURFACE_LABELS[k]).join(', ')} — not in ${missing
      .map((k) => SURFACE_LABELS[k])
      .join(', ')}`;
  }

  return { term, root, filesSearched: files.length, bySurface, surfaceFileCounts, auditDoc, verdict };
}
