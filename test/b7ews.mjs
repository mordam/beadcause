#!/usr/bin/env node
//
// b7e-ws — read another workspace's tracker by name, instead of guessing which
// directory resolves it (bc-bmry.10).
//
//   npm test
//   node test/b7ews.mjs
//
// Three sessions working beadcause bugs each had to read *deluvia*'s graph, and each
// one hand-rolled `cd ~/beads/deluvia && zsh -c 'bd show dv-vry'` — one of them got the
// wrong graph outright, because the shell's own cwd resolution (`_bd_set_workspace`)
// picked a different `.beads` than the name implied, and `bd` answered "no issue found"
// for what was really "wrong workspace". `bin/b7e-ws` replaces the whole dance with a
// lookup that already exists for free: `cfg.workspaces` (lib/config.js, backed by
// lib/workspaceroots.js) maps a name to its `.beads` directory, and `Bd.run` (lib/bd.js)
// spawns `bd` with `BEADS_DIR`/`cwd` set to that directory directly — no `cd`, ever.
//
// Driven as a real subprocess against a stub `bd`, for the reason test/autoendorse.mjs
// gives for `bin/file.js`: the flags reaching `bd` are the thing under test, and a stub
// that swallowed the argv would prove nothing. The stub keeps one JSON world PER
// workspace directory (read from `$BEADS_DIR/world.json`), which is what makes "the
// right workspace answered" a provable fact rather than an assumption — the same id
// exists in both worlds with different data, and the test checks the data, not just
// that something was printed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-ws');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ews-'));
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });

/* ------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args: process.argv.slice(2), dir }) + '\\n');
const worldFile = path.join(dir, 'world.json');
const world = fs.existsSync(worldFile) ? JSON.parse(fs.readFileSync(worldFile, 'utf8')) : { issues: {} };
const args = process.argv.slice(2);
const verb = args[0];
const json = args.includes('--json');
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
// process.exit(0) right after a write here used to be able to drop whatever was still
// pending, same bug as bin/b7e-ws itself is under test for (bc-dgx7.45) — the if/else
// chain below is what stands in for the early return process.exit used to give, so a
// big fixture payload (list --json below) flushes instead of racing process.exit.
if (verb === 'show') {
  const issue = world.issues[args[1]];
  if (!issue) die('Error fetching ' + args[1] + ': no issue found matching "' + args[1] + '"');
  process.stdout.write(json ? JSON.stringify([issue]) : (issue.id + ' · ' + issue.title + '\\n'));
  process.exitCode = 0;
} else if (verb === 'comments') {
  process.stdout.write('comments for ' + args[1] + ': none\\n');
  process.exitCode = 0;
} else if (verb === 'list') {
  const rows = Object.values(world.issues);
  process.stdout.write(json ? JSON.stringify(rows) : rows.map((r) => r.id).join('\\n') + '\\n');
  process.exitCode = 0;
} else if (verb === 'ready') {
  process.stdout.write('ready: none\\n');
  process.exitCode = 0;
} else if (verb === 'search') {
  process.stdout.write('search results for "' + args[1] + '": none\\n');
  process.exitCode = 0;
} else {
  die('stub bd: unexpected verb "' + verb + '"');
}
`,
  { mode: 0o755 }
);

/* --------------------------------------------------------------- two workspaces */

const dirFor = (name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const ALPHA = { name: 'alpha', dir: dirFor('alpha') };
const BETA = { name: 'beta', dir: dirFor('beta') };
const GAMMA = { name: 'gamma-big', dir: dirFor('gamma-big') };

const seed = (id, title, description = '') => ({ id, title, description, status: 'open', issue_type: 'task', priority: 2, labels: [] });

fs.writeFileSync(
  path.join(ALPHA.dir, 'world.json'),
  JSON.stringify({ issues: { 'al-1': seed('al-1', 'Alpha bead one') } }, null, 2)
);
fs.writeFileSync(
  path.join(BETA.dir, 'world.json'),
  JSON.stringify({ issues: { 'be-1': seed('be-1', 'Beta bead one') } }, null, 2)
);
// A single issue with a caller-sized description — enough to push `list --json` past
// the 64KB pipe buffer, for the real-pipe proof below.
fs.writeFileSync(
  path.join(GAMMA.dir, 'world.json'),
  JSON.stringify({ issues: { 'ga-1': seed('ga-1', 'Gamma bead one', 'x'.repeat(70000) + 'END') } })
);

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify(
    { bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [ALPHA, BETA, GAMMA] },
    null,
    2
  )
);

/* ------------------------------------------------------------------------- run */

