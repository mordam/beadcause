#!/usr/bin/env node
//
// b7e-census — which beads carry a label or an edge, over the real graph, without
// writing a program for it (bc-bmry.12). Three sessions (bc-bmry.2, bc-bmry.5,
// bc-xl7n.98) each hand-rolled the same question a different way; this is that command.
//
//   npm test
//   node test/census.mjs
//
// Two kinds of proof, for the reason test/b7eowes.mjs gives for the same split: the
// matching in lib/census.js is a pure function over the `{ beads, edges }` shape
// lib/ancestry.js's indexFrom already builds, so the predicate logic (exact-label AND,
// --not-label, status filtering, the blocked-by-label join, the label-family count) is
// provable directly against small fabricated indexes — no `bd`, no subprocess. Then
// bin/b7e-census is driven as a real subprocess against a stub `bd`, for the reason
// test/b7ews.mjs gives for bin/b7e-ws: the flags reaching `bd` (and the argv parsing in
// front of them) are the thing under test there, and a stub that swallowed the argv
// would prove nothing about the wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { indexFrom } from '../lib/ancestry.js';
import { census, valuesOf, inFamily } from '../lib/census.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-census');

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

console.log('\nb7e-census\n');

/* ============================================================== lib/census.js */

const bead = (id, { status = 'open', labels = [], title = '' } = {}) => [id, { id, status, labels, title }];

const indexOf = (beadPairs, edgeRows = []) => {
  const beads = new Map(beadPairs);
  const edges = new Map();
  for (const [i, e] of edgeRows.entries()) edges.set(`e${i}`, e);
  return { beads, edges };
};

check('census: --label matches exactly, never by prefix', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate'] }),
    bead('b', { labels: ['gate:G0'] }),
    bead('c', { labels: ['gate', 'gate:G1'] }),
  ]);
  const rows = census(idx, { labels: ['gate'] });
  assert.deepEqual(rows.map((r) => r.id), ['a', 'c']);
});

check('census: multiple --label are ANDed, not ORed', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate', 'ran:opus'] }),
    bead('b', { labels: ['gate'] }),
    bead('c', { labels: ['ran:opus'] }),
  ]);
  assert.deepEqual(census(idx, { labels: ['gate', 'ran:opus'] }).map((r) => r.id), ['a']);
});

check('census: --not-label excludes a bead carrying it', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate'] }),
    bead('b', { labels: ['gate', 'ran:opus'] }),
  ]);
  assert.deepEqual(census(idx, { labels: ['gate'], notLabels: ['ran:opus'] }).map((r) => r.id), ['a']);
});

check('census: with no --status, closed beads are matched too — bd list --all, not bd list', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate'], status: 'open' }),
    bead('b', { labels: ['gate'], status: 'closed' }),
  ]);
  assert.deepEqual(census(idx, { labels: ['gate'] }).map((r) => r.id), ['a', 'b']);
});

check('census: --status narrows to exactly the statuses given', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate'], status: 'open' }),
    bead('b', { labels: ['gate'], status: 'closed' }),
    bead('c', { labels: ['gate'], status: 'in_progress' }),
  ]);
  assert.deepEqual(
    census(idx, { labels: ['gate'], statuses: ['open', 'in_progress'] }).map((r) => r.id),
    ['a', 'c']
  );
});

check('census: rows come back sorted by id', () => {
  const idx = indexOf([bead('z', { labels: ['gate'] }), bead('a', { labels: ['gate'] })]);
  assert.deepEqual(census(idx, { labels: ['gate'] }).map((r) => r.id), ['a', 'z']);
});

check('census: --blocked-by-label finds a bead blocked by a still-open labelled bead', () => {
  const idx = indexOf(
    [bead('work', {}), bead('gate1', { labels: ['pr-delivery'], status: 'open' })],
    [{ type: 'blocks', from: 'work', to: 'gate1' }]
  );
  assert.deepEqual(census(idx, { blockedByLabel: 'pr-delivery' }).map((r) => r.id), ['work']);
});

check('census: --blocked-by-label ignores a CLOSED blocker — finished work is not a live gate', () => {
  const idx = indexOf(
    [bead('work', {}), bead('gate1', { labels: ['pr-delivery'], status: 'closed' })],
    [{ type: 'blocks', from: 'work', to: 'gate1' }]
  );
  assert.deepEqual(census(idx, { blockedByLabel: 'pr-delivery' }), []);
});

