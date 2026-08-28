#!/usr/bin/env node
//
// b7e-retired — which occurrences of a superseded figure are still an assertion, and
// which are the record of its own retirement (bc-dgx7.129).
//
//   npm test
//   node test/b7eretired.mjs
//
// The fixture reproduces the SHAPE the bead names — a table row naming "Superseded
// figures (Entry NNN)", a CHANGE_LOG entry whose whole body is the retiring decision, a
// "Notes for Adam" worklog paragraph, a --datum-dir subtree, and a same-number-
// different-unit false positive — rather than deluvia's own corpus at a pinned commit,
// for the reason a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci names:
// deluvia is not fetched by this repo's CI and its files keep moving.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-retired');

const {
  valuePattern,
  unitNearby,
  nearestHeadingAbove,
  tableOrHeadingRule,
  notesForAdamRule,
  isChangeLogFile,
  changeLogEntryRule,
  classifyMatch,
  scanText,
  walkWorkingTree,
  classify,
} = await import(path.join(ROOT, 'lib', 'retired.js'));

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ------------------------------------------------------------------ fixture */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eretired-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });

// A live assertion: still says the old figure, still about sea level.
fs.writeFileSync(
  path.join(REPO, 'FUNDAY_COAST.md'),
  '# Funday Coast\n\nSea levels were 80-100 m lower during the last glacial maximum.\n'
);

// A different unit — the exact false positive the bead names: same figure, a canal's
// width, not sea level.
fs.writeFileSync(
  path.join(REPO, 'LLAEDDYNN.md'),
  '# Llaeddynn\n\nThe old trade canal ran 180 km long, 80-100 m wide, now silted.\n'
);

// A table row that IS the record of the retirement, not an assertion of the figure.
fs.writeFileSync(
  path.join(REPO, 'REGIONS_TABLE.md'),
  [
    '# Regional data',
    '',
    '| Figure | Status | Current |',
    '| --- | --- | --- |',
    "| Sea level '80-100 m' | Superseded figures (Entry 040) | ~65 m current |",
    '',
  ].join('\n')
);

// A heading naming the retirement, with the figure inside its body.
fs.writeFileSync(
  path.join(REPO, 'RETIRED_HEADING.md'),
  ['# World data', '', '## Superseded figures', '', 'Old sea level draft: 80-100 m lower.', ''].join('\n')
);

// A "Notes for Adam" worklog block reporting the drift, not asserting it.
fs.writeFileSync(
  path.join(REPO, 'WORKLOG.md'),
  [
    '# Session log',
    '',
    '## Notes for Adam',
    '',
    "SUNDALAND.md still says '80-100 m lower' for sea level — filed as its own bead.",
    '',
  ].join('\n')
);

// A --datum-dir subtree: on a different datum entirely, so even a live-shaped sentence
// inside it is recorded, not live.
fs.mkdirSync(path.join(REPO, 'reference', 'regions', 'cycle1'), { recursive: true });
fs.writeFileSync(
  path.join(REPO, 'reference', 'regions', 'cycle1', 'OLD_CYCLE.md'),
  '# Cycle 1\n\nSea levels were 80-100 m lower here, by this cycle\'s own standard.\n'
);

// A CHANGE_LOG.md entry whose body IS the retiring decision — reuses entryHeadings, so
// it must actually parse as an entry, in the shape lib/changelog.js expects.
fs.writeFileSync(
  path.join(REPO, 'CHANGE_LOG.md'),
  [
    '# CHANGE_LOG',
    '',
    '## Entry 040 — 2026-08-10',
    '',
    '**Type:** WORLD DECISION',
    '**Status:** [PROPAGATED]',
    "**Decision:** Sea level was '80-100 m' lower; revised to '~65 m' per updated Kazran modelling.",
    '',
    '**Chapters affected:**',
    '- [x] placeholder',
    '',
  ].join('\n')
);

