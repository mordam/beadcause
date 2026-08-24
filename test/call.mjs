#!/usr/bin/env node
//
// b7e-call — call one export from this repo, with arguments, or over every row of a real
// tracker (bc-zjab.7). Seven sessions each hand-rolled `node -e
// "import('./lib/x.js').then(m=>...)"` to answer "what does this export return", and two
// of those round trips were spent on shell quoting rather than the answer (bc-bmry.5's
// NUL scan). This is a real subprocess throughout — a stub `bd` for --over, same shape as
// test/census.mjs's, and a real fixture module for --json — because the thing under test
// is the argv parsing, the import boundary and how the child process actually prints a
// return value, none of which a fake would prove anything about.
//
//   npm test
//   node test/call.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-call');

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

console.log('\nb7e-call\n');

/* ------------------------------------------------------------------- fixture module */

// Written inside ROOT on purpose: b7e-call refuses a module path outside the worktree,
// so a real target for the "it works" checks has to live under the checkout the running
// bin/b7e-call actually belongs to.
const FIXTURE = path.join(ROOT, 'test', 'tmp-b7ecall-fixture.mjs');
fs.writeFileSync(
  FIXTURE,
  `export function greet(name) {
  return \`hello, \${name}!\\nline two > "quoted" \\x00end\`;
}
export function boom() {
  throw new Error('kaboom\\nsecond line should never reach the terminal');
}
export function add(a, b) {
  return a + b;
}
export async function slow(x) {
  return x * 2;
}
export function bead(row) {
  return row && typeof row === 'object' ? row.status : null;
}
export function bigString(n) {
  return 'x'.repeat(n) + 'END';
}
`
);
const FIXTURE_REL = path.relative(ROOT, FIXTURE);

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd: ROOT, ...opts });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* ============================================================================ --json */

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage:/);
  assert.match(stdout, /b7e-call/);
});

check('no arguments at all prints usage and exits nonzero', () => {
  const { status, stdout } = run([]);
  assert.notEqual(status, 0);
  assert.match(stdout, /usage:/);
});

check('a string return value is printed verbatim — newlines, >, quotes and NUL intact', () => {
  const { status, stdout } = run([`${FIXTURE_REL}#greet`, '--json', '["World"]']);
  assert.equal(status, 0);
  assert.equal(stdout, 'hello, World!\nline two > "quoted" \x00end\n');
});

