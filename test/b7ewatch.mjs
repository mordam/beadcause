#!/usr/bin/env node
//
// b7e-watch — how far a gate has got, and what's red, from its own run record
// (bc-gdub.3), and lib/gaterun.js, the record `bin/b7e-gate` writes for it to read.
//
//   npm test
//   node test/b7ewatch.mjs
//
// lib/gaterun.js's read/write functions are proved against a REAL git repo — a bare
// "origin" plus a working clone plus a nested worktree of it, the same shape
// test/blame.mjs and test/b7eworktree.mjs already use for their own tools — because the
// whole point of `.claude/gate-runs` living in the *main checkout* rather than the
// worktree a gate happens to run in is a real `git rev-parse --git-common-dir`
// question, and a fake filesystem would agree with itself about it and prove nothing.
//
// The CLI half drives the real `bin/b7e-watch` against that same fixture, including
// the "does it reproduce on origin/main" tagging, which goes through the real
// lib/blame.js rather than a second implementation of the same comparison.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-watch');

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
 * fixtures — a real bare origin, a working clone, and a nested worktree,
 * the same shape test/blame.mjs already builds for the same kind of tool.
 * ===================================================================== */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7ewatch-test-'));

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
  'test/red-everywhere.mjs': failing('always red'),
  'test/green.mjs': passing(),
});

// A worktree nested under `.claude/worktrees/`, the real repo's own layout — this is
// what proves `runsDir`/`worktreeSlug` resolve the SAME shared directory from either
// side, which is the whole reason the run record lives in the main checkout at all.
const wt1 = path.join(main, '.claude', 'worktrees', 'wt1');
git(main, 'worktree', 'add', '-q', '-b', 'wt1-branch', wt1, 'main');

// A suite that exists locally (on wt1-branch) but was never pushed to origin/main —
// blameSuite reports that as 'yours'. Written after the worktree is cut, on the
// worktree's own branch, so origin/main never sees it.
fs.mkdirSync(path.join(wt1, 'test'), { recursive: true });
fs.writeFileSync(path.join(wt1, 'test', 'new-red.mjs'), failing('a suite only this branch has'));
git(wt1, 'add', '-A');
git(wt1, 'commit', '-q', '-m', 'a local-only red suite');

/* ===================================================================== *
 * 1. lib/gaterun.js — write/read, against the real fixture
 * ===================================================================== */

console.log('\nlib/gaterun.js: where a run lives, and what it resolves to\n');

await checkAsync('runsDir resolves to .claude/gate-runs under the MAIN checkout from either side', async () => {
  const fromMain = await gaterun.runsDir(main);
  const fromWorktree = await gaterun.runsDir(wt1);
  assert.equal(fromMain, path.join(main, '.claude', 'gate-runs'));
  assert.equal(fromWorktree, fromMain, 'a worktree must resolve to the SAME shared directory, not its own');
});

await checkAsync('worktreeSlug names the main checkout "main" and a nested worktree by its own name', async () => {
  assert.equal(await gaterun.worktreeSlug(main), 'main');
  assert.equal(await gaterun.worktreeSlug(wt1), 'wt1');
});

await checkAsync('startRun writes a start line, appendResult/endRun add to the same file', async () => {
  const { runId, file } = await gaterun.startRun(main, { suites: ['test/green.mjs', 'test/red-everywhere.mjs'] });
  assert.ok(runId.startsWith('main-'), `runId should be filed under the "main" slug, got ${runId}`);
  assert.ok(fs.existsSync(file));
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.4 });
  let r = gaterun.readRun(file);
  assert.equal(r.running, true, 'no end line yet — this is a live run');
  assert.equal(r.done, 1);
  assert.deepEqual(r.failed, []);

  gaterun.appendResult(file, { suite: 'test/red-everywhere.mjs', status: 'fail', elapsed: 0.1, tail: '  FAIL always red' });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.5 });
  r = gaterun.readRun(file);
  assert.equal(r.running, false);
  assert.equal(r.status, 'fail');
  assert.equal(r.done, 2);
  assert.deepEqual(r.failed, ['test/red-everywhere.mjs']);
  assert.equal(r.total, 2);
  assert.equal(r.worktree, 'main');
});

check('a torn last line (writer mid-append) reads as still running, not a crash', () => {
  const dir = path.join(main, '.claude', 'gate-runs');
  const file = path.join(dir, 'main-torn-line-test.jsonl');
  fs.writeFileSync(
    file,
    [
      JSON.stringify({ type: 'start', runId: 'main-torn-line-test', at: new Date().toISOString(), total: 1, suites: ['x'], worktree: 'main' }),
      '{"type":"result","suite":"x","status":"ok"', // torn — no closing brace, no newline
    ].join('\n')
  );
  const r = gaterun.readRun(file);
  assert.equal(r.running, true);
  assert.equal(r.done, 0, 'the torn line must not be parsed as a finished result');
  // Hand-named, out of band with the real `<slug>-<timestamp>-<rand>` shape — remove it
  // rather than let it sort ahead of a later test's run by pure luck of the filename.
  fs.rmSync(file);
});

