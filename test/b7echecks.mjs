#!/usr/bin/env node
//
// b7e-checks — a workspace repo's own gate scripts, all of them, with a baseline
// (bc-dgx7.57).
//
//   npm test
//   node test/b7echecks.mjs
//
// Named `b7echecks.mjs`, not `checks.mjs` — that name is already the browser-checks
// audit suite (lib/checkaudit.js), an unrelated command with a name one letter away.
// Overwriting it once, by hand, before this file existed is the reason this note is
// here at all.
//
// lib/checks.js does the manifest, the running and the baseline diff; this drives it
// directly against fabricated trees (fake `scripts/check_*.py` files, a fake
// `studio_status.py`) rather than against the real deluvia checkout, which would make
// this suite slower than the loop it replaces and would fail on any machine without
// that repo cloned. A handful of calls through the real `bin/b7e-checks` binary cover
// what only the CLI does: argv parsing, exit codes, `--json`, the lock refusal and an
// end-to-end `--baseline` run against a real (throwaway) git repo.
//
// python3 is assumed present — the same assumption every check this command runs makes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-checks');

const checks = await import(path.join(ROOT, 'lib', 'checks.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-checks-test-'));

/** A fresh `<tmp>/<name>/scripts/` directory holding the given files. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

/** A python script under `scripts/` that exits with `code`, optionally printing `line`. */
const pyExit = (code, line) => `${line ? `print(${JSON.stringify(line)})\n` : ''}import sys\nsys.exit(${code})\n`;

/** A fake `studio_status.py`: honours `--json`, prints a fixed drift payload, exits `exitCode`. */
const pyStudioStatus = (drift, exitCode = 0) => `
import json
import sys
payload = {"drift": ${JSON.stringify(drift)}}
if "--json" in sys.argv:
    print(json.dumps(payload))
else:
    print("DRIFT" if payload["drift"] else "no drift")
sys.exit(${exitCode})
`;

/* ===================================================================== *
 * 1. the manifest — detection and discovery
 * ===================================================================== */

console.log('\nthe manifest\n');

check('a tree with no scripts/check_*.py matches no manifest', () => {
  const dir = tree('nomanifest', {});
  assert.equal(checks.manifestFor(dir), null);
  assert.deepEqual(checks.discoverChecks(dir), []);
});

check('a tree with at least one scripts/check_*.py is recognised', () => {
  const dir = tree('recognised', { 'scripts/check_a.py': pyExit(0) });
  assert.notEqual(checks.manifestFor(dir), null);
});

check('discovery finds every check_*.py, sorted, each judged by exit code', () => {
  const dir = tree('discover', {
    'scripts/check_b.py': pyExit(0),
    'scripts/check_a.py': pyExit(0),
    'scripts/not_a_check.py': pyExit(0),
  });
  const found = checks.discoverChecks(dir);
  assert.deepEqual(found.map((c) => c.name), ['scripts/check_a.py', 'scripts/check_b.py']);
  assert.equal(found[0].judge, checks.byExitCode);
});

check('studio_status.py is appended, judged by judgeStudioStatus, if present', () => {
  const dir = tree('withstudio', {
    'scripts/check_a.py': pyExit(0),
    'scripts/studio_status.py': pyStudioStatus([]),
  });
  const found = checks.discoverChecks(dir);
  assert.deepEqual(found.map((c) => c.name), ['scripts/check_a.py', 'scripts/studio_status.py (DRIFT)']);
  assert.equal(found[1].judge, checks.judgeStudioStatus);
});

check('no studio_status.py, no DRIFT entry', () => {
  const dir = tree('nostudio', { 'scripts/check_a.py': pyExit(0) });
  assert.deepEqual(checks.discoverChecks(dir).map((c) => c.name), ['scripts/check_a.py']);
});

/* ===================================================================== *
 * 2. judging — exit code alone, and studio_status.py's DRIFT probe
 * ===================================================================== */

console.log('\njudging a result\n');

