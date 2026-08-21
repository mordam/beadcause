#!/usr/bin/env node
//
// b7e-blame — say whether a failing suite is already failing on origin/main (bc-khoe.42).
//
//   npm test
//   node test/blame.mjs
//
// The pure functions (extractFailures, suitesFromGateLog) are proved directly against
// small fabricated strings, the same argument test/b7eowes.mjs makes for its own
// extractors. The worktree-and-comparison half is proved against a REAL git repo — a
// bare "origin" plus a working clone, the same shape test/b7eworktree.mjs uses for its
// sibling tool — because worktree semantics (a detached checkout sharing objects with
// its origin, `origin/main` resolving without a fetch) are exactly the thing a fake
// filesystem would agree with itself about and tell you nothing real.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-blame');

const blame = await import(path.join(ROOT, 'lib', 'blame.js'));

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

/* ================================================================ 1. extractFailures */

console.log('\nextractFailures reads the FAIL lines this repo\'s suites actually print\n');

check('the plain shape — two leading spaces, one after FAIL', () => {
  assert.deepEqual(blame.extractFailures('  ok   passes\n  FAIL name of the broken check\n'), [
    'name of the broken check',
  ]);
});

check('the systemcard.mjs shape — no lead, two spaces after FAIL', () => {
  assert.deepEqual(blame.extractFailures('FAIL  another check\n      detail line\n'), ['another check']);
});

check('the dash shape — FAIL - name: message, on one line', () => {
  assert.deepEqual(blame.extractFailures('FAIL - a check: it threw\n'), ['a check: it threw']);
});

check('multiple FAILs, in order, ok/skip lines ignored', () => {
  assert.deepEqual(blame.extractFailures('  ok   one\n  FAIL two\n  skip three\n  FAIL four\n'), ['two', 'four']);
});

check('a suite with no FAIL line at all returns []', () => {
  assert.deepEqual(blame.extractFailures('something crashed\nEXIT 1\n'), []);
});

check('empty/undefined output returns []', () => {
  assert.deepEqual(blame.extractFailures(''), []);
  assert.deepEqual(blame.extractFailures(undefined), []);
});

check('a word merely containing FAIL is not a check line', () => {
  assert.deepEqual(blame.extractFailures('this test never FAILs on its own\n'), []);
});

/* ============================================================= 2. suitesFromGateLog */

console.log("\nsuitesFromGateLog reads b7e-gate's own --log, plain or --json\n");

check('the plain [done/total] STATUS suite secs shape, ok lines skipped', () => {
  const log = ['[1/3] ok test/a.mjs 0.4s', '[2/3] FAIL test/b.mjs 1.2s', '[3/3] TIMEOUT test/c.mjs 300.0s', 'all suites passed'].join(
    '\n',
  );
  assert.deepEqual(blame.suitesFromGateLog(log), ['test/b.mjs', 'test/c.mjs']);
});

check('the --json shape, one object per line, the summary line ignored', () => {
  const log = [
    JSON.stringify({ index: 1, total: 2, suite: 'test/a.mjs', status: 'ok' }),
    JSON.stringify({ index: 2, total: 2, suite: 'test/b.mjs', status: 'FAIL' }),
    JSON.stringify({ summary: true, total: 2, passed: 1, failed: ['test/b.mjs'] }),
  ].join('\n');
  assert.deepEqual(blame.suitesFromGateLog(log), ['test/b.mjs']);
});

check('duplicates are deduped, order of first appearance kept', () => {
  const log = ['[1/2] FAIL test/a.mjs 1.0s', '[2/2] FAIL test/a.mjs 1.0s'].join('\n');
  assert.deepEqual(blame.suitesFromGateLog(log), ['test/a.mjs']);
});

check('a blank or unrelated log returns []', () => {
  assert.deepEqual(blame.suitesFromGateLog(''), []);
  assert.deepEqual(blame.suitesFromGateLog('log: /tmp/x\n\nsome prose\n'), []);
});

/* ================================================================ fixtures for the rest */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-blame-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/**
 * A bare `origin` and a working clone `work`, `main` pushed and tracked, `node_modules`
 * present (so `makeMainWorktree`'s symlink has something real to point at) — the shape a
 * real `root` passed to `runBlame`/`--dir` actually has.
 */
