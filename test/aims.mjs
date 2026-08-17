#!/usr/bin/env node
//
// The AIMS on paper — `lib/aims.js`.
//
//   npm test
//   node test/aims.mjs
//
// bc-eqn1.1: every record this programme keeps is a record *of* something, and until this
// module existed the something did not exist. The organisation, the policy, the scope, the
// parties and the roles are the paper the whole of the rest is evidence for.
//
// Three failures are worth a suite of their own, and none of them is visible by reading
// one function:
//
// 1. **A policy of aspirations.** The answer chosen for this programme is
//    enforce-then-record, so a clause has to name a condition something can evaluate. The
//    three enforcement states are what keep that honest, and each of them has a rule that
//    can be shown to fire: an enforced clause that names no gate, a planned clause that
//    names no bead, and an organisational clause that pretends to be testable.
// 2. **A policy that has drifted from its document.** The clauses live here and the policy
//    lives in README.md, which is where a person reads it. A clause added in code that the
//    document never states is a gate enforcing something nobody was told about; a clause
//    struck from the document while the gate stays is worse. `documentProblems` pins the
//    two together and the suite proves the pin bites.
// 3. **A gate that has been deleted underneath the clause that cites it.** A policy naming
//    a file that is not there reads, to anybody checking, exactly like a policy that is
//    covered.
//
// The rules are run against deliberately broken inputs as well as against the real thing,
// for the reason lib/evidence.js gives for the same split: a rule only ever run against a
// register that passes is a rule nobody has seen fail.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPROVALS,
  CONCENTRATION,
  CONTEXT,
  DOCUMENTS,
  ENFORCEMENT,
  NOT_AIMS_ROLES,
  ORGANISATION,
  PARTIES,
  POLICY,
  ROLES,
  SCOPE,
  SIGNATURE,
  TOP_MANAGEMENT,
  approvers,
  clause,
  clauseProblems,
  clausesInState,
  controlProblems,
  documentProblems,
  enforcementProblems,
  mayApprove,
  parties,
  partyProblems,
  policyProblems,
  problems,
  roleProblems,
  scopeProblems,
  sectionOf,
  signed,
} from '../lib/aims.js';
import { REGISTER as CONTROLLED } from '../lib/documents.js';
import { REGISTER as SUPPLIERS } from '../lib/suppliers.js';

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

/** A well-formed enforced clause, to be broken one field at a time below. */
const sound = () => ({
  id: 'AIP-99',
  commitment: 'Nothing happens that a person did not ask for, in a sentence long enough to be a commitment.',
  testable: 'A request carrying no bead is refused before anything is opened, and the refusal is written where it can be read.',
  state: 'enforced',
  by: ['lib/aims.js'],
  bead: null,
  note: 'This clause exists only in the suite, and is here to be broken one field at a time.',
});

console.log('the AIMS on paper\n');

/* ------------------------------------------------------------- the real thing */

await check('the AIMS as it stands has nothing wrong with it', () => {
  const { problems: found } = problems(ROOT);
  assert.deepEqual(found, [], `${found.length} problem(s):\n${found.join('\n')}`);
});

await check('the legal entity is named, exactly as the certificate would name it', () => {
  assert.equal(ORGANISATION.legalName, 'Adam Morgan, trading as Neadamthal');
  assert.equal(ORGANISATION.decidedBy, 'bc-jlpj', 'the entity was a decision, and the bead that made it is the record');
  assert.ok(ORGANISATION.gap.bead, 'what the repo cannot state names a bead rather than guessing');
});

await check('top management is a person, and the policy they have not yet signed says so', () => {
  assert.ok(TOP_MANAGEMENT.name.length > 1);
  assert.equal(signed(), false, 'a session can draft a policy; only a person can sign one');
  assert.equal(SIGNATURE.state, 'draft');
  assert.equal(SIGNATURE.signedOn, null, 'a signature date on an unsigned policy is a fabricated record');
  assert.match(SIGNATURE.line, /Signed/, 'and there is a line to sign on');
});

await check('the unsigned policy warns every time anybody asks, and never fails the build', () => {
  const { problems: found, warnings } = problems(ROOT);
  assert.deepEqual(found, [], 'a draft is a known state, not a defect');
  assert.ok(
    warnings.some((w) => /draft/.test(w)),
    `expected the draft to be reported: ${warnings.join('\n')}`
  );
});

/* ------------------------------------------------------------- the three states */

await check('every enforcement state is used, because a policy that only claims enforcement is one nobody checked', () => {
  for (const state of ENFORCEMENT) {
    assert.ok(
      clausesInState(state).length >= 1,
      `no clause is ${state} — the states only mean something while all three are honestly in use`
    );
  }
});

await check('an enforced clause names what does the refusing, and a planned one names the bead that will', () => {
  for (const c of POLICY.clauses) {
    if (c.state === 'enforced') assert.ok(c.by.length >= 1, `${c.id}: enforced by nothing`);
    if (c.state === 'planned') assert.ok(c.bead, `${c.id}: planned by nobody`);
    if (c.state === 'organisational') {
      assert.equal(c.testable, null, `${c.id}: an organisational clause that is testable is not organisational`);
      assert.equal(c.by.length, 0, `${c.id}: an organisational clause enforces nothing`);
    }
  }
});