check('byExitCode: 0 is ok', () => assert.equal(checks.byExitCode({ code: 0, out: '' }).ok, true));
check('byExitCode: non-zero is not ok', () => assert.equal(checks.byExitCode({ code: 1, out: '' }).ok, false));
check('byExitCode: a timeout is not ok, whatever the code', () => {
  assert.equal(checks.byExitCode({ code: 0, timedOut: true, out: '' }).ok, false);
});
check('byExitCode: detail is the output\'s last line', () => {
  assert.equal(checks.byExitCode({ code: 0, out: 'first\nlast line\n' }).detail, 'last line');
});

check('judgeStudioStatus: exit 0, empty drift, is ok', () => {
  const r = checks.judgeStudioStatus({ code: 0, stdout: JSON.stringify({ drift: [] }) });
  assert.equal(r.ok, true);
});
check('judgeStudioStatus: exit 0, non-empty drift, is NOT ok — never mistaken for a pass', () => {
  const r = checks.judgeStudioStatus({ code: 0, stdout: JSON.stringify({ drift: [{ gate: 'G1', id: 'x-1' }] }) });
  assert.equal(r.ok, false);
  assert.match(r.detail, /G1 x-1/);
});
check('judgeStudioStatus: non-zero exit is a failure regardless of drift — it could not even report', () => {
  const r = checks.judgeStudioStatus({ code: 1, out: JSON.stringify({ drift: [] }) });
  assert.equal(r.ok, false);
});
check('judgeStudioStatus: exit 0 but unparseable --json output is a failure, not a silent pass', () => {
  const r = checks.judgeStudioStatus({ code: 0, stdout: 'not json' });
  assert.equal(r.ok, false);
});
check('judgeStudioStatus: parses stdout, not the combined stdout+stderr buffer — a stray stderr line must not break the JSON parse', () => {
  const r = checks.judgeStudioStatus({
    code: 0,
    out: 'a stderr warning interleaved mid-buffer' + JSON.stringify({ drift: [] }),
    stdout: JSON.stringify({ drift: [] }),
  });
  assert.equal(r.ok, true);
});

/* ===================================================================== *
 * 3. runCheck / runChecks — real python3 children
 * ===================================================================== */

console.log('\nrunning real python3 children\n');

await checkAsync('a passing check reports ok, a failing one does not, exit code read directly (never through a pipe)', async () => {
  const dir = tree('run-mixed', {
    'scripts/check_pass.py': pyExit(0, 'fine'),
    'scripts/check_fail.py': pyExit(1, 'not fine'),
  });
  const list = checks.discoverChecks(dir);
  const result = await checks.runChecks(dir, list, { jobs: 2 });
  assert.equal(result.total, 2);
  assert.equal(result.passed, 1);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, 'scripts/check_fail.py');
});

await checkAsync('a check past its timeout is killed and reported timed out', async () => {
  const dir = tree('run-timeout', {
    'scripts/check_hangs.py': 'import time\ntime.sleep(5)\n',
  });
  const list = checks.discoverChecks(dir);
  const result = await checks.runChecks(dir, list, { jobs: 1, timeoutMs: 200 });
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].timedOut, true);
});

