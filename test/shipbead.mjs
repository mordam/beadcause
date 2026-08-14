#!/usr/bin/env node
/**
 * A ship bead is nobody's work, and no tap can make it somebody's.
 *
 *     npm test
 *     node test/shipbead.mjs
 *
 * lib/release.js files one bead per merged-but-undeployed pull request. Its acceptance is
 * *the merge commit for #164 is in what beadcause is running*, and only a deploy makes that
 * true — a deploy being a tap on the pull request board, deliberately not an agent's to run.
 * So the bead says, in its own rendered text, "nothing will open a session on it".
 *
 * That promise was hung on `unendorsed`, and this suite exists because a label a tap is
 * designed to remove is the wrong place to hang a promise no tap should be able to break.
 * lib/endorsequeue.js listed the endorsement screen as every bead carrying the marker, with
 * no filter; ship beads are the highest-frequency thing filed here and `newestFirst` put
 * them at the front of it; and one press of "Endorse all" on 2026-08-11 took the marker off
 * twenty-five of them at once. Three unattended worker windows were then opened on three of
 * those beads (bc-dc3u, bc-lnph, bc-izs0), each to discover there was nothing to do.
 *
 * Re-adding the marker by hand was tried and measured: twenty-five repaired on 08-13, twelve
 * back the next morning. It cannot hold, because re-labelling does not change `created_at`
 * and the ordering that puts them in front of Endorse all is the ordering they came with.
 *
 * So the checks below are about the *shape* of the fix rather than the label:
 *
 * 1. **It keys on `ship`, not on endorsement.** Every gate here is asserted against a bead
 *    that is fully endorsed — no `unendorsed` label anywhere in the fixture but one. A
 *    suite that tested held ship beads would pass against the code that had the bug.
 * 2. **Both layers, because one of them is a filter.** A filter is what stops the refusal
 *    ever being reached, and it is never the guarantee: lib/endorse.js says so, and the
 *    incident is what it looks like when the guarantee was a filter all along. So the queue
 *    is checked *and* the door is checked, separately.
 * 3. **Shipping itself is untouched.** The whole risk of filtering ship beads out of the
 *    agent's queues is filtering them off the board that closes them. `openShipBeads` finds
 *    them by label, so the board cannot be reached by any of this — asserted, not assumed.
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
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-shipbead-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { SHIP_LABEL, isShipBead, assertNotShipBead } = await import(LIB('shipbead.js'));
const { UNENDORSED, QUEUE_EXCLUDED } = await import(LIB('endorse.js'));
const { Bd } = await import(LIB('bd.js'));
const { endorsementQueue, forget } = await import(LIB('endorsequeue.js'));
const { applyVerdict } = await import(LIB('verdict.js'));
const { openWorkSession, openPlanSession } = await import(LIB('session.js'));
const release = await import(LIB('release.js'));

/* ------------------------------------------------------------------- the fixture */

const WS = { name: 'beadcause', dir: path.join(tmp, 'ws') };

/**
 * A ship bead exactly as lib/release.js leaves one — except endorsed, which is the state
 * the incident actually produced and the state every gate here has to hold in.
 */
const shipBead = (id, extra = {}) => ({
  id,
  title: `Ship #164: bc-wx2e: two colliding .chip[aria-pressed] rules`,
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [SHIP_LABEL],
  description: 'ship: mordam/beadcause#164',
  created_at: '2026-08-11T02:00:00Z',
  ...extra,
});

/** An ordinary agent-filed discovery, still held. What the endorsement screen is *for*. */
const heldBead = (id) => ({
  id,
  title: 'The drawer forgets its scroll position',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [UNENDORSED, 'agent-filed'],
  created_at: '2026-08-10T02:00:00Z',
});

