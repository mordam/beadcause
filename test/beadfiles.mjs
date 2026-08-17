#!/usr/bin/env node
//
// The field a bead can actually carry: a `beadfiles` block in its description — bc-42ow.1.
//
//   npm test                      (runs it alongside the other suites)
//   node test/beadfiles.mjs       (on its own)
//
// lib/beadfiles.js shipped its consumer before its producer: `withoutClaimedFiles` in
// lib/advocate.js has been the sixth dispatch filter since bc-mp8c, and `declaredFiles`
// read `row.surface ?? row.files ?? row.fileSurface` — three property names that nothing
// anywhere writes, because a bead is a `bd` row and `bd` has no surface column. So the
// whole file-occupancy hold was inert on every bead in the tracker. This suite is the
// producer's half of the contract, and it asserts five things:
//
// 1. **A block in the description is a surface.** That is the field, and it is in the
//    description because `bd list --json` carries `description` on every row and carries
//    neither `notes` nor `design`.
// 2. **A missing, empty or unparseable block is not.** All three yield `[]`, which is the
//    same answer as a bead that never mentioned files — and a bead with no surface must
//    DISPATCH. A declaration is a forecast made before anyone read the code; a field that
//    could withhold work by being malformed would be worse than no field at all.
// 3. **The existing bounds apply to it.** MAX_FILES, the entry length, the NEVER regexp
//    and the dedupe are the same for the block as for the property names, because both
//    arrive through one normalizer and neither source may grow a bound of its own.
// 4. **The writer and the reader are the same implementation.** `withSurface` puts a
//    block in and `declaredFiles` reads it back, so the console path (bc-42ow.2) and the
//    plan path (bc-42ow.3) cannot invent a second spelling of the block.
// 5. **There is exactly one read path.** lib/beadfiles.js, and no lib/surface.js beside
//    it — the standing constraint of bc-42ow, and lib/prstage.js's argument: three
//    implementations of one question is how two screens come to disagree about it.
//
// Pure module reads. No temp directory, no `bd`, no git, nothing written anywhere.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (what, ok, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${what}${ok || !detail ? '' : ` — ${detail}`}`);
  if (!ok) failed += 1;
};
const same = (what, got, want) => check(what, JSON.stringify(got) === JSON.stringify(want), JSON.stringify(got));

const { declaredFiles, parseSurface, formatSurface, withSurface, withoutSurface, surfaceOf, occupiedBy } =
  await import('../lib/beadfiles.js');

const withBlock = (...lines) => ['Some prose about the work.', '', '```beadfiles', ...lines, '```', '', 'And more.'].join('\n');

/* ------------------------------------------------- 1. the block is the field */

console.log('\na beadfiles block in the description');

same(
  'a block in the description is a declared surface',
  declaredFiles({ description: withBlock('lib/advocate.js', 'lib/beadfiles.js') }),
  ['lib/advocate.js', 'lib/beadfiles.js']
);
check(
  'and it is read as DECLARED, not guessed — so it may hold work',
  surfaceOf({ description: withBlock('lib/advocate.js') }, []).source === 'declared'
);
same('`~~~` fences the same as ```', parseSurface('~~~beadfiles\nlib/a.js\n~~~'), ['lib/a.js']);
same('a comment line is not a path', parseSurface('```beadfiles\n# what we expect to touch\nlib/a.js\n```'), ['lib/a.js']);
same(
  'the four spellings of one path reduce to one',
  parseSurface('```beadfiles\nlib/a.js\n./lib/a.js\n/lib/a.js\nlib//a.js\n```'),
  ['lib/a.js']
);
same('a trailing slash says "everything under here"', parseSurface('```beadfiles\nlib/\n```'), ['lib/**']);
same('a glob survives, because YAML is exactly what this block is not', parseSurface('```beadfiles\n*.js\nlib/**\n```'), [
  '*.js',
  'lib/**',
]);
same('a block anywhere in the description is found, not only at the end', parseSurface('```beadfiles\nlib/a.js\n```\n\ntail'), [
  'lib/a.js',
]);
same('`body` is read too — what Bd.create calls a description before the bead exists', declaredFiles({ body: withBlock('lib/a.js') }), [
  'lib/a.js',
]);

/* --------------------------------------- 2. nobody said, and it must dispatch */

console.log('\nno surface, and every way of failing to have one');

same('a bead with no block declares nothing', declaredFiles({ description: 'Fix the thing in lib/advocate.js.' }), []);
same('an empty block declares nothing', declaredFiles({ description: '```beadfiles\n\n```' }), []);
same('a block of nothing but comments declares nothing', declaredFiles({ description: '```beadfiles\n# soon\n```' }), []);
same('an unclosed block declares nothing rather than swallowing the rest', declaredFiles({ description: '```beadfiles\nlib/a.js' }), []);
same('a block full of things that are not paths declares nothing', declaredFiles({ description: '```beadfiles\n..\n.\n/\n```' }), []);
same('a surface that climbs out of the checkout is dropped, not resolved', parseSurface('```beadfiles\n../other/a.js\nlib/a.js\n```'), [
  'lib/a.js',
]);
same('an empty row declares nothing', declaredFiles({}), []);
same('and neither does nothing at all', declaredFiles(null), []);
check(
  'a bead with no surface holds nothing, whoever is claiming what',
  occupiedBy(declaredFiles({ description: 'no block' }), [ROOT], [{ state: 'held', file: 'lib/advocate.js', repo: ROOT }]).length === 0
);

