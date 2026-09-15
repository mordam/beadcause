#!/usr/bin/env node
/**
 * How many beads has this tracker filed under nothing? — bc-xl7n.83.
 *
 *     npm test
 *     node test/orphancensus.mjs
 *
 * lib/underroot.js already answers this one bead at a time, and lib/advocate.js's
 * `withoutOrphans` already uses that to hold such a bead out of the ready queue. Neither
 * counts, and neither sees a bead that never reached the ready queue in the first place
 * — a run of epic-advocate passes on bc-xl7n hand-derived the same number often enough
 * that it is worth a suite of its own. Six properties, in the order they would break in:
 *
 * 1. **A root counts itself, not its absence.** `underAnyOf` puts a root in its own set;
 *    a census that forgot would report every P0 and every epic as unrooted.
 * 2. **A closed parent is walked through, not stopped at.** Two halves, and the suite
 *    needs both because only the second one tells the two readings apart. The shape
 *    bc-rfnr.7's own comment names is an epic that closed over a still-open child: not
 *    parentless by any obvious query — the walk is what finds it. The half that
 *    discriminates is an **open** root above a **closed** middle, where a walk that
 *    stopped at the first closed ancestor would call a perfectly rooted bead an orphan.
 * 3. **A tracker with no roots at all reports no orphans.** The fail-open `hasRootAbove`
 *    already documents, at the scale of a whole workspace rather than one bead.
 * 4. **The two exclusions are by label, never by title** — the Merge #NNN genre, and a
 *    bead already superseded. Both counted into `unrooted` so the total stays honest,
 *    never into `ordinary` — that is the number this bead exists to make visible, and
 *    neither delivery traffic nor work already decided against must move it. Each counts
 *    itself, so `mergeGenre` can never absorb the other one as a residual.
 * 5. **The watch logs a new orphan once, not once per cycle.** The same restraint every
 *    other hold in this app already uses, and the reason a rising count is still
 *    noticeable without being a line every thirty seconds for as long as it holds.
 * 6. **It is wired.** The sweep exists, the cycle calls it, and it reports its own
 *    failure like every other sweep beside it.
 * 7. **A fall is logged too, and a quiet cycle is not** — bc-xl7n.132.2. A bead-naming
 *    line can only ever fire on a rise, which made the last `[census]` line in the log a
 *    high-water mark; `changed` on each counts row is what says an orphan was adopted.
 *    It must not key on the denominator, or a working day is a line every cycle.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-orphancensus-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { orphanCensus, describeOrphan, describeCensus, createOrphanWatch } = await import(LIB('orphancensus.js'));
const { indexFrom, PARENT_EDGE } = await import(LIB('ancestry.js'));
const { NO_ROOT_ABOVE } = await import(LIB('underroot.js'));
const { MERGE_LABEL } = await import(LIB('mergebead.js'));
const { DELIVERY_LABEL } = await import(LIB('delivery.js'));
const { supersedeLabel } = await import(LIB('superseded.js'));

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
};

console.log('\nnothing counts the beads with no root above them\n');

const row = (id, extra = {}) =>
  JSON.stringify({ id, title: `bead ${id}`, status: 'open', priority: 2, labels: [], dependencies: [], ...extra });
const parentEdge = (child, parent) => ({ issue_id: child, depends_on_id: parent, type: PARENT_EDGE });

/**
 * A tracker with one root of each kind this bead has to get right: a P0, an epic at a
 * non-urgent priority (bc-htoy), a root that closed over an open child, an open root
 * with a *closed* bead between it and its grandchild, a Merge #NNN card of each genre,
 * and two beads nothing has ever decided.
 */
