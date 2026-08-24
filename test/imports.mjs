#!/usr/bin/env node
//
// b7e-import — before adding an import: is it exported, already here, colliding, or a
// cycle; and the other half, what dies if a symbol leaves (bc-ka5y.30).
//
//   npm test
//   node test/imports.mjs
//
// lib/imports.js does the work, over lib/noundef.js's own parser and scope resolution;
// this drives it directly against fabricated trees, the split test/triage.mjs and
// test/gate.mjs already use for their own siblings, plus a handful of calls through the
// real bin/b7e-import binary for what only the CLI does: argv parsing, --from, --json,
// --removing, and the exit code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-import');

const importsLib = await import(path.join(ROOT, 'lib', 'imports.js'));
const {
  exportsOf,
  importsOf,
  insertionLine,
  alreadyImported,
  localCollision,
  findExporters,
  resolveImport,
  cycleIfImported,
  deadOnRemoval,
} = importsLib;

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-imports-test-'));

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
 * 1. exportsOf / importsOf — reading what a file actually declares
 * ===================================================================== */

console.log('\nexportsOf and importsOf read every export/import shape acorn parses\n');

check('a named const, function and class export', () => {
  const exps = exportsOf('export const A = 1;\nexport function B() {}\nexport class C {}\n');
  assert.deepEqual(
    exps.map((e) => e.name),
    ['A', 'B', 'C'],
  );
  assert.ok(exps.every((e) => e.kind === 'named' && e.from === null));
});

check('a local export list, with an alias', () => {
  const exps = exportsOf('const X = 1, Y = 2;\nexport { X, Y as Z };\n');
  assert.deepEqual(
    exps.map((e) => [e.name, e.local]),
    [
      ['X', 'X'],
      ['Z', 'Y'],
    ],
  );
});

check('a re-export from another module', () => {
  const exps = exportsOf("export { P } from './other.js';\n");
  assert.equal(exps[0].kind, 'reexport-named');
  assert.equal(exps[0].from, './other.js');
});

check('export * and export * as NS', () => {
  const exps = exportsOf("export * from './wild.js';\nexport * as NS from './ns.js';\n");
  assert.equal(exps[0].kind, 'reexport-all');
  assert.equal(exps[0].name, '*');
  assert.equal(exps[1].kind, 'reexport-namespace');
  assert.equal(exps[1].name, 'NS');
});

check('export default names the identifier when there is one', () => {
  assert.equal(exportsOf('export default function foo() {}\n')[0].name, 'foo');
  assert.equal(exportsOf('export default 42;\n')[0].name, 'default');
});

check('a destructured export names every bound identifier', () => {
  const exps = exportsOf('export const { a, b: renamed, ...rest } = obj;\n');
  assert.deepEqual(
    exps.map((e) => e.name).sort(),
    ['a', 'rest', 'renamed'].sort(),
  );
});

check('importsOf reads named, default and namespace specifiers', () => {
  const imps = importsOf("import fs from 'node:fs';\nimport * as ns from './ns.js';\nimport { a, b as c } from './mod.js';\n");
  assert.equal(imps.length, 3);
  assert.deepEqual(imps[0].specifiers, [{ imported: 'default', local: 'fs', kind: 'default' }]);
  assert.deepEqual(imps[1].specifiers, [{ imported: '*', local: 'ns', kind: 'namespace' }]);
  assert.deepEqual(imps[2].specifiers, [
    { imported: 'a', local: 'a', kind: 'named' },
    { imported: 'b', local: 'c', kind: 'named' },
  ]);
});

check('a syntax error is reported as no exports/imports, not a throw', () => {
  assert.deepEqual(exportsOf('export const ='), []);
  assert.deepEqual(importsOf('import {'), []);
});

/* ===================================================================== *
 * 2. insertionLine / alreadyImported / localCollision
 * ===================================================================== */

console.log('\ninsertionLine, alreadyImported and localCollision answer against one file\n');

check('insertionLine is one past the last import, not alphabetised', () => {
  const src = "import fs from 'node:fs';\nimport { z } from './z.js';\nimport { a } from './a.js';\n\nconst x = 1;\n";
  assert.equal(insertionLine(src), 4);
});

check('insertionLine is 1 when the file imports nothing', () => {
  assert.equal(insertionLine('const x = 1;\n'), 1);
});

check('alreadyImported matches by local alias, not just the exported name', () => {
  const src = "import { landedNewsEvents as news } from './news.js';\n";
  assert.equal(alreadyImported(src, 'news').source, './news.js');
  assert.equal(alreadyImported(src, 'landedNewsEvents').local, 'news');
  assert.equal(alreadyImported(src, 'somethingElse'), null);
});

check('localCollision finds a local const/function/class, never an import', () => {
  assert.equal(localCollision('const mutedNews = 1;\n', 'mutedNews').kind, 'local');
  assert.equal(localCollision('function mutedNews() {}\n', 'mutedNews').kind, 'function');
  assert.equal(localCollision("import { mutedNews } from './x.js';\n", 'mutedNews'), null);
  assert.equal(localCollision('const other = 1;\n', 'mutedNews'), null);
});

