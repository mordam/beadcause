#!/usr/bin/env node
//
// b7e-sheet — render named sophab drawing sheets at named sizes (bc-dgx7.13).
//
//   npm test
//   node test/b7esheet.mjs
//
// lib/sheet.js's pure halves (sophabRoot resolution, the availability check, the argv
// it builds for tools/sheet_probe.py) are checked directly with an injected fake spawn,
// the same shape lib/plate.js's injectable `{ sips, python }` uses for its own external
// tools. The bin is driven as a real subprocess against a fixture "sophab checkout" (a
// stub .venv/bin/python3 that just echoes its argv), the same split test/b7ewhere.mjs
// uses — argv parsing and exit codes are the thing under test there, and calling the lib
// function directly would prove nothing about the CLI wrapper around it. One real
// end-to-end render against the actual sophab checkout on this machine runs ONLY when
// it, its .venv and tools/sheet_probe.py are all actually present — skipped loudly
// otherwise, the same shape test/plate.mjs uses for a missing sips/Pillow.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-sheet');

const { defaultSophabRoot, sheetProbeProblem, runSheetProbe } = await import(path.join(ROOT, 'lib', 'sheet.js'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nb7e-sheet\n');

/* ------------------------------------------------------------------ defaultSophabRoot */

check('defaultSophabRoot: SOPHAB_DIR wins when set', () => {
  const prev = process.env.SOPHAB_DIR;
  process.env.SOPHAB_DIR = '/tmp/not-real-sophab';
  try {
    assert.equal(defaultSophabRoot(), '/tmp/not-real-sophab');
  } finally {
    if (prev === undefined) delete process.env.SOPHAB_DIR;
    else process.env.SOPHAB_DIR = prev;
  }
});

check('defaultSophabRoot: falls back to ~/neadamthal.projects/sophab', () => {
  const prev = process.env.SOPHAB_DIR;
  delete process.env.SOPHAB_DIR;
  try {
    assert.equal(defaultSophabRoot(), path.join(os.homedir(), 'neadamthal.projects', 'sophab'));
  } finally {
    if (prev !== undefined) process.env.SOPHAB_DIR = prev;
  }
});

/* ------------------------------------------------------------------ sheetProbeProblem */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b7esheet-fixture-'));

check('sheetProbeProblem: no checkout at all is refused', () => {
  const problem = sheetProbeProblem(path.join(tmp, 'nowhere'));
  assert.ok(problem && problem.includes('no sophab checkout'), problem);
});

check('sheetProbeProblem: checkout with no tools/sheet_probe.py is refused', () => {
  const dir = path.join(tmp, 'no-script');
  fs.mkdirSync(dir, { recursive: true });
  const problem = sheetProbeProblem(dir);
  assert.ok(problem && problem.includes('sheet_probe.py'), problem);
});

check('sheetProbeProblem: checkout with the script but no .venv is refused', () => {
  const dir = path.join(tmp, 'no-venv');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'sheet_probe.py'), '# stub\n');
  const problem = sheetProbeProblem(dir);
  assert.ok(problem && problem.includes('.venv'), problem);
});

