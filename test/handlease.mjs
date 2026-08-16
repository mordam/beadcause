/**
 * The window nobody's advocate opened, and the claim that now follows it.
 *
 * bc-3p53. `launch` stakes a `held:` label before it opens a window, so every session
 * the advocate opens is visible to the other Macs (bc-bllw). Nothing else was: a bead
 * opened from the phone, a terminal seeded on one, a session started in iTerm by hand.
 * On one laptop that never showed, because `withoutLiveSessions` holds the bead on the
 * strength of the process alone; across two it is the same incident through a door the
 * lease did not cover — the process is here, the other machine has nothing to read, and
 * its advocate opens a second window on a bead only this Mac can see is taken.
 *
 * Six claims, and the second is the one the design turns on:
 *
 *   - **a window this advocate never opened stakes this Mac's claim**, off the same
 *     evidence `withoutLiveSessions` already holds the bead on — a live session whose
 *     name carries the id, or a live in-app terminal seeded on one, which is the door no
 *     name can ever speak for because that brief tells the session not to rename itself;
 *   - **and the claim comes off when the window goes**, rather than parking the bead on
 *     every other Mac until `leaseMinutes` runs out. That is the whole reason this is a
 *     sweep over live windows and not a write at the door that opened one;
 *   - **and the other Mac holds it out of its queue**, which is the point of writing it;
 *   - **and a claim it already holds is adopted, not written over**, so a restarted
 *     daemon does not leave two labels from one handle on one bead;
 *   - **and it says nothing about a worker, a `DONE-` window, or a bead another machine
 *     already holds** — three windows that are somebody else's business;
 *   - **and a solo install writes nothing at all**, the same guarantee every other part
 *     of lib/lease.js makes out of an unset `me`.
 *
 *     node test/handlease.mjs
 *
 * The harness is test/leasequeue.mjs's — one label store per machine, unioned by an
 * explicit `sync()`, because that is what a shared Dolt actually gives you — with
 * test/livequeue.mjs's session records planted into a temp directory `claudeSessionsDir`
 * points at. The pid is this process's, which is the only one a test can be sure is
 * alive: liveness is a signal-0 check, so a made-up number would be filtered out before
 * the code under test ever saw the record. No iTerm, no `bd`, no agent.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-handlease-'));
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

/** Claimed, and so out of `bd ready` — what a bead with a session sitting on it is. */
const working = (id, title, over = {}) => bead(id, title, { inProgress: true, ...over });

const ago = (minutes) => new Date(Date.now() - minutes * 60000);

/**
 * A Claude Code session record, as `~/.claude/sessions/<pid>.json`.
 *
 * `cwd` decides which workspace the record belongs to — `beadsDirFor` maps a directory
 * under `projectRoot` to a workspace exactly as the shell does — and this suite only
 * ever has one, so the default is right for every case.
 */
function plant(name, { pid = process.pid, status = 'busy', cwd = REPO } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `sess-${pid}`, name, cwd, status, startedAt: Date.now() })
  );
}

/** Every record gone: a window that has closed leaves nothing behind, and neither may a case. */
function noWindows() {
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
}

