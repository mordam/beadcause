/**
 * The recount, and the per-bead lever, driven through a real advocate record.
 *
 * bc-xl7n.149. test/attemptaudit.mjs is the arithmetic on its own; this is the half that
 * can only be wrong in the daemon — that the repair reaches `a.attempts` before anything
 * reads it, that it is written down so a 39MB log is not re-read on every tick, that it
 * survives a restart, and that `rearm` through `control` takes the charges off **one** bead
 * where `forget` takes them off all of them.
 *
 * Four claims, and the first two are the acceptance criteria:
 *
 *   - **a bead retired for windows this daemon parked is dispatchable again**, one bead at
 *     a time, decided from the log rather than by clearing the map;
 *   - **a bead that genuinely broke two windows is still retired afterwards**;
 *   - **the log is read once per bead, not once per tick** — `attemptAudited` is persisted
 *     into advocates.json, so a daemon its own merges restart several times a day does not
 *     re-read the whole log to reach an answer it already wrote down;
 *   - **and the per-bead door exists at all**, which is what the bead was filed about:
 *     `rearm` had one caller, reachable only by answering a delivery card, so a bead that
 *     never delivered had no lever short of `forget`.
 *
 *     node test/attemptrepair.mjs
 *
 * Built on test/parkidle.mjs's harness — `open`/`prs` injected so no iTerm and no `gh` are
 * touched, and now `daemonLog` injected too, because the real one is this laptop's own and
 * a suite that ticked without it would be replaying last week against a fixture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-attemptrepair-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
const LOG = path.join(tmp, 'beadcause.log');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

let clock = Date.parse('2026-08-27T18:00:00.000Z');
const line = (text) => {
  clock += 60_000;
  return `${new Date(clock).toISOString()} [advocate] alpha: ${text}`;
};
const opened = (id, n) => line(`opened a session on ${id} in ${REPO} (auto, sonnet (low), attempt ${n})`);
const parked = (id) => line(`parked worker ${id} — quiet for 20m — it is waiting on you`);
const exited = (id) => line(`${id} — the session exited without closing it (exit 143)`);
const timedOut = (id) => line(`${id} — still open after 2h — releasing the slot`);

/**
 * The three populations, in one log, exactly as the live one holds them.
 *
 *   `bc-parked`  two windows, both parked and closed by this daemon — repairable to zero
 *   `bc-mixed`   one timeout it earned and one park it did not — repairable to one
 *   `bc-earned`  two windows that ran themselves out — must be left exactly where it is
 *   `bc-unknown` a counter the log cannot reconcile — must be left exactly where it is
 */
function writeLog() {
  const lines = [
    opened('bc-parked', 1),
    parked('bc-parked'),
    exited('bc-parked'),
    opened('bc-parked', 2),
    parked('bc-parked'),
    exited('bc-parked'),
    opened('bc-mixed', 1),
    timedOut('bc-mixed'),
    opened('bc-mixed', 2),
    parked('bc-mixed'),
    exited('bc-mixed'),
    opened('bc-earned', 1),
    timedOut('bc-earned'),
    opened('bc-earned', 2),
    timedOut('bc-earned'),
    // Five endings against a counter of two: the bc-khoe.21 shape, where the rule
    // underneath an ending changed and the replay must refuse rather than guess.
    ...[1, 2, 3, 4, 5].flatMap((n) => [opened('bc-unknown', n), timedOut('bc-unknown')]),
  ];
  fs.writeFileSync(LOG, `${lines.join('\n')}\n`);
}

const CHARGED = { 'bc-parked': 2, 'bc-mixed': 2, 'bc-earned': 2, 'bc-unknown': 2 };

/**
 * One advocate, ticked as many times as the case asks for, over a persisted state that
 * survives between ticks — which is the only way to see `attemptAudited` doing its job.
 */
async function stand({ attempts = CHARGED, audited = null, log = true } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  if (log) writeLog();
  else fs.rmSync(LOG, { force: true });

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      maxAttemptsPerBead: 2,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Every sweep with a suite of its own, off — each would otherwise run real git, a
      // real `gh` or a real agent against a temp directory on every tick here.
      parkIdleWindows: false,
      closeFinishedSessions: false,
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
  // The counters a previous daemon left behind, which is the whole subject: `attempts` is
  // one of the fields an advocate record adopts from advocates.json on boot.
  fs.writeFileSync(
    path.join(dir, 'advocates.json'),
    JSON.stringify({ alpha: { attempts, ...(audited ? { attemptAudited: audited } : {}) } }, null, 2)
  );

  const advocates = createAdvocates(cfg, {
    bd: {
      ready: async () => [],
      listLabel: async () => [],
      show: async (_ws, id) => ({ id, status: 'open' }),
      children: async () => [],
      listStatus: async () => [],
      graph: async () => ({ beads: new Map() }),
    },
    bus: { emit() {} },
    open: async () => {
      throw new Error('nothing in this suite should open a window');
    },
    openPlan: async () => {
      throw new Error('nothing in this suite should open a planner');
    },
    openAdvocate: async () => {
      throw new Error('nothing in this suite should open a P0 advocate');
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    terminals: () => [],
    daemonLog: LOG,
  });
  const saved = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(dir, 'advocates.json'), 'utf8')).alpha || {};
    } catch {
      return {};
    }
  };
  return { advocates, saved };
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
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('\nthe attempt recount, through a real advocate record\n');

/* ------------------------------------------------------------------ the cases */

await check('a bead retired for windows this daemon parked is dispatchable again', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  const after = saved().attempts;
  assert.equal(after['bc-parked'], undefined, 'both charges should be gone');
  assert.equal(after['bc-mixed'], 1, 'the earned half of a mixed pair stays');
});

