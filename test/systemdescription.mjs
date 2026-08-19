#!/usr/bin/env node
//
// The system description is generated, never written by hand — `lib/systemdescription.js`.
//
//   npm test                            (runs it alongside the other suites)
//   node test/systemdescription.mjs     (on its own)
//
// bc-4r10.3. Section 3 of a SOC 2 report is management's description of the system, and
// the usual failure is not that somebody writes a wrong description. It is that somebody
// writes a description that *looks* finished: a heading with a paragraph under it, drafted
// once, drifting from the estate it describes at the rate the estate changes. So the claim
// this suite defends is that no sentence about the service organisation in the output came
// from anywhere but a record, and that a section nothing can derive says so out loud.
//
// Four things are asserted, and three of them are about refusals.
//
//  1. **The section table and the generators are one set.** A section with no generator is
//     a heading with nothing under it; a generator with no section never runs and looks
//     maintained. Both directions are refused, and `COMPONENT_KINDS` is checked against
//     the real `KINDS` from `lib/boundary.js` — so a boundary that grows a sixth kind
//     turns this red rather than silently describing five of them.
//  2. **A description cannot be generated from a record that does not validate**, and a
//     section with no source cannot claim one. This is the half where a document that
//     looks finished would otherwise be produced.
//  3. **The census reaches the document.** An enumerated census makes an empty section
//     `generated` — there are none, and the record says so — and a partial one makes the
//     same section `partial` with the hole naming where the rest is held. That is
//     `lib/boundary.js`'s whole argument arriving one layer up, and it is asserted from
//     both directions because it is the half a later edit will relax.
//  4. **Nothing signs.** The assertion is always a draft, the operating-effectiveness
//     statement exists only over a period, and `assertionProblems` is non-empty today —
//     but reachable, which is proved by constructing the record that empties it. A gate
//     nobody can ever pass is a gate somebody deletes.
//
// Two of the checks are free cross-module ones, in the shape `test/boundary.mjs` uses:
// every criterion the description names is run through the *real* `criterionProblems` from
// `lib/election.js` and the *real* `isControl` from `lib/controls.js`, rather than against
// a shape this file invented. And the source of `lib/systemdescription.js` is read to prove
// it imports none of the registers that describe carved-out beadcause — the file's central
// argument, which prose alone cannot hold.
//
// Everything here is pure. No config directory, no git, no tracker, no network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CENSUS_KINDS, KINDS, boundaryFor } from '../lib/boundary.js';
import { byFramework, isControl } from '../lib/controls.js';
import { criterionProblems, scope, NOTHING } from '../lib/election.js';
import { ELECTED, POLICIES } from '../lib/policies.js';
import {
  ASSERTIONS,
  COMPONENT_KINDS,
  ENVIRONMENT_CRITERIA,
  PERIOD_KINDS,
  SECTIONS,
  SECTION_IDS,
  SIGNING_IS_A_HUMAN_ACT,
  STATES,
  SUPPLIABLE,
  assertion,
  assertionProblems,
  criteriaFor,
  describe,
  descriptionProblems,
  electedCriteria,
  holes,
  periodLabel,
  periodProblems,
  render,
  renderAssertion,
  section,
  sectionProblems,
  suppliedProblems,
  summarise,
  unwritable,
} from '../lib/systemdescription.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

const climative = boundaryFor('climative');
const PERIOD = { kind: 'over', from: '2026-09-01', to: '2026-12-01' };
const shipped = describe(climative, { period: PERIOD });

/** A boundary with nothing unknown in it — every census enumerated, every kind present. */
const enumerated = () => ({
  organisation: 'acme',
  system: 'The Widget Platform',
  serviceOrganisation: 'Acme',
  decidedBy: 'bc-0000',
  statement:
    'The Widget Platform operated by Acme — the services its user entities reach, the data they ' +
    'submit and the reporting they receive.',
  components: KINDS.map((kind) => ({
    id: `a-${kind}`,
    kind,
    label: `the ${kind}`,
    disposition: 'inside',
    why: `It is part of the request path every user entity reaches, end to end.`,
  })),
  userEntities: [{ id: 'someone', label: 'Someone', why: 'They submit widgets and read the reporting.' }],
  subservice: [],
  census: Object.fromEntries(CENSUS_KINDS.map((k) => [k, { state: 'enumerated' }])),
});

/* ------------------------------------- 1. the table and the generators are one set */

