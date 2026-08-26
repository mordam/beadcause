#!/usr/bin/env node
//
// b7e-stillred — is this suite already known red, whose bead, at what base, and has
// origin/main fixed it since (bc-dgx7.62), against lib/stillred.js and the real CLI.
//
//   npm test
//   node test/stillred.mjs
//
// A real bare origin plus a working clone, the same shape test/blame.mjs and
// test/b7ewatch.mjs already build for the same family of tools — this needs
// `origin/main` to resolve to real, fetchable history, and a fake filesystem would
// agree with itself about that and prove nothing. Gate-run records are written through
// the REAL lib/gaterun.js (startRun/appendResult/endRun), never hand-typed JSONL, so a
// format drift in that file breaks this suite the same day it breaks the real tool.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-stillred');

const gaterun = await import(path.join(ROOT, 'lib', 'gaterun.js'));
const stillred = await import(path.join(ROOT, 'lib', 'stillred.js'));
const blame = await import(path.join(ROOT, 'lib', 'blame.js'));

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

/* ===================================================================== *
 * fixtures
 * ===================================================================== */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-stillred-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** A bare `origin` and a working clone, `main` pushed and tracked — the shape a real `--dir` actually has. */
function makeRepo(name, files) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', originBare);
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n.claude/gate-runs/\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  git(work, 'push', '-q', '-u', 'origin', 'main');
  return work;
}

/** No `origin` remote at all — a suite can still fail here, but there is nothing to compare `origin/main` against. */
function makeRepoNoOrigin(name, files) {
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n.claude/gate-runs/\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  return work;
}

const passing = () => "console.log('  ok   the one check');\nprocess.exit(0);\n";
const failing = (names) => `${names.map((n) => `console.log('  FAIL ${n}');`).join('\n')}\nprocess.exit(1);\n`;

const worktreeCount = (dir) => execFileSync('git', ['worktree', 'list'], { cwd: dir, encoding: 'utf8' }).trim().split('\n').length;

/**
 * Every direct (non-CLI) call in this suite runs with `BEADS_DIR` pointed at a directory
 * with no `.beads` in it, so `findBead`'s `bd search` fails fast and deterministically
 * (~0.3s: "no beads database found") rather than depending on whatever this Mac's real
 * workspace happens to contain today — the answer under test here is "gracefully null,"
 * not any particular bead.
 */
const NO_BEADS_DIR = path.join(tmp, 'no-such-beads-dir');
async function withNoBeads(fn) {
  const prev = process.env.BEADS_DIR;
  process.env.BEADS_DIR = NO_BEADS_DIR;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.BEADS_DIR;
    else process.env.BEADS_DIR = prev;
  }
}
const CLI_ENV = { ...process.env, BEADS_DIR: NO_BEADS_DIR };

/* ===================================================================== *
 * 1. lib/stillred.js — the four verdicts
 * ===================================================================== */

console.log('\nlib/stillred.js: is a suite already known red, and has origin/main fixed it since\n');

await checkAsync('no gate run has ever recorded this failing — no-record, exit 0, no bead', async () => {
  const work = makeRepo('no-record', { 'test/a.mjs': failing(['x']) });
  const [r] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(r.verdict, 'no-record');
  assert.equal(r.failureCount, 0);
  assert.equal(r.last, null);
  assert.equal(r.bead, null);
  assert.equal(stillred.exitCodeFor([r]), 0);
});

await checkAsync('recorded red, no commit has touched the suite on origin/main since — still-red, exit 1', async () => {
  const work = makeRepo('still-red', { 'test/a.mjs': failing(['x']) });
  const { file } = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });

  // Push something unrelated — proves this is a path-filtered comparison, not "did
  // origin/main move at all."
  fs.writeFileSync(path.join(work, 'README.md'), 'unrelated change\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'touch something unrelated');
  git(work, 'push', '-q', 'origin', 'main');

  const [r] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(r.verdict, 'still-red');
  assert.equal(r.failureCount, 1);
  assert.deepEqual(r.commitsSinceBase, []);
  assert.equal(stillred.exitCodeFor([r]), 1);
  assert.match(stillred.verdictLine(r), /no fix on origin\/main since your base/);
});

