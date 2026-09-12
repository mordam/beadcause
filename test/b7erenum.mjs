#!/usr/bin/env node
// b7e-renum — what a chapter number meant when it was written, and which chapter it
// is today (bc-xl7n.154).
//
//   npm test
//   node test/b7erenum.mjs
//
// lib/renum.js does the resolution; this drives it both directly and through
// bin/b7e-renum, against fixtures built with lib/fixture.js's buildFixture — real
// (throwaway) git trees, never the deluvia checkout, so this suite depends on neither
// deluvia being cloned nor its current numbering. Four fixtures, one per method the
// module tries in order: a genuine `git mv`-shaped renumber (rename-follow), an
// in-place rewrite that keeps its title (identical H1 title), one that keeps only its
// proper nouns (proper-noun overlap), and a renumber into the archive (cut — the same
// rename-follow method, landing on an archived path).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-renum');

const renum = await import(path.join(ROOT, 'lib', 'renum.js'));
const { buildFixture, fixtureRoot } = await import(path.join(ROOT, 'lib', 'fixture.js'));

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

console.log('\nb7e-renum\n');

const run = (dir, args) => spawnSync(process.execPath, [BIN, '--dir', dir, ...args], { encoding: 'utf8' });
// A tiny sync git helper for the test itself — separate from lib/renum.js's own,
// because a test should not trust the thing it is testing to tell it the truth about
// the fixture it built.
const git = (dir, ...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
const shaOf = (dir, message) => git(dir, 'log', '--format=%H', '--grep', message).trim().split('\n')[0];

/* ===================================================================== *
 * fixture 1 — a genuine renumber: rename-follow
 * ===================================================================== */

const CH18 = ['# CHAPTER 18: OLD TITLE', '', '**POV:** Someone', '**Timeline:** A', '', 'Body text about Kallista and Vorrik in the old numbering.'].join('\n') + '\n';

const fxRename = buildFixture({
  name: 'b7erenum-rename',
  steps: [
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_18.summary.md', content: CH18 },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_1.summary.md', content: '# CHAPTER 1: UNRELATED\n\nNothing to do with it.\n' },
    { type: 'commit', message: 'RENAME-SEED seed old numbering' },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_34.summary.md', content: '# CHAPTER 34\n\nline2\nSee (from Ch. 18) for background.\nline4\n' },
    { type: 'commit', message: 'RENAME-CITE cite the old number while it is still correct' },
    { type: 'delete', path: 'novel/Deluvia Book 3/CHAPTER_18.summary.md' },
    { type: 'file', path: 'novel/Deluvia Book 3/CHAPTER_19.summary.md', content: CH18.replace('CHAPTER 18', 'CHAPTER 19') },
    { type: 'commit', message: 'RENAME-SHIFT Entry 147-style renumber, 18 -> 19' },
  ],
});

check('citedNumbers parses "(from Ch. 18)" as [18]', () => {
  assert.deepEqual(renum.citedNumbers('See (from Ch. 18) for background.'), [18]);
});

check('citedNumbers parses "(from Ch. 14/23)" as [14, 23], in order', () => {
  assert.deepEqual(renum.citedNumbers('Vorrik (from Ch. 14/23), the healing-first voice.'), [14, 23]);
});

check('citedNumbers finds nothing on a line with no chapter citation', () => {
  assert.deepEqual(renum.citedNumbers('Just an ordinary sentence.'), []);
});

check('inferBookFromPath reads the book number from the novel/<dir>/ ancestor', () => {
  const { book, bookDirRel } = renum.inferBookFromPath(fxRename.dir, path.join(fxRename.dir, 'novel/Deluvia Book 3/CHAPTER_34.summary.md'));
  assert.equal(book, 3);
  assert.equal(bookDirRel, 'novel/Deluvia Book 3');
});

check('inferBookFromPath: a file not under novel/ infers no book', () => {
  const { book } = renum.inferBookFromPath(fxRename.dir, path.join(fxRename.dir, 'README.md'));
  assert.equal(book, null);
});

check('resolveCitation: file:line mode chases (from Ch. 18) to Ch. 19 via git rename-follow', () => {
  const result = renum.resolveCitation(fxRename.dir, path.join(fxRename.dir, 'novel/Deluvia Book 3/CHAPTER_34.summary.md'), 4);
  assert.equal(result.blocks.length, 1);
  const [block] = result.blocks;
  assert.equal(block.citedNumber, 18);
  assert.equal(block.book, 3);
  assert.equal(block.then.variants.length, 1);
  assert.equal(block.then.variants[0].relPath, 'novel/Deluvia Book 3/CHAPTER_18.summary.md');
  assert.equal(block.nowResults.length, 1);
  assert.equal(block.nowResults[0].method, 'git rename-follow');
  assert.equal(block.nowResults[0].winner.relPath, 'novel/Deluvia Book 3/CHAPTER_19.summary.md');
  assert.equal(block.nowResults[0].winner.archived, false);
});

