#!/usr/bin/env node
//
// b7e-run — run THIS checkout's own bin/ command, not whichever copy PATH found
// (bc-dgx7.87).
//
//   npm test
//   node test/b7erun.mjs
//
// lib/run.js's repoRoot()/targetFor()/resolveOnPath()/divergenceWarning() are pure and
// tested directly. The rest drives the real bin/b7e-run against fabricated git repos —
// each a "checkout" with its own bin/<name> fixture command — the only way to prove the
// resolution actually depends on the calling process's OWN cwd rather than this file's,
// and that a same-named file elsewhere on PATH never gets run instead.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';
import { repoRoot, targetFor, resolveOnPath, divergenceWarning } from '../lib/run.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-run');

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7erun-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A real git repo at `<tmp>/<name>` — enough for `git rev-parse --show-toplevel` to
 * resolve it, with a `bin/` holding whatever fixture files `files` names. */
function repo(name, files = {}) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
    if (rel.startsWith('bin/')) fs.chmodSync(full, 0o755);
  }
  return dir;
}

/** A fixture command: prints `marker` on stdout, `marker-err` on stderr, and exits `code`. */
const probeScript = (marker, code = 0) => `#!/usr/bin/env node
console.log(${JSON.stringify(marker)});
console.error(${JSON.stringify(`${marker}-err`)});
process.exit(${code});
`;

/* ===================================================================== *
 * lib/run.js — pure
 * ===================================================================== */

console.log('\nlib/run.js\n');

check('repoRoot(cwd) resolves the repo the given cwd is actually in, not this file\'s own', () => {
  const dir = repo('plain-repo');
  assert.equal(fs.realpathSync(repoRoot(dir)), fs.realpathSync(dir));
});

check('repoRoot falls back to this checkout when cwd is not inside any git repo', () => {
  const outside = fs.mkdtempSync(path.join(tmp, 'no-git-'));
  assert.equal(fs.realpathSync(repoRoot(outside)), fs.realpathSync(ROOT));
});

check('targetFor is exactly <root>/bin/<command>, no extension guessing', () => {
  assert.equal(targetFor('/x', 'b7e-gate'), path.join('/x', 'bin', 'b7e-gate'));
  assert.equal(targetFor('/x', 'b7e-owes.js'), path.join('/x', 'bin', 'b7e-owes.js'));
});

check('resolveOnPath finds the first directory on PATH holding that file', () => {
  const a = repo('path-a', { 'bin/probe': probeScript('a') });
  const b = repo('path-b', { 'bin/probe': probeScript('b') });
  const pathEnv = [path.join(a, 'bin'), path.join(b, 'bin')].join(path.delimiter);
  assert.equal(resolveOnPath('probe', pathEnv), path.join(a, 'bin', 'probe'));
});

check('resolveOnPath returns null when nothing on PATH has that name', () => {
  assert.equal(resolveOnPath('nope-nowhere', '/does/not/exist'), null);
});

check('divergenceWarning is null when PATH agrees with the target', () => {
  const a = repo('agree', { 'bin/probe': probeScript('a') });
  const target = targetFor(a, 'probe');
  assert.equal(divergenceWarning(target, 'probe', path.join(a, 'bin')), null);
});

check('divergenceWarning is null when PATH does not resolve the name at all', () => {
  const a = repo('no-path-hit', { 'bin/probe': probeScript('a') });
  const target = targetFor(a, 'probe');
  assert.equal(divergenceWarning(target, 'probe', '/does/not/exist'), null);
});

