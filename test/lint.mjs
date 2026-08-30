#!/usr/bin/env node
//
// b7e-lint — say whether the file you just wrote survived being written (bc-khoe.30.18).
//
//   npm test
//   node test/lint.mjs
//
// lib/lint.js is a pure function of a file's bytes and does the actual reading; this
// drives it directly against fabricated fixtures, plus a handful of calls through the
// real bin/b7e-lint binary for what only the CLI does: argv parsing, --dir, --json, the
// default "changed files" list and the exit code. Every JS fixture below lives under a
// tmp tree carrying its own {"type":"module"} package.json — without one, `node --check`
// falls back to Node's own ambiguous-module auto-detection, which was measured (while
// building this suite) to silently pass a file that node --check correctly rejects once
// this repo's own real "type": "module" is in scope. Get that wrong and every fixture
// below "passes" for the wrong reason.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-lint');

const lint = await import(path.join(ROOT, 'lib', 'lint.js'));
const { isControlByte, controlByteFindings, smartPunctFindings, badApostropheFindings, nodeCheck, shebangFindings, lintFile, isClean } =
  lint;

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
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-lint-test-'));

/** bin/b7e-lint colours the path in each line; strip that before matching plain text. */
const stripAnsi = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/** A fresh `<tmp>/<name>/` tree, with a `{"type":"module"}` package.json — see header. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

/* ===================================================================== *
 * 1. control bytes
 * ===================================================================== */

console.log('control bytes\n');

check('isControlByte accepts tab, LF, CR; rejects the rest below 32', () => {
  assert.equal(isControlByte(9), false, 'tab');
  assert.equal(isControlByte(10), false, 'LF');
  assert.equal(isControlByte(13), false, 'CR');
  assert.equal(isControlByte(32), false, 'space is not below 32');
  assert.equal(isControlByte(0), true, 'NUL');
  assert.equal(isControlByte(7), true, 'BEL');
  assert.equal(isControlByte(27), true, 'ESC');
});

check('controlByteFindings reports the offset and the 1-based line', () => {
  const buf = Buffer.from('line one\nline t\x00wo\nline three\n', 'utf8');
  const hits = controlByteFindings(buf);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].byte, 0);
  assert.equal(buf[hits[0].offset], 0, 'the offset really points at the NUL byte');
});

check('a clean buffer reports nothing', () => {
  assert.deepEqual(controlByteFindings(Buffer.from('all clean\nhere too\n')), []);
});

/* ===================================================================== *
 * 2. smart punctuation
 * ===================================================================== */

console.log('\nsmart punctuation\n');

check('a smart apostrophe is found, by codepoint, with its line', () => {
  const src = "line one\nconst s = 'it wasn’t';\n";
  const hits = smartPunctFindings(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].codePoint, 0x2019);
  assert.equal(hits[0].char, '’');
});

check('curly double quotes are found too', () => {
  const hits = smartPunctFindings('const s = “hi”;\n');
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((h) => h.codePoint),
    [0x201c, 0x201d],
  );
});

check('an em dash, an en dash and an ellipsis are NOT flagged', () => {
  // This repo's own prose leans on em dashes throughout lib/ and bin/ on purpose —
  // flagging them would make this command noisy on almost every file it touches.
  assert.deepEqual(smartPunctFindings('a — b – c…\n'), []);
});

check('a straight apostrophe and straight quotes are NOT flagged', () => {
  assert.deepEqual(smartPunctFindings(`const s = 'it is "fine"';\n`), []);
});

/* ===================================================================== *
 * 3. the apostrophe that closes a single-quoted literal early
 * ===================================================================== */

console.log('\nbad apostrophes\n');

check('an unescaped apostrophe followed by a letter is flagged, with its line', () => {
  const src = "line one\nconst bad = 'it wasn't reused';\n";
  const hits = badApostropheFindings(src);
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
});

check('an escaped apostrophe inside a single-quoted string is not flagged', () => {
  assert.deepEqual(badApostropheFindings("const ok = 'it wasn\\'t reused';\n"), []);
});

