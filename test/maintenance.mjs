#!/usr/bin/env node
/**
 * The nightly maintenance window — when it fires, what it does, and when it gives up.
 *
 *     npm test
 *     node test/maintenance.mjs
 *
 * Everything here runs on a fake clock, and it has to: the transitions this file exists
 * to pin are "forty-five minutes later" and "the next night", and a suite that waited for
 * either would be the slowest file in the repo by three orders of magnitude. `decide` is
 * pure for exactly that reason — a clock, the options, and how many windows are open.
 *
 * Three properties are the point, and they are the three that would cost something real
 * if they broke:
 *
 * 1. **It runs once a night.** A daemon restarted every few minutes must not re-ask, and
 *    must not re-collect. This is the failure a `launchctl kickstart` would find, and it
 *    is why `night` and `phase` are persisted at all.
 * 2. **It always ends.** A window that never resumes dispatching is a fleet that does
 *    nothing until somebody notices, and the thing most likely to cause it is a session
 *    that will not take a signal. So the ceiling is checked against a Mac that never
 *    empties.
 * 3. **The collection always happens.** Not "if the drain worked" — the collection is the
 *    entire point of the night, and it is safe under load, so a night that could not empty
 *    the Mac must still collect. That is the reserve.
 *
 * The one shape worth naming before you read the checks: a window configured across
 * midnight. `windowStart` looks backwards rather than forwards precisely so that "which
 * night is this" has an answer at 00:30, and getting it wrong would run the window twice
 * — once before midnight and once after — which no amount of `night` bookkeeping downstream
 * could fix.
 */
import assert from 'node:assert/strict';

const m = await import('../lib/maintenance.js');
const reap = await import('../lib/reap.js');

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/** A local-time Date on a fixed, boring day. Local on purpose — the window is wall clock. */
const at = (h, min, day = 17) => new Date(2026, 7, day, h, min, 0, 0);

const ON = { ...m.MAINTENANCE_DEFAULTS, maintenance: true, maintenanceAt: '03:00' };

/** Run the machine forward over a list of `[time, live]` steps, collecting every verdict. */
const runOver = (o, steps, start = { phase: 'idle', night: null }) => {
  let prev = start;
  const seen = [];
  for (const [now, live] of steps) {
    const v = m.decide(prev, { o, now, live });
    seen.push(v);
    prev = { phase: v.phase, night: v.night };
  }
  return seen;
};

/* ------------------------------------------------------------- reading the clock */

console.log('\nwhich night is it\n');

await check(() => assert.equal(m.minutesOfDay('03:00'), 180), '"03:00" is 180 minutes into the day');
await check(() => assert.equal(m.minutesOfDay('3:5'), null), 'a malformed time is null rather than a guess');
await check(() => assert.equal(m.minutesOfDay('24:00'), null), 'and so is an hour that does not exist');

await check(
  () => assert.equal(m.windowStart('03:00', at(3, 40)).getHours(), 3),
  'at 03:40 the window that started at 03:00 is this morning’s'
);
await check(
  () => assert.equal(m.nightOf(m.windowStart('03:00', at(2, 0))), '2026-08-16'),
  'at 02:00 the most recent 03:00 was yesterday — so it is still last night'
);
await check(() => assert.equal(m.windowStart('nope', at(3, 40)), null), 'an unparseable time has no window at all');

// The midnight-crossing case, which is the one a forwards-looking implementation gets wrong.
await check(() => {
  const before = m.nightOf(m.windowStart('23:30', at(23, 45)));
  const after = m.nightOf(m.windowStart('23:30', new Date(2026, 7, 18, 0, 30)));
  assert.equal(before, '2026-08-17');
  assert.equal(after, '2026-08-17', 'half an hour past midnight is still the same night’s window');
}, 'a window at 23:30 is one night either side of midnight, not two');

/* ------------------------------------------------------------------ the sequence */

console.log('\nthe sequence, on a Mac with work on it\n');

await check(() => {
  const v = m.decide({}, { o: { ...ON, maintenance: false }, now: at(3, 5), live: 4 });
  assert.equal(v.phase, 'off');
  assert.equal(v.act, 'none');
}, 'switched off, it never fires — whatever the clock says');

