#!/usr/bin/env node
//
// b7e-chapter — which file on disk is this book or chapter, and which variant is the
// live one (bc-dgx7.123).
//
//   npm test
//   node test/b7echapter.mjs
//
// lib/chapter.js does the resolution; this drives it both directly and through
// bin/b7e-chapter, against a fixture built with lib/fixture.js's buildFixture — a real
// (throwaway) git tree, never the deluvia checkout, so this suite depends on neither
// deluvia being cloned nor its current file layout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-chapter');

const chapter = await import(path.join(ROOT, 'lib', 'chapter.js'));
const { buildFixture, fixtureRoot } = await import(path.join(ROOT, 'lib', 'fixture.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
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

console.log('\nb7e-chapter\n');

/* ===================================================================== *
 * fixture: a synthetic novel/ tree, never deluvia's real one
 * ===================================================================== */

const CANON_PY = [
  '# Gates chapters 1-11: propagated.md is the canon text.',
  'BOOK_DIR = "Deluvia Book 3"',
  'CANON_KEYWORD = "propagated"',
  '',
].join('\n');

const fx = buildFixture({
  name: 'b7echapter-suite',
  steps: [
    { type: 'file', path: 'novel/Deluvia Book 1/BOOK_1_OVERVIEW.md', content: 'book 1 overview\n' },
    { type: 'file', path: 'novel/Deluvia Book 12/BOOK_12_OVERVIEW.md', content: 'book 12 overview — must never answer a query for book 1\n' },
    { type: 'file', path: 'novel/Deluvia Book 2/BOOK_2_OVERVIEW.md', content: 'book 2 overview\n' },
    {
      type: 'file',
      path: 'novel/Deluvia Book 2/_archive_pre-restructure/CHAPTER_22.summary.md',
      content: 'archived twin, must never be a result\n',
    },
    {
      type: 'file',
      path: '.claude/worktrees-retired/old-session-a3f/novel/Deluvia Book 2/BOOK_2_OVERVIEW.md',
      content: 'retired-worktree twin, must never be a result\n',
    },
    { type: 'file', path: 'novel/Deluvia Book 5/BOOK_5_SUMMARY.md', content: 'book 5 summary\n' },
    { type: 'file', path: 'novel/Deluvia Book 5/BOOK_5_CHAPTER_MAP.md', content: 'book 5 chapter map\n' },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_1.summary.md', content: 'ch1 summary\n' },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_1.text.draft.md', content: 'ch1 draft prose\n' },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_1.propagated.md', content: 'ch1 propagated\n' },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_12.summary.md', content: 'ch12 summary — above the canon gate range\n' },
    { type: 'file', path: 'scripts/check_ch1_11_canon.py', content: CANON_PY },
    { type: 'commit', message: 'seed the fixture novel/ tree' },
  ],
});
const DIR = fx.dir;

/* ===================================================================== *
 * 1. lib/chapter.js — units
 * ===================================================================== */

check('classifyVariant recognises propagated/summary/prose, and falls back to other', () => {
  assert.equal(chapter.classifyVariant('propagated'), 'propagated');
  assert.equal(chapter.classifyVariant('summary'), 'summary');
  assert.equal(chapter.classifyVariant('text.draft'), 'prose');
  assert.equal(chapter.classifyVariant('text.draft1'), 'prose');
  assert.equal(chapter.classifyVariant('outline'), 'other');
});

check('isArchived catches _archive_* segments and anything under .claude/worktrees-retired/', () => {
  assert.equal(chapter.isArchived('novel/Deluvia Book 2/_archive_pre-restructure/CHAPTER_22.summary.md'), true);
  assert.equal(chapter.isArchived('.claude/worktrees-retired/old-a3f/novel/Deluvia Book 2/BOOK_2_OVERVIEW.md'), true);
  assert.equal(chapter.isArchived('novel/Deluvia Book 2/BOOK_2_OVERVIEW.md'), false);
});

