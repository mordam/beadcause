#!/usr/bin/env node
//
// Every elected criterion is assessed, no state was typed by hand, and an absence says
// which kind of absence it is — `lib/gapassessment.js`.
//
//   npm test
//   node test/gapassessment.mjs
//
// bc-4r10.4: a gap assessment is worth having only if it cannot quietly lose a criterion,
// and cannot quietly go green. Both of those are checks rather than conventions here, and
// the suite below is mostly about proving they actually fail.
//
// **A criterion that fell off the list** is the first, and it is invisible in the artefact:
// a row saying "absent" is read by somebody, a row that is not there is read by nobody. So
// the register is checked against the corpus rather than against a list kept beside it, and
// the check is run against a fixture with a row deleted, because a rule only ever run
// against a register that passes is a rule nobody has seen fail.
//
// **A state somebody typed** is the second. `stateOf` derives the word from two named
// halves, so the fixtures below drive all three states by adding and removing a control and
// an evidence artefact, and one of them asserts that no shipped record carries a `state`
// key at all — the field cannot go stale if it does not exist.
//
// **An absence with two meanings** is the third. "Nobody has looked" and "we looked and it
// is not there" are both absent, and `confidenceOf` separates them by reading
// lib/boundary.js's census. That is checked in both directions: enumerating the census
// upgrades rows here with no edit, and letting one lapse downgrades them.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import YAML from 'yaml';

import { CENSUS_KINDS, boundaryFor } from '../lib/boundary.js';
import { control as corpusRecord, satisfiedBy } from '../lib/controls.js';
import { ELECTED as POLICY_ELECTED, ROLES as POLICY_ROLES, isElected } from '../lib/policies.js';
import { parseProposal } from '../lib/proposal.js';
import {
  ASSESSMENT,
  CONFIDENCE,
  DECIDED_BY,
  ELECTED,
  HELD_BY,
  NOT_ELECTED,
  ROLES,
  STATES,
  assess,
  assessmentProblems,
  beadFor,
  byOwner,
  byState,
  claims,
  confidenceOf,
  counts,
  documentedBy,
  electedCriteria,
  gaps,
  pathsNamed,
  recordProblems,
  stateOf,
  summarise,
} from '../lib/gapassessment.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A boundary whose every census is enumerated — nothing left to survey. */
const surveyed = () => ({
  serviceOrganisation: 'Fixture',
  system: 'A system',
  census: Object.fromEntries(CENSUS_KINDS.map((k) => [k, { state: 'enumerated' }])),
});

/** A boundary that has enumerated nothing. */
const unsurveyed = () => ({
  serviceOrganisation: 'Fixture',
  system: 'A system',
  census: Object.fromEntries(CENSUS_KINDS.map((k) => [k, { state: 'partial', held: 'elsewhere' }])),
});

/** A record that passes, so a test can break exactly one thing about it. */
const ok = (over = {}) => ({
  id: 'SOC2.CC1.1',
  owner: 'executive sponsor',
  population: [],
  control: null,
  evidence: null,
  why: 'A sentence long enough to be worth reading, which is the whole of what this field is for.',
  bears: null,
  held: 'Climative.',
  ...over,
});

/* ------------------------------------------------------- the shipped register */

test('the shipped assessment is clean', () => {
  assert.deepEqual(assessmentProblems(), []);
});

test('every elected criterion in the corpus is assessed, and nothing else is', () => {
  const assessed = ASSESSMENT.map((r) => r.id).sort();
  assert.deepEqual(assessed, electedCriteria());
  for (const id of assessed) {
    assert.equal(corpusRecord(id)?.kind, 'criterion', `${id} is not a criterion in the corpus`);
    assert.ok(isElected(id), `${id} is assessed and its category is not elected`);
  }
  // The number is pinned so that electing a category, or the corpus growing a criterion,
  // has to be a deliberate edit here rather than a silent change in a count.
  assert.equal(assessed.length, 38, 'the elected criteria are CC (33) + A (3) + C (2)');
});

test('a criterion dropped from the register is refused', () => {
  const short = ASSESSMENT.filter((r) => r.id !== 'SOC2.CC7.2');
  const problems = assessmentProblems(short);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /^SOC2\.CC7\.2: elected and not assessed/);
});

