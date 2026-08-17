#!/usr/bin/env node
//
// No controlled document goes past its review date — `lib/documents.js`.
//
//   npm test
//   node test/documents.mjs
//
// bc-eqn1.11: an auditor does not read a document for accuracy. They ask who approved it,
// which version is current, and when it was last reviewed — and a nineteen-thousand-line
// README that answers none of the three is uncontrolled documentation however good it is.
//
// This is the half that makes the register stay true, and the failure it exists for is the
// one nothing else can catch: **a stale document does not look stale.** It reads exactly as
// well on the day it stops being true as it did the day it was approved, so the only thing
// that can find one is a date and something willing to fail on it. That is the argument
// lib/checkaudit.js makes about a check that has silently not passed for a month, with a
// longer fuse on it.
//
// Which means this suite will one day fail with no diff behind it. That is the control
// operating. What the suite has to earn in exchange is that the failure is never a
// surprise and never a lie, so three of the checks below are about the rules themselves
// rather than about the register: pointed at a date two years out every entry is overdue,
// pointed at a broken entry every field rule fires, and a section renamed in the README
// detaches from its owner loudly rather than quietly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  MAX_REVIEW_MONTHS,
  REGISTER,
  STATE,
  WARN_DAYS,
  addMonths,
  entryProblems,
  hasSection,
  history,
  parseDate,
  registerProblems,
  reviewStatus,
} from '../lib/documents.js';

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

/** A well-formed entry, to be broken one field at a time below. */
const sound = () => ({
  id: 'a-document',
  title: 'A document',
  path: 'README.md',
  section: null,
  owner: 'Adam Morgan',
  approvedBy: 'Adam Morgan',
  approvedOn: '2026-01-01',
  version: '1.0.0',
  reviewedOn: '2026-01-01',
  reviewMonths: 12,
  serves: 'ISO/IEC 42001 Clause 7.5 — documented information the management system needs.',
  why: 'It says what the system does, and a sentence in it that is no longer true is a control described but not operating.',
});

console.log('controlled documents\n');

/* ---------------------------------------------------------- the real register */

await check('the register is well-formed, and nothing in it is overdue', () => {
  const { problems } = registerProblems(ROOT);
  assert.deepEqual(problems, [], `${problems.length} problem(s):\n${problems.join('\n')}`);
});

await check('every controlled document is actually in the repo, at the section it claims', () => {
  for (const e of REGISTER) {
    const abs = path.join(ROOT, e.path);
    assert.ok(fs.existsSync(abs), `${e.id}: ${e.path} is not there`);
    if (e.section) {
      assert.ok(hasSection(fs.readFileSync(abs, 'utf8'), e.section), `${e.id}: ${e.path} has no heading \`${e.section}\``);
    }
  }
});

await check('the README is controlled, because it is the specification', () => {
  const readme = REGISTER.find((e) => e.path === 'README.md' && e.section === null);
  assert.ok(readme, 'the README carries every claim made to an auditor and is the one document that cannot be uncontrolled');
  assert.ok(readme.reviewMonths <= 12, 'annually at the outside');
});

await check('the two registers this programme has already produced are controlled documents themselves', () => {
  for (const p of ['lib/suppliers.js', 'lib/evidence.js']) {
    assert.ok(
      REGISTER.some((e) => e.path === p),
      `${p} is a register an auditor reads, so it is documented information and needs an owner and a review date like any other`
    );
  }
});

/* ------------------------------------------------------------------- the dates */

await check('a review date is the review period after the review, clamped to the month', () => {
  assert.equal(addMonths('2026-01-01', 12), '2027-01-01');
  assert.equal(addMonths('2026-01-31', 1), '2026-02-28', 'the 31st of January plus a month is not the 3rd of March');
  assert.equal(addMonths('2024-01-31', 1), '2024-02-29', 'and it knows about February in a leap year');
  assert.equal(addMonths('2026-06-15', 6), '2026-12-15');
});

await check('a date that is not a date is refused rather than rolled forward', () => {
  assert.equal(parseDate('2026-02-31'), null, 'Date.UTC would roll this into March, silently meaning a different day');
  assert.equal(parseDate('2026-13-01'), null);
  assert.equal(parseDate('15/08/2026'), null);
  assert.equal(parseDate(''), null);
  assert.ok(parseDate('2026-08-15') !== null);
});

