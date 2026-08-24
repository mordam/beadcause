/**
 * Whether a shell script ever reaches outside a fixed set of directories, checked by
 * reading the script rather than running it — the same question `bin/b7e-sh` exists to
 * answer before it hands the script to `bash`.
 *
 * This is a heuristic over the *text* of the script, not a sandbox: it does not run
 * anything, and it does not stop a script from doing something destructive *inside* the
 * allowed roots. What it catches is a path that leaves them, in every spelling this file
 * knows how to recognise — an absolute path, a relative one that walks out with `..`, a
 * redirection target (`>/etc/x` attached or ` > /etc/x` spaced), an option value
 * (`--git-dir=/repo/other/.git`), a `git -C`, a `cd`. A script this cannot follow (built
 * from a variable, from `eval`, from a subshell it cannot see into) is not waved through
 * — it is refused, on the same "cannot verify it stays inside" reasoning the worktree's
 * own Bash approval uses, so this never grants a script safety nobody actually checked.
 *
 * Two things make that bearable rather than useless, and both are why this file is more
 * than a regex over `/`:
 *
 * - **It knows a program text from a filename.** `sed '/^debug/d' f.txt`,
 *   `awk '/^foo/ {print}'` and `grep '/api/v1'` all hand a leading `/` to a command whose
 *   first operand is an *expression*, not a path. Refusing those would refuse the very
 *   use case bc-ka5y.29 was filed for (bc-ka5y.19's `sed` loop), so `EXPRESSION_COMMANDS`
 *   names the handful of commands that take one and where it sits in their argument list.
 *   The exemption is deliberately narrow: it covers one quoted operand, it lapses the
 *   moment a `-e`/`-f` says the operands are files, and every other token in the line —
 *   redirection targets included — is checked as usual. An unquoted `/etc/passwd` in that
 *   position is still refused, because the cost of being wrong there is an escape and the
 *   cost of being wrong the other way is one pair of quotes.
 * - **It compares directories, not strings.** A root and a target that name the same
 *   directory through different symlinks — `/tmp/x` and `/private/tmp/x` on macOS, which
 *   is exactly how `mktemp -d` and the session scratchpad differ — are the same place, so
 *   containment is tried textually first and then again with both sides resolved through
 *   `realpath`. That resolution is the one thing here that touches the filesystem, and it
 *   only ever *widens* what is allowed: a root that does not exist yet, or a target that
 *   does not (the case `mkdir -p` and a script's own output files are for), falls back to
 *   the textual answer rather than failing.
 *
 * Known limits, stated rather than papered over: it does not track quoting across lines,
 * so a heredoc's body is read as code (which errs towards refusing); it does not expand
 * a variable, so `"$dir/f"` is refused as unverifiable rather than guessed at; and a
 * command not in `EXPRESSION_COMMANDS` that takes program text will have a leading `/`
 * in it refused. All three fail towards "no", which is the direction a guard may fail in.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Special files that are never a real escape, whatever root list is in force. */
const ALWAYS_ALLOWED = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/**
 * Commands whose *first operand is program text* rather than a filename, and the flags
 * that change that. `exprFlags` take the program on the flag instead (`sed -e '…'`),
 * `fileFlags` take it from a file (`awk -f prog.awk`) — and either one means every
 * operand after it is a file, which is POSIX's own rule and the reason the leading-operand
 * exemption lapses when one appears. `valueFlags` is every flag that consumes the next
 * word, so a flag's value is never mistaken for the operand.
 *
 * `sed -i` is deliberately absent from `valueFlags`: BSD `sed` wants a suffix argument and
 * GNU `sed` does not, so modelling it either way is wrong on the other platform. Skipping
 * *empty* operands instead gets both right — BSD's `sed -i '' 's/a/b/' f` and GNU's
 * `sed -i 's/a/b/' f` each land on `s/a/b/` as the first operand that is really there.
 */
