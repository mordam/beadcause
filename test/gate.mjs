#!/usr/bin/env node
//
// b7e-gate — the whole suite without bailing, and the one runner instead of nine
// hand-rolled scratchpad ones (bc-khoe.39).
//
//   npm test
//   node test/gate.mjs
//
// lib/gate.js does the discovery, the filtering, the concurrent pool and the lock; this
// drives it directly against fabricated trees rather than running it against this repo's
// own ~350 suites, which would make testing the gate slower than the thing it replaces.
// A handful of calls through the real `bin/b7e-gate` binary cover what only the CLI does:
// parsing repeatable `--only`/`--skip` flags, refusing a second invocation on the same
// tree, and printing JSON.
//
// Two things get proved rather than assumed, because [[parallel-runner-must-not-use-spawnsync]]
// is exactly the failure a runner like this can have and still look right from the log:
// that suites in the pool genuinely overlap in wall-clock time, and that a suite past its
// timeout is actually killed rather than merely reported slow while it goes on running.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-gate');

const gate = await import(path.join(ROOT, 'lib', 'gate.js'));

// This suite spawns real runners, and both of them now take a machine-wide gate slot
// (bc-xlz32.1). Under a gate they inherit `BEADCAUSE_GATE_HELD` and skip it; run alone
// while two other gates are live they would queue behind them and time out, so opt out
// here — the semaphore itself is proved in test/gateslots.mjs, against its own directory.
process.env.BEADCAUSE_GATE_SLOTS = '0';

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-gate-test-'));

/** A fresh `<tmp>/<name>/test/` directory holding the given files, same shape test/testrunner.mjs uses. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

/** Writes a `.ran` marker on exit, and — with `logPath` — a start/end timestamp either side of a sleep. */
const marker = (name, { exit = 0, sleepMs = 0, logPath } = {}) => {
  const lines = ["import fs from 'node:fs';"];
  if (logPath) {
    lines.push(`fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ name: ${JSON.stringify(name)}, at: 'start', t: Date.now() }) + '\\n');`);
  }
  if (sleepMs) lines.push(`await new Promise((r) => setTimeout(r, ${sleepMs}));`);
  lines.push(`fs.writeFileSync(new URL('./${name}.ran', import.meta.url), '');`);
  if (logPath) {
    lines.push(`fs.appendFileSync(${JSON.stringify(logPath)}, JSON.stringify({ name: ${JSON.stringify(name)}, at: 'end', t: Date.now() }) + '\\n');`);
  }
  lines.push(`process.exit(${exit});`);
  return `${lines.join('\n')}\n`;
};
const didRun = (dir, name) => fs.existsSync(path.join(dir, 'test', `${name}.ran`));
const readLog = (logPath) =>
  fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/* ===================================================================== *
 * 1. pure classification and formatting
 * ===================================================================== */

console.log('\nclassifying a suite\n');

check('a *real.mjs suite is slow', () => assert.equal(gate.isSlow('test/closegatereal.mjs'), true));
check('test/landcheck.mjs is slow though it does not end in real.mjs', () => assert.equal(gate.isSlow('test/landcheck.mjs'), true));
check('an ordinary suite is not slow', () => assert.equal(gate.isSlow('test/gate.mjs'), false));
check('scripts/test-swap.js is solo', () => assert.equal(gate.isSolo('scripts/test-swap.js'), true));
check('test/slowstart.mjs is solo', () => assert.equal(gate.isSolo('test/slowstart.mjs'), true));
check('an ordinary suite is not solo', () => assert.equal(gate.isSolo('test/gate.mjs'), false));

check('an ordinary suite gets the default timeout', () => assert.equal(gate.timeoutMsFor('test/gate.mjs'), gate.DEFAULT_TIMEOUT_MS));
check('a slow suite gets the slow timeout', () => assert.equal(gate.timeoutMsFor('test/adoptsweepreal.mjs'), gate.SLOW_TIMEOUT_MS));
check('--timeout overrides the default uniformly', () => assert.equal(gate.timeoutMsFor('test/gate.mjs', 5000), 5000));
check('--timeout overrides the slow default too', () => assert.equal(gate.timeoutMsFor('test/adoptsweepreal.mjs', 5000), 5000));

console.log('\n--only / --skip matching\n');