// The Kazran-height-bands case (dv-5i2.92): a second retired figure whose only
// occurrences are inside CHANGE_LOG entry bodies — LIVE must come back empty for it.
fs.writeFileSync(
  path.join(REPO, 'KAZRAN.md'),
  '# Kazran\n\nHeight bands were finalised after the Entry 041 ruling below.\n'
);
fs.appendFileSync(
  path.join(REPO, 'CHANGE_LOG.md'),
  [
    '',
    '## Entry 041 — 2026-08-11',
    '',
    '**Type:** LORE DECISION',
    '**Status:** [PROPAGATED]',
    "**Decision:** Kazran height bands revised from '7-8 ft' to '6-7 ft', matching the sea-level ruling above.",
    '',
    '**Chapters affected:**',
    '- [x] placeholder',
    '',
  ].join('\n')
);

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

/* --------------------------------------------------------------------- lib */

await check('valuePattern: any dash-like char matches a plain "-", any space run matches any whitespace', () => {
  // valuePattern returns a global (stateful) regex — a fresh one per .test() call, since
  // reusing one across assertions advances lastIndex and silently fails the next check.
  assert.ok(valuePattern('80-100 m').test('80-100 m'));
  assert.ok(valuePattern('80-100 m').test('80–100 m')); // en dash
  assert.ok(valuePattern('80-100 m').test('80—100 m')); // em dash
  assert.ok(valuePattern('80-100 m').test('80−100 m')); // minus sign
  assert.ok(valuePattern('80-100 m').test('80-100    m')); // wider run of spaces
  assert.ok(!valuePattern('80-100 m').test('80-101 m'));
});

await check('unitNearby: true with no --unit given at all', () => {
  assert.equal(unitNearby('anything at all', 0, 3, null), true);
});

await check('unitNearby: finds the unit within the window, tolerates a trailing "s"', () => {
  const line = 'Sea levels were 80-100 m lower during the glacial maximum.';
  const idx = line.indexOf('80-100 m');
  assert.equal(unitNearby(line, idx, '80-100 m'.length, 'sea level'), true);
});

await check('unitNearby: false when the unit is a different thing being measured', () => {
  const line = 'The old trade canal ran 180 km long, 80-100 m wide, now silted.';
  const idx = line.indexOf('80-100 m');
  assert.equal(unitNearby(line, idx, '80-100 m'.length, 'sea level'), false);
});

await check('nearestHeadingAbove: finds the closest heading at or above the line', () => {
  const lines = ['# Top', '', '## Superseded figures', '', 'body line'];
  assert.deepEqual(nearestHeadingAbove(lines, 4), { line: 2, text: 'Superseded figures' });
  assert.equal(nearestHeadingAbove(['no heading here'], 0), null);
});

await check('tableOrHeadingRule: a table row naming Superseded/Retired/Entry NNN', () => {
  const lines = ["| Sea level '80-100 m' | Superseded figures (Entry 040) | ~65 m current |"];
  assert.match(tableOrHeadingRule(lines, 0), /table row naming Superseded/);
});

await check('tableOrHeadingRule: a table row under a header row that names it, not the row itself', () => {
  const lines = ['| Figure | Superseded figures (Entry 040) |', '| --- | --- |', '| 80-100 m | ~65 m current |'];
  assert.match(tableOrHeadingRule(lines, 2), /header row names Superseded/);
});

await check('tableOrHeadingRule: under a heading naming Superseded/Retired', () => {
  const lines = ['## Superseded figures', '', 'Old sea level draft: 80-100 m lower.'];
  assert.match(tableOrHeadingRule(lines, 2), /heading naming Superseded/);
});

await check('tableOrHeadingRule: null for an ordinary sentence with no table or heading match', () => {
  const lines = ['# World', '', 'Sea levels were 80-100 m lower.'];
  assert.equal(tableOrHeadingRule(lines, 2), null);
});

await check('notesForAdamRule: inside a "Notes for Adam" block', () => {
  const lines = ['## Notes for Adam', '', "SUNDALAND.md still says '80-100 m lower'."];
  assert.match(notesForAdamRule(lines, 2), /Notes for Adam/);
});

await check('notesForAdamRule: null outside such a block', () => {
  const lines = ['# World', '', 'Sea levels were 80-100 m lower.'];
  assert.equal(notesForAdamRule(lines, 2), null);
});

await check('isChangeLogFile: CHANGE_LOG.md and variants, never a file that merely mentions one', () => {
  assert.equal(isChangeLogFile('CHANGE_LOG.md'), true);
  assert.equal(isChangeLogFile('changelog.md'), true);
  assert.equal(isChangeLogFile('reference/CHANGE_LOG.md'), true);
  assert.equal(isChangeLogFile('CHANGE_LOG_NOTES.md'), false);
  assert.equal(isChangeLogFile('WORKLOG.md'), false);
});

