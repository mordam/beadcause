#!/usr/bin/env node
//
// b7e-rebaseline — a gate's own "expected X — got Y" turned into the edit, everywhere X is
// written (bc-dgx7.76). Five sessions (dv-gr6.41, dv-gr6.43, dv-b5d.4.3, dv-3rn.1,
// dv-b5d.14) each hand-propagated a re-measured number into a script and the doc that
// mirrors it, five different ways; this is that command.
//
//   npm test
//   node test/b7erebaseline.mjs
//
// Two kinds of proof, the same split test/count.mjs and test/b7echecks.mjs use: the
// parsing, anchoring and rewriting in lib/rebaseline.js are exercised directly against
// fabricated gate output and small trees, and then bin/b7e-rebaseline is driven as a real
// subprocess against a fabricated repo (lib/fixture.js) whose scripts/check_saga_audit.py
// prints dv-gr6.41's own three FAIL lines verbatim — same expected values, same measured
// values, same constants, same two doc tables — with a real python3 child, exactly as
// test/b7echecks.mjs already assumes python3 is present.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildFixture } from '../lib/fixture.js';
import {
  anchored,
  anchorsFor,
  applyPlan,
  bucketFor,
  buildPlan,
  collectFailures,
  definitionSite,
  findSites,
  formatLike,
  numberTokens,
  parseFailures,
  scriptPathsOf,
} from '../lib/rebaseline.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-rebaseline');

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

console.log('\nb7e-rebaseline\n');

/* =========================================================== parsing a gate's output */

// dv-gr6.41's own three FAIL lines, verbatim from the bead.
const GR641 = [
  'FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536',
  'FAIL [S3.1] total shortfall == 25198 -- got 24752',
  'FAIL [S3.2] Ch 4 delta == +2499 -- got +2945',
].join('\n');

check('parseFailures: reads dv-gr6.41\'s three pairs off its own FAIL lines', () => {
  const { pairs, unparsed } = parseFailures(GR641, { check: 'scripts/check_saga_audit.py' });
  assert.equal(pairs.length, 3, `expected 3 pairs, got ${pairs.length}`);
  assert.deepEqual(
    pairs.map((p) => [p.checkId, p.label, p.expected, p.measured]),
    [
      ['S3.1', 'Ch 4 prose words', '4090', '4536'],
      ['S3.1', 'total shortfall', '25198', '24752'],
      ['S3.2', 'Ch 4 delta', '+2499', '+2945'],
    ]
  );
  assert.deepEqual(unparsed, []);
});

check('parseFailures: "expected X, got Y" and "want X ... got Y" are the same pair', () => {
  const out = [
    'FAIL [S9.1] widgets: expected 12, got 14',
    'ERROR [S9.2] gizmos — want 7 but got 9',
  ].join('\n');
  const { pairs } = parseFailures(out);
  assert.deepEqual(
    pairs.map((p) => [p.checkId, p.expected, p.measured]),
    [
      ['S9.1', '12', '14'],
      ['S9.2', '7', '9'],
    ]
  );
});

check('parseFailures: the pair is never matched across a third number on the line', () => {
  const { pairs } = parseFailures('FAIL [S1] expected 4090 -- got 4536 (was 4001)');
  assert.equal(pairs[0].measured, '4536', `matched the wrong half: ${JSON.stringify(pairs[0])}`);
});

check('parseFailures: a failure that is not a pair is out of scope, never a baseline', () => {
  const out = [
    'FAIL [S5.1] dangling pointer: docs/GONE.md referenced from CHAPTER_4',
    'FAIL [S6.2] naming violation: "Athira" spelled "Arthir" in 3 files',
  ].join('\n');
  const { pairs, unparsed } = parseFailures(out, { check: 'scripts/check_saga_audit.py' });
  assert.deepEqual(pairs, []);
  assert.equal(unparsed.length, 2);
  assert.ok(unparsed[0].line.includes('dangling pointer'), unparsed[0].line);
});

