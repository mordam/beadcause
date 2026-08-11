#!/usr/bin/env node
/**
 * No shell script writes a `grep` option *after* the `--` that ends its options.
 *
 *     npm test
 *     node test/grepargs.mjs
 *     node test/grepargs.mjs --dir ~/.claude          # sweep a tree outside this repo
 *
 * `--` and `--exclude-dir` are each unremarkable. Together they are a trap, and the trap
 * is that the option silently becomes a *filename*:
 *
 *     grep -rlq -- "$name" "$dir" --exclude-dir=archive   # searches archive/ anyway
 *
 * `--` ends option parsing — POSIX Utility Syntax Guideline 10 — so everything after it
 * is an operand. `--exclude-dir=archive` is therefore a file grep is asked to search, it
 * does not exist, and the exclusion never happens. grep says so on stderr, which in a
 * script gating on the exit status is behind `2>/dev/null`, so there is nothing to see.
 * The filter simply does not apply, which is always the permissive direction.
 *
 * bc-uytt is what this cost. The `ship` skill's attic sweep tested each retired worktree
 * for a handoff that still mentioned it, with exactly that line. `archive/` — spent
 * handoffs, excluded by definition — was searched every time, so every spent handoff went
 * on protecting its attic entry from removal, forever. The line had been wrong since it
 * was written and no output ever hinted at it.
 *
 * ## The rule this is *not*
 *
 * bc-2mpr filed this as an option-order problem: that `grep` on this laptop is ugrep,
 * which honours only the options written before the paths, where GNU grep accepts them
 * anywhere. That is not what is happening, and the distinction decides which call sites
 * are bugs. Measured, in a directory with a match in `keep/` and a match in `archive/`:
 *
 *     grep -rl "needle" dir --exclude-dir=archive        ugrep: keep only.  BSD: keep only.
 *     grep -rl "needle" --exclude-dir=archive dir        ugrep: keep only.  BSD: keep only.
 *     grep -rl -- "needle" dir --exclude-dir=archive     ugrep: BOTH, rc=2. BSD: BOTH, rc=2.
 *
 * Options after the path are honoured — by ugrep 7.5 and by macOS BSD grep alike. Only
 * `--` breaks it, and `--` breaks it *everywhere*, GNU grep included: it is the one part
 * of the syntax every implementation is required to agree on. So the fix is never "move
 * the flag earlier because of ugrep". It is "the `--` is in the wrong place", and the
 * same line on a GNU box was equally broken.
 *
 * The symptom says so too. Under ugrep the missing file makes `grep -q` exit 2, which a
 * shell reads as *no match* — the sweep would have deleted attic entries rather than
 * keeping them. It kept them, which needs exit 0, which is BSD grep. And that is right:
 * the ugrep `grep` is a shell function from Claude Code's snapshot, and a function does
 * not survive into `bash prune-retired.sh`. Scripts here get `/usr/bin/grep`. Only the
 * commands an agent types into its own Bash tool get ugrep.
 *
 * ## What this checks, and what it deliberately does not
 *
 * A grep is flagged only when an option-shaped word follows the `--` in the *same*
 * command. Options after a path, with no `--`, are left alone — they are correct, they
 * are measured above, and flagging them would be a rule that makes working lines look
 * broken. Options before everything are the form to write. If you genuinely mean to
 * search a file whose name begins with a dash, write it as `./-name`, which is what the
 * `--` was for in the first place.
 *
 * `git grep` is skipped: it is git's own parser, its `--` separates revisions from paths
 * rather than options from operands, and it is a different question. Comment lines are
 * skipped, because the two files in this repo that contain the broken form contain it as
 * a quotation of the bug (this header is the second one).
 *
 * Shell scripts are the target, plus fenced commands in tracked markdown — an agent
 * copies a fenced command verbatim, which makes a wrong one in a skill or a doc every bit
 * as live as a wrong one in a script. `--dir` points the same sweep at a tree outside the
 * repo, which is how `~/.claude` and `~/.claude-personal/skills` were checked for bc-2mpr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

/** Every spelling of grep that takes grep's arguments. `git grep` is not one of them. */
const GREP = /^(?:.*\/)?(?:u|e|f|z|zip|xz|bz)?grep$/;

/**
 * Words that can precede a command without being one, so `if grep …` is still a grep.
 *
 * Env assignments (`LC_ALL=C grep …`) are matched by shape rather than listed.
 */
