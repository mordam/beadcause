#!/usr/bin/env node
//
// b7e-flake — how often does a suite actually fail, over N runs, with every run's
// output kept (bc-dgx7.73).
//
//   npm test
//   node test/flake.mjs
//
// lib/flake.js does the loop, the per-run logging and the failure-signature grouping;
// this drives it directly against fabricated trees, the same split test/gate.mjs and
// test/triage.mjs use for their own siblings — a real flaky suite is, by definition, not
// something this suite can drive deterministically. A handful of calls through the real
// bin/b7e-flake binary cover what only the CLI does: argv parsing, --env, --json, and
// the exit code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-flake');

const flakeLib = await import(path.join(ROOT, 'lib', 'flake.js'));
const { failureSignature, runFlakeTarget, runFlake, targetSummaryLine, failureLines, targetSlug } = flakeLib;

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-flake-test-'));

/** A fresh `<tmp>/<name>/` directory holding the given files — same shape test/gate.mjs and test/triage.mjs use. Not a git checkout, on purpose: `runFlake` must fall back gracefully rather than resolve `.claude/gate-runs` through a real repo. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const alwaysPass = () => 'process.exit(0);\n';
const alwaysFail = (msg = 'broken') => `console.log('${msg}');\nprocess.exit(1);\n`;
/** Fails on every Nth invocation, counted in a file under `counterFile` — deterministic, unlike a real flake, so a test can assert an exact rate. */
const failsEveryNth = (n, counterFile, message = 'ENOTEMPTY: directory not empty') =>
  [
    "import fs from 'node:fs';",
    `const f = ${JSON.stringify(counterFile)};`,
    "let n = 0;",
    "try { n = Number(fs.readFileSync(f, 'utf8')); } catch {}",
    'n += 1;',
    'fs.writeFileSync(f, String(n));',
    `if (n % ${n} === 0) { console.log(${JSON.stringify(message)}); process.exit(1); }`,
    'process.exit(0);',
  ].join('\n') + '\n';
/** Throws a real `AssertionError`, the shape `assert.equal` leaves in a suite's stdout. */
const assertionFailure = (detail = 'expected true') =>
  [
    "import assert from 'node:assert/strict';",
    `assert.equal(false, true, ${JSON.stringify(detail)});`,
  ].join('\n') + '\n';
