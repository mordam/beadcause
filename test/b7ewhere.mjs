#!/usr/bin/env node
//
// b7e-where — every surface a printed figure appears on, and whether they agree
// (bc-dgx7.16).
//
//   npm test
//   node test/b7ewhere.mjs
//
// lib/where.js's pure halves (classification, pattern-building, the walk, the verdict)
// are checked directly; the bin is driven as a real subprocess against fixture trees, the
// same split test/cites.mjs uses and for the same reason — the argv parsing and the exit
// codes are the thing under test there, and calling the lib function directly would prove
// nothing about the CLI wrapper around it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-where');

const { repoRoot, listFiles, classifySurface, isAuditDoc, buildPattern, searchSurfaces, SURFACE_LABELS, SURFACE_ORDER } =
  await import(path.join(ROOT, 'lib', 'where.js'));

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nb7e-where\n');

/* ------------------------------------------------------------------ classifySurface */

check('classifySurface: a path under test/ or tests/ is tests, regardless of extension', () => {
  assert.equal(classifySurface('tests/test_costing.py'), 'tests');
  assert.equal(classifySurface('test/foo.mjs'), 'tests');
  assert.equal(classifySurface('a/b/tests/README.md'), 'tests'); // a fixture doc still counts as tests
  assert.equal(classifySurface('a/b/tests/page.html'), 'tests');
});

check('classifySurface: test_*.py / *_test.py / *.spec.js filenames are tests even outside a tests/ dir', () => {
  assert.equal(classifySurface('scripts/test_helpers.py'), 'tests');
  assert.equal(classifySurface('src/costing_test.py'), 'tests');
  assert.equal(classifySurface('src/widget.spec.js'), 'tests');
});

check('classifySurface: .md/.rst is docs', () => {
  assert.equal(classifySurface('README.md'), 'docs');
  assert.equal(classifySurface('docs/plan_set_number_audit.md'), 'docs');
  assert.equal(classifySurface('docs/notes.rst'), 'docs');
});

check('classifySurface: .html or a static/public/pages/templates directory is served markup', () => {
  assert.equal(classifySurface('webapp/pages/arch.html'), 'servedMarkup');
  assert.equal(classifySurface('webapp/static/img/plan.svg'), 'servedMarkup');
  assert.equal(classifySurface('public/index.html'), 'servedMarkup');
  assert.equal(classifySurface('templates/base.jinja2'), 'servedMarkup');
});

check('classifySurface: everything else is source', () => {
  assert.equal(classifySurface('costing.py'), 'source');
  assert.equal(classifySurface('webapp/engine.py'), 'source'); // .py under webapp/, not under pages/static
  assert.equal(classifySurface('lib/where.js'), 'source');
});

check('isAuditDoc: a docs file with "audit" in its name, and only a docs file', () => {
  assert.ok(isAuditDoc('docs/plan_set_number_audit.md'));
  assert.ok(!isAuditDoc('docs/end-wall-design.md'));
  assert.ok(!isAuditDoc('tests/test_audit.py')); // classifies as tests, not docs — not the ledger
});

/* --------------------------------------------------------------------- buildPattern */

check('buildPattern: literal by default, regex metacharacters escaped', () => {
  const re = buildPattern('PRICES["beam_2x10_lf"]');
  assert.ok(re.test('x = PRICES["beam_2x10_lf"]'));
  assert.ok(!re.test('PRICES[Xbeam2x10lfX]'));
});

check('buildPattern: x, X and × all match each other — the bead\'s own requirement', () => {
  const re = buildPattern('2x10');
  assert.ok(re.test('a 2x10 beam'));
  assert.ok(re.test('a 2×10 beam'), 'the audit-doc/E-sheet spelling must match too');
  assert.ok(re.test('a 2X10 beam'));
  const re2 = buildPattern('2×10'); // querying with the × spelling finds the x spelling too
  assert.ok(re2.test('a 2x10 beam'));
});

