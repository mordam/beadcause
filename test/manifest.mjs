#!/usr/bin/env node
//
// b7e-manifest — a book's chapter and interlude manifest, with the sequence checked
// (bc-dgx7.103). Five deluvia sessions (dv-afr.6, dv-afr.7, dv-afr.8, dv-afr.9, dv-gr6.8)
// each built this table by hand, a different way, before any judgement about the book
// itself could start. This is that command.
//
//   npm test
//   node test/manifest.mjs
//
// Two kinds of proof, the same split test/plate.mjs and test/census.mjs use for the same
// reason: everything in lib/manifest.js that is actually logic — the chapter/interlude
// count regexes (reimplemented from deluvia/scripts/build_series_log.py's own, verified
// by hand against the live deluvia repo when this was written: all six books' counts
// matched exactly, see bc-dgx7.103's delivery notes), header parsing, day/BP/placement
// extraction, and the overlap/gap/placement derivations — is exercised directly against
// tiny fabricated fixtures, so it runs without `deluvia` on disk at all. bin/b7e-manifest
// is then driven as a real subprocess against a fabricated book directory (and, for
// --ref, a fabricated git repo), the same shape test/b7ews.mjs uses for bin/b7e-ws: the
// argv parsing and the wiring in front of the library is the thing under test there.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  buildManifest,
  classify,
  dayIssues,
  extractAge,
  extractBP,
  extractDayRange,
  extractPlacement,
  extractThread,
  extractWordTarget,
  extractYear,
  parseHeader,
  placementIssues,
  repoRoot,
  resolveBookDir,
  wordCount,
} from '../lib/manifest.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-manifest');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-manifest\n');

/* ==================================================================== classify() */

check('classify: chapters is the union of summary and prose numbers, matching build_series_log.py', () => {
  const c = classify(['CHAPTER_1.summary.md', 'CHAPTER_2.text.draft1.md', 'CHAPTER_2.summary.md']);
  assert.deepEqual([...c.chapterNums].sort(), [1, 2]);
  assert.deepEqual([...c.summaries.nums].sort(), [1, 2]);
  assert.deepEqual([...c.prose.nums].sort(), [2]);
});

check('classify: a CHAPTER_18A-shaped file is not counted, but is named in uncounted', () => {
  const c = classify(['CHAPTER_18.summary.md', 'CHAPTER_18A_THE_PARTING.summary.md']);
  assert.deepEqual([...c.chapterNums], [18]);
  assert.deepEqual(c.uncounted, ['CHAPTER_18A_THE_PARTING.summary.md']);
});

check('classify: interlude prose excludes .summary.md, same split as il_prose in the Python', () => {
  const c = classify(['INTERLUDE_01.summary.md', 'INTERLUDE_01.md', 'INTERLUDE_02.summary.md']);
  assert.deepEqual([...c.ilNums].sort(), [1, 2]);
  assert.deepEqual([...c.ilProse.nums], [1]);
  assert.deepEqual([...c.ilSummaries.nums].sort(), [1, 2]);
});

check('classify: planning is every other .md, not prefixed CHAPTER_/INTERLUDE_', () => {
  const c = classify(['CHAPTER_1.summary.md', 'BOOK_OVERVIEW.md', 'notes.txt']);
  assert.deepEqual(c.planning, ['BOOK_OVERVIEW.md']);
});

/* ==================================================================== parseHeader() */

check('parseHeader: collects **Key:** lines up to the first --- into a lowercased map', () => {
  const { h1, fields } = parseHeader(
    '# CHAPTER 1: THE START\n\n**POV:** Alice (Explorer, 30)  \n**Timeline:** A (Coast)\n\n---\n\n**Not:** captured, past the divider\n'
  );
  assert.equal(h1, 'CHAPTER 1: THE START');
  assert.equal(fields.get('pov'), 'Alice (Explorer, 30)');
  assert.equal(fields.get('timeline'), 'A (Coast)');
  assert.equal(fields.has('not'), false);
});

check('parseHeader: stops at the first ## heading too, when there is no ---', () => {
  const { fields } = parseHeader('# CHAPTER 1\n\n**POV:** Alice\n\n## Chapter Summary\n\n**Not:** captured\n');
  assert.equal(fields.get('pov'), 'Alice');
  assert.equal(fields.has('not'), false);
});

