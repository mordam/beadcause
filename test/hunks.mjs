#!/usr/bin/env node
//
// b7e-hunks — every conflict hunk in the working tree, addressable, with both sides (bc-dgx7.78).
//
//   npm test
//   node test/hunks.mjs
//
// Real repos, real merges, real conflicts throughout — the failure this exists to close
// off (`git add` staging a file that still has markers in it, per bc-d2y6/dv-3rn.1) is
// exactly the kind of thing a fake filesystem would agree with itself about.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-hunks');

const hunks = await import(path.join(ROOT, 'lib', 'hunks.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-hunks-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A fresh repo, mid-merge, with a plain two-way conflict in `path` (default `a.js`). */
function conflictedRepo(name, { file = 'a.js', ourLines = ['MAIN'], theirLines = ['FEATURE'], diff3 = false } = {}) {
  const work = path.join(tmp, name);
  fs.mkdirSync(path.dirname(path.join(work, file)), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  if (diff3) git(work, 'config', 'merge.conflictstyle', 'diff3');
  fs.writeFileSync(path.join(work, file), 'before\nbase\nafter\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, file), `before\n${theirLines.join('\n')}\nafter\n`);
  git(work, 'commit', '-aqm', 'feature');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, file), `before\n${ourLines.join('\n')}\nafter\n`);
  git(work, 'commit', '-aqm', 'mainedit');
  try {
    git(work, 'merge', 'feature', '-q');
  } catch {
    // expected — conflict
  }
  return work;
}

/* ==================================================================== 1. lib/hunks.js */

console.log('\nparseHunks / conflictedFiles — the parsing\n');

{
  const work = conflictedRepo('lib-basic');
  const text = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  const found = hunks.parseHunks(text);
  check('one hunk found', found.length === 1);
  check('ours side is HEAD\'s content', found[0].oursLines.join('\n') === 'MAIN');
  check('theirs side is the merged branch\'s content', found[0].theirsLines.join('\n') === 'FEATURE');
  check('ours label names HEAD', found[0].oursLabel === 'HEAD');
  check('theirs label names the merged branch', found[0].theirsLabel === 'feature');
  check('no base section for a plain two-way conflict', found[0].baseLines === null);
  check('conflictedFiles reports exactly a.js', hunks.conflictedFiles(work).join(',') === 'a.js');
}

{
  const work = conflictedRepo('lib-diff3', { diff3: true, ourLines: ['MAIN'], theirLines: ['FEATURE'] });
  const text = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  const found = hunks.parseHunks(text);
  check('diff3 style still finds exactly one hunk', found.length === 1);
  check('diff3 base section is captured separately from ours/theirs', found[0].baseLines && found[0].baseLines.join('\n') === 'base');
}

{
  const work = path.join(tmp, 'lib-two-hunks-onefile');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  // git's merge needs enough unchanged context between two changed regions to treat them
  // as separate hunks — too little and it folds them into one conflict block.
  const mid = Array.from({ length: 10 }, (_, i) => `mid${i}`).join('\n');
  fs.writeFileSync(path.join(work, 'two.js'), `before\nbase\nafter\n${mid}\nmore\nbase2\ntail\n`);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'two.js'), `before\nFEATURE\nafter\n${mid}\nmore\nFEATURE2\ntail\n`);
  git(work, 'commit', '-aqm', 'feature2');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'two.js'), `before\nMAIN\nafter\n${mid}\nmore\nMAIN2\ntail\n`);
  git(work, 'commit', '-aqm', 'mainedit2');
  try {
    git(work, 'merge', 'feature', '-q');
  } catch {
    // expected
  }
  const { hunks: found } = hunks.hunksForFile(work, 'two.js');
  check('two separate hunks in one file are both found', found.length === 2);
  check('hunk ids are 1 and 2, in document order', found[0].index === 1 && found[1].index === 2);
  check('the second hunk starts after the first ends', found[1].startLine > found[0].endLine);
}

{
  const clean = path.join(tmp, 'lib-clean-plain');
  fs.mkdirSync(clean, { recursive: true });
  git(clean, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(clean, 'ok.js'), 'nothing to see\n');
  git(clean, 'add', '-A');
  git(clean, 'commit', '-q', '-m', 'first');
  check('a repo with nothing conflicted reports no conflicted files', hunks.conflictedFiles(clean).length === 0);
}

{
  check('parseId splits a well-formed id', (() => {
    const p = hunks.parseId('lib/deep/file.js#3');
    return p && p.file === 'lib/deep/file.js' && p.index === 3;
  })());
  check('parseId refuses a string with no #n suffix', hunks.parseId('lib/file.js') === null);
  check('parseId refuses a non-numeric suffix', hunks.parseId('lib/file.js#abc') === null);
}

