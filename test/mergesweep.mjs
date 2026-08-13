#!/usr/bin/env node
/**
 * **The trigger** — the four ways a merge lands, and the one sweep behind all of them.
 *
 *     npm test
 *     node test/mergesweep.mjs
 *
 * lib/prsweep.js decides *which* pull requests a merge put out of date, and
 * test/prsweep.mjs covers that. This is the other half: a merge has landed somewhere,
 * and the sweep has to happen exactly once, in the daemon, without the merge waiting for
 * it. Five ways that goes wrong, and none of them shows up on a screen:
 *
 * 1. **A door that does not record its merge.** There are four — a delivery card and the
 *    PR board (lib/server.js), `beadcause-deliver`, and `reconcileLanded` for a merge
 *    made on github.com — and the one that gets missed is the one that looks broken
 *    exactly when Adam happens to merge that way. Each is asserted where it can actually
 *    be pressed — test/mergeclose.mjs answers a delivery card, test/boardmerge.mjs posts
 *    to `/api/pr/merge`, test/landed.mjs sweeps a merge made on github.com — and all
 *    three read the record back off disk. `beadcause-deliver` is the one with no harness,
 *    being a process that merges and exits, so its door is read out of the source here
 *    the way test/crash.mjs reads the poll cycle.
 * 2. **A record acted on twice.** `takeSweepRequests` empties the file before anything
 *    is swept, because the one thing a second sweep can do that the first did not is
 *    open a second resolver window on a branch that already has one — bc-utyr, the
 *    incident lib/resolvers.js exists for.
 * 3. **Two merges into one repo costing two sweeps.** Records are keyed by repo and the
 *    higher pull request number wins, so a busy cycle is one sweep and the resolver's
 *    brief names the merge that moved the base last.
 * 4. **A record outliving its merge.** A daemon that was down for a day would otherwise
 *    come up and open windows for a merge from yesterday.
 * 5. **A request that throws at a merge that already landed.** Every caller here has
 *    merged something on GitHub by the time it writes one. `requestSweep` returning
 *    `null` is the whole of what a failure may cost.
 *
 * The sweep itself is injected — nothing in this repo's tests may open an iTerm window —
 * and the config directory is a scratch one, so the real `~/.config/beadcause` is never
 * read or written.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

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
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mergesweep-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

// Imported after the env is set: CONFIG_DIR resolves once, at module load.
const { MERGE_SWEEPS_PATH, readSweepRequests, requestSweep, sweepMerged, describeSweepOutcome } = await import(LIB('mergesweep.js'));

const reset = () => fs.rmSync(MERGE_SWEEPS_PATH, { force: true });

/** A workspace of one repo, with a checkout on disk so `resolveSessionDir` can answer. */
const checkout = path.join(tmp, 'demo-checkout');
fs.mkdirSync(checkout, { recursive: true });
const cfg = { workspaces: [{ name: 'demo', dir: path.join(tmp, 'demo') }], sessionDirs: { demo: checkout } };

/* ------------------------------------------------------------ one record */

console.log('a merge records where it landed');

reset();
const rec = requestSweep({ workspace: 'demo', key: 'demo', number: 42, base: 'main', why: 'a delivery card in demo' });
check('the record comes back', rec?.key === 'demo' && rec.number === 42, JSON.stringify(rec));
check('and it is on disk', fs.existsSync(MERGE_SWEEPS_PATH));
check('keyed by the repo', Object.keys(readSweepRequests()).join(',') === 'demo', JSON.stringify(readSweepRequests()));
check('carrying the base it merged into', readSweepRequests().demo.base === 'main');
check('and why, so the log can name the door', readSweepRequests().demo.why === 'a delivery card in demo');

// The one field a caller may not have. A worker that merged a pull request always knows
// its number; `reconcileLanded` closing a card over a merge with no bead behind it may
// not, and the brief has a sentence for that case rather than a `Number(null)`.
reset();
requestSweep({ workspace: 'demo', key: 'demo' });
check('a merge that cannot name its pull request still records', readSweepRequests().demo.number === null);
check('and gets the default base', readSweepRequests().demo.base === 'main');

