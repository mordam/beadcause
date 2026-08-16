#!/usr/bin/env node
//
// A silent or modified instance is a finding — `lib/findings.js`.
//
//   npm test                      (runs it alongside the other suites)
//   node test/findings.mjs        (on its own)
//
// bc-3muu.5, and the three claims are the bead's three acceptance criteria in the order it
// states them:
//
//   1. **An enrolled instance that goes silent raises a finding within a stated interval.**
//      Stated is half the claim: the interval is an export, every silence finding quotes it
//      and the duration it was exceeded by, and a survey that has not itself run within the
//      interval raises a finding against *itself* — because an instance can only be found
//      silent by somebody looking, and a gap between surveys is a gap in the guarantee.
//   2. **A chain that does not extend its predecessor is rejected and reported.** The
//      rejecting is `witnessProblems` and already lands; what is asserted here is the
//      second verb. A refusal that becomes an HTTP status and nothing else is an event that
//      lives as long as a socket, so the sentences it produced are carried into a finding
//      with a place to live — including for an instance whose *first* publication was
//      refused and which therefore has no ledger to be found in.
//   3. **Neither can be made to look like a clean record.** This is the half worth the
//      suite. Deleting a ledger makes the report louder rather than quieter, because the
//      previous survey names the instance and the absence is the finding. `clean` is every
//      instance accounted for and current rather than "no findings", so a survey covering
//      nobody is not clean. A comparison handed in pre-declared `divergent: false` is
//      classified from the verdict table anyway. And `surveyProblems` is pointed at
//      doctored reports — a row deleted, a row marked current with findings on it, a report
//      marked clean carrying them — so the check is one somebody who did not run the survey
//      can make.
//
// Nothing here touches a config directory, a network, or a clock: every instant is a fixture
// and the module takes `at` as an argument. That is the point of the far end being pure —
// the same suite runs wherever the service is hosted.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EXPECTED_MS,
  FINDINGS,
  FINDING_KINDS,
  SEVERITIES,
  describe as describeSurvey,
  divergence,
  raise,
  rejection,
  severityOf,
  silence,
  surveyOf,
  surveyProblems,
  worst,
} from '../lib/findings.js';
import { digest, genesis, next } from '../lib/publishable.js';
import { EMPTY_LEDGER, VERDICTS, compare, witness, witnessProblems } from '../lib/witness.js';
import { blankComments, claimed } from '../lib/evidence.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

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

/* ------------------------------------------------------------------- fixtures */

const INSTANCE = 'inst-0a1b2c3d4e5f6a7b';
const OTHER = 'inst-ffeeddccbbaa9988';
const HOUR = 60 * 60 * 1000;
const T0 = Date.UTC(2026, 7, 15, 0, 0, 0);
/** An instant `h` hours after the fixture epoch, in the one form `at` accepts. */
const AT = (h) => new Date(T0 + h * HOUR).toISOString();
const SHA = (n) => String(n).padStart(40, 'a');

/** A chain of `n + 1` records: an enrolment at seq 0 and chain-heads after it, one an hour. */
function chainOf(instance, n, { first = 'enrolment' } = {}) {
  const fields = (kind, i) =>
    kind === 'enrolment'
      ? { fingerprint: digest(`key:${instance}`), org: 'acme' }
      : { ref: 'refs/beadcause/sessions/bc-3muu.5', head: SHA(i), length: i + 1, linear: true, intact: true };
  const records = [genesis(instance, first, fields(first, 0), { at: AT(0) })];
  for (let i = 1; i <= n; i++) records.push(next(records[i - 1], 'chain-head', fields('chain-head', i), { at: AT(i) }));
  return records;
}

/** A ledger the service was told those records at, one an hour, `witnessedAt` for the last. */
function ledgerOf(records, { witnessedAt = null } = {}) {
  let ledger = EMPTY_LEDGER;
  records.forEach((rec, i) => {
    const at = i === records.length - 1 && witnessedAt ? witnessedAt : AT(i);
    ledger = witness(ledger, rec, { at }).ledger;
  });
  return ledger;
}

/* --------------------------------------------- 1. the vocabulary, and its closure */

check('the finding vocabulary is closed, and the prototype chain is not a way in', () => {
  assert.deepEqual(FINDING_KINDS, Object.keys(FINDINGS));
  for (const name of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
    assert.equal(severityOf(name), null, `${name} reads as a kind of finding`);
    assert.throws(() => raise(name, INSTANCE, 'why', AT(1)), /is not a kind of finding/);
  }
  for (const kind of FINDING_KINDS) assert.ok(SEVERITIES.includes(FINDINGS[kind].severity), `${kind} has no severity`);
});

