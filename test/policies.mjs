#!/usr/bin/env node
//
// The policy set expires, and nothing in it claims a criterion that does not exist —
// `lib/policies.js`.
//
//   npm test
//   node test/policies.mjs
//
// bc-4r10.12: a SOC 2 engagement asks for roughly fifteen policies and then tests two
// things about them that have nothing to do with what they say — who approved this, and
// when was it last reviewed. The exception written up more often than any other is a
// policy last reviewed before the observation period began.
//
// So the suite below is mostly about the two ways this register could be false while
// passing. **A date nobody moved** is the first, and it is checked the way
// `test/documents.mjs` checks it: pointed at a clock two years on, an adopted policy is
// overdue and says whose it is. **A criterion in no policy** is the second, and it is the
// one that reads as coverage — fifteen current documents, and CC7.2 in none of them. That
// check needs the control corpus, which is not in every release, so it is guarded and
// prints a loud SKIP rather than passing quietly: the arrangement `test/servicescope.mjs`
// uses, for the same reason.
//
// Both of those are rules run against fixtures rather than against the real set, because
// the real set is supposed to be clean, and a rule only ever run against a register that
// passes is a rule nobody has seen fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_REVIEW_MONTHS as DOC_CEILING, WARN_DAYS as DOC_WARN } from '../lib/documents.js';
import {
  ADOPTION,
  ADOPTION_FIELDS,
  ELECTED,
  HELD_BY,
  MAX_REVIEW_MONTHS,
  POLICIES,
  ROLES,
  STATES,
  WARN_DAYS,
  alsoServes,
  categoryOf,
  claimed,
  coverage,
  entryProblems,
  gaps,
  isElected,
  policiesFor,
  registerProblems,
  setProblems,
  stateOf,
  summarise,
} from '../lib/policies.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}`);
    console.log(`      ${err.message.split('\n').join('\n      ')}`);
  }
}

/**
 * A neighbour that may not be in this release.
 *
 * `lib/controls.js` is bc-4r10.1 and lands on its own branch. Importing it unguarded
 * would make this suite red until that merges, which is a red nobody can fix from here;
 * skipping loudly means the check starts working on somebody else's merge rather than on
 * somebody remembering to come back.
 */
async function optional(spec, why) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.log(`SKIP  ${spec} is not in this release yet — ${why}`);
    return null;
  }
}

/** An owed policy that is well-formed, to be broken one field at a time below. */
const owed = () => ({
  id: 'a-policy',
  title: 'A Policy',
  aim: 'It states the thing the organisation has decided, so that an auditor can test the practice against it.',
  ownerRole: 'security lead',
  reviewMonths: 12,
  criteria: ['SOC2.CC6.1'],
  enforcedBy: [],
  owes: 'Nobody has written it, and nothing in this repository enforces the substance of it in the meantime.',
  adoption: 'owed',
});

/** The same policy, adopted — the shape this register does not have an example of yet. */
const adopted = () => ({
  ...owed(),
  adoption: 'adopted',
  owes: null,
  path: 'README.md',
  owner: 'Adam Morgan',
  approvedBy: 'Adam Morgan',
  approvedOn: '2026-01-01',
  version: '1.0.0',
  reviewedOn: '2026-01-01',
});

/* ------------------------------------------------------------- the register */

await check('the set is well-formed, and it is checked at import rather than on demand', () => {
  assert.deepEqual(registerProblems(), []);
  assert.equal(POLICIES.length, 15);
  assert.throws(() => POLICIES.push({}), TypeError);
});

await check('the fifteen a SOC 2 request list asks for are the fifteen that are here', () => {
  assert.deepEqual(
    POLICIES.map((p) => p.id).sort(),
    [
      'acceptable-use',
      'access-control',
      'business-continuity',
      'change-management',
      'code-of-conduct',
      'data-classification',
      'encryption',
      'hr-security',
      'incident-response',
      'information-security',
      'logging-and-monitoring',
      'physical-security',
      'risk-assessment',
      'secure-development',
      'vendor-management',
    ]
  );
});

