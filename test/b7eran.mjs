#!/usr/bin/env node
//
// b7e-ran — did the gate actually run this suite, and what did it say (bc-dgx7.92),
// against `lib/gaterun.js`'s `resultsFor`/`missingFrom`/`verdictFor` and the real CLI.
//
//   npm test
//   node test/b7eran.mjs
//
// A real git repo with a real `test/` directory, the same shape test/b7ewatch.mjs and
// test/b7egated.mjs already build for the same module — the CLI shells to
// `scripts/test.mjs --list --dir <root>` to refuse a typo'd suite name, and that has
// to see real files on disk to answer, not a fabricated list a fake filesystem would
// just agree with itself about.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-ran');

const gaterun = await import(path.join(ROOT, 'lib', 'gaterun.js'));

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
 * fixture — a real repo with a real test/ directory, the same shape
 * test/b7ewatch.mjs already builds.
 * ===================================================================== */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7eran-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

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

const passing = () => "console.log('  ok   fixture suite');\nprocess.exit(0);\n";

const main = makeRepo('main-repo', {
  'test/a.mjs': passing(),
  'test/b.mjs': passing(),
  'test/c.mjs': passing(),
  'test/never.mjs': passing(),
  'test/timedout.mjs': passing(),
});

/* ===================================================================== *
 * 1. lib/gaterun.js — resultsFor / missingFrom / verdictFor
 * ===================================================================== */

console.log('\nlib/gaterun.js: resultsFor, missingFrom, verdictFor\n');

check('verdictFor: ok status, no timeout tail, a fail with no timeout tail, a fail with a timeout tail', () => {
  assert.equal(gaterun.verdictFor({ status: 'ok' }), 'ok');
  assert.equal(gaterun.verdictFor({ status: 'fail', tail: '  FAIL something broke' }), 'FAIL');
  assert.equal(gaterun.verdictFor({ status: 'fail', tail: 'suite output\ntimed out after 300s — killed' }), 'TIMEOUT');
  assert.equal(gaterun.verdictFor(null), null, 'no record at all — nothing to verdict');
});

await checkAsync('resultsFor: ran (ok), ran (FAIL), ran (TIMEOUT via tail), and never-ran, all in one run', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/a.mjs', 'test/b.mjs', 'test/c.mjs', 'test/never.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'ok', elapsed: 1.234 });
  gaterun.appendResult(file, { suite: 'test/b.mjs', status: 'fail', elapsed: 0.5, tail: '  FAIL not ok' });
  gaterun.appendResult(file, {
    suite: 'test/c.mjs',
    status: 'fail',
    elapsed: 300,
    tail: 'partial output\ntimed out after 300s — killed',
  });
  gaterun.endRun(file, { status: 'fail', elapsed: 302 });
  const run = gaterun.readRun(file);

  const records = gaterun.resultsFor(run, ['test/a.mjs', 'test/b.mjs', 'test/c.mjs', 'test/never.mjs']);
  const byName = Object.fromEntries(records.map((r) => [r.suite, r]));

  assert.equal(byName['test/a.mjs'].ran, true);
  assert.equal(byName['test/a.mjs'].verdict, 'ok');
  assert.equal(byName['test/a.mjs'].elapsed, 1.234);

  assert.equal(byName['test/b.mjs'].ran, true);
  assert.equal(byName['test/b.mjs'].verdict, 'FAIL');

  assert.equal(byName['test/c.mjs'].ran, true);
  assert.equal(byName['test/c.mjs'].verdict, 'TIMEOUT');

  assert.equal(byName['test/never.mjs'].ran, false);
  assert.equal(byName['test/never.mjs'].verdict, null);
  assert.equal(byName['test/never.mjs'].status, null);
  assert.equal(byName['test/never.mjs'].elapsed, null);

  // The exact ambiguity a basename grep cannot resolve — bc-dgx7.80's debrief.
  assert.deepEqual(gaterun.missingFrom(run), ['test/never.mjs']);
});

check('missingFrom returns [] for a run with no recorded suites list at all — nothing to diff, not a false "all missing"', () => {
  assert.deepEqual(gaterun.missingFrom({ suites: null, results: [] }), []);
});

/* ===================================================================== *
 * 2. the CLI — spawned for real, against the fixture
 * ===================================================================== */

console.log('\nthe CLI\n');

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

check('no suite named and no --missing — refused, exit 2', () => {
  const r = run(main, []);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /name at least one suite/);
});

check('--missing given alongside suite names — refused, exit 2', () => {
  const r = run(main, ['--missing', 'test/a.mjs']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /does not take suite names/);
});

check('no gate run at all for this worktree — exit 2, says so', () => {
  const scratch = makeRepo('cli-empty', { 'test/x.mjs': passing() });
  const r = run(scratch, ['test/x.mjs']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no gate run found/);
});

check('--run naming a run that does not exist — exit 2', () => {
  const scratch = makeRepo('cli-badrun', { 'test/x.mjs': passing() });
  const r = run(scratch, ['--run', 'nope', 'test/x.mjs']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no run nope/);
});