check('a finding is stamped with an instant, and detail cannot overwrite what it is', () => {
  assert.throws(() => raise('silent', INSTANCE, 'why', 'yesterday'), /stamped with/);
  const f = raise('vanished', INSTANCE, 'gone', AT(1), { kind: 'silent', severity: 'finding', instance: OTHER, why: 'nothing to see' });
  assert.equal(f.kind, 'vanished', 'detail overwrote the kind');
  assert.equal(f.severity, 'material', 'detail downgraded the severity');
  assert.equal(f.instance, INSTANCE);
  assert.equal(f.why, 'gone');
  assert.throws(() => {
    'use strict';
    f.severity = 'finding';
  });
});

check('the worst of a list is the worst of a list, and an empty list has none', () => {
  assert.equal(worst([]), null);
  assert.equal(worst([raise('silent', INSTANCE, 'a', AT(1))]), 'finding');
  assert.equal(worst([raise('silent', INSTANCE, 'a', AT(1)), raise('rejected', INSTANCE, 'b', AT(1))]), 'material');
  assert.equal(SEVERITIES.indexOf('finding') < SEVERITIES.indexOf('material'), true, 'severities run weakest first');
});

/* ------------------------------------ 2. silence, measured against a stated interval */

check('an instance witnessed within the interval is current, and the survey is clean', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(9) });
  const report = surveyOf({ ledgers: [ledger], at: AT(10) });
  assert.equal(report.enrolled, 1);
  assert.equal(report.current, 1);
  assert.equal(report.instances[0].state, 'current');
  assert.deepEqual([...report.findings], []);
  assert.equal(report.clean, true);
  assert.deepEqual(surveyProblems(report, { ledgers: [ledger] }), []);
});

check('an instance that goes silent raises a finding, and the finding quotes the interval', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(3) });
  const report = surveyOf({ ledgers: [ledger], at: AT(12) });
  assert.equal(report.clean, false, 'a silent instance cannot leave a clean survey');
  assert.equal(report.instances[0].state, 'silent');
  const [finding] = report.findings;
  assert.equal(finding.kind, 'silent');
  assert.equal(finding.instance, INSTANCE);
  assert.equal(finding.expected, EXPECTED_MS, 'the interval is on the finding, not only in the prose');
  assert.equal(finding.silentFor, 9 * HOUR);
  assert.match(finding.why, /9 hours ago/, 'the finding says how long, not merely that');
  assert.match(finding.why, /every 6 hours/, 'and against what interval');
});

check('the interval is a stated default and a caller may state another', () => {
  assert.equal(EXPECTED_MS, 6 * HOUR);
  const ledger = ledgerOf(chainOf(INSTANCE, 1), { witnessedAt: AT(1) });
  assert.equal(surveyOf({ ledgers: [ledger], at: AT(4) }).clean, true, 'three hours is inside the default');
  const tight = surveyOf({ ledgers: [ledger], at: AT(4), expect: HOUR });
  assert.equal(tight.clean, false);
  assert.equal(tight.findings[0].expected, HOUR);
  assert.match(tight.findings[0].why, /every 60 minutes/);
  assert.throws(() => surveyOf({ ledgers: [ledger], at: AT(4), expect: 0 }), /positive number of milliseconds/);
  assert.throws(() => surveyOf({ ledgers: [ledger], at: 'now' }), /stamped with/);
});

check('silence is dated by the service clock, never by the clock of the instance being judged', () => {
  // The records are stamped hours 0..3; the service was told the last one at hour 20. An
  // instance whose own timestamps say it is fresh cannot be the authority on that.
  const stale = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(20) });
  assert.equal(surveyOf({ ledgers: [stale], at: AT(21) }).clean, true);
  const backdated = { ...stale, receipts: stale.receipts.map((r, i) => ({ ...r, received: AT(i) })) };
  assert.equal(surveyOf({ ledgers: [backdated], at: AT(21) }).clean, false);
});

check('a ledger with records and no receipt to date them by is silent, not current', () => {
  const records = chainOf(INSTANCE, 2);
  const finding = silence({ instance: INSTANCE, lastWitnessed: null, records: records.length }, AT(1));
  assert.equal(finding.kind, 'silent');
  assert.match(finding.why, /no receipt to date any of them by/);
  assert.equal(finding.silentFor, null, 'how long is unknown, and unknown is not zero');
  const report = surveyOf({ ledgers: [{ instance: INSTANCE, records, receipts: [] }], at: AT(1) });
  assert.equal(report.clean, false);
});

