/**
 * The door into the survey: what has to be true at once before an advocate proposes.
 *
 * bc-shwx. `propose` in lib/advocate.js is the half of the advocate that goes looking for
 * work rather than doing it, and on 2026-08-11 it had never run: `lastProposalAt` was
 * null for all six advocates on this Mac and no `<workspace>_advocate.log` existed. The
 * bead asked whether that is the gate working — a queue that is never dry is a queue that
 * never needs proposals — or the gate being unreachable in practice, since three of its
 * hold-conditions (`heldByChildren`, `heldByTwin`, `heldByPr`) were added *after* it and
 * each one makes "clear" rarer.
 *
 * It has since fired for real: the `architecture` advocate surveyed on 2026-08-12, wrote
 * `architecture_advocate.log`, stamped `lastProposalAt` and proposed two beads. So the
 * gate is reachable, and the answer to the bead is "working as intended". What that
 * measurement cannot do is stay true — it is one reading of one file on one laptop, and
 * the next filter added above `propose` would close the door again with nothing to say
 * so. This suite is that reading turned into something that fails.
 *
 * The repo already asserts the negative: `test/repoqueue.mjs` checks that a queue emptied
 * by a hold proposes nothing over itself, and six sibling suites turn `propose` off so it
 * cannot reach a real agent. Nothing asserted the positive, and a gate only ever tested
 * shut cannot tell "correctly closed" from "welded shut" — which is exactly the doubt
 * bc-shwx was filed about, and exactly what `test/css.mjs` means by a guard that cannot
 * fail being one nobody should trust.
 *
 * **Where the positive case stops, and why that is the whole gate.** `propose` cannot be
 * run to completion here: past the one-open-ask rule it spawns a read-only agent for ten
 * minutes, and a suite that shells out to `claude` is not a suite. So the fake tracker
 * answers the one-open-ask lookup with an ask already open, which is the last statement
 * before the spawn — every condition this bead is about (not paused, no workers, an empty
 * and unheld queue, `propose` on, the cooldown elapsed) has been passed by the time that
 * lookup happens, and only `propose` ever asks for `advocate-proposal`. So the call is the
 * evidence, and the cases below differ by exactly one condition each.
 *
 *     node test/proposegate.mjs
 *
 * Built on test/twinqueue.mjs's harness: `open` is injected, so a tick that would have
 * opened an iTerm window pushes an id onto an array instead. No iTerm, no `bd`, no agent,
 * and nothing written outside a temp config dir.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-proposegate-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates, PROPOSAL_LABEL } = await import(LIB('advocate.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, title, over = {}) => ({
  id,
  title,
  priority: 2,
  issue_type: 'task',
  created_at: OLD,
  ...over,
});

/** Long enough that the twin filter matches on the words rather than on being short. */
const TITLE = 'The router never proxies a WebSocket upgrade to the backend';

/** The ask that is already open, which is where the positive case stops. */
const OPEN_ASK = { id: 'x-ask', title: 'alpha: 2 beads for you to approve' };

/**
 * One tick, against a tracker and a stored state the case chooses.
 *
 * `state` is written to advocates.json before the advocates are built, because both
 * `paused` and `lastProposalAt` are read out of it once at construction and there is no
 * other way in — which is the point for `paused`: it survives a restart deliberately, and
 * four of the six advocates in the original measurement were in exactly that state.
 */
