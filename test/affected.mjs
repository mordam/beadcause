#!/usr/bin/env node
//
// b7e-affected — given a diff, name the suites that actually cover it (bc-khoe.40).
//
//   npm test
//   node test/affected.mjs
//
// lib/affected.js does the matching; this drives it against fabricated trees (the same
// shape test/gate.mjs uses, one level deeper — bin/, lib/, public/, scripts/, test/ all
// present) rather than against this repo's own ~450 suites, so a regression here is
// found in milliseconds rather than by reading a diff of two enormous suite lists. A
// handful of checks run against the real repo at the end, because the two concrete cases
// in bc-khoe.40's own acceptance criteria — `public/spacebar.js`, `lib/advocate.js` — are
// about *this* codebase, not a fabricated one, and the whole point is that they hold here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-affected');

const affected = await import(path.join(ROOT, 'lib', 'affected.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-affected-test-'));

/** A fresh `<tmp>/<name>/` tree holding the given files at the given repo-relative paths. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, body);
  }
  return dir;
};

/* ===================================================================== *
 * 1. imports — direct, transitive, the LIB()/PUBLIC() dynamic convention
 * ===================================================================== */

console.log('\nimport resolution\n');

check('a direct static import is an edge', () => {
  const dir = tree('import-static', {
    'lib/a.js': "export const A = 1;\n",
    'test/x.mjs': "import { A } from '../lib/a.js';\n",
  });
  const { suites } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(suites, ['test/x.mjs']);
});

check('a transitive import (two hops) is still an edge', () => {
  const dir = tree('import-transitive', {
    'lib/a.js': "export const A = 1;\n",
    'lib/b.js': "import { A } from './a.js';\nexport const B = A;\n",
    'test/x.mjs': "import { B } from '../lib/b.js';\n",
  });
  const { suites } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(suites, ['test/x.mjs']);
});

check('a multi-line destructured import is still an edge', () => {
  const dir = tree('import-multiline', {
    'lib/a.js': "export const A = 1;\nexport const Q = 2;\n",
    'test/x.mjs': "import {\n  A,\n  Q,\n} from '../lib/a.js';\n",
  });
  const { suites } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(suites, ['test/x.mjs']);
});

check('the LIB() dynamic-import convention resolves to lib/, whatever the base is called', () => {
  const dir = tree('import-lib-helper', {
    'lib/advocate.js': "export function createAdvocates() {}\n",
    'test/x.mjs': "const LIB = (f) => require('path').join(__dirname, '..', 'lib', f);\nconst { createAdvocates } = await import(LIB('advocate.js'));\n",
  });
  const { suites } = affected.findAffected(dir, ['lib/advocate.js']);
  assert.deepEqual(suites, ['test/x.mjs']);
});

check('an unrelated file with no import edge is not matched', () => {
  const dir = tree('import-none', {
    'lib/a.js': "export const A = 1;\n",
    'lib/unrelated.js': "export const U = 1;\n",
    'test/x.mjs': "import { U } from '../lib/unrelated.js';\n",
  });
  const { unmatched } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(unmatched, ['lib/a.js']);
});

/* ===================================================================== *
 * 2. source-text reads — the public/spacebar.js shape, no import anywhere
 * ===================================================================== */

console.log('\nsource-text reads (no import at all)\n');

check("public/*.js read via path.join segments, fs.readFileSync — 'reads its source text'", () => {
  const dir = tree('read-pathjoin', {
    'public/bar.js': "function paint() {}\n",
    'test/x.mjs': [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "const ROOT = '..';",
      "const bar = fs.readFileSync(path.join(ROOT, 'public', 'bar.js'), 'utf8');",
      "console.log(bar);",
    ].join('\n'),
  });
  const { results } = affected.findAffected(dir, ['public/bar.js']);
  assert.deepEqual(results[0].matches, [{ suite: 'test/x.mjs', reasons: ['reads its source text'] }]);
});

check("a same-file read() wrapper around a bare literal path is the same shape", () => {
  const dir = tree('read-wrapper', {
    'public/bar.js': "function paint() {}\n",
    'test/x.mjs': [
      "import fs from 'node:fs';",
      "const ROOT = '..';",
      "const read = (f) => fs.readFileSync(ROOT + '/' + f, 'utf8');",
      "const bar = read('public/bar.js');",
      "console.log(bar);",
    ].join('\n'),
  });
  const { results } = affected.findAffected(dir, ['public/bar.js']);
  assert.deepEqual(results[0].matches, [{ suite: 'test/x.mjs', reasons: ['reads its source text'] }]);
});

