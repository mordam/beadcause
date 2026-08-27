#!/usr/bin/env node
/**
 * `b7e-mutate` — mutation-test a change without hand-rolling the backup-mutate-restore
 * dance. bin/b7e-mutate and lib/mutate.js.
 *
 *     npm test
 *     node test/b7emutate.mjs
 *
 * bc-dgx7.12's own acceptance criteria are what this replays: sp-vbm's nine mutations,
 * expressed as one plan, run in one call, all caught, tree byte-identical afterward —
 * including when the process is killed mid-run — and a mutation whose `--from` matches
 * nothing exits non-zero rather than reporting a pass. Every case here spawns the real
 * CLI against real files in a scratch directory, the same discipline test/b7ehandback.mjs
 * uses for its own CLI.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-mutate');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7emutate-'));

const SAMPLE = `function add(a, b) {
  return a + b;
}
module.exports = { add };
`;
const TEST_JS = `const assert = require('assert');
const { add } = require('./sample.js');
assert.strictEqual(add(2, 3), 5);
console.log('ok');
`;
const BAD_TEST_JS = `throw new Error('already broken');\n`;

function writeSample(dir) {
  fs.writeFileSync(path.join(dir, 'sample.js'), SAMPLE);
  fs.writeFileSync(path.join(dir, 'test.js'), TEST_JS);
}

/** A fresh scratch dir per check, so one check's leftover file can never leak into another. */
function scratch(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  writeSample(dir);
  return dir;
}

const run = (args, cwd) => {
  const res = spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status, out: res.stdout || '', err: res.stderr || '' };
};

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.stack || err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