const build = () =>
  indexFrom(
    [
      row('zz-mine', { priority: 0 }),
      row('zz-mine.1', { dependencies: [parentEdge('zz-mine.1', 'zz-mine')] }),
      row('zz-epic', { issue_type: 'epic' }),
      row('zz-epic.1', { dependencies: [parentEdge('zz-epic.1', 'zz-epic')] }),
      row('zz-shut', { status: 'closed' }),
      row('zz-shut.1', { dependencies: [parentEdge('zz-shut.1', 'zz-shut')] }),
      // The only shape in this file where "walk through a closed parent" and "stop at the
      // first closed one" disagree: an OPEN root, a closed bead beneath it, and an open
      // bead beneath that. See the check that reads it.
      row('zz-live', { priority: 0 }),
      row('zz-live.1', { status: 'closed', dependencies: [parentEdge('zz-live.1', 'zz-live')] }),
      row('zz-live.1.1', { dependencies: [parentEdge('zz-live.1.1', 'zz-live.1')] }),
      row('zz-orphan'),
      row('zz-orphan2'),
      row('zz-orphan-closed', { status: 'closed' }),
      row('zz-merge-card', { labels: [MERGE_LABEL] }),
      row('zz-delivery-card', { labels: [DELIVERY_LABEL] }),
    ].join('\n')
  );

/**
 * A root, a bead nothing has decided, and a bead already decided *against* — the third
 * population `ordinary` must not count. Kept out of `build()` on purpose: it is the only
 * fixture that needs a `superseded-by:` label, and the counts every check above asserts
 * over `build()` would otherwise all have to move to accommodate it.
 */
const supersededIdx = () =>
  indexFrom(
    [
      row('zz-root', { priority: 0 }),
      row('zz-gone', { labels: [supersedeLabel('zz-root')] }),
      row('zz-orphan'),
    ].join('\n')
  );

/* -------------------------------------------------------------- 1-4. the pure census */

await check('a root counts itself, and its children, as rooted', () => {
  const c = orphanCensus(build());
  assert.equal(c.ordinary.includes('zz-mine'), false);
  assert.equal(c.ordinary.includes('zz-mine.1'), false);
});

await check('AN EPIC AT ANY PRIORITY ROOTS ITS SUBTREE — bc-htoy', () => {
  const c = orphanCensus(build());
  assert.equal(c.ordinary.includes('zz-epic'), false);
  assert.equal(c.ordinary.includes('zz-epic.1'), false);
});

await check('A CLOSED PARENT IS WALKED THROUGH, NOT STOPPED AT', () => {
  // The exact shape bc-rfnr.7's comment names: an open child of a root that has since
  // closed. It has a parent, so no "is it parentless" query finds it — the walk does.
  const c = orphanCensus(build());
  assert.equal(c.ordinary.includes('zz-shut.1'), true);
  // zz-shut itself is closed, so it is not in the non-closed population at all — its
  // closedness is what makes it not a root, not a reason to count it as an orphan too.
  assert.equal(c.ordinary.includes('zz-shut'), false);
  // And the half that actually discriminates, which everything above this line does not:
  // zz-shut is closed *and* P2, so it is not a root under either reading and zz-shut.1 is
  // an ordinary orphan whether the walk stops at a closed parent or goes through it.
  // zz-live.1.1's only route to a root runs *through* the closed zz-live.1 and ends at
  // the open P0 zz-live — so an implementation that stopped at the first closed ancestor
  // would report a perfectly rooted bead as an orphan, which is the refactor the module
  // header names as one of the two traps this suite exists to hold. Measured on
  // 2026-08-24: that mutation leaves this file at 25/25 without this assertion.
  assert.equal(c.ordinary.includes('zz-live.1.1'), false);
  assert.equal(c.ordinary.includes('zz-live'), false);
});

await check('a closed bead is never counted, orphaned or not', () => {
  const c = orphanCensus(build());
  assert.equal(c.ordinary.includes('zz-orphan-closed'), false);
});

await check('two beads nothing has decided are both ordinary orphans', () => {
  const c = orphanCensus(build());
  assert.deepEqual(c.ordinary.sort(), ['zz-orphan', 'zz-orphan2', 'zz-shut.1']);
});

await check('THE MERGE #NNN GENRE IS UNROOTED BUT NEVER ORDINARY', () => {
  const c = orphanCensus(build());
  assert.equal(c.ordinary.includes('zz-merge-card'), false, 'merge-queue');
  assert.equal(c.ordinary.includes('zz-delivery-card'), false, 'pr-delivery');
  // Still counted, so the total is honest — just not into the number this bead is about.
  assert.equal(c.unrooted, c.ordinary.length + c.mergeGenre);
  assert.equal(c.mergeGenre, 2);
});

