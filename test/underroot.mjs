#!/usr/bin/env node
/**
 * The teeth — a bead with nothing decided above it is not workable.
 *
 *     npm test
 *     node test/underroot.mjs
 *
 * bc-rfnr.7, and the bead the whole epic is load-bearing on: bc-rfnr.2 draws an inbox of
 * P0 descendants, and without this the advocate goes on opening unattended sessions on
 * everything the screen no longer shows. That state — work happening all night with
 * nothing on the phone accounting for it — is strictly worse than the flat list it
 * replaced, which is why the rule and the screen have to land together.
 *
 * Six properties, in the order they would break in:
 *
 * 1. **A root is workable, and so is anything under one.** The rule is not "has a parent";
 *    it is "has a root above it", and a root passes its own test. This is also bc-rfnr.4
 *    working with no special case: a crash the app filed on itself is a P0 by
 *    construction (lib/errors.js), so it stays a leaf you can work directly.
 *
 *    **A root is a P0 *or* an epic at any priority since bc-htoy** (`isRoot`,
 *    lib/ownership.js), and the widening is asserted in both directions here: a P2 epic
 *    roots its own subtree, and a P2 *task* still roots nothing. Widened rather than
 *    replaced, which is why the crash property above still holds — those beads are P0
 *    tasks, and an epic-only rule would have made the app's own stack traces unworkable.
 * 2. **Somebody else's P0 is still a P0.** The board is `ownedByMe` because a screen
 *    answers "what am I answerable for"; the gate is not, because it answers "did
 *    anybody decide this". Scoping it to your own would break a shared graph on the day
 *    it gained a second person — which is the whole of bc-y3qk.
 * 3. **A closed P0 is not a root.** The case bc-rfnr.7's own comment says to decide
 *    rather than inherit. It is decided the way `rootBoard` already decides it, because a
 *    bead dispatched all night while invisible on the phone is the one combination this
 *    epic exists to make impossible.
 * 4. **An unreadable graph withholds nothing.** Deliberately the opposite of
 *    `assertEndorsed`: there the evidence is one bead, here it is the whole workspace,
 *    so failing closed would stop every session on the Mac on a Dolt write lock — and it
 *    would look exactly like a quiet night. Asserted in all four of its shapes, because
 *    this is the branch that turns a rule into an outage.
 * 5. **The refusal is a refusal.** Same shape as lib/endorse.js, lib/superseded.js and
 *    lib/stillopen.js — a 409 with a named boolean — so a caller can tell it from a
 *    launch that failed, and the sentence names the fix, since nothing clears this hold
 *    on its own.
 * 6. **The door actually asks.** `openWorkSession` is asserted against a real
 *    `openWorkSession`, not reasoned about: a unit test of `hasRootAbove` would pass just
 *    as happily against a launcher that never called it, which is the mistake
 *    test/ownership.mjs already names for the owner stamp.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-underroot-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { NO_ROOT_ABOVE, rootsOf, hasRootAbove, refusal, assertUnderRoot } = await import(LIB('underroot.js'));
const { indexFrom, PARENT_EDGE } = await import(LIB('ancestry.js'));
const { openWorkSession } = await import(LIB('session.js'));

/* --------------------------------------------------------------------- harness */

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

console.log('\na bead nothing has decided is not work\n');

const row = (id, extra = {}) =>
  JSON.stringify({ id, title: `bead ${id}`, status: 'open', priority: 2, labels: [], dependencies: [], ...extra });
const parentEdge = (child, parent) => ({ issue_id: child, depends_on_id: parent, type: PARENT_EDGE });

/**
 * A tracker with one P0 of yours, one of somebody else's, one that has closed over an
 * open child, a crash P0, and two beads nothing has ever decided.
 */
