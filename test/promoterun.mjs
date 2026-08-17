/**
 * Carrying a promotion bead — four steps, three states, and a close that has to be earned.
 *
 * bc-y8k4.2. lib/promote.js files the bead; lib/promoterun.js is the half of the release
 * agent that picks one up and carries it, and it is written against a **driver interface**
 * rather than against a pipeline precisely so it can be proved here: no network, no Azure,
 * no `bd`, nothing outside a temp config dir.
 *
 * What is worth a suite, in the order it goes wrong:
 *
 * 1. **The order and the stopping.** Four calls, always the same order, and a UAT failure
 *    must stop *before* `promoteToProd` — so the fake driver records what it was asked, and
 *    the assertion is on that list rather than on a returned summary.
 * 2. **Cannot-say is not failure and is not success.** A driver that throws, a step that
 *    answers with nothing recognisable, a test that passes without naming a check, a deploy
 *    that passes without naming an image: all four neither close the bead nor promote.
 * 3. **The same image.** `promoteToProd` is handed the digest UAT tested and must come back
 *    with it. A different one is a positive answer that production holds something else,
 *    which is the one thing the four-step order exists to prevent — so it is `failed` and
 *    not cannot-say.
 * 4. **The record.** What was deployed and what was checked goes on the bead whatever the
 *    outcome, because a run that stopped in UAT is the one whose record matters most.
 * 5. **The seam with lib/promote.js.** The repos are parsed out of the body `filePromotion`
 *    writes, so one case files a real promotion bead and carries the very bead that was
 *    filed. A body whose Repos line moved would otherwise be a release agent that refuses
 *    every promotion on this tracker, with both files passing their own tests.
 *
 *     npm test
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

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-promoterun-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { assertDriver, carry, epicOf, isEndorsed, openPromotions, readStep, reposOf, stateOf, STEPS, PASSED, FAILED, UNKNOWN } =
  await import(LIB('promoterun.js'));
const { filePromotion } = await import(LIB('promote.js'));
const { validatePlan } = await import(LIB('plan.js'));

const WS = { name: 'alpha', dir: path.join(tmp, 'beads', 'alpha', '.beads') };
const IMAGE = 'registry.example/alpha@sha256:abc123';

/* ------------------------------------------------------------------ fixtures */

const BODY = ['Every bead under **x-1** is closed.', '', '**Repos** (one image each): `alpha`', '', '- `x-1.2`'].join('\n');

const promotionBead = (over = {}) => ({
  id: 'p-1',
  title: 'Promote x-1 — the epic that landed',
  description: BODY,
  status: 'open',
  assignee: '',
  labels: ['promote'],
  ...over,
});

/** A graph index of the shape `Bd.graph` answers with — closed rows and labels included. */
const index = (rows, parentOf) => ({
  parents: new Map(Object.entries(parentOf)),
  beads: new Map(rows.map((r) => [r.id, r])),
  adopts: new Map(),
  edges: new Map(),
});

const work = (over = {}) =>
  index(
    [
      { id: 'x-1', title: 'the epic', status: 'open', issue_type: 'epic', labels: [] },
      { id: 'x-1.2', title: 'the work that landed', status: 'closed', labels: [] },
      ...(over.extra || []),
    ],
    { 'x-1.2': 'x-1', ...(over.parents || {}) }
  );

/**
 * A `bd` that remembers what was written to it and nothing more.
 *
 * Every write a run makes is on here, so the assertions can be about what ended up on the
 * bead rather than about what `carry` said it did — which is the difference between testing
 * the record and testing the report of the record.
 */
function fakeBd({ row = promotionBead(), graph = work(), fail = {} } = {}) {
  const bd = {
    row,
    comments: [],
    closed: [],
    assigned: [],
    statuses: [],
    reopened: [],
    show: async () => (fail.show ? Promise.reject(new Error(fail.show)) : row),
    graph: async () => (fail.graph ? { error: fail.graph, beads: new Map(), parents: new Map() } : graph),
    assign: async (_ws, id, who) => bd.assigned.push(`${id}:${who}`),
    setStatus: async (_ws, id, status) => {
      if (fail.claim) throw new Error(fail.claim);
      bd.statuses.push(`${id}:${status}`);
    },
    comment: async (_ws, id, textIn) => {
      if (fail.comment) throw new Error(fail.comment);
      bd.comments.push({ id, text: textIn });
    },
    close: async (_ws, id, reason) => {
      if (fail.close) throw new Error(fail.close);
      bd.closed.push({ id, reason });
    },
    reopenAbandoned: async (_ws, id) => bd.reopened.push(id),
    listLabel: async () => [row],
  };
  return bd;
}

