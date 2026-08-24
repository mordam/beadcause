/**
 * Whether a shell script ever reaches outside a fixed set of directories, checked by
 * reading the script rather than running it — the same question `bin/b7e-sh` exists to
 * answer before it hands the script to `bash`.
 *
 * This is a heuristic over the *text* of the script, not a sandbox: it does not resolve
 * variables, command substitution, or anything decided at runtime, and it does not stop
 * a script from doing something destructive *inside* the allowed roots. What it catches
 * is the three shapes bc-ka5y.29's own evidence names — an absolute path outside the
 * allowed roots, a `git -C` into a directory outside them, and a `cd` that leaves them —
 * because those are the shapes a worktree-isolated session's own Bash approval already
 * refuses outright on anything more complex than a single plain command, which is what
 * sent six sessions to hand-roll a workaround instead. A script this cannot follow
 * (built from a variable, from `eval`, from a subshell it cannot see into) is not waved
 * through — it is refused, on the same "cannot verify it stays inside" reasoning the
 * Bash approval itself uses, so this never grants a script safety nobody actually
 * checked.
 */
import os from 'node:os';
import path from 'node:path';

/** Special files that are never a real escape, whatever root list is in force. */
const ALWAYS_ALLOWED = new Set(['/dev/null', '/dev/stdin', '/dev/stdout', '/dev/stderr', '/dev/tty']);

/**
 * `target`, resolved against `cwd` — absolute as given, `~` expanded to the real home
 * directory, everything else joined and normalised. Purely textual: nothing here touches
 * the filesystem, so a target that does not exist yet (the very case `mkdir -p` and a
 * script's own output files are for) resolves exactly like one that does.
 */
function resolve(cwd, target) {
  if (target === '~') return os.homedir();
  if (target.startsWith('~/')) return path.join(os.homedir(), target.slice(2));
  return path.resolve(cwd, target);
}

function insideAny(roots, target) {
  return roots.some((root) => {
    const rel = path.relative(root, target);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  });
}

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
 * `line`, split on whitespace outside single/double quotes, with the quotes themselves
 * stripped from each token. Good enough for the argument-per-token scripts this repo's
 * sessions actually write (see bc-ka5y.29's own five examples) — not a POSIX word
 * splitter, and it does not need to be one: anything it cannot make sense of shows up as
 * a token containing `$`, `` ` `` or an unmatched quote, which `verifyLine` below treats
 * as unverifiable rather than guessing.
 */
function tokenize(line) {
  const tokens = [];
  let cur = '';
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      continue;
    }
    if (/\s/.test(c)) {
      if (cur) tokens.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

/** True for a token this file will not try to resolve — it may name any path at all. */
function isDynamic(token) {
  return token.includes('$') || token.includes('`') || token.includes("'") || token.includes('"');
}

/**
 * Check one already-comment-stripped line against `roots` and the virtual `cwd` a
 * `cd` earlier in the script left behind. Returns `null` if the line is fine, or
 * `{ target, reason }` naming the offending path and why.
 */
function verifyLine(line, roots, cwd) {
  const tokens = tokenize(line);

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];

    if (tok === 'cd') {
      const arg = tokens[i + 1];
      if (arg === undefined || arg === '-') return { target: arg ?? '(no argument)', reason: 'cd with no directory this can verify' };
      if (isDynamic(arg)) return { target: arg, reason: 'cd to a target built at runtime — cannot verify where it goes' };
      const resolved = resolve(cwd, arg);
      if (!insideAny(roots, resolved)) return { target: resolved, reason: 'cd leaves the allowed roots' };
      continue;
    }

    if (tok === 'git') {
      const flag = tokens[i + 1];
      if (flag === '-C') {
        const arg = tokens[i + 2];
        if (arg === undefined) return { target: '(no argument)', reason: 'git -C with no directory this can verify' };
        if (isDynamic(arg)) return { target: arg, reason: 'git -C into a target built at runtime — cannot verify where it goes' };
        const resolved = resolve(cwd, arg);
        if (!insideAny(roots, resolved)) return { target: resolved, reason: 'git -C leaves the allowed roots' };
      }
      continue;
    }

    if (tok.startsWith('/') || tok.startsWith('~')) {
      if (isDynamic(tok)) return { target: tok, reason: 'a path built at runtime — cannot verify where it goes' };
      const resolved = resolve(cwd, tok);
      if (ALWAYS_ALLOWED.has(resolved)) continue;
      if (!insideAny(roots, resolved)) return { target: resolved, reason: 'an absolute path outside the allowed roots' };
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
  const absRoots = roots.map((r) => path.resolve(r));
  let cwd = absRoots[0];
  const lines = text.split('\n');

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    const line = stripComment(raw).trim();
    if (!line) continue;

    const problem = verifyLine(line, absRoots, cwd);
    if (problem) {
      return { ok: false, line: i + 1, text: raw, target: problem.target, reason: problem.reason };
    }

    // `cd` moves the virtual cwd for every later line — verifyLine already refused
    // one that would leave the roots, so a `cd` reaching here is safe to adopt.
    const tokens = tokenize(line);
    const cdIdx = tokens.indexOf('cd');
    if (cdIdx !== -1 && tokens[cdIdx + 1] && tokens[cdIdx + 1] !== '-' && !isDynamic(tokens[cdIdx + 1])) {
      cwd = resolve(cwd, tokens[cdIdx + 1]);
    }
  }

  return { ok: true };
}