await check(() => {
  const v = m.decide({}, { o: ON, now: at(2, 59), live: 4 });
  assert.equal(v.phase, 'idle');
  assert.equal(v.act, 'none');
}, 'a minute before the hour, nothing is held');

await check(() => {
  const v = m.decide({}, { o: ON, now: at(3, 1), live: 4 });
  assert.equal(v.phase, 'draining');
  assert.equal(v.act, 'ask');
  assert.equal(m.holdsDispatch(v), true);
}, 'a minute after it, every window is asked to wrap up and dispatch is held');

await check(() => {
  const v = m.decide({ phase: 'draining', night: '2026-08-17' }, { o: ON, now: at(3, 10), live: 4 });
  assert.equal(v.act, 'none');
}, 'and asked exactly once — the next nine ticks ask nothing');

await check(() => {
  const v = m.decide({ phase: 'draining', night: '2026-08-17' }, { o: ON, now: at(3, 20), live: 0 });
  assert.equal(v.phase, 'collecting');
  assert.equal(v.act, 'collect');
}, 'when the last window ends, it collects without waiting out the drain');

await check(() => {
  const v = m.decide({ phase: 'draining', night: '2026-08-17' }, { o: ON, now: at(3, 46), live: 2 });
  assert.equal(v.phase, 'closing');
  assert.equal(v.act, 'force');
  assert.equal(m.holdsDispatch(v), true);
}, 'past the 45-minute drain, the two that are left are closed');

await check(() => {
  const v = m.decide({ phase: 'closing', night: '2026-08-17' }, { o: ON, now: at(3, 50), live: 0 });
  assert.equal(v.act, 'collect');
}, 'and once they are gone, it collects');

await check(() => {
  const v = m.decide({ phase: 'collecting', night: '2026-08-17' }, { o: ON, now: at(3, 51), live: 0 });
  assert.equal(v.act, 'none');
}, 'a collection already running is never started twice');

await check(() => {
  const v = m.decide({}, { o: ON, now: at(3, 0), live: 0 });
  assert.equal(v.act, 'collect');
  assert.match(v.why, /nothing was running/);
}, 'on a quiet night there is nothing to drain and it collects at the hour');

/* ------------------------------------------------------------------- once a night */

console.log('\nonce a night, and not once a tick\n');

await check(() => {
  const v = m.decide({ phase: 'done', night: '2026-08-17' }, { o: ON, now: at(3, 30), live: 0 });
  assert.equal(v.phase, 'idle');
  assert.equal(v.act, 'none');
  assert.equal(m.holdsDispatch(v), false);
}, 'after tonight’s collection the window is over and dispatching is free');

await check(() => {
  const v = m.decide({ phase: 'done', night: '2026-08-17' }, { o: ON, now: at(3, 5, 18), live: 0 });
  assert.equal(v.act, 'collect');
  assert.equal(v.night, '2026-08-18');
}, 'and tomorrow it fires again, under tomorrow’s date');

await check(() => {
  // The kickstart case: a daemon reborn mid-drain must not re-ask.
  const acts = runOver(ON, [
    [at(3, 1), 3],
    [at(3, 2), 3],
    [at(3, 3), 3],
  ]).map((v) => v.act);
  assert.deepEqual(acts, ['ask', 'none', 'none']);
}, 'a restart inside the drain resumes it rather than asking every window a second time');

await check(() => {
  // A persisted `collecting` from a daemon that died mid-gc.
  const v = m.decide({ phase: 'collecting', night: '2026-08-17' }, { o: ON, now: at(3, 30), live: 0 });
  assert.equal(v.act, 'none');
  assert.equal(m.holdsDispatch(v), true);
}, 'a daemon that died mid-collection does not start a second one on the way back up');

/* --------------------------------------------------------------- it always ends */

console.log('\nit always ends, and it always collects\n');

await check(() => {
  const v = m.decide({ phase: 'closing', night: '2026-08-17' }, { o: ON, now: at(5, 1), live: 2 });
  assert.equal(v.phase, 'done');
  assert.equal(v.act, 'resume');
  assert.equal(m.holdsDispatch(v), false);
  assert.match(v.why, /2 window\(s\) still open/);
}, 'two hours in with windows that would not die, dispatching resumes anyway — and says so');