/* ==================================================================== field extractors */

check('extractDayRange: prefers time over setting, reads Days N-M', () => {
  const fields = new Map([
    ['time', 'Days 30–35 (of the Day 1→50→60 clock; impact is Day 50)'],
    ['setting', 'Day 1, somewhere else'],
  ]);
  assert.deepEqual(extractDayRange(fields), { start: 30, end: 35, raw: 'Days 30–35' });
});

check('extractDayRange: a single Day N (no dash) is a one-day range', () => {
  assert.deepEqual(extractDayRange(new Map([['time', 'Day 29, first light through the afternoon']])), {
    start: 29,
    end: 29,
    raw: 'Day 29',
  });
});

check('extractDayRange: falls back to setting when time is absent', () => {
  assert.deepEqual(extractDayRange(new Map([['setting', 'Post-glacial grasslands, Day 1']])), {
    start: 1,
    end: 1,
    raw: 'Day 1',
  });
});

check('extractDayRange: null when neither field has a day mention', () => {
  assert.equal(extractDayRange(new Map([['time', '~12,950 BP']])), null);
});

check('extractBP: reads a ~N,NNN BP figure', () => {
  assert.deepEqual(extractBP(new Map([['time', '~12,950 BP — Book\'s opening']])), { value: 12950, raw: '~12,950 BP' });
});

check('extractYear: reads Year N from time', () => {
  assert.deepEqual(extractYear(new Map([['time', 'Year 20 post-impact (~12,860 BP)']])), { value: 20, raw: 'Year 20' });
});

check('extractThread: reads timeline, falls back to thread, keeps the short code', () => {
  assert.equal(extractThread(new Map([['timeline', 'A (North America)']])).code, 'A');
  assert.equal(extractThread(new Map([['thread', 'A — The Yield']])).code, 'A');
  assert.equal(extractThread(new Map()), null);
});

check('extractAge: the first 1-3 digit number inside POV\'s own parenthetical', () => {
  assert.equal(extractAge(new Map([['pov', 'TAYITHI (Alban Orve, 23)']])), 23);
  assert.equal(extractAge(new Map([['pov', 'Kustiyan (Alban Orve navigator, 16)']])), 16);
  assert.equal(extractAge(new Map([['pov', 'Muchi (half-Annu / half-Oohan)']])), null);
  assert.equal(extractAge(new Map()), null);
});

check('extractWordTarget: parses a min-max figure with thousands commas', () => {
  const t = extractWordTarget('**Target word count:** 5,600–6,000 words\n');
  assert.deepEqual(t, { raw: '5,600–6,000 words', min: 5600, max: 6000 });
});

check('extractWordTarget: a single figure sets both min and max, and Length target is the same slot', () => {
  const t = extractWordTarget('**Length target:** 1,500-2,500 words (mid-length)\n');
  assert.deepEqual(t, { raw: '1,500-2,500 words (mid-length)', min: 1500, max: 2500 });
});

check('extractPlacement: parses "after Chapter N ... before Chapter M"', () => {
  const fields = new Map([['placement', 'After Chapter 10, before Chapter 11']]);
  assert.deepEqual(extractPlacement(fields), { raw: 'After Chapter 10, before Chapter 11', afterCh: 10, beforeCh: 11 });
});

check('extractPlacement: an unparseable value is reported, not thrown', () => {
  const fields = new Map([['placement', 'Somewhere in the second act']]);
  assert.deepEqual(extractPlacement(fields), { raw: 'Somewhere in the second act', afterCh: null, beforeCh: null });
});

check('wordCount: whitespace-splits the whole text', () => {
  assert.equal(wordCount('one two three'), 3);
  assert.equal(wordCount('  \n  '), 0);
});

/* ==================================================================== dayIssues() */

const chRow = (num, thread, start, end) => ({ num, label: `Ch ${num}`, thread: { code: thread }, dayRange: { start, end } });

check('dayIssues: flags an overlap within the same thread, not across threads', () => {
  const { overlaps } = dayIssues([chRow(1, 'A', 1, 5), chRow(2, 'A', 3, 8), chRow(3, 'B', 3, 8)]);
  assert.equal(overlaps.length, 1);
  assert.equal(overlaps[0].a.num, 1);
  assert.equal(overlaps[0].b.num, 2);
});

