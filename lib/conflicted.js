/**
 * Does this commit carry an unresolved merge, or a file that does not parse?
 *
 * git will commit conflict markers without a murmur. `git add -A && git commit` in the
 * middle of a merge stages a file still full of `<<<<<<<` / `=======` / `>>>>>>>` and
 * produces a merge commit that looks exactly like a resolved one: right parents, right
 * message, no warning anywhere. Nothing in git objects, because from git's point of
 * view those are seven characters like any other seven.
 *
 * It happened here on 2026-08-11. Two resolver sessions raced in one worktree (bc-d2y6);
 * one ran `git merge --abort` between the other's `node --check` and its commit, so the
 * commit captured the *re-conflicted* `public/console.js`. The tell was not a conflict
 * message. It was `npm test` failing 14 checks of 16 in `test/dismissed.mjs` with
 * `Unexpected token '<<'`, 38 suites into a 105-suite run — which reads as a real
 * regression about dismissal, not as *your file does not parse*. It came within one
 * `git push` of putting an unparseable `public/console.js` on a branch, and that file is
 * served to a phone.
 *
 * So: two questions, both sub-second, asked where they are cheap rather than 38 suites
 * into the gate.
 *
 * 1. **Does any changed text file carry a conflict marker?** A grep, but of the
 *    *committed blob* rather than the working tree — the whole point of bc-d2y6 is that
 *    the tree can be clean while `HEAD` is broken. A resolver that fixes the file after
 *    committing leaves `git status` empty and the damage in the history.
 * 2. **Does every changed `.js` still parse?** `node --check`, which is the same parse
 *    the daemon and the browser will do, minutes earlier and against one file at a time
 *    so the error names the file rather than a test.
 *
 * **`=======` is deliberately not a marker here.** It is the one line of the three that
 * occurs in real text: it is a setext `<h1>` underline in Markdown, and this repo's
 * README is 600KB of Markdown. `<<<<<<<`, `>>>>>>>` and diff3's `|||||||` never occur by
 * accident, and any real conflict has all of them — so dropping the ambiguous one costs
 * no detection at all and buys a check that cannot cry wolf. Exactly seven, followed by
 * a space or the end of the line, which is what git writes.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

/**
 * The three lines git writes into a conflicted file, and never writes anywhere else.
 *
 * `=======` is missing on purpose — see the note at the top of the file.
 */
export const MARKER_RE = /^(<{7}|>{7}|\|{7})( |$)/;

/** Extensions `node --check` can answer for. Everything else is only grepped. */
const PARSEABLE = new Set(['.js', '.mjs', '.cjs']);

const git = (dir, args) =>
  execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).trim();

/** A blob as bytes. Not `encoding: 'utf8'` — binariness is decided below, on the bytes. */
const blob = (dir, spec) =>
  execFileSync('git', ['show', spec], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });

/**
 * git's own heuristic, near enough: a NUL byte in the first 8000 means binary.
 *
 * Worth having rather than trusting the extension, because the thing being scanned is a
 * *changed* file list — a PNG, a keystore or a font would otherwise be decoded as UTF-8
 * and grepped, which is slow and can only produce nonsense.
 */
export function isBinary(buf) {
  const end = Math.min(buf.length, 8000);
  for (let i = 0; i < end; i++) if (buf[i] === 0) return true;
  return false;
}

/**
 * Every conflict marker in a file's text, as `{ line, text }`, in order.
 *
 * Exported because it is the whole of the detection, and a test that asserts on it is
 * asserting on the thing rather than on a report built out of it.
 */
export function markersIn(text) {
  const found = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (MARKER_RE.test(line)) found.push({ line: i + 1, text: line });
  }
  return found;
}

/**
 * Does this source parse? — the answer `node --check` gives, and the file it names.
 *
 * `node --check` wants a path on disk, so a committed blob is written to a temp file
 * first, keeping its basename and extension: the extension because it is what decides
 * how the file is parsed on older runtimes, and the basename because it is the only
 * part of node's error message that says *which* file, and a message naming
 * `tmp-4f2a.js` would be worse than no message at all.
 *
 * Returns null when it parses, or node's first two lines when it does not — which for
 * the case this exists to catch is `Unexpected token '<<'` and the line it is on.
 */
