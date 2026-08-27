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
 * 6. the naming convention — "shares its name" (bc-xlz32.9)
 * ===================================================================== */

console.log('\nthe suite this repo\'s naming convention would give a file\n');

check('test/<stem>.mjs matches lib/<stem>.js with no import and no text reference anywhere', () => {
  const dir = tree('same-name-lib', {
    'lib/panestage.js': "export const PANE = 1;\n",
    'test/panestage.mjs': "console.log('drives the page through a browser, never reads or imports it');\n",
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/panestage.js']);
  assert.deepEqual(unmatched, []);
  assert.deepEqual(results[0].matches, [{ suite: 'test/panestage.mjs', reasons: ['shares its name'] }]);
});

check('a public page loaded by a <script> tag matches its suite the same way — the bc-xlz32.9 case', () => {
  const dir = tree('same-name-public', {
    'public/panestage.js': "function draw() {}\n",
    'test/panestage.mjs': "console.log('nothing');\n",
  });
  const { suites, unmatched } = affected.findAffected(dir, ['public/panestage.js']);
  assert.deepEqual(unmatched, []);
  assert.deepEqual(suites, ['test/panestage.mjs']);
});

check('the bin/b7e-* family pairs through the dash-stripped stem', () => {
  const dir = tree('same-name-dashes', {
    'bin/b7e-bound': "#!/usr/bin/env node\n",
    'test/b7ebound.mjs': "console.log('nothing');\n",
  });
  const { suites } = affected.findAffected(dir, ['bin/b7e-bound']);
  assert.deepEqual(suites, ['test/b7ebound.mjs']);
});

check('a lib/ module whose suite is named after the tool in front of it still pairs', () => {
  const dir = tree('same-name-b7e-prefix', {
    'lib/precedent.js': "export const PRECEDENT = 1;\n",
    'test/b7eprecedent.mjs': "console.log('nothing');\n",
  });
  const { suites } = affected.findAffected(dir, ['lib/precedent.js']);
  assert.deepEqual(suites, ['test/b7eprecedent.mjs']);
});

check('a stem with no suite behind it is still unmatched — the rule invents nothing', () => {
  const dir = tree('same-name-absent', {
    'lib/lonely.js': "export const LONELY = 1;\n",
    'test/somethingelse.mjs': "console.log('nothing');\n",
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/lonely.js']);
  assert.deepEqual(results, []);
  assert.deepEqual(unmatched, ['lib/lonely.js']);
});

check('a stronger reason is still reported, with the shared stem last', () => {
  const dir = tree('same-name-plus-import', {
    // A side-effect import, so `imports it` is the only *other* reason in play — naming
    // the exported binding would add "names it in a string" and stop this saying anything
    // about ordering.
    'lib/thing.js': "export const THING = 1;\n",
    'test/thing.mjs': "import '../lib/thing.js';\n",
  });
  const { results } = affected.findAffected(dir, ['lib/thing.js']);
  assert.deepEqual(results[0].matches, [{ suite: 'test/thing.mjs', reasons: ['imports it', 'shares its name'] }]);
});

check('the stem is the file name, not a substring — test/pane.mjs is not the suite for lib/panestage.js', () => {
  const dir = tree('same-name-not-substring', {
    'lib/panestage.js': "export const PANE = 1;\n",
    'test/pane.mjs': "console.log('nothing');\n",
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/panestage.js']);
  assert.deepEqual(results, []);
  assert.deepEqual(unmatched, ['lib/panestage.js']);
});

/* ===================================================================== *
 * 6a. walks the tree — the convention suites (bc-xlz32.8)
 * ===================================================================== */

console.log('\nsuites that walk a source directory cover what they cannot name\n');

// This suite is itself a candidate suite against the real repo — the same hazard section
// 11 joins its paths in segments for, aimed at a different rule. A fixture written out as
// a literal `readdirSync(path.join(ROOT, 'lib'))` would make *this file* claim to walk
// `lib/`, and `test/affected.mjs` would then match every lib/ and public/ change in the
// repo. Built from a parameter, the only quoted segment inside a `readdir(...)` here is
// `${dir}`, which names no source directory.
const walks = (dir, verb = 'fs.readdirSync') => `import fs from 'node:fs';\n${verb}(path.join(ROOT, '${dir}'));\n`;

check('a walk comes along when something else covers the file', () => {
  const dir = tree('walks-lib', {
    'lib/brandnew.js': "export const NEW = 1;\n",
    'test/brandnew.mjs': "console.log('the suite for it');\n",
    'test/convention.mjs': walks('lib'),
  });
  const { suites, unmatched } = affected.findAffected(dir, ['lib/brandnew.js']);
  assert.deepEqual(unmatched, []);
  assert.deepEqual(suites, ['test/brandnew.mjs', 'test/convention.mjs']);
});

check('a walk on its own is not cover — the file is still unmatched, and the gate still runs whole', () => {
  const dir = tree('walks-only', {
    'lib/brandnew.js': "export const NEW = 1;\n",
    'test/convention.mjs': walks('lib'),
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/brandnew.js']);
  assert.deepEqual(results, []);
  assert.deepEqual(unmatched, ['lib/brandnew.js']);
});

check('it covers only the directory it actually walks', () => {
  const dir = tree('walks-one-dir-only', {
    'public/page.js': "function draw() {}\n",
    'test/convention.mjs': walks('lib'),
  });
  const { results, unmatched } = affected.findAffected(dir, ['public/page.js']);
  assert.deepEqual(results, []);
  assert.deepEqual(unmatched, ['public/page.js']);
});

check('a readdir of somewhere that is not a source dir is not a walk', () => {
  assert.deepEqual([...affected.walkedDirs(walks('fixtures'))], []);
  assert.deepEqual([...affected.walkedDirs(walks('lib'))], ['lib']);
  assert.deepEqual([...affected.walkedDirs(walks('public', 'await fs.promises.readdir'))], ['public']);
});

check('reading a single file out of a source dir is not walking it', () => {
  const dir = tree('reads-not-walks', {
    'lib/brandnew.js': "export const NEW = 1;\n",
    'test/reader.mjs': walks('lib', 'fs.readFileSync').replace(/\)\);/, ", 'other.js'));"),
  });
  const { results } = affected.findAffected(dir, ['lib/brandnew.js']);
  assert.deepEqual(results, []);
});

/* ===================================================================== *
 * 6b. @manifest — data an import edge does not propagate from (bc-xlz32.7)
 * ===================================================================== */

console.log('\n@manifest — an import edge does not propagate out of data\n');

const MANIFEST = "/**\n * The list.\n *\n * @manifest\n */\nexport const BIG_TOOL_LIST = ['a'];\n";

check('a suite that merely imports a manifest is not selected', () => {
  const dir = tree('manifest-import-only', {
    'lib/manifested.js': MANIFEST,
    'lib/consumer.js': "import { BIG_TOOL_LIST } from './manifested.js';\nexport const passthrough = BIG_TOOL_LIST;\n",
    // Imports the consumer, so the manifest is two hops inside its closure — and says
    // nothing about either. This is the 196-of-205 shape.
    'test/downstream.mjs': "import { passthrough } from '../lib/consumer.js';\nconsole.log(passthrough);\n",
  });
  const { results, unmatched } = affected.findAffected(dir, ['lib/manifested.js']);
  assert.deepEqual(results, []);
  assert.deepEqual(unmatched, ['lib/manifested.js']);
});

check('a suite that names what is in the manifest is still selected', () => {
  const dir = tree('manifest-named', {
    'lib/manifested.js': MANIFEST,
    'test/asserts.mjs': "console.log('BIG_TOOL_LIST must still contain a');\n",
  });
  const { results } = affected.findAffected(dir, ['lib/manifested.js']);
  assert.deepEqual(results[0].matches, [{ suite: 'test/asserts.mjs', reasons: ['names it in a string'] }]);
});

check('the tag is refused to a file that declares a function — and the edge comes back', () => {
  const dir = tree('manifest-with-function', {
    'lib/manifested.js': "/**\n * @manifest\n */\nexport function notData() { return 1; }\n",
    'test/downstream.mjs': "import { notData } from '../lib/manifested.js';\nconsole.log(1);\n",
  });
  const { suites, manifests } = affected.findAffected(dir, ['lib/manifested.js']);
  assert.deepEqual(manifests, []);
  assert.deepEqual(suites, ['test/downstream.mjs']);
  assert.deepEqual(affected.manifestProblems("/** @manifest */\nexport function f() {}\n"), [
    'it declares a function — a manifest is data, not behaviour',
  ]);
});

check('the tag is refused to a file that imports something — a manifest is a leaf', () => {
  const dir = tree('manifest-with-import', {
    'lib/base.js': "export const BASE = 1;\n",
    'lib/manifested.js': "/**\n * @manifest\n */\nimport { BASE } from './base.js';\nexport const LIST = [BASE];\n",
    'test/downstream.mjs': "import { LIST } from '../lib/manifested.js';\nconsole.log(1);\n",
  });
  const { suites, manifests } = affected.findAffected(dir, ['lib/manifested.js']);
  assert.deepEqual(manifests, []);
  assert.ok(suites.includes('test/downstream.mjs'), 'the import edge still propagates');
});

check('a file that mentions the tag mid-sentence has not claimed it', () => {
  assert.equal(affected.isManifestSource(' * a file may declare @manifest in its header\n'), false);
  assert.equal(affected.isManifestSource(' * @manifest\n'), true);
});

check('the manifest is reported, not silently applied', () => {
  const dir = tree('manifest-reported', {
    'lib/manifested.js': MANIFEST,
    'test/asserts.mjs': "console.log('BIG_TOOL_LIST');\n",
  });
  assert.deepEqual(affected.findAffected(dir, ['lib/manifested.js']).manifests, ['lib/manifested.js']);
});

/* ===================================================================== *
 * 7. never a shrug — unmatched files are named, not silently dropped
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
 * 8. candidateSuites — the two existing inventories, unioned
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
 * 9. defaultChangedFiles — the real git diff, against a fabricated repo
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
 * 10. the CLI — argv, exit codes, the empty-stdout fallback
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
 * 11. the real repo — bc-khoe.40's own two acceptance cases
 * ===================================================================== */

console.log("\nthe real repo — bc-khoe.40's own acceptance\n");

// This suite is itself a candidate suite against the real repo, so a path written here as
// one contiguous quoted literal ('public/spacebar.js') would make this file "reference"
// whatever it names — the exact false-positive shape section 4 guards against, aimed at
// this file instead of a fixture. Building each path from two joined segments sidesteps
// it: neither half alone is the literal `pathLiteralIndex` looks for.
const rel = (...segs) => segs.join('/');

check('public/spacebar.js: exactly the suites that read its source text, matching on text and not on import', () => {
  // Three since bc-mc71w: test/addspace.mjs reads the picker to assert that the row it
  // draws is wired to the dialog behind it. The list is spelled out rather than counted
  // because the claim is *which* suites, not how many — a fifth appearing is either a real
  // reader or the matcher having gone back to propagating through imports.
  //
  // Four since bc-xnj67, and that one is a real reader of the least usual kind: it lifts
  // `slugOf` out of the source and runs it. That function is a copy of `spaceSlug` in
  // lib/spaces.js — one on each side of the browser/daemon line, with no module readable
  // from both — and what the suite asserts is that the two copies still agree.
  // Five since bc-xlz32.9, and the fifth is the embarrassing one: `test/spacebar.mjs` is
  // *the* suite for this file — the space picker's own — and none of the three original
  // reasons could see it, because it drives the picker through a browser rather than
  // importing it and builds its paths in segments rather than as a literal. bc-khoe.40's
  // own acceptance case was missing its most obvious suite for as long as this list said
  // four. That is the whole argument for matching on the naming convention.
  const { results } = affected.findAffected(affected.REPO_ROOT, [rel('public', 'spacebar.js')]);
  const by = (reason) => results[0].matches.filter((m) => m.reasons.includes(reason)).map((m) => m.suite);
  assert.deepEqual(by('reads its source text'), ['test/addspace.mjs', 'test/editfreeze.mjs', 'test/spacepaths.mjs', 'test/sweepfail.mjs']);
  assert.deepEqual(by('shares its name'), [rel('test', 'spacebar.mjs')]);
  // Everything else on the list walks public/ — the convention checks, which cover this
  // file the way they cover every other entry in that directory and name none of them.
  const rest = results[0].matches.filter((m) => !m.reasons.includes('reads its source text') && !m.reasons.includes('shares its name'));
  for (const m of rest) assert.deepEqual(m.reasons, ['walks the tree'], `${m.suite} is on the list for ${m.reasons.join('; ')}`);
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

check('every @manifest file in the real repo is genuinely data — no imports, no functions', () => {
  const tagged = [...affected.listJsFiles(affected.REPO_ROOT), ...affected.listAssetFiles(affected.REPO_ROOT)]
    .filter((f) => affected.isManifestSource(fs.readFileSync(path.join(affected.REPO_ROOT, f), 'utf8')));
  // Spelled out rather than counted: the tag takes ~200 suites off a file's list, so a
  // new one appearing here is a decision somebody should have to make on purpose.
  assert.deepEqual(tagged, [rel('lib', 'toolbelt.js')]);
  for (const f of tagged) {
    const problems = affected.manifestProblems(fs.readFileSync(path.join(affected.REPO_ROOT, f), 'utf8'));
    assert.deepEqual(problems, [], `${f} claims @manifest but ${problems.join('; ')}`);
  }
});

check('lib/toolbelt.js selects the suites that name the tool list, not everything that imports it', () => {
  const { suites } = affected.findAffected(affected.REPO_ROOT, [rel('lib', 'toolbelt.js')]);
  const total = affected.candidateSuites(affected.REPO_ROOT).length;
  // 205 of 530 before bc-xlz32.7, 196 of those for no reason but the edge.
  assert.ok(suites.length < total / 10, `expected a short, named list; got ${suites.length} of ${total}`);
  // `BASE_TOOL_LIST` since bc-wbrhi — the `bd` verbs this suite is about are the
  // hand-written half, which is what stayed in toolbelt.js when the b7e half became
  // derived. test/allowlist.mjs names it for exactly this reason.
  assert.ok(suites.includes(rel('test', 'allowlist.mjs')), 'names BASE_TOOL_LIST');
  assert.ok(suites.includes(rel('test', 'loadorder.mjs')), 'names the file — it is the cycle guard toolbelt.js exists for');
});

// The sentinel is joined from parts at run time, and that is the whole point of it.
// `findAffected` matches a *quoted path literal* (`pathLiteralIndex` in lib/affected.js),
// so any name written out in full here is only absent from the tree until some other suite
// happens to pick the same plausible string for its own missing-path fixture — and then
// this check goes red in a file that suite's author never opened. That is not
// hypothetical: #813 added test/b7esurface.mjs using this check's previous
// `lib/this-file-does-not-exist-anywhere.js` verbatim, `unmatched` came back empty, and
// main was red from 3b2001af1 until bc-jhelk (bc-sp2sz). Assembled, the literal this check
// looks for appears in no file in the repo — this one included — so nothing can collide
// with it, whatever anybody adds next.
check('a file nothing references is reported unmatched against the real repo too', () => {
  const absent = rel('lib', ['affected', 'mjs', 'sentinel', 'absent'].join('-') + '.js');
  assert.ok(!fs.existsSync(path.join(affected.REPO_ROOT, absent)), `${absent} has to be absent for this check to mean anything`);
  const { unmatched } = affected.findAffected(affected.REPO_ROOT, [absent]);
  assert.deepEqual(unmatched, [absent], `something in the tree now names ${absent} — give this check a fresh sentinel rather than weakening it`);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall affected checks passed\n');
process.exit(failures ? 1 : 0);