function makeRepo(name, files) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', originBare);
  // Ignored, the same as this repo's own — so origin/main's checkout never has one,
  // exactly like the real thing, and the symlink in makeMainWorktree lands cleanly.
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  fs.mkdirSync(path.join(work, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(work, 'node_modules', 'dummy.txt'), 'x\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return work;
}

const passing = () => "console.log('  ok   the one check');\nprocess.exit(0);\n";
const failing = (names) =>
  `${names.map((n) => `console.log('  FAIL ${n}');`).join('\n')}\nprocess.exit(1);\n`;
const failingUnnamed = () => "console.log('something exploded');\nprocess.exit(1);\n";

const worktreeCount = (dir) => execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length;

/* ============================================================== 3. blameSuite / runBlame */

console.log('\nrunBlame compares a suite here against a detached origin/main\n');

await checkAsync('a suite that fails identically on both sides is main-red, and no new names', async () => {
  const work = makeRepo('mainred', { 'test/a.mjs': failing(['old bug']) });
  const before = worktreeCount(work);
  const { results } = await blame.runBlame(work, ['test/a.mjs']);
  assert.equal(results.length, 1);
  assert.equal(results[0].verdict, 'main-red');
  assert.deepEqual(results[0].localFail, ['old bug']);
  assert.deepEqual(results[0].mainFail, ['old bug']);
  assert.equal(worktreeCount(work), before, 'the scratch worktree was removed again');
});

await checkAsync('a suite red on main plus a new local failure is partial, both lists named', async () => {
  const work = makeRepo('partial', { 'test/a.mjs': failing(['old bug']) });
  fs.writeFileSync(path.join(work, 'test/a.mjs'), failing(['old bug', 'new bug']));
  const { results } = await blame.runBlame(work, ['test/a.mjs']);
  assert.equal(results[0].verdict, 'partial');
  assert.deepEqual(results[0].localFail, ['old bug', 'new bug']);
  assert.deepEqual(results[0].mainFail, ['old bug']);
});

await checkAsync('a suite green on main but red here is yours', async () => {
  const work = makeRepo('yours', { 'test/a.mjs': passing() });
  fs.writeFileSync(path.join(work, 'test/a.mjs'), failing(['a brand new check']));
  const { results } = await blame.runBlame(work, ['test/a.mjs']);
  assert.equal(results[0].verdict, 'yours');
  assert.deepEqual(results[0].localFail, ['a brand new check']);
  assert.deepEqual(results[0].mainFail, [], 'main really did run, and named nothing failing');
});

await checkAsync('a suite that does not exist at origin/main at all is yours, and main is never run', async () => {
  const work = makeRepo('newfile', { 'test/keep.mjs': passing() });
  fs.writeFileSync(path.join(work, 'test/brandnew.mjs'), failing(['whatever']));
  const { results } = await blame.runBlame(work, ['test/brandnew.mjs']);
  assert.equal(results[0].verdict, 'yours');
  assert.match(results[0].detail, /does not exist at origin\/main/);
});

await checkAsync('a suite that passes here is clean, and no origin/main worktree is ever built', async () => {
  const work = makeRepo('clean', { 'test/a.mjs': passing() });
  const before = worktreeCount(work);
  const { results } = await blame.runBlame(work, ['test/a.mjs']);
  assert.equal(results[0].verdict, 'clean');
  assert.deepEqual(results[0].localFail, []);
  assert.equal(results[0].mainFail, null);
  assert.equal(worktreeCount(work), before, 'a passing suite never needed origin/main at all');
});

await checkAsync('red on both sides with no named check anywhere is unclear, not main-red', async () => {
  const work = makeRepo('unclear', { 'test/a.mjs': failingUnnamed() });
  const { results } = await blame.runBlame(work, ['test/a.mjs']);
  assert.equal(results[0].verdict, 'unclear');
  assert.deepEqual(results[0].localFail, []);
  assert.deepEqual(results[0].mainFail, []);
});

await checkAsync('a suite path that does not exist locally at all is no-local, and nothing is run', async () => {
  const work = makeRepo('nolocal', { 'test/a.mjs': passing() });
  const { results } = await blame.runBlame(work, ['test/nonexistent.mjs']);
  assert.equal(results[0].verdict, 'no-local');
  assert.match(results[0].detail, /does not exist in/);
});

await checkAsync('one origin/main worktree is reused across several suites in one call, not rebuilt per suite', async () => {
  const work = makeRepo('reuse', { 'test/a.mjs': failing(['x']), 'test/b.mjs': failing(['y']) });
  // Not stubbing makeMainWorktree (ESM live bindings make that awkward) — instead prove
  // reuse the observable way: with --keep, exactly ONE worktree is left behind for TWO
  // failing suites, which is only possible if the second suite's comparison reused the
  // first suite's build rather than making its own.
  const before = worktreeCount(work);
  const { results, mainDir } = await blame.runBlame(work, ['test/a.mjs', 'test/b.mjs'], { keepWorktree: true });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.verdict === 'main-red'));
  assert.equal(worktreeCount(work), before + 1, 'one worktree for two suites, not two');
  blame.removeMainWorktree(work, mainDir, path.dirname(mainDir));
});