await check(() => {
  const v = m.decide({ phase: 'collecting', night: '2026-08-17' }, { o: ON, now: at(5, 1), live: 0 });
  assert.equal(v.act, 'resume');
  assert.match(v.why, /still running/);
}, 'and a collection that never returned does not hold the fleet past the bound either');

await check(() => {
  // The reserve: five minutes before the ceiling it stops waiting and collects.
  const v = m.decide({ phase: 'closing', night: '2026-08-17' }, { o: ON, now: at(4, 56), live: 2 });
  assert.equal(v.phase, 'collecting');
  assert.equal(v.act, 'collect');
  assert.match(v.why, /would not close/);
}, 'a Mac that never empties still gets collected, inside the window, over the top of it');

await check(() => {
  const o = { ...ON, maintenanceForceClose: false };
  const forced = m.decide({ phase: 'draining', night: '2026-08-17' }, { o, now: at(3, 46), live: 2 });
  assert.equal(forced.act, 'none', 'nothing is closed');
  const later = m.decide({ phase: 'draining', night: '2026-08-17' }, { o, now: at(4, 56), live: 2 });
  assert.equal(later.act, 'collect', 'but the collection still happens at the reserve');
}, 'with forcing switched off it never signals a window, and still collects');

await check(() => {
  const o = { ...ON, maintenanceDrainMinutes: 600, maintenanceMaxMinutes: 60 };
  const v = m.decide({ phase: 'draining', night: '2026-08-17' }, { o, now: at(3, 56), live: 1 });
  assert.equal(v.act, 'collect');
}, 'a drain longer than the window is clamped to it rather than eating the collection');

await check(() => {
  const v = m.decide({}, { o: { ...ON, maintenanceAt: 'half three' }, now: at(3, 5), live: 2 });
  assert.equal(v.phase, 'off');
  assert.match(v.why, /not an HH:MM/);
}, 'a typo in the time switches the window off and names itself, rather than firing at midnight');

/* ----------------------------------------------------------- what the reaper does */

console.log('\nwhat force does to the reaper, and what it must not do\n');

const session = (over = {}) => ({ sessionId: 's1', name: 'bc-1 something', status: 'idle', pid: 42, ...over });
const entry = { id: 'bc-1', pid: 42, sessionId: 's1', at: new Date().toISOString() };

await check(() => {
  const d = reap.decide(entry, session({ status: 'busy' }), {});
  assert.equal(d.act, 'wait');
  assert.equal(d.why, 'busy');
}, 'ordinarily a busy window waits, however long it has been on the list');

await check(() => {
  const d = reap.decide(entry, session({ status: 'busy' }), { force: true });
  assert.equal(d.act, 'term');
  assert.match(d.why, /mid-turn/);
}, 'under force it is signalled, and the line records that it was mid-turn');

await check(() => {
  const d = reap.decide(entry, session(), { closeGraceSeconds: 600 });
  assert.equal(d.act, 'wait');
  assert.equal(d.why, 'in grace');
}, 'ordinarily a freshly-listed idle window waits out its grace period');

await check(() => {
  const d = reap.decide(entry, session(), { closeGraceSeconds: 600, force: true });
  assert.equal(d.act, 'term');
}, 'under force it does not');

// The guard that force may never waive. This is the one with no undo.
await check(() => {
  const d = reap.decide(entry, session({ sessionId: 'somebody-else' }), { force: true });
  assert.equal(d.act, 'drop');
  assert.match(d.why, /no longer the bc-1 session/);
}, 'but a recycled pid is still dropped under force — never signalled');

await check(() => {
  const d = reap.decide(entry, null, { force: true });
  assert.equal(d.act, 'drop');
}, 'and a window that has already gone is still just dropped');

/* --------------------------------------------------------------- the collection */

console.log('\nthe collection\n');

await check(async () => {
  const asked = [];
  const bd = {
    doltRemote: async () => null,
    gc: async (ws) => {
      asked.push(ws.name);
      return 'Phase 3/3: Dolt GC\n  Dolt GC: complete: 825.3 MB → 298.7 MB (freed 526.6 MB)\n';
    },
  };
  const out = await m.collect(bd, [{ name: 'a' }, { name: 'b' }]);
  assert.deepEqual(asked, ['a', 'b']);
  assert.deepEqual(
    out.map((r) => r.ok),
    [true, true]
  );
  assert.equal(out[0].detail, 'complete: 825.3 MB → 298.7 MB (freed 526.6 MB)');
}, 'every workspace is collected, and bd’s own sentence about what it freed is what is reported');

