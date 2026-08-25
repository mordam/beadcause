/**
 * A bead whose merge-bead already closed on a merge does not get a second window while
 * its own close is still retrying.
 *
 * bc-4r10.20. `finish` in lib/mergequeue.js closes the merge-bead first and the work
 * bead second, and the two are not one write: the second close can be refused (a
 * blocker with nothing to do with this pull request) or throw after `Bd.close` has
 * already spent its one `--force` attempt. Either way `oweClose` (lib/owed.js) records
 * it and `sweepOwed` retries it every poll — but the ledger entry can exist for one beat
 * before that retry runs, and in that beat `bd ready` already shows the bead as
 * unblocked, because its blocker (the merge-bead) is the thing that just closed.
 * bc-4r10.9 sat open for four days on exactly this shape before `sweepOwed` even
 * existed to retry it.
 *
 * `withoutOwed` is the filter: a bead whose `workspace/id` is a key in
 * `owed-closes.json` is held out of the queue, the way `withoutOrphans` holds a bead
 * with no root above it. Two things are worth asserting separately, as in
 * test/twinqueue.mjs:
 *
 *   - **no window opens** on a bead the ledger says is owed a close;
 *   - **it is visible as held**, on the card, naming what it is waiting on — a queue
 *     that silently drops work reads exactly like an advocate that has run dry.
 *
 *     npm test
 *     node test/owedqueue.mjs
 *
 * `open` is injected, as in test/twinqueue.mjs and test/epicqueue.mjs: a tick that
 * would have opened an iTerm window pushes a bead id onto an array instead. No iTerm,
 * no `bd`, no agent — and, since `oweClose`/`readOwed` write and read a real file,
 * nothing outside a temp config dir this suite owns and cleans up.
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
// both advocates.json and owed-closes.json belong to this suite's own temp dir rather
// than to whatever the daemon on this laptop has written.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-owedqueue-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(SESSIONS, { recursive: true });
fs.mkdirSync(REPO, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { oweClose, readOwed, OWED_PATH } = await import(LIB('owed.js'));

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

/**
 * One tick, over a tracker that says what the case needs it to. Copied from
 * test/twinqueue.mjs, minus the `inProgress` half this suite has no use for.
 */
async function tick({ ready = [], owed = [], rawOwed = null, overrides = {} } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // A clean slate per case, ledger included — `owed` (and `rawOwed`, for the unreadable
  // case) is what puts it back, so a case that wants a record present writes it through
  // this function rather than around it. `quiesce` + `removeTree` rather than a bare
  // recursive `rmSync`, per test/tmpadoption.mjs (bc-9d37.9): a write of
  // `advocates.json` schedules a common-repo commit whose `git init` lands in
  // `CONFIG_DIR`.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  for (const rec of owed) oweClose(rec);
  if (rawOwed !== null) fs.writeFileSync(OWED_PATH, rawOwed);

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
      propose: false,
      sessionLog: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      ...overrides,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const opened = [];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress' }),
    children: async () => [],
    listStatus: async () => [],
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
  return { opened, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

const heldIds = (card) => card.heldByOwed.map((h) => h.id);
const whyFor = (card, id) => (card.heldByOwed.find((h) => h.id === id) || {}).why || '';

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
 * The incident itself, in miniature: a bead's merge-bead closed, the work bead's own
 * close is a ledger entry rather than a fact, and `bd ready` — this test's fake — still
 * hands it back. One window before this filter existed; none now.
 */
await check('a bead owed a close does not get a second window', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'CC7 monitoring and incident response')],
    owed: [{ workspace: 'alpha', id: 'x-1', reason: 'Merged #324 as aeeb6c94 into main on GitHub', why: 'blocked by an unrelated dependency' }],
  });

  assert.deepEqual(opened, [], 'no window over a bead whose close is already recorded as owed');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.match(whyFor(card, 'x-1'), /Merged #324 as aeeb6c94/, `got: ${whyFor(card, 'x-1')}`);
});