export function parseError(text, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-parse-'));
  const file = path.join(dir, path.basename(name));
  try {
    fs.writeFileSync(file, text);
    const res = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (res.status === 0) return null;
    const out = `${res.stderr || ''}${res.stdout || ''}`;
    const said = out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .find((l) => /SyntaxError|Error:/.test(l));
    return said || `node --check exited ${res.status}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The changed files of a comparison, with the binary ones already dropped.
 *
 * `--numstat` rather than `--name-only` because it answers both questions in one call:
 * git reports a binary file as `-\t-\t<path>`, which is its own answer to "is this
 * text", arrived at with the same rules `git diff` uses everywhere else.
 *
 * `--diff-filter=d` drops deletions. A deleted file has no blob to read, and a scan
 * that dies on `git show HEAD:gone.js` would fail every branch that removed a file.
 */
function changed(dir, range) {
  const out = git(dir, ['diff', '--numstat', '--diff-filter=d', ...range]);
  if (!out) return [];
  const files = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^(\S+)\t(\S+)\t(.+)$/);
    if (!m) continue;
    // `-  -  path` is git saying binary. Take it at its word and do not read the blob.
    if (m[1] === '-' && m[2] === '-') continue;
    files.push(m[3]);
  }
  return files;
}

/**
 * Scan a set of committed blobs, given how to read one.
 *
 * The two callers differ only in where a blob lives — `<ref>:<path>` for a commit,
 * `:<path>` for the index — so that is the only thing they pass in.
 */
function scan(dir, files, spec) {
  const findings = [];
  for (const file of files) {
    let buf;
    try {
      buf = blob(dir, spec(file));
    } catch {
      // A path git listed but cannot show is not this check's business to explain.
      continue;
    }
    if (isBinary(buf)) continue;
    const text = buf.toString('utf8');

    const markers = markersIn(text);
    if (markers.length) findings.push({ file, kind: 'conflict', markers });

    // Only when the markers are absent: an unparseable file whose reason is the markers
    // above would otherwise be reported twice, and the second report would be the one
    // that does not say what to do about it.
    else if (PARSEABLE.has(path.extname(file))) {
      const err = parseError(text, file);
      if (err) findings.push({ file, kind: 'syntax', error: err });
    }
  }
  return findings;
}

/**
 * What is wrong with the commits this branch is about to push — `[]` when nothing is.
 *
 * `base...ref` (three dots) is against the merge base, so this asks about the branch's
 * own work rather than about everything that has happened on `main` since it started.
 * A conflict marker committed while merging `main` in still shows: the file it is in
 * differs from the merge base by definition, or the merge would not have conflicted.
 */
export function inspectBranch(dir, { ref = 'HEAD', base = 'origin/main' } = {}) {
  const files = changed(dir, [`${base}...${ref}`]);
  return scan(dir, files, (f) => `${ref}:${f}`);
}

/**
 * The same question of the index — what `git commit` is about to write.
 *
 * This is the pre-commit half, and it reads the *staged* blob rather than the file on
 * disk. Those differ in exactly the case worth catching: `git add`, then an edit, then
 * a commit that carries the version nobody looked at.
 */
export function inspectStaged(dir) {
  const files = changed(dir, ['--cached', against(dir, 'HEAD')]);
  return scan(dir, files, (f) => `:${f}`);
}

/** The same question of a single commit, against its own first parent. */
export function inspectCommit(dir, ref = 'HEAD') {
  const files = changed(dir, [against(dir, `${ref}^`), ref]);
  return scan(dir, files, (f) => `${ref}:${f}`);
}

/**
 * git's empty tree, which every repo has without anyone writing it.
 *
 * The comparison this stands in for is "against nothing": the first commit of a repo has
 * no parent and an unborn `HEAD` names no tree, so `git diff HEAD` fails outright rather
 * than reporting every file as added. That is a real state here — the pre-commit hook is
 * installed by a command anyone can run, and it must not make the *first* commit of a
 * fresh checkout the one thing it cannot do.
 */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const against = (dir, ref) => {
  try {
    git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{tree}`]);
    return ref;
  } catch {
    return EMPTY_TREE;
  }
};

/**
 * Findings as something to read, with the fix on the end.
 *
 * The fix line matters more than the finding does. Whoever sees this is mid-merge with
 * two branches in their head, and the useful sentence is not "there is a marker in
 * console.js" — it is that the file has to be resolved and the *commit* remade, because
 * fixing the working tree leaves the broken blob exactly where it was.
 */
export function report(findings, { what = 'this commit' } = {}) {
  const lines = [];
  for (const f of findings) {
    if (f.kind === 'conflict') {
      const where = f.markers.map((m) => `${m.line}: ${m.text}`).join('\n      ');
      lines.push(`  ${f.file} — ${f.markers.length} unresolved conflict marker${f.markers.length === 1 ? '' : 's'}\n      ${where}`);
    } else {
      lines.push(`  ${f.file} — does not parse\n      ${f.error}`);
    }
  }
  const conflicted = findings.some((f) => f.kind === 'conflict');
  lines.push(
    '',
    `${conflicted ? 'Resolve' : 'Fix'} the file and remake ${what} — this read the blob git has, not the\n` +
      'file on disk, so an edit to the working tree alone leaves it exactly as broken\nas it is now.'
  );
  return lines.join('\n');
}
