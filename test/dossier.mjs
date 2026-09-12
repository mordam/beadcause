#!/usr/bin/env node
/**
 * `b7e-dossier` — every canon assertion about one named thing, with its source line.
 * lib/dossier.js and bin/b7e-dossier.
 *
 *   npm test
 *   node test/dossier.mjs
 *
 * The fixture is bc-dgx7.101's own corpus in miniature, and every shape in it is one a
 * real deluvia session hit:
 *
 *  - a canon file stating an age in digits (`173 years old`, the
 *    `reference/CHARACTER_CONCURRENCY.md:54` shape) against a drafted chapter stating a
 *    different one in words (`forty-three years old`, the `CHAPTER_5.propagated.md`
 *    shape). That pair is the finding `dv-gr6.5` got by luck, and it only works if the
 *    reader understands both spellings.
 *  - a species section whose heading names the subject and whose height bullet does not —
 *    the `### §8 — Othens` / `- Height:` shape no grep for the name would ever return.
 *  - two incompatible height ranges (`15'–25'` against `12'0"–15'0"`) plus a point value
 *    inside one of them (`~15'`), because a point inside a range must NOT be reported as
 *    a contradiction.
 *  - a chapter-number possessive (`Ch. 33's`), which reads as 33 feet to any regexp that
 *    does not guard against it — measured on the real corpus, where it produced fifteen
 *    fictitious heights for one character.
 *  - a run of labelled prose (`emotional arc:` and friends), which is what a chapter
 *    summary is made of and which must not become a field.
 *
 * The `--at` half builds a real git repo and rewrites the age between two commits, so the
 * ref read is exercised against the same thing the working-tree read sees.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
import {
  wordsToNumber,
  numberBefore,
  globToRegExp,
  orderFiles,
  fieldsIn,
  labelledFields,
  nameMatcher,
  scanFile,
  fieldSummary,
  disagreements,
  sourcesFor,
  DEFAULT_SOURCES,
} from '../lib/dossier.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-dossier');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dossier-'));
process.on('exit', () => removeTreeSync(tmp));

/* ------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
};

/* ------------------------------------------------------------------- fixture */

const CONCURRENCY = `# Character concurrency

## Book 3 cast

**Korgath** (Kazran Orve Warlord, 173 years old) — runs Pontus Forge.
**Sven** (his son) — an adult at the impact.
`;

const SPECIES = `# Species guide

### §8 — Othens
*Megatherium giganteus*

- Height: 12'0"–15'0" when upright, both sexes; the largest reach ~15'
- Build: immense, broad, deep-barreled

### §8A — Sloth-hen
Sister people to the Othens. §8 used to give the Othens as 15'–25' upright, which
would have made them far larger than the Sloth-hen.
`;

const CHAPTER = `# Chapter 5

He was forty-three years old and had been running this forge for eleven of them. Korgath had doubled it again, added the rolling racks and the covered waystation. That is Ch. 33's chapter, not this one.

emotional arc: Korgath moves from routine administrative focus to physical alarm as
the earthquake tremor arrives, and then to the cold arithmetic of the sealing order.
writing notes: Lean hard on the established Korgath voice — smith-and-strategist
interiority, ledger-and-tonnage nouns, no lyricism he would not use himself.
`;

const UNRELATED = `# Trade routes

Tin caravans arrive in storm. Nothing here names anybody.
`;

const CORPUS = {
  'reference/CHARACTER_CONCURRENCY.md': CONCURRENCY,
  'reference/SPECIES_GUIDE.md': SPECIES,
  'novel/CHAPTER_5.propagated.md': CHAPTER,
  'docs/TRADE.md': UNRELATED,
};

const REPO = path.join(tmp, 'repo');
for (const [rel, text] of Object.entries(CORPUS)) {
  fs.mkdirSync(path.join(REPO, path.dirname(rel)), { recursive: true });
  fs.writeFileSync(path.join(REPO, rel), text);
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 'test@localhost');
git(REPO, 'config', 'user.name', 'test');
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'the corpus with the contradiction still in it');
const BEFORE_FIX = git(REPO, 'rev-parse', 'HEAD');
// The fix dv-gr6.5 went on to make: the chapter is brought in line with canon. After it,
// the working tree has no disagreement at all — which is exactly why `--at` exists.
fs.writeFileSync(
  path.join(REPO, 'novel/CHAPTER_5.propagated.md'),
  CHAPTER.replace('forty-three years old', 'a hundred and seventy-three years old')
);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'canon: Korgath is 173, not 43');

