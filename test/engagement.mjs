#!/usr/bin/env node
//
// The engagement names four terms, the two dates are derived from readiness, and nothing
// here can be told a date — `lib/engagement.js`.
//
//   npm test
//   node test/engagement.mjs
//
// bc-4r10.13 is the bead where a SOC 2 programme usually acquires its first false fact: a
// window open date, chosen in a planning meeting, that nothing later re-checks. The module
// refuses to hold one, and this suite is mostly about proving the refusal is real rather
// than stylistic.
//
// **A date that cannot be stored** is the first. There is no date field, `schedule()`
// returns `null` for both dates unconditionally, and the tests below drive the gates with
// fixture registers — a register where every criterion is met against an enumerated
// population opens both gates, and taking the evidence off one row shuts them again with no
// other edit. That is the same argument `test/gapassessment.mjs` makes about a state,
// applied to the field a schedule is built out of.
//
// **The stricter gate binds** is the second, and it falls out of bc-j0o3's answer rather
// than being written down: the Type I as-of date and the window open date are one day, so
// the design gate can never be the one that binds. A fixture with controls described and no
// evidence proves it — design open, operating shut, and the Type I still not settable.
//
// **An emptiness that says which emptiness it is** is the third. No firm has been asked,
// and `selection()` says `unsolicited` rather than leaving a null that reads the same as a
// failed search. The four states are driven from fixtures because three of them are
// unreachable from the shipped data.
//
// **A term that cannot be filled in** is the fourth, and it is the finding worth having:
// the subservice method is refused because the boundary's subservice census is `partial`,
// so the empty list means unsurveyed rather than none — and a fixture whose census is
// enumerated flips the same code to "none", which is a different sentence entirely.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CENSUS_KINDS, METHODS, boundaryFor } from '../lib/boundary.js';
import { ASSESSMENT, assess } from '../lib/gapassessment.js';
import { ELECTED as POLICY_ELECTED, ROLES as POLICY_ROLES } from '../lib/policies.js';
import { SECTION_IDS } from '../lib/systemdescription.js';
import {
  BRIDGE_MAX_MONTHS,
  BRIDGE_STATES,
  DECIDED_BY,
  ELECTED,
  FIRM_CLASSES,
  GATES,
  HELD_BY,
  LETTER_TERMS,
  MIN_QUOTES,
  PLATFORM_LEAD_MONTHS,
  QUOTES,
  QUOTE_TERMS,
  REPORT_PLAN,
  ROLES,
  SELECTION_STATES,
  SEPARATING,
  STEPS,
  STEP_STATES,
  TOOLING_GATED_ON,
  bridge,
  engagement,
  engagementProblems,
  letter,
  letterProblems,
  nonGoal,
  platformPurchase,
  quoteProblems,
  readiness,
  render,
  schedule,
  selection,
  stepsIn,
  summarise,
} from '../lib/engagement.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/** A boundary whose every census is enumerated — nothing left to survey. */
const surveyed = (over = {}) => ({
  serviceOrganisation: 'Fixture',
  system: 'A system',
  subservice: [],
  census: Object.fromEntries(CENSUS_KINDS.map((k) => [k, { state: 'enumerated' }])),
  ...over,
});

/** The shipped boundary's shape: nothing surveyed, so an empty list means unknown. */
const unsurveyed = (over = {}) => ({
  serviceOrganisation: 'Fixture',
  system: 'A system',
  subservice: [],
  census: Object.fromEntries(CENSUS_KINDS.map((k) => [k, { state: 'partial', held: 'elsewhere' }])),
  ...over,
});

/** A register of one criterion, in whatever state the caller wants. */
const register = (over = {}) => [
  {
    id: 'SOC2.CC1.1',
    owner: 'executive sponsor',
    population: [],
    control: 'A described control.',
    evidence: 'Something an auditor could sample.',
    why: 'A sentence long enough to be worth reading, which is the whole of what this field is for.',
    bears: null,
    held: null,
    ...over,
  },
];

/** A quote that passes, so a test can break exactly one thing about it. */
const quote = (over = {}) => ({
  firm: 'A firm',
  class: 'boutique-assurance',
  covers: QUOTE_TERMS.filter((t) => t.required).map((t) => t.id),
  answers: Object.fromEntries(SEPARATING.map((q) => [q.id, 'They answered.'])),
  peerReviewedOn: '2026-02-01',
  ...over,
});

/* ------------------------------------------------------- the shipped register */

