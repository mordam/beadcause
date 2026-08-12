/**
 * Two Macs, one synced tracker, and exactly one window on the bead.
 *
 * bc-bllw. Every filter in lib/advocate.js reads this process's own knowledge — busy
 * ids, attempt counts, `a.workers` — so nothing in it can see that another machine is
 * already on a bead. lib/sync.js is two minutes wide, which means the obvious fix is not
 * available: claim-then-check inside that window is two local writes that both succeed.
 * lib/lease.js resolves the collision *afterwards* instead, off a label both machines can
 * read, and this is where that is tested against the real tick.
 *
 * Five claims, and the third is the one that would be quietly dropped:
 *
 *   - **no window** over a bead another Mac holds a live claim on;
 *   - **and it is visible as held**, with the handle on it, because a queue that shrinks
 *     in silence reads exactly like an advocate that has decided there is nothing to do;
 *   - **and when both machines claim inside the sync window, exactly one survives** —
 *     not two, which is the bug, and not zero, which is worse;
 *   - **and a claim whose holder went away expires**, because a bead parked forever costs
 *     more than the duplicate window this exists to prevent;
 *   - **and a claim holds the subtree under it** (bc-etbq), because one window can be
 *     responsible for an epic and its children while only the epic carries a label — so a
 *     child that looks unclaimed to every other machine is not.
 *
 *     node test/leasequeue.mjs
 *
 * Built on test/livequeue.mjs's harness — `open` is injected, so a tick that would have
 * opened an iTerm window pushes a bead id onto an array. The tracker is faked as what
 * Dolt actually gives you: **one label store per machine**, unioned only when `sync()` is
 * called. That is the whole point — a test whose two advocates share one label store
 * cannot stage the race, because the second machine would see the first one's claim
 * before it ever wrote its own.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-leasequeue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { leaseLabel, leasesOf } = await import(LIB('lease.js'));

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

const ago = (minutes) => new Date(Date.now() - minutes * 60000);

/**
 * The bead the *other* machine is working: claimed, so out of `bd ready` entirely, and
 * therefore not in the labels the survey already has. It is the interesting fixture for
 * bc-etbq — the ancestor whose claim holds a subtree is usually one nothing here can see
 * for free, and it is the only case that costs a read.
 */
const working = (id, title, over = {}) => bead(id, title, { inProgress: true, ...over });

/**
 * The batch head on the other Mac, as the tracker shows it from here: an epic, claimed, and
 * carrying one machine's claim. An **epic**, because that is the qualifier — a batch head is
 * always one, and a session on a plain parent speaks only for the bead it was handed.
 */
const heldEpic = (id, handle, minutes = 2) =>
  working(id, 'the epic', { issue_type: 'epic', labels: [leaseLabel(handle, ago(minutes))] });

/**
 * One machine's view of the shared tracker.
 *
 * Labels are rows, so two machines writing two different ones is not a conflict Dolt has
 * to resolve — it is two rows, and after a sync both machines see both. `sync` is that
 * union, and calling it is what a `bd dolt pull` and push amount to for this feature.
 */
function world(rows) {
  const machines = new Map();
  const viewFor = (name) => {
    if (!machines.has(name)) machines.set(name, new Map(rows.map((r) => [r.id, new Set(r.labels || [])])));
    return machines.get(name);
  };
  return {
    viewFor,
    labels: (name, id) => [...(viewFor(name).get(id) || [])],
    sync() {
      const union = new Map();
      for (const view of machines.values()) {
        for (const [id, set] of view) {
          if (!union.has(id)) union.set(id, new Set());
          for (const l of set) union.get(id).add(l);
        }
      }
      for (const view of machines.values()) {
        for (const [id, set] of union) view.set(id, new Set(set));
      }
    },
  };
}

/**
 * One advocate, on one Mac, over one machine's view of the tracker.
 *
 * `handle` is `cfg.me` — what makes this machine a machine rather than the single-person
 * install every other suite here runs as. Null is that install, and it is a case.
 */
