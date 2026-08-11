/**
 * `quietUntil` — when a space stops being quiet, and why the answer is a wall clock.
 *
 * This is the number the phone and the monitor both print ("🔇 quiet until Mon 09:00"),
 * and it was written with a throwaway script and never checked in. It is worth a suite
 * because every input to it is a *local* time and every one of them has a trap:
 *
 * - a quiet-hours window normally crosses midnight (18:00 → 09:00), so the arithmetic
 *   that works for 09:00 → 17:00 is the arithmetic that gets the common case wrong;
 * - `quietDays` flips at midnight, `quietHours` at its own boundary, and the two
 *   interact — quiet until 09:00 on a Monday that follows a quiet Sunday;
 * - the window can span a DST change, and `quietUntil` promises the wall clock time it
 *   was configured with rather than a fixed number of milliseconds later. That promise
 *   is only testable inside a zone that has a DST change, which is why the suite
 *   re-runs itself in four of them.
 *
 * Two kinds of assertion, and the second is the one that would catch a rewrite:
 *
 * 1. the exact wall clock the answer should be, written out by hand;
 * 2. the *properties* that make an answer correct at all, checked minute by minute:
 *    the moment returned is not quiet, and every minute between now and it is. That
 *    scan is independent of how `quietUntil` finds its candidates, so it holds an
 *    implementation that abandoned the boundary trick to exactly the same standard.
 *
 * Nothing here touches the network, the config directory or the clock.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isQuiet, quietUntil } from '../lib/spaces.js';

const SELF = fileURLToPath(import.meta.url);

/* ------------------------------------------------------------------- helpers */

const pad = (n) => String(n).padStart(2, '0');