check('the section table validates, which is what the import-time throw is about', () => {
  assert.deepEqual(sectionProblems(), []);
});

check('a section nothing generates is refused — it would print as a heading with nothing under it', () => {
  const problems = sectionProblems([...SECTIONS, { id: 'invented', title: 'Invented', must: 'Nothing.' }]);
  assert.ok(problems.some((p) => /section invented: nothing generates it/.test(p)), problems.join('\n'));
});

check('a generator with no section is refused — it would never run and would look maintained', () => {
  const problems = sectionProblems(SECTIONS, { ...Object.fromEntries(SECTION_IDS.map((id) => [id, () => {}])), orphan: () => {} });
  assert.ok(problems.some((p) => /a generator for "orphan", which is not a section/.test(p)), problems.join('\n'));
});

check('every boundary kind lands in exactly one component section, so a sixth kind cannot go undescribed', () => {
  const placed = Object.values(COMPONENT_KINDS).flat();
  assert.deepEqual([...placed].sort(), [...KINDS].sort(), 'COMPONENT_KINDS and lib/boundary.js KINDS must be the same set');
  assert.equal(placed.length, new Set(placed).size, 'a kind placed in two sections would be described twice');
});

check('the vocabularies are frozen, so nothing widens them at runtime', () => {
  for (const v of [STATES, PERIOD_KINDS, SECTIONS, SECTION_IDS, SUPPLIABLE, ASSERTIONS, ENVIRONMENT_CRITERIA]) {
    assert.ok(Object.isFrozen(v));
  }
});

check('the control-environment criteria are read off the corpus, not listed by hand', () => {
  assert.ok(ENVIRONMENT_CRITERIA.length >= 15, `expected the CC1-CC5 restatement, got ${ENVIRONMENT_CRITERIA.length}`);
  for (const id of ENVIRONMENT_CRITERIA) assert.ok(/^SOC2\.CC[1-5]\./.test(id), `${id} is not a CC1-CC5 criterion`);
  assert.equal(
    ENVIRONMENT_CRITERIA.length,
    byFramework('SOC2').filter((r) => /^CC[1-5]\./.test(r.local)).length
  );
});

/* --------------------------------- 2. what it refuses, so nothing looks finished */

check('a record the boundary refuses cannot be described at all', () => {
  const broken = enumerated();
  delete broken.census;
  assert.throws(() => describe(broken), /boundary does not validate/);
});

check('junk is refused the same way rather than producing an empty description', () => {
  for (const junk of [null, undefined, {}, 'nonsense', 42]) assert.throws(() => describe(junk), /boundary does not validate/);
});

check('an unavailable section must name where the answer is held', () => {
  assert.deepEqual(descriptionProblems(shipped), []);
  const forged = {
    ...shipped,
    sections: shipped.sections.map((s) => (s.state === 'unavailable' ? { ...s, heldElsewhere: '' } : s)),
  };
  const problems = descriptionProblems(forged);
  assert.ok(problems.some((p) => /does not say where the answer is held/.test(p)), problems.join('\n'));
});

check('a section with content and no recorded source is content somebody wrote by hand', () => {
  const forged = { ...shipped, sections: shipped.sections.map((s) => (s.id === 'services' ? { ...s, from: [] } : s)) };
  const problems = descriptionProblems(forged);
  assert.ok(problems.some((p) => /section services: content with nothing recorded as its source/.test(p)), problems.join('\n'));
});

check('every section of the shipped description carries a state that is one of the three', () => {
  assert.equal(shipped.sections.length, SECTIONS.length);
  for (const s of shipped.sections) assert.ok(STATES.includes(s.state), `${s.id}: ${s.state}`);
  assert.equal(
    shipped.states.generated + shipped.states.partial + shipped.states.unavailable,
    SECTIONS.length
  );
});

check('the file imports none of the registers that describe carved-out beadcause', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = fs.readFileSync(path.join(here, '..', 'lib', 'systemdescription.js'), 'utf8');
  const imports = [...source.matchAll(/^import[^;]*from '([^']+)';/gm)].map((m) => m[1]);
  for (const forbidden of ['./incident.js', './access.js', './servicescope.js', './suppliers.js', './changesample.js', './evidence.js']) {
    assert.ok(!imports.includes(forbidden), `${forbidden} describes a carved-out component and must not reach the description`);
  }
  assert.deepEqual([...imports].sort(), ['./boundary.js', './controls.js', './policies.js'], 'the three registers, and nothing else');
});

