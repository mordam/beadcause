#!/usr/bin/env node
//
// Multi-tenant from the first line — `lib/organisation.js`.
//
//   npm test
//   node test/organisation.mjs
//
// bc-3muu.8: Climative is the *first* service organisation, not the only one. The failure
// this suite exists for is not a bug that can be observed — it is an assumption nobody
// makes on purpose. A schema written while there is one organisation does not say there
// is one organisation; it simply never asks, and the day there is a second the fix is a
// migration over the chains, which are the one thing the service exists to prove were
// never rewritten.
//
// So the checks below are about the shapes that would let that happen, and three of them
// are pointed at deliberately wrong input rather than at the real thing:
//
//   1. `orgProblems` refuses the words a single-tenant install actually writes. `default`
//      is not a bad name — it is a tenant that accumulates real history under a label
//      meaning "nobody", and it is unpickable afterwards.
//   2. `tenancyProblems` is run against the *plausible* single-tenant vocabulary — org on
//      the enrolment record, everything else joined through the instance — because that
//      table passes every other check in the repo and only this one calls it wrong.
//   3. The migration-free property is demonstrated rather than asserted: a second
//      organisation's keys are built and every key the first one already had is compared
//      byte for byte. "A second organisation can enrol without a migration touching
//      existing chains" is an acceptance criterion, and an acceptance criterion nobody
//      exercised is a sentence.
//
// Nothing here touches the filesystem, the network or a git repository, because the module
// does not either — it is a leaf, so a check, a service and a daemon can each hold it.
import assert from 'node:assert/strict';

import {
  LABEL_MAX,
  ORG_FIELD,
  ORG_MAX,
  ORG_MIN,
  RESERVED,
  SEPARATOR,
  STATUSES,
  UNTENANTED,
  belongsTo,
  foreign,
  labelProblems,
  orgProblems,
  partition,
  recordProblems,
  registryProblems,
  routeProblems,
  scope,
  scopeProblems,
  stamp,
  tenancyProblems,
  unscope,
} from '../lib/organisation.js';

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
const climative = { id: 'climative', label: 'Climative', status: 'active', enrolledAt: at };

/* ------------------------------------------------------------------- the id */

await check('the first organisation is a well-formed id, and says nothing about being first', () => {
  assert.deepEqual(orgProblems('climative'), []);
  assert.deepEqual(orgProblems('acme-energy'), []);
  assert.deepEqual(orgProblems('a2b'), []);
});

await check('an id is lowercase, letter-first, and single-dashed', () => {
  for (const bad of ['Climative', 'climative_labs', '2b', '-lead', 'trail-', 'two--dashes', 'has.dot', 'has space']) {
    assert.ok(orgProblems(bad).length, `${bad} should be refused`);
  }
});

await check('an id is bounded at both ends', () => {
  assert.ok(orgProblems('a'.repeat(ORG_MIN - 1)).some((p) => p.includes('shorter')));
  assert.ok(orgProblems('a'.repeat(ORG_MAX + 1)).some((p) => p.includes('longer')));
  assert.deepEqual(orgProblems('a'.repeat(ORG_MAX)), []);
});

await check('whitespace around an id is a different id, not a tidier one', () => {
  assert.ok(orgProblems(' climative').length);
  assert.ok(orgProblems('climative\n').length);
});

await check('nothing but a string is an id', () => {
  for (const bad of [undefined, null, 42, {}, ['climative']]) assert.ok(orgProblems(bad).length);
});

await check('the words a single-tenant install writes are refused, and the refusal says why', () => {
  assert.ok(RESERVED.includes('default'), 'default is the one this is really about');
  for (const word of RESERVED) {
    const problems = orgProblems(word);
    assert.ok(problems.length, `${word} should be reserved`);
    assert.ok(
      problems.some((p) => p.includes('reserved')),
      `${word} should be refused as reserved rather than as malformed — the caller needs to know it is a real word it may not have`
    );
  }
});

