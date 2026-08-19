#!/usr/bin/env node
/**
 * Coverage — measured against real V8 output, not against a mock of it.
 *
 *     npm test
 *     node test/coverage.mjs
 *
 * lib/coverage.js reads a file format nobody here controls: whatever `NODE_V8_COVERAGE`
 * drops in a directory. Every interesting claim it makes is a claim about that format —
 * that the entry spanning the whole file is the module body and not a function, that
 * `ranges[0].count` is the invocation count, that a file nothing imported produces *no
 * entry at all* rather than an entry full of zeroes. A suite that fed it a hand-written
 * fixture would pin this file's idea of V8 and would keep passing on the day a Node
 * upgrade changed the real one, which is the only day it matters.
 *
 * So the fixtures here are generated: a three-file tree under `os.tmpdir()`, a driver
 * that calls some of it and not the rest, run in a real child process with the real
 * environment variable set. What is asserted is then the honest thing — that the fold
 * agrees with what the driver actually did.
 *
 * Hand-written raw files are used for exactly two cases, both of which are about the
 * pile rather than the format: half-written JSON from a process killed mid-flush (which
 * is a normal outcome here, since suites end by killing daemons), and the same file
 * appearing in two processes with different verdicts.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  SCOPE,
  coverageForFiles,
  foldCoverage,
  readReport,
  saveReport,
  scopeFiles,
  summaryLine,
} from '../lib/coverage.js';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const read = (f) => fs.readFileSync(path.join(REPO, f), 'utf8');

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-coverage-'));
const write = (rel, body) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
  return abs;
};

/* ------------------------------------------------------- a tree, and a run over it */
//
// `partly.js` is the interesting one: one export called, one never, and a header comment
// long enough that a line-based metric would call the file well covered on the strength
// of the prose alone. That is the argument in lib/coverage.js, made executable.

write(
  'lib/used.js',
  `export function alpha() {\n  return 1;\n}\nexport const gamma = () => 3;\n`
);
write(
  'lib/partly.js',
  `/**\n * A header long enough to matter.\n *\n * Six lines of prose, which V8 marks executed the instant anything imports this\n * file, and which say nothing whatever about whether the code below ever ran.\n * That is the whole reason this file counts functions instead of lines.\n */\nexport function called() {\n  return 'yes';\n}\nexport function neverCalled() {\n  return 'no';\n}\n`
);
write('lib/never.js', `export function nobody() {\n  return 0;\n}\n`);
write('bin/entry.js', `export function main() {\n  return 'ran';\n}\n`);
write('public/browser.js', `export function paints() {\n  return 'ui';\n}\n`);
write(
  'drive.mjs',
  [
    `import { alpha } from './lib/used.js';`,
    `import { called } from './lib/partly.js';`,
    `import { main } from './bin/entry.js';`,
    `import './public/browser.js';`,
    `alpha();`,
    `called();`,
    `main();`,
  ].join('\n') + '\n'
);

const raw = path.join(tmp, '.coverage');
const run = spawnSync(process.execPath, [path.join(tmp, 'drive.mjs')], {
  cwd: tmp,
  env: { ...process.env, NODE_V8_COVERAGE: raw },
  encoding: 'utf8',
});

console.log('a real V8 run, folded');

await check('the driver ran and V8 wrote something', () => {
  assert.equal(run.status, 0, run.stderr);
  assert.ok(fs.readdirSync(raw).some((f) => f.startsWith('coverage-')));
});

const report = foldCoverage(raw, { root: tmp, commit: 'abc123' });
const byPath = new Map(report.files.map((f) => [f.path, f]));

await check('every file in scope is in the report, whether V8 saw it or not', () => {
  assert.deepEqual(
    report.files.map((f) => f.path).sort(),
    ['bin/entry.js', 'lib/never.js', 'lib/partly.js', 'lib/used.js']
  );
});

await check('a file nothing imported is loaded:false with no function count invented', () => {
  const never = byPath.get('lib/never.js');
  assert.equal(never.loaded, false);
  assert.equal(never.functions, null, 'V8 never parsed it, so there is no denominator');
  assert.deepEqual(never.uncovered, []);
});

await check('an imported file is loaded:true', () => {
  assert.equal(byPath.get('lib/partly.js').loaded, true);
});

await check('and the module body is not counted as one of its functions', () => {
  const partly = byPath.get('lib/partly.js');
  assert.equal(partly.functions.total, 2, JSON.stringify(partly));
});

await check('the function that was called is covered and the one that was not is named', () => {
  const partly = byPath.get('lib/partly.js');
  assert.equal(partly.functions.covered, 1);
  assert.deepEqual(partly.uncovered.map((u) => u.name), ['neverCalled']);
});