check('a survey that has not run within the interval is a finding against itself', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 2), { witnessedAt: AT(23) });
  const previous = surveyOf({ ledgers: [ledger], at: AT(2) });
  const late = surveyOf({ ledgers: [ledger], previous, at: AT(24) });
  const unsurveyed = late.findings.find((f) => f.kind === 'unsurveyed');
  assert.ok(unsurveyed, 'a 22-hour gap between surveys went unremarked');
  assert.equal(unsurveyed.instance, null, 'the survey is what is at fault, not an instance');
  assert.equal(unsurveyed.since, previous.at);
  assert.match(unsurveyed.why, /nothing could have been found in between/);
  assert.equal(late.clean, false);
  const prompt = surveyOf({ ledgers: [ledger], previous: surveyOf({ ledgers: [ledger], at: AT(22) }), at: AT(24) });
  assert.equal(prompt.findings.length, 0, 'a survey inside the interval says nothing about itself');
});

/* ------------------------- 3. a chain that does not extend its predecessor, reported */

check('the witness refuses a record that does not extend what it holds, and the refusal has a place to live', () => {
  const records = chainOf(INSTANCE, 3);
  const ledger = ledgerOf(records.slice(0, 3));
  const rewrite = { ...records[2], head: SHA(9) };
  const problems = witnessProblems(ledger, rewrite);
  assert.ok(problems.length, 'the witness admitted a rewrite of a sequence number it already holds');
  assert.match(problems[0], /already holds a different record at seq 2/);

  const finding = rejection(INSTANCE, rewrite.seq, problems, AT(5));
  assert.equal(finding.kind, 'rejected');
  assert.equal(finding.severity, 'material');
  assert.equal(finding.seq, 2);
  assert.deepEqual([...finding.problems], problems);
  assert.match(finding.why, /a publication was refused: /);
  assert.equal(Object.hasOwn(finding, 'record'), false, 'a refused record is not held, and a finding is not a way to hold it');
});

check('a refused publication is reported in the survey, and the instance is not current', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(9) });
  const report = surveyOf({
    ledgers: [ledger],
    refusals: [{ instance: INSTANCE, seq: 2, problems: ['a sequence number is used once'], at: AT(9) }],
    at: AT(10),
  });
  assert.equal(report.clean, false, 'a refused publication left a clean survey');
  assert.equal(report.instances[0].state, 'rejected');
  assert.equal(report.material, 1);
  assert.deepEqual(surveyProblems(report, { ledgers: [ledger], refusals: [{ instance: INSTANCE }] }), []);
});

check('an instance whose first publication was refused has no ledger, and is reported anyway', () => {
  const report = surveyOf({ refusals: [{ instance: OTHER, seq: 0, problems: ['the first record a ledger is told is seq 0'], at: AT(1) }], at: AT(2) });
  assert.equal(report.enrolled, 1, 'an instance with no ledger fell out of the population');
  assert.equal(report.instances[0].instance, OTHER);
  assert.equal(report.instances[0].state, 'rejected');
  assert.equal(report.clean, false);
});

check('a refusal with no reason recorded is still a finding, and says that it has none', () => {
  const finding = rejection(INSTANCE, null, [], AT(1));
  assert.equal(finding.kind, 'rejected');
  assert.equal(finding.seq, null);
  assert.match(finding.why, /no reason was recorded/);
});

check('a chain the service holds that does not link to itself is unsound', () => {
  const records = chainOf(INSTANCE, 3);
  const gapped = { instance: INSTANCE, records: [records[0], records[2], records[3]], receipts: [] };
  const report = surveyOf({ ledgers: [gapped], at: AT(4) });
  assert.equal(report.instances[0].state, 'unsound');
  assert.equal(report.findings[0].severity, 'material');
  assert.match(report.findings[0].why, /does not hold together/);
  assert.equal(report.clean, false);
});

check('a second chain for one instance is a finding, not a row written over the first', () => {
  const first = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(9) });
  const second = ledgerOf(chainOf(INSTANCE, 1), { witnessedAt: AT(9) });
  const report = surveyOf({ ledgers: [first, second], at: AT(10) });
  assert.equal(report.enrolled, 1, 'an instance has one row');
  assert.equal(report.instances[0].seq, 3, 'and the first chain was not written over by the second');
  assert.equal(report.instances[0].state, 'duplicated');
  assert.equal(report.findings[0].severity, 'material');
  assert.equal(report.clean, false);
});

check('a chain that does not begin with an enrolment is a chain nobody was admitted for', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 2, { first: 'chain-head' }), { witnessedAt: AT(2) });
  const report = surveyOf({ ledgers: [ledger], at: AT(3) });
  assert.equal(report.instances[0].state, 'unenrolled');
  assert.match(report.findings[0].why, /first record is its enrolment/);
  assert.equal(report.clean, false);
});

