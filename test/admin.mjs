/**
 * Pause all / resume all — the state machine, without a pty or an iTerm window.
 *
 * The interesting failures here are not arithmetic, they are promises the screen
 * makes that the code might not keep:
 *
 * 1. **Resume gives back more than pause took.** An advocate you paused by hand
 *    last week must still be paused after you press resume-all today. This is the
 *    one that would be invisible until a repo you had deliberately stopped quietly
 *    started opening windows again.
 * 2. **"Drain" touched something running.** The default must not signal a worker.
 *    The whole feature is built on that promise, and a `process.kill` slipping into
 *    the default path is the difference between a safe button and a destructive one
 *    wearing a safe label.
 * 3. **A scope reached outside itself.** Pausing one space must leave the other
 *    space's advocates and terminals running — per-space is not decoration, it is
 *    the reason you can stop work without stopping everything.
 * 4. **A closed terminal was forgotten.** There is nothing else left to reopen it
 *    from once lib/terminal.js has reaped the record, so if the list drops an entry
 *    the terminal is gone for good — and a reopen that fails on the cap must keep
 *    its entry rather than silently discarding it.
 * 5. **Something ran at boot.** Loading persisted state must report, never act.
 *    Adam's constraint on the whole feature: a `launchctl kickstart -k` behaves
 *    exactly as it did before this existed.
 *
 * The advocates and terminals are stubs — no `bd`, no pty, no process signalled
 * anywhere. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-admin-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createAdmin, scopes, GLOBAL } = await import(LIB('admin.js'));

const STATE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'admin.json');

/* ------------------------------------------------------------------ fixtures */

const cfg = {
  workspaces: [{ name: 'alpha' }, { name: 'beta' }, { name: 'loner' }],
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Personal', workspaces: ['beta'] },
  ],
};

/**
 * The advocates, as `createAdvocates` hands them over — snapshot plus control.
 *
 * `killed` records nothing: the pids are fake and this stub is what makes "drain
 * signalled nobody" a fact rather than an inspection of the source.
 */
function stubAdvocates(init) {
  const state = new Map(init.map((a) => [a.workspace, { ...a }]));
  const log = [];
  return {
    log,
    snapshot: () => [...state.values()].map((a) => ({ ...a, workers: a.workers.map((w) => ({ ...w })) })),
    has: (name) => state.has(name),
    control(name, action) {
      const a = state.get(name);
      if (!a) throw Object.assign(new Error(`no advocate for ${name}`), { status: 404 });
      if (action === 'pause') a.paused = true;
      else if (action === 'resume') a.paused = false;
      log.push(`${action}:${name}`);
    },
  };
}

/**
 * The terminals, as lib/terminal.js hands them over.
 *
 * `suspend` models the real thing exactly: the record stays in the registry as
 * `resumable` rather than leaving it, which is what makes resuming-by-id the same
 * conversation. `forget` is how a test says "this one was reaped while you had it
 * paused", which is the only case that falls back to a fresh open.
 */
function stubTerminals(init) {
  let all = init.map((t) => ({ status: 'live', cols: 80, rows: 24, bead: null, ...t }));
  const opened = [];
  const resumed = [];
  let cap = 99;
  return {
    opened,
    resumed,
    setCap: (n) => {
      cap = n;
    },
    forget: (id) => {
      all = all.filter((t) => t.id !== id);
    },
    list: () => all.map((t) => ({ ...t })),
    suspend: (id) => {
      const t = all.find((x) => x.id === id);
      if (!t) return false;
      t.status = 'resumable';
      return true;
    },
    resume: (id) => {
      const t = all.find((x) => x.id === id);
      if (!t || t.status !== 'resumable') return false;
      if (opened.length + resumed.length >= cap) {
        throw Object.assign(new Error('terminals are already open (terminalMax) — close one first'), { status: 429 });
      }
      t.status = 'live';
      resumed.push(id);
      return true;
    },
    open: (record) => {
      if (opened.length + resumed.length >= cap) {
        throw Object.assign(new Error('terminals are already open (terminalMax) — close one first'), { status: 429 });
      }
      opened.push(record);
      all.push({ id: `re-${opened.length}`, workspace: record.workspace, status: 'live', cols: 80, rows: 24, bead: record.bead });
      return { id: `re-${opened.length}` };
    },
  };
}

const worker = (id, pid) => ({ id, pid, ended: false });

