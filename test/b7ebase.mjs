#!/usr/bin/env node
//
// b7e-base — is this branch based on current main, and what has landed under it since
// (bc-36xx.25).
//
//   npm test
//   node test/b7ebase.mjs
//
// Real `git init`/`clone`/`commit` throughout, same argument test/b7eworktree.mjs and
// test/siblings.mjs make: the whole point of this tool is what `git fetch`, `git
// rev-list` and `git diff` actually report against a real remote-tracking ref, and a
// fake filesystem would only prove the parser can read strings this file wrote. In
// particular test 4 below (a local `main` ahead of `origin/main`) is exactly the shape
// that fooled bc-bmry.8 by hand — it only means anything against a real clone with a
// real `origin` remote.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-base');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ebase-'));

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

/** A real `git clone` of `origin` — the only way to get a real `origin` remote. */
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

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

/* ================================================================= 1. current */

console.log('\na branch with nothing landed underneath it is current\n');

{
  const origin = makeOrigin('origin1');
  const work = cloneWork(origin, 'work1');
  git(work, 'checkout', '-q', '-b', 'feature');

  const r = run(work);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says current with origin/main', /feature is current with origin\/main/.test(r.stdout), r.stdout);
}

/* ================================================================== 2. behind */

console.log('\na main that has since moved is reported as behind, with what landed\n');

{
  const origin = makeOrigin('origin2');
  const work = cloneWork(origin, 'work2');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(origin, 'added.txt', 'b\n', 'add b');

  const r = run(work);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says behind by 1 commit', /behind by 1 commit/.test(r.stdout), r.stdout);
  check('names the commit that landed', /add b/.test(r.stdout), r.stdout);
  // A pure "behind" branch has no commits of its own yet, so there is structurally
  // nothing for the landed file to overlap with — see test 3 for a branch that does
  // have its own commits, where the overlap is the whole point.
  check('says this branch touches none of the landed files yet', /touches none of them yet/.test(r.stdout), r.stdout);

  // Same question, without a fetch — a stale `git log -1 origin/main` (no fetch first) is
  // exactly what all seven of bc-36xx.25's non-fetching sessions did, and it must not see
  // the commit that only exists on the real remote until something actually fetches.
  const origin2b = makeOrigin('origin2b');
  const work2b = cloneWork(origin2b, 'work2b');
  git(work2b, 'checkout', '-q', '-b', 'feature');
  commitFile(origin2b, 'added.txt', 'b\n', 'add b');
  const stale = run(work2b, ['--no-fetch']);
  check('--no-fetch alone (no prior fetch) does not see what only origin has', /is current/.test(stale.stdout), stale.stdout);
}

/* ============================================================== 3. diverged */

console.log('\ndiverged: both sides have commits, and the file overlap is called out\n');

{
  const origin = makeOrigin('origin3');
  const work = cloneWork(origin, 'work3');
  git(work, 'checkout', '-q', '-b', 'feature');

  // The branch's own commits — one touching the file main will also touch, one that is
  // entirely its own business.
  commitFile(work, 'shared.txt', 'one\ntwo (branch)\n', 'branch touches shared');
  commitFile(work, 'onlyBranch.txt', 'x\n', 'branch-only file');

  // main moves on with its own commits — one touching the same shared file, one that
  // never comes near anything the branch touched.
  commitFile(origin, 'shared.txt', 'one\ntwo (main)\n', 'main touches shared');
  commitFile(origin, 'onlyMain.txt', 'y\n', 'main-only file');

  const r = run(work);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says diverged, 2 ahead 2 behind', /diverged — 2 ahead, 2 behind/.test(r.stdout), r.stdout);
  check('names both commits that landed on main', /main touches shared/.test(r.stdout) && /main-only file/.test(r.stdout), r.stdout);
  check('the overlap names shared.txt', /shared\.txt/.test(r.stdout), r.stdout);
  check(
    'the overlap never names onlyMain.txt or onlyBranch.txt — only the file both sides touched',
    !/onlyMain\.txt/.test(r.stdout) && !/onlyBranch\.txt/.test(r.stdout),
    r.stdout
  );

  const j = run(work, ['--json']);
  const parsed = JSON.parse(j.stdout);
  check('json: state diverged', parsed.state === 'diverged', JSON.stringify(parsed));
  check('json: ahead 2, behind 2', parsed.ahead === 2 && parsed.behind === 2, JSON.stringify(parsed));
  check('json: overlap is exactly [shared.txt]', JSON.stringify(parsed.overlap) === JSON.stringify(['shared.txt']), JSON.stringify(parsed.overlap));
  check(
    'json: landedFiles carries both main-side files',
    parsed.landedFiles.includes('shared.txt') && parsed.landedFiles.includes('onlyMain.txt'),
    JSON.stringify(parsed.landedFiles)
  );
  check(
    'json: branchFiles carries both branch-side files',
    parsed.branchFiles.includes('shared.txt') && parsed.branchFiles.includes('onlyBranch.txt'),
    JSON.stringify(parsed.branchFiles)
  );
}

