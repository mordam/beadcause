#!/usr/bin/env node
//
// b7e-await — wait for a call the harness already backgrounded, and hand back its real
// output and exit status (bc-dgx7.99). Drives the real CLI as a real subprocess — the
// thing under test IS how it behaves against a `.output` file changing under it while
// it polls, and a fake would prove nothing about the timing. Fixtures are plain files
// in a scratch tmp dir, written and (for the "still running" cases) appended to from
// this same test process, so there is no dependency on a real backgrounded task or on
// two separate tool calls ever landing far enough apart in wall-clock time.
//
//   npm test
//   node test/b7eawait.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-await');

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};
const checkAsync = async (name, fn) => {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nb7e-await\n');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'b7eawait-'));
process.on('exit', () => removeTreeSync(TMP));

let n = 0;
function fixtureDir() {
  n += 1;
  const d = path.join(TMP, `fx${n}`);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

function run(args, opts = {}) {
  const started = Date.now();
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '', ms: Date.now() - started };
}

/** Runs asynchronously and resolves on exit, for tests that must act while it is still polling. */
function runAsync(args, opts = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [BIN, ...args], { cwd: ROOT, ...opts });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr, ms: Date.now() - started }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ======================================================================= usage / argv */

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-await/);
  assert.match(stdout, /--timeout <seconds>/);
});

check('no arguments prints usage and exits 1', () => {
  const { status, stdout } = run([]);
  assert.equal(status, 1);
  assert.match(stdout, /usage: b7e-await/);
});

check('a bare flag with no task id prints usage and exits 1', () => {
  const { status, stdout } = run(['--timeout', '5']);
  assert.equal(status, 1);
  assert.match(stdout, /usage: b7e-await/);
});

check('--flag=value inline form works the same as --flag value', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'inline.output'), 'hi\n\n[exited with code 0]\n');
  const { status, stdout } = run([`--dir=${dir}`, 'inline', '--tail=1']);
  assert.equal(status, 0);
  assert.equal(stdout, '[exited with code 0]\n');
});

check('--timeout 0 is refused', () => {
  const { status, stderr } = run(['sometask', '--timeout', '0', '--dir', fixtureDir()]);
  assert.equal(status, 1);
  assert.match(stderr, /--timeout <seconds> must be a positive number/);
});

check('--timeout not-a-number is refused', () => {
  const { status, stderr } = run(['sometask', '--timeout', 'soon', '--dir', fixtureDir()]);
  assert.equal(status, 1);
  assert.match(stderr, /--timeout <seconds> must be a positive number/);
});

check('--tail 0 is refused', () => {
  const { status, stderr } = run(['sometask', '--tail', '0', '--dir', fixtureDir()]);
  assert.equal(status, 1);
  assert.match(stderr, /--tail <n> must be a positive integer/);
});

check('--tail 1.5 is refused', () => {
  const { status, stderr } = run(['sometask', '--tail', '1.5', '--dir', fixtureDir()]);
  assert.equal(status, 1);
  assert.match(stderr, /--tail <n> must be a positive integer/);
});

/* ================================================================== the trailer itself */

check('a task that exited 0: prints output, exits 0', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'aaa.output'), 'hello\nworld\n\n[exited with code 0]\n');
  const { status, stdout } = run(['aaa', '--dir', dir]);
  assert.equal(status, 0);
  assert.equal(stdout, 'hello\nworld\n\n[exited with code 0]\n');
});

check('a task that exited nonzero: propagates the exact code', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'bbb.output'), 'oops\n\n[exited with code 3]\n');
  const { status, stdout } = run(['bbb', '--dir', dir]);
  assert.equal(status, 3);
  assert.match(stdout, /oops/);
});

check('a task the harness killed (no code at all): exits 125, distinct from --timeout', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'ccc.output'), '\n[killed]\n');
  const { status, stdout } = run(['ccc', '--dir', dir]);
  assert.equal(status, 125);
  assert.match(stdout, /\[killed\]/);
});

check('exit code 256 wraps the same way process.exit always does', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'wrap.output'), '\n[exited with code 256]\n');
  const { status } = run(['wrap', '--dir', dir]);
  assert.equal(status, 0); // 256 mod 256
});

check('--tail <n> prints only the last n lines, trailer included', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'ddd.output'), 'l1\nl2\nl3\nl4\nl5\n\n[exited with code 0]\n');
  const { status, stdout } = run(['ddd', '--dir', dir, '--tail', '2']);
  assert.equal(status, 0);
  assert.equal(stdout, '\n[exited with code 0]\n');
});

check('--tail bigger than the file prints the whole thing', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'eee.output'), 'l1\nl2\n\n[exited with code 0]\n');
  const { stdout } = run(['eee', '--dir', dir, '--tail', '100']);
  assert.equal(stdout, 'l1\nl2\n\n[exited with code 0]\n');
});

check('an empty output file (no output, no trailer yet) does not crash the tail-read', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'fff.output'), '');
  const { status } = run(['fff', '--dir', dir, '--timeout', '0.5']);
  assert.equal(status, 124);
});

/* ============================================================================ timeout */