check('resolveImport resolves a relative specifier, and refuses a bare one', () => {
  const dir = tree('resolve', { 'lib/a.js': '', 'lib/b.js': '' });
  assert.equal(resolveImport(dir, 'lib/a.js', './b.js'), 'lib/b.js');
  assert.equal(resolveImport(dir, 'lib/a.js', './missing.js'), null);
  assert.equal(resolveImport(dir, 'lib/a.js', 'node:fs'), null);
});

/* ===================================================================== *
 * 3. findExporters — the collision search across a tree
 * ===================================================================== */

console.log('\nfindExporters names every module exporting a name, across lib/bin/scripts\n');

const severities = tree('severities', {
  'lib/findings.js': "export const SEVERITIES = ['finding', 'material'];\n",
  'lib/incident.js': 'export const SEVERITIES = [1, 2];\n',
  'lib/reviewadvocate.js': "export const SEVERITIES = ['blocking', 'suggestion'];\n",
  'lib/mergebead.js': "import { SEVERITIES } from './reviewadvocate.js';\nexport const MERGE_LABEL = 'x';\n",
});

check('bc-36xx.18: SEVERITIES resolves to all three real exporters, named', () => {
  const found = findExporters(severities, 'SEVERITIES');
  assert.deepEqual(
    found.map((f) => f.file).sort(),
    ['lib/findings.js', 'lib/incident.js', 'lib/reviewadvocate.js'],
  );
});

check('a name nothing exports comes back empty, not a throw', () => {
  assert.deepEqual(findExporters(severities, 'NoSuchThing'), []);
});

/* ===================================================================== *
 * 4. cycleIfImported
 * ===================================================================== */

console.log('\ncycleIfImported proves a real cycle, the way test/noundef.mjs proves its own line\n');

const cyclic = tree('cyclic', {
  'lib/a.js': "import { bThing } from './b.js';\nexport const aThing = 1;\nexport function useB() { return bThing; }\n",
  'lib/b.js': 'export const bThing = 2;\n',
});

check('importing aThing into b.js would close a.js <-> b.js', () => {
  const chain = cycleIfImported(cyclic, 'lib/b.js', 'lib/a.js');
  assert.ok(chain, 'expected a cycle to be reported');
  assert.equal(chain[0], 'lib/b.js');
  assert.equal(chain.at(-1), 'lib/b.js');
});

check('importing bThing into a.js (already the case) is not reported as a new cycle target', () => {
  // a.js already imports b.js directly; asking whether importing b.js's own export
  // into a.js would cycle is really asking whether b.js imports a.js — it does not.
  assert.equal(cycleIfImported(cyclic, 'lib/a.js', 'lib/b.js'), null);
});

/* ===================================================================== *
 * 5. deadOnRemoval — the other half
 * ===================================================================== */

console.log('\ndeadOnRemoval: what an identifier-based read catches that grep -rln did not\n');

const commonrepo = tree('commonrepo', {
  'lib/commonrepo.js': [
    "import fs from 'node:fs';",
    "import path from 'node:path';",
    '',
    'const STALE_LOCK_MS = 5000;',
    '',
    'function heldByOtherProcess(pid) {',
    '  return pid > 0;',
    '}',
    '',
    'function clearAbandonedLocks(dir) {',
    "  const files = fs.readdirSync(path.join(dir, '.locks'));",
    '  return files.length > STALE_LOCK_MS;',
    '}',
    '',
    'export function snapshot() {',
    '  return heldByOtherProcess(1);',
    '}',
    '',
  ].join('\n'),
  'test/gitref.mjs': ["const held = 'held';", 'export { held };', ''].join('\n'),
  'test/lockfiles.mjs': ["const heldBy = { a: 1 };", 'export { heldBy };', ''].join('\n'),
});

check('bc-xl7n.93: fs and path are dead once clearAbandonedLocks/STALE_LOCK_MS leave', () => {
  const result = deadOnRemoval(commonrepo, 'lib/commonrepo.js', ['clearAbandonedLocks', 'STALE_LOCK_MS']);
  assert.deepEqual(
    result.deadImports.map((d) => d.name).sort(),
    ['fs', 'path'],
  );
  assert.deepEqual(result.deadLocals, []);
  assert.deepEqual(result.missing, []);
});

check("bc-xl7n.93's twelve heldBy/held false positives: identifier match, not substring", () => {
  // Nothing outside lib/commonrepo.js references the identifier clearAbandonedLocks or
  // STALE_LOCK_MS — 'held' and 'heldBy' in test/ are a different word and a different
  // identifier respectively, and grep -rln "held" matched both. This must not.
  const result = deadOnRemoval(commonrepo, 'lib/commonrepo.js', ['clearAbandonedLocks', 'STALE_LOCK_MS']);
  assert.deepEqual(result.stillReferencedFrom, []);
});