/** A fresh admin over fresh stubs, with the persisted state wiped unless kept. */
function build({ advocates, terminals, keepState = false } = {}) {
  if (!keepState) fs.rmSync(STATE, { force: true });
  const adv = stubAdvocates(
    advocates || [
      { workspace: 'alpha', paused: false, workers: [worker('a-1', 111)] },
      { workspace: 'beta', paused: false, workers: [] },
      { workspace: 'loner', paused: false, workers: [] },
    ]
  );
  const term = stubTerminals(terminals || [{ id: 't1', workspace: 'alpha' }, { id: 't2', workspace: 'beta' }]);
  return { admin: createAdmin(cfg, { advocates: adv, terminals: term }), adv, term };
}

const scopeOf = (status, id) => status.scopes.find((s) => s.id === id);

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

/* --------------------------------------------------------------------- cases */

console.log('admin pause-all');

await check('scopes are global first, then one per space, workspaces resolved', () => {
  const s = scopes(cfg);
  assert.equal(s[0].id, GLOBAL, 'global must be first — it is the switch you reach for');
  assert.deepEqual(s[0].workspaces, ['alpha', 'beta', 'loner'], 'global covers every workspace');
  assert.deepEqual(
    s.map((x) => x.id),
    ['*', 'Work', 'Personal']
  );
  assert.deepEqual(s[1].workspaces, ['alpha']);
});

await check('a space naming a workspace that is not configured does not invent one', () => {
  const s = scopes({ workspaces: [{ name: 'alpha' }], spaces: [{ name: 'Work', workspaces: ['alpha', 'ghost'] }] });
  assert.deepEqual(s[1].workspaces, ['alpha'], 'ghost is not served, so it is not in reach');
});

await check('pause-all pauses every advocate and suspends every terminal', () => {
  const { admin, adv, term } = build();
  const { did } = admin.control({ action: 'pause', scope: GLOBAL });
  assert.deepEqual(did.paused, ['alpha', 'beta', 'loner']);
  assert.deepEqual(did.closed.map((c) => c.workspace), ['alpha', 'beta']);
  assert.equal(term.list().filter((t) => t.status === 'live').length, 0, 'no terminal is left running');
  assert.ok(adv.snapshot().every((a) => a.paused));
});

await check('a paused terminal is suspended, not closed — it comes back as itself', () => {
  const { admin, term } = build();
  admin.control({ action: 'pause', what: 'terminals', scope: GLOBAL });
  assert.ok(
    term.list().every((t) => t.status === 'resumable'),
    'suspending leaves the conversation resumable rather than ended'
  );

  const { did } = admin.control({ action: 'resume', what: 'terminals', scope: GLOBAL });
  assert.deepEqual(term.resumed, ['t1', 't2'], 'the same two terminals, by id');
  assert.equal(did.opened.length, 2);
  assert.equal(did.fresh?.length ?? 0, 0, 'and none of them came back as a new conversation');
  assert.equal(term.opened.length, 0, 'nothing was opened from scratch');
});

await check('a terminal reaped while paused falls back to a fresh one, and says so', () => {
  const { admin, term } = build();
  admin.control({ action: 'pause', what: 'terminals', scope: GLOBAL });
  term.forget('t1'); // Gone: reaped, or its record deleted.

  const { did } = admin.control({ action: 'resume', what: 'terminals', scope: GLOBAL });
  assert.deepEqual(did.opened.map((r) => r.id), ['t2'], 't2 is the conversation you were having');
  assert.deepEqual(did.fresh.map((r) => r.id), ['t1'], 't1 could only come back as a new one');
  assert.equal(term.opened.length, 1, 'and it did come back rather than being dropped');
});

await check('drain is the default and signals nobody', () => {
  const { admin } = build();
  const { did } = admin.control({ action: 'pause', scope: GLOBAL });
  // `killed` is absent or empty — either says the same thing, and neither may be
  // a list of pids. alpha has a live worker, so this is a real opportunity to fail.
  assert.equal(did.killed?.length ?? 0, 0, 'draining must leave running sessions completely alone');
  assert.equal(did.mode, 'drain');
});

await check('kill mode really signals the worker, and the worker really dies', async () => {
  // A disposable child stands in for the `claude` in an iTerm window, so the
  // SIGTERM is genuinely delivered rather than asserted about. Emphatically not
  // process.pid: this test would then end by killing the test run.
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  const died = new Promise((resolve) => child.on('exit', (code, signal) => resolve(signal || code)));

  const { admin } = build({
    advocates: [{ workspace: 'alpha', paused: false, workers: [{ id: 'a-1', pid: child.pid, ended: false }] }],
    terminals: [],
  });
  const { did } = admin.control({ action: 'pause', what: 'advocates', scope: GLOBAL, mode: 'kill' });
  assert.equal(did.killed.length, 1, 'the running worker is signalled and reported');
  assert.equal(did.killed[0].bead, 'a-1');
  assert.equal(await died, 'SIGTERM', 'and the process it named is the one that ended');
});

