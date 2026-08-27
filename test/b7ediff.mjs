#!/usr/bin/env node
//
// b7e-diff — what this branch actually delivers, against its own merge base and
// nobody else's (bc-dgx7.17).
//
//   npm test
//   node test/b7ediff.mjs
//
// Real `git init`/`commit`/`reset` throughout, the same argument test/b7ebase.mjs
// makes: the whole point is what a real `git status`, `git diff --name-only` and
// `git reset --soft` actually produce, and a fake filesystem would only prove the
// parser can read strings this file wrote. Test 4 in particular reproduces the
// sp-weu failure the bead describes almost exactly: a `git reset --soft main` that
// picks up another branch's already-merged work as uncommitted changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-diff');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${String(detail).split('\n').join('\n      ')}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

/** git with an identity of its own, so this never depends on the machine's. */
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ediff-'));

/** A one-commit repo on `main`, ready for a branch to fork off it. */
function makeRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

function commitFile(dir, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

/* ============================================================= 1. clean branch */

console.log('\na branch with its own commits and nothing uncommitted is clean\n');

{
  const repo = makeRepo('repo1');
  git(repo, 'checkout', '-q', '-b', 'feature');
  commitFile(repo, 'own.txt', 'a\n', 'branch-only commit');

  const r = run(repo);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('names its own commit', /branch-only commit/.test(r.stdout), r.stdout);
  check('names own.txt in the file list', /own\.txt/.test(r.stdout), r.stdout);
  check('says nothing is orphaned', /no uncommitted path is orphaned/.test(r.stdout), r.stdout);
  check('says main has not moved', /has not moved past the merge-base/.test(r.stdout), r.stdout);

  const j = run(repo, ['--json']);
  const parsed = JSON.parse(j.stdout);
  check('json: baseAdvancedBy is 0', parsed.baseAdvancedBy === 0, JSON.stringify(parsed));
  check('json: files is [own.txt]', JSON.stringify(parsed.files) === JSON.stringify(['own.txt']), JSON.stringify(parsed.files));
  check('json: uncommittedUnauthored is empty', parsed.uncommittedUnauthored.length === 0, JSON.stringify(parsed));
}

/* ==================================================== 2. an honest uncommitted edit */

console.log('\nan uncommitted edit to a file this branch already committed is not orphaned\n');

{
  const repo = makeRepo('repo2');
  git(repo, 'checkout', '-q', '-b', 'feature');
  commitFile(repo, 'own.txt', 'a\n', 'branch-only commit');
  fs.appendFileSync(path.join(repo, 'own.txt'), 'more\n');

  const r = run(repo);
  check('exits 0 — own.txt already belongs to a commit on this branch', r.status === 0, `status ${r.status}\n${r.stdout}`);
}

/* ======================================= 3. a genuinely foreign uncommitted file */

console.log('\nan uncommitted file no commit on this branch ever touched is named and fails\n');

{
  const repo = makeRepo('repo3');
  git(repo, 'checkout', '-q', '-b', 'feature');
  commitFile(repo, 'own.txt', 'a\n', 'branch-only commit');
  // Never committed on this branch — dropped straight into the working tree.
  fs.writeFileSync(path.join(repo, 'stray.txt'), 'nobody committed this\n');

  const r = run(repo);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}`);
  check('names stray.txt as orphaned', /stray\.txt/.test(r.stdout), r.stdout);
  check('does not also name own.txt as orphaned', !new RegExp('own\\.txt\\n').test(r.stdout.split('orphaned')[1] || ''), r.stdout);

  const j = run(repo, ['--json']);
  const parsed = JSON.parse(j.stdout);
  check('json: uncommittedUnauthored is exactly [stray.txt]', JSON.stringify(parsed.uncommittedUnauthored) === JSON.stringify(['stray.txt']), JSON.stringify(parsed));
}

/* ==================================================== 4. the sp-weu reproduction */

console.log("\nsp-weu's own failure: a soft reset onto a moved main picks up another branch's work\n");

{
  const repo = makeRepo('repo4');

  // Another branch's work lands on main first — this is what sp-weu's checkout
  // would see as "already merged" by the time it went to squash.
  git(repo, 'checkout', '-q', '-b', 'other-branch');
  commitFile(repo, 'costing.py', 'other work\n', "someone else's merged commit");
  git(repo, 'checkout', '-q', 'main');
  git(repo, 'merge', '-q', '--no-ff', 'other-branch', '-m', 'merge other-branch');
  const beforeMerge = git(repo, 'rev-parse', 'main~1');

  // sp-weu forked before that merge landed, made its own real commit...
  git(repo, 'checkout', '-q', '-b', 'sp-weu');
  git(repo, 'reset', '-q', '--hard', beforeMerge); // fork point: before the merge above
  commitFile(repo, 'my-real-change.txt', 'sp-weu wrote this\n', 'sp-weu real commit 1');

  // ...then squashed with `git reset --soft main` — the bug. Reset all the way onto
  // main's current tip, not onto the fork point, so main's own merge commit (and the
  // file it carried) lands in the working tree as if sp-weu had written it.
  git(repo, 'reset', '-q', '--soft', 'main');

  const bug = run(repo);
  check('exits 1 — nothing is committed yet, so nothing can be told apart', bug.status === 1, `status ${bug.status}\n${bug.stdout}`);
  check('names costing.py — the file main only has because of the other branch\'s merge', /costing\.py/.test(bug.stdout), bug.stdout);
  check("also names sp-weu's own file: with zero commits on the branch, nothing can be trusted yet", /my-real-change\.txt/.test(bug.stdout), bug.stdout);
  check('this branch has 0 commits of its own — reset --soft main moved HEAD to main itself', /0 commits of this branch's own/.test(bug.stdout), bug.stdout);

  // The actual fix the bead describes: reset to the merge-base, not to main's current
  // tip, then commit only the files that are genuinely this branch's own. Once that is
  // done there is a real commit to attribute my-real-change.txt to, and costing.py is
  // not even in the working tree any more (it never came from a commit sp-weu made).
  git(repo, 'reset', '-q', '--hard', beforeMerge);
  commitFile(repo, 'my-real-change.txt', 'sp-weu wrote this\n', 'sp-weu real commit 1, recommitted at the true merge-base');

  const fixed = run(repo);
  check('fixed: exits 0', fixed.status === 0, `status ${fixed.status}\n${fixed.stdout}`);
  check('fixed: says nothing is orphaned', /no uncommitted path is orphaned/.test(fixed.stdout), fixed.stdout);
  check('fixed: costing.py is gone from the report entirely', !/costing\.py/.test(fixed.stdout), fixed.stdout);
}

/* ========================================================= 5. --base <ref> */

console.log('\n--base compares against a ref other than main\n');

{
  const repo = makeRepo('repo5');
  git(repo, 'checkout', '-q', '-b', 'develop');
  commitFile(repo, 'dev.txt', 'd\n', 'develop commit');
  git(repo, 'checkout', '-q', '-b', 'feature', 'develop');
  commitFile(repo, 'own.txt', 'a\n', 'branch commit off develop');
  git(repo, 'checkout', '-q', 'develop');
  commitFile(repo, 'dev-2.txt', 'd2\n', 'a second develop commit');
  git(repo, 'checkout', '-q', 'feature');

  const r = run(repo, ['--base', 'develop']);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stdout}`);
  check('compares against develop', /vs develop/.test(r.stdout), r.stdout);
  check('develop has advanced by 1 commit', /develop has advanced 1 commit/.test(r.stdout), r.stdout);
  check('only this branch\'s own commit is listed', /branch commit off develop/.test(r.stdout) && !/a second develop commit/.test(r.stdout), r.stdout);
}

