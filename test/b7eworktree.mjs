#!/usr/bin/env node
//
// b7e-worktree — make a fresh worktree runnable in one call (bc-khoe.41).
//
//   npm test
//   node test/b7eworktree.mjs
//
// Real `git worktree add` in a temp directory throughout, the same argument
// test/atticcli.mjs makes for the sibling tool: worktree semantics — a linked
// worktree sharing refs with its main checkout, `.gitignore` patterns with no
// trailing slash matching both a real directory and the symlinks inside it — are
// the subject, and a fake filesystem would only agree with whatever the code
// under test assumed. It runs `scripts/vendor.js` for real too, copied from this
// repo's own copy rather than reimplemented, so a change to its contract fails
// this suite rather than going unnoticed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-worktree');

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- fixtures */

/** git with an identity of its own, so this never depends on the machine's. */
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

const BUNDLE_FILES = ['marked.js', 'purify.js', 'mermaid.js', 'd3.js', 'xterm.js', 'xterm.css', 'xterm-addon-fit.js'];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eworktree-'));

/**
 * A main checkout: `.gitignore` for `node_modules`/`public/vendor` exactly as this repo's
 * own does (no trailing slash — bc-slxm), a real `node_modules` and a built
 * `public/vendor`, and this repo's own `scripts/vendor.js` so the borrow logic under test
 * is the real thing.
 */
function makeMainRepo(name) {
  const main = path.join(tmp, name);
  fs.mkdirSync(path.join(main, 'node_modules'), { recursive: true });
  fs.mkdirSync(path.join(main, 'public', 'vendor'), { recursive: true });
  fs.mkdirSync(path.join(main, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(main, '.gitignore'), 'node_modules\npublic/vendor\n');
  fs.writeFileSync(path.join(main, 'node_modules', 'dummy.txt'), 'x\n');
  for (const f of BUNDLE_FILES) fs.writeFileSync(path.join(main, 'public', 'vendor', f), 'content\n');
  fs.copyFileSync(path.join(ROOT, 'scripts', 'vendor.js'), path.join(main, 'scripts', 'vendor.js'));
  fs.writeFileSync(path.join(main, 'file.txt'), 'one\n');
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'add', '-A');
  git(main, 'commit', '-q', '-m', 'init');
  return main;
}

/** A linked worktree with `node_modules`/`public/vendor` stripped, the way EnterWorktree leaves one. */
function makeFreshWorktree(main, name) {
  const dir = path.join(main, '.claude', 'worktrees', name);
  git(main, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir, 'HEAD');
  fs.rmSync(path.join(dir, 'node_modules'), { recursive: true, force: true });
  fs.rmSync(path.join(dir, 'public', 'vendor'), { recursive: true, force: true });
  return dir;
}

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
const symlinkTargets = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => fs.lstatSync(path.join(dir, f)).isSymbolicLink())
    .sort();

/* ============================================================= 1. --check */

console.log('\n--check reports without changing anything\n');

{
  const main = makeMainRepo('check-only');
  const wt = makeFreshWorktree(main, 'wt');
  const r = run(wt, ['--check']);
  check('exits 0 on a fresh worktree — nothing is behind yet', r.status === 0, `status ${r.status}\n${r.stderr}`);
  check('reports node_modules missing', /node_modules missing/.test(r.stdout), r.stdout);
  check('reports 0/7 bundles present', /0\/7 bundles present/.test(r.stdout), r.stdout);
  check('does not create node_modules', !fs.existsSync(path.join(wt, 'node_modules')));
  check('does not create public/vendor', !fs.existsSync(path.join(wt, 'public', 'vendor')));
}

/* ================================================== 2. the real run, and acceptance */

console.log('\na real run leaves the worktree runnable\n');

