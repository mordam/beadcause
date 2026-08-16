#!/usr/bin/env node
//
// Who operates the central service — `lib/operator.js`.
//
//   npm test
//   node test/operator.mjs
//
// bc-3muu.9: each organisation installs and runs its own control-daemon, and we host
// nothing. The decision is recorded in the README; what is checked here is the half of it
// that can rot into a lie without anybody editing a sentence.
//
// Three of these checks are pointed at input that is deliberately wrong, because the
// failures this file exists for all pass every other check in the repository:
//
//   1. An anchor operated by the organisation itself. It validates as a deployment, it
//      renders as a three-tier arrangement, and it is a third copy in the same hands —
//      the one mistake that leaves the whole epic's claim false with everything green.
//      Immutable object storage in our own account is the plausible version of it.
//   2. A self-hosted pair claiming `independent`. That is the misstatement in a system
//      description that an auditor finds, and it is what `claimProblems` is for.
//   3. A second control-daemon under the same operator, claimed as corroboration. Two
//      copies in the same hands are one party.
//
// The shipped model is asserted as data rather than described: `VENDOR_OPERATES` is empty
// and `shipped()` names no vendor anywhere, so "you run it, we never hold your evidence"
// is a property of this repository that a diff has to break on purpose.
//
// Nothing here touches the filesystem, the network or a git repository, because the module
// does not either.
import assert from 'node:assert/strict';

import {
  ASSURANCE,
  OPERATED_BY,
  PARTIES,
  ROLES,
  VENDOR_OPERATES,
  arrangementProblems,
  assuranceOf,
  claimProblems,
  deploymentProblems,
  shipped,
  subservices,
} from '../lib/operator.js';

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

const at = '2026-08-15T17:48:35Z';
const dep = (role, operator, org = 'climative') => ({ role, operator, org, since: at });

const local = dep('local', 'organisation');
const control = dep('control', 'organisation');
const anchor = dep('anchor', 'external');

/* --------------------------------------------------------------- one deployment */

await check('a deployment is a role, a party, an organisation and a date', () => {
  assert.deepEqual(deploymentProblems(local), []);
  assert.deepEqual(deploymentProblems(control), []);
  assert.deepEqual(deploymentProblems(anchor), []);
});

await check('the operator is a relation, not a name — a company name is not one of them', () => {
  const [problem] = deploymentProblems({ ...local, operator: 'Climative Inc' });
  assert.match(problem, /operator must be one of/);
  assert.match(problem, /relation to the/, 'and the message says why a name would not do');
  assert.deepEqual(PARTIES, ['organisation', 'vendor', 'external']);
});

await check('a role names what it holds, and nothing outside the three is one', () => {
  assert.deepEqual(ROLES, ['local', 'control', 'anchor']);
  for (const role of ['witness', 'backup', 'replica', 'primary', '']) {
    assert.match(deploymentProblems({ ...local, role })[0], /role must be one of/, role || '(empty)');
  }
});

await check('an arrangement is a period, so a deployment carries when it started', () => {
  assert.match(deploymentProblems({ ...control, since: undefined })[0], /since must be a UTC instant/);
  assert.match(deploymentProblems({ ...control, since: '15 August 2026' })[0], /since must be a UTC instant/);
  assert.match(deploymentProblems({ ...control, since: '2026-08-15T14:48:35-03:00' })[0], /since must be a UTC instant/);
  assert.deepEqual(deploymentProblems({ ...control, since: '2026-08-15T17:48:35.123Z' }), []);
});

await check('the organisation rule is lib/organisation.js, not a second weaker copy of it', () => {
  // Reserved words and shape both come back through orgProblems, so there is one place
  // to be wrong about what an organisation id is.
  assert.match(deploymentProblems({ ...local, org: 'default' })[0], /reserved/);
  assert.match(deploymentProblems({ ...local, org: 'Climative' })[0], /not the shape/);
  assert.deepEqual(deploymentProblems({ ...local, org: 'acme-energy' }), []);
});

await check('a field the record does not mint is refused whatever it is called', () => {
  const problems = deploymentProblems({ ...control, independent: true });
  assert.ok(problems.some((p) => p.includes('"independent" is not part of a deployment record')), problems.join('; '));
});

/* --------------------------------------------------------------- the arrangement */

