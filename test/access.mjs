/**
 * The access register keeps up with the system, or the repo goes red.
 *
 * Three things are being kept true here, and only the third is a normal unit test.
 *
 * 1. **A new agent kind cannot ship unregistered.** `AGENTS` in lib/foundation.js is the
 *    roster; `AGENT_ACCESS` must cover it exactly. A seventh kind added to BASELINES with
 *    no access row fails here rather than appearing in a register as silence.
 * 2. **A new credential cannot ship without a way back.** Every id in `CREDENTIALS` has to
 *    appear in a `JML.leaver` step, so the leaver path cannot go stale behind the register.
 * 3. **The periodic review fails when it is overdue.** Which is the control itself, not a
 *    test of one — see the header of lib/access.js for the honest limit of that.
 */
import assert from 'node:assert/strict';
import { AGENTS } from '../lib/foundation.js';
import {
  AGENT_ACCESS,
  CREDENTIALS,
  JML,
  PRINCIPAL_KINDS,
  REVIEWS,
  REVIEW_INTERVAL_DAYS,
  agentPrincipals,
  boundaryPrincipal,
  humanPrincipals,
  register,
  reviewLine,
  reviewState,
} from '../lib/access.js';

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL - ${name}: ${err.message}`);
  }
};

check('every agent kind is registered, and nothing else is', () => {
  const registered = Object.keys(AGENT_ACCESS).sort();
  assert.deepEqual(registered, [...AGENTS].sort(), 'AGENT_ACCESS must cover AGENTS exactly');
});

check('an unregistered agent kind is a refusal, not silence', () => {
  // The roster is read at call time, so the only way to stage the failure is to prove the
  // thrower is reached — the assertion above is what stops it happening for real.
  const row = AGENT_ACCESS[AGENTS[0]];
  delete AGENT_ACCESS[AGENTS[0]];
  try {
    assert.throws(() => agentPrincipals(), /has no access registered/);
  } finally {
    AGENT_ACCESS[AGENTS[0]] = row;
  }
});

check('every agent principal names a grant and a revocation', () => {
  for (const p of agentPrincipals()) {
    assert.ok(p.grant && p.grant.length > 10, `${p.id} has no grant`);
    assert.ok(p.revoke && p.revoke.length > 10, `${p.id} has no revocation act`);
    assert.ok(p.reaches && p.reaches.length > 10, `${p.id} does not say what it reaches`);
    assert.ok(PRINCIPAL_KINDS.includes(p.kind), `${p.id} has kind ${p.kind}`);
  }
});

check('agent rows read writes and ownsRepo off the foundation', () => {
  const byId = Object.fromEntries(agentPrincipals().map((p) => [p.id, p]));
  // The chat session is the one that may not write, and the merge queue is the one that
  // owns the door into main. If either of those flips, the register said so first.
  assert.match(byId['agent:console'].writes, /read-only/);
  assert.match(byId['agent:merge-advocate'].writes, /may write/);
  assert.equal(byId['agent:worker'].ownsRepo, true);
  assert.equal(byId['agent:merge-advocate'].name, 'The merge queue', 'the row is named by the foundation title');
});

check('every credential has a leaver step', () => {
  const covered = new Set(JML.leaver.map((s) => s.credential));
  for (const c of CREDENTIALS) {
    assert.ok(covered.has(c.id), `credential ${c.id} has no leaver step — add one to JML.leaver`);
  }
});

check('every leaver step names a credential that exists', () => {
  const ids = new Set(CREDENTIALS.map((c) => c.id));
  for (const s of JML.leaver) {
    assert.ok(ids.has(s.credential), `leaver step names unknown credential ${s.credential}`);
    assert.ok(s.act && s.act.length > 10, 'a leaver step with no act');
  }
});

check('every credential says where it lives and what ends it', () => {
  const seen = new Set();
  for (const c of CREDENTIALS) {
    assert.ok(!seen.has(c.id), `duplicate credential id ${c.id}`);
    seen.add(c.id);
    for (const field of ['what', 'where', 'holder', 'scope', 'revoke']) {
      assert.ok(c[field] && String(c[field]).length > 5, `credential ${c.id} has no ${field}`);
    }
  }
});

check('joiner and mover paths are written down', () => {
  assert.ok(JML.joiner.length >= 3, 'the joiner path is not documented');
  assert.ok(JML.mover.length >= 2, 'the mover path is not documented');
});

check('the human half is read from config, not typed into the module', () => {
  const cfg = { auth: { token: 'sekrit', google: { allowed: ['a@example.com', 'B@Example.com '] } } };
  const now = new Date('2026-08-15T12:00:00Z');
  const state = {
    devices: {
      d1: { email: 'a@example.com', label: 'iPhone', first: '2026-08-01T00:00:00.000Z', last: '2026-08-15T11:00:00.000Z', exp: '2026-09-15T00:00:00.000Z' },
    },
  };
  const people = humanPrincipals(cfg, state, now);
  const ids = people.map((p) => p.id);
  assert.ok(ids.includes('human:a@example.com'), 'the allowlist is not in the register');
  assert.ok(ids.includes('human:b@example.com'), 'the allowlist is not normalised the way the gate normalises it');
  assert.ok(ids.includes('human:token-holder'), 'the shared token is a grant and belongs in the register');
  assert.ok(ids.some((i) => i.startsWith('device:')), 'a signed-in device is a principal');
});

check('an install with no sign-in and no devices still registers the token holder', () => {
  const people = humanPrincipals({ auth: { token: 'x' } }, {}, new Date('2026-08-15T12:00:00Z'));
  assert.deepEqual(people.map((p) => p.id), ['human:token-holder']);
});

check('an install with nothing configured registers nobody rather than guessing', () => {
  assert.deepEqual(humanPrincipals({}, {}, new Date('2026-08-15T12:00:00Z')), []);
});

check('the boundary is a principal, because a network position is a grant', () => {
  const b = boundaryPrincipal({ baseUrl: 'https://mac.tailnet.ts.net:4318' });
  assert.equal(b.kind, 'machine');
  assert.match(b.grant, /[Tt]ailscale/);
  assert.match(b.revoke, /tailnet/);
});

check('the register assembles both halves and the review', () => {
  const reg = register({ auth: { token: 'x' } }, {}, new Date('2026-08-15T12:00:00Z'));
  assert.ok(reg.principals.length >= AGENTS.length + 2);
  assert.equal(reg.credentials, CREDENTIALS);
  assert.ok(reg.review);
  for (const p of reg.principals) assert.ok(PRINCIPAL_KINDS.includes(p.kind), `unknown principal kind ${p.kind}`);
});

check('a review is due an interval after the last one, and late after that', () => {
  const reviews = [{ at: '2026-01-01', by: 'someone@example.com', note: 'first' }];
  const on = (d) => reviewState(new Date(`${d}T12:00:00Z`), reviews, 90);
  assert.equal(on('2026-01-02').overdue, false);
  assert.equal(on('2026-01-02').dueAt, '2026-04-01');
  assert.equal(on('2026-03-01').due, false, 'a review two months out is not due yet');
  assert.equal(on('2026-03-25').due, true, 'the warning window opens before the date, not on it');
  assert.equal(on('2026-03-25').overdue, false, 'due is not late');
  assert.equal(on('2026-04-05').overdue, true);
  assert.equal(on('2026-04-05').daysLate, 4);
  assert.match(reviewLine(on('2026-04-05')), /overdue/);
});

check('a register that has never been reviewed is overdue, not fine', () => {
  const s = reviewState(new Date('2026-08-15T12:00:00Z'), [], 90);
  assert.equal(s.overdue, true);
  assert.match(reviewLine(s), /No access review has ever been recorded/);
});

check('the recorded reviews are well formed and in order', () => {
  assert.ok(REVIEWS.length >= 1, 'no access review has ever been recorded');
  let previous = 0;
  for (const r of REVIEWS) {
    assert.match(r.at, /^\d{4}-\d{2}-\d{2}$/, `review date ${r.at} is not a date`);
    assert.ok(r.by && r.by.includes('@'), `review ${r.at} does not say who performed it`);
    assert.ok(r.note && r.note.length > 10, `review ${r.at} says nothing about what was looked at`);
    const at = Date.parse(`${r.at}T00:00:00Z`);
    assert.ok(at >= previous, 'REVIEWS is append-only and must stay in date order');
    previous = at;
  }
});

// The control itself. When this goes red the fix is two lines in lib/access.js — perform
// the review, append the entry — and not a change to this file.
check('the periodic access review is not overdue', () => {
  const s = reviewState();
  assert.equal(s.overdue, false, reviewLine(s));
  assert.ok(REVIEW_INTERVAL_DAYS <= 366, 'an interval longer than a year is not a periodic review');
});

if (failures) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\naccess register ok');
