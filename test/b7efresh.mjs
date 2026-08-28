#!/usr/bin/env node
//
// b7e-fresh — is my worktree's base current, and what will actually land (bc-dgx7.127).
//
//   npm test
//   node test/b7efresh.mjs
//
// Real `git init`/`clone`/`commit`/`cherry-pick` throughout, same argument test/b7ebase.mjs
// and test/b7edeliverbase.mjs make for the two tools this one combines: the whole point is
// what `git fetch`, `git rev-list`, `git diff` and `git patch-id` actually report against a
// real remote-tracking ref and real branch history, not strings this file wrote by hand. A
// config fixture stands in for `~/.config/beadcause` via `BEADCAUSE_CONFIG_DIR`, matching
// test/b7edeliverbase.mjs's shape.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-fresh');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7efresh-'));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
const HOME = path.join(tmp, 'home');
fs.mkdirSync(HOME, { recursive: true });

/** A one-commit repo on `main`, ready to be cloned as an `origin`. */
function makeOrigin(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'shared.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/** A real `git clone` of `origin`. */
function cloneWork(origin, name) {
  const dir = path.join(tmp, name);
  git(tmp, 'clone', '-q', origin, dir);
  return dir;
}

function commitFile(dir, file, content, message) {
  fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
  fs.writeFileSync(path.join(dir, file), content);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', message);
}

/** Writes a config naming exactly the workspaces given. */
function writeConfig(workspaces, pr = { enabled: true, base: 'main' }) {
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ workspaces, pr }, null, 2));
}
// No config at all by default — most tests here are single-repo, cwd-only, and should
// work with zero beadcause configuration present, the same as `b7e-base` does standalone.
writeConfig([]);

const run = (cwd, args = []) => {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, HOME, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
};

/* ================================================================= 1. current */

console.log('\na branch with nothing landed underneath it is current\n');

{
  const origin = makeOrigin('origin1');
  const work = cloneWork(origin, 'work1');
  git(work, 'checkout', '-q', '-b', 'feature');

  const r = run(work, ['--no-provenance']);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says current with origin/main', /feature is current with origin\/main/.test(r.stdout), r.stdout);
}

/* ==================================================== 2. behind, with the reset command */

console.log('\na main that has since moved is reported behind, with the reset command, exit 1\n');

