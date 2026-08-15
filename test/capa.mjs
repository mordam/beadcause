#!/usr/bin/env node
/**
 * A nonconformity grows a root cause, an action, and a dated check that blocks its close.
 *
 *     npm test
 *     node test/capa.mjs
 *
 * bc-eqn1.13. `lib/errors.js` files the P0 and `lib/incident.js` puts a clock on it, so
 * detection and correction were already done. This is Clause 10.2's remainder, and there
 * are six things it has to get right — the first two more than the rest, because both are
 * mistakes that read as success.
 *
 * 1. **A gate refusal is not a nonconformity.** They are different kinds in a closed
 *    vocabulary, they live in different places, and a row carrying both labels is a throw
 *    rather than a guess. An auditor reading a pile of refusals as failures draws exactly
 *    the wrong conclusion, and every count here keeps them apart.
 * 2. **A seeded section is not an answered one.** The record is created with the question
 *    under each heading; if `capaFrom` counted that prose as an answer, every record would
 *    be complete the moment it was filed and the whole thing would be a form.
 * 3. **The check is a blocker, and `deferred` still blocks.** bd refuses a close over any
 *    dependency that is not closed (lib/bd.js `gateFor`), which is what lets the check be
 *    deferred until its date without letting go of the door.
 * 4. **A record closed over an open check is visible as forced.** bd refuses that close,
 *    so it can only have been `--force`d — and the register's job is to make sure that
 *    decision was made in the open rather than lost.
 * 5. **The paperwork is not a second finding.** The check bead carries `nonconformity` so
 *    the register is one `bd list`, and is pulled out of the records exactly as a review
 *    is pulled out of the incident register.
 * 6. **What is owed needs no judgement.** A commitment stated before the incident and
 *    missed is a requirement not met, by construction; everything else is raised by hand.
 *
 * Nothing here opens a window, reaches the network or touches a real tracker.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const {
  CHECK_LABEL,
  CHECK_OF_PREFIX,
  DEFAULT_CHECK_DAYS,
  DUE_PREFIX,
  KINDS,
  NONCONFORMITY_LABEL,
  RAISED_FROM_PREFIX,
  REFUSAL_LABEL,
  REFUSAL_MARK,
  SECTIONS,
  UNANSWERED,
  capaFrom,
  checksOverdue,
  dueFromLabels,
  dueOn,
  effectivenessBead,
  forcedCloses,
  isoDay,
  kindFromLabels,
  nonconformitiesOwed,
  nonconformityBead,
  parseRefusal,
  periodEvidence,
  refusalComment,
  refusalRecord,
  refusalsFrom,
  register,
  requireKind,
} = await import(path.join(ROOT, 'lib', 'capa.js'));

const DAY = 86_400_000;
const NOW = Date.parse('2026-09-01T12:00:00Z');
let passed = 0;
const ok = (what) => {
  passed += 1;
  console.log(`  ok  ${what}`);
};

/* ------------------------------------------- 1. the two kinds, and never both at once */

console.log('the vocabulary, and the separation it exists for');

assert.equal(KINDS.length, 2, 'two record kinds and no more');
assert.equal(requireKind('nonconformity').id, 'nonconformity');
assert.equal(requireKind('REFUSAL').id, 'refusal', 'case is not a different kind');
assert.throws(() => requireKind('sev1'), /no such record kind/, 'a kind nobody minted is a refusal');
assert.throws(() => requireKind(''), /no such record kind/);
ok('the kind vocabulary is closed — an id nobody minted throws');

assert.equal(kindFromLabels([NONCONFORMITY_LABEL, 'compliance']).id, 'nonconformity');
assert.equal(kindFromLabels([REFUSAL_LABEL]).id, 'refusal');
assert.equal(kindFromLabels(['app-error', 'sev2']), null, 'most rows are neither');
assert.throws(
  () => kindFromLabels([NONCONFORMITY_LABEL, REFUSAL_LABEL]),
  /never the same record/,
  'both labels is a throw, not a guess about which one to count',
);
ok('a row cannot be both a finding and a control working');

// The two `means` sentences have to actually disagree — this is the line that gets read
// out at an audit, and two paraphrases of "something went wrong" would be worthless.
const refusal = KINDS.find((k) => k.id === 'refusal');
assert.match(refusal.means, /control operating|not a failure/i);
assert.match(refusal.counts, /never as a finding/i);
ok('the refusal kind says in words that it is not a finding');

/* --------------------------------------------------- 2. a seeded section is not an answer */

