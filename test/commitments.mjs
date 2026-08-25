#!/usr/bin/env node
//
// The principal service commitments — owed to NYSERDA and TD, measured against the
// criteria they bear on, and refused if written in without a source — `lib/commitments.js`.
//
//   npm test
//   node test/commitments.mjs
//
// bc-4r10.3.2: DC 200 asks a system description to state the commitments the service
// organisation made its user entities. Nothing in this repository is the executed
// agreement, so this register is owed exactly like `lib/policies.js`'s fifteen policies —
// and the suite below is mostly the same two-sided check that file uses: an owed entry
// carrying a recorded field is refused as hard as an adopted one missing one, because that
// is the shape a register takes when somebody writes what the agreement *would* say.
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_REVIEW_MONTHS as DOC_CEILING, WARN_DAYS as DOC_WARN } from '../lib/documents.js';
import {
  ADOPTION,
  ADOPTION_FIELDS,
  COMMITMENTS,
  ELECTED,
  HELD_BY,
  MAX_REVIEW_MONTHS,
  ROLES,
  STATES,
  USER_ENTITIES,
  WARN_DAYS,
  categoryOf,
  claimed,
  coverage,
  entryProblems,
  gaps,
  isElected,
  registerProblems,
  stateOf,
  summarise,
  suppliable,
} from '../lib/commitments.js';
import { suppliedProblems } from '../lib/systemdescription.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
void ROOT;

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

/** A neighbour that may not be in this release — see `test/policies.mjs`'s reason. */
async function optional(spec, why) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.log(`SKIP  ${spec} is not in this release yet — ${why}`);
    return null;
  }
}

/** An owed commitment that is well-formed, to be broken one field at a time below. */
const owed = () => ({
  id: 'a-commitment',
  title: 'A Commitment',
  aim: 'What the organisation has promised its user entities about this, in a sentence long enough to be one.',
  toUserEntities: ['nyserda'],
  criteria: ['SOC2.A1.1'],
  ownerRole: 'operations lead',
  reviewMonths: 12,
  adoption: 'owed',
  owes: 'Nobody has read the executed agreement for what it actually promises about this.',
});

/** The same commitment, adopted — the shape this register does not have an example of yet. */
const adopted = () => ({
  ...owed(),
  adoption: 'adopted',
  owes: null,
  statement: 'The organisation commits to a stated capacity headroom, reviewed quarterly against demand.',
  source: 'The NYSERDA Master Services Agreement, Schedule C, section 4.',
  recordedBy: 'Adam Morgan',
  recordedOn: '2026-01-01',
  reviewedOn: '2026-01-01',
});

/* ------------------------------------------------------------- the register */

await check('the set is well-formed, and it is checked at import rather than on demand', () => {
  assert.deepEqual(registerProblems(), []);
  assert.equal(COMMITMENTS.length, 2);
  assert.throws(() => COMMITMENTS.push({}), TypeError);
});

await check('the two commitment categories DC 200 asks about, that this election actually covers', () => {
  assert.deepEqual(COMMITMENTS.map((c) => c.id).sort(), ['availability', 'confidentiality']);
});

await check('nothing is recorded, and every owed commitment says what it is owed', () => {
  // The honest state today. When a commitment is genuinely read out of an agreement this
  // assertion changes with it — deliberately, because that is a claim about a real contract.
  assert.deepEqual([...new Set(COMMITMENTS.map((c) => c.adoption))], ['owed']);
  for (const c of COMMITMENTS) {
    assert.ok(c.owes.length >= 40, `${c.id} does not say what it is owed`);
    for (const field of ADOPTION_FIELDS) assert.equal(c[field] ?? null, null, `${c.id} carries ${field} while owed`);
  }
});

await check('the whole set is held by one organisation, owed to the two named user entities', () => {
  assert.equal(HELD_BY, 'climative');
  assert.deepEqual(ADOPTION, ['adopted', 'owed']);
  assert.deepEqual(STATES, ['owed', 'current', 'approaching', 'overdue']);
  assert.deepEqual(USER_ENTITIES, ['nyserda', 'td']);
  for (const c of COMMITMENTS) {
    assert.deepEqual(c.toUserEntities, ['nyserda', 'td']);
    assert.ok(ROLES.includes(c.ownerRole), `${c.id} is owned by a role nobody minted`);
  }
});