const checkAsync = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${String(err.stack || err.message).split('\n').slice(0, 8).join('\n      ')}`);
  }
};

console.log('\nb7e-mutate — mutation-test a change without hand-rolling the dance\n');

check('a real mutation the test catches is reported caught, and the file is restored', () => {
  const dir = scratch('caught');
  const { status, out } = run(['--file', 'sample.js', '--from', 'a + b', '--to', 'a - b', '--test', 'node test.js'], dir);
  assert.equal(status, 0, out);
  assert.match(out, /sample\.js: caught/);
  assert.equal(fs.readFileSync(path.join(dir, 'sample.js'), 'utf8'), SAMPLE);
});

check('a no-op mutation the test cannot catch is reported SURVIVED, non-zero exit', () => {
  const dir = scratch('survived');
  const { status, out } = run(['--file', 'sample.js', '--from', 'a + b', '--to', 'a + b', '--test', 'node test.js'], dir);
  assert.notEqual(status, 0);
  assert.match(out, /sample\.js: SURVIVED/);
  assert.equal(fs.readFileSync(path.join(dir, 'sample.js'), 'utf8'), SAMPLE);
});

check('a --from that matches nothing is an error, not a silent pass, and nothing was written', () => {
  const dir = scratch('nomatch');
  const { status, out } = run(['--file', 'sample.js', '--from', 'NOWHERE_IN_FILE', '--to', 'x', '--test', 'node test.js'], dir);
  assert.notEqual(status, 0);
  assert.match(out, /sample\.js: ERROR — --from matches nothing/);
  assert.equal(fs.readFileSync(path.join(dir, 'sample.js'), 'utf8'), SAMPLE);
});

check('a baseline that is already red refuses before any mutation, distinct exit code', () => {
  const dir = scratch('redbaseline');
  fs.writeFileSync(path.join(dir, 'test.js'), BAD_TEST_JS);
  const { status, err } = run(['--file', 'sample.js', '--from', 'a + b', '--to', 'a - b', '--test', 'node test.js'], dir);
  assert.equal(status, 3);
  assert.match(err, /baseline is already red/);
  assert.equal(fs.readFileSync(path.join(dir, 'sample.js'), 'utf8'), SAMPLE, 'refused before touching the file');
});

check("sp-vbm's nine mutations as one plan, run in one call, all caught, tree byte-identical after", () => {
  const dir = scratch('plan9');
  // Nine distinct literal swaps, each individually caught by test.js's strict equality on
  // add(2, 3) === 5 — mirroring "nine mutations against one suite" as the bead's own
  // acceptance criteria describe it. Each is checked against the pristine original — the
  // file is fully restored between mutations, so these do NOT compose: every "from" here
  // has to match the untouched sample, not the output of a previous swap in this list.
  const swaps = [
    ['a + b', 'a - b'],
    ['function add', 'function addx'],
    ['module.exports', 'module.exportsX'],
    ['{ add }', '{ addOnly: add }'],
    ['return a + b', 'return b + a + 1'],
    ['return a + b;', 'return a * b;'],
    ['add(a, b)', 'add(aa, b)'],
    ['add }', 'addNope }'],
    ['add(a, b)', 'add(a, bb)'],
  ];
  fs.writeFileSync(path.join(dir, 'plan.yaml'), swaps.map(([from, to]) => `- file: sample.js\n  from: "${from}"\n  to: "${to}"\n`).join(''));
  const { status, out } = run(['--plan', 'plan.yaml', '--test', 'node test.js', '--keep-going'], dir);
  assert.equal(status, 0, out);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, swaps.length);
  assert.ok(lines.every((l) => / caught/.test(l)), out);
  assert.equal(fs.readFileSync(path.join(dir, 'sample.js'), 'utf8'), SAMPLE, 'byte-identical after the whole plan');
});

check('--plan reads from stdin with "-"', () => {
  const dir = scratch('stdin');
  const yaml = '- file: sample.js\n  from: "a + b"\n  to: "a - b"\n';
  const res = spawnSync(process.execPath, [BIN, '--plan', '-', '--test', 'node test.js'], { cwd: dir, input: yaml, encoding: 'utf8' });
  assert.equal(res.status, 0, res.stdout + res.stderr);
  assert.match(res.stdout, /sample\.js: caught/);
});

check('without --keep-going, a plan stops at the first SURVIVED mutation', () => {
  const dir = scratch('stopfirst');
  const yaml = [
    '- file: sample.js\n  from: "a + b"\n  to: "a + b"\n  label: noop\n', // SURVIVED
    '- file: sample.js\n  from: "a + b"\n  to: "a - b"\n  label: real\n', // would be caught
  ].join('');
  fs.writeFileSync(path.join(dir, 'plan.yaml'), yaml);
  const { status, out } = run(['--plan', 'plan.yaml', '--test', 'node test.js'], dir);
  assert.notEqual(status, 0);
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 1, 'stopped after the first problem');
  assert.match(lines[0], /^noop: SURVIVED/);
});

check('--keep-going runs the rest of the plan after a SURVIVED mutation', () => {
  const dir = scratch('keepgoing');
  const yaml = [
    '- file: sample.js\n  from: "a + b"\n  to: "a + b"\n  label: noop\n',
    '- file: sample.js\n  from: "a + b"\n  to: "a - b"\n  label: real\n',
  ].join('');
  fs.writeFileSync(path.join(dir, 'plan.yaml'), yaml);
  const { status, out } = run(['--plan', 'plan.yaml', '--test', 'node test.js', '--keep-going'], dir);
  assert.notEqual(status, 0, 'still non-zero overall — one of them SURVIVED');
  const lines = out.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^noop: SURVIVED/);
  assert.match(lines[1], /^real: caught/);
});

check('a plan record\'s own test overrides the plan-wide --test', () => {
  const dir = scratch('perrecordtest');
  fs.writeFileSync(path.join(dir, 'other-test.js'), TEST_JS);
  const yaml = '- file: sample.js\n  from: "a + b"\n  to: "a - b"\n  test: "node other-test.js"\n';
  fs.writeFileSync(path.join(dir, 'plan.yaml'), yaml);
  // The plan-wide --test is deliberately a command that would crash if it ran, so this
  // only passes if the record's own "test" was actually used instead.
  const { status, out } = run(['--plan', 'plan.yaml', '--test', 'node no-such-file.js'], dir);
  assert.equal(status, 0, out);
  assert.match(out, /caught/);
});

check('--json reports the same facts as the printed form', () => {
  const dir = scratch('json');
  const { status, out } = run(['--file', 'sample.js', '--from', 'a + b', '--to', 'a - b', '--test', 'node test.js', '--json'], dir);
  assert.equal(status, 0, out);
  const payload = JSON.parse(out);
  assert.equal(payload.refused, null);
  assert.equal(payload.results.length, 1);
  assert.equal(payload.results[0].survived, false);
  assert.equal(payload.results[0].file, 'sample.js');
});

check('--from/--to/--file/--test are all required in single-mutation mode', () => {
  const dir = scratch('usage');
  const { status: s1 } = run(['--file', 'sample.js', '--to', 'x', '--test', 'node test.js'], dir);
  assert.equal(s1, 2);
  const { status: s2 } = run(['--file', 'sample.js', '--from', 'x', '--test', 'node test.js'], dir);
  assert.equal(s2, 2);
  const { status: s3 } = run(['--file', 'sample.js', '--from', 'a + b', '--to', 'x'], dir);
  assert.equal(s3, 2);
  const { status: s4 } = run([], dir);
  assert.equal(s4, 2);
});

check('--plan and --file together are refused', () => {
  const dir = scratch('bothmodes');
  fs.writeFileSync(path.join(dir, 'plan.yaml'), '- file: sample.js\n  from: "a"\n  to: "b"\n');
  const { status, err } = run(['--file', 'sample.js', '--plan', 'plan.yaml', '--test', 'node test.js'], dir);
  assert.equal(status, 2);
  assert.match(err, /mutually exclusive/);
});

check('an empty plan is refused', () => {
  const dir = scratch('emptyplan');
  fs.writeFileSync(path.join(dir, 'plan.yaml'), '[]\n');
  const { status, err } = run(['--plan', 'plan.yaml', '--test', 'node test.js'], dir);
  assert.equal(status, 2);
  assert.match(err, /names no mutations/);
});

check('clearPycache removes __pycache__ directories but leaves node_modules and .git alone', async () => {
  const dir = scratch('pycache');
  const cache = path.join(dir, 'sub', '__pycache__');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'mod.cpython-311.pyc'), 'stale bytecode');
  const nm = path.join(dir, 'node_modules', '__pycache__');
  fs.mkdirSync(nm, { recursive: true });
  const gitCache = path.join(dir, '.git', '__pycache__');
  fs.mkdirSync(gitCache, { recursive: true });
  const { clearPycache } = await import(new URL('../lib/mutate.js', import.meta.url).href);
  clearPycache(dir);
  assert.equal(fs.existsSync(cache), false);
  assert.equal(fs.existsSync(nm), true, 'node_modules is skipped entirely, not walked into');
  assert.equal(fs.existsSync(gitCache), true, '.git is skipped entirely, not walked into');
});

await checkAsync('the file is restored to the exact original bytes even when the process is killed mid-run', async () => {
  const dir = scratch('killed');
  // The baseline run uses this same command before any mutation happens (see lib/mutate.js
  // header), so the mutation write cannot appear on disk until one full delay has already
  // elapsed — the poll deadline below has to clear the baseline *and* leave room to land
  // the kill inside the mutation run's own delay window.
  fs.writeFileSync(path.join(dir, 'slow-test.js'), 'setTimeout(() => { console.log("ok"); }, 4000);\n');
  const child = spawn(process.execPath, [BIN, '--file', 'sample.js', '--from', 'a + b', '--to', 'a - b', '--test', 'node slow-test.js'], {
    cwd: dir,
  });
  const mutated = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 15000;
    const poll = () => {
      const text = fs.readFileSync(path.join(dir, 'sample.js'), 'utf8');
      if (text.includes('a - b')) return resolve(text);
      if (Date.now() > deadline) return reject(new Error('mutation never appeared on disk'));
      setTimeout(poll, 25);
    };
    poll();
  });
  assert.match(mutated, /a - b/, 'sanity: the mutation really landed before the kill');
  const killedAt = Date.now();
  const exit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  const { code, signal } = await exit;
  const tookMs = Date.now() - killedAt;
  // A node process blocked in a synchronous child test run is not always preemptible
  // between ticks — how the OS/Node report the death (a caught 'SIGTERM' re-raised by
  // lib/teardown.js vs the process simply ending early) is not the property under test.
  // What matters, and what the bead's own acceptance criteria actually name, is that it
  // ended promptly rather than running the mutation's test to its natural 4s completion,
  // and that the file came back byte-identical either way.
  assert.ok(tookMs < 3500, `expected the kill to end the run well before the natural 4s test duration, took ${tookMs}ms (code=${code}, signal=${signal})`);
  assert.equal(fs.readFileSync(path.join(dir, 'sample.js'), 'utf8'), SAMPLE, 'restored even though the process was killed mid-run, not returned normally');
});

console.log(`\n${ran - failures}/${ran} passed`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