await check('every reserved word is itself a legal id, or reserving it proves nothing', () => {
  // If `default` were refused by the shape rule anyway, the reservation would be dead
  // code that looks like a guarantee. Each of them has to be a name somebody could
  // otherwise have taken.
  for (const word of RESERVED) {
    const shapeOnly = orgProblems(word).filter((p) => !p.includes('reserved'));
    assert.deepEqual(shapeOnly, [], `${word} is refused for a second reason, so the reservation is untested`);
  }
});

/* ---------------------------------------------------------------- the label */

await check('a label is one bounded line, and it is not the id', () => {
  assert.deepEqual(labelProblems('Climative'), []);
  assert.deepEqual(labelProblems('Acme Energy Ltd.'), []);
  assert.ok(labelProblems('').length);
  assert.ok(labelProblems('a'.repeat(LABEL_MAX + 1)).length);
  assert.ok(labelProblems('two\nlines').some((p) => p.includes('one line')));
});

/* --------------------------------------------------------------- the record */

await check('an organisation record is id, label, status and when it enrolled', () => {
  assert.deepEqual(recordProblems(climative), []);
});

await check('a record with a field nobody minted is refused', () => {
  const problems = recordProblems({ ...climative, tier: 'enterprise' });
  assert.ok(problems.some((p) => p.includes('tier')));
});

await check('there is no deleted — an organisation withdraws and its records stay', () => {
  assert.deepEqual(STATUSES, ['active', 'withdrawn']);
  assert.deepEqual(recordProblems({ ...climative, status: 'withdrawn' }), []);
  assert.ok(recordProblems({ ...climative, status: 'deleted' }).length);
  assert.ok(recordProblems({ ...climative, status: 'removed' }).length);
});

await check('enrolledAt is UTC, because "since when" is what a continuity claim reduces to', () => {
  assert.deepEqual(recordProblems({ ...climative, enrolledAt: '2026-08-15T17:48:35.123Z' }), []);
  for (const bad of ['2026-08-15', '2026-08-15T14:48:35-03:00', 'yesterday', 1755280115000]) {
    assert.ok(recordProblems({ ...climative, enrolledAt: bad }).length, `${bad} should be refused`);
  }
});

await check('a register of one is fine, which is the state this ships in', () => {
  assert.deepEqual(registryProblems([climative]), []);
  assert.deepEqual(registryProblems([]), []);
});

await check('a second organisation joins a register without argument', () => {
  const acme = { id: 'acme-energy', label: 'Acme Energy', status: 'active', enrolledAt: at };
  assert.deepEqual(registryProblems([climative, acme]), []);
});

await check('an id is never reissued, not even to a withdrawn organisation successor', () => {
  const problems = registryProblems([
    { ...climative, status: 'withdrawn' },
    { id: 'climative', label: 'Climative Holdings', status: 'active', enrolledAt: at },
  ]);
  assert.ok(problems.some((p) => p.includes('never reissued')), problems.join('; '));
});

await check('two organisations a human cannot tell apart are refused', () => {
  const problems = registryProblems([climative, { id: 'climative-uk', label: ' climative ', status: 'active', enrolledAt: at }]);
  assert.ok(problems.some((p) => p.includes('tell them apart')), problems.join('; '));
});

await check('a broken entry is reported once, by index, and does not poison the rest', () => {
  const problems = registryProblems([{ id: 'DEFAULT' }, climative]);
  assert.ok(problems.every((p) => !p.includes('registered twice')));
  assert.ok(problems.some((p) => p.startsWith('entry 0:')));
});

/* --------------------------------------------------------------- the prefix */

await check('a key begins with the organisation', () => {
  assert.equal(scope('climative', 'chains', 'evidence'), `climative${SEPARATOR}chains${SEPARATOR}evidence`);
  assert.deepEqual(unscope('climative/chains/evidence'), { org: 'climative', parts: ['chains', 'evidence'] });
});

