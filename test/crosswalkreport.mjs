#!/usr/bin/env node
//
// Nothing in the matrix is written down, an empty column means what it says, and the
// premise it exists to prove is a number somebody can check — `lib/crosswalkreport.js`.
//
//   npm test
//   node test/crosswalkreport.mjs
//
// bc-4r10.14: a crosswalk matrix is the artefact most likely to be quietly false, because
// nobody reads a cell that is there and everybody reads the summary line. Three ways it
// goes wrong, and the suite is mostly about proving each one is refused.
//
// **A second copy of the edges.** The corpus already holds every crosswalk edge; a matrix
// that restated them would drift within a quarter and be wrong exactly where a buyer looks.
// So no control id appears anywhere in the module — checked against the source — and every
// cell is asserted equal to a declared edge, in both directions.
//
// **Coverage counted the wrong way round.** Edges run from controls to criteria, so inbound
// is coverage and outbound is not. Counting outbound would report both ISO Annex A sets as
// fully covered while saying nothing at all, and the sums below would still add up. There
// is a check for a column with outbound edges and no inbound, because that is the exact
// record the mistake would turn green.
//
// **An empty column read as a gap when it is not one, or as fine when it is.** A declined
// privacy criterion and an Annex A control nobody has ruled on are both empty and neither
// is a finding; a mandatory clause nobody answers is. That is `applicabilityOf`, and it is
// driven here from all four directions.
//
// The pinned numbers at the end are the honest ones for today. If landing a standard, an
// edge or an election changes them, that is the change being deliberate rather than the
// suite being brittle — which is the same argument `test/controls.mjs` makes for its two
// unclaimed lists.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FRAMEWORKS, byFramework, control as corpusRecord, corpus, crosswalk, satisfiedBy } from '../lib/controls.js';
import { ELECTED as POLICY_ELECTED, categoryOf, isElected } from '../lib/policies.js';
import {
  APPLICABILITY,
  DECIDED_BY,
  ELECTED,
  HELD_BY,
  IN_SCOPE,
  OBLIGATION_FRAMEWORKS,
  applicabilityOf,
  cellsFor,
  columns,
  counts,
  csv,
  declined,
  forFramework,
  isObligation,
  matrix,
  reach,
  reportProblems,
  rows,
  shared,
  summarise,
  uncovered,
  undecided,
} from '../lib/crosswalkreport.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------- nothing is written down */

test('no control id appears anywhere in the module', () => {
  // The check that notices a "for reference" list pasted in beside the code, which is how
  // the matrix and the corpus start disagreeing. lib/gapassessment.js makes the same check
  // for the ISO frameworks; here it is every framework, because every cell in this file is
  // derived and there is no legitimate reason to name one.
  const source = fs.readFileSync(path.join(root, 'lib/crosswalkreport.js'), 'utf8');
  const shapes = new RegExp(`\\b(?:${Object.keys(FRAMEWORKS).join('|')})\\.[A-Za-z0-9.]+`, 'g');
  assert.deepEqual(source.match(shapes) || [], []);
});

test('the module joins two registers and reaches for nothing else', () => {
  // The compliance leaves deliberately do not import each other, so anything needing two of
  // them is a file of its own — and the file is pinned to the two it needs. A description of
  // Climative's system that reached into lib/incident.js would be reporting a beadcause
  // daemon crash as an in-scope incident; the same rule, one module along.
  const source = fs.readFileSync(path.join(root, 'lib/crosswalkreport.js'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '(\.\/[^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./controls.js', './policies.js']);
});

test('the election is read, never copied', () => {
  assert.deepEqual(ELECTED, POLICY_ELECTED);
  assert.equal(HELD_BY, 'climative');
  assert.deepEqual(DECIDED_BY, { categories: 'bc-yfgo', applicability: 'bc-eqn1.14' });
});

/* ------------------------------------------------------------- rows and columns */