test('the shipped engagement is clean', () => {
  assert.deepEqual(engagementProblems(), []);
});

test('the categories and the roles come from the policy set and are not restated', () => {
  assert.deepEqual(ELECTED, POLICY_ELECTED);
  assert.deepEqual(ROLES, POLICY_ROLES);
  const source = fs.readFileSync(path.join(root, 'lib/engagement.js'), 'utf8');
  assert.equal(source.match(/\[\s*'CC'\s*,\s*'A'\s*,\s*'C'\s*\]/), null, 'a second copy of the election would disagree within a quarter');
});

test('the module joins the boundary, the assessment and the description, and reaches for nothing else', () => {
  // lib/systemdescription.js and lib/gapassessment.js pin their import lists for the same
  // reason: nothing describing the Climative system may reach for a module that describes
  // beadcause, which the boundary carves out.
  const source = fs.readFileSync(path.join(root, 'lib/engagement.js'), 'utf8');
  const imports = [...source.matchAll(/^import .* from '(\.\/[^']+)';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(imports, ['./boundary.js', './gapassessment.js', './systemdescription.js']);
});

test('every register is frozen, entries included', () => {
  for (const [name, list] of [
    ['FIRM_CLASSES', FIRM_CLASSES],
    ['SEPARATING', SEPARATING],
    ['QUOTE_TERMS', QUOTE_TERMS],
    ['LETTER_TERMS', LETTER_TERMS],
    ['STEPS', STEPS],
  ]) {
    assert.ok(Object.isFrozen(list), `${name} is not frozen`);
    for (const entry of list) assert.ok(Object.isFrozen(entry), `an entry of ${name} is not frozen`);
  }
  assert.ok(Object.isFrozen(REPORT_PLAN) && Object.isFrozen(DECIDED_BY) && Object.isFrozen(QUOTES));
});

test('no shipped record carries a date, because a date is what goes stale', () => {
  const source = fs.readFileSync(path.join(root, 'lib/engagement.js'), 'utf8');
  // Comments and prose may discuss a date; a literal one in code is the thing being refused.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  const dates = (code.match(/\b\d{4}-\d{2}-\d{2}\b/g) || []).filter((d) => !code.includes(`'${d}T`));
  assert.deepEqual(dates, [], 'a date literal in the code is a schedule somebody typed');
  const s = schedule();
  assert.equal(s.typeOneAsOf, null);
  assert.equal(s.typeTwoOpensOn, null);
});

/* ------------------------------------------------------------------ the gates */

test('both gates are shut today, and the criteria holding them are the assessment’s', () => {
  const r = readiness();
  assert.equal(r.design.open, false);
  assert.equal(r.operating.open, false);
  assert.equal(r.operating.holding.length, 38, 'nothing is met, so every elected criterion holds the window shut');
  assert.deepEqual(
    r.design.holding,
    assess(ASSESSMENT, boundaryFor(HELD_BY))
      .filter((row) => !row.control)
      .map((row) => row.id)
      .sort()
  );
});

test('a met register against an enumerated population opens both gates', () => {
  const b = surveyed();
  const r = readiness(register(), b);
  assert.equal(r.design.open, true);
  assert.equal(r.operating.open, true);
  assert.equal(schedule(register(), b).settable, true);
  assert.equal(schedule(register(), b).binding, null, 'nothing binds once the operating gate is open');
});

test('taking the evidence off one row shuts the operating gate and leaves the design gate open', () => {
  const b = surveyed();
  const r = readiness(register({ evidence: null }), b);
  assert.equal(r.design.open, true, 'the control is still described, which is what a Type I opines on');
  assert.equal(r.operating.open, false);
  assert.deepEqual(r.operating.holding, ['SOC2.CC1.1']);
});

test('a met row against a population nobody enumerated still holds the window shut', () => {
  // The half people leave out. A register that reads 100% met over an estate nobody has
  // surveyed cannot have been tested, and the confidence is what says so.
  const b = unsurveyed();
  const r = readiness(register({ population: ['repo'] }), b);
  assert.equal(r.design.open, true);
  assert.equal(r.operating.open, false, 'provisional is not testable, whatever the state says');
  assert.deepEqual(r.operating.holding, ['SOC2.CC1.1']);
});