function machine(w, rows, { handle, overrides = {}, bdOver = {} } = {}) {
  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: SESSIONS,
    me: handle,
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(os.homedir(), 'beads', 'alpha', '.beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Features with their own suites, each of which would otherwise run real git, a
      // real `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      holdOpenPrs: false,
      sessionLog: false,
      ...overrides,
    },
  };

  const view = w.viewFor(handle || 'solo');
  const opened = [];
  // How many times each id was actually read. The subtree rule (bc-etbq) is the one part
  // of this filter that can cost a `bd` call, and "one per ancestor per pass, whatever the
  // queue looks like" is a claim a cache makes and only a counter can keep.
  const shows = new Map();
  const bd = {
    // `inProgress` is out of `bd ready` for the same reason the real one is: somebody is on
    // it. It is still readable by id, which is the whole difference that matters here.
    ready: async () =>
      rows.filter((r) => !r.closed && !r.inProgress).map((r) => ({ ...r, labels: [...(view.get(r.id) || [])] })),
    listLabel: async () => [],
    show: async (_ws, id) => {
      shows.set(id, (shows.get(id) || 0) + 1);
      // The whole row and not three fields of it, because `leaseHolderAbove` reads the type:
      // a claim on an epic above a bead holds it, and a claim on a plain parent does not.
      const row = rows.find((r) => r.id === id);
      return {
        ...(row || { id, issue_type: 'task' }),
        status: row?.closed ? 'closed' : 'in_progress',
        labels: [...(view.get(id) || [])],
      };
    },
    children: async () => [],
    listStatus: async () => [],
    addLabel: async (_ws, id, label) => {
      if (!view.has(id)) view.set(id, new Set());
      view.get(id).add(label);
    },
    removeLabel: async (_ws, id, label) => {
      view.get(id)?.delete(label);
    },
    ...bdOver,
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
  });

  return {
    opened,
    advocates,
    reads: (id) => shows.get(id) || 0,
    async tick() {
      await advocates.tick();
      return advocates.snapshot().find((a) => a.workspace === 'alpha');
    },
  };
}

/** A clean CONFIG_DIR per case: otherwise case N's worker is still holding case N+1's bead. */
function reset() {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
}

const heldIds = (card) => (card.heldByLease || []).map((h) => h.id);

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  reset();
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

/** The straightforward half: the other Mac's claim arrived before we looked. */
await check('a bead another Mac holds gets no window', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('beta', ago(2))] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, [], 'beta is on it');
  assert.equal(card.queue, 0, 'and it is out of the queue, not merely unpicked');
  assert.deepEqual(heldIds(card), ['x-1'], 'held rather than vanished');
  assert.equal(card.heldByLease[0].handle, 'beta', 'the card names the machine to go and ask');
  assert.match(card.note, /claimed by another Mac/, card.note);
  assert.doesNotMatch(card.note, /clear/, card.note);
});

/** And the bead beside it, which nobody has claimed, is still worked. */
await check('it holds only the bead the claim names', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('beta', ago(2))] }), bead('x-2', 'b')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-2']);
});

/** Opening a window stakes a claim, before iTerm rather than after it. */
await check('a launch claims the bead for this Mac', async () => {
  const rows = [bead('x-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1']);
  const held = leasesOf(w.labels('alpha', 'x-1'));
  assert.equal(held.length, 1, 'one claim');
  assert.equal(held[0].handle, 'alpha', 'and it names this Mac');
});

/**
 * The race, staged as it actually happens: both machines look before either has synced,
 * so both see an unclaimed bead, both claim it and both open a window. The sync is what
 * makes the collision visible, and the tick after it is where exactly one of them has to
 * survive — not two, which is the bug, and not zero, which is worse.
 */
