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
 * 6. **A result that is partial** (bc-y8k4.4). Three repos, and one of them red: the other
 *    two must not be thrown away, the bead must not close, and the next run must not deploy
 *    a repo that is already in production. The fake `bd` reads back exactly what was written
 *    to it, so a resumed run here is a real one — the second `carry` parses the first one's
 *    ledger out of the comment the first one actually wrote. The trap the assertions are
 *    aimed at is a repo whose UAT passed and whose production was held back: its last step
 *    says `passed`, and writing *that* into the ledger as verified would skip a repo that
 *    has never been near production, for good.
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

const {
  assertDriver,
  carry,
  epicOf,
  isEndorsed,
  ledgerFrom,
  openPromotions,
  parseRun,
  readStep,
  reposOf,
  stateOf,
  RUN_CLOSE,
  RUN_OPEN,
  STEPS,
  PASSED,
  FAILED,
  UNKNOWN,
} = await import(LIB('promoterun.js'));
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
    written: [],
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
      bd.written.push({ id, text: textIn });
    },
    close: async (_ws, id, reason) => {
      if (fail.close) throw new Error(fail.close);
      bd.closed.push({ id, reason });
    },
    reopenAbandoned: async (_ws, id) => bd.reopened.push(id),
    listLabel: async () => [row],
    // What was written *is* what is read back, which is what makes a resumed run testable
    // for real: carry twice against one of these and the second run reads the first run's
    // ledger off the comment the first run actually wrote. bc-y8k4.4.
    comments: async () => {
      if (fail.readComments) throw new Error(fail.readComments);
      return bd.written.map((c) => ({ text: c.text }));
    },
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
  const [{ text }] = bd.written;
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
  assert.match(bd.written[0].text, /Stopped in \*\*production\*\*/);
});

/* ------------------------------------------------------------------ cannot say */

await check('a driver that throws is cannot-say, and cannot-say neither closes nor promotes', async () => {
  const bd = fakeBd();
  const driver = fakeDriver({ testInUat: new Error('the pipeline API timed out') });
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });

  assert.equal(run.state, UNKNOWN, 'a throw is ignorance, not a verdict');
  assert.deepEqual(calls(driver), ['deployToUat', 'testInUat'], 'nothing promoted');
  assert.deepEqual(bd.closed, []);
  assert.match(bd.written[0].text, /cannot say/);
  assert.match(bd.written[0].text, /timed out/, 'and the reason survives onto the bead');
  assert.match(bd.written[0].text, /Cannot-say neither closes nor promotes/);
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
  assert.match(bd.written[0].text, /without naming a single check/);
});

await check('a deploy that passes without naming an image cannot be promoted', async () => {
  const bd = fakeBd();
  const driver = fakeDriver({ deployToUat: { state: PASSED } });
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });
  assert.equal(run.state, UNKNOWN);
  assert.deepEqual(calls(driver), ['deployToUat'], 'nothing is tested against an image nobody can name');
  assert.match(bd.written[0].text, /nothing can promote what it cannot name/);
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
  assert.match(bd.written[0].text, /the same image or it is a rebuild/);
});

/* -------------------------------------------------------------------- the record */

