#!/usr/bin/env node
/**
 * `scripts/prune-retired.sh` — the old name for the attic sweep, and the symlink that
 * keeps it honest.
 *
 *     npm test
 *     node test/pruneshim.mjs
 *
 * `test/attic.mjs` covers the gates and `test/atticcli.mjs` the report. This covers the
 * forwarder, which is a separate claim from either: **the file a ship actually invokes
 * reaches this repo's sweep**, from wherever it is invoked.
 *
 * It is worth a suite because of how the last two bugs here were found — which is to say,
 * late. The sweep was 210 lines of bash outside every repo, and bc-bcdp's inverted
 * `grep -q` under pipefail reported 68 of 85 healthy attic entries as strays for as long
 * as it took somebody to disbelieve the output. bc-uytt moved the gates into `lib/` and
 * left the bash behind as a shim, which fixed the sweep and not the arrangement: the
 * entry point was still unversioned, unreviewed and untested, and a shim is small right
 * up until somebody edits it.
 *
 * So the shim is in the repo and `~/.claude/skills/ship/prune-retired.sh` is a symlink to
 * it. The two assertions that matter are therefore about *resolution*, not about sweeping:
 *
 * 1. Invoked through a symlink, it finds the checkout the real file is in — not the
 *    symlink's own directory, and not `$HOME`. This is the whole install.
 * 2. The installed path, when it exists, is a symlink and not a copy. A copy is the
 *    arrangement that drifted; one `cp` puts it back, and nothing else would notice.
 *
 * Real `bash` and a real temp git repo throughout. `--no-pr` everywhere, so nothing here
 * shells out to `gh` or touches the network.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const SHIM = path.join(ROOT, 'scripts', 'prune-retired.sh');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-pruneshim-'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/**
 * Run the shim. `env` is merged over a deliberately hostile base: `HOME` points at an
 * empty directory, so any test that passes did so by resolving the script's own location
 * rather than by falling through to `$HOME/neadamthal.projects/beadcause` — which on this
 * laptop exists and would make every one of these pass for the wrong reason.
 */
const emptyHome = fs.mkdtempSync(path.join(tmp, 'home-'));
function shim(args, { env = {}, at = SHIM } = {}) {
  const r = spawnSync('bash', [at, ...args], {
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, HOME: emptyHome, BEADCAUSE_DIR: '', ...env },
  });
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/* ---------------------------------------------------------------- fixtures */

/** A git repo with nothing in it — enough for the sweep to run and say so. */
function bareRepo(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git('add', '-A');
  git('commit', '-qm', 'first');
  return dir;
}

/* ------------------------------------------------------------------- tests */

console.log('prune-retired.sh — the shim');

check('is in the repo, and executable', () => {
  assert.ok(fs.existsSync(SHIM), `${SHIM} does not exist`);
  assert.ok(fs.statSync(SHIM).mode & 0o111, 'not executable — a ship invokes it directly');
});

check('forwards to bin/attic.js rather than parsing anything itself', () => {
  const r = shim([]);
  assert.equal(r.code, 2, `expected exit 2 for no arguments, got ${r.code}`);
  // The usage text belongs to bin/attic.js. Seeing it is how we know node ran.
  assert.match(r.err + r.out, /beadcause-attic/, 'no sign the sweep was reached');
});