await check('the model beadcause ships is sound, and is what OPERATED_BY says it is', () => {
  const arrangement = shipped('climative', at);
  assert.deepEqual(arrangementProblems(arrangement), []);
  assert.deepEqual(
    arrangement.map((d) => [d.role, d.operator]),
    [
      ['local', 'organisation'],
      ['control', 'organisation'],
      ['anchor', 'external'],
    ]
  );
  assert.equal(OPERATED_BY.control, 'organisation', 'the customer runs their own control-daemon');
});

await check('we operate nothing, and that is data rather than a sentence', () => {
  assert.deepEqual(VENDOR_OPERATES, [], 'the day this is not empty, something became a subservice organisation');
  const named = shipped('climative', at).filter((d) => d.operator === 'vendor');
  assert.deepEqual(named, [], 'no deployment in the shipped model is operated by the vendor');
  assert.deepEqual(subservices(shipped('climative', at)), [], 'so nobody has a carve-out decision to make');
});

await check('a witness with nothing to witness is not an arrangement', () => {
  const [problem] = arrangementProblems([control, anchor]);
  assert.match(problem, /no local deployment/);
  assert.equal(assuranceOf([control, anchor]), null, 'and it is asked nothing rather than told the weakest word');
});

await check('deployments naming two organisations are two arrangements', () => {
  const problems = arrangementProblems([local, dep('control', 'organisation', 'acme-energy')]);
  assert.ok(problems.some((p) => /acme-energy and climative/.test(p)), problems.join('; '));
});

await check('an empty arrangement is asked nothing, and says so', () => {
  assert.deepEqual(arrangementProblems([]), [
    'an arrangement with no deployments in it claims nothing, and cannot be asked what it claims',
  ]);
  assert.equal(assuranceOf([]), null);
  assert.deepEqual(arrangementProblems('climative'), ['an arrangement is a list of deployment records']);
});

/* ------------------------------------------- the anchor that is not one (failure 1) */

await check('an anchor operated by the organisation is refused by name', () => {
  const inHouse = [local, control, dep('anchor', 'organisation')];
  const problems = arrangementProblems(inHouse);
  assert.ok(problems.some((p) => /not an anchor/.test(p) && /same hands/.test(p)), problems.join('; '));
  assert.equal(assuranceOf(inHouse), null, 'and nothing can be claimed over it at all');
});

await check('an anchor operated by the vendor is refused for the same reason', () => {
  // The tempting one: we build the client, so it feels natural for us to hold the
  // receipts. We are a party to the arrangement, so it buys the same nothing.
  const problems = arrangementProblems([local, control, dep('anchor', 'vendor')]);
  assert.ok(problems.some((p) => /an anchor operated by the vendor is not an anchor/.test(p)), problems.join('; '));
});

await check('every deployment validates individually while the arrangement is false', () => {
  // This is why the rule lives at the arrangement level: nothing about a single record
  // says whether the party operating it is inside the thing it is meant to be outside.
  const inHouse = [local, control, dep('anchor', 'organisation')];
  for (const d of inHouse) assert.deepEqual(deploymentProblems(d), []);
  assert.notDeepEqual(arrangementProblems(inHouse), []);
});

/* --------------------------------------------------- what may be claimed (failure 2) */

await check('the ladder is ordered weakest first, and that order is the API', () => {
  assert.deepEqual(ASSURANCE, ['unwitnessed', 'corroborated', 'independent']);
});

await check('a local-only install is unwitnessed, which is true rather than broken', () => {
  assert.equal(assuranceOf([local]), 'unwitnessed');
  assert.deepEqual(claimProblems([local], 'unwitnessed'), []);
});

await check('a self-hosted pair is corroborated, and cannot claim independence', () => {
  const pair = [local, control];
  assert.equal(assuranceOf(pair), 'corroborated');
  assert.deepEqual(claimProblems(pair, 'corroborated'), []);

  const [problem] = claimProblems(pair, 'independent');
  assert.match(problem, /is corroborated and cannot claim independent/);
  assert.match(problem, /same hands/, 'and it says why, because the reason is the whole decision');
});

await check('the anchor is what buys independence, not the access control', () => {
  assert.equal(assuranceOf([local, control, anchor]), 'independent');
  assert.deepEqual(claimProblems([local, control, anchor], 'independent'), []);
});