/**
 * The fake driver — one scripted answer per call, and a log of what it was asked.
 *
 * The log is the point. "It stopped before promoting" is only provable by the promotion
 * never having been asked for; a run that called `promoteToProd` and then reported having
 * stopped would pass any assertion made on its own summary.
 */
function fakeDriver(answers = {}) {
  const asked = [];
  const driver = { asked };
  for (const step of STEPS) {
    driver[step.call] = async (ctx) => {
      asked.push({ call: step.call, ...ctx });
      const answer = answers[step.call];
      if (typeof answer === 'function') return answer(ctx);
      if (answer instanceof Error) throw answer;
      return answer ?? { state: PASSED, ...(step.verb === 'deploy' || step.verb === 'promote' ? { image: IMAGE } : {}), ...(step.verb === 'test' ? { checks: [{ name: `${step.env}:smoke`, state: PASSED }] } : {}) };
    };
  }
  return driver;
}

const calls = (driver) => driver.asked.map((a) => a.call);

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

/* ---------------------------------------------------------------- the passing run */

await check('all four pass in order, the bead is claimed, and only then is it closed', async () => {
  const bd = fakeBd();
  const driver = fakeDriver();
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });

  assert.equal(run.refused, undefined, 'nothing refused it');
  assert.deepEqual(calls(driver), ['deployToUat', 'testInUat', 'promoteToProd', 'testInProd'], 'four, in that order');
  assert.deepEqual(bd.assigned, ['p-1:release-agent'], 'claimed the way every other agent here claims work');
  assert.deepEqual(bd.statuses, ['p-1:in_progress'], 'and the assignee is written before the status, never after');
  assert.equal(run.closed, true);
  assert.equal(run.promoted, true);
  assert.deepEqual(bd.closed.map((c) => c.id), ['p-1'], 'closed exactly once');
  assert.match(bd.closed[0].reason, /verified in production/i);
  assert.match(bd.closed[0].reason, /sha256:abc123/, 'and the close reason names the image, which is what a promotion is');
  assert.deepEqual(bd.reopened, [], 'a closed bead is not handed back as well');
});

await check('the image UAT tested is the image production is asked to promote', async () => {
  const driver = fakeDriver();
  await carry(fakeBd(), WS, 'p-1', driver, { actor: 'release-agent' });
  const promote = driver.asked.find((a) => a.call === 'promoteToProd');
  assert.equal(promote.image, IMAGE, 'never "the latest build" — the digest deployToUat named');
  assert.equal(driver.asked.find((a) => a.call === 'testInProd').image, IMAGE);
});

await check('the test steps are told what the epic actually closed, asked of the tracker now', async () => {
  const driver = fakeDriver();
  await carry(fakeBd(), WS, 'p-1', driver, { actor: 'release-agent' });
  const uat = driver.asked.find((a) => a.call === 'testInUat');
  assert.deepEqual(uat.work.map((b) => b.id), ['x-1.2'], 'bc-y8k4.1: derived, not read off a frozen body');
  assert.equal(uat.epic, 'x-1');
  assert.equal(uat.repo, 'alpha');
});

/* ------------------------------------------------------------------- a failure */

await check('a UAT failure stops before production is ever asked to promote', async () => {
  const bd = fakeBd();
  const driver = fakeDriver({
    testInUat: { state: FAILED, checks: [{ name: 'uat:login', state: FAILED, detail: 'HTTP 500' }] },
  });
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });

  assert.deepEqual(calls(driver), ['deployToUat', 'testInUat'], 'the promotion was never requested');
  assert.equal(run.promoted, false);
  assert.equal(run.closed, false);
  assert.deepEqual(bd.closed, [], 'and nothing closed the bead');
  assert.deepEqual(bd.reopened, ['p-1'], 'handed back unclaimed, or no later run could pick it up');
  assert.equal(run.handedBack, true);
});

