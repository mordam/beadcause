#!/usr/bin/env node
/**
 * `b7e-head` — read a pull request's files at its head, without a ref a sibling session
 * can clobber. lib/head.js and bin/b7e-head.
 *
 *     npm test
 *     node test/b7ehead.mjs
 *
 * bc-dgx7.37's own acceptance criteria are what this replays, against a real throwaway
 * git repo (a bare "origin" and a clone, exactly like `gh` would see) and a fake `gh`
 * that answers `pr view --json headRefOid,...` from a fixture:
 *
 * 1. **The head is resolved from `headRefOid`, never a branch name** — the fake `gh`
 *    never sees a `--head` or branch-name lookup at all, only `pr view <number>`.
 * 2. **Fetching writes no ref.** `git rev-parse FETCH_HEAD` and `git branch --list` are
 *    read before and after a run and asserted byte-identical — the exact check
 *    bc-zjab.12's own session would have needed.
 * 3. **Two runs against different pull requests do not interfere** — both fetched into
 *    the same checkout, both read back correctly afterward.
 * 4. **`--file` is exactly the file's bytes**, byte-identical to what was committed, and
 *    nothing else on stdout.
 * 5. **`--tree` writes only under `os.tmpdir()`**, is keyed by head oid (a second call's
 *    directory is unchanged — same marker file, same mtime), and links `node_modules`.
 *
 * Nothing here touches the network or runs a real `gh`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-head');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ehead-'));
process.on('exit', () => removeTreeSync(tmp));

/* -------------------------------------------------------------------- the repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const origin = path.join(tmp, 'origin.git');
const REPO = path.join(tmp, 'repo');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, REPO);
git(REPO, 'config', 'user.email', 't@e');
git(REPO, 'config', 'user.name', 'test');
const rootContent = 'root\n';
fs.writeFileSync(path.join(REPO, 'README.md'), rootContent);
git(REPO, 'add', '-A');
git(REPO, 'commit', '--quiet', '-m', 'root');
git(REPO, 'push', '--quiet', '-u', 'origin', 'main');
const baseOid = git(REPO, 'rev-parse', 'HEAD');

/** One pull request's head commit, pushed to `origin` on its own branch, never checked out again. */
function pullRequest(number, branch, files) {
  git(REPO, 'checkout', '--quiet', '-b', branch, 'main');
  for (const [name, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(REPO, name)), { recursive: true });
    fs.writeFileSync(path.join(REPO, name), content);
  }
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '--quiet', '-m', `pr ${number}`);
  const headOid = git(REPO, 'rev-parse', 'HEAD');
  git(REPO, 'push', '--quiet', 'origin', branch);
  git(REPO, 'checkout', '--quiet', 'main');
  git(REPO, 'branch', '--quiet', '-D', branch);
  return {
    number,
    headOid,
    headRefName: branch,
    baseRefName: 'main',
    baseRefOid: baseOid,
    files: Object.keys(files).map((p) => ({ path: p, additions: 1, deletions: 0, changeType: 'ADDED' })),
  };
}

const pr617 = pullRequest(617, 'feature-617', {
  'lib/widget.js': 'export const widget = () => "resolveThread lives here";\n',
  'test/widget.mjs': '// covers widget()\n',
});
const pr618 = pullRequest(618, 'feature-618', {
  'lib/other.js': 'export const other = () => "unrelated";\n',
});

// `origin`'s working branch is deleted locally in `REPO` above (`branch -D`), same as a
// real checkout that never checked a pull request's branch out — only `gh pr view` and
// an explicit-sha `git fetch` should ever be able to find these commits again.

/**
 * A fake `node_modules`, so `--tree`'s symlink has something real to point at — created
 * only now, after every pull request commit above, so `git add -A` on those commits
 * never picks it up. It stays untracked in `REPO` forever, exactly like a real
 * `npm ci`'d checkout's own `node_modules` never being part of any commit.
 */
fs.mkdirSync(path.join(REPO, 'node_modules'), { recursive: true });
fs.writeFileSync(path.join(REPO, 'node_modules', 'marker.txt'), 'installed\n');

/* ---------------------------------------------------------------------- fake gh */

const PRS = { 617: pr617, 618: pr618 };
const PRS_FILE = path.join(tmp, 'prs.json');
fs.writeFileSync(PRS_FILE, JSON.stringify(PRS));

const BIN_DIR = path.join(tmp, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });
const GH_CALLS = path.join(tmp, 'gh-calls.log');
fs.writeFileSync(
  path.join(BIN_DIR, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(GH_CALLS)}, JSON.stringify(a) + '\\n');