await check('nothing is adopted, and every owed policy says what it is owed', () => {
  // The honest state today, and the one a later run must not quietly "fix" by writing an
  // approval nobody gave. When a policy is genuinely approved this assertion changes with
  // it — deliberately, because that is a claim about a real signature.
  assert.deepEqual([...new Set(POLICIES.map((p) => p.adoption))], ['owed']);
  for (const p of POLICIES) {
    assert.ok(p.owes.length >= 40, `${p.id} does not say what it is owed`);
    for (const field of ADOPTION_FIELDS) assert.equal(p[field] ?? null, null, `${p.id} carries ${field} while owed`);
  }
});

await check('the whole set is held by one organisation, and it is the one the boundary names', () => {
  assert.equal(HELD_BY, 'climative');
  assert.deepEqual(ADOPTION, ['adopted', 'owed']);
  assert.deepEqual(STATES, ['owed', 'current', 'approaching', 'overdue']);
  assert.ok(ROLES.includes('security lead'));
  for (const p of POLICIES) assert.ok(ROLES.includes(p.ownerRole), `${p.id} is owned by a role nobody minted`);
});

await check('the review machinery is `lib/documents.js`\'s, not a second copy of it', () => {
  // A second definition of "overdue" is how two registers come to disagree about one date.
  assert.equal(MAX_REVIEW_MONTHS, DOC_CEILING);
  assert.equal(WARN_DAYS, DOC_WARN);
  assert.ok(POLICIES.every((p) => p.reviewMonths <= MAX_REVIEW_MONTHS));
  assert.equal(POLICIES.find((p) => p.id === 'vendor-management').reviewMonths, 6);
});

await check('every enforcement a policy claims is a file that is still in the repo', () => {
  for (const p of POLICIES) {
    for (const file of p.enforcedBy) {
      assert.ok(fs.existsSync(path.join(ROOT, file)), `${p.id} claims ${file}, which is not in the repo`);
    }
  }
  // Nine of fifteen have something operating already; six have neither and are the gap.
  assert.equal(POLICIES.filter((p) => p.enforcedBy.length > 0).length, 9);
  assert.deepEqual(gaps().map((p) => p.id).sort(), [
    'acceptable-use',
    'code-of-conduct',
    'encryption',
    'hr-security',
    'physical-security',
    'risk-assessment',
  ]);
});

await check('the set as it stands has nothing wrong with it and nothing coming due', () => {
  const { problems, warnings } = setProblems(ROOT, new Date());
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
});

/* ------------------------------------------------------ the rules, made to fire */

await check('a sound entry has nothing wrong with it, adopted or owed', () => {
  assert.deepEqual(entryProblems(owed()), []);
  assert.deepEqual(entryProblems(adopted()), []);
});

await check('every field an auditor asks about can be shown to fail', () => {
  const broken = {
    id: 'Not Kebab',
    title: '',
    aim: 'too short',
    ownerRole: 'Chief Policy Officer',
    reviewMonths: 0,
    criteria: [],
    enforcedBy: null,
    adoption: 'drafted',
  };
  for (const [field, value] of Object.entries(broken)) {
    const problems = entryProblems({ ...owed(), [field]: value });
    assert.ok(problems.length > 0, `a broken \`${field}\` produced no problem`);
  }
});

await check('an owed policy carrying an approval is refused as hard as an adopted one missing it', () => {
  // The dangerous direction is the second one: a register filled in with what a document
  // *would* say passes every other rule and is false in the only way that matters.
  for (const field of ADOPTION_FIELDS) {
    const problems = entryProblems({ ...owed(), [field]: '2026-01-01' });
    assert.ok(
      problems.some((p) => p.includes(field) && p.includes('still owed')),
      `an owed policy carrying \`${field}\` was accepted`
    );
  }
  for (const field of ADOPTION_FIELDS) {
    const problems = entryProblems({ ...adopted(), [field]: null });
    assert.ok(problems.length > 0, `an adopted policy missing \`${field}\` was accepted`);
  }
});