check('an exact suite path matches only itself', () => {
  assert.equal(gate.matchesAny('test/a.mjs', ['test/a.mjs']), true);
  assert.equal(gate.matchesAny('test/ab.mjs', ['test/a.mjs']), false);
});
check('a glob with * matches a family', () => {
  assert.equal(gate.matchesAny('test/b7edef.mjs', ['test/b7e*.mjs']), true);
  assert.equal(gate.matchesAny('test/gate.mjs', ['test/b7e*.mjs']), false);
});
check('a dot in a suite name is literal, not "any character"', () => {
  // b7e-affected prints exact paths; a name like test/a.b.mjs must not be matched by
  // a pattern for test/aXb.mjs — the dot in the pattern is escaped, not "any char".
  assert.equal(gate.matchesAny('test/aXb.mjs', ['test/a.b.mjs']), false);
});
check('selectSuites: --only with no match empties the list', () => {
  assert.deepEqual(gate.selectSuites(['test/a.mjs', 'test/b.mjs'], { only: ['test/z.mjs'] }), []);
});
check('selectSuites: --skip removes a named suite and nothing else', () => {
  assert.deepEqual(gate.selectSuites(['test/a.mjs', 'test/b.mjs', 'test/c.mjs'], { skip: ['test/b.mjs'] }), ['test/a.mjs', 'test/c.mjs']);
});
check('selectSuites: only and skip compose, only first', () => {
  assert.deepEqual(
    gate.selectSuites(['test/a.mjs', 'test/b.mjs', 'test/c.mjs'], { only: ['test/a*.mjs', 'test/b*.mjs'], skip: ['test/b.mjs'] }),
    ['test/a.mjs'],
  );
});

console.log('\nthe tally and the JSON record\n');

check('a clean run says "all N suites passed"', () => {
  assert.equal(gate.summaryLine({ passed: 3, total: 3, failed: [] }), 'all 3 suites passed');
});
check('a single-suite clean run is not plural', () => {
  assert.equal(gate.summaryLine({ passed: 1, total: 1, failed: [] }), 'all 1 suite passed');
});
check('a run with failures names them', () => {
  assert.equal(
    gate.summaryLine({ passed: 1, total: 3, failed: [{ suite: 'test/a.mjs' }, { suite: 'test/b.mjs' }] }),
    '1/3 passed, 2 failed: test/a.mjs, test/b.mjs',
  );
});
check('a JSON record carries the fields a human line is built from', () => {
  const rec = gate.toJsonRecord({ suite: 'test/a.mjs', status: 'ok', code: 0, signal: null, ms: 1234 }, 2, 5);
  assert.deepEqual(rec, { index: 2, total: 5, suite: 'test/a.mjs', status: 'ok', code: 0, signal: null, seconds: 1.2 });
});

/* ===================================================================== *
 * 2. the lock — one gate per tree at a time
 * ===================================================================== */

console.log('\nthe lock\n');

{
  const lockRoot = tree('lockroot', {});
  const first = gate.acquireLock(lockRoot);
  check('the first acquire on a tree succeeds', () => assert.equal(first.ok, true));

  const second = gate.acquireLock(lockRoot);
  check('a second acquire on the same tree while the first holds it is refused', () => assert.equal(second.ok, false));
  check('the refusal names the holding pid', () => assert.equal(second.pid, process.pid));

  // Forge a stale record over our own lock file — the pid it names has already exited —
  // and confirm acquireLock reclaims rather than refuses forever.
  const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)']);
  fs.writeFileSync(first.lockPath, JSON.stringify({ pid: dead.pid, startedAt: Date.now() - 999_000 }));
  const third = gate.acquireLock(lockRoot);
  check('a lock whose pid is no longer alive is reclaimed, not left standing forever', () => assert.equal(third.ok, true));
  third.release();

  const fourth = gate.acquireLock(lockRoot);
  check('after release, a fresh acquire on the same tree succeeds', () => assert.equal(fourth.ok, true));
  fourth.release();
  check('release removes the lock file', () => assert.equal(fs.existsSync(fourth.lockPath), false));
}

/* ===================================================================== *
 * 3. runGate — no bail, real concurrency, solo suites held out
 * ===================================================================== */

console.log('\nno bail at the first failure\n');

await checkAsync('a red suite does not stop the others, and is the one named as failed', async () => {
  const dir = tree('nobail', {
    'test/a-pass.mjs': marker('a-pass'),
    'test/b-fail.mjs': marker('b-fail', { exit: 3 }),
    'test/c-pass.mjs': marker('c-pass'),
  });
  const result = await gate.runGate(dir, { jobs: 1 });
  assert.equal(result.total, 3);
  assert.equal(result.ok, false);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].suite, 'test/b-fail.mjs');
  assert.equal(didRun(dir, 'a-pass'), true, 'a-pass should still have run');
  assert.equal(didRun(dir, 'c-pass'), true, 'c-pass should still have run — the point of the whole file');
});

console.log('\nreal concurrency, not spawnSync wearing its clothes\n');

await checkAsync('two suites in the pool genuinely overlap in wall-clock time', async () => {
  const logPath = path.join(tmp, 'concurrency.jsonl');
  const dir = tree('concurrent', {
    'test/x1.mjs': marker('x1', { sleepMs: 400, logPath }),
    'test/x2.mjs': marker('x2', { sleepMs: 400, logPath }),
  });
  const result = await gate.runGate(dir, { jobs: 2 });
  assert.equal(result.ok, true);
  const events = readLog(logPath);
  const starts = events.filter((e) => e.at === 'start');
  const ends = events.filter((e) => e.at === 'end');
  assert.equal(starts.length, 2);
  const laterStart = Math.max(...starts.map((e) => e.t));
  const earlierEnd = Math.min(...ends.map((e) => e.t));
  assert.ok(laterStart < earlierEnd, `the second suite started (${laterStart}) after the first had already finished (${earlierEnd}) — that is serial, not concurrent`);
});

