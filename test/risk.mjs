#!/usr/bin/env node
//
// The AI risk register, its criteria and its method — `lib/risk.js`.
//
//   npm test
//   node test/risk.mjs
//
// bc-eqn1.5: Clause 6.1.2 asks for a *process* and not a list, and the failure this
// suite is mostly about is a register that passes every check while being false. Four
// shapes of that, and each one has a rule and a fixture below:
//
// 1. **Criteria drawn around the answers.** Rate everything first and then decide what
//    counts as acceptable, and nothing is ever above the line. The criteria carry a date
//    for that reason, and the bands, the thresholds and who signs for what are checked
//    against each other rather than each being separately plausible.
// 2. **A treatment that treats nothing.** A residual lower than the inherent rating with
//    no control behind it, or a control id nobody minted. The ids are literals in the
//    module — the leaf rule `lib/servicescope.js` established — and this is where they
//    are resolved against the real corpus.
// 3. **An acceptance nobody gave.** The one 6.1.3 is actually about. Three states, each
//    wrong in a different direction, and the rules are run against fixtures broken one
//    field at a time because the real register is supposed to be clean.
// 4. **A rating nobody revisited.** Checked the way `test/documents.mjs` checks it, by
//    pointing the clock two years on and watching every entry go overdue and say whose
//    it is.
//
// The corpus and the evidence register are neighbours rather than dependencies: the
// module keeps their ids as literals so it still loads without them, and the resolution
// checks here are guarded and print a loud SKIP instead of passing quietly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROLES as AIMS_ROLES, APPROVALS, mayApprove } from '../lib/aims.js';
import { MAX_REVIEW_MONTHS as DOC_CEILING, WARN_DAYS as DOC_WARN } from '../lib/documents.js';
import {
  ACCEPTANCE,
  ACCEPTANCE_APPROVAL,
  ACCEPTED_FIELDS,
  BANDS,
  CONSEQUENCE,
  CRITERIA,
  HARMS,
  LIKELIHOOD,
  MAX_REVIEW_MONTHS,
  METHOD,
  OWNER_ROLES,
  PROCESS_ORDER,
  RISKS,
  THRESHOLDS,
  TREATMENTS,
  WARN_DAYS,
  acceptanceProblems,
  acceptorFor,
  alsoServes,
  atLeastBand,
  atOrAbove,
  bandOf,
  chain,
  controlsClaimed,
  criteriaProblems,
  entryProblems,
  evidenceClaimed,
  harming,
  isControlId,
  isProcessId,
  methodGaps,
  methodProblems,
  needsAcceptance,
  ratingOf,
  registerProblems,
  risksFor,
  scoreOf,
  setProblems,
  stateOf,
  summarise,
  unaccepted,
  unmoved,
  untreated,
} from '../lib/risk.js';

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
 * The arrangement `test/policies.mjs` and `test/servicescope.mjs` both use: importing
 * unguarded would make this suite red until somebody else's branch merges, which is a red
 * nobody can fix from here, and skipping loudly means the check starts working on that
 * merge rather than on somebody remembering to come back.
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

const controls = await optional('../lib/controls.js', 'the control ids stay held to shape only');
const evidence = await optional('../lib/evidence.js', 'the evidence class ids stay held to shape only');

/** A well-formed risk whose residual is above the line, to be broken one field at a time. */
const risk = () => ({
  id: 'a-risk',
  title: 'A risk',
  statement: 'Something the system does could go wrong in a way nobody would notice until it had already happened twice.',
  sources: ['The capability is present in every session, so nothing external stands between it and happening.'],
  harmTo: ['organisation'],
  inherent: { likelihood: 'likely', consequence: 'major' },
  treatment: 'reduce',
  treats: 'A gate refuses it, and the record of the refusal is kept where somebody would look for it afterwards.',
  controls: ['ISO42001.A.9.2'],
  enforcedBy: ['lib/endorse.js'],
  evidence: ['session-transcripts'],
  residual: { likelihood: 'unlikely', consequence: 'major' },
  owes: 'The gate is an instruction an agent follows rather than a boundary it meets, which is what keeps the residual where it is.',
  owner: 'system-owner',
  acceptance: {
    state: 'owed',
    by: null,
    role: null,
    on: null,
    why: 'Nobody has sat down with this register and signed for the residuals it leaves, and inventing a date would be the lie.',
  },
  beads: [],
  reviewedOn: '2026-08-24',
  reviewMonths: 6,
});