await check('a caller that cannot name the organisation does not get a key', () => {
  assert.throws(() => scope('default', 'chains'), /reserved/);
  assert.throws(() => scope('', 'chains'), /cannot scope/);
  assert.throws(() => scope(undefined, 'chains'), /cannot scope/);
  assert.throws(() => scope('climative'), /needs something under the organisation/);
});

await check('nothing under an organisation can climb out of it', () => {
  assert.throws(() => scope('climative', '..', 'acme-energy'), /climb out|not a usable key part/);
  assert.throws(() => scope('climative', 'a/b'), /not a usable key part/);
  assert.throws(() => scope('climative', '../acme-energy'), /not a usable key part/);
});

await check('unscope is the tolerant direction — it answers null rather than throwing', () => {
  assert.equal(unscope('climative'), null, 'an organisation alone is not a key to anything');
  assert.equal(unscope(''), null);
  assert.equal(unscope(null), null);
  assert.equal(unscope('climative/../acme-energy/x'), null);
  assert.equal(unscope('Climative/chains'), null, 'an id that is not one is not a scope');
  assert.equal(unscope('default/chains'), null, 'and neither is a reserved word');
});

await check('shape alone cannot tell a scoped key from an unscoped one, and the module says so', () => {
  // `chains` is a perfectly legal organisation id, so `chains/evidence` is indistinguishable
  // from a key belonging to an organisation called `chains`. Any check that claimed to tell
  // them apart without the register would be guessing, and guessing at a tenant boundary is
  // the thing this file exists to stop.
  assert.deepEqual(unscope('chains/evidence'), { org: 'chains', parts: ['evidence'] });
  assert.deepEqual(scopeProblems('chains/evidence'), []);

  // Hand it the register and the question becomes decidable, which is the form to use
  // anywhere a wrong answer would cross a boundary.
  const known = ['climative'];
  assert.equal(unscope('chains/evidence', known), null);
  assert.deepEqual(unscope('climative/chains/evidence', known), { org: 'climative', parts: ['chains', 'evidence'] });
});

await check('an unscoped key is refused with the reason, not with "invalid"', () => {
  assert.deepEqual(scopeProblems('climative/chains/x'), []);

  const malformed = scopeProblems('Climative/chains/x');
  assert.equal(malformed.length, 1);
  assert.ok(malformed[0].includes('prefix comparison rather than a parse'), malformed[0]);
  assert.ok(malformed[0].includes('not the shape'), malformed[0]);

  const unregistered = scopeProblems('chains/x', ['climative']);
  assert.equal(unregistered.length, 1);
  assert.ok(unregistered[0].includes('"chains" is not registered'), unregistered[0]);

  assert.deepEqual(scopeProblems(''), ['a key is required']);
});

await check('the boundary really is a prefix comparison, which is the point of putting it first', () => {
  const mine = scope('climative', 'chains', 'head');
  const theirs = scope('acme-energy', 'chains', 'head');
  assert.ok(mine.startsWith(`climative${SEPARATOR}`));
  assert.ok(!theirs.startsWith(`climative${SEPARATOR}`));
  // And the near-miss that a naive `startsWith('climative')` would let through.
  const lookalike = scope('climative-uk', 'chains', 'head');
  assert.ok(lookalike.startsWith('climative'), 'the trap exists');
  assert.ok(!lookalike.startsWith(`climative${SEPARATOR}`), 'and the separator is what closes it');
});

/* ---------------------------------------------------------------- the routes */

await check('a route names the organisation', () => {
  assert.deepEqual(routeProblems('/api/o/:org/chains'), []);
  assert.deepEqual(routeProblems('/api/o/:org/chains/:chain'), []);
});

await check('a route that names none is refused unless it says why', () => {
  const problems = routeProblems('/api/chains/:chain');
  assert.ok(problems.some((p) => p.includes('names no organisation')), problems.join('; '));
  for (const template of Object.keys(UNTENANTED)) {
    assert.deepEqual(routeProblems(template), [], `${template} is in UNTENANTED and should pass`);
    assert.ok(UNTENANTED[template].length > 20, `${template} needs a sentence, not a shrug`);
  }
});

