#!/usr/bin/env node
//
// b7e-landed — say whether a bead's work is already on main, and under whose pull
// request (bc-khoe.47).
//
//   npm test
//   node test/landedcheck.mjs
//
// The pure functions (familyRootOf, familyIdsIn, prNumberOf) are proved directly
// against small fabricated strings. Everything that reads git history is proved
// against a REAL git repo — a bare "origin" plus a working clone, the same shape
// test/blame.mjs and test/b7eworktree.mjs already use for their own tools — because
// `git log --grep`'s boundary behaviour (POSIX ERE has no `\b`, which is the whole
// reason for the hand-rolled one) is exactly the thing worth proving against the real
// command rather than assumed. The last section runs against this repo's own real,
// immutable history: bc-42ow.4's landing under bc-42ow.3's PR #435 already happened and
// can never un-happen, so pinning it here is not the kind of assertion that flakes with
// main the way a suite's pass/fail would.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-landed');

const lc = await import(path.join(ROOT, 'lib', 'landedcheck.js'));

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

/* ==================================================================== 1. familyRootOf */

console.log("\nfamilyRootOf finds the immediate sibling group, not the whole epic\n");

check('one dot — the parent, same as the whole id minus its own segment', () => {
  assert.equal(lc.familyRootOf('bc-42ow.4'), 'bc-42ow');
});

check('two dots — one level up, not the top epic', () => {
  assert.equal(lc.familyRootOf('bc-ka5y.15.3'), 'bc-ka5y.15');
});

check('no dot — its own root, so its family is itself plus its direct children', () => {
  assert.equal(lc.familyRootOf('bc-mp8c'), 'bc-mp8c');
});

/* ===================================================================== 2. familyIdsIn */

console.log('\nfamilyIdsIn reads every id in a family out of prose, word-bounded\n');

check('the root itself and a dotted child, both in one sentence', () => {
  assert.deepEqual(lc.familyIdsIn('This is bc-42ow.3 and bc-42ow.4, delivered together.', 'bc-42ow'), [
    'bc-42ow.3',
    'bc-42ow.4',
  ]);
});

check('a longer id with the same prefix is not a false match', () => {
  assert.deepEqual(lc.familyIdsIn('bc-42owx is unrelated', 'bc-42ow'), []);
});

check('duplicates collapse to one', () => {
  assert.deepEqual(lc.familyIdsIn('bc-42ow.4 ... later, bc-42ow.4 again', 'bc-42ow'), ['bc-42ow.4']);
});

check('no root given finds nothing', () => {
  assert.deepEqual(lc.familyIdsIn('bc-42ow.4', ''), []);
});

/* ===================================================================== 3. prNumberOf */

console.log('\nprNumberOf reads the squash-merge (#NNN) off a commit subject\n');

check('the ordinary shape', () => {
  assert.equal(lc.prNumberOf('bc-42ow.3: A plan may not give the same file to two groups (#435)'), 435);
});

check('no trailing (#NNN) at all', () => {
  assert.equal(lc.prNumberOf('bc-42ow.3: not yet merged that way'), null);
});

check('a (#NNN) in the middle, not at the end, does not count', () => {
  assert.equal(lc.prNumberOf('bc-42ow.3: fixes (#1) of three things'), null);
});

/* ============================================================= fixtures for the rest */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-landed-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A bare `origin` and a working clone `work`, `main` pushed and tracked. */
function makeRepo(name) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', originBare);
  fs.writeFileSync(path.join(work, 'README.md'), 'init\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return work;
}

function commitFile(work, rel, body, message) {
  fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
  fs.writeFileSync(path.join(work, rel), body);
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', message);
}

function push(work) {
  git(work, 'push', '-q', 'origin', 'main');
}

/* ================================================================== 4. familyCommits */

console.log('\nfamilyCommits reads git log --grep against the real command, boundary and all\n');

check('finds a commit whose subject names the exact id, with its PR number', () => {
  const work = makeRepo('family-subject');
  commitFile(work, 'a.txt', 'x\n', 'bc-9k2.1: a change (#12)');
  push(work);
  const base = lc.resolveBase(work, 'main');
  const commits = lc.familyCommits(work, base, 'bc-9k2');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].ids, ['bc-9k2.1']);
  assert.equal(commits[0].pr, 12);
});