await check('changeLogEntryRule: a line inside Entry 040\'s body is caught, one outside is not', () => {
  const text = fs.readFileSync(path.join(REPO, 'CHANGE_LOG.md'), 'utf8');
  const decisionLine = text.split('\n').findIndex((l) => l.includes("was '80-100 m' lower")) + 1;
  assert.match(changeLogEntryRule(text, decisionLine), /Entry 040/);
  assert.equal(changeLogEntryRule(text, 1), null); // the "# CHANGE_LOG" title line
});

await check('classifyMatch: datum-dir is checked first and wins over an on-unit sentence', () => {
  const verdict = classifyMatch({
    relPath: 'reference/regions/cycle1/OLD_CYCLE.md',
    text: '',
    lines: ["Sea levels were 80-100 m lower here, by this cycle's own standard."],
    lineIdx: 0,
    matchIndex: 12,
    matchLen: 8,
    value: '80-100 m',
    instead: null,
    unit: 'sea level',
    datumDirs: ['reference/regions/cycle1'],
  });
  assert.equal(verdict.live, false);
  assert.equal(verdict.rule, 'datum-dir');
});

await check('classifyMatch: a live match carries --instead in its reason', () => {
  const verdict = classifyMatch({
    relPath: 'FUNDAY_COAST.md',
    text: '',
    lines: ['Sea levels were 80-100 m lower during the last glacial maximum.'],
    lineIdx: 0,
    matchIndex: 16,
    matchLen: 8,
    value: '80-100 m',
    instead: '~65 m',
    unit: 'sea level',
    datumDirs: [],
  });
  assert.equal(verdict.live, true);
  assert.match(verdict.reason, /not '~65 m'/);
});

await check('scanText: never spins on a zero-width match', () => {
  const out = scanText('f.md', 'no match here at all', { value: '80-100 m', instead: null, unit: null, datumDirs: [] });
  assert.deepEqual(out, []);
});

await check('walkWorkingTree: pathspecs restrict the scan; SKIP_DIRS is never descended', () => {
  fs.mkdirSync(path.join(REPO, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'node_modules', 'junk.md'), '80-100 m');
  const all = walkWorkingTree(REPO, []);
  assert.ok(!all.includes('node_modules/junk.md'));
  const scoped = walkWorkingTree(REPO, ['FUNDAY_COAST.md']);
  assert.deepEqual(scoped, ['FUNDAY_COAST.md']);
  fs.rmSync(path.join(REPO, 'node_modules'), { recursive: true, force: true });
});

await check('classify: acceptance shape — LIVE has exactly the live occurrence, everything else is RECORDED with a rule', async () => {
  const { live, recorded } = await classify(REPO, {
    value: '80-100 m',
    unit: 'sea level',
    datumDirs: ['reference/regions/cycle1'],
  });
  assert.deepEqual(
    live.map((r) => r.file),
    ['FUNDAY_COAST.md']
  );
  const byFile = Object.fromEntries(recorded.map((r) => [r.file, r.rule]));
  assert.equal(byFile['LLAEDDYNN.md'], 'unit-mismatch');
  assert.equal(byFile['REGIONS_TABLE.md'], 'superseded-table-or-heading');
  assert.equal(byFile['RETIRED_HEADING.md'], 'superseded-table-or-heading');
  assert.equal(byFile['WORKLOG.md'], 'notes-for-adam');
  assert.equal(byFile['reference/regions/cycle1/OLD_CYCLE.md'], 'datum-dir');
  assert.equal(byFile['CHANGE_LOG.md'], 'changelog-entry');
});

await check('classify: --datum-dir demotes the whole subtree even without --unit', async () => {
  const { live, recorded } = await classify(REPO, {
    value: '80-100 m',
    datumDirs: ['reference/regions/cycle1'],
  });
  assert.ok(!live.some((r) => r.file.startsWith('reference/regions/cycle1')));
  assert.ok(recorded.some((r) => r.file === 'reference/regions/cycle1/OLD_CYCLE.md' && r.rule === 'datum-dir'));
});

