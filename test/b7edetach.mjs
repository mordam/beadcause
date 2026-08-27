#!/usr/bin/env node
//
// b7e-detach — start the gate so it outlives the call that started it, and hand back a
// run id (bc-dgx7.25), plus the `--run-id` seam through bin/b7e-gate and lib/gaterun.js
// that makes the id knowable before the child exists.
//
//   npm test
//   node test/b7edetach.mjs
//
// The whole claim of this command is about process lifetime, and a fake cannot hold it:
// what is being asserted is that a child SURVIVES the exit of the process that spawned
// it, which is a real `setsid(2)` against a real reaped parent or it is nothing. So this
// builds a real git repo with two real suites in it — one of them slow enough that the
// launcher must return while it is still going — runs the real `bin/b7e-detach` to
// completion with `spawnSync` (so the parent is genuinely gone before anything is
// asserted), and then watches the run record reach `done` with nobody holding the child
// at all. `test/b7ewatch.mjs` already builds the same bare-origin-plus-clone shape for
// the same reason; this reuses it rather than inventing a third.
//
// `BEADCAUSE_GATE_SLOTS=0` for the same reason test/gate.mjs sets it: this spawns real
// gates, and run alone beside two live sibling gates on this Mac they would queue behind
// them and time the suite out. The semaphore itself is proved in test/gateslots.mjs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-detach');
const GATE = path.join(ROOT, 'bin', 'b7e-gate');
const WATCH = path.join(ROOT, 'bin', 'b7e-watch');

process.env.BEADCAUSE_GATE_SLOTS = '0';

const gaterun = await import(path.join(ROOT, 'lib', 'gaterun.js'));
const gate = await import(path.join(ROOT, 'lib', 'gate.js'));

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
 * a real repo with two real suites, one of them slow
 * ===================================================================== */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7edetach-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

/** How long `test/slow.mjs` sleeps — long enough that a launcher that waited would show it. */
const SLOW_MS = 4000;

function makeRepo(name) {
  const originBare = path.join(tmp, `${name}.git`);
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', originBare]);
  const work = path.join(tmp, name);
  fs.mkdirSync(path.join(work, 'test'), { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  git(work, 'remote', 'add', 'origin', originBare);
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n.claude/gate-runs/\n');
  fs.writeFileSync(path.join(work, 'test', 'quick.mjs'), 'process.exit(0);\n');
  fs.writeFileSync(
    path.join(work, 'test', 'slow.mjs'),
    `await new Promise((r) => setTimeout(r, ${SLOW_MS}));\nprocess.exit(0);\n`
  );
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'fixture');
  git(work, 'push', '-q', 'origin', 'main');
  return work;
}

const repo = makeRepo('tree');

const detach = (args = [], opts = {}) =>
  spawnSync(process.execPath, [BIN, '--dir', repo, ...args], { encoding: 'utf8', ...opts });

const runsFor = () => path.join(repo, '.claude', 'gate-runs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The one line `b7e-detach` prints, taken apart. `null` when stdout is not that shape. */
function parseLine(stdout) {
  const lines = stdout.trim().split('\n').filter(Boolean);
  if (lines.length !== 1) return null;
  const m = /^run (\S+) — pid (\d+), log (.+)$/.exec(lines[0]);
  return m ? { runId: m[1], pid: Number(m[2]), log: m[3] } : null;
}

/* ===================================================================== *
 * 1. lib/gaterun.js — the id can be said before the run exists
 * ===================================================================== */

console.log('\nan id minted before the run\n');

await checkAsync('mintRunId gives the same <worktree>-<stamp>-<rand> shape startRun would', async () => {
  const id = await gaterun.mintRunId(repo);
  assert.match(id, /^main-\d{8}T\d{9}Z-[a-z0-9]{1,4}$/, id);
  assert.equal(gaterun.RUN_ID_RE.test(id), true);
});

await checkAsync('startRun files the record under a given runId rather than minting one', async () => {
  const id = await gaterun.mintRunId(repo);
  const { runId, file } = await gaterun.startRun(repo, { suites: ['test/quick.mjs'], runId: id });
  assert.equal(runId, id);
  assert.equal(path.basename(file, '.jsonl'), id);
  assert.equal(gaterun.readRun(file).runId, id);
  fs.rmSync(file, { force: true });
});

await checkAsync('startRun refuses a run id that could leave the runs directory', async () => {
  for (const bad of ['../escape', 'a/b', '', '.hidden']) {
    await assert.rejects(
      () => gaterun.startRun(repo, { suites: ['test/quick.mjs'], runId: bad }),
      /not a usable run id/,
      `should have refused ${JSON.stringify(bad)}`
    );
  }
});

check('RUN_ID_RE accepts the ids this repo actually mints and nothing with a separator', () => {
  assert.equal(gaterun.RUN_ID_RE.test('worktree-b7e-detach-dgx725-20260827T110000000Z-a1b2'), true);
  assert.equal(gaterun.RUN_ID_RE.test('../x'), false);
  assert.equal(gaterun.RUN_ID_RE.test('a/b'), false);
  assert.equal(gaterun.RUN_ID_RE.test('a b'), false);
});

/* ===================================================================== *
 * 2. bin/b7e-gate --run-id
 * ===================================================================== */

console.log('\nb7e-gate --run-id\n');

check('--run-id refuses an id that is not a bare filename, before locking anything', () => {
  const r = spawnSync(process.execPath, [GATE, '--dir', repo, '--run-id', '../escape', '--list'], {
    encoding: 'utf8',
  });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /--run-id wants a bare id/);
});

await checkAsync('--run-id refuses an id whose run already exists rather than appending to it', async () => {
  const id = await gaterun.mintRunId(repo);
  const { file } = await gaterun.startRun(repo, { suites: ['test/quick.mjs'], runId: id });
  const before = fs.readFileSync(file, 'utf8');
  const r = spawnSync(process.execPath, [GATE, '--dir', repo, '--run-id', id, '--list'], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, new RegExp(`run ${id} already exists`));
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'the existing record must be untouched');
  fs.rmSync(file, { force: true });
});

