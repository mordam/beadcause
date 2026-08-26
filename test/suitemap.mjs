#!/usr/bin/env node
/**
 * The inside of an existing suite — its fixtures, what it imports from the file under
 * test, and where a new check goes (bc-dgx7.85).
 *
 *     npm test
 *     node test/suitemap.mjs
 *
 * `lib/suitemap.js` does the parse, over acorn (the same reason `lib/already.js` and
 * `lib/imports.js` parse rather than grep); this drives it against fabricated trees —
 * the same shape `test/affected.mjs` uses — plus, at the end, the two concrete cases in
 * the bead's own acceptance criteria: `b7e-suitemap test/homing.mjs` and `b7e-suitemap
 * --for public/report.js`, against this repo's own suites, because those are what the
 * bead was actually filed over and a fabricated tree cannot stand in for them.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const BIN = path.join(ROOT, 'bin', 'b7e-suitemap');

const { mapSuite, suiteFor } = await import(LIB('suitemap.js'));

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-suitemap-test-'));

/** A fresh `<tmp>/<name>/` tree holding the given files at the given repo-relative
 * paths — the same fixture shape `test/affected.mjs` uses. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
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
    console.log(`      ${String(err.message).split('\n')[0]}`);
  }
};

/* ------------------------------------------------------------------------- imports */

console.log('\nimports from the module under test\n');

check('a static import is named and resolved, and a bare node: builtin is not', () => {
  const dir = tree('imp-static', {
    'lib/a.js': 'export const A = 1;\n',
    'test/x.mjs': "import assert from 'node:assert/strict';\nimport { A } from '../lib/a.js';\n",
  });
  const m = mapSuite(dir, 'test/x.mjs');
  const a = m.imports.find((i) => i.resolved === 'lib/a.js');
  assert.ok(a, 'lib/a.js not found in imports');
  assert.deepEqual(a.names, ['A']);
  const builtin = m.imports.find((i) => i.names.includes('assert'));
  assert.equal(builtin.resolved, null);
});