check('a record with no workspace is refused outright', requestSweep({ key: 'demo' }) === null);
check('and one with no repo key', requestSweep({ workspace: 'demo' }) === null);

/* -------------------------------------------------------- two merges, one sweep */

console.log('\ntwo merges into one repo are one sweep');

reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 42, why: 'first' });
requestSweep({ workspace: 'demo', key: 'demo', number: 51, why: 'second' });
check('one record, not two', Object.keys(readSweepRequests()).length === 1);
check('and it names the later merge', readSweepRequests().demo.number === 51);

// Out of order, which is what two processes racing look like: the worker's delivery and
// the advocate's landed sweep can write within a moment of each other in either order.
reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 51 });
requestSweep({ workspace: 'demo', key: 'demo', number: 42 });
check('the higher number wins whichever order they arrive in', readSweepRequests().demo.number === 51);

reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 51 });
requestSweep({ workspace: 'demo', key: 'demo', number: null });
check('and a request that cannot name one does not erase the one that could', readSweepRequests().demo.number === 51);

reset();
requestSweep({ workspace: 'demo', key: 'climative/athena-service', number: 3 });
requestSweep({ workspace: 'demo', key: 'climative/frontend-base', number: 4 });
check('two repos are two records — a merge in one cannot conflict the other', Object.keys(readSweepRequests()).length === 2);

/* ---------------------------------------------------------------- the drain */

console.log('\nthe daemon takes them and sweeps once each');

reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 42, base: 'main' });
const calls = [];
const spy = async (bd, c, opts) => {
  calls.push(opts);
  return { key: 'demo', refused: null, error: null, handed: [], queued: [] };
};
let out = await sweepMerged({}, cfg, { sweep: spy });
check('the sweep ran once', calls.length === 1, JSON.stringify(calls));
check('for the workspace named on the record', calls[0]?.ws?.name === 'demo');
check('in the checkout that workspace resolves to', calls[0]?.dir === checkout, String(calls[0]?.dir));
check('told which merge set it off', calls[0]?.after === 42);
check('and which base moved', calls[0]?.base === 'main');
check('the outcome says it swept', out[0]?.status === 'swept', JSON.stringify(out));
check('nothing worth a log line about a sweep that worked', describeSweepOutcome(out[0]) === '');

// The whole of point 2. A record left behind is a second window on a branch that
// already has one, hours later, with nobody at the Mac.
check('the record is gone', Object.keys(readSweepRequests()).length === 0, JSON.stringify(readSweepRequests()));
calls.length = 0;
out = await sweepMerged({}, cfg, { sweep: spy });
check('so the next cycle sweeps nothing', calls.length === 0 && out.length === 0);

// And taken *before* the sweep, not after it: a sweep that dies halfway must not leave a
// record that opens its windows again on the next cycle.
reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 42 });
const thrower = async () => {
  throw new Error('gh exploded');
};
out = await sweepMerged({}, cfg, { sweep: thrower });
check('a sweep that throws does not throw at the cycle', out[0]?.status === 'swept', JSON.stringify(out));
check('it is reported instead', /gh exploded/.test(out[0]?.result?.error || ''), JSON.stringify(out[0]));
check('and the record is still gone', Object.keys(readSweepRequests()).length === 0);

/* ------------------------------------------------------------ the refusals */

console.log('\nand the records it will not act on');

reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 42, at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() });
calls.length = 0;
out = await sweepMerged({}, cfg, { sweep: spy });
check('a record older than the queue TTL is dropped', out[0]?.status === 'stale', JSON.stringify(out));
check('without sweeping anything', calls.length === 0);
check('and it says how old it was', /5h ago/.test(describeSweepOutcome(out[0])), describeSweepOutcome(out[0]));

reset();
requestSweep({ workspace: 'gone', key: 'gone', number: 1 });
calls.length = 0;
out = await sweepMerged({}, cfg, { sweep: spy });
check('a workspace that is no longer configured is dropped', out[0]?.status === 'gone', JSON.stringify(out));
check('with a sentence naming it', /not a configured workspace/.test(describeSweepOutcome(out[0])), describeSweepOutcome(out[0]));
check('and nothing was swept', calls.length === 0);

