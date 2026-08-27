#!/usr/bin/env node
//
// b7e-field — the exact bytes of one field of one bead, raw, and the readback that
// proves a write landed (bc-dgx7.26). A session audit found five sessions each
// building their own extractor over `bd show --json`: a `node -e` one-off, a fistful
// of `python3 -c` snippets, a scratchpad `extract.py`. This is `Bd.show` (lib/bd.js)
// and `loadConfig` (lib/config.js), already imported by bin/b7e-plancheck, plus the
// argv and the printing around them.
//
//   npm test
//   node test/b7efield.mjs
//
// Driven as a real subprocess against a stub `bd`, the same shape test/b7eplancheck.mjs
// uses: the stub refuses any verb it does not explicitly recognise ('show' only here),
// which is what would catch this command spawning a write.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-field');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7efield-'));
process.on('exit', () => removeTreeSync(tmp));

/* ---------------------------------------------------------------------- the stub bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const dir = process.env.BEADS_DIR;
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify({ args, dir }) + '\\n');
const world = JSON.parse(fs.readFileSync(path.join(dir, 'world.json'), 'utf8'));
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
const rest = args.slice(1);

function collectIds(list) {
  const ids = [];
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    if (a === '--json') continue;
    if (a === '--actor') { i += 1; continue; }
    ids.push(a);
  }
  return ids;
}

if (verb === 'show') {
  const ids = collectIds(rest);
  const rows = [];
  for (const id of ids) {
    const issue = world.issues[id];
    if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
    rows.push({ ...issue });
  }
  process.stdout.write(JSON.stringify(rows));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '" — this command must never write');
`,
  { mode: 0o755 }
);

/* ------------------------------------------------------------------------- the world */

const NOTES_BODY = 'line one\nline two, no trailing newline on purpose';
const DESC_BODY = 'a description with\nseveral lines\nof text';

const issue = (id, over = {}) => ({
  id,
  title: 'A field-bearing bead',
  description: DESC_BODY,
  status: 'open',
  issue_type: 'task',
  priority: 2,
  assignee: 'someone@example.com',
  owner: '',
  labels: ['alpha', 'beta'],
  acceptance_criteria: 'must pass the acceptance test',
  notes: NOTES_BODY,
  parent: null,
  dependencies: [],
  ...over,
});

const WORLD = {
  issues: {
    'fl-full': issue('fl-full'),
    'fl-bare': issue('fl-bare', {
      description: '',
      notes: undefined,
      design: undefined,
      acceptance_criteria: '',
      labels: [],
      assignee: '',
      priority: 0,
    }),
  },
};

const dirFor = (name) => {
  const dir = path.join(tmp, 'beads', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'world.json'), JSON.stringify(WORLD, null, 2));
  return dir;
};
const WS = { name: 'field-ws', dir: dirFor('field-ws') };

const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [WS] }, null, 2)
);

/* --------------------------------------------------------------------------- run */

const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7efield-elsewhere-'));

function run(args, opts = {}) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

const callCount = () => (fs.existsSync(CALLS) ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const verbsCalled = () =>
  fs.existsSync(CALLS)
    ? fs.readFileSync(CALLS, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).args[0])
    : [];

