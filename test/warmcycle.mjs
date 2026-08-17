#!/usr/bin/env node
/**
 * Filling a cache key before anybody asks for it — and not paying for it.
 *
 *     npm test
 *     node test/warmcycle.mjs
 *
 * bc-1kwl.4. lib/cache.js (bc-1kwl.2) took the wait out of every read but the first
 * one: past the window a kept answer comes back now and the producer runs behind it,
 * and the *only* request that still waits on `bd` or `gh` is one that finds a key with
 * nothing kept for it at all. bc-1kwl.3 and .7 put the standing screens' sweeps on that
 * layer, which leaves exactly one thing between a phone out of a pocket and a list: a
 * cold key. And cold keys are not rare — every one of them is cold again the moment the
 * daemon restarts, which for beadcause is every merge.
 *
 * So the poll cycle fills them. The bead's acceptance has two halves that pull against
 * each other, and this file is mostly about the second:
 *
 * 1. **First paint of the inbox and the pull request board is under a second** after
 *    the app has been shut for an hour. That is "nothing is ever cold", which is what
 *    the cold-key checks below are.
 * 2. **Daemon traffic with nobody looking is no higher than it is today** — `gh`
 *    traffic by name. A warmer on a plain interval satisfies (1) trivially and breaks
 *    (2) outright: these windows are ten seconds wide and a cycle is thirty, so
 *    "warm every cycle" is every producer re-run every cycle, forever, for screens
 *    nobody is looking at. That is exactly the cost bc-1kwl.5 spent a bead holding down.
 *
 * Four claims, each a way the whole thing quietly degrades into the interval warmer:
 *
 * 1. **The gate** (`warmDue`): cold is warmed unconditionally; kept is warmed only when
 *    that workspace's tracker has moved *and* a floor has passed. Staleness on its own
 *    is never a reason — `bd` is the only source these keys have, so an unmoved manifest
 *    means a fresh sweep would return the same bytes.
 * 2. **The endorsement queue is cold-only.** It is the most expensive sweep in the app
 *    (a `bd list --label` per workspace plus up to forty `bd show`s, measured at 48
 *    seconds), and a warmer that re-ran it on a clock would be the single worst thing
 *    in the daemon.
 * 3. **The board is asked once and never again** — the whole of claim (2) above, since
 *    it is the only warmed key that reaches the network.
 * 4. **The cycle runs the pass beside itself, not inside it.** A warm sweep must never
 *    be in front of a `tick`, which is what puts a question on a phone; and a warm that
 *    throws must not kill the daemon or leave the warmer switched off for the life of
 *    the process.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-warmcycle-'));
// Before the first import of anything under lib/: CONFIG_DIR resolves once, at load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

/**
 * A `gh` that is not there, put in front of the real one.
 *
 * The board warm is the one check here that would otherwise shell out to GitHub, and a
 * suite whose answer depends on whether this Mac happens to be logged in is not a
 * check. `lib/pr.js` runs `execFile('gh', …)`, so a directory on the front of `PATH`
 * with nothing called `gh` in it is enough: `available()` reports the one dependency
 * beadcause is allowed to be missing, `collectBoard` answers `{ unavailable }`, and —
 * this is the part being asserted — that answer is *kept* like any other, which is what
 * makes the warmer ask once rather than on every beat forever.
 */
const NOGH = path.join(tmp, 'nogh');
fs.mkdirSync(NOGH, { recursive: true });
process.env.PATH = `${NOGH}${path.delimiter}${process.env.PATH}`;

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
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

console.log('\nwarming the cache on the poll cycle and at boot\n');

/* ------------------------------------------------------------------ the gate */

const { warmDue } = await import(LIB('server.js'));

/** A `peek` over a plain table, which is all `warmDue` ever asks of one. */
const peeking = (table) => (key) => table[key] || null;
const due = (table, ws, opts = {}) =>
  warmDue(`thing:${ws}`, ws, { peek: peeking(table), floorMs: 30_000, ...opts });

await check('a key with nothing kept is warmed, whatever the clock says', () => {
  assert.equal(due({}, 'alpha', { now: 0, changed: new Set() }), true);
});

await check('a kept key whose tracker has not moved is never warmed — at any age', () => {
  const kept = { 'thing:alpha': { at: 0 } };
  const anHour = 3_600_000;
  assert.equal(due(kept, 'alpha', { now: anHour, changed: new Set() }), false);
});

await check('a kept key whose tracker moved is warmed once the floor has passed', () => {
  const kept = { 'thing:beta': { at: 0 } };
  const changed = new Set(['beta']);
  assert.equal(due(kept, 'beta', { now: 29_000, changed }), false);
  assert.equal(due(kept, 'beta', { now: 30_000, changed }), true);
});

await check('and a move in one workspace never warms another — the gate is per key', () => {
  // The correction this signature exists for. alpha is ancient and quiet, beta is what
  // moved. A gate that answered for the pair would sweep alpha too, and since these
  // windows are ten seconds wide it would sweep *every* quiet workspace, every time any
  // one of them was written to.
  const kept = { 'thing:alpha': { at: 0 }, 'thing:beta': { at: 0 } };
  const changed = new Set(['beta']);
  assert.equal(due(kept, 'alpha', { now: 3_600_000, changed }), false);
  assert.equal(due(kept, 'beta', { now: 3_600_000, changed }), true);
});

/* ------------------------------------------------- the endorsement queue, cold-only */

const cache = await import(LIB('cache.js'));
const { warm: warmQueue, forget: forgetQueue } = await import(LIB('endorsequeue.js'));