check('parseFailures: a tally line is neither a pair nor an out-of-scope finding', () => {
  const { pairs, unparsed } = parseFailures('2 of 9 checks failed');
  assert.deepEqual(pairs, []);
  assert.deepEqual(unparsed, [], `a tally was reported as a finding: ${JSON.stringify(unparsed)}`);
});

check('parseFailures: expected == measured is not stale, whatever the line is called', () => {
  const { pairs } = parseFailures('FAIL [S1] something else about it == 12 -- got 12');
  assert.deepEqual(pairs, []);
});

check('collectFailures: passing checks are never parsed, and duplicates collapse', () => {
  const results = [
    { name: 'scripts/check_a.py', ok: false, out: GR641 },
    { name: 'scripts/check_a.py', ok: false, out: GR641 },
    { name: 'scripts/check_b.py', ok: true, out: 'FAIL [S3.1] Ch 4 prose words == 1 -- got 2' },
  ];
  const { pairs } = collectFailures(results);
  assert.equal(pairs.length, 3, `expected the 3 from the failing check only, got ${pairs.length}`);
  assert.ok(pairs.every((p) => p.check === 'scripts/check_a.py'));
});

/* ========================================================= number tokens and format */

check('numberTokens: a trailing comma in a dict literal is not a thousands group', () => {
  // The first thing that bit: `4: 4090,` — a `[\d,]*` number rule reads the trailing
  // comma as the start of a group and loses the token entirely.
  const toks = numberTokens('    4: 4090,');
  assert.deepEqual(toks.map((t) => t.text), ['4', '4090']);
});

check('numberTokens: a grouped number is one token, and its parts are not', () => {
  const toks = numberTokens('| 4 | 4,090 | 25,198 |');
  assert.deepEqual(toks.map((t) => t.text), ['4', '4,090', '25,198']);
  assert.deepEqual(toks.map((t) => t.value), [4, 4090, 25198]);
});

check('numberTokens: never inside a longer number, an identifier or a section id', () => {
  // `40901` is a number in its own right and is reported as one — what must never happen
  // is 4090 being *found inside* it, or inside `v1.4090`, or `S3.1` yielding a 3 and a 1.
  const toks = numberTokens('S3.1 40901 v1.4090 CH4');
  assert.deepEqual(toks.map((t) => t.text), ['40901']);
  assert.ok(!toks.some((t) => t.value === 4090), JSON.stringify(toks));
});

check('numberTokens: a signed number keeps its sign', () => {
  assert.deepEqual(numberTokens('delta +2499 and -17').map((t) => t.text), ['+2499', '-17']);
});

check('formatLike: grouping and an explicit + survive the rewrite', () => {
  assert.equal(formatLike('4,090', 4536), '4,536');
  assert.equal(formatLike('4090', 4536), '4536');
  assert.equal(formatLike('+2499', 2945), '+2945');
  assert.equal(formatLike('+2,499', 2945), '+2,945');
  assert.equal(formatLike('25198', -3), '-3');
});

/* ==================================================================== anchoring */

check('anchorsFor: the label\'s words and its qualifier number, never the value itself', () => {
  const [pair] = parseFailures('FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536').pairs;
  const a = anchorsFor(pair);
  assert.equal(a.checkId, 's3.1');
  assert.deepEqual(a.words, ['prose', 'words']);
  assert.deepEqual(a.qualifiers, ['4']);
});

check('anchored: the check id in a heading is enough on its own', () => {
  const [pair] = parseFailures('FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536').pairs;
  assert.equal(anchored(anchorsFor(pair), '## S3.1 Prose words by chapter').ok, true);
});

check('anchored: a label word without the qualifier number is not enough', () => {
  const [pair] = parseFailures('FAIL Ch 4 prose words == 4090 -- got 4536').pairs;
  const a = anchorsFor(pair);
  assert.equal(anchored(a, 'prose words for chapter 9').ok, false, 'chapter 9 was anchored to the chapter 4 check');
  assert.equal(anchored(a, 'prose words for chapter 4').ok, true);
});