check('finds a commit that only names the sibling in its body, not its subject', () => {
  const work = makeRepo('family-body');
  const msg = 'bc-9k2.2: a change (#13)\n\nThis is bc-9k2.2 and bc-9k2.3, delivered together.\n';
  fs.writeFileSync(path.join(work, 'b.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', msg);
  push(work);
  const base = lc.resolveBase(work, 'main');
  const commits = lc.familyCommits(work, base, 'bc-9k2');
  assert.equal(commits.length, 1);
  assert.deepEqual(commits[0].ids, ['bc-9k2.2', 'bc-9k2.3']);
});

check('a longer id sharing the same prefix is not a false hit — the ERE boundary works for real', () => {
  const work = makeRepo('family-boundary');
  commitFile(work, 'a.txt', 'x\n', 'bc-9k2x: unrelated bead, similar prefix');
  push(work);
  const base = lc.resolveBase(work, 'main');
  assert.deepEqual(lc.familyCommits(work, base, 'bc-9k2'), []);
});

check('no family commits at all returns []', () => {
  const work = makeRepo('family-none');
  commitFile(work, 'a.txt', 'x\n', 'unrelated commit, no bead id');
  push(work);
  const base = lc.resolveBase(work, 'main');
  assert.deepEqual(lc.familyCommits(work, base, 'bc-9k2'), []);
});

/* ============================================================== 5. resolveBase */

console.log('\nresolveBase prefers origin/<base>, falls back to the bare ref\n');

check('origin/main resolves when the repo has been pushed', () => {
  const work = makeRepo('base-origin');
  assert.equal(lc.resolveBase(work, 'main'), 'origin/main');
});

check('a base that does not exist anywhere returns null', () => {
  const work = makeRepo('base-missing');
  assert.equal(lc.resolveBase(work, 'nowhere'), null);
});

/* ========================================================= 6. collisionsSinceMergeBase */

console.log('\ncollisionsSinceMergeBase: literal overlap, and the one-hop textual reach\n');

check('a file both sides touched since the merge-base is the literal case', () => {
  const work = makeRepo('collide-literal');
  const mergeBase = git(work, 'rev-parse', 'HEAD').trim();
  commitFile(work, 'shared.txt', 'branch version\n', 'branch: touches shared.txt');
  const branchTip = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', mergeBase);
  commitFile(work, 'shared.txt', 'main version\n', 'main: also touches shared.txt');
  git(work, 'branch', '-f', 'main');
  git(work, 'checkout', '-q', 'main');
  push(work);
  const base = lc.resolveBase(work, 'main');
  const c = lc.collisionsSinceMergeBase(work, branchTip, base);
  assert.deepEqual(c.literal, ['shared.txt']);
  assert.deepEqual(c.textual, []);
});

check('a base file that names a branch-only file in its own source is the textual case', () => {
  const work = makeRepo('collide-textual');
  const mergeBase = git(work, 'rev-parse', 'HEAD').trim();
  commitFile(work, 'public/sound.wav', 'audio bytes\n', 'branch: adds public/sound.wav');
  const branchTip = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', mergeBase);
  commitFile(work, 'lib/loader.js', "readFile('public/sound.wav')\n", 'main: loader now names sound.wav');
  git(work, 'branch', '-f', 'main');
  git(work, 'checkout', '-q', 'main');
  push(work);
  const base = lc.resolveBase(work, 'main');
  const c = lc.collisionsSinceMergeBase(work, branchTip, base);
  assert.deepEqual(c.literal, []);
  assert.equal(c.textual.length, 1);
  assert.equal(c.textual[0].branchFile, 'public/sound.wav');
  assert.equal(c.textual[0].reachedVia, 'lib/loader.js');
});

check('no overlap at all is reported as empty, not an error', () => {
  const work = makeRepo('collide-none');
  const mergeBase = git(work, 'rev-parse', 'HEAD').trim();
  commitFile(work, 'branch-only.txt', 'x\n', 'branch: its own file');
  const branchTip = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'checkout', '-q', mergeBase);
  commitFile(work, 'main-only.txt', 'y\n', 'main: its own, unrelated file');
  git(work, 'branch', '-f', 'main');
  git(work, 'checkout', '-q', 'main');
  push(work);
  const base = lc.resolveBase(work, 'main');
  const c = lc.collisionsSinceMergeBase(work, branchTip, base);
  assert.deepEqual(c.literal, []);
  assert.deepEqual(c.textual, []);
});

/* ==================================================================== 7. beadIdFromBranch */

console.log("\nbeadIdFromBranch reads the id off the branch's own first commit\n");

check('a branch with a conventionally-titled commit reads its own id', () => {
  const work = makeRepo('branchid');
  const base = lc.resolveBase(work, 'main');
  git(work, 'checkout', '-q', '-b', 'worktree-something-zz1');
  commitFile(work, 'a.txt', 'x\n', 'bc-9k2.1: the actual change');
  assert.equal(lc.beadIdFromBranch(work, base), 'bc-9k2.1');
});

check('a branch with no commits of its own returns null', () => {
  const work = makeRepo('branchid-none');
  const base = lc.resolveBase(work, 'main');
  assert.equal(lc.beadIdFromBranch(work, base), null);
});