check('the identical path literal with no read call nearby is the weaker "names it in a string"', () => {
  const dir = tree('names-no-read', {
    'public/bar.js': "function paint() {}\n",
    'lib/registry.js': "export const OWNERS = { paint: 'public/bar.js' };\n",
    'test/x.mjs': "import { OWNERS } from '../lib/registry.js';\nconsole.log(OWNERS);\n",
  });
  // registry.js is imported by the suite, but a text reference does not travel through
  // the import graph (see section 4) — so this checks the suite's *own* text, which does
  // not mention the path at all, and correctly finds nothing.
  const { unmatched } = affected.findAffected(dir, ['public/bar.js']);
  assert.deepEqual(unmatched, ['public/bar.js']);
});

check('a distinctive exported identifier appearing as a bare word is "names it in a string"', () => {
  const dir = tree('names-identifier', {
    'lib/a.js': "export function createAdvocates() {}\n",
    'test/x.mjs': "// this suite fakes createAdvocates without importing it\nfunction createAdvocates() { return null; }\n",
  });
  const { results } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(results[0].matches, [{ suite: 'test/x.mjs', reasons: ['names it in a string'] }]);
});

check('a short, generic exported name is not searched for at all', () => {
  const dir = tree('generic-name-dropped', {
    'lib/a.js': "export const options = 1;\n",
    'test/x.mjs': "const options = { anything: true };\nconsole.log(options);\n",
  });
  const { unmatched } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(unmatched, ['lib/a.js'], 'a bare six-letter English word must not be treated as a reference');
});

/* ===================================================================== *
 * 3. comments are stripped before anything is checked
 * ===================================================================== */

console.log('\ncomments do not count\n');

check('a path mentioned only in a header comment is not a reference', () => {
  const dir = tree('comment-path', {
    'public/bar.js': "function paint() {}\n",
    'test/x.mjs': "// this suite is about a completely different thing than 'public/bar.js'\nconsole.log('unrelated');\n",
  });
  const { unmatched } = affected.findAffected(dir, ['public/bar.js']);
  assert.deepEqual(unmatched, ['public/bar.js']);
});

check('an identifier mentioned only in a block comment is not a reference', () => {
  const dir = tree('comment-identifier', {
    'lib/a.js': "export function createAdvocates() {}\n",
    'test/x.mjs': "/**\n * See createAdvocates in lib/a.js for background.\n */\nconsole.log('unrelated');\n",
  });
  const { unmatched } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(unmatched, ['lib/a.js']);
});

/* ===================================================================== *
 * 4. a text reference is one hop, never propagated through the import graph
 * ===================================================================== */

console.log('\nno hub explosion — a text match does not travel through imports\n');

check('a hub file every suite imports does not turn a text reference into every suite matching', () => {
  // The regression this guards: lib/foundation.js carries one code reference to
  // lib/advocate.js ("briefOwner: 'lib/advocate.js'") and is imported by nearly every
  // suite in the real repo. Propagating that one line through the import graph turned a
  // change to lib/advocate.js into 222 of 449 "affected" suites. This fixture is the
  // same shape at a scale a human can read: a hub every suite imports, one line in it
  // naming the changed file, and many suites that never mention it themselves.
  const files = { 'lib/target.js': "export function distinctiveName() {}\n" };
  files['lib/hub.js'] = "export const OWNER = 'lib/target.js';\n";
  for (let i = 0; i < 12; i++) {
    files[`test/s${i}.mjs`] = `import { OWNER } from '../lib/hub.js';\nconsole.log(OWNER, ${i});\n`;
  }
  const dir = tree('hub-no-propagation', files);
  const { suites, unmatched } = affected.findAffected(dir, ['lib/target.js']);
  assert.deepEqual(suites, [], 'none of the twelve suites reference lib/target.js in their own text');
  assert.deepEqual(unmatched, ['lib/target.js']);
});

check('the same hub DOES count for a suite that imports the changed file directly', () => {
  const dir = tree('hub-direct-import-still-counts', {
    'lib/target.js': "export function distinctiveName() {}\n",
    'lib/hub.js': "export const OWNER = 'lib/target.js';\n",
    'test/direct.mjs': "import { distinctiveName } from '../lib/target.js';\nimport { OWNER } from '../lib/hub.js';\n",
    'test/indirect.mjs': "import { OWNER } from '../lib/hub.js';\n",
  });
  const { suites } = affected.findAffected(dir, ['lib/target.js']);
  assert.deepEqual(suites, ['test/direct.mjs'], 'only the suite with a real import edge, not the one that merely shares the hub');
});