await check('drain leaves that same worker running', async () => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const { admin } = build({
      advocates: [{ workspace: 'alpha', paused: false, workers: [{ id: 'a-1', pid: child.pid, ended: false }] }],
      terminals: [],
    });
    admin.control({ action: 'pause', what: 'advocates', scope: GLOBAL });
    // Still there: `kill(pid, 0)` throws ESRCH for a process that has gone.
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'the default must not have touched it');
  } finally {
    child.kill('SIGKILL');
  }
});

await check('a worker that has already ended is not signalled', () => {
  const child = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
  try {
    const { admin } = build({
      advocates: [{ workspace: 'alpha', paused: false, workers: [{ id: 'a-1', pid: child.pid, ended: true }] }],
      terminals: [],
    });
    const { did } = admin.control({ action: 'pause', what: 'advocates', scope: GLOBAL, mode: 'kill' });
    assert.equal(did.killed.length, 0, 'a finished worker is a window that has already closed');
    assert.doesNotThrow(() => process.kill(child.pid, 0), 'and its stale pid is not signalled');
  } finally {
    child.kill('SIGKILL');
  }
});

await check('resume does not un-pause an advocate that was paused by hand', () => {
  const { admin, adv } = build({
    advocates: [
      // beta was stopped deliberately, before any of this ran.
      { workspace: 'alpha', paused: false, workers: [] },
      { workspace: 'beta', paused: true, workers: [] },
      { workspace: 'loner', paused: false, workers: [] },
    ],
    terminals: [],
  });
  admin.control({ action: 'pause', what: 'advocates', scope: GLOBAL });
  const { did } = admin.control({ action: 'resume', what: 'advocates', scope: GLOBAL });
  assert.deepEqual(did.resumed.sort(), ['alpha', 'loner'], 'only the two this paused come back');
  assert.equal(adv.snapshot().find((a) => a.workspace === 'beta').paused, true, 'beta stays as you left it');
});

await check('pausing one space leaves the other running', () => {
  const { admin, adv, term } = build();
  admin.control({ action: 'pause', scope: 'Work' });
  const paused = adv.snapshot().filter((a) => a.paused).map((a) => a.workspace);
  assert.deepEqual(paused, ['alpha'], 'only the Work space stopped');
  assert.deepEqual(
    term.list().filter((t) => t.status === 'live').map((t) => t.id),
    ['t2'],
    "Personal's terminal is untouched"
  );
});

await check('a workspace in no space is reachable only from global', () => {
  const { admin, adv } = build();
  admin.control({ action: 'pause', scope: 'Work' });
  admin.control({ action: 'pause', scope: 'Personal' });
  assert.equal(adv.snapshot().find((a) => a.workspace === 'loner').paused, false, 'no space covers loner');
  admin.control({ action: 'pause', scope: GLOBAL });
  assert.equal(adv.snapshot().find((a) => a.workspace === 'loner').paused, true, 'global does');
});

await check('advocates and terminals pause separately', () => {
  const { admin, adv, term } = build();
  admin.control({ action: 'pause', what: 'terminals', scope: GLOBAL });
  assert.equal(term.list().filter((t) => t.status === 'live').length, 0, 'the terminals are suspended');
  assert.ok(adv.snapshot().every((a) => !a.paused), 'and no advocate was touched');

  const st = admin.status();
  assert.equal(scopeOf(st, GLOBAL).terminals.closed, 2);
  assert.equal(scopeOf(st, GLOBAL).advocates.ours, 0, 'the screen must not offer to resume advocates it never paused');
  assert.equal(scopeOf(st, GLOBAL).advocates.pausedCount, 0);
});

await check('resuming globally clears the label on the space that was paused', () => {
  // The bug this replaced: pause one space, resume everything, and the space still
  // called itself paused while its advocate was plainly running again. Nothing the
  // screen draws is stored — it is all derived from the live roster.
  const { admin } = build({ terminals: [] });
  admin.control({ action: 'pause', what: 'advocates', scope: 'Work' });
  assert.equal(scopeOf(admin.status(), 'Work').advocates.ours, 1);

  admin.control({ action: 'resume', what: 'advocates', scope: GLOBAL });
  const st = admin.status();
  assert.equal(scopeOf(st, 'Work').advocates.ours, 0, 'nothing here is resumable any more');
  assert.equal(scopeOf(st, 'Work').advocates.pausedCount, 0, 'because nothing here is paused any more');
});