/** A `bd` with no subprocess behind it: these gates are all row-reading. */
const trackerOf = (rows) => {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const calls = [];
  return {
    calls,
    async show(_ws, id) {
      calls.push(['show', id]);
      return byId.get(id) || null;
    },
    async listLabel(_ws, label) {
      calls.push(['listLabel', label]);
      return rows.filter((r) => (r.labels || []).includes(label));
    },
    async removeLabel(_ws, id, label) {
      calls.push(['removeLabel', id, label]);
      const row = byId.get(id);
      if (row) row.labels = (row.labels || []).filter((l) => l !== label);
    },
  };
};

/* --------------------------------------------------------------------- harness */

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

console.log('\na ship bead is nobody’s work, and no tap can make it somebody’s\n');

/* ================================================================ 1. the label itself */

await check('one string, one place — and release.js still exports the name its callers use', () => {
  assert.equal(SHIP_LABEL, 'ship');
  assert.equal(release.SHIP_LABEL, SHIP_LABEL, 'release.js and shipbead.js disagree about the label');
  // Declared once. Two spellings of a guard's key is the same as no guard, and this one
  // moved out of release.js precisely so both sides could read the same constant.
  const src = read('lib/release.js');
  assert.ok(!/const SHIP_LABEL = /.test(src), 'release.js declares the label a second time');
});

await check('it reads the label off a row, and is not fooled by a near miss', () => {
  assert.equal(isShipBead(shipBead('bc-izs0')), true);
  assert.equal(isShipBead({ labels: [' ship '] }), true, 'a padded label is the same label');
  assert.equal(isShipBead({ labels: ['shipped', 'no-auto-ship', 'auto-ship'] }), false);
  assert.equal(isShipBead({}), false);
  assert.equal(isShipBead(null), false);
});

/* ============================================ 2. the filter — no queue may contain one */

await check('`ship` is in QUEUE_EXCLUDED, beside the two that were already there', () => {
  assert.ok(QUEUE_EXCLUDED.includes(SHIP_LABEL), 'the advocate would survey ship beads as waiting work');
  assert.ok(QUEUE_EXCLUDED.includes(UNENDORSED));
  assert.ok(QUEUE_EXCLUDED.includes('human'));
});

await check('`Bd.ready` forces it on whatever the caller asks for, and filters the rows too', async () => {
  const bd = new Bd({ bin: 'bd', actor: 'test' });
  let asked = null;
  bd.json = async (_ws, args) => {
    asked = args;
    // A bd that quietly ignored the flag — which is the case the row filter exists for.
    return [shipBead('bc-izs0'), { id: 'bc-real', status: 'open', labels: [] }];
  };
  // The stalest possible call site: the pre-list signature, asking for one exclusion.
  const rows = await bd.ready(WS, { excludeLabel: 'human' });
  assert.ok(asked.includes(SHIP_LABEL), '`--exclude-label ship` never reached bd');
  assert.ok(asked.includes(UNENDORSED), 'and the older forced exclusion was dropped on the way');
  assert.deepEqual(rows.map((r) => r.id), ['bc-real'], 'a ship bead came back as claimable work');
});

await check('the endorsement queue draws the held discovery and not the ship bead', async () => {
  forget();
  const bd = trackerOf([shipBead('bc-izs0', { labels: [SHIP_LABEL, UNENDORSED] }), heldBead('bc-drw1')]);
  const q = await endorsementQueue(bd, [WS], { refresh: true });
  assert.deepEqual(q.beads.map((b) => b.id), ['bc-drw1'], 'a ship bead is on the screen that endorses');
  // The counts feed the "n waiting" pill: a screen that says 2 and draws 1 is the lie the
  // truncation notice exists to prevent, so the ship bead has to leave before it is counted.
  assert.equal(q.counts.total, 1, 'and it is counted as something waiting on a decision');
  assert.equal(q.truncated, 0);
  forget();
});

