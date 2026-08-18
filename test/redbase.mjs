#!/usr/bin/env node
/**
 * The red-base runbook: hold the merge queue while the base is failing — bc-arf8.
 *
 *     npm test
 *     node test/redbase.mjs
 *
 * lib/redbase.js is a pure decision about a standing condition, and what makes it worth
 * pinning one state at a time is that three of its four answers are *doing nothing* — and
 * doing nothing is what a refactor deletes without noticing.
 *
 * The four that would hurt most, in order:
 *
 * 1. **Unknown is neither red nor green.** `baseChecks` returns `null` when it could not
 *    ask GitHub. Read as red it files a P0 and opens an unattended window over a network
 *    blip; read as green it lifts a live hold and closes a bead somebody is working.
 * 2. **The fix is exempt.** The hold's whole design constraint: the pull request that
 *    fixes the base has to merge while the hold is on, or the repo wedges.
 * 3. **Pending never clears.** `main`'s checks re-run on every merge, so a base with a run
 *    in flight is unknown — clearing on it would lift the hold in the window between a
 *    push and its first red check, every time.
 * 4. **One bead per base, found by its own title.** There is no record on disk on purpose
 *    (lib/redbase.js's header), so the title *is* the key and a search that stopped
 *    matching would file a second P0 and open a second window on every tick.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const {
  RED_BASE_LABEL,
  HOLD_PRIORITY,
  baseVerdict,
  clearReason,
  exemptFrom,
  findHold,
  holdAcceptance,
  holdBody,
  holdIssue,
  holdRefusal,
  holdTitle,
  isHoldBead,
  sweepBase,
} = await import(LIB('redbase.js'));

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

/** The async twin, for `sweepBase` — the same reporting, one await deep. */
const acheck = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

console.log('\nthe red-base hold\n');

const RED = { state: 'failing', failing: 1, pending: 0, total: 3, failed: ['test/reenter.mjs'] };
const GREEN = { state: 'passing', failing: 0, pending: 0, total: 3, failed: [] };
const PENDING = { state: 'pending', failing: 0, pending: 2, total: 3, failed: [] };
const holdRow = (over = {}) => ({
  id: 'zz-hold',
  title: holdTitle('beadcause', 'main'),
  status: 'open',
  labels: [RED_BASE_LABEL],
  ...over,
});

/* ----------------------------------------------------------------- the verdict */

check('a failing base with nothing open files the bead', () => {
  const v = baseVerdict({ baseline: RED, open: null });
  assert.equal(v.act, 'file');
  assert.equal(v.red, true);
  assert.deepEqual(v.failed, ['test/reenter.mjs']);
});

check('a failing base with the bead already open writes nothing', () => {
  // The steady state, and it has to be silent: a tick every thirty seconds that
  // commented or amended would make a broken afternoon unreadable.
  assert.equal(baseVerdict({ baseline: RED, open: holdRow() }).act, 'hold');
});

check('a green base with a bead open closes it — the hold lifts by itself', () => {
  assert.equal(baseVerdict({ baseline: GREEN, open: holdRow() }).act, 'clear');
});

check('a green base with nothing open does nothing at all', () => {
  assert.equal(baseVerdict({ baseline: GREEN, open: null }).act, 'none');
});

check('UNKNOWN IS NOT RED — a GitHub it could not ask files nothing', () => {
  // `baseChecks` answers null for a rate limit, a token or a network. Reading that as red
  // opens an unattended window over an outage.
  const v = baseVerdict({ baseline: null, open: null });
  assert.equal(v.act, 'none');
  assert.equal(v.red, false);
  assert.equal(v.unknown, true);
});

check('AND UNKNOWN IS NOT GREEN — it never closes a live hold', () => {
  // The costlier half: a hold lifted and a P0 closed under a session that is working it,
  // because `gh` timed out once.
  assert.equal(baseVerdict({ baseline: null, open: holdRow() }).act, 'none');
});

check('PENDING IS NOT GREEN EITHER — a base mid-run never clears the hold', () => {
  // main's checks re-run on every merge, so this window opens on every single merge.
  assert.equal(baseVerdict({ baseline: PENDING, open: holdRow() }).act, 'none');
  assert.equal(baseVerdict({ baseline: PENDING, open: null }).act, 'none');
});