await check('the review machinery is `lib/documents.js`\'s, not a second copy of it', () => {
  assert.equal(MAX_REVIEW_MONTHS, DOC_CEILING);
  assert.equal(WARN_DAYS, DOC_WARN);
  assert.ok(COMMITMENTS.every((c) => c.reviewMonths <= MAX_REVIEW_MONTHS));
});

/* ------------------------------------------------------ the rules, made to fire */

await check('a sound entry has nothing wrong with it, adopted or owed', () => {
  assert.deepEqual(entryProblems(owed()), []);
  assert.deepEqual(entryProblems(adopted()), []);
});

await check('every field can be shown to fail', () => {
  const broken = {
    id: 'Not Kebab',
    title: '',
    aim: 'too short',
    toUserEntities: [],
    criteria: [],
    ownerRole: 'Chief Trust Officer',
    reviewMonths: 0,
    adoption: 'drafted',
  };
  for (const [field, value] of Object.entries(broken)) {
    const problems = entryProblems({ ...owed(), [field]: value });
    assert.ok(problems.length > 0, `a broken \`${field}\` produced no problem`);
  }
});

await check('a commitment owed to an entity nobody named is refused', () => {
  assert.ok(entryProblems({ ...owed(), toUserEntities: ['acme'] }).length > 0);
});

await check('an owed commitment carrying a recorded field is refused as hard as an adopted one missing it', () => {
  // The dangerous direction: a register filled in with what the agreement *would probably*
  // say passes every other rule and is false in the only way that matters.
  for (const field of ADOPTION_FIELDS) {
    const problems = entryProblems({ ...owed(), [field]: '2026-01-01' });
    assert.ok(
      problems.some((p) => p.includes(field) && p.includes('still owed')),
      `an owed commitment carrying \`${field}\` was accepted`
    );
  }
  for (const field of ADOPTION_FIELDS) {
    const problems = entryProblems({ ...adopted(), [field]: null });
    assert.ok(problems.length > 0, `an adopted commitment missing \`${field}\` was accepted`);
  }
});

await check('a commitment measured against a criterion that is not one, or is not elected, is refused', () => {
  assert.ok(entryProblems({ ...owed(), criteria: ['A1.1'] }).length > 0, 'a bare local id was accepted');
  assert.ok(entryProblems({ ...owed(), criteria: ['ISO27001.A.5.15'] }).length > 0, 'an Annex A control was accepted as a criterion');
  const unelected = entryProblems({ ...owed(), criteria: ['SOC2.PI1.1'] });
  assert.ok(unelected.length > 0, 'an unelected category was accepted without argument');
  assert.ok(entryProblems({ ...owed(), criteria: ['SOC2.A1.1', 'SOC2.A1.1'] }).length > 0, 'the same criterion twice was accepted');
});

await check('two commitments cannot share an id', () => {
  const problems = registerProblems([owed(), { ...owed(), title: 'Another' }]);
  assert.ok(problems.some((p) => p.includes('two commitments with the same id')));
});

await check('the categories are availability and confidentiality only — processing integrity and privacy are not elected', () => {
  assert.deepEqual(ELECTED, ['A', 'C']);
  assert.equal(categoryOf('SOC2.A1.2'), 'A');
  assert.equal(categoryOf('SOC2.C1.1'), 'C');
  assert.equal(categoryOf('nonsense'), null);
  assert.ok(isElected('SOC2.A1.1'));
  assert.ok(!isElected('SOC2.PI1.1'));
  assert.ok(!isElected('SOC2.P6.7'));
  assert.ok(!isElected('SOC2.CC6.1'), 'the common criteria are not a DC 200 commitment category');
});

/* ------------------------------------------------------------ the dates */

await check('an owed commitment has no review date to be late for', () => {
  assert.deepEqual(stateOf(owed()), { state: 'owed', due: null, days: null });
  for (const c of COMMITMENTS) assert.equal(stateOf(c).state, 'owed');
});