if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
if (a[0] === 'repo' && a[1] === 'view') { console.log('{"nameWithOwner":"mordam/widgets","viewerPermission":"WRITE"}'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') {
  const number = Number(a[2]);
  const prs = JSON.parse(fs.readFileSync(${JSON.stringify(PRS_FILE)}, 'utf8'));
  const row = prs[number];
  if (!row) { console.error('no pull request #' + number); process.exit(1); }
  console.log(JSON.stringify({
    number: row.number,
    headRefOid: row.headOid,
    headRefName: row.headRefName,
    baseRefName: row.baseRefName,
    baseRefOid: row.baseRefOid,
    files: row.files,
  }));
  process.exit(0);
}
console.error('unexpected gh: ' + a.join(' '));
process.exit(1);
`,
  { mode: 0o755 }
);

/* -------------------------------------------------------------------------- run */

// `--dir` goes right after the PR number, never appended at the end — a case below
// passes its own trailing `-- <paths>`, and anything after a bare `--` is taken as
// literal pathspecs rather than parsed as flags, exactly like git's own convention.
const withDir = (args, dir) => [args[0], '--dir', dir, ...args.slice(1)];

function run(args, { dir = REPO } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...withDir(args, dir)], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}` },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/** `res.stdout` as a Buffer instead of a string — for the `--file` byte-identity check. */
function runBuffer(args, { dir = REPO } = {}) {
  const res = spawnSync(process.execPath, [BIN, ...withDir(args, dir)], {
    cwd: tmp,
    env: { ...process.env, HOME: tmp, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}` },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || Buffer.alloc(0), stderr: (res.stderr || Buffer.alloc(0)).toString('utf8') };
}

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

console.log('\nb7e-head\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-head/);
});

check('no PR number is refused', () => {
  const { status, stderr } = run(['--list']);
  assert.notEqual(status, 0);
  assert.match(stderr, /expected exactly one PR number/);
});

check('two modes at once is refused', () => {
  const { status, stderr } = run(['617', '--list', '--tree']);
  assert.notEqual(status, 0);
  assert.match(stderr, /pass one/);
});

check('an unknown pull request is refused, not silently empty', () => {
  const { status, stderr } = run(['999', '--list']);
  assert.notEqual(status, 0);
  assert.match(stderr, /could not resolve pull request 999/);
});

/* ------------------------------------------------------- acceptance 1: never a branch */

check('acceptance 1: resolves headRefOid from `gh pr view <number>`, never a branch lookup', () => {
  fs.writeFileSync(GH_CALLS, '');
  const { status } = run(['617', '--list']);
  assert.equal(status, 0);
  const calls = fs
    .readFileSync(GH_CALLS, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const prViewCalls = calls.filter((c) => c[0] === 'pr' && c[1] === 'view');
  assert.equal(prViewCalls.length, 1, 'exactly one pr view call');
  assert.equal(prViewCalls[0][2], '617', 'looked up by number, not by branch name');
  assert.ok(!calls.some((c) => c.includes('feature-617')), 'the branch name was never passed to gh at all');
});

/* -------------------------------------------------- acceptance 2: no ref, no branch */

/** `git rev-parse --verify --quiet <ref>`, or `null` — never throws on a missing ref. */
const softRevParse = (cwd, ref) => {
  const res = spawnSync('git', ['rev-parse', '--verify', '--quiet', ref], { cwd, encoding: 'utf8' });
  return res.status === 0 ? res.stdout.trim() : null;
};

check('acceptance 2: fetching a head writes no FETCH_HEAD and no branch — the bc-zjab.12 check', () => {
  const before = { fetchHead: softRevParse(REPO, 'FETCH_HEAD') };
  const branchesBefore = git(REPO, 'branch', '--list');

  const { status } = run(['617', '--file', 'lib/widget.js']);
  assert.equal(status, 0);

  const after = { fetchHead: softRevParse(REPO, 'FETCH_HEAD') };
  const branchesAfter = git(REPO, 'branch', '--list');

  assert.equal(after.fetchHead, before.fetchHead, 'FETCH_HEAD moved — a ref was written');
  assert.equal(branchesAfter, branchesBefore, 'a new branch appeared in git branch --list');
  assert.ok(!branchesAfter.includes('feature-617'), 'the pull request branch must never be checked out locally');
});

/* -------------------------------------------------------------- acceptance 3: no interference */

check('acceptance 3: two pull requests fetched into the same checkout do not interfere', () => {
  const a = runBuffer(['617', '--file', 'lib/widget.js']);
  const b = runBuffer(['618', '--file', 'lib/other.js']);
  assert.equal(a.status, 0);
  assert.equal(b.status, 0);
  assert.equal(a.stdout.toString('utf8'), 'export const widget = () => "resolveThread lives here";\n');
  assert.equal(b.stdout.toString('utf8'), 'export const other = () => "unrelated";\n');
});

/* --------------------------------------------------------------- acceptance 4: --file */

check('acceptance 4: --file is exactly the bytes at the head commit, nothing else on stdout', () => {
  const { status, stdout } = runBuffer(['617', '--file', 'lib/widget.js']);
  assert.equal(status, 0);
  assert.equal(stdout.toString('utf8'), 'export const widget = () => "resolveThread lives here";\n');
});

check('--file on a path that does not exist at the head is refused, not empty', () => {
  const { status, stderr } = run(['617', '--file', 'lib/nope.js']);
  assert.notEqual(status, 0);
  assert.match(stderr, /does not exist at/);
});

check('the head oid banner is on stderr, never mixed into --file\'s stdout', () => {
  const { stderr } = run(['617', '--file', 'lib/widget.js']);
  assert.match(stderr, new RegExp(pr617.headOid));
});

/* --------------------------------------------------------------------------- --list */

check('--list prints the head oid, base oid, branch name and changed paths', () => {
  const { status, stdout } = run(['617', '--list']);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(pr617.headOid));
  assert.match(stdout, new RegExp(pr617.baseRefOid));
  assert.match(stdout, /feature-617/);
  assert.match(stdout, /lib\/widget\.js/);
  assert.match(stdout, /test\/widget\.mjs/);
});

check('--list --json is the same facts, machine-readable', () => {
  const { status, stdout } = run(['617', '--list', '--json']);
  assert.equal(status, 0);
  const row = JSON.parse(stdout);
  assert.equal(row.headOid, pr617.headOid);
  assert.equal(row.baseOid, pr617.baseRefOid);
  assert.equal(row.headRefName, 'feature-617');
  assert.deepEqual(
    row.files.map((f) => f.path).sort(),
    ['lib/widget.js', 'test/widget.mjs']
  );
});

check('with no mode given, the default matches --list', () => {
  const withList = run(['617', '--list', '--json']).stdout;
  const withNothing = run(['617', '--json']).stdout;
  assert.equal(withNothing, withList);
});

/* --------------------------------------------------------------------------- --grep */

check('--grep finds a pattern in the head tree', () => {
  const { status, stdout } = run(['617', '--grep', 'resolveThread']);
  assert.equal(status, 0);
  assert.match(stdout, /lib\/widget\.js:1:/);
});

check('--grep -- <paths> narrows the search', () => {
  const missed = run(['617', '--grep', 'resolveThread', '--', 'test']);
  assert.equal(missed.status, 0);
  assert.equal(missed.stdout.trim(), '', 'the pattern is not under test/, so nothing should match');

  const found = run(['617', '--grep', 'resolveThread', '--', 'lib']);
  assert.match(found.stdout, /lib\/widget\.js/);
});

check('--grep with no matches is an empty, successful answer', () => {
  const { status, stdout } = run(['617', '--grep', 'nothing-matches-this-xyz']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '');
});

/* --------------------------------------------------------------------------- --tree */

check('acceptance 5: --tree writes only under os.tmpdir(), keyed by head oid, node_modules linked', () => {
  const { status, stdout } = run(['617', '--tree']);
  assert.equal(status, 0);
  const dest = stdout.trim();
  assert.ok(dest.startsWith(fs.realpathSync(os.tmpdir())) || dest.startsWith(os.tmpdir()), `--tree wrote outside os.tmpdir(): ${dest}`);
  assert.ok(dest.includes(pr617.headOid), 'the materialised directory is not keyed by head oid');
  assert.equal(fs.readFileSync(path.join(dest, 'lib', 'widget.js'), 'utf8'), 'export const widget = () => "resolveThread lives here";\n');
  const nmLink = path.join(dest, 'node_modules');
  assert.ok(fs.lstatSync(nmLink).isSymbolicLink(), 'node_modules was not linked in');
  assert.equal(fs.readFileSync(path.join(nmLink, 'marker.txt'), 'utf8'), 'installed\n');

  // A second call for the same head reuses the directory rather than re-extracting it.
  const markerPath = path.join(dest, '.b7e-head-ok');
  const before = fs.statSync(markerPath).mtimeMs;
  const again = run(['617', '--tree']);
  assert.equal(again.stdout.trim(), dest);
  assert.equal(fs.statSync(markerPath).mtimeMs, before, 'the marker was rewritten — the tree was not reused');
});

check('README.md names b7e-head', () => {
  const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /^### .*`b7e-head`/m, 'no ### section names b7e-head');
});

check('registered in package.json and package-lock.json bin', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-head'], 'bin/b7e-head');
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(lock.packages[''].bin['b7e-head'], 'bin/b7e-head');
});

console.log(`\n${failures === 0 ? 'all good' : `${failures} failing`}\n`);
process.exit(failures === 0 ? 0 : 1);