console.log('\nsolo suites hold out of the pool\n');

await checkAsync('a solo suite runs only after the whole pool has finished, never alongside it', async () => {
  const logPath = path.join(tmp, 'solo.jsonl');
  const dir = tree('solo', {
    'test/y1.mjs': marker('y1', { sleepMs: 300, logPath }),
    'test/slowstart.mjs': marker('slowstart', { sleepMs: 50, logPath }),
  });
  const result = await gate.runGate(dir, { jobs: 4 });
  assert.equal(result.ok, true);
  const events = readLog(logPath);
  const y1End = events.find((e) => e.name === 'y1' && e.at === 'end').t;
  const soloStart = events.find((e) => e.name === 'slowstart' && e.at === 'start').t;
  assert.ok(soloStart >= y1End, `scripts/test-swap.js/test/slowstart.mjs must not overlap the pool — solo started at ${soloStart}, pool suite ended at ${y1End}`);
});

console.log('\na suite past its timeout is actually killed\n');

await checkAsync('a hung suite is reported TIMEOUT and does not survive to write its own marker', async () => {
  const dir = tree('timeout', {
    'test/hangs.mjs': marker('hangs', { sleepMs: 4000 }),
  });
  const result = await gate.runGate(dir, { jobs: 1, timeoutOverrideMs: 200 });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].status, 'TIMEOUT');
  assert.equal(didRun(dir, 'hangs'), false, 'a killed suite must not still be running long enough to write its marker');
});

console.log('\nan empty selection\n');

await checkAsync('a tree with no matching suites reports zero rather than throwing', async () => {
  const dir = tree('empty', {});
  const result = await gate.runGate(dir, { jobs: 3 });
  assert.equal(result.total, 0);
  assert.equal(result.ok, true);
});

/* ===================================================================== *
 * 4. the CLI itself — argv parsing, exit codes, --json, the lock refusal
 * ===================================================================== */

console.log('\nthe CLI\n');

{
  const dir = tree('cli-mixed', {
    'test/a-pass.mjs': marker('a-pass'),
    'test/b-fail.mjs': marker('b-fail', { exit: 3 }),
  });

  check('--list prints the selection without running anything', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--list'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.deepEqual(run.stdout.trim().split('\n').sort(), ['test/a-pass.mjs', 'test/b-fail.mjs']);
    assert.equal(didRun(dir, 'a-pass'), false, '--list must not run anything');
  });

  check('--only narrows the CLI selection, repeated flag included', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--only', 'test/a-pass.mjs', '--list'], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'test/a-pass.mjs');
  });

  check('a red suite exits 1 and names the suite in the output', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /test\/b-fail\.mjs/);
    assert.match(run.stdout, /test\/a-pass\.mjs/);
  });

  check('a clean tree exits 0', () => {
    const cleanDir = tree('cli-clean', { 'test/a-pass.mjs': marker('a-pass') });
    const run = spawnSync(process.execPath, [BIN, '--dir', cleanDir], { encoding: 'utf8' });
    assert.equal(run.status, 0);
  });

  check('--json prints one parseable object per line, no prose mixed in', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json'], { encoding: 'utf8' });
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    assert.ok(lines.length >= 3, `expected at least a record per suite plus a summary, got ${lines.length}`);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.summary, true);
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.failed, ['test/b-fail.mjs']);
  });

  check('the log file carries the summary line, not just the per-suite ones', () => {
    // A process.exit() race with the write stream: `stream.end()` alone does not wait for
    // the underlying write to land, and it was the LAST line — the one saying whether the
    // run was clean — that a real end-to-end run against this repo's own 392 suites lost.
    const logPath = path.join(tmp, 'cli-log-flush.log');
    spawnSync(process.execPath, [BIN, '--dir', dir, '--log', logPath], { encoding: 'utf8' });
    const logged = fs.readFileSync(logPath, 'utf8').trim().split('\n');
    assert.match(logged.at(-1), /failed: test\/b-fail\.mjs/, `the log's last line should be the tally; got:\n${logged.join('\n')}`);
  });
}

await checkAsync('a second invocation on the same tree is refused rather than doubling the load', async () => {
  const dir = tree('cli-lock', { 'test/slow.mjs': marker('slow', { sleepMs: 900 }) });
  const first = spawn(process.execPath, [BIN, '--dir', dir]);
  // Give the first process time to acquire the lock before the second one tries.
  await new Promise((r) => setTimeout(r, 250));
  const second = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(second.status, 2, `expected the refusal exit code 2, got ${second.status}: ${second.stderr}`);
  assert.match(second.stderr, /already running/);
  const firstDone = await new Promise((resolve) => first.on('close', (code) => resolve(code)));
  assert.equal(firstDone, 0, 'the first invocation should have run to completion undisturbed');
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall gate checks passed\n');
process.exit(failures ? 1 : 0);