await check('the organisation is resolved before anything else it could be scoped by', () => {
  const problems = routeProblems('/api/chains/:chain/:org');
  assert.ok(
    problems.some((p) => p.includes('resolves :chain before it knows the organisation')),
    problems.join('; ')
  );
});

await check('a route cannot both carry an organisation and claim it needs none', () => {
  // Pointed at a deliberately contradictory register, because the real one does not contain
  // the mistake and a rule only ever run against input that passes is a rule nobody has
  // seen fire.
  const broken = { '/api/o/:org/chains': 'it is only ever the one organisation, so this is fine' };
  const problems = routeProblems('/api/o/:org/chains', broken);
  assert.ok(problems.some((p) => p.includes('claims in UNTENANTED that it needs no organisation')), problems.join('; '));
  assert.deepEqual(routeProblems('/api/o/:org/chains'), [], 'and against the real register it is simply correct');
});

await check('a malformed template is refused rather than parsed optimistically', () => {
  assert.ok(routeProblems('api/o/:org').length, 'a template is a path');
  assert.ok(routeProblems('/api//:org').some((p) => p.includes('empty segment')));
  assert.ok(routeProblems('/api/:org/x/:org').some((p) => p.includes('twice')));
  assert.ok(routeProblems(42).length);
});

/* -------------------------------------------------------- the record vocabulary */

await check('a vocabulary whose envelope carries the organisation is what is wanted', () => {
  const vocabulary = {
    envelope: { instance: 'token', org: 'token', seq: 'count', at: 'at', prev: 'digest' },
    fields: { enrolment: { fingerprint: 'digest' }, 'chain-head': { ref: 'ref', head: 'sha' } },
  };
  assert.deepEqual(tenancyProblems(vocabulary), []);
});

await check('the plausible single-tenant table — org at enrolment, joined thereafter — is named as the failure', () => {
  // This is the design that passes every other check in the repo: a tenant recorded once
  // and resolved by walking back to the enrolment through `instance`. It is smaller, it
  // is obvious, and the only thing wrong with it is that a derived tenant has no history.
  const vocabulary = {
    envelope: { instance: 'token', seq: 'count', at: 'at', prev: 'digest' },
    fields: {
      enrolment: { fingerprint: 'digest', org: 'token' },
      'chain-head': { ref: 'ref', head: 'sha' },
      criterion: { control: 'control', state: 'state' },
    },
  };
  const problems = tenancyProblems(vocabulary);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('a join rather than a fact'), problems[0]);
  assert.ok(problems[0].includes('enrolment'), 'it should say which kind is hoarding the tenant');
});

await check('a table with no organisation anywhere says the migration it would cost', () => {
  const vocabulary = {
    envelope: { instance: 'token', seq: 'count' },
    fields: { 'chain-head': { ref: 'ref', head: 'sha' } },
  };
  const problems = tenancyProblems(vocabulary);
  assert.equal(problems.length, 1);
  assert.ok(problems[0].includes('migration over the chains'), problems[0]);
});

await check('the tenant has one home — a kind may not carry it beside the envelope', () => {
  const vocabulary = {
    envelope: { instance: 'token', org: 'token' },
    fields: { enrolment: { fingerprint: 'digest', org: 'token' } },
  };
  assert.ok(tenancyProblems(vocabulary).some((p) => p.includes('one home')));
});

await check('a vocabulary that mints nothing is not a vocabulary', () => {
  assert.ok(tenancyProblems({ envelope: { org: 'token' }, fields: {} }).some((p) => p.includes('mints no kinds')));
  assert.ok(tenancyProblems(null).length);
  assert.ok(tenancyProblems('records').length);
});

/* ------------------------------------------------------------ stamping records */

await check('a record gets its organisation through one funnel', () => {
  const rec = stamp('climative', { kind: 'chain-head', head: 'abc' });
  assert.equal(rec[ORG_FIELD], 'climative');
  assert.ok(belongsTo('climative', rec));
  assert.ok(!belongsTo('acme-energy', rec));
});

