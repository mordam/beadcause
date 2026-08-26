#!/usr/bin/env node
//
// b7e-counterproof — prove a new check is red without the fix, and put the tree back
// (bc-68ou.14).
//
//   npm test
//   node test/counterproof.mjs
//
// lib/counterproof.js does the mutate/run/restore and the by-name comparison; this
// drives it directly against fabricated git repos (real git history is needed here,
// unlike test/triage.mjs's plain filesystem trees, because `--at <ref>` and
// `git show <ref>:<path>` are the whole mechanism under test) plus a handful of calls
// through the real bin/b7e-counterproof.js binary for argv parsing, --json and the exit
// codes, and one real SIGTERM-mid-run drive — the exact failure mode the bead is named
// for (bc-gdub lost uncommitted work to a hand-rolled restore that a crash could skip).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-counterproof.js');

const cp = await import(path.join(ROOT, 'lib', 'counterproof.js'));
const gate = await import(path.join(ROOT, 'lib', 'gate.js'));

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

/* ================================================================== 1. extractChecks */

console.log("\nextractChecks reads this repo's own ok/FAIL convention, plus the failure text\n");

check('ok and FAIL, plain spacing, in order', () => {
  const rows = cp.extractChecks('  ok   one\n  FAIL two\n');
  assert.deepEqual(
    rows.map((r) => [r.kind, r.name]),
    [
      ['ok', 'one'],
      ['fail', 'two'],
    ],
  );
});

check('the systemcard.mjs shape — no lead, two spaces after FAIL', () => {
  const rows = cp.extractChecks('FAIL  another check\n');
  assert.deepEqual(rows, [{ kind: 'fail', name: 'another check', detail: '' }]);
});

check('the dash shape, on one line, for both ok and FAIL', () => {
  const rows = cp.extractChecks('ok - passed fine\nFAIL - broke: it threw\n');
  assert.deepEqual(
    rows.map((r) => r.name),
    ['passed fine', 'broke: it threw'],
  );
});

check('a FAIL is followed by its indented detail, joined and trimmed', () => {
  const out = '  FAIL a check\n       Expected 1\n       to equal 2\n  ok   next\n';
  const rows = cp.extractChecks(out);
  assert.equal(rows[0].kind, 'fail');
  assert.equal(rows[0].detail, 'Expected 1\nto equal 2');
  assert.equal(rows[1].kind, 'ok');
});

check('detail stops at a blank line even with no next check', () => {
  const rows = cp.extractChecks('  FAIL x\n       the reason\n\nsome unrelated trailing prose\n');
  assert.equal(rows[0].detail, 'the reason');
});

check('a suite with no named line at all returns []', () => {
  assert.deepEqual(cp.extractChecks('something crashed\nEXIT 1\n'), []);
});

check('empty/undefined output returns []', () => {
  assert.deepEqual(cp.extractChecks(''), []);
  assert.deepEqual(cp.extractChecks(undefined), []);
});

check('a word merely containing ok or FAIL is not a check line', () => {
  assert.deepEqual(cp.extractChecks('broken tokens do not count\nlooks okay to me\n'), []);
});

/* ================================================================ fixtures for the rest */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-counterproof-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A plain repo (no remote) with `files` as its first commit. Returns `{ dir, sha }`. */
function makeRepo(name, files) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'init');
  return { dir, sha: git(dir, 'rev-parse', 'HEAD').trim() };
}

/**
 * `lib/thing.js` exporting `BUGGY` — `true` at the "at" commit, `false` once "fixed" —
 * and a `test/thing.mjs` with four named checks: one that only fails while `BUGGY` is
 * true (the one a revert should flip), one that fails unconditionally (already red
 * either way — proves nothing about the revert), and one that passes unconditionally
 * (still proves nothing, the other direction). Four checks total is enough to exercise
 * `X of Y flipped` without a real suite's runtime.
 */
function libBody(buggy) {
  return `export const BUGGY = ${buggy};\n`;
}
const testBody = () =>
  [
    "import assert from 'node:assert/strict';",
    "import { BUGGY } from '../lib/thing.js';",
    'let failures = 0, ran = 0;',
    'function check(name, fn) {',
    '  ran += 1;',
    '  try { fn(); console.log(`  ok   ${name}`); }',
    '  catch (err) { failures += 1; console.log(`  FAIL ${name}`); console.log(`       ${err.message}`); }',
    '}',
    "check('depends on the fix', () => assert.equal(BUGGY, false));",
    "check('already broken either way', () => assert.equal(1, 2));",
    "check('passes either way', () => assert.equal(1, 1));",
    'console.log(failures ? `${failures} of ${ran} failed` : `${ran} passed`);',
    'process.exit(failures ? 1 : 0);',
  ].join('\n');