check('a string that closes before punctuation, an operator or whitespace is not flagged', () => {
  assert.deepEqual(badApostropheFindings("const a = 'x' + 'y';\nconst b = 'x'.length;\nconst c = ['x', 'y'];\n"), []);
});

check('an apostrophe inside a // comment is not flagged', () => {
  assert.deepEqual(badApostropheFindings("// it wasn't reused, this is prose\nconst ok = 1;\n"), []);
});

check('an apostrophe inside a /* */ comment is not flagged', () => {
  assert.deepEqual(badApostropheFindings("/* it wasn't reused */\nconst ok = 1;\n"), []);
});

check('an apostrophe inside a double-quoted string is not flagged', () => {
  assert.deepEqual(badApostropheFindings('const ok = "it wasn\'t reused";\n'), []);
});

check('an apostrophe inside a template literal is not flagged', () => {
  assert.deepEqual(badApostropheFindings('const ok = `it wasn\'t reused`;\n'), []);
});

check('a single-quoted string nested inside a template expression is still scanned', () => {
  const src = "const bad = `outer ${'it wasn't reused'} end`;\n";
  const hits = badApostropheFindings(src);
  assert.equal(hits.length, 1, 'the nested single-quoted string is reached through ${...}');
});

check('a `/` inside a regex character class does not desync the scanner', () => {
  // Without the char-class skip, the `/` inside `[/]` would be read as ending the regex,
  // and everything after — including the real single-quoted string — would be misread.
  const src = "const re = /[/]/;\nconst ok = 'fine';\n";
  assert.deepEqual(badApostropheFindings(src), []);
});

/* ===================================================================== *
 * 4. node --check
 * ===================================================================== */

console.log('\nnode --check\n');

check('a syntactically valid file reports null', () => {
  const dir = tree('check-ok', { 'ok.js': 'export const x = 1;\n' });
  assert.equal(nodeCheck(path.join(dir, 'ok.js')), null);
});

check('a broken file reports the SyntaxError text', () => {
  const dir = tree('check-bad', { 'bad.js': "const bad = 'it wasn't reused';\n" });
  const out = nodeCheck(path.join(dir, 'bad.js'));
  assert.match(out, /SyntaxError/);
});

/* ===================================================================== *
 * 5. bin/ shebang and exec bit
 * ===================================================================== */

console.log('\nbin/ shebang and exec bit\n');

check('a bin/ file missing both is flagged for both, in order', () => {
  const dir = tree('shebang', { 'bin/tool.js': 'console.log(1);\n' });
  const abs = path.join(dir, 'bin', 'tool.js');
  const problems = shebangFindings(abs, fs.readFileSync(abs, 'utf8'));
  assert.deepEqual(problems, ['missing shebang (#!/usr/bin/env node)', 'not executable (chmod +x)']);
});

check('a proper bin/ file is clean', () => {
  const dir = tree('shebang-ok', { 'bin/tool.js': '#!/usr/bin/env node\nconsole.log(1);\n' });
  const abs = path.join(dir, 'bin', 'tool.js');
  fs.chmodSync(abs, 0o755);
  assert.deepEqual(shebangFindings(abs, fs.readFileSync(abs, 'utf8')), []);
});

/* ===================================================================== *
 * 6. lintFile / isClean — the acceptance fixture, all three in one file
 * ===================================================================== */

console.log('\nlintFile\n');

check('a file carrying a NUL, a smart apostrophe and an early-closing apostrophe reports all three', () => {
  const dir = tree('acceptance', {
    'fixture.js': `export const ok = 1;\nconst bad = 'it wasn't reused';\nconst nul = 'x\x00y';\n// smart ’ quote here\n`,
  });
  const result = lintFile(dir, 'fixture.js');
  assert.equal(isClean(result), false);
  assert.equal(result.controlBytes.length, 1, 'the NUL byte');
  assert.equal(result.controlBytes[0].line, 3);
  assert.equal(result.smartPunct.length, 1, 'the smart apostrophe');
  assert.equal(result.smartPunct[0].line, 4);
  assert.equal(result.badApostrophes.length, 1, 'the apostrophe that closes the string early');
  assert.equal(result.badApostrophes[0].line, 2);
  assert.ok(result.checkError, 'node --check also fails on the same file');
});