await checkAsync('a status field is a plain token the writer set, never text matched out of a log', async () => {
  // The acceptance criterion this stands in for: colour codes in a suite's own stdout
  // cannot change the answer, because nothing here greps that output. `tail` carries
  // whatever a suite printed, ANSI included; `status` never comes from reading it.
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  gaterun.appendResult(file, {
    suite: 'test/x.mjs',
    status: 'ok',
    elapsed: 0.1,
    tail: '\x1b[32m  ok\x1b[0m \x1b[31mFAIL\x1b[0m mentioned in colour but not in status',
  });
  const r = gaterun.readRun(file);
  assert.deepEqual(r.failed, [], 'a "FAIL" substring inside colour-coded prose must not flip a result');
});

await checkAsync('latestRunFor picks the newest run for a worktree, by name, and ignores other worktrees', async () => {
  const first = await gaterun.startRun(main, { suites: ['a'] });
  gaterun.endRun(first.file, { status: 'ok', elapsed: 0.1 });
  await new Promise((r) => setTimeout(r, 5)); // the id's timestamp has millisecond resolution
  const second = await gaterun.startRun(main, { suites: ['a'] });
  gaterun.endRun(second.file, { status: 'ok', elapsed: 0.1 });
  const latest = await gaterun.latestRunFor(main);
  assert.equal(latest, second.file);

  const wtRun = await gaterun.startRun(wt1, { suites: ['a'] });
  const latestForMain = await gaterun.latestRunFor(main);
  assert.equal(latestForMain, second.file, "wt1's run must not shadow main's own latest");
  const latestForWt1 = await gaterun.latestRunFor(wt1);
  assert.equal(latestForWt1, wtRun.file);
});

/* ===================================================================== *
 * 2. the CLI — spawned for real, cwd set to the fixture (main or wt1)
 * ===================================================================== */

console.log('\nthe CLI\n');

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

check('no run at all for this worktree — exit 2, says so', () => {
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

await checkAsync('a still-running gate — exit 0, names what failed so far, tags nothing', async () => {
  const { file } = await gaterun.startRun(wt1, { suites: ['test/green.mjs', 'test/new-red.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.appendResult(file, { suite: 'test/new-red.mjs', status: 'fail', elapsed: 0.1 });
  const r = run(wt1);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /running/);
  assert.match(r.stdout, /failed so far: test\/new-red\.mjs/);
  assert.ok(!/not on origin\/main/.test(r.stdout), 'a running gate must not be blamed yet');
});

await checkAsync('a finished clean run — exit 0, nothing failed', async () => {
  const { file } = await gaterun.startRun(wt1, { suites: ['test/green.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 0.2 });
  const r = run(wt1);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /done, green/);
});

await checkAsync('a finished run red on a suite only this branch has — exit 1, tagged new', async () => {
  const { file } = await gaterun.startRun(wt1, { suites: ['test/new-red.mjs'] });
  gaterun.appendResult(file, { suite: 'test/new-red.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.2 });
  const r = run(wt1);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /test\/new-red\.mjs \(new — not on origin\/main\)/);
});

await checkAsync('a finished run red on a suite origin/main is ALSO red on — exit 0, tagged main-red', async () => {
  const { file } = await gaterun.startRun(wt1, { suites: ['test/red-everywhere.mjs'] });
  gaterun.appendResult(file, { suite: 'test/red-everywhere.mjs', status: 'fail', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'fail', elapsed: 0.2 });
  const r = run(wt1);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /test\/red-everywhere\.mjs \(also red on origin\/main\)/);
});

await checkAsync('--run <id> started from one worktree is readable from another', async () => {
  const { runId, file } = await gaterun.startRun(main, { suites: ['test/green.mjs'] });
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 0.1 });
  // Asked for from wt1 — a different worktree, a different session's cwd entirely.
  const r = run(wt1, ['--run', runId]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.stdout, /\(main\)/, "the run's own worktree tag travels with it, not the caller's");
});

await checkAsync('--wait blocks until the run ends, then reports the final result', async () => {
  const { file } = await gaterun.startRun(wt1, { suites: ['test/green.mjs'] });
  const child = spawn(process.execPath, [BIN, '--wait', '--timeout', '10'], { cwd: wt1, encoding: 'utf8' });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  await new Promise((r) => setTimeout(r, 300));
  gaterun.appendResult(file, { suite: 'test/green.mjs', status: 'ok', elapsed: 0.1 });
  gaterun.endRun(file, { status: 'ok', elapsed: 0.4 });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0);
  assert.match(out, /done, green/);
});

await checkAsync('--wait gives up at the deadline and reports "running" rather than hanging', async () => {
  await gaterun.startRun(wt1, { suites: ['test/green.mjs'] }); // never ends
  const started = Date.now();
  const r = spawnSync(process.execPath, [BIN, '--wait', '--timeout', '1'], { cwd: wt1, encoding: 'utf8' });
  const took = Date.now() - started;
  assert.equal(r.status, 0);
  assert.match(r.stdout, /running/);
  assert.ok(took < 5000, `should give up near the 1s deadline, took ${took}ms`);
});

removeTreeSync(tmp);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall b7e-watch checks passed');