check('findBookDir matches book 1 to "Deluvia Book 1", never to "Deluvia Book 12"', () => {
  const hit = chapter.findBookDir(DIR, 1);
  assert.ok(hit, 'book 1 should resolve');
  assert.equal(path.basename(hit.dir), 'Deluvia Book 1');
});

check('findBookDir returns null for a book number nothing names', () => {
  assert.equal(chapter.findBookDir(DIR, 99), null);
});

check('findBookDocs: book 2 (OVERVIEW only) resolves the OVERVIEW and archives the retired-worktree twin', () => {
  const { book, resolved, archive } = chapter.findBookDocs(DIR, 2);
  assert.ok(book);
  assert.deepEqual(resolved.map((r) => r.kind), ['OVERVIEW']);
  assert.equal(archive.length, 1);
  assert.match(archive[0].relPath, /worktrees-retired/);
});

check('findChapterFiles: book 2 chapter 22 has no live variant, only the _archive_pre-restructure twin', () => {
  const { resolved, archive } = chapter.findChapterFiles(DIR, 2, 22);
  assert.equal(resolved.length, 0);
  assert.equal(archive.length, 1);
  assert.match(archive[0].relPath, /_archive_pre-restructure/);
});

check('findBookDocs: book 5 (SUMMARY + CHAPTER_MAP, no OVERVIEW) resolves both, archives none', () => {
  const { resolved, archive } = chapter.findBookDocs(DIR, 5);
  assert.deepEqual(
    resolved.map((r) => r.kind).sort(),
    ['CHAPTER_MAP', 'SUMMARY']
  );
  assert.equal(archive.length, 0);
});

check('findChapterFiles: book 3 chapter 1 resolves all three variants, no archive twins', () => {
  const { resolved, archive } = chapter.findChapterFiles(DIR, 3, 1);
  assert.equal(resolved.length, 3);
  assert.deepEqual(
    resolved.map((r) => r.variant).sort(),
    ['prose', 'propagated', 'summary'].sort()
  );
  assert.equal(archive.length, 0);
});

check('findChapterFiles: chapter 1 never matches CHAPTER_12', () => {
  const { resolved } = chapter.findChapterFiles(DIR, 3, 1);
  assert.ok(!resolved.some((r) => r.relPath.includes('CHAPTER_12')));
});

check('findCanonGate: chapter 1 of Book 3 is governed, propagated is named canon-current', () => {
  const { resolved } = chapter.findChapterFiles(DIR, 3, 1);
  const gate = chapter.findCanonGate(DIR, 'Deluvia Book 3', 1, resolved);
  assert.ok(gate);
  assert.equal(gate.variant, 'propagated');
  assert.equal(gate.scriptRelPath, 'scripts/check_ch1_11_canon.py');
});

check('findCanonGate: chapter 12 of Book 3 is outside the gate\'s range — no gate', () => {
  const { resolved } = chapter.findChapterFiles(DIR, 3, 12);
  const gate = chapter.findCanonGate(DIR, 'Deluvia Book 3', 12, resolved);
  assert.equal(gate, null);
});

check('findCanonGate: same chapter range, a different book name — no gate', () => {
  const { resolved } = chapter.findChapterFiles(DIR, 3, 1);
  const gate = chapter.findCanonGate(DIR, 'Deluvia Book 4', 1, resolved);
  assert.equal(gate, null);
});

check('resolveChapter(book, chapter): marks exactly the propagated variant canon-current, citing the gate', () => {
  const result = chapter.resolveChapter(DIR, 3, 1);
  assert.equal(result.mode, 'chapter');
  const propagated = result.variants.find((v) => v.variant === 'propagated');
  const others = result.variants.filter((v) => v.variant !== 'propagated');
  assert.equal(propagated.canonCurrent, true);
  assert.equal(propagated.canonReason, 'scripts/check_ch1_11_canon.py');
  assert.ok(others.every((v) => v.canonCurrent === false && v.canonReason === null));
});

check('resolveChapter(book, chapter above gate range): nothing is canon-current', () => {
  const result = chapter.resolveChapter(DIR, 3, 12);
  assert.equal(result.variants.length, 1);
  assert.equal(result.variants[0].canonCurrent, false);
});