check('--help is the sweep\'s help, and exits 0', () => {
  const r = shim(['--help']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.err}`);
  assert.match(r.out, /usage: beadcause-attic/, r.out);
});

check('passes its flags straight through', () => {
  const r = shim(['--days', 'ninety', bareRepo('flags')]);
  assert.equal(r.code, 2, `expected exit 2 for a bad --days, got ${r.code}`);
  assert.match(r.err, /--days must be a number/, r.err);
});

check('sweeps for real: a repo with no attic exits 0 and says so', () => {
  const r = shim([bareRepo('noattic'), '--dry-run', '--no-pr']);
  assert.equal(r.code, 0, `expected exit 0, got ${r.code}: ${r.err}`);
  assert.match(r.out, /no \.claude\/worktrees-retired\/ — nothing to do/, r.out);
});

check('refuses a worktree rather than sweeping the wrong attic', () => {
  const main = bareRepo('wt-main');
  const wt = path.join(tmp, 'wt-linked');
  execFileSync('git', ['worktree', 'add', '-q', '-b', 'side', wt], { cwd: main, stdio: 'pipe' });
  const r = shim([wt, '--dry-run', '--no-pr']);
  assert.equal(r.code, 2, `expected exit 2 for a worktree, got ${r.code}: ${r.out}`);
  assert.match(r.err, /is a worktree, not the main checkout/, r.err);
});

/* --------------------------------------------------------- how it resolves */

console.log('finding the checkout');

check('invoked through a symlink, it resolves to the checkout the real file is in', () => {
  // The install, exactly: a symlink in a directory that is not a checkout of anything.
  const installed = path.join(fs.mkdtempSync(path.join(tmp, 'skills-')), 'prune-retired.sh');
  fs.symlinkSync(SHIM, installed);
  const r = shim(['--help'], { at: installed });
  assert.equal(r.code, 0, `expected exit 0 through the symlink, got ${r.code}: ${r.err}`);
  assert.match(r.out, /usage: beadcause-attic/, r.out);
});

check('a chain of symlinks resolves too', () => {
  const a = path.join(fs.mkdtempSync(path.join(tmp, 'hop1-')), 'prune-retired.sh');
  const b = path.join(fs.mkdtempSync(path.join(tmp, 'hop2-')), 'prune-retired.sh');
  fs.symlinkSync(SHIM, a);
  fs.symlinkSync(a, b);
  const r = shim(['--help'], { at: b });
  assert.equal(r.code, 0, `expected exit 0 through two symlinks, got ${r.code}: ${r.err}`);
});

check('a copy outside every checkout falls back, and says which one it looked in', () => {
  // No symlink to follow and no BEADCAUSE_DIR: all it has left is $HOME, which here is
  // empty on purpose. The point of the test is the message, because this is the state a
  // person has to be able to diagnose from one line of a ship's output.
  const stray = path.join(fs.mkdtempSync(path.join(tmp, 'stray-')), 'prune-retired.sh');
  fs.copyFileSync(SHIM, stray);
  const r = shim(['--help'], { at: stray });
  assert.equal(r.code, 2, `expected exit 2 with no checkout to find, got ${r.code}`);
  assert.match(r.err, /is not there/, r.err);
  assert.match(r.err, /probably behind/, r.err);
  assert.match(r.err, new RegExp(emptyHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), r.err);
});

check('BEADCAUSE_DIR wins over where the file lives', () => {
  const r = shim(['--help'], { env: { BEADCAUSE_DIR: path.join(tmp, 'nope') } });
  assert.equal(r.code, 2, `expected exit 2 for a BEADCAUSE_DIR with no sweep in it, got ${r.code}`);
  assert.match(r.err, /nope\/bin\/attic\.js/, r.err);
});

/* ------------------------------------------------------------- the install */

console.log('the installed path');

// `~/.claude/skills/ship/prune-retired.sh` is what the `ship` skill has always named. It
// must be a symlink to a checkout's `scripts/prune-retired.sh` — a regular file there is
// a copy, and a copy is the arrangement that drifted twice. Skipped when absent, because
// this suite has to pass on a machine that has never installed the skill.
const INSTALLED = path.join(os.homedir(), '.claude', 'skills', 'ship', 'prune-retired.sh');

check('is a symlink into a checkout, or is not installed at all', () => {
  let stat;
  try {
    stat = fs.lstatSync(INSTALLED);
  } catch {
    console.log(`       (not installed at ${INSTALLED} — nothing to check)`);
    return;
  }
  assert.ok(
    stat.isSymbolicLink(),
    `${INSTALLED} is a regular file. It must be a symlink to scripts/prune-retired.sh in a ` +
      'beadcause checkout: a copy is what drifted from the sweep twice before (bc-bcdp, bc-uytt).'
  );
  // Read the link rather than resolving it, because a symlink into the **main checkout**
  // dangles between this landing on origin/main and that checkout pulling — nothing pulls
  // it on its own, and the deploy that does is a separate step somebody has to run. A
  // dangling link is the expected transient state and `realpathSync` would throw on it.
  const raw = fs.readlinkSync(INSTALLED);
  const target = path.resolve(path.dirname(INSTALLED), raw);
  assert.equal(path.basename(target), 'prune-retired.sh', `points at ${target}`);
  assert.equal(path.basename(path.dirname(target)), 'scripts', `points at ${target}`);
  const checkout = path.dirname(path.dirname(target));
  if (!fs.existsSync(target)) {
    console.log(`       (points into ${checkout}, which has not pulled this yet)`);
    return;
  }
  assert.ok(fs.existsSync(path.join(checkout, 'bin', 'attic.js')), `${checkout} has no bin/attic.js`);
});

/* ------------------------------------------------------------------ finish */

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
