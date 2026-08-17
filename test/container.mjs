#!/usr/bin/env node
/**
 * The furniture — a standing root is not work, and nothing may open a session on one.
 *
 *     npm test
 *     node test/container.mjs
 *
 * bc-xl7n.14. bc-w156 says of itself "a permanent container, not a piece of work" and its
 * acceptance says the root must exist and not be closed; bc-xl7n is the unsorted backlog
 * everything nobody has placed yet is filed under. Both sentences were prose, and the
 * dispatcher did the opposite of both: a childless P0 epic is never a batch head
 * (`batchesFor` skips anything below `minBatchBeads`) and so falls through to *ordinary
 * worker dispatch*, whose one sanctioned ending is `bin/deliver.js -b <bead>` — which
 * closes it. An advocate tick that found a standing root ready therefore opened a session
 * whose success deleted the root from the board. Three windows landed on that state in two
 * days and all three escaped by reading the prose, which is exactly the protection
 * lib/superseded.js exists to replace.
 *
 * Seven properties, in the order they would break in:
 *
 * 1. **The marker is one string.** Read off `labels` with the same trim as every other
 *    marker in the family — three spellings is the same as no hold.
 * 2. **No queue can contain one, and no caller can ask for one.** `QUEUE_EXCLUDED` carries
 *    it *and* `Bd.ready` forces it on, so a caller that passes its own exclude list — or
 *    none — still cannot be handed a container. Asserted on the arguments and on the rows,
 *    because bd honouring `--exclude-label` is not something this repo gets to assume.
 * 3. **The door refuses.** `openWorkSession` is asserted against the real
 *    `openWorkSession`: a unit test of `isContainer` would pass just as happily against a
 *    launcher that never called it.
 * 4. **So does the planner's door**, and it lands hardest there — a planner's job is to cut
 *    an epic into the children that finish it, and a standing root is never finished.
 * 5. **THE P0 ADVOCATE'S DOOR DOES NOT**, which is the only asymmetry between the three and
 *    the one thing in this file most likely to be "fixed" by somebody tidying. An
 *    EpicAdvocate is re-entrant, belongs to its epic for the epic's life, files children
 *    *under* the root and never closes it — it is what a standing root is *for*.
 * 6. **The gates are layers, not a replacement for each other.** A container that is also
 *    unendorsed fails on endorsement, with endorsement's own error.
 * 7. **A container is still a root.** It is still a P0 in `rootsOf`, so its children are
 *    still workable and a bead filed under it is still under a P0 — the acceptance
 *    criterion that says a container stays a valid parent and stays on the board. The board
 *    itself needs no change and gets none: `rootBoard` is built from `bd.graph`, never from
 *    `bd.ready`, so the filter here cannot reach it.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-container-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { CONTAINER, isContainer, refusal, assertNotContainer } = await import(LIB('container.js'));
const { QUEUE_EXCLUDED, UNENDORSED } = await import(LIB('endorse.js'));
const { Bd } = await import(LIB('bd.js'));
const { rootsOf, hasRootAbove } = await import(LIB('underroot.js'));
const { indexFrom, PARENT_EDGE } = await import(LIB('ancestry.js'));
const { openWorkSession, openPlanSession, openEpicAdvocateSession } = await import(LIB('session.js'));

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

console.log('\na standing root is furniture, not work\n');

const WS = { name: 'zz', dir: tmp };
const container = (id, extra = {}) => ({
  id,
  title: `standing root ${id}`,
  status: 'open',
  priority: 0,
  issue_type: 'epic',
  labels: [CONTAINER, 'owner:adam@example.com'],
  ...extra,
});

/* ------------------------------------------------------------------ the marker */

await check('the marker is one string, read off labels and trimmed', () => {
  assert.equal(CONTAINER, 'container');
  assert.equal(isContainer(container('zz-root')), true);
  assert.equal(isContainer({ labels: [' container '] }), true, 'bd does not normalise labels');
  assert.equal(isContainer({ labels: ['containers', 'not-a-container'] }), false, 'and it is not a prefix match');
  assert.equal(isContainer({}), false);
  assert.equal(isContainer(null), false);
});

await check('the refusal is the family shape — 409, a named boolean, and it names the fix', () => {
  const err = refusal('zz-root');
  assert.equal(err.status, 409);
  assert.equal(err.container, true);
  assert.match(err.message, /zz-root may not be worked/);
  // Whoever reads this is holding a bead they thought was work, so the sentence has to
  // say where the work actually goes rather than only that this is not it. Same argument
  // lib/underroot.js's message makes, and for the same reason: nothing clears this hold.
  assert.match(err.message, /children|file a new one under it/);
  assert.throws(() => assertNotContainer(container('zz-root')), (e) => e.container === true);
  assert.equal(assertNotContainer({ id: 'zz-work', labels: [] }).id, 'zz-work');
});

/* ------------------------------------------------------------------- the queue */

/**
 * `Bd.ready` with the `bd` spawn replaced, so the assertion is about this file's rule and
 * not about whether bd is installed on the machine running the suite.
 *
 * Both halves are asserted because they fail apart: the arguments prove the exclusion was
 * *asked for* (which is what keeps a busy workspace's rows off the wire), and the returned
 * rows prove it is enforced here as well (which is what holds if a future bd changes what
 * `--exclude-label` means). `Bd.ready` already belts-and-braces the same way for
 * `unendorsed` and `ship`.
 */
const readyWith = (rows) => {
  const bd = new Bd({ bin: 'bd', actor: 'beadcause' });
  const asked = [];
  bd.json = async (_ws, args) => {
    asked.push(args);
    return rows;
  };
  return { bd, asked };
};