/* ===================================================================== *
 * 3. refusals, which cost nothing and start nothing
 * ===================================================================== */

console.log('\nrefusing rather than detaching\n');

check('--help says what it does and starts nothing', () => {
  const before = fs.existsSync(runsFor()) ? fs.readdirSync(runsFor()).length : 0;
  const r = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /usage: b7e-detach/);
  const after = fs.existsSync(runsFor()) ? fs.readdirSync(runsFor()).length : 0;
  assert.equal(after, before, '--help must not start a run');
});

check('a --dir that is not a git checkout is refused, not detached into', () => {
  const plain = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  const r = spawnSync(process.execPath, [BIN, '--dir', plain], { encoding: 'utf8' });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /is not a git checkout/);
  assert.equal(r.stdout.trim(), '');
});

check('a gate already running on this tree is refused before the fork', () => {
  const lock = gate.acquireLock(repo);
  assert.equal(lock.ok, true, 'the fixture tree should not already be locked');
  try {
    const r = detach();
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /a gate is already running on this tree — pid \d+/);
    assert.equal(r.stdout.trim(), '', 'a refusal must not print a run id');
  } finally {
    lock.release();
  }
});

check('--start-timeout wants a number', () => {
  const r = detach(['--start-timeout', 'soon']);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /--start-timeout wants a number/);
});

/* ===================================================================== *
 * 4. the whole point: the run outlives the call that started it
 * ===================================================================== */

console.log('\nthe run outlives the call\n');

let started = null;

await checkAsync('one call returns with a run id while the sweep is still going', async () => {
  const began = Date.now();
  const r = detach(['--start-timeout', '30']);
  const elapsed = Date.now() - began;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  started = parseLine(r.stdout);
  assert.ok(started, `expected one line, got ${JSON.stringify(r.stdout)}`);
  assert.ok(
    elapsed < SLOW_MS,
    `returned in ${elapsed}ms, which is not sooner than the ${SLOW_MS}ms suite it started`
  );
  const file = gaterun.runFile(runsFor(), started.runId);
  assert.equal(fs.existsSync(file), true, 'the run record should exist by the time the id is printed');
  assert.equal(gaterun.readRun(file).running, true, 'the run should still be going');
});

await checkAsync('the child is a session of its own — not this process, not its group', async () => {
  assert.ok(started, 'needs the run above');
  // `setsid` is what detaching means here, and a process in its own session is its own
  // group leader: its pgid IS its pid. A `nohup … &` child (the shape that died at suite
  // 88) keeps the launcher's group and would report that group instead.
  const pgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(started.pid)], { encoding: 'utf8' }).trim();
  assert.equal(Number(pgid), started.pid, `pgid ${pgid} should be the child's own pid ${started.pid}`);
  assert.notEqual(started.pid, process.pid);
});

