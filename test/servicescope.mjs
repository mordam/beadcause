#!/usr/bin/env node
//
// The service inside the boundary of the audits it serves — `lib/servicescope.js`.
//
//   npm test
//   node test/servicescope.mjs
//
// bc-3muu.7. Two halves, and each one has a way of rotting quietly.
//
// The subservice decision rots by staying right while the arrangement changes underneath
// it. `not-a-subservice` is true today only because bc-3muu.9 put every deployment in the
// organisation's own hands, so the checks below hand `methodFor` an arrangement where
// somebody else operates the witness and assert that the decision flips to required — and
// that the record still saying otherwise is refused. Both directions are checked, because
// the opposite mistake — a method recorded over a subservice organisation that does not
// exist — validates perfectly and sends an auditor looking for an agreement nobody signed.
//
// The control enumeration rots by claiming. `enforced` names a module, so every module
// named is opened here: a control that says lib/publishable.js does it, in a release where
// somebody moved lib/publishable.js, reads as built and is not. `owed` and `partial` name
// a bead, and an entry that names neither is a gap with no owner, which is the state this
// whole file exists to convert into a list.
//
// TWO CROSS-MODULE CHECKS RUN ONLY WHEN THEIR NEIGHBOUR EXISTS, and say so loudly when it
// does not. lib/controls.js (bc-4r10.1) and lib/boundary.js (bc-4r10.2) are landing on
// their own beads; this module is a leaf and imports neither, which is what lets it ship
// before them. The moment either arrives, the skip becomes a real check with no edit here:
// every enumerated id has to resolve in the corpus, and the components have to survive
// `boundaryProblems` when spread into a real boundary record. That is the free check the
// bc-3muu.6 note describes — proving a projection still fits rather than asserting a shape
// this file invented — and the point of writing it now is that it starts working on
// somebody else's merge rather than on somebody remembering.
//
// Nothing here touches the network or a git repository. It reads two files: the modules
// the enumeration names.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { shipped } from '../lib/operator.js';
import {
  CARVE_OUT_CUECS,
  COMPONENTS,
  CONTROLS,
  DECISIONS,
  METHODS,
  NOT_A_SUBSERVICE,
  SERVICE,
  STATES,
  controls,
  coverage,
  entry,
  enumerationProblems,
  frameworkOf,
  inFramework,
  methodFor,
  methodProblems,
  owed,
  statement,
} from '../lib/servicescope.js';

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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const at = '2026-08-15T17:48:35Z';
const dep = (role, operator, org = 'climative') => ({ role, operator, org, since: at });
const SHIPPED = shipped('climative', at);

/** Import a sibling that may not have landed yet. Null, and a loud line, when it has not. */
async function neighbour(spec, why) {
  try {
    return await import(spec);
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;
    console.log(`SKIP  ${spec} is not in this release yet — ${why}`);
    return null;
  }
}

/* ------------------------------------------------------------ the enumeration */

await check('the enumeration is sound, and it is checked at import rather than on demand', () => {
  assert.deepEqual(enumerationProblems(), []);
  assert.ok(CONTROLS.length >= 20, `only ${CONTROLS.length} controls enumerated`);
  // Frozen, because it is handed to every caller in the process.
  assert.throws(() => CONTROLS.push({}), TypeError);
  assert.throws(() => {
    CONTROLS[0].state = 'enforced';
  }, TypeError);
});

await check('every module an entry names is a module in this release', () => {
  const named = CONTROLS.filter((c) => c.by).map((c) => c.by);
  assert.ok(named.length >= 3, 'nothing claims to be built, which cannot be right');
  for (const module of new Set(named)) {
    assert.ok(
      fs.existsSync(path.join(root, module)),
      `${module} is named as what does a control and is not in this release — the entry reads as built`
    );
  }
});

await check('the four themes the bead names are each enumerated', () => {
  // Access, availability, change management and logging: the bead's own list of what gets
  // tested. A later edit that drops one leaves a theme with no row and nothing says so.
  const ids = CONTROLS.map((c) => c.id);
  for (const [theme, id] of [
    ['access', 'SOC2.CC6.1'],
    ['availability', 'SOC2.A1.1'],
    ['change management', 'SOC2.CC8.1'],
    ['logging', 'ISO27001.A.8.15'],
    ['confidentiality — the mitigation the epic turns on', 'SOC2.C1.1'],
  ]) {
    assert.ok(ids.includes(id), `${theme} is not enumerated: ${id} is missing`);
  }
});

await check('all three frameworks are answered, and the ISO half is not a copy of the SOC 2 half', () => {
  const cov = coverage();
  assert.equal(cov.total, CONTROLS.length);
  for (const token of ['SOC2', 'ISO27001', 'ISO42001']) {
    assert.ok(inFramework(token).length > 0, `${token} has no entry, so an ISO reader is told nothing`);
    assert.equal(cov.byFramework[token], inFramework(token).length);
  }
  assert.equal(
    Object.values(cov.byState).reduce((a, b) => a + b, 0),
    CONTROLS.length,
    'a control is in a state nobody counted'
  );
  assert.equal(frameworkOf('ISO42001.A.6.2.8'), 'ISO42001');
});