/** Sleeps, then exits — for proving concurrency (`--jobs`) actually overlaps runs. */
const timed = (logPath, sleepMs = 150) =>
  [
    "import fs from 'node:fs';",
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ at: 'start', t: Date.now() }) + '\\n');`,
    `await new Promise((r) => setTimeout(r, ${sleepMs}));`,
    `fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ at: 'end', t: Date.now() }) + '\\n');`,
    'process.exit(0);',
  ].join('\n') + '\n';
/** Echoes an env var into stdout, to prove `--env`/`env` actually reaches the child. */
const echoesEnv = (varName) => `console.log(process.env[${JSON.stringify(varName)}] ?? '(unset)');\nprocess.exit(0);\n`;
const readLog = (p) =>
  fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

/* ===================================================================== *
 * 1. failureSignature — grouping a failing run by the one line worth reading
 * ===================================================================== */

console.log('\nfailureSignature groups a failing run by its first recognisable line\n');

check('an errno-style code, wherever it appears in the output, wins', () => {
  const out = "some preamble\nENOTEMPTY: directory not empty, rmdir '/x/config/.git'\nmore\n";
  assert.equal(failureSignature({ out, status: 'FAIL' }), 'ENOTEMPTY');
});
check('an AssertionError line, absent an errno code', () => {
  const out = 'AssertionError [ERR_ASSERTION]: expected true to equal false\n    at file.js:1:1\n';
  assert.match(failureSignature({ out, status: 'FAIL' }), /^AssertionError/);
});
check('a "SomethingError:" line, absent the above', () => {
  const out = 'TypeError: cannot read properties of undefined\n    at file.js:1:1\n';
  assert.match(failureSignature({ out, status: 'FAIL' }), /^TypeError:/);
});
check('timedOut wins outright, regardless of what the output says', () => {
  assert.equal(failureSignature({ out: 'ENOENT: whatever\n', status: 'TIMEOUT', timedOut: true }), 'timeout');
});
check('a signal, absent any recognisable output line', () => {
  assert.equal(failureSignature({ out: 'nothing useful here\n', status: 'FAIL', signal: 'SIGKILL', code: null }), 'signal SIGKILL');
});
check('falls back to the bare exit code when nothing else is recognisable', () => {
  assert.equal(failureSignature({ out: 'nothing useful here\n', status: 'FAIL', code: 7 }), 'exit 7');
});
check('never throws on empty or missing output', () => {
  assert.equal(failureSignature({ status: 'FAIL', code: 1 }), 'exit 1');
  assert.equal(failureSignature({ out: '', status: 'FAIL', code: 1 }), 'exit 1');
});

/* ===================================================================== *
 * 2. runFlakeTarget / runFlake — the real loop, against fabricated trees
 * ===================================================================== */

console.log('\nrunFlakeTarget/runFlake — the loop, run for real\n');

await checkAsync('every run of a clean suite passes, and each gets its own kept log', async () => {
  const dir = tree('clean', { 'test/wasfine.mjs': alwaysPass() });
  const logDir = path.join(tmp, 'clean-logs');
  const t = await runFlakeTarget(dir, 'test/wasfine.mjs', { runs: 5, jobs: 2, dir: logDir });
  assert.equal(t.passed, 5);
  assert.equal(t.failed, 0);
  assert.equal(t.results.length, 5);
  for (const r of t.results) {
    assert.equal(r.status, 'ok');
    assert.equal(fs.existsSync(r.logPath), true, `run ${r.index}'s log must exist even though it passed`);
  }
});

await checkAsync('a suite that fails every Nth run reports that exact rate, with every failing log kept', async () => {
  const counterFile = path.join(tmp, 'nth-counter');
  const dir = tree('everynth', { 'test/flaky.mjs': failsEveryNth(7, counterFile) });
  const logDir = path.join(tmp, 'everynth-logs');
  const t = await runFlakeTarget(dir, 'test/flaky.mjs', { runs: 21, jobs: 1, dir: logDir });
  assert.equal(t.passed, 18);
  assert.equal(t.failed, 3, 'exactly 3 of 21 should fail on a 1-in-7 rate');
  const failedRuns = t.results.filter((r) => r.status !== 'ok').map((r) => r.index);
  assert.deepEqual(failedRuns, [7, 14, 21]);
  for (const r of t.results.filter((r) => r.status !== 'ok')) {
    assert.equal(fs.existsSync(r.logPath), true);
    assert.match(fs.readFileSync(r.logPath, 'utf8'), /ENOTEMPTY/, `run ${r.index}'s log must keep its own output`);
  }
  assert.equal(t.signatures.length, 1);
  assert.equal(t.signatures[0].signature, 'ENOTEMPTY');
  assert.equal(t.signatures[0].count, 3);
});

await checkAsync('two different failure causes are reported as two separate signatures', async () => {
  const dir = tree('twosigs', {
    'test/mixed.mjs': [
      "const n = Number(process.env.RUN_N || '0');",
      "if (n % 2 === 0) { console.log('ENOENT: no such file'); process.exit(1); }",
      "console.log('AssertionError: nope'); process.exit(1);",
    ].join('\n') + '\n',
  });
  // every run fails, alternating cause by an index this test controls itself rather than
  // depending on scheduling order — one call per parity, 4 runs each.
  const evens = await runFlakeTarget(dir, 'test/mixed.mjs', {
    runs: 4,
    jobs: 1,
    dir: path.join(tmp, 'twosigs-evens'),
    env: { RUN_N: '0' },
  });
  const odds = await runFlakeTarget(dir, 'test/mixed.mjs', {
    runs: 4,
    jobs: 1,
    dir: path.join(tmp, 'twosigs-odds'),
    env: { RUN_N: '1' },
  });
  assert.equal(evens.signatures[0].signature, 'ENOENT');
  assert.match(odds.signatures[0].signature, /^AssertionError/);
});