const INDEX = indexFrom(
  [
    row('zz-mine', { priority: 0, labels: ['owner:adam@example.com'] }),
    row('zz-mine.1', { dependencies: [parentEdge('zz-mine.1', 'zz-mine')] }),
    row('zz-mine.1.1', { dependencies: [parentEdge('zz-mine.1.1', 'zz-mine.1')] }),
    row('zz-theirs', { priority: 0, labels: ['owner:bob@example.com'] }),
    row('zz-theirs.1', { dependencies: [parentEdge('zz-theirs.1', 'zz-theirs')] }),
    row('zz-done', { priority: 0, status: 'closed', labels: ['owner:adam@example.com'] }),
    row('zz-done.1', { dependencies: [parentEdge('zz-done.1', 'zz-done')] }),
    row('zz-crash', { priority: 0, issue_type: 'bug', labels: ['app-error', 'owner:adam@example.com'] }),
    // bc-htoy: an epic at a priority nobody would call urgent, and a child under it. Both
    // were unworkable until the rule widened, and the epic is deliberately P2 — the same
    // priority as every other row here, so nothing about it but its *type* can be what
    // makes it a root.
    row('zz-epic', { issue_type: 'epic', labels: ['owner:adam@example.com'] }),
    row('zz-epic.1', { dependencies: [parentEdge('zz-epic.1', 'zz-epic')] }),
    row('zz-orphan'),
    // The shape the comment on bc-rfnr.7 names: an open child of a *non*-P0 parent that
    // has since closed. Not parentless by any obvious query, and still under nothing.
    row('zz-shut', { status: 'closed' }),
    row('zz-shut.1', { dependencies: [parentEdge('zz-shut.1', 'zz-shut')] }),
  ].join('\n')
);

/* ------------------------------------------------------------------- the roots */

await check('the roots are the open P0s and the open epics, whoever owns them', () => {
  assert.deepEqual([...rootsOf(INDEX.beads)].sort(), ['zz-crash', 'zz-epic', 'zz-mine', 'zz-theirs']);
});

await check('AN EPIC AT ANY PRIORITY IS A ROOT — bc-htoy', () => {
  // The whole of the widening, and the two halves that have to hold together. zz-epic is
  // P2, exactly like zz-orphan and zz-shut: if the type were not being read, it would be
  // in neither list.
  assert.equal(rootsOf(INDEX.beads).has('zz-epic'), true, 'a P2 epic roots work');
  assert.equal(hasRootAbove(INDEX, 'zz-epic'), true, 'and is above itself, like every other root');
  assert.equal(hasRootAbove(INDEX, 'zz-epic.1'), true, 'so its children are workable without touching a priority');
  // And the half that must not have widened with it: a P2 task is still nothing decided.
  // The rule reached epics, not everything below P0.
  assert.equal(rootsOf(INDEX.beads).has('zz-orphan'), false, 'a P2 task is still not a root');
});

await check('A CLOSED P0 IS NOT A ROOT', () => {
  // The decision bc-rfnr.7 asked for, and it is `rootBoard`'s: a P0 that landed is off the
  // board and stops pulling its descendants in with it. If the gate disagreed, zz-done.1
  // would be dispatched every night while being invisible on the phone.
  assert.equal(rootsOf(INDEX.beads).has('zz-done'), false);
  assert.equal(hasRootAbove(INDEX, 'zz-done.1'), false);
});

/* -------------------------------------------------------------------- the rule */

await check('a P0 is above itself, so a P0 is workable', () => {
  assert.equal(hasRootAbove(INDEX, 'zz-mine'), true);
  assert.equal(hasRootAbove(INDEX, 'zz-theirs'), true);
});

await check('A CRASH P0 IS DISPATCHABLE DIRECTLY — bc-rfnr.4', () => {
  // No special case anywhere: lib/errors.js files it at P0, so it is its own root. The
  // exemption it *does* need is from the EpicAdvocate, and that is `wantsAdvocate`'s
  // (test/epicadvocate.mjs). Both halves have to hold or a stack trace either gets a
  // planning agent or gets stuck.
  assert.equal(hasRootAbove(INDEX, 'zz-crash'), true);
});

await check('anything under a P0 is workable, at any depth', () => {
  assert.equal(hasRootAbove(INDEX, 'zz-mine.1'), true);
  assert.equal(hasRootAbove(INDEX, 'zz-mine.1.1'), true);
});

await check('SOMEBODY ELSE’S P0 IS STILL A P0', () => {
  // The gate asks whether anybody decided this, not whether you did. A six-person squad
  // sharing one graph (bc-y3qk) would otherwise have five sixths of its tracker refused.
  assert.equal(hasRootAbove(INDEX, 'zz-theirs.1'), true);
});

await check('and a bead with nothing above it is not workable', () => {
  assert.equal(hasRootAbove(INDEX, 'zz-orphan'), false);
  assert.equal(hasRootAbove(INDEX, 'zz-nothing-like-this'), false);
});

