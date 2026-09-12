#!/usr/bin/env node
//
// b7e-why — what the failing suite actually printed, out of a finished gate run
// (bc-dgx7.66), against `lib/gaterun.js`'s `stripAnsi`/`whyFor` and the real CLI.
//
//   npm test
//   node test/b7ewhy.mjs
//
// A real bare origin, a working clone and a nested worktree — the same fixture shape
// test/b7ewatch.mjs and test/b7eran.mjs already build for the same module. It has to be
// real on two counts: the CLI shells to `scripts/test.mjs --list --dir <root>` to refuse
// a typo'd suite name, and `runsDir`/`worktreeSlug` resolve through `git rev-parse`.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-why');

const gaterun = await import(path.join(ROOT, 'lib', 'gaterun.js'));

const ESC = String.fromCharCode(27);

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
 * fixture
 * ===================================================================== */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7ewhy-test-'));

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

const passing = () => "console.log('  ok   the one check');\nprocess.exit(0);\n";
const failing = (name) => `console.log('  FAIL ${name}');\nprocess.exit(1);\n`;

const main = makeRepo('main-repo', {
  'test/green.mjs': passing(),
  'test/red.mjs': failing('an assertion'),
  'test/never.mjs': passing(),
  'test/timedout.mjs': passing(),
});

// A worktree under `.claude/worktrees/`, this repo's own layout — what proves a run
// started in one place is readable from another, since `runsDir` resolves to the main
// checkout from either side.
const wt1 = path.join(main, '.claude', 'worktrees', 'wt1');
git(main, 'worktree', 'add', '-q', '-b', 'wt1-branch', wt1, 'main');
// What a real suite writes into the record: the runner's own colour, around the check
// names and the assertion text a session actually needs to read.
const COLOURED_TAIL = [
  `  ${ESC}[32m✓${ESC}[0m A CHECK THAT PASSED`,
  `  ${ESC}[31m✗${ESC}[0m THE CHECK THAT DID NOT`,
  `      Expected values to be strictly equal:${ESC}[22m`,
  '      + actual - expected',
  '',
  `${ESC}[31m1 failed${ESC}[0m`,
].join('\n');

/* ===================================================================== *
 * 1. lib/gaterun.js — stripAnsi / whyFor
 * ===================================================================== */

console.log('\nlib/gaterun.js: stripAnsi, whyFor\n');

check('stripAnsi takes colour off and leaves the text, including the check names and the assertion', () => {
  const out = gaterun.stripAnsi(COLOURED_TAIL);
  assert.ok(!out.includes(ESC), 'no escape byte may survive');
  assert.match(out, /✓ A CHECK THAT PASSED/);
  assert.match(out, /✗ THE CHECK THAT DID NOT/);
  assert.match(out, /Expected values to be strictly equal:$/m);
});

check('stripAnsi drops a lone escape byte with nothing recognisable after it', () => {
  // The one a naive `s/ESC\[[0-9;]*m//` leaves behind — invisible in every reader, and
  // a control byte in whatever field it is pasted into.
  assert.equal(gaterun.stripAnsi(`before${ESC}after`), 'beforeafter');
});

check('stripAnsi on nothing at all is the empty string, not a crash or "undefined"', () => {
  assert.equal(gaterun.stripAnsi(undefined), '');
  assert.equal(gaterun.stripAnsi(null), '');
});

await checkAsync('whyFor with no names answers exactly the run\'s failed suites, tail stripped', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/green.mjs', 'test/red.mjs', 'test/never.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.2 });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 1.5, tail: COLOURED_TAIL });
  gaterun.endRun(file, { status: 'fail', elapsed: 2 });
  const run = gaterun.readRun(file);

  const records = gaterun.whyFor(run);
  assert.equal(records.length, 1, 'only the failed suite — the green one is not an explanation');
  assert.equal(records[0].suite, 'test/red.mjs');
  assert.equal(records[0].verdict, 'FAIL');
  assert.ok(!records[0].why.includes(ESC));
  assert.match(records[0].why, /THE CHECK THAT DID NOT/);
});