await check('stamping does not mutate what it was given', () => {
  const original = { kind: 'chain-head' };
  stamp('climative', original);
  assert.equal(original[ORG_FIELD], undefined);
});

await check('re-filing another organisation record is refused, not silently won', () => {
  const theirs = stamp('acme-energy', { kind: 'chain-head' });
  assert.throws(() => stamp('climative', theirs), /already carries org "acme-energy"/);
  assert.doesNotThrow(() => stamp('acme-energy', theirs), 'stamping twice with the same id is careful, not wrong');
  assert.throws(() => stamp('climative', { kind: 'chain-head', org: null }), /not an organisation/);
  assert.throws(() => stamp('climative', null), /not a record/);
  assert.throws(() => stamp('default', {}), /cannot stamp a record/);
});

await check('a record with no organisation belongs to nobody, including the only one there is', () => {
  assert.ok(!belongsTo('climative', { kind: 'chain-head' }));
  assert.ok(!belongsTo('climative', { kind: 'chain-head', org: null }));
  assert.ok(!belongsTo('default', stamp('climative', {})), 'and a reserved word matches nothing at all');
});

await check('partition groups by tenant and hands back the ones that name none', () => {
  const records = [
    stamp('climative', { seq: 0 }),
    stamp('acme-energy', { seq: 1 }),
    stamp('climative', { seq: 2 }),
    { seq: 3 },
    { seq: 4, org: 'Default' },
  ];
  const { byOrg, untenanted } = partition(records);
  assert.deepEqual([...byOrg.keys()].sort(), ['acme-energy', 'climative']);
  assert.equal(byOrg.get('climative').length, 2);
  assert.equal(untenanted.length, 2, 'a malformed org is untenanted, not its own tenant');
});

await check('unknown fails closed — an untenanted record is foreign to everybody', () => {
  const records = [stamp('climative', { seq: 0 }), stamp('acme-energy', { seq: 1 }), { seq: 2 }];
  const leaked = foreign('climative', records);
  assert.equal(leaked.length, 2);
  assert.ok(leaked.some((r) => r.seq === 2), 'a record whose tenant is unknown is not safely nobody\'s');
  assert.deepEqual(foreign('climative', []), []);
  assert.deepEqual(foreign('climative', null), []);
});

/* ------------------------------------------- the acceptance criterion, exercised */

await check('a second organisation enrols without a migration touching existing keys', () => {
  const before = [
    scope('climative', 'chains', 'evidence'),
    scope('climative', 'chains', 'management'),
    scope('climative', 'instances', 'a1b2c3'),
  ];
  const beforeRecords = before.map((key, i) => stamp('climative', { key, seq: i }));

  // Everything the second organisation needs, built the only way there is to build it.
  const after = [
    scope('acme-energy', 'chains', 'evidence'),
    scope('acme-energy', 'instances', 'd4e5f6'),
  ];
  const all = [...beforeRecords, ...after.map((key, i) => stamp('acme-energy', { key, seq: i }))];

  // The criterion, literally: not one existing key changed, and not one existing record
  // was rewritten to make room.
  const still = all.filter((r) => belongsTo('climative', r));
  assert.deepEqual(still.map((r) => r.key), before, 'existing keys are byte-identical');
  assert.deepEqual(still, beforeRecords, 'and so are the records under them');

  // And no key of one collides with, or is a prefix of, a key of the other.
  for (const mine of before) {
    for (const theirs of after) {
      assert.notEqual(mine, theirs);
      assert.ok(!theirs.startsWith(`${mine}${SEPARATOR}`) && !mine.startsWith(`${theirs}${SEPARATOR}`));
    }
  }
});

await check('the register itself is what grows, and nothing else has to', () => {
  const register = [climative];
  const grown = [...register, { id: 'acme-energy', label: 'Acme Energy', status: 'active', enrolledAt: at }];
  assert.deepEqual(registryProblems(grown), []);
  assert.deepEqual(register, [climative], 'growing it is an append, not an edit');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
