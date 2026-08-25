#!/usr/bin/env node
//
// b7e-at — a runnable copy of this repo at any commit, taken away afterwards (bc-dgx7.63).
//
//   npm test
//   node test/at.mjs
//
// Real `git worktree add` against a real repo throughout, the same argument
// test/blame.mjs and test/b7eworktree.mjs make for their own worktree-building
// siblings: worktree semantics — a detached checkout sharing objects with its source,
// a scratch registry that survives the process that wrote it — are exactly the thing a
// fake filesystem would agree with itself about and tell you nothing real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-at');

const at = await import(path.join(ROOT, 'lib', 'at.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-at-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A real repo with two commits and a real `node_modules`, so the symlink has something to point at. */
function makeRepo(name) {
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n');
  fs.mkdirSync(path.join(work, 'test'), { recursive: true });
  fs.writeFileSync(path.join(work, 'lib.txt'), 'one\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'first');
  const first = git(work, 'rev-parse', 'HEAD').trim();
  fs.writeFileSync(path.join(work, 'lib.txt'), 'two\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'second');
  const second = git(work, 'rev-parse', 'HEAD').trim();
  fs.mkdirSync(path.join(work, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(work, 'node_modules', 'dummy.txt'), 'x\n');
  return { work, first, second };
}

const worktreeCount = (dir) => execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length;

/* ==================================================================== 1. lib/at.js */

console.log("\nmakeAtWorktree/removeAtWorktree — a detached tree at any ref\n");

{
  const { work, first } = makeRepo('basic');
  const before = worktreeCount(work);
  const built = at.makeAtWorktree(work, first, { vendor: false });
  check('the tree is checked out at the ref it was asked for', built.sha === first, `${built.sha} !== ${first}`);
  check('the file content matches that commit, not the tip', fs.readFileSync(path.join(built.dir, 'lib.txt'), 'utf8') === 'one\n');
  check('node_modules is a symlink to the source repo\'s own', fs.lstatSync(path.join(built.dir, 'node_modules')).isSymbolicLink());
  check('a real git worktree was registered', worktreeCount(work) === before + 1);
  check('a meta.json sidecar was written, naming root/ref/sha', (() => {
    const meta = JSON.parse(fs.readFileSync(path.join(built.scratchRoot, 'meta.json'), 'utf8'));
    return meta.root === work && meta.ref === first && meta.sha === first;
  })());
  at.removeAtWorktree(work, built.dir, built.scratchRoot);
  check('removeAtWorktree deregisters the worktree', worktreeCount(work) === before);
  check('removeAtWorktree deletes the scratch directory (and its meta.json)', !fs.existsSync(built.scratchRoot));
}

{
  const { work, second } = makeRepo('vendor-missing');
  const built = at.makeAtWorktree(work, second, { vendor: true });
  check('vendor:true with no scripts/vendor.js in the tree still returns a usable tree', fs.existsSync(built.dir));
  const meta = JSON.parse(fs.readFileSync(path.join(built.scratchRoot, 'meta.json'), 'utf8'));
  check('and records that nothing was vendored', meta.vendored === false);
  at.removeAtWorktree(work, built.dir, built.scratchRoot);
}

{
  const { work } = makeRepo('badref');
  const before = worktreeCount(work);
  assert.throws(() => at.makeAtWorktree(work, 'not-a-real-ref', { vendor: false }));
  check('a bad ref throws and registers nothing', worktreeCount(work) === before);
  check('and no scratch directory is left behind', at.liveTrees().every((t) => t.root !== work));
}

console.log('\nliveTrees/reapTree — the registry a killed process cannot clean up itself\n');

{
  const { work, first, second } = makeRepo('registry');
  const before = worktreeCount(work);
  at.makeAtWorktree(work, first, { vendor: false });
  at.makeAtWorktree(work, second, { vendor: false });
  const mine = at.liveTrees().filter((t) => t.root === work);
  check('both trees show up in liveTrees()', mine.length === 2);
  check('each entry names its own ref and sha', mine.some((t) => t.sha === first) && mine.some((t) => t.sha === second));
  check('and both are real git worktree registrations', worktreeCount(work) === before + 2);
  at.reapTree(mine.find((t) => t.sha === first));
  check('reapTree removes exactly the one it was given', at.liveTrees().filter((t) => t.root === work).length === 1);
  at.reapTree(at.liveTrees().find((t) => t.root === work));
  check('reaping the rest empties it out', at.liveTrees().every((t) => t.root !== work));
  check('and the git worktree registrations are gone too', worktreeCount(work) === before);
}

{
  // A scratch directory with no meta.json (a crash between mkdtemp and the write) is
  // still visible and still reapable — nothing here is invisible for want of a sidecar.
  const base = at.atTreeRoot();
  fs.mkdirSync(base, { recursive: true });
  const orphan = fs.mkdtempSync(path.join(base, 'tree-'));
  const found = at.liveTrees().find((t) => t.scratchRoot === orphan);
  check('an entry with no meta.json is still reported, fields null', Boolean(found) && found.root === null && found.ref === null);
  at.reapTree(found);
  check('reapTree with no recorded root still deletes the scratch directory', !fs.existsSync(orphan));
}

/* ======================================================================= 2. the CLI */

console.log('\nbin/b7e-at — argv, exit codes, teardown\n');

{
  const r = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
  check('--help exits 0 and prints usage', r.status === 0 && r.stdout.includes('b7e-at <ref>'));
}

{
  const r = spawnSync('node', [BIN, 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  check('a ref with no command and no --keep is refused', r.status === 2 && /--keep/.test(r.stderr));
}

{
  const r = spawnSync('node', [BIN], { cwd: ROOT, encoding: 'utf8' });
  check('no ref at all is refused', r.status === 2);
}

{
  const { work, first } = makeRepo('cli-run');
  const before = worktreeCount(work);
  const r = spawnSync('node', [BIN, first, '--dir', work, '--', 'cat', 'lib.txt'], { encoding: 'utf8' });
  check('the command runs against the file as it was at that ref', r.stdout === 'one\n');
  check('the command\'s own exit code is passed through', r.status === 0);
  check('the tree is gone again afterward', worktreeCount(work) === before);
}

{
  const { work, second } = makeRepo('cli-nonzero');
  const before = worktreeCount(work);
  const r = spawnSync('node', [BIN, second, '--dir', work, '--', 'node', '-e', 'process.exit(7)'], { encoding: 'utf8' });
  check('a nonzero exit from the command is passed through', r.status === 7);
  check('the tree is torn down even on a nonzero exit', worktreeCount(work) === before);
}

{
  const { work, first } = makeRepo('cli-killed');
  const before = worktreeCount(work);
  const r = spawnSync('node', [BIN, first, '--dir', work, '--', 'node', '-e', "process.kill(process.pid,'SIGTERM')"], {
    encoding: 'utf8',
  });
  check('a command that kills itself is reported as killed, not silently 0', r.status !== 0);
  check('the tree is torn down even when the command was killed', worktreeCount(work) === before);
}

{
  const { work, first } = makeRepo('cli-keep');
  const before = worktreeCount(work);
  const r = spawnSync('node', [BIN, first, '--dir', work, '--keep'], { encoding: 'utf8' });
  const dir = r.stdout.trim();
  check('--keep with no command prints the tree\'s path on stdout', r.status === 0 && fs.existsSync(dir));
  check('and leaves the worktree registered', worktreeCount(work) === before + 1);
  const listed = spawnSync('node', [BIN, '--list'], { encoding: 'utf8' });
  check('--list shows the kept tree', listed.stdout.includes(dir));
  const reaped = spawnSync('node', [BIN, '--reap'], { encoding: 'utf8' });
  check('--reap tears it down', reaped.status === 0 && worktreeCount(work) === before);
  const listedAfter = spawnSync('node', [BIN, '--list'], { encoding: 'utf8' });
  check('--list shows nothing once every tree is reaped', listedAfter.stdout === '');
}

{
  const { work } = makeRepo('cli-badref');
  const r = spawnSync('node', [BIN, 'not-a-real-ref', '--dir', work, '--', 'echo', 'hi'], { encoding: 'utf8' });
  check('a ref that does not resolve exits 3', r.status === 3);
}

{
  const notARepo = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-at-norepo-'));
  const r = spawnSync('node', [BIN, 'HEAD', '--dir', notARepo, '--keep'], { encoding: 'utf8' });
  check('run against a directory that is not a git repository refuses (exit 2)', r.status === 2);
}

console.log('\nlib/blame.js — the lift did not change what it exports\n');

{
  const blame = await import(path.join(ROOT, 'lib', 'blame.js'));
  check('makeMainWorktree is still exported', typeof blame.makeMainWorktree === 'function');
  check('removeMainWorktree is still exported', typeof blame.removeMainWorktree === 'function');
}

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
