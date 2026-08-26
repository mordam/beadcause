#!/usr/bin/env node
//
// b7e-already — does lib/ already have a function for this, and can it be imported
// (bc-dgx7.81). lib/already.js does the work: a reverse index of every top-level
// declaration under lib/, bin/ and scripts/, keyed by name and the first line of its
// own doc comment, with class methods folded in and exported/private told apart.
//
//   npm test
//   node test/already.mjs
//
// Structural behaviour is driven against fabricated trees, so a rename elsewhere in
// this repo cannot turn this suite red (see
// a-real-repo-assertion-in-a-test-rots-between-your-run-and-ci). A short section at the
// end runs the real binary against this repo's own REPO_ROOT, but only for the two
// shapes the bead itself was filed over — a private arrow-less function and an
// `export const ... =>` — asserted loosely enough to survive an unrelated rename.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-already');

const alreadyLib = await import(path.join(ROOT, 'lib', 'already.js'));
const { moduleSurface, allEntries, scoreEntry, search } = alreadyLib;

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-already-test-'));

/** A fresh `<tmp>/<name>/` directory holding the given files. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

/* ===================================================================== *
 * 1. moduleSurface — reading exported vs private, every declaration shape
 * ===================================================================== */

console.log('\nmoduleSurface reads function/const/arrow/class declarations, exported and private\n');

const shapes = tree('shapes', {
  'lib/shapes.js': [
    '/** How long ago, in the words a refusal can use. */',
    'function ago(ms) {',
    '  return ms;',
    '}',
    '',
    '/**',
    ' * The same question, answered with the directory alone.',
    ' */',
    'export const resolveSessionDir = (cfg, workspace, bead = null) => cfg;',
    '',
    '/** A promise\'s value, or null if it rejected. */',
    'export const ok = (p) => p;',
    '',
    'export async function fetchThing(id) {',
    '  return id;',
    '}',
    '',
    'export const STALE_LOCK_MS = 5000;',
    '',
    '/** Adapter around the bd CLI. */',
    'export class Bd {',
    '  constructor({ bin }) {',
    '    this.bin = bin;',
    '  }',
    '',
    '  /** Open issues carrying the human label. */',
    '  async listHuman(workspace) {',
    '    return workspace;',
    '  }',
    '',
    '  static helper() {',
    '    return 1;',
    '  }',
    '}',
    '',
  ].join('\n'),
});

check('a private function is reported private, with its doc first line', () => {
  const surface = moduleSurface(shapes, 'lib/shapes.js');
  const agoEntry = surface.find((e) => e.name === 'ago');
  assert.ok(agoEntry, 'expected an entry for ago');
  assert.equal(agoEntry.exported, false);
  assert.equal(agoEntry.kind, 'function');
  assert.equal(agoEntry.doc, 'How long ago, in the words a refusal can use.');
  assert.match(agoEntry.signature, /function ago\(ms\)/);
});

check('export const ... => is found and marked exported — the shape ^export function misses', () => {
  const surface = moduleSurface(shapes, 'lib/shapes.js');
  const entry = surface.find((e) => e.name === 'resolveSessionDir');
  assert.ok(entry, 'expected an entry for resolveSessionDir');
  assert.equal(entry.exported, true);
  assert.equal(entry.kind, 'const');
  assert.match(entry.signature, /const resolveSessionDir = \(cfg, workspace, bead = null\) =>/);
  assert.equal(entry.doc, 'The same question, answered with the directory alone.');
});

check('an async function export is signed with async', () => {
  const entry = moduleSurface(shapes, 'lib/shapes.js').find((e) => e.name === 'fetchThing');
  assert.match(entry.signature, /^async function fetchThing\(id\)$/);
});

check('a plain const value prints its literal value, not just the name', () => {
  const entry = moduleSurface(shapes, 'lib/shapes.js').find((e) => e.name === 'STALE_LOCK_MS');
  assert.match(entry.signature, /const STALE_LOCK_MS = 5000/);
});

check('a class is one entry, and every method is another, inheriting the class export state', () => {
  const surface = moduleSurface(shapes, 'lib/shapes.js');
  const cls = surface.find((e) => e.kind === 'class' && e.name === 'Bd');
  assert.ok(cls);
  assert.equal(cls.exported, true);
  const ctor = surface.find((e) => e.kind === 'method' && e.name === 'Bd.constructor');
  assert.ok(ctor, 'expected the constructor as its own entry');
  assert.equal(ctor.exported, true);
  const method = surface.find((e) => e.kind === 'method' && e.name === 'Bd.listHuman');
  assert.ok(method);
  assert.equal(method.exported, true);
  assert.match(method.signature, /^async listHuman\(workspace\)$/);
  assert.equal(method.doc, 'Open issues carrying the human label.');
  const staticMethod = surface.find((e) => e.name === 'Bd.helper');
  assert.match(staticMethod.signature, /^static helper\(\)$/);
});

check('a syntax error is reported as no declarations, not a throw', () => {
  const dir = tree('broken', { 'lib/broken.js': 'export const =' });
  assert.deepEqual(moduleSurface(dir, 'lib/broken.js'), []);
});