check('resolveChapter annotates lineCount and lastCommit from the fixture\'s real git history', () => {
  const result = chapter.resolveChapter(DIR, 3, 1);
  for (const v of result.variants) {
    assert.equal(v.lineCount, 1);
    assert.match(v.lastCommit, /seed the fixture novel\/ tree/);
  }
});

check('resolveChapter(book) with no chapter: book mode, docs annotated too', () => {
  const result = chapter.resolveChapter(DIR, 5, null);
  assert.equal(result.mode, 'book');
  assert.equal(result.docs.length, 2);
  assert.ok(result.docs.every((d) => typeof d.lineCount === 'number'));
});

check('resolveChapter: unknown book number reports book: null', () => {
  const result = chapter.resolveChapter(DIR, 999, null);
  assert.equal(result.book, null);
  assert.equal(result.docs.length, 0);
});

check('mapBooks lists every book novel/ names, sorted, with its doc kinds — never the retired-worktree twin as its own book', () => {
  const books = chapter.mapBooks(DIR);
  const numbers = books.map((b) => b.number);
  assert.deepEqual(numbers, [...numbers].sort((a, b) => a - b));
  assert.deepEqual(numbers, [1, 2, 3, 5, 12]);
  const two = books.find((b) => b.number === 2);
  assert.deepEqual(two.kinds, ['OVERVIEW']);
  const three = books.find((b) => b.number === 3);
  assert.deepEqual(three.kinds, [], 'book 3 has no BOOK_3_* doc in this fixture, only chapters');
});

/* ===================================================================== *
 * 2. bin/b7e-chapter — argv, exit codes, printed shape
 * ===================================================================== */

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

check('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: b7e-chapter/);
});