check('anchored: an unrelated sentence carrying the same number anchors nothing', () => {
  const [pair] = parseFailures('FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536').pairs;
  assert.equal(anchored(anchorsFor(pair), 'The village census counted 4090 households.').ok, false);
});

check('bucketFor: the script, the doc it mirrors, a selftest fixture, elsewhere', () => {
  const scripts = new Set(['scripts/check_saga_audit.py']);
  assert.equal(bucketFor('scripts/check_saga_audit.py', scripts), 'script');
  assert.equal(bucketFor('ai-context/audits/SAGA_READINESS_AUDIT_2026-08-10.md', scripts), 'doc');
  assert.equal(bucketFor('tests/test_check_saga_audit.py', scripts), 'selftest');
  assert.equal(bucketFor('src/app.py', scripts), 'elsewhere');
});

check('scriptPathsOf: a manifest check\'s own file, judge suffix and all', () => {
  const paths = scriptPathsOf([
    { name: 'scripts/check_saga_audit.py', argv: ['scripts/check_saga_audit.py', '.'] },
    { name: 'scripts/studio_status.py (DRIFT)', argv: ['scripts/studio_status.py', '.', '--json'] },
  ]);
  assert.deepEqual([...paths].sort(), ['scripts/check_saga_audit.py', 'scripts/studio_status.py']);
});

/* ============================================================ finding and rewriting */

const tmpTree = (name, files) => {
  const dir = path.join(fs.mkdtempSync(path.join(fs.realpathSync(process.env.TMPDIR || '/tmp'), 'b7e-rebaseline-')), name);
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
};

check('findSites: only anchored sites are in the plan; the rest are reported, not touched', () => {
  const dir = tmpTree('sites', {
    'scripts/check_saga_audit.py': '# [S3.1] Ch 4 prose words\nPROSE_WORDS = {\n    4: 4090,\n}\n',
    'audit.md': '## S3.1 Prose words by chapter\n\n| Chapter | Prose words |\n| --- | --- |\n| 4 | 4,090 |\n',
    'unrelated.md': 'The village census counted 4090 households.\n',
  });
  const { pairs } = parseFailures('FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536');
  const [sites] = findSites(dir, pairs, { scriptPaths: new Set(['scripts/check_saga_audit.py']) });
  const rewritten = sites.filter((s) => s.associated && !s.ambiguous);
  assert.deepEqual(
    rewritten.map((s) => `${s.file}:${s.line} ${s.oldText}->${s.newText}`).sort(),
    ['audit.md:5 4,090->4,536', 'scripts/check_saga_audit.py:3 4090->4536']
  );
  const held = sites.filter((s) => !s.associated);
  assert.deepEqual(held.map((s) => s.file), ['unrelated.md']);
});

check('findSites: a site two stale assertions disagree about is nobody\'s to rewrite', () => {
  const dir = tmpTree('ambiguous', {
    'audit.md': '## S3.1 prose words and S3.2 delta for chapter 4\n\nBoth read 4090 today.\n',
  });
  const { pairs } = parseFailures(
    ['FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536', 'FAIL [S3.2] Ch 4 delta == 4090 -- got 111'].join('\n')
  );
  const lists = findSites(dir, pairs, {});
  const all = lists.flat();
  assert.ok(all.length >= 2, `expected both assertions to claim the site, got ${all.length}`);
  assert.ok(all.every((s) => s.ambiguous), `a contested site was still planned: ${JSON.stringify(all, null, 1)}`);
});