await check('A SUPERSEDED BEAD IS UNROOTED BUT NEVER ORDINARY', () => {
  // A bead carrying `superseded-by:<id>` has been looked at and decided against, so it is
  // exactly not a bead "nothing has decided above". `strandingsIn` (lib/rootclose.js) and
  // `worthSaying` (lib/epicdone.js) both already drop it; this file used to count it.
  // The label is spelled by lib/superseded.js's own helper, so a change to it lands here.
  const c = orphanCensus(supersededIdx());
  assert.deepEqual(c.ordinary, ['zz-orphan']);
  assert.equal(c.superseded, 1);
  assert.equal(c.unrooted, 2, 'still unrooted — having no root above it is true of it');
});

await check('AND `mergeGenre` DOES NOT ABSORB IT — a residual is only right with one exclusion', () => {
  // `mergeGenre` was `unrooted - ordinary.length`, which reports every non-merge
  // exclusion as a merge card. Each exclusion counts itself now, and the three add up.
  const c = orphanCensus(supersededIdx());
  assert.equal(c.mergeGenre, 0, 'no merge-queue or pr-delivery card in this fixture');
  assert.equal(c.unrooted, c.ordinary.length + c.mergeGenre + c.superseded);
});

await check('a card that is both is reported as what filed it, not as decided against', () => {
  // The documented order — merge genre asked first — so adding an exclusion can never
  // change what an existing one counts.
  const idx = indexFrom(
    [
      row('zz-root', { priority: 0 }),
      row('zz-merge-gone', { labels: [MERGE_LABEL, supersedeLabel('zz-root')] }),
    ].join('\n')
  );
  const c = orphanCensus(idx);
  assert.equal(c.mergeGenre, 1);
  assert.equal(c.superseded, 0);
  assert.deepEqual(c.ordinary, []);
});

await check('nonClosed is every open/in-progress bead, orphan or not', () => {
  const c = orphanCensus(build());
  // Every row above except the three explicitly closed ones (zz-shut, zz-orphan-closed,
  // zz-live.1).
  assert.equal(c.nonClosed, 11);
});

await check('excluded by the label, never by pattern-matching the title', () => {
  // A card that merely mentions "Merge" in its own title, carrying neither label, is an
  // ordinary orphan like any other — the bead's own instruction, asserted rather than
  // trusted. A root beside it so the tracker is not the "nobody has decided anything
  // yet" case the next check is about.
  const idx = indexFrom(
    [row('zz-root', { priority: 0 }), row('zz-Merge-243-lookalike', { title: 'Merge #243 into main' })].join('\n')
  );
  const c = orphanCensus(idx);
  assert.equal(c.ordinary.includes('zz-Merge-243-lookalike'), true);
});

await check('A TRACKER WITH NO ROOTS AT ALL REPORTS NO ORPHANS', () => {
  // The fail-open `hasRootAbove` already documents at bead scale, here at workspace
  // scale: nobody has decided about *anything* yet, so singling every bead out as
  // unrooted would only restate that.
  const idx = indexFrom([row('zz-a'), row('zz-b')].join('\n'));
  const c = orphanCensus(idx);
  assert.equal(c.unrooted, 0);
  assert.deepEqual(c.ordinary, []);
});

await check('an empty or unreadable index counts nothing rather than throwing', () => {
  const nothing = { nonClosed: 0, unrooted: 0, mergeGenre: 0, superseded: 0, ordinary: [] };
  assert.deepEqual(orphanCensus(indexFrom('')), nothing);
  assert.deepEqual(orphanCensus({}), nothing);
  assert.deepEqual(orphanCensus(null), nothing);
});

/* ---------------------------------------------------------------------- describeOrphan */

await check('describeOrphan names the fix and the phrase the pill already uses', () => {
  const line = describeOrphan({ id: 'zz-orphan', ordinary: 3, unrooted: 5, mergeGenre: 2, nonClosed: 40 });
  assert.match(line, /^zz-orphan — /);
  assert.match(line, new RegExp(NO_ROOT_ABOVE));
  assert.match(line, /3 ordinary orphan\(s\) now, of 5 unrooted bead\(s\)/);
  assert.match(line, /40 non-closed/);
});

await check('and says so plainly when it is the only one', () => {
  const line = describeOrphan({ id: 'zz-lonely', ordinary: 1, unrooted: 1, mergeGenre: 0, nonClosed: 9 });
  assert.match(line, /the only ordinary orphan of 1 unrooted bead\(s\)/);
});