/** A repo whose "at" commit is buggy and whose working tree is already fixed — committed. */
function makeFixedRepo(name) {
  const { dir, sha } = makeRepo(name, { 'lib/thing.js': libBody(true), 'test/thing.mjs': testBody() });
  fs.writeFileSync(path.join(dir, 'lib/thing.js'), libBody(false));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fix it');
  return { dir, atSha: sha };
}

/**
 * Same shape, but the fix lands on a `feature` branch checked out *off* the buggy
 * commit — `main` itself never moves past it. `resolveDefaultAt`'s merge-base with
 * `main` only lands on the buggy commit when `main` and `HEAD` have actually diverged;
 * two commits straight on `main` (what `makeFixedRepo` builds) makes `main` the tip
 * itself, which is exactly the case this fixture exists to avoid confusing it with.
 */
function makeBranchedRepo(name) {
  const { dir, sha: atSha } = makeRepo(name, { 'lib/thing.js': libBody(true), 'test/thing.mjs': testBody() });
  git(dir, 'checkout', '-q', '-b', 'feature');
  fs.writeFileSync(path.join(dir, 'lib/thing.js'), libBody(false));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fix it');
  return { dir, atSha };
}

/* =============================================================== 2. resolveWork */

console.log('\nresolveWork resolves a bare stem, with or without an extension\n');

check('an exact suite path resolves as-is', () => {
  const all = ['test/thing.mjs', 'scripts/shade-check.mjs'];
  assert.equal(cp.resolveWork('test/thing.mjs', all).suite, 'test/thing.mjs');
});

check('a bare basename with no extension resolves against the .mjs file', () => {
  const all = ['test/thing.mjs'];
  assert.equal(cp.resolveWork('thing', all).suite, 'test/thing.mjs');
});

check('a browser check basename resolves too — scripts/*-check.mjs is in scope', () => {
  const all = ['scripts/shade-check.mjs'];
  assert.equal(cp.resolveWork('shade-check', all).suite, 'scripts/shade-check.mjs');
});

check('nothing matching anywhere is unresolved, with a reason', () => {
  const { suite, reason } = cp.resolveWork('nope', ['test/thing.mjs']);
  assert.equal(suite, null);
  assert.match(reason, /no suite named/);
});

/* =============================================================== 3. resolveDefaultAt */

console.log('\nresolveDefaultAt falls back through origin/main, then main\n');

check('a plain single-commit repo resolves --at to its own HEAD via the main fallback', () => {
  const { dir, sha } = makeRepo('defaultat', { 'a.txt': 'x\n' });
  assert.equal(cp.resolveDefaultAt(dir), sha);
});

check('a directory with no git history at all resolves to null', () => {
  const dir = path.join(tmp, 'nogit');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(cp.resolveDefaultAt(dir), null);
});

/* =============================================================== 4. counterprove() */

console.log('\ncounterprove reverts, runs each suite twice, and says what flipped\n');

await checkAsync('the one check tied to the bug flips; the other two are reported, not counted', async () => {
  const { dir, atSha } = makeFixedRepo('flip');
  const result = await cp.counterprove(dir, { at: atSha, paths: ['lib/thing.js'], suites: ['thing'] });
  assert.equal(result.ok, true);
  assert.equal(result.suites.length, 1);
  const s = result.suites[0];
  assert.equal(s.total, 3);
  assert.deepEqual(
    s.flipped.map((c) => c.name),
    ['depends on the fix'],
  );
  assert.deepEqual(
    s.alreadyRed.map((c) => c.name),
    ['already broken either way'],
  );
  assert.match(s.flipped[0].detail, /Expected values to be strictly equal/);
  assert.equal(result.totalFlipped, 1);
  assert.equal(result.totalChecked, 3);
  assert.equal(result.proven, true);
  assert.equal(cp.exitCodeFor(result), 0);
});

await checkAsync('the tree is put back exactly, uncommitted fix included', async () => {
  const { dir, atSha } = makeFixedRepo('restore');
  const before = fs.readFileSync(path.join(dir, 'lib/thing.js'), 'utf8');
  const statusBefore = git(dir, 'status', '--porcelain');
  await cp.counterprove(dir, { at: atSha, paths: ['lib/thing.js'], suites: ['thing'] });
  assert.equal(fs.readFileSync(path.join(dir, 'lib/thing.js'), 'utf8'), before);
  assert.equal(git(dir, 'status', '--porcelain'), statusBefore);
});