check('definitionSite: the assigning line in the script, not the doc that mirrors it', () => {
  const dir = tmpTree('definition', {
    'scripts/check_saga_audit.py': '# [S3.1] Ch 4 prose words\nPROSE_WORDS = {\n    4: 4090,\n}\n',
    'audit.md': '## S3.1 Prose words\n\n| 4 | 4,090 |\n',
  });
  const { pairs } = parseFailures('FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536');
  const [sites] = findSites(dir, pairs, { scriptPaths: new Set(['scripts/check_saga_audit.py']) });
  const def = definitionSite(sites);
  assert.equal(def.file, 'scripts/check_saga_audit.py');
  assert.equal(def.line, 3);
});

check('applyPlan: rewrites bottom-up, and refuses a file that has moved under it', () => {
  const dir = tmpTree('apply', {
    'a.md': '## S3.1 prose words for chapter 4\n\nboth 4090 and 4090 on one line\n',
  });
  const { pairs } = parseFailures('FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536');
  const plan = buildPlan(dir, [{ name: 'g', ok: false, out: 'FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536' }], {});
  assert.equal(plan.edits.length, 2, `expected both occurrences on the line, got ${plan.edits.length}`);
  const wrote = applyPlan(plan);
  assert.equal(wrote.applied, 2);
  assert.equal(
    fs.readFileSync(path.join(dir, 'a.md'), 'utf8').split('\n')[2],
    'both 4536 and 4536 on one line'
  );

  // Now the same plan again, against a file that no longer reads that way.
  const second = applyPlan(plan);
  assert.equal(second.applied, 0);
  assert.equal(second.refused.length, 1, `a stale plan was applied anyway: ${JSON.stringify(second)}`);
  assert.ok(second.refused[0].why.includes('re-run the plan'), second.refused[0].why);
  assert.equal(pairs.length, 1);
});

/* ================================================= the real command, a real python3 */

console.log('\nbin/b7e-rebaseline against a real gate script\n');

const words = (n) => `${Array.from({ length: n }, () => 'word').join(' ')}\n`;

// dv-gr6.41's own numbers. Chapter 4 now measures 4536 words where the gate still expects
// 4090; the totals fall out of that: shortfall 32527 - (4536 + 3239) = 24752 against a
// written 25198, and the propagation delta 4536 - 1591 = +2945 against a written +2499.
const CHECK_PY = `#!/usr/bin/env python3
"""The shape deluvia's scripts/check_saga_audit.py has: constants a doc mirrors."""
import pathlib
import sys

ROOT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else '.')

# [S3.1] prose words by chapter
PROSE_WORDS = {
    4: 4090,
    5: 3239,
}
# [S3.1] total shortfall against the target
SHORTFALL = 25198
TARGET = 32527
# [S3.2] propagation delta by chapter
PROP_DELTA = {
    4: +2499,
}
PRE_PROPAGATION = 1591


def words(n):
    return len((ROOT / 'novel' / ('CHAPTER_%d.propagated.md' % n)).read_text().split())


bad = 0
for ch, expected in sorted(PROSE_WORDS.items()):
    got = words(ch)
    if got != expected:
        print("FAIL [S3.1] Ch %d prose words == %d -- got %d" % (ch, expected, got))
        bad += 1

shortfall = TARGET - sum(words(ch) for ch in PROSE_WORDS)
if shortfall != SHORTFALL:
    print("FAIL [S3.1] total shortfall == %d -- got %d" % (SHORTFALL, shortfall))
    bad += 1

for ch, expected in sorted(PROP_DELTA.items()):
    got = words(ch) - PRE_PROPAGATION
    if got != expected:
        print("FAIL [S3.2] Ch %d delta == %+d -- got %+d" % (ch, expected, got))
        bad += 1

print("%d of 3 assertions did not hold" % bad if bad else "ok")
sys.exit(1 if bad else 0)
`;

const AUDIT_MD = `# Saga readiness audit — 2026-08-10

## S3.1 Prose words by chapter

| Chapter | Prose words |
| --- | --- |
| 4 | 4,090 |
| 5 | 3,239 |

Total shortfall against the target: 25,198 words.

## S3.2 Propagation delta by chapter

| Chapter | Delta |
| --- | --- |
| 4 | +2,499 |
`;