const GREP_LIKE = {
  exprFlags: ['-e', '--regexp'],
  fileFlags: ['-f', '--file'],
  valueFlags: [
    '-e', '--regexp', '-f', '--file', '-m', '--max-count', '-A', '--after-context',
    '-B', '--before-context', '-C', '--context', '-d', '--directories', '-D', '--devices',
    '--include', '--exclude', '--exclude-dir', '--include-dir', '--color', '--colour',
    '--binary-files', '--label', '-g', '--glob', '--iglob', '-t', '--type',
  ],
};
const AWK_LIKE = {
  exprFlags: [],
  fileFlags: ['-f', '--file'],
  valueFlags: ['-f', '--file', '-v', '--assign', '-F', '--field-separator'],
};
const EXPRESSION_COMMANDS = new Map([
  ['sed', { exprFlags: ['-e', '--expression'], fileFlags: ['-f', '--file'], valueFlags: ['-e', '--expression', '-f', '--file', '-l', '--line-length'] }],
  ['awk', AWK_LIKE],
  ['gawk', AWK_LIKE],
  ['nawk', AWK_LIKE],
  ['mawk', AWK_LIKE],
  ['grep', GREP_LIKE],
  ['egrep', GREP_LIKE],
  ['fgrep', GREP_LIKE],
  ['rg', GREP_LIKE],
  ['ugrep', GREP_LIKE],
]);

/** Commands that print their operands rather than opening them — a path in one is text. */
const TEXT_COMMANDS = new Set(['echo', 'printf', ':', 'true', 'false']);

/**
 * Words that stand in front of the command rather than being it. Stripping them is what
 * makes `do sed …` inside a `for` loop, or `sudo cat /etc/shadow`, read as the command it
 * actually runs.
 */
const LEADING_WORDS = new Set([
  'do', 'then', 'else', 'elif', 'if', 'while', 'until', 'for', '!', '{', '}', '(', ')',
  'time', 'sudo', 'env', 'command', 'exec', 'nohup', 'builtin', 'eval',
]);

/* ============================================================== resolving a path */

/**
 * `target`, resolved against `cwd` — absolute as given, `~` expanded to the real home
 * directory, everything else joined and normalised. Purely textual: nothing here touches
 * the filesystem, so a target that does not exist yet resolves exactly like one that does.
 */
function resolve(cwd, target) {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return path.resolve(cwd, target);
}

const realpath = fs.realpathSync.native ? (p) => fs.realpathSync.native(p) : (p) => fs.realpathSync(p);
let realCache = new Map();

/**
 * `p` with every symlink in it resolved — including when `p` itself does not exist, by
 * resolving the longest ancestor that does and re-joining the rest. Falls back to `p`
 * unchanged if even that fails, so this can only ever agree with the textual answer or
 * name the same directory more precisely.
 */
function canonical(p) {
  const hit = realCache.get(p);
  if (hit !== undefined) return hit;
  const tail = [];
  let dir = p;
  for (;;) {
    try {
      const resolved = realpath(dir);
      const out = tail.length ? path.join(resolved, ...tail) : resolved;
      realCache.set(p, out);
      return out;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) {
        realCache.set(p, p);
        return p;
      }
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

function contains(root, target) {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Whether `target` is inside any root — textually, or with both sides resolved through
 * `realpath` so `/tmp/x` and `/private/tmp/x` are one directory. Textual first, so a
 * symlink *inside* a root (this repo's `node_modules` in every worktree) keeps working.
 */
function insideAny(roots, target) {
  if (roots.some((root) => contains(root.textual, target))) return true;
  const real = canonical(target);
  return roots.some((root) => contains(root.canonical, real));
}

/* ==================================================================== reading a line */

/** Strip a `#` comment, respecting single- and double-quoted strings — not a full lexer, just enough that `echo "a # b"` keeps its `#`. */
function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle && line[i - 1] !== '\\') inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i);
  }
  return line;
}