await check('a policy claiming a criterion that is not one, or is not elected, is refused', () => {
  assert.ok(entryProblems({ ...owed(), criteria: ['CC6.1'] }).length > 0, 'a bare local id was accepted');
  assert.ok(entryProblems({ ...owed(), criteria: ['ISO27001.A.5.15'] }).length > 0, 'an Annex A control was accepted as a criterion');
  const unelected = entryProblems({ ...owed(), criteria: ['SOC2.P4.2'] });
  assert.ok(unelected.some((p) => p.includes('bc-4r10.4')), 'an unelected category was accepted without argument');
  assert.ok(entryProblems({ ...owed(), criteria: ['SOC2.CC6.1', 'SOC2.CC6.1'] }).length > 0, 'the same criterion twice was accepted');
});

await check('two policies cannot share an id', () => {
  const problems = registerProblems([owed(), { ...owed(), title: 'Another' }]);
  assert.ok(problems.some((p) => p.includes('two policies with the same id')));
});

await check('the categories are the elected ones, and the exempt ones are exempt by category rather than by list', () => {
  assert.deepEqual(ELECTED, ['CC', 'A', 'C']);
  assert.equal(categoryOf('SOC2.CC6.1'), 'CC');
  assert.equal(categoryOf('SOC2.PI1.4'), 'PI');
  assert.equal(categoryOf('SOC2.P6.7'), 'P');
  assert.equal(categoryOf('SOC2.A1.2'), 'A');
  assert.equal(categoryOf('nonsense'), null);
  assert.ok(isElected('SOC2.C1.1'));
  assert.ok(!isElected('SOC2.PI1.1'));
});

await check('the crosswalk is where the other frameworks come from, and no policy names one', () => {
  // One source, two renderings: a second mapping typed out here is how a policy comes to
  // be evidence for a 27001 control it stopped covering a year ago.
  assert.ok(!JSON.stringify(POLICIES).includes('ISO27001'), 'a policy names an Annex A control directly');
  assert.ok(!JSON.stringify(POLICIES).includes('ISO42001'), 'a policy names a 42001 control directly');
  const fake = (id) => (id === 'SOC2.CC6.1' ? ['ISO27001.A.5.15', 'ISO42001.A.4.2'] : []);
  assert.deepEqual(alsoServes(POLICIES.find((p) => p.id === 'access-control'), fake), ['ISO27001.A.5.15', 'ISO42001.A.4.2']);
});

/* ------------------------------------------------------------ the dates */

await check('an owed policy has no review date to be late for', () => {
  assert.deepEqual(stateOf(owed()), { state: 'owed', due: null, days: null });
  for (const p of POLICIES) assert.equal(stateOf(p).state, 'owed');
});

await check('the three states fire, and the warning comes before the failure', () => {
  const p = { ...adopted(), reviewedOn: '2026-01-01', reviewMonths: 12 };
  assert.equal(stateOf(p, new Date('2026-06-01T00:00:00Z')).state, 'current');
  assert.equal(stateOf(p, new Date('2026-12-20T00:00:00Z')).state, 'approaching');
  assert.equal(stateOf(p, new Date('2027-01-02T00:00:00Z')).state, 'overdue');
  assert.equal(stateOf(p, new Date('2026-06-01T00:00:00Z')).due, '2027-01-01');
});

await check('an adopted policy pointed at a clock two years on is overdue and says whose it is', () => {
  const later = new Date('2028-08-17T00:00:00Z');
  const { problems, warnings } = setProblems(ROOT, later, { register: [adopted()] });
  assert.equal(warnings.length, 0);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('review was due'));
  assert.ok(problems[0].includes('Adam Morgan owns it'), problems[0]);
  assert.ok(problems[0].includes('bump `version`'), problems[0]);
});

await check('a review coming due warns rather than failing, a month out', () => {
  const soon = new Date('2026-12-20T00:00:00Z');
  const { problems, warnings } = setProblems(ROOT, soon, { register: [adopted()] });
  assert.deepEqual(problems, []);
  assert.equal(warnings.length, 1);
  assert.ok(warnings[0].includes('review due 2027-01-01'));
});

await check('a date that has not happened yet is caught, because it passes every other rule', () => {
  const { problems } = setProblems(ROOT, new Date('2026-06-01T00:00:00Z'), {
    register: [{ ...adopted(), reviewedOn: '2027-01-01' }],
  });
  assert.ok(problems.some((p) => p.includes('has not happened yet')));
});