check('a rollup that names failing checks is red however it labelled its state', () => {
  // Belt and braces against a `rollup` that grows a state this does not know: names in
  // `failed` are the fact, and the direction that costs a hold rather than a bad merge.
  assert.equal(baseVerdict({ baseline: { state: 'weird', failed: ['lint'] }, open: null }).act, 'file');
});

check('an empty repo with no checks at all is not a red base', () => {
  assert.equal(baseVerdict({ baseline: { state: 'none', failed: [], total: 0 }, open: null }).act, 'none');
});

/* -------------------------------------------------------------------- the bead */

check('the title carries the base and the unit, because both vary', () => {
  // deluvia lands on atlas/public-launch, and a workspace of forty repos has forty
  // independent answers — one bead per workspace would hold thirty-nine over the fortieth.
  assert.notEqual(holdTitle('beadcause', 'main'), holdTitle('beadcause', 'atlas/public-launch'));
  assert.notEqual(holdTitle('climative/athena', 'main'), holdTitle('climative/hermes', 'main'));
  assert.match(holdTitle('beadcause', 'main'), /beadcause/);
});

check('THE BEAD IS FOUND BY ITS OWN TITLE AND ITS OWN LABEL', () => {
  const rows = [
    { id: 'zz-other', title: 'something else', status: 'open', labels: [RED_BASE_LABEL] },
    holdRow(),
  ];
  assert.equal(findHold(rows, { key: 'beadcause', base: 'main' })?.id, 'zz-hold');
  // A different base is a different question and must not match.
  assert.equal(findHold(rows, { key: 'beadcause', base: 'release' }), null);
  assert.equal(findHold(rows, { key: 'sophab', base: 'main' }), null);
});

check('and a closed one is not found, which is what makes the runbook automatic', () => {
  // The merge of the fix closes this bead as the queue's work bead. Nothing has to be
  // told that the hold is over: the search simply stops finding it.
  assert.equal(findHold([holdRow({ status: 'closed' })], { key: 'beadcause', base: 'main' }), null);
});

check('a bead with the right title and no label is not one of these', () => {
  // The label is the half a retitle cannot take off, and the half that stops this
  // adopting a bead somebody wrote by hand.
  assert.equal(findHold([holdRow({ labels: [] })], { key: 'beadcause', base: 'main' }), null);
  assert.equal(isHoldBead(holdRow()), true);
  assert.equal(isHoldBead({ labels: ['human'] }), false);
});

check('findHold survives a Map, which is what bd.graph hands over', () => {
  const beads = new Map([['zz-hold', holdRow()]]);
  assert.equal(findHold(beads, { key: 'beadcause', base: 'main' })?.id, 'zz-hold');
  assert.equal(findHold(null, { key: 'beadcause', base: 'main' }), null);
});

check('the bead is a P0 bug, endorsed, carrying its own provenance', () => {
  const issue = holdIssue({ key: 'beadcause', base: 'main', failed: ['test/reenter.mjs'], at: '2026-08-18T09:00:00Z' });
  assert.equal(issue.priority, HOLD_PRIORITY);
  assert.equal(issue.priority, 0, 'a P0 is also what makes it a root, so openWorkSession needs no parent for it');
  assert.equal(issue.type, 'bug');
  assert.deepEqual(issue.labels, [RED_BASE_LABEL]);
  // Deliberately NOT unendorsed: holding this one behind a tap would leave the queue
  // stopped until somebody looked at their phone, which is the human this bead removes.
  assert.ok(!issue.labels.includes('unendorsed'));
  assert.equal(issue.title, holdTitle('beadcause', 'main'));
});

check('the body names the failing checks, the stamp and both ways out', () => {
  const body = holdBody({
    key: 'beadcause',
    base: 'main',
    failed: ['test/reenter.mjs', 'scripts/selftest.mjs'],
    at: '2026-08-18T09:00:00Z',
  });
  assert.match(body, /test\/reenter\.mjs/);
  assert.match(body, /scripts\/selftest\.mjs/);
  // UTC with an explicit Z, because a reading taken at an instant sits in the tracker for
  // days and every card and brief around it talks ADT.
  assert.match(body, /2026-08-18T09:00:00Z/);
  assert.match(body, /\*\*under this bead\*\*/, 'it does not say how to get out from under the hold');
  assert.match(body, /pull request board/, 'it does not say the tap still works for a fix under another bead');
  assert.match(body, /Do not retitle it/, 'the title is the key and the bead does not say so');
});

check('a long failing list is capped rather than pasted whole', () => {
  const failed = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const body = holdBody({ key: 'beadcause', base: 'main', failed, at: '' });
  assert.match(body, /and 2 more/);
});