check('resolveCitation throws on a line with no citation', () => {
  fs.writeFileSync(path.join(fxRename.dir, 'novel/Deluvia Book 3/PLAIN.md'), 'nothing here\n');
  assert.throws(
    () => renum.resolveCitation(fxRename.dir, path.join(fxRename.dir, 'novel/Deluvia Book 3/PLAIN.md'), 1),
    /no chapter number found/
  );
});

check('resolveCitation throws for a file outside any novel/<Book N>/ directory', () => {
  fs.writeFileSync(path.join(fxRename.dir, 'STRAY.md'), 'Ch. 1 mentioned here\n');
  assert.throws(() => renum.resolveCitation(fxRename.dir, path.join(fxRename.dir, 'STRAY.md'), 1), /not under a novel/);
});

check('CLI: <file>:<line> resolves the same rename, prints "now: Ch. 19" and exits 0', () => {
  const r = run(fxRename.dir, ['novel/Deluvia Book 3/CHAPTER_34.summary.md:4']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /now:\s+Ch\. 19/);
  assert.match(r.stdout, /match: git rename-follow/);
});

check('CLI --json on the same query: valid JSON naming the resolved chapter', () => {
  const r = run(fxRename.dir, ['novel/Deluvia Book 3/CHAPTER_34.summary.md:4', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.citations[0].nowResults[0].winner.relPath, 'novel/Deluvia Book 3/CHAPTER_19.summary.md');
});

check('CLI: <book> <chapter> --at <ref> mode reaches the same answer directly', () => {
  const citeSha = shaOf(fxRename.dir, 'RENAME-CITE');
  const r = run(fxRename.dir, ['3', '18', '--at', citeSha]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /now:\s+Ch\. 19/);
});

check('resolveAtRef resolves a plain git ref directly', () => {
  const citeSha = shaOf(fxRename.dir, 'RENAME-CITE');
  const ref = renum.resolveAtRef(fxRename.dir, citeSha);
  assert.equal(ref.sha, citeSha);
});

check('resolveAtRef refuses a ref that does not exist', () => {
  assert.throws(() => renum.resolveAtRef(fxRename.dir, 'not-a-real-ref-at-all'), /not a ref, a date/);
});

check('bookDirAtRef finds "Deluvia Book 3" at a historical ref, not "Deluvia Book 12"-style false match', () => {
  const citeSha = shaOf(fxRename.dir, 'RENAME-CITE');
  const dir = renum.bookDirAtRef(fxRename.dir, citeSha, 3);
  assert.equal(dir.name, 'Deluvia Book 3');
});

/* ===================================================================== *
 * fixture 2 — an in-place rewrite that keeps its title: identical H1 title
 * ===================================================================== */

const OLD_TITLE_BODY = '# THE CROSSING\n\nOld body text about a canoe and a storm, mentioned once here.\n'.repeat(3);
const NEW_TITLE_BODY =
  '# THE CROSSING\n\nCompletely rewritten body about entirely different events — tariffs, grain and salt roads discussed at length across a council session that goes on for quite a while.\n'.repeat(
    3
  );

const fxTitle = buildFixture({
  name: 'b7erenum-titlematch',
  steps: [
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_7.summary.md', content: OLD_TITLE_BODY },
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_9.summary.md', content: '# SOME OTHER CHAPTER\n\nUnrelated decoy content, nothing to do with it whatsoever.\n' },
    { type: 'commit', message: 'TITLE-SEED seed old ch7' },
    { type: 'delete', path: 'novel/Deluvia Book 2/CHAPTER_7.summary.md' },
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_5.summary.md', content: NEW_TITLE_BODY },
    { type: 'commit', message: 'TITLE-SHIFT restructure: ch7 becomes ch5, rewritten in place' },
  ],
});

check('titleSubject strips a leading "CHAPTER N:" so a renumbered title still compares equal', () => {
  assert.equal(renum.titleSubject('CHAPTER 27: THE FIRE FALLS'), renum.titleSubject('CHAPTER 28: THE FIRE FALLS'));
  assert.equal(renum.titleSubject('CHAPTER 27: THE FIRE FALLS'), 'the fire falls');
});

check('the rewrite fixture genuinely breaks git rename detection (plain A/D, no R line)', () => {
  const nameStatus = git(fxTitle.dir, 'log', '-M', '--name-status', '--format=', '-1');
  assert.doesNotMatch(nameStatus, /^R\d*\t/m);
});

check('resolveNow: falls through rename-follow (nothing to find) to an identical H1 title match', () => {
  const seedSha = shaOf(fxTitle.dir, 'TITLE-SEED');
  const { then, nowResults } = renum.resolveBookAt(fxTitle.dir, 2, 7, seedSha);
  assert.equal(then.variants.length, 1);
  assert.equal(nowResults.length, 1);
  assert.equal(nowResults[0].method, 'identical H1 title');
  assert.equal(nowResults[0].winner.relPath, 'novel/Deluvia Book 2/CHAPTER_5.summary.md');
});

check('CLI: book/chapter mode reports the title match and exits 0', () => {
  const seedSha = shaOf(fxTitle.dir, 'TITLE-SEED');
  const r = run(fxTitle.dir, ['2', '7', '--at', seedSha]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /now:\s+Ch\. 5/);
  assert.match(r.stdout, /match: identical H1 title/);
});

/* ===================================================================== *
 * fixture 3 — retitled and rewritten, sharing only proper nouns: overlap
 * ===================================================================== */

const OLD_OVERLAP = '# THE OLD TITLE\n\nSorahi and Muchi and Oren-Vael and Miran discuss the crossing at length in the old draft.\n'.repeat(3);
const NEW_OVERLAP = '# A COMPLETELY DIFFERENT TITLE\n\nSorahi and Muchi and Oren-Vael and Miran discuss the crossing again, rewritten from scratch with new sentences throughout.\n'.repeat(3);
const DECOY1 = '# DECOY ONE\n\nAstara and Nemrek and a council of something entirely unrelated appear only here.\n'.repeat(3);
const DECOY2 = '# DECOY TWO\n\nOnly Muchi appears once here — nothing else in this decoy chapter matches at all.\n'.repeat(3);

const fxOverlap = buildFixture({
  name: 'b7erenum-overlap',
  steps: [
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_7.summary.md', content: OLD_OVERLAP },
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_9.summary.md', content: DECOY1 },
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_11.summary.md', content: DECOY2 },
    { type: 'commit', message: 'OVERLAP-SEED seed old ch7 plus decoys' },
    { type: 'delete', path: 'novel/Deluvia Book 2/CHAPTER_7.summary.md' },
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_5.summary.md', content: NEW_OVERLAP },
    { type: 'commit', message: 'OVERLAP-SHIFT restructure: ch7 becomes ch5, retitled and rewritten' },
  ],
});

check('properNouns collects capitalized names and drops common stopwords', () => {
  const nouns = renum.properNouns('Sorahi and Muchi discuss The Crossing after Chapter One.');
  assert.ok(nouns.has('Sorahi'));
  assert.ok(nouns.has('Muchi'));
  assert.ok(nouns.has('Crossing'));
  assert.ok(!nouns.has('The'));
  assert.ok(!nouns.has('Chapter'));
});

check('resolveNow: no rename, no title match — proper-noun overlap picks the real match over both decoys', () => {
  const seedSha = shaOf(fxOverlap.dir, 'OVERLAP-SEED');
  const { nowResults } = renum.resolveBookAt(fxOverlap.dir, 2, 7, seedSha);
  assert.equal(nowResults[0].method, 'proper-noun overlap');
  assert.equal(nowResults[0].winner.relPath, 'novel/Deluvia Book 2/CHAPTER_5.summary.md');
  assert.ok(nowResults[0].candidates.length >= 1);
  assert.ok(nowResults[0].candidates[0].score > (nowResults[0].candidates[1]?.score ?? -1));
});

check('CLI: book/chapter mode reports the overlap match with its score and exits 0', () => {
  const seedSha = shaOf(fxOverlap.dir, 'OVERLAP-SEED');
  const r = run(fxOverlap.dir, ['2', '7', '--at', seedSha]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /now:\s+Ch\. 5/);
  assert.match(r.stdout, /match: proper-noun overlap/);
});

/* ===================================================================== *
 * fixture 4 — cut: renamed, via the same rename-follow, into the archive
 * ===================================================================== */

const CH12_OLD = '# CHAPTER 12: THE OLD SCENE\n\nSoreth and Poret argue about the historical archive here.\n';

const fxCut = buildFixture({
  name: 'b7erenum-cut',
  steps: [
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_12.summary.md', content: CH12_OLD },
    { type: 'commit', message: 'CUT-SEED seed old ch12' },
    { type: 'delete', path: 'novel/Deluvia Book 2/CHAPTER_12.summary.md' },
    { type: 'file', path: 'novel/Deluvia Book 2/_archive_pre-restructure/CHAPTER_12.summary.md', content: CH12_OLD },
    { type: 'commit', message: 'CUT-SHIFT restructure: cut ch12 into the archive' },
  ],
});

check('resolveNow: a chapter renamed into _archive_pre-restructure/ reports as archived, same method', () => {
  const seedSha = shaOf(fxCut.dir, 'CUT-SEED');
  const { nowResults } = renum.resolveBookAt(fxCut.dir, 2, 12, seedSha);
  assert.equal(nowResults[0].method, 'git rename-follow');
  assert.equal(nowResults[0].winner.archived, true);
  assert.match(nowResults[0].winner.relPath, /_archive_pre-restructure/);
});

check('CLI: book/chapter mode prints "cut" rather than a live chapter number, and still exits 0', () => {
  const seedSha = shaOf(fxCut.dir, 'CUT-SEED');
  const r = run(fxCut.dir, ['2', '12', '--at', seedSha]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /now:\s+cut — survives only in .*_archive_pre-restructure/);
});

/* ===================================================================== *
 * unresolved: nothing crosses the confidence bar
 * ===================================================================== */

const fxAmbiguous = buildFixture({
  name: 'b7erenum-ambiguous',
  steps: [
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_7.summary.md', content: '# GONE\n\nAquila and Bethel and Corvus appear only here, nowhere else in the book at all.\n' },
    { type: 'file', path: 'novel/Deluvia Book 2/CHAPTER_9.summary.md', content: '# STILL HERE\n\nCompletely unrelated content sharing not one single proper noun with the old chapter.\n' },
    { type: 'commit', message: 'AMBIG-SEED seed an orphan chapter' },
    { type: 'delete', path: 'novel/Deluvia Book 2/CHAPTER_7.summary.md' },
    { type: 'commit', message: 'AMBIG-SHIFT delete ch7 outright, nothing takes its place' },
  ],
});

check('resolveNow: nothing shares the old chapter\'s identity anywhere — unresolved, not a false guess', () => {
  const seedSha = shaOf(fxAmbiguous.dir, 'AMBIG-SEED');
  const { nowResults } = renum.resolveBookAt(fxAmbiguous.dir, 2, 7, seedSha);
  assert.equal(nowResults[0].method, null);
  assert.equal(nowResults[0].winner, null);
});

check('CLI: an unresolved chapter exits 1 and prints "unresolved", not a wrong answer', () => {
  const seedSha = shaOf(fxAmbiguous.dir, 'AMBIG-SEED');
  const r = run(fxAmbiguous.dir, ['2', '7', '--at', seedSha]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /now:\s+unresolved/);
});

check('CLI: a chapter number the era never had — "then" not found, exit 1', () => {
  const seedSha = shaOf(fxAmbiguous.dir, 'AMBIG-SEED');
  const r = run(fxAmbiguous.dir, ['2', '999', '--at', seedSha]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not found in/);
});

/* ===================================================================== *
 * --at : ref | date | "Entry NNN"
 * ===================================================================== */

// Pinned, deliberately far apart — buildFixture's commits otherwise land within the
// same second of each other, which a day-granularity `--at <date>` query cannot tell
// apart. `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pass straight through buildFixture's
// git() (only the four identity vars are pinned there), so setting them here for the
// duration of the build is enough — restored immediately after regardless of outcome.
const savedDates = { GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE, GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE };
let fxAt;
try {
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2026-01-01T00:00:00-03:00';
  fxAt = buildFixture({
    name: 'b7erenum-at',
    steps: [{ type: 'file', path: 'CHANGE_LOG.md', content: '## Entry 001 — first\n\nSomething.\n' }, { type: 'commit', message: 'AT-E1 log entry 1' }],
  });
  process.env.GIT_AUTHOR_DATE = process.env.GIT_COMMITTER_DATE = '2026-06-01T00:00:00-03:00';
  fs.writeFileSync(path.join(fxAt.dir, 'CHANGE_LOG.md'), '## Entry 001 — first\n\nSomething.\n\n## Entry 002 — second\n\nSomething else.\n');
  git(fxAt.dir, 'add', '-A');
  git(fxAt.dir, '-c', 'user.name=b7e-fixture', '-c', 'user.email=b7e-fixture@localhost', 'commit', '-q', '-m', 'AT-E2 log entry 2');
} finally {
  for (const [k, v] of Object.entries(savedDates)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

check('resolveAtRef("Entry NNN") finds the commit that introduced that heading', () => {
  const ref = renum.resolveAtRef(fxAt.dir, 'Entry 002');
  const e2Sha = shaOf(fxAt.dir, 'AT-E2');
  assert.equal(ref.sha, e2Sha);
});

check('resolveAtRef("Entry NNN") refuses a number CHANGE_LOG.md never names', () => {
  assert.throws(() => renum.resolveAtRef(fxAt.dir, 'Entry 999'), /no commit in CHANGE_LOG\.md history/);
});

check('resolveAtRef(date) resolves to the last commit at or before that date, not the later one', () => {
  const e1Sha = shaOf(fxAt.dir, 'AT-E1');
  // Between the two pinned commit dates (2026-01-01 and 2026-06-01) — must land on E1.
  const ref = renum.resolveAtRef(fxAt.dir, '2026-03-01');
  assert.equal(ref.sha, e1Sha);
});

/* ===================================================================== *
 * CLI argv — usage, exit codes
 * ===================================================================== */

const runRaw = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8' });

check('--help prints usage and exits 0', () => {
  const r = runRaw(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: b7e-renum/);
});

check('neither -w nor --dir is a refusal, exit 2', () => {
  const r = runRaw(['2', '3', '--at', 'HEAD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /one of -w\/--workspace or --dir is required/);
});

check('-w and --dir together is a refusal, exit 2', () => {
  const r = runRaw(['-w', 'deluvia', '--dir', fxRename.dir, '3', '18', '--at', 'HEAD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

check('an unrecognised workspace name is a refusal, exit 2', () => {
  const r = runRaw(['-w', 'zzz-not-a-real-workspace-b7erenum', '3', '18', '--at', 'HEAD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no workspace named/);
});

check('<book> <chapter> mode without --at is a refusal, exit 2', () => {
  const r = run(fxRename.dir, ['3', '18']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /needs --at/);
});

check('--at together with <file>:<line> mode is a refusal, exit 2', () => {
  const r = run(fxRename.dir, ['novel/Deluvia Book 3/CHAPTER_34.summary.md:4', '--at', 'HEAD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /only applies to <book> <chapter> mode/);
});

check('non-integer <book>/<chapter> is a refusal, exit 2', () => {
  const r = run(fxRename.dir, ['three', '18', '--at', 'HEAD']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /must be integers/);
});

check('neither shape of positional args is a refusal, exit 2', () => {
  const r = run(fxRename.dir, ['3', '18', '19', '--at', 'HEAD']);
  assert.equal(r.status, 2);
});

check('a bad --at value on an otherwise-valid query is exit 1, not a crash', () => {
  const r = run(fxRename.dir, ['3', '18', '--at', 'not-a-real-ref']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /b7e-renum:/);
});

/* ===================================================================== *
 * wiring — the two registrations and the header grant, self-checked
 * ===================================================================== */

check('bin/b7e-renum is executable and declares exactly one @grant', () => {
  const st = fs.statSync(BIN);
  assert.ok(st.mode & 0o111, 'bin/b7e-renum should be executable');
  const src = fs.readFileSync(BIN, 'utf8');
  const grants = [...src.matchAll(/^[ \t]*(?:\*|\/\/)?[ \t]*@grant[ \t]+(\S+)[ \t]*$/gm)];
  assert.equal(grants.length, 1);
  assert.equal(grants[0][1], 'read');
});

check('package.json and package-lock.json both register b7e-renum at bin/b7e-renum', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-renum'], 'bin/b7e-renum');
  assert.equal(lock.packages?.['']?.bin?.['b7e-renum'], 'bin/b7e-renum');
});

// Only the fixtures this run itself created.
for (const entry of fs.existsSync(fixtureRoot()) ? fs.readdirSync(fixtureRoot()) : []) {
  if (entry.startsWith('b7erenum-')) fs.rmSync(path.join(fixtureRoot(), entry), { recursive: true, force: true });
}

console.log(failures ? `\n${failures}/${ran} failed\n` : `\n${ran}/${ran} passed\n`);
process.exit(failures ? 1 : 0);
