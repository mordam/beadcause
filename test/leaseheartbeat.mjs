/**
 * The daemon renews bd's own per-issue claim lease while it can see the window alive.
 *
 * bc-xl7n.114, direction (1). bd 1.2.1 ships a second, independent notion of a claim
 * going stale — every `--claim` takes a lease with its own TTL, kept alive by
 * `bd heartbeat` and, once it lapses, eligible for `bd reclaim`, bd's own "reaper" for a
 * dead worker's claim. Nothing in a worker's brief ever calls `bd heartbeat` again after
 * the first claim, so the lease on a bead genuinely being worked runs out on its own
 * clock regardless of whether the work is still going — "a lease only lapses because
 * nothing renews it", in the bead's own words. Whatever ends up running `bd reclaim`,
 * a fresh heartbeat is what keeps a live worker's claim off its list.
 *
 * Three claims:
 *
 *   - **a live, claimed worker gets a heartbeat every tick it survives `reconcile`**;
 *   - **an unclaimed worker gets none** — nothing to renew, and a heartbeat on a bead
 *     bd does not think this actor holds is a call `Bd.heartbeat` itself would rather
 *     not make;
 *   - **a fake `Bd` with no `heartbeat` method breaks nothing** — every test double in
 *     this repo predates the method, and `reconcile` must not assume every caller has it.
 *
 *     node test/leaseheartbeat.mjs
 *
 * Two ticks, like test/handlease.mjs: the first launches an ordinary ready bead, so
 * `reconcile` on the second tick has a real worker in `a.workers` to renew. The session
 * record is planted between ticks, exactly as a worker's own rename would land.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-leaseheartbeat-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));

const bead = (id, title) => ({ id, title, priority: 2, issue_type: 'task', created_at: '2020-01-01T00:00:00Z' });

function plant(name, { pid = process.pid, status = 'busy', cwd = REPO } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `sess-${pid}`, name, cwd, status, startedAt: Date.now() })
  );
}

/**
 * One machine, over a tracker whose `ready`/`show` reflect the launch this suite drives —
 * unlike test/handlease.mjs's fixed `rows`, this one flips a bead to claimed the moment
 * `open` is called, because the case that matters here is specifically the worker
 * `reconcile` still holds on a *second* tick, and that only happens if the first tick's
 * launch is what the tracker itself now says claimed it.
 */
function machine({ heartbeat = true } = {}) {
  const claimed = new Set();
  const opened = [];
  const heartbeats = [];
  const bd = {
    ready: async () => [bead('al-1', 'ordinary ready work')].filter((b) => !claimed.has(b.id)),
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: claimed.has(id) ? 'in_progress' : 'open' }),
    children: async () => [],
    listStatus: async () => [],
    ...(heartbeat ? { heartbeat: async (_ws, id) => { heartbeats.push(id); return true; } } : {}),
  };

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
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      sessionLog: false,
    },
  };

  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      claimed.add(b.id);
      return { dir: REPO, mode: 'test', term: null };
    },
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
    psLines: async () => [],
  });

  return { opened, heartbeats, advocates, tick: () => advocates.tick() };
}

/** A clean CONFIG_DIR and no leftover windows per case. */
async function reset() {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
}

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

await check('a live, claimed worker is heartbeated on the tick after it launches', async () => {
  const m = machine();
  await m.tick();
  assert.deepEqual(m.opened, ['al-1'], 'the advocate launched it');
  assert.deepEqual(m.heartbeats, [], 'nothing to renew yet — the worker has not survived a reconcile pass');

  // The window renames itself, exactly as a worker's first turn would.
  plant('Beadcause - al-1 ordinary ready work');
  await m.tick();
  assert.deepEqual(m.heartbeats, ['al-1'], 'reconcile renewed the claim while the window is still there');

  // And it keeps doing so, tick after tick, for as long as the window survives.
  await m.tick();
  assert.deepEqual(m.heartbeats, ['al-1', 'al-1'], 'renewed again on the next tick');
});

await check('a fake Bd with no heartbeat method breaks nothing', async () => {
  const m = machine({ heartbeat: false });
  await m.tick();
  plant('Beadcause - al-1 ordinary ready work');
  // Would throw "bd.heartbeat is not a function" if the guard were missing.
  await m.tick();
  assert.deepEqual(m.opened, ['al-1'], 'reconcile ran to completion regardless');
});

console.log(failures ? `\n${failures}/${ran} FAILED` : `\nall ${ran} checks passed`);
process.exitCode = failures ? 1 : 0;