check('census: --blocked-by-label ignores an edge that is not a blocks edge', () => {
  const idx = indexOf(
    [bead('work', {}), bead('other', { labels: ['pr-delivery'], status: 'open' })],
    [{ type: 'related', from: 'work', to: 'other' }]
  );
  assert.deepEqual(census(idx, { blockedByLabel: 'pr-delivery' }), []);
});

check('census: --blocked-by-label reads direction as bd show does — from is blocked, to is the blocker', () => {
  const idx = indexOf(
    [bead('work', {}), bead('gate1', { labels: ['pr-delivery'], status: 'open' })],
    // the label carrier is the FROM end here, so it must not count as a blocker of itself
    [{ type: 'blocks', from: 'gate1', to: 'work' }]
  );
  assert.deepEqual(census(idx, { blockedByLabel: 'pr-delivery' }), []);
});

check('census: --blocked-by-label composes with --status, reproducing the in_progress join', () => {
  const idx = indexOf(
    [
      bead('a', { status: 'in_progress' }),
      bead('b', { status: 'open' }),
      bead('card', { labels: ['pr-delivery'], status: 'open' }),
    ],
    [
      { type: 'blocks', from: 'a', to: 'card' },
      { type: 'blocks', from: 'b', to: 'card' },
    ]
  );
  assert.deepEqual(
    census(idx, { blockedByLabel: 'pr-delivery', statuses: ['in_progress'] }).map((r) => r.id),
    ['a']
  );
});

check('inFamily: bare label and every "<prefix>:*" belong to the family, nothing else does', () => {
  assert.ok(inFamily('gate', 'gate:'));
  assert.ok(inFamily('gate:G0', 'gate:'));
  assert.ok(!inFamily('gate:G0', 'other:')); // a different family entirely
  assert.ok(!inFamily('gated', 'gate:')); // a longer word, not a member of the family
});

check('valuesOf: every value in the family, with its count', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate'] }),
    bead('b', { labels: ['gate:G0'] }),
    bead('c', { labels: ['gate:G0'] }),
    bead('d', { labels: ['gate:G1'] }),
    bead('e', { labels: ['unrelated'] }),
  ]);
  const counts = valuesOf(idx, 'gate:');
  assert.deepEqual(
    Object.fromEntries(counts),
    { gate: 1, 'gate:G0': 2, 'gate:G1': 1 }
  );
});

check('valuesOf: respects a status filter the same way census does', () => {
  const idx = indexOf([
    bead('a', { labels: ['gate'], status: 'open' }),
    bead('b', { labels: ['gate'], status: 'closed' }),
  ]);
  assert.deepEqual(Object.fromEntries(valuesOf(idx, 'gate:', { statuses: ['open'] })), { gate: 1 });
  assert.deepEqual(Object.fromEntries(valuesOf(idx, 'gate:')), { gate: 2 });
});

