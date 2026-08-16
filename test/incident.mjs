#!/usr/bin/env node
/**
 * An error that filed itself grows a severity, a clock and a review.
 *
 *     npm test
 *     node test/incident.mjs
 *
 * bc-4r10.9. `lib/errors.js` already turned a reported error into a P0 bead; this is the
 * rest of what CC7 asks for, and the five things it has to get right.
 *
 * 1. **The severity vocabulary is closed.** An id nobody minted is a throw, not a
 *    warning — a scale you can add to at the moment of the incident says whatever the
 *    person filing wanted it to say.
 * 2. **The classification is about impact, not about the stack.** A daemon that exited
 *    is not the same event as a toast on one phone, and the mapping from the reporters'
 *    own `kind` values is asserted for every kind either reporter emits, because a kind
 *    that quietly falls through to the default is a real outage on a 30-day clock.
 * 3. **The clock is read, never written.** Every number comes from `created_at`,
 *    `started_at` and `closed_at`, which bd writes while people do their ordinary work.
 *    Nothing in lib/incident.js stamps anything, and the suite pins that by handing it
 *    plain rows and asserting the arithmetic.
 * 4. **`met` is three-valued.** An incident ninety seconds old has not missed a
 *    fifteen-minute commitment, and a period report that folded "not yet" into "missed"
 *    would show a total breach every time it was run during an incident. This is the
 *    check most likely to be lost to a well-meaning simplification.
 * 5. **A review is owed by severity and answered by a bead.** Not by a document, not by
 *    a memory — the register has to be able to say how many of the ones that were owed
 *    exist.
 *
 * And one end-to-end: a report through the real `intake` lands a bead carrying the
 * severity, with the commitment written on it in words.
 *
 * Nothing here opens a window, reaches the network or touches a real tracker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-incident-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const {
  EXERCISES,
  EXERCISE_LABEL,
  INCIDENT_LABEL,
  REVIEW_LABEL,
  REVIEW_OF_PREFIX,
  SEVERITIES,
  breaches,
  clockFor,
  commitmentFor,
  commitmentNote,
  communicationFor,
  escalated,
  exerciseBead,
  incidentLabels,
  periodEvidence,
  register,
  requireSeverity,
  reviewBead,
  reviewsOwed,
  severityFromLabels,
  severityOf,
} = await import(LIB('incident.js'));
const { intake, labelsFor, describe, fingerprint } = await import(LIB('errors.js'));

const MIN = 60_000;
const T0 = Date.parse('2026-08-01T00:00:00Z');
const at = (minutes) => new Date(T0 + minutes * MIN).toISOString();

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nan error that filed itself grows a severity, a clock and a review\n');

/* -------------------------------------------------------------- the vocabulary */

await check('the severity vocabulary is closed — an id nobody minted is a throw', () => {
  assert.equal(requireSeverity('sev1').rank, 1);
  assert.equal(requireSeverity('SEV2').id, 'sev2', 'and it is case-insensitive, because a label is typed by hand');
  assert.throws(() => requireSeverity('sev0'), /no such severity/);
  assert.throws(() => requireSeverity('critical'), /no such severity/, 'another framework’s word is not this one');
  assert.throws(() => requireSeverity(''), /no such severity/);
});

await check('the four are ordered, and every one has a commitment in code', () => {
  assert.deepEqual(
    SEVERITIES.map((s) => s.id),
    ['sev1', 'sev2', 'sev3', 'sev4']
  );
  for (const s of SEVERITIES) {
    assert.ok(s.acknowledge >= 1 && s.resolve > s.acknowledge, `${s.id} must resolve in longer than it acknowledges`);
    assert.ok(s.means && s.tell, `${s.id} has to say what it means and who is told`);
  }
  // Worse is faster, all the way down. A scale where sev2 gets longer than sev3 is one
  // where the number means nothing.
  for (let i = 1; i < SEVERITIES.length; i += 1) {
    assert.ok(SEVERITIES[i].acknowledge > SEVERITIES[i - 1].acknowledge, 'each level is slower than the one above');
    assert.ok(SEVERITIES[i].resolve > SEVERITIES[i - 1].resolve);
  }
});

/* ------------------------------------------------------------ the classification */

