/**
 * The claim two Macs can both read, and the rule that makes exactly one of them win.
 *
 * bc-bllw. Two advocates on two machines against one Dolt tracker both pick the same
 * ready bead, because every filter in lib/advocate.js reads this process's own knowledge
 * and nothing in the shared graph says a machine is already on it. lib/sync.js is two
 * minutes wide, so claim-then-check is not a lease — it is two local writes that both
 * succeed. The design admits that and resolves the collision afterwards.
 *
 * Which puts the whole of the correctness in this file, because the tiebreak is the
 * only thing standing between "two windows" and "no windows":
 *
 *   - **both machines compute the same winner**, from the same labels, with no further
 *     communication — that is what makes "exactly one survives" a fact and not a hope;
 *   - **a claim expires**, so a Mac that sleeps mid-bead does not park the work forever;
 *   - **a machine with no handle has no opinion**, which is every single-person install
 *     and must stay byte-for-byte what it was.
 *
 *     node test/lease.mjs
 *
 * Pure: no daemon, no `bd`, no clock of its own — every case passes the `now` it wants.
 */
import assert from 'node:assert/strict';
import {
  describeLease,
  handleFor,
  isLive,
  leaseLabel,
  leaseVerdict,
  leasesOf,
  renewDue,
  stampOf,
  timeOf,
  LEASE_PREFIX,
} from '../lib/lease.js';

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

const AT = '2026-08-12T09:42:00.000Z';
const label = (handle, at) => leaseLabel(handle, at);

/* ------------------------------------------------------------------- the label */

check('a label round-trips through the stamp', () => {
  assert.equal(stampOf(AT), '20260812T094200Z');
  assert.equal(timeOf('20260812T094200Z'), '2026-08-12T09:42:00Z');
  assert.equal(label('mba', AT), 'held:20260812T094200Z:mba');
});

/**
 * The handle is routinely an email, which contains the character everything here splits
 * on. The stamp leads the label precisely so the split is the *first* colon and the rest
 * is the handle whatever is in it.
 */
check('an email handle survives the split', () => {
  const l = label('Adam@Example.com', AT);
  assert.equal(l, 'held:20260812T094200Z:adam@example.com');
  assert.deepEqual(leasesOf([l]).map((x) => x.handle), ['adam@example.com']);
});

check('no handle stakes nothing', () => {
  assert.equal(label('', AT), null);
  assert.equal(label(null, AT), null);
  assert.equal(handleFor({}), null, 'a machine that has not been told who it is');
  assert.equal(handleFor({ me: 'someone@example.com' }), 'someone@example.com');
});

/**
 * A label nobody can parse is not a machine, and treating one as a holder would be a
 * bead no advocate anywhere may open because of a typo — strictly worse than the
 * duplicate window the whole feature exists to prevent.
 */
check('a malformed claim holds nothing', () => {
  const junk = [
    `${LEASE_PREFIX}notadate:mba`,
    `${LEASE_PREFIX}20260812T094200Z`,
    `${LEASE_PREFIX}:mba`,
    `${LEASE_PREFIX}20260812T094200Z:`,
    'held-by:mba',
    'for:mba',
    '',
  ];
  assert.deepEqual(leasesOf(junk), []);
  assert.equal(leaseVerdict(junk, 'other').holder, null);
});

/* ---------------------------------------------------------------- the tiebreak */

/** The headline: two claims inside the sync window, and both machines agree who won. */
check('both machines pick the same winner', () => {
  const early = label('alpha', '2026-08-12T09:42:00Z');
  const late = label('beta', '2026-08-12T09:42:30Z');
  const now = new Date('2026-08-12T09:43:00Z');

  // The same two labels, in either order — the graph does not promise one.
  for (const labels of [[early, late], [late, early]]) {
    const onAlpha = leaseVerdict(labels, 'alpha', { now });
    const onBeta = leaseVerdict(labels, 'beta', { now });
    assert.equal(onAlpha.holder.handle, 'alpha', 'the earlier claim wins');
    assert.equal(onBeta.holder.handle, 'alpha', 'and the other machine says so too');
    assert.equal(onAlpha.lost, false, 'so alpha keeps its window');
    assert.equal(onBeta.lost, true, 'and beta stands down');
    assert.equal(onAlpha.won, true, 'alpha knows it was contested');
  }
});

/**
 * Two clocks can agree to the second, and then the stamp decides nothing. What the
 * tiebreak may never do is *tie*: one machine keeping its window while the other also
 * keeps its own is the two-window failure, and both standing down is the zero-window
 * one. So the handle breaks it, deterministically, and neither machine has to be told.
 */