const PREFIX = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', 'command', 'exec', 'sudo', 'time', 'nice', '{', '(']);

/**
 * Short options that take a separate argument, and only when they end the cluster.
 *
 * `-e PAT` puts the pattern in the option, so the path that follows is the *first*
 * operand and not the pattern — the walk below has to know that to keep its count of
 * what has been consumed straight. `-rne PAT` is the same option at the end of a
 * cluster; `-m5` carries its own argument and consumes nothing.
 */
const SHORT_ARG = new Set(['e', 'f', 'm', 'A', 'B', 'C', 'd', 'D', 'N', 'Q', 'T']);

/** Long options that take a separate argument when not written with `=`. */
const LONG_ARG = new Set([
  '--regexp', '--file', '--max-count', '--after-context', '--before-context', '--context',
  '--binary-files', '--devices', '--directories', '--label', '--include', '--exclude',
  '--exclude-dir', '--exclude-from', '--include-dir', '--include-from', '--group-separator',
]);

/**
 * Split a line into words the way a shell would, near enough.
 *
 * Quotes are removed and their contents kept as one word, which is what makes
 * `-- "$name" "$dir" --exclude-dir=archive` come apart into the four words that matter.
 * A quoted `"--exclude-dir=x"` therefore reads as an option; that is a deliberate trade,
 * because the quoting does not change what grep does with it either.
 */
function words(segment) {
  const out = [];
  let cur = '';
  let quote = null;
  let started = false;
  for (const c of segment) {
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      started = true;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur || started) out.push(cur);
      cur = '';
      started = false;
      continue;
    }
    cur += c;
  }
  if (cur || started) out.push(cur);
  return out;
}

/** One line, cut into the commands it runs. A line-level read, like test/pipefail.mjs. */
function commands(line) {
  return line
    .replace(/\$\(/g, ' ')
    .replace(/[`)}]/g, ' ')
    .split(/\|\||&&|[|;&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const optionish = (w) => w.length > 1 && w.startsWith('-') && w !== '--';

/**
 * The option-shaped words that follow a `--` in a grep command, if any.
 *
 * Everything before the `--` is skipped rather than validated: an option there is
 * correct wherever it sits, and the only interesting question is what comes after.
 */
function afterDoubleDash(cmd) {
  const w = words(cmd).filter((x) => x !== '');
  let i = 0;
  while (i < w.length && (PREFIX.has(w[i]) || /^[A-Za-z_][A-Za-z0-9_]*=/.test(w[i]))) i += 1;
  if (i >= w.length || !GREP.test(w[i])) return [];

  const rest = w.slice(i + 1);
  const dash = rest.indexOf('--');
  if (dash === -1) return [];

  // A `--` that is itself the argument of an option (`-e --`) is a pattern, not the
  // terminator. Walk the options to find out which one this is.
  let j = 0;
  while (j < dash) {
    const t = rest[j];
    if (!optionish(t)) break; // an operand before the `--`: the `--` is just a word
    if (t.startsWith('--')) {
      if (!t.includes('=') && LONG_ARG.has(t)) j += 1;
    } else {
      const last = t[t.length - 1];
      if (SHORT_ARG.has(last)) j += 1;
    }
    j += 1;
  }
  if (j !== dash) return [];

  return rest.slice(dash + 1).filter(optionish);
}

/**
 * The lines of a file that can actually run.
 *
 * Shell comments are dropped. Markdown is reduced to its fenced blocks, because a fenced
 * command is what gets copied and everything around it is prose that may well be
 * *describing* the bug.
 */
function runnableLines(text, ext) {
  const lines = text.split('\n').map((t, i) => ({ n: i + 1, text: t }));
  if (ext === '.md') {
    const out = [];
    let fenced = false;
    for (const line of lines) {
      if (/^\s*(```|~~~)/.test(line.text)) {
        fenced = !fenced;
        continue;
      }
      if (fenced && line.text.trim()) out.push(line);
    }
    return out;
  }
  return lines.filter(({ text: t }) => t.trim() && !t.trim().startsWith('#'));
}

/** Files worth reading: shell scripts and markdown, minus the places nobody edits. */
function scanTargets(root) {
  const SKIP = new Set(['node_modules', '.git', 'worktrees', 'worktrees-retired', 'backups', 'shell-snapshots', 'android', 'vendor', 'cache', 'file-history', 'projects', 'todos', 'statsig', 'plugins']);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const at = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(at, depth + 1);
        continue;
      }
      const ext = path.extname(e.name);
      if (ext === '.sh' || ext === '.bash' || ext === '.zsh' || ext === '.md') found.push(at);
    }
  };
  walk(root, 0);
  return found;
}

function scanFile(file) {
  const hits = [];
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return hits;
  }
  for (const { n, text: line } of runnableLines(text, path.extname(file))) {
    for (const cmd of commands(line)) {
      const strays = afterDoubleDash(cmd);
      if (strays.length) hits.push({ file, n, line: line.trim(), strays });
    }
  }
  return hits;
}