await check('a sound clause has nothing wrong with it', () => {
  assert.deepEqual(clauseProblems(sound()), []);
});

await check('every rule a clause has to pass can be shown to fail', () => {
  const fails = (patch, re) => {
    const found = clauseProblems({ ...sound(), ...patch });
    assert.ok(found.some((p) => re.test(p)), `${JSON.stringify(patch)} passed; got:\n${found.join('\n')}`);
  };

  fails({ id: 'policy-1' }, /must be AIP-/);
  fails({ commitment: 'be good' }, /`commitment` must state/);
  fails({ note: 'later' }, /`note` must say/);
  fails({ state: 'aspirational' }, /`state` must be one of/);
  fails({ by: 'lib/aims.js' }, /`by` must be a list/);
  fails({ testable: null }, /must carry a `testable` sentence/);
  fails({ by: [] }, /must name in `by` what does the refusing/);
  fails({ state: 'planned', bead: null }, /must name the `bead`/);
  fails({ state: 'organisational' }, /must have `testable: null`/);
  fails({ state: 'organisational', testable: null }, /`by` must be empty/);
});

await check('a policy with no enforced clause at all is refused outright', () => {
  const aspirational = {
    ...POLICY,
    clauses: [{ ...sound(), state: 'organisational', testable: null, by: [], bead: 'bc-x' }],
  };
  const found = policyProblems(aspirational);
  assert.ok(found.some((p) => /not one clause is enforced/.test(p)), found.join('\n'));
});

await check('two clauses cannot share an id', () => {
  const doubled = { ...POLICY, clauses: [sound(), sound()] };
  assert.ok(policyProblems(doubled).some((p) => /same id/.test(p)));
});

await check('a clause is reachable by id, which is the seam every gate that cites one goes through', () => {
  assert.equal(clause('AIP-1').state, 'enforced');
  assert.equal(clause('AIP-404'), null, 'an id nothing knows about is null rather than a throw');
});

/* -------------------------------------------------------------------- the scope */

await check('the scope statement has an edge, and every exclusion says why and what is left', () => {
  assert.deepEqual(scopeProblems(), []);
  assert.ok(SCOPE.excluded.length >= 1, 'a scope with no exclusions has not been thought about');
});

await check('an exclusion with no reason, and one with no residual risk, are both caught', () => {
  const noWhy = { ...SCOPE, excluded: [{ name: 'The model', why: 'because', residual: SCOPE.excluded[0].residual }] };
  assert.ok(scopeProblems(noWhy).some((p) => /an exclusion with no reason is a gap/.test(p)));

  const noResidual = { ...SCOPE, excluded: [{ name: 'The model', why: SCOPE.excluded[0].why, residual: 'none' }] };
  assert.ok(scopeProblems(noResidual).some((p) => /out of scope is not out of the audit/.test(p)));
});

await check('a scope with nothing excluded at all is refused, because that is not a boundary', () => {
  assert.ok(scopeProblems({ ...SCOPE, excluded: [] }).some((p) => /`excluded` must name what is outside/.test(p)));
});

/* ------------------------------------------------------------------ the parties */

await check('the context is written down, both halves of it', () => {
  assert.ok(CONTEXT.internal.length >= 1 && CONTEXT.external.length >= 1);
  assert.ok(
    CONTEXT.internal.some((s) => /segregation of duties/.test(s)),
    'the one-person concentration is the internal issue that decides most of the design, and it is stated'
  );
});

await check('suppliers are folded in from their own register rather than copied into this one', () => {
  const all = parties();
  assert.equal(all.length, PARTIES.length + SUPPLIERS.length);
  for (const s of SUPPLIERS) {
    assert.ok(
      all.some((p) => p.id === s.id && p.fromSupplier),
      `${s.id} is an interested party and should arrive from the supplier register`
    );
  }
});

await check('a hand-written party that duplicates a supplier is refused, because two lists drift', () => {
  const duplicated = [...PARTIES, { ...PARTIES[0], id: SUPPLIERS[0].id }];
  const found = partyProblems(duplicated);
  assert.ok(found.some((p) => /already in the supplier register/.test(p)), found.join('\n'));
});

await check('every rule a party has to pass can be shown to fail', () => {
  const base = PARTIES[0];
  const fails = (patch, re) => {
    const found = partyProblems([{ ...base, ...patch }]);
    assert.ok(found.some((p) => re.test(p)), `${JSON.stringify(patch)} passed; got:\n${found.join('\n')}`);
  };
  fails({ id: 'The Operator' }, /kebab-case/);
  fails({ party: '' }, /`party` must name them/);
  fails({ needs: [] }, /`needs` must say/);
  fails({ how: 'somehow' }, /`how` must say how/);
  assert.ok(partyProblems([]).some((p) => /the register is empty/.test(p)));
});

/* -------------------------------------------------------------------- the roles */