/* ===================================================================== 8. checkLanded */

console.log('\ncheckLanded: the whole answer, verdict by verdict\n');

await checkAsync('landed — a commit on base names the id directly', async () => {
  const work = makeRepo('landed-yes');
  commitFile(work, 'a.txt', 'x\n', 'bc-9k2.1: the change (#7)');
  push(work);
  const r = await lc.checkLanded(work, 'bc-9k2.1', { base: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'landed');
  assert.equal(r.commits[0].pr, 7);
});

await checkAsync('no-evidence — nothing names it, no branch, no supersede', async () => {
  const work = makeRepo('landed-nothing');
  const r = await lc.checkLanded(work, 'bc-zzz.9', { base: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'no-evidence');
});

await checkAsync('unlanded — a worktree branch whose tag spells the id, ahead of base, not merged', async () => {
  const work = makeRepo('landed-branch-tag');
  git(work, 'checkout', '-q', '-b', 'worktree-thing-zzq1');
  commitFile(work, 'a.txt', 'x\n', 'unrelated commit message');
  const r = await lc.checkLanded(work, 'bc-zzq.1', { base: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'unlanded');
  assert.equal(r.branch, 'worktree-thing-zzq1');
  assert.equal(r.ahead, 1);
});

await checkAsync('unlanded — a branch whose short tag does not spell the id, found by its own commit instead', async () => {
  const work = makeRepo('landed-branch-fallback');
  // "abc9" is not tagOf('bc-zz.1') ('zz1') — the ordinary shape of a session's own
  // short worktree name (see the file header) — so only the fallback pass finds it.
  git(work, 'checkout', '-q', '-b', 'worktree-something-abc9');
  commitFile(work, 'a.txt', 'x\n', 'bc-zz.1: work in progress');
  const r = await lc.checkLanded(work, 'bc-zz.1', { base: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'unlanded');
  assert.equal(r.branch, 'worktree-something-abc9');
  assert.equal(r.ahead, 1);
});

await checkAsync('a bad base is refused, not silently misread', async () => {
  const work = makeRepo('landed-badbase');
  const r = await lc.checkLanded(work, 'bc-9k2.1', { base: 'nowhere' });
  assert.equal(r.ok, false);
});

/* -------------------------------------------------------------------------- the CLI */

console.log('\nbin/b7e-landed: exit codes and the printed report\n');

check('landed exits 0 and names the commit and PR', () => {
  const work = makeRepo('cli-landed');
  commitFile(work, 'a.txt', 'x\n', 'bc-9k2.1: the change (#7)');
  push(work);
  const r = spawnSync(process.execPath, [BIN, 'bc-9k2.1', '--dir', work, '--base', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /already on origin\/main/);
  assert.match(r.stdout, /PR #7/);
});

check('no evidence exits 1 and says so plainly', () => {
  const work = makeRepo('cli-nothing');
  const r = spawnSync(process.execPath, [BIN, 'bc-zzz.9', '--dir', work, '--base', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no evidence bc-zzz\.9 has landed/);
});

check('--json prints one parseable object', () => {
  const work = makeRepo('cli-json');
  commitFile(work, 'a.txt', 'x\n', 'bc-9k2.1: the change (#7)');
  push(work);
  const r = spawnSync(process.execPath, [BIN, 'bc-9k2.1', '--dir', work, '--base', 'main', '--json'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.verdict, 'landed');
});

check('a bad base refuses with exit 2', () => {
  const work = makeRepo('cli-badbase');
  const r = spawnSync(process.execPath, [BIN, 'bc-9k2.1', '--dir', work, '--base', 'nowhere'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

check('no id and no commits of its own on the branch refuses with exit 2', () => {
  const work = makeRepo('cli-noid');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--base', 'main'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
});

check('--help prints usage and exits 0', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-landed/);
});

/* ------------------------------------------------------- 9. against this repo's own history */

console.log("\nagainst this repo's own real, immutable history\n");

await checkAsync('bc-42ow.4 landed under bc-42ow.3\'s PR #435, with the sibling in the family', async () => {
  const r = await lc.checkLanded(ROOT, 'bc-42ow.4', { base: 'main' });
  assert.equal(r.ok, true);
  assert.equal(r.verdict, 'landed');
  const withPr = r.commits.find((c) => c.sha.startsWith('f8d4b710'));
  assert.ok(withPr, 'f8d4b710 is among the commits naming bc-42ow.4');
  assert.equal(withPr.pr, 435);
  const siblingNamed = r.family.some((c) => c.ids.includes('bc-42ow.3'));
  assert.ok(siblingNamed, 'bc-42ow.3 shows up in the family search');
});

/* ---------------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} checks passed`);
process.exit(failures ? 1 : 0);