await check('classify: the Kazran height-bands case — LIVE empty, both entries land in RECORDED', async () => {
  const { live, recorded } = await classify(REPO, { value: '7-8 ft', pathspecs: ['CHANGE_LOG.md'] });
  assert.deepEqual(live, []);
  assert.ok(recorded.some((r) => r.rule === 'changelog-entry' && r.file === 'CHANGE_LOG.md'));
});

await check('classify: --rev reads through git, ignores an uncommitted working-tree edit', async () => {
  fs.appendFileSync(path.join(REPO, 'FUNDAY_COAST.md'), '\nAn uncommitted stray line about 80-100 m.\n');
  const { live } = await classify(REPO, { value: '80-100 m', unit: 'sea level', rev: 'main', pathspecs: ['FUNDAY_COAST.md'] });
  assert.equal(live.length, 1); // the committed sentence only, not the uncommitted stray one
  git(REPO, 'checkout', '--', 'FUNDAY_COAST.md');
});

/* --------------------------------------------------------------------- CLI */

await check('CLI: prints LIVE and RECORDED, exits 1 when LIVE is non-empty', () => {
  const run = spawnSync(
    process.execPath,
    [BIN, '--dir', REPO, '--value', '80-100 m', '--unit', 'sea level', '--datum-dir', 'reference/regions/cycle1'],
    { encoding: 'utf8' }
  );
  assert.equal(run.status, 1);
  assert.match(run.stdout, /LIVE \(1\):/);
  assert.match(run.stdout, /RECORDED \(\d+\):/);
  assert.match(run.stdout, /FUNDAY_COAST\.md/);
});

await check('CLI: exits 0 when LIVE is empty', () => {
  // Scoped to a pathspec that has no live occurrence of its own (--unit demotes it).
  const run = spawnSync(
    process.execPath,
    [BIN, '--dir', REPO, '--value', '80-100 m', '--unit', 'sea level', 'LLAEDDYNN.md'],
    { encoding: 'utf8' }
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /LIVE \(0\):/);
});

await check('CLI: --json is valid JSON with live/recorded arrays', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--value', '80-100 m', '--unit', 'sea level', '--json'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.ok(Array.isArray(parsed.live));
  assert.ok(Array.isArray(parsed.recorded));
  assert.equal(parsed.unit, 'sea level');
});

await check('CLI: --instead is carried into a live match\'s reason', () => {
  const run = spawnSync(
    process.execPath,
    [BIN, '--dir', REPO, '--value', '80-100 m', '--instead', '~65 m', '--unit', 'sea level', '--json'],
    { encoding: 'utf8' }
  );
  const parsed = JSON.parse(run.stdout);
  const live = parsed.live.find((r) => r.file === 'FUNDAY_COAST.md');
  assert.match(live.reason, /not '~65 m'/);
});

await check('CLI: --rev classifies at a git ref instead of the working tree', () => {
  const run = spawnSync(
    process.execPath,
    [BIN, '--dir', REPO, '--value', '7-8 ft', '--rev', 'main', 'CHANGE_LOG.md'],
    { encoding: 'utf8' }
  );
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /RECORDED \(1\):/);
});

await check('CLI: pathspecs restrict the scan to the given paths', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--value', '80-100 m', 'FUNDAY_COAST.md'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stderr);
  assert.doesNotMatch(run.stdout, /LLAEDDYNN\.md/);
});

await check('CLI: --value is required', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--value is required/);
});

await check('CLI: an unrecognised flag is refused', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', REPO, '--value', 'x', '--bogus'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /unrecognised flag/);
});

await check('CLI: --help prints usage and exits 0 without scanning anything', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage: b7e-retired/);
});

await check('CLI: never writes to the tree it scans', () => {
  const before = fs.readFileSync(path.join(REPO, 'FUNDAY_COAST.md'), 'utf8');
  spawnSync(process.execPath, [BIN, '--dir', REPO, '--value', '80-100 m', '--unit', 'sea level'], { encoding: 'utf8' });
  assert.equal(fs.readFileSync(path.join(REPO, 'FUNDAY_COAST.md'), 'utf8'), before);
});

/* -------------------------------------------------------------------- report */

cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} b7e-retired checks passed`);
process.exit(failures ? 1 : 0);