await check('the three states fire, and the warning comes before the failure', () => {
  const e = { reviewedOn: '2026-01-01', reviewMonths: 12 };
  const on = (iso) => new Date(`${iso}T12:00:00Z`);

  assert.equal(reviewStatus(e, on('2026-06-01')).state, 'current');
  assert.equal(reviewStatus(e, on('2026-12-20')).state, 'approaching', `${WARN_DAYS} days out it says so`);
  assert.equal(reviewStatus(e, on('2027-01-01')).state, 'approaching', 'due today is not yet late');
  assert.equal(reviewStatus(e, on('2027-01-02')).state, 'overdue');
  assert.equal(reviewStatus(e, on('2027-01-02')).days, -1, 'and it counts how late, because the number is what makes it act');

  for (const s of ['current', 'approaching', 'overdue']) assert.ok(STATE.includes(s));
});

await check('every entry in the real register is overdue against a clock two years on', () => {
  // The check exists to fail. A suite that only ever ran it against a register that
  // passes could report a green repo either way, which is the failure mode this whole
  // file is written against.
  const later = new Date('2029-01-01T12:00:00Z');
  const { problems } = registerProblems(ROOT, later);
  const overdue = problems.filter((p) => p.includes('review was due'));
  assert.equal(overdue.length, REGISTER.length, `${overdue.length} of ${REGISTER.length} reported overdue`);
  assert.ok(
    overdue.every((p) => /Read it, change what is no longer true/.test(p)),
    'and each says what a review is, because "overdue" with no instruction is answered by moving the date'
  );
  assert.ok(overdue.every((p) => /owns it\.$/.test(p)), 'and names who owns it');
});

await check('a review coming due is a warning and not yet a failure', () => {
  const soon = new Date('2027-07-25T12:00:00Z'); // inside the warning window of the 12-month entries
  const { problems, warnings } = registerProblems(ROOT, soon, [
    { ...sound(), reviewedOn: '2026-08-15', reviewMonths: 12 },
  ]);
  assert.deepEqual(problems, [], 'not yet late');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /review due 2027-08-15, in \d+ days/);
});

/* ------------------------------------------------------- the rules, proved */

await check('a sound entry has nothing wrong with it', () => {
  assert.deepEqual(entryProblems(sound()), []);
});

await check('every field an auditor asks about can be shown to fail', () => {
  const fires = (patch, re) => {
    const problems = entryProblems({ ...sound(), ...patch });
    assert.ok(problems.some((p) => re.test(p)), `${JSON.stringify(patch)} produced ${JSON.stringify(problems)}`);
  };

  fires({ id: 'Not Kebab' }, /kebab-case/);
  fires({ title: '' }, /`title`/);
  fires({ path: '' }, /`path`/);
  fires({ owner: '' }, /`owner`/);
  fires({ approvedBy: '' }, /an approval nobody gave/);
  fires({ version: '' }, /`version`/);
  fires({ serves: 'clause 7.5' }, /`serves`/);
  fires({ why: 'it is important' }, /`why`/);
  fires({ approvedOn: 'last summer' }, /`approvedOn` must be a real date/);
  fires({ reviewedOn: '2026-02-31' }, /`reviewedOn` must be a real date/);
  fires({ section: 42 }, /`section`/);
});

await check('a document reviewed before it was approved is caught, because one of the two dates is wrong', () => {
  const problems = entryProblems({ ...sound(), approvedOn: '2026-06-01', reviewedOn: '2026-01-01' });
  assert.ok(problems.some((p) => /before it was approved/.test(p)), problems.join('\n'));
});

await check('a review period longer than the ceiling is refused as "never" with a number beside it', () => {
  assert.deepEqual(entryProblems({ ...sound(), reviewMonths: MAX_REVIEW_MONTHS }), []);
  const problems = entryProblems({ ...sound(), reviewMonths: MAX_REVIEW_MONTHS + 1 });
  assert.ok(problems.some((p) => /not a review cycle/.test(p)), problems.join('\n'));
  assert.ok(entryProblems({ ...sound(), reviewMonths: 0 }).length, 'nor is zero');
  assert.ok(entryProblems({ ...sound(), reviewMonths: 6.5 }).length, 'nor half a month');
});

await check('a date in the future is caught — it is the one way to pass every other rule and still be false', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const { problems } = registerProblems(ROOT, now, [{ ...sound(), reviewedOn: '2027-01-01' }]);
  assert.ok(problems.some((p) => /has not happened yet/.test(p)), problems.join('\n'));
});

await check('two entries cannot own the same document, and cannot share an id', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const twice = registerProblems(ROOT, now, [sound(), { ...sound(), id: 'another' }]);
  assert.ok(twice.problems.some((p) => /already controlled by another entry/.test(p)), 'two owners is no owner');

  const same = registerProblems(ROOT, now, [sound(), { ...sound(), path: 'package.json' }]);
  assert.ok(same.problems.some((p) => /same id/.test(p)));
});

await check('a controlled document that has left the repo fails rather than passing quietly', () => {
  const { problems } = registerProblems(ROOT, new Date('2026-08-15T12:00:00Z'), [{ ...sound(), path: 'docs/gone.md' }]);
  assert.ok(problems.some((p) => /is not in the repo/.test(p)), problems.join('\n'));
});

