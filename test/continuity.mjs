#!/usr/bin/env node
//
// Offline is ordinary, and an unpublished period is not a clean one —
// `lib/continuity.js` and the fail-open half of `lib/publication.js`.
//
//   npm test                        (runs it alongside the other suites)
//   node test/continuity.mjs        (on its own)
//
// bc-3muu.4. Two rules that point in opposite directions, and the suite is built so that
// neither can be satisfied by quietly weakening the other:
//
//  1. **Fail open for work.** A daemon with no route to the service keeps recording. The
//     chain grows, every local check still passes, and every way a transport can fail —
//     refused, dropped mid-run, never supplied, or *accepted and then silent* — comes back
//     as an outcome rather than as a throw. The last of those is the one a `try/catch`
//     does not cover and the reason `publishQuietly` puts a deadline on the call.
//  2. **Fail closed for claims.** The outage is then an unverified interval, with its
//     duration and its reason, and reconnecting does not heal it. That is the assertion
//     the whole bead reduces to: every queued record lands, in order, with nothing lost —
//     and the eight hours in which nobody was watching stay eight hours in which nobody
//     was watching, because the receipts that arrived at 18:00 are stamped 18:00.
//
// The pure half runs against fixtures. The integration half runs a real chain against a
// throwaway `BEADCAUSE_CONFIG_DIR` and an in-process ledger; nothing here goes near a
// network, and nothing touches the real ~/.config/beadcause.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-continuity-'));
process.env.BEADCAUSE_CONFIG_DIR = tmp;

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const { TOLERANCE_MS, claimProblems, continuity, duration } = await import('../lib/continuity.js');
const { append, chain, localHead, publishQuietly, verifyChain } = await import('../lib/publication.js');
const { EMPTY_LEDGER, compare, ledgerHead, ledgerProblems, witness } = await import('../lib/witness.js');
const { recordDigest } = await import('../lib/publishable.js');
const { blankComments } = await import('../lib/evidence.js');

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

const INSTANCE = 'inst-0a1b2c3d4e5f';
const SHA = (n) => String(n).padStart(40, 'a');
const CHAIN_HEAD = (n) => ({ ref: 'refs/beadcause/sessions/bc-3muu.4', head: SHA(n), length: n + 1, linear: true, intact: true });

/** `T(14, 30)` — an instant on the one day this suite happens on. */
const T = (h, m = 0, s = 0) =>
  `2026-08-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}Z`;

/** A receipt, in the shape lib/witness.js issues one. Only `received` decides coverage. */
const receipt = (seq, received) => ({ instance: INSTANCE, seq, record: recordDigest({ seq }), received });

/** A record, as far as this file is concerned: something with an `at` that explains a gap. */
const stampedAt = (seq, at) => ({ instance: INSTANCE, seq, at, kind: 'chain-head', prev: null });

/** The service, in process: a ledger, a head to ask and a deliver to send to. */
function service({ clock } = {}) {
  let held = EMPTY_LEDGER;
  let tick = 0;
  return {
    get ledger() {
      return held;
    },
    head: async () => ledgerHead(held),
    deliver: async (rec) => {
      const out = witness(held, rec, { at: clock ? clock(tick++) : T(18, 0, tick++) });
      held = out.ledger;
      return out.receipt;
    },
  };
}

console.log('continuity — work never blocks on the service, and an unpublished period cannot be claimed\n');

/* ------------------------------------------------- 1. the bracket rule, in fixtures */

await check('two witnesses inside the tolerance verify the interval between them', () => {
  const ledger = { records: [], receipts: [receipt(0, T(10)), receipt(1, T(10, 45))] };
  const report = continuity(ledger, { from: T(10), to: T(10, 45) });
  assert.equal(report.state, 'verified');
  assert.equal(report.unverifiedMs, 0);
  assert.equal(report.intervals.length, 1);
  assert.equal(report.intervals[0].verified, true);
  assert.equal(report.intervals[0].duration, '45m');
  assert.deepEqual(claimProblems(report), [], 'and a window with no gap in it may be claimed');
});