/** The same risk, with its residual accepted properly. */
const accepted = () => ({
  ...risk(),
  acceptance: {
    state: 'accepted',
    by: 'Adam Morgan',
    role: 'top-management',
    on: '2026-08-24',
    why: 'Read against what the gate actually refuses, and judged worth living with until a sandboxed session exists.',
  },
});

/** A risk whose residual falls in the acceptable band, so no acceptance is owed. */
const below = () => ({
  ...risk(),
  residual: { likelihood: 'unlikely', consequence: 'minor' },
  acceptance: { state: 'not-required', by: null, role: null, on: null, why: 'The residual is in the acceptable band, so the criteria ask nobody to sign for it.' },
});

/* -------------------------------------------------------------- the module */

await check('the register is well-formed, and it is checked at import rather than on demand', () => {
  assert.deepEqual(registerProblems(), []);
  assert.equal(RISKS.length, 8);
  assert.throws(() => RISKS.push({}), TypeError);
  assert.throws(() => CRITERIA.acceptable.push('critical'), TypeError);
});

await check('the six risks bc-eqn1.5 named are all in it, by id', () => {
  const ids = RISKS.map((r) => r.id);
  for (const id of [
    'unattended-merge-to-main',
    'amendment-widens-an-agent',
    'model-routed-by-an-editable-label',
    'prompt-content-reaches-a-third-party',
    'agent-writes-outside-what-it-was-asked-about',
    'autonomous-filing-loop',
  ]) {
    assert.ok(ids.includes(id), `${id} is not in the register`);
  }
});

await check('this register imports exactly the two modules it needs', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib/risk.js'), 'utf8');
  const local = [...src.matchAll(/^import[^;]*from '\.\/([a-z]+)\.js';$/gm)].map((m) => m[1]).sort();
  assert.deepEqual(local, ['aims', 'documents'], 'the import list changed — the roles and the review clock are the only two');
  assert.ok(!/from '\.\/controls\.js'/.test(src), 'the corpus is resolved in this suite, never imported by the register');
  assert.ok(!/from '\.\/evidence\.js'/.test(src), 'the evidence register is resolved in this suite, never imported');
});

await check('the review clock is lib/documents.js\'s, not a second one', () => {
  assert.equal(MAX_REVIEW_MONTHS, DOC_CEILING);
  assert.equal(WARN_DAYS, DOC_WARN);
});

await check('the risk owners are the management system\'s roles, and nothing invented', () => {
  assert.deepEqual(OWNER_ROLES, AIMS_ROLES.map((r) => r.id));
  for (const r of RISKS) assert.ok(OWNER_ROLES.includes(r.owner), `${r.id} is owned by ${r.owner}`);
});

/* ------------------------------------------------------------- the scales */

await check('the scales are five ordinal points each, and the levels are 1 to 5 in order', () => {
  assert.deepEqual(LIKELIHOOD.map((l) => l.level), [1, 2, 3, 4, 5]);
  assert.deepEqual(CONSEQUENCE.map((c) => c.level), [1, 2, 3, 4, 5]);
  for (const row of [...LIKELIHOOD, ...CONSEQUENCE]) {
    assert.ok(row.means.length > 60, `${row.id} is anchored on a phrase rather than on something observable`);
  }
});