await checkAsync('no origin remote at all — unclear-base, exit 1, not a crash', async () => {
  const work = makeRepoNoOrigin('unclear-base', { 'test/a.mjs': failing(['x']) });
  const { file } = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });

  const [r] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(r.verdict, 'unclear-base');
  assert.equal(r.base, null);
  assert.equal(stillred.exitCodeFor([r]), 1);
});

await checkAsync(
  'reconstructing bc-dgx7.52: red at base A, a fix lands on origin/main at B — fixed-on-main, exit 0, ' +
    'where b7e-blame on the SAME inputs says "red here, green on main" (verdict "yours")',
  async () => {
    const work = makeRepo('fixed-on-main', {
      'test/a.mjs': failing(['maxWorkers vs maxWorkersLimit race']),
      'node_modules/dummy.txt': 'x\n',
    });
    const baseSha = git(work, 'rev-parse', 'HEAD').trim();

    // The gate run bc-dgx7.52 itself ran, red, at base A — recorded from THIS working
    // tree, which never advances past base A below (mirroring "my branch was in
    // flight" while someone else's fix landed on origin/main).
    const { file } = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
    gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1, tail: '  FAIL maxWorkers vs maxWorkersLimit race' });
    gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });

    // bc-beleq's fix, landing on origin/main via a SEPARATE clone — `work`'s own
    // branch and working tree never see it directly, only through `git fetch`, the
    // same "kept current by the daemon and the sessions sweeping this repo" assumption
    // lib/blame.js's own header already documents.
    const other = path.join(tmp, 'fixed-on-main-other-clone');
    git(tmp, 'clone', '-q', path.join(tmp, 'fixed-on-main.git'), other);
    fs.writeFileSync(path.join(other, 'test/a.mjs'), passing());
    git(other, 'add', '-A');
    git(other, 'commit', '-q', '-m', 'fix: correct the maxWorkers vs maxWorkersLimit race');
    git(other, 'push', '-q', 'origin', 'main');
    git(work, 'fetch', '-q', 'origin');

    const [r] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
    assert.equal(r.verdict, 'fixed-on-main');
    assert.equal(r.base, baseSha);
    assert.equal(r.commitsSinceBase.length, 1);
    assert.match(r.commitsSinceBase[0].subject, /correct the maxWorkers/);
    assert.equal(stillred.exitCodeFor([r]), 0);
    assert.match(stillred.verdictLine(r), /fixed on main since your base — merge origin\/main/);

    // b7e-blame, asked the SAME question against the SAME tree: `work`'s own working
    // copy is still on the failing content (it never fetched the fix into its working
    // tree, only into `origin/main`), so it is red here — and the fix already landed
    // on `origin/main`, so blameSuite calls that "yours": green on main, squarely
    // yours to merge. Two tools, two different questions, compatible answers.
    const blamed = (await blame.runBlame(work, ['test/a.mjs'])).results[0];
    assert.equal(blamed.verdict, 'yours', `expected b7e-blame's verdict to read "green on main — yours", got ${JSON.stringify(blamed)}`);
  },
);

await checkAsync('the most recent recorded failure wins when a suite has failed more than once', async () => {
  const work = makeRepo('most-recent', { 'test/a.mjs': failing(['x']) });
  const first = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(first.file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(first.file, { status: 'fail', elapsed: 0.1 });
  await new Promise((r) => setTimeout(r, 5)); // runIds are millisecond-stamped
  const second = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(second.file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(second.file, { status: 'fail', elapsed: 0.1 });

  const [r] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(r.failureCount, 2);
  assert.equal(r.last.runId, second.runId);
});

await checkAsync('a run recorded from a NESTED WORKTREE is read from the main checkout — fleet-wide, not just this tree', async () => {
  const work = makeRepo('fleet-wide', { 'test/a.mjs': failing(['x']) });
  const wt = path.join(work, '.claude', 'worktrees', 'wt-fleet');
  git(work, 'worktree', 'add', '-q', '-b', 'wt-fleet-branch', wt, 'main');

  const { file } = await gaterun.startRun(wt, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });

  // Asked from the MAIN checkout root, never the worktree that actually ran it.
  const [r] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(r.failureCount, 1);
  assert.equal(r.last.worktree, 'wt-fleet');
});

await checkAsync('--base overrides the computed merge-base outright', async () => {
  const work = makeRepo('base-override', { 'test/a.mjs': failing(['x']) });
  const { file } = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });

  fs.writeFileSync(path.join(work, 'test/a.mjs'), passing());
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fix it');
  const fixSha = git(work, 'rev-parse', 'HEAD').trim();
  git(work, 'push', '-q', 'origin', 'main');

  const [withoutBase] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(withoutBase.verdict, 'fixed-on-main', 'the computed base (before the fix) should read as fixed');

  const [withBase] = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs'], { base: fixSha }));
  assert.equal(withBase.verdict, 'still-red', '--base pinned at the fix commit itself leaves nothing after it to call a fix');
  assert.equal(withBase.base, fixSha);
});