test('the design gate can never be the binding one, because bc-j0o3 put both dates on one day', () => {
  assert.equal(REPORT_PLAN.sameDay, true);
  assert.equal(DECIDED_BY.type, 'bc-j0o3');
  const b = surveyed();
  const s = schedule(register({ evidence: null }), b);
  assert.equal(s.binding, 'operating');
  assert.equal(s.typeOne.gate, 'operating', 'the Type I is dated on the stricter gate while both dates are one day');
  assert.equal(s.typeOne.open, false);
  assert.equal(s.settable, false);
  assert.equal(s.typeOneAsOf, null, 'even open, this never yields a date — somebody sets one, and this says whether they may');
});

test('the gate names are closed, and every gated step names one', () => {
  for (const step of STEPS) {
    if (step.gate === undefined) continue;
    assert.ok(GATES.includes(step.gate), `${step.id}: ${step.gate}`);
  }
  assert.deepEqual([...GATES].sort(), ['design', 'operating']);
});

/* -------------------------------------------------------------- the selection */

test('nobody has been asked, and that is a state rather than a blank', () => {
  const s = selection();
  assert.equal(s.state, 'unsolicited');
  assert.equal(s.received, 0);
  assert.equal(s.firm, null);
  assert.match(s.why, /No firm has been asked/);
  assert.deepEqual(QUOTES, []);
});

test('all four selection states are reachable, and one quote is not two', () => {
  assert.equal(selection([quote()]).state, 'quoting', `${MIN_QUOTES} quotes are needed to compare a price to anything`);
  assert.equal(selection([quote(), quote({ firm: 'Another' })]).state, 'quoted');
  assert.equal(selection([], { firm: 'A firm' }).state, 'engaged');
  assert.deepEqual([...SELECTION_STATES].sort(), ['engaged', 'quoted', 'quoting', 'unsolicited']);
});

test('a quote that prices one report is not comparable to a quote that prices both', () => {
  // bc-j0o3 chose a sequencing. A Type-II-only quote prices a different plan, and the
  // cheaper number wins an argument it was not in.
  const half = quote({ covers: ['type-ii', 'peer-review'] });
  assert.equal(selection([half, quote({ firm: 'Another' })]).state, 'quoting');
  assert.equal(selection([half, quote({ firm: 'Another' })]).comparable, 1);
  assert.ok(quoteProblems(half).some((p) => /does not cover type-i/.test(p)));
});

test('a quote that dodged one of the two separating questions is refused', () => {
  const dodged = quote({ answers: { 'git-ref-evidence': 'Yes.' } });
  assert.ok(quoteProblems(dodged).some((p) => /automated-actors/.test(p)));
  assert.deepEqual(quoteProblems(quote()), []);
  assert.ok(quoteProblems(quote({ class: 'big-four' })).some((p) => /is not one of/.test(p)));
  assert.ok(quoteProblems(quote({ peerReviewedOn: 'last year' })).some((p) => /not a date/.test(p)));
});

test('the separating questions are two, and each says what its answer predicts', () => {
  assert.equal(SEPARATING.length, 2, 'a question every firm answers alike separates nothing');
  for (const q of SEPARATING) {
    assert.ok(q.asks.endsWith('?'));
    assert.ok(q.predicts.length > 40, `${q.id} does not say why it is worth asking`);
  }
  assert.deepEqual(SEPARATING.map((q) => q.id).sort(), ['automated-actors', 'git-ref-evidence']);
});

test('the firm classes name a cost, a credibility and a risk, and say whether they bundle tooling', () => {
  assert.equal(FIRM_CLASSES.length, 3);
  for (const c of FIRM_CLASSES) {
    for (const field of ['label', 'cost', 'credibility', 'risk']) assert.ok(c[field].length >= 20, `${c.id}: ${field}`);
    assert.equal(typeof c.bundlesTooling, 'boolean');
  }
  assert.deepEqual(FIRM_CLASSES.filter((c) => c.bundlesTooling).map((c) => c.id), ['audit-tech']);
});

/* ----------------------------------------------------------------- the letter */

test('the letter names four terms, and two of them cannot be filled in today', () => {
  const l = letter();
  assert.equal(l.terms.length, 4);
  assert.deepEqual(l.unresolved.sort(), ['period', 'subservice-method']);
  assert.equal(l.complete, false);
  assert.equal(l.engaged, null);
  assert.deepEqual(LETTER_TERMS.map((t) => t.id).sort(), ['criteria', 'description-criteria', 'period', 'subservice-method']);
});