/* ------------------------------- 4. neither can be made to look like a clean record */

check('a ledger that is deleted makes the survey louder, because the previous survey named it', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(9) });
  const before = surveyOf({ ledgers: [ledger], at: AT(10) });
  assert.equal(before.clean, true);

  const after = surveyOf({ ledgers: [], previous: before, at: AT(12) });
  assert.equal(after.clean, false, 'deleting the ledger produced a clean survey, which is the whole failure');
  assert.equal(after.enrolled, 1, 'the vanished instance is a row, not an absent row');
  assert.equal(after.instances[0].state, 'vanished');
  const [finding] = after.findings;
  assert.equal(finding.severity, 'material');
  assert.equal(finding.was, 3);
  assert.match(finding.why, /holds no ledger for it now/);
});

check('a ledger rewound to an earlier head is the same finding, for the same reason', () => {
  const records = chainOf(INSTANCE, 4);
  const before = surveyOf({ ledgers: [ledgerOf(records, { witnessedAt: AT(9) })], at: AT(10) });
  const rewound = ledgerOf(records.slice(0, 3), { witnessedAt: AT(11) });
  const after = surveyOf({ ledgers: [rewound], previous: before, at: AT(12) });
  assert.equal(after.instances[0].state, 'vanished');
  assert.match(after.findings[0].why, /records it had are gone/);
  assert.equal(after.clean, false);
});

check('a survey that accounts for nobody is not clean — that is the confident way to say nothing', () => {
  const empty = surveyOf({ at: AT(1) });
  assert.equal(empty.enrolled, 0);
  assert.deepEqual([...empty.findings], [], 'and it genuinely has no findings, which is the trap');
  assert.equal(empty.clean, false);
  assert.match(empty.why, /not the same as every instance being current/);
  assert.match(describeSurvey(empty), /nothing to be found/);
});

check('divergence is read off the verdict table, and never off a flag on the object handed in', () => {
  for (const [verdict, divergent] of Object.entries(VERDICTS)) {
    const finding = divergence(INSTANCE, { verdict, why: 'because', divergent: false }, AT(1));
    if (divergent) {
      assert.ok(finding, `${verdict} is a divergent verdict and produced no finding`);
      assert.equal(finding.kind, 'diverged');
      assert.equal(finding.verdict, verdict);
      assert.match(finding.why, new RegExp(`^${verdict} — `));
    } else {
      assert.equal(finding, null, `${verdict} is ordinary and was reported as a discrepancy`);
    }
  }
});

check('a verdict this service has never heard of is a finding, because silence would be worst', () => {
  const finding = divergence(INSTANCE, { verdict: 'fine', why: 'all good', divergent: false }, AT(1));
  assert.ok(finding);
  assert.equal(finding.verdict, null);
  assert.match(finding.why, /not a verdict this service knows how to read/);
  assert.ok(divergence(INSTANCE, null, AT(1)), 'and no comparison at all is not an ordinary verdict either');
});

check('a real fork between the two sides reaches the survey as a material finding', () => {
  const records = chainOf(INSTANCE, 3);
  const forked = chainOf(INSTANCE, 3, { first: 'chain-head' });
  const cmp = compare(records, { instance: INSTANCE, seq: 2, at: AT(2), digest: digest(forked[2]) });
  assert.equal(cmp.verdict, 'forked');
  const report = surveyOf({
    ledgers: [ledgerOf(records, { witnessedAt: AT(9) })],
    comparisons: [{ instance: INSTANCE, comparison: cmp, at: AT(9) }],
    at: AT(10),
  });
  assert.equal(report.instances[0].state, 'diverged');
  assert.equal(report.clean, false);
  assert.equal(report.material, 1);
});

check('an ordinary comparison leaves the instance in the population and says nothing about it', () => {
  const records = chainOf(OTHER, 2);
  const cmp = compare(records, { instance: OTHER, seq: 2, at: AT(2), digest: digest(records[2]) });
  assert.equal(cmp.verdict, 'agreed');
  const report = surveyOf({ comparisons: [{ instance: OTHER, comparison: cmp, at: AT(1) }], at: AT(2) });
  assert.equal(report.enrolled, 1, 'a compared instance is a member of the population');
  assert.equal(report.instances[0].state, 'silent', 'and the service holds no ledger for it, which is the finding');
});

/* -------------------------------- 5. the report is checkable by somebody who did not run it */