{
  const origin = makeOrigin('origin2');
  const work = cloneWork(origin, 'work2');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(origin, 'added.txt', 'b\n', 'add b');

  const r = run(work, ['--no-provenance']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says behind by 1 commit', /behind by 1 commit/.test(r.stdout), r.stdout);
  check('names the commit that landed', /add b/.test(r.stdout), r.stdout);
  check('prints the exact reset command', /reset: git merge --ff-only origin\/main/.test(r.stdout), r.stdout);
}

/* ============================================================ 3. --reset: behind -> current */

console.log('\n--reset fast-forwards a behind branch with a clean tree, exit 0\n');

{
  const origin = makeOrigin('origin3');
  const work = cloneWork(origin, 'work3');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(origin, 'added.txt', 'b\n', 'add b');

  const before = run(work, ['--no-provenance']);
  check('before: exits 1 (behind)', before.status === 1, before.stdout);

  const reset = run(work, ['--no-provenance', '--reset']);
  check('--reset exits 0', reset.status === 0, `status ${reset.status}\n${reset.stdout}\n${reset.stderr}`);
  check('says fast-forwarded', /--reset: fast-forwarded/.test(reset.stdout), reset.stdout);
  check('added.txt now exists in the worktree', fs.existsSync(path.join(work, 'added.txt')), '');

  const after = run(work, ['--no-provenance']);
  check('after: exits 0 (current)', after.status === 0, after.stdout);
}

/* ==================================================== 4. --reset refuses a dirty tree */

console.log('\n--reset refuses over uncommitted changes, exit 2\n');

{
  const origin = makeOrigin('origin4');
  const work = cloneWork(origin, 'work4');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(origin, 'added.txt', 'b\n', 'add b');
  fs.writeFileSync(path.join(work, 'uncommitted.txt'), 'oops\n');

  const r = run(work, ['--no-provenance', '--reset']);
  check('exits 2', r.status === 2, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('refuses, names the reason', /refused — working tree is not clean/.test(r.stdout), r.stdout);
  check('the fetched commit was not applied', !fs.existsSync(path.join(work, 'added.txt')), '');
}

/* ================================================== 5. --reset refuses a real divergence */

console.log('\n--reset refuses a genuine divergence rather than discarding this branch\'s own commits\n');

{
  const origin = makeOrigin('origin5');
  const work = cloneWork(origin, 'work5');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(work, 'mine.txt', 'x\n', 'my own commit');
  commitFile(origin, 'added.txt', 'b\n', 'add b');

  const r = run(work, ['--no-provenance', '--reset']);
  check('exits 2', r.status === 2, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says diverged, refuses to discard', /refused — diverged/.test(r.stdout), r.stdout);
  check('the branch commit is untouched', fs.existsSync(path.join(work, 'mine.txt')), '');
}

/* ============================================ 6. cherry-picked-in commit split from own work */

console.log("\na commit cherry-picked -x from another branch is listed apart from this branch's own work\n");

{
  const origin = makeOrigin('origin6');
  const work = cloneWork(origin, 'work6');

  // A stranded branch elsewhere in the same checkout, with a commit of its own.
  git(work, 'checkout', '-q', '-b', 'stranded');
  commitFile(work, 'salvaged.txt', 's\n', 'work worth keeping');
  const strandedSha = git(work, 'rev-parse', 'HEAD');

  // The branch under test: its own commit, plus that one cherry-picked in with -x.
  git(work, 'checkout', '-q', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(work, 'mine.txt', 'm\n', 'authored on this branch');
  git(work, 'cherry-pick', '-x', strandedSha);

  const r = run(work);
  check('exits 0 — nothing landed on main, this branch just has its own commits', r.status === 0, r.stdout);
  check('lists the authored-here commit as authored-here', /authored on this branch\s+\[authored-here\]/.test(r.stdout), r.stdout);
  check(
    'lists the cherry-picked commit separately, naming its source and "trailer"',
    new RegExp(`work worth keeping\\s+\\[cherry-picked from ${strandedSha.slice(0, 8)}, by trailer\\]`).test(r.stdout),
    r.stdout
  );
  check('the delivered file list carries both files', /mine\.txt/.test(r.stdout) && /salvaged\.txt/.test(r.stdout), r.stdout);

  const j = run(work, ['--json']);
  const parsed = JSON.parse(j.stdout);
  const authored = parsed.provenance.find((p) => p.subject === 'authored on this branch');
  const picked = parsed.provenance.find((p) => p.subject === 'work worth keeping');
  check('json: authored-here commit tagged so', authored?.from === 'authored-here', JSON.stringify(authored));
  check('json: cherry-picked commit tagged so, source sha matches, via trailer', picked?.from === 'cherry-picked' && picked.source === strandedSha && picked.via === 'trailer', JSON.stringify(picked));
  check(
    'json: branchFiles is exactly the file list deliver.js would push',
    JSON.stringify([...parsed.branchFiles].sort()) === JSON.stringify(['mine.txt', 'salvaged.txt']),
    JSON.stringify(parsed.branchFiles)
  );
}

/* ==================================== 7. cherry-picked without -x, found by patch-id */

console.log('\na plain cherry-pick (no -x, no trailer) is still caught, by patch-id against another local branch\n');

{
  const origin = makeOrigin('origin7');
  const work = cloneWork(origin, 'work7');

  git(work, 'checkout', '-q', '-b', 'stranded');
  commitFile(work, 'salvaged2.txt', 's\n', 'more work worth keeping');
  const strandedSha = git(work, 'rev-parse', 'HEAD');

  git(work, 'checkout', '-q', 'main');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(work, 'mine2.txt', 'm\n', 'authored on this branch too');
  git(work, 'cherry-pick', strandedSha); // no -x: no trailer, identical patch under a new sha

  const r = run(work);
  check(
    'lists it as cherry-picked, this time "by patch-id" and naming the source branch',
    new RegExp('more work worth keeping\\s+\\[cherry-picked from [0-9a-f]{8} on stranded, by patch-id\\]').test(r.stdout),
    r.stdout
  );

  // --no-provenance skips the scan: the same commit reads as authored-here instead, and
  // costs nothing walking every other local branch's history.
  const skip = run(work, ['--no-provenance']);
  check('--no-provenance: falls back to authored-here (trailer-only)', /more work worth keeping\s+\[authored-here\]/.test(skip.stdout), skip.stdout);
}

/* ======================================================= 8. -w resolves via baseFor */

console.log('\n-w <workspace> resolves the base the way a real delivery would, not a literal default\n');

{
  const origin = makeOrigin('origin8');
  git(origin, 'checkout', '-q', '-b', 'develop');
  commitFile(origin, 'dev-only.txt', 'd\n', 'develop-only commit');
  git(origin, 'checkout', '-q', 'main');

  const work = cloneWork(origin, 'work8');
  fs.mkdirSync(path.join(work, '.beads'), { recursive: true });
  git(work, 'checkout', '-q', '-b', 'feature', 'origin/develop');
  git(origin, 'checkout', '-q', 'develop');
  commitFile(origin, 'dev-2.txt', 'd2\n', 'a second develop commit');

  const ws = { name: 'w8', dir: path.join(work, '.beads') };
  writeConfig([ws], { enabled: true, basePerWorkspace: { w8: 'develop' } });

  const r = run(work, ['-w', 'w8', '--no-provenance']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('compares against origin/develop, not the literal main default', /vs origin\/develop/.test(r.stdout), r.stdout);
  check('behind by 1 (the second develop commit only)', /behind by 1 commit/.test(r.stdout), r.stdout);

  writeConfig([]); // restore the empty default for later tests
}

/* ============================================================ 9. --base overrides everything */

console.log('\n--base is a literal ref and wins over any workspace resolution\n');

{
  const origin = makeOrigin('origin9');
  git(origin, 'checkout', '-q', '-b', 'develop');
  commitFile(origin, 'dev-only.txt', 'd\n', 'develop-only commit');
  git(origin, 'checkout', '-q', 'main');

  const work = cloneWork(origin, 'work9');
  git(work, 'checkout', '-q', '-b', 'feature', 'origin/develop');
  git(origin, 'checkout', '-q', 'develop');
  commitFile(origin, 'dev-2.txt', 'd2\n', 'a second develop commit');

  const r = run(work, ['--base', 'develop', '--no-provenance']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('compares against origin/develop', /vs origin\/develop/.test(r.stdout), r.stdout);
}

/* ============================================================ 10. bad usage */

console.log('\nbad usage and non-repos are refused, not miscounted\n');

{
  const notARepo = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(notARepo, { recursive: true });
  const r = run(notARepo);
  check('exits 2 outside a git checkout', r.status === 2, `status ${r.status}\n${r.stderr}`);
  check('says why', /not a git checkout/.test(r.stderr), r.stderr);

  const origin = makeOrigin('origin10');
  const work = cloneWork(origin, 'work10');
  const ghost = run(work, ['--base', 'ghost-branch-nobody-made']);
  check('exits 2 when the named base exists nowhere', ghost.status === 2, `status ${ghost.status}\n${ghost.stderr}`);
  check('says there is nothing to compare against', /nothing to compare against/.test(ghost.stderr), ghost.stderr);
}

/* ============================================================== 11. --help */

console.log('\n--help says how to call it\n');

{
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  check('exits 0', r.status === 0, `status ${r.status}`);
  check('prints usage', /b7e-fresh/.test(r.stdout), r.stdout);
}

/* ---------------------------------------------------------------- verdict */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
