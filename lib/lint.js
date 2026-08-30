/**
 * `b7e-lint` (bc-khoe.30.18) — say whether a file just written survived being written.
 *
 * Three sessions wrote a large, prose-heavy `lib/` module in one shot and then had to
 * work out by hand whether the prose had broken the code, each a different way:
 * `bc-4r10.4` normalised 12 U+2019 apostrophes it had already grepped with a blind
 * `sed -i '' "s/’/'/g"` over both the module *and* its suite, which closed three
 * single-quoted string literals early — it found out by running the suite and reading a
 * `SyntaxError` stack twice. `bc-4r10.13` found backticks where apostrophes belonged in
 * its own module and swept them with `sed` into U+2019 — the exact character `bc-4r10.4`
 * had just had to strip, because the house convention this repo actually uses is an
 * escaped ASCII apostrophe (`\'`) inside a single-quoted string. `bc-4r10.3` hunted NUL
 * bytes by hand, ahead of time, because `test/filter.mjs`'s own control-byte check
 * (below) never runs over anything it wrote — that suite only reads `lib/` and
 * `public/`, so a NUL landing in `test/` or `bin/` is invisible to it.
 *
 * This is the one command that answers all of it in a single pass: `node --check`, every
 * control byte, every smart-punctuation character that looks like a quote, every
 * apostrophe that silently closes a single-quoted string it was never meant to close, and
 * — for `bin/` — a missing shebang or exec bit. See `bin/b7e-lint` for the CLI half
 * (argv parsing, the default "changed files" list, printing); everything here is a pure
 * function of a file's bytes, so it needs no git and no `--dir` of its own.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/* ----------------------------------------------------------------- control bytes */

/**
 * The exact rule `test/filter.mjs` already checks over `lib/` and `public/` — a byte
 * below 32 that is not tab, LF or CR turns a source file binary without turning it
 * unreadable to `node`, so `grep` (and a person) finds nothing wrong while the file is
 * quietly broken. Exported so `test/filter.mjs` can share this one predicate instead of
 * carrying its own copy, per the bead's own instruction not to let the two drift.
 */
export function isControlByte(b) {
  return b < 32 && b !== 9 && b !== 10 && b !== 13;
}

/** Every control byte in `buf`, with the 1-based line it falls on and its byte offset. */
export function controlByteFindings(buf) {
  const findings = [];
  let line = 1;
  for (let i = 0; i < buf.length; i++) {
    const b = buf[i];
    if (isControlByte(b)) findings.push({ line, offset: i, byte: b });
    if (b === 10) line += 1;
  }
  return findings;
}

/* ----------------------------------------------------------------- line lookup */

function newlineOffsets(src) {
  const offsets = [];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offsets.push(i);
  return offsets;
}

/** 1-based line number of `pos` in a string, given that string's own `newlineOffsets`. */
function lineAt(offsets, pos) {
  let lo = 0;
  let hi = offsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid] < pos) lo = mid + 1;
    else hi = mid;
  }
  return lo + 1;
}

/* ----------------------------------------------------------------- smart punctuation */

/**
 * Quote-look-alike codepoints only — not em/en dashes or an ellipsis, both of which this
 * repo's own prose (this file included) uses on purpose throughout `lib/`, `bin/` and
 * `README.md`. A dash never breaks a string literal; a curly quote can, silently, the
 * moment it is typed where a straight one belongs or a straight one is "corrected" into
 * one by a blind pass — which is exactly `bc-4r10.4` and `bc-4r10.13` above.
 *
 * Named by codepoint and Unicode name only, never by typing the character itself into
 * this file's own source — this module would otherwise flag its own definition table
 * every time it is pointed at itself, which is exactly the kind of self-inflicted noise
 * this tool exists to catch in somebody else's file.
 */
const SMART_PUNCT = new Map([
  [0x2018, 'left single quotation mark'],
  [0x2019, 'right single quotation mark'],
  [0x201a, 'single low-9 quotation mark'],
  [0x201b, 'single high-reversed-9 quotation mark'],
  [0x201c, 'left double quotation mark'],
  [0x201d, 'right double quotation mark'],
  [0x201e, 'double low-9 quotation mark'],
  [0x201f, 'double high-reversed-9 quotation mark'],
]);

/** Every smart-punctuation character in `src`, with its 1-based line. */
export function smartPunctFindings(src) {
  const findings = [];
  const offsets = newlineOffsets(src);
  for (let i = 0; i < src.length; i++) {
    const cp = src.codePointAt(i);
    const name = SMART_PUNCT.get(cp);
    if (name) findings.push({ line: lineAt(offsets, i), char: String.fromCodePoint(cp), codePoint: cp, name });
  }
  return findings;
}

/* ----------------------------------------------------------------- bad apostrophes */

/**
 * Every single-quoted string literal whose closing `'` is immediately followed — no
 * space, no operator, no punctuation — by a letter, digit, `_` or `$`. That shape is
 * never valid JavaScript (a `StringLiteral` token cannot be adjacent to an
 * `IdentifierName` with nothing between them), so it is a reliable, low-noise signal
 * that the `'` was meant as a contraction's apostrophe rather than the end of the
 * string — precisely the `bc-4r10.4` shape: `'it wasn't reused'` tokenizes as the string
 * `'it wasn'` followed by the bare identifier `t`.
 *
 * A small hand-rolled state machine, not an import of `test/helpers/blank.mjs`'s
 * `blankJs` — that file is a test helper with its own already-documented reason to have
 * no import path into `lib/`, and its state machine is itself a copy of one that started
 * inside `public/editmode.js`. This one is purpose-built to report positions rather than
 * blank text, but the modes it walks (comments, regex, double-quoted and template
 * strings, `${…}` nesting) are the same, for the same reason: skipping any of them
 * wrongly is a false positive inside a comment or somebody else's string.
 */