await check('nothing to say about a row with no id', () => {
  assert.equal(describeOrphan(null), '');
  assert.equal(describeOrphan({}), '');
});

await check('describeCensus gives the standing number with no bead named', () => {
  const line = describeCensus({ workspace: 'zz', ordinary: 3, unrooted: 5, mergeGenre: 2, nonClosed: 40 });
  assert.equal(line, '3 ordinary orphans, of 5 unrooted bead(s) across 40 non-closed');
});

await check('AND SAYS THE COUNT REACHED ZERO, WHICH NO BEAD-NAMING LINE CAN', () => {
  // The whole reason this second describer exists: `describeOrphan` needs a bead, and
  // the interesting fall is the one that leaves no bead to name.
  assert.equal(describeCensus({ ordinary: 0, unrooted: 0, mergeGenre: 0, nonClosed: 40 }),
    'no ordinary orphans, of 0 unrooted bead(s) across 40 non-closed');
  assert.equal(describeCensus({ ordinary: 1, unrooted: 1, mergeGenre: 0, nonClosed: 9 }),
    '1 ordinary orphan, of 1 unrooted bead(s) across 9 non-closed');
});

await check('a counts row and a newOrphans row are the same shape, so neither describer can be handed the wrong one', () => {
  // `orphanCensus` returns `ordinary` as an array; both describers take it as a number,
  // and a row that carried the array would print "[object Array] ordinary orphans".
  assert.equal(describeCensus(null), '');
  assert.match(describeCensus({ ordinary: 2, unrooted: 2, nonClosed: 2 }), /^2 ordinary orphans,/);
});

/* ------------------------------------------------------------------ 5. the watch */

console.log('\nthe watch logs a new orphan once, not once per cycle\n');

const graphSeq = (...indexes) => {
  let i = 0;
  return {
    graph: async () => {
      const at = Math.min(i, indexes.length - 1);
      i += 1;
      return indexes[at];
    },
  };
};

// A root beside every fixture below — otherwise the tracker has decided nothing about
// *anything*, `orphanCensus`'s own fail-open applies, and every one of these would pass
// for the wrong reason (see the fixed "excluded by the label" check above, which hit
// exactly this).
const withRoot = (...rows) => indexFrom([row('zz-root', { priority: 0 }), ...rows].join('\n'));

await check('the first pass reports every ordinary orphan it finds as new', async () => {
  const idx = withRoot(row('zz-orphan'), row('zz-orphan2'));
  const watch = createOrphanWatch({ bd: graphSeq(idx) });
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(
    out.newOrphans.map((r) => r.id).sort(),
    ['zz-orphan', 'zz-orphan2']
  );
  assert.equal(out.counts[0].workspace, 'zz');
  assert.equal(out.errors.length, 0);
});

await check('AND THE WATCH NEVER SPENDS A LINE NAMING WORK ALREADY DECIDED AGAINST', async () => {
  // The harm end to end: a superseded bead reaching `newOrphans` is a `[census]` line in
  // the daemon log about a duplicate whose real work lives somewhere else.
  const idx = withRoot(row('zz-orphan'), row('zz-gone', { labels: [supersedeLabel('zz-root')] }));
  const watch = createOrphanWatch({ bd: graphSeq(idx) });
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(out.newOrphans.map((r) => r.id), ['zz-orphan']);
  assert.equal(out.counts[0].superseded, 1, 'counted, just not named');
});

await check('a bead already reported does not log again while it stays held', async () => {
  const idx = withRoot(row('zz-orphan'));
  const watch = createOrphanWatch({ bd: graphSeq(idx) });
  const first = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(first.newOrphans.map((r) => r.id), ['zz-orphan']);
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(out.newOrphans, []);
});

await check('but a bead that newly becomes an orphan is reported the moment it does', async () => {
  const before = withRoot(row('zz-orphan'));
  const after = withRoot(row('zz-orphan'), row('zz-orphan2'));
  const watch = createOrphanWatch({ bd: graphSeq(before, after) });
  await watch.sweep([{ name: 'zz' }]);
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(out.newOrphans.map((r) => r.id), ['zz-orphan2']);
});