await check('the three states fire, and the warning comes before the failure', () => {
  const c = { ...adopted(), reviewedOn: '2026-01-01', reviewMonths: 12 };
  assert.equal(stateOf(c, new Date('2026-06-01T00:00:00Z')).state, 'current');
  assert.equal(stateOf(c, new Date('2026-12-20T00:00:00Z')).state, 'approaching');
  assert.equal(stateOf(c, new Date('2027-01-02T00:00:00Z')).state, 'overdue');
});

/* ---------------------------------------------------------- the coverage */

await check('a criterion no commitment claims is a problem, and so is one no corpus mints', () => {
  const criteria = ['SOC2.A1.1', 'SOC2.A1.2', 'SOC2.PI1.1'];
  const cov = coverage(criteria, [owed()]);
  assert.deepEqual(cov.elected, ['SOC2.A1.1', 'SOC2.A1.2']);
  assert.deepEqual(cov.exempt, ['SOC2.PI1.1']);
  assert.deepEqual(cov.unclaimed, ['SOC2.A1.2']);
  assert.deepEqual(cov.unknown, []);

  const invented = coverage(criteria, [{ ...owed(), criteria: ['SOC2.A1.1', 'SOC2.A1.9'] }]);
  assert.deepEqual(invented.unknown, ['SOC2.A1.9']);
});

await check('the two categories claim exactly the criteria the register names', () => {
  assert.deepEqual(claimed(), ['SOC2.A1.1', 'SOC2.A1.2', 'SOC2.A1.3', 'SOC2.C1.1', 'SOC2.C1.2']);
});

await check('nothing is recorded, so nothing has been read out of an agreement — the gap, named', () => {
  assert.deepEqual(gaps().map((c) => c.id).sort(), ['availability', 'confidentiality']);
});

await check('the set says what it is in a sentence', () => {
  const said = summarise();
  assert.ok(said.includes('2 commitment categories'), said);
  assert.ok(said.includes('0 recorded and 2 owed'), said);
  assert.ok(said.includes('5 criteria'), said);
  assert.ok(said.includes('nyserda and td'), said);
});

/* ------------------------------------------------------- the seam it feeds */

await check('an all-owed register supplies nothing — the honest answer for a category nobody has read', () => {
  assert.deepEqual(suppliable(), []);
  assert.deepEqual(suppliable([owed()]), []);
});

await check('a recorded commitment supplies exactly the shape the description wants, and it validates there', () => {
  const supplied = suppliable([adopted()]);
  assert.equal(supplied.length, 1);
  assert.deepEqual(Object.keys(supplied[0]).sort(), ['id', 'label', 'source', 'statement']);
  assert.equal(supplied[0].label, 'A Commitment');
  assert.deepEqual(suppliedProblems('commitments', supplied), []);
});

await check('a mixed register supplies only the recorded half', () => {
  const supplied = suppliable([owed(), { ...adopted(), id: 'b-commitment', title: 'B Commitment' }]);
  assert.equal(supplied.length, 1);
  assert.equal(supplied[0].id, 'b-commitment');
});

/* --------------------------------------------- against the corpus, when it lands */

const controls = await optional('../lib/controls.js', 'bc-4r10.1 is the branch that mints the criteria ids claimed here');

await check('every criterion a commitment claims is one the control corpus actually mints', async () => {
  if (!controls) return;
  for (const id of claimed()) assert.ok(controls.isControl(id), `${id} is claimed by a commitment and is not in the corpus`);
});

await check('the register does not claim more than the two elected categories give it', async () => {
  if (!controls) return;
  const ids = controls.byFramework('SOC2').map((r) => r.id);
  const cov = coverage(ids);
  assert.deepEqual(cov.unknown, [], 'a commitment claims a criterion the corpus does not mint');
  // Not asserting `unclaimed` empty here, on purpose: unlike the policy set (which every
  // elected criterion must be *some* document's answer), a commitment category is coarser
  // than a criterion, and A1.1-A1.3/C1.1-C1.2 do not have to be claimed one-for-one by
  // separate entries. What matters is that nothing here invents a category the corpus does
  // not mint, which the `unknown` assertion above already covers.
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