await checkAsync('env is forwarded to every run', async () => {
  const dir = tree('envfwd', { 'test/echo.mjs': echoesEnv('B7E_FLAKE_TEST_VAR') });
  const t = await runFlakeTarget(dir, 'test/echo.mjs', {
    runs: 2,
    jobs: 1,
    dir: path.join(tmp, 'envfwd-logs'),
    env: { B7E_FLAKE_TEST_VAR: 'hello-from-flake' },
  });
  for (const r of t.results) {
    assert.equal(fs.readFileSync(r.logPath, 'utf8').trim(), 'hello-from-flake');
  }
});

await checkAsync('--timeout (an override) kills a hung run, which counts as a failure with signature "timeout"', async () => {
  const dir = tree('hangs', { 'test/hangs.mjs': timed(path.join(tmp, 'hangs.jsonl'), 4000) });
  const t = await runFlakeTarget(dir, 'test/hangs.mjs', {
    runs: 1,
    jobs: 1,
    dir: path.join(tmp, 'hangs-logs'),
    timeoutOverrideMs: 200,
  });
  assert.equal(t.results[0].status, 'TIMEOUT');
  assert.equal(t.results[0].signature, 'timeout');
});

await checkAsync('--jobs actually overlaps runs rather than forcing them serial', async () => {
  const logPath = path.join(tmp, 'concurrent.jsonl');
  const dir = tree('concurrent', { 'test/slow.mjs': timed(logPath, 200) });
  await runFlakeTarget(dir, 'test/slow.mjs', { runs: 4, jobs: 4, dir: path.join(tmp, 'concurrent-logs') });
  const events = readLog(logPath);
  const starts = events.filter((e) => e.at === 'start').map((e) => e.t).sort((a, b) => a - b);
  const ends = events.filter((e) => e.at === 'end').map((e) => e.t).sort((a, b) => a - b);
  // If every run were serial, the 4th start would come after the 1st end. At jobs=4 they
  // are all started before any of them can have ended (each sleeps 200ms).
  assert.ok(starts[3] < ends[0] + 200, 'the 4th run should start well before any could have finished serially');
});

await checkAsync('runFlake covers more than one target, each with its own subdirectory of logs', async () => {
  const dir = tree('multitarget', {
    'test/a.mjs': alwaysPass(),
    'test/b.mjs': alwaysFail('b is broken'),
  });
  const runDir = path.join(tmp, 'multitarget-run');
  const result = await runFlake(dir, ['test/a.mjs', 'test/b.mjs'], { runs: 3, jobs: 2, dir: runDir });
  assert.equal(result.ok, false);
  assert.equal(result.targets.length, 2);
  const [a, b] = result.targets;
  assert.equal(a.failed, 0);
  assert.equal(b.failed, 3);
  assert.equal(
    path.dirname(a.results[0].logPath),
    path.join(runDir, targetSlug('test/a.mjs')),
  );
  assert.equal(
    path.dirname(b.results[0].logPath),
    path.join(runDir, targetSlug('test/b.mjs')),
  );
  assert.equal(typeof result.loadStart, 'number');
  assert.equal(typeof result.loadEnd, 'number');
});

await checkAsync('a --dir that is not a git checkout does not throw — it mints a plain tmp directory instead', async () => {
  const dir = tree('nongit', { 'test/wasfine.mjs': alwaysPass() });
  assert.equal(fs.existsSync(path.join(dir, '.git')), false);
  const result = await runFlake(dir, ['test/wasfine.mjs'], { runs: 1, jobs: 1 });
  assert.equal(result.ok, true);
  assert.equal(fs.existsSync(result.dir), true);
});

/* ===================================================================== *
 * 3. reporting — pure formatting
 * ===================================================================== */

console.log('\nreporting\n');