await check('the bands partition every score the scales can produce, with no gap and no overlap', () => {
  const seen = new Map();
  for (let l = 1; l <= 5; l++) {
    for (let c = 1; c <= 5; c++) {
      const band = bandOf(l * c);
      assert.ok(BANDS.includes(band), `${l}x${c} landed outside the bands`);
      seen.set(band, (seen.get(band) || 0) + 1);
    }
  }
  assert.deepEqual([...seen.keys()].sort(), [...BANDS].sort(), 'a band nothing can reach is a band nobody will ever have to sign for');
  assert.equal(bandOf(0), null);
  assert.equal(bandOf(26), null);
  assert.equal(bandOf(4.5), null);
});

await check('the thresholds increase, and the top one reaches the largest score there is', () => {
  assert.deepEqual(THRESHOLDS.map((t) => t.band), [...BANDS]);
  assert.equal(THRESHOLDS[THRESHOLDS.length - 1].upTo, 25);
  for (let i = 1; i < THRESHOLDS.length; i++) assert.ok(THRESHOLDS[i].upTo > THRESHOLDS[i - 1].upTo);
});

await check('a rating off the scale scores null rather than guessing', () => {
  assert.equal(scoreOf({ likelihood: 'likely', consequence: 'major' }), 16);
  assert.equal(scoreOf({ likelihood: 'quite likely', consequence: 'major' }), null);
  assert.equal(scoreOf({ likelihood: 'likely' }), null);
  assert.equal(scoreOf(null), null);
  assert.deepEqual(ratingOf({ residual: { likelihood: 'rare', consequence: 'minor' } }), { score: 2, band: 'low' });
});

await check('atLeastBand orders by badness, and refuses a word that is not a band', () => {
  assert.ok(atLeastBand('critical', 'low'));
  assert.ok(atLeastBand('medium', 'medium'));
  assert.ok(!atLeastBand('low', 'high'));
  assert.ok(!atLeastBand('severe', 'low'), 'a consequence id is not a band');
});

/* ------------------------------------------------------------ the criteria */

await check('the criteria are well-formed, and every band falls on exactly one side of the line', () => {
  assert.deepEqual(criteriaProblems(), []);
  for (const band of BANDS) {
    const acceptable = CRITERIA.acceptable.includes(band);
    const treat = CRITERIA.requiresTreatment.includes(band);
    assert.ok(acceptable !== treat, `${band} is on both sides of the line or on neither`);
  }
});

await check('criteria with no date are refused — criteria drawn around the answers are the failure', () => {
  const problems = criteriaProblems({ ...CRITERIA, statedOn: null });
  assert.ok(problems.some((p) => /statedOn/.test(p)), problems.join('; '));
});

await check('a band that is acceptable and also names an acceptor is refused', () => {
  const problems = criteriaProblems({ ...CRITERIA, acceptedBy: { ...CRITERIA.acceptedBy, low: 'top-management' } });
  assert.ok(problems.some((p) => /below the line needs nobody/.test(p)), problems.join('; '));
});

await check('a band on neither side of the line is refused, which is how one gets quietly dropped', () => {
  const problems = criteriaProblems({ ...CRITERIA, requiresTreatment: ['medium', 'high'] });
  assert.ok(problems.some((p) => /critical is neither acceptable nor requires treatment/.test(p)), problems.join('; '));
});

await check('an acceptor role that may not give the approval is refused', () => {
  const problems = criteriaProblems({ ...CRITERIA, acceptedBy: { ...CRITERIA.acceptedBy, high: 'incident-owner' } });
  assert.ok(problems.some((p) => new RegExp(ACCEPTANCE_APPROVAL).test(p)), problems.join('; '));
});

await check('a residual acceptance is an approval kind the roles table knows about', () => {
  assert.ok(APPROVALS.includes(ACCEPTANCE_APPROVAL), 'an approval nothing may give is a decision nothing can make');
  assert.ok(mayApprove('top-management', ACCEPTANCE_APPROVAL));
  assert.ok(mayApprove('system-owner', ACCEPTANCE_APPROVAL), 'Clause 6.1.3 asks the risk owner to accept the residual');
  assert.ok(!mayApprove('incident-owner', ACCEPTANCE_APPROVAL));
  for (const band of BANDS) {
    const role = acceptorFor(band);
    if (role !== null) assert.ok(mayApprove(role, ACCEPTANCE_APPROVAL), `${band} names an acceptor who may not accept`);
  }
});

