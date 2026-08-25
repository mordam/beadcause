#!/usr/bin/env node
//
// b7e-claims — every external assertion about a file, before you change it (bc-dgx7.60).
//
//   npm test
//   node test/b7eclaims.mjs
//
// The mechanism (lib/corpus.js, lib/probes.js) is proven against a fabricated fixture
// tree that mirrors the shape deluvia's scripts/check_saga_audit.py actually uses — a
// `check(id, desc, cond)` call, a docstring naming its own section id, a `# TAG -- ...`
// module comment, an ALL_CAPS constant compared inside an enumeration over a directory —
// rather than against the live deluvia checkout, which is a separate repo on this
// machine that this suite must still pass without (CI has no deluvia checkout at all,
// and several other worker sessions edit it concurrently even when it is present).
//
// This session DID also run the command against the real, current deluvia repo
// (read-only, via --dir) to check the bead's own acceptance criteria before writing this
// fixture — see the debrief on bc-dgx7.60 for what it found. One of the two examples the
// bead quotes verbatim (`reference/deluvia.archaeo-anthro-overview.md`) turned out to
// name a file that resolved dv-6cn's own finding by being renamed — it does not exist on
// deluvia's current main — so it is deliberately not asserted here as a live example,
// per [[b7e-bead-grep-history-is-narrative-not-spec]]: a bead's quoted session narrative
// describes what happened once, not a live spec to re-assert forever. The other example
// (`LORE_PROPOSAL_electric_universe.md`, S5.2's `UNREFERENCED = 14`) was independently
// verified true against deluvia's current main and reproduced structurally below with a
// fixture instead of a live dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-claims');

const { classifyTarget, sentenceAround, markdownFiles, pythonFiles, claimsInProse } = await import(path.join(ROOT, 'lib', 'corpus.js'));
const { claimsInPython, numericLiteralsAtRisk } = await import(path.join(ROOT, 'lib', 'probes.js'));

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

console.log('\nb7e-claims\n');

/* ---------------------------------------------------------------- classifyTarget */

check('a /-bearing argument is a path target, matched by itself, its basename and its stem', () => {
  const t = classifyTarget('reference/LORE_PROPOSAL_electric_universe.md');
  assert.equal(t.kind, 'path');
  assert.deepEqual(t.needles.sort(), ['LORE_PROPOSAL_electric_universe', 'LORE_PROPOSAL_electric_universe.md', 'reference/LORE_PROPOSAL_electric_universe.md'].sort());
});

check('a bare filename is a basename target', () => {
  const t = classifyTarget('ORPHAN_FILE.md');
  assert.equal(t.kind, 'basename');
  assert.deepEqual(t.needles.sort(), ['ORPHAN_FILE', 'ORPHAN_FILE.md'].sort());
});

check('TAG+digits is a section target, not a basename', () => {
  const t = classifyTarget('S5.1');
  assert.equal(t.kind, 'section');
  assert.deepEqual(t.needles, ['S5.1']);
});

check('B10 (no dot) is also a section target', () => {
  assert.equal(classifyTarget('B10').kind, 'section');
});

/* ------------------------------------------------------------------ sentenceAround */

check('sentenceAround isolates just the sentence containing the match', () => {
  const line = 'The old name is retired. The new one, reference/REAL_WORLD_EVIDENCE.md, replaces it. Nothing else changed.';
  const idx = line.indexOf('REAL_WORLD_EVIDENCE');
  assert.equal(sentenceAround(line, idx), 'The new one, reference/REAL_WORLD_EVIDENCE.md, replaces it.');
});

check('sentenceAround falls back to the whole trimmed line when there is no sentence punctuation', () => {
  const line = '  - reference/REAL_WORLD_EVIDENCE.md — Real-world evidence and references';
  const idx = line.indexOf('REAL_WORLD_EVIDENCE');
  assert.equal(sentenceAround(line, idx), line.trim());
});