await check('renaming a controlled section detaches it from its owner, loudly', () => {
  const now = new Date('2026-08-15T12:00:00Z');
  const entry = { ...sound(), section: '## A heading nobody wrote' };
  const { problems } = registerProblems(ROOT, now, [entry]);
  assert.ok(problems.some((p) => /no longer has the heading/.test(p)), problems.join('\n'));

  // And the matcher is whole-line, so a heading quoted inside a paragraph is not it.
  assert.equal(hasSection('some prose about ## Install and what it does', '## Install'), false);
  assert.equal(hasSection('# One\n## Install\n\ntext', '## Install'), true);
});

/* -------------------------------------------------------------- the drafts */

await check('a draft records no approval, and is not required to have one', () => {
  const draft = { ...sound(), approvedBy: null, approvedOn: null, awaitingApproval: 'Adam Morgan, as top management' };
  assert.deepEqual(entryProblems(draft), [], 'a document waiting for a signature is a state, not a defect');
});

await check('a draft carrying an approval anyway is refused, because that is the lie', () => {
  const both = { ...sound(), awaitingApproval: 'Adam Morgan, as top management' };
  const problems = entryProblems(both);
  assert.ok(problems.some((p) => /must carry `approvedBy: null` and `approvedOn: null`/.test(p)), problems.join('\n'));

  const half = { ...sound(), approvedBy: null, awaitingApproval: 'Adam Morgan, as top management' };
  assert.ok(entryProblems(half).some((p) => /approvedOn: null/.test(p)), 'a leftover date is the same problem');
});

await check('a draft awaiting nobody in particular is refused', () => {
  const vague = { ...sound(), approvedBy: null, approvedOn: null, awaitingApproval: '' };
  const problems = entryProblems(vague);
  // An empty string is not "no draft" — it is a draft whose signatory nobody wrote down, which
  // is the one that would sit in the register for a year with nobody able to say whose it was.
  assert.ok(problems.some((p) => /`awaitingApproval` must name whose signature/.test(p)), problems.join('\n'));
});

await check('a draft warns every time anybody asks, and never fails', () => {
  const now = new Date('2026-08-17T12:00:00Z');
  const draft = {
    ...sound(),
    reviewedOn: '2026-08-17',
    approvedBy: null,
    approvedOn: null,
    awaitingApproval: 'Adam Morgan, as top management',
  };
  const { problems, warnings } = registerProblems(ROOT, now, [draft]);
  assert.deepEqual(problems, [], 'failing on a state only a signature can clear is not something a terminal can fix');
  assert.ok(warnings.some((w) => /draft, awaiting Adam Morgan/.test(w)), warnings.join('\n'));
});

await check('the review clock still runs on a draft, because one unsigned for a year is a different problem', () => {
  const draft = {
    ...sound(),
    approvedBy: null,
    approvedOn: null,
    awaitingApproval: 'Adam Morgan, as top management',
  };
  const { problems } = registerProblems(ROOT, new Date('2029-01-01T12:00:00Z'), [draft]);
  assert.ok(problems.some((p) => /review was due/.test(p)), problems.join('\n'));
});

await check('the four documents bc-eqn1.1 drafted are in the register, and all four are drafts', () => {
  const drafted = REGISTER.filter((e) => e.awaitingApproval);
  assert.equal(drafted.length, 4, 'the AI policy, the scope statement, the interested parties and the roles table');
  for (const e of drafted) {
    assert.equal(e.approvedOn, null, `${e.id}: a draft that records an approval is the artefact this refuses to produce`);
    assert.equal(e.approvedBy, null, `${e.id}: same`);
    assert.ok(e.section?.startsWith('#### '), `${e.id}: each is a section of the README, which is where a person reads it`);
  }
});

/* ------------------------------------------------------------ change history */

await check('the change history is the one in git, and an unknown path is empty rather than an error', () => {
  const real = history(ROOT, { path: 'README.md' }, 3);
  assert.ok(real.length >= 1, 'the README has a history');
  assert.match(real[0].at, /^\d{4}-\d{2}-\d{2}T/, 'with a date on each revision');
  assert.ok(real[0].sha && real[0].who && real[0].subject, `sparse revision: ${JSON.stringify(real[0])}`);
  assert.ok(real[0].subject.includes(' ') || real[0].subject.length > 0, 'the subject is the whole subject, spaces and all');

  assert.deepEqual(history(ROOT, { path: 'docs/never-existed.md' }), [], 'no history is not an error');
  assert.deepEqual(history('/nowhere-at-all', { path: 'README.md' }), [], 'and neither is no repo');
});

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