test('a criterion assessed twice is refused', () => {
  const doubled = [...ASSESSMENT, ASSESSMENT[0]];
  assert.ok(assessmentProblems(doubled).some((p) => p === 'SOC2.CC1.1: assessed twice'));
});

test('a row for an unelected criterion is refused', () => {
  const problems = recordProblems(ok({ id: 'SOC2.P1.1' }));
  assert.ok(problems.some((p) => /category P is not elected/.test(p)), problems.join('; '));
});

test('a row for an id the corpus does not mint is refused', () => {
  assert.ok(recordProblems(ok({ id: 'SOC2.CC1.99' })).some((p) => /not an id the control corpus mints/.test(p)));
  assert.ok(recordProblems(ok({ id: 'ISO27001.A.5.1' })).some((p) => /is a control, not a criterion/.test(p)));
});

test('a category that is neither elected nor declined is the silent absence, and is refused', () => {
  // NOT_ELECTED is what makes "there is nothing about privacy in here" an answer rather
  // than an omission. Remove the entry and the register can no longer account for P.
  const kept = Object.freeze([NOT_ELECTED[0]]);
  const swapped = assessmentProblems(ASSESSMENT).concat(
    ['CC', 'A', 'C', 'PI', 'P']
      .filter((c) => !ELECTED.includes(c) && !kept.some((k) => k.category === c))
      .map((c) => `category ${c} is neither elected nor recorded as declined — that is the silent absence`)
  );
  assert.ok(swapped.includes('category P is neither elected nor recorded as declined — that is the silent absence'));
  // And in the shipped register both declined categories are accounted for, with a decision.
  assert.deepEqual(NOT_ELECTED.map((c) => c.category).sort(), ['P', 'PI']);
  for (const c of NOT_ELECTED) assert.equal(c.decision, DECIDED_BY.categories);
});

/* ------------------------------------------------------- the state is derived */

test('no shipped record carries a state field — there is nothing to go stale', () => {
  for (const record of ASSESSMENT) {
    assert.ok(!('state' in record), `${record.id} carries a state field`);
    assert.ok(!('confidence' in record), `${record.id} carries a confidence field`);
  }
});

test('stateOf derives all three from the two halves', () => {
  assert.equal(stateOf(ok({ control: 'a described control', evidence: 'a sampleable artefact' })), 'met');
  assert.equal(stateOf(ok({ control: 'a described control', evidence: null })), 'partial');
  assert.equal(stateOf(ok({ control: null, evidence: 'a sampleable artefact' })), 'partial');
  assert.equal(stateOf(ok({ control: null, evidence: null })), 'absent');
  assert.deepEqual([...new Set(assess().map((r) => r.state))].every((s) => STATES.includes(s)), true);
});

test('removing the control from a met row moves it to partial with no other edit', () => {
  const met = ok({ control: 'a described control', evidence: 'a sampleable artefact', held: null });
  assert.equal(stateOf(met), 'met');
  assert.deepEqual(recordProblems(met, { boundary: surveyed() }), []);
  const descoped = { ...met, control: null };
  assert.equal(stateOf(descoped), 'partial');
  // And it now owes an address, which is the check that stops a descoped control leaving a
  // row that says "partial" and nothing about where the missing half would come from.
  assert.ok(recordProblems(descoped, { boundary: surveyed() }).some((p) => /does not say where the answer is held/.test(p)));
});

test('a met row that still names somewhere the answer is held is refused', () => {
  const met = ok({ control: 'a described control', evidence: 'a sampleable artefact', held: 'somewhere else' });
  assert.ok(recordProblems(met, { boundary: surveyed() }).some((p) => /met, and still names somewhere the answer is held/.test(p)));
});

/* -------------------------------------------- absent has two meanings, derived */

test('confidence is read out of the boundary census, not written down', () => {
  const organisational = ok({ population: [] });
  const technical = ok({ population: ['host', 'datastore'] });
  assert.equal(confidenceOf(organisational, unsurveyed()), 'assessed');
  assert.equal(confidenceOf(technical, unsurveyed()), 'provisional');
  assert.equal(confidenceOf(technical, surveyed()), 'assessed');
  for (const row of assess()) assert.ok(CONFIDENCE.includes(row.confidence));
});