await check('every kind either reporter emits is classified by impact, not by the stack', () => {
  const expected = {
    // lib/crash.js — by the time the bead is written the daemon is going down.
    uncaughtException: 'sev1',
    unhandledRejection: 'sev1',
    'daemon sweep — release': 'sev2',
    // public/report.js — a failed fetch is the backend not answering, from the phone's
    // side indistinguishable from the daemon being down.
    fetch: 'sev2',
    error: 'sev3',
    rejection: 'sev3',
    sw: 'sev3',
    toast: 'sev4',
    manual: 'sev4',
  };
  for (const [kind, want] of Object.entries(expected)) {
    assert.equal(severityOf({ kind }).id, want, `${kind} should be ${want}`);
  }
});

await check('a kind nobody knows is sev3 — the cheaper mistake is the one you can see', () => {
  assert.equal(severityOf({ kind: 'something-new' }).id, 'sev3');
  assert.equal(severityOf({}).id, 'sev3', 'and a report with no kind at all is the same');
  assert.notEqual(severityOf({ kind: 'something-new' }).id, 'sev4', 'never buried on a 30-day clock');
});

await check('volume escalates a level, and can never manufacture a sev1', () => {
  assert.equal(escalated('sev3', { occurrences: 9 }).id, 'sev3', 'under the threshold nothing moves');
  assert.equal(escalated('sev3', { occurrences: 10 }).id, 'sev2');
  assert.equal(escalated('sev4', { occurrences: 40 }).id, 'sev3', 'one level, not straight to the top');
  assert.equal(escalated('sev2', { occurrences: 400 }).id, 'sev2', 'the ceiling — sev1 means the process died');
  assert.equal(escalated('sev1', { occurrences: 400 }).id, 'sev1');
  assert.equal(escalated('sev3', { occurrences: 999, escalateAt: 0 }).id, 'sev3', 'a zero threshold turns it off');
});

await check('the labels are the register plus the severity, and read back', () => {
  assert.deepEqual(incidentLabels('sev2'), [INCIDENT_LABEL, 'sev2']);
  assert.equal(severityFromLabels([INCIDENT_LABEL, 'sev2', 'app-error']).id, 'sev2');
  assert.equal(severityFromLabels(['app-error']), null, 'a bead filed before this existed is not a failure');
  assert.throws(() => severityFromLabels(['sev9']), /no such severity/, 'but a typo is');
});

/* ------------------------------------------------------------------- the clock */

const incident = (over = {}) => ({
  id: 'bc-x1',
  title: 'the graph sheet threw',
  status: 'closed',
  labels: [INCIDENT_LABEL, 'sev2'],
  created_at: at(0),
  ...over,
});

await check('the clock is read off created_at, started_at and closed_at and nothing else', () => {
  const c = clockFor(incident({ started_at: at(30), closed_at: at(600) }), { now: T0 + 700 * MIN });
  assert.equal(c.ackMinutes, 30);
  assert.equal(c.resolveMinutes, 600);
  assert.equal(c.ackMet, true, '30 minutes against a 60-minute commitment');
  assert.equal(c.resolveMet, true, '10 hours against a 24-hour commitment');
  assert.equal(c.breached, false);
  assert.equal(c.open, false);
});

await check('missing both commitments is two separate misses, and both are named', () => {
  const c = clockFor(incident({ started_at: at(200), closed_at: at(3000) }), { now: T0 + 3100 * MIN });
  assert.equal(c.ackMet, false);
  assert.equal(c.resolveMet, false);
  assert.equal(c.breached, true);
  assert.deepEqual(breaches([c]).map((x) => x.id), ['bc-x1']);
});

await check('met is three-valued: inside the window is pending, not missed', () => {
  const fresh = clockFor(incident({ status: 'open', closed_at: null }), { now: T0 + 5 * MIN });
  assert.equal(fresh.ackMet, null, 'five minutes into a sixty-minute acknowledgement window');
  assert.equal(fresh.resolveMet, null);
  assert.equal(fresh.breached, false, 'and nothing is breached yet');
  assert.equal(fresh.open, true);

  const late = clockFor(incident({ status: 'open', closed_at: null }), { now: T0 + 90 * MIN });
  assert.equal(late.ackMet, false, 'past the window with nobody having claimed it, it is missed');
  assert.equal(late.resolveMet, null, 'while the resolution window is still running');
  assert.equal(late.breached, true);
});

await check('a bead closed without ever being claimed counts as acknowledged when it closed', () => {
  // The real case: a fix that landed under another bead's pull request, or a duplicate.
  // Leaving it never-acknowledged for ever would be a permanent breach for work that was
  // done — the opposite of what the number is for.
  const c = clockFor(incident({ started_at: null, closed_at: at(20) }), { now: T0 + 100 * MIN });
  assert.equal(c.acknowledged, Date.parse(at(20)));
  assert.equal(c.ackMet, true);
});