await checkAsync('runChecks pools genuinely concurrently, not spawnSync wearing its clothes', async () => {
  const logPath = path.join(tmp, 'concurrency.jsonl');
  const py = (name) => `
import json
import time
with open(${JSON.stringify(logPath)}, "a") as f:
    f.write(json.dumps({"name": ${JSON.stringify(name)}, "at": "start", "t": time.time()}) + "\\n")
time.sleep(0.4)
with open(${JSON.stringify(logPath)}, "a") as f:
    f.write(json.dumps({"name": ${JSON.stringify(name)}, "at": "end", "t": time.time()}) + "\\n")
`;
  const dir = tree('run-concurrent', {
    'scripts/check_x1.py': py('x1'),
    'scripts/check_x2.py': py('x2'),
  });
  const list = checks.discoverChecks(dir);
  const result = await checks.runChecks(dir, list, { jobs: 2 });
  assert.equal(result.ok, true);
  const events = fs
    .readFileSync(logPath, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const starts = events.filter((e) => e.at === 'start');
  const ends = events.filter((e) => e.at === 'end');
  const laterStart = Math.max(...starts.map((e) => e.t));
  const earlierEnd = Math.min(...ends.map((e) => e.t));
  assert.ok(laterStart < earlierEnd, `expected overlap: later start ${laterStart}, earlier end ${earlierEnd}`);
});

await checkAsync('env overrides reach the child — how BEADS_DIR is pointed at the checked repo\'s own workspace', async () => {
  const dir = tree('run-env', { 'scripts/check_env.py': 'import os, sys\nsys.exit(0 if os.environ.get("BEADS_DIR") == "/x/y" else 1)\n' });
  const list = checks.discoverChecks(dir);
  const result = await checks.runChecks(dir, list, { jobs: 1, env: { BEADS_DIR: '/x/y' } });
  assert.equal(result.ok, true);
});

await checkAsync('a real studio_status.py writing to stderr as well as stdout still parses — end to end, not just the unit judge', async () => {
  const dir = tree('run-stderr-noise', {
    'scripts/studio_status.py': `
import json
import sys
print("a noisy warning nobody asked for", file=sys.stderr)
if "--json" in sys.argv:
    print(json.dumps({"drift": []}))
sys.exit(0)
`,
  });
  const list = checks.discoverChecks(dir);
  const result = await checks.runChecks(dir, list, { jobs: 1 });
  assert.equal(result.ok, true, `expected the DRIFT probe to pass despite stderr noise; got: ${JSON.stringify(result.failed)}`);
});

/* ===================================================================== *
 * 4. classifyAgainstBaseline
 * ===================================================================== */

console.log('\nclassifying against a baseline\n');

check('a check failing both now and at the baseline is ALREADY RED', () => {
  const current = [{ name: 'a', ok: false }];
  const baseline = [{ name: 'a', ok: false }];
  assert.equal(checks.classifyAgainstBaseline(current, baseline)[0].baseline, 'already-red');
});
check('a check failing now but passing at the baseline is newly red', () => {
  const current = [{ name: 'a', ok: false }];
  const baseline = [{ name: 'a', ok: true }];
  assert.equal(checks.classifyAgainstBaseline(current, baseline)[0].baseline, 'newly-red');
});
check('a check with no baseline counterpart at all is newly red, not blamed on nothing', () => {
  const current = [{ name: 'new-check', ok: false }];
  assert.equal(checks.classifyAgainstBaseline(current, [])[0].baseline, 'newly-red');
});
check('a passing check is green whatever the baseline said', () => {
  const current = [{ name: 'a', ok: true }];
  const baseline = [{ name: 'a', ok: false }];
  assert.equal(checks.classifyAgainstBaseline(current, baseline)[0].baseline, 'green');
});
check('matched by name, not position', () => {
  const current = [{ name: 'b', ok: false }, { name: 'a', ok: false }];
  const baseline = [{ name: 'a', ok: false }, { name: 'b', ok: true }];
  const out = checks.classifyAgainstBaseline(current, baseline);
  assert.equal(out.find((c) => c.name === 'a').baseline, 'already-red');
  assert.equal(out.find((c) => c.name === 'b').baseline, 'newly-red');
});

/* ===================================================================== *
 * 5. makeRefWorktree / removeRefWorktree — a real git repo
 * ===================================================================== */

console.log('\nthe baseline worktree\n');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

function makeGitRepo(name, files) {
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  return work;
}
const worktreeCount = (dir) => git(dir, 'worktree', 'list').trim().split('\n').length;

await checkAsync('makeRefWorktree checks out a ref detached, removeRefWorktree leaves nothing behind', async () => {
  const work = makeGitRepo('refwt', { 'scripts/check_a.py': pyExit(0) });
  const before = worktreeCount(work);
  const { dir, scratchRoot } = checks.makeRefWorktree(work, 'main');
  assert.ok(fs.existsSync(path.join(dir, 'scripts', 'check_a.py')));
  assert.equal(worktreeCount(work), before + 1);
  checks.removeRefWorktree(work, dir, scratchRoot);
  assert.equal(worktreeCount(work), before, 'the scratch worktree was removed again');
  assert.equal(fs.existsSync(scratchRoot), false);
});

/* ===================================================================== *
 * 6. the CLI itself
 * ===================================================================== */

console.log('\nthe CLI\n');

check('--dir against a tree with no manifest is refused with exit 2', () => {
  const dir = tree('cli-nomanifest', {});
  const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no manifest/);
});