{
  check('truncate leaves a short line untouched', hunks.truncate('short', 200) === 'short');
  check('truncate labels an empty/undefined line', hunks.truncate(undefined, 200) === '<empty>');
  check('truncate labels a genuinely blank line', hunks.truncate('', 200) === '<blank>');
  const long = 'x'.repeat(300);
  const t = hunks.truncate(long, 200);
  check('truncate cuts a long line to width plus a marker', t.startsWith('x'.repeat(200)) && t.includes('+100 chars'));
}

console.log('\ntakeHunks — all-or-nothing, one side at a time\n');

{
  const work = conflictedRepo('lib-take-basic');
  const result = hunks.takeHunks(work, [{ file: 'a.js', index: 1, side: 'ours' }]);
  check('takeHunks reports one applied edit', result.applied && result.applied.length === 1);
  const text = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  check('taking ours leaves the file with no markers and ours content', text === 'before\nMAIN\nafter\n');
}

{
  const work = conflictedRepo('lib-take-theirs');
  hunks.takeHunks(work, [{ file: 'a.js', index: 1, side: 'theirs' }]);
  const text = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  check('taking theirs leaves the file with theirs content', text === 'before\nFEATURE\nafter\n');
}

{
  const work = path.join(tmp, 'lib-take-two-hunks');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'two.js'), 'a\nb\nc\nd\ne\nf\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'two.js'), 'FEAT1\nb\nc\nd\ne\nFEAT2\n');
  git(work, 'commit', '-aqm', 'feature');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'two.js'), 'MAIN1\nb\nc\nd\ne\nMAIN2\n');
  git(work, 'commit', '-aqm', 'mainedit');
  try {
    git(work, 'merge', 'feature', '-q');
  } catch {
    // expected
  }
  const result = hunks.takeHunks(work, [
    { file: 'two.js', index: 1, side: 'ours' },
    { file: 'two.js', index: 2, side: 'theirs' },
  ]);
  check('both hunks in one file resolve in a single call', result.applied && result.applied.length === 2);
  const text = fs.readFileSync(path.join(work, 'two.js'), 'utf8');
  check('taking ours on #1 and theirs on #2 leaves the middle untouched', text === 'MAIN1\nb\nc\nd\ne\nFEAT2\n');
}

{
  const work = path.join(tmp, 'lib-take-leaves-other-untouched');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'two.js'), 'a\nb\nc\nd\ne\nf\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'two.js'), 'FEAT1\nb\nc\nd\ne\nFEAT2\n');
  git(work, 'commit', '-aqm', 'feature');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'two.js'), 'MAIN1\nb\nc\nd\ne\nMAIN2\n');
  git(work, 'commit', '-aqm', 'mainedit');
  try {
    git(work, 'merge', 'feature', '-q');
  } catch {
    // expected
  }
  hunks.takeHunks(work, [{ file: 'two.js', index: 1, side: 'ours' }]);
  const { hunks: remaining } = hunks.hunksForFile(work, 'two.js');
  check('taking hunk 1 alone leaves hunk 2 fully intact, markers and all', remaining.length === 1 && remaining[0].oursLines.join('\n') === 'MAIN2' && remaining[0].theirsLines.join('\n') === 'FEAT2');
}

{
  const work = conflictedRepo('lib-take-invalid');
  const before = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  const result = hunks.takeHunks(work, [
    { file: 'a.js', index: 1, side: 'ours' },
    { file: 'a.js', index: 99, side: 'ours' },
  ]);
  check('an invalid id in the batch returns an error', typeof result.error === 'string');
  const after = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  check('all-or-nothing: nothing is written when any id in the batch is bad', before === after);
}

console.log('\nstageFiles — refuses whatever still has a marker\n');

{
  const work = conflictedRepo('lib-stage-refuse');
  const { staged, refused } = hunks.stageFiles(work, hunks.conflictedFiles(work));
  check('a file that still has markers is refused, not staged', staged.length === 0 && refused.length === 1 && refused[0].file === 'a.js');
  const status = git(work, 'status', '--short');
  check('git status still shows the file unmerged after the refusal', status.includes('a.js'));
}

{
  const work = conflictedRepo('lib-stage-clean');
  hunks.takeHunks(work, [{ file: 'a.js', index: 1, side: 'ours' }]);
  const { staged, refused } = hunks.stageFiles(work, hunks.conflictedFiles(work));
  check('a file with markers resolved is staged cleanly', staged.length === 1 && refused.length === 0);
}

/* ==================================================================== 2. bin/b7e-hunks CLI */

console.log('\nbin/b7e-hunks — the argv shell\n');

function run(cwd, args) {
  return spawnSync('node', [BIN, ...args], { cwd, encoding: 'utf8' });
}

{
  const r = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
  check('--help exits 0 and prints usage', r.status === 0 && r.stdout.includes('b7e-hunks'));
}

{
  const notARepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-hunks-norepo-'));
  const r = run(notARepo, []);
  check('run against a directory that is not a git repository refuses (exit 2)', r.status === 2);
}