await check('config overrides one number and leaves the rest', () => {
  const config = { incidents: { sev2: { acknowledge: 5 } } };
  const c = commitmentFor('sev2', config);
  assert.equal(c.acknowledge, 5);
  assert.equal(c.resolve, 1440, 'the number nobody set is still the stated one');
  const clock = clockFor(incident({ started_at: at(30), closed_at: at(60) }), { now: T0 + 100 * MIN, config });
  assert.equal(clock.ackMet, false, 'and the tighter commitment is the one it is measured against');
});

await check('a commitment of zero cannot turn the control off', () => {
  const c = commitmentFor('sev1', { incidents: { sev1: { acknowledge: 0, resolve: -5 } } });
  assert.equal(c.acknowledge, 15, 'a zero would breach every incident at the moment it was filed');
  assert.equal(c.resolve, 240);
});

await check('an unclassified bead still lands in the register, and says so', () => {
  const c = clockFor(incident({ labels: ['app-error'] }), { now: T0 + 10 * MIN });
  assert.equal(c.severity, 'sev3');
  assert.equal(c.classified, false, 'so a period report can say how much of it is history');
});

/* ---------------------------------------------------------------- the register */

await check('the register keeps closed incidents — a register that drops them evidences nothing', () => {
  const rows = [
    incident({ id: 'a', labels: [INCIDENT_LABEL, 'sev3'], created_at: at(10), closed_at: at(20) }),
    incident({ id: 'b', labels: [INCIDENT_LABEL, 'sev1'], created_at: at(50), status: 'open', closed_at: null }),
    incident({ id: 'c', labels: [INCIDENT_LABEL, 'sev1'], created_at: at(5), closed_at: at(30) }),
  ];
  const reg = register(rows, { now: T0 + 100 * MIN });
  assert.deepEqual(reg.map((r) => r.id), ['c', 'b', 'a'], 'worst first, then oldest');
  assert.equal(reg.length, 3, 'and the closed ones are in it');
});

await check('a review bead is pulled out of the register and matched to its incident', () => {
  const rows = [
    incident({ id: 'a', labels: [INCIDENT_LABEL, 'sev1'], closed_at: at(30) }),
    {
      id: 'r1',
      title: 'Post-incident review: …',
      status: 'open',
      labels: [INCIDENT_LABEL, REVIEW_LABEL, `${REVIEW_OF_PREFIX}a`],
      created_at: at(40),
    },
  ];
  const reg = register(rows, { now: T0 + 100 * MIN });
  assert.deepEqual(reg.map((r) => r.id), ['a'], 'a review is not an incident of its own');
  assert.equal(reg[0].reviewedBy, 'r1');
  assert.deepEqual(reviewsOwed(reg), [], 'and nothing is owed once it exists');
});

await check('a review is owed by severity, and only once the incident is resolved', () => {
  const open1 = clockFor(incident({ labels: [INCIDENT_LABEL, 'sev1'], status: 'open', closed_at: null }), { now: T0 });
  assert.equal(open1.reviewOwed, false, 'nothing is owed while it is still happening');
  const done1 = clockFor(incident({ labels: [INCIDENT_LABEL, 'sev1'], closed_at: at(30) }), { now: T0 + 100 * MIN });
  assert.equal(done1.reviewOwed, true);
  const done3 = clockFor(incident({ labels: [INCIDENT_LABEL, 'sev3'], closed_at: at(30) }), { now: T0 + 100 * MIN });
  assert.equal(done3.reviewOwed, false, 'a broken surface does not owe a review');
  const wider = clockFor(incident({ labels: [INCIDENT_LABEL, 'sev3'], closed_at: at(30) }), {
    now: T0 + 100 * MIN,
    config: { incidents: { reviewFrom: 'sev3' } },
  });
  assert.equal(wider.reviewOwed, true, 'and where it is owed is configurable');
});

await check('the review bead asks the only question that changes anything', () => {
  const c = clockFor(incident({ labels: [INCIDENT_LABEL, 'sev1'], started_at: at(200), closed_at: at(3000) }), {
    now: T0 + 3100 * MIN,
  });
  const bead = reviewBead(c, { workspace: 'beadcause' });
  assert.ok(bead.labels.includes(REVIEW_LABEL) && bead.labels.includes(`${REVIEW_OF_PREFIX}bc-x1`));
  assert.ok(bead.labels.includes(INCIDENT_LABEL), 'so the register is still one bd call');
  assert.deepEqual(bead.deps, ['discovered-from:bc-x1']);
  assert.match(bead.description, /risk register/i, 'question 4 is the whole point of the review');
  assert.match(bead.description, /missed its commitment/i, 'and it opens with the fact that it did');
  assert.match(bead.acceptance, /risk/i);

  const kept = reviewBead(clockFor(incident({ labels: [INCIDENT_LABEL, 'sev1'], started_at: at(1), closed_at: at(30) }), { now: T0 + 100 * MIN }));
  assert.match(kept.description, /met its commitment/i, 'a review is not only for the ones that went badly');
});