check('neither -w nor --dir is a refusal, exit 2', () => {
  const r = run(['2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /one of -w\/--workspace or --dir is required/);
});

check('-w and --dir together is a refusal, exit 2', () => {
  const r = run(['-w', 'deluvia', '--dir', DIR, '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

check('an unrecognised workspace name is a refusal, exit 2', () => {
  const r = run(['-w', 'zzz-not-a-real-workspace-b7echapter', '2']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no workspace named/);
});

check('a non-integer <book> is a refusal, exit 2', () => {
  const r = run(['--dir', DIR, 'two']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /<book> must be an integer/);
});

check('a non-integer <chapter> is a refusal, exit 2', () => {
  const r = run(['--dir', DIR, '3', 'one']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /<chapter> must be an integer/);
});

check('an unknown --variant value is a refusal, exit 2', () => {
  const r = run(['--dir', DIR, '3', '1', '--variant', 'draft']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--variant must be/);
});

check('--variant with no <book> is a refusal, exit 2', () => {
  const r = run(['--dir', DIR, '--variant', 'summary']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--variant needs a <book>/);
});

check('book 2: names the OVERVIEW, not a SUMMARY, and lists the retired-worktree twin under ARCHIVE', () => {
  const r = run(['--dir', DIR, '2']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /BOOK_2_OVERVIEW\.md/);
  assert.doesNotMatch(r.stdout, /BOOK_2_SUMMARY\.md/);
  assert.match(r.stdout, /ARCHIVE/);
  assert.match(r.stdout, /worktrees-retired[\\/]old-session-a3f/);
});

check('book 2 chapter 22: the archived twin is never a result, only listed under ARCHIVE', () => {
  const r = run(['--dir', DIR, '2', '22']);
  assert.equal(r.status, 1, 'nothing live resolves for this chapter');
  assert.doesNotMatch(r.stdout, /^CHAPTER_22\.summary\.md/m);
  assert.match(r.stdout, /ARCHIVE/);
  assert.match(r.stdout, /_archive_pre-restructure[\\/]CHAPTER_22\.summary\.md/);
});

check('book 5: names both the SUMMARY and the CHAPTER_MAP, no ARCHIVE section', () => {
  const r = run(['--dir', DIR, '5']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /BOOK_5_SUMMARY\.md/);
  assert.match(r.stdout, /BOOK_5_CHAPTER_MAP\.md/);
  assert.doesNotMatch(r.stdout, /ARCHIVE/);
});

check('book 3 chapter 1: all three variants, propagated marked canon-current with its gate cited', () => {
  const r = run(['--dir', DIR, '3', '1']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /CHAPTER_1\.summary\.md/);
  assert.match(r.stdout, /CHAPTER_1\.text\.draft\.md/);
  assert.match(r.stdout, /CHAPTER_1\.propagated\.md/);
  assert.match(r.stdout, /canon-current \(scripts\/check_ch1_11_canon\.py\)/);
  const notCanonCount = (r.stdout.match(/not canon-current/g) || []).length;
  assert.equal(notCanonCount, 2);
});

check('book 3 chapter 12 (above the gate range): resolves the file, marks nothing canon-current', () => {
  const r = run(['--dir', DIR, '3', '12']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /CHAPTER_12\.summary\.md/);
  assert.doesNotMatch(r.stdout, /canon-current \(/);
});

check('an unknown book number is exit 1 with a clear refusal, not a silent empty pass', () => {
  const r = run(['--dir', DIR, '777']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /no book 777 found/);
});

check('--variant propagated narrows to just that file', () => {
  const r = run(['--dir', DIR, '3', '1', '--variant', 'propagated', '--path-only']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 1);
  assert.match(lines[0], /CHAPTER_1\.propagated\.md$/);
});

check('--variant current resolves to the canon-current file when one exists', () => {
  const r = run(['--dir', DIR, '3', '1', '--variant', 'current', '--path-only']);
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /CHAPTER_1\.propagated\.md$/);
});

check('--variant current is an honest empty answer (exit 1) when no gate covers the chapter', () => {
  const r = run(['--dir', DIR, '3', '12', '--variant', 'current', '--path-only']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout.trim(), '');
});

check('the bare form with no <book> prints the whole map, one line per book, no archive/retired entries', () => {
  const r = run(['--dir', DIR]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /Book 1\b/);
  assert.match(r.stdout, /Book 2\b/);
  assert.match(r.stdout, /Book 3\b/);
  assert.match(r.stdout, /Book 5\b/);
  assert.match(r.stdout, /Book 12\b/);
  const label = /\x1b\[1mBook 2\x1b\[0m/g;
  assert.equal((r.stdout.match(label) || []).length, 1, 'the retired-worktree twin must not appear as a second Book 2');
});

check('--json on chapter mode is valid JSON with the canon fields', () => {
  const r = run(['--dir', DIR, '3', '1', '--json']);
  assert.equal(r.status, 0);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.mode, 'chapter');
  const propagated = parsed.variants.find((v) => v.variant === 'propagated');
  assert.equal(propagated.canonCurrent, true);
  assert.equal(propagated.canonReason, 'scripts/check_ch1_11_canon.py');
});

/* ===================================================================== *
 * 3. wiring — the two registrations and the header grant, self-checked
 * ===================================================================== */

check('bin/b7e-chapter is executable and declares exactly one @grant', () => {
  const st = fs.statSync(BIN);
  assert.ok(st.mode & 0o111, 'bin/b7e-chapter should be executable');
  const src = fs.readFileSync(BIN, 'utf8');
  const grants = [...src.matchAll(/^[ \t]*(?:\*|\/\/)?[ \t]*@grant[ \t]+(\S+)[ \t]*$/gm)];
  assert.equal(grants.length, 1);
  assert.equal(grants[0][1], 'read');
});

check('package.json and package-lock.json both register b7e-chapter at bin/b7e-chapter', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-chapter'], 'bin/b7e-chapter');
  assert.equal(lock.packages?.['']?.bin?.['b7e-chapter'], 'bin/b7e-chapter');
});

// Only the fixture this run itself created — never the whole of fixtureRoot(), which
// this machine's other concurrent uses of the same command also share.
for (const entry of fs.existsSync(fixtureRoot()) ? fs.readdirSync(fixtureRoot()) : []) {
  if (entry === 'b7echapter-suite') fs.rmSync(path.join(fixtureRoot(), entry), { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