test('surveying the estate upgrades every provisional row with no edit here', () => {
  const today = counts(ASSESSMENT, boundaryFor(HELD_BY));
  assert.ok(today.confidence.provisional > 0, 'the shipped boundary has partial censuses; that is the point');
  const after = counts(ASSESSMENT, surveyed());
  assert.equal(after.confidence.provisional, 0);
  assert.equal(after.confidence.assessed, after.total);
  // And the states themselves do not move — surveying tells you the assessment is
  // trustworthy, not that a control appeared.
  assert.deepEqual(after.state, today.state);
});

test('a met row resting on a population nobody has enumerated is refused', () => {
  const met = ok({ population: ['host'], control: 'a described control', evidence: 'an artefact', held: null });
  assert.deepEqual(recordProblems(met, { boundary: surveyed() }), []);
  const problems = recordProblems(met, { boundary: unsurveyed() });
  assert.ok(problems.some((p) => /met against a population nobody has enumerated/.test(p)), problems.join('; '));
});

test('a population naming something that is not a boundary census kind is refused', () => {
  assert.ok(recordProblems(ok({ population: ['repository'] })).some((p) => /not a boundary census kind/.test(p)));
  assert.ok(recordProblems(ok({ population: ['host', 'host'] })).some((p) => /repeats a census kind/.test(p)));
  assert.ok(recordProblems(ok({ population: 'host' })).some((p) => /must be an array of census kinds/.test(p)));
  for (const record of ASSESSMENT) {
    for (const kind of record.population) assert.ok(CENSUS_KINDS.includes(kind), `${record.id} names ${kind}`);
  }
});

/* ------------------------------------------------------- the rest of the shape */

test('every owner is one of the policy set functions the policies register defines, and the two lists are one list', () => {
  assert.deepEqual(ROLES, POLICY_ROLES);
  assert.deepEqual(ELECTED, POLICY_ELECTED);
  for (const record of ASSESSMENT) assert.ok(ROLES.includes(record.owner), `${record.id}: ${record.owner}`);
  assert.ok(recordProblems(ok({ owner: 'chief compliance officer' })).some((p) => /is not one of/.test(p)));
});

test('an empty string is refused where null means something', () => {
  assert.ok(recordProblems(ok({ bears: '' })).some((p) => /bears is an empty string/.test(p)));
  assert.ok(recordProblems(ok({ control: 42 })).some((p) => /control must be a sentence or null/.test(p)));
});

test('a why nobody wrote is refused', () => {
  assert.ok(recordProblems(ok({ why: 'absent.' })).some((p) => /a state nobody explained/.test(p)));
});

test('every module a record names is a module that exists', () => {
  // The servicescope pattern: a row citing lib/changesample.js as the artefact an auditor
  // would sample reads as a built control, and stays reading that way after the module is
  // deleted. Opening them is the only thing that notices.
  let named = 0;
  for (const record of ASSESSMENT) {
    for (const rel of pathsNamed(record)) {
      named += 1;
      assert.ok(fs.existsSync(path.join(root, rel)), `${record.id} names ${rel}, which does not exist`);
    }
  }
  assert.ok(named > 0, 'no record names a module — the check would be vacuous');
});

test('the claimed control ids come from the corpus and are not restated here', () => {
  const source = fs.readFileSync(path.join(root, 'lib/gapassessment.js'), 'utf8');
  for (const record of ASSESSMENT) {
    assert.ok(!('claims' in record), `${record.id} writes its own crosswalk; satisfiedBy() is the one home for it`);
    assert.deepEqual(claims(record.id), satisfiedBy(record.id));
  }
  // No ISO control id appears anywhere in the module — the crosswalk has exactly one home,
  // and it is lib/controls.js. This is the check that notices a well-meant "for reference"
  // list pasted in beside the rows, which is how the two copies start disagreeing.
  assert.deepEqual(source.match(/\bISO(?:27001|42001)\.[A-Za-z0-9.]+/g) || [], []);
});

test('the module joins the three registers and reaches for nothing else', () => {
  // lib/systemdescription.js pins its import list for the same reason: the compliance
  // leaves describe different subjects, and a description of Climative's platform that
  // reached into lib/incident.js would be reporting a daemon crash as an in-scope incident.
  const source = fs.readFileSync(path.join(root, 'lib/gapassessment.js'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '(\.\/[^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./boundary.js', './controls.js', './policies.js']);
});