/* -------------------------------------------------------------------- config */

const CONFIG_DIR = fs.mkdtempSync(path.join(tmp, 'config-'));
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify(
    {
      // `sessionDirs` is what points a workspace at a checkout — `dir` is where its
      // tracker lives, and lib/session.js resolves the two separately.
      workspaces: [{ name: 'dossier-ws', dir: path.join(tmp, 'tracker') }],
      sessionDirs: { 'dossier-ws': REPO },
      dossier: {
        sourcesPerWorkspace: {
          'dossier-ws': {
            default: ['reference/**/*.md', 'docs/**/*.md', 'novel/**/*.md'],
            species: ['reference/SPECIES_GUIDE.md'],
          },
        },
      },
    },
    null,
    2
  )
);
fs.mkdirSync(path.join(tmp, 'tracker', '.beads'), { recursive: true });

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const asJson = (args) => {
  const { status, stdout, stderr } = run([...args, '--json']);
  assert.ok(stdout.trim(), `no stdout (status ${status}): ${stderr}`);
  return { status, ...JSON.parse(stdout) };
};

/* ------------------------------------------------------------------- numbers */

console.log('\nnumbers, in both spellings');

check('wordsToNumber reads a compound word-run', () => {
  assert.equal(wordsToNumber('forty three'), 43);
  assert.equal(wordsToNumber('forty-three'), 43);
  assert.equal(wordsToNumber('a hundred and seventy three'), 173);
  assert.equal(wordsToNumber('two thousand and twelve'), 2012);
  assert.equal(wordsToNumber('nothing at all'), null);
});

check('numberBefore takes the longest run, not the last word', () => {
  assert.equal(numberBefore('He was a hundred and seventy-three'), 173);
  assert.equal(numberBefore('He was forty-three'), 43);
  assert.equal(numberBefore('aged 173'), 173);
  assert.equal(numberBefore('the warlord is'), null);
});

check('an age is read out of prose in either spelling', () => {
  const digits = fieldsIn('**Korgath** (Kazran Orve Warlord, 173 years old)');
  assert.deepEqual(digits.filter((f) => f.field === 'age').map((f) => f.value), ['173 years']);
  const words = fieldsIn('He was forty-three years old and had been running this forge.');
  assert.deepEqual(words.filter((f) => f.field === 'age').map((f) => f.value), ['43 years']);
});

/* -------------------------------------------------------------------- fields */

console.log('\nwhat a line asserts');

check('two spellings of one height normalise to the same value', () => {
  const a = fieldsIn("- Height: 12'0\"–15'0\" when upright").filter((f) => f.field === 'height');
  const b = fieldsIn('The Othens stand 12–15 ft upright').filter((f) => f.field === 'height');
  assert.ok(a.some((f) => f.value === '12-15 ft'), JSON.stringify(a));
  assert.ok(b.some((f) => f.value === '12-15 ft'), JSON.stringify(b));
});

check("a chapter-number possessive is not a height — Ch. 33's is not 33 feet", () => {
  const fields = fieldsIn("That is Ch. 33's chapter. This one is only the strike.");
  assert.deepEqual(fields.filter((f) => f.field === 'height'), []);
});

check('a bare feet mark still counts where the line is about size', () => {
  const fields = fieldsIn("the largest individuals reach ~15' (Lady Athira)");
  assert.ok(fields.some((f) => f.field === 'height' && f.value === '15 ft'), JSON.stringify(fields));
});

check('a labelled field is short and unpunctuated, or it is prose', () => {
  assert.deepEqual(labelledFields('POV: Korgath (Kazran Orve warlord)'), [
    { field: 'pov', value: 'Korgath (Kazran Orve warlord)', labelled: true },
  ]);
  // The shape every chapter summary in the real corpus is made of.
  assert.deepEqual(labelledFields('emotional arc: Korgath moves from routine focus to alarm. Then to arithmetic.'), []);
  // Mid-sentence punctuation is punctuation, not a field.
  assert.deepEqual(labelledFields('He said: nothing at all'), []);
});

check('a label that duplicates a reader field defers to the reader', () => {
  const fields = fieldsIn('Age: 173 years old');
  assert.deepEqual(fields.map((f) => `${f.field}=${f.value}`), ['age=173 years']);
});

/* --------------------------------------------------------------- names, globs */

console.log('\nnames and the source order');