// The mirror of the check above rather than a second version of it: the twenty-five beads
// the press already stripped never come back to this screen, because the screen is a query
// on the marker they lost. Which is the point — the marker being gone is not the damage,
// them being *workable* is, and that is what the doors below are for. Asserted so nobody
// "fixes" the incident by putting `unendorsed` back and expects this screen to stay clean.
await check('a ship bead the press already stripped is off the screen too, marker or not', async () => {
  forget();
  const bd = trackerOf([shipBead('bc-izs0'), heldBead('bc-drw1')]);
  const q = await endorsementQueue(bd, [WS], { refresh: true });
  assert.deepEqual(q.beads.map((b) => b.id), ['bc-drw1']);
  forget();
});

/* ================================== 3. the refusal — the guarantee, and endorsement-blind */

await check('assertNotShipBead passes an ordinary row through and refuses a ship bead', () => {
  const ok = heldBead('bc-drw1');
  assert.equal(assertNotShipBead(ok), ok, 'the gate must hand back the row it was given');
  assert.throws(() => assertNotShipBead(shipBead('bc-izs0')), (err) => {
    assert.equal(err.status, 409, 'a refusal is a conflict, not a 500');
    assert.equal(err.ship, true, 'nothing could tell this from a launch that merely failed');
    assert.match(err.message, /bc-izs0/, 'the sentence in the log has to name the bead');
    assert.match(err.message, /only a deploy closes one/);
    return true;
  });
});

await check('openWorkSession refuses a fully endorsed ship bead, on the label alone', async () => {
  const bead = shipBead('bc-izs0');
  assert.ok(!bead.labels.includes(UNENDORSED), 'the fixture must be endorsed or this proves nothing');
  const bd = trackerOf([bead]);
  await assert.rejects(
    () => openWorkSession({}, WS, 'bc-izs0', { bd }),
    (err) => {
      assert.equal(err.ship, true);
      assert.equal(err.status, 409);
      return true;
    }
  );
  // It refused before it resolved a directory or wrote a prompt: the only tracker call is
  // the one `assertEndorsed` already pays for.
  assert.deepEqual(bd.calls, [['show', 'bc-izs0']]);
});

await check('and so does openPlanSession — every door into an unattended window, not one', async () => {
  const bd = trackerOf([shipBead('bc-izs0')]);
  await assert.rejects(() => openPlanSession({}, WS, 'bc-izs0', { bd }), /may not be worked/);
});

await check('every door that asks assertEndorsed asks this too', () => {
  const src = read('lib/session.js');
  const doors = src.match(/await assertEndorsed\(/g) || [];
  const gated = src.match(/assertNotShipBead\(/g) || [];
  assert.ok(doors.length >= 3, 'the doors moved — this check is reading the wrong shape');
  // One gate per door. A fourth door added without one is the hole this suite is about.
  assert.equal(gated.length, doors.length, 'a door into an unattended session has no ship gate');
});

/* ================================================== 4. Endorse all cannot reach one either */

await check('endorsing a ship bead by id is refused, not quietly performed', async () => {
  const bead = shipBead('bc-izs0', { labels: [SHIP_LABEL, UNENDORSED] });
  const bd = trackerOf([bead]);
  const out = await applyVerdict(bd, WS, { verdict: 'endorse', ids: ['bc-izs0'] });
  assert.equal(out.ok.length, 0, 'the press landed');
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].status, 409);
  assert.ok(bead.labels.includes(UNENDORSED), 'and it took the marker off on the way');
  assert.ok(!bd.calls.some((c) => c[0] === 'removeLabel'), 'a write was attempted on a ship bead');
});

await check('a group endorse still lands the beads beside it — one refusal is not a failed press', async () => {
  const held = heldBead('bc-drw1');
  const bd = trackerOf([shipBead('bc-izs0'), held]);
  const out = await applyVerdict(bd, WS, { verdict: 'endorse', ids: ['bc-izs0', 'bc-drw1'] });
  assert.deepEqual(out.ok.map((r) => r.id), ['bc-drw1'], 'the ordinary bead was dropped over the ship bead');
  assert.deepEqual(out.failed.map((r) => r.id), ['bc-izs0']);
  assert.ok(!held.labels.includes(UNENDORSED), 'and the one that should have been endorsed was not');
});