/**
 * `line`, split into `{ value, quoted, op }` tokens: whitespace-separated words with their
 * quotes stripped, and the shell operators that are *not* whitespace-separated split off
 * on their own — `;`, `&&`, `||`, `|`, `&`, and redirections including an attached file
 * descriptor and target (`2>/dev/null` → `2>` then `/dev/null`).
 *
 * Two details carry weight further down. `quoted` remembers that a word came from inside
 * quotes even though the quotes are gone, which is what lets a `sed` expression be told
 * apart from a bare path. And an empty quoted word (`sed -i ''`) survives as a token with
 * an empty value rather than vanishing, which is what keeps operand counting honest.
 */
function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quoted = false;
  let started = false;
  let quote = null;

  const flush = () => {
    if (started) tokens.push({ value: cur, quoted, op: null });
    cur = '';
    quoted = false;
    started = false;
  };

  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];

    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }

    if (c === "'" || c === '"') {
      quote = c;
      quoted = true;
      started = true;
      continue;
    }

    if (/\s/.test(c)) {
      flush();
      continue;
    }

    // A redirection: an optional file descriptor, `>` or `<`, then `>>`/`<<`/`<<<` and an
    // optional `&N` duplication. Splitting this off is what makes `>/etc/x` a redirection
    // whose *target* is a path, rather than one opaque token that starts with `>`.
    if (c === '>' || c === '<') {
      let fd = '';
      if (!quoted && /^\d+$/.test(cur)) {
        fd = cur;
        cur = '';
        started = false;
      }
      flush();
      let op = fd + c;
      while (line[i + 1] === c) {
        op += c;
        i += 1;
      }
      if (line[i + 1] === '&') {
        op += '&';
        i += 1;
        while (/\d/.test(line[i + 1] || '')) {
          op += line[i + 1];
          i += 1;
        }
      }
      tokens.push({ value: op, quoted: false, op });
      continue;
    }

    if (c === '&' && line[i + 1] === '>') {
      flush();
      let op = '&>';
      i += 1;
      if (line[i + 1] === '>') {
        op += '>';
        i += 1;
      }
      tokens.push({ value: op, quoted: false, op });
      continue;
    }

    if (c === ';' || c === '&' || c === '|') {
      flush();
      let op = c;
      if (line[i + 1] === c) {
        op += c;
        i += 1;
      }
      tokens.push({ value: op, quoted: false, op });
      continue;
    }

    cur += c;
    started = true;
  }

  flush();
  return tokens;
}

const isControlOp = (op) => op !== null && !/[<>]/.test(op);
const isRedirectOp = (op) => op !== null && /[<>]/.test(op);
/** `<<` and `<<<` are followed by a delimiter word or inline data, never by a filename. */
const takesFileTarget = (op) => isRedirectOp(op) && !op.includes('<<');

/**
 * `tokens` with the innards of an arithmetic expansion dropped. `echo $((10 / 2))` splits
 * into `$((10`, `/`, `2))`, and that bare `/` is division, not the root directory — but
 * `rm -rf /` is the root directory, so this cannot be handled by exempting `/` itself.
 */