console.log('\nthe record, and what it does not yet say');

const bead = nonconformityBead({
  source: 'bc-src',
  title: 'the advocate tick threw for six days',
  requirement: 'a background sweep that fails is a bead',
  due: '2026-10-01',
});
assert.match(bead.title, /^Nonconformity: /);
assert.ok(bead.labels.includes(NONCONFORMITY_LABEL));
assert.ok(bead.labels.includes(`${RAISED_FROM_PREFIX}bc-src`));
assert.deepEqual(bead.deps, ['discovered-from:bc-src'], 'raised from, never blocking, the bug');
assert.ok(!bead.deps.some((d) => String(d).startsWith('blocks:')), 'the record must not block the bug bead');
assert.equal(bead.priority, 2, 'the record is the unhurried half — the bug is the P0');
ok('a record is raised from the bug and never blocks it');

const fresh = capaFrom({ description: bead.description });
assert.equal(fresh.complete, false);
// One section is seeded from the requirement at raise time; the other four are the ones
// somebody has to sit down and answer.
assert.deepEqual(fresh.missing, ['correction', 'cause', 'action', 'effectiveness']);
assert.match(fresh.sections.happened, /a background sweep that fails is a bead/);
ok('a freshly raised record answers one section and owes four');

// THE ONE THAT MATTERS. Every unanswered section carries the question under it, in
// italics. If that prose counted, `complete` would be true here and the register would
// report a shelf of finished CAPAs that say nothing.
assert.ok(bead.description.includes(UNANSWERED));
for (const s of SECTIONS) assert.ok(bead.description.includes(s.asks), `${s.id} is seeded with its question`);
assert.ok(fresh.missing.length >= 4, 'the seeded questions are not answers');
ok('the seeded question is not mistaken for an answer');

/* ------------------------------------------------ the answer arrives however it arrives */

const answeredByComment = capaFrom(
  { description: bead.description },
  { comments: [{ text: 'unrelated chatter' }, { text: '#### Root cause\n\nThe sweep swallowed every error class, so a TypeError looked like a locked tracker.' }] },
);
assert.equal(answeredByComment.missing.includes('cause'), false, 'a comment answers a section');
assert.match(answeredByComment.sections.cause, /swallowed every error class/);
ok('an answer in a comment counts, because that is how answers arrive');

const twice = capaFrom(
  { description: bead.description },
  { comments: [{ text: '#### Correction\n\nfirst attempt' }, { text: '#### Correction\n\nwhat was actually done' }] },
);
assert.equal(twice.sections.correction, 'what was actually done', 'the later answer wins');
ok('appending a better answer replaces the earlier one');

const whole = capaFrom({
  description: SECTIONS.map((s) => `#### ${s.heading}\n\nsomething real about ${s.id}`).join('\n\n'),
});
assert.equal(whole.complete, true);
assert.deepEqual(whole.missing, []);
ok('a record with all five answered reads as complete');

/* ------------------------------------------------------ 3. the check, dated and blocking */

console.log('\nthe effectiveness check');

const check = effectivenessBead({ nonconformity: 'bc-nc1', title: 'the sweep', due: '2026-10-01', action: 'isBug now covers the class' });
assert.ok(check.labels.includes(CHECK_LABEL));
assert.ok(check.labels.includes(NONCONFORMITY_LABEL), 'it rides the same label so the register is one bd list');
assert.ok(check.labels.includes(`${CHECK_OF_PREFIX}bc-nc1`));
assert.ok(check.labels.includes(`${DUE_PREFIX}2026-10-01`));
assert.equal(dueFromLabels(check.labels), '2026-10-01');
assert.match(check.title, /^Effectiveness check 2026-10-01: /);
assert.match(check.description, /cannot close/);
assert.match(check.description, /did not work.*real answer/is, '"it did not work" has to be stated as an outcome');
assert.throws(() => effectivenessBead({}), /check of a nonconformity/);
ok('the check is dated on the bead, in a label, and in its title');

assert.equal(dueOn({ from: NOW, days: 30 }), isoDay(NOW + 30 * DAY));
assert.equal(dueOn({ from: NOW }), isoDay(NOW + DEFAULT_CHECK_DAYS * DAY), 'a horizon nobody named is the default');
assert.equal(dueOn({ from: NOW, days: 0 }), isoDay(NOW + DEFAULT_CHECK_DAYS * DAY), 'a same-day check is not a check');
assert.equal(dueOn({ from: NOW, days: 'soon' }), isoDay(NOW + DEFAULT_CHECK_DAYS * DAY));
ok('the due date is arithmetic on a day, and a nonsense horizon falls back');