/* --------------------------------------- 3. the census reaches the document */

check('an enumerated census makes an empty section generated — there are none, and the record says so', () => {
  const record = enumerated();
  record.components = [];
  const d = describe(record, { criteria: [], period: PERIOD });
  const s = section(d, 'subservice');
  assert.equal(s.state, 'generated');
  assert.deepEqual(s.entries, []);
  assert.deepEqual(s.holes, [], 'an enumerated census leaves nothing outstanding');
});

check('a partial census makes the same section partial, with the hole naming where the rest is held', () => {
  const record = enumerated();
  record.census.subservice = { state: 'partial', held: 'the vendor spreadsheet', note: 'Nobody has surveyed the processors.' };
  const d = describe(record, { criteria: [], period: PERIOD });
  const s = section(d, 'subservice');
  assert.equal(s.state, 'partial');
  assert.equal(s.holes.length, 1);
  assert.equal(s.holes[0].held, 'the vendor spreadsheet');
  assert.match(s.holes[0].why, /surveyed the processors/);
});

check("the shipped record's six partial censuses arrive as holes in the components, not as blanks", () => {
  for (const id of ['infrastructure', 'software', 'people', 'data']) {
    const s = section(shipped, id);
    assert.equal(s.state, 'partial', id);
    assert.ok(s.holes.length, `${id} has a partial census and must admit it`);
    for (const h of s.holes) assert.ok(h.held, `${id}: a hole must say where the rest is held`);
  }
});

check('a carved-out component is printed under its own section rather than dropped', () => {
  const s = section(shipped, 'software');
  assert.ok(s.carved.some((c) => c.id === 'beadcause'), 'beadcause is carved out and the description says so');
  assert.ok(s.entries.every((e) => e.disposition !== 'carved-out'), 'a carve-out is never described as part of the system');
});

check('`holes` flattens every outstanding thing across the document, which is the errand list', () => {
  const all = holes(shipped);
  assert.ok(all.length >= 8, `expected the record's admitted gaps, got ${all.length}`);
  for (const h of all) assert.ok(h.section && h.of && h.why, JSON.stringify(h));
  assert.deepEqual(
    [...new Set(all.map((h) => h.section))].filter((id) => !SECTION_IDS.includes(id)),
    [],
    'a hole belongs to a section that exists'
  );
});

/* ------------------------------------------ the criteria, and the presumption */

check('with no election the criteria are presumed from the policy set, and the document says so', () => {
  assert.equal(shipped.criteria.presumed, true);
  assert.deepEqual(shipped.criteria.elected, criteriaFor(ELECTED));
  assert.match(render(shipped), /presumed from the policy set/);
});

check('an election passed in is used, and is not marked presumed', () => {
  const d = describe(climative, { criteria: ['SOC2.CC8.1'], period: PERIOD });
  assert.equal(d.criteria.presumed, false);
  assert.deepEqual(d.criteria.elected, ['SOC2.CC8.1']);
  assert.equal(section(d, 'criteria').entries.length, 1);
});

check('an empty election is an election, not an absence — passing [] does not fall back to the presumption', () => {
  const d = describe(climative, { criteria: [], period: PERIOD });
  assert.equal(d.criteria.presumed, false);
  assert.deepEqual(d.criteria.elected, []);
});

check('a 27001 or 42001 control is elected elsewhere, not silently dropped, and never appears as a criterion', () => {
  const d = describe(climative, { criteria: ['SOC2.CC8.1', 'ISO27001.A.8.32'], period: PERIOD });
  assert.deepEqual(d.criteria.elected, ['SOC2.CC8.1']);
  assert.deepEqual(d.criteria.elsewhere, ['ISO27001.A.8.32']);
  assert.ok(section(d, 'criteria').entries.every((e) => e.id.startsWith('SOC2.')));
});

check('an id the corpus does not mint is dropped out loud and fails the description', () => {
  const d = describe(climative, { criteria: ['SOC2.CC6.9'], period: PERIOD });
  assert.deepEqual(d.criteria.dropped, ['SOC2.CC6.9']);
  assert.ok(descriptionProblems(d).some((p) => /SOC2\.CC6\.9 is not in the control corpus/.test(p)));
});