test('the criteria and the description criteria resolve from their neighbours', () => {
  const l = letter();
  const criteria = l.terms.find((t) => t.id === 'criteria');
  assert.deepEqual(criteria.value.categories, [...ELECTED]);
  assert.equal(criteria.value.criteria.length, 38);
  const dc = l.terms.find((t) => t.id === 'description-criteria');
  assert.deepEqual(dc.value.sections, [...SECTION_IDS]);
  assert.equal(dc.value.sections.length, 14);
});

test('the subservice method is refused because the census is partial, not because the list is empty', () => {
  // The finding worth having. An empty list under a partial census says nobody has surveyed
  // the processors; the same empty list under an enumerated census says there are none, and
  // those are opposite instructions.
  const partial = letter({ boundary: unsurveyed() }).terms.find((t) => t.id === 'subservice-method');
  assert.equal(partial.resolved, false);
  assert.match(partial.says, /unsurveyed rather than none/);

  const enumerated = letter({ boundary: surveyed() }).terms.find((t) => t.id === 'subservice-method');
  assert.equal(enumerated.resolved, false, 'there is still no method to name — but the sentence is a different one');
  assert.match(enumerated.says, /there are none/);

  const decided = letter({
    boundary: surveyed({ subservice: [{ id: 'hosting', method: 'carve-out' }] }),
  }).terms.find((t) => t.id === 'subservice-method');
  assert.equal(decided.resolved, true);
  assert.ok(METHODS.includes(decided.value[0].method));
});

test('a period only resolves when it is well-shaped, and the shape comes from the description', () => {
  const bad = letter({ period: { kind: 'over', from: '2027-04-01' } }).terms.find((t) => t.id === 'period');
  assert.equal(bad.resolved, false);
  const good = letter({ period: { kind: 'as-of', asOf: '2027-04-01' } }).terms.find((t) => t.id === 'period');
  assert.equal(good.resolved, true);
  assert.equal(good.says, 'Stated.');
});

test('letterProblems refuses a letter with four resolved terms and no signatory', () => {
  const problems = letterProblems({
    boundary: surveyed({ subservice: [{ id: 'hosting', method: 'carve-out' }] }),
    period: { kind: 'as-of', asOf: '2027-04-01' },
    register: register(),
  });
  assert.deepEqual(problems, ['no firm is engaged — a letter with four resolved terms and no signatory is a template']);
  assert.ok(letterProblems().length >= 3, 'today the period and the subservice method are refused too');
});

/* ------------------------------------------------------------------ the steps */

test('the steps run in dependency order and every one is owned by a role the policy set names', () => {
  const order = STEPS.map((s) => s.id);
  for (const step of STEPS) {
    assert.ok(ROLES.includes(step.owner), `${step.id}: ${step.owner}`);
    for (const need of step.needs) assert.ok(order.indexOf(need) < order.indexOf(step.id), `${step.id} needs ${need}, which is later`);
  }
  assert.deepEqual(order, ['gap-assessment', 'quotes', 'letter', 'type-i', 'window-open', 'bridge']);
});

test('the gap assessment is done and the quotes are the only thing ready', () => {
  const e = engagement();
  assert.equal(e.steps.find((s) => s.id === 'gap-assessment').state, 'done');
  assert.deepEqual(stepsIn('ready').map((s) => s.id), ['quotes']);
  for (const state of e.steps.map((s) => s.state)) assert.ok(STEP_STATES.includes(state));
});

test('a step nobody can reach is blocked rather than ready, which is what needs is for', () => {
  const e = engagement();
  const blocked = e.steps.filter((s) => s.state === 'blocked').map((s) => s.id);
  assert.deepEqual(blocked, ['letter', 'type-i', 'window-open', 'bridge']);
});

/* ----------------------------------------------------------------- the bridge */

test('the bridge state comes from two dates and nothing else', () => {
  assert.equal(bridge('2027-03-31', '2027-02-01').state, 'covered');
  assert.equal(bridge('2027-03-31', '2027-04-30').state, 'bridge');
  assert.equal(bridge('2027-03-31', '2027-09-01').state, 'stale');
  assert.equal(bridge('2027-03-31', 'soon').state, null);
  for (const s of [bridge('2027-03-31', '2027-02-01'), bridge('2027-03-31', '2027-04-30'), bridge('2027-03-31', '2027-09-01')]) {
    assert.ok(BRIDGE_STATES.includes(s.state));
    assert.ok(s.why.length > 20);
  }
});