check('buildPattern: --regex mode compiles term as a real RegExp', () => {
  const re = buildPattern('PILE_ULS_KN\\s*=\\s*\\d+', { regex: true });
  assert.ok(re.test('PILE_ULS_KN = 100.0'));
});

check('buildPattern: a bad --regex pattern throws rather than crashing silently', () => {
  assert.throws(() => buildPattern('(unclosed', { regex: true }));
});

/* --------------------------------------------------------------- listFiles / repoRoot */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-where-'));
const write = (root, rel, text) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

check('listFiles: falls back to a plain walk, skipping node_modules/.git/__pycache__, when root is not a git repo', () => {
  const plain = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-where-plain-'));
  write(plain, 'a.py', 'x = 1\n');
  write(plain, 'node_modules/dep/index.js', 'skip me\n');
  write(plain, '__pycache__/a.pyc', 'skip me\n');
  const files = listFiles(plain);
  assert.deepEqual(files, ['a.py']);
  fs.rmSync(plain, { recursive: true, force: true });
});

const gitTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-where-git-'));
const git = (...args) => execFileSync('git', args, { cwd: gitTmp, stdio: ['ignore', 'pipe', 'pipe'] });
git('init', '-q');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
write(gitTmp, '.gitignore', 'ignored_dir/\n');
write(gitTmp, 'costing.py', 'PRICES = {"beam_2x10_lf": 2.30}\n# comment mentions 2×10 too\n');
write(gitTmp, 'end_wall.py', 'BEAM_D = 9.25  # 3-ply 2x10\n');
write(gitTmp, 'docs/plan_set_number_audit.md', '| S3 | 3ply 2x10 BEAM | derived |\n');
write(gitTmp, 'docs/other.md', 'nothing relevant here\n');
write(gitTmp, 'tests/test_costing.py', 'assert "2x10" in item\n');
write(gitTmp, 'webapp/pages/arch.html', '<td>3-ply 2×10 on piles</td>\n');
write(gitTmp, 'ignored_dir/should_not_appear.py', '2x10 must never be found here\n');
git('add', '-A');
git('commit', '-q', '-m', 'fixture');
// an uncommitted, untracked file — must still be found (a session's own unsaved edits)
write(gitTmp, 'uncommitted.py', 'a fresh 2x10 nobody has committed yet\n');

check('repoRoot resolves a git worktree to its own top level', () => {
  assert.equal(fs.realpathSync(repoRoot(gitTmp)), fs.realpathSync(gitTmp));
});

check('listFiles honours .gitignore and includes untracked-but-not-ignored files', () => {
  const files = listFiles(gitTmp);
  assert.ok(files.includes('costing.py'));
  assert.ok(files.includes('uncommitted.py'), 'an unsaved edit must still be searchable');
  assert.ok(!files.includes('ignored_dir/should_not_appear.py'), '.gitignore must be honoured');
});

/* ------------------------------------------------------------------------ searchSurfaces */

check('searchSurfaces: groups hits by surface, in one call, over the fixture repo', () => {
  const r = searchSurfaces(gitTmp, '2x10');
  assert.deepEqual(r.bySurface.source.map((e) => e.file).sort(), ['costing.py', 'end_wall.py', 'uncommitted.py']);
  assert.deepEqual(r.bySurface.tests.map((e) => e.file), ['tests/test_costing.py']);
  assert.deepEqual(r.bySurface.docs.map((e) => e.file), ['docs/plan_set_number_audit.md']);
  assert.deepEqual(r.bySurface.servedMarkup.map((e) => e.file), ['webapp/pages/arch.html']);
});

check('searchSurfaces: the × spelling is found by an x query, and vice versa, without a separate call', () => {
  const r = searchSurfaces(gitTmp, '2x10');
  const costingHits = r.bySurface.source.find((e) => e.file === 'costing.py').hits.map((h) => h.text);
  assert.ok(costingHits.some((t) => t.includes('2×10')), 'a 2x10 query must find the 2×10 comment too');
});

check('searchSurfaces: names the audit-doc row separately when the literal is registered there', () => {
  const r = searchSurfaces(gitTmp, '2x10');
  assert.equal(r.auditDoc.file, 'docs/plan_set_number_audit.md');
  assert.equal(r.auditDoc.hits.length, 1);
});

