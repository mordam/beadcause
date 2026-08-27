#!/usr/bin/env node
//
// lib/pygate.js — the Python arm of b7e-gate (bc-khoe.61): the interpreter walk-up from a
// fresh worktree with no .venv of its own, exit-code-only gating against a script that
// prints ERROR: lines on a run that still passes, and the CLI dispatch that picks this
// arm from a tree's own shape rather than a name or a config lookup.
//
// The fake ".venv/bin/python" below is a Node script, not a real interpreter — this repo's
// CI runner is not guaranteed to have Python, and lib/pygate.js never inspects what it
// spawns beyond its exit code, so a Node stand-in exercises the exact same contract.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-gate');

const pygate = await import(path.join(ROOT, 'lib', 'pygate.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-pygate-test-'));

const sophabTree = (name) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'partest.py'), '# not actually run — the fake interpreter ignores it\n');
  return dir;
};

/**
 * A `.venv/bin/python` that is actually Node: reads its own argv/env, decides pass or
 * fail from `FAKE_PARTEST_EXIT`, and — unless `quiet` — prints an `ERROR:` line and a
 * traceback-shaped block to stdout regardless of exit code, the same as the real suite
 * does on a run that still passes (bc-khoe.61's whole reason exit code is the only signal
 * `runPythonGate` ever reads).
 */
const fakeInterpreter = (dir, { name = 'python' } = {}) => {
  const bin = path.join(dir, '.venv', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const p = path.join(bin, name);
  const body = [
    '#!/usr/bin/env node',
    "import fs from 'node:fs';",
    "const argvPath = process.argv[3] || process.env.FAKE_ARGV_LOG;",
    "if (argvPath) fs.writeFileSync(argvPath, JSON.stringify({ argv: process.argv.slice(2), pythonpath: process.env.PYTHONPATH || null }));",
    "console.log('ERROR: something logged during teardown');",
    "console.log('Traceback (most recent call last): ...');",
    "const sleepMs = Number(process.env.FAKE_PARTEST_SLEEP_MS || 0);",
    "if (sleepMs) { const until = Date.now() + sleepMs; while (Date.now() < until) {} }",
    "process.exit(Number(process.env.FAKE_PARTEST_EXIT || 0));",
  ].join('\n');
  fs.writeFileSync(p, `${body}\n`, { mode: 0o755 });
  return p;
};

/* ===================================================================== *
 * 1. shape detection
 * ===================================================================== */

console.log('\nwhich arm a tree is\n');

check('a tree with tools/partest.py is Python-shaped', () => {
  const dir = sophabTree('shape-py');
  assert.equal(pygate.isPythonShaped(dir), true);
});
check('a tree without it is not', () => {
  const dir = path.join(tmp, 'shape-node');
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(pygate.isPythonShaped(dir), false);
});

/* ===================================================================== *
 * 2. finding the interpreter — a fresh worktree has no .venv of its own
 * ===================================================================== */

console.log('\nfinding an interpreter\n');

check("root's own .venv/bin/python wins outright", () => {
  const dir = sophabTree('venv-own-python');
  const p = fakeInterpreter(dir, { name: 'python' });
  assert.equal(pygate.findInterpreter(dir), p);
});
check('python3 is used when python is absent', () => {
  const dir = sophabTree('venv-own-python3');
  const p = fakeInterpreter(dir, { name: 'python3' });
  assert.equal(pygate.findInterpreter(dir), p);
});
check('neither name anywhere reachable is a real null, not a guess', () => {
  const dir = sophabTree('venv-none');
  assert.equal(pygate.findInterpreter(dir), null);
});

await checkAsync('a worktree with no .venv of its own walks up to the main checkout that has one', async () => {
  const repoDir = path.join(tmp, 'walkup-main');
  fs.mkdirSync(path.join(repoDir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(repoDir, 'tools', 'partest.py'), '# fixture\n');
  execFileSync('git', ['init', '-q', repoDir]);
  execFileSync('git', ['-C', repoDir, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', repoDir, 'config', 'user.name', 'test']);
  fs.writeFileSync(path.join(repoDir, 'README'), 'fixture\n');
  execFileSync('git', ['-C', repoDir, 'add', '-A']);
  execFileSync('git', ['-C', repoDir, 'commit', '-q', '-m', 'init']);
  const mainInterpreter = fakeInterpreter(repoDir, { name: 'python' });

  const worktreeDir = path.join(tmp, 'walkup-worktree');
  execFileSync('git', ['-C', repoDir, 'worktree', 'add', '-q', worktreeDir, '-b', 'wt-fixture']);

  assert.equal(pygate.findInterpreter(worktreeDir), mainInterpreter);
});

/* ===================================================================== *
 * 3. running the one process — exit code only, never the scraped output
 * ===================================================================== */

console.log('\nrunning the one process, gated on its exit code alone\n');

await checkAsync('exit 0 is ok even though stdout is full of ERROR: lines', async () => {
  const dir = sophabTree('run-pass');
  const interpreter = fakeInterpreter(dir);
  const r = await pygate.runPythonGate(dir, { interpreter, extraArgs: [] });
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.match(r.out, /ERROR:/, 'the fixture is supposed to print ERROR: regardless of exit code — that is the whole point');
});

await checkAsync('a non-zero exit is not ok, same ERROR: noise or not', async () => {
  const dir = sophabTree('run-fail');
  const interpreter = fakeInterpreter(dir);
  process.env.FAKE_PARTEST_EXIT = '1';
  try {
    const r = await pygate.runPythonGate(dir, { interpreter, extraArgs: [] });
    assert.equal(r.ok, false);
    assert.equal(r.code, 1);
  } finally {
    delete process.env.FAKE_PARTEST_EXIT;
  }
});

await checkAsync('PYTHONPATH is set to "." and extraArgs are forwarded verbatim', async () => {
  const dir = sophabTree('run-argv');
  const interpreter = fakeInterpreter(dir);
  const argvLog = path.join(tmp, 'argv-log.json');
  const r = await pygate.runPythonGate(dir, { interpreter, extraArgs: [argvLog, 'tests.test_costing'] });
  assert.equal(r.ok, true);
  const logged = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
  assert.deepEqual(logged.argv, [path.join('tools', 'partest.py'), argvLog, 'tests.test_costing']);
  assert.equal(logged.pythonpath, '.');
});

await checkAsync('a run past its timeout is killed and reported TIMEOUT, not FAIL', async () => {
  const dir = sophabTree('run-timeout');
  const interpreter = fakeInterpreter(dir);
  process.env.FAKE_PARTEST_SLEEP_MS = '4000';
  try {
    const r = await pygate.runPythonGate(dir, { interpreter, timeoutMs: 200 });
    assert.equal(r.ok, false);
    assert.equal(r.timedOut, true);
  } finally {
    delete process.env.FAKE_PARTEST_SLEEP_MS;
  }
});

/* ===================================================================== *
 * 4. the CLI — dispatch, refusals, and the shared lock
 * ===================================================================== */

console.log('\nthe CLI dispatches on the tree\'s own shape\n');

{
  const dir = sophabTree('cli-pass');
  fakeInterpreter(dir);
  check('--list prints the command line for the Python arm, without running anything', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--list'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(run.stdout, /PYTHONPATH=\. .*python.*tools[\\/]partest\.py/);
  });
  check('a passing script exits 0 through the CLI', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
  });
  check('--json summarises the single logical suite', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json'], { encoding: 'utf8' });
    const lines = run.stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const summary = lines.at(-1);
    assert.equal(summary.summary, true);
    assert.equal(summary.total, 1);
    assert.equal(summary.passed, 1);
    assert.deepEqual(summary.failed, []);
  });
}

{
  const dir = sophabTree('cli-fail');
  fakeInterpreter(dir);
  check('a failing script exits 1 through the CLI, tail printed despite the ERROR: noise', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir], {
      encoding: 'utf8',
      env: { ...process.env, FAKE_PARTEST_EXIT: '1' },
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /FAIL/);
  });
}