// A cwd with no relation to either workspace or to this repo at all — the whole point
// of the command is that this must not matter.
const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7ews-elsewhere-'));

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

function lastCall() {
  const lines = fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean);
  return JSON.parse(lines[lines.length - 1]);
}
const callCount = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);

/* --------------------------------------------------------------------- harness */

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

console.log('\nb7e-ws\n');

check('--help prints usage and exits 0, without ever calling bd', () => {
  const before = callCount();
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-ws/);
  assert.equal(callCount(), before, 'help must not spawn bd');
});

check('show <id> answers from a cwd with no relation to the workspace at all', () => {
  const { status, stdout } = run(['-w', 'alpha', 'show', 'al-1']);
  assert.equal(status, 0);
  assert.match(stdout, /al-1/);
  assert.match(stdout, /Alpha bead one/);
});

check('the SAME id in the OTHER workspace is a different bead — proves the right dir was used', () => {
  const a = run(['-w', 'alpha', 'show', 'al-1']);
  const b = run(['-w', 'beta', 'show', 'al-1']);
  assert.equal(a.status, 0);
  assert.notEqual(b.status, 0, 'al-1 does not exist in beta');
  assert.match(b.stderr, /no issue found/);
});

check('bd is spawned with BEADS_DIR set to that workspace\'s own directory', () => {
  run(['-w', 'beta', 'show', 'be-1']);
  const call = lastCall();
  assert.equal(call.dir, BETA.dir);
});

check('--json passes bd\'s own rows through unformatted', () => {
  const { status, stdout } = run(['-w', 'alpha', 'show', 'al-1', '--json']);
  assert.equal(status, 0);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].id, 'al-1');
  const call = lastCall();
  assert.ok(call.args.includes('--json'), '--json must reach bd');
});

check('a caller-sized row survives a real pipe whole (bc-dgx7.53)', () => {
  // bin/b7e-ws's success path never calls process.exit at all — it falls off the end
  // after process.stdout.write(out), which is already the fix bc-dgx7.45 applied
  // elsewhere. This proves that holds for a payload past the 64KB pipe buffer too.
  const { status, stdout } = run(['-w', 'gamma-big', 'list', '--json']);
  assert.equal(status, 0);
  assert.ok(stdout.length > 65536, `payload too small to test the pipe buffer: ${stdout.length} bytes`);
  const rows = JSON.parse(stdout);
  assert.equal(rows[0].id, 'ga-1');
  assert.ok(rows[0].description.endsWith('END'), 'description truncated mid-payload');
});

check('comments, list and ready and search are all forwarded', () => {
  assert.match(run(['-w', 'alpha', 'comments', 'al-1']).stdout, /comments for al-1/);
  assert.match(run(['-w', 'alpha', 'list']).stdout, /al-1/);
  assert.match(run(['-w', 'alpha', 'ready']).stdout, /ready:/);
  assert.match(run(['-w', 'alpha', 'search', 'a phrase']).stdout, /search results for "a phrase"/);
});

check('list forwards its own flags to bd verbatim', () => {
  run(['-w', 'alpha', 'list', '--status=open', '--label=foo']);
  const call = lastCall();
  // Bd.run appends its own `--actor <who>` after whatever this command forwards — see
  // lib/bd.js — so only the leading, caller-controlled slice is this command's to prove.
  assert.deepEqual(call.args.slice(0, 3), ['list', '--status=open', '--label=foo']);
});

check('an unconfigured workspace name is refused, naming the ones that exist', () => {
  const before = callCount();
  const { status, stderr } = run(['-w', 'gamma', 'show', 'zz-1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no workspace named "gamma"/);
  assert.match(stderr, /alpha/);
  assert.match(stderr, /beta/);
  assert.equal(callCount(), before, 'an unresolvable workspace must never reach bd');
});

check('a missing -w is refused before anything is resolved', () => {
  const { status, stderr } = run(['show', 'al-1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('a mutation verb is refused rather than forwarded, and bd is never called', () => {
  const before = callCount();
  const { status, stderr } = run(['-w', 'alpha', 'close', 'al-1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /"close" is not a read verb/);
  assert.equal(callCount(), before, 'a refused verb must not spawn bd at all');
});

check('create, update, claim, label and dep are refused the same way', () => {
  for (const verb of ['create', 'update', 'claim', 'label', 'dep']) {
    const { status, stderr } = run(['-w', 'alpha', verb, 'al-1']);
    assert.notEqual(status, 0, `${verb} must be refused`);
    assert.match(stderr, /is not a read verb/);
  }
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