check('a still-live import (used by kept code too) is not reported dead', () => {
  const dir = tree('stilllive', {
    'lib/x.js': [
      "import path from 'node:path';",
      'function goingAway() { return path.sep; }',
      'export function staying() { return path.delimiter; }',
      '',
    ].join('\n'),
  });
  const result = deadOnRemoval(dir, 'lib/x.js', ['goingAway']);
  assert.deepEqual(result.deadImports, []);
});

check('an actual cross-file reference to the removed name is reported', () => {
  const dir = tree('crossref', {
    'lib/x.js': 'export function goingAway() { return 1; }\n',
    'test/uses.mjs': "import { goingAway } from '../lib/x.js';\nconsole.log(goingAway());\n",
  });
  const result = deadOnRemoval(dir, 'lib/x.js', ['goingAway']);
  assert.deepEqual(result.stillReferencedFrom, [{ file: 'test/uses.mjs', name: 'goingAway' }]);
});

check('a name not actually declared at the top level is reported missing, not silently ignored', () => {
  const result = deadOnRemoval(commonrepo, 'lib/commonrepo.js', ['neverDeclared']);
  assert.deepEqual(result.missing, ['neverDeclared']);
});

check('a binding already unused before the removal is not blamed on it', () => {
  const dir = tree('predead', {
    'lib/x.js': ["import path from 'node:path';", 'export function goingAway() { return 1; }', ''].join('\n'),
  });
  // `path` was never used at all — that is a pre-existing dead import, not one this
  // removal causes, so it must not show up in deadImports.
  const result = deadOnRemoval(dir, 'lib/x.js', ['goingAway']);
  assert.deepEqual(result.deadImports, []);
});

/* ===================================================================== *
 * 6. The CLI — argv, --from, --removing, --json, exit codes
 * ===================================================================== */

console.log('\nbin/b7e-import: argv parsing, --from, --removing, --json and exit codes\n');

const cliTree = tree('cli', {
  'lib/news.js': 'export const landedNewsEvents = () => [];\n',
  'lib/other.js': 'export const landedNewsEvents = () => [];\n',
  'lib/advocate.js': "import { landedNewsEvents } from './news.js';\nconsole.log(landedNewsEvents);\n",
  'lib/fresh.js': 'export function keepMe() { return 1; }\n',
});

check('a clean add — exported once, not yet imported — exits 0', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'keepMe', '--into', 'lib/advocate.js'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /exported from lib\/fresh\.js/);
  assert.match(run.stdout, /not yet imported/);
});

check('already imported from the right module — exits 0, no collision reported', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'landedNewsEvents', '--into', 'lib/advocate.js', '--from', 'news.js'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /already imported/);
});

check('ambiguous exporters with no --from — exits 1 and lists both', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'landedNewsEvents', '--into', 'lib/advocate.js'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /more than one place/);
  assert.match(run.stdout, /lib\/news\.js/);
  assert.match(run.stdout, /lib\/other\.js/);
});

check('--from disambiguates, and reports the OTHER one as a collision', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'landedNewsEvents', '--into', 'lib/advocate.js', '--from', 'other.js'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /lib\/other\.js/);
  assert.match(run.stdout, /collides with an existing import/);
});

check('a symbol nothing exports — exits 1, says so plainly', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'noSuchSymbol', '--into', 'lib/advocate.js'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /not exported anywhere/);
});

check('--json prints one parseable object', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, '--json', 'keepMe', '--into', 'lib/advocate.js'], { encoding: 'utf8' });
  const obj = JSON.parse(run.stdout.trim());
  assert.equal(obj.symbol, 'keepMe');
  assert.equal(obj.exportedFrom.file, 'lib/fresh.js');
});

const removeTree = tree('cli-remove', {
  'lib/commonrepo.js': [
    "import fs from 'node:fs';",
    'function clearAbandonedLocks() { return fs.existsSync(\".\"); }',
    'export function snapshot() { return 1; }',
    '',
  ].join('\n'),
  'test/uses.mjs': "import { clearAbandonedLocks } from '../lib/commonrepo.js';\nconsole.log(clearAbandonedLocks);\n",
});

check('--removing reports a dead import and a live external reference, exits 1', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', removeTree, '--removing', 'clearAbandonedLocks', '--into', 'lib/commonrepo.js'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /dead imports/);
  assert.match(run.stdout, /fs/);
  assert.match(run.stdout, /still referenced elsewhere/);
  assert.match(run.stdout, /test\/uses\.mjs/);
});

check('--into missing is refused with exit 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'keepMe'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

check('a --into file that does not exist is refused with exit 2', () => {
  const run = spawnSync(process.execPath, [BIN, '--dir', cliTree, 'keepMe', '--into', 'lib/ghost.js'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall b7e-import checks passed\n');
process.exit(failures ? 1 : 0);