test('a column is an obligation and guidance is never one', () => {
  const cols = columns();
  assert.ok(cols.length > 0);
  for (const c of cols) assert.ok(FRAMEWORKS[c.framework].certifiable, `${c.id} is a column and nobody is certified against it`);
  for (const token of Object.keys(FRAMEWORKS)) {
    if (FRAMEWORKS[token].certifiable) continue;
    assert.deepEqual(forFramework(token), [], `${token} is guidance and has columns`);
    for (const record of byFramework(token)) assert.equal(isObligation(record), false);
  }
  // Derived from the corpus rather than listed, so a framework added there cannot be
  // silently invisible here.
  assert.deepEqual(OBLIGATION_FRAMEWORKS, Object.keys(FRAMEWORKS).filter((t) => FRAMEWORKS[t].certifiable));
});

test('a criterion is never a row, and guidance is', () => {
  const rs = rows();
  assert.equal(rs.filter((r) => r.kind === 'criterion').length, 0, 'the corpus refuses a criterion an edge; one appearing as a row is a bug here');
  assert.ok(rs.some((r) => r.guidance), 'guidance elaborates controls and belongs in the picture');
  for (const r of rs) assert.ok(r.covers.length > 0, `${r.id} is a row and claims nothing`);
  assert.equal(rs.length, [...corpus().ids.values()].filter((r) => r.crosswalk.length).length);
});

test("a guidance row's own standard is not counted in its span", () => {
  const guidance = rows().find((r) => r.guidance);
  assert.ok(guidance, 'no guidance row to check');
  assert.ok(!guidance.frameworks.includes(guidance.framework), 'nobody is certified against guidance, so it is not a standard answered');
  for (const r of rows()) assert.equal(r.span, r.frameworks.length);
});

/* ------------------------------------------------- every cell is a declared edge */

test('the matrix restates nothing — cells and corpus edges agree in both directions', () => {
  const { cells, columns: cols } = matrix();
  const ids = new Set(cols.map((c) => c.id));
  const seen = new Set();
  for (const { row, column } of cells) {
    assert.ok(crosswalk(row).includes(column), `${row} has a cell at ${column} the corpus does not declare`);
    assert.ok(ids.has(column), `a cell points at ${column}, which is not a column`);
    seen.add(`${row} ${column}`);
  }
  let declaredCells = 0;
  for (const record of corpus().ids.values()) {
    for (const target of record.crosswalk) {
      if (!ids.has(target)) continue;
      declaredCells += 1;
      assert.ok(seen.has(`${record.id} ${target}`), `${record.id} claims ${target} and the matrix has no cell for it`);
    }
  }
  assert.equal(cells.length, declaredCells);
  // Every declared edge in this corpus lands on an obligation, so nothing is dropped today.
  assert.equal(cells.length, corpus().edges);
});

test('a column reports what claims it, exactly as the corpus computes it', () => {
  for (const c of columns()) {
    assert.deepEqual(c.claimedBy, satisfiedBy(c.id));
    assert.deepEqual(c.claims, crosswalk(c.id));
    assert.equal(c.covered, satisfiedBy(c.id).length > 0);
  }
});

test('coverage is inbound and only inbound', () => {
  // The record the mistake would turn green: an Annex A control that claims plenty and that
  // nothing claims back. Counting outbound as coverage reports both ISO sets as complete.
  const outboundOnly = columns().filter((c) => c.claims.length && !c.claimedBy.length);
  assert.ok(outboundOnly.length > 0, 'no outbound-only obligation to check the direction against');
  for (const c of outboundOnly) assert.equal(c.covered, false, `${c.id} claims things and is reported covered`);
});

/* ------------------------------------------------------- what an empty column means */

