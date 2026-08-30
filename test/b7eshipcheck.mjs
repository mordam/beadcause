#!/usr/bin/env node
//
// b7e-shipcheck — what this branch actually ships, and whether bin/deliver.js would
// refuse it right now (bc-khoe.27.10).
//
//   npm test
//   node test/b7eshipcheck.mjs
//
// deliverVerdict() is pure and proved directly against fabricated {branch, base, dirty}
// shapes, the same argument test/b7eowes.mjs makes for its own extractors. Everything
// else here — base resolution, the committed diff, the dirty-tree read — is proved
// against a REAL throwaway git repo (a bare "origin" plus a working clone), the same
// shape test/blame.mjs and test/b7eworktree.mjs use for their own tools: a fake
// filesystem would agree with itself about `merge-base` and tell you nothing real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-shipcheck');

const shipcheck = await import(path.join(ROOT, 'lib', 'shipcheck.js'));

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
const checkAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ================================================================ 1. deliverVerdict */

console.log('\ndeliverVerdict reproduces bin/deliver.js\'s own three guard clauses\n');

check('a detached HEAD refuses, worded like deliver.js\'s own line', () => {
  const v = shipcheck.deliverVerdict({ branch: null, base: 'main', dirty: [] });
  assert.equal(v.refuses, true);
  assert.match(v.reason, /detached head/);
});

check('branch === base refuses "refusing to open a PR from X into Y"', () => {
  const v = shipcheck.deliverVerdict({ branch: 'main', base: 'main', dirty: [] });
  assert.equal(v.refuses, true);
  assert.match(v.reason, /refusing to open a PR from main into main/);
});

check('branch === master refuses even when base is something else', () => {
  const v = shipcheck.deliverVerdict({ branch: 'master', base: 'trunk', dirty: [] });
  assert.equal(v.refuses, true);
  assert.match(v.reason, /refusing to open a PR from master into trunk/);
});

check('a dirty tree refuses and names every path, staged or not', () => {
  const v = shipcheck.deliverVerdict({
    branch: 'feature',
    base: 'main',
    dirty: [
      { status: 'M ', file: 'lib/x.js' },
      { status: '??', file: 'scratch.tmp' },
    ],
  });
  assert.equal(v.refuses, true);
  assert.match(v.reason, /uncommitted changes/);
  assert.match(v.reason, /lib\/x\.js/);
  assert.match(v.reason, /scratch\.tmp/);
});

check('a branch of its own with a clean tree does not refuse', () => {
  const v = shipcheck.deliverVerdict({ branch: 'feature', base: 'main', dirty: [] });
  assert.equal(v.refuses, false);
  assert.equal(v.reason, null);
});

/* ================================================================ fixtures for the rest */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-shipcheck-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A bare `origin` with one commit on `main`, and a working clone tracking it. */
function makeRepo(name, files = { 'README.md': 'hello\n' }) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', originBare);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return work;
}

/* ================================================================ 2. resolveBase */

console.log('\nresolveBase — merge-base against a freshly fetched origin/<base>\n');

await checkAsync('resolves origin/main and its merge-base with HEAD', async () => {
  const work = makeRepo('resolve-basic');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add a.txt');
  const base = await shipcheck.resolveBase(work, 'main');
  assert.equal(base.ref, 'origin/main');
  assert.match(base.method, /freshly fetched origin\/main/);
  const mainTip = git(work, 'rev-parse', 'origin/main').trim();
  assert.equal(base.sha, mainTip);
});

await checkAsync('falls back to a local base branch when there is no origin remote at all', async () => {
  const work = path.join(tmp, 'no-origin');
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, 'x.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'y.txt'), 'y\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'feature commit');
  const base = await shipcheck.resolveBase(work, 'main');
  assert.equal(base.ref, 'main');
  assert.match(base.method, /local main/);
  assert.ok(base.sha);
});

await checkAsync('neither origin/<base> nor a local <base> resolving is reported, not thrown', async () => {
  const work = makeRepo('no-base-at-all');
  const originBare = path.join(tmp, 'no-base-at-all.git');
  git(work, 'branch', '-m', 'main', 'trunk'); // rename the only local branch away from "main"
  git(work, 'update-ref', '-d', 'refs/remotes/origin/main'); // drop the remote-tracking ref too
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/trunk'], { cwd: originBare }); // and on origin itself
  execFileSync('git', ['update-ref', '-d', 'refs/heads/main'], { cwd: originBare }); // so a fetch cannot bring it back
  const base = await shipcheck.resolveBase(work, 'main');
  assert.equal(base.sha, null);
  assert.match(base.method, /neither origin\/main nor a local main resolves/);
});

