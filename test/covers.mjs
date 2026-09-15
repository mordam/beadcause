#!/usr/bin/env node
//
// Which of a workspace repo's own gate scripts actually read a given file (bc-dgx7.126).
//
//   npm test
//   node test/covers.mjs
//
// lib/covers.js runs each of lib/checks.js's discovered checks once under lib/
// coversaudit.py's audit hook, caches the result by the check script's own content
// hash, and matches a query path against what came back. This drives that directly
// against fabricated trees — real python3 children, same as test/b7echecks.mjs — never
// against a real deluvia checkout, which this suite must not depend on having cloned.
//
// python3 is assumed present, the same assumption b7e-checks already makes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

process.env.BEADCAUSE_CONFIG_DIR = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-covers-config-'));

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const covers = await import(path.join(ROOT, 'lib', 'covers.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-covers-test-'));

/** A fresh `<tmp>/<name>/` tree holding the given files (any path, not just `scripts/`). */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

/* ===================================================================== *
 * 1. auditCheck — what a real python3 child reports
 * ===================================================================== */

console.log('\nauditCheck: recording what a check actually reads\n');

await checkAsync('an open() on a file under root is recorded as a read', async () => {
  const dir = tree('audit-open', {
    'scripts/check_a.py': 'with open("data/a.txt") as f:\n    f.read()\n',
    'data/a.txt': 'hi',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.reads, [path.join(dir, 'data', 'a.txt')]);
  assert.equal(r.exitCode, 0);
});

await checkAsync('pathlib.Path.read_text is also an open() — same audit event, same result', async () => {
  const dir = tree('audit-pathlib', {
    'scripts/check_a.py': 'import pathlib\npathlib.Path("data/a.txt").read_text()\n',
    'data/a.txt': 'hi',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.reads, [path.join(dir, 'data', 'a.txt')]);
});

await checkAsync('os.listdir is recorded as a walked directory', async () => {
  const dir = tree('audit-listdir', {
    'scripts/check_a.py': 'import os\nos.listdir("data")\n',
    'data/a.txt': 'hi',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.dirs, [path.join(dir, 'data')]);
});

await checkAsync('glob.glob funnels through os.scandir — a directory walk with no listdir call in sight', async () => {
  const dir = tree('audit-glob', {
    'scripts/check_a.py': 'import glob\nglob.glob("data/*.txt")\n',
    'data/a.txt': 'hi',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.dirs, [path.join(dir, 'data')]);
});

await checkAsync('a path outside root is filtered out — interpreter/stdlib noise never pollutes the result', async () => {
  const outsideFile = path.join(tmp, 'outside.txt');
  fs.writeFileSync(outsideFile, 'nope');
  const dir = tree('audit-filtered', {
    'scripts/check_a.py': `with open(${JSON.stringify(outsideFile)}) as f:\n    f.read()\n`,
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.reads, []);
});

await checkAsync('a check that raises mid-run still contributes what it read before failing — the dv-gr6.70 shape', async () => {
  const dir = tree('audit-fails', {
    'scripts/check_a.py': 'import os, sys\nos.listdir("data")\nsys.exit(1)\n',
    'data/a.txt': 'hi',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.dirs, [path.join(dir, 'data')]);
  assert.equal(r.exitCode, 1);
});

await checkAsync('an uncaught exception (not sys.exit) still contributes and is reported as a failure', async () => {
  const dir = tree('audit-raises', {
    'scripts/check_a.py': 'import os\nos.listdir("data")\nraise ValueError("boom")\n',
    'data/a.txt': 'hi',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] });
  assert.deepEqual(r.dirs, [path.join(dir, 'data')]);
  assert.equal(r.exitCode, 1);
});

await checkAsync('env overrides reach the child, same as lib/checks.js\'s runCheck', async () => {
  const dir = tree('audit-env', {
    'scripts/check_a.py': 'import os, sys\nsys.exit(0 if os.environ.get("BEADS_DIR") == "/x/y" else 1)\n',
  });
  const r = covers.auditCheck(dir, { name: 'scripts/check_a.py', argv: ['scripts/check_a.py'] }, { env: { BEADS_DIR: '/x/y' } });
  assert.equal(r.exitCode, 0);
});

/* ===================================================================== *
 * 2. coverageForCheck — cached by the script's own content hash
 * ===================================================================== */

console.log('\ncoverageForCheck: caching\n');

await checkAsync('a second call reuses the cache — python3 is not spawned again', async () => {
  const dir = tree('cache-hit', {
    'scripts/check_a.py': `
import os
with open("run-count.txt", "a") as f:
    f.write("x")
os.listdir(".")
`,
    'run-count.txt': '',
  });
  const check = covers.discoverChecks(dir)[0];
  covers.coverageForCheck(dir, check);
  covers.coverageForCheck(dir, check);
  const runs = fs.readFileSync(path.join(dir, 'run-count.txt'), 'utf8');
  assert.equal(runs, 'x', `expected exactly one real run, python3 ran ${runs.length} times`);
});

await checkAsync('editing the script invalidates the cache — content hash changed', async () => {
  const dir = tree('cache-invalidate', {
    'scripts/check_a.py': 'import os\nwith open("run-count.txt", "a") as f:\n    f.write("x")\n',
    'run-count.txt': '',
  });
  const check = covers.discoverChecks(dir)[0];
  covers.coverageForCheck(dir, check);
  fs.appendFileSync(path.join(dir, 'scripts', 'check_a.py'), '# a harmless comment\n');
  covers.coverageForCheck(dir, check);
  const runs = fs.readFileSync(path.join(dir, 'run-count.txt'), 'utf8');
  assert.equal(runs, 'xx', `expected two real runs after the edit, got ${runs.length}`);
});

await checkAsync('refresh: true reruns even when the cache is still valid', async () => {
  const dir = tree('cache-refresh', {
    'scripts/check_a.py': 'import os\nwith open("run-count.txt", "a") as f:\n    f.write("x")\n',
    'run-count.txt': '',
  });
  const check = covers.discoverChecks(dir)[0];
  covers.coverageForCheck(dir, check);
  covers.coverageForCheck(dir, check, { refresh: true });
  const runs = fs.readFileSync(path.join(dir, 'run-count.txt'), 'utf8');
  assert.equal(runs, 'xx');
});

await checkAsync('coverageMap covers every discovered check', async () => {
  const dir = tree('cache-map', {
    'scripts/check_a.py': 'import os\nos.listdir(".")\n',
    'scripts/check_b.py': 'import os\nos.listdir(".")\n',
  });
  const map = covers.coverageMap(dir);
  assert.deepEqual(
    map.map((e) => e.name),
    ['scripts/check_a.py', 'scripts/check_b.py']
  );
});

/* ===================================================================== *
 * 3. whichCover / coverAll — matching a query path
 * ===================================================================== */

console.log('\nmatching a query path\n');

check('an exact read match is "opens it"', () => {
  const map = [{ name: 'scripts/check_a.py', reads: ['/root/data/a.txt'], dirs: [] }];
  const matches = covers.whichCover('/root', map, 'data/a.txt');
  assert.deepEqual(matches, [{ name: 'scripts/check_a.py', reason: 'opens it' }]);
});

check('an ancestor directory match is "walks its directory" — covers a file that does not exist on disk yet', () => {
  const map = [{ name: 'scripts/check_a.py', reads: [], dirs: ['/root/novel/Book3'] }];
  const matches = covers.whichCover('/root', map, 'novel/Book3/INTERLUDE_035.summary.md');
  assert.deepEqual(matches, [{ name: 'scripts/check_a.py', reason: 'walks its directory' }]);
});

check('a check matching both ways reports the more specific reason', () => {
  const map = [{ name: 'scripts/check_a.py', reads: ['/root/data/a.txt'], dirs: ['/root/data'] }];
  const matches = covers.whichCover('/root', map, 'data/a.txt');
  assert.deepEqual(matches, [{ name: 'scripts/check_a.py', reason: 'opens it' }]);
});

check('a path in a sibling directory does not match — the ancestor check is a real prefix, not a substring', () => {
  const map = [{ name: 'scripts/check_a.py', reads: [], dirs: ['/root/novel/Book3'] }];
  const matches = covers.whichCover('/root', map, 'novel/Book30ther/x.md');
  assert.deepEqual(matches, []);
});

check('an unrelated path matches nothing', () => {
  const map = [{ name: 'scripts/check_a.py', reads: ['/root/data/a.txt'], dirs: [] }];
  const matches = covers.whichCover('/root', map, 'reference/UNRELATED.md');
  assert.deepEqual(matches, []);
});

check('coverAll dedupes matched names across query paths and orders unmatched separately', () => {
  const map = [
    { name: 'scripts/check_a.py', reads: ['/root/x.md', '/root/y.md'], dirs: [] },
    { name: 'scripts/check_b.py', reads: ['/root/y.md'], dirs: [] },
  ];
  const { results, unmatched, names } = covers.coverAll('/root', map, ['x.md', 'y.md', 'z.md']);
  assert.equal(results.length, 3);
  assert.deepEqual(unmatched, ['z.md']);
  assert.deepEqual(names, ['scripts/check_a.py', 'scripts/check_b.py']);
});

/* ===================================================================== *
 * 4. end to end — the bead's own acceptance case
 * ===================================================================== */

console.log('\nend to end — the INTERLUDE_035 case\n');

await checkAsync('a new interlude is covered by the directory-walking gate, not the exact-open one — verbatim bc-dgx7.126', async () => {
  const dir = tree('e2e-interlude', {
    'scripts/check_saga_audit.py': `
import os
files = os.listdir(os.path.join("novel", "Book3"))
inventory = {"Book3": 1}
count = len([f for f in files if f.startswith("INTERLUDE")])
if count != inventory["Book3"]:
    raise SystemExit(1)
`,
    'scripts/check_entry069_species_naming.py': `
import os
with open(os.path.join("novel", "Book3", "INTERLUDE_034.summary.md")) as f:
    f.read()
`,
    'novel/Book3/INTERLUDE_034.summary.md': 'existing',
  });
  const map = covers.coverageMap(dir);
  const forNew = covers.whichCover(dir, map, 'novel/Book3/INTERLUDE_035.summary.md');
  assert.deepEqual(forNew, [{ name: 'scripts/check_saga_audit.py', reason: 'walks its directory' }]);

  const forExisting = covers.whichCover(dir, map, 'novel/Book3/INTERLUDE_034.summary.md');
  const names = forExisting.map((m) => m.name).sort();
  assert.deepEqual(names, ['scripts/check_entry069_species_naming.py', 'scripts/check_saga_audit.py']);

  const forUnrelated = covers.whichCover(dir, map, 'reference/CHARACTER_CONCURRENCY.md');
  assert.deepEqual(forUnrelated, []);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);
fs.rmSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true, force: true });

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
