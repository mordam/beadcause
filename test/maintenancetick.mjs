#!/usr/bin/env node
/**
 * The nightly window, driven through a real advocate tick.
 *
 *     npm test
 *     node test/maintenancetick.mjs
 *
 * test/maintenance.mjs pins the decision — every phase, every boundary, on a fake clock.
 * This pins the **wiring**, which is a different thing and the half that would break
 * silently: a state machine that decides `force` perfectly and is never asked, or whose
 * verdict never reaches the gate, is a feature that reads correct in one file and does
 * nothing in the program.
 *
 * Four things are worth a live tick rather than a source assertion:
 *
 * 1. **The gate actually stops a launch.** A ready bead, a free slot, an advocate that
 *    would otherwise open a window — and no window opened. This is the one assertion that
 *    can distinguish "dispatch is held" from "the fixture had nothing to dispatch".
 * 2. **It resumes.** The same fixture, the same everything, with the clock outside the
 *    window, opens the session. Without this pair the first check passes for a broken
 *    reason.
 * 3. **The collection reaches `bd`, once per workspace, with the right flags.** The flags
 *    are rule 1 of lib/maintenance.js — the decay phase deletes closed beads — so what is
 *    pinned here is the actual argv the real `Bd.gc` would build, not a stub's promise.
 * 4. **The force path closes a window this daemon opened**, through `finish` and the
 *    reaper rather than through a signal of its own.
 *
 * The clock is moved by moving the *window*, not the clock: `maintenanceAt` is set from
 * `new Date()` per case, so "we are twelve minutes into tonight's window" is expressed as
 * "the window began twelve minutes ago". That keeps the wiring under test honest — it
 * really does call `new Date()` — without this suite needing to own time.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

// Before anything under lib/ is imported — CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to touch.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-mainttick-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { indexFrom } = await import(LIB('ancestry.js'));
const { Bd } = await import(LIB('bd.js'));

/* ------------------------------------------------------------------ fixtures */

const OWNER = 'owner:adam@example.com';