await checkAsync(
  'a checkout with no LOCAL main ref at all still resolves the base and the real diff — ' +
    'the case a bare `git diff main...HEAD` cannot even ask (bc-gdub.1)',
  async () => {
    const origin = makeRepo('no-local-main-ref');
    // A fresh checkout of the branch alone — `git clone --branch --single-branch` is the
    // cheap way to reproduce "this checkout never had a local `main` at all", which is
    // what a worktree created straight onto a feature branch from a remote ref looks
    // like: `main` exists only as `origin/main`, never as `refs/heads/main`.
    const clone = path.join(tmp, 'no-local-main-ref-clone');
    execFileSync('git', ['clone', '-q', '--branch', 'main', '--single-branch', origin, clone]);
    git(clone, 'checkout', '-q', '-b', 'feature');
    git(clone, 'branch', '-D', 'main'); // the clone made one; drop it, so none exists locally
    fs.writeFileSync(path.join(clone, 'new.txt'), 'new\n');
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'feature commit');

    assert.throws(() => git(clone, 'diff', 'main...HEAD', '--name-only'), /unknown revision|ambiguous/);

    const result = await shipcheck.shipcheck(clone, { baseRef: 'main' });
    assert.equal(result.base.ref, 'origin/main');
    assert.ok(result.base.sha);
    assert.deepEqual(result.diff.files, ['new.txt']);
    assert.equal(result.diff.ahead, 1);
    assert.equal(result.verdict.refuses, false);
  },
);

/* ================================================================ 3. committedDiff / workingTreeStatus */

console.log('\ncommittedDiff and workingTreeStatus\n');

await checkAsync('committedDiff names files, a stat, and the ahead count', async () => {
  const work = makeRepo('diff-basic');
  const base = await shipcheck.resolveBase(work, 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'a.txt'), 'one\ntwo\n');
  fs.writeFileSync(path.join(work, 'b.txt'), 'three\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'two files');
  const diff = await shipcheck.committedDiff(work, base.sha);
  assert.deepEqual(diff.files.sort(), ['a.txt', 'b.txt']);
  assert.equal(diff.ahead, 1);
  assert.match(diff.stat, /2 files changed/);
});

await checkAsync('workingTreeStatus reads staged, unstaged and untracked alike', async () => {
  const work = makeRepo('dirty-basic');
  fs.writeFileSync(path.join(work, 'README.md'), 'changed\n');
  fs.writeFileSync(path.join(work, 'new.tmp'), 'scratch\n');
  const dirty = await shipcheck.workingTreeStatus(work);
  const files = dirty.map((d) => d.file).sort();
  assert.deepEqual(files, ['README.md', 'new.tmp']);
});

/* ============================================================================ 4. the CLI */

console.log('\nbin/b7e-shipcheck — argv, exit codes, --json\n');

check('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-shipcheck/);
});

check(
  'a fresh worktree with one commit and one untracked scratch file: the file is named as ' +
    'what deliver.js will refuse over, and the same call succeeds once it is gone',
  () => {
    const work = makeRepo('cli-dirty');
    git(work, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(work, 'a.txt'), 'x\n');
    git(work, 'add', '-A');
    git(work, 'commit', '-q', '-m', 'a commit');
    fs.writeFileSync(path.join(work, '.deliver-summary.tmp'), 'scratch\n');

    const dirty = spawnSync(process.execPath, [BIN, '--dir', work], { encoding: 'utf8' });
    assert.equal(dirty.status, 1, dirty.stdout + dirty.stderr);
    assert.match(dirty.stdout, /\.deliver-summary\.tmp/);
    assert.match(dirty.stdout, /deliver\.js will refuse/);
    assert.match(dirty.stdout, /verdict: deliver\.js would REFUSE/);

    fs.rmSync(path.join(work, '.deliver-summary.tmp'));
    const clean = spawnSync(process.execPath, [BIN, '--dir', work], { encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stdout + clean.stderr);
    assert.match(clean.stdout, /verdict: clean/);
  },
);

check('the main checkout (branch === base) refuses rather than printing a main-into-main invocation', () => {
  const work = makeRepo('cli-main-into-main');
  const r = spawnSync(process.execPath, [BIN, '--dir', work], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /refusing to open a PR from main into main/);
});

check('--json prints one parseable object with the same verdict', () => {
  const work = makeRepo('cli-json');
  git(work, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'a commit');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.branch, 'feature');
  assert.equal(obj.verdict.refuses, false);
  assert.deepEqual(obj.diff.files, ['a.txt']);
});

check('-b names the bead in the printed header, cosmetically', () => {
  const work = makeRepo('cli-bead');
  git(work, 'checkout', '-q', '-b', 'feature');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '-b', 'bc-khoe.27.10'], { encoding: 'utf8' });
  assert.match(r.stdout, /# bc-khoe\.27\.10/);
});

check('--base points at a different integration branch', () => {
  const work = makeRepo('cli-base', { 'README.md': 'hello\n' });
  git(work, 'checkout', '-q', '-b', 'trunk');
  git(work, 'push', '-q', '-u', 'origin', 'trunk');
  git(work, 'checkout', '-q', '-b', 'feature', 'trunk');
  fs.writeFileSync(path.join(work, 'a.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'a commit');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--base', 'trunk'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /base: origin\/trunk/);
});

check('a base that resolves nowhere exits 2, not 1 — a usage problem, not a verdict', () => {
  const work = makeRepo('cli-no-base');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--base', 'nonexistent'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /could not resolve/);
});

/* ------------------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} failing\n`);
  process.exit(1);
} else {
  console.log('\nall checks passed\n');
}