/* ---------------------------------------------------- 4 & 5. the register, and what it sees */

console.log('\nthe register');

const answered = SECTIONS.map((s) => `#### ${s.heading}\n\nsaid`).join('\n\n');
const rows = [
  { id: 'nc-open', title: 'check still open', status: 'open', labels: [NONCONFORMITY_LABEL, `${RAISED_FROM_PREFIX}bc-a`], description: answered },
  { id: 'nc-open-check', title: 'the check of it', status: 'deferred', labels: [NONCONFORMITY_LABEL, CHECK_LABEL, `${CHECK_OF_PREFIX}nc-open`, `${DUE_PREFIX}2026-12-01`] },
  { id: 'nc-done', title: 'check answered', status: 'closed', labels: [NONCONFORMITY_LABEL], description: answered },
  { id: 'nc-done-check', title: 'its check', status: 'closed', labels: [NONCONFORMITY_LABEL, CHECK_LABEL, `${CHECK_OF_PREFIX}nc-done`, `${DUE_PREFIX}2026-08-01`] },
  { id: 'nc-forced', title: 'closed over an open check', status: 'closed', labels: [NONCONFORMITY_LABEL], description: answered },
  { id: 'nc-forced-check', title: 'never answered', status: 'open', labels: [NONCONFORMITY_LABEL, CHECK_LABEL, `${CHECK_OF_PREFIX}nc-forced`, `${DUE_PREFIX}2026-08-01`] },
  { id: 'nc-bare', title: 'nothing is holding it', status: 'open', labels: [NONCONFORMITY_LABEL], description: 'a paragraph and no headings' },
];

const reg = register(rows, { now: NOW });
assert.deepEqual(
  reg.map((r) => r.id).sort(),
  ['nc-bare', 'nc-done', 'nc-forced', 'nc-open'],
  'the four checks are paperwork and are not records of their own',
);
ok('the checks are pulled out — the paperwork about a finding is not a second finding');

const by = new Map(reg.map((r) => [r.id, r]));

// The door. `deferred` is not closed, so it is still a blocker — the whole reason a check
// can be scheduled for its date without letting go.
assert.equal(by.get('nc-open').blocked, true, 'a deferred check still blocks');
assert.equal(by.get('nc-open').checkStatus, 'deferred');
assert.equal(by.get('nc-open').forced, false);
assert.equal(by.get('nc-open').checkOverdue, false, 'due in December, and it is September');
ok('an open record behind a deferred check is blocked, not overdue');

assert.equal(by.get('nc-done').checkDone, true);
assert.equal(by.get('nc-done').blocked, false);
assert.equal(by.get('nc-done').forced, false, 'closed after its check is exactly right');
ok('a record closed after its check was answered is clean');

assert.equal(by.get('nc-forced').forced, true, 'closed over an open check can only have been --forced');
assert.equal(by.get('nc-forced').checkOverdue, true, 'and its check is a month past its date');
assert.deepEqual(forcedCloses(reg).map((r) => r.id), ['nc-forced']);
ok('a record closed over an open check is visible as forced');

assert.equal(by.get('nc-bare').unchecked, true);
assert.equal(by.get('nc-bare').checkId, '');
assert.equal(by.get('nc-bare').complete, false);
assert.equal(by.get('nc-bare').missing.length, SECTIONS.length, 'a paragraph answers nothing');
ok('a record with no check at all says so, and nothing is holding it');

assert.deepEqual(checksOverdue(reg).map((r) => r.id), ['nc-forced']);
assert.equal(reg[0].id, 'nc-forced', 'the worst thing about the register sorts first');
ok('overdue checks are listed, and the register leads with what is wrong with it');

assert.throws(
  () => register([{ id: 'both', labels: [NONCONFORMITY_LABEL, REFUSAL_LABEL] }]),
  /never the same record/,
  'the register will not quietly count a confused row either way',
);
ok('the register refuses a row that is both kinds');

/* ---------------------------------------------------------------- 6. what is owed */

console.log('\nwhat is owed without anybody deciding');