check('electedCriteria never loses an id and never repeats one', () => {
  const { elected, elsewhere, dropped } = electedCriteria(['SOC2.CC8.1', 'SOC2.CC8.1', 'ISO42001.A.2.2', 'nope']);
  assert.deepEqual(elected, ['SOC2.CC8.1']);
  assert.deepEqual(elsewhere, ['ISO42001.A.2.2']);
  assert.deepEqual(dropped, ['nope']);
});

check('free cross-module check: every criterion named is one the election could hold and the corpus mints', () => {
  for (const id of [...shipped.criteria.elected, ...ENVIRONMENT_CRITERIA]) {
    assert.deepEqual(criterionProblems(id), [], `lib/election.js would refuse ${id}`);
    assert.ok(isControl(id), `lib/controls.js does not mint ${id}`);
  }
  for (const e of section(shipped, 'criteria').entries) {
    assert.ok(e.title && e.definition, `${e.id} was printed without the corpus text behind it`);
    for (const other of e.alsoSatisfies) assert.ok(isControl(other), `${e.id} crosswalks to ${other}, which is not a control`);
  }
});

check('an install with nothing elected reads back as nothing, and the description still generates', () => {
  const elected = scope(NOTHING);
  assert.deepEqual(elected, []);
  const d = describe(climative, { criteria: elected.length ? elected : null, period: PERIOD });
  assert.equal(d.criteria.presumed, true, 'no election means the presumption, said out loud');
});

check('the criteria not in scope are disclosed exactly, and the missing half is the reason', () => {
  const s = section(shipped, 'excluded');
  const named = new Set(shipped.criteria.elected);
  assert.equal(s.entries.length, byFramework('SOC2').length - named.size);
  assert.ok(s.entries.every((e) => !named.has(e.id)));
  assert.ok(s.holes.some((h) => /nothing records why/.test(h.why)), 'the count is exact and the reasons are owed');
});

check('the procedures section is the policy set, with the state that expires on it', () => {
  const s = section(shipped, 'procedures');
  assert.equal(s.entries.length, POLICIES.length);
  assert.deepEqual(s.from, ['lib/policies.js']);
  assert.ok(s.holes.some((h) => /policies are owed/.test(h.why)));
});

/* -------------------------------------- 4. nothing signs, and the gate is reachable */

check('the assertion is never signed, and there is no way to make it so', () => {
  const a = assertion(shipped, { signatory: 'A Person', title: 'Chief Executive' });
  assert.equal(a.signed, false);
  assert.equal(SIGNING_IS_A_HUMAN_ACT, true);
  assert.match(renderAssertion(a), /DRAFT, UNSIGNED/);
});

check('operating effectiveness is asserted over a period and never at a date', () => {
  const over = assertion(describe(climative, { period: PERIOD }));
  const asOf = assertion(describe(climative, { period: { kind: 'as-of', asOf: '2026-09-01' } }));
  assert.ok(over.says.some((s) => s.id === 'operation'), 'a Type II assertion claims it');
  assert.ok(!asOf.says.some((s) => s.id === 'operation'), 'a Type I assertion cannot claim it');
  assert.ok(asOf.says.some((s) => s.id === 'design'), 'and still claims suitable design');
});

check('today it may not be signed, and every reason is a thing that would make it false', () => {
  const problems = assertionProblems(shipped, { signatory: 'A Person' });
  assert.ok(problems.some((p) => /sections cannot be written from any record/.test(p)));
  assert.ok(problems.some((p) => /presumed from the policy set/.test(p)));
  assert.ok(problems.some((p) => /holes? across/.test(p)));
});

check('an unnamed signatory is itself a refusal', () => {
  assert.ok(assertionProblems(shipped).some((p) => /nobody is named to sign it/.test(p)));
});

check('the gate is reachable: a record with nothing outstanding empties it', () => {
  const record = enumerated();
  const supplied = Object.fromEntries(
    SUPPLIABLE.map((id) => [
      id,
      [{ id: `${id}-1`, label: `The ${id} record`, statement: `Everything recorded for ${id}.`, source: 'the signed master services agreement' }],
    ])
  );
  const register = [
    {
      id: 'everything',
      title: 'One Policy',
      aim: 'It is the documented answer for the one criterion elected.',
      ownerRole: 'security lead',
      reviewMonths: 12,
      criteria: byFramework('SOC2').map((r) => r.id),
      enforcedBy: ['lib/mergequeue.js'],
      adoption: 'adopted',
      owner: 'A Person',
      approvedBy: 'A Person',
      approvedOn: '2026-08-01',
      version: '1.0',
      reviewedOn: '2026-08-01',
      path: 'policies/one.md',
    },
  ];
  const d = describe(record, {
    criteria: byFramework('SOC2').map((r) => r.id),
    period: PERIOD,
    register,
    supplied,
    now: new Date('2026-09-01T00:00:00Z'),
  });
  assert.equal(d.writable, true, `still unwritable: ${unwritable(d).map((x) => x.id).join(', ')}`);
  assert.equal(d.states.unavailable, 0);
  assert.deepEqual(holes(d), [], 'nothing outstanding');
  assert.deepEqual(assertionProblems(d, { signatory: 'A Person' }), [], 'a person may sign this one');
  assert.equal(assertion(d, { signatory: 'A Person' }).signed, false, 'and it is still not signed by a generator');
});