await check('two witnesses further apart than the tolerance leave the whole interval unverified', () => {
  const ledger = { records: [], receipts: [receipt(0, T(10)), receipt(1, T(16))] };
  const report = continuity(ledger, { from: T(10), to: T(16) });
  assert.equal(report.state, 'unverified');
  assert.equal(report.intervals.length, 1);
  assert.equal(report.intervals[0].verified, false);
  assert.equal(report.unverifiedMs, 6 * 60 * 60 * 1000, 'the whole gap, not the hour over the budget');
  assert.match(report.intervals[0].why, /^6h unverified/);
});

await check('nothing before the first witness is ever verified, however close it is', () => {
  const ledger = { records: [], receipts: [receipt(0, T(10)), receipt(1, T(10, 30))] };
  const report = continuity(ledger, { from: T(9, 55), to: T(10, 30) });
  assert.equal(report.intervals.length, 2);
  assert.deepEqual(
    report.intervals.map((i) => [i.verified, i.duration]),
    [
      [false, '5m'],
      [true, '30m'],
    ],
    'a report that vouched backwards would vouch for time the install did not exist in'
  );
  assert.match(report.intervals[0].why, /nothing had been witnessed before 2026-08-15T10:00:00Z/);
});

await check('the trailing edge is verified for the tolerance and not a millisecond longer', () => {
  const ledger = { records: [], receipts: [receipt(0, T(10))] };

  const inside = continuity(ledger, { from: T(10), to: T(10, 59) });
  assert.equal(inside.state, 'verified', 'the end of the window stands in for the bracket the next publication supplies');

  const outside = continuity(ledger, { from: T(10), to: T(11, 1) });
  assert.equal(outside.state, 'unverified');
  assert.match(outside.intervals[0].why, /nothing has been witnessed since 2026-08-15T10:00:00Z/);
  assert.equal(outside.intervals.length, 1, 'the whole trailing interval, not the part past the budget');
});

await check('the tolerance is an argument, and the default is the one this file publishes', () => {
  assert.equal(TOLERANCE_MS, 60 * 60 * 1000);
  const ledger = { records: [], receipts: [receipt(0, T(10)), receipt(1, T(12))] };
  assert.equal(continuity(ledger, { from: T(10), to: T(12) }).state, 'unverified');
  assert.equal(continuity(ledger, { from: T(10), to: T(12), tolerance: 3 * 60 * 60 * 1000 }).state, 'verified');
});

await check('a run of publications is one verified interval rather than one per receipt', () => {
  const receipts = [0, 1, 2, 3, 4, 5].map((n) => receipt(n, T(10, n * 10)));
  const report = continuity({ records: [], receipts }, { from: T(10), to: T(10, 50) });
  assert.equal(report.intervals.length, 1, 'adjacent verified spans merge');
  assert.equal(report.witnessed, 6);
  assert.match(report.intervals[0].why, /never more than 10m between publications/);
});

await check('an outage in the middle splits the window into three, and only the middle is a gap', () => {
  const receipts = [receipt(0, T(9)), receipt(1, T(9, 30)), receipt(2, T(16)), receipt(3, T(16, 30))];
  const report = continuity({ records: [], receipts }, { from: T(9), to: T(16, 30) });
  assert.deepEqual(
    report.intervals.map((i) => [i.verified, i.duration]),
    [
      [true, '30m'],
      [false, '6h 30m'],
      [true, '30m'],
    ]
  );
  assert.equal(report.state, 'unverified', 'one gap is enough — a window is only as good as its densest gap');
  assert.equal(Math.round(report.coverage * 100), 13);
});

/* -------------------------------------------------- 2. the reason, not just the gap */

await check('an outage says the instance kept working, and how much is queued behind it', () => {
  const records = [10, 11, 12, 13].map((h, i) => stampedAt(i, T(h)));
  const report = continuity({ records, receipts: [receipt(0, T(9)), receipt(3, T(14))] }, { from: T(9), to: T(14) });
  const gap = report.intervals.find((i) => !i.verified);
  assert.equal(gap.records, 4, 'the records stamped inside the gap are counted');
  assert.match(gap.why, /the instance kept working — 4 record\(s\) are stamped inside it and were witnessed only afterwards/);
});