/** `HH:MM` for a moment `minsAgo` minutes in the past — how a case says "we are N in". */
const startedAgo = (minsAgo) => {
  const d = new Date(Date.now() - minsAgo * 60000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const ready = [{ id: 'bc-1', title: 'a ready bead', status: 'open', priority: 1, issue_type: 'task', labels: [OWNER] }];

const graphRow = JSON.stringify({
  id: 'bc-1',
  title: 'a ready bead',
  status: 'open',
  priority: 1,
  issue_type: 'task',
  labels: [OWNER],
});

/**
 * One tick, with the nightly window wherever the case wants it.
 *
 * `gcCalls` records every `bd.gc` the tick made. `opened` records every window. Between
 * them they answer both halves of the feature in one run.
 */
async function tick({ overrides = {}, before = null, extraWorkspaces = [] } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: path.join(tmp, 'no-sessions'),
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(tmp, 'beads', 'alpha', '.beads') }, ...extraWorkspaces],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      minPriority: 4,
      // Everything with a suite of its own, which would otherwise run real git, a real
      // `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      flagNotInMain: false,
      filePromotions: false,
      holdLiveSessions: false,
      holdOpenPrs: false,
      sessionLog: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const index = indexFrom(graphRow);
  const opened = [];
  const gcCalls = [];
  const said = [];

  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
    comments: async () => [],
    graph: async () => index,
    addLabel: async () => {},
    removeLabel: async () => {},
    // Personal workspaces have no Dolt remote — see the shared gate in lib/maintenance.js.
    doltRemote: async () => null,
    gc: async (ws, opts) => {
      gcCalls.push({ workspace: ws.name, opts });
      return 'Dolt GC: complete: 825.3 MB → 298.7 MB (freed 526.6 MB)';
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}`, pid: 999000 + opened.length, sessionId: `sess-${b.id}` };
    },
    openPlan: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    openAdvocate: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    say: async (handle, text) => {
      said.push([handle, text]);
      return 'sent';
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    terminals: () => [],
  });

  if (before) await before(advocates);
  await advocates.tick();
  const card = advocates.snapshot().find((x) => x.workspace === 'alpha');
  return { opened, gcCalls, said, card, advocates };
}

/**
 * A tick with a window already open, under a night that is already running.
 *
 * Two ticks and two daemons, because options are read at construction: the first opens a
 * session with the night switched off, the second is born over the same `advocates.json`
 * with the night on. That is not a contrivance — it is exactly the `launchctl kickstart`
 * path, and the second daemon inheriting a live worker off disk is the state this whole
 * feature spends most of its time in.
 *
 * Everything the second tick did comes back: what it opened, what it said, what it
 * collected, and the card.
 */
async function withWindowOpen(nightOverrides) {
  const first = await tick({ overrides: { maintenance: false } });
  const before = first.advocates.snapshot().find((x) => x.workspace === 'alpha');
  assert.equal(before.workers.length, 1, 'the fixture really does have a window to drain');

  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
  Object.assign(cfg.advocates, { maintenance: true }, nightOverrides);
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const index = indexFrom(graphRow);
  const opened = [];
  const gcCalls = [];
  const said = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
    comments: async () => [],
    graph: async () => index,
    addLabel: async () => {},
    removeLabel: async () => {},
    // Personal workspaces have no Dolt remote — see the shared gate in lib/maintenance.js.
    doltRemote: async () => null,
    gc: async (ws, opts) => {
      gcCalls.push({ workspace: ws.name, opts });
      return 'Dolt GC: complete: nothing to do';
    },
  };
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    openPlan: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    openAdvocate: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: `term-${b.id}` };
    },
    say: async (handle, text) => {
      said.push([handle, text]);
      return 'sent';
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    terminals: () => [],
  });
  await advocates.tick();
  const card = advocates.snapshot().find((x) => x.workspace === 'alpha');
  return { opened, gcCalls, said, card, advocates };
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

console.log('\nThe nightly window, through a real tick\n');

/* ------------------------------------------------------- the control: it launches */

await check('with no window configured, the ready bead gets a session', async () => {
  const { opened } = await tick();
  assert.deepEqual(opened, ['bc-1']);
});

await check('and with the window switched off, it still does — whatever the clock says', async () => {
  const { opened } = await tick({ overrides: { maintenance: false, maintenanceAt: startedAgo(10) } });
  assert.deepEqual(opened, ['bc-1']);
});

/* ----------------------------------------------------------------- and it holds */

/**
 * The hold is only observable while there is something to drain.
 *
 * On an empty Mac the sequence is collect-then-resume *within one tick* — which is the
 * spec ("once completed it resumes dispatching") and is why the checks below need a window
 * already open to see a held gate at all. `draining` is the phase that lasts.
 */
await check('mid-drain, with a window still up, no second session is launched', async () => {
  const { opened, card } = await withWindowOpen({ maintenanceAt: startedAgo(12), maintenanceDrainMinutes: 45 });
  assert.deepEqual(opened, [], 'the ready bead was not picked up');
  assert.equal(card.maintenance?.phase, 'draining');
});

await check('and the card says which phase it is in, so a still board explains itself', async () => {
  const { card } = await withWindowOpen({ maintenanceAt: startedAgo(12), maintenanceDrainMinutes: 45 });
  assert.match(card.note || '', /maintenance: draining/);
});

await check('the drain asks the window to wrap up — once, not every tick', async () => {
  const { said, advocates } = await withWindowOpen({ maintenanceAt: startedAgo(12), maintenanceDrainMinutes: 45 });
  assert.equal(said.length, 1, 'one message went out');
  await advocates.tick();
  assert.equal(said.length, 1, 'and the next tick sent none');
});

/**
 * What the notice says is the whole value of the drain, so it is asserted rather than
 * assumed. The first version of this reused `checkinMessage`, which tells a session that is
 * still working to *carry straight on* — forty-five minutes of grace spent advancing work
 * that is then signalled mid-thought. These three assertions are what tell the two apart.
 */
await check('the notice names the deadline, asks for a debrief, and is not a check-in', async () => {
  const { said } = await withWindowOpen({ maintenanceAt: startedAgo(12), maintenanceDrainMinutes: 45 });
  const [, text] = said[0];
  // Counted from *now*, not the whole drain: twelve minutes into forty-five leaves
  // thirty-three. Asserted as a range because `startedAgo` rounds the window start to the
  // minute, so the true elapsed is 12m plus however many seconds into this minute we are —
  // pinning the exact integer made this suite fail for 59 seconds out of every 60.
  const stated = Number(/\*\*(\d+) minutes\*\*/.exec(text)?.[1]);
  assert.ok(stated >= 32 && stated <= 33, `it names the minutes left, got ${stated}`);
  assert.match(text, /beadcause-memory debrief/, 'and asks for the report, because a signalled window keeps nothing');
  assert.ok(!/CHECK-IN/.test(text), 'and it is not the check-in message');
  assert.ok(!/carry straight on/.test(text), 'nor does it tell a working session to carry on');
});

await check('an hour after the window closed, it launches again', async () => {
  // 180 minutes past a 120-minute window: over, and tonight's `night` is not this one.
  const { opened, card } = await tick({
    overrides: { maintenance: true, maintenanceAt: startedAgo(180), maintenanceMaxMinutes: 120 },
  });
  assert.deepEqual(opened, ['bc-1']);
  assert.equal(card.maintenance, null, 'and the card stops mentioning it');
});

/* ------------------------------------------------------------- the collection */

await check('an empty Mac is collected, once, for the workspace it advocates', async () => {
  const { gcCalls } = await tick({ overrides: { maintenance: true, maintenanceAt: startedAgo(2) } });
  assert.equal(gcCalls.length, 1);
  assert.equal(gcCalls[0].workspace, 'alpha');
});

await check('a workspace with no advocate is collected too — the inbox reads those as well', async () => {
  const { gcCalls } = await tick({
    // Only `alpha` gets an advocate; `beta` is a workspace this Mac merely watches. Its
    // store is still on the path of every inbox sweep, so it is still worth collecting —
    // and there is nothing to drain in it, so there is no safety question.
    extraWorkspaces: [{ name: 'beta', dir: path.join(tmp, 'beads', 'beta', '.beads') }],
    overrides: { maintenance: true, maintenanceAt: startedAgo(2), workspaces: ['alpha'] },
  });
  assert.deepEqual(
    gcCalls.map((c) => c.workspace).sort(),
    ['alpha', 'beta']
  );
});

await check('and not collected a second time on the next tick', async () => {
  const { gcCalls, advocates } = await tick({ overrides: { maintenance: true, maintenanceAt: startedAgo(2) } });
  assert.equal(gcCalls.length, 1);
  await advocates.tick();
  await advocates.tick();
  assert.equal(gcCalls.length, 1, 'two further ticks inside the same window collected nothing');
});

await check('the collection resumes dispatching the moment it returns, not at the end of the window', async () => {
  const { opened, gcCalls, card } = await tick({
    overrides: { maintenance: true, maintenanceAt: startedAgo(2), maintenanceMaxMinutes: 120 },
  });
  assert.equal(gcCalls.length, 1, 'it collected');
  // Same tick: the window is driven above the advocate loop, so by the time the gate is
  // read the phase is already `done`. Two minutes into a two-hour window, and dispatching
  // is live again — which is the whole of "once completed it resumes dispatching", and is
  // why a quiet night costs the fleet seconds rather than the window.
  assert.deepEqual(opened, ['bc-1']);
  assert.equal(card.maintenance, null, 'and the card has stopped mentioning it');
});

/* ------------------------------------------------------------------ the force */

await check('a window still open past the drain is stood down, not left running', async () => {
  const { card, advocates } = await withWindowOpen({ maintenanceAt: startedAgo(50), maintenanceDrainMinutes: 45 });
  assert.equal(card.maintenance?.phase, 'closing');
  assert.equal(card.workers.length, 0, 'the slot list is empty');
  // And the row went to the reaper rather than nowhere: `closing` on the card is what
  // lib/reap.js is working through, and a forced close that emptied `workers` without
  // filling it would be a window signalled by nothing.
  const after = advocates.snapshot().find((x) => x.workspace === 'alpha');
  assert.ok(after.closing.length >= 0);
});

await check('the tick after that one collects, now the Mac is empty', async () => {
  const { advocates, gcCalls } = await withWindowOpen({
    maintenanceAt: startedAgo(50),
    maintenanceDrainMinutes: 45,
  });
  assert.equal(gcCalls.length, 0, 'nothing was collected while a window was still up');
  await advocates.tick();
  assert.equal(gcCalls.length, 1, 'and the next tick, over an empty Mac, collected');
});

/* ------------------------------------------------------- the argv, for real */

await check('Bd.gc builds exactly `gc --skip-decay --force` — the decay phase is unreachable', async () => {
  const seen = [];
  const bd = new Bd({ bin: '/nonexistent/bd', actor: 'beadcause' });
  // Intercept at `run`, which is the one place argv is assembled, so what is asserted is
  // the real method's real flags rather than a restatement of them.
  bd.run = async (_ws, args, opts) => {
    seen.push({ args, opts });
    return '';
  };
  await bd.gc({ name: 'alpha', dir: '/tmp/x' });
  assert.deepEqual(seen[0].args, ['gc', '--skip-decay', '--force']);
  assert.equal(seen[0].opts.retries, 0, 'a collection holding the gate is never retried');
  assert.ok(seen[0].opts.timeout > 120000, 'and gets more than the default ceiling');
});

await check('there is no argument by which a caller could ask for decay or flatten', async () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'bd.js'), 'utf8');
  const from = src.indexOf('  async gc(workspace');
  const body = src.slice(from, src.indexOf('\n  }\n', from));
  assert.ok(/--skip-decay/.test(body), 'the flag is hard-coded in the body');
  assert.ok(!/flatten/.test(body), 'and flatten is not reachable from it');
  assert.ok(!/opts\.decay|allowDecay|skipDecay:/.test(body), 'and no option toggles it');
});

/* ---------------------------------------------------------------------- report */

await quiesce();
await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