check('sheetProbeProblem: script + .venv present is fine', () => {
  const dir = path.join(tmp, 'complete');
  fs.mkdirSync(path.join(dir, 'tools'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.venv', 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'tools', 'sheet_probe.py'), '# stub\n');
  fs.writeFileSync(path.join(dir, '.venv', 'bin', 'python3'), '#!/bin/sh\n', { mode: 0o755 });
  assert.equal(sheetProbeProblem(dir), null);
});

/* ------------------------------------------------------------------ runSheetProbe */

check('runSheetProbe: builds the python argv from sophabRoot, forwards optional flags', () => {
  const calls = [];
  const fakeSpawn = (bin, args, opts) => {
    calls.push({ bin, args, opts });
    return { status: 0, stdout: '', stderr: '' };
  };
  runSheetProbe(
    { sheets: 'E1', size: 'small', out: '/tmp/x', text: true, json: true, sophabRoot: '/fake/sophab' },
    fakeSpawn
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/fake/sophab/.venv/bin/python3');
  assert.deepEqual(calls[0].args, [
    '/fake/sophab/tools/sheet_probe.py', 'E1', '--size', 'small', '--out', '/tmp/x', '--text', '--json',
  ]);
  assert.equal(calls[0].opts.cwd, '/fake/sophab');
  assert.equal(calls[0].opts.env.PYTHONPATH, '/fake/sophab');
});

check('runSheetProbe: omits --out/--text/--json when not given', () => {
  const calls = [];
  const fakeSpawn = (bin, args) => {
    calls.push(args);
    return { status: 0, stdout: '', stderr: '' };
  };
  runSheetProbe({ sheets: 'all', size: 'big', sophabRoot: '/fake/sophab' }, fakeSpawn);
  assert.deepEqual(calls[0], ['/fake/sophab/tools/sheet_probe.py', 'all', '--size', 'big']);
});

/* ------------------------------------------------------------------ bin/b7e-sheet CLI */

function run(args, env = {}) {
  return spawnSync(process.execPath, [BIN, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

check('CLI: --help exits 0 and prints usage without touching any checkout', () => {
  const r = run(['--help'], { SOPHAB_DIR: '/definitely/not/there' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('usage: b7e-sheet'), r.stdout);
});

check('CLI: no args refuses with exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('needs <sheets>'), r.stderr);
});

check('CLI: sheets with no --size refuses with exit 2', () => {
  const r = run(['E1']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('--size is required'), r.stderr);
});

check('CLI: two positional sheets arguments are refused', () => {
  const r = run(['E1', 'S7', '--size', 'small']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('only one <sheets> argument'), r.stderr);
});

check('CLI: an unknown flag is refused', () => {
  const r = run(['E1', '--size', 'small', '--bogus']);
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('unknown flag --bogus'), r.stderr);
});

check('CLI: a missing sophab checkout is refused with a clear message, not a crash', () => {
  const r = run(['E1', '--size', 'small'], { SOPHAB_DIR: path.join(tmp, 'nowhere') });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes('no sophab checkout'), r.stderr);
});

// A fixture "sophab checkout" whose .venv/bin/python3 is a real executable shell script
// standing in for the real interpreter — proves the CLI forwards argv, stdout, stderr
// and exit code correctly, without needing matplotlib/numpy/sophab's own tree at all.
const fixtureRoot = path.join(tmp, 'fixture-sophab');
fs.mkdirSync(path.join(fixtureRoot, 'tools'), { recursive: true });
fs.mkdirSync(path.join(fixtureRoot, '.venv', 'bin'), { recursive: true });
fs.writeFileSync(path.join(fixtureRoot, 'tools', 'sheet_probe.py'), '# stub, never actually run\n');
fs.writeFileSync(
  path.join(fixtureRoot, '.venv', 'bin', 'python3'),
  [
    '#!/bin/sh',
    'echo "ARGS:$@"',
    'if [ "$2" = "FAIL" ]; then echo "boom" 1>&2; exit 1; fi',
    'echo "/tmp/fixture/E1_small.png"',
    'exit 0',
    '',
  ].join('\n'),
  { mode: 0o755 }
);

check('CLI: forwards sheets/--size/--out/--text/--json through to the interpreter', () => {
  const r = run(['E1', '--size', 'small', '--out', '/tmp/look', '--text', '--json'], {
    SOPHAB_DIR: fixtureRoot,
  });
  assert.equal(r.status, 0);
  const scriptPath = path.join(fixtureRoot, 'tools', 'sheet_probe.py');
  assert.ok(
    r.stdout.includes(`ARGS:${scriptPath} E1 --size small --out /tmp/look --text --json`),
    r.stdout
  );
});

check("CLI: exits with the interpreter's own status and prints its stderr", () => {
  // sheets=FAIL is not special to the CLI wrapper -- it is what the fixture python
  // stub itself watches for, to prove a non-zero exit really is forwarded verbatim.
  const r = run(['FAIL', '--size', 'small'], { SOPHAB_DIR: fixtureRoot });
  assert.equal(r.status, 1);
  assert.ok(r.stderr.includes('boom'), r.stderr);
});

check('CLI: --dir overrides SOPHAB_DIR', () => {
  const r = run(['E1', '--size', 'small', '--dir', fixtureRoot], { SOPHAB_DIR: '/nowhere/at/all' });
  assert.equal(r.status, 0);
  assert.ok(r.stdout.includes('/tmp/fixture/E1_small.png'), r.stdout);
});

await cleanupTmp(tmp);

/* ------------------------------------------------------------------ real sophab, if present */

const realRoot = defaultSophabRoot();
const realProblem = sheetProbeProblem(realRoot);
if (realProblem) {
  console.log(`  \x1b[33m—\x1b[0m skipped: real sophab checkout not usable here (${realProblem})`);
} else {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b7esheet-real-'));
  check('real sophab: E1 --size small renders one PNG, sophab worktree stays clean', () => {
    const before = execFileSync('git', ['-C', realRoot, 'status', '--porcelain'], { encoding: 'utf8' });
    const r = execFileSync(process.execPath, [BIN, 'E1', '--size', 'small', '--out', outDir], {
      encoding: 'utf8',
    });
    const lines = r.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 1, r);
    assert.ok(fs.existsSync(lines[0]), `expected ${lines[0]} to exist`);
    const after = execFileSync('git', ['-C', realRoot, 'status', '--porcelain'], { encoding: 'utf8' });
    assert.equal(after, before, 'sheet_probe.py must never dirty the sophab checkout it runs from');
  });
  await cleanupTmp(outDir);
}

console.log(`\n${ran - failures}/${ran} ok\n`);
process.exit(failures ? 1 : 0);