check('searchSurfaces: no audit doc named when none matches', () => {
  const r = searchSurfaces(gitTmp, 'BEAM_D');
  assert.equal(r.auditDoc, null);
});

check('searchSurfaces: verdict names every surface present with a hit, when all agree', () => {
  const r = searchSurfaces(gitTmp, '2x10');
  assert.equal(r.verdict, '2x10 found on every surface that exists here: source, docs, tests, served markup');
});

check('searchSurfaces: verdict flags a surface that has files but no hit', () => {
  const r = searchSurfaces(gitTmp, 'BEAM_D'); // only in costing.py-adjacent source (end_wall.py)
  assert.match(r.verdict, /found in source — not in docs, tests, served markup/);
});

check('searchSurfaces: verdict says so plainly when nothing matches anywhere', () => {
  const r = searchSurfaces(gitTmp, 'TOTALLY_ABSENT_TOKEN');
  assert.match(r.verdict, /not found on any surface/);
});

check('searchSurfaces: ignored_dir never leaks into a hit, cannot be defeated by an unquoted glob (there is no glob at all)', () => {
  const r = searchSurfaces(gitTmp, '2x10');
  const allFiles = SURFACE_ORDER.flatMap((k) => r.bySurface[k].map((e) => e.file));
  assert.ok(!allFiles.includes('ignored_dir/should_not_appear.py'));
});

/* --------------------------------------------------------------------------- the CLI */

function run(args, cwd = gitTmp) {
  const res = spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', cwd });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-where/);
});

check('no term at all is refused with exit 2', () => {
  const { status, stderr } = run([]);
  assert.equal(status, 2);
  assert.match(stderr, /usage: b7e-where/);
});

check('an unrecognised flag is refused with exit 2', () => {
  const { status, stderr } = run(['2x10', '--bogus']);
  assert.equal(status, 2);
  assert.match(stderr, /unrecognised flag: --bogus/);
});

check('two positional terms are refused — quote it instead', () => {
  const { status, stderr } = run(['2x10', 'PRICES']);
  assert.equal(status, 2);
  assert.match(stderr, /one search term at a time/);
});

check('--dir points the whole run at a fixture tree, printing every surface and the verdict', () => {
  const { status, stdout } = run(['2x10', '--dir', gitTmp], ROOT);
  assert.equal(status, 0);
  assert.match(stdout, /source \(3 files\)/);
  assert.match(stdout, /docs \(1 file\)/);
  assert.match(stdout, /tests \(1 file\)/);
  assert.match(stdout, /served markup \(1 file\)/);
  assert.match(stdout, /audit doc: docs\/plan_set_number_audit\.md/);
  assert.match(stdout, /found on every surface that exists here/);
});

check('--json prints one parseable object with the same shape lib/where.js returns', () => {
  const { status, stdout } = run(['2x10', '--dir', gitTmp, '--json'], ROOT);
  assert.equal(status, 0);
  const obj = JSON.parse(stdout);
  assert.equal(obj.term, '2x10');
  assert.ok(Array.isArray(obj.bySurface.source));
  assert.equal(obj.auditDoc.file, 'docs/plan_set_number_audit.md');
});

check('a literal search for a glob-shaped term is never shell-expanded — no crash, no surprise matches', () => {
  const { status } = run(['*.py', '--dir', gitTmp], ROOT);
  assert.equal(status, 0); // the historical failure mode here was zsh's own "(eval):1: no matches found"
});

check('--regex plus a real pattern finds the assignment line, not just any mention', () => {
  const { status, stdout } = run(['BEAM_D\\s*=\\s*9\\.25', '--regex', '--dir', gitTmp], ROOT);
  assert.equal(status, 0);
  assert.match(stdout, /end_wall\.py:1 /);
});

await cleanupTmp(gitTmp);
fs.rmSync(tmp, { recursive: true, force: true });

/* --------------------------------------------------------------------------- done */

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