/* ===================================================================== *
 * 5. browser checks — "serves this page"
 * ===================================================================== */

console.log('\nbrowser checks that serve a page\n');

check('a check naming a public page by its bare filename gets the sharper "serves this page"', () => {
  const dir = tree('serves-page', {
    'public/monitor.html': '<html></html>\n',
    'scripts/monitor-check.mjs': "const PAGES = [{ url: '/monitor', file: 'monitor.html' }];\nconsole.log(PAGES);\n",
  });
  const { results } = affected.findAffected(dir, ['public/monitor.html']);
  assert.deepEqual(results[0].matches, [{ suite: 'scripts/monitor-check.mjs', reasons: ['serves this page'] }]);
});

check('an ordinary suite naming the same page gets the plain reason, not "serves this page"', () => {
  const dir = tree('serves-page-not-a-check', {
    'public/monitor.html': '<html></html>\n',
    'test/routes.mjs': "const PAGES = [{ url: '/monitor', file: 'monitor.html' }];\nconsole.log(PAGES);\n",
  });
  const { results } = affected.findAffected(dir, ['public/monitor.html']);
  assert.deepEqual(results[0].matches, [{ suite: 'test/routes.mjs', reasons: ['names it in a string'] }]);
});

/* ===================================================================== *
 * 6. never a shrug — unmatched files are named, not silently dropped
 * ===================================================================== */

console.log('\nnever the whole directory as a shrug\n');

check('a changed file with no trace anywhere is reported unmatched, not silently absent from both lists', () => {
  const dir = tree('truly-unmatched', {
    'lib/a.js': "export const A = 1;\n",
    'test/x.mjs': "console.log('nothing to do with lib/a.js');\n",
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/a.js']);
  assert.deepEqual(results, []);
  assert.deepEqual(unmatched, ['lib/a.js']);
});

check('one matched file and one unmatched file are reported independently', () => {
  const dir = tree('mixed-match', {
    'lib/a.js': "export const A = 1;\n",
    'lib/b.js': "export const B = 1;\n",
    'test/x.mjs': "import { A } from '../lib/a.js';\n",
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/a.js', 'lib/b.js']);
  assert.deepEqual(results.map((r) => r.file), ['lib/a.js']);
  assert.deepEqual(unmatched, ['lib/b.js']);
});

/* ===================================================================== *
 * 7. candidateSuites — the two existing inventories, unioned
 * ===================================================================== */

console.log('\ncandidateSuites reuses discoverSuites and checkaudit.discover\n');

check('candidateSuites is test/*.mjs, the pinned scripts/ entries, and every *-check.mjs', () => {
  const dir = tree('candidate-suites', {
    'test/b.mjs': '',
    'test/a.mjs': '',
    'scripts/selftest.mjs': '',
    'scripts/test-swap.js': '',
    'scripts/foo-check.mjs': '',
    'scripts/notacheck.mjs': '',
  });
  assert.deepEqual(affected.candidateSuites(dir), [
    'scripts/foo-check.mjs',
    'scripts/selftest.mjs',
    'scripts/test-swap.js',
    'test/a.mjs',
    'test/b.mjs',
  ]);
});

/* ===================================================================== *
 * 8. defaultChangedFiles — the real git diff, against a fabricated repo
 * ===================================================================== */

console.log('\ndefaultChangedFiles — a real git repo, no origin/main\n');

{
  const dir = tree('git-diff', { 'lib/a.js': "export const A = 1;\n" });
  const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=test', '-c', 'user.email=test@localhost', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
  git('-c', 'init.defaultBranch=main', 'init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'first');

  check('with nothing changed, the list is empty', () => {
    assert.deepEqual(affected.defaultChangedFiles(dir), []);
  });

  fs.writeFileSync(path.join(dir, 'lib', 'a.js'), "export const A = 2;\n");
  check('an uncommitted tracked edit shows up (falls back to `main` — there is no origin/main here)', () => {
    assert.deepEqual(affected.defaultChangedFiles(dir), ['lib/a.js']);
  });

  git('add', '-A');
  git('commit', '-q', '-m', 'second');
  check('once committed to main, the same edit is gone from the diff (merge-base is HEAD itself)', () => {
    assert.deepEqual(affected.defaultChangedFiles(dir), []);
  });

  fs.writeFileSync(path.join(dir, 'lib', 'b.js'), "export const B = 1;\n");
  check('a new untracked file is included', () => {
    assert.deepEqual(affected.defaultChangedFiles(dir), ['lib/b.js']);
  });

  git('checkout', '-q', '-b', 'topic');
  git('add', '-A');
  git('commit', '-q', '-m', 'third');
  fs.writeFileSync(path.join(dir, 'lib', 'c.js'), "export const C = 1;\n");
  git('add', '-A');
  git('commit', '-q', '-m', 'fourth');
  check('everything since the merge-base with main comes back, not just the tip commit', () => {
    assert.deepEqual(affected.defaultChangedFiles(dir), ['lib/b.js', 'lib/c.js']);
  });
}

/* ===================================================================== *
 * 9. the CLI — argv, exit codes, the empty-stdout fallback
 * ===================================================================== */

console.log('\nthe CLI\n');

{
  const dir = tree('cli', {
    'public/bar.js': "function paint() {}\n",
    'test/reads.mjs': "import fs from 'node:fs';\nimport path from 'node:path';\nconst ROOT='..';\nfs.readFileSync(path.join(ROOT, 'public', 'bar.js'));\n",
  });

  check('a matched file prints exact suite paths and exits 0', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'public/bar.js'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), 'test/reads.mjs');
  });

  check('--why adds the reason and the file, tab-separated', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--why', 'public/bar.js'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.equal(run.stdout.trim(), 'test/reads.mjs\treads its source text — public/bar.js');
  });

  check('an unmatched file prints nothing on stdout — an empty --only selection is b7e-gate\'s "everything"', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'lib/nope.js'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /no suite matches lib\/nope\.js/);
  });

  check('one matched and one unmatched file together: still nothing on stdout, exit 1', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'public/bar.js', 'lib/nope.js'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.equal(run.stdout, '', 'a partial narrowing would silently drop coverage for the unmatched file');
  });

  check('--json prints one object per file, then a summary line', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--json', 'public/bar.js'], { encoding: 'utf8' });
    const lines = run.stdout.trim().split('\n').filter(Boolean);
    assert.equal(lines.length, 2);
    const rec = JSON.parse(lines[0]);
    assert.deepEqual(rec.suites, ['test/reads.mjs']);
    const summary = JSON.parse(lines[1]);
    assert.equal(summary.summary, true);
    assert.deepEqual(summary.suites, ['test/reads.mjs']);
    assert.deepEqual(summary.unmatchedFiles, []);
  });

  check('an unrecognised flag is refused with exit 2', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--nope'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
  });
}