{
  const main = makeMainRepo('for-real');
  const wt = makeFreshWorktree(main, 'wt');
  const r = run(wt);
  check('exits 0', r.status === 0, `status ${r.status}\n${r.stdout}\n${r.stderr}`);

  const nmStat = fs.lstatSync(path.join(wt, 'node_modules'));
  check('node_modules is a symlink, never a copy (bc-mf9s)', nmStat.isSymbolicLink());
  check(
    'node_modules resolves to the main checkout',
    fs.realpathSync(path.join(wt, 'node_modules')) === fs.realpathSync(path.join(main, 'node_modules')),
  );

  const vendorDir = path.join(wt, 'public', 'vendor');
  check('public/vendor is a real directory, never a symlinked one (bc-slxm, bc-0i27.25)', !fs.lstatSync(vendorDir).isSymbolicLink());
  const links = symlinkTargets(vendorDir);
  check('and it holds all seven bundles, each a link', links.length === 7, links.join(', '));
  check('nothing under public/vendor is a plain copy', BUNDLE_FILES.every((f) => fs.lstatSync(path.join(vendorDir, f)).isSymbolicLink()));

  const status = git(wt, 'status', '--short').trim();
  check('git status --short is clean', status === '', status);

  console.log('\nrunning it twice changes nothing the second time\n');
  const r2 = run(wt);
  check('second run also exits 0', r2.status === 0, `status ${r2.status}\n${r2.stderr}`);
  check('reports node_modules already linked', /node_modules already linked/.test(r2.stdout), r2.stdout);
  const status2 = git(wt, 'status', '--short').trim();
  check('git status --short is still clean', status2 === '', status2);
}

/* ============================================== 3. a real node_modules is left alone */

console.log("\na worktree that already installed its own node_modules is warned, not overwritten\n");

{
  const main = makeMainRepo('real-nm');
  const wt = makeFreshWorktree(main, 'wt');
  fs.mkdirSync(path.join(wt, 'node_modules'));
  fs.writeFileSync(path.join(wt, 'node_modules', 'installed.txt'), 'a real install\n');
  const r = run(wt);
  check('exits 0 — a real node_modules is not itself a failure', r.status === 0, `status ${r.status}\n${r.stderr}`);
  check('warns about it', /real directory here/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  check('leaves it as a real directory rather than replacing it', fs.lstatSync(path.join(wt, 'node_modules')).isDirectory() && !fs.lstatSync(path.join(wt, 'node_modules')).isSymbolicLink());
  check('and does not delete what was installed', fs.existsSync(path.join(wt, 'node_modules', 'installed.txt')));
}

/* ===================================================== 4. behind local main */

console.log('\nbehind local main is named, and fails the run\n');

{
  const main = makeMainRepo('behind');
  const wt = makeFreshWorktree(main, 'wt');
  run(wt); // set up cleanly first
  fs.appendFileSync(path.join(main, 'file.txt'), 'two\n');
  // Not `-A`: the worktree already exists under `.claude/worktrees/`, and re-scanning
  // the whole tree from the main checkout — which nothing in real use ever does once a
  // worktree is live — trips git's embedded-repository warning on it.
  git(main, 'add', 'file.txt');
  git(main, 'commit', '-q', '-m', 'advance main');

  const r = run(wt, ['--check']);
  check('exits 1', r.status === 1, `status ${r.status}\n${r.stdout}\n${r.stderr}`);
  check('says it is behind local main', /behind local main/.test(r.stdout + r.stderr), r.stdout + r.stderr);
  check('names git reset --hard main as the fix, without running it itself', /git reset --hard main/.test(r.stdout + r.stderr));
  check('main has not been reset out from under the worktree', git(wt, 'log', '--oneline', '-1').trim() !== git(main, 'log', '--oneline', '-1').trim());
}

/* =================================================== 5. refused outside a worktree */

console.log('\nrefuses outside a .claude/worktrees/<name> checkout\n');

{
  const main = makeMainRepo('outside');
  const r = run(main);
  check('exits 2', r.status === 2, `status ${r.status}`);
  check('says why', /not inside a \.claude\/worktrees/.test(r.stderr), r.stderr);
  check(
    'touches nothing — node_modules is still the real one this main checkout committed',
    fs.existsSync(path.join(main, 'node_modules', 'dummy.txt')) && !fs.lstatSync(path.join(main, 'node_modules')).isSymbolicLink(),
  );
}

/* ============================================================ 6. --help / bare usage */

console.log('\n--help says how to call it\n');

{
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  check('exits 0', r.status === 0, `status ${r.status}`);
  check('prints usage', /b7e-worktree/.test(r.stdout), r.stdout);
}

/* ---------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : '\n\x1b[32mall checks passed\x1b[0m\n');
process.exit(failures ? 1 : 0);