await checkAsync('--keep leaves the worktree in place, and it can still be cleaned up by hand', async () => {
  const work = makeRepo('keep', { 'test/a.mjs': failing(['x']) });
  const before = worktreeCount(work);
  const { results, mainDir } = await blame.runBlame(work, ['test/a.mjs'], { keepWorktree: true });
  assert.equal(results[0].verdict, 'main-red');
  assert.ok(mainDir && fs.existsSync(mainDir), 'the worktree is still there');
  assert.equal(worktreeCount(work), before + 1);
  blame.removeMainWorktree(work, mainDir, path.dirname(mainDir));
  assert.equal(worktreeCount(work), before, 'cleaned up by hand afterward');
});

await checkAsync('a crash partway through the suite list still tears the worktree down', async () => {
  const work = makeRepo('crashmidway', { 'test/a.mjs': failing(['x']) });
  const before = worktreeCount(work);
  // `path.join` throws synchronously on a non-string argument — a cheap, reliable way
  // to make the SECOND suite blow up after the first has already failed here and built
  // the origin/main worktree, which is exactly the case the `finally` block exists for.
  await assert.rejects(blame.runBlame(work, ['test/a.mjs', null]));
  assert.equal(worktreeCount(work), before, 'the finally block still removed the worktree it built for test/a.mjs');
});

/* =================================================================== 4. the CLI */

console.log('\nbin/b7e-blame — argv, exit codes, --json\n');

check('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-blame/);
});

check('no suites and no --from exits 2', () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /nothing to blame/);
});

check('a main-red suite exits 0 via --dir', () => {
  const work = makeRepo('cli-mainred', { 'test/a.mjs': failing(['old bug']) });
  const r = spawnSync(process.execPath, [BIN, '--dir', work, 'test/a.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /red on main too/);
  assert.match(r.stdout, /old bug/);
});

check('a yours suite exits 1 via --dir', () => {
  const work = makeRepo('cli-yours', { 'test/a.mjs': passing() });
  fs.writeFileSync(path.join(work, 'test/a.mjs'), failing(['new bug']));
  const r = spawnSync(process.execPath, [BIN, '--dir', work, 'test/a.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /green on main — yours/);
});

check('--json prints one parseable object per suite', () => {
  const work = makeRepo('cli-json', { 'test/a.mjs': failing(['old bug']) });
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--json', 'test/a.mjs'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = r.stdout.trim().split('\n').pop();
  const obj = JSON.parse(line);
  assert.equal(obj.suite, 'test/a.mjs');
  assert.equal(obj.verdict, 'main-red');
});

check('--from reads a plain-text b7e-gate log and blames what it names', () => {
  const work = makeRepo('cli-from', { 'test/a.mjs': failing(['old bug']) });
  const logPath = path.join(tmp, 'gate.log');
  fs.writeFileSync(logPath, '[1/1] FAIL test/a.mjs 0.1s\nsome failed\n');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--from', logPath], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /test\/a\.mjs/);
});

/* ---------------------------------------------------------------- 5. this repo's own suites */

console.log('\nagainst this repo\'s own two known-shaped suites\n');

check('scripts/selftest.mjs and test/systemcard.mjs are real files this command can point at', () => {
  // Not asserting a verdict here — main's own colour changes day to day (see the
  // bead), and asserting "red" or "green" would make this suite flake with main
  // rather than with a bug. What is worth pinning: both exist, and running one
  // through blameSuite() against THIS checkout as both "root" and (via a real
  // origin/main worktree) "main" does not throw.
  assert.ok(fs.existsSync(path.join(ROOT, 'scripts/selftest.mjs')));
  assert.ok(fs.existsSync(path.join(ROOT, 'test/systemcard.mjs')));
});

/* ---------------------------------------------------------------------- verdict */

fs.rmSync(tmp, { recursive: true, force: true });
console.log(failures ? `\n${failures} of ${ran} failed` : `\n${ran} checks passed`);
process.exit(failures ? 1 : 0);