check('a throwing export exits non-zero naming the module and only the error\'s first line', () => {
  const { status, stderr } = run([`${FIXTURE_REL}#boom`, '--json', '[]']);
  assert.notEqual(status, 0);
  assert.match(stderr, new RegExp(FIXTURE_REL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(stderr, /kaboom/);
  assert.ok(!stderr.includes('second line should never reach the terminal'));
});

check('a non-string return value is printed for a human, not JSON-escaped', () => {
  const { status, stdout } = run([`${FIXTURE_REL}#add`, '--json', '[2,3]']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '5');
});

check('an async export is awaited before printing', () => {
  const { status, stdout } = run([`${FIXTURE_REL}#slow`, '--json', '[21]']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '42');
});

check('a module path outside the worktree is refused rather than resolved', () => {
  const { status, stderr } = run(['/etc/hosts#toString', '--json', '[]']);
  assert.notEqual(status, 0);
  assert.match(stderr, /refusing module path outside the worktree/);
});

check('a module path that climbs out with ../.. is refused the same way', () => {
  const { status, stderr } = run(['../../../../../../etc/hosts#toString', '--json', '[]']);
  assert.notEqual(status, 0);
  assert.match(stderr, /refusing module path outside the worktree/);
});

check('a missing module is a plain error, not a crash', () => {
  const { status, stderr } = run(['test/does-not-exist.mjs#foo', '--json', '[]']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no such module/);
});

check('an export the module does not have is a plain error naming what it does have', () => {
  const { status, stderr } = run([`${FIXTURE_REL}#nope`, '--json', '[]']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no exported function "nope"/);
  assert.match(stderr, /greet/);
});

check('malformed --json is refused before anything is imported', () => {
  const { status, stderr } = run([`${FIXTURE_REL}#greet`, '--json', 'not json']);
  assert.notEqual(status, 0);
  assert.match(stderr, /not valid JSON/);
});

check('--json that is not an array is refused', () => {
  const { status, stderr } = run([`${FIXTURE_REL}#greet`, '--json', '{"a":1}']);
  assert.notEqual(status, 0);
  assert.match(stderr, /must be a JSON array/);
});

check('a target with no "#" is refused', () => {
  const { status, stderr } = run(['lib/relay.js', '--json', '[]']);
  assert.notEqual(status, 0);
  assert.match(stderr, /missing "#"/);
});

check('a caller-sized return value survives a real pipe whole (bc-dgx7.53)', () => {
  // `printForHuman(...)` then `process.exit(0)` used to drop whatever of the write was
  // still pending: stdout to a **pipe** is async in Node, so this could come back cut at
  // exactly 65536 bytes with status 0 — no error, no nonzero exit, nothing to notice.
  // spawnSync's stdio here is a pipe, which is the case that broke.
  const { status, stdout } = run([`${FIXTURE_REL}#bigString`, '--json', '[70000]']);
  assert.equal(status, 0);
  assert.ok(stdout.length > 65536, `payload too small to test the pipe buffer: ${stdout.length} bytes`);
  assert.ok(stdout.trimEnd().endsWith('END'), `expected the payload's tail intact, got: ${JSON.stringify(stdout.slice(-20))}`);
});

/* ============================================================================= --over */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-call-'));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });

const FAKE_BD = path.join(tmp, 'bd');
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
const args = process.argv.slice(2);
const worldFile = path.join(dir, 'world.json');
if (!fs.existsSync(worldFile)) { process.stderr.write('no such workspace\\n'); process.exit(1); }
const world = JSON.parse(fs.readFileSync(worldFile, 'utf8'));
if (args[0] === 'ready') {
  const excluded = new Set();
  for (let i = 0; i < args.length; i += 1) if (args[i] === '--exclude-label') excluded.add(args[i + 1]);
  const rows = world.filter((r) => r.status === 'open' && !(r.labels || []).some((l) => excluded.has(l)));
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
if (args[0] === 'list') {
  const statusArg = args.find((a) => a.startsWith('--status='));
  let rows;
  if (statusArg) {
    const wanted = new Set(statusArg.slice('--status='.length).split(','));
    rows = world.filter((r) => wanted.has(r.status));
  } else {
    rows = world.filter((r) => r.status !== 'closed'); // bd list's own default: closed hidden
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
process.stderr.write('stub bd: unexpected verb "' + args[0] + '"\\n');
process.exit(1);
`,
  { mode: 0o755 }
);

const dirFor = (name) => {
  const d = path.join(tmp, name, '.beads');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
const DELUVIA = { name: 'deluvia', dir: dirFor('deluvia') };

const row = (id, { status = 'open', labels = [] } = {}) => ({ id, status, labels, title: `${id} title` });
const world = [
  row('dv-1', { status: 'open' }),
  row('dv-2', { status: 'open' }),
  row('dv-3', { status: 'closed' }),
  row('dv-4', { status: 'in_progress' }),
];
fs.writeFileSync(path.join(DELUVIA.dir, 'world.json'), JSON.stringify(world));

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [DELUVIA] }, null, 2)
);

function runOver(args) {
  return run(args, { env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir } });
}

check('--over with no mode suffix defaults to ready', () => {
  const { status, stdout } = runOver([`${FIXTURE_REL}#bead`, '--over', 'deluvia']);
  assert.equal(status, 0);
  assert.match(stdout, /^dv-1 /m);
  assert.match(stdout, /^dv-2 /m);
  assert.ok(!stdout.includes('dv-3')); // closed — not ready
  assert.ok(!stdout.includes('dv-4')); // in_progress — not ready
  assert.match(stdout, /2 beads called/);
});

check('--over :open reads bd list --status=open, not ready', () => {
  const { stdout } = runOver([`${FIXTURE_REL}#bead`, '--over', 'deluvia:open']);
  assert.match(stdout, /dv-1/);
  assert.ok(!stdout.includes('dv-4')); // in_progress, excluded by --status=open
});

check('--over :all is bd\'s own default — closed excluded, in_progress included', () => {
  const { stdout } = runOver([`${FIXTURE_REL}#bead`, '--over', 'deluvia:all']);
  assert.match(stdout, /dv-1/);
  assert.match(stdout, /dv-4/);
  assert.ok(!stdout.includes('dv-3')); // closed
  assert.match(stdout, /3 beads called/);
});

check('--limit caps the rows and announces the cap rather than truncating silently', () => {
  const { stdout } = runOver([`${FIXTURE_REL}#bead`, '--over', 'deluvia:all', '--limit', '1']);
  assert.match(stdout, /showing 1 of 3/);
  assert.match(stdout, /1 bead called/);
});

check('--over prints a tally of distinct results at the end', () => {
  const { stdout } = runOver([`${FIXTURE_REL}#bead`, '--over', 'deluvia:all']);
  const tallyLine = stdout.split('\n').find((l) => l.startsWith('2\t'));
  assert.ok(tallyLine, `expected a "2\\t..." tally line in:\n${stdout}`);
});

check('an unrecognised mode is refused', () => {
  const { status, stderr } = runOver([`${FIXTURE_REL}#bead`, '--over', 'deluvia:bogus']);
  assert.notEqual(status, 0);
  assert.match(stderr, /is not a mode --over understands/);
});

check('an unconfigured workspace is refused, naming the ones that exist', () => {
  const { status, stderr } = runOver([`${FIXTURE_REL}#bead`, '--over', 'nope:ready']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no workspace named "nope"/);
  assert.match(stderr, /deluvia/);
});

check('the live cross-workspace read this bead\'s acceptance names actually runs read-only', () => {
  // b7e-call lib/relay.js#chainFor --over deluvia:ready — chainFor's own signature is
  // (cfg, workspaceName, bead), so called with just the row it comes back null for every
  // row; the point of this check is that the real command, the real module and a real
  // tracker read all run to completion and print a tally, not that the answer is
  // meaningful for this particular export's calling convention.
  const { status, stdout } = runOver(['lib/relay.js#chainFor', '--over', 'deluvia:ready']);
  assert.equal(status, 0);
  assert.match(stdout, /^dv-1 /m);
  assert.match(stdout, /2 beads called/);
});

fs.rmSync(FIXTURE, { force: true });

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