/* ===================================================================== *
 * 10. the real repo — bc-khoe.40's own two acceptance cases
 * ===================================================================== */

console.log("\nthe real repo — bc-khoe.40's own acceptance\n");

// This suite is itself a candidate suite against the real repo, so a path written here as
// one contiguous quoted literal ('public/spacebar.js') would make this file "reference"
// whatever it names — the exact false-positive shape section 4 guards against, aimed at
// this file instead of a fixture. Building each path from two joined segments sidesteps
// it: neither half alone is the literal `pathLiteralIndex` looks for.
const rel = (...segs) => segs.join('/');

check('public/spacebar.js: exactly the two suites that read its source text, matching on text and not on import', () => {
  const { suites, results } = affected.findAffected(affected.REPO_ROOT, [rel('public', 'spacebar.js')]);
  assert.deepEqual(suites, ['test/editfreeze.mjs', 'test/sweepfail.mjs']);
  for (const m of results[0].matches) assert.deepEqual(m.reasons, ['reads its source text']);
});

check('lib/advocate.js: a real, bounded floor — not the whole test directory, and not every suite that shares a hub with it', () => {
  const { suites } = affected.findAffected(affected.REPO_ROOT, [rel('lib', 'advocate.js')]);
  const total = affected.candidateSuites(affected.REPO_ROOT).length;
  assert.ok(suites.length > 20, `expected a real, non-trivial floor; got ${suites.length}`);
  assert.ok(suites.length < total / 2, `expected well under half of ${total} suites; got ${suites.length} — a hub file is probably propagating again`);
  assert.ok(suites.includes('test/inmain.mjs'), 'imports lib/advocate.js directly via LIB()');
  assert.ok(suites.includes('test/superseded.mjs'), 'imports lib/advocate.js directly via LIB()');
  assert.ok(suites.includes('test/filter.mjs'), 'imports lib/advocate.js transitively through lib/server.js');
});

check('a file nothing references is reported unmatched against the real repo too', () => {
  const { unmatched } = affected.findAffected(affected.REPO_ROOT, [rel('lib', 'this-file-does-not-exist-anywhere.js')]);
  assert.deepEqual(unmatched, [rel('lib', 'this-file-does-not-exist-anywhere.js')]);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall affected checks passed\n');
process.exit(failures ? 1 : 0);