/* ==================================================================== bin/b7e-census */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-census-'));
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
if (args[0] === 'export') {
  const worldFile = path.join(dir, 'world.jsonl');
  if (!fs.existsSync(worldFile)) { process.stderr.write('no such workspace\\n'); process.exit(1); }
  // Not process.exit(0) after the write: this stub is itself spawned over a pipe (by
  // execFile in lib/bd.js), and a big fixture would otherwise cut at the 64KB pipe
  // buffer here before it ever reached the CLI under test — the same bug bc-dgx7.45
  // is about, one level down.
  process.stdout.write(fs.readFileSync(worldFile, 'utf8'));
  process.exitCode = 0;
  return;
}
process.stderr.write('stub bd: unexpected verb "' + args[0] + '"\\n');
process.exit(1);
`,
  { mode: 0o755 }
);

const dirFor = (name) => {
  const dir = path.join(tmp, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const DELUVIA = { name: 'deluvia', dir: dirFor('deluvia') };
const BROKEN = { name: 'broken', dir: dirFor('broken') };
const BULK = { name: 'bulk', dir: dirFor('bulk') };

const row = (id, { status = 'open', labels = [], title = 'a title', deps = [] } = {}) => ({
  id,
  title,
  status,
  labels,
  priority: 2,
  issue_type: 'task',
  dependencies: deps.map(([to, type]) => ({ issue_id: id, depends_on_id: to, type })),
});

const world = [
  row('dv-1', { labels: ['gate'], status: 'open' }),
  row('dv-2', { labels: ['gate'], status: 'closed' }),
  row('dv-3', { labels: ['gate:G0'], status: 'open' }),
  row('dv-4', { labels: [], status: 'in_progress', deps: [['dv-5', 'blocks']] }),
  row('dv-5', { labels: ['pr-delivery'], status: 'open' }),
];
fs.writeFileSync(DELUVIA.dir + '/world.jsonl', world.map((r) => JSON.stringify(r)).join('\n') + '\n');
// BROKEN has no world.jsonl at all, so the stub's `export` fails — a real `bd export`
// timing out or losing a Dolt lock looks the same from here: a nonzero exit.

// Enough matching rows that `--json`'s report cannot fit in a 64KB pipe buffer — see the
// check below.
const bulkWorld = Array.from({ length: 700 }, (_, i) =>
  row(`bk-${i}`, { labels: ['gate'], title: `bulk fixture bead number ${i}, padded so each row is not tiny` })
);
fs.writeFileSync(BULK.dir + '/world.jsonl', bulkWorld.map((r) => JSON.stringify(r)).join('\n') + '\n');

fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [DELUVIA, BROKEN, BULK] }, null, 2)
);

const UNRELATED_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-census-elsewhere-'));

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: UNRELATED_CWD,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

check('--help prints usage and exits 0 without ever resolving a workspace', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-census/);
});

check('-w is required', () => {
  const { status, stderr } = run(['--label', 'gate']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('an unconfigured workspace is refused, naming the ones that exist', () => {
  const { status, stderr } = run(['-w', 'nope', '--label', 'gate']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no workspace named "nope"/);
  assert.match(stderr, /deluvia/);
});

check('--label --count reproduces bc-bmry.2\'s pipeline: exact match, every status, one number', () => {
  const { status, stdout } = run(['-w', 'deluvia', '--label', 'gate', '--count']);
  assert.equal(status, 0);
  assert.equal(stdout.trim(), '2'); // dv-1 (open) and dv-2 (closed) — gate:G0 does not count
});

check('--status narrows further, same as census() does', () => {
  const { stdout } = run(['-w', 'deluvia', '--label', 'gate', '--status', 'open', '--count']);
  assert.equal(stdout.trim(), '1');
});

check('--blocked-by-label --status reproduces bc-xl7n.98\'s join', () => {
  const { status, stdout } = run(['-w', 'deluvia', '--blocked-by-label', 'pr-delivery', '--status', 'in_progress']);
  assert.equal(status, 0);
  assert.match(stdout, /^dv-4\t/m);
  assert.match(stdout, /1 bead matched/);
});

check('--values prints every value in the family with its count', () => {
  const { stdout } = run(['-w', 'deluvia', '--values', 'gate:']);
  const lines = stdout.trim().split('\n');
  assert.deepEqual(lines.sort(), ['gate\t2', 'gate:G0\t1']);
});

check('--json emits one full row per line, parseable', () => {
  const { stdout } = run(['-w', 'deluvia', '--label', 'gate', '--status', 'open', '--json']);
  const rows = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'dv-1');
});

check('default listing prints id/status/labels/title and a trailing count', () => {
  const { stdout } = run(['-w', 'deluvia', '--label', 'gate']);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 3); // two matches plus the trailing count line
  assert.match(lines[0], /^dv-1\topen\tgate\t/);
  assert.equal(lines[2], '2 beads matched');
});

check('--count refuses to combine with --json or --values', () => {
  const a = run(['-w', 'deluvia', '--label', 'gate', '--count', '--json']);
  assert.notEqual(a.status, 0);
  assert.match(a.stderr, /--count cannot be combined/);
  const b = run(['-w', 'deluvia', '--count', '--values', 'gate:']);
  assert.notEqual(b.status, 0);
});

check('--json through a pipe is whole and parseable, however big the report (bc-dgx7.45)', () => {
  // `console.log(...)` then `process.exit(0)` used to drop whatever of the write was
  // still pending: stdout to a **pipe** is async in Node, so this came back cut at
  // exactly 65536 bytes with status 0 — unparseable JSON, no error, no nonzero exit,
  // nothing to notice. spawnSync's stdio here is a pipe, which is the case that broke.
  const { status, stdout } = run(['-w', 'bulk', '--label', 'gate', '--json']);
  assert.equal(status, 0);
  assert.ok(stdout.length > 65536, `payload too small to test the pipe buffer: ${stdout.length} bytes`);
  const rows = stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(rows.length, 700, `expected all 700 rows, got ${rows.length}`);
});

check('a failed `bd export` exits 2 rather than printing an empty answer', () => {
  const { status, stderr } = run(['-w', 'broken', '--label', 'gate']);
  assert.equal(status, 2);
  assert.match(stderr, /b7e-census:/);
});

console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