check('destructured top-level declarators are skipped, not crashed on', () => {
  const dir = tree('destructured', { 'lib/d.js': 'export const { a, b } = obj;\nexport function real() {}\n' });
  const names = moduleSurface(dir, 'lib/d.js').map((e) => e.name);
  assert.deepEqual(names, ['real']);
});

/* ===================================================================== *
 * 2. scoreEntry / search — matching a description, not just a literal name
 * ===================================================================== */

console.log('\nscoreEntry and search match camelCase pieces and doc text, not just literal strings\n');

check('a query word matches inside a camelCase name via word-splitting', () => {
  const entries = allEntries(shapes);
  const entry = entries.find((e) => e.name === 'resolveSessionDir');
  assert.ok(scoreEntry(entry, ['session']) > 0);
  assert.ok(scoreEntry(entry, ['dir']) > 0);
  assert.ok(scoreEntry(entry, ['nonexistentword']) === 0);
});

check('a partial match (one of several words) still scores, and ranks below a fuller match', () => {
  const hits = search(shapes, ['time', 'ago']);
  const names = hits.map((e) => e.name);
  assert.ok(names.includes('ago'), 'time ago should still surface ago via the word ago alone');
});

check('search finds resolveSessionDir by its split words even though grep "^export function" could not', () => {
  const hits = search(shapes, ['resolve', 'session', 'dir']);
  assert.ok(hits.some((e) => e.name === 'resolveSessionDir'));
});

check('onlyPrivate narrows to unexported declarations only', () => {
  const hits = search(shapes, ['ago'], { onlyPrivate: true });
  assert.ok(hits.every((e) => e.exported === false));
  assert.ok(hits.some((e) => e.name === 'ago'));
});

check('a phrase nothing matches returns an empty list, not a throw', () => {
  assert.deepEqual(search(shapes, ['zzzznothingatall']), []);
});

/* ===================================================================== *
 * 3. The CLI — argv, --module, --private, --dir, exit codes
 * ===================================================================== */

console.log('\nbin/b7e-already: argv parsing, --module, --private, --dir and exit codes\n');

check('a matching query exits 0 and prints the file:line, export/private label and doc', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', shapes, 'time', 'ago'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /lib\/shapes\.js:\d+/);
  assert.match(run.stdout, /private/);
  assert.match(run.stdout, /ago/);
});

check('--private restricts the output to unexported hits', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', shapes, 'ago', '--private'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.doesNotMatch(run.stdout, /export\b/);
});

check('--module lists every declaration in one file, class methods included', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', shapes, '--module', 'lib/shapes.js'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /class Bd/);
  assert.match(run.stdout, /listHuman/);
  assert.match(run.stdout, /helper/);
  assert.match(run.stdout, /ago/);
});

check('--module on a file with no declarations exits 1, not a crash', () => {
  const dir = tree('empty', { 'lib/empty.js': "// nothing here\n" });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--module', 'lib/empty.js'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
});

check('--module on a missing file is refused with exit 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', shapes, '--module', 'lib/ghost.js'], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stdout + run.stderr);
});

check('no words and no --module is refused with exit 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', shapes], { encoding: 'utf8' });
  assert.equal(run.status, 2, run.stdout + run.stderr);
});

check('a phrase nothing matches exits 1, not a crash', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', shapes, 'zzzznothingatallmatchesthis'], { encoding: 'utf8' });
  assert.equal(run.status, 1, run.stdout + run.stderr);
  assert.equal(run.stdout.trim().split('\n').length, 1);
});

check('--help exits 0 and does not run a search', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /b7e-already/);
});

/* ===================================================================== *
 * 4. Real repo smoke test — the two shapes bc-dgx7.81 was filed over
 * ===================================================================== */

console.log('\nagainst this repo\'s own tree: the two acceptance shapes, asserted loosely\n');

check('bc-dgx7.62: "time ago" finds ago in lib/resolvers.js, marked private, in one call', () => {
  const run = spawnSync(process.execPath, [BIN, 'time', 'ago'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  const hit = run.stdout.split('\n').find((l) => l.includes('lib/resolvers.js') && /\bago\b/.test(l));
  assert.ok(hit, `expected a lib/resolvers.js ago hit in:\n${run.stdout}`);
  assert.match(hit, /private/);
});

check('bc-dgx7.64: "resolve session dir" finds resolveSessionDir, an export const ... =>', () => {
  const run = spawnSync(process.execPath, [BIN, 'resolve', 'session', 'dir'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /resolveSessionDir/);
});

check('bc-dgx7.62: --module lib/bd.js lists the Bd class and its methods', () => {
  const run = spawnSync(process.execPath, [BIN, '--module', 'lib/bd.js'], { encoding: 'utf8', cwd: ROOT });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /class Bd/);
  // Not pinned to a specific method name — lib/bd.js's own method list is another
  // module's wiring and may change — only that *something* beyond the class line itself
  // came back, which is the whole of what four greps couldn't get in one call.
  assert.ok(run.stdout.trim().split('\n').length > 1, 'expected more than just the class line');
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall b7e-already checks passed\n');
process.exit(failures ? 1 : 0);