await checkAsync('whyFor with explicit names answers a passing suite and a never-ran one too', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/green.mjs', 'test/red.mjs', 'test/never.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.2 });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 1.5, tail: COLOURED_TAIL });
  gaterun.endRun(file, { status: 'fail', elapsed: 2 });
  const run = gaterun.readRun(file);

  const byName = Object.fromEntries(
    gaterun.whyFor(run, ['test/green.mjs', 'test/never.mjs']).map((r) => [r.suite, r])
  );
  assert.equal(byName['test/green.mjs'].ran, true);
  assert.equal(byName['test/green.mjs'].verdict, 'ok');
  assert.equal(byName['test/green.mjs'].why, null, 'a suite that passed has nothing to explain');
  assert.equal(byName['test/never.mjs'].ran, false);
  assert.equal(byName['test/never.mjs'].why, null);
});

check('whyFor on a run with nothing failed and no names is an empty list, not a throw', () => {
  assert.deepEqual(gaterun.whyFor({ failed: [], results: [] }), []);
  assert.deepEqual(gaterun.whyFor({ results: [] }), [], 'a run record with no failed key at all');
});

/* ===================================================================== *
 * 2. the CLI — spawned for real, against the fixture
 * ===================================================================== */

console.log('\nthe CLI\n');

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

check('no gate run at all for this worktree — exit 2, says so', () => {
  const scratch = makeRepo('cli-empty', { 'test/x.mjs': passing() });
  const r = run(scratch);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no gate run found/);
});

check('--run naming a run that does not exist — exit 2', () => {
  const scratch = makeRepo('cli-badrun', { 'test/x.mjs': passing() });
  const r = run(scratch, ['--run', 'nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no run nope/);
});

check('a suite name that is not in the repo — refused, exit 2, not reported as never-ran', () => {
  const r = run(main, ['test/does-not-exist.mjs']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a suite in this repo/);
  assert.doesNotMatch(r.stdout, /never-ran/);
});

// THE BEAD'S OWN ACCEPTANCE CRITERION: against a run file with a failed suite whose tail
// holds ANSI codes, ONE call prints the check names and the assertion text with no escape
// sequences and no second run of the suite.
await checkAsync('one call prints the failed suite\'s recorded tail — check names, assertion text, no escape sequences', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/green.mjs', 'test/red.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.2 });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 1.5, tail: COLOURED_TAIL });
  gaterun.endRun(file, { status: 'fail', elapsed: 2 });

  const r = run(main);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /test\/red\.mjs: FAIL 1\.5s/);
  assert.match(r.stdout, /A CHECK THAT PASSED/);
  assert.match(r.stdout, /THE CHECK THAT DID NOT/);
  assert.match(r.stdout, /Expected values to be strictly equal:/);
  assert.ok(!r.stdout.includes(ESC), 'the printed output must carry no escape sequence — recorded or added');
  assert.doesNotMatch(r.stdout, /test\/green\.mjs/, 'a passing suite is not asked about by default');
});

await checkAsync('the tail survives verbatim from appendResult to the printed output, line for line', async () => {
  const written = 'first line\n  indented second\n\nfourth after a blank';
  const { file } = await gaterun.startRun(main, { suites: ['test/red.mjs'] });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 0.1, tail: written });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.2 });

  const r = run(main);
  const printed = r.stdout
    .split('\n')
    .filter((l) => l.startsWith('  '))
    .map((l) => l.slice(2));
  assert.deepEqual(printed, written.split('\n').map((l) => l), 'every line, in order, indented by exactly two spaces');
});

await checkAsync('a named suite that did not fail says so rather than printing nothing', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/green.mjs', 'test/red.mjs', 'test/never.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.4 });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 0.1, tail: 'FAIL something' });
  gaterun.endRun(file, { status: 'fail', elapsed: 1 });

  const green = run(main, ['test/green.mjs']);
  assert.equal(green.status, 0, green.stderr);
  assert.match(green.stdout, /test\/green\.mjs: ran ok 0\.4s — nothing to explain/);

  const never = run(main, ['test/never.mjs']);
  assert.equal(never.status, 1);
  assert.match(never.stdout, /test\/never\.mjs: never-ran/);
});