check('claims at the same instant still resolve to one winner', () => {
  const labels = [label('beta', AT), label('alpha', AT)];
  const now = new Date('2026-08-12T09:43:00Z');
  assert.equal(leaseVerdict(labels, 'alpha', { now }).lost, false);
  assert.equal(leaseVerdict(labels, 'beta', { now }).lost, true);
});

/** Three machines is the same rule and is worth pinning: one keeps it, two give it up. */
check('three claims leave exactly one holder', () => {
  const now = new Date('2026-08-12T09:45:00Z');
  const labels = [
    label('carol', '2026-08-12T09:42:10Z'),
    label('alice', '2026-08-12T09:42:00Z'),
    label('bob', '2026-08-12T09:42:05Z'),
  ];
  const lost = ['alice', 'bob', 'carol'].filter((h) => leaseVerdict(labels, h, { now }).lost);
  assert.deepEqual(lost, ['bob', 'carol'], 'alice claimed first and keeps it');
});

/* -------------------------------------------------------------------- expiring */

/**
 * The half that stops this being worse than the problem. A Mac that sleeps mid-bead
 * stops restamping; an hour later its claim is not a holder, and the work is available
 * again rather than parked on a machine nobody can wake.
 */
check('a claim older than its life holds nothing', () => {
  const old = label('gone', '2026-08-12T08:00:00Z');
  const now = new Date('2026-08-12T09:42:00Z');
  assert.equal(isLive(leasesOf([old])[0], { now, minutes: 60 }), false);
  const v = leaseVerdict([old], 'here', { now, minutes: 60 });
  assert.equal(v.holder, null, 'nobody holds it');
  assert.equal(v.lost, false, 'so this Mac may take it');
  assert.deepEqual(v.stale.map((s) => s.handle), ['gone']);
});

/** And a live one still does, at fifty-nine minutes as much as at one. */
check('a claim inside its life still holds', () => {
  const now = new Date('2026-08-12T09:42:00Z');
  const v = leaseVerdict([label('there', '2026-08-12T08:45:00Z')], 'here', { now, minutes: 60 });
  assert.equal(v.holder.handle, 'there');
  assert.equal(v.lost, true);
});

/**
 * A stale claim beside a live one must not win on being older — the sort is over the
 * *live* ones, and a lapsed machine outranking a working one would hand every bead to
 * whichever Mac had been switched off longest.
 */
check('a stale claim does not outrank a live one', () => {
  const now = new Date('2026-08-12T09:42:00Z');
  const labels = [label('asleep', '2026-08-12T06:00:00Z'), label('awake', '2026-08-12T09:40:00Z')];
  assert.equal(leaseVerdict(labels, 'awake', { now, minutes: 60 }).holder.handle, 'awake');
  assert.equal(leaseVerdict(labels, 'awake', { now, minutes: 60 }).lost, false);
});

/** Half the life, so one missed tick never costs a live session its bead. */
check('a claim is restamped at half its life', () => {
  const now = new Date('2026-08-12T09:42:00Z');
  const fresh = leasesOf([label('me', '2026-08-12T09:30:00Z')])[0];
  const aging = leasesOf([label('me', '2026-08-12T08:55:00Z')])[0];
  assert.equal(renewDue(fresh, { now, minutes: 60 }), false);
  assert.equal(renewDue(aging, { now, minutes: 60 }), true);
  assert.equal(renewDue(null, { now, minutes: 60 }), true, 'and no claim at all is always due');
});

/* ------------------------------------------------------------ the quiet install */

/**
 * The guarantee lib/addressee.js makes and this inherits: with `me` unset there is no
 * branch to enter. A machine that cannot say who it is cannot be the machine somebody
 * else is not, so nothing is ever held from it.
 */
check('a machine with no handle is never the loser', () => {
  const now = new Date('2026-08-12T09:43:00Z');
  const v = leaseVerdict([label('somebody', AT)], null, { now });
  assert.equal(v.lost, false, 'a solo install is not held by anybody');
  assert.equal(v.mine, null);
  assert.equal(v.holder.handle, 'somebody', 'though it can still read the claim');
});

check('it says who and how long ago', () => {
  const now = new Date('2026-08-12T09:47:00Z');
  const l = leasesOf([label('adam@example.com', AT)])[0];
  assert.equal(describeLease(l, { now }), "adam@example.com's Mac claimed it 5m ago");
  assert.equal(describeLease(null), 'nobody holds it');
});

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