check('a suite name that is not in the repo — refused as unknown, exit 2, not reported as never-ran', () => {
  const r = run(main, ['test/does-not-exist.mjs']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a suite in this repo/);
  assert.doesNotMatch(r.stdout, /never-ran/);
});

await checkAsync('a suite that ran and passed — prints ok with a duration, exit 0', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'ok', elapsed: 2.5 });
  gaterun.endRun(file, { status: 'ok', elapsed: 2.5 });
  const r = run(main, ['test/a.mjs']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test\/a\.mjs: ran ok 2\.5s/);
});

await checkAsync('a suite that never ran — prints never-ran, exit 1', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/a.mjs', 'test/never.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'ok', elapsed: 1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 1 });
  const r = run(main, ['test/never.mjs']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /test\/never\.mjs: never-ran/);
});

await checkAsync('a suite that ran and failed — prints FAIL, exit 1', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/b.mjs'] });
  gaterun.appendResult(file, { suite: 'test/b.mjs', status: 'fail', elapsed: 0.9, tail: '  FAIL oops' });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.9 });
  const r = run(main, ['test/b.mjs']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /test\/b\.mjs: ran FAIL 0\.9s/);
});

await checkAsync('a suite that timed out — prints TIMEOUT (recovered from the tail), exit 1', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/timedout.mjs'] });
  gaterun.appendResult(file, {
    suite: 'test/timedout.mjs',
    status: 'fail',
    elapsed: 300,
    tail: 'still going\ntimed out after 300s — killed',
  });
  gaterun.endRun(file, { status: 'fail', elapsed: 300 });
  const r = run(main, ['test/timedout.mjs']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /test\/timedout\.mjs: ran TIMEOUT 300\.0s/);
});

await checkAsync('--missing prints exactly the suites the run selected but never produced a result for', async () => {
  const { file } = await gaterun.startRun(main, {
    suites: ['test/a.mjs', 'test/b.mjs', 'test/c.mjs', 'test/never.mjs', 'test/timedout.mjs'],
  });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'ok', elapsed: 1 });
  gaterun.appendResult(file, { suite: 'test/b.mjs', status: 'ok', elapsed: 1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 2 });
  const r = run(main, ['--missing']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /test\/c\.mjs: never-ran/);
  assert.match(r.stdout, /test\/never\.mjs: never-ran/);
  assert.match(r.stdout, /test\/timedout\.mjs: never-ran/);
  assert.doesNotMatch(r.stdout, /test\/a\.mjs/);
  assert.doesNotMatch(r.stdout, /test\/b\.mjs/);
});

await checkAsync('--missing on a run with nothing missing — says so, exit 0', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/a.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'ok', elapsed: 1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 1 });
  const r = run(main, ['--missing']);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing missing/);
});

await checkAsync('--json prints one parseable record per line', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/a.mjs', 'test/never.mjs'] });
  gaterun.appendResult(file, { suite: 'test/a.mjs', status: 'ok', elapsed: 1.5 });
  gaterun.endRun(file, { status: 'ok', elapsed: 1.5 });
  const r = run(main, ['test/a.mjs', 'test/never.mjs', '--json']);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].suite, 'test/a.mjs');
  assert.equal(lines[0].verdict, 'ok');
  assert.equal(lines[1].suite, 'test/never.mjs');
  assert.equal(lines[1].ran, false);
});

await checkAsync('--run <id> reads a specific run rather than the latest', async () => {
  const first = await gaterun.startRun(main, { suites: ['test/a.mjs'] });
  gaterun.appendResult(first.file, { suite: 'test/a.mjs', status: 'ok', elapsed: 1 });
  gaterun.endRun(first.file, { status: 'ok', elapsed: 1 });
  await new Promise((r) => setTimeout(r, 5));
  const second = await gaterun.startRun(main, { suites: ['test/a.mjs'] });
  gaterun.appendResult(second.file, { suite: 'test/a.mjs', status: 'fail', elapsed: 1, tail: '  FAIL' });
  gaterun.endRun(second.file, { status: 'fail', elapsed: 1 });

  const latest = run(main, ['test/a.mjs']);
  assert.match(latest.stdout, /FAIL/, 'with no --run, the newest run wins');

  const older = run(main, ['test/a.mjs', '--run', first.runId]);
  assert.match(older.stdout, /ran ok/);
  assert.match(older.stdout, new RegExp(first.runId));
});

await checkAsync('--dir points at another tree entirely', async () => {
  const other = makeRepo('cli-otherdir', { 'test/x.mjs': passing() });
  const { file } = await gaterun.startRun(other, { suites: ['test/x.mjs'] });
  gaterun.appendResult(file, { suite: 'test/x.mjs', status: 'ok', elapsed: 0.3 });
  gaterun.endRun(file, { status: 'ok', elapsed: 0.3 });
  const r = run(main, ['test/x.mjs', '--dir', other]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test\/x\.mjs: ran ok/);
});

removeTreeSync(tmp);

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall passed\x1b[0m');