function dropArithmetic(tokens) {
  const out = [];
  let depth = 0;
  for (const t of tokens) {
    if (depth === 0 && t.op === null && t.value.includes('$((')) {
      depth += 1;
      if (t.value.includes('))')) depth -= 1;
      continue;
    }
    if (depth > 0) {
      if (t.value.includes('))')) depth -= 1;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** `tokens` cut into simple commands at `;`, `&&`, `||`, `|` and `&`. */
function segment(tokens) {
  const segments = [];
  let cur = [];
  for (const t of tokens) {
    if (isControlOp(t.op)) {
      if (cur.length) segments.push(cur);
      cur = [];
      continue;
    }
    cur.push(t);
  }
  if (cur.length) segments.push(cur);
  return segments;
}

/* =============================================================== judging a command */

/** True for a token this file will not try to resolve — it may name any path at all. */
function isDynamic(token) {
  return token.includes('$') || token.includes('`') || token.includes("'") || token.includes('"');
}

/**
 * Whether `value` is a spelling of a filesystem path — the question `verifyLine` used to
 * answer with "does it start with `/` or `~`", which missed `../../../lib/server.js` and
 * `"$HOME/.ssh/id_rsa"` entirely (bc-4hg1a c1).
 *
 * A bare relative word (`f.txt`, `s/real/PWNED/`) is *not* path-shaped, and it does not
 * need to be: resolved against a cwd already known to be inside the roots, it can only
 * land inside them. What can leave is a path that is absolute, that walks up with `..`,
 * or that is built from something this cannot read.
 */
function pathShaped(value) {
  if (!value) return false;
  if (value.startsWith('/') || value.startsWith('~')) return true;
  if (value === '.' || value === '..') return true;
  if (value.startsWith('./') || value.startsWith('../')) return true;
  if (value.split('/').includes('..')) return true;
  if (value.includes('$') && value.includes('/')) return true;
  return false;
}

/** `value` checked against the roots, or `null` if it is fine. */
function checkTarget(value, roots, cwd, reason) {
  if (isDynamic(value)) return { target: value, reason: 'a path built at runtime — cannot verify where it goes' };
  const resolved = resolve(cwd, value);
  if (ALWAYS_ALLOWED.has(resolved) || ALWAYS_ALLOWED.has(canonical(resolved))) return null;
  if (!insideAny(roots, resolved)) return { target: resolved, reason };
  return null;
}

/** The command a segment runs, and the tokens after it, with leading keywords and `VAR=x` assignments taken off. */
function head(tokens) {
  let i = 0;
  const assignments = [];
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.op !== null) break;
    if (LEADING_WORDS.has(t.value)) {
      i += 1;
      continue;
    }
    if (!t.quoted && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t.value)) {
      assignments.push(t);
      i += 1;
      continue;
    }
    break;
  }
  return { command: tokens[i] && tokens[i].op === null ? tokens[i].value : null, args: tokens.slice(i + 1), assignments };
}

/**
 * Check one simple command against `roots` and the virtual `cwd` a `cd` earlier in the
 * script left behind. Returns `null` if it is fine, or `{ target, reason }` naming the
 * offending path and why.
 */