/**
 * One machine's view of the shared tracker — labels are rows, so two machines writing
 * two different ones is not a conflict, and `sync()` is the union a `bd dolt` push and
 * pull amount to.
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
    handles: (name, id) => leasesOf([...(viewFor(name).get(id) || [])]).map((l) => l.handle),
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

/** One advocate, on one Mac, over one machine's view. `handle` is `cfg.me`; null is a solo install. */
function machine(w, rows, { handle, overrides = {}, terms = [] } = {}) {
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
  // How many times each id was read. The whole cost of this feature is one `bd show` per
  // hand-opened window per half a lease, and only a counter can keep that claim.
  const shows = new Map();
  const bd = {
    ready: async () =>
      rows.filter((r) => !r.closed && !r.inProgress).map((r) => ({ ...r, labels: [...(view.get(r.id) || [])] })),
    listLabel: async () => [],
    show: async (_ws, id) => {
      shows.set(id, (shows.get(id) || 0) + 1);
      const row = rows.find((r) => r.id === id);
      // Null for a bead this workspace does not have, which is what the real one answers
      // and what a hyphenated word in a window title has to run into.
      if (!row) return null;
      return { ...row, status: row.closed ? 'closed' : 'in_progress', labels: [...(view.get(id) || [])] };
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
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    // Read fresh on every call rather than captured, so a case can end a terminal between
    // ticks — which is the whole of how a pty's claim is released.
    terminals: () => terms,
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

/** A clean CONFIG_DIR and no leftover windows: otherwise case N is still holding case N+1's bead. */
async function reset() {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  noWindows();
}

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  await reset();
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

/** The hole, in the smallest shape that has it: a window this advocate did not open. */
await check('a hand-opened window stakes this Mac claim', async () => {
  const rows = [working('al-1', 'opened from the phone')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 opened from the phone');

  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), ['alpha'], 'the window is published as a claim');
});

/**
 * And the point of writing it: the other Mac, after a sync, holds the bead rather than
 * opening a second window on it. Without the claim `al-1` is merely `in_progress` over
 * there — which is where bc-bllw's incident says the second window comes from.
 */
await check('and the other Mac holds it out of its queue', async () => {
  const rows = [bead('al-1', 'opened from the phone')];
  const w = world(rows);
  // Both machines before either ticks: a view is created from `rows` the first time it is
  // asked for, so a Mac built after the sync would be built from the unsynced world and
  // the case would pass or fail for the wrong reason.
  const alpha = machine(w, rows, { handle: 'alpha' });
  const beta = machine(w, rows, { handle: 'beta' });

  plant('Beadcause - al-1 opened from the phone');
  await alpha.tick();

  w.sync();
  // The window is on alpha's Mac, and beta cannot see a process on another laptop — the
  // label is the whole of what it has to go on.
  noWindows();
  const card = await beta.tick();

  assert.deepEqual(beta.opened, [], 'no second window on the other Mac');
  assert.deepEqual((card.heldByLease || []).map((h) => h.id), ['al-1'], 'held, and said so on the card');
  assert.match(card.heldByLease[0].why, /alpha/, card.heldByLease[0].why);
});

/**
 * The half that made this a bead rather than a line. A hand-opened window has no worker
 * record, so nothing would ever renew or drop its claim — and staking one that only
 * `leaseMinutes` can end parks the bead on every other Mac for an hour after the window
 * closed, which lib/lease.js calls strictly worse than the duplicate it prevents.
 */
await check('and the claim comes off when the window goes', async () => {
  const rows = [working('al-1', 'opened from the phone')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 opened from the phone');
  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), ['alpha'], 'staked first');

  noWindows();
  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), [], 'and released on the tick after the window went');
});

/**
 * A claim already ours is adopted rather than restaked — the case a restarted daemon is
 * in, since the record of what it staked lives in memory and the labels do not. Two
 * labels from one handle would be a second row to sync and a bead `leaseVerdict` reports
 * as contested by a machine that is not contesting anything.
 */
await check('a claim it already holds is adopted, not doubled', async () => {
  const fresh = leaseLabel('alpha', ago(5));
  const rows = [working('al-1', 'a', { labels: [fresh] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  assert.deepEqual(w.labels('alpha', 'al-1'), [fresh], 'the same one label, unchanged');
});

/** …and one halfway through its life is restamped, with the old one taken off after. */
await check('and one past half its life is restamped', async () => {
  const stale = leaseLabel('alpha', ago(40));
  const rows = [working('al-1', 'a', { labels: [stale] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  const now = w.labels('alpha', 'al-1');
  assert.equal(now.length, 1, `one claim, not two: ${now.join(', ')}`);
  assert.notEqual(now[0], stale, 'and it is a fresher stamp');
  assert.deepEqual(leasesOf(now).map((l) => l.handle), ['alpha']);
});

/**
 * A window this advocate *did* open is a worker, and `launch` staked its claim before the
 * window existed. Renewing it is `reconcile`'s job, and a second mechanism writing a
 * second label on the same bead is the bug this case exists to keep out.
 */
await check('a worker window is left to the launch that staked it', async () => {
  const rows = [bead('al-1', 'ordinary ready work')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  await alpha.tick();
  assert.deepEqual(alpha.opened, ['al-1'], 'the advocate opened it itself');
  // And now the window names its bead, exactly as a worker's does once it has renamed
  // itself — which is the moment a sweep over live windows could double-claim it.
  plant('Beadcause - al-1 ordinary ready work');
  await alpha.tick();

  assert.equal(w.labels('alpha', 'al-1').length, 1, `one claim, not two: ${w.labels('alpha', 'al-1').join(', ')}`);
});

/** A subtask under a worker is the same window's subtree, and the ancestor's claim covers it. */
await check('nor a window on a bead under one', async () => {
  const rows = [bead('al-1', 'the epic', { issue_type: 'epic' }), working('al-1.2', 'a child of it')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });

  await alpha.tick();
  assert.deepEqual(alpha.opened, ['al-1'], 'the epic is the work the advocate took on');
  plant('Beadcause - al-1.2 a child of it');
  await alpha.tick();

  assert.deepEqual(w.handles('alpha', 'al-1.2'), [], 'the child is covered by the claim on the epic');
});

/** A session finished by its own account is not working the bead, and its window may sit for an hour. */
await check('a DONE- window claims nothing', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('DONE-Beadcause - al-1 a');

  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), []);
});

/**
 * Another machine already holds it. A later claim of ours loses the tiebreak anyway, and
 * writing one would only tell the holder's card the bead is contested — when nothing here
 * is going to stand down, because this window is a person at a keyboard.
 */
await check('a bead another Mac holds is not claimed over', async () => {
  const rows = [working('al-1', 'a', { labels: [leaseLabel('beta', ago(2))] })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), ['beta'], 'beta keeps it, and alpha wrote nothing');
});

/** A closed bead is nobody's to hold, and a window can easily outlive the close. */
await check('a closed bead is not claimed', async () => {
  const rows = [bead('al-1', 'a', { closed: true })];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), []);
});