check('targetSummaryLine for a clean target', () => {
  assert.equal(targetSummaryLine({ target: 'test/a.mjs', passed: 5, runs: 5, failed: 0 }), 'test/a.mjs: 5/5 passed');
});
check('targetSummaryLine names every signature and its count', () => {
  const t = {
    target: 'test/a.mjs',
    passed: 18,
    runs: 21,
    failed: 3,
    signatures: [{ signature: 'ENOTEMPTY', count: 3 }],
  };
  assert.equal(targetSummaryLine(t), 'test/a.mjs: 18/21 passed, 3 failed (ENOTEMPTY x3)');
});
check('failureLines names each failing run and its log path', () => {
  const t = {
    results: [
      { index: 1, status: 'ok', logPath: '/x/run-001.log' },
      { index: 2, status: 'FAIL', signature: 'ENOTEMPTY', logPath: '/x/run-002.log' },
    ],
  };
  assert.deepEqual(failureLines(t), ['  run 2: ENOTEMPTY — /x/run-002.log']);
});

/* ===================================================================== *
 * 4. the CLI — argv parsing, --env, --json, exit codes
 * ===================================================================== */

console.log('\nthe CLI\n');

check('--help prints usage and exits 0 without running anything', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /b7e-flake/);
});

check('with no target given, it refuses with exit code 2', () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no target given/);
});

check('a malformed --env is refused with exit code 2', () => {
  const run = spawnSync(process.execPath, [BIN, 'whatever.mjs', '--env', 'NOEQUALSSIGN'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--env wants K=V/);
});

{
  const dir = tree('cli', {
    'test/clean.mjs': alwaysPass(),
    'test/broken.mjs': alwaysFail('cli broken'),
  });

  check('a clean target over --runs runs exits 0, and prints the rate', () => {
    const run = spawnSync(process.execPath, [BIN, 'test/clean.mjs', '--runs', '3', '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /test\/clean\.mjs: 3\/3 passed/);
  });

  check('an always-failing target exits 1, and names a failing run\'s log path', () => {
    const run = spawnSync(process.execPath, [BIN, 'test/broken.mjs', '--runs', '2', '--jobs', '1', '--dir', dir], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /test\/broken\.mjs: 0\/2 passed, 2 failed/);
    assert.match(run.stdout, /run 1:.*\.log/);
  });

  check('two targets in one call are both reported', () => {
    const run = spawnSync(process.execPath, [BIN, 'test/clean.mjs', 'test/broken.mjs', '--runs', '2', '--dir', dir], {
      encoding: 'utf8',
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /test\/clean\.mjs: 2\/2 passed/);
    assert.match(run.stdout, /test\/broken\.mjs: 0\/2 passed/);
  });

  check('--json prints one object per run plus a final summary object', () => {
    const run = spawnSync(process.execPath, [BIN, 'test/clean.mjs', '--runs', '2', '--dir', dir, '--json'], {
      encoding: 'utf8',
    });
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 3, `expected two run records plus a summary, got ${lines.length}`);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.summary, true);
    assert.equal(summary.targets[0].passed, 2);
  });

  check('--env K=V reaches the child process', () => {
    const echoDir = tree('cli-env', { 'test/echo.mjs': echoesEnv('B7E_FLAKE_CLI_VAR') });
    const run = spawnSync(
      process.execPath,
      [BIN, 'test/echo.mjs', '--runs', '1', '--dir', echoDir, '--env', 'B7E_FLAKE_CLI_VAR=from-the-cli'],
      { encoding: 'utf8' },
    );
    assert.equal(run.status, 0);
    // the printed report does not echo a run's own stdout, so read it back off disk —
    // every per-run line names its log path, passing or not.
    const plain = run.stdout.replace(/\x1b\[[0-9;]*m/g, '');
    const logLine = plain.split('\n').find((l) => l.includes('.log'));
    const logPath = logLine.trim().split(/\s+/).pop();
    assert.equal(fs.readFileSync(logPath, 'utf8').trim(), 'from-the-cli');
  });
}

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall flake checks passed\n');
process.exit(failures ? 1 : 0);