await checkAsync('and it finishes after the launcher is gone — the record reaches done, green', async () => {
  assert.ok(started, 'needs the run above');
  const file = gaterun.runFile(runsFor(), started.runId);
  const deadline = Date.now() + 90_000;
  let run = gaterun.readRun(file);
  while (run.running && Date.now() < deadline) {
    await sleep(250);
    run = gaterun.readRun(file);
  }
  assert.equal(run.running, false, 'the detached run never finished');
  assert.equal(run.status, 'ok', `${run.failed.join(', ')} — ${fs.readFileSync(started.log, 'utf8').slice(-800)}`);
  assert.deepEqual(run.suites.slice().sort(), ['test/quick.mjs', 'test/slow.mjs']);
  assert.equal(run.done, 2);
});

check('b7e-watch, with no arguments at all, reports on it', () => {
  assert.ok(started, 'needs the run above');
  const r = spawnSync(process.execPath, [WATCH], { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`run ${started.runId}\\b`));
  assert.match(r.stdout, /done, green/);
});

check('the console log named in that line holds the run the gate actually printed', () => {
  assert.ok(started, 'needs the run above');
  const body = fs.readFileSync(started.log, 'utf8');
  assert.match(body, new RegExp(`run: ${started.runId}`), 'the gate should have announced the id it was given');
  assert.match(body, /all 2 suites passed/);
});

/* ===================================================================== *
 * 5. what the caller can still ask for
 * ===================================================================== */

console.log('\nflags\n');

await checkAsync('--only is forwarded to the gate unchanged, and --log names the console file', async () => {
  const logPath = path.join(tmp, 'chosen.log');
  const r = detach(['--only', 'test/quick.mjs', '--log', logPath, '--start-timeout', '30']);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = parseLine(r.stdout);
  assert.ok(line, r.stdout);
  assert.equal(line.log, logPath);
  const file = gaterun.runFile(runsFor(), line.runId);
  const deadline = Date.now() + 60_000;
  let run = gaterun.readRun(file);
  while (run.running && Date.now() < deadline) {
    await sleep(200);
    run = gaterun.readRun(file);
  }
  assert.deepEqual(run.suites, ['test/quick.mjs'], 'only the selected suite should have been run');
  assert.equal(run.status, 'ok');
  assert.equal(fs.existsSync(logPath), true);
  assert.match(fs.readFileSync(logPath, 'utf8'), /all 1 suites? passed/);
});

await checkAsync('a flag after a literal -- belongs to the far side, not to this command', async () => {
  // `-- …` is `tools/partest.py`'s own argv on b7e-gate's Python arm, and neither of this
  // command's own two flags may be read out of it. `--help` in there must not print usage
  // instead of starting a run, and a `--log` in there is not this command's `--log`: the
  // printed path should be the tmp default, not the one sitting in somebody else's argv.
  const theirs = path.join(tmp, 'theirs.log');
  const r = detach(['--only', 'test/quick.mjs', '--start-timeout', '30', '--', '--help', '--log', theirs]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = parseLine(r.stdout);
  assert.ok(line, `expected a run line, got ${JSON.stringify(r.stdout)}`);
  assert.notEqual(line.log, theirs);
  assert.equal(fs.existsSync(line.log), true, 'the default tmp log should have been used and written to');
  const file = gaterun.runFile(runsFor(), line.runId);
  const deadline = Date.now() + 60_000;
  let run = gaterun.readRun(file);
  while (run.running && Date.now() < deadline) {
    await sleep(200);
    run = gaterun.readRun(file);
  }
  assert.equal(run.status, 'ok');
});

await checkAsync('--start-timeout 0 answers without waiting for the record at all', async () => {
  const began = Date.now();
  const r = detach(['--only', 'test/quick.mjs', '--start-timeout', '0']);
  const elapsed = Date.now() - began;
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const line = parseLine(r.stdout);
  assert.ok(line, r.stdout);
  assert.ok(elapsed < 3000, `waited ${elapsed}ms with a zero start timeout`);
  // Whatever it did or did not manage to see, the run it named must still turn up.
  const file = gaterun.runFile(runsFor(), line.runId);
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(file) && Date.now() < deadline) await sleep(100);
  assert.equal(fs.existsSync(file), true, 'the id printed should name a run that appears');
  let run = gaterun.readRun(file);
  while (run.running && Date.now() < deadline) {
    await sleep(200);
    run = gaterun.readRun(file);
  }
  assert.equal(run.status, 'ok');
});

/* ===================================================================== */

removeTreeSync(tmp);

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failed\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mall b7e-detach checks passed\x1b[0m');