await check('what was deployed and what was checked is on the bead, whatever the outcome', async () => {
  const bd = fakeBd();
  await carry(bd, WS, 'p-1', fakeDriver(), { actor: 'release-agent' });
  const [{ id, text }] = bd.written;
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
  const [{ text }] = bd.written;
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
  assert.match(bd.written[0].text, /\*\*Still open under `x-1`\*\* \(1\)[^\n]*`x-1\.3`/, 'bc-4bet.2, seen from the last place it can be caught');
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

/* ----------------------------------------------------- more than one repo (bc-y8k4.4) */

/** The same bead, spanning three repos — the Repos line `filePromotion` writes for one. */
const REPOS = ['alpha', 'beta', 'gamma'];
const manyBead = (over = {}) =>
  promotionBead({ description: BODY.replace('`alpha`', REPOS.map((r) => `\`${r}\``).join(', ')), ...over });

/** One image per repo, so "the same image" can be wrong per repo rather than globally. */
const img = (repo) => `registry.example/${repo}@sha256:abc123`;

/**
 * A driver that answers per repo, and can be told to answer differently for one of them.
 *
 * `only` is what makes the interesting cases readable: `{ testInProd: { beta: {…} } }` is
 * "everything is green except beta in production", which is the partial result this whole
 * shape exists for.
 */
function manyDriver(only = {}) {
  const answer = (call, ctx, fallback) => {
    const per = only[call];
    const said = per && Object.prototype.hasOwnProperty.call(per, ctx.repo) ? per[ctx.repo] : null;
    if (said instanceof Error) throw said;
    return said ?? fallback;
  };
  return fakeDriver({
    deployToUat: (ctx) => answer('deployToUat', ctx, { state: PASSED, image: img(ctx.repo) }),
    testInUat: (ctx) => answer('testInUat', ctx, { state: PASSED, checks: [{ name: `uat:${ctx.repo}`, state: PASSED }] }),
    promoteToProd: (ctx) => answer('promoteToProd', ctx, { state: PASSED, image: ctx.image }),
    testInProd: (ctx) => answer('testInProd', ctx, { state: PASSED, checks: [{ name: `prod:${ctx.repo}`, state: PASSED }] }),
  });
}

const asked = (driver) => driver.asked.map((a) => `${a.call}:${a.repo}`);
const ledgerOn = (bd, n = 0) => parseRun(bd.written[n].text);
const rowFor = (bd, repo, n = 0) => ledgerOn(bd, n).repos.find((r) => r.repo === repo);

await check('three repos: every one of them through UAT before any of them reaches production', async () => {
  const bd = fakeBd({ row: manyBead() });
  const driver = manyDriver();
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });

  assert.deepEqual(
    asked(driver),
    [
      'deployToUat:alpha', 'testInUat:alpha',
      'deployToUat:beta', 'testInUat:beta',
      'deployToUat:gamma', 'testInUat:gamma',
      'promoteToProd:alpha', 'testInProd:alpha',
      'promoteToProd:beta', 'testInProd:beta',
      'promoteToProd:gamma', 'testInProd:gamma',
    ],
    'UAT for all three first — the cheap place to find out the third is red is before the first is live'
  );
  assert.equal(run.closed, true, 'and with all three verified it closes');
  assert.deepEqual(run.legs.map((l) => l.image), REPOS.map(img), 'one image per repo, and each promote got its own');
  assert.match(bd.closed[0].reason, /3 repos/);
  for (const repo of REPOS) assert.match(bd.closed[0].reason, new RegExp(`\`${repo}\``), `${repo} is named in the close`);
  assert.equal(run.repo, '', 'the flattened single-repo fields are empty rather than naming one of three');
});

await check('one repo failing in production leaves the other two promoted and the bead open', async () => {
  const bd = fakeBd({ row: manyBead() });
  const run = await carry(bd, WS, 'p-1', manyDriver({ testInProd: { beta: { state: FAILED, checks: [{ name: 'prod:beta', state: FAILED, detail: 'HTTP 500' }] } } }), {
    actor: 'release-agent',
  });

  assert.equal(run.closed, false, 'two of three is not a promotion');
  assert.deepEqual(bd.closed, []);
  assert.deepEqual(bd.reopened, ['p-1'], 'handed back so a later run can finish beta');
  assert.deepEqual(run.legs.filter((l) => l.verified).map((l) => l.repo), ['alpha', 'gamma']);

  const [{ text }] = bd.written;
  assert.match(text, /\*\*Still owed\*\* \(1 of 3\)[^\n]*`beta`/, 'what is still owed, on the card');
  assert.match(text, /2 of 3 repos are verified in production/);
  assert.match(text, /`alpha`, `gamma` are promoted and stay that way\./, 'and the two that passed are not thrown away');
  assert.match(text, /HTTP 500/, "with the driver's own words about the one that did not");
});