// ---------------------------------------------------------------------------
// `--dir`: the same sweep, pointed somewhere else. Reports and exits; no assertions,
// because a tree outside the repo is not this repo's to fail on.
// ---------------------------------------------------------------------------
const dirArg = process.argv.indexOf('--dir');
if (dirArg !== -1) {
  const root = path.resolve(process.argv[dirArg + 1] || '.');
  const files = scanTargets(root);
  const hits = files.flatMap(scanFile);
  console.log(`swept ${files.length} file${files.length === 1 ? '' : 's'} under ${root}`);
  for (const h of hits) {
    console.log(`  ${path.relative(root, h.file)}:${h.n} — ${h.strays.join(' ')} after \`--\`\n      ${h.line}`);
  }
  console.log(hits.length ? `${hits.length} site(s) to fix` : 'clean');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// The repo.
// ---------------------------------------------------------------------------
const targets = [];
for (const dir of ['scripts', 'bin', 'docs', 'test']) {
  const at = path.join(ROOT, dir);
  if (fs.existsSync(at)) targets.push(...scanTargets(at));
}
for (const f of ['README.md']) {
  const at = path.join(ROOT, f);
  if (fs.existsSync(at)) targets.push(at);
}

if (targets.length) ok(`shell scripts and docs found (${targets.length})`);
else bad('there are files to check', 'found none under scripts/, bin/, docs/ or test/');

const offenders = targets.flatMap(scanFile);
if (offenders.length) {
  bad(
    'no grep passes an option after its `--`',
    `${offenders.length} site${offenders.length === 1 ? '' : 's'} — the option is being read as a filename:\n      ${offenders
      .map((h) => `${path.relative(ROOT, h.file)}:${h.n} — ${h.strays.join(' ')}\n          ${h.line}`)
      .join('\n      ')}`
  );
} else {
  ok('no grep passes an option after its `--`');
}

// ---------------------------------------------------------------------------
// The detector, against the line that caused bc-uytt and the forms that are fine.
// Without this a broken regex reads as a clean repo.
// ---------------------------------------------------------------------------
const CASES = [
  ['the line bc-uytt was caused by', 'grep -rlq -- "$name" "$dir" --exclude-dir=archive 2>/dev/null', 1],
  ['the fix: options before the `--`', 'grep -rlq --exclude-dir=archive -- "$name" "$dir" 2>/dev/null', 0],
  ['an option after the path, no `--` (works; not a finding)', 'grep -rn "$name" "$dir" --exclude-dir=archive', 0],
  ['a short option after the `--`', 'grep -rl -- "$name" "$dir" -i', 1],
  ['`--` with nothing but operands after it', 'grep -qF -- "$label" "$file"', 0],
  ['a grep with no `--` at all', 'grep -qx "worktree $dir" "$file"', 0],
  ['`git grep`, which is a different parser', 'git grep -l -e "$pat" -- "$dir" --exclude-dir=x', 0],
  ['a pattern that is literally `--`', 'grep -e -- "$file"', 0],
  ['inside an `if`', 'if grep -q -- "$p" "$f" --include=x; then', 1],
  ['a pipeline stage', 'cat "$f" | grep -q -- "$p" -i', 1],
];
for (const [name, line, want] of CASES) {
  const got = commands(line).reduce((sum, cmd) => sum + (afterDoubleDash(cmd).length ? 1 : 0), 0);
  if (got === want) ok(`detector: ${name}`);
  else bad(`detector: ${name}`, `flagged ${got}, expected ${want}\n          ${line}`);
}

// ---------------------------------------------------------------------------
// The behaviour itself, measured rather than remembered — this is the claim the whole
// file rests on, and it is one `spawnSync` away. `grep` here is the binary on PATH:
// execve does not see the shell function, which is the point made in the header.
// ---------------------------------------------------------------------------
const tmp = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'grepargs-'));
try {
  fs.mkdirSync(path.join(tmp, 'keep'));
  fs.mkdirSync(path.join(tmp, 'archive'));
  fs.writeFileSync(path.join(tmp, 'keep', 'a.txt'), 'needle\n');
  fs.writeFileSync(path.join(tmp, 'archive', 'b.txt'), 'needle\n');
  const run = (args) => spawnSync('grep', args, { cwd: tmp, encoding: 'utf8' });

  const before = run(['-rl', '--exclude-dir=archive', '--', 'needle', '.']);
  const after = run(['-rl', '--', 'needle', '.', '--exclude-dir=archive']);
  const noDash = run(['-rl', 'needle', '.', '--exclude-dir=archive']);

  if (before.error) {
    ok('grep behaviour (skipped: no grep binary on PATH)');
  } else {
    const searched = (r) => (r.stdout || '').includes('archive');

    if (!searched(before)) ok('an option before the `--` excludes the directory');
    else bad('an option before the `--` excludes the directory', `stdout: ${JSON.stringify(before.stdout)}`);

    if (searched(after)) ok('an option after the `--` is ignored — the directory is searched anyway');
    else bad('an option after the `--` is ignored', `expected archive/ in the results, got ${JSON.stringify(after.stdout)}`);

    if (!searched(noDash)) ok('an option after the *path* is honoured — order alone is not the bug');
    else bad('an option after the path is honoured', `archive/ was searched: ${JSON.stringify(noDash.stdout)}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