function verifySegment(tokens, roots, cwd) {
  const { command, args, assignments } = head(tokens);

  // `FOO=/etc/x cmd` names a path as surely as `cmd /etc/x` does.
  for (const a of assignments) {
    const value = a.value.slice(a.value.indexOf('=') + 1);
    if (pathShaped(value)) {
      const problem = checkTarget(value, roots, cwd, 'an absolute path outside the allowed roots');
      if (problem) return problem;
    }
  }

  if (command === 'cd') {
    const arg = args.find((t) => t.op === null);
    const value = arg ? arg.value : undefined;
    if (value === undefined || value === '' || value === '-') {
      return { target: value === undefined ? '(no argument)' : value, reason: 'cd with no directory this can verify' };
    }
    if (isDynamic(value)) return { target: value, reason: 'cd to a target built at runtime — cannot verify where it goes' };
    const resolved = resolve(cwd, value);
    if (!insideAny(roots, resolved)) return { target: resolved, reason: 'cd leaves the allowed roots' };
    return null;
  }

  const spec = EXPRESSION_COMMANDS.get(command);
  const isText = TEXT_COMMANDS.has(command);

  // A `-e`/`-f` says the program text came from somewhere else, so every operand after it
  // is a file — POSIX's own rule, and the reason the leading-operand exemption lapses.
  let expressionOperand = Boolean(spec);
  if (spec) {
    for (const t of args) {
      if (t.op !== null) continue;
      const name = t.value.startsWith('--') ? t.value.split('=')[0] : t.value;
      if (spec.exprFlags.includes(name) || spec.fileFlags.includes(name)) expressionOperand = false;
    }
  }

  for (let i = 0; i < args.length; i += 1) {
    const t = args[i];

    if (t.op !== null) {
      // The word after a redirection is a file this script opens, whatever else it looks
      // like — `>/etc/x` and `> /etc/x` are the same instruction (bc-4hg1a c1).
      if (takesFileTarget(t.op)) {
        const target = args[i + 1];
        if (target && target.op === null && target.value) {
          const problem = checkTarget(target.value, roots, cwd, 'a redirection outside the allowed roots');
          if (problem) return problem;
        }
        i += 1;
      }
      continue;
    }

    if (command === 'git' && t.value === '-C') {
      const arg = args[i + 1];
      if (!arg || arg.op !== null) return { target: '(no argument)', reason: 'git -C with no directory this can verify' };
      if (isDynamic(arg.value)) return { target: arg.value, reason: 'git -C into a target built at runtime — cannot verify where it goes' };
      const resolved = resolve(cwd, arg.value);
      if (!insideAny(roots, resolved)) return { target: resolved, reason: 'git -C leaves the allowed roots' };
      i += 1;
      continue;
    }

    if (t.value.startsWith('-') && t.value.length > 1) {
      const eq = t.value.indexOf('=');
      if (eq !== -1) {
        // `--directory=/etc`, `--git-dir=/repo/other/.git` — the path is on the flag.
        const value = t.value.slice(eq + 1);
        const name = t.value.slice(0, eq);
        if (spec && spec.exprFlags.includes(name)) continue;
        if (pathShaped(value)) {
          const problem = checkTarget(value, roots, cwd, 'an option naming a path outside the allowed roots');
          if (problem) return problem;
        }
        continue;
      }
      if (spec && spec.valueFlags.includes(t.value)) {
        const arg = args[i + 1];
        i += 1;
        if (!arg || arg.op !== null) continue;
        if (spec.exprFlags.includes(t.value)) continue; // program text, not a filename
        if (pathShaped(arg.value)) {
          const problem = checkTarget(arg.value, roots, cwd, 'an absolute path outside the allowed roots');
          if (problem) return problem;
        }
      }
      continue;
    }

    if (isText) continue;

    // The first operand that is really there — `sed -i ''` leaves an empty one that is not
    // the program — and only if it is quoted, so an unquoted `/etc/passwd` is still a path.
    if (expressionOperand) {
      if (t.value === '') continue;
      expressionOperand = false;
      if (t.quoted) continue;
    }

    if (pathShaped(t.value)) {
      const problem = checkTarget(t.value, roots, cwd, 'an absolute path outside the allowed roots');
      if (problem) return problem;
    }
  }

  return null;
}

/**
 * Verify `text` never touches outside `roots` — absolute directories, first of which is
 * the virtual starting `cwd` a bare `cd` is resolved against.
 *
 * Returns `{ ok: true }`, or `{ ok: false, line, text, target, reason }` at the first
 * line that fails — line numbers are 1-indexed, matching what an editor or `sed -n` would
 * show for the same file.
 */
export function verifyScript(text, roots) {
  realCache = new Map();
  const absRoots = roots.map((r) => {
    const textual = path.resolve(r);
    return { textual, canonical: canonical(textual) };
  });
  let cwd = absRoots[0].textual;
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    for (const seg of segment(dropArithmetic(tokenize(line)))) {
      const problem = verifySegment(seg, absRoots, cwd);
      if (problem) {
        return { ok: false, line: i + 1, text: raw, target: problem.target, reason: problem.reason };
      }

      // `cd` moves the virtual cwd for everything after it — verifySegment already refused
      // one that would leave the roots, so a `cd` reaching here is safe to adopt.
      const { command, args } = head(seg);
      if (command === 'cd') {
        const arg = args.find((t) => t.op === null);
        if (arg && arg.value && arg.value !== '-' && !isDynamic(arg.value)) cwd = resolve(cwd, arg.value);
      }
    }
  }

  return { ok: true };
}