await check('two Macs claim inside the sync window and exactly one survives', async () => {
  const rows = [bead('x-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  const beta = machine(w, rows, { handle: 'beta' });

  await alpha.tick();
  await beta.tick();
  assert.deepEqual(alpha.opened, ['x-1'], 'both believed they won');
  assert.deepEqual(beta.opened, ['x-1'], 'which is the state the design admits to');

  w.sync();
  const onAlpha = await alpha.tick();
  const onBeta = await beta.tick();

  assert.equal(onAlpha.workers.length, 1, 'the earlier claim keeps its window');
  assert.equal(onBeta.workers.length, 0, 'and the later one gives its up');
  assert.deepEqual(alpha.opened, ['x-1'], 'nobody opens a second window');
  assert.deepEqual(beta.opened, ['x-1']);

  assert.equal(onBeta.stoodDown.length, 1, 'the machine that lost says so on its card');
  assert.equal(onBeta.stoodDown[0].id, 'x-1');
  assert.match(onBeta.stoodDown[0].why, /alpha/, onBeta.stoodDown[0].why);
  assert.equal(onAlpha.stoodDown.length, 0, 'and the one that won says nothing of the sort');

  // The loser's claim comes off, so the bead converges on one holder rather than staying
  // contested — and the winner is still holding it, which is what stops the next tick
  // handing it back to the machine that just let it go.
  const left = leasesOf(w.labels('beta', 'x-1')).map((l) => l.handle);
  assert.deepEqual(left, ['alpha']);
  assert.deepEqual(heldIds(onBeta), ['x-1'], 'and it reads as held, not as gone');
});

/**
 * The half that stops this being worse than the problem. A Mac that slept mid-bead stops
 * restamping its claim; an hour later the work is available again rather than parked on
 * a machine nobody can wake.
 */
await check('a claim whose holder went away expires', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('asleep', ago(180))] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha', overrides: { leaseMinutes: 60 } });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1'], 'three hours is past its life');
  assert.deepEqual(heldIds(card), [], 'and nothing is held');
});

/** …and one inside its life still holds, which is the other half of the same number. */
await check('a claim inside its life still holds', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('awake', ago(30))] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha', overrides: { leaseMinutes: 60 } });

  await alpha.tick();
  assert.deepEqual(alpha.opened, []);
});

/**
 * This Mac's own claim on a *ready* bead is a released one — the worker ended, or a
 * delivery reopened it — and holding a bead behind our own claim would be an advocate
 * refusing its own work forever.
 */
await check('this Mac is not held by its own claim', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('alpha', ago(5))] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1']);
  assert.deepEqual(heldIds(card), []);
});

/** A worker that ends releases the bead, rather than leaving the other Mac to wait it out. */
await check('a finished worker gives the claim back', async () => {
  const rows = [bead('x-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  await alpha.tick();
  assert.equal(leasesOf(w.labels('alpha', 'x-1')).length, 1);

  rows[0].closed = true; // the session closed its bead on the way out
  await alpha.tick();
  assert.deepEqual(leasesOf(w.labels('alpha', 'x-1')), [], 'the claim came off with the worker');
});

/**
 * The guarantee lib/addressee.js makes and this inherits: with `me` unset there is no
 * branch to enter, so a single-person install writes no labels and is held by none.
 */
await check('a Mac that does not know who it is claims nothing', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('somebody', ago(2))] })];
  const w = world(rows);
  const solo = machine(w, rows, { handle: null });

  const card = await solo.tick();
  assert.deepEqual(solo.opened, ['x-1'], 'nobody else exists as far as this install knows');
  assert.deepEqual(heldIds(card), []);
  assert.deepEqual(leasesOf(w.labels('solo', 'x-1')).map((l) => l.handle), ['somebody'], 'and it wrote none');
});