await checkAsync('a path that did not exist at --at is removed, then restored', async () => {
  const { dir, atSha } = makeFixedRepo('newfile');
  fs.writeFileSync(path.join(dir, 'lib/extra.js'), 'export const NEW = true;\n');
  const before = fs.readFileSync(path.join(dir, 'lib/extra.js'), 'utf8');
  await cp.counterprove(dir, { at: atSha, paths: ['lib/extra.js', 'lib/thing.js'], suites: ['thing'] });
  assert.equal(fs.readFileSync(path.join(dir, 'lib/extra.js'), 'utf8'), before, 'restored even though `at` never had it');
});

await checkAsync('a check that passes both ways is not proven, and the exit code says so', async () => {
  const { dir, atSha } = makeFixedRepo('noflip');
  const result = await cp.counterprove(dir, { at: atSha, paths: ['lib/thing.js'], suites: ['thing'] });
  // Revert only a file the suite never reads, so nothing about the suite's own outcome changes.
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'unrelated');
  const r2 = await cp.counterprove(dir, { at: atSha, paths: ['unrelated.txt'], suites: ['thing'] });
  assert.equal(r2.suites[0].flipped.length, 0);
  assert.match(cp.reportLines(r2).join('\n'), /passes both ways, proves nothing/);
  assert.equal(cp.exitCodeFor(r2), 1);
  void result;
});

await checkAsync('an unresolved suite name refuses outright, and nothing is mutated', async () => {
  const { dir, atSha } = makeFixedRepo('badname');
  const before = fs.readFileSync(path.join(dir, 'lib/thing.js'), 'utf8');
  const result = await cp.counterprove(dir, { at: atSha, paths: ['lib/thing.js'], suites: ['thing', 'nope'] });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /nope/);
  assert.equal(fs.readFileSync(path.join(dir, 'lib/thing.js'), 'utf8'), before);
  assert.equal(cp.exitCodeFor(result), 2);
});

await checkAsync('--keep-going skips an unresolved suite and still runs the rest', async () => {
  const { dir, atSha } = makeFixedRepo('keepgoing');
  const result = await cp.counterprove(dir, { at: atSha, paths: ['lib/thing.js'], suites: ['nope', 'thing'], keepGoing: true });
  assert.equal(result.ok, true);
  assert.equal(result.suites.length, 1);
  assert.equal(result.unresolved.length, 1);
  assert.equal(result.unresolved[0].input, 'nope');
  assert.equal(result.suites[0].flipped.length, 1, 'the resolvable suite still ran and still proved its check');
  assert.equal(cp.exitCodeFor(result), 1, 'an unresolved name still costs the exit code, even under --keep-going');
});

await checkAsync('a bad --at refuses cleanly', async () => {
  const { dir } = makeFixedRepo('badat');
  const result = await cp.counterprove(dir, { at: 'not-a-real-ref', paths: ['lib/thing.js'], suites: ['thing'] });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /does not resolve/);
});

await checkAsync('no paths given is a refusal', async () => {
  const result = await cp.counterprove('/nonexistent', { at: 'HEAD', paths: [], suites: ['thing'] });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /no paths/);
});
await checkAsync('no suites given is a refusal', async () => {
  const result = await cp.counterprove('/nonexistent', { at: 'HEAD', paths: ['a'], suites: [] });
  assert.equal(result.ok, false);
  assert.match(result.refusal, /no suites/);
});

await checkAsync('the tree-wide gate lock is respected — a held lock refuses rather than doubling the load', async () => {
  const { dir, atSha } = makeFixedRepo('lockheld');
  const lock = gate.acquireLock(dir);
  assert.equal(lock.ok, true, 'the fixture itself must be able to take the lock first');
  try {
    const result = await cp.counterprove(dir, { at: atSha, paths: ['lib/thing.js'], suites: ['thing'] });
    assert.equal(result.ok, false);
    assert.match(result.refusal, /already running/);
  } finally {
    lock.release();
  }
});

/* ========================================================= 5. SIGTERM mid-run */

console.log('\na SIGTERM mid-run leaves the tree exactly as it was, uncommitted edit included\n');

/** `lib/slow.js` exporting a `MARK`, and a suite that sleeps long enough to be killed mid-run. */
function makeSlowRepo(name) {
  const { dir, sha } = makeRepo(name, { 'lib/slow.js': "export const MARK = 'old';\n" });
  const slowSuite = ["setTimeout(() => { console.log('  ok   slept'); process.exit(0); }, 4000);"].join('\n');
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'test/slow.mjs'), slowSuite);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'slow suite');
  fs.writeFileSync(path.join(dir, 'lib/slow.js'), "export const MARK = 'UNCOMMITTED-FIX';\n");
  return { dir, atSha: sha };
}