check('divergenceWarning names the other file and the tree it belongs to when PATH disagrees', () => {
  const worktree = repo('div-worktree', { 'bin/probe': probeScript('worktree') });
  const main = repo('div-main', { 'bin/probe': probeScript('main') });
  const target = targetFor(worktree, 'probe');
  const w = divergenceWarning(target, 'probe', path.join(main, 'bin'));
  assert.match(w, /PATH would instead have run/);
  assert.match(w, new RegExp(path.join(main, 'bin', 'probe').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(w, new RegExp(`\\(in ${fs.realpathSync(main).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`));
});

/* ===================================================================== *
 * bin/b7e-run — end to end
 * ===================================================================== */

console.log('\nbin/b7e-run\n');

check('with no --dir, resolves and runs the CALLING cwd\'s own copy — proving it is not this test file\'s own repo', () => {
  const worktree = repo('e2e-cwd', { 'bin/probe': probeScript('from-worktree') });
  const run = spawnSync(process.execPath, [BIN, 'probe'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^from-worktree$/m);
  assert.match(run.stderr, new RegExp(`${fs.realpathSync(worktree).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} -> `));
});

check('runs the resolved copy even when PATH would have picked a DIFFERENT file, and says so', () => {
  const worktree = repo('e2e-worktree', { 'bin/probe': probeScript('worktree-copy') });
  const main = repo('e2e-main', { 'bin/probe': probeScript('main-copy') });
  const run = spawnSync(process.execPath, [BIN, 'probe'], {
    cwd: worktree,
    encoding: 'utf8',
    env: { ...process.env, PATH: [path.join(main, 'bin'), process.env.PATH].join(path.delimiter) },
  });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^worktree-copy$/m, 'must run the resolved worktree copy, not the PATH one');
  assert.doesNotMatch(run.stdout, /main-copy/);
  assert.match(run.stderr, /PATH would instead have run/);
  assert.match(run.stderr, new RegExp(path.join(main, 'bin', 'probe').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

check('--dir targets an explicit checkout regardless of cwd', () => {
  const elsewhere = repo('e2e-dir-target', { 'bin/probe': probeScript('dir-target') });
  const outside = fs.mkdtempSync(path.join(tmp, 'e2e-dir-cwd-'));
  const run = spawnSync(process.execPath, [BIN, '--dir', elsewhere, 'probe'], { cwd: outside, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /^dir-target$/m);
});

check('a missing command exits 2, naming <root>/bin/<name>', () => {
  const worktree = repo('e2e-missing');
  const run = spawnSync(process.execPath, [BIN, 'b7e-nosuch'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, new RegExp(path.join(worktree, 'bin', 'b7e-nosuch').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.equal(run.stdout, '');
});

check('--which resolves and reports without running anything', () => {
  const worktree = repo('e2e-which', {
    'bin/probe': `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.argv[2] || 'ran.txt', 'ran');
`,
  });
  const marker = path.join(worktree, 'ran.txt');
  const run = spawnSync(process.execPath, [BIN, '--which', 'probe'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stderr, /probe$/m);
  assert.equal(fs.existsSync(marker), false, '--which must not have executed the command');
});

check('--which on a missing command exits 2 the same way a real run would', () => {
  const worktree = repo('e2e-which-missing');
  const run = spawnSync(process.execPath, [BIN, '--which', 'b7e-nosuch'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 2);
});

check('the child\'s own non-zero exit code is passed through unchanged', () => {
  const worktree = repo('e2e-exitcode', { 'bin/probe': probeScript('x', 7) });
  const run = spawnSync(process.execPath, [BIN, 'probe'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 7);
});

check('args after the command are forwarded to it untouched, including flag-shaped ones', () => {
  const worktree = repo('e2e-args', {
    'bin/probe': `#!/usr/bin/env node
console.log(JSON.stringify(process.argv.slice(2)));
`,
  });
  const run = spawnSync(process.execPath, [BIN, 'probe', '--jobs', '3', '--flag'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /\["--jobs","3","--flag"\]/);
});

check('the child\'s own stdout and stderr both pass through verbatim', () => {
  const worktree = repo('e2e-streams', { 'bin/probe': probeScript('marker-xyz') });
  const run = spawnSync(process.execPath, [BIN, 'probe'], { cwd: worktree, encoding: 'utf8' });
  assert.match(run.stdout, /^marker-xyz$/m);
  assert.match(run.stderr, /marker-xyz-err/);
});

check('no arguments at all is refused with exit 2 and a usage message, nothing run', () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage:\n {2}b7e-run/);
});

check('--help prints usage and exits 0', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /usage:\n {2}b7e-run/);
});

check('--dir with no path following it is refused with exit 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

check('--which with extra arguments after the command name is refused with exit 2', () => {
  const worktree = repo('e2e-which-extra', { 'bin/probe': probeScript('x') });
  const run = spawnSync(process.execPath, [BIN, '--which', 'probe', '--jobs', '3'], { cwd: worktree, encoding: 'utf8' });
  assert.equal(run.status, 2);
});

await checkAsync('killing the wrapper kills the command it spawned, not just itself', async () => {
  // Same shape as the regression bin/b7e-shipgate guards against (memory note
  // a-wrapper-that-spawns-b7e-gate-must-forward-its-own-kill-signal): b7e-run itself
  // may be spawned as someone else's child (a worker's own long-running gate, run
  // through b7e-run for the resolution guarantee) and killing it must not orphan the
  // real command still holding whatever lock it acquired.
  const worktree = repo('e2e-signal', {
    'bin/probe': `#!/usr/bin/env node
const fs = require('fs');
fs.writeFileSync(process.argv[2], String(process.pid));
setTimeout(() => {}, 6000);
`,
  });
  const pidFile = path.join(worktree, 'child.pid');
  const wrapper = spawn(process.execPath, [BIN, 'probe', pidFile], { cwd: worktree, stdio: 'ignore' });
  for (let n = 0; n < 40 && !fs.existsSync(pidFile); n += 1) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(pidFile), 'the spawned command never even started — nothing to prove');
  const childPid = Number(fs.readFileSync(pidFile, 'utf8'));
  wrapper.kill('SIGTERM');
  await new Promise((resolve) => wrapper.on('exit', resolve));
  let alive = true;
  for (let n = 0; n < 20 && alive; n += 1) {
    try {
      process.kill(childPid, 0);
      await new Promise((r) => setTimeout(r, 100));
    } catch {
      alive = false;
    }
  }
  assert.equal(alive, false, 'the spawned command must not still be running once the wrapper is gone');
});

/* ===================================================================== */

removeTreeSync(tmp);

console.log(`\n${failures === 0 ? '\x1b[32m' : '\x1b[31m'}${failures === 0 ? 'all checks passed' : `${failures} check(s) failed`}\x1b[0m\n`);
process.exit(failures === 0 ? 0 : 1);