/** A local-time moment, written the way a person says it. Months are 1-based here. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

/** A Date as its local wall clock, which is the only thing this module promises. */
const wall = (d) =>
  d === null ? null : `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

let checks = 0;

/**
 * The properties that make any answer correct, whatever produced it.
 *
 * Minute-by-minute rather than at the boundaries, because the boundaries are what the
 * implementation already looks at: a scan can catch a candidate list that missed a
 * transition, and comparing boundaries to boundaries cannot.
 */
function invariants(space, now, until, label) {
  assert.ok(until > now, `${label}: ${wall(until)} is not after ${wall(now)}`);
  assert.ok(!isQuiet(space, until), `${label}: ${wall(until)} is still quiet, so it is not when quiet ends`);
  for (let t = now.getTime() + 60_000; t < until.getTime(); t += 60_000) {
    const m = new Date(t);
    assert.ok(isQuiet(space, m), `${label}: quiet ends at ${wall(m)}, before the ${wall(until)} that was returned`);
  }
}

/** `expected` is a wall clock string, or null for "there is no such moment". */
function expect(label, space, now, expected) {
  assert.ok(space.muted || !expected || isQuiet(space, now), `${label}: the fixture is not quiet at ${wall(now)}`);
  const until = quietUntil(space, now);
  assert.equal(wall(until), expected, `${label}: quietUntil at ${wall(now)}`);
  if (until) invariants(space, now, until, label);
  checks += 1;
}

/* ------------------------------------------------------------------ fixtures */

// 2026-03-07 is a Saturday, so the dates below land on known weekdays:
//   Sat 2026-03-07 · Sun 2026-03-08 · Mon 2026-03-09 · Tue 2026-03-10 · Wed 2026-03-11
// 2026-03-08 is also the North American spring-forward, and 2026-11-01 the fall-back.
const EVENINGS = { name: 'Evenings', quietHours: { from: '18:00', to: '09:00' } };
const WORKDAY = { name: 'Workday', quietHours: { from: '09:00', to: '17:00' } };
const WEEKEND = { name: 'Weekend', quietDays: ['sat', 'sun'] };
const BOTH = { name: 'Both', quietDays: ['sun'], quietHours: { from: '18:00', to: '09:00' } };

function run() {
  /* ------------------------------------------------- nothing to wait out */

  expect('no space at all', {}, at(2026, 3, 10, 22, 0), null);
  assert.equal(quietUntil(null, at(2026, 3, 10, 22, 0)), null, 'null space');
  assert.equal(quietUntil(undefined, at(2026, 3, 10, 22, 0)), null, 'undefined space');

  // Not quiet: there is nothing to be until.
  expect('outside the window', EVENINGS, at(2026, 3, 10, 12, 0), null);
  expect('a weekday, for a weekend space', WEEKEND, at(2026, 3, 10, 12, 0), null);
  expect('a space with no rules', { name: 'Always on' }, at(2026, 3, 10, 22, 0), null);

  // Muted has no end, and says so — `isQuiet` is true throughout. A number here would
  // be a promise the phone would keep and the mute would not.
  expect('muted', { name: 'Muted', muted: true }, at(2026, 3, 10, 22, 0), null);
  expect(
    'muted, inside quiet hours too',
    { name: 'Muted', muted: true, quietHours: { from: '18:00', to: '09:00' } },
    at(2026, 3, 10, 22, 0),
    null
  );

  /* --------------------------------------------------------- quiet hours */

  // The window that crosses midnight, from either side of it.
  expect('evening, before midnight', EVENINGS, at(2026, 3, 10, 22, 0), '2026-03-11 09:00');
  expect('the small hours', EVENINGS, at(2026, 3, 11, 3, 0), '2026-03-11 09:00');
  expect('the first minute of the window', EVENINGS, at(2026, 3, 10, 18, 0), '2026-03-11 09:00');
  expect('the last minute of the window', EVENINGS, at(2026, 3, 11, 8, 59), '2026-03-11 09:00');

  // …and the same-day window, which is the one a naive implementation gets right.
  expect('a daytime window', WORKDAY, at(2026, 3, 10, 10, 0), '2026-03-10 17:00');
  expect('a daytime window, at its start', WORKDAY, at(2026, 3, 10, 9, 0), '2026-03-10 17:00');

  // `to` is exclusive on both shapes: 09:00 and 17:00 are the first loud minute.
  assert.equal(isQuiet(EVENINGS, at(2026, 3, 11, 9, 0)), false, '09:00 is loud');
  assert.equal(isQuiet(WORKDAY, at(2026, 3, 10, 17, 0)), false, '17:00 is loud');

  /* ---------------------------------------------------------- quiet days */

  // Saturday into Sunday: the answer is Monday midnight, not tomorrow.
  expect('a quiet Saturday', WEEKEND, at(2026, 3, 7, 12, 0), '2026-03-09 00:00');
  expect('a quiet Sunday', WEEKEND, at(2026, 3, 8, 23, 30), '2026-03-09 00:00');

  // Spelled any way the config might: `bd`-style three-letter, full names, mixed case.
  expect('long day names', { name: 'L', quietDays: ['Saturday', 'SUNDAY'] }, at(2026, 3, 7, 12, 0), '2026-03-09 00:00');

  /* ------------------------------------------- the two rules interacting */

  // The case the module's own comment names: quiet all Sunday, and quiet until 09:00
  // on the Monday that follows, because Monday starts inside the evening window.
  expect('a quiet Sunday before an evening window', BOTH, at(2026, 3, 8, 12, 0), '2026-03-09 09:00');
  expect('the Saturday evening before it', BOTH, at(2026, 3, 7, 20, 0), '2026-03-09 09:00');

  // Quiet every day but one: the eight-day horizon is what makes this resolvable.
  const ONE_LOUD_DAY = { name: 'Wednesdays only', quietDays: ['sun', 'mon', 'tue', 'thu', 'fri', 'sat'] };
  expect('quiet every day except Wednesday', ONE_LOUD_DAY, at(2026, 3, 12, 12, 0), '2026-03-18 00:00');

  // Quiet every day, with nothing to wait for. Null rather than a date eight days out,
  // which would be a lie the UI would print.
  const ALWAYS = { name: 'Always', quietDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] };
  expect('quiet every day', ALWAYS, at(2026, 3, 10, 12, 0), null);
  assert.ok(isQuiet(ALWAYS, at(2026, 3, 18, 12, 0)), 'quiet every day really is quiet in eight days');

  /* ------------------------------------------------------- unparseable */

  // A typo disables the rule rather than muting the space forever — so a space whose
  // only rule is a typo is not quiet, and has no "until".
  for (const bad of ['25:00', '18:60', '6pm', '', '18.00', null]) {
    const space = { name: 'Typo', quietHours: { from: bad, to: '09:00' } };
    assert.equal(isQuiet(space, at(2026, 3, 10, 22, 0)), false, `from: ${JSON.stringify(bad)} disables the rule`);
    expect(`unparseable from: ${JSON.stringify(bad)}`, space, at(2026, 3, 10, 22, 0), null);
  }

  // But a quiet *day* still holds, and with no usable `to` the only boundary left is
  // midnight — which is exactly where a quiet day ends.
  expect(
    'a quiet day with an unparseable window',
    { name: 'Half typo', quietDays: ['tue'], quietHours: { from: 'six', to: '09:00' } },
    at(2026, 3, 10, 22, 0),
    '2026-03-11 00:00'
  );

  /* -------------------------------------------------------------- DST */

  // Both of these are ordinary days in a zone without DST and transitions in the four
  // the suite re-runs itself in. The assertion is the same either way, and that is the
  // point: the promise is a wall clock, not a duration.
  expect('across the spring forward', EVENINGS, at(2026, 3, 7, 22, 0), '2026-03-08 09:00');
  // Half an hour before midnight on the eve of a 23-hour day: anything that reached the
  // next day by adding 86,400,000 lands on the day after it and never considers the
  // Sunday at all.
  expect('late on the eve of the spring forward', EVENINGS, at(2026, 3, 7, 23, 30), '2026-03-08 09:00');
  expect('across the fall back', EVENINGS, at(2026, 10, 31, 22, 0), '2026-11-01 09:00');
  expect('a quiet day across the spring forward', WEEKEND, at(2026, 3, 7, 12, 0), '2026-03-09 00:00');
}

/* --------------------------------------------------------------------- zones */

/**
 * The zones the suite re-runs itself in.
 *
 * Halifax is where this is written and where the DST dates above are transitions. UTC
 * has no DST at all, and is the zone CI would most likely be in. Kolkata is half an
 * hour off the hour, which breaks anything that reduced a zone to a whole number.
 * Lord Howe shifts by *thirty minutes* at DST, which is the case that breaks anything
 * that assumed a transition moves the clock by an hour.
 */
const ZONES = ['America/Halifax', 'UTC', 'Asia/Kolkata', 'Australia/Lord_Howe'];

run();

if (!process.env.BEADCAUSE_TEST_TZ) {
  for (const tz of ZONES) {
    const child = spawnSync(process.execPath, [SELF], {
      env: { ...process.env, TZ: tz, BEADCAUSE_TEST_TZ: tz },
      stdio: 'inherit',
    });
    assert.equal(child.status, 0, `quietUntil failed in TZ=${tz}`);
  }
  console.log(`✓ quietUntil — ${checks} answers, in ${ZONES.length + 1} zones`);
}