await check('an exercise is paperwork about incidents, not an incident', () => {
  const rows = [
    incident({ id: 'a', labels: [INCIDENT_LABEL, 'sev2'], closed_at: at(30) }),
    { id: 'x1', title: 'Incident response exercise: night-exit', status: 'open', labels: [INCIDENT_LABEL, EXERCISE_LABEL], created_at: at(40) },
  ];
  const reg = register(rows, { now: T0 + 100 * MIN });
  assert.deepEqual(reg.map((r) => r.id), ['a'], 'a bad month must not look worse for having been rehearsed');
  assert.equal(periodEvidence(reg, {}).total, 1);
});

await check('a tabletop exercise is a bead with a date, participants and the fourth question', () => {
  assert.deepEqual(EXERCISES.map((e) => e.id), ['night-exit', 'silent-sweep', 'no-fix-critical']);
  for (const e of EXERCISES) requireSeverity(e.severity);
  const bead = exerciseBead({ id: 'night-exit', participants: ['Adam'], when: '2026-09-01' });
  assert.ok(bead.labels.includes(EXERCISE_LABEL) && bead.labels.includes('exercise:night-exit'));
  assert.match(bead.description, /2026-09-01/);
  assert.match(bead.description, /Adam/);
  assert.match(bead.description, /nothing changed/, 'because "we learned nothing" is a finding of its own');
  const own = exerciseBead({ scenario: 'The tailnet certificate expires mid-incident.' });
  assert.match(own.description, /tailnet certificate/);
  assert.deepEqual(own.labels.filter((l) => l.startsWith('exercise:')), [], 'and an ad-hoc one mints no id');
  assert.throws(() => exerciseBead({}), /no scenario/);
});

/* ---------------------------------------------------------------- the evidence */

await check('the period is bounded by detection, so a slow fix cannot move a bad week out of it', () => {
  const rows = [
    incident({ id: 'old', created_at: at(-100000), closed_at: at(10) }),
    incident({ id: 'in', created_at: at(10), started_at: at(20), closed_at: at(40) }),
  ];
  const reg = register(rows, { now: T0 + 100 * MIN });
  const ev = periodEvidence(reg, { from: T0 });
  assert.equal(ev.total, 1, 'the old one is out of the window even though it closed inside it');
  assert.equal(ev.acknowledgement.met, 1);
  assert.equal(ev.resolution.met, 1);
});

await check('pending is counted apart from met and missed', () => {
  const reg = register(
    [
      incident({ id: 'a', status: 'open', closed_at: null, created_at: at(0) }),
      incident({ id: 'b', started_at: at(5), closed_at: at(10), created_at: at(0) }),
      incident({ id: 'c', started_at: at(500), closed_at: at(9000), created_at: at(0) }),
    ],
    { now: T0 + 5 * MIN }
  );
  const ev = periodEvidence(reg, {});
  assert.equal(ev.total, 3);
  assert.equal(ev.acknowledgement.met, 1);
  assert.equal(ev.acknowledgement.missed, 1);
  assert.equal(ev.acknowledgement.pending, 1, 'the one still inside its window is neither');
  assert.equal(ev.open, 1);
});

await check('the communication step says who, and by when, and sends nothing', () => {
  const c = communicationFor('sev1');
  assert.equal(c.withinMinutes, 15);
  assert.match(c.who, /Adam/);
  const note = commitmentNote('sev1');
  assert.match(note, /Acknowledge by/);
  assert.match(note, /claiming this bead is the acknowledgement/, 'the bead says how the clock is read');
});

/* ------------------------------------------------- and the whole way through intake */