test('the bridge turns stale at the limit rather than becoming a longer bridge', () => {
  const limit = Math.round(BRIDGE_MAX_MONTHS * 30.44);
  const at = new Date(Date.parse('2027-03-31T00:00:00Z') + limit * 86400000).toISOString().slice(0, 10);
  const past = new Date(Date.parse('2027-03-31T00:00:00Z') + (limit + 1) * 86400000).toISOString().slice(0, 10);
  assert.equal(bridge('2027-03-31', at).state, 'bridge');
  assert.equal(bridge('2027-03-31', past).state, 'stale');
  assert.match(bridge('2027-03-31', past).why, /current\s+report/);
});

/* ---------------------------------------------------------------- the tooling */

test('the non-goal is checked against the assessment rather than asserted', () => {
  const n = nonGoal();
  assert.deepEqual([...TOOLING_GATED_ON], ['bc-4r10.1', 'bc-4r10.5']);
  assert.equal(n.corpus, true, 'lib/controls.js landed, so the elected criteria enumerate');
  assert.equal(n.evidenced, true, 'bc-4r10.5 landed, so CC8.1 carries evidence');
  assert.equal(n.discharged, true);
  // And a register where CC8.1 has no evidence puts it back — the check reads the data.
  assert.equal(nonGoal(register({ id: 'SOC2.CC8.1', evidence: null }), surveyed()).discharged, false);
});

test('the platform purchase window is derived from a date that does not exist, so there is none', () => {
  assert.equal(platformPurchase(schedule().typeTwoOpensOn), null);
  assert.equal(platformPurchase(null), null);
  const w = platformPurchase('2027-04-01');
  assert.deepEqual(w, { from: '2027-01-01', to: '2027-02-01' });
  assert.equal(PLATFORM_LEAD_MONTHS.min, 2);
  assert.equal(PLATFORM_LEAD_MONTHS.max, 3);
  assert.equal(DECIDED_BY.tooling, 'bc-4r10.17');
});

/* ------------------------------------------------------------ what it produces */

test('the summary today is the honest one, and it names what is holding the gate', () => {
  assert.match(
    summarise(),
    /^Climative · Energy Navigator \/ Insights · unsolicited, 0 quotes · Type I \+ Type II same day · no date settable, 38 criteria holding the operating gate$/
  );
  // And the other branch, which the shipped data cannot reach: once both gates are open the
  // summary says a date may be set rather than naming a gate that is not holding anything.
  assert.match(summarise(register(), surveyed()), /a date is settable, both gates open$/);
  const out = render();
  assert.match(out, /ready\s+quotes/);
  assert.match(out, /Type II window opens\s+not settable/);
  assert.match(out, /unresolved subservice-method/);
});

test('the shipped engagement refuses to be broken — every rule fails on a fixture', () => {
  // A rule only ever run against data that passes is a rule nobody has seen fail. The
  // shipped register is clean, so each of these is the same check against a broken one.
  assert.ok(quoteProblems({}).length >= 3);
  assert.ok(quoteProblems({ firm: 'X', class: 'audit-tech', covers: 'type-i', answers: {} }).some((p) => /covers must be an array/.test(p)));
});

test('the command reads and renders, and --strict gates on there being no date', () => {
  const run = (args) => {
    try {
      const stdio = ['ignore', 'pipe', 'ignore'];
      return { code: 0, out: execFileSync(process.execPath, [path.join(root, 'bin/engagement.js'), ...args], { encoding: 'utf8', stdio }) };
    } catch (e) {
      return { code: e.status, out: String(e.stdout || '') };
    }
  };
  assert.equal(run(['show']).code, 0);
  assert.match(run(['show']).out, /38 criteria holding the operating gate/);
  assert.match(run(['dates']).out, /Type II window opens not settable/);
  assert.match(run(['letter']).out, /subservice-method/);
  assert.match(run(['firms']).out, /boutique-assurance/);
  assert.match(run(['bridge', '2027-03-31', '2027-09-01']).out, /stale/);
  assert.equal(run(['bridge', '2027-03-31', 'soon']).code, 1);
  assert.equal(run(['nonsense']).code, 1);
  assert.equal(run(['show', '--strict']).code, 1, 'no date is settable today');
  const json = JSON.parse(run(['dates', '--json']).out);
  assert.equal(json.typeTwoOpensOn, null);
  assert.equal(json.purchase, null);
  assert.deepEqual(JSON.parse(run(['show', '--json']).out).schedule, schedule());
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