check('a name matcher is plural-tolerant and escapes what it is given', () => {
  const m = nameMatcher(['Othen']);
  assert.ok(m.test('the Othens are the tallest'));
  assert.ok(m.test("an Othen's quarry"));
  assert.ok(!m.test('Othenwald'));
  // dv-5eu.1.3 lost two calls to grep refusing this; a regexp must not throw on it.
  assert.doesNotThrow(() => nameMatcher(['Korgath (Iron-Voice)']).test('x'));
});

check('globs order the corpus, and no file is listed twice', () => {
  const files = ['novel/a.md', 'reference/b.md', 'docs/c.md', 'reference/deep/d.md', 'top.md'];
  assert.deepEqual(orderFiles(files, ['reference/**/*.md', '**/*.md']), [
    'reference/b.md',
    'reference/deep/d.md',
    'docs/c.md',
    'novel/a.md',
    'top.md',
  ]);
});

check('** may match nothing at all, so **/*.md reaches a top-level file', () => {
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('**/*.md').test('a/b/c.md'));
  assert.ok(!globToRegExp('reference/*.md').test('reference/deep/d.md'));
});

check('sourcesFor falls through workspace, kind and default in that order', () => {
  const cfg = { dossier: { sources: ['x/*.md'], sourcesPerWorkspace: { w: { default: ['d/*.md'], place: ['p/*.md'] } } } };
  assert.deepEqual(sourcesFor(cfg, 'w', 'place'), ['p/*.md']);
  assert.deepEqual(sourcesFor(cfg, 'w', 'nosuchkind'), ['d/*.md']);
  assert.deepEqual(sourcesFor(cfg, 'other', 'place'), ['x/*.md']);
  assert.deepEqual(sourcesFor({}, 'w'), DEFAULT_SOURCES);
  // A workspace may name a bare list instead of a per-kind object.
  assert.deepEqual(sourcesFor({ dossier: { sourcesPerWorkspace: { w: ['a/*.md'] } } }, 'w', 'place'), ['a/*.md']);
});

/* ------------------------------------------------------------------ the scan */

console.log('\nthe scan');

check('a field bullet under a heading that names the subject is a hit', () => {
  const hits = scanFile('reference/SPECIES_GUIDE.md', SPECIES, nameMatcher(['Othen']));
  const bullet = hits.find((h) => h.text.startsWith('- Height:'));
  assert.ok(bullet, `no height bullet in ${JSON.stringify(hits.map((h) => h.text))}`);
  assert.equal(bullet.via, 'section');
  assert.equal(bullet.heading, '§8 — Othens');
});

check('a line under that heading that asserts nothing is not a hit', () => {
  const hits = scanFile('reference/SPECIES_GUIDE.md', SPECIES, nameMatcher(['Othen']));
  assert.ok(!hits.some((h) => h.text.startsWith('*Megatherium giganteus*')));
});

check('a point value inside a range is not a disagreement', () => {
  const summary = fieldSummary([
    { file: 'a.md', line: 1, text: 'x', fields: [{ field: 'height', value: '12-15 ft', lo: 12, hi: 15, unit: 'ft' }] },
    { file: 'b.md', line: 2, text: 'y', fields: [{ field: 'height', value: '15 ft', lo: 15, hi: 15, unit: 'ft' }] },
  ]);
  assert.deepEqual(disagreements(summary), []);
});

check('two overlapping-but-incompatible ranges are a disagreement', () => {
  const summary = fieldSummary([
    { file: 'a.md', line: 1, text: 'x', fields: [{ field: 'height', value: '12-15 ft', lo: 12, hi: 15, unit: 'ft' }] },
    { file: 'b.md', line: 2, text: 'y', fields: [{ field: 'height', value: '15-25 ft', lo: 15, hi: 25, unit: 'ft' }] },
  ]);
  assert.deepEqual(disagreements(summary).map((d) => d.field), ['height']);
});

check('twenty distinct paragraphs of one label are not twenty contradictions', () => {
  const hits = Array.from({ length: 20 }, (_, i) => ({
    file: `ch${i}.md`,
    line: 1,
    text: 'x',
    fields: [{ field: 'arc', value: `a distinct sentence number ${i} about the character`, labelled: true }],
  }));
  assert.deepEqual(disagreements(fieldSummary(hits)), []);
});