await check('and a silence says so instead — nothing recorded is not the same event as nothing published', () => {
  const report = continuity({ records: [], receipts: [receipt(0, T(9)), receipt(1, T(14))] }, { from: T(9), to: T(14) });
  const gap = report.intervals.find((i) => !i.verified);
  assert.equal(gap.records, 0);
  assert.match(gap.why, /nothing was recorded here either, so the interval is silence rather than a queue/);
});

await check('records still waiting are distinguished from records witnessed late', () => {
  const records = [stampedAt(0, T(12))];
  const report = continuity({ records, receipts: [receipt(0, T(9))] }, { from: T(9), to: T(14) });
  const gap = report.intervals.find((i) => !i.verified);
  assert.match(gap.why, /1 record\(s\) are stamped inside it and are still unwitnessed/);
});

await check('a ledger nobody has told anything is wholly unverified, and says which it is', () => {
  const report = continuity(EMPTY_LEDGER, { from: T(9), to: T(17) });
  assert.equal(report.state, 'unverified');
  assert.equal(report.witnessed, 0);
  assert.equal(report.coverage, 0);
  assert.match(report.intervals[0].why, /nothing has been witnessed at all/);
  assert.equal(continuity(null, { from: T(9), to: T(17) }).state, 'unverified', 'and so is nothing at all');
  assert.equal(continuity({ receipts: 'later' }, { from: T(9), to: T(17) }).state, 'unverified');
});

await check('a receipt with no readable time buys no coverage, and is said out loud', () => {
  const readable = { records: [], receipts: [receipt(0, T(10)), receipt(1, T(11))] };
  assert.equal(continuity(readable, { from: T(10), to: T(12) }).state, 'verified', 'with both receipts the window holds');

  const ledger = { records: [], receipts: [receipt(0, T(10)), { ...receipt(1, T(11)), received: 'this morning' }] };
  const report = continuity(ledger, { from: T(10), to: T(12) });
  assert.equal(report.witnessed, 1, 'dropped rather than guessed at — the safe direction is a smaller window');
  assert.equal(report.state, 'unverified');
  assert.equal(report.problems.length, 1);
  assert.match(report.problems[0], /receipt 1 carries no readable `received`/);
  assert.ok(claimProblems(report).includes(report.problems[0]), 'and it reaches the refusal rather than only the report');
});

await check('a window is two instants and it refuses anything else', () => {
  assert.throws(() => continuity(EMPTY_LEDGER, { from: 'yesterday', to: T(10) }), /two UTC instants/);
  assert.throws(() => continuity(EMPTY_LEDGER, { from: T(10), to: T(10) }), /does not come after/);
  assert.throws(() => continuity(EMPTY_LEDGER, { from: T(11), to: T(10) }), /does not come after/);
  assert.throws(() => continuity(EMPTY_LEDGER, { from: T(9), to: T(10), tolerance: 0 }), /greater than zero/);
});

await check('a duration is two units at most and never rounds up', () => {
  assert.equal(duration(45_000), '45s');
  assert.equal(duration(6 * 3600_000 + 12 * 60_000 + 59_000), '6h 12m');
  assert.equal(duration(3 * 86400_000 + 2 * 3600_000 + 59 * 60_000), '3d 2h');
  assert.equal(duration(0), '0ms');
});

/* --------------------------------------- 3. an unpublished period cannot be claimed */

await check('a clean window may be claimed, and a window with a hole in it may not', () => {
  const clean = continuity({ records: [], receipts: [receipt(0, T(10)), receipt(1, T(10, 30))] }, { from: T(10), to: T(10, 30) });
  assert.deepEqual(claimProblems(clean), []);

  const holed = continuity({ records: [], receipts: [receipt(0, T(10)), receipt(1, T(16))] }, { from: T(10), to: T(16) });
  const problems = claimProblems(holed);
  assert.equal(problems.length, 2, 'the refusal, and then the interval it is about');
  assert.match(problems[0], /1 unverified interval\(s\) totalling 6h of a 6h window/);
  assert.match(problems[0], /absence of evidence rather than evidence that nothing happened/);
  assert.match(problems[0], /unverified rather than compliant/);
  assert.match(problems[1], /^2026-08-15T10:00:00Z to 2026-08-15T16:00:00Z: /);
});