/* ============================================================ 5. shipping itself is untouched */

await check('the board still finds ship beads by label, so none of this can reach it', () => {
  const src = read('lib/release.js');
  // `openShipBeads` is a query on the label, not on the ready queue — which is the entire
  // reason filtering ship beads out of the agent's queues is safe. If this ever became a
  // `bd.ready` call, every gate above would start hiding pull requests from the board.
  assert.match(src, /listLabel\(ws, SHIP_LABEL\)/, 'the ship board no longer reads the label directly');
  assert.ok(!/\.ready\(/.test(src), 'release.js reads the ready queue, which this suite now filters');
  // Filing is unchanged: `unendorsed` stays on a new ship bead. It is no longer *load-bearing*
  // — that is the whole diff — but taking it off would put ship beads back on a phone screen
  // as things to judge the moment anything read the marker instead of the label.
  assert.match(src, /labels: \[SHIP_LABEL, UNENDORSED\]/, 'a filed ship bead lost its marker');
});

/* ============================== 6. the counts, which is where a filter tells a lie */

await check('`readyHeld` leaves ship beads out, so the pill agrees with what it links to', async () => {
  const bd = new Bd({ bin: 'bd', actor: 'test' });
  let asked = null;
  bd.json = async (_ws, args) => {
    asked = args;
    return [shipBead('bc-izs0', { labels: [SHIP_LABEL, UNENDORSED] }), heldBead('bc-drw1')];
  };
  const rows = await bd.readyHeld(WS);
  assert.ok(asked.includes(SHIP_LABEL), '`--exclude-label ship` never reached bd');
  assert.deepEqual(rows.map((r) => r.id), ['bc-drw1'], '`N held for endorsement` counts a ship bead');
});

await check('`readyShip` asks for the whole cohort, endorsed or not', async () => {
  const bd = new Bd({ bin: 'bd', actor: 'test' });
  let asked = null;
  bd.json = async (_ws, args) => {
    asked = args;
    return [shipBead('bc-izs0'), shipBead('bc-lnph', { labels: [SHIP_LABEL, UNENDORSED] })];
  };
  const rows = await bd.readyShip(WS);
  // On the label, not on the marker: the twelve that "Endorse all" stripped are the ones
  // sitting inside `ready_issues` with nothing on any screen to explain them.
  assert.ok(asked.includes('--label') && asked.includes(SHIP_LABEL));
  assert.ok(!asked.includes(UNENDORSED), 'narrowing on the marker would miss the endorsed cohort');
  assert.equal(rows.length, 2);
});

await check('and the monitor subtracts both, without subtracting the overlap twice', async () => {
  const { collectWork } = await import(LIB('work.js'));
  const bd = {
    async status() {
      // Nine ready by bd's count: one real bead, three ship beads, five held discoveries.
      return { ready_issues: 9, open_issues: 20, blocked_issues: 0, in_progress_issues: 0, closed_issues: 4 };
    },
    async listStatus() {
      return [];
    },
    // Partitioned, which is what Bd.readyHeld's ship exclusion buys: the ship bead that
    // still carries the marker is counted once, by readyShip, and not by both.
    async readyHeld() {
      return [heldBead('a'), heldBead('b'), heldBead('c'), heldBead('d'), heldBead('e')];
    },
    async readyShip() {
      return [shipBead('s1'), shipBead('s2'), shipBead('s3', { labels: [SHIP_LABEL, UNENDORSED] })];
    },
  };
  const [row] = await collectWork(bd, [WS]);
  assert.equal(row.counts.held, 5, 'the pill has to be the number the endorsement screen draws');
  assert.equal(row.counts.ready, 1, 'three ship beads are still being reported as work waiting');
});

/* --------------------------------------------------------------------- teardown */

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