check('a multi-line destructured static import still resolves and names every binding', () => {
  const dir = tree('imp-multiline', {
    'lib/a.js': 'export const A = 1;\nexport const Q = 2;\n',
    'test/x.mjs': "import {\n  A,\n  Q,\n} from '../lib/a.js';\n",
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.deepEqual(m.imports[0].names, ['A', 'Q']);
  assert.equal(m.imports[0].resolved, 'lib/a.js');
});

check('the LIB(...) dynamic-import convention resolves and names every destructured binding', () => {
  const dir = tree('imp-dynamic', {
    'lib/a.js': 'export const A = 1;\nexport const B = 2;\n',
    'test/x.mjs': [
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const HERE = path.dirname(fileURLToPath(import.meta.url));",
      "const LIB = (f) => path.join(HERE, '..', 'lib', f);",
      "const { A, B } = await import(LIB('a.js'));",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  const a = m.imports.find((i) => i.kind === 'dynamic');
  assert.ok(a, 'no dynamic import found');
  assert.deepEqual(a.names, ['A', 'B']);
  assert.equal(a.resolved, 'lib/a.js');
});

check('a vm-loaded source read is reported as importing the module it loads', () => {
  const dir = tree('imp-vmsource', {
    'public/x.js': 'window.x = 1;\n',
    'test/x.mjs': [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const HERE = path.dirname(fileURLToPath(import.meta.url));",
      "const ROOT = path.join(HERE, '..');",
      "const PUBLIC = (f) => path.join(ROOT, 'public', f);",
      "const SOURCE = fs.readFileSync(PUBLIC('x.js'), 'utf8');",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  const src = m.imports.find((i) => i.kind === 'vm-source');
  assert.ok(src, 'no vm-source import found');
  assert.equal(src.resolved, 'public/x.js');
  assert.deepEqual(src.names, ['SOURCE']);
});

/* ------------------------------------------------------------------------- helpers */

console.log('\nfile-local helpers\n');

check('a top-level function declaration is a helper, with its return keys expanded', () => {
  const dir = tree('helpers-fn', {
    'test/x.mjs': ['function load(opts) {', '  return { window: 1, fire: 2 };', '}', ''].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  const load = m.helpers.find((h) => h.name === 'load');
  assert.ok(load, 'load not found');
  assert.deepEqual(load.returns, ['window', 'fire']);
  assert.match(load.signature, /^function load\(opts\)$/);
});

check('an arrow-const helper is found, and a plain-value const is not', () => {
  const dir = tree('helpers-arrow', {
    'test/x.mjs': ["const row = (id, extra = {}) => ({ id, ...extra });", "const TOKEN = 'sekrit';", ''].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.ok(m.helpers.find((h) => h.name === 'row'));
  assert.ok(!m.helpers.find((h) => h.name === 'TOKEN'));
});

check('the check/ok/bad harness leaves are never listed as helpers', () => {
  const dir = tree('helpers-noharness', {
    'test/x.mjs': [
      'let failures = 0;',
      'const check = async (name, fn) => { try { await fn(); } catch {} };',
      "const row = (id) => id;",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.ok(!m.helpers.find((h) => h.name === 'check'));
  assert.ok(m.helpers.find((h) => h.name === 'row'));
});

check('a LIB/PUBLIC-shaped path helper is not listed as a fixture helper', () => {
  const dir = tree('helpers-pathhelper', {
    'lib/a.js': 'export const A = 1;\n',
    'test/x.mjs': [
      "import path from 'node:path';",
      "const LIB = (f) => path.join('lib', f);",
      "const row = (id) => id;",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.ok(!m.helpers.find((h) => h.name === 'LIB'));
  assert.ok(m.helpers.find((h) => h.name === 'row'));
});

/* -------------------------------------------------------------------------- checks */

console.log('\nnamed checks, in order, under their section\n');

check('check() calls are found in source order, each under its nearest section divider', () => {
  const dir = tree('checks-basic', {
    'test/x.mjs': [
      'let failures = 0;',
      'const check = async (name, fn) => { try { await fn(); } catch { failures += 1; } };',
      '',
      '/* ------------------------------------------------------------------ section a */',
      '',
      "await check('first check', () => {});",
      "await check('second check', () => {});",
      '',
      '/* ------------------------------------------------------------------ section b */',
      '',
      "await check('third check', () => {});",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.deepEqual(
    m.checks.map((c) => [c.section, c.title]),
    [
      ['section a', 'first check'],
      ['section a', 'second check'],
      ['section b', 'third check'],
    ],
  );
  assert.ok(m.checks[0].line < m.checks[1].line && m.checks[1].line < m.checks[2].line);
});

check('a check before the first section divider has a null section', () => {
  const dir = tree('checks-nosection', {
    'test/x.mjs': [
      'const check = async (name, fn) => { await fn(); };',
      "await check('loose check', () => {});",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.equal(m.checks[0].section, null);
});

check('a check title built from a template literal with no interpolation is still a title', () => {
  const dir = tree('checks-template', {
    'test/x.mjs': ['const check = async (name, fn) => { await fn(); };', "await check(`a templated title`, () => {});", ''].join(
      '\n',
    ),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.equal(m.checks[0].title, 'a templated title');
});

check('a per-file ok/bad convenience wrapper (is(name, got, want)) is not chased for titles', () => {
  const dir = tree('checks-is', {
    'test/x.mjs': [
      'let failures = 0;',
      "const ok = (name) => {};",
      "const bad = (name) => { failures += 1; };",
      'const is = (name, got, want) => (got === want ? ok(name) : bad(name));',
      "is('an indirect check', 1, 1);",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.equal(m.checks.length, 0, 'is(...) should not be chased into ok/bad');
});

check('a direct ok(...)/bad(...) ternary at top level is still found, once per branch', () => {
  const dir = tree('checks-ternary', {
    'test/x.mjs': [
      'let failures = 0;',
      "const ok = (name) => {};",
      "const bad = (name) => { failures += 1; };",
      "true ? ok('the ternary check') : bad('the ternary check');",
      '',
    ].join('\n'),
  });
  const m = mapSuite(dir, 'test/x.mjs');
  assert.deepEqual(
    m.checks.map((c) => c.title),
    ['the ternary check', 'the ternary check'],
  );
});

/* --------------------------------------------------------------- --for resolution */

console.log('\nresolving --for through lib/affected.js\n');

check('a suite that imports the target directly wins over one that only reads its text', () => {
  const dir = tree('for-direct', {
    'lib/a.js': 'export const A = 1;\n',
    'test/reads-it.mjs': [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const s = fs.readFileSync(path.join('lib', 'a.js'), 'utf8');",
      '',
    ].join('\n'),
    'test/imports-it.mjs': "import { A } from '../lib/a.js';\n",
  });
  const res = suiteFor(dir, 'lib/a.js');
  assert.equal(res.suite, 'test/imports-it.mjs');
});

check('with no direct importer resolvable, a suite that reads the target via a helper call still beats a generic directory-walker', () => {
  // `lib/affected.js` cannot see the PUBLIC(...) helper-call convention as a text
  // reference at all (the literal is split across two calls) — so `test/reporter.mjs`
  // reaches `findAffected`'s own candidate list only through an unrelated directory
  // walk, same as it does in the real repo (see the acceptance-criteria case below).
  // `mapSuite`'s own precise `vm-source` detection is what promotes it over
  // `test/walker.mjs`, which has nothing but that same weak walk.
  const dir = tree('for-nameHit', {
    'public/report.js': 'window.x = 1;\n',
    'test/walker.mjs': ["import fs from 'node:fs';", "fs.readdirSync('public');", ''].join('\n'),
    'test/reporter.mjs': [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const HERE = path.dirname(fileURLToPath(import.meta.url));",
      "const ROOT = path.join(HERE, '..');",
      "const PUBLIC = (f) => path.join(ROOT, 'public', f);",
      "const SOURCE = fs.readFileSync(PUBLIC('report.js'), 'utf8');",
      "fs.readdirSync('public');",
      '',
    ].join('\n'),
    // Gives the file at least one non-walk match, which is what makes `findAffected`
    // treat it as covered at all and include the walk-only entries in its result.
    'test/reads-literally.mjs': [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "fs.readFileSync(path.join('public', 'report.js'), 'utf8');",
      '',
    ].join('\n'),
  });
  const res = suiteFor(dir, 'public/report.js');
  assert.equal(res.suite, 'test/reporter.mjs');
});

check('a target nothing covers resolves to null', () => {
  const dir = tree('for-nothing', { 'lib/a.js': 'export const A = 1;\n', 'lib/b.js': 'export const B = 2;\n' });
  assert.equal(suiteFor(dir, 'lib/b.js'), null);
});

/* --------------------------------------------------------------------------- exit */

console.log('\nthe non-existent and the malformed\n');

check('a suite that does not exist maps to null', () => {
  const dir = tree('missing', {});
  assert.equal(mapSuite(dir, 'test/nope.mjs'), null);
});

check('a suite with a syntax error maps to null rather than throwing', () => {
  const dir = tree('syntax-error', { 'test/x.mjs': 'const { = broken(\n' });
  assert.equal(mapSuite(dir, 'test/x.mjs'), null);
});

/* ------------------------------------------------------------------------ the CLI */

console.log('\nthe CLI\n');

check('bin/b7e-suitemap prints imports, helpers and checks against a fixture tree', () => {
  const dir = tree('cli-basic', {
    'lib/a.js': 'export const A = 1;\n',
    'test/x.mjs': [
      "import { A } from '../lib/a.js';",
      'let failures = 0;',
      'const check = async (name, fn) => { await fn(); };',
      "await check('a real check', () => {});",
      '',
    ].join('\n'),
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'test/x.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /lib\/a\.js/);
  assert.match(run.stdout, /a real check/);
});

check('--json prints a parseable object with the same shape', () => {
  const dir = tree('cli-json', {
    'test/x.mjs': ["const check = async (name, fn) => { await fn(); };", "await check('x', () => {});", ''].join('\n'),
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json', 'test/x.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.suite, 'test/x.mjs');
  assert.equal(parsed.checks.length, 1);
});

check('--for resolves through lib/affected.js and says so on stderr', () => {
  const dir = tree('cli-for', {
    'lib/a.js': 'export const A = 1;\n',
    'test/x.mjs': "import { A } from '../lib/a.js';\n",
  });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--for', 'lib/a.js'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /resolves to test\/x\.mjs/);
  assert.match(run.stdout, /test\/x\.mjs/);
});

check('a suite path and --for together is refused', () => {
  const dir = tree('cli-both', { 'test/x.mjs': '' });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--for', 'lib/a.js', 'test/x.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

check('no argument at all is refused', () => {
  const dir = tree('cli-none', {});
  const run = spawnSync(process.execPath, [BIN, '--dir', dir], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

check('a suite that does not exist exits 4', () => {
  const dir = tree('cli-missing', {});
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'test/nope.mjs'], { encoding: 'utf8' });
  assert.equal(run.status, 4);
});

check('--for naming a file nothing covers exits 4', () => {
  const dir = tree('cli-for-nothing', { 'lib/a.js': 'export const A = 1;\n' });
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--for', 'lib/a.js'], { encoding: 'utf8' });
  assert.equal(run.status, 4);
});

check('an unrecognised flag is refused', () => {
  const dir = tree('cli-badflag', {});
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--nope'], { encoding: 'utf8' });
  assert.equal(run.status, 2);
});

/* --------------------------------------------------- the bead's own acceptance criteria */

console.log("\nthe bead's own two acceptance cases, against this repo\n");

check('b7e-suitemap test/homing.mjs prints the anchor bc-mwhkg.2 needed three sed slices and a grep for', () => {
  const m = mapSuite(ROOT, 'test/homing.mjs');
  const c = m.checks.find((c) => c.title.includes('THE HOME IS THE P0 THE DISCOVERY CAME FROM'));
  assert.ok(c, 'the anchor title was not found');
  const backlog = m.checks.find((c) => c.section === 'the backlog P0');
  assert.ok(backlog, 'the "the backlog P0" section was not found');
});

check('b7e-suitemap --for public/report.js resolves to test/reporter.mjs and names load, fire, and the acceptance criteria', () => {
  const res = suiteFor(ROOT, 'public/report.js');
  assert.equal(res.suite, 'test/reporter.mjs');
  const m = mapSuite(ROOT, res.suite);
  const load = m.helpers.find((h) => h.name === 'load');
  assert.ok(load, 'load was not found as a helper');
  assert.ok(load.returns && load.returns.includes('fire'), 'fire was not found among what load returns');
  const acceptance = m.checks.filter((c) => c.section === 'the acceptance criteria');
  assert.ok(acceptance.length >= 3, 'the acceptance-criteria section checks were not found');
});

/* ------------------------------------------------------------------------------ done */

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} passed\x1b[0m\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