await check('an unread window is not a clean one', () => {
  assert.match(claimProblems(null)[0], /no continuity report to claim over/);
  assert.match(claimProblems({ intervals: 'none' })[0], /no continuity report to claim over/);
  assert.equal(claimProblems({ intervals: [], unverifiedMs: 0, duration: '0ms' }).length, 0);
});

await check('99% covered is still refused, because a window is only as good as its densest gap', () => {
  const receipts = [receipt(0, T(0)), receipt(1, T(12)), receipt(2, T(12, 30))];
  const report = continuity({ records: [], receipts }, { from: T(12), to: T(12, 30) });
  assert.equal(report.state, 'verified', 'the window asked about is clean');
  const wider = continuity({ records: [], receipts }, { from: T(0), to: T(12, 30) });
  assert.equal(wider.state, 'unverified', 'and the window containing the gap is not, at any coverage');
  assert.ok(claimProblems(wider).length);
});

/* ---------------------------- 4. fail open: local function with the service unreachable */

await check('the chain grows with no service in sight, and every local check still passes', async () => {
  await append('enrolment', { fingerprint: recordDigest({ key: 'public' }), org: 'climative' }, { instance: INSTANCE, at: T(10) });
  for (const h of [11, 12, 13]) await append('chain-head', CHAIN_HEAD(h), { at: T(h) });

  const records = await chain();
  assert.equal(records.length, 4, 'four records, and nothing was asked of a network to write them');
  const v = await verifyChain();
  assert.equal(v.sound, true, 'linear, intact, linked, one commit per record');
  assert.equal((await localHead()).seq, 3);
});

await check('every way a transport can fail comes back as an outcome rather than a throw', async () => {
  const refused = await publishQuietly({
    head: async () => {
      throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' });
    },
    deliver: async () => assert.fail('nothing is sent to a service that could not be asked'),
  });
  assert.equal(refused.verdict, 'offline');
  assert.equal(refused.divergent, false, 'offline is ordinary and is not a finding');
  assert.equal(refused.pending, 4, 'and the queue is still there, on disk, for the next attempt');

  const none = await publishQuietly();
  assert.equal(none.verdict, 'offline');
  assert.match(none.why, /no transport was given/);

  const midRun = await publishQuietly({
    head: async () => null,
    deliver: async () => {
      throw new Error('socket hang up');
    },
  });
  assert.equal(midRun.verdict, 'offline');
  assert.equal(midRun.sent, 0);
  assert.equal(midRun.pending, 4, 'nothing is claimed for what did not go');
});

await check('a service that accepts the connection and then says nothing is offline too', async () => {
  // The one a try/catch does not cover, and the reason `publishQuietly` exists rather than
  // being a `try` at each call site: a socket that hangs blocks the day as completely as a
  // crash, and more quietly.
  const started = Date.now();
  const out = await publishQuietly({
    head: () => new Promise(() => {}),
    deliver: async () => assert.fail('nothing is sent'),
    deadlineMs: 25,
  });
  assert.equal(out.verdict, 'offline');
  assert.match(out.why, /the service did not answer within 25ms/);
  assert.ok(Date.now() - started < 5000, 'and it came back rather than waiting on the socket');

  const stalled = await publishQuietly({
    head: async () => null,
    deliver: () => new Promise(() => {}),
    deadlineMs: 25,
  });
  assert.equal(stalled.verdict, 'offline');
  assert.equal(stalled.sent, 0);
  assert.equal(stalled.pending, 4);
});

await check('and work carries straight on: the chain keeps growing across the outage', async () => {
  for (const h of [14, 15, 16]) await append('chain-head', CHAIN_HEAD(h), { at: T(h) });
  const records = await chain();
  assert.equal(records.length, 7);
  assert.deepEqual(records.map((r) => r.seq), [0, 1, 2, 3, 4, 5, 6]);
  assert.equal((await verifyChain()).sound, true, 'eight hours with no service, and nothing local is any the worse');
});

/* ------------------------------------ 5. reconnect republishes without loss — and the gap stays */