check('a supplied record is held to the same bar — a statement with no source is refused', () => {
  const problems = suppliedProblems('commitments', [{ id: 'a', label: 'A commitment', statement: 'We will be available.' }]);
  assert.ok(problems.some((p) => /needs a `source`/.test(p)), problems.join('\n'));
  assert.deepEqual(suppliedProblems('services', []), [
    '"services" is not a section anything may supply — the rest are generated',
  ]);
  assert.throws(() => describe(enumerated(), { supplied: { commitments: [{ id: 'a' }] } }), /supplied record does not validate/);
});

/* ------------------------------------------------ the document, and its diff */

check('the rendered document carries no clock, so the diff between two of them is reviewable', () => {
  const a = render(describe(climative, { period: PERIOD, now: new Date('2026-01-01T00:00:00Z') }));
  const b = render(describe(climative, { period: PERIOD, now: new Date('2027-06-15T12:34:56Z') }));
  assert.equal(a, b, 'the same records rendered a year apart must be byte-identical');
  assert.ok(!/\d{4}-\d{2}-\d{2}T\d{2}:/.test(a), 'no timestamp anywhere in the body');
});

check('a period is a date or a range, never both and never backwards', () => {
  assert.deepEqual(periodProblems(PERIOD), []);
  assert.deepEqual(periodProblems({ kind: 'as-of', asOf: '2026-09-01' }), []);
  assert.ok(periodProblems(null).length);
  assert.ok(periodProblems({ kind: 'over', from: '2026-12-01', to: '2026-09-01' }).some((p) => /runs forwards/.test(p)));
  assert.ok(periodProblems({ kind: 'over', from: '2026-09-01', to: '2026-12-01', asOf: '2026-09-01' }).some((p) => /asserts neither/.test(p)));
  assert.ok(periodProblems({ kind: 'as-of', asOf: '2026-09-01', to: '2026-12-01' }).some((p) => /says something else/.test(p)));
  assert.ok(periodProblems({ kind: 'over', from: 'September', to: '2026-12-01' }).some((p) => /is not a date/.test(p)));
  assert.equal(periodLabel(PERIOD), '2026-09-01 to 2026-12-01');
  assert.equal(periodLabel({ kind: 'nonsense' }), null);
});

check('a description generated with no period says so rather than inventing one', () => {
  const d = describe(climative);
  assert.equal(d.period, null);
  assert.match(render(d), /\*\*Period:\*\* _not stated_/);
  assert.ok(assertionProblems(d, { signatory: 'A Person' }).some((p) => /^period: /.test(p)));
});

check('the document names every section, in order, with what the criteria asked of it', () => {
  const doc = render(shipped);
  SECTIONS.forEach((s, i) => {
    assert.ok(doc.includes(`## ${i + 1}. ${s.title}`), `${s.id} is missing its heading`);
    assert.ok(doc.includes(s.must), `${s.id} does not print what the description criteria ask of it`);
  });
  assert.ok(doc.includes('Not yet derivable'), 'a section nothing derives says so in the document itself');
});

check('`summarise` says the states and the holes, because a count of sections would read as finished', () => {
  const line = summarise(shipped);
  assert.match(line, /Climative/);
  assert.match(line, /unavailable/);
  assert.match(line, /hole/);
});

check('every reader answers rather than throwing on a description that is not one', () => {
  for (const junk of [null, undefined, {}, 'nonsense', 42]) {
    assert.equal(section(junk, 'services'), null);
    assert.deepEqual(unwritable(junk), []);
    assert.deepEqual(holes(junk), []);
    assert.ok(typeof summarise(junk) === 'string');
  }
  assert.ok(descriptionProblems(null).length, 'but validation still says so');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