check('the same fixture, fixed, is clean — and node --check agrees', () => {
  const dir = tree('acceptance-fixed', {
    'fixture.js': "export const ok = 1;\nconst bad = 'it wasn\\'t reused';\nconst nul = 'xy';\n// smart quote here\n",
  });
  const result = lintFile(dir, 'fixture.js');
  assert.equal(isClean(result), true);
  assert.equal(nodeCheck(path.join(dir, 'fixture.js')), null);
});

check('a clean tree reports nothing to fix', () => {
  const dir = tree('clean', { 'ok.js': 'export const x = 1;\n' });
  assert.equal(isClean(lintFile(dir, 'ok.js')), true);
});

check('a missing file is reported as not existing, never thrown', () => {
  const dir = tree('missing', {});
  const result = lintFile(dir, 'ghost.js');
  assert.equal(result.exists, false);
});

check('a binary extension is skipped rather than misread as text', () => {
  const dir = tree('binary', {});
  fs.writeFileSync(path.join(dir, 'icon.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  const result = lintFile(dir, 'icon.png');
  assert.equal(result.skipped, 'binary');
});

check('smart punctuation is still caught in a non-JS file, but node --check is not run', () => {
  const dir = tree('readme', { 'NOTES.md': 'this isn’t code\n' });
  const result = lintFile(dir, 'NOTES.md');
  assert.equal(result.smartPunct.length, 1);
  assert.equal(result.checkError, null);
});

/* ===================================================================== *
 * 7. the CLI — argv parsing, --dir, --json, exit codes
 * ===================================================================== */

console.log('\nthe CLI\n');

check('--help prints usage and exits 0 without running anything', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /b7e-lint/);
});

check('a clean tree, given explicitly, prints nothing and exits 0', () => {
  const dir = tree('cli-clean', { 'ok.js': 'export const x = 1;\n' });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'ok.js'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
});

check('the acceptance fixture, given by CLI path, reports all three findings with file:line and exits 1', () => {
  const dir = tree('cli-acceptance', {
    'fixture.js': `export const ok = 1;\nconst bad = 'it wasn't reused';\nconst nul = 'x\x00y';\n// smart ’ quote here\n`,
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'fixture.js'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  const out = stripAnsi(run.stdout);
  assert.match(out, /fixture\.js:3 control byte/);
  assert.match(out, /fixture\.js:4 smart punctuation/);
  assert.match(out, /fixture\.js:2 apostrophe closes/);
  assert.match(out, /fixture\.js: node --check failed/);
});

check('--json prints an array of dirty-file records, one per file', () => {
  const dir = tree('cli-json', { 'fixture.js': "const bad = 'it wasn't reused';\n" });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json', 'fixture.js'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, 'fixture.js');
});

check('a bin/ file missing its shebang and exec bit is flagged by the CLI too', () => {
  const dir = tree('cli-bin', { 'bin/tool.js': 'console.log(1);\n' });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'bin/tool.js'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /missing shebang/);
  assert.match(run.stdout, /not executable/);
});

check('with --dir, a bare path is resolved against that tree, not the caller\'s own cwd', () => {
  // The same argument bin/b7e-affected already makes for itself: --dir exists to test
  // against a tree this process is not sitting in, so a path given alongside it must
  // resolve against *that* tree.
  const dir = tree('cli-dir-relative', { 'fixture.js': "const bad = 'it wasn't reused';\n" });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'fixture.js'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 1, 'found relative to --dir, not relative to ROOT (where it would not exist)');
});

check('an unresolvable --dir is refused with exit code 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', path.join(tmp, 'does-not-exist')], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

check('with no files to lint (default changed files, none present) it exits 0 quietly', () => {
  const dir = tree('cli-none', {});
  const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.equal(run.stdout, '');
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall lint checks passed\n');
process.exit(failures ? 1 : 0);