check('dayIssues: flags a gap between non-overlapping ranges in the same thread', () => {
  const { gaps } = dayIssues([chRow(1, 'A', 1, 5), chRow(2, 'A', 10, 12)]);
  assert.equal(gaps.length, 1);
  assert.deepEqual(gaps[0].missing, [6, 9]);
});

check('dayIssues: back-to-back ranges (no missing day) are neither an overlap nor a gap', () => {
  const { overlaps, gaps } = dayIssues([chRow(1, 'A', 1, 5), chRow(2, 'A', 6, 8)]);
  assert.equal(overlaps.length, 0);
  assert.equal(gaps.length, 0);
});

check('dayIssues: a chapter nested inside an earlier one\'s range does not create a false gap', () => {
  // Ch.1 spans days 1-10; Ch.2 (a flashback/aside) is fully inside it at 2-3; Ch.3 picks
  // back up at day 8, still inside Ch.1's own range. Comparing Ch.3 only against Ch.2
  // (the immediately-preceding entry by start) would wrongly report days 4-7 as missing,
  // when Ch.1 was covering them the whole time.
  const { overlaps, gaps } = dayIssues([chRow(1, 'A', 1, 10), chRow(2, 'A', 2, 3), chRow(3, 'A', 8, 12)]);
  assert.equal(gaps.length, 0, JSON.stringify(gaps));
  assert.equal(overlaps.length, 2);
  assert.deepEqual(new Set(overlaps.map((o) => `${o.a.num}-${o.b.num}`)), new Set(['1-2', '1-3']));
});

check('dayIssues: rows without a day range are skipped, not treated as day 0', () => {
  const { overlaps, gaps } = dayIssues([chRow(1, 'A', 1, 5), { num: 2, label: 'Ch 2', thread: { code: 'A' }, dayRange: null }]);
  assert.equal(overlaps.length, 0);
  assert.equal(gaps.length, 0);
});

/* ==================================================================== placementIssues() */

const ilRow = (num, afterCh, beforeCh) => ({ num, label: `IL ${num}`, placement: { afterCh, beforeCh, raw: `after ${afterCh} before ${beforeCh}` } });

check('placementIssues: flags an inconsistent placement (before != after+1)', () => {
  const issues = placementIssues([ilRow(1, 2, 4)], 10);
  assert.ok(issues.some((i) => i.kind === 'inconsistent'));
});

check('placementIssues: flags a placement past the book\'s own last chapter', () => {
  const issues = placementIssues([ilRow(1, 10, 11)], 5);
  assert.ok(issues.some((i) => i.kind === 'out-of-range'));
});

check('placementIssues: a placement at the true last chapter is in range, not flagged', () => {
  const issues = placementIssues([ilRow(1, 23, 24)], 24);
  assert.equal(issues.filter((i) => i.kind === 'out-of-range').length, 0);
});

check('placementIssues: flags a non-monotone sequence across interlude numbers', () => {
  const issues = placementIssues([ilRow(1, 1, 2), ilRow(2, 5, 6), ilRow(3, 2, 3)], 20);
  assert.ok(issues.some((i) => i.kind === 'non-monotone' && i.num === 3));
});

check('placementIssues: an unparseable placement is reported, never thrown', () => {
  const issues = placementIssues([{ num: 1, label: 'IL 1', placement: { afterCh: null, beforeCh: null, raw: 'later' } }], 10);
  assert.ok(issues.some((i) => i.kind === 'unparseable'));
});

/* ==================================================================== repoRoot() */

check('repoRoot: resolves to git\'s own toplevel for a cwd inside a repo', () => {
  const gitProbe = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-manifest-reporoot-'));
  execFileSync('git', ['init', '-q'], { cwd: gitProbe });
  const nested = path.join(gitProbe, 'a', 'b');
  fs.mkdirSync(nested, { recursive: true });
  assert.equal(fs.realpathSync(repoRoot(nested)), fs.realpathSync(gitProbe));
});

check('repoRoot: falls back when cwd is not inside any git repository', () => {
  const notGit = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-manifest-nogit-'));
  assert.equal(repoRoot(notGit, 'fallback-value'), 'fallback-value');
});