/* ------------------------------------------------ 3. the existing bounds hold */

console.log('\nthe bounds the property names already had');

const many = Array.from({ length: 40 }, (_, i) => `lib/f${i}.js`);
check('MAX_FILES caps the block at 24, dropping the overflow rather than the bead', parseSurface(formatSurface(many)).length === 24);
same('a duplicate is one entry', parseSurface('```beadfiles\nlib/a.js\nlib/a.js\n```'), ['lib/a.js']);
same(
  'NEVER applies to the block too',
  parseSurface('```beadfiles\nnode_modules/x/index.js\n.git/config\n.claude/worktrees/w/lib/a.js\nlib/a.js\n```'),
  ['lib/a.js']
);
same('an entry longer than 300 chars is dropped, not truncated into a path that matches something else', parseSurface(
  `\`\`\`beadfiles\nlib/${'x'.repeat(400)}.js\nlib/a.js\n\`\`\``
), ['lib/a.js']);

/* --------------------------- 4. the three property names, and who wins over whom */

console.log('\nthe legacy property names, kept as a fallback');

same('a property surface still reads, so the sixth filter keeps working', declaredFiles({ surface: ['lib/a.js'] }), ['lib/a.js']);
same('as a string, whitespace-separated, as test/claimqueue.mjs has always written it', declaredFiles({ surface: 'lib/a.js lib/b.js' }), [
  'lib/a.js',
  'lib/b.js',
]);
same(
  'a caller already holding a list wins over the block — it is the only one that can hold a surface for a bead that does not exist yet',
  declaredFiles({ files: ['lib/held.js'], description: withBlock('lib/written.js') }),
  ['lib/held.js']
);
same(
  'but an EMPTY list means "I am holding none", not "this bead has no surface"',
  declaredFiles({ files: [], description: withBlock('lib/written.js') }),
  ['lib/written.js']
);
same('an unrecognised shape yields nothing rather than throwing', declaredFiles({ surface: { lib: true } }), []);

/* ------------------------------------- 5. one implementation of the block format */

console.log('\none spelling of the block, and one read path');

const written = withSurface('The work, described.', ['lib/a.js', 'lib/b.js']);
same('what the writer writes, the reader reads back', declaredFiles({ description: written }), ['lib/a.js', 'lib/b.js']);
check('and the prose survives the trip', /The work, described\./.test(written));
same('a rewrite REPLACES the block rather than appending a second one that would lose to the first', declaredFiles({
  description: withSurface(written, ['lib/c.js']),
}), ['lib/c.js']);
check(
  'and rewriting does not grow a blank line every time',
  !/\n{3,}/.test(withSurface(withSurface(withSurface('Prose.', ['lib/a.js']), ['lib/b.js']), ['lib/c.js'])),
  JSON.stringify(withSurface(withSurface(withSurface('Prose.', ['lib/a.js']), ['lib/b.js']), ['lib/c.js']))
);
check('an empty surface withdraws the block and leaves the prose', withSurface(written, []) === 'The work, described.');
check('formatSurface says nothing when there is nothing to say', formatSurface([]) === '' && formatSurface(null) === '');
check('withoutSurface is what a card shows above the machinery', withoutSurface(written) === 'The work, described.');
check('and it leaves a description that never had a block alone', withoutSurface('Just prose.') === 'Just prose.');

// Comment lines are dropped before the search, and that is not tidiness: every file here
// argues in prose about the identifiers around it, so a module that merely *documents* the
// block would otherwise read as a module that implements it — the wrong answer, not noise.
// See the same trap in public/editmode.js's blankJs.
const code = (src) =>
  src
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\/?\*)/.test(l))
    .join('\n');
const fence = ['`', '`', '`', 'beadfiles'].join('');
const spellings = [];
for (const dir of ['lib', 'bin']) {
  for (const name of fs.readdirSync(path.join(ROOT, dir))) {
    if (!name.endsWith('.js')) continue;
    if (code(fs.readFileSync(path.join(ROOT, dir, name), 'utf8')).includes(fence)) spellings.push(`${dir}/${name}`);
  }
}
same(
  `only lib/beadfiles.js spells the fence in code — everything else calls formatSurface/withSurface for it`,
  spellings,
  ['lib/beadfiles.js']
);
check(
  'and there is no lib/surface.js beside it — bc-42ow says one read path, or nothing',
  !fs.existsSync(path.join(ROOT, 'lib', 'surface.js'))
);

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