const clocks = [
  { id: 'inc-breach', title: 'missed', severity: 'sev2', breached: true, resolved: NOW - DAY, ackMet: false, resolveMet: true },
  { id: 'inc-ok', title: 'met both', severity: 'sev2', breached: false, resolved: NOW - DAY },
  { id: 'inc-live', title: 'still open and already late', severity: 'sev1', breached: true, resolved: null },
  { id: 'bc-a', title: 'already has a record', severity: 'sev2', breached: true, resolved: NOW - DAY },
];
const owed = nonconformitiesOwed(clocks, reg);
assert.deepEqual(owed.map((c) => c.id), ['inc-breach']);
ok('a breached, resolved incident with no record is owed one — and only that');

assert.deepEqual(nonconformitiesOwed(clocks, []).map((c) => c.id), ['inc-breach', 'bc-a'], 'bc-a is owed only because nc-open covers it');
ok('an incident already covered by a record is not owed a second one');

/* --------------------------------------------------------- the other kind of record */

console.log('\ngate refusals — the control working');

assert.throws(() => refusalRecord({ gate: 'endorse' }), /name the control/, 'an unnamed refusal is an obstruction');
assert.throws(() => refusalRecord({ control: 'A.9.2' }), /name the gate/);
const r = refusalRecord({
  control: 'A.9.2',
  gate: 'endorse',
  subject: 'bc-x — an unattended session on an unendorsed bead',
  why: 'nothing had looked at it',
  at: NOW,
});
const comment = refusalComment(r);
assert.ok(comment.startsWith(REFUSAL_MARK), 'the first line is the one a scan finds');
assert.match(comment, /never counted as one/, 'every single one says what it is');
const back = parseRefusal(comment);
assert.equal(back.control, 'A.9.2');
assert.equal(back.gate, 'endorse');
assert.equal(back.subject, 'bc-x — an unattended session on an unendorsed bead');
assert.equal(back.why, 'nothing had looked at it');
assert.equal(back.at, NOW);
ok('a refusal round-trips through the comment it is stored as');

assert.equal(parseRefusal('an ordinary comment about the weather'), null);
const found = refusalsFrom([{ text: 'chatter' }, comment, { text: refusalComment({ ...r, at: NOW - DAY }) }], { bead: 'bc-x' });
assert.equal(found.length, 2);
assert.equal(found[0].at, NOW - DAY, 'oldest first');
assert.equal(found[0].bead, 'bc-x');
ok('refusals are read back off a bead and ordered, ignoring everything else');

/* ------------------------------------------------- and never added to the same total */

console.log('\nthe evidence, counted apart');

const raisedAt = new Map(rows.map((row) => [row.id, NOW - 2 * DAY]));
const ev = periodEvidence(reg, found, { from: NOW - 30 * DAY, to: NOW, raisedAt });
assert.equal(ev.nonconformities.total, 4);
assert.equal(ev.nonconformities.forced, 1);
assert.equal(ev.nonconformities.unchecked, 1);
assert.equal(ev.nonconformities.checksDone, 1);
assert.equal(ev.nonconformities.checksOverdue, 1);
assert.equal(ev.refusals.total, 2);
assert.deepEqual(ev.refusals.byControl, { 'A.9.2': 2 });
// The assertion the module exists for: refusals cannot reach any nonconformity number.
const none = periodEvidence(reg, [], { from: NOW - 30 * DAY, to: NOW, raisedAt });
assert.deepEqual(ev.nonconformities, none.nonconformities, 'refusals change no finding count at all');
assert.match(ev.refusals.meaning, /never as a finding/);
ok('refusals are counted in their own field and move no finding count');

const narrow = periodEvidence(reg, found, { from: NOW - DAY / 2, to: NOW, raisedAt });
assert.equal(narrow.nonconformities.total, 0, 'a period bounds by when the record was raised');
assert.equal(narrow.refusals.total, 1, 'and refusals by when the refusal happened');
ok('the two are bounded by their own timestamps');

// `Date.parse` of nonsense is NaN, which is a number — a row whose timestamp cannot be
// read must fall outside a bounded window rather than into every one of them.
const unreadable = periodEvidence(reg, [], { from: NOW - 30 * DAY, to: NOW, raisedAt: new Map([['nc-open', 'not a date']]) });
assert.equal(unreadable.nonconformities.total, 0);
assert.equal(periodEvidence(reg, [], { raisedAt: new Map() }).nonconformities.total, 4, 'and into all of history when nothing bounds it');
ok('a record with an unreadable timestamp is outside a window, not inside every one');

/* --------------------------------------------------------------------- and the table */

execFileSync(process.execPath, ['--check', path.join(ROOT, 'bin', 'capa.js')], { stdio: 'pipe' });
ok('bin/capa.js parses');

console.log(`\n${passed} checks passed`);