test('applicability comes from somewhere, for all four answers', () => {
  const claused = columns().find((c) => c.kind === 'clause');
  const control = columns().find((c) => c.kind === 'control');
  const elected = columns().find((c) => c.kind === 'criterion' && isElected(c.id));
  const notElected = columns().find((c) => c.kind === 'criterion' && !isElected(c.id));
  assert.equal(claused.applicability, 'mandatory');
  assert.equal(control.applicability, 'undecided');
  assert.equal(elected.applicability, 'elected');
  assert.equal(notElected.applicability, 'declined');
  assert.deepEqual([...APPLICABILITY].sort(), ['declined', 'elected', 'mandatory', 'undecided']);
  assert.deepEqual(IN_SCOPE, ['elected', 'mandatory']);
  // A record nobody can be certified against has no applicability at all rather than a
  // default — a guidance process silently reported "undecided" would be a column-in-waiting.
  assert.equal(applicabilityOf(corpusRecord(byFramework('ISO5338')[0].id)), null);
  assert.equal(applicabilityOf(null), null);
});

test('election moving moves the answer, with no edit here', () => {
  // Not a mock of lib/policies.js — the assertion is that the two agree on every criterion,
  // so a category leaving ELECTED changes this file's output and nothing else.
  for (const c of columns({ frameworks: ['SOC2'] })) {
    assert.equal(c.applicability, isElected(c.id) ? 'elected' : 'declined');
    assert.equal(c.inScope, ELECTED.includes(categoryOf(c.id)));
  }
});

test('a declined criterion is empty and is not a gap', () => {
  const empty = declined().filter((c) => !c.covered);
  assert.ok(empty.length > 0, 'no empty declined column to check');
  const gaps = new Set(uncovered().map((c) => c.id));
  for (const c of empty) assert.ok(!gaps.has(c.id), `${c.id} was declined and is reported as an uncovered obligation`);
});

test('an undecided control is counted out loud rather than reported as a gap', () => {
  const waiting = undecided();
  assert.ok(waiting.length > 0);
  const gaps = new Set(uncovered().map((c) => c.id));
  for (const c of waiting) {
    assert.equal(c.kind, 'control');
    assert.ok(!gaps.has(c.id), `${c.id} has no statement of applicability and is reported as a gap`);
  }
  assert.equal(counts().applicability.undecided, waiting.length, 'the narrowing has to be visible in the counts');
});

test('uncovered is exactly the in-scope obligations nothing claims', () => {
  const expected = columns()
    .filter((c) => IN_SCOPE.includes(c.applicability) && !c.covered)
    .map((c) => c.id);
  assert.deepEqual(uncovered().map((c) => c.id), expected);
  for (const c of uncovered()) {
    assert.ok(c.inScope);
    assert.deepEqual(satisfiedBy(c.id), []);
  }
});

/* --------------------------------------------------------- indirect reach is labelled */

test('reach follows the edges and is not a cell', () => {
  // Guidance may not claim a criterion directly — the corpus refuses the edge — so the only
  // way that route is answerable at all is transitively, and it must never be a cell.
  const guidance = rows().find((r) => r.guidance && [...reach(r.id)].some((id) => corpusRecord(id).kind === 'criterion'));
  assert.ok(guidance, 'no guidance row reaches a criterion in two hops');
  const direct = cellsFor(guidance.id);
  assert.equal(direct.filter((id) => corpusRecord(id).kind === 'criterion').length, 0, 'guidance claimed a criterion directly');
  const indirect = [...reach(guidance.id)].filter((id) => !direct.includes(id));
  assert.ok(indirect.length > 0);
  assert.ok(indirect.some((id) => corpusRecord(id).kind === 'criterion'));
  const { cells } = matrix();
  for (const id of indirect) {
    assert.ok(!cells.some((cell) => cell.row === guidance.id && cell.column === id), `${guidance.id} has a cell for a two-hop reach`);
  }
});

test('reach terminates and every id it returns resolves', () => {
  for (const r of rows()) {
    for (const id of reach(r.id)) assert.ok(corpusRecord(id), `${r.id} reaches ${id}, which is not in the corpus`);
  }
});

/* -------------------------------------------------------------- narrowing an axis */