await check('an unwitnessed install cannot claim corroboration either', () => {
  const [problem] = claimProblems([local], 'corroborated');
  assert.match(problem, /is unwitnessed and cannot claim corroborated/);
  assert.match(problem, /perfectly self-consistent/);
});

await check('understating is never a problem, because nobody is harmed by it', () => {
  const three = [local, control, anchor];
  assert.deepEqual(claimProblems(three, 'corroborated'), []);
  assert.deepEqual(claimProblems(three, 'unwitnessed'), []);
});

await check('a word outside the ladder is not a claim', () => {
  assert.match(claimProblems([local], 'compliant')[0], /is not something an arrangement can claim/);
  assert.match(claimProblems([local], 'third-party')[0], /is not something an arrangement can claim/);
});

await check('an unsound arrangement backs no claim at all, not even the weakest', () => {
  const inHouse = [local, control, dep('anchor', 'organisation')];
  const [problem] = claimProblems(inHouse, 'unwitnessed');
  assert.match(problem, /cannot back any claim until it is sound/);
});

/* --------------------------------------------- two copies, one party (failure 3) */

await check('a second control-daemon under the same operator is redundancy, not a second party', () => {
  const doubled = [local, control, { ...control, since: '2026-09-01T00:00:00Z' }];
  const problems = arrangementProblems(doubled);
  assert.ok(problems.some((p) => /more than one control deployment/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /one party and must not be counted as two/.test(p)), problems.join('; '));
});

await check('two control deployments under different parties are allowed', () => {
  const shared = [local, control, dep('control', 'external')];
  assert.deepEqual(arrangementProblems(shared), []);
  assert.equal(assuranceOf(shared), 'corroborated', 'still corroborated — an anchor is what the third word needs');
});

/* -------------------------------------------------------- the consequence of hosting */

await check('a hosted control-daemon is a subservice organisation, and the function says so first', () => {
  const hosted = [local, dep('control', 'vendor'), anchor];
  assert.deepEqual(arrangementProblems(hosted), [], 'it is a legal arrangement — it is just one with paperwork');

  const [entry, ...rest] = subservices(hosted);
  assert.deepEqual(rest, []);
  assert.equal(entry.role, 'control');
  assert.equal(entry.operator, 'vendor');
  assert.match(entry.why, /carve-out or inclusive-method decision/);
});

await check('the anchor is a supplier and never a subservice organisation', () => {
  // It is handed a hash and returns a receipt. It performs no control on anybody's
  // behalf, so putting a timestamping CA in a system description would be wrong.
  assert.deepEqual(subservices([local, control, anchor]), []);
  assert.deepEqual(subservices([local, anchor]), []);
});

await check('a managed local daemon is one too — the rule is about who holds the evidence', () => {
  const managed = [dep('local', 'vendor'), control];
  const roles = subservices(managed).map((e) => e.role);
  assert.deepEqual(roles, ['local']);
});

await check('an unsound arrangement reports no subservices rather than a guess', () => {
  assert.deepEqual(subservices([dep('control', 'vendor')]), [], 'no local deployment, so there is nothing to answer about');
});

/* ------------------------------------------------------------------- the vocabulary */

await check('the closed sets are lists, so the prototype names are not secretly members', () => {
  // bc-3muu.1 nearly shipped the other shape and caught it before merge: `'constructor' in
  // obj` is true of every plain object, so a vocabulary written as an object and tested
  // with `in` silently mints the prototype names — precisely the ones nobody writes a test
  // for. Frozen arrays and `includes` have no such hole; this pins that they still do not.
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.match(deploymentProblems({ ...local, role: name })[0], /role must be one of/, name);
    assert.match(deploymentProblems({ ...local, operator: name })[0], /operator must be one of/, name);
    assert.match(claimProblems([local], name)[0], /is not something an arrangement can claim/, name);
  }
});

await check('nothing anybody can set says independent — it is derived every time', () => {
  const pair = [local, control];
  assert.equal(assuranceOf(pair), 'corroborated');
  // The shapes somebody would reach for to say it anyway are refused as unknown fields.
  for (const field of ['assurance', 'independent', 'anchored', 'trusted']) {
    const problems = deploymentProblems({ ...control, [field]: 'independent' });
    assert.ok(problems.some((p) => p.includes(`"${field}" is not part of a deployment record`)), field);
  }
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