/* ============================================================== 6. bad usage */

console.log('\nbad usage and a missing base ref are refused, not miscounted\n');

{
  const notARepo = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(notARepo, { recursive: true });
  const r = run(notARepo);
  check('exits 2 outside a git checkout', r.status === 2, `status ${r.status}\n${r.stderr}`);
  check('says why', /not a git checkout/.test(r.stderr), r.stderr);

  const repo = makeRepo('repo6');
  git(repo, 'checkout', '-q', '-b', 'feature');
  const ghost = run(repo, ['--base', 'ghost-branch-nobody-made']);
  check('exits 2 when the named base exists nowhere', ghost.status === 2, `status ${ghost.status}\n${ghost.stderr}`);
  check('says no such ref', /no such ref/.test(ghost.stderr), ghost.stderr);

  // --base never falls back to origin/<ref> — a local-only name that does not exist
  // is refused even if some remote-tracking ref of the same short name might.
  git(repo, 'remote', 'add', 'origin', repo);
  git(repo, 'update-ref', 'refs/remotes/origin/ghost-branch-nobody-made', 'HEAD');
  const stillGhost = run(repo, ['--base', 'ghost-branch-nobody-made']);
  check('still refused — no origin fallback for --base', stillGhost.status === 2, `status ${stillGhost.status}\n${stillGhost.stderr}`);
}

/* ============================================================== 7. --help */

console.log('\n--help says how to call it\n');

{
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  check('exits 0', r.status === 0, `status ${r.status}`);
  check('prints usage', /b7e-diff/.test(r.stdout), r.stdout);
}

/* ---------------------------------------------------------------- verdict */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
