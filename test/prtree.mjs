#!/usr/bin/env node
//
// b7e-prtree — a reviewer's own runnable copy of a pull request (bc-dgx7.38).
//
//   npm test
//   node test/prtree.mjs
//
// The whole argument for this file is a real git repo, not a fake one: the bug it
// exists to catch (bc-zjab.12's FETCH_HEAD getting clobbered mid-run by a concurrent
// fetch elsewhere on the Mac) is exactly the kind of thing an in-memory fake would agree
// with itself about and tell you nothing real. So every fixture below is a real bare
// "origin" plus a real, genuinely-missing-the-commit "reviewer" clone — cloned
// `--no-local --single-branch` so it does not silently inherit every object the way a
// same-machine `git clone` normally would, which is what lets the fetch-by-sha tests
// prove something rather than pass by construction. `lib/pr.js`'s own `gh` integration
// is proved in test/pr.mjs; this file proves how `lib/prtree.js` *uses* whatever `gh pr
// view` (or a fake standing in for it) hands back, and never reads `FETCH_HEAD`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-prtree');

const { buildTree, treeRoot } = await import(path.join(ROOT, 'lib', 'prtree.js'));

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
const checkAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};
/** Run `fn` and hand back the error it threw/rejected with, or null. */
const threw = async (fn) => {
  try {
    await fn();
    return null;
  } catch (err) {
    return err;
  }
};

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-prtree-test-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// Every tree this file builds lives here instead of the real os.tmpdir()/beadcause-prtree
// — os.tmpdir() re-reads TMPDIR on every call, so this is enough, and it is what keeps
// this suite from colliding with a real reviewer session's own trees on the same Mac.
const TREE_HOME = path.join(tmp, 'treehome');
fs.mkdirSync(TREE_HOME, { recursive: true });
process.env.TMPDIR = TREE_HOME;

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t.co', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/**
 * A bare `origin`, an `author` clone that commits and pushes PR refs by hand (this repo
 * has no real GitHub here, so a "pull request" is just `refs/pull/<n>/head` /
 * `refs/pull/<n>/merge` pushed straight to the bare repo), and a `reviewer` clone that
 * never sees a PR's objects until `buildTree` fetches them — cloned `--no-local
 * --single-branch --branch main` specifically so that same-machine object-store sharing
 * cannot quietly hand it objects it has no ref to.
 */
function makeRepo(name) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);

  const author = path.join(tmp, `${name}-author`);
  fs.mkdirSync(author, { recursive: true });
  git(author, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(author, 'README.md'), 'hello\n');
  fs.mkdirSync(path.join(author, 'scripts'), { recursive: true });
  // A vendor.js that does no real work — just proves --vendor ran it, offline.
  fs.writeFileSync(path.join(author, 'scripts', 'vendor.js'), "require('fs').writeFileSync('vendor-ran.txt', 'yes\\n');\n");
  git(author, 'add', '-A');
  git(author, 'commit', '-q', '-m', 'init');
  git(author, 'remote', 'add', 'origin', originBare);
  git(author, 'push', '-q', '-u', 'origin', 'main');

  const reviewer = path.join(tmp, `${name}-reviewer`);
  execFileSync('git', ['clone', '-q', '--no-local', '--single-branch', '--branch', 'main', originBare, reviewer]);
  fs.mkdirSync(path.join(reviewer, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(reviewer, 'node_modules', 'dummy.txt'), 'x\n');

  return { originBare, author, reviewer };
}

/** Commit a change on `author` and push it straight to `refs/pull/<n>/<kind>` on origin. */
function pushPrRef(author, n, kind, relPath, body) {
  fs.writeFileSync(path.join(author, relPath), body);
  git(author, 'add', '-A');
  git(author, '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', `pr ${n} ${kind}`);
  const sha = git(author, 'rev-parse', 'HEAD').trim();
  git(author, 'push', '-q', 'origin', `HEAD:refs/pull/${n}/${kind}`);
  return sha;
}

const fakeViewPR = (bySha) => async (repoRoot, prNumber) => {
  const sha = bySha[String(prNumber)];
  if (!sha) throw new Error(`fakeViewPR: no PR #${prNumber}`);
  return { headSha: sha, branch: `pr-${prNumber}-branch` };
};

/* ============================================================ 1. resolving a PR head */

console.log('\nbuildTree resolves a PR head sha, fetches it, and archives exactly that\n');