check('the acceptance is about the base, not about a diff', () => {
  // Nothing here is finished by a commit — it is finished by the base passing, which is
  // also what closes the bead without anybody doing it.
  assert.match(holdAcceptance('main'), /green on GitHub/);
  assert.match(clearReason('main', '2026-08-18T09:00:00Z'), /green again/);
  assert.match(clearReason('main', '2026-08-18T09:00:00Z'), /2026-08-18T09:00:00Z/);
});

/* --------------------------------------------------------------- the exemption */

check('THE FIX IS EXEMPT FROM ITS OWN HOLD, OR THE REPO WEDGES', () => {
  const hold = { bead: 'zz-hold', base: 'main', key: 'beadcause', failed: ['lint'] };
  assert.equal(exemptFrom(hold, { bead: 'zz-hold' }), true);
  assert.equal(exemptFrom(hold, { bead: 'zz-other' }), false);
});

check('and nothing is exempt from a hold that names no bead', () => {
  assert.equal(exemptFrom(null, { bead: 'zz-hold' }), false);
  assert.equal(exemptFrom({ base: 'main' }, { bead: 'zz-hold' }), false);
});

check('the sentence names the base, the checks and the bead to go and look at', () => {
  const why = holdRefusal({ bead: 'zz-hold', base: 'main', failed: ['test/reenter.mjs'] });
  assert.match(why, /main/);
  assert.match(why, /test\/reenter\.mjs/);
  assert.match(why, /zz-hold/, 'a held pull request that does not name its fix is a dead end');
});

check('and it still says something during an outage that named no checks', () => {
  const why = holdRefusal({ bead: 'zz-hold', base: 'main', failed: [] });
  assert.match(why, /is red/);
  assert.ok(!why.includes('()'), 'an empty check list left an empty bracket in the sentence');
});

/* ------------------------------------------------------------------ the sweep */

/**
 * `sweepBase` is what lib/server.js hangs on `pr.baseChecks`, `bd.graph`, `bd.create`,
 * `bd.close` and `openWorkSession` — so what these pin is the *sequence*: which of the
 * five effects run, in which order, and above all which of them do **not** run on a tick
 * where the answer is "carry on".
 */
const world = ({ baseline = RED, rows = [], filed = 'zz-new', createThrows = null, closeThrows = null } = {}) => {
  const did = { filed: [], closed: [], settled: 0, announced: [], opened: [], log: [] };
  return {
    did,
    deps: {
      checks: async () => baseline,
      rows: async () => rows,
      file: async (issue) => {
        if (createThrows) throw createThrows;
        did.filed.push(issue);
        return filed;
      },
      close: async (id, reason) => {
        if (closeThrows) throw closeThrows;
        did.closed.push({ id, reason });
      },
      settle: async () => {
        did.settled += 1;
      },
      announce: (id) => did.announced.push(id),
      open: async (id) => {
        did.opened.push(id);
        return true;
      },
      log: (l) => did.log.push(l),
    },
  };
};
const HERE_KEY = { key: 'beadcause', base: 'main' };

await acheck('A RED BASE FILES ONE P0 AND OPENS A WINDOW ON IT', async () => {
  const w = world();
  const out = await sweepBase(HERE_KEY, w.deps);
  assert.equal(out.act, 'file');
  assert.equal(w.did.filed.length, 1);
  assert.equal(w.did.filed[0].priority, 0);
  assert.equal(w.did.filed[0].title, holdTitle('beadcause', 'main'));
  assert.match(w.did.filed[0].body, /test\/reenter\.mjs/);
  // The third bullet of the runbook: a session opened on it immediately, past an advocate
  // that may be paused — because pausing advocates to stop the queue would also stop the
  // fix being dispatched.
  assert.deepEqual(w.did.opened, ['zz-new']);
  assert.deepEqual(out.hold, { bead: 'zz-new', key: 'beadcause', base: 'main', failed: ['test/reenter.mjs'] });
});

await acheck('and it settles the cache it just invalidated, or it files a second next tick', async () => {
  // `bd.graph` caches for a minute and the poll cycle is faster than that, so without
  // this the very next tick cannot see the bead it just filed.
  const w = world();
  await sweepBase(HERE_KEY, w.deps);
  assert.equal(w.did.settled, 1);
  assert.deepEqual(w.did.announced, ['zz-new'], 'a parked phone finds out when something else happens to move');
});