await check('an uncovered function carries the line it starts on', () => {
  const at = byPath.get('lib/partly.js').uncovered[0].line;
  const line = fs.readFileSync(path.join(tmp, 'lib/partly.js'), 'utf8').split('\n')[at - 1];
  assert.match(line, /neverCalled/, `line ${at} was ${JSON.stringify(line)}`);
});

await check('the prose header does not make the file look covered — it is 1 of 2, not most of it', () => {
  const partly = byPath.get('lib/partly.js');
  const src = fs.readFileSync(path.join(tmp, 'lib/partly.js'), 'utf8');
  const comment = src.split('\n').filter((l) => l.trim().startsWith('*') || l.trim().startsWith('/**')).length;
  assert.ok(comment >= 6, 'the fixture is meant to be mostly prose');
  assert.equal(partly.functions.covered / partly.functions.total, 0.5);
});

await check('bin/ is in the default scope and was measured', () => {
  assert.deepEqual(SCOPE, ['lib', 'bin']);
  assert.equal(byPath.get('bin/entry.js').functions.covered, 1);
});

await check('public/ is out of scope and is not in the report at all', () => {
  assert.equal(byPath.has('public/browser.js'), false);
  assert.equal(scopeFiles(tmp).includes('public/browser.js'), false);
});

await check('the totals count files, the ones nothing imported, and the functions', () => {
  assert.equal(report.totals.files, 4);
  assert.equal(report.totals.loaded, 3);
  assert.equal(report.totals.functions, 5, JSON.stringify(report.totals));
  assert.equal(report.totals.covered, 3);
});

await check('the report stamps the commit it is a claim about', () => {
  assert.equal(report.commit, 'abc123');
  assert.equal(report.root, tmp);
  assert.ok(Date.parse(report.generated) > 0);
});

await check('a narrower scope narrows the report', () => {
  const only = foldCoverage(raw, { root: tmp, scope: ['lib'] });
  assert.deepEqual(only.files.map((f) => f.path).sort(), ['lib/never.js', 'lib/partly.js', 'lib/used.js']);
});

/* ---------------------------------------------------------------- folding the pile */

console.log('\nthe pile, rather than the format');

const pile = path.join(tmp, 'pile');
fs.mkdirSync(pile, { recursive: true });
// The real path, because that is what V8 emits: on macOS `os.tmpdir()` is
// `/var/folders/...` and its real name is `/private/var/folders/...`, and a fold that
// compares the two as strings matches nothing while looking like an untested tree.
const REAL = fs.realpathSync(tmp);
const url = (rel) => pathToFileURL(path.join(REAL, rel)).href;
const src = (rel) => fs.readFileSync(path.join(tmp, rel), 'utf8');
/** One process's verdict on lib/used.js: whole-module range, then the two functions. */
const process1 = (alphaCount, gammaCount) => ({
  result: [
    {
      scriptId: '1',
      url: url('lib/used.js'),
      functions: [
        { functionName: '', isBlockCoverage: true, ranges: [{ startOffset: 0, endOffset: src('lib/used.js').length, count: 1 }] },
        { functionName: 'alpha', isBlockCoverage: false, ranges: [{ startOffset: 7, endOffset: 40, count: alphaCount }] },
        { functionName: 'gamma', isBlockCoverage: false, ranges: [{ startOffset: 60, endOffset: 70, count: gammaCount }] },
      ],
    },
  ],
});

fs.writeFileSync(path.join(pile, 'coverage-1.json'), JSON.stringify(process1(0, 4)));
fs.writeFileSync(path.join(pile, 'coverage-2.json'), JSON.stringify(process1(9, 0)));
fs.writeFileSync(path.join(pile, 'coverage-3.json'), '{"result":[{"url":"file:///a","fun');
fs.writeFileSync(path.join(pile, 'notes.txt'), 'not coverage output');

const merged = foldCoverage(pile, { root: tmp, scope: ['lib'] });
const used = merged.files.find((f) => f.path === 'lib/used.js');

await check('a function is covered if any process called it', () => {
  assert.deepEqual(used.uncovered, [], 'alpha ran in one process, gamma in the other');
  assert.equal(used.functions.covered, 2);
});

await check('a half-written coverage file is skipped, not thrown on', () => {
  assert.equal(merged.processes, 2);
  assert.equal(merged.unreadable, 1);
});

await check('files that are not coverage output are ignored', () => {
  assert.equal(merged.processes, 2, 'notes.txt must not have been counted');
});