await check('the roles table is sound, and every approval there is has somebody who may give it', () => {
  assert.deepEqual(roleProblems(), []);
  for (const kind of APPROVALS) {
    assert.ok(approvers(kind).length >= 1, `nobody may approve ${kind}`);
  }
});

await check('an approval no role may give is caught — a decision nothing can make is a deadlock', () => {
  const found = roleProblems(ROLES, [...APPROVALS, 'a-new-kind-of-approval']);
  assert.ok(found.some((p) => /nobody may approve/.test(p)), found.join('\n'));
});

await check('a role claiming an approval that is not in the vocabulary is caught', () => {
  const found = roleProblems([{ ...ROLES[0], mayApprove: ['everything'] }]);
  assert.ok(found.some((p) => /is not one of the approvals/.test(p)), found.join('\n'));
});

await check('who may approve an impact assessment is answerable, because bc-eqn1.6 refuses on it', () => {
  assert.equal(mayApprove('impact-approver', 'impact-assessment'), true);
  assert.equal(mayApprove('aims-manager', 'impact-assessment'), false);
  assert.equal(mayApprove('nobody-at-all', 'impact-assessment'), false, 'an unknown role approves nothing');
});

await check('the concentration is recorded rather than disguised', () => {
  assert.equal(CONCENTRATION.roles, ROLES.length);
  assert.equal(new Set(ROLES.map((r) => r.holder)).size, CONCENTRATION.holders);
  assert.match(CONCENTRATION.says, /segregation of duties/);
});

await check('the two ownership vocabularies are named as not being roles, and they are still there', () => {
  const paths = NOT_AIMS_ROLES.map((n) => n.path);
  assert.deepEqual(paths, ['lib/owner.js', 'lib/ownership.js']);
  for (const p of paths) assert.ok(fs.existsSync(path.join(ROOT, p)), `${p} is gone, so the exemption is about nothing`);
  for (const r of ROLES) assert.ok(!paths.includes(r.id), 'an AIMS role is not a file');
});

/* --------------------------------------------------------------- enforcement */

await check('a clause naming a gate that is not in the repo fails, loudly', () => {
  const deleted = { ...POLICY, clauses: [{ ...sound(), by: ['lib/a-gate-that-was-deleted.js'] }] };
  const found = enforcementProblems(ROOT, deleted);
  assert.ok(found.some((p) => /is not in the repo/.test(p)), found.join('\n'));
  assert.deepEqual(enforcementProblems(ROOT), [], 'and the real policy names only files that are there');
});

await check('an exemption naming a module that has left the repo fails the same way', () => {
  const found = enforcementProblems(ROOT, POLICY, [{ path: 'lib/gone.js', why: 'it was here once' }]);
  assert.ok(found.some((p) => /no longer exists/.test(p)), found.join('\n'));
});

/* ----------------------------------------------------------------- the documents */

await check('a section is read to the next heading of its own level, not to the end of the file', () => {
  const doc = ['# One', '## Two', 'body of two', '### Three', 'body of three', '## Four', 'body of four'].join('\n');
  assert.equal(sectionOf(doc, '## Two'), 'body of two\n### Three\nbody of three');
  assert.equal(sectionOf(doc, '### Three'), 'body of three');
  assert.equal(sectionOf(doc, '## Nowhere'), null, 'a heading that is not there is null, not empty');
});

await check('each of the four documents is in the README, at the heading it claims', () => {
  assert.deepEqual(documentProblems(ROOT), []);
  assert.equal(DOCUMENTS.length, 4, 'the policy, the scope, the parties and the roles');
});

await check('a clause the document does not state is caught, which is the drift that matters', () => {
  const invented = [{ ...DOCUMENTS[0], pins: ['AIP-4242'] }];
  const found = documentProblems(ROOT, invented);
  assert.ok(found.some((p) => /does not mention/.test(p)), found.join('\n'));
});

await check('a renamed heading detaches the document from its code and says so', () => {
  const renamed = [{ ...DOCUMENTS[0], heading: '#### A policy under another name' }];
  const found = documentProblems(ROOT, renamed);
  assert.ok(found.some((p) => /has no heading/.test(p)), found.join('\n'));
});

await check('every document declared here is controlled by lib/documents.js, with an owner and a review date', () => {
  assert.deepEqual(controlProblems(), []);
  for (const d of DOCUMENTS) {
    const entry = CONTROLLED.find((e) => e.path === d.path && e.section === d.heading);
    assert.ok(entry, `${d.id} is not controlled`);
    assert.ok(entry.owner, `${d.id} has no owner`);
    assert.equal(entry.approvedOn, null, 'and it is a draft, so it records no approval');
    assert.ok(entry.awaitingApproval, `${d.id} does not say whose signature it is waiting for`);
  }
});

await check('a document declared here and controlled nowhere is caught', () => {
  const orphan = [{ ...DOCUMENTS[0], id: 'uncontrolled', heading: '#### Not in the register' }];
  const found = controlProblems(orphan);
  assert.ok(found.some((p) => /no owner, no version and no review date/.test(p)), found.join('\n'));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