async function tick({ ready = [], inProgress = [], state = null, overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case: state, the activity file the launch stamps, and the worker
  // markers. Otherwise case N's worker is still in case N+1's queue.
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  if (state) fs.writeFileSync(path.join(dir, 'advocates.json'), JSON.stringify({ alpha: state }));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // The one thing under test, on by default here where every sibling suite turns it
      // off. A case that wants it off says so.
      propose: true,
      // Everything else that would run real git, a real `gh` or a real agent against a
      // temp directory on every case. Quiet hours matter more here than anywhere: this
      // suite runs at whatever hour the gate is being asked about.
      respectQuietHours: false,
      tidyWorktrees: false,
      sessionLog: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      flagNotInMain: false,
      filePromotions: false,
      holdOpenPrs: false,
      planEpics: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  /** Every label the tick asked the tracker about, in order. */
  const labelled = [];
  const bd = {
    ready: async () => ready,
    listLabel: async (_ws, label) => {
      labelled.push(label);
      return label === PROPOSAL_LABEL ? [OPEN_ASK] : [];
    },
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => inProgress,
    // No P0 roots means every bead is workable — `hasP0Above` is fail-open on an empty
    // graph, so this filter is never what empties a queue here. See lib/underp0.js.
    graph: async () => ({ beads: [], parents: new Map() }),
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
  });
  await advocates.tick();
  return { opened, labelled, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

/** Did the tick get as far as `propose`? Nothing else asks for this label. */
const surveyed = ({ labelled }) => labelled.includes(PROPOSAL_LABEL);

/** A worker record shaped as the daemon writes one. */
const worker = (id, title) => ({ id, title, at: new Date().toISOString(), attempt: 1, batch: [] });

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

/* ------------------------------------------------------------------ the cases */

/**
 * The one bc-shwx was filed to settle. Nothing ready, no windows open, nothing held, and
 * the advocate goes looking — which is what "clear" is supposed to mean and what a Mac
 * with six advocates had never once observed.
 */
await check('a genuinely clear queue reaches the survey', async () => {
  const result = await tick({ ready: [] });

  assert.equal(result.card.queue, 0);
  assert.ok(surveyed(result), 'the gate is reachable — this is the whole bead');
  assert.match(
    result.card.note,
    /waiting on you to answer x-ask/,
    `the one-open-ask rule is where it stopped, not the gate; got: ${result.card.note}`
  );
});

/**
 * And the control that makes the case above worth having: the same tick with the survey
 * switched off must not ask. Without this, a `labelled` that filled up for some other
 * reason would read as the gate opening.
 */
await check('and with propose off it does not', async () => {
  const result = await tick({ ready: [], overrides: { propose: false } });

  assert.equal(surveyed(result), false, 'propose: false is the off switch, and it is honoured');
  assert.match(result.card.note, /clear — no ready beads/, result.card.note);
});

/**
 * A window already open is the first of the five conditions, and the plainest: an
 * advocate that proposed new work while it was doing old work would be doing the easy
 * half of its job. It is also why the `beadcause` advocate has never surveyed — it has
 * not been without a worker since it was switched on.
 */
await check('a session already working stops it', async () => {
  const result = await tick({ ready: [], state: { workers: [worker('x-1', TITLE)], attempts: {} } });

  assert.equal(surveyed(result), false, 'not with a window open on this repo');
  assert.match(result.card.note, /1 session\(s\) working, nothing else ready/, result.card.note);
});

/**
 * The condition the bead is actually about. A queue emptied by a *hold* is not a clear
 * one — here by `withoutTwins`, one of the three filters added after `propose` — and the
 * distinction is invisible in the count: `queue` is 0 in this case and in the first one,
 * and only `quiet` tells them apart. test/repoqueue.mjs asserts the same rule for the
 * repo filter; this is the pair to the positive case above, one condition apart.
 */
await check('a queue emptied by a hold is not a clear one', async () => {
  const result = await tick({
    ready: [bead('x-2', TITLE)],
    inProgress: [{ id: 'x-1', title: TITLE, status: 'in_progress' }],
  });

  assert.equal(result.card.queue, 0, 'the count is the same as a clear queue — that is the trap');
  assert.equal(surveyed(result), false, 'and nothing is proposed over it');
  assert.match(result.card.note, /nothing ready · 1 the same job as work already under way/, result.card.note);
});

/**
 * Paused, and this is the second half of the original measurement rather than a corner
 * case: four of the six advocates whose `lastProposalAt` was null were paused, and a
 * paused advocate returns from the tick well above the queue block. Their nulls said
 * nothing about the gate at all.
 */
await check('a paused advocate never gets near it', async () => {
  const result = await tick({ ready: [], state: { paused: true, workers: [], attempts: {} } });

  assert.equal(surveyed(result), false, 'pausing means "open no more sessions", and proposing is one');
  assert.match(result.card.note, /^paused/, result.card.note);
});

/**
 * The cooldown, which is the only condition of the five that clears itself. Stamped on
 * *both* survey outcomes — including "nothing worth proposing" — so an advocate that
 * found nothing does not spend ten agent-minutes finding nothing again half an hour
 * later.
 */
await check('and once it has surveyed, the cooldown holds it off', async () => {
  const result = await tick({
    ready: [],
    state: { workers: [], attempts: {}, lastProposalAt: new Date().toISOString() },
  });

  assert.equal(surveyed(result), false, 'one survey per proposeCooldownHours, whatever the queue says');
  assert.match(result.card.note, /clear — no ready beads/, result.card.note);
});

/**
 * And the cooldown is a window rather than a latch: the same state with an old stamp
 * surveys again. Without this the case above passes just as well against a gate that
 * never opens twice.
 */
await check('an expired cooldown lets it through again', async () => {
  const result = await tick({ ready: [], state: { workers: [], attempts: {}, lastProposalAt: OLD } });

  assert.ok(surveyed(result), 'a stamp from 2020 holds nothing back');
});

/* --------------------------------------------------------------------- report */

console.log(`\n${failures ? `${failures} of ${ran} checks failed` : `all ${ran} checks passed`}`);
try {
  await cleanupTmp(tmp);
} catch {
  /* a temp directory that will not go is not a failure of the thing under test */
}
process.exit(failures ? 1 : 0);