test('--framework narrows the axis the verb is about, and only that one', () => {
  const soc2 = columns({ frameworks: ['SOC2'] });
  assert.equal(soc2.length, byFramework('SOC2').length);
  for (const c of soc2) assert.equal(c.framework, 'SOC2');
  // The rows that answer them still come from everywhere, which is the whole point of asking.
  const narrowed = matrix({ frameworks: ['SOC2'] });
  assert.equal(narrowed.rows.length, rows().length);
  assert.ok(new Set(narrowed.cells.map((c) => c.row.split('.')[0])).size > 1);
  assert.deepEqual(columns({ frameworks: ['ISO23894'] }), [], 'guidance has no columns to narrow to');
});

/* ---------------------------------------------------- the checks, seen to fail */

test('reportProblems is silent on the real matrix and fires on a doctored one', () => {
  assert.deepEqual(reportProblems(), []);
  const cols = columns();
  const real = matrix().cells;
  const guidanceRecord = byFramework('ISO23894')[0];
  const fires = (patch, re) => {
    const problems = reportProblems(patch);
    assert.ok(problems.some((p) => re.test(p)), `expected ${re} in ${JSON.stringify(problems)}`);
  };
  fires({ cols: [...cols, cols[0]] }, /appears twice/);
  fires({ cols: [...cols, { ...cols[0], id: guidanceRecord.id, framework: 'ISO23894' }] }, /nobody is certified against ISO23894/);
  fires({ cols: cols.map((c, i) => (i ? c : { ...c, applicability: 'probably' })) }, /has no applicability/);
  fires({ cols: cols.map((c, i) => (i ? c : { ...c, inScope: !c.inScope })) }, /applicability does not say so/);
  fires({ cols: cols.map((c, i) => (i ? c : { ...c, covered: !c.covered })) }, /marked covered against/);
  fires({ cells: real.slice(1) }, /the matrix holds \d+ cells and the corpus declares/);
  fires({ cells: [...real, { row: real[0].row, column: guidanceRecord.id }] }, /is not a column/);
  fires({ cells: [...real, { row: real[0].row, column: cols[cols.length - 1].id }] }, /does not declare/);
});

/* ------------------------------------------------------------------ what it produces */

test('the matrix today is the honest one, and the numbers are pinned', () => {
  const c = counts();
  assert.equal(c.obligations, 224);
  assert.equal(c.rows, 232);
  assert.equal(c.cells, 346);
  assert.equal(c.covered, 113);
  assert.deepEqual(c.applicability, { elected: 38, declined: 23, mandatory: 32, undecided: 131 });
  assert.deepEqual(c.perFramework.SOC2, { obligations: 61, covered: 49, inScope: 38, uncovered: 0 });
  assert.equal(c.allStandards, 29, 'the premise, as a number: 29 records answer all three standards at once');
  assert.deepEqual(c.span, { 1: 67, 2: 136, 3: 29 });
});

test('every elected criterion is claimed, and the uncovered ones are the management system', () => {
  // The finding, and it is not the one a hand-drawn matrix would have shown. Nothing elected
  // is unclaimed — the twelve criteria the corpus leaves unclaimed are all in categories that
  // were declined — and every gap is an ISO/IEC 42001 management-system clause: work no other
  // standard's control does for you.
  assert.equal(counts().perFramework.SOC2.uncovered, 0);
  const gaps = uncovered();
  assert.equal(gaps.length, 14);
  for (const c of gaps) {
    assert.equal(c.kind, 'clause');
    assert.equal(c.applicability, 'mandatory');
  }
});

test('shared is the premise as a list, and defaults to all three standards', () => {
  const all = shared();
  assert.equal(all.length, 29);
  for (const r of all) assert.equal(r.span, OBLIGATION_FRAMEWORKS.length);
  assert.ok(shared(2).length > all.length, 'two standards at once is still reuse and there is more of it');
  assert.equal(shared(1).length, rows().length, 'every row answers at least one standard');
  assert.equal(shared(OBLIGATION_FRAMEWORKS.length + 1).length, 0);
});