export function badApostropheFindings(src) {
  const findings = [];
  const offsets = newlineOffsets(src);
  const stack = [];
  let mode = 'code';
  let prev = '';
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === 'code') {
      if (c === '/' && d === '/') {
        mode = 'line';
        i += 2;
        continue;
      }
      if (c === '/' && d === '*') {
        mode = 'block';
        i += 2;
        continue;
      }
      if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) {
        mode = 'regex';
        i += 1;
        continue;
      }
      if (c === "'") {
        mode = 'sq';
        i += 1;
        continue;
      }
      if (c === '"') {
        mode = 'dq';
        i += 1;
        continue;
      }
      if (c === '`') {
        stack.push('tpl');
        mode = 'tpl';
        i += 1;
        continue;
      }
      if (c === '}' && stack[stack.length - 1] === 'sub') {
        stack.pop();
        mode = 'tpl';
        i += 1;
        continue;
      }
      if (!/\s/.test(c)) prev = c;
      i += 1;
      continue;
    }
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        prev = '';
      }
      i += 1;
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && d === '/') {
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'regex') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '[') {
        // A character class may legally contain an unescaped `/`; skip it whole.
        let j = i + 1;
        while (j < src.length && src[j] !== ']') j += src[j] === '\\' ? 2 : 1;
        i = j + 1;
        continue;
      }
      if (c === '/' || c === '\n') {
        mode = 'code';
        prev = '/';
      }
      i += 1;
      continue;
    }
    if (mode === 'tpl') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        stack.pop();
        mode = 'code';
        prev = '`';
        i += 1;
        continue;
      }
      if (c === '$' && d === '{') {
        stack.push('sub');
        mode = 'code';
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    if (mode === 'dq') {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '"') {
        mode = 'code';
        prev = '"';
        i += 1;
        continue;
      }
      if (c === '\n') {
        // An unterminated string; bail back to code rather than eat the rest of the file.
        mode = 'code';
      }
      i += 1;
      continue;
    }
    // mode === 'sq'
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '\n') {
      mode = 'code';
      i += 1;
      continue;
    }
    if (c === "'") {
      const next = src[i + 1];
      if (next && /[A-Za-z0-9_$]/.test(next)) {
        findings.push({ line: lineAt(offsets, i), index: i });
      }
      mode = 'code';
      prev = "'";
    }
    i += 1;
  }
  return findings;
}

/* ----------------------------------------------------------------- node --check */

/** `null` when `node --check` passes; the trimmed stderr (its `SyntaxError`) when it fails. */
export function nodeCheck(absPath) {
  try {
    execFileSync(process.execPath, ['--check', absPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return null;
  } catch (err) {
    const out = String(err.stderr || err.message || '').trim();
    return out || 'node --check failed with no output';
  }
}

/* ----------------------------------------------------------------- bin/ shebang + exec bit */

/** Problems with a `bin/` file specifically — a missing `#!` line, a missing exec bit. */
export function shebangFindings(absPath, text) {
  const problems = [];
  const firstLine = text.split('\n', 1)[0] || '';
  if (!firstLine.startsWith('#!')) problems.push('missing shebang (#!/usr/bin/env node)');
  try {
    const { mode } = fs.statSync(absPath);
    if (!(mode & 0o111)) problems.push('not executable (chmod +x)');
  } catch {
    // fs.readFileSync already succeeded for the caller to have `text` at all; ignore.
  }
  return problems;
}

/* ----------------------------------------------------------------- per-file */

const JS_EXT = /\.(js|mjs|cjs)$/;
const BINARY_EXT = /\.(png|jpe?g|gif|ico|webp|svg|woff2?|ttf|eot|otf|pdf|zip|gz|apk|keystore|jar|mp4|mov|wasm)$/i;

function isBinDir(rel) {
  return rel === 'bin' || rel.startsWith('bin/') || rel.startsWith(`bin${path.sep}`);
}

function isJsFile(rel) {
  return JS_EXT.test(rel) || (isBinDir(rel) && !path.extname(rel));
}

/**
 * Lint one file, given as a path relative to `root`. Never throws on a missing or
 * unreadable file — `exists: false` — because the default "files changed against the
 * merge base" list routinely names a file that was since deleted.
 */
export function lintFile(root, rel) {
  const abs = path.join(root, rel);
  const result = {
    path: rel,
    exists: true,
    skipped: null,
    controlBytes: [],
    smartPunct: [],
    badApostrophes: [],
    checkError: null,
    shebangProblems: [],
  };

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    result.exists = false;
    return result;
  }
  if (!stat.isFile()) {
    result.exists = false;
    return result;
  }
  if (BINARY_EXT.test(rel)) {
    result.skipped = 'binary';
    return result;
  }

  let buf;
  try {
    buf = fs.readFileSync(abs);
  } catch (err) {
    result.skipped = `unreadable: ${err.message}`;
    return result;
  }

  result.controlBytes = controlByteFindings(buf);

  const text = buf.toString('utf8');
  result.smartPunct = smartPunctFindings(text);

  if (isJsFile(rel)) {
    result.badApostrophes = badApostropheFindings(text);
    result.checkError = nodeCheck(abs);
  }

  if (isBinDir(rel)) {
    result.shebangProblems = shebangFindings(abs, text);
  }

  return result;
}

/** `true` when a `lintFile` result has nothing to report. */
export function isClean(result) {
  return (
    result.controlBytes.length === 0 &&
    result.smartPunct.length === 0 &&
    result.badApostrophes.length === 0 &&
    !result.checkError &&
    result.shebangProblems.length === 0
  );
}