await check('a bead adopted under a root and later orphaned again is reported twice', async () => {
  const orphaned = withRoot(row('zz-x'));
  const rooted = withRoot(row('zz-x', { dependencies: [parentEdge('zz-x', 'zz-root')] }));
  const watch = createOrphanWatch({ bd: graphSeq(orphaned, rooted, orphaned) });
  const first = await watch.sweep([{ name: 'zz' }]);
  const second = await watch.sweep([{ name: 'zz' }]);
  const third = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(first.newOrphans.map((r) => r.id), ['zz-x']);
  assert.deepEqual(second.newOrphans, []);
  assert.deepEqual(third.newOrphans.map((r) => r.id), ['zz-x']);
});

await check('AN UNREADABLE WORKSPACE HOLDS EVERYTHING IT ALREADY KNEW, RATHER THAN CLEARING IT', async () => {
  const idx = withRoot(row('zz-orphan'));
  let calls = 0;
  const bd = {
    graph: async () => {
      calls += 1;
      if (calls === 2) throw new Error('bd export timed out');
      return idx;
    },
  };
  const watch = createOrphanWatch({ bd });
  const first = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(first.newOrphans.map((r) => r.id), ['zz-orphan']);
  const failed = await watch.sweep([{ name: 'zz' }]);
  assert.equal(failed.errors.length, 1);
  assert.match(failed.errors[0].error, /bd export timed out/);
  // The trap `sweepEpicsDone` already paid for: a failed pass must not report the
  // previously-known orphan as newly cleared, and the *next* good pass must not
  // report it as newly arrived either.
  const recovered = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(recovered.newOrphans, []);
});

await check("an index carrying `.error` — bd.graph's own fail-open — is the same as a throw", async () => {
  const good = withRoot(row('zz-orphan'));
  const bad = { parents: new Map(), beads: new Map(), error: 'bd export timed out' };
  const watch = createOrphanWatch({ bd: graphSeq(good, bad, good) });
  await watch.sweep([{ name: 'zz' }]);
  const failed = await watch.sweep([{ name: 'zz' }]);
  assert.equal(failed.errors.length, 1);
  const recovered = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(recovered.newOrphans, []);
});

/* ------------------------------- 7. a fall is logged too, and a quiet cycle is not */

console.log('\nand the standing number moves in both directions, not only up\n');

await check('the first pass after a restart is a change, so the standing number is said once', async () => {
  const idx = withRoot(row('zz-orphan'));
  const watch = createOrphanWatch({ bd: graphSeq(idx) });
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.equal(out.counts[0].changed, true);
  // Shaped like a newOrphans row — a count, with the ids beside it rather than in place
  // of it, so either row can be handed to either describer.
  assert.equal(out.counts[0].ordinary, 1);
  assert.deepEqual(out.counts[0].ids, ['zz-orphan']);
});

await check('a cycle where nothing moved says nothing at all', async () => {
  const idx = withRoot(row('zz-orphan'));
  const watch = createOrphanWatch({ bd: graphSeq(idx) });
  await watch.sweep([{ name: 'zz' }]);
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.equal(out.counts[0].changed, false);
  assert.deepEqual(out.newOrphans, []);
});

await check('AN ORPHAN ADOPTED IS A CHANGE, THOUGH THERE IS NO BEAD LEFT TO NAME', async () => {
  // The gap this bead is about. `newOrphans` is empty on the fall — it always is — so
  // without `changed` the last [census] line in the log stays the high-water mark.
  const orphaned = withRoot(row('zz-x'));
  const rooted = withRoot(row('zz-x', { dependencies: [parentEdge('zz-x', 'zz-root')] }));
  const watch = createOrphanWatch({ bd: graphSeq(orphaned, rooted) });
  await watch.sweep([{ name: 'zz' }]);
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(out.newOrphans, []);
  assert.equal(out.counts[0].changed, true);
  assert.equal(out.counts[0].ordinary, 0);
  assert.equal(describeCensus(out.counts[0]), 'no ordinary orphans, of 0 unrooted bead(s) across 2 non-closed');
});