/* ==================================================================== resolveBookDir() */

check('resolveBookDir: a bare integer resolves under <root>/novel/Deluvia Book <n>', () => {
  assert.equal(resolveBookDir('3', { root: '/r' }), path.join('/r', 'novel', 'Deluvia Book 3'));
});

check('resolveBookDir: a bare integer with no root is refused, not silently wrong', () => {
  assert.throws(() => resolveBookDir('3', {}), /needs a repo root/);
});

check('resolveBookDir: an explicit relative path resolves against cwd, not root', () => {
  assert.equal(resolveBookDir('novel/Deluvia Book 1', { root: '/r', cwd: '/somewhere/else' }), path.join('/somewhere/else', 'novel/Deluvia Book 1'));
});

check('resolveBookDir: an absolute path is passed through unchanged', () => {
  assert.equal(resolveBookDir('/abs/path', { root: '/r' }), '/abs/path');
});

/* ==================================================================== buildManifest() end-to-end fixture */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-manifest-'));
const bookDir = path.join(tmp, 'Book X');
fs.mkdirSync(bookDir, { recursive: true });

const write = (name, text) => fs.writeFileSync(path.join(bookDir, name), text);

write(
  'CHAPTER_1.summary.md',
  '# CHAPTER 1: OPENING\n\n**POV:** Alice (Explorer, 30)\n**Timeline:** A (Somewhere)\n**Setting:** A shore\n**Time:** Day 1\n**Target word count:** 1,000-1,500 words\n\n---\n\nOnce upon a time on a shore.\n'
);
write(
  'CHAPTER_2.summary.md',
  '# CHAPTER 2: THE STORM\n\n**POV:** Bob\n**Thread:** A (Somewhere)\n**Setting:** A boat\n**Time:** Days 3-6\n\n---\n\nWind and water.\n'
);
write(
  'CHAPTER_3.summary.md',
  '# CHAPTER 3: THE SAME STORM, AGAIN\n\n**POV:** Carol\n**Timeline:** A\n**Time:** Days 5-8\n\n---\n\nA second boat, same days.\n'
);
write(
  'CHAPTER_5.summary.md',
  '# CHAPTER 5: LATER\n\n**POV:** Dana\n**Timeline:** A\n**Time:** Days 12-14\n\n---\n\nSomewhere after a gap.\n'
);
write('CHAPTER_5.text.draft1.md', 'one two three four five six seven eight nine ten');
write('CHAPTER_6A_EXTRA.summary.md', '# CHAPTER 6A: A SIDE PIECE\n\n**POV:** Eve\n\n---\n\nnot counted\n');
write(
  'INTERLUDE_01.summary.md',
  '# INTERLUDE 01: FIRST\n\n**Placement:** After Chapter 1, before Chapter 2\n\n---\n\nA short interlude.\n'
);
write(
  'INTERLUDE_02.summary.md',
  '# INTERLUDE 02: SECOND\n\n**Placement:** After Chapter 2, before Chapter 4\n\n---\n\nSkips a slot.\n'
);
write(
  'INTERLUDE_03.summary.md',
  '# INTERLUDE 03: THIRD\n\n**Placement:** After Chapter 1, before Chapter 2\n\n---\n\nBack behind interlude 2.\n'
);
write(
  'INTERLUDE_04.summary.md',
  '# INTERLUDE 04: FOURTH\n\n**Placement:** After Chapter 10, before Chapter 11\n\n---\n\nPast the last real chapter.\n'
);
write('BOOK_OVERVIEW.md', '# Book X\n\nA planning document.\n');

const manifest = buildManifest({ dir: bookDir, root: tmp, ref: null });

check('buildManifest: totals match the fixture (union counting, uncounted named)', () => {
  assert.deepEqual(manifest.totals, {
    chapters: 4,
    summaries: 4,
    prose: 1,
    propagated: 0,
    interludeOutlines: 4,
    interludeProse: 0,
  });
  assert.deepEqual(manifest.uncounted, ['CHAPTER_6A_EXTRA.summary.md']);
});