test('summarise is one line and says what a reader would otherwise assume', () => {
  assert.match(
    summarise(),
    /^climative · 224 obligations across 3 certifiable standards · 346 crosswalk edges · 29 answer all 3 at once · 14 in scope and unclaimed · 131 awaiting a statement of applicability$/
  );
});

/* ---------------------------------------------------------------------- the grid */

test('the csv is the same computation, and round-trips back to the declared edges', () => {
  const text = csv();
  const lines = text.split('\n');
  const cell = (line) => line.match(/"((?:[^"]|"")*)"/g).map((v) => v.slice(1, -1).replace(/""/g, '"'));
  const header = cell(lines[0]);
  const applicability = cell(lines[1]);
  const cols = columns();
  assert.deepEqual(header.slice(4), cols.map((c) => c.id));
  assert.deepEqual(applicability.slice(4), cols.map((c) => c.applicability));
  assert.equal(lines.length, rows().length + 2);
  const marked = new Set();
  for (const line of lines.slice(2)) {
    const values = cell(line);
    values.slice(4).forEach((v, i) => {
      if (v === 'x') marked.add(`${values[0]} ${cols[i].id}`);
      else assert.equal(v, '', 'a grid cell is a cross or it is empty');
    });
  }
  const declaredEdges = new Set(matrix().cells.map((c) => `${c.row} ${c.column}`));
  assert.deepEqual([...marked].sort(), [...declaredEdges].sort());
});

test('a quote in a title cannot break the grid', () => {
  // Every field is quoted and inner quotes are doubled, so a title somebody writes with an
  // apostrophe-and-quote in it stays one cell. Checked on the emitter rather than on a title
  // that happens not to have one today.
  const text = csv({ frameworks: ['SOC2'] });
  for (const line of text.split('\n')) {
    assert.equal((line.match(/"/g) || []).length % 2, 0, 'an odd number of quotes on a line is a broken row');
  }
});

/* ------------------------------------------------------------------- the command */

test('the command reads and renders, and --strict gates on an unclaimed obligation', () => {
  const run = (args) => {
    try {
      const stdio = ['ignore', 'pipe', 'ignore'];
      return { code: 0, out: execFileSync(process.execPath, [path.join(root, 'bin/crosswalk.js'), ...args], { encoding: 'utf8', stdio }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') };
    }
  };
  assert.equal(run(['matrix']).code, 0);
  assert.match(run(['matrix']).out, /29 answer all 3 at once/);
  assert.match(run(['shared']).out, /29 records answer 3 certifiable standards at once/);
  assert.match(run(['uncovered']).out, /14 obligations are in scope/);
  assert.equal(run(['uncovered', '--strict']).code, 1, 'fourteen clauses are unclaimed today');
  assert.equal(run(['uncovered', '--framework', 'SOC2', '--strict']).code, 0, 'nothing elected is unclaimed');
  assert.match(run(['undecided']).out, /statement that decides it/);
  assert.equal(run(['control', 'SOC2.CC6.1']).code, 0);
  assert.match(run(['control', 'SOC2.CC6.1']).out, /Claimed by/);
  assert.equal(run(['control', 'SOC2.CC99.9']).code, 1, 'an id nobody minted is a refusal');
  assert.equal(run(['matrix', '--framework', 'nonsense']).code, 1);
  assert.equal(run(['nope']).code, 1);
  const json = JSON.parse(run(['matrix', '--json']).out);
  assert.equal(json.columns.length, 224);
  assert.equal(json.cells.length, 346);
  assert.equal(run(['csv']).out.split('\n').length, rows().length + 3, 'two header lines, one per row, and a trailing newline');
});

/* --------------------------------------------------------------------- the runner */

let failed = 0;
for (const [name, fn] of tests) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL  ${name}\n      ${err.message.split('\n').join('\n      ')}`);
  }
}
console.log(`\n${tests.length - failed}/${tests.length} passed`);
process.exit(failed ? 1 : 0);