await check('the ledger says which repos are in production, and a later run does not touch those', async () => {
  const bd = fakeBd({ row: manyBead() });
  const first = manyDriver({ testInProd: { beta: { state: FAILED, checks: [{ name: 'prod:beta', state: FAILED }] } } });
  await carry(bd, WS, 'p-1', first, { actor: 'release-agent' });
  assert.equal(rowFor(bd, 'alpha').verified, true);
  assert.equal(rowFor(bd, 'alpha').image, img('alpha'), 'and the digest, so the record says what is live');
  assert.equal(rowFor(bd, 'beta').verified, false);

  // The second run reads the first run's ledger off the comment the first run actually wrote.
  const second = manyDriver();
  const run = await carry(bd, WS, 'p-1', second, { actor: 'release-agent' });
  assert.deepEqual(asked(second), ['deployToUat:beta', 'testInUat:beta', 'promoteToProd:beta', 'testInProd:beta'], 'alpha and gamma are in production and are not deployed again');
  assert.equal(run.closed, true, 'and the bead closes on the repo that was owed');
  assert.match(bd.written[1].text, /done by an earlier run/, 'the two it skipped say why rather than reading as untried');
  assert.match(bd.closed[0].reason, /an earlier run/);
  assert.equal(rowFor(bd, 'alpha', 1).verified, true, 'and the ledger it writes still carries them');
});

await check('a repo red in UAT holds production back for every repo, and the held ones say so', async () => {
  const bd = fakeBd({ row: manyBead() });
  const driver = manyDriver({ testInUat: { beta: { state: FAILED, checks: [{ name: 'uat:beta', state: FAILED }] } } });
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });

  assert.deepEqual(
    asked(driver),
    ['deployToUat:alpha', 'testInUat:alpha', 'deployToUat:beta', 'testInUat:beta', 'deployToUat:gamma', 'testInUat:gamma'],
    'gamma is still exercised — a run comes back knowing as much as it can — and nothing is promoted'
  );
  assert.equal(run.promoted, false);
  assert.equal(run.state, FAILED);
  assert.equal(run.closed, false);
  const [{ text }] = bd.written;
  assert.match(text, /held back — `beta` did not get through UAT/, 'the ones that were fine say why they stopped');

  // The trap this shape sets: alpha's last step passed, and writing that as verified would
  // skip a repo that has never been near production for good.
  assert.equal(rowFor(bd, 'alpha').verified, false, 'passing UAT is not being in production');
  const again = manyDriver();
  await carry(bd, WS, 'p-1', again, { actor: 'release-agent' });
  assert.equal(asked(again).length, 12, 'so the next run carries all three of them');
});

await check('only a ledger row that says verified skips a repo, and the last word per repo wins', async () => {
  const block = (repos) => [RUN_OPEN, JSON.stringify({ repos }), RUN_CLOSE].join('\n');
  const found = ledgerFrom([
    { text: `prose above it\n\n${block([{ repo: 'alpha', verified: true, image: 'one' }, { repo: 'beta', verified: false }])}` },
    { text: 'a comment with no block at all' },
    { text: `${RUN_OPEN}\n{ not json\n${RUN_CLOSE}` },
    { text: block([{ repo: 'alpha', verified: true, image: 'two' }]) },
  ]);
  assert.equal(found.get('alpha').image, 'two', 'a later run replaces an earlier answer for the same repo');
  assert.equal(found.get('beta').verified, false, 'and a repo only the first comment mentioned is not forgotten');
  assert.equal(ledgerFrom([{ text: block([{ repo: 'x', verified: 'yes' }]) }]).get('x').verified, false, 'anything but true is carry-it-again');
  assert.equal(parseRun('no block here'), null);
  assert.equal(parseRun(`${RUN_OPEN}\n[]\n${RUN_CLOSE}`), null, 'and a block that is not a ledger is not one');
  assert.deepEqual(
    parseRun([RUN_OPEN, '```json', JSON.stringify({ repos: [{ repo: 'x' }] }), '```', RUN_CLOSE].join('\n')).repos,
    [{ repo: 'x' }],
    'a fenced block reads too, because that is the shape lib/plan.js writes and the two are one comment away from each other'
  );
});