check('buildManifest: chapter rows are in numeric order with their own header fields', () => {
  assert.deepEqual(manifest.chapters.map((r) => r.num), [1, 2, 3, 5]);
  assert.equal(manifest.chapters[0].pov, 'Alice (Explorer, 30)');
  assert.equal(manifest.chapters[0].age, 30);
  assert.equal(manifest.chapters[0].wordTarget.min, 1000);
});

check('buildManifest: a prose file is measured and attached to its own chapter row', () => {
  const ch5 = manifest.chapters.find((r) => r.num === 5);
  const prose = ch5.files.find((f) => f.file === 'CHAPTER_5.text.draft1.md');
  assert.equal(prose.words, 10);
});

check('buildManifest: derives the fixture\'s overlap (Ch.2/Ch.3) and its two gaps', () => {
  // Day 1 (Ch.1) to Days 3-6 (Ch.2) leaves day 2 unaccounted for too — a second, smaller
  // gap the fixture didn't set out to test but is exactly as real as the Ch.3/Ch.5 one.
  assert.equal(manifest.issues.overlaps.length, 1);
  assert.deepEqual(new Set([manifest.issues.overlaps[0].a.num, manifest.issues.overlaps[0].b.num]), new Set([2, 3]));
  assert.equal(manifest.issues.gaps.length, 2);
  assert.deepEqual(
    manifest.issues.gaps.map((g) => g.missing).sort((a, b) => a[0] - b[0]),
    [[2, 2], [9, 11]]
  );
});

check('buildManifest: derives the fixture\'s placement issues — inconsistent, out-of-range, non-monotone', () => {
  const kinds = manifest.issues.placement.map((p) => `${p.num}:${p.kind}`);
  assert.ok(kinds.includes('2:inconsistent'), kinds.join(','));
  assert.ok(kinds.includes('4:out-of-range'), kinds.join(','));
  assert.ok(kinds.includes('3:non-monotone'), kinds.join(','));
});

check('buildManifest: a directory that does not exist is refused, not silently empty', () => {
  assert.throws(() => buildManifest({ dir: path.join(tmp, 'nope'), root: tmp, ref: null }), /no such directory/);
});

/* ==================================================================== --ref, over a real fixture repo */

const gitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-manifest-git-'));
execFileSync('git', ['init', '-q'], { cwd: gitTmp });
const gitBookDir = path.join(gitTmp, 'novel', 'Deluvia Book 9');
fs.mkdirSync(gitBookDir, { recursive: true });
fs.writeFileSync(path.join(gitBookDir, 'CHAPTER_1.summary.md'), '# CHAPTER 1: OLD TITLE\n\n**Timeline:** A\n**Time:** Day 1\n\n---\n');
execFileSync('git', ['add', '-A'], { cwd: gitTmp });
execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'first'], { cwd: gitTmp });
const firstSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: gitTmp, encoding: 'utf8' }).trim();
// Working tree now diverges from that commit — CHAPTER_2 added, CHAPTER_1 retitled.
fs.writeFileSync(path.join(gitBookDir, 'CHAPTER_1.summary.md'), '# CHAPTER 1: NEW TITLE\n\n**Timeline:** A\n**Time:** Day 1\n\n---\n');
fs.writeFileSync(path.join(gitBookDir, 'CHAPTER_2.summary.md'), '# CHAPTER 2: ADDED LATER\n\n**Timeline:** A\n**Time:** Day 2\n\n---\n');

check('buildManifest: --ref reads the book as it stood at that commit, not the working tree', () => {
  const atFirst = buildManifest({ dir: gitBookDir, root: gitTmp, ref: firstSha });
  assert.equal(atFirst.totals.chapters, 1);
  assert.equal(atFirst.chapters[0].label, 'CHAPTER 1: OLD TITLE');

  const working = buildManifest({ dir: gitBookDir, root: gitTmp, ref: null });
  assert.equal(working.totals.chapters, 2);
  assert.equal(working.chapters[0].label, 'CHAPTER 1: NEW TITLE');
});

/* ==================================================================== bin/b7e-manifest, as a subprocess */

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

check('--help prints usage and exits 0 without needing a book argument', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-manifest/);
});

check('no arguments is refused', () => {
  const { status, stderr } = run([]);
  assert.notEqual(status, 0);
  assert.match(stderr, /needs a <book-dir\|book-number>/);
});