/** Off is off. */
await check('holdLeases: false launches anyway', async () => {
  const rows = [bead('x-1', 'a', { labels: [leaseLabel('beta', ago(2))] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha', overrides: { holdLeases: false } });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1']);
  assert.deepEqual(heldIds(card), []);
  assert.deepEqual(leasesOf(w.labels('alpha', 'x-1')).map((l) => l.handle), ['beta'], 'and stakes nothing');
});

/* ------------------------------------------------------- and one level up (bc-etbq) */

/**
 * The hole a batch head opens. One window on the other Mac is responsible for an epic and
 * its ready children, and the only thing leased is the epic — so the children look
 * unclaimed to every machine but that one, and `a.workers` cannot help because the worker
 * belongs to somebody else's daemon. A claim on an ancestor is a claim on the subtree.
 */
await check('a bead inside another Mac subtree gets no window', async () => {
  const rows = [heldEpic('x-1', 'beta'), bead('x-1.1', 'a child')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, [], 'beta has a window over the whole subtree');
  assert.deepEqual(heldIds(card), ['x-1.1'], 'held rather than vanished');
  assert.equal(card.heldByLease[0].handle, 'beta', 'and the card names the machine to go and ask');
  assert.match(card.heldByLease[0].why, /on x-1, which is above it/, card.heldByLease[0].why);
  assert.match(card.note, /claimed by another Mac/, card.note);
  assert.doesNotMatch(card.note, /clear/, card.note);
});

/** However deep. The claim is on the subtree, and a grandchild is in it. */
await check('however far down the subtree it is', async () => {
  const rows = [heldEpic('x-1', 'beta'), bead('x-1.2.3', 'a grandchild')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, []);
  assert.match(card.heldByLease[0].why, /on x-1, which is above it/, card.heldByLease[0].why);
});

/**
 * And no further than the subtree, which is the half that keeps this from being a machine
 * for parking work: a claim on one child says nothing about its siblings, and an id that
 * merely starts alike is not underneath anything.
 */
await check('it holds the subtree and nothing beside it', async () => {
  const rows = [
    working('x-1.1', 'the child being worked', { labels: [leaseLabel('beta', ago(2))] }),
    bead('x-1.2', 'its sibling'),
    bead('x-12', 'a bead whose id merely starts alike'),
    bead('x-2', 'somewhere else entirely'),
  ];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(heldIds(card), [], 'nothing in this queue is under x-1.1');
  assert.deepEqual([...alpha.opened].sort(), ['x-1.2', 'x-12', 'x-2'], `opened ${alpha.opened.join(', ')}`);
});

/**
 * And the qualifier, which is the other half of "nothing beside it". `heldByChildren` fires
 * its upward check only against a **batch head**, and test/twinqueue.mjs holds that line for
 * this laptop: a session handed one plain parent speaks for one bead, and holding its
 * children behind it would leave nobody doing either. The rule here cannot see whether the
 * other machine's window took a batch — a label says a machine and a moment — so it uses the
 * one thing a batch head always is, and the two rules then agree. They have to: the same two
 * beads must not resolve one way when the window is on this Mac and another way when it is
 * on the next desk.
 */
await check('a claim on a plain parent holds nothing under it', async () => {
  const rows = [
    working('x-1', 'a plain parent, being worked', { labels: [leaseLabel('beta', ago(2))] }),
    bead('x-1.1', 'a child'),
  ];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(heldIds(card), [], 'a parent is not a subtree');
  assert.deepEqual(alpha.opened, ['x-1.1']);
});

/**
 * What it costs, which is the argument for asking this at all: one read per ancestor per
 * pass however many children are in the queue, and none at all for a bead with no parent.
 */
await check('the ancestor is read once for the whole queue', async () => {
  const rows = [
    heldEpic('x-1', 'beta'),
    bead('x-1.1', 'a child'),
    bead('x-1.2', 'another'),
    bead('x-1.3', 'a third'),
    bead('x-2', 'a bead with no parent'),
  ];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(heldIds(card), ['x-1.1', 'x-1.2', 'x-1.3']);
  assert.equal(alpha.reads('x-1'), 1, 'three children, one read');
  assert.equal(alpha.reads('x-2'), 0, 'and the bead with no parent asked nothing');
});

/** A tracker that will not answer holds nothing back — the queue is not its to empty. */
await check('a bd that cannot answer holds nothing', async () => {
  const rows = [heldEpic('x-1', 'beta'), bead('x-1.1', 'a child')];
  const w = world(rows);
  const alpha = machine(w, rows, {
    handle: 'alpha',
    bdOver: {
      show: async (_ws, id) => {
        if (id === 'x-1') throw new Error('dolt: database locked');
        return { id, status: 'in_progress', labels: [] };
      },
    },
  });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1.1'], 'cannot tell is not the same as held');
  assert.deepEqual(heldIds(card), []);
});

/**
 * Our own claim above a bead is not somebody else's. A released lease on the parent — the
 * worker ended, the delivery reopened it — must not park its children on this Mac forever.
 * Whether a *live* local worker on the parent should hold them is `heldByChildren`'s
 * question and not this filter's; it is deliberately narrower, because about this laptop
 * there is a whole worker record to look at rather than one label.
 */
await check('this Mac is not held by its own claim above it', async () => {
  const rows = [heldEpic('x-1', 'alpha', 5), bead('x-1.1', 'a child')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  const card = await alpha.tick();
  assert.deepEqual(heldIds(card), [], 'nothing held by a claim of ours');
  assert.deepEqual(alpha.opened, ['x-1.1']);
});

/** The single-person guarantee, one level up: no handle, no subtree, no read. */
await check('a Mac that does not know who it is is held by no subtree', async () => {
  const rows = [heldEpic('x-1', 'somebody'), bead('x-1.1', 'a child')];
  const w = world(rows);
  const solo = machine(w, rows, { handle: null });

  const card = await solo.tick();
  assert.deepEqual(solo.opened, ['x-1.1'], 'nobody else exists as far as this install knows');
  assert.deepEqual(heldIds(card), []);
  assert.equal(solo.reads('x-1'), 0, 'and it did not even ask');
});

/** Off is off, one level up too. */
await check('holdLeases: false enters the subtree anyway', async () => {
  const rows = [heldEpic('x-1', 'beta'), bead('x-1.1', 'a child')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha', overrides: { holdLeases: false } });

  const card = await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1.1']);
  assert.deepEqual(heldIds(card), []);
});

/**
 * The race the queue filter cannot reach, and the reason `reconcile` has to ask the same
 * question. Both machines look before either has synced: Mac A takes the parent — a batch
 * head takes the epic — and a child goes ready a moment later, so Mac B, which cannot see
 * A's claim yet, correctly holds the parent back and opens a window on the child instead.
 * Two windows in one subtree on two machines, which is bc-thid with the guard removed.
 *
 * The sync makes it visible, and the tick after it is where exactly one has to survive: the
 * machine above stands nobody down, so the answer cannot be zero, and the machine inside
 * withdraws rather than carrying a second branch for the same work.
 */
await check('two Macs in one subtree and exactly one survives', async () => {
  // One child, so `minBatchBeads` means nobody forms a batch here and the epic launches as
  // an ordinary bead: the race does not need batching to run, only a window above a window.
  const rows = [bead('x-1', 'the epic', { issue_type: 'epic' })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  const beta = machine(w, rows, { handle: 'beta' });

  await alpha.tick();
  assert.deepEqual(alpha.opened, ['x-1'], 'A is responsible for the epic');

  // The child goes ready under it — the sibling a batch head would have carried, or simply
  // a subtask that unblocked. B has not synced, so nothing it can see says A is in here.
  rows.push(bead('x-1.1', 'a child'));
  await beta.tick();
  assert.deepEqual(beta.opened, ['x-1.1'], 'and B opens a second window inside the same subtree');

  w.sync();
  const onAlpha = await alpha.tick();
  const onBeta = await beta.tick();

  assert.equal(onAlpha.workers.length, 1, 'the machine above keeps its window');
  assert.equal(onBeta.workers.length, 0, 'and the one inside gives its up');
  assert.deepEqual(alpha.opened, ['x-1'], 'nobody opens a third window');
  assert.deepEqual(beta.opened, ['x-1.1'], 'and the one that stood down does not try again');

  assert.equal(onBeta.stoodDown.length, 1, 'the machine that lost says so on its card');
  assert.equal(onBeta.stoodDown[0].id, 'x-1.1');
  assert.match(onBeta.stoodDown[0].why, /x-1, which is above this one/, onBeta.stoodDown[0].why);
  assert.match(onBeta.stoodDown[0].why, /alpha/, onBeta.stoodDown[0].why);
  assert.equal(onAlpha.stoodDown.length, 0, 'and the one that won says nothing of the sort');

  // The withdrawn claim comes off the child, and the subtree converges on the one holder.
  assert.deepEqual(leasesOf(w.labels('beta', 'x-1.1')), [], 'B lets the child go');
  assert.deepEqual(leasesOf(w.labels('beta', 'x-1')).map((l) => l.handle), ['alpha']);
  assert.deepEqual(heldIds(onBeta), ['x-1.1'], 'and the child reads as held, not as gone');
  // The parent is held too, by the older rule and not by this one: `heldByChildren` runs
  // ahead of the whole filter chain, so an epic whose child is ready never reaches the
  // lease filter at all. Worth pinning — the two rules holding one subtree for two
  // different reasons is what makes the card add up to "nothing ready" rather than "clear".
  assert.deepEqual(
    (onBeta.heldByChildren || []).map((h) => h.id),
    ['x-1']
  );
  assert.doesNotMatch(onBeta.note, /clear/, onBeta.note);
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
