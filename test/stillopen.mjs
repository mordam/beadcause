/**
 * Nothing may open a work session on a bead that is already closed — bc-uaxn.
 *
 * The incident: a worker window was handed a full brief for bc-ikj6 seventy-eight minutes
 * after bin/deliver.js closed it and #173 had merged. What makes that more than a wasted
 * hour is the brief's own first instruction — `bd update <id> --claim` sets `in_progress`,
 * which on a closed bead *reopens merged work* and hands it back to the next advocate tick
 * to open another window on. So the test has two halves, matching the two layers:
 *
 * 1. **The refusal.** `openWorkSession` and `openPlanSession` ask the tracker themselves
 *    and refuse, off the row `assertEndorsed` already fetched. This is the guarantee, and
 *    it is asserted against a *caller-supplied row that says open* — because the whole
 *    shape of the bug is a queue row that was true when the survey ran and is not now.
 * 2. **The brief.** `workPromptFor` says what to do when `bd show` answers `CLOSED`, since
 *    the refusal only covers the doors this daemon owns and the incident's launch path
 *    could never be established from what was left on disk.
 *
 * No `bd` binary and no world file: `assertEndorsed` calls `bd.show(workspace, id)` and
 * nothing else here needs a tracker, so the stub is four lines and the test says exactly
 * what it depends on. `sessionDirs` is deliberately real — a refusal that only happened
 * because the directory was missing would prove nothing about the status.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-stillopen-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { isClosed, closeReasonOf, assertStillOpen } = await import(LIB('stillopen.js'));
const { openWorkSession, openPlanSession, workPromptFor } = await import(LIB('session.js'));

const ws = { name: 'demo', dir: tmp };
const cfg = { sessionDirs: { demo: tmp }, openSessions: true };

/** A tracker that answers `show` with one row, and is asked nothing else. */
const trackerSaying = (row) => ({ show: async () => row });

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

console.log('\nnothing may open a work session on a closed bead\n');

/* --------------------------------------------------------------- the status itself */

await check('closed is closed however the tracker spells it, and nothing else is', () => {
  assert.equal(isClosed({ status: 'closed' }), true);
  assert.equal(isClosed({ status: 'CLOSED' }), true, 'case is not a second status');
  assert.equal(isClosed({ status: ' closed ' }), true, 'nor is a stray space');
  // The ones that must stay workable, and `in_progress` is the load-bearing one: attempt 2
  // on a bead the previous window claimed and abandoned is an ordinary retry, and refusing
  // it would turn every abandoned session into a bead nothing may pick up again.
  for (const status of ['open', 'in_progress', 'blocked', 'deferred', '', undefined]) {
    assert.equal(isClosed({ status }), false, `${status} is not closed`);
  }
});

await check('the close reason rides into the message, from either spelling', () => {
  assert.equal(closeReasonOf({ close_reason: 'landed as #173' }), 'landed as #173');
  assert.equal(closeReasonOf({ closeReason: 'landed as #173' }), 'landed as #173');
  assert.equal(closeReasonOf({ close_reason: 'landed as #173\nand deployed' }), 'landed as #173', 'one line');
  assert.equal(closeReasonOf({}), '');
});

await check('the gate refuses a closed bead and passes an open one', () => {
  assert.throws(
    () => assertStillOpen({ id: 'zz-done', status: 'closed', close_reason: 'landed as #173' }),
    (err) => err.status === 409 && err.closed === true && /already closed/.test(err.message) && /#173/.test(err.message),
    'a caller can tell this from a launch that failed, and must not retry it'
  );
  assert.equal(assertStillOpen({ id: 'zz-work', status: 'open' }).id, 'zz-work');
});

/* ------------------------------------------------------------------ the refusal */

await check('openWorkSession refuses a bead the tracker says is closed', async () => {
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-done', title: 'already landed' }, {
      bd: trackerSaying({ id: 'zz-done', status: 'closed', labels: [], close_reason: 'landed as #173' }),
    }),
    (err) => err.status === 409 && err.closed === true,
    'this is the guarantee — no queue filter can be, because the bead closed after the queue was built'
  );
});

await check('and it reads the status off the tracker, not off the row it was handed', async () => {
  // The exact shape of bc-ikj6: a queue row that was true when the survey ran, handed to
  // the launcher seventy-eight minutes later. If the gate trusted the argument it would
  // open the window, and the brief's third line would reopen the bead.
  await assert.rejects(
    () => openWorkSession(cfg, ws, { id: 'zz-done', title: 'already landed', status: 'open', labels: [] }, {
      bd: trackerSaying({ id: 'zz-done', status: 'closed', labels: [] }),
    }),
    (err) => err.closed === true,
    'a caller-supplied row proves nothing about a bead'
  );
});

await check('openPlanSession refuses it too — a planner reopens its epic as its last act', async () => {
  await assert.rejects(
    () => openPlanSession(cfg, ws, { id: 'zz-epic', title: 'a finished epic' }, {
      kids: [],
      bd: trackerSaying({ id: 'zz-epic', status: 'closed', labels: [] }),
    }),
    (err) => err.status === 409 && err.closed === true,
    'bin/plan.js ends with `bd update --status open`, so a planner on a closed epic un-closes it'
  );
});

await check('an open bead gets past the gate — and is stopped by the missing directory instead', async () => {
  // Aimed at a directory that is not there, which is test/endorse.mjs's device and is here
  // for its reason: nothing in this file may actually open a window, so the positive case
  // has to fail *after* the gates and before AppleScript. That the failure is a directory
  // rather than a 409 about the status is the whole assertion — it places the gate.
  const nowhere = { sessionDirs: { demo: path.join(tmp, 'no-such-checkout') }, openSessions: true };
  await assert.rejects(
    () => openWorkSession(nowhere, ws, { id: 'zz-work', title: 'ordinary work' }, {
      bd: trackerSaying({ id: 'zz-work', status: 'open', labels: [] }),
    }),
    (err) => err.closed !== true,
    'the gate must not be what stops ordinary work'
  );
});

/* -------------------------------------------------------------------- the brief */

await check('the brief tells the window what to do when bd show says CLOSED', async () => {
  const prompt = workPromptFor('demo', { id: 'zz-work', title: 'ordinary work' }, 1, null, 'Adam', {});

  // Order is the whole of it: reading the status has to come before claiming, because the
  // claim is the destructive step. `bd show` is line one of Start, `--claim` is line three.
  const show = prompt.indexOf(`bd show zz-work`);
  const claim = prompt.indexOf(`bd update zz-work --claim`);
  assert.ok(show !== -1 && claim !== -1, 'both instructions are in the brief');
  assert.ok(show < claim, 'and the status is read before the bead is claimed');

  assert.match(prompt, /CLOSED/, 'it names the answer it is warning about');
  assert.match(prompt, /reopens work that has already merged|reopen/i, 'and says what claiming would do');
  // The instruction has to be *stop*, not "proceed carefully": a window that keeps going
  // finds nothing to do and files something, which is the wasted hour with a bead attached.
  assert.ok(
    /do not claim it, and stop|end the session/i.test(prompt),
    'and says to stop rather than to be careful'
  );
});

/* -------------------------------------------------------------------- the result */

console.log(`\n${ran - failures}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