check('neither -w nor --dir is refused with exit 2 and a usage line', () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /required/);
});

check('an unknown workspace is refused with exit 2', () => {
  const run = spawnSync(process.execPath, [BIN, '-w', 'no-such-workspace-xyz'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no workspace named/);
});

{
  const dir = tree('cli-mixed', {
    'scripts/check_a_pass.py': pyExit(0),
    'scripts/check_b_fail.py': pyExit(1),
  });

  check('--list prints the selection without running anything', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--list'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.deepEqual(run.stdout.trim().split('\n'), ['scripts/check_a_pass.py', 'scripts/check_b_fail.py']);
  });

  check('--only narrows the CLI selection, exit code never piped through anything else', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--only', 'scripts/check_a_pass.py', '--list'], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'scripts/check_a_pass.py');
  });

  check('--skip drops a named check and nothing else', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--skip', 'scripts/check_b_fail.py', '--list'], { encoding: 'utf8' });
    assert.equal(run.stdout.trim(), 'scripts/check_a_pass.py');
  });

  check('a red check exits 1 and names both checks in the output', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /check_b_fail\.py/);
    assert.match(run.stdout, /check_a_pass\.py/);
  });

  check('a clean tree exits 0', () => {
    const cleanDir = tree('cli-clean', { 'scripts/check_a.py': pyExit(0) });
    const run = spawnSync(process.execPath, [BIN, '--dir', cleanDir], { encoding: 'utf8' });
    assert.equal(run.status, 0);
  });

  check('--json prints one parseable object per line, exit codes never read through a pipe', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json'], { encoding: 'utf8' });
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line), `not JSON: ${line}`);
    const summary = JSON.parse(lines.at(-1));
    assert.equal(summary.summary, true);
    assert.equal(summary.total, 2);
    assert.deepEqual(summary.failed, ['scripts/check_b_fail.py']);
  });
}

await checkAsync('a second invocation on the same tree is refused rather than doubling the load', async () => {
  const dir = tree('cli-lock', { 'scripts/check_slow.py': 'import time\ntime.sleep(0.9)\n' });
  const { spawn } = await import('node:child_process');
  const first = spawn(process.execPath, [BIN, '--dir', dir]);
  await new Promise((r) => setTimeout(r, 250));
  const second = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(second.status, 2, `expected refusal exit code 2, got ${second.status}: ${second.stderr}`);
  assert.match(second.stderr, /already running/);
  const firstDone = await new Promise((resolve) => first.on('close', (code) => resolve(code)));
  assert.equal(firstDone, 0, 'the first invocation should have run to completion undisturbed');
});

await checkAsync('--baseline: a pre-existing failure is ALREADY RED, a new one is newly red, end to end', async () => {
  const work = makeGitRepo('cli-baseline', {
    'scripts/check_old.py': pyExit(1, 'always broken'),
    'scripts/check_clean.py': pyExit(0),
  });
  const baselineSha = git(work, 'rev-parse', 'HEAD').trim();
  // Add a NEW failing check on top of the baseline commit — one the baseline ref never had.
  fs.writeFileSync(path.join(work, 'scripts', 'check_new.py'), pyExit(1, 'freshly broken'));
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'add a newly-broken check');

  const run = spawnSync(process.execPath, [BIN, '--dir', work, '--baseline', baselineSha], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  // Strip ANSI colour codes — the tag and the name are on the same printed line but not
  // textually adjacent once the colour escapes for the tag sit between them.
  const plain = run.stdout.replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /ALREADY RED\s+scripts\/check_old\.py/);
  assert.match(plain, /newly red\s+scripts\/check_new\.py/);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