check('an unknown flag is refused', () => {
  const { status, stderr } = run(['--nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /unknown flag --nope/);
});

check('--ref with no value is refused', () => {
  const { status, stderr } = run([bookDir, '--ref']);
  assert.notEqual(status, 0);
  assert.match(stderr, /--ref needs a value/);
});

check('a second positional argument is refused', () => {
  const { status, stderr } = run([bookDir, 'extra']);
  assert.notEqual(status, 0);
  assert.match(stderr, /one <book-dir\|book-number> only/);
});

check('a directory that does not exist exits 2 with a plain message', () => {
  const { status, stderr } = run([path.join(tmp, 'does-not-exist')]);
  assert.equal(status, 2);
  assert.match(stderr, /b7e-manifest: no such directory/);
});

check('an explicit book directory prints the report, including the derived issues', () => {
  const { status, stdout } = run([bookDir]);
  assert.equal(status, 0);
  assert.match(stdout, /4 chapters \(4 summaries, 1 prose, 0 propagated\)/);
  assert.match(stdout, /not counted above.*CHAPTER_6A_EXTRA\.summary\.md/);
  assert.match(stdout, /OVERLAP\s+thread A: Ch\.[23] .* and Ch\.[23]/);
  assert.match(stdout, /GAP\s+thread A: Days 9–11 between Ch\.3 and Ch\.5/);
  assert.match(stdout, /PLACEMENT IL\.2 \(inconsistent\)/);
  assert.match(stdout, /PLACEMENT IL\.4 \(out-of-range\)/);
  assert.match(stdout, /PLACEMENT IL\.3 \(non-monotone\)/);
});

check('a book with nothing to flag says so, rather than printing an empty section', () => {
  const cleanDir = path.join(tmp, 'Book Clean');
  fs.mkdirSync(cleanDir, { recursive: true });
  fs.writeFileSync(path.join(cleanDir, 'CHAPTER_1.summary.md'), '# CHAPTER 1\n\n**Timeline:** A\n**Time:** Day 1\n\n---\n');
  const { stdout } = run([cleanDir]);
  assert.match(stdout, /no day-range overlaps or gaps, no interlude placement issues/);
});

check('--json prints the whole manifest, parseable, matching the lib-level totals', () => {
  const { status, stdout } = run([bookDir, '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.totals, manifest.totals);
  assert.equal(parsed.chapters.length, 4);
});

check('a bare book number resolves under <repo root>/novel/Deluvia Book <n>, from a nested cwd', () => {
  const nested = path.join(gitTmp, 'novel');
  const { status, stdout } = run(['9'], { cwd: nested });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /2 chapters/);
});

check('--ref reads the book at that commit through the CLI too', () => {
  const { status, stdout } = run(['9', '--ref', firstSha], { cwd: gitTmp });
  assert.equal(status, 0, stdout);
  assert.match(stdout, /1 chapters/);
  assert.match(stdout, /OLD TITLE/);
});

check('--json through a pipe is whole and parseable, however big the report (bc-dgx7.45)', () => {
  // console.log(...) then process.exit(0) used to drop whatever of the write was still
  // pending: stdout to a pipe is async in Node, so a book with enough chapters could cut
  // at exactly 65536 bytes with status 0 and unparseable JSON — nothing to notice. The
  // manifest itself doesn't carry each file's full text (only its word count), so this
  // takes chapter *rows*, not chapter length: ~500 bytes of JSON per row, so 200 rows
  // clears the 64KB pipe buffer with margin.
  const bigDir = path.join(tmp, 'Book Big');
  fs.mkdirSync(bigDir, { recursive: true });
  for (let n = 1; n <= 200; n += 1) {
    fs.writeFileSync(
      path.join(bigDir, `CHAPTER_${n}.summary.md`),
      `# CHAPTER ${n}: FILLER\n\n**POV:** Someone (Explorer, 30)\n**Timeline:** A\n**Setting:** A place\n**Time:** Day ${n}\n\n---\n\nSome body text.\n`
    );
  }
  const res = spawnSync(process.execPath, [BIN, bigDir, '--json'], { encoding: 'utf8' });
  assert.equal(res.status, 0);
  assert.ok((res.stdout || '').length > 65536, `payload too small to test the pipe buffer: ${(res.stdout || '').length} bytes`);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.chapters.length, 200);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