await checkAsync('SIGTERM while the reverted run is up restores the file and leaves git status unchanged', async () => {
  const { dir, atSha } = makeSlowRepo('sigterm');
  const foo = path.join(dir, 'lib/slow.js');
  const statusBefore = git(dir, 'status', '--porcelain');
  const contentBefore = fs.readFileSync(foo, 'utf8');

  const child = spawn(process.execPath, [BIN, '--dir', dir, '--at', atSha, 'lib/slow.js', '--', 'slow'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const exitPromise = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

  // Poll until the mutation has actually landed — the baseline pass runs first (also a
  // ~4s sleep), so this only flips once that has finished and the revert has happened.
  const deadline = Date.now() + 15000;
  let mutated = false;
  while (Date.now() < deadline) {
    if (fs.readFileSync(foo, 'utf8').includes("MARK = 'old'")) {
      mutated = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(mutated, 'the revert never landed within 15s — cannot test the kill window');

  await new Promise((r) => setTimeout(r, 300));
  child.kill('SIGTERM');
  const { signal } = await exitPromise;
  assert.equal(signal, 'SIGTERM', 'died of the signal it was sent, not a process.exit()');

  assert.equal(fs.readFileSync(foo, 'utf8'), contentBefore, 'the uncommitted fix is back, byte for byte');
  assert.equal(git(dir, 'status', '--porcelain'), statusBefore, 'git status is exactly what it was before the call');
});

/* ==================================================================== 6. the CLI */

console.log('\nbin/b7e-counterproof.js — argv, exit codes, --json\n');

check('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-counterproof/);
});

check('no -- separator at all exits 2', () => {
  const r = spawnSync(process.execPath, [BIN, 'lib/thing.js', 'thing'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /then --, then/);
});

check('-- with nothing before it exits 2 — no paths', () => {
  const r = spawnSync(process.execPath, [BIN, '--', 'thing'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no paths/);
});

check('-- with nothing after it exits 2 — no suites', () => {
  const r = spawnSync(process.execPath, [BIN, 'lib/thing.js', '--'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no suites/);
});

check('a proven revert exits 0 via --dir and --at, bare suite name and all', () => {
  const { dir, atSha } = makeFixedRepo('cli-proven');
  const r = spawnSync(process.execPath, [BIN, '--dir', dir, '--at', atSha, 'lib/thing.js', '--', 'thing'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /1 of 3 flipped/);
  assert.match(r.stdout, /depends on the fix/);
});

check('--at defaults to the merge-base with main when not given', () => {
  const { dir, atSha } = makeBranchedRepo('cli-default-at');
  const r = spawnSync(process.execPath, [BIN, '--dir', dir, 'lib/thing.js', '--', 'thing'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`reverted against ${atSha}`));
  assert.match(r.stdout, /1 of 3 flipped/);
});

check('a path given relative to --dir resolves against that tree, not the real cwd', () => {
  const { dir, atSha } = makeFixedRepo('cli-cwd-base');
  // Run from this repo's own root (ROOT), nowhere near `dir` — the whole point of the
  // b7e-affected CWD_BASE convention this reuses.
  const r = spawnSync(process.execPath, [BIN, '--dir', dir, '--at', atSha, 'lib/thing.js', '--', 'thing'], {
    encoding: 'utf8',
    cwd: ROOT,
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

check('--json prints one parseable object', () => {
  const { dir, atSha } = makeFixedRepo('cli-json');
  const r = spawnSync(process.execPath, [BIN, '--dir', dir, '--at', atSha, '--json', 'lib/thing.js', '--', 'thing'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const obj = JSON.parse(r.stdout.trim());
  assert.equal(obj.ok, true);
  assert.equal(obj.totalFlipped, 1);
  assert.equal(obj.suites[0].suite, 'test/thing.mjs');
});

check('an unresolved suite exits 2 and names the bad one', () => {
  const { dir, atSha } = makeFixedRepo('cli-unresolved');
  const r = spawnSync(process.execPath, [BIN, '--dir', dir, '--at', atSha, 'lib/thing.js', '--', 'nope'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /nope/);
});

/* -------------------------------------------------------------- 7. this repo's own files */

console.log("\nagainst this repo's own real files\n");

check('bin/b7e-counterproof.js is registered in package.json and is on PATH-shaped', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.bin['b7e-counterproof'], 'bin/b7e-counterproof.js');
  assert.ok(fs.existsSync(BIN));
});

/* ---------------------------------------------------------------------- verdict */

removeTreeSync(tmp);
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} checks passed`);
process.exit(failures ? 1 : 0);