await acheck('NO SECOND P0 WHILE ONE IS OPEN', async () => {
  const w = world({ rows: [holdRow()] });
  const out = await sweepBase(HERE_KEY, w.deps);
  assert.equal(out.act, 'hold');
  assert.deepEqual(w.did.filed, []);
  assert.deepEqual(w.did.closed, []);
  assert.equal(w.did.settled, 0, 'the steady state wrote something');
  assert.deepEqual(w.did.announced, [], 'a base red for an hour woke every device every tick');
  assert.equal(out.hold.bead, 'zz-hold');
});

await acheck('but the window is offered again, because a session can exit without fixing it', async () => {
  const w = world({ rows: [holdRow()] });
  await sweepBase(HERE_KEY, w.deps);
  // Every refusal in the caller's `open` is cheap and none of them writes anything, so
  // offering costs nothing and not offering leaves a P0 nobody is on.
  assert.deepEqual(w.did.opened, ['zz-hold']);
});

await acheck('A GREEN BASE CLOSES THE P0 AND THE HOLD LIFTS BY ITSELF', async () => {
  const w = world({ baseline: GREEN, rows: [holdRow()] });
  const out = await sweepBase(HERE_KEY, w.deps);
  assert.equal(out.act, 'clear');
  assert.equal(out.hold, null);
  assert.equal(w.did.closed[0].id, 'zz-hold');
  assert.match(w.did.closed[0].reason, /green again/);
  assert.equal(w.did.settled, 1);
  assert.deepEqual(w.did.announced, ['zz-hold']);
  assert.deepEqual(w.did.opened, [], 'it opened a window on a bead it had just closed');
});

await acheck('a close bd refused leaves the hold on rather than pretending', async () => {
  // The safe direction — and it is said out loud, because a hold that will not lift is
  // exactly the thing nobody would think to go looking for.
  const w = world({ baseline: GREEN, rows: [holdRow()], closeThrows: new Error('blocked by open issues [zz-x]') });
  const out = await sweepBase(HERE_KEY, w.deps);
  assert.equal(out.act, 'stuck');
  assert.equal(out.hold.bead, 'zz-hold');
  assert.ok(w.did.log.some((l) => /would not close/.test(l)));
});

await acheck('A TRACKER THAT COULD NOT BE ASKED CHANGES NOTHING AT ALL', async () => {
  // Both wrong answers cost something: a second P0 with a second window behind it, or a
  // hold lifted over an outage.
  const last = { bead: 'zz-hold', key: 'beadcause', base: 'main', failed: ['lint'] };
  const w = world({ rows: null });
  const out = await sweepBase({ ...HERE_KEY, last }, { ...w.deps, rows: async () => null });
  assert.equal(out.act, 'unknown');
  assert.deepEqual(out.hold, last, 'a hold this process knew about was lifted by a failed read');
  assert.deepEqual(w.did.filed, []);
  assert.deepEqual(w.did.closed, []);
});

await acheck('and a GitHub that could not be asked holds what it was already holding', async () => {
  const last = { bead: 'zz-hold', key: 'beadcause', base: 'main', failed: ['lint'] };
  const w = world({ baseline: null, rows: [holdRow()] });
  const out = await sweepBase({ ...HERE_KEY, last }, w.deps);
  assert.equal(out.hold.bead, 'zz-hold');
  // The names come forward from the last real reading, so a held pull request still says
  // what is broken during an outage.
  assert.deepEqual(out.hold.failed, ['lint']);
  assert.deepEqual(w.did.closed, []);
});

await acheck('a bd that would not take the bead files nothing and opens nothing', async () => {
  const w = world({ createThrows: new Error('dolt: database locked') });
  const out = await sweepBase(HERE_KEY, w.deps);
  assert.equal(out.act, 'unknown');
  assert.equal(out.hold, null);
  assert.deepEqual(w.did.opened, []);
  assert.ok(w.did.log.some((l) => /could not file/.test(l)));
});

await acheck('a green base with nothing open is the quiet tick, and it is silent', async () => {
  const w = world({ baseline: GREEN });
  const out = await sweepBase(HERE_KEY, w.deps);
  assert.equal(out.act, 'none');
  assert.equal(out.hold, null);
  assert.deepEqual(w.did.log, [], 'the ordinary case logs, on a Mac where this runs every minute forever');
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `${ran} passed`}\n`);
process.exit(failures ? 1 : 0);