/* ------------------------------------------------------------------------- fixture */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-claims-'));
const write = (rel, text) => {
  const abs = path.join(tmp, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
};

// A reference/ file two other markdown docs quote by name (so it is NOT an orphan in
// this fixture's own corpus), plus a python gate that (a) names it directly by string
// literal under one check id, and (b) — the S5.2 trap — enumerates every markdown file
// under reference/ and compares a count to an ALL_CAPS constant, WITHOUT ever naming
// this file's basename anywhere in that second function. b7e-claims must still flag
// that constant as at risk: editing this file's referencedness elsewhere is exactly what
// moves it, whether or not the file is currently one of the ones counted.
write('reference/ORPHAN_FILE.md', '# Orphan\n\nSome content nothing here needs to quote back.\n');
write('docs/NOTES.md', ['Retired chronology.', '', 'See reference/ORPHAN_FILE.md for the evidence half; S1 is what checks it now.', '', 'Unrelated closing note.'].join('\n'));
write('scripts/check_fixture.py', [
  'import os',
  '',
  '# S2 -- reference files nothing else names.',
  'REFCOUNT = 3',
  '',
  '',
  'def check_named(root):',
  '    """S1 -- direct mention of the fixture file."""',
  '    check("S1", "orphan file exists", os.path.exists(os.path.join(root, "reference", "ORPHAN_FILE.md")))',
  '',
  '',
  'def check_unreferenced(root):',
  '    """S2 -- orphan count, over the same directory, naming no file directly."""',
  '    refdir = os.path.join(root, "reference") + os.sep',
  '    files = []',
  '    orphans = []',
  '    for p in files:',
  '        if not p.endswith(".md"):',
  '            continue',
  '        orphans.append(p)',
  '    check("S2", "%d orphans" % REFCOUNT, len(orphans) == REFCOUNT)',
  '',
].join('\n'));
// A decoy under a directory that is never walked — proves the tree-wide walk still
// respects the same exclusions lib/cites.js settled on, even though this walker is its
// own copy (deluvia's own directory names rule out reusing the fixed ROOT_DIRS list).
write('node_modules/dep/README.md', 'reference/ORPHAN_FILE.md leaked in here it must not count\n');
write('.claude/worktrees/x/docs/NOTES.md', 'reference/ORPHAN_FILE.md also leaked in a sibling worktree copy\n');

console.log('\nlib/corpus.js and lib/probes.js, called directly');

check('markdownFiles and pythonFiles walk the whole tree but skip node_modules/.claude', () => {
  const md = markdownFiles(tmp);
  const py = pythonFiles(tmp);
  assert.deepEqual(md.sort(), ['docs/NOTES.md', 'reference/ORPHAN_FILE.md'].sort());
  assert.deepEqual(py, ['scripts/check_fixture.py']);
});

check('claimsInProse finds the path target, with the sentence', () => {
  const rows = claimsInProse(tmp, markdownFiles(tmp), classifyTarget('reference/ORPHAN_FILE.md'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].file, 'docs/NOTES.md');
  assert.match(rows[0].sentence, /^See reference\/ORPHAN_FILE\.md for the evidence half;/);
});

check('claimsInPython attributes the literal mention to its own check id, not the module comment', () => {
  const rows = claimsInPython(tmp, pythonFiles(tmp), classifyTarget('reference/ORPHAN_FILE.md'));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].checkId, 'S1');
  assert.match(rows[0].text, /check\("S1", "orphan file exists"/);
});

check('numericLiteralsAtRisk finds S2 REFCOUNT even though S2 never names the file', () => {
  const target = classifyTarget('reference/ORPHAN_FILE.md');
  const rows = numericLiteralsAtRisk(tmp, pythonFiles(tmp), target, markdownFiles(tmp));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].constName, 'REFCOUNT');
  assert.equal(rows[0].constValue, '3');
  assert.equal(rows[0].checkId, 'S2');
});

check('a bare basename resolves its own directory to run the same numeric-literal check', () => {
  const target = classifyTarget('ORPHAN_FILE.md');
  const rows = numericLiteralsAtRisk(tmp, pythonFiles(tmp), target, markdownFiles(tmp));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].constName, 'REFCOUNT');
});

check('a section id target finds both its docstring line and its check() call, not the sibling S2', () => {
  const rows = claimsInPython(tmp, pythonFiles(tmp), classifyTarget('S1'));
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.checkId === 'S1'));
});

/* ------------------------------------------------------------------------- the CLI */

console.log('\nthe real command, spawned');

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { cwd: ROOT, encoding: 'utf8' });

check('a path target prints all three groups', () => {
  const r = run(['reference/ORPHAN_FILE.md', '--dir', tmp]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROSE CLAIMS \(1\)/);
  assert.match(r.stdout, /GATE PROBES \(1\)/);
  assert.match(r.stdout, /NUMERIC LITERALS AT RISK \(1\)/);
  assert.match(r.stdout, /docs\/NOTES\.md:3/);
  assert.match(r.stdout, /scripts\/check_fixture\.py:9 \[S1\]/);
  assert.match(r.stdout, /REFCOUNT = 3/);
});

check('--json prints one object per row, tagged by group', () => {
  const r = run(['reference/ORPHAN_FILE.md', '--dir', tmp, '--json']);
  assert.equal(r.status, 0, r.stderr);
  const rows = r.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(rows.filter((x) => x.group === 'prose').length, 1);
  assert.equal(rows.filter((x) => x.group === 'gate').length, 1);
  assert.equal(rows.filter((x) => x.group === 'numeric').length, 1);
});

check('a target nothing claims returns all three groups empty and still exits 0', () => {
  const r = run(['NothingNamesThisAnywhereXyz.md', '--dir', tmp]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PROSE CLAIMS \(0\)/);
  assert.match(r.stdout, /GATE PROBES \(0\)/);
  assert.match(r.stdout, /NUMERIC LITERALS AT RISK \(0\)/);
});

check('bare invocation exits non-zero and prints usage', () => {
  const r = run([]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /b7e-claims <path\|basename\|section-id>/);
});

check('--help exits 0 and prints usage', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-claims <path\|basename\|section-id>/);
});

check('an unrecognised flag is refused', () => {
  const r = run(['x', '--nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised flag/);
});

await cleanupTmp(tmp);

/* --------------------------------------------------------------------------- done */

console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