await check('`ours` counts only what this page paused, never a hand-paused advocate', () => {
  const { admin } = build({
    advocates: [
      { workspace: 'alpha', paused: true, workers: [] },
      { workspace: 'beta', paused: false, workers: [] },
      { workspace: 'loner', paused: false, workers: [] },
    ],
    terminals: [],
  });
  admin.control({ action: 'pause', what: 'advocates', scope: GLOBAL });
  const g = scopeOf(admin.status(), GLOBAL).advocates;
  assert.equal(g.pausedCount, 3, 'all three are stopped');
  assert.equal(g.ours, 2, 'but only two of them by this page');
  assert.equal(scopeOf(admin.status(), 'Work').advocates.ours, 0, 'alpha was already paused when we got there');
});

await check('the fallback reopen is seeded the same way the terminal was', () => {
  const { admin, term } = build({
    terminals: [
      { id: 't1', workspace: 'alpha', bead: { id: 'a-7', title: 'Something' }, cols: 100, rows: 40 },
      { id: 't2', workspace: 'beta' },
    ],
  });
  admin.control({ action: 'pause', what: 'terminals', scope: GLOBAL });
  term.forget('t1');
  const { did } = admin.control({ action: 'resume', what: 'terminals', scope: GLOBAL });
  assert.equal(did.fresh.length, 1);
  assert.deepEqual(term.opened[0].bead, { id: 'a-7', title: 'Something' }, 'the bead it was seeded on comes back');
  assert.equal(term.opened[0].cols, 100, 'and the size it was at');
});

await check('a terminal that will not come back keeps its record rather than vanishing', () => {
  const { admin, term } = build();
  admin.control({ action: 'pause', what: 'terminals', scope: GLOBAL });
  term.setCap(1); // The cap is full after one: you opened others by hand meanwhile.
  const { did, status } = admin.control({ action: 'resume', what: 'terminals', scope: GLOBAL });
  assert.equal(did.opened.length, 1);
  assert.equal(did.failed.length, 1, 'the one that did not fit is reported, not swallowed');
  assert.match(did.failed[0].error, /terminalMax/);
  assert.equal(status.closed.length, 1, 'and is still resumable once a slot frees');
});

await check('the status counts what a press would affect, per scope', () => {
  const { admin } = build();
  const st = admin.status();
  const work = scopeOf(st, 'Work');
  assert.equal(work.advocates.total, 1);
  assert.equal(work.advocates.workers, 1, 'the number the red button acts on');
  assert.equal(work.terminals.live, 1);
  assert.equal(scopeOf(st, GLOBAL).advocates.workers, 1);
  // bc-4zz landed: a resumed terminal is the session you were talking to, so the
  // screen must stop warning that it is a new one.
  assert.equal(st.reopenIsFresh, false, 'resuming continues the conversation now');
});

await check('bad input is refused rather than half-applied', () => {
  const { admin, adv } = build();
  for (const bad of [
    { action: 'stop', scope: GLOBAL },
    { action: 'pause', what: 'everything', scope: GLOBAL },
    { action: 'pause', scope: GLOBAL, mode: 'nuke' },
    { action: 'pause', scope: 'Nowhere' },
  ]) {
    assert.throws(() => admin.control(bad), (err) => err.status === 400, `should refuse ${JSON.stringify(bad)}`);
  }
  assert.ok(adv.snapshot().every((a) => !a.paused), 'nothing was paused on the way to the error');
});

await check('the pause survives a restart, and reloading it acts on nothing', () => {
  const first = build();
  first.admin.control({ action: 'pause', scope: GLOBAL });
  assert.ok(fs.existsSync(STATE), 'the record is written where a restart can find it');

  // A new daemon: new stubs, everything running again, the state file still there.
  const next = build({ keepState: true });
  assert.ok(next.adv.snapshot().every((a) => !a.paused), 'loading state must not re-pause anything by itself');
  assert.equal(next.term.list().length, 2, 'and must not close anything by itself');

  // What it does carry is the record of what to give back: which advocates this
  // page paused, and which terminals it closed.
  const st = next.admin.status();
  assert.equal(scopeOf(st, GLOBAL).advocates.ours, 3, 'resume still knows what it may un-pause');
  assert.equal(st.closed.length, 2, 'and the closed terminals are still reopenable');
});

await check('a corrupt state file is not fatal', () => {
  fs.writeFileSync(STATE, '{ not json');
  const { admin } = build({ keepState: true });
  const st = admin.status();
  assert.equal(scopeOf(st, GLOBAL).advocates.ours, 0, 'an unreadable record reads as nothing this page paused');
  assert.equal(st.closed.length, 0);
});

/* --------------------------------------------------------------------- exit */

await cleanupTmp(tmp);
console.log(`${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