/* ================================================ 4. local main ahead (bc-bmry.8) */

console.log('\na local main ahead of origin/main is never read as something that landed\n');

{
  const origin = makeOrigin('origin4');
  const work = cloneWork(origin, 'work4');
  git(work, 'checkout', '-q', '-b', 'feature');

  // A commit made directly on this checkout's local `main`, never pushed anywhere —
  // exactly what bc-bmry.8's `git log --oneline -1 main` read as "up to date" over.
  git(work, 'checkout', '-q', 'main');
  commitFile(work, 'local-only.txt', 'z\n', 'local-only commit on main, never pushed');
  git(work, 'checkout', '-q', 'feature');

  const r = run(work);
  check('exits 0 — origin/main has not moved', r.status === 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('reports current, not behind', /is current with origin\/main/.test(r.stdout), r.stdout);
  check('never names the local-only commit as something that landed', !/local-only/.test(r.stdout), r.stdout);
}

/* ======================================================= 5. --no-fetch after a fetch */

console.log('\n--no-fetch immediately after a real fetch gives the same answer\n');

{
  const origin = makeOrigin('origin5');
  const work = cloneWork(origin, 'work5');
  git(work, 'checkout', '-q', '-b', 'feature');
  commitFile(origin, 'added.txt', 'b\n', 'add b');

  const withFetch = run(work);
  const withoutFetch = run(work, ['--no-fetch']);
  check('both exit 1', withFetch.status === 1 && withoutFetch.status === 1, `${withFetch.status} / ${withoutFetch.status}`);
  check(
    '--no-fetch reports the same behind-by-1 the real fetch just cached',
    /behind by 1 commit/.test(withFetch.stdout) && /behind by 1 commit/.test(withoutFetch.stdout),
    `${withFetch.stdout}\n---\n${withoutFetch.stdout}`
  );
}

/* ========================================================== 6. --base <ref> */

console.log('\n--base compares against a ref other than main\n');

{
  const origin = makeOrigin('origin6');
  git(origin, 'checkout', '-q', '-b', 'develop');
  commitFile(origin, 'dev-only.txt', 'd\n', 'develop-only commit');
  git(origin, 'checkout', '-q', 'main');

  const work = cloneWork(origin, 'work6');
  git(work, 'checkout', '-q', '-b', 'feature', 'origin/develop');
  git(origin, 'checkout', '-q', 'develop');
  commitFile(origin, 'dev-2.txt', 'd2\n', 'a second develop commit');

  const r = run(work, ['--base', 'develop']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('compares against origin/develop', /vs origin\/develop/.test(r.stdout), r.stdout);
  check('behind by 1 (the second develop commit only)', /behind by 1 commit/.test(r.stdout), r.stdout);
}

/* ============================================================ 7. bad usage */

console.log('\nbad usage and non-repos are refused, not miscounted\n');

{
  const notARepo = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(notARepo, { recursive: true });
  const r = run(notARepo);
  check('exits 2 outside a git checkout', r.status === 2, `status ${r.status}\n${r.stderr}`);
  check('says why', /not a git checkout/.test(r.stderr), r.stderr);

  const origin = makeOrigin('origin7');
  const work = cloneWork(origin, 'work7');
  const ghost = run(work, ['--base', 'ghost-branch-nobody-made']);
  check('exits 2 when the named base exists nowhere', ghost.status === 2, `status ${ghost.status}\n${ghost.stderr}`);
  check('says there is nothing to compare against', /nothing to compare against/.test(ghost.stderr), ghost.stderr);
}

/* ============================================================== 8. --help */

console.log('\n--help says how to call it\n');

{
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  check('exits 0', r.status === 0, `status ${r.status}`);
  check('prints usage', /b7e-base/.test(r.stdout), r.stdout);
}

/* ---------------------------------------------------------------- verdict */

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