await check('a root reached through a symlink still matches what V8 reported', () => {
  // The link is made here rather than taken from the platform, and that is a change of
  // this check's own footing rather than of what it tests. It used to lean on `os.tmpdir()`
  // being `/var/folders/…` for a real `/private/var/folders/…`, which is true of a Mac
  // shell and stopped being true inside the suite: scripts/test.mjs now hands every suite
  // a `$TMPDIR` of its own, made under a `realpathSync` so that the directory it removes
  // afterwards is the directory the suite actually wrote in (bc-5isv). So nothing arrives
  // symlinked any more, and a precondition that asserted one made this check fail where a
  // real symlinked root — a `~/Repos` on an external disk, a home directory behind an
  // automounter — would still reach `foldCoverage` and still have to fold.
  const link = path.join(tmp, 'root-link');
  fs.symlinkSync(REAL, link);
  assert.notEqual(fs.realpathSync(link), link, 'the link must not be its own target');
  const viaLink = foldCoverage(pile, { root: link, scope: ['lib'] });
  assert.equal(viaLink.files.find((f) => f.path === 'lib/used.js').loaded, true);
});

await check('an absent raw directory folds to a report of everything untouched', () => {
  const none = foldCoverage(path.join(tmp, 'nothing-here'), { root: tmp, scope: ['lib'] });
  assert.equal(none.processes, 0);
  assert.equal(none.totals.loaded, 0);
  assert.equal(none.totals.functions, 0);
  assert.equal(none.files.length, 3);
});

/* ------------------------------------------------------ what a candidate card asks */

console.log('\nthe projection a candidate card reads');

await check('it leads with the files nothing in the suite runs', () => {
  const answer = coverageForFiles(report, ['lib/never.js', 'lib/partly.js']);
  assert.deepEqual(answer.untested, ['lib/never.js']);
  assert.equal(answer.measured, true);
});

await check('and hands back the commit and the time, so a card can age it', () => {
  const answer = coverageForFiles(report, ['lib/partly.js']);
  assert.equal(answer.commit, 'abc123');
  assert.equal(answer.generated, report.generated);
});

await check('a path outside the scope is refused rather than reported as zero', () => {
  const answer = coverageForFiles(report, ['public/browser.js', 'README.md', 'lib/used.js']);
  assert.deepEqual(answer.outOfScope, ['README.md', 'public/browser.js']);
  assert.deepEqual(answer.files.map((f) => f.path), ['lib/used.js']);
  assert.deepEqual(answer.untested, []);
});

await check('a file the candidate added since the measurement is unknown, not untested', () => {
  const answer = coverageForFiles(report, ['lib/brandnew.js']);
  assert.equal(answer.files[0].loaded, null, 'null is "we do not know", false is "nothing ran it"');
  assert.deepEqual(answer.untested, [], 'and it must not be reported as never imported');
});

await check('with no measurement at all it says so instead of guessing', () => {
  const answer = coverageForFiles(null, ['lib/used.js']);
  assert.equal(answer.measured, false);
  assert.deepEqual(answer.untested, []);
  assert.deepEqual(answer.outOfScope, ['lib/used.js'], 'nothing is in scope when there is no scope');
});

await check('duplicate paths in a diff are asked about once', () => {
  const answer = coverageForFiles(report, ['lib/used.js', './lib/used.js', 'lib/used.js']);
  assert.equal(answer.files.length, 1);
});

/* --------------------------------------------------------------- publish and reread */

console.log('\npublishing');

const target = path.join(tmp, 'published', 'coverage.json');

await check('saving creates the directory and reading gets the same report back', () => {
  saveReport(report, target);
  const back = readReport(target);
  assert.deepEqual(back.files, report.files);
  assert.equal(back.commit, 'abc123');
});

await check('an absent or unreadable report reads as null, never as empty coverage', () => {
  assert.equal(readReport(path.join(tmp, 'published', 'nope.json')), null);
  fs.writeFileSync(target + '.bad', '{ half');
  assert.equal(readReport(target + '.bad'), null);
});

await check('the summary line leads with the count that could change a decision', () => {
  assert.match(summaryLine(report), /^1 of 4 files are never imported by the suite;/);
  assert.match(summaryLine(report), /3\/5 functions executed \(60%\)/);
  assert.equal(summaryLine(null), 'no coverage has been measured');
});

/* --------------------------------------------------------------- the registrations */
//
// Three things outside these two files have to exist or the command is unreachable, or
// worse, reachable and quietly filling the config repo's history with a 200KB report.

console.log('\nwired up');

await check('npm run coverage exists and points at the runner', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.scripts.coverage, 'node scripts/coverage.mjs');
});

await check('the raw output is ignored by this repo, so it cannot fail a delivery', () => {
  assert.match(read('.gitignore'), /^\.coverage\/$/m);
});

await check('and the published report is ignored by the config repo, which commits everything', () => {
  assert.match(read('lib/commonrepo.js'), /^coverage\.json$/m);
});

await check('the runner does not measure the swap suite, which has to be run alone', () => {
  assert.match(read('scripts/coverage.mjs'), /SKIP = new Set\(\['scripts\/test-swap\.js'\]\)/);
});

/* ------------------------------------------------------------------------- teardown */

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