const WS = [{ name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') }];

/** Just enough `bd` for the queue's sweep, counting the calls that cost anything. */
const countingBd = () => {
  const calls = { list: 0, show: 0 };
  return {
    calls,
    listLabel: async () => {
      calls.list += 1;
      return [];
    },
    listHeld: async () => {
      calls.list += 1;
      return [];
    },
    list: async () => {
      calls.list += 1;
      return [];
    },
    show: async () => {
      calls.show += 1;
      return null;
    },
  };
};

await check('the endorsement queue is swept once when cold and not again while anything is kept', async () => {
  cache.clear();
  const bd = countingBd();
  assert.equal(await warmQueue(bd, WS), true, 'the first pass fills a cold key');
  const after = bd.calls.list;
  assert.ok(after > 0, 'the cold pass actually swept');
  for (let i = 0; i < 5; i += 1) assert.equal(await warmQueue(bd, WS), false, 'a filled key was warmed again');
  assert.equal(bd.calls.list, after, `five further passes cost ${bd.calls.list - after} extra bd call(s)`);
});

await check('and it fills again after a verdict drops it — which is when the screen is next opened', async () => {
  cache.clear();
  const bd = countingBd();
  await warmQueue(bd, WS);
  const after = bd.calls.list;
  forgetQueue();
  assert.equal(await warmQueue(bd, WS), true, 'a dropped key was left cold');
  assert.ok(bd.calls.list > after, 'the re-fill did not sweep');
});

/* --------------------------------------------------- the board, once and never again */

const { warmBoard } = await import(LIB('prboard.js'));

await check('the pull request board is asked once per daemon and never again', async () => {
  cache.clear();
  const cfg = { workspaces: WS, repos: {}, spaces: [] };
  const bd = countingBd();
  assert.equal(await warmBoard(bd, cfg), true, 'the first pass fills a cold board');
  // The point of the claim: with `gh` absent the answer is a sentence rather than a
  // board, and a sentence is a value — so nothing here goes back to the network on the
  // next beat, or the one after, for the life of the process. This is the acceptance
  // criterion "daemon gh traffic with nobody looking is no higher than it is today":
  // a warmer that returned true here would be a `gh pr list` per repo every cycle.
  for (let i = 0; i < 5; i += 1) assert.equal(await warmBoard(bd, cfg), false, `beat ${i + 2} asked gh again`);
});

/* ----------------------------------------------------- and the cycle runs it detached */

const { startPoller } = await import(LIB('server.js'));

/**
 * A poller with a real workspace directory under it and everything else faked — the
 * same shape test/detect.mjs drives, because the claims are about the same cycle.
 *
 * `pollSeconds` is enormous so the backstop can never be what makes an assertion pass.
 */
const drivePoller = async (warmKeys) => {
  const dir = fs.mkdtempSync(path.join(tmp, 'poll-'));
  const beads = path.join(dir, '.beads');
  const manifest = path.join(beads, 'embeddeddolt', 'pl', '.dolt', 'noms', 'manifest');
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, 'warm-one');

  let sweeps = 0;
  const timer = startPoller(
    {
      baseUrl: 'http://127.0.0.1',
      token: 'warm-token',
      actor: 'beadcause-test',
      workspaces: [{ name: 'pl', dir: beads }],
      pollSeconds: 3600,
      detectSeconds: 1,
      autoDispatch: false,
      ntfy: { enabled: false },
    },
    {
      bus: { emit() {} },
      hooks: {},
      bd: { comments: async () => [], removeLabel: async () => {} },
      advocates: { tick: async () => {} },
      allQuestions: async () => {
        sweeps += 1;
        return [];
      },
      warmKeys,
    }
  );
  return { manifest, timer, counts: () => ({ sweeps }) };
};

const settle = (ms) => new Promise((r) => setTimeout(r, ms));

await check('the boot beat warms — a daemon that has just restarted does not wait to be asked', async () => {
  let passes = 0;
  const run = await drivePoller(async () => {
    passes += 1;
    return [];
  });
  try {
    await settle(150);
    assert.equal(passes, 1, 'the first beat did not warm');
  } finally {
    clearInterval(run.timer);
  }
});

await check('a warm pass that runs long neither doubles up nor holds the poll back', async () => {
  let started = 0;
  let released;
  const held = new Promise((r) => {
    released = r;
  });
  const run = await drivePoller(async () => {
    started += 1;
    await held;
    return [];
  });
  try {
    await settle(150);
    assert.equal(started, 1);
    const first = run.counts().sweeps;
    // Three beats go by with the warm pass still out. The tick must keep running —
    // this is the claim that the pass is beside the cycle rather than inside it — and
    // no second pass may be started on top of the one that is stuck.
    for (let i = 0; i < 3; i += 1) {
      fs.writeFileSync(run.manifest, `warm-${i}`);
      await settle(1100);
    }
    assert.equal(started, 1, `a stuck warm pass was started ${started} times`);
    assert.ok(run.counts().sweeps > first, 'the poll stopped sweeping behind a stuck warm pass');
  } finally {
    released?.();
    clearInterval(run.timer);
  }
});

await check('a warm pass that throws does not kill the daemon or switch the warmer off', async () => {
  let passes = 0;
  const run = await drivePoller(async () => {
    passes += 1;
    throw new Error('tracker mid-write');
  });
  try {
    await settle(150);
    assert.equal(passes, 1);
    fs.writeFileSync(run.manifest, 'warm-again');
    await settle(1400);
    assert.ok(passes >= 2, 'the warmer stopped after one rejection — `warming` was left true');
  } finally {
    clearInterval(run.timer);
  }
});

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
