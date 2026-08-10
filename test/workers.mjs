/**
 * Setting an advocate's worker count from its card — live, and then still there.
 *
 * The number used to live in ~/.config/beadcause/config.json and nowhere else, so
 * changing it meant an editor and a `launchctl kickstart`. Now a stepper on the card
 * does it, which splits the feature in two halves that can each be wrong on their own:
 *
 * 1. **Live but not saved.** The next restart quietly puts the old number back, and
 *    the card that showed 5 for two days was telling the truth right up until the
 *    daemon bounced. Nothing on screen would ever say so.
 * 2. **Saved but not live.** The config is right and the running advocate still opens
 *    the old number of sessions, so the button appears to do nothing until something
 *    unrelated restarts the daemon hours later.
 * 3. **Clamped to the wrong ceiling.** `maxWorkersLimit` defaults to 3. A stepper held
 *    to *that* could never take a repo past today's cap — the control would be
 *    decoration. So the range is `MAX_WORKERS_CEILING` (9) and choosing a number above
 *    the per-repo ceiling raises the ceiling, because pressing the button is the
 *    statement that this repo may go that far. If that write is missed, the number
 *    works until the restart and then silently drops back to 3 — failure 1 wearing a
 *    disguise.
 * 4. **One repo's stepper moving another's cap.** The global `maxWorkers` is the
 *    fallback for every workspace without its own entry, so writing there would step
 *    every unconfigured repo at once.
 * 5. **A cap that is not the binding one.** `globalMaxWorkers` is a total across every
 *    advocate. A repo stepped to 5 under a global 3 will get 3, and a card that says
 *    only "5" reads as broken. The snapshot has to carry which number is winning.
 *
 * No iTerm, no `bd`, no daemon: `createAdvocates` is called directly, and the config it
 * writes is read back off disk the way a restart reads it. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-workers-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const CONFIG = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
const STATE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'advocates.json');

const { createAdvocates, workerLimit, saveWorkerLimit, MAX_WORKERS_CEILING } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

/** Two workspaces, because failure 4 is invisible with one. */
const baseConfig = () => ({
  workspaces: [
    { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') },
    { name: 'beta', dir: path.join(tmp, 'beta', '.beads') },
  ],
  advocates: {
    enabled: true,
    workspaces: '*',
    maxWorkers: 2,
    maxWorkersLimit: 3,
    globalMaxWorkers: 3,
    // Nothing here proposes or surveys in this file — `control` never ticks — but the
    // real config has these and a default that changed shape should show up here.
    propose: false,
  },
});

/** Advocates over a fresh config on disk, the way the daemon comes up. */
function harness(overrides = {}) {
  const cfg = { ...baseConfig(), ...overrides };
  if (overrides.advocates) cfg.advocates = { ...baseConfig().advocates, ...overrides.advocates };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  fs.rmSync(STATE, { force: true });
  const events = [];
  const advocates = createAdvocates(cfg, { bd: {}, bus: { emit: (e) => events.push(e) } });
  return { advocates, cfg, events };
}

const card = (advocates, name) => advocates.snapshot().find((a) => a.workspace === name);
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

/**
 * What the same config looks like to a daemon that has just started.
 *
 * This is the restart, and it is the only honest test of "it sticks": the process
 * that wrote the number is gone, and the number has to come back out of the file.
 */
function afterRestart() {
  const cfg = onDisk();
  return { cfg, advocates: createAdvocates(cfg, { bd: {}, bus: { emit: () => {} } }) };
}

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
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

console.log('\nworker count from the card\n');

/* ------------------------------------------------------------------- checks */

await check('the limit changes on the running advocate, with no restart', async () => {
  const { advocates, events } = harness();
  assert.equal(card(advocates, 'alpha').limit, 2, 'the config said 2');
  await advocates.control('alpha', 'limit', 3);
  assert.equal(card(advocates, 'alpha').limit, 3, 'this is failure mode 2 — the live half');
  assert.ok(
    events.some((e) => e.action === 'limit' && /3 session/.test(e.detail)),
    'and the change is on the event bus, so the log says what happened'
  );
});

await check('and it is written where a restart will find it', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 3);
  assert.equal(onDisk().advocates.perWorkspace.alpha.maxWorkers, 3, 'this is failure mode 1');
  // The real proof: a second daemon, built from nothing but the file.
  const { advocates: restarted } = afterRestart();
  assert.equal(card(restarted, 'alpha').limit, 3, 'a kickstart must not put 2 back');
});

await check('a number above maxWorkersLimit raises it, rather than being eaten at boot', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 5);
  assert.equal(card(advocates, 'alpha').limit, 5, 'the ceiling is 9, not maxWorkersLimit');
  const saved = onDisk();
  assert.equal(saved.advocates.perWorkspace.alpha.maxWorkers, 5);
  assert.equal(saved.advocates.maxWorkersLimit, 5, 'this is failure mode 3 — otherwise 5 clamps to 3 at boot');
  const { cfg, advocates: restarted } = afterRestart();
  assert.equal(card(restarted, 'alpha').limit, 5);
  assert.equal(workerLimit(cfg, 'alpha').requested, 5, 'and nothing warns, because nothing was clamped');
  assert.equal(workerLimit(cfg, 'alpha').ceiling, 5);
});