/**
 * A record for another workspace, or another bead, must hold nothing here — the ledger
 * is shared across every workspace the daemon runs, keyed `workspace/id`, and a filter
 * that matched on `id` alone would hold beads it had never heard of.
 */
await check('a record for a different workspace or a different bead holds nothing', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'Unrelated to either record')],
    owed: [
      { workspace: 'beta', id: 'x-1', reason: 'Merged #7 into main on GitHub' },
      { workspace: 'alpha', id: 'x-9', reason: 'Merged #8 into main on GitHub' },
    ],
  });

  assert.deepEqual(opened, ['x-1'], 'neither record names this workspace and this bead together');
  assert.deepEqual(heldIds(card), []);
});

/**
 * Ordinary work beside owed work: the filter must subtract exactly the beads the ledger
 * names and launch everything else, in the order the queue would otherwise pick.
 */
await check('an owed bead is held while the rest of the queue is worked as usual', async () => {
  const { opened, card } = await tick({
    ready: [bead('x-1', 'Owed a close'), bead('x-2', 'Ordinary ready work', { created_at: '2020-06-01T00:00:00Z' })],
    owed: [{ workspace: 'alpha', id: 'x-1', reason: 'Merged #324 into main on GitHub' }],
  });

  assert.deepEqual(opened, ['x-2'], 'the unrelated bead is launched, the owed one is not');
  assert.deepEqual(heldIds(card), ['x-1']);
  assert.equal(card.queue, 1, 'and the queue count reflects the subtraction, not just the pill');
});

/**
 * The retry that actually clears the hold: once `forgetOwed` (or the sweep it stands
 * for) drops the record, the next tick sees an ordinary ready bead and launches it —
 * the pill is a snapshot of a ledger, not a second tracker with its own memory.
 */
await check('a record that clears lets the bead through on the next tick', async () => {
  const held = await tick({
    ready: [bead('x-1', 'Owed, for one tick')],
    owed: [{ workspace: 'alpha', id: 'x-1', reason: 'Merged #324 into main on GitHub' }],
  });
  assert.deepEqual(held.opened, [], 'held on the first tick');

  // No `owed` this time: `tick` already clears the ledger along with everything else
  // in `CONFIG_DIR`, which is the fact this case is pinning — the hold does not outlive
  // the record that caused it.
  const cleared = await tick({ ready: [bead('x-1', 'Owed, for one tick')] });
  assert.deepEqual(cleared.opened, ['x-1'], 'and launched once the ledger no longer names it');
  assert.deepEqual(heldIds(cleared.card), []);
});

/**
 * A ledger this process cannot parse must not empty the queue — the same fail-open rule
 * every filter in lib/advocate.js follows, and `readOwed` itself already answers `{}`
 * for exactly this case (test/mergeclose.mjs pins that half); this is the wiring half.
 */
await check('an unreadable ledger holds nothing back', async () => {
  const { opened } = await tick({ ready: [bead('x-1', 'Should still launch')], rawOwed: '{ this is not json' });
  assert.deepEqual(opened, ['x-1']);
  assert.deepEqual(readOwed(), {}, 'sanity: the ledger really was unreadable, not merely empty');
});

/**
 * And the ordinary case, which every case above this one already exercises once but is
 * worth saying outright: no record at all, on an otherwise empty ledger, holds nothing.
 */
await check('no owed records at all is the same as no filter running', async () => {
  const { opened, card } = await tick({ ready: [bead('x-1', 'Nothing owed anywhere')] });
  assert.deepEqual(opened, ['x-1']);
  assert.deepEqual(heldIds(card), []);
});

/* --------------------------------------------------------------------- report */

console.log(`\n${failures ? `${failures} of ${ran} checks failed` : `all ${ran} checks passed`}`);
try {
  await cleanupTmp(tmp);
} catch {
  /* a temp directory that will not go is not a failure of the thing under test */
}
process.exit(failures ? 1 : 0);