await check('the acceptable band needs nobody\'s signature, and every other band needs somebody\'s', () => {
  for (const band of CRITERIA.acceptable) assert.equal(needsAcceptance(band), false, `${band} is acceptable and still asks for a signature`);
  for (const band of CRITERIA.requiresTreatment) assert.equal(needsAcceptance(band), true, `${band} is above the line and asks for nobody`);
  assert.equal(acceptorFor('critical'), null, 'a critical residual may not be retained at all');
});

/* -------------------------------------------------------------- the method */

await check('the method is all eight of 23894\'s process steps, once each, in the standard\'s order', () => {
  assert.deepEqual(methodProblems(), []);
  assert.equal(METHOD.length, 8);
  assert.deepEqual(METHOD.map((s) => s.process), [...PROCESS_ORDER]);
});

await check('a method missing a step fails by name, which is the only way one is ever noticed', () => {
  const problems = methodProblems(METHOD.filter((s) => s.process !== 'ISO23894.Process.RiskEvaluation'));
  assert.ok(problems.some((p) => /RiskEvaluation/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /not a shorter method/.test(p)), problems.join('; '));
});

await check('a method with the steps rearranged fails, because the order is the process', () => {
  const shuffled = [METHOD[1], METHOD[0], ...METHOD.slice(2)];
  const problems = methodProblems(shuffled);
  assert.ok(problems.some((p) => /not in the standard's order/.test(p)), problems.join('; '));
});

await check('a step that names no clause is refused, and an absent gap is refused too', () => {
  const noClause = methodProblems(METHOD.map((s, i) => (i === 0 ? { ...s, clauses: [] } : s)));
  assert.ok(noClause.some((p) => /answering no clause is a habit/.test(p)), noClause.join('; '));
  const noGap = methodProblems(METHOD.map((s, i) => (i === 0 ? { ...s, gap: undefined } : s)));
  assert.ok(noGap.some((p) => /nobody looked/.test(p)), noGap.join('; '));
});

await check('the steps that admit to a gap say so in a sentence rather than by being empty', () => {
  const gaps = methodGaps();
  assert.ok(gaps.length > 0, 'a method with no gaps at all is a method nobody read honestly');
  for (const step of gaps) assert.ok(step.gap.length > 60, `${step.process} calls a gap in a phrase`);
});

/* ------------------------------------------------------------ one entry */

await check('the fixture is clean, so every failure below is the field it broke', () => {
  assert.deepEqual(entryProblems(risk()), []);
  assert.deepEqual(entryProblems(accepted()), []);
  assert.deepEqual(entryProblems(below()), []);
});

await check('a risk with no source is a worry, and a source that is a word is not a source', () => {
  assert.ok(entryProblems({ ...risk(), sources: [] }).some((p) => /no source is a worry/.test(p)));
  assert.ok(entryProblems({ ...risk(), sources: ['agents'] }).some((p) => /must be a sentence/.test(p)));
});

await check('a register that never asks who the harm falls on is refused — 23894\'s whole demand', () => {
  assert.ok(entryProblems({ ...risk(), harmTo: [] }).some((p) => /23894 exists to refuse/.test(p)));
  assert.ok(entryProblems({ ...risk(), harmTo: ['customers'] }).some((p) => /is not one of/.test(p)));
  assert.ok(entryProblems({ ...risk(), harmTo: ['organisation', 'organisation'] }).some((p) => /same party twice/.test(p)));
  assert.ok(harming('society').length > 0, 'not one risk in the register harms anybody but the organisation');
  assert.ok(harming('individuals').length > 1);
});

await check('a treatment that makes the risk worse is a mistake being recorded as a control', () => {
  const worse = { ...risk(), residual: { likelihood: 'almost-certain', consequence: 'severe' } };
  assert.ok(entryProblems(worse).some((p) => /worse than the inherent risk/.test(p)));
});

await check('a treatment that changed nothing must say why, and `retain` is allowed to say nothing', () => {
  const unchanged = { ...risk(), residual: { ...risk().inherent }, owes: null };
  assert.ok(entryProblems(unchanged).some((p) => /treatment changed nothing/.test(p)));
  assert.deepEqual(entryProblems({ ...unchanged, treatment: 'retain' }).filter((p) => /changed nothing/.test(p)), []);
  assert.equal(unmoved().length, 1, 'the register grew or lost an entry whose treatment moved nothing');
  assert.equal(unmoved()[0].id, 'prompt-content-reaches-a-third-party');
});

await check('a control id without its framework token is refused, because two frameworks mint A.5.2', () => {
  assert.ok(isControlId('ISO42001.A.5.2'));
  assert.ok(isControlId('ISO42001.Clause6.1.2'));
  assert.ok(!isControlId('A.9.2'), 'the framework token is part of the id');
  assert.ok(!isControlId('ISO27001.A.5.2'), 'only 42001 ids treat an AI risk here');
  assert.ok(!isControlId('SOC2.CC3.1'), 'the SOC 2 direction is the crosswalk, not a second list');
  assert.ok(isProcessId('ISO23894.Process.RiskTreatment'));
  assert.ok(!isProcessId('Process.RiskTreatment'));
  assert.ok(entryProblems({ ...risk(), controls: ['A.9.2'] }).some((p) => /different controls/.test(p)));
  assert.ok(entryProblems({ ...risk(), controls: [] }).some((p) => /treats nothing/.test(p)));
});

await check('a treatment somebody enforces and nobody keeps a record of is refused', () => {
  const problems = entryProblems({ ...risk(), evidence: [] });
  assert.ok(problems.some((p) => /nobody can sample/.test(p)), problems.join('; '));
});

await check('a risk nothing enforces has to say so, and then it is allowed', () => {
  assert.ok(entryProblems({ ...risk(), enforcedBy: [], owes: null }).some((p) => /a finding, in a sentence/.test(p)));
  assert.deepEqual(entryProblems({ ...risk(), enforcedBy: [], evidence: [] }), []);
});

await check('an owner who is not one of the management system\'s roles is nobody', () => {
  assert.ok(entryProblems({ ...risk(), owner: 'Adam Morgan' }).some((p) => /is an owner nobody is accountable as/.test(p)));
  assert.ok(entryProblems({ ...risk(), owner: 'security lead' }).some((p) => /accountable as/.test(p)));
});

await check('a review period past the ceiling is refused, on the ceiling documents.js sets', () => {
  assert.ok(entryProblems({ ...risk(), reviewMonths: MAX_REVIEW_MONTHS + 1 }).some((p) => /whole number of months/.test(p)));
  assert.ok(entryProblems({ ...risk(), reviewMonths: 0 }).some((p) => /whole number of months/.test(p)));
  assert.ok(entryProblems({ ...risk(), reviewedOn: 'last spring' }).some((p) => /must be a real date/.test(p)));
});

/* ---------------------------------------------------------- the acceptance */

await check('an acceptance nobody gave cannot be recorded, in either direction', () => {
  const claimed = { ...risk(), acceptance: { ...risk().acceptance, on: '2026-08-24' } };
  assert.ok(entryProblems(claimed).some((p) => /an acceptance nobody gave cannot be recorded/.test(p)));
  for (const field of ACCEPTED_FIELDS) {
    const half = { ...accepted(), acceptance: { ...accepted().acceptance, [field]: null } };
    assert.ok(entryProblems(half).length > 0, `an accepted residual with no ${field} passed`);
  }
});

await check('a residual above the line accepted by the wrong role is refused', () => {
  const wrong = { ...accepted(), acceptance: { ...accepted().acceptance, role: 'incident-owner' } };
  assert.ok(acceptanceProblems(wrong).some((p) => new RegExp(ACCEPTANCE_APPROVAL).test(p)));

  // The fixture's residual is `unlikely × major`, which is medium — the system owner's
  // to accept, and top management's as well, because they may accept anything.
  assert.equal(ratingOf(accepted(), 'residual').band, 'medium');
  const medium = { ...accepted(), acceptance: { ...accepted().acceptance, role: 'system-owner' } };
  assert.deepEqual(acceptanceProblems(medium), [], "a medium residual is the system owner's to accept");
  assert.deepEqual(acceptanceProblems(accepted()), [], 'top management may accept anything that may be accepted at all');

  const high = {
    ...accepted(),
    residual: { likelihood: 'possible', consequence: 'major' },
    acceptance: { ...accepted().acceptance, role: 'system-owner' },
  };
  assert.equal(ratingOf(high, 'residual').band, 'high');
  assert.ok(acceptanceProblems(high).some((p) => /top-management/.test(p)), 'a high residual was accepted a rung down');
});

await check('a critical residual may not be accepted at all — the criteria say so, and the rule quotes them', () => {
  const critical = {
    ...accepted(),
    inherent: { likelihood: 'almost-certain', consequence: 'severe' },
    residual: { likelihood: 'almost-certain', consequence: 'severe' },
    treatment: 'retain',
  };
  const problems = acceptanceProblems(critical);
  assert.ok(problems.some((p) => p.includes('may not be retained')), problems.join('; '));
});

await check('the register cannot quietly move its own line in either direction', () => {
  const pretend = { ...risk(), acceptance: { ...below().acceptance } };
  assert.ok(acceptanceProblems(pretend).some((p) => /moving its own line/.test(p)));
  const overdone = { ...below(), acceptance: { ...accepted().acceptance } };
  assert.ok(acceptanceProblems(overdone).some((p) => /did not have to/.test(p)));
});

await check('nothing in this register is accepted yet, and every one of them says what is missing', () => {
  assert.equal(unaccepted().length, RISKS.filter((r) => needsAcceptance(ratingOf(r, 'residual').band)).length);
  for (const r of RISKS) {
    assert.ok(ACCEPTANCE.includes(r.acceptance.state));
    assert.ok(r.acceptance.why.length > 60, `${r.id} explains its acceptance state in a phrase`);
    if (r.acceptance.state !== 'accepted') for (const f of ACCEPTED_FIELDS) assert.equal(r.acceptance[f], null);
  }
});

/* ---------------------------------------------------------------- the reads */

await check('the chain is risk, control, what enforces it and what could be sampled', () => {
  const c = chain(RISKS[0]);
  assert.equal(c.risk, 'unattended-merge-to-main');
  assert.equal(c.inherent.band, 'high');
  assert.equal(c.residual.band, 'medium');
  assert.ok(c.controls.length > 0 && c.enforcedBy.length > 0 && c.evidence.length > 0);
  assert.equal(c.acceptedBy, null);
  assert.deepEqual(chain({}).controls, [], 'the chain is the entry rearranged, so a fixture works as the real thing does');
});

await check('risksFor reads the register backwards — the Statement of Applicability\'s column', () => {
  const treated = risksFor('ISO42001.A.9.2');
  assert.ok(treated.length > 1, 'A.9.2 is selected by only one risk');
  assert.ok(treated.every((r) => r.controls.includes('ISO42001.A.9.2')));
  assert.deepEqual(risksFor('ISO42001.A.99.9'), []);
  assert.deepEqual(controlsClaimed(), [...new Set(RISKS.flatMap((r) => r.controls))].sort());
});

await check('atOrAbove is the cut a management review reads, worst first and stable on a tie', () => {
  const high = atOrAbove('high');
  assert.ok(high.length > 0, 'nothing in the register is high or worse, which would make the whole thing decorative');
  assert.ok(high.every((r) => atLeastBand(ratingOf(r, 'residual').band, 'high')));
  const scores = high.map((r) => ratingOf(r, 'residual').score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a), 'not ordered worst first');
  assert.deepEqual(atOrAbove('low').map((r) => r.id).sort(), RISKS.map((r) => r.id).sort(), 'every risk is at least low');
  assert.deepEqual(atOrAbove('critical'), [], 'a critical residual may not be retained, so none should be here');

  // Two entries scoring the same must come back in the register's own order, because
  // nothing here ranks one against the other and a sort that invented an order would be
  // the arithmetic the scales deliberately are not.
  const tied = [{ ...risk(), id: 'first' }, { ...risk(), id: 'second' }];
  assert.deepEqual(atOrAbove('low', tied).map((r) => r.id), ['first', 'second']);
});

await check('untreated and unmoved are the two honest counts, and the summary quotes them', () => {
  assert.deepEqual(untreated(), [], 'a risk with nothing enforcing it belongs in the tracker as work, not here');
  const line = summarise();
  assert.ok(line.includes(`${RISKS.length} risks`));
  assert.ok(/still owe/.test(line));
  assert.ok(/eight process steps/.test(line));
});

await check('every risk in this checkout is current, and its enforcement is all still on disk', () => {
  const { problems, warnings } = setProblems(ROOT);
  assert.deepEqual(problems, []);
  assert.deepEqual(warnings, []);
});

await check('a rating nobody revisited fails two years on, and says how late it is', () => {
  const { problems } = setProblems(ROOT, new Date('2028-08-24T00:00:00Z'));
  assert.equal(problems.length, RISKS.length + 1, 'every risk and the criteria themselves should be overdue');
  assert.ok(problems.every((p) => /due for review/.test(p)), problems.join('; '));
  assert.ok(problems.some((p) => /the risk criteria was due/.test(p)), 'the criteria expire on the same clock the ratings do');
});

await check('a review a fortnight out warns rather than failing, because it is not late yet', () => {
  const soon = new Date(`${CRITERIA.reviewedOn}T00:00:00Z`);
  soon.setUTCMonth(soon.getUTCMonth() + CRITERIA.reviewMonths);
  soon.setUTCDate(soon.getUTCDate() - 14);
  const { problems, warnings } = setProblems(ROOT, soon);
  assert.deepEqual(problems, []);
  assert.ok(warnings.length > 0, 'nothing warned a fortnight before every review date in the register');
  assert.ok(warnings.every((w) => /review due/.test(w)));
});

await check('a date that has not happened yet is the one way to pass every other rule and still be false', () => {
  const { problems } = setProblems(ROOT, new Date('2026-01-01T00:00:00Z'));
  assert.ok(problems.some((p) => /has not happened yet/.test(p)), problems.join('; '));
});

await check('enforcement that has left the repo fails rather than passing quietly', () => {
  const gone = [{ ...risk(), enforcedBy: ['lib/nothing-of-the-sort.js'] }];
  const { problems } = setProblems(ROOT, new Date('2026-08-24T00:00:00Z'), { register: gone });
  assert.ok(problems.some((p) => /is not in the repo/.test(p)), problems.join('; '));
});

await check('the method pointing at a file nobody can read fails the same way', () => {
  const bent = METHOD.map((s, i) => (i === 0 ? { ...s, where: ['lib/never-existed.js'] } : s));
  const { problems } = setProblems(ROOT, new Date('2026-08-24T00:00:00Z'), { method: bent });
  assert.ok(problems.some((p) => /the method points at something nobody can read/.test(p)), problems.join('; '));
});

/* --------------------------------------------------- resolved for real */

await check('every control a treatment names is one the corpus actually mints', async () => {
  if (!controls) return;
  const ids = [...controls.corpus().ids.keys()];
  const { problems } = setProblems(ROOT, new Date(), { controls: ids });
  assert.deepEqual(problems, []);
  for (const id of controlsClaimed()) {
    assert.ok(controls.isControl(id), `${id} is not in the corpus`);
    assert.equal(controls.frameworkOf(id), 'ISO42001', `${id} is not a 42001 id`);
  }
  const bad = setProblems(ROOT, new Date(), {
    register: [{ ...risk(), controls: ['ISO42001.A.99.9'] }],
    controls: ids,
  });
  assert.ok(bad.problems.some((p) => /cannot be generated/.test(p)), bad.problems.join('; '));
});

await check('the method cites the eight 23894 process rows the corpus holds, and real clauses', async () => {
  if (!controls) return;
  // Every ISO 23894 row is `kind: 'process'` — the framework is guidance, not controls —
  // so the eight are picked out by their group, which is the standard's own division into
  // principles, framework and process.
  const process = controls.byFramework('ISO23894').filter((r) => r.group === 'Process').map((r) => r.id);
  assert.deepEqual([...PROCESS_ORDER].sort(), [...process].sort(), 'the corpus and the method disagree about what the eight steps are');
  for (const step of METHOD) {
    assert.ok(controls.isControl(step.process), `${step.process} is not in the corpus`);
    for (const id of step.clauses) assert.ok(controls.isControl(id), `${id} is not in the corpus`);
  }
});

await check('every class of record a risk rests on is one the evidence register keeps', async () => {
  if (!evidence) return;
  const ids = evidence.REGISTER.map((e) => e.id);
  const { problems } = setProblems(ROOT, new Date(), { evidence: ids });
  assert.deepEqual(problems, []);
  for (const id of evidenceClaimed()) assert.ok(ids.includes(id), `${id} is not a class in the evidence register`);
  const bad = setProblems(ROOT, new Date(), {
    register: [{ ...risk(), evidence: ['a-record-nobody-keeps'] }],
    evidence: ids,
  });
  assert.ok(bad.problems.some((p) => /claims a record nobody keeps/.test(p)), bad.problems.join('; '));
});

await check('the SOC 2 half is read off the crosswalk rather than written down here', async () => {
  if (!controls) return;
  const served = new Set();
  for (const r of RISKS) for (const id of alsoServes(r, controls.crosswalk)) served.add(id);
  assert.ok(served.size > 10, `only ${served.size} ids came back off the crosswalk`);
  assert.ok([...served].some((id) => id.startsWith('SOC2.')), 'no SOC 2 criterion came back — bc-4r10.8 reads this register through them');
  assert.ok([...served].some((id) => id.startsWith('ISO27001.')), 'no 27001 control came back');
  assert.ok([...served].every((id) => controls.isControl(id)));
  // Scoped to the two data blocks rather than the whole file: the rule that refuses a
  // foreign id has to *name* one in its own failure message, and a grep over the source
  // cannot tell the difference between an id being used and an id being refused.
  const src = fs.readFileSync(path.join(ROOT, 'lib/risk.js'), 'utf8');
  for (const name of ['METHOD', 'RISKS']) {
    const from = src.indexOf(`export const ${name} = Object.freeze([`);
    assert.ok(from > 0, `${name} is no longer a frozen literal — this check reads it by hand`);
    const data = src.slice(from, src.indexOf('\n]);', from));
    assert.ok(!/'SOC2\./.test(data), `a SOC 2 id was written into ${name} — that is the second crosswalk bc-4r10.1 exists to prevent`);
    assert.ok(!/'ISO27001\./.test(data), `a 27001 id was written into ${name}, for the same reason`);
  }
});

await check('this register is itself a controlled document, with an owner and a review date', async () => {
  const documents = await import('../lib/documents.js');
  const entry = documents.REGISTER.find((d) => d.path === 'lib/risk.js');
  assert.ok(entry, 'a register that says everything else expires and never expires itself is the gap this programme keeps closing');
  assert.equal(entry.reviewMonths, 6);
  assert.deepEqual(documents.entryProblems(entry), []);
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