check('a labelled field only one file writes does not become a summary row', () => {
  const summary = fieldSummary([
    { file: 'a.md', line: 1, text: 'x', fields: [{ field: 'pov', value: 'Korgath', labelled: true }] },
    { file: 'b.md', line: 2, text: 'y', fields: [{ field: 'age', value: '173 years', lo: 173, hi: 173, unit: 'years' }] },
    { file: 'c.md', line: 3, text: 'z', fields: [{ field: 'age', value: '43 years', lo: 43, hi: 43, unit: 'years' }] },
  ]);
  assert.deepEqual(summary.map((s) => s.field), ['age']);
});

/* --------------------------------------------------------------------- the CLI */

console.log('\nthe command');

check('a name canon and a draft disagree about is reported as a DISAGREES row', () => {
  const out = asJson(['-w', 'dossier-ws', '--at', BEFORE_FIX, 'Korgath']);
  assert.equal(out.status, 0);
  const age = out.disagrees.find((d) => d.field === 'age');
  assert.ok(age, `no age disagreement in ${JSON.stringify(out.disagrees.map((d) => d.field))}`);
  assert.deepEqual(age.values.map((v) => v.value).sort(), ['173 years', '43 years']);
  const files = age.values.flatMap((v) => v.sources.map((s) => `${s.file}:${s.line}`));
  assert.ok(files.some((f) => f.startsWith('reference/CHARACTER_CONCURRENCY.md:')), files.join(' '));
  assert.ok(files.some((f) => f.startsWith('novel/CHAPTER_5.propagated.md:')), files.join(' '));
});

check('and the working tree, where the fix has landed, no longer disagrees', () => {
  const out = asJson(['-w', 'dossier-ws', 'Korgath']);
  assert.equal(out.status, 0);
  assert.deepEqual(out.disagrees.filter((d) => d.field === 'age'), []);
  const age = out.fields.find((f) => f.field === 'age');
  assert.deepEqual(age.values.map((v) => v.value), ['173 years']);
});

check('blocks come back in the configured glob order, not alphabetically', () => {
  const out = asJson(['-w', 'dossier-ws', '--at', BEFORE_FIX, 'Korgath']);
  assert.deepEqual(out.blocks.map((b) => b.file), ['reference/CHARACTER_CONCURRENCY.md', 'novel/CHAPTER_5.propagated.md']);
});

check('--kind slices the source set down to that shelf', () => {
  const out = asJson(['-w', 'dossier-ws', '--kind', 'species', 'Othen']);
  assert.deepEqual(out.blocks.map((b) => b.file), ['reference/SPECIES_GUIDE.md']);
  assert.deepEqual(out.sources, ['reference/SPECIES_GUIDE.md']);
});

check('two incompatible height ranges for a species are found across one file', () => {
  const out = asJson(['-w', 'dossier-ws', '--kind', 'species', 'Othen']);
  const height = out.fields.find((f) => f.field === 'height');
  const values = height.values.map((v) => v.value);
  assert.ok(values.includes('12-15 ft'), values.join(' '));
  assert.ok(values.includes('15-25 ft'), values.join(' '));
  assert.deepEqual(out.disagrees.map((d) => d.field), ['height']);
});

check('a name nothing asserts anything about exits 1 and says so in one line', () => {
  const { status, stdout, stderr } = run(['-w', 'dossier-ws', 'Zzyzxqq']);
  assert.equal(status, 1);
  assert.equal(stdout, '');
  assert.equal(stderr.trim().split('\n').length, 1);
  assert.match(stderr, /nothing in .* names Zzyzxqq/);
});

check('--dir reads a checkout no workspace names', () => {
  const { status, stdout } = run(['--dir', REPO, 'Korgath']);
  assert.equal(status, 0);
  assert.match(stdout, /CHARACTER_CONCURRENCY\.md/);
});

check('no name, no workspace and an unknown flag are each refused with 2', () => {
  assert.equal(run(['-w', 'dossier-ws']).status, 2);
  assert.equal(run(['Korgath']).status, 2);
  assert.equal(run(['-w', 'dossier-ws', '--nosuchflag', 'Korgath']).status, 2);
});

check('an unknown workspace exits 4 and lists the ones there are', () => {
  const { status, stderr } = run(['-w', 'nosuchws', 'Korgath']);
  assert.equal(status, 4);
  assert.match(stderr, /dossier-ws/);
});

check('an --at ref that does not resolve exits 5 rather than looking empty', () => {
  const { status, stderr } = run(['-w', 'dossier-ws', '--at', 'no-such-ref-at-all', 'Korgath']);
  assert.equal(status, 5);
  assert.match(stderr, /could not read/);
});

check('--help prints usage and exits 0 without searching anything', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-dossier/);
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
