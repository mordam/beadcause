#!/usr/bin/env node
//
// b7e-show — read a file as it is at another ref, without inventing a redirect (bc-dgx7.72).
//
//   npm test
//   node test/show.mjs
//
// A real repo, real commits, a real `git show` throughout — the failure this command
// exists to close off (a redirect that writes nothing, indistinguishable from a `grep`
// that finds nothing) is exactly the kind of thing a fake filesystem would agree with
// itself about and tell you nothing real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-show');

const show = await import(path.join(ROOT, 'lib', 'show.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-show-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A real repo with two commits, a nested path, and a binary file that would corrupt under utf8. */
function makeRepo(name) {
  const work = path.join(tmp, name);
  fs.mkdirSync(path.join(work, 'nested'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'lib.txt'), 'one\n');
  fs.writeFileSync(path.join(work, 'nested', 'deep.txt'), 'nested one\n');
  fs.writeFileSync(path.join(work, 'bin.dat'), Buffer.from([0, 1, 2, 254, 255, 0, 128]));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  const first = git(work, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(work, 'lib.txt'), 'two\n');
  fs.rmSync(path.join(work, 'bin.dat'));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'second — drops bin.dat, changes lib.txt');
  const second = git(work, 'rev-parse', 'HEAD').trim();
  return { work, first, second };
}

/* ==================================================================== 1. lib/show.js */

console.log('\nresolveRef / materialise — the git plumbing\n');

{
  const { work, first, second } = makeRepo('lib-basic');

  check('resolveRef resolves a real ref', (await show.resolveRef(work, first)) === first);
  check('resolveRef resolves HEAD', (await show.resolveRef(work, 'HEAD')) === second);
  check('resolveRef returns null for a ref that does not exist', (await show.resolveRef(work, 'nope-not-a-ref')) === null);

  const { hits, misses } = await show.materialise(work, first, ['lib.txt', 'nested/deep.txt', 'nope.txt']);
  check('one hit per path that existed at the ref', hits.length === 2);
  check('one miss for the path absent at the ref', misses.length === 1 && misses[0].path === 'nope.txt' && !misses[0].unsafe);
  const libHit = hits.find((h) => h.path === 'lib.txt');
  check('the materialised content is the ref\'s, not the working tree\'s', fs.readFileSync(libHit.file, 'utf8') === 'one\n');
  const nestedHit = hits.find((h) => h.path === 'nested/deep.txt');
  check('a nested path is materialised under its own subdirectory', fs.readFileSync(nestedHit.file, 'utf8') === 'nested one\n');
  check(
    'the materialised copy byte-matches `git show <ref>:<path>` directly',
    Buffer.compare(fs.readFileSync(libHit.file), Buffer.from(git(work, 'show', `${first}:lib.txt`))) === 0
  );
  check('no file is written for the path that was absent', !fs.existsSync(path.join(path.dirname(libHit.file), 'nope.txt')));
}

{
  const { work, first } = makeRepo('lib-binary');
  const { hits } = await show.materialise(work, first, ['bin.dat']);
  const expected = execFileSync('git', ['show', `${first}:bin.dat`], { cwd: work, encoding: 'buffer' });
  check('a binary file materialises byte-for-byte, not corrupted by a utf8 read', Buffer.compare(fs.readFileSync(hits[0].file), expected) === 0);
}

{
  const { work, first } = makeRepo('lib-all-absent');
  const { hits, misses } = await show.materialise(work, first, ['nope-one.txt', 'nope-two.txt']);
  check('every path absent means no hits', hits.length === 0);
  check('every path absent means every one is reported as a miss', misses.length === 2);
}

{
  const { work, first } = makeRepo('lib-escape');
  const { hits, misses } = await show.materialise(work, first, ['../../etc/passwd']);
  check('a path that climbs out of the repo is refused, not resolved', hits.length === 0 && misses.length === 1 && misses[0].unsafe === true);
}

{
  const { work, first, second } = makeRepo('lib-diff');
  const out = await show.diffAgainstRef(work, first, ['lib.txt']);
  check('diffAgainstRef reports the change between the ref and the working tree', out.includes('-one') && out.includes('+two'));
}

/* ==================================================================== 2. bin/b7e-show CLI */

console.log('\nbin/b7e-show — the argv shell\n');

{
  const { work, first } = makeRepo('cli-basic');
  const r = spawnSync('node', [BIN, first, 'lib.txt', 'nope.txt', '--dir', work], { encoding: 'utf8' });
  check('a mix of present and absent paths exits 1', r.status === 1);
  const hitLine = r.stdout.trim().split('\n').find((l) => l.includes('lib.txt'));
  check('the present path\'s line names the ref, the repo-relative path, and an openable absolute path', (() => {
    if (!hitLine) return false;
    const [ref, p, file] = hitLine.split(' ');
    return ref === first && p === 'lib.txt' && fs.existsSync(file) && fs.readFileSync(file, 'utf8') === 'one\n';
  })());
  check('the absent path is named on stderr', r.stderr.includes('nope.txt'));
}

{
  const { work, first } = makeRepo('cli-json');
  const r = spawnSync('node', [BIN, first, 'lib.txt', 'nope.txt', '--dir', work, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(r.stdout);
  check('--json prints a parseable {hits, misses}', parsed.hits.length === 1 && parsed.misses.length === 1);
}

{
  const { work, first } = makeRepo('cli-badref');
  const before = fs.existsSync(show.showTreeRoot()) ? fs.readdirSync(show.showTreeRoot()).length : 0;
  const r = spawnSync('node', [BIN, 'not-a-real-ref', 'lib.txt', '--dir', work], { encoding: 'utf8' });
  check('a ref that does not resolve exits 2', r.status === 2);
  const after = fs.existsSync(show.showTreeRoot()) ? fs.readdirSync(show.showTreeRoot()).length : 0;
  check('and leaves no new scratch directory behind', after === before);
}

{
  const notARepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-show-norepo-'));
  const r = spawnSync('node', [BIN, 'HEAD', 'lib.txt', '--dir', notARepo], { encoding: 'utf8' });
  check('run against a directory that is not a git repository refuses (exit 2)', r.status === 2);
}

{
  const r = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
  check('--help exits 0 and prints usage', r.status === 0 && r.stdout.includes('b7e-show'));
}

{
  const { work, first, second } = makeRepo('cli-diff');
  const r = spawnSync('node', [BIN, first, 'lib.txt', '--dir', work, '--diff'], { encoding: 'utf8' });
  check('--diff prints a unified diff against the working tree and exits 0', r.status === 0 && r.stdout.includes('+two') && r.stdout.includes('-one'));
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