{
  const work = conflictedRepo('cli-listing');
  const r = run(work, []);
  check('listing with one open hunk exits 1', r.status === 1);
  check('the listing line names file, id, and line range', r.stdout.includes('a.js#1 L2-6'));
  check('the listing line shows both sides\' first line', r.stdout.includes('ours:MAIN') && r.stdout.includes('theirs:FEATURE'));
  check('the trailing line counts hunks and files', r.stdout.includes('1 hunk still open across 1 file'));
}

{
  // x.js gets two hunks (enough context between them to stay separate), y.js gets one —
  // x.js should outrank y.js in the listing by hunk count.
  const work = path.join(tmp, 'cli-ordering');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  const mid = Array.from({ length: 10 }, (_, i) => `mid${i}`).join('\n');
  fs.writeFileSync(path.join(work, 'x.js'), `head\nbase1\n${mid}\nbase2\ntail\n`);
  fs.writeFileSync(path.join(work, 'y.js'), 'y1\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'x.js'), `head\nfeat1\n${mid}\nfeat2\ntail\n`);
  fs.writeFileSync(path.join(work, 'y.js'), 'y-feature\n');
  git(work, 'commit', '-aqm', 'feature');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'x.js'), `head\nmain1\n${mid}\nmain2\ntail\n`);
  fs.writeFileSync(path.join(work, 'y.js'), 'y-main\n');
  git(work, 'commit', '-aqm', 'mainedit');
  try {
    git(work, 'merge', 'feature', '-q');
  } catch {
    // expected
  }
  const r = run(work, []);
  const lines = r.stdout.trim().split('\n');
  check('files are grouped and ordered by descending hunk count', lines[0].startsWith('x.js#1') && lines[1].startsWith('x.js#2') && lines[2].startsWith('y.js#1'));
}

{
  const work = conflictedRepo('cli-print');
  const r = run(work, ['a.js#1']);
  check('printing a hunk by id exits 1 (conflict still open) and shows both sides in full', r.status === 1 && r.stdout.includes('--- ours (HEAD) ---') && r.stdout.includes('MAIN') && r.stdout.includes('--- theirs (feature) ---') && r.stdout.includes('FEATURE'));
}

{
  const work = conflictedRepo('cli-print-missing');
  const r = run(work, ['a.js#7']);
  check('printing a hunk id that does not exist refuses (exit 2)', r.status === 2 && r.stderr.includes('a.js#7'));
}

{
  const work = conflictedRepo('cli-print-badshape');
  const r = run(work, ['a.js']);
  check('an id with no #n is refused before touching anything (exit 2)', r.status === 2 && r.stderr.includes('a.js'));
}

{
  const work = conflictedRepo('cli-take');
  const r = run(work, ['--take', 'ours', 'a.js#1']);
  check('--take prints what it replaced', r.stdout.includes('a.js#1 took ours'));
  check('--take exits 0 once nothing is left conflicted', r.status === 0);
  const text = fs.readFileSync(path.join(work, 'a.js'), 'utf8');
  check('the file on disk reflects the taken side, no markers', text === 'before\nMAIN\nafter\n');
}

{
  const work = conflictedRepo('cli-take-badside');
  const r = run(work, ['--take', 'nonsense', 'a.js#1']);
  check('--take with an unrecognised side is refused (exit 2)', r.status === 2);
}

{
  const work = conflictedRepo('cli-stage-refuses');
  const r = run(work, ['--stage']);
  check('--stage refuses a file that still contains a marker — the dv-3rn.1 failure', r.status === 1 && r.stdout.includes('refused a.js'));
  const status = git(work, 'status', '--short');
  check('the refused file was never staged', status.startsWith('UU'));
}

{
  const work = conflictedRepo('cli-stage-clean');
  run(work, ['--take', 'ours', 'a.js#1']);
  const r = run(work, ['--stage']);
  check('--stage stages a file with zero markers left, and exits 0', r.status === 0 && r.stdout.includes('staged a.js'));
}

{
  const work = conflictedRepo('cli-take-stage-conflict');
  const r = run(work, ['--stage', '--take', 'ours', 'a.js#1']);
  check('--stage and --take together are refused (exit 2)', r.status === 2);
}

{
  // The bead's own acceptance criterion: a wide single line must not blow up printing.
  const work = path.join(tmp, 'cli-wide-line');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'w.js'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'w.js'), `${'A'.repeat(4000)}\n`);
  git(work, 'commit', '-aqm', 'feature');
  git(work, 'checkout', '-q', 'main');
  fs.writeFileSync(path.join(work, 'w.js'), `${'B'.repeat(300)}\n`);
  git(work, 'commit', '-aqm', 'mainedit');
  try {
    git(work, 'merge', 'feature', '-q');
  } catch {
    // expected
  }
  const r = run(work, ['w.js#1']);
  const widest = Math.max(...r.stdout.split('\n').map((l) => l.length));
  check('a 4000-character hunk prints without any single line overflowing the width cap', r.status === 1 && widest < 300);
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