await check('INCLUDING ONE WHOSE CHAIN DEAD-ENDS IN A CLOSED NON-P0', () => {
  // The case that will recur every time a non-P0 parent closes over an open child, which
  // is ordinary. It has a parent, so no "is it parentless" query finds it; the walk does.
  assert.equal(hasRootAbove(INDEX, 'zz-shut.1'), false);
});

/* --------------------------------------------------------------- the fail-open */

await check('AN UNREADABLE GRAPH WITHHOLDS NOTHING, IN ALL FOUR OF ITS SHAPES', () => {
  // The branch that turns a rule into an outage. `Bd.graph` answers an empty shape on a
  // failed export rather than throwing, so every one of these is a state the daemon can
  // genuinely be in — and every one of them means "nothing to be sure about", not "stop".
  const empty = indexFrom('');
  assert.equal(hasRootAbove(empty, 'zz-orphan'), true, 'an export that came back empty');
  assert.equal(hasRootAbove({}, 'zz-orphan'), true, 'no index at all');
  assert.equal(hasRootAbove(null, 'zz-orphan'), true, 'not even an object');
  const noRoots = indexFrom([row('zz-a'), row('zz-b')].join('\n'));
  assert.equal(hasRootAbove(noRoots, 'zz-a'), true, 'a workspace nobody has filed an epic or a P0 in');
});

/* ----------------------------------------------------------------- the refusal */

await check('the refusal is a 409 with a named boolean, like its three siblings', () => {
  const err = refusal('zz-orphan');
  assert.equal(err.status, 409);
  assert.equal(err.noRoot, true);
  assert.match(err.message, /zz-orphan/);
  assert.match(err.message, new RegExp(NO_ROOT_ABOVE));
  // It names the fix, unlike the other three: nothing clears this hold on its own.
  assert.match(err.message, /adopt it under an epic/i);
  // And it offers the cheap fix first. Before bc-htoy the only remedy this sentence named
  // was raising a P0, which is why so many beads were adopted under an urgency nobody
  // meant; the priority is still on offer, second.
  assert.match(err.message, /raise a P0/i);
});

const graphOf = (index) => ({ graph: async () => index });

await check('assertUnderRoot passes a bead under a P0 and refuses one under nothing', async () => {
  const bd = graphOf(INDEX);
  await assertUnderRoot(bd, { name: 'zz' }, { id: 'zz-mine.1' });
  await assert.rejects(() => assertUnderRoot(bd, { name: 'zz' }, { id: 'zz-orphan' }), (e) => e.noRoot === true);
});

await check('and a caller with no bd is not refused — no evidence may not empty a queue', async () => {
  await assertUnderRoot(null, { name: 'zz' }, { id: 'zz-orphan' });
  await assertUnderRoot({}, { name: 'zz' }, { id: 'zz-orphan' });
});

/* ------------------------------------------------------------------- the door */

/**
 * The launcher, asked for real.
 *
 * `openWorkSession` refuses in this order — endorsed, superseded, closed, then this — so
 * the fake tracker has to answer a bead that passes the first three and fails only the
 * fourth. Nothing is stubbed past that point: if the gate were not wired in, the call
 * would go on to resolve a checkout and try to open an iTerm window, which is a very
 * different failure from the one asserted here.
 */
const bdFor = (index, issue) => ({
  graph: async () => index,
  show: async () => issue,
});

await check('THE DOOR REFUSES A BEAD WITH NO P0 ABOVE IT', async () => {
  const issue = { id: 'zz-orphan', title: 'a bead nobody decided', status: 'open', labels: [] };
  await assert.rejects(
    () => openWorkSession({}, { name: 'zz', dir: tmp }, issue, { bd: bdFor(INDEX, issue) }),
    (e) => e.status === 409 && e.noRoot === true
  );
});

await check('and it is the fourth refusal, not a replacement for the first', async () => {
  // A held bead under a perfectly good P0 still fails on endorsement, with endorsement's
  // own error — the two gates are layers, and a bug that made this one shadow the others
  // would read as "the epic board broke endorsement".
  const issue = { id: 'zz-mine.1', title: 'held', status: 'open', labels: ['unendorsed'] };
  await assert.rejects(
    () => openWorkSession({}, { name: 'zz', dir: tmp }, issue, { bd: bdFor(INDEX, issue) }),
    (e) => e.status === 409 && e.unendorsed === true && !e.noRoot
  );
});

/* ------------------------------------------------------------------------ done */

cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