{
  const dir = sophabTree('cli-extra-args');
  fakeInterpreter(dir);
  check('tokens after -- reach the script as its own argv', () => {
    const argvLog = path.join(tmp, 'cli-argv-log.json');
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--', argvLog, 'tests.test_costing'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stdout + run.stderr);
    const logged = JSON.parse(fs.readFileSync(argvLog, 'utf8'));
    assert.deepEqual(logged.argv.slice(1), [argvLog, 'tests.test_costing']);
  });
}

{
  const dir = sophabTree('cli-only-refused');
  fakeInterpreter(dir);
  check('--only/--skip are refused on the Python arm rather than silently ignored', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--only', 'tests.test_costing'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stderr, /--only\/--skip do not apply here/);
  });
}

check('no interpreter anywhere reachable refuses with exit 2, not a crash', () => {
  const dir = sophabTree('cli-no-interpreter');
  const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no \.venv\/bin\/python/);
});

await checkAsync('the Python arm takes lib/gate.js\'s own per-tree lock — a concurrent second run is refused', async () => {
  const dir = sophabTree('cli-lock-shared');
  fakeInterpreter(dir);
  process.env.FAKE_PARTEST_SLEEP_MS = '900';
  const { spawn } = await import('node:child_process');
  const first = spawn(process.execPath, [BIN, '--dir', dir], { env: process.env });
  await new Promise((r) => setTimeout(r, 250));
  const second = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  delete process.env.FAKE_PARTEST_SLEEP_MS;
  assert.equal(second.status, 2, `expected the shared lock's refusal, got ${second.status}: ${second.stderr}`);
  assert.match(second.stderr, /already running/);
  const firstDone = await new Promise((resolve) => first.on('close', (code) => resolve(code)));
  assert.equal(firstDone, 0, 'the first invocation should have run to completion undisturbed');
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall pygate checks passed\n');
process.exit(failures ? 1 : 0);