await check('what is owed is reported, worst first, with an owner on every line', () => {
  const list = owed();
  assert.equal(list.length, controls('owed').length + controls('partial').length);
  assert.ok(list.length > 0, 'nothing is owed, which is not true of a service that does not exist yet');
  // owed before partial: a control with nothing behind it is a different conversation.
  const firstPartial = list.findIndex((o) => o.state === 'partial');
  const lastOwed = list.map((o) => o.state).lastIndexOf('owed');
  if (firstPartial !== -1) assert.ok(lastOwed < firstPartial, 'partial entries are mixed in among the owed ones');
  for (const o of list) assert.match(o.bead, /^bc-/, `${o.id} is owed by nobody`);
});

await check('a state and its evidence cannot disagree — both directions refused', () => {
  const good = CONTROLS.find((c) => c.state === 'enforced');
  // enforced with a bead is a control still being built wearing the word for one that is not.
  assert.match(
    enumerationProblems([{ ...good, bead: 'bc-3muu.3' }]).join(' '),
    /enforced names bc-3muu\.3, so it is not enforced yet/
  );
  // owed with a module is a claim that something already does it.
  const gap = CONTROLS.find((c) => c.state === 'owed');
  assert.match(
    enumerationProblems([{ ...gap, by: 'lib/publishable.js' }]).join(' '),
    /owed names lib\/publishable\.js, which says something already does this/
  );
  assert.match(enumerationProblems([{ ...gap, bead: undefined }]).join(' '), /needs `bead`/);
  assert.match(enumerationProblems([{ ...good, by: undefined }]).join(' '), /needs `by`/);
});

await check('a control id is held to the shape its framework uses, and a typo is refused', () => {
  const good = CONTROLS[0];
  for (const id of ['SOC2.CC6', 'ISO27001.A.5', 'ISO42001.A6.2.8', 'SOC.CC6.1', 'CC6.1', 'SOC2.XX6.1', '']) {
    assert.match(
      enumerationProblems([{ ...good, id }]).join(' '),
      /is not the shape of a corpus control id/,
      `${id} was accepted`
    );
  }
  for (const id of ['SOC2.CC6.1', 'SOC2.A1.2', 'SOC2.PI1.4', 'ISO27001.A.8.15', 'ISO42001.A.6.2.8', 'ISO42001.A.10.2']) {
    assert.deepEqual(
      enumerationProblems([{ ...good, id }]).filter((p) => p.includes('shape of a corpus control id')),
      [],
      `${id} was refused`
    );
  }
});

await check('one control is one row, and an unknown field is refused rather than stored', () => {
  const c = CONTROLS[0];
  assert.match(enumerationProblems([c, { ...c }]).join(' '), /is enumerated twice/);
  assert.match(enumerationProblems([{ ...c, tested: true }]).join(' '), /"tested" is not part of an enumerated control/);
  // The closed sets are membership-tested with `includes`, not `in` — see test/operator.mjs
  // for what `in` does to a closed vocabulary written over a plain object.
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.match(enumerationProblems([{ ...c, state: name }]).join(' '), /is not one of enforced, partial, owed/, name);
  }
});

await check('the enumeration answers no control question with the service itself', () => {
  // The trap in a system that monitors other systems. bc-3muu.5 is the witness watching
  // its tenants — the product — and it may be named as context but never as the control.
  const monitoring = CONTROLS.find((c) => c.id === 'SOC2.CC7.2');
  assert.equal(monitoring.state, 'owed');
  assert.notEqual(monitoring.bead, 'bc-3muu.5', 'monitoring of the witness is answered with the witness');
  for (const c of CONTROLS) {
    assert.ok(!/lib\/servicescope\.js/.test(c.by || ''), `${c.id} cites this file as its own control`);
  }
});

/* ---------------------------------------------------- the subservice decision */

await check('the shipped arrangement records a decision rather than an empty list', () => {
  const found = methodFor(SHIPPED);
  assert.equal(found.decision, NOT_A_SUBSERVICE);
  assert.equal(found.required, false);
  assert.deepEqual([...found.operators], []);
  assert.ok(found.why.length > 60, 'the answer is a word with no argument behind it');
  assert.ok(DECISIONS.includes(found.decision));
  assert.deepEqual(methodProblems(SHIPPED, NOT_A_SUBSERVICE), []);
});