reset();
requestSweep({ workspace: 'demo', key: 'demo', number: 42 });
calls.length = 0;
out = await sweepMerged({}, { ...cfg, pr: { enabled: false } }, { sweep: spy });
check('pull requests off in config sweeps nothing', out[0]?.status === 'off' && calls.length === 0, JSON.stringify(out));
check('and says nothing about it either — it is configuration, not news', describeSweepOutcome(out[0]) === '');

// Point 5. Something is in the way of the file, and a merge that has landed on GitHub is
// not undone by that. A directory where the file goes is the cheapest way to stage it and
// it is a real state: a stray `mkdir`, a sync client, a half-restored config directory.
reset();
fs.mkdirSync(MERGE_SWEEPS_PATH, { recursive: true });
let threw = null;
let refused;
try {
  refused = requestSweep({ workspace: 'demo', key: 'demo', number: 42 });
} catch (err) {
  threw = err;
}
check('a config directory that will not take the file does not throw', !threw, String(threw));
check('it answers null and the merge stands', refused === null, JSON.stringify(refused));
check('and the drain reads it as nothing waiting rather than falling over', (await sweepMerged({}, cfg, { sweep: spy })).length === 0);
fs.rmSync(MERGE_SWEEPS_PATH, { recursive: true, force: true });

/* -------------------------------------------------- the doors, one at a time */

console.log('\nevery door into main asks for one');

// github.com's merge button is the one door with no code of its own here: it is noticed
// after the fact by `reconcileLanded`, which has a tracker, a fortnight of merged pull
// requests and a close gate in front of it. Asserting it needs all of those, so it is
// asserted in test/landed.mjs beside the fast-forward it shares a gate with, and what is
// checked here is only that the call is still there to be asserted.
const landed = fs.readFileSync(LIB('landed.js'), 'utf8');
check('a merge on github.com asks for a sweep once it has closed something', /request\(\{/.test(landed), 'nothing in lib/landed.js');
check(
  'behind the same gate as the fast-forward, so a quiet tick costs no `gh`',
  landed.indexOf('if (out.closed.length || out.cards.length) {') < landed.indexOf('out.swept = request({'),
  'the request is outside the gate'
);

/* --------------------------------------------------- and the two in the daemon */

// Read from the source, deliberately. Both live inside `resolveDeliveryFor` and the
// `/api/pr/merge` handler, behind a real `gh pr merge` — standing a daemon up and
// stubbing GitHub to watch a JSON file appear would be a test of the stub. What can go
// wrong and be invisible is the *wiring*: a door that never calls it at all.
console.log('\nand the doors that need a harness to press');

const server = fs.readFileSync(LIB('server.js'), 'utf8');
const deliver = fs.readFileSync(path.join(HERE, '..', 'bin', 'deliver.js'), 'utf8');
// The two taps are asserted where they can be pressed: test/mergeclose.mjs answers a
// delivery card and test/boardmerge.mjs posts to `/api/pr/merge`, both against a real
// server and a fake `gh`, and both then read the record back off disk. A worker's own
// delivery has no such harness — it is a process that merges and exits — so what is
// checked for that door is the call and the shape of it.
check('a worker that merges its own pull request asks for a sweep', /requestSweep\(\{ workspace: ws\.name/.test(deliver), 'nothing in bin/deliver.js');
check(
  'and nothing in bin/deliver.js sweeps in its own process',
  !/sweepConflicts/.test(deliver),
  'a worker sweeping in-process cannot see the daemon resolvers — bc-utyr'
);
check(
  'the daemon drains them in the poll cycle',
  /await sweepMerges\(\);/.test(server) && /sweepFailed\('the conflict sweep'/.test(server),
  'no drain in the cycle, or no failure report around it'
);
// The ordering that costs a whole cycle when it is wrong: the advocate tick is what
// notices a merge on github.com and records one of these.
check(
  'after the advocate tick, so a merge it just found is swept in the same cycle',
  server.indexOf('await app.advocates?.tick();') < server.indexOf('await sweepMerges();'),
  'the drain runs before the tick that fills it'
);

/* ------------------------------------------------------------------ done */

await cleanupTmp(tmp);
console.log(`\n${failures ? `${failures} of ${ran} failed` : `${ran} passed`}`);
process.exit(failures ? 1 : 0);