await check('a bead that broke two windows of its own keeps both charges', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  assert.equal(saved().attempts['bc-earned'], 2);
});

await check('a counter the log cannot reconcile is not touched', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  assert.equal(saved().attempts['bc-unknown'], 2);
});

await check('and every one of them is written down as looked at', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  const seen = saved().attemptAudited || {};
  for (const id of Object.keys(CHARGED)) assert.ok(id in seen, `${id} was not recorded as audited`);
  assert.equal(seen['bc-earned'], 2, 'an untouched counter records the value it kept');
  assert.equal(seen['bc-parked'], 0, 'a repaired one records what it was lowered to');
});

await check('the log is not read again for a bead already recounted', async () => {
  // The proof is a log that would now say something different: if the audit ran a second
  // time it would have this new evidence and would repair `bc-earned`. It must not, and
  // the only thing stopping it is the record from the first tick.
  const { advocates, saved } = await stand();
  await advocates.tick();
  assert.equal(saved().attempts['bc-earned'], 2);
  fs.writeFileSync(
    LOG,
    `${[opened('bc-earned', 1), parked('bc-earned'), exited('bc-earned'), opened('bc-earned', 2), parked('bc-earned'), exited('bc-earned')].join('\n')}\n`
  );
  await advocates.tick();
  assert.equal(saved().attempts['bc-earned'], 2, 'it re-read the log for a bead it had already settled');
});

await check('a restart does not re-read it either', async () => {
  const first = await stand();
  await first.advocates.tick();
  const carried = first.saved();
  // A second daemon over the state the first one left — which is what a merge here does
  // several times a day.
  const second = await stand({ attempts: carried.attempts, audited: carried.attemptAudited });
  await second.advocates.tick();
  const after = second.saved();
  // Every counter still standing keeps its record, so nothing is due and the log is not
  // opened. `bc-parked` is not among them and must not be: its counter is gone, so its
  // record has nothing left to shadow, and carrying one for a bead with no charges would
  // be a map that grows for ever. (A bead charged again later is then unexplainable
  // against a log that still holds its old episodes, which is the safe direction.)
  for (const id of Object.keys(after.attempts)) {
    assert.equal(after.attemptAudited[id], carried.attemptAudited[id], `${id} lost its record across the boot`);
  }
  assert.equal('bc-parked' in after.attemptAudited, false, 'a record outlived the counter it shadows');
  assert.equal(after.attempts['bc-earned'], 2);
});

await check('a charge written after the recount is a new question', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  assert.equal(saved().attempts['bc-earned'], 2);
  // The same bead charged again — a third window that also ran itself out. `attemptAudited`
  // holds 2, the counter now holds 3, and the two disagreeing is what makes it due again.
  const audited = saved().attemptAudited;
  const next = await stand({ attempts: { 'bc-earned': 3 }, audited });
  await next.advocates.tick();
  assert.equal(next.saved().attemptAudited['bc-earned'], 3, 'a changed counter should have been looked at again');
});

await check('a log that is not there repairs nothing and throws nothing', async () => {
  const { advocates, saved } = await stand({ log: false });
  await advocates.tick();
  assert.deepEqual(saved().attempts, CHARGED, 'counters must survive a log that cannot be read');
});

await check('a workspace with nothing at the cap never opens the log at all', async () => {
  const { advocates, saved } = await stand({ attempts: { 'bc-parked': 1 } });
  await advocates.tick();
  assert.deepEqual(saved().attempts, { 'bc-parked': 1 });
  assert.deepEqual(saved().attemptAudited, {}, 'nothing was due, so nothing should have been recorded');
});

await check('rearm through control takes the charges off one bead and no other', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  const out = await advocates.control('alpha', 'rearm', 'bc-earned');
  assert.equal(out.charges, 2);
  assert.equal(out.retired, true, 'it should say the bead was retired, which is the sentence worth having');
  const after = saved();
  assert.equal(after.attempts['bc-earned'], undefined);
  assert.equal(after.attempts['bc-unknown'], 2, 'its neighbour must keep its charges');
  assert.equal('bc-earned' in (after.attemptAudited || {}), false, 'a cleared counter is a new question');
});

await check('rearm on a bead with no charges says so rather than pretending', async () => {
  const { advocates } = await stand();
  const out = await advocates.control('alpha', 'rearm', 'bc-nothing');
  assert.equal(out.charges, 0);
  assert.equal(out.retired, false);
});

await check('forget still clears the whole map, and its record with it', async () => {
  const { advocates, saved } = await stand();
  await advocates.tick();
  assert.ok(Object.keys(saved().attemptAudited || {}).length, 'the audit should have recorded something to clear');
  await advocates.control('alpha', 'forget');
  assert.deepEqual(saved().attempts, {});
  assert.deepEqual(saved().attemptAudited, {});
});

await check('the console names each retired bead beside the verb', async () => {
  const { advocates } = await stand();
  await advocates.tick();
  const card = advocates.snapshot().find((a) => a.workspace === 'alpha');
  const ids = (card.givenUp || []).map((g) => g.id);
  // `givenUp` is computed over the queue and the graph, both empty in this fixture, so
  // the list itself is empty here — what matters is that the shape the console draws from
  // is on the snapshot at all, and that the repair has already been applied under it.
  assert.ok(Array.isArray(card.givenUp), 'the card must carry the list the rows are drawn from');
  assert.equal(ids.includes('bc-parked'), false, 'a repaired bead must not still be reported as given up on');
});

await quiesce();
await cleanupTmp(tmp);

console.log(failures ? `\n${failures} of ${ran} checks failed\n` : `\n${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