check('a report with a row quietly deleted is refused, and the refusal names the row', () => {
  const ledgers = [ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(9) }), ledgerOf(chainOf(OTHER, 2), { witnessedAt: AT(9) })];
  const report = surveyOf({ ledgers, at: AT(10) });
  assert.deepEqual(surveyProblems(report, { ledgers }), []);

  const doctored = { ...report, instances: report.instances.filter((r) => r.instance !== OTHER), enrolled: 1 };
  const problems = surveyProblems(doctored, { ledgers });
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`does not account for ${OTHER}, and the service holds a ledger for it`));
});

check('a report is refused for every source that can name an instance, not only for its ledgers', () => {
  const report = surveyOf({ at: AT(10) });
  assert.match(surveyProblems(report, { refusals: [{ instance: INSTANCE }] })[0], /recorded a refused publication/);
  assert.match(surveyProblems(report, { comparisons: [{ instance: INSTANCE }] })[0], /a comparison was run against it/);
  assert.match(surveyProblems(report, { previous: { at: AT(1), instances: [{ instance: INSTANCE, seq: 3 }] } })[0], /accounted for it/);
});

check('a report cannot be marked clean over findings, nor over nobody', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(1) });
  const noisy = surveyOf({ ledgers: [ledger], at: AT(12) });
  assert.equal(noisy.clean, false);
  assert.match(surveyProblems({ ...noisy, clean: true }, { ledgers: [ledger] })[0], /marked clean and carries 1 finding/);
  assert.match(surveyProblems({ ...surveyOf({ at: AT(1) }), clean: true }, {})[0], /marked clean and accounts for no instances/);
});

check('a row cannot be marked current over its own findings, and the counts must add up', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(1) });
  const report = surveyOf({ ledgers: [ledger], at: AT(12) });
  const lying = { ...report, instances: [{ ...report.instances[0], state: 'current' }] };
  assert.match(surveyProblems(lying, { ledgers: [ledger] })[0], /reported current and carries 1 finding/);
  assert.match(surveyProblems({ ...report, enrolled: 4 }, { ledgers: [ledger] })[0], /says it covers 4 instance\(s\) and lists 1/);
  assert.deepEqual(surveyProblems(null, {}), ['not a survey']);
});

check('a finding wearing a severity that is not its own is refused', () => {
  const ledger = ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(1) });
  const report = surveyOf({ ledgers: [ledger], at: AT(12) });
  const downgraded = { ...report, findings: [{ ...report.findings[0], severity: 'finding', kind: 'vanished' }] };
  assert.match(surveyProblems(downgraded, { ledgers: [ledger] }).join('\n'), /vanished finding is material and this one claims to be finding/);
  const invented = { ...report, findings: [{ ...report.findings[0], kind: 'noticed' }] };
  assert.match(surveyProblems(invented, { ledgers: [ledger] })[0], /"noticed" is not one this service mints/);
});

check('the one-line description states every denominator it has', () => {
  const ledgers = [ledgerOf(chainOf(INSTANCE, 3), { witnessedAt: AT(1) }), ledgerOf(chainOf(OTHER, 2), { witnessedAt: AT(11) })];
  const line = describeSurvey(surveyOf({ ledgers, at: AT(12) }));
  assert.match(line, /2 instance\(s\), 1 current within 6 hours/);
  assert.match(line, /1 finding\(s\)/);
  assert.match(line, /surveyed 2026-08-15T12:00:00\.000Z/);
});

/* ------------------------------------------- 6. the surveyor cannot author, and holds nothing */

check('lib/findings.js imports no way to mint a record — a surveyor that could author could answer itself', () => {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/findings.js'), 'utf8'));
  const imports = [...src.matchAll(/import\s+([^;]*?)\s+from\s+'([^']+)'/g)];
  assert.deepEqual(imports.map((m) => m[2]).sort(), ['./publishable.js', './witness.js'], 'a leaf below the config directory');
  const names = imports
    .flatMap((m) => m[1].replace(/[{}]/g, '').split(','))
    .map((s) => s.trim().split(/\s+as\s+/)[0].trim())
    .filter(Boolean);
  for (const minter of ['record', 'next', 'genesis'])
    assert.ok(!names.includes(minter), `lib/findings.js imports \`${minter}\` — the surveyor can now author what it surveys`);
  assert.ok(!/(?<![A-Za-z0-9_$.])genesis\s*\(/.test(src), 'and does not call one by another name');
  assert.ok(!/CONFIG_DIR|refs\/beadcause/.test(src), 'and reaches for nothing on this particular Mac');
});

check('the surveyor persists nothing, so the evidence register claims nothing of it', () => {
  assert.equal(claimed().get('lib/findings.js'), undefined, 'a register entry for a module that keeps nothing fails as stale');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