await check('QUEUE_EXCLUDED carries the marker, beside human, unendorsed and ship', () => {
  assert.ok(QUEUE_EXCLUDED.includes(CONTAINER), 'the advocate survey would count containers as waiting work');
});

await check('NO CALLER CAN ASK FOR A QUEUE CONTAINING ONE', async () => {
  // No exclude list at all — the default caller, and the one a future call site is most
  // likely to be. `Bd.ready` forces the marker on regardless, which is the whole reason it
  // is forced there rather than left to `QUEUE_EXCLUDED`.
  const { bd, asked } = readyWith([container('zz-root'), { id: 'zz-root.1', labels: [] }]);
  const rows = await bd.ready(WS);
  assert.deepEqual(rows.map((r) => r.id), ['zz-root.1'], 'a container was handed out as ready work');
  assert.ok(asked[0].join(' ').includes(`--exclude-label ${CONTAINER}`), 'and bd was never asked to leave it out');
});

await check('and a caller that asks for its own exclusions does not lose it', async () => {
  const { bd } = readyWith([container('zz-root')]);
  assert.deepEqual(await bd.ready(WS, { excludeLabels: ['human'] }), []);
});

/* -------------------------------------------------------------------- the door */

/**
 * The launcher, asked for real.
 *
 * `openWorkSession` refuses in this order — endorsed, superseded, closed, ship, container,
 * then no-P0-above — so the fake tracker has to answer a bead that passes the first four
 * and fails on this one. Nothing is stubbed past that point: if the gate were not wired
 * in, the call would go on to resolve a checkout and try to open an iTerm window, which is
 * a very different failure from the one asserted here.
 */
const INDEX = indexFrom(
  [
    JSON.stringify({ id: 'zz-root', title: 'the standing root', status: 'open', priority: 0, labels: [CONTAINER, 'owner:adam@example.com'], dependencies: [] }),
    JSON.stringify({ id: 'zz-root.1', title: 'real work', status: 'open', priority: 2, labels: [], dependencies: [{ issue_id: 'zz-root.1', depends_on_id: 'zz-root', type: PARENT_EDGE }] }),
  ].join('\n')
);
const bdFor = (issue) => ({ graph: async () => INDEX, show: async () => issue });

await check('THE WORKER DOOR REFUSES A CONTAINER', async () => {
  const issue = container('zz-root');
  await assert.rejects(
    () => openWorkSession({}, WS, issue, { bd: bdFor(issue) }),
    (e) => e.status === 409 && e.container === true
  );
});

await check("THE PLANNER'S DOOR REFUSES ONE TOO — a shelf is never finished", async () => {
  const issue = container('zz-root');
  await assert.rejects(
    () => openPlanSession({}, WS, issue, { bd: bdFor(issue) }),
    (e) => e.status === 409 && e.container === true
  );
});

await check('THE P0 ADVOCATE DOOR DOES NOT — that agent is what a standing root is for', async () => {
  // Asserted without opening a window: `openEpicAdvocateSession` runs the four shared
  // gates and *then* asks `wantsAdvocate`, which says no to a P0 nobody owns. So an
  // unowned container gets past this file and dies on that — proving the container gate is
  // not in this door, with nothing reaching `launch`. A container gate here would take the
  // one agent that looks after standing roots and point it at everything except them.
  const issue = container('zz-root', { labels: [CONTAINER] });
  await assert.rejects(
    () => openEpicAdvocateSession({}, WS, issue, { bd: bdFor(issue) }),
    (e) => e.container !== true && /advocate|owner/i.test(e.message)
  );
});

await check('and it is a layer, not a replacement for the first four', async () => {
  // A container that is also unendorsed fails on endorsement, with endorsement's own
  // error. A bug that let this gate shadow the others would read as "the container marker
  // broke endorsement".
  const issue = container('zz-root', { labels: [CONTAINER, UNENDORSED] });
  await assert.rejects(
    () => openWorkSession({}, WS, issue, { bd: bdFor(issue) }),
    (e) => e.status === 409 && e.unendorsed === true && !e.container
  );
});

/* ------------------------------------------------------- and still a root */

await check('A CONTAINER IS STILL A P0 ROOT, so its children are still workable', () => {
  // The acceptance criterion that keeps this from being a way to delete a subtree: the
  // marker says "do not work *this*", never "do not work under this". `rootsOf` is the
  // set `rootBoard` measures `unhomed` against and the set lib/underroot.js gates on, so this
  // one assertion covers both the board and the rule.
  assert.ok(rootsOf(INDEX.beads).has('zz-root'), 'the container stopped being a root');
  assert.equal(hasRootAbove(INDEX, 'zz-root.1'), true, 'and its children stopped being workable');
});

await check('and a bead filed under one is ordinary work — in the queue, and past this gate', async () => {
  // Deliberately not driven through `openWorkSession`: past the four refusals that door
  // runs, the next thing it does is resolve a checkout and hand an AppleScript to iTerm,
  // and a suite that opens a real window is a suite nobody can run twice. The two things
  // this file could get wrong about a child are both here — the queue filter matching too
  // widely, and the gate refusing on ancestry rather than on the bead in front of it.
  const kid = { id: 'zz-root.1', title: 'real work', status: 'open', labels: [] };
  assert.equal(assertNotContainer(kid).id, 'zz-root.1');
  const { bd } = readyWith([container('zz-root'), kid]);
  assert.deepEqual((await bd.ready(WS, { excludeLabels: QUEUE_EXCLUDED })).map((r) => r.id), ['zz-root.1']);
});

/* ------------------------------------------------------------------------ done */

cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