await check('a witness somebody else operates makes the method required, and names them', () => {
  const hosted = [dep('local', 'organisation'), dep('control', 'vendor')];
  const found = methodFor(hosted);
  assert.equal(found.required, true);
  assert.equal(found.decision, null, 'a method was defaulted, and a method is a commitment somebody makes');
  assert.deepEqual([...found.operators], ['vendor']);
  assert.deepEqual([...found.cuecs], [...CARVE_OUT_CUECS]);
  assert.ok(CARVE_OUT_CUECS.length > 0, 'a carve-out owes at least one complementary user entity control');
  for (const method of METHODS) assert.deepEqual(methodProblems(hosted, method), []);
  assert.match(
    methodProblems(hosted, NOT_A_SUBSERVICE).join(' '),
    /removes a party from the description rather than deciding about it/
  );
});

await check('recording a method with nobody to record it about is refused too', () => {
  for (const method of METHODS) {
    assert.match(
      methodProblems(SHIPPED, method).join(' '),
      /describes a subservice organisation that does not exist/,
      method
    );
  }
  assert.match(methodProblems(SHIPPED, 'carved out').join(' '), /is not something a system description can record/);
});

await check('an arrangement nobody could read answers null rather than the comfortable word', () => {
  // The same distinction `assuranceOf` draws. A caller handed `not-a-subservice` for a
  // record that did not validate would write it into a system description.
  for (const broken of [[], [dep('control', 'organisation')], [dep('anchor', 'organisation')], 'not a list']) {
    assert.equal(methodFor(broken), null, JSON.stringify(broken));
    assert.equal(statement(broken), null);
    assert.equal(entry(broken), null);
  }
  assert.match(methodProblems([], NOT_A_SUBSERVICE).join(' '), /cannot carry a subservice decision until it is sound/);
});

/* ------------------------------------------------------- what a description gets */

await check('the description entry is one seam, and the statement is generated from it', () => {
  const e = entry(SHIPPED);
  assert.equal(e.service, SERVICE);
  assert.equal(e.components, COMPONENTS);
  assert.equal(e.controls, CONTROLS);
  assert.deepEqual(e.coverage, coverage());
  assert.equal(e.method.decision, NOT_A_SUBSERVICE);

  const said = statement(SHIPPED);
  assert.match(said, /^[A-Z]/, 'a paragraph in a system description starts with a capital letter');
  assert.match(said, /carved out of the system description and inside the boundary of the audit/);
  assert.match(said, /not a subservice organisation/);
  assert.ok(said.includes(String(CONTROLS.length)), 'the statement does not say how many controls were enumerated');
  // The hosted case has to read differently, or the paragraph is decoration.
  const hosted = statement([dep('local', 'organisation'), dep('control', 'vendor')]);
  assert.match(hosted, /carve-out or inclusive-method decision is owed/);
});

await check('the components are carved out of the description and say what they still bear on', () => {
  assert.equal(COMPONENTS.length, 2);
  const [host, store] = COMPONENTS;
  assert.equal(host.kind, 'host');
  assert.equal(store.kind, 'datastore');
  for (const c of COMPONENTS) {
    assert.equal(c.disposition, 'carved-out');
    assert.ok(c.bearsOn.length > 40, `${c.id} is carved out with nothing recorded against it`);
    assert.match(c.id, /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
    assert.throws(() => {
      c.disposition = 'inside';
    }, TypeError);
  }
  // The contentless rule is the confidentiality argument and it is stated on the store.
  assert.match(store.why, /no content of any kind|refuses anything else/);
  assert.match(SERVICE.neverHolds, /bead text/);
});

/* --------------------------------------------------------- the neighbours, when here */

await check('every enumerated id resolves in the corpus', async () => {
  const corpus = await neighbour('../lib/controls.js', 'ids are held to their shape only until it lands (bc-4r10.1)');
  if (!corpus) return;
  const bad = CONTROLS.map((c) => c.id).filter((id) => !corpus.isControl(id));
  assert.deepEqual(bad, [], 'ids enumerated against a corpus that does not have them');
  // And the crosswalk is what joins the SOC 2 rows to their ISO counterparts, which is why
  // this file does not keep a second list of them by hand.
  const access = corpus.satisfiedBy('SOC2.CC6.1');
  assert.ok(Array.isArray(access));
});

await check('the components survive a real boundary record', async () => {
  const boundary = await neighbour('../lib/boundary.js', 'the component shape is copied by hand until it lands (bc-4r10.2)');
  if (!boundary) return;
  const record = boundary.boundaryFor('climative');
  assert.ok(record, 'no boundary to spread the components into');
  const taken = new Set(record.components.map((c) => c.id));
  for (const c of COMPONENTS) assert.ok(!taken.has(c.id), `${c.id} is already a component of that boundary`);
  const merged = { ...record, components: [...record.components, ...COMPONENTS] };
  assert.deepEqual(boundary.boundaryProblems(merged), [], 'the components do not fit the boundary record');
  assert.deepEqual([...boundary.DISPOSITIONS], ['inside', 'carved-out']);
  assert.deepEqual([...boundary.METHODS], [...METHODS], 'the method words drifted apart from lib/boundary.js');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