const file = (p, content) => ({ type: 'file', path: p, content });
const commit = (message = 'commit') => ({ type: 'commit', message });

const fx = buildFixture({
  name: 'b7e-rebaseline-saga',
  steps: [
    file('scripts/check_saga_audit.py', CHECK_PY),
    file('novel/CHAPTER_4.propagated.md', words(4536)),
    file('novel/CHAPTER_5.propagated.md', words(3239)),
    file('ai-context/audits/SAGA_READINESS_AUDIT_2026-08-10.md', AUDIT_MD),
    file('tests/test_check_saga_audit.py', 'def test_ch4():\n    assert PROSE_WORDS[4] == 4090\n'),
    file('docs/VILLAGE.md', 'The village census counted 4090 households in the spring.\n'),
    commit('saga fixture, chapter 4 already regrown'),
  ],
});

const run = (args, opts = {}) =>
  spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', ...opts });

const gitStatus = (dir) =>
  execFileSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .map((l) => l.slice(3))
    .sort();

let dry;
check('--dry (the default) names all three stale assertions and touches nothing', () => {
  dry = run(['--dir', fx.dir, '--json']);
  assert.equal(dry.status, 0, `exit ${dry.status}\n${dry.stderr}`);
  const plan = JSON.parse(dry.stdout.trim().split('\n').pop());
  assert.equal(plan.gate.ok, false);
  assert.deepEqual(
    plan.checks.map((c) => `${c.checkId} ${c.label} ${c.expected}->${c.measured}`).sort(),
    [
      'S3.1 Ch 4 prose words 4090->4536',
      'S3.1 total shortfall 25198->24752',
      'S3.2 Ch 4 delta +2499->+2945',
    ]
  );
  assert.deepEqual(gitStatus(fx.dir), [], '--dry wrote to the tree');
});

check('the plan names the script constants and both doc tables, in their buckets', () => {
  const plan = JSON.parse(dry.stdout.trim().split('\n').pop());
  const rewritten = plan.checks.flatMap((c) => c.sites.filter((s) => s.rewritten).map((s) => `${s.bucket} ${s.file}:${s.line} ${s.old}->${s.new}`));
  const doc = 'ai-context/audits/SAGA_READINESS_AUDIT_2026-08-10.md';
  for (const want of [
    `script scripts/check_saga_audit.py:10 4090->4536`,
    `script scripts/check_saga_audit.py:14 25198->24752`,
    `script scripts/check_saga_audit.py:18 +2499->+2945`,
    `doc ${doc}:7 4,090->4,536`,
    `doc ${doc}:10 25,198->24,752`,
    `doc ${doc}:16 +2,499->+2,945`,
    `selftest tests/test_check_saga_audit.py:2 4090->4536`,
  ]) {
    assert.ok(rewritten.includes(want), `missing from the plan: ${want}\ngot:\n  ${rewritten.join('\n  ')}`);
  }
});

check('an unrelated 4090 elsewhere in the tree is reported, never planned', () => {
  const plan = JSON.parse(dry.stdout.trim().split('\n').pop());
  const village = plan.checks.flatMap((c) => c.sites.filter((s) => s.file === 'docs/VILLAGE.md'));
  assert.equal(village.length, 1, 'the unrelated site was not reported at all');
  assert.equal(village[0].rewritten, false, 'the village census was going to be rewritten');
});

check('the definition site is the constant in the script', () => {
  const plan = JSON.parse(dry.stdout.trim().split('\n').pop());
  const prose = plan.checks.find((c) => c.label === 'Ch 4 prose words');
  assert.deepEqual(prose.definition, { file: 'scripts/check_saga_audit.py', line: 10 });
});