await check('the handback names the environment and the check that failed', async () => {
  const bd = fakeBd();
  const driver = fakeDriver({
    testInUat: { state: FAILED, checks: [{ name: 'uat:login', state: FAILED, detail: 'HTTP 500' }] },
  });
  await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });
  const [{ text }] = bd.comments;
  assert.match(text, /Stopped in \*\*uat\*\*/, 'which environment');
  assert.match(text, /`uat:login`/, 'and what failed in it');
  assert.match(text, /HTTP 500/, 'with the driver\'s own words, not a paraphrase');
  assert.match(text, /Not closed/, 'said plainly, because a card that stops explaining is one nobody chases');
});

await check('a production failure leaves the bead open — the image is promoted and nothing is verified', async () => {
  const bd = fakeBd();
  const run = await carry(
    bd,
    WS,
    'p-1',
    fakeDriver({ testInProd: { state: FAILED, checks: [{ name: 'prod:smoke', state: FAILED }] } }),
    { actor: 'release-agent' }
  );
  assert.equal(run.promoted, true, 'it did reach production');
  assert.equal(run.closed, false, 'and that is not what closes it');
  assert.deepEqual(bd.closed, []);
  assert.match(bd.comments[0].text, /Stopped in \*\*production\*\*/);
});

/* ------------------------------------------------------------------ cannot say */

await check('a driver that throws is cannot-say, and cannot-say neither closes nor promotes', async () => {
  const bd = fakeBd();
  const driver = fakeDriver({ testInUat: new Error('the pipeline API timed out') });
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });

  assert.equal(run.state, UNKNOWN, 'a throw is ignorance, not a verdict');
  assert.deepEqual(calls(driver), ['deployToUat', 'testInUat'], 'nothing promoted');
  assert.deepEqual(bd.closed, []);
  assert.match(bd.comments[0].text, /cannot say/);
  assert.match(bd.comments[0].text, /timed out/, 'and the reason survives onto the bead');
  assert.match(bd.comments[0].text, /Cannot-say neither closes nor promotes/);
});

await check('a step answering with nothing recognisable is cannot-say, never a pass', async () => {
  const run = await carry(fakeBd(), WS, 'p-1', fakeDriver({ testInUat: { detail: 'ran, I think' } }), {
    actor: 'release-agent',
  });
  assert.equal(run.state, UNKNOWN);
  assert.equal(run.closed, false);
});

await check('a test that passes without naming one check has not distinguished this release from the last', async () => {
  const bd = fakeBd();
  const run = await carry(bd, WS, 'p-1', fakeDriver({ testInUat: { state: PASSED, checks: [] } }), {
    actor: 'release-agent',
  });
  assert.equal(run.state, UNKNOWN, 'a green deploy of the previous image looks identical from outside');
  assert.equal(run.closed, false);
  assert.match(bd.comments[0].text, /without naming a single check/);
});

await check('a deploy that passes without naming an image cannot be promoted', async () => {
  const bd = fakeBd();
  const driver = fakeDriver({ deployToUat: { state: PASSED } });
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });
  assert.equal(run.state, UNKNOWN);
  assert.deepEqual(calls(driver), ['deployToUat'], 'nothing is tested against an image nobody can name');
  assert.match(bd.comments[0].text, /nothing can promote what it cannot name/);
});

await check('a passed step over an unknown check is unknown; over a failed check it is failed', async () => {
  const step = STEPS[1];
  const unsure = readStep(step, { state: PASSED, checks: [{ name: 'a', state: PASSED }, { name: 'b' }] });
  assert.equal(unsure.state, UNKNOWN, 'the checks outrank the summary');
  const bad = readStep(step, { state: PASSED, checks: [{ name: 'a', state: FAILED }] });
  assert.equal(bad.state, FAILED, 'and a step cannot talk its way up from a failed check');
  assert.match(bad.detail, /reported passed over a failed check/);
});

/* ---------------------------------------------------------------- the same image */

await check('production coming back with a different image is a failure, not an ignorance', async () => {
  const bd = fakeBd();
  const run = await carry(
    bd,
    WS,
    'p-1',
    fakeDriver({ promoteToProd: { state: PASSED, image: 'registry.example/alpha@sha256:different' } }),
    { actor: 'release-agent' }
  );
  assert.equal(run.state, FAILED, 'a positive answer that production holds something else');
  assert.equal(run.closed, false);
  assert.match(bd.comments[0].text, /the same image or it is a rebuild/);
});

/* -------------------------------------------------------------------- the record */