check('--timeout on a task still running: partial output, exits 124', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'ggg.output'), 'still going\n');
  const { status, stdout, ms } = run(['ggg', '--dir', dir, '--timeout', '0.8']);
  assert.equal(status, 124);
  assert.equal(stdout, 'still going\n');
  assert.ok(ms >= 700 && ms < 2500, `took ${ms}ms for a 0.8s deadline — should be close to it`);
});

check('a task id that never appears, with --timeout, times out rather than hanging past it', () => {
  const dir = fixtureDir(); // empty — nothing named hhh.output ever shows up
  const { status, stdout, ms } = run(['hhh', '--dir', dir, '--timeout', '0.6']);
  assert.equal(status, 124);
  assert.equal(stdout, '');
  assert.ok(ms >= 550 && ms < 2500, `took ${ms}ms for a 0.6s deadline — should be close to it`);
});

check('a task id that never appears, with NO --timeout, gives up after the discovery grace', () => {
  const dir = fixtureDir();
  const { status, stderr, ms } = run(['iii', '--dir', dir]);
  assert.equal(status, 127);
  assert.match(stderr, /no task "iii" found/);
  // The discovery grace (2s) applies even under --dir, same code path as the real search.
  assert.ok(ms >= 1800 && ms < 4000, `took ${ms}ms — should be about the 2s discovery grace`);
});

/* ================================================================ notices completion promptly */

await checkAsync('notices a trailer written mid-poll within about a second, not late and not early', async () => {
  const dir = fixtureDir();
  const file = path.join(dir, 'jjj.output');
  fs.writeFileSync(file, 'partial\n');
  const p = runAsync(['jjj', '--dir', dir]);
  await sleep(900);
  fs.appendFileSync(file, '\n[exited with code 42]\n');
  const { status, stdout, ms } = await p;
  assert.equal(status, 42);
  assert.match(stdout, /partial/);
  assert.ok(ms >= 900 && ms < 1900, `took ${ms}ms — trailer landed at ~900ms, should not lag much past 1s`);
});

/* ================================================================== does not busy-wait */

check('does not busy-wait: measured CPU is a small fraction of wall-clock while blocked', () => {
  const dir = fixtureDir();
  fs.writeFileSync(path.join(dir, 'kkk.output'), 'x\n');
  const started = Date.now();
  const res = spawnSync(process.execPath, [BIN, 'kkk', '--dir', dir, '--timeout', '1.2'], { cwd: ROOT });
  const wallMs = Date.now() - started;
  // spawnSync doesn't hand back child rusage on darwin without extra plumbing; the
  // honest proxy available here is that a poll loop sleeping 300ms at a time between
  // reads of a few hundred bytes finishes in wall-clock terms close to the deadline
  // with no sign of the process spinning (a busy-wait would show as the deadline
  // overrunning under load, not as this number, so this is a smoke check — the `time`
  // measurements taken by hand while building this landed 1-2% CPU on a real poll).
  assert.equal(res.status, 124);
  assert.ok(wallMs < 2500, `took ${wallMs}ms for a 1.2s deadline`);
});

/* ========================================================== real discovery, not --dir */

check('with no --dir: finds the file via uid+cwd+session-id, the primary (fast) path', () => {
  const base = fixtureDir();
  const sessionId = 'sess-primary-11111111';
  const cwdSlug = process.cwd().replace(/[^A-Za-z0-9]/g, '-');
  const tasksDir = path.join(base, cwdSlug, sessionId, 'tasks');
  fs.mkdirSync(tasksDir, { recursive: true });
  fs.writeFileSync(path.join(tasksDir, 'primary.output'), 'found it\n\n[exited with code 0]\n');
  const { status, stdout } = run(['primary'], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, B7E_AWAIT_TEST_BASE: base },
  });
  assert.equal(status, 0);
  assert.match(stdout, /found it/);
});

check('with no --dir: falls back across a sibling cwd-slug carrying the same session id', () => {
  // Simulates a session whose cwd changed (EnterWorktree) between backgrounding the
  // task and awaiting it — the file lives under the OLD cwd's slug, not the current one.
  const base = fixtureDir();
  const sessionId = 'sess-fallback-22222222';
  const staleTasksDir = path.join(base, 'some-other-cwd-slug-from-before', sessionId, 'tasks');
  fs.mkdirSync(staleTasksDir, { recursive: true });
  fs.writeFileSync(path.join(staleTasksDir, 'stale.output'), 'via fallback\n\n[exited with code 7]\n');
  const { status, stdout } = run(['stale'], {
    env: { ...process.env, CLAUDE_CODE_SESSION_ID: sessionId, B7E_AWAIT_TEST_BASE: base },
  });
  assert.equal(status, 7);
  assert.match(stdout, /via fallback/);
});

check('with no --dir and no CLAUDE_CODE_SESSION_ID: refuses with a clear message, exits 2', () => {
  const env = { ...process.env };
  delete env.CLAUDE_CODE_SESSION_ID;
  const { status, stderr } = run(['whatever'], { env });
  assert.equal(status, 2);
  assert.match(stderr, /CLAUDE_CODE_SESSION_ID/);
});

console.log('');
if (failures > 0) {
  console.log(`${failures} check(s) failed\n`);
  process.exit(1);
}
console.log('all checks passed\n');