await check('a report through the real intake lands a bead carrying its severity', async () => {
  const created = [];
  const bd = {
    async json() {
      return [];
    },
    async create(ws, issue) {
      created.push(issue);
      return 'bc-new1';
    },
    async comment() {},
    async addLabel() {},
    async removeLabel() {},
  };
  const out = await intake(bd, { name: 'w' }, { message: 'the daemon fell over', kind: 'uncaughtException' });
  assert.equal(out.action, 'created');
  assert.equal(out.severity, 'sev1');
  const issue = created[0];
  assert.ok(issue.labels.includes('incident') && issue.labels.includes('sev1'), issue.labels.join(', '));
  assert.match(issue.body, /Severity sev1/, 'and the commitment is on the bead, in words, at the time');
  assert.match(issue.body, /15 min/);
});

await check('the repeat that crosses the threshold escalates the bead, and only then writes', async () => {
  const calls = [];
  const bead = { id: 'bc-old', status: 'open', labels: ['app-error', 'incident', 'sev3'], comment_count: 20 };
  const bd = {
    async json() {
      return [bead];
    },
    async create() {
      throw new Error('should not file a second bead');
    },
    async comment() {
      calls.push('comment');
    },
    async addLabel(ws, id, label) {
      calls.push(`add ${label}`);
    },
    async removeLabel(ws, id, label) {
      calls.push(`remove ${label}`);
    },
  };
  const fp = fingerprint({ message: 'it threw again', kind: 'error' });
  bead.labels.push(fp.atLabel || fp.msgLabel);
  const out = await intake(bd, { name: 'w' }, { message: 'it threw again', kind: 'error' });
  assert.equal(out.action, 'commented');
  assert.equal(out.severity, 'sev2', '21 occurrences of a sev3 is not a sev3');
  assert.ok(calls.includes('add sev2') && calls.includes('remove sev3'), calls.join(', '));

  // And the one that does not cross it writes no labels at all — this is the hot path,
  // and a label write per occurrence is the cost the coalescing window exists to avoid.
  calls.length = 0;
  bead.comment_count = 1;
  bead.labels = bead.labels.filter((l) => l !== 'sev2').concat('sev3');
  const quiet = { message: 'a different throw', kind: 'error' };
  const fp2 = fingerprint(quiet);
  bead.labels.push(fp2.msgLabel);
  const again = await intake(bd, { name: 'w' }, quiet);
  assert.equal(again.action, 'commented');
  assert.deepEqual(calls, ['comment'], `expected only the comment, got ${calls.join(', ')}`);
});

await check('one bug seen from two reporters takes the worse of the two, and never the milder', async () => {
  const calls = [];
  const bead = { id: 'bc-old2', status: 'open', labels: ['app-error', 'incident', 'sev4'], comment_count: 0 };
  const bd = {
    async json() {
      return [bead];
    },
    async create() {
      throw new Error('should not file a second bead');
    },
    async comment() {},
    async addLabel(ws, id, label) {
      calls.push(`add ${label}`);
    },
    async removeLabel(ws, id, label) {
      calls.push(`remove ${label}`);
    },
  };
  // Filed off a toast on Monday; the same fingerprint arrives from the crash handler on
  // Tuesday. It is one bug, and the second report is the one that says what it costs.
  const loud = { message: 'the same underlying fault', kind: 'uncaughtException' };
  bead.labels.push(fingerprint(loud).msgLabel);
  const out = await intake(bd, { name: 'w' }, loud);
  assert.equal(out.severity, 'sev1');
  assert.ok(calls.includes('add sev1') && calls.includes('remove sev4'), calls.join(', '));

  // And the other way round changes nothing: a bead does not become less serious because
  // the next report of it came from somewhere quieter.
  // A distinct message, so this is a fresh comment rather than one folded into the window
  // the call above opened — the window is the subject of another check, not this one.
  calls.length = 0;
  bead.labels = bead.labels.filter((l) => l !== 'sev4').concat('sev1');
  const meek = { message: 'the same fault, noticed somewhere quieter', kind: 'toast' };
  bead.labels.push(fingerprint(meek).msgLabel);
  const back = await intake(bd, { name: 'w' }, meek);
  assert.equal(back.severity, 'sev1');
  assert.deepEqual(calls, [], `expected no label writes, got ${calls.join(', ')}`);
});

await check('labelsFor with no severity is exactly what it always was', () => {
  const fp = fingerprint({ message: 'x', source: 'app.js', line: 3 });
  assert.deepEqual(labelsFor(fp), ['app-error', fp.atLabel, fp.msgLabel]);
  assert.deepEqual(labelsFor(fp, severityOf({ kind: 'toast' })), ['app-error', fp.atLabel, fp.msgLabel, 'incident', 'sev4']);
  assert.ok(!describe({ message: 'x' }, fp).includes('Severity'), 'and an undescribed severity writes no commitment');
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