await check('what was deployed and what was checked is on the bead, whatever the outcome', async () => {
  const bd = fakeBd();
  await carry(bd, WS, 'p-1', fakeDriver(), { actor: 'release-agent' });
  const [{ id, text }] = bd.comments;
  assert.equal(id, 'p-1', 'on the bead, not only in a log');
  assert.match(text, /\*\*Image\*\* — `registry\.example\/alpha@sha256:abc123`/);
  assert.match(text, /\*\*UAT deploy\*\* — passed/);
  assert.match(text, /\*\*UAT tests\*\* — passed — `uat:smoke` passed/);
  assert.match(text, /\*\*production tests\*\* — passed — `production:smoke` passed/);
  assert.match(text, /\*\*What it was carrying\*\* \(1 closed under `x-1`\): `x-1\.2`/);
  assert.match(text, /Production is verified, so p-1 is closed\./);
});

await check('the steps that never ran say so rather than being left out', async () => {
  const bd = fakeBd();
  await carry(bd, WS, 'p-1', fakeDriver({ deployToUat: { state: FAILED, detail: 'stage red' } }), {
    actor: 'release-agent',
  });
  const [{ text }] = bd.comments;
  assert.match(text, /\*\*UAT tests\*\* — not reached/);
  assert.match(text, /\*\*production promote\*\* — not reached/);
  assert.match(text, /\*\*production tests\*\* — not reached/);
});

await check('open work under the epic is named on the record — this promotion is not all of it', async () => {
  const graph = work({
    extra: [{ id: 'x-1.3', title: 'still in flight', status: 'open', labels: [] }],
    parents: { 'x-1.3': 'x-1' },
  });
  const bd = fakeBd({ graph });
  await carry(bd, WS, 'p-1', fakeDriver(), { actor: 'release-agent' });
  assert.match(bd.comments[0].text, /\*\*Still open under `x-1`\*\* \(1\)[^\n]*`x-1\.3`/, 'bc-4bet.2, seen from the last place it can be caught');
});

await check('a record that will not write is a warning, and does not stop the close', async () => {
  const bd = fakeBd({ fail: { comment: 'dolt lock' } });
  const run = await carry(bd, WS, 'p-1', fakeDriver(), { actor: 'release-agent' });
  assert.equal(run.recorded, false);
  assert.equal(run.closed, true, 'production is verified either way; the record is not the evidence');
  assert.match(run.warn.join(' '), /could not write the run/);
});

await check('a close that will not take is loudly owed, never silently dropped', async () => {
  const bd = fakeBd({ fail: { close: 'blocked by x-9' } });
  const run = await carry(bd, WS, 'p-1', fakeDriver(), { actor: 'release-agent' });
  assert.equal(run.closed, false);
  assert.match(run.warn.join(' '), /production is verified but p-1 would not close/);
  assert.deepEqual(bd.reopened, [], 'and it is not handed back either — the work is done');
});

/* ------------------------------------------------------------------- refusals */

const refusals = [
  ['a bead that is not a promotion bead', { row: promotionBead({ labels: ['ship'] }) }, /not a promotion bead/],
  ['a bead that is already closed', { row: promotionBead({ status: 'closed' }) }, /already closed/],
  [
    'a bead nobody has endorsed — the hold is the whole gate between a sweep and production',
    { row: promotionBead({ labels: ['promote', 'unendorsed'] }) },
    /not endorsed/,
  ],
  [
    'a bead another agent is holding',
    { row: promotionBead({ status: 'in_progress', assignee: 'someone-else' }) },
    /held by someone-else/,
  ],
  ['a bead whose title does not name its epic', { row: promotionBead({ title: 'Release the thing' }) }, /does not name the epic/],
  ['a bead naming no repo', { row: promotionBead({ description: 'no repos here' }) }, /names no repo/],
  [
    'a bead spanning more than one repo, which is bc-y8k4.4',
    { row: promotionBead({ description: BODY.replace('`alpha`', '`alpha`, `beta`') }) },
    /covers 2 repos.*bc-y8k4\.4/,
  ],
  ['a tracker that will not say what the epic closed', { fail: { graph: 'bd export timed out' } }, /nothing to exercise/],
  ['a tracker that will not answer at all', { fail: { show: 'no such workspace' } }, /could not read p-1/],
  ['a bead that cannot be claimed', { fail: { claim: 'lock contention' } }, /could not claim p-1/],
];