await checkAsync('a finished green run — says nothing failed, exit 0', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/green.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 0.1 });
  const r = run(main);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing failed/);
});

await checkAsync('a failed suite the gate recorded no tail for says so rather than printing a bare heading', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/red.mjs'] });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.2 });
  const r = run(main);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /no output was recorded/);
});

await checkAsync('TIMEOUT is reported as its own verdict, recovered from the tail', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/timedout.mjs'] });
  gaterun.appendResult(file, {
    suite: 'test/timedout.mjs',
    status: 'fail',
    elapsed: 300,
    tail: 'still going\ntimed out after 300s — killed',
  });
  gaterun.endRun(file, { status: 'fail', elapsed: 300 });
  const r = run(main);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /test\/timedout\.mjs: TIMEOUT 300\.0s/);
  assert.match(r.stdout, /timed out after 300s — killed/);
});

await checkAsync('--json prints one parseable record per line, with the stripped tail in `why`', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/red.mjs'] });
  gaterun.appendResult(file, { suite: 'test/red.mjs', status: 'fail', elapsed: 1.5, tail: COLOURED_TAIL });
  gaterun.endRun(file, { status: 'fail', elapsed: 2 });
  const r = run(main, ['--json']);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].suite, 'test/red.mjs');
  assert.equal(lines[0].verdict, 'FAIL');
  assert.ok(!lines[0].why.includes(ESC));
  assert.match(lines[0].why, /THE CHECK THAT DID NOT/);
  assert.ok(lines[0].tail.includes(ESC), 'the raw tail is carried through unchanged beside it');
});

await checkAsync('--run <id> started from one worktree is readable from another', async () => {
  const first = await gaterun.startRun(main, { suites: ['test/red.mjs'] });
  gaterun.appendResult(first.file, { suite: 'test/red.mjs', status: 'fail', elapsed: 0.1, tail: 'the older red' });
  gaterun.endRun(first.file, { status: 'fail', elapsed: 0.2 });
  await new Promise((r) => setTimeout(r, 5));
  const second = await gaterun.startRun(main, { suites: ['test/red.mjs'] });
  gaterun.appendResult(second.file, { suite: 'test/red.mjs', status: 'fail', elapsed: 0.1, tail: 'the newer red' });
  gaterun.endRun(second.file, { status: 'fail', elapsed: 0.2 });

  const latest = run(main);
  assert.match(latest.stdout, /the newer red/, 'with no --run, the newest run wins');

  // Asked for from wt1 — a different worktree, a different session's cwd entirely.
  const older = run(wt1, ['--run', first.runId]);
  assert.match(older.stdout, /the older red/);
});

await checkAsync('--dir points at another tree entirely', async () => {
  const other = makeRepo('cli-otherdir', { 'test/x.mjs': failing('over there') });
  const { file } = await gaterun.startRun(other, { suites: ['test/x.mjs'] });
  gaterun.appendResult(file, { suite: 'test/x.mjs', status: 'fail', elapsed: 0.3, tail: 'a tail from the other tree' });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.3 });
  const r = run(main, ['--dir', other]);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /a tail from the other tree/);
});

/* ===================================================================== *
 * 3. the promise that nothing is ever re-run
 * ===================================================================== */

console.log('\nnothing is re-run\n');

await checkAsync('a recorded red for a suite that does not exist on disk still prints its tail — nothing is re-run', async () => {
  // The proof that the tail comes out of the record and not out of a fresh run: the suite
  // is recorded as failed but its file was never written, so anything that tried to run
  // it would have to report that instead of the assertion text below.
  const { file } = await gaterun.startRun(main, { suites: ['test/deleted-since.mjs'] });
  gaterun.appendResult(file, {
    suite: 'test/deleted-since.mjs',
    status: 'fail',
    elapsed: 9.5,
    tail: `  ${ESC}[31m✗${ESC}[0m WHAT IT SAID WHEN IT RAN`,
  });
  gaterun.endRun(file, { status: 'fail', elapsed: 10 });
  const r = run(main);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /WHAT IT SAID WHEN IT RAN/);
  assert.ok(!r.stdout.includes(ESC));
});

removeTreeSync(tmp);

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall passed\x1b[0m');