/* ------------------------------------------------------------------------ harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
};

console.log('\nb7e-field\n');

check('--help prints usage and exits 0, without ever calling bd', () => {
  const before = callCount();
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-field/);
  assert.equal(callCount(), before, 'help must not spawn bd');
});

check('missing -w/-b is refused with exit 2, before any bd spawn', () => {
  const before = callCount();
  const { status, stderr } = run(['-b', 'fl-full', 'notes']);
  assert.equal(status, 2);
  assert.match(stderr, /-w\/--workspace and -b\/--bead are both required/);
  assert.equal(callCount(), before);
});

check('no field and no --all is refused with exit 2', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full']);
  assert.equal(status, 2);
  assert.match(stderr, /name at least one field, or pass --all/);
});

check('--all combined with a named field is refused', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', '--all']);
  assert.equal(status, 2);
  assert.match(stderr, /mutually exclusive/);
});

check('an unconfigured workspace is refused, naming the ones that exist', () => {
  const { status, stderr } = run(['-w', 'nowhere', '-b', 'fl-full', 'notes']);
  assert.equal(status, 2);
  assert.match(stderr, /no such workspace "nowhere"/);
  assert.match(stderr, /workspaces: field-ws/);
});

check('a bead that does not exist is refused, exit 2', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-nope', 'notes']);
  assert.equal(status, 2);
  assert.match(stderr, /could not read fl-nope/);
});

check('an unrecognised field name is refused, naming the fields that do exist', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full', 'bogus']);
  assert.equal(status, 2);
  assert.match(stderr, /unrecognised field\(s\): bogus/);
  assert.match(stderr, /description, design, notes, acceptance, labels, status, assignee, priority, title/);
});

check('a single field prints its raw body with no added newline', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes']);
  assert.equal(status, 0);
  assert.equal(stdout, NOTES_BODY, 'byte-for-byte, nothing appended');
});

check('acceptance maps to the acceptance_criteria json key, not a raw bd key', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'acceptance']);
  assert.equal(status, 0);
  assert.equal(stdout, 'must pass the acceptance test');
});

check('labels prints one label per line, raw', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'labels']);
  assert.equal(status, 0);
  assert.equal(stdout, 'alpha\nbeta');
});

check('priority prints as a plain number, even when it is 0', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-bare', 'priority']);
  assert.equal(status, 0);
  assert.equal(stdout, '0');
});

check('an unset field prints empty, not a refusal', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-bare', 'design']);
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

check('more than one field is printed with a ── rule before each', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'title', 'status']);
  assert.equal(status, 0);
  assert.equal(stdout, '── title\nA field-bearing bead\n── status\nopen\n');
});

check('--all prints every field with a value, in the field-order the bead names', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', '--all']);
  assert.equal(status, 0);
  const headers = [...stdout.matchAll(/── ([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(headers, ['description', 'notes', 'acceptance', 'labels', 'status', 'assignee', 'priority', 'title']);
});

check('--all on a bead with almost nothing set names only what has a value (priority 0 still counts)', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-bare', '--all']);
  assert.equal(status, 0);
  const headers = [...stdout.matchAll(/── ([a-z]+)/g)].map((m) => m[1]);
  assert.deepEqual(headers, ['status', 'priority', 'title']);
});

check('--len prints "<field> <bytes>" instead of the body', () => {
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', 'title', '--len']);
  assert.equal(status, 0);
  assert.equal(stdout, `notes ${Buffer.byteLength(NOTES_BODY, 'utf8')}\ntitle ${Buffer.byteLength('A field-bearing bead', 'utf8')}\n`);
});

check('--verify with an identical file prints nothing on stdout and exits 0', () => {
  const file = path.join(tmp, 'verify-match.txt');
  fs.writeFileSync(file, NOTES_BODY);
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', '--verify', file]);
  assert.equal(status, 0);
  assert.equal(stdout, '');
});

check('--verify with a one-character difference prints a unified diff and exits 1', () => {
  const file = path.join(tmp, 'verify-mismatch.txt');
  fs.writeFileSync(file, `${NOTES_BODY}!`);
  const { status, stdout } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', '--verify', file]);
  assert.equal(status, 1);
  assert.match(stdout, /^diff --git/);
  assert.match(stdout, /line two, no trailing newline on purpose/);
});

check('--verify against a missing file is refused, not a false mismatch', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', '--verify', path.join(tmp, 'does-not-exist.txt')]);
  assert.equal(status, 2);
  assert.match(stderr, /could not read/);
});

check('--verify with more than one field is refused', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', 'title', '--verify', path.join(tmp, 'verify-match.txt')]);
  assert.equal(status, 2);
  assert.match(stderr, /--verify needs exactly one field/);
});

check('--verify combined with --all is refused', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full', '--all', '--verify', path.join(tmp, 'verify-match.txt')]);
  assert.equal(status, 2);
  assert.match(stderr, /--verify needs exactly one field/);
});

check('--verify combined with --len is refused', () => {
  const { status, stderr } = run(['-w', 'field-ws', '-b', 'fl-full', 'notes', '--len', '--verify', path.join(tmp, 'verify-match.txt')]);
  assert.equal(status, 2);
  assert.match(stderr, /mutually exclusive/);
});

check('this command spawns bd show and nothing else', () => {
  fs.rmSync(CALLS, { force: true });
  run(['-w', 'field-ws', '-b', 'fl-full', '--all']);
  assert.deepEqual(verbsCalled(), ['show']);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