check('--only narrows to one assertion and leaves the others alone', () => {
  const r = run(['--dir', fx.dir, '--only', 'S3.2', '--json']);
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.deepEqual(plan.checks.map((c) => c.checkId), ['S3.2']);
  assert.equal(plan.skipped, 2);
});

check('--write makes the gate green in one pass, with no other file touched', () => {
  const r = run(['--dir', fx.dir, '--write', '--json']);
  assert.equal(r.status, 0, `exit ${r.status}\n${r.stdout}\n${r.stderr}`);
  const plan = JSON.parse(r.stdout.trim().split('\n').pop());
  assert.equal(plan.after.ok, true, `the gate is still red: ${JSON.stringify(plan.after)}`);
  assert.deepEqual(gitStatus(fx.dir), [
    'ai-context/audits/SAGA_READINESS_AUDIT_2026-08-10.md',
    'scripts/check_saga_audit.py',
    'tests/test_check_saga_audit.py',
  ]);
});

check('the doc kept its comma grouping and its explicit +', () => {
  const doc = fs.readFileSync(path.join(fx.dir, 'ai-context/audits/SAGA_READINESS_AUDIT_2026-08-10.md'), 'utf8');
  assert.ok(doc.includes('| 4 | 4,536 |'), doc);
  assert.ok(doc.includes('Total shortfall against the target: 24,752 words.'), doc);
  assert.ok(doc.includes('| 4 | +2,945 |'), doc);
  assert.ok(doc.includes('| 5 | 3,239 |'), 'chapter 5, which never moved, was rewritten');
});

check('a second --write over a green gate is a no-op that says so', () => {
  const r = run(['--dir', fx.dir, '--write']);
  assert.equal(r.status, 0, r.stderr);
  assert.ok(/nothing to re-baseline/.test(r.stdout), r.stdout);
});

/* ---------------------------------------------- a failure that is not a pair at all */

const OUT_OF_SCOPE_PY = `#!/usr/bin/env python3
import sys
print("FAIL [S5.1] dangling pointer: docs/GONE.md referenced from CHAPTER_4")
print("FAIL [S3.1] Ch 4 prose words == 4090 -- got 4536")
sys.exit(1)
`;

const fxBad = buildFixture({
  name: 'b7e-rebaseline-outofscope',
  steps: [
    file('scripts/check_pointers.py', OUT_OF_SCOPE_PY),
    file('notes.md', '## S3.1 Ch 4 prose words\n\n4090\n'),
    commit('a gate that fails about two different kinds of thing'),
  ],
});

check('an out-of-scope failure exits 2 and refuses to write, even alongside a real pair', () => {
  const r = run(['--dir', fxBad.dir, '--write']);
  assert.equal(r.status, 2, `expected exit 2, got ${r.status}\n${r.stdout}\n${r.stderr}`);
  assert.ok(/out of scope/.test(r.stdout), r.stdout);
  assert.ok(/dangling pointer/.test(r.stdout), r.stdout);
  assert.deepEqual(gitStatus(fxBad.dir), [], 'it wrote anyway');
});

/* -------------------------------------------------------------------------- usage */

check('a tree no manifest recognises is refused, not silently rebaselined', () => {
  const empty = buildFixture({ name: 'b7e-rebaseline-nomanifest', steps: [file('README.md', 'nothing here\n'), commit('empty')] });
  const r = run(['--dir', empty.dir]);
  assert.equal(r.status, 2, `exit ${r.status}\n${r.stdout}`);
  assert.ok(/no manifest recognises/.test(r.stderr), r.stderr);
});

check('-w and --dir together, and neither, are both refused', () => {
  assert.equal(run(['-w', 'deluvia', '--dir', '/tmp']).status, 2);
  assert.equal(run([]).status, 2);
});

check('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.ok(/usage: b7e-rebaseline/.test(r.stdout), r.stdout);
});

console.log('');
if (failures) {
  console.log(`${failures} check${failures === 1 ? '' : 's'} failed`);
  process.exit(1);
}
console.log('all checks passed');
