/**
 * One deterministic occurrence census for a literal (or an extended-regex pattern), at a
 * fixed git ref — `bin/b7e-count` is the argv shell; this is the counting.
 *
 * bc-dgx7.59, filed by the session audit (`lib/sessionaudit.js`) against four sessions
 * (`dv-i5v`, `dv-5i2.44`, `dv-nnk`, `dv-6cn`) that each needed "how many times does this
 * literal appear, and in how many files" and each hand-rolled a different pipeline —
 * `git grep -lI ... | tee | wc -l`, a `while read` loop piped through `awk`, a
 * `scratchpad/count.py`, `grep -rn --include=*.md` rejected by zsh globbing before it
 * even ran — and at least two of those disagreed with each other on the same tree. This
 * is the one answer.
 *
 * **`git grep -I -o -n -z`, not `-c`.** `-c` counts matching *lines*, and a line naming
 * the same literal twice is one line and two occurrences — exactly the distinction that
 * made dv-i5v's three pipelines disagree (a `git grep -lI` count, a `while read`+`awk`
 * count, and a `python3` count, three different numbers off the same tree). `-o` prints
 * only the matched text, one per output line, so counting lines of `-o` output *is*
 * counting occurrences. `-z` NUL-separates the ref, path and line-number fields instead
 * of `:`, so a path that happens to contain a colon is never misparsed as a second
 * field — see `parseGrepOutput` below for the exact shape this prints.
 *
 * **Always at a ref, never `--no-index`.** `git grep <pattern> <ref> -- <pathspec>`
 * reads the git tree object at `ref`, not the live working directory — so a stale
 * sibling git worktree sitting on disk under `.claude/worktrees/` (a *second full
 * checkout* of the same repo, which is exactly what inflated a plain recursive
 * `grep -rn --include=*.md .` in dv-6cn's first attempt) is never walked into in the
 * first place. `.git` and `.claude/worktrees` are excluded from the pathspec anyway,
 * defensively, so that invariant holds even if a future caller ever points this at
 * something other than a committed ref.
 */
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.join(HERE, '..');

// Tried in order when no --ref is given — the same fallback lib/affected.js's
// `resolvableBase` and lib/counterproof.js's own copy of it already use, and the reading
// of "the delivery base" this bead's own text asks for: the ref a branch here actually
// delivers into.
const DEFAULT_REF_CANDIDATES = ['origin/main', 'main'];

// Always excluded from every count, whatever the caller's own --paths/--exclude say —
// see the docblock above for why this matters even though a ref-based git grep never
// walks either of these on its own.
const ALWAYS_EXCLUDED = ['.git', '.claude/worktrees'];

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * The ref this census runs against: `ref` itself if it resolves to a tree in `dir`, else
 * (with no `ref` given) `origin/main` falling back to `main`. Throws — never guesses —
 * when nothing given resolves, so a typo'd `--ref` or a workspace with neither remote
 * fails loudly instead of silently counting an empty tree.
 */
export function resolveRef(dir, ref) {
  const candidates = ref ? [ref] : DEFAULT_REF_CANDIDATES;
  for (const cand of candidates) {
    try {
      git(dir, ['rev-parse', '--verify', `${cand}^{tree}`]);
      return cand;
    } catch {
      // try the next candidate
    }
  }
  if (ref) throw new Error(`${ref} does not resolve to a tree in ${dir}`);
  throw new Error(`neither origin/main nor main resolves to a tree in ${dir} — pass --ref`);
}

function emptyResult(pattern, regex) {
  return { pattern, regex, occurrences: 0, files: 0, perFile: [] };
}

/**
 * Parse `git grep -I -o -n -z`'s stdout into `{ occurrences, files, perFile }`.
 *
 * Each record is one line, NUL-separating three fields — `<ref>:<path>`, `<line>`,
 * `<match>` — and terminated by a real newline (`-z` only changes the *inter-field*
 * separator, not the record terminator, so splitting on `\n` first and then `\0` is
 * exactly right). The first field still joins `ref` and `path` with a literal `:`
 * (confirmed against `git grep(1)`'s own behaviour), so the path is recovered by
 * stripping the known `${ref}:` prefix rather than splitting on `:` again — a path is
 * never guaranteed colon-free, and a ref is.
 */
function parseGrepOutput(out, ref, pattern, regex) {
  const prefix = `${ref}:`;
  const perFileCounts = new Map();
  let occurrences = 0;
  for (const line of out.split('\n')) {
    if (!line) continue;
    const fields = line.split('\0');
    const refPath = fields[0];
    const file = refPath.startsWith(prefix) ? refPath.slice(prefix.length) : refPath;
    occurrences += 1;
    perFileCounts.set(file, (perFileCounts.get(file) || 0) + 1);
  }
  const perFile = [...perFileCounts.entries()]
    .map(([filePath, count]) => ({ path: filePath, count }))
    .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
  return { pattern, regex, occurrences, files: perFile.length, perFile };
}

/**
 * Every occurrence of one `pattern` at `ref` in `dir`.
 *
 * `regex: true` runs it as an extended regex (`git grep -E`); the default is a fixed
 * string (`-F`) — a literal counted with `-F` can never be surprised by a character in
 * it that happens to mean something in ERE, which is the whole class of bug the bead's
 * own "or --regex" split exists to keep separate.
 *
 * `paths`/`excludes` are git pathspecs (glob magic applied), on top of the two always-
 * excluded above. An exclude-only pathspec list still matches everything else, which is
 * ordinary git pathspec behaviour and not special-cased here.
 */
export function countOccurrences(dir, ref, pattern, { regex = false, paths = [], excludes = [] } = {}) {
  const pathspecs = [
    ...ALWAYS_EXCLUDED.map((p) => `:(glob,exclude)${p}`),
    ...excludes.map((p) => `:(glob,exclude)${p}`),
    ...paths.map((p) => `:(glob)${p}`),
  ];
  const args = ['grep', '-I', '-o', '-n', '-z', regex ? '-E' : '-F', '-e', pattern, ref, '--', ...pathspecs];
  let out;
  try {
    out = git(dir, args);
  } catch (err) {
    if (err.status === 1) return emptyResult(pattern, regex); // git grep: ran fine, nothing matched
    const stderr = (err.stderr || err.message || '').toString().trim();
    throw new Error(`git grep failed for ${JSON.stringify(pattern)} at ${ref}: ${stderr || `exit ${err.status}`}`);
  }
  return parseGrepOutput(out, ref, pattern, regex);
}

/** One result per pattern, in the order given — the whole census for one call. */
export function census(dir, ref, patterns, { regex = false, paths = [], excludes = [] } = {}) {
  return patterns.map((pattern) => countOccurrences(dir, ref, pattern, { regex, paths, excludes }));
}