await check('an enforcement or an approved policy that has left the repo fails rather than passing quietly', () => {
  const gone = setProblems(ROOT, new Date(), { register: [{ ...owed(), enforcedBy: ['lib/nothing-here.js'] }] });
  assert.ok(gone.problems.some((p) => p.includes('lib/nothing-here.js')));
  const missing = setProblems(ROOT, new Date(), { register: [{ ...adopted(), path: 'policies/nothing.md' }] });
  assert.ok(missing.problems.some((p) => p.includes('is not in the repo')));
});

/* ---------------------------------------------------------- the coverage */

await check('a criterion no policy claims is a problem, and so is one no corpus mints', () => {
  const criteria = ['SOC2.CC6.1', 'SOC2.CC7.2', 'SOC2.P4.2'];
  const cov = coverage(criteria, [owed()]);
  assert.deepEqual(cov.elected, ['SOC2.CC6.1', 'SOC2.CC7.2']);
  assert.deepEqual(cov.exempt, ['SOC2.P4.2']);
  assert.deepEqual(cov.unclaimed, ['SOC2.CC7.2']);
  assert.deepEqual(cov.unknown, []);

  const invented = coverage(criteria, [{ ...owed(), criteria: ['SOC2.CC6.1', 'SOC2.CC9.9'] }]);
  assert.deepEqual(invented.unknown, ['SOC2.CC9.9']);

  const { problems } = setProblems(ROOT, new Date(), { register: [owed()], criteria });
  assert.ok(problems.some((p) => p.includes('no policy claims SOC2.CC7.2')));
});

await check('a criterion claimed twice is a criterion covered twice, not an error', () => {
  // Overlap is how a policy set actually reads: CC6.5 is disposal to the data policy and
  // media sanitisation to the physical one, and both are true.
  assert.equal(policiesFor('SOC2.CC6.5').length, 2);
  assert.equal(policiesFor('SOC2.CC8.1').length, 2);
  assert.equal(policiesFor('SOC2.CC9.2').length, 1);
  assert.equal(policiesFor('SOC2.PI1.1').length, 0);
  assert.equal(claimed().length, 38);
});

await check('the set says what it is in a sentence', () => {
  const said = summarise();
  assert.ok(said.includes('15 policies'), said);
  assert.ok(said.includes('0 adopted and 15 owed'), said);
  assert.ok(said.includes('38 elected criteria'), said);
});

/* --------------------------------------------- against the corpus, when it lands */

const controls = await optional('../lib/controls.js', 'bc-4r10.1 is the branch that mints the criteria ids claimed here');

await check('every criterion a policy claims is one the control corpus actually mints', async () => {
  if (!controls) return;
  for (const id of claimed()) assert.ok(controls.isControl(id), `${id} is claimed by a policy and is not in the corpus`);
});

await check('every elected criterion in the corpus is some policy\'s documented answer', async () => {
  if (!controls) return;
  const ids = controls.byFramework('SOC2').map((r) => r.id);
  const cov = coverage(ids);
  assert.equal(ids.length, 61, 'the corpus no longer holds all 61 criteria');
  assert.deepEqual(cov.unclaimed, [], 'an elected criterion is in no policy');
  assert.deepEqual(cov.unknown, [], 'a policy claims a criterion the corpus does not mint');
  // Electing one more category is meant to break this, loudly, until the set grows.
  assert.equal(cov.exempt.length, 23, 'the unelected categories changed size — elect them here or in the corpus, not by accident');
  const { problems } = setProblems(ROOT, new Date(), { criteria: ids });
  assert.deepEqual(problems, []);
});

await check('the other two frameworks are read off the crosswalk rather than written down', async () => {
  if (!controls) return;
  const also = alsoServes(POLICIES.find((p) => p.id === 'access-control'), controls.satisfiedBy);
  assert.ok(also.length > 5, `the access-control policy serves only ${also.length} Annex A controls`);
  assert.ok(also.every((id) => controls.isControl(id)));
  assert.ok(also.some((id) => id.startsWith('ISO27001.')), 'no 27001 control came back');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