await check('stepping back down leaves the permission it granted in place', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 7);
  await advocates.control('alpha', 'limit', 2);
  const saved = onDisk();
  assert.equal(saved.advocates.perWorkspace.alpha.maxWorkers, 2, 'the limit follows the button down');
  assert.equal(saved.advocates.maxWorkersLimit, 7, 'the ceiling does not — you already said this repo may');
  assert.equal(card(advocates, 'alpha').limit, 2);
});

await check('it cannot go past 9, or below 1', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 42);
  assert.equal(card(advocates, 'alpha').limit, MAX_WORKERS_CEILING);
  assert.equal(MAX_WORKERS_CEILING, 9, 'the card offers this number — it is part of the contract');
  assert.equal(onDisk().advocates.perWorkspace.alpha.maxWorkers, 9, 'and 42 is never written');
  await advocates.control('alpha', 'limit', 0);
  assert.equal(card(advocates, 'alpha').limit, 1, 'zero would be a paused advocate wearing the wrong control');
  await advocates.control('alpha', 'limit', -3);
  assert.equal(card(advocates, 'alpha').limit, 1);
});

await check('a value that is not a number is refused, and changes nothing', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 4);
  // `Number(null)` is 0, which clamps to 1 — so a request that forgot its value would
  // otherwise read as a deliberate "one session at a time". Out of range is a clamp;
  // no number at all is a 400, and the two must not share a path.
  for (const junk of [undefined, null, '', '   ', 'lots', NaN, {}]) {
    await assert.rejects(
      () => advocates.control('alpha', 'limit', junk),
      (err) => err.status === 400 && /needs a number/.test(err.message),
      `${JSON.stringify(junk) ?? String(junk)} is not a limit`
    );
    assert.equal(card(advocates, 'alpha').limit, 4, 'and the limit it already had stands');
  }
  assert.equal(onDisk().advocates.perWorkspace.alpha.maxWorkers, 4, 'nothing was written either');
  // A numeric string is what an HTML dataset hands you, and it does have to work.
  await advocates.control('alpha', 'limit', '6');
  assert.equal(card(advocates, 'alpha').limit, 6);
});

await check('one repo\'s stepper does not move another repo\'s cap', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 4);
  assert.equal(card(advocates, 'beta').limit, 2, 'this is failure mode 4');
  const saved = onDisk();
  assert.equal(saved.advocates.maxWorkers, 2, 'the global fallback is untouched');
  assert.equal(saved.advocates.perWorkspace.beta, undefined, 'and beta gains no entry it did not ask for');
  const { advocates: restarted } = afterRestart();
  assert.equal(card(restarted, 'beta').limit, 2, 'still 2 after a restart, on the raised ceiling');
});

await check('each repo keeps its own number when both are stepped', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 5);
  await advocates.control('beta', 'limit', 3);
  const { advocates: restarted } = afterRestart();
  assert.equal(card(restarted, 'alpha').limit, 5);
  assert.equal(card(restarted, 'beta').limit, 3);
});

await check('the card is told which cap is the binding one', async () => {
  const { advocates } = harness();
  const before = card(advocates, 'alpha');
  assert.equal(before.globalMax, 3, 'globalMaxWorkers travels, so the card need not guess it');
  assert.equal(before.ceiling, MAX_WORKERS_CEILING, 'and so does the range of the stepper');
  assert.equal(before.globalHeld, false, '2 under a global 3 is honoured');
  await advocates.control('alpha', 'limit', 5);
  const after = card(advocates, 'alpha');
  assert.equal(after.limit, 5, 'the press worked');
  assert.equal(after.globalHeld, true, 'this is failure mode 5 — and 5 is still not what it will get');
  await advocates.control('alpha', 'limit', 3);
  assert.equal(card(advocates, 'alpha').globalHeld, false, 'and it stops saying so when it stops being true');
});

await check('the note quoting the old limit is dropped, not left contradicting the new one', async () => {
  const { advocates } = harness();
  await advocates.control('alpha', 'limit', 4);
  assert.equal(card(advocates, 'alpha').note, '', 'the next tick writes a fresh one');
});

await check('an advocate that does not exist is a 404, not a config write', async () => {
  const { advocates } = harness();
  await assert.rejects(() => advocates.control('gamma', 'limit', 4), (err) => err.status === 404);
  assert.equal(onDisk().advocates.perWorkspace?.gamma, undefined);
});

await check('the helper can be called on a config with no advocates block at all', () => {
  // The daemon always has one; `saveWorkerLimit` is reachable from anywhere and a
  // thrown TypeError here would be an unwritten config and a lost button press.
  const bare = {};
  const out = saveWorkerLimit(bare, 'alpha', 4);
  assert.equal(bare.advocates.perWorkspace.alpha.maxWorkers, 4);
  assert.equal(bare.advocates.maxWorkersLimit, 4, 'above the default 3, so the ceiling comes with it');
  assert.equal(out.maxWorkers, 4);
  // And it does not flatten a `perWorkspace` entry that carries other settings.
  const kept = { advocates: { perWorkspace: { alpha: { minPriority: 1 } } } };
  saveWorkerLimit(kept, 'alpha', 2);
  assert.equal(kept.advocates.perWorkspace.alpha.minPriority, 1);
  assert.equal(kept.advocates.perWorkspace.alpha.maxWorkers, 2);
});

await check('an unknown action is still refused, with the number-carrying one in place', async () => {
  const { advocates } = harness();
  await assert.rejects(() => advocates.control('alpha', 'limits', 4), /unknown action/);
  assert.equal(card(advocates, 'alpha').limit, 2);
});

/* -------------------------------------------------------------------- result */

console.log(`\n${ran - failures}/${ran} passed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