await check(async () => {
  const bd = {
    doltRemote: async () => null,
    gc: async (ws) => {
      if (ws.name === 'a') throw new Error('store is locked\nand a second line nobody needs');
      return 'Dolt GC: complete: nothing to do';
    },
  };
  const out = await m.collect(bd, [{ name: 'a' }, { name: 'b' }]);
  assert.equal(out[0].ok, false);
  assert.equal(out[0].detail, 'store is locked');
  assert.equal(out[1].ok, true, 'one workspace failing does not stop the next');
}, 'one workspace’s failure costs its own line and nothing else');

await check(() => {
  assert.equal(m.freedFrom('nothing recognisable here'), 'collected');
}, 'a gc that phrased itself differently still reads as a gc that worked');

/* ------------------------------------------------- the shared tracker is left alone */

console.log('\nthe tracker that belongs to other people\n');

/** `bd` for a fleet where one workspace is shared and the rest are this Mac's own. */
const withRemotes = (remotes, gcLog) => ({
  doltRemote: async (ws) => remotes[ws.name] ?? null,
  gc: async (ws) => {
    gcLog.push(ws.name);
    return 'Dolt GC: complete: nothing to do';
  },
});

await check(async () => {
  const done = [];
  const bd = withRemotes({ architecture: { name: 'origin', url: 'git@github.com:Climative/architecture' } }, done);
  const out = await m.collect(bd, [{ name: 'beadcause' }, { name: 'architecture' }, { name: 'sophab' }]);
  assert.deepEqual(done, ['beadcause', 'sophab'], 'the shared one was never collected');
  const skipped = out.find((r) => r.workspace === 'architecture');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.ok, true, 'a deliberate skip is not a failure');
  assert.match(skipped.detail, /shared with origin/);
  assert.match(skipped.detail, /maintenanceCollectShared/, 'and it names the switch that would include it');
}, 'a workspace with a Dolt remote is skipped by default, and says so rather than silently');

await check(async () => {
  const done = [];
  const bd = withRemotes({ architecture: { name: 'origin', url: null } }, done);
  await m.collect(bd, [{ name: 'architecture' }], { shared: true });
  assert.deepEqual(done, ['architecture']);
}, 'and is collected when somebody has explicitly said to');

await check(async () => {
  const done = [];
  const bd = {
    doltRemote: async () => {
      throw new Error('bd exploded');
    },
    gc: async (ws) => {
      done.push(ws.name);
      return '';
    },
  };
  const out = await m.collect(bd, [{ name: 'mystery' }]);
  assert.deepEqual(done, [], 'a workspace we could not ask about is left alone');
  assert.equal(out[0].skipped, true);
  assert.match(out[0].detail, /could not tell whether it is shared/);
}, 'and a workspace whose remote cannot be listed is skipped, not collected on an assumption');

/* ------------------------------------------------------- what it will not accept */

console.log('\nthe two things it will never do\n');

await check(async () => {
  const args = [];
  const bd = {
    doltRemote: async () => null,
    gc: async (ws, opts) => {
      args.push({ ws: ws.name, opts });
      return '';
    },
  };
  await m.collect(bd, [{ name: 'a' }]);
  // The flags themselves are Bd.gc's, so what is pinned here is that `collect` has no
  // way to ask for anything else: no phase argument reaches it and none is invented.
  assert.deepEqual(Object.keys(args[0].opts), ['timeout']);
}, 'collect can pass nothing to bd but a timeout — there is no route to the decay phase');

await check(() => {
  const src = m.collect.toString();
  assert.ok(!/decay/i.test(src) || /skip-decay/i.test(src), 'no decay flag is constructed here');
  assert.ok(!/flatten/i.test(src), 'and bd flatten is never reached for');
}, 'and neither decay nor flatten appears anywhere in the path that runs');

/* ---------------------------------------------------------------------- verdict */

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