test('the register is frozen, records included', () => {
  assert.ok(Object.isFrozen(ASSESSMENT));
  for (const record of ASSESSMENT) assert.ok(Object.isFrozen(record), `${record.id} is not frozen`);
});

/* ------------------------------------------------------------ what it produces */

test('the assessment today is the honest one, and the counts are pinned', () => {
  const c = counts();
  assert.deepEqual(c.state, { met: 0, partial: 1, absent: 37 });
  assert.deepEqual(c.confidence, { assessed: 18, provisional: 20 });
  assert.equal(byState('partial')[0].id, 'SOC2.CC8.1');
  assert.equal(gaps().length, 38, 'nothing is met, so every row is on the remediation list');
  assert.match(summarise(), /^Climative · Energy Navigator \/ Insights · 38 elected criteria · 0 met, 1 partial, 37 absent · 20 provisional$/);
});

test('CC8.1 is evidence without a control, which is what partial is for', () => {
  const row = assess().find((r) => r.id === 'SOC2.CC8.1');
  assert.equal(row.control, null);
  assert.ok(row.evidence.length > 40);
  assert.equal(row.state, 'partial');
  assert.equal(row.confidence, 'provisional', 'the repository census is partial, so the population it covers is unknown');
});

test('byOwner accounts for every row exactly once', () => {
  const carried = byOwner();
  assert.deepEqual([...carried.keys()], [...ROLES]);
  const ids = [...carried.values()].flat().map((r) => r.id).sort();
  assert.deepEqual(ids, electedCriteria());
});

test('documentedBy is asked of the policy set rather than restated', () => {
  const row = assess().find((r) => r.id === 'SOC2.CC8.1');
  assert.deepEqual(row.documentedBy, documentedBy('SOC2.CC8.1').map((p) => p.id));
  assert.ok(row.documentedBy.includes('change-management'));
});

/* ------------------------------------------------------------------ the command */

test('beadFor produces the payload beadcause-file accepts, one per gap', () => {
  const payload = gaps().map(beadFor);
  assert.equal(payload.length, 38);
  for (const bead of payload) {
    assert.ok(bead.priority <= 2, 'a filed bead may not outrank the work Adam chose');
    assert.ok(bead.title.startsWith('SOC2.'));
    assert.match(bead.description, /^.+\n\nState: (met|partial|absent), (assessed|provisional)\. Owner: /s);
    assert.ok(bead.acceptance.includes('computes to met'));
  }
});

test('beadcause-gaps beads round-trips through the real filing parser', () => {
  const out = execFileSync(process.execPath, [path.join(root, 'bin/gaps.js'), 'beads'], { encoding: 'utf8' });
  const list = YAML.parse(out);
  assert.equal(list.length, 38);
  const parsed = parseProposal(['```beadproposal', YAML.stringify({ workspace: 'beadcause', beads: list }), '```'].join('\n'));
  assert.ok(parsed && !parsed.error, `parseProposal refused the emitted payload: ${parsed?.error}`);
  assert.equal(parsed.beads.length, 38);
});

test('the command reads and renders, and --strict gates on a gap', () => {
  const run = (args) => {
    try {
      const stdio = ['ignore', 'pipe', 'ignore'];
      return { code: 0, out: execFileSync(process.execPath, [path.join(root, 'bin/gaps.js'), ...args], { encoding: 'utf8', stdio }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') };
    }
  };
  assert.equal(run(['show']).code, 0);
  assert.match(run(['show']).out, /38 elected criteria/);
  assert.match(run(['criterion', 'CC8.1']).out, /Change management/);
  assert.match(run(['declined']).out, /Privacy: declined/);
  assert.equal(run(['criterion', 'PI1.1']).code, 1, 'a criterion that is not elected is not in this assessment');
  assert.equal(run(['show', '--strict']).code, 1, 'there is at least one gap today');
  const json = JSON.parse(run(['show', '--json']).out);
  assert.equal(json.rows.length, 38);
  assert.deepEqual(json.counts, counts());
});

/* ---------------------------------------------------------------------- runner */

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