{
  const { originBare, author, reviewer } = makeRepo('head');
  const headSha = pushPrRef(author, 11, 'head', 'README.md', 'from the PR head\n');

  await checkAsync('the built tree exists at treeRoot()/<name>, under the fixture TMPDIR', async () => {
    const result = await buildTree(
      { repoRoot: reviewer, name: 'head-11', prNumber: '11' },
      { viewPR: fakeViewPR({ 11: headSha }) }
    );
    assert.equal(result.dir, path.join(treeRoot(), 'head-11'));
    assert.ok(result.dir.startsWith(TREE_HOME), `${result.dir} is not under the fixture TMPDIR ${TREE_HOME}`);
  });

  await checkAsync('the sha it resolved is exactly what "gh pr view" (the fake) reported, and the ref is "head"', async () => {
    const result = await buildTree(
      { repoRoot: reviewer, name: 'head-12', prNumber: '11' },
      { viewPR: fakeViewPR({ 11: headSha }) }
    );
    assert.equal(result.sha, headSha);
    assert.equal(result.ref, 'head');
    assert.equal(result.prNumber, '11');
    assert.equal(result.branch, 'pr-11-branch');
  });

  await checkAsync('the extracted content is byte-for-byte the PR head\'s tree, not the base main it cloned', async () => {
    const result = await buildTree(
      { repoRoot: reviewer, name: 'head-13', prNumber: '11' },
      { viewPR: fakeViewPR({ 11: headSha }) }
    );
    assert.equal(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8'), 'from the PR head\n');
  });
}

/* ==================================================== 2. never reads FETCH_HEAD */

console.log('\nit never reads FETCH_HEAD — the whole reason this file exists\n');

{
  const { author, reviewer } = makeRepo('fetchhead');
  const headSha = pushPrRef(author, 22, 'head', 'README.md', 'the real pr\n');

  const fetchHeadPath = path.join(reviewer, '.git', 'FETCH_HEAD');
  const bogus = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\t\tbranch \'nonsense\' of somewhere-unrelated\n';
  fs.writeFileSync(fetchHeadPath, bogus);

  await checkAsync('the tree is built at the pull request\'s real head sha, not whatever FETCH_HEAD says', async () => {
    const result = await buildTree(
      { repoRoot: reviewer, name: 'fh-1', prNumber: '22' },
      { viewPR: fakeViewPR({ 22: headSha }) }
    );
    assert.equal(result.sha, headSha);
    assert.equal(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8'), 'the real pr\n');
  });

  check('and FETCH_HEAD itself is byte-for-byte untouched — buildTree never wrote it', () => {
    assert.equal(fs.readFileSync(fetchHeadPath, 'utf8'), bogus);
  });
}

/* ==================================================== 3. --merge, via ls-remote */

console.log('\n--merge resolves refs/pull/<n>/merge through ls-remote, no gh, no ref left behind\n');

{
  const { author, reviewer } = makeRepo('merge');
  const headSha = pushPrRef(author, 33, 'head', 'README.md', 'head content\n');
  const mergeSha = pushPrRef(author, 33, 'merge', 'README.md', 'merge content\n');
  assert.notEqual(headSha, mergeSha, 'test fixture bug: head and merge shas must differ');

  await checkAsync('--merge builds refs/pull/<n>/merge\'s content, not the head\'s', async () => {
    const result = await buildTree({ repoRoot: reviewer, name: 'merge-1', prNumber: '33', merge: true });
    assert.equal(result.sha, mergeSha);
    assert.equal(result.ref, 'merge');
    assert.equal(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8'), 'merge content\n');
  });

  await checkAsync('a PR with no merge ref (no such PR here) refuses with a readable reason, mentioning --merge', async () => {
    const err = await threw(() => buildTree({ repoRoot: reviewer, name: 'merge-2', prNumber: '999', merge: true }));
    assert.ok(err, 'expected buildTree to reject');
    assert.match(err.message, /refs\/pull\/999\/merge/);
  });
}

/* ==================================================== 4. --sha, bypassing gh entirely */

console.log('\n--sha builds from an explicit sha with no PR lookup at all\n');

{
  const { author, reviewer } = makeRepo('sha');
  const sha = pushPrRef(author, 44, 'head', 'README.md', 'explicit sha content\n');

  await checkAsync('an explicit --sha is used as-is, ref "given", no prNumber', async () => {
    const result = await buildTree({ repoRoot: reviewer, name: 'sha-1', sha });
    assert.equal(result.sha, sha);
    assert.equal(result.ref, 'given');
    assert.equal(result.prNumber, null);
    assert.equal(fs.readFileSync(path.join(result.dir, 'README.md'), 'utf8'), 'explicit sha content\n');
  });

  await checkAsync('--sha combined with --merge is refused before anything is fetched', async () => {
    const err = await threw(() => buildTree({ repoRoot: reviewer, name: 'sha-2', sha, merge: true }));
    assert.match(err.message, /--merge/);
  });

  await checkAsync('neither a PR number nor --sha is refused', async () => {
    const err = await threw(() => buildTree({ repoRoot: reviewer, name: 'sha-3' }));
    assert.match(err.message, /pull request number or --sha/);
  });
}

/* ==================================================== 5. node_modules, replace, --keep */

console.log('\nnode_modules linking, --name replacing a prior tree, and --keep refusing to\n');

{
  const { author, reviewer } = makeRepo('extras');
  const shaA = pushPrRef(author, 55, 'head', 'README.md', 'version A\n');

  await checkAsync('node_modules is symlinked from the reviewing checkout when it has one', async () => {
    const result = await buildTree({ repoRoot: reviewer, name: 'extras-1', sha: shaA });
    assert.equal(result.nodeModulesLinked, true);
    const linked = fs.lstatSync(path.join(result.dir, 'node_modules'));
    assert.ok(linked.isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(result.dir, 'node_modules', 'dummy.txt'), 'utf8'), 'x\n');
  });

  await checkAsync('--vendor runs scripts/vendor.js inside the new tree', async () => {
    const result = await buildTree({ repoRoot: reviewer, name: 'extras-2', sha: shaA, vendor: true });
    assert.equal(result.vendored, true);
    assert.equal(fs.readFileSync(path.join(result.dir, 'vendor-ran.txt'), 'utf8'), 'yes\n');
  });

  const shaB = pushPrRef(author, 56, 'head', 'README.md', 'version B\n');
  await checkAsync('a second call with the same --name replaces the first tree entirely', async () => {
    const first = await buildTree({ repoRoot: reviewer, name: 'extras-replace', sha: shaA });
    fs.writeFileSync(path.join(first.dir, 'left-over-from-first-run.txt'), 'stray\n');
    const second = await buildTree({ repoRoot: reviewer, name: 'extras-replace', sha: shaB });
    assert.equal(second.dir, first.dir);
    assert.equal(fs.readFileSync(path.join(second.dir, 'README.md'), 'utf8'), 'version B\n');
    assert.ok(!fs.existsSync(path.join(second.dir, 'left-over-from-first-run.txt')), 'the stray file from the first run must be gone');
  });

  await checkAsync('--keep makes a later call with the same --name refuse rather than delete', async () => {
    await buildTree({ repoRoot: reviewer, name: 'extras-kept', sha: shaA, keep: true });
    const err = await threw(() => buildTree({ repoRoot: reviewer, name: 'extras-kept', sha: shaB }));
    assert.match(err.message, /kept by a previous run/);
    // And the kept tree's own content is undisturbed by the refused second call.
    assert.equal(
      fs.readFileSync(path.join(treeRoot(), 'extras-kept', 'README.md'), 'utf8'),
      'version A\n'
    );
  });
}

/* ==================================================== 6. containment */

console.log('\nnothing here is ever written under the real home directory or CONFIG_DIR\n');

{
  const { author, reviewer } = makeRepo('contain');
  const sha = pushPrRef(author, 77, 'head', 'README.md', 'contained\n');

  await checkAsync('a --name that tries to escape the tree root is refused, not walked', async () => {
    const err = await threw(() => buildTree({ repoRoot: reviewer, name: '../../escaped-outside', sha }));
    assert.ok(err, 'expected buildTree to reject a traversing --name');
    assert.match(err.message, /outside the tree/);
    assert.ok(!fs.existsSync(path.join(tmp, '..', 'escaped-outside')), 'nothing must exist at the escaped path');
  });

  check('the CLI run with HOME pointed at an empty fixture directory writes nothing at all under it', () => {
    const fakeHome = fs.mkdtempSync(path.join(tmp, 'fake-home-'));
    const run = spawnSync('node', [BIN, '--sha', sha, '--name', 'contain-cli'], {
      cwd: reviewer,
      env: { ...process.env, TMPDIR: TREE_HOME, HOME: fakeHome },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.deepEqual(fs.readdirSync(fakeHome), []);
    assert.ok(!run.stdout.trim().startsWith(fakeHome), 'the tree it built lives under TMPDIR, not the HOME it was run with');
  });
}

/* ==================================================== 7. the CLI */

console.log('\nbin/b7e-prtree — argv, exit codes, and the printed shape\n');

{
  const { author, reviewer } = makeRepo('cli');
  const sha = pushPrRef(author, 88, 'head', 'README.md', 'from the cli\n');

  check('--help prints usage and exits 0', () => {
    const run = spawnSync('node', [BIN, '--help'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /usage: b7e-prtree/);
  });

  check('an unrecognised flag exits 1', () => {
    const run = spawnSync('node', [BIN, '--nonsense'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
  });

  check('neither a PR number nor --sha exits 1', () => {
    const run = spawnSync('node', [BIN], { encoding: 'utf8' });
    assert.equal(run.status, 1);
  });

  check('a PR number AND --sha together exits 1', () => {
    const run = spawnSync('node', [BIN, '9', '--sha', sha], { encoding: 'utf8' });
    assert.equal(run.status, 1);
  });

  check('--merge without a PR number exits 1', () => {
    const run = spawnSync('node', [BIN, '--sha', sha, '--merge'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
  });

  check('run outside any git repository exits 2', () => {
    const outside = fs.mkdtempSync(path.join(tmp, 'not-a-repo-'));
    const run = spawnSync('node', [BIN, '--sha', sha], { cwd: outside, env: { ...process.env, TMPDIR: TREE_HOME }, encoding: 'utf8' });
    assert.equal(run.status, 2);
  });

  check('a real run with --sha (no gh) prints the tree path on stdout, one line, and the sha on stderr', () => {
    const run = spawnSync('node', [BIN, '--sha', sha, '--name', 'cli-1'], {
      cwd: reviewer,
      env: { ...process.env, TMPDIR: TREE_HOME },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const lines = run.stdout.trim().split('\n');
    assert.equal(lines.length, 1, 'stdout must be exactly the one path line');
    assert.equal(lines[0], path.join(treeRoot(), 'cli-1'));
    assert.match(run.stderr, new RegExp(sha));
    assert.equal(fs.readFileSync(path.join(lines[0], 'README.md'), 'utf8'), 'from the cli\n');
  });

  check('--json prints one well-formed object on stdout instead', () => {
    const run = spawnSync('node', [BIN, '--sha', sha, '--name', 'cli-2', '--json'], {
      cwd: reviewer,
      env: { ...process.env, TMPDIR: TREE_HOME },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    const parsed = JSON.parse(run.stdout);
    assert.equal(parsed.sha, sha);
    assert.equal(parsed.ref, 'given');
    assert.equal(parsed.dir, path.join(treeRoot(), 'cli-2'));
  });

  check('--merge resolves through the CLI too, with no gh call needed', () => {
    const mergeSha = pushPrRef(author, 89, 'merge', 'README.md', 'cli merge content\n');
    const run = spawnSync('node', [BIN, '89', '--merge', '--name', 'cli-merge'], {
      cwd: reviewer,
      env: { ...process.env, TMPDIR: TREE_HOME },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(fs.readFileSync(path.join(run.stdout.trim(), 'README.md'), 'utf8'), 'cli merge content\n');
    assert.match(run.stderr, new RegExp(mergeSha));
  });

  check('the default --name is derived from the PR number (and --merge), with no --name given', () => {
    const mergeSha = pushPrRef(author, 90, 'merge', 'README.md', 'default-named merge\n');
    const run = spawnSync('node', [BIN, '90', '--merge'], {
      cwd: reviewer,
      env: { ...process.env, TMPDIR: TREE_HOME },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(run.stdout.trim(), path.join(treeRoot(), 'pr90-merge'));
    assert.equal(fs.readFileSync(path.join(run.stdout.trim(), 'README.md'), 'utf8'), 'default-named merge\n');
  });

  check('a sha that resolves to nothing fetchable fails with exit 3, not a crash', () => {
    const run = spawnSync('node', [BIN, '--sha', 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', '--name', 'cli-badsha'], {
      cwd: reviewer,
      env: { ...process.env, TMPDIR: TREE_HOME },
      encoding: 'utf8',
    });
    assert.equal(run.status, 3, `expected exit 3, got ${run.status}; stderr: ${run.stderr}`);
    assert.match(run.stderr, /b7e-prtree:/);
  });
}

/* ---------------------------------------------------------------------- verdict */

console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} checks passed`);
process.exit(failures ? 1 : 0);