/* ===================================================================== *
 * 2. never spawns a suite and never builds a worktree
 * ===================================================================== */

console.log('\nnever runs the suite, never builds a git worktree\n');

await checkAsync('a suite file that is not even valid JavaScript is never executed', async () => {
  const work = makeRepo('no-spawn-proof', {
    // If this were ever handed to `node`, it would throw a SyntaxError before this
    // suite's own assertions got a chance to run — the loudest possible proof that
    // lib/stillred.js never spawns it.
    'test/a.mjs': 'this is not valid JavaScript at all {{{ ((( ]]] must never be executed\n',
  });
  const { file } = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });

  const before = worktreeCount(work);
  const results = await withNoBeads(() => stillred.stillRedAll(work, ['test/a.mjs']));
  assert.equal(results.length, 1); // resolved at all — proves nothing threw parsing/running the suite
  assert.equal(worktreeCount(work), before, 'no git worktree should have been built');
});

check('the same, driven through the real CLI, with no worktree left behind and no crash', () => {
  const work = makeRepo('no-spawn-proof-cli', {
    'test/a.mjs': 'this is not valid JavaScript at all {{{ ((( ]]] must never be executed\n',
  });
  const before = worktreeCount(work);
  const r = spawnSync(process.execPath, [BIN, '--dir', work, 'test/a.mjs'], { encoding: 'utf8', env: CLI_ENV });
  assert.equal(worktreeCount(work), before, 'no git worktree should have been built');
  assert.doesNotMatch(r.stderr || '', /SyntaxError/, 'the garbage suite content must never reach node as code');
});

/* ===================================================================== *
 * 3. the CLI — argv, exit codes, --json, --from, --help
 * ===================================================================== */

console.log('\nbin/b7e-stillred — argv, exit codes, --json, --from\n');

check('--help exits 0 and prints usage', () => {
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-stillred/);
});

check('no suites and no --from exits 2', () => {
  const r = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no suites given/);
});

check('no-record via --dir exits 0', () => {
  const work = makeRepo('cli-no-record', { 'test/a.mjs': failing(['x']) });
  const r = spawnSync(process.execPath, [BIN, '--dir', work, 'test/a.mjs'], { encoding: 'utf8', env: CLI_ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /nothing on file/);
});

await checkAsync('still-red via --dir exits 1', async () => {
  const work = makeRepo('cli-still-red', { 'test/a.mjs': failing(['x']) });
  const { file } = await gaterun.startRun(work, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.1 });
  const r = spawnSync(process.execPath, [BIN, '--dir', work, 'test/a.mjs'], { encoding: 'utf8', env: CLI_ENV });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /no fix on origin\/main since your base/);
});

check('--json prints one parseable object per suite', () => {
  const work = makeRepo('cli-json', { 'test/a.mjs': failing(['x']) });
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--json', 'test/a.mjs'], { encoding: 'utf8', env: CLI_ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const rows = JSON.parse(r.stdout.trim());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].suite, 'test/a.mjs');
  assert.equal(rows[0].verdict, 'no-record');
});

check('--from reads a b7e-gate log and asks about every suite it named FAIL/TIMEOUT', () => {
  const work = makeRepo('cli-from', { 'test/a.mjs': failing(['x']), 'test/b.mjs': passing() });
  const logPath = path.join(tmp, 'gate.log');
  fs.writeFileSync(logPath, '[1/2] FAIL test/a.mjs 0.1s\n[2/2] ok test/b.mjs 0.1s\nsome failed\n');
  const r = spawnSync(process.execPath, [BIN, '--dir', work, '--from', logPath], { encoding: 'utf8', env: CLI_ENV });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /test\/a\.mjs/);
  assert.doesNotMatch(r.stdout, /test\/b\.mjs/, 'only the FAIL/TIMEOUT lines should be pulled out of the log');
});

removeTreeSync(tmp);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall b7e-stillred checks passed');