/**
 * `beadInName` matches a shape, not a tracker, so a hyphenated word in a window title
 * reads as an id. The tracker is what settles it, and a bead it does not have is nothing
 * to write a label on.
 */
await check('a hyphenated word that is not a bead claims nothing', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - api-cache the vendor bundles');

  await alpha.tick();
  assert.deepEqual(w.labels('alpha', 'api-cache'), [], 'nothing written for a word');
  assert.equal(alpha.reads('api-cache'), 1, 'asked once');
});

/** One read per window per half a lease: the negative answer is remembered too. */
await check('it costs one read per window, not one per tick', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha' });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  await alpha.tick();
  await alpha.tick();
  assert.equal(alpha.reads('al-1'), 1, 'read once, then answered from the claim it holds');
});

/**
 * The door a name can never speak for: an in-app terminal seeded on a bead is told not to
 * rename itself, so no session record will ever carry its id. The pty register is the
 * evidence instead, and it is exact — this daemon starts and ends it.
 */
await check('a terminal seeded on a bead claims it with no session name at all', async () => {
  const rows = [working('al-1', 'asked from the phone')];
  const w = world(rows);
  const terms = [{ id: 't1', workspace: 'alpha', status: 'live', bead: { id: 'al-1', title: 'asked from the phone' } }];
  const alpha = machine(w, rows, { handle: 'alpha', terms });

  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), ['alpha'], 'claimed off the register, with nothing planted');
});

/** …and gives it back the moment that pty ends. */
await check('and a terminal that ended holds nothing', async () => {
  const rows = [working('al-1', 'asked from the phone')];
  const w = world(rows);
  const terms = [{ id: 't1', workspace: 'alpha', status: 'live', bead: { id: 'al-1', title: 'a' } }];
  const alpha = machine(w, rows, { handle: 'alpha', terms });
  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), ['alpha'], 'staked first');

  terms[0].status = 'exited';
  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), [], 'released with the pty');
});

/**
 * And a resumable one holds nothing either. It is a conversation waiting to be picked up,
 * with no process behind it and possibly days before anybody does — which is the park
 * lib/lease.js calls worse than the duplicate window the lease exists to prevent.
 */
await check('a resumable terminal claims nothing', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const terms = [{ id: 't1', workspace: 'alpha', status: 'resumable', bead: { id: 'al-1', title: 'a' } }];
  const alpha = machine(w, rows, { handle: 'alpha', terms });

  await alpha.tick();
  assert.deepEqual(w.handles('alpha', 'al-1'), []);
});

/** The single-person install, which is what `me` unset means and what most installs are. */
await check('a Mac with no handle writes nothing', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const solo = machine(w, rows, { handle: null });
  plant('Beadcause - al-1 a');

  await solo.tick();
  assert.deepEqual(w.labels('solo', 'al-1'), [], 'no handle, no label, nothing to read differently anywhere');
  assert.equal(solo.reads('al-1'), 0, 'and not even a read');
});

/** Off with the federation switch… */
await check('holdLeases: false writes nothing', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha', overrides: { holdLeases: false } });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  assert.deepEqual(w.labels('alpha', 'al-1'), []);
});

/**
 * …and off with the window switch too. A window is the only evidence this has, so an
 * advocate told not to treat an open window as a bead being worked has no business
 * telling the other machines that it is.
 */
await check('holdLiveSessions: false writes nothing either', async () => {
  const rows = [working('al-1', 'a')];
  const w = world(rows);
  const alpha = machine(w, rows, { handle: 'alpha', overrides: { holdLiveSessions: false } });
  plant('Beadcause - al-1 a');

  await alpha.tick();
  assert.deepEqual(w.labels('alpha', 'al-1'), []);
});

/* --------------------------------------------------------------------- done */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} checks passed`);
process.exit(failures ? 1 : 0);