await check('a driver whose own words would end the comment early does not eat the ledger', async () => {
  const bd = fakeBd({ row: manyBead() });
  await carry(bd, WS, 'p-1', manyDriver({ testInProd: { beta: { state: FAILED, detail: 'the pipeline said <!-- go --> and stopped' } } }), {
    actor: 'release-agent',
  });
  assert.equal(ledgerOn(bd).repos.length, 3, 'all three rows survive an arrow in a detail');
  assert.match(rowFor(bd, 'beta').detail, /<!-- go --> and stopped/, 'and it comes back out as it went in');
});

await check('a bd that cannot say what it was told carries every repo again rather than closing over one', async () => {
  const bd = fakeBd({ row: manyBead(), fail: { readComments: 'dolt lock' } });
  const driver = manyDriver();
  const run = await carry(bd, WS, 'p-1', driver, { actor: 'release-agent' });
  assert.equal(asked(driver).length, 12, 'silence is never "already verified"');
  assert.equal(run.closed, true);
});

await check('a repo the Repos line no longer names keeps the record that it was promoted', async () => {
  const bd = fakeBd({ row: manyBead() });
  await carry(bd, WS, 'p-1', manyDriver(), { actor: 'release-agent' });
  // Somebody edits the body down to one repo — the line is prose, and prose gets edited.
  bd.row.description = BODY;
  const kept = await carry(bd, WS, 'p-1', manyDriver(), { actor: 'release-agent' });
  assert.deepEqual(kept.legs.map((l) => l.repo), ['alpha'], 'the run is what the body says');
  assert.deepEqual(
    ledgerOn(bd, 1).repos.map((r) => r.repo).sort(),
    ['alpha', 'beta', 'gamma'],
    'and the ledger still says beta and gamma are in production'
  );
});

await check('a repo named twice in one Repos line is one image, not two', async () => {
  assert.deepEqual(reposOf({ description: '**Repos** (one image each): `alpha`, `beta`, `alpha`' }), ['alpha', 'beta']);
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
  [
    'a bead with somebody\'s name on it that is somehow still open — a handback clears the name',
    { row: promotionBead({ status: 'open', assignee: 'someone-else' }) },
    /held by someone-else/,
  ],
  ['a bead whose title does not name its epic', { row: promotionBead({ title: 'Release the thing' }) }, /does not name the epic/],
  ['a bead naming no repo', { row: promotionBead({ description: 'no repos here' }) }, /names no repo/],
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
    assert.deepEqual(bd.written, [], 'and writes nothing on a bead it never took');
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

  // And the same seam for the shape bc-y8k4.4 is about: a plan whose groups landed in two
  // repos — one group per repo, because a group spanning two is refused by `validatePlan` —
  // is a body naming two, and the run that picks it up has a leg for each.
  const spread = validatePlan(
    {
      groups: [
        { name: 'first', beads: ['x-1.2'], prs: [{ repo: 'alpha', title: 'the work' }], prompt: 'Do the one bead the plan named as one change.' },
        { name: 'second', beads: ['x-1.3'], prs: [{ repo: 'beta', title: 'the other half' }], prompt: 'Do the other bead the plan named as one change.' },
      ],
    },
    { epic: 'x-1', children: null }
  );
  await filePromotion(bd, WS, { id: 'x-1', title: 'the epic that landed', labels: [] }, spread);
  const twoRepos = { id: 'p-9', title: created[1].title, description: created[1].body, status: 'open', labels: ['promote'] };
  assert.deepEqual(reposOf(twoRepos), ['alpha', 'beta'], 'both, off the line filePromotion wrote');
  const both = await carry(fakeBd({ row: twoRepos }), WS, 'p-9', manyDriver(), { actor: 'release-agent' });
  assert.deepEqual(both.legs.map((l) => l.repo), ['alpha', 'beta'], 'and a leg for each rather than a refusal');
  assert.equal(both.closed, true);
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