await check('THE DENOMINATOR MOVING ON ITS OWN IS NOT A CHANGE', async () => {
  // Somebody filed an ordinary rooted bead. `nonClosed` rises and the orphan picture is
  // untouched — key on that and a working day is one line per workspace per cycle, which
  // is the failure the once-per-spell rule above already exists to avoid.
  const before = withRoot(row('zz-orphan'));
  const after = withRoot(row('zz-orphan'), row('zz-fine', { dependencies: [parentEdge('zz-fine', 'zz-root')] }));
  const watch = createOrphanWatch({ bd: graphSeq(before, after) });
  const first = await watch.sweep([{ name: 'zz' }]);
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.equal(out.counts[0].nonClosed, first.counts[0].nonClosed + 1, 'the denominator did move');
  assert.equal(out.counts[0].changed, false);
});

await check('a merge-genre orphan arriving moves the total, and is a change even though `ordinary` does not move', async () => {
  // `unrooted` is in the signature too, so the honest total is not silently stale.
  const before = withRoot(row('zz-orphan'));
  const after = withRoot(row('zz-orphan'), row('zz-merge-card', { labels: [MERGE_LABEL] }));
  const watch = createOrphanWatch({ bd: graphSeq(before, after) });
  await watch.sweep([{ name: 'zz' }]);
  const out = await watch.sweep([{ name: 'zz' }]);
  assert.equal(out.counts[0].ordinary, 1);
  assert.equal(out.counts[0].unrooted, 2);
  assert.equal(out.counts[0].changed, true);
});

await check('a workspace it could not read leaves its last shape alone, so the next good pass is not a change', async () => {
  // The same trap the fail-open check above pays for, one field over: a failed pass must
  // not make the recovered one look like the count moved.
  const idx = withRoot(row('zz-orphan'));
  let calls = 0;
  const bd = {
    graph: async () => {
      calls += 1;
      if (calls === 2) throw new Error('bd export timed out');
      return idx;
    },
  };
  const watch = createOrphanWatch({ bd });
  await watch.sweep([{ name: 'zz' }]);
  const failed = await watch.sweep([{ name: 'zz' }]);
  assert.deepEqual(failed.counts, []);
  const recovered = await watch.sweep([{ name: 'zz' }]);
  assert.equal(recovered.counts[0].changed, false);
});

/* ---------------------------------------------------------------------- 6. the wiring */

console.log('\nthe sweep is called, and reports its own failure like every sweep beside it\n');

{
  const server = read('lib/server.js');
  await check('the poll cycle calls the sweep', () => assert.match(server, /await sweepOrphanCensus\(\);/));
  await check('and reports its own failure, like every other sweep in the cycle', () =>
    assert.match(server, /sweepFailed\('the orphan-census sweep'/)
  );
  await check('the watcher is built once and held on the app, not per request', () =>
    assert.match(server, /const orphanWatch = createOrphanWatch\(\{ bd \}\);/)
  );
  await check('a workspace it could not read is logged, not swallowed', () =>
    assert.match(server, /\[census\] \$\{bad\.workspace\}: could not read the tracker/)
  );
  await check('THE STANDING NUMBER IS PRINTED OFF `counts`, WHICH NOTHING READ BEFORE', () =>
    assert.match(server, /for \(const row of out\.counts\) \{/)
  );
  await check('and only when it moved, and not twice for a workspace a bead-naming line already spoke for', () =>
    assert.match(server, /if \(!row\.changed \|\| named\.has\(row\.workspace\)\) continue;/)
  );

  const { createApp } = await import(LIB('server.js'));
  const app = createApp({
    host: '127.0.0.1',
    baseUrl: 'http://127.0.0.1',
    token: 'orphancensus-token',
    actor: 'beadcause-test',
    bdBin: path.join(tmp, 'no-such-bd'),
    workspaces: [],
    sessionDirs: {},
    openSessions: false,
    autoDispatch: false,
    pollSeconds: 3600,
    terminal: false,
    port: 0,
    ntfy: { enabled: false },
    advocates: { enabled: false, workspaces: [] },
  });
  await check('and it is on the app object the poll cycle reads', () => assert.equal(typeof app.orphanWatch?.sweep, 'function'));

  const { blankComments } = await import(LIB('evidence.js'));
  const mod = blankComments(read('lib/orphancensus.js'));
  await check('the watcher writes nothing to disk', () => assert.ok(!/CONFIG_DIR|refs\/beadcause|writeFile/.test(mod)));
}

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