await check('reconnecting sends the whole queue, in order, with nothing lost', async () => {
  const svc = service({ clock: (n) => T(18, 0, n) });
  const out = await publishQuietly(svc);
  assert.equal(out.verdict, 'published');
  assert.equal(out.sent, 7, 'every record that was queued behind the outage');
  assert.equal(out.pending, 0);
  assert.deepEqual(out.receipts.map((r) => r.seq), [0, 1, 2, 3, 4, 5, 6], 'and in the order they were recorded');
  assert.deepEqual([...ledgerProblems(svc.ledger)], [], "the service's own copy links up");
  assert.equal(ledgerHead(svc.ledger).digest, (await localHead()).digest, 'both sides now hold the same head');
  assert.equal(compare(await chain(), await svc.head()).verdict, 'agreed');

  const again = await publishQuietly(svc);
  assert.equal(again.verdict, 'agreed');
  assert.equal(svc.ledger.records.length, 7, 'and a second attempt does not double anything up');
});

await check('THE ONE THAT MATTERS: reconnecting does not heal the period nobody witnessed', async () => {
  const svc = service({ clock: (n) => T(18, 0, n) });
  await publishQuietly(svc);
  const report = continuity(svc.ledger, { from: T(10), to: T(18, 30) });

  assert.equal(report.state, 'unverified', 'every record landed, and the window is still not claimable');
  assert.equal(report.records, 7, 'the service holds all seven');
  const gap = report.intervals.find((i) => !i.verified);
  assert.equal(gap.duration, '8h', 'the receipts are stamped when they arrived, not when the records claim to be from');
  assert.equal(gap.records, 7, 'and all seven were stamped inside it');
  assert.match(gap.why, /were witnessed only afterwards/);
  assert.ok(claimProblems(report).length, 'so the window is refused');

  const after = continuity(svc.ledger, { from: T(18), to: T(18, 30) });
  assert.equal(after.state, 'verified', 'while the period since the reconnect is fine, which is the point of both halves');
});

await check('a record stamped hours before it was witnessed buys back none of those hours', () => {
  // The arithmetic, in isolation, because it is the one thing a future change could quietly
  // reverse by reading `at` instead of `received` and every other check would still pass.
  const records = [stampedAt(0, T(2)), stampedAt(1, T(3))];
  const receipts = [receipt(0, T(12)), receipt(1, T(12, 0, 1))];
  const report = continuity({ records, receipts }, { from: T(2), to: T(12, 30) });
  assert.equal(report.state, 'unverified');
  assert.equal(report.intervals[0].verified, false);
  assert.equal(report.intervals[0].from, '2026-08-15T02:00:00Z');
  assert.equal(report.intervals[0].to, '2026-08-15T12:00:00Z', 'ten hours nobody was watching, whatever the records say');
});

/* --------------------------------------------------- 6. the far end can be the far end */

await check('lib/continuity.js is a leaf, so the report can be asked for at either end', () => {
  const src = blankComments(fs.readFileSync(path.join(ROOT, 'lib/continuity.js'), 'utf8'));
  const imports = [...src.matchAll(/import\s+([^;]*?)\s+from\s+'([^']+)'/g)].map((m) => m[2]);
  assert.deepEqual(imports, ['./publishable.js'], 'no config directory, no git, and no clock it was not handed');
  assert.ok(!/new Date\(\)/.test(src), 'a report that read the clock could not be run twice with the same answer');
});

await check('the service can report on its own ledger, with no local chain in the room', async () => {
  // The far end holds `{records, receipts}` and nothing else — no repository, no config
  // directory, no second copy of the chain — and that is the whole input `continuity` takes.
  let held = EMPTY_LEDGER;
  for (const rec of await chain()) held = witness(held, rec, { at: T(10, held.records.length * 8) }).ledger;

  const report = continuity(held, { from: T(10), to: T(11, 30) });
  assert.equal(report.witnessed, 7);
  assert.equal(report.records, 7);
  assert.equal(report.state, 'verified', 'witnessed every eight minutes, so the window holds');
  assert.deepEqual(claimProblems(report), []);
});

await cleanupTmp(tmp);

console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);