for (const [name, opts, re] of refusals) {
  await check(`refused, before anything is driven: ${name}`, async () => {
    const bd = fakeBd(opts);
    const driver = fakeDriver();
    const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });
    assert.match(run.refused || '', re);
    assert.deepEqual(calls(driver), [], 'a refusal drives nothing');
    assert.deepEqual(bd.closed, [], 'and closes nothing');
    assert.deepEqual(bd.comments, [], 'and writes nothing on a bead it never took');
  });
}

await check('a driver missing one of the four is refused before the bead is ever claimed', async () => {
  const bd = fakeBd();
  const half = fakeDriver();
  delete half.promoteToProd;
  const run = await carry(bd, WS, 'p-1', half, { actor: 'release-agent' });
  assert.match(run.refused, /no promoteToProd/);
  assert.deepEqual(bd.assigned, [], 'nothing claimed, so nothing is left in_progress with an image half way to UAT');
  assert.throws(() => assertDriver({}), /no deployToUat, no testInUat, no promoteToProd, no testInProd/);
  assert.equal(assertDriver(fakeDriver()).deployToUat.constructor.name, 'AsyncFunction', 'and a whole one comes straight back');
});

/* ------------------------------------------------------------------ the parsing */

await check('the epic and the repos are read out of what lib/promote.js actually writes', async () => {
  const created = [];
  const bd = {
    graph: async () => work(),
    create: async (_ws, spec) => {
      created.push(spec);
      return 'p-9';
    },
    addLabel: async () => {},
  };
  const plan = validatePlan(
    {
      groups: [
        {
          name: 'first',
          beads: ['x-1.2'],
          prs: [{ repo: 'alpha', title: 'the work' }],
          prompt: 'Do the one bead the plan named as one change.',
        },
      ],
    },
    { epic: 'x-1', children: null }
  );
  const filed = await filePromotion(bd, WS, { id: 'x-1', title: 'the epic that landed', labels: [] }, plan);
  assert.equal(filed.filed, 'p-9');

  // The bead as it would come back off the tracker — the two files' seam, and a body whose
  // Repos line moved would be a release agent that refuses every promotion on this Mac.
  const row = { id: 'p-9', title: created[0].title, description: created[0].body, status: 'open', labels: created[0].labels };
  assert.equal(epicOf(row), 'x-1');
  assert.deepEqual(reposOf(row), ['alpha']);

  assert.deepEqual(created[0].labels, ['promote', 'unendorsed'], 'filed held, as every bead this daemon files for itself is');
  const held = await carry(fakeBd({ row }), WS, 'p-9', fakeDriver(), { actor: 'release-agent' });
  assert.match(held.refused, /not endorsed/, 'so the bead as filed is refused until somebody agrees to it');

  const endorsed = { ...row, labels: ['promote'] };
  const driver = fakeDriver();
  const run = await carry(fakeBd({ row: endorsed }), WS, 'p-9', driver, { actor: 'release-agent' });
  assert.equal(run.refused, undefined, 'and once endorsed it carries as it stands, with nothing rewritten by hand');
  assert.equal(run.repo, 'alpha');
});

await check('stateOf never guesses: only the three words, or a plain boolean, are an answer', async () => {
  assert.equal(stateOf({ state: 'passed' }), PASSED);
  assert.equal(stateOf({ state: 'FAILED' }), FAILED);
  assert.equal(stateOf(true), PASSED);
  assert.equal(stateOf(false), FAILED);
  assert.equal(stateOf({ ok: true }), PASSED);
  assert.equal(stateOf({ state: 'green' }), UNKNOWN, 'a word nobody agreed on settles nothing');
  assert.equal(stateOf(null), UNKNOWN);
  assert.equal(stateOf({}), UNKNOWN);
});

await check('the pick-up is every promotion bead nobody has closed', async () => {
  const rows = [
    promotionBead(),
    promotionBead({ id: 'p-2', status: 'closed' }),
    promotionBead({ id: 'p-3', labels: ['promote', 'unendorsed'] }),
  ];
  const found = await openPromotions({ listLabel: async () => rows }, WS);
  assert.deepEqual(found.map((r) => r.id), ['p-1'], 'a closed promotion is not work waiting, and a held one is not picked up');
  assert.equal(isEndorsed(rows[2]), false, 'and the filter and the refusal read the same label');
  assert.deepEqual(await openPromotions({}, WS), [], 'and a bd that cannot list is an empty list, not a crash');
});

/* --------------------------------------------------------------------- report */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
if (failures) process.exit(1);
console.log('all good');
