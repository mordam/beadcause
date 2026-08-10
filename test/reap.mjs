/**
 * Closing the window of a session whose bead is closed.
 *
 * The bug this fixes is not subtle — seven idle `DONE-…` windows were on the Mac when
 * it was written — but the fix is the only thing in beadcause that sends a signal to a
 * process it does not own, and that is worth being careful about in both directions:
 *
 * 1. **It has to actually fire.** A grace period, an idle check and a name check are
 *    four ways to talk yourself out of ever closing anything, and a feature that never
 *    fires looks exactly like one that is being cautious. So the end-to-end check
 *    below spawns a real process, tells a real advocate its bead is closed, and
 *    requires the process to be dead at the end of it.
 * 2. **It must never fire at the wrong process.** `~/.claude/sessions/<pid>.json`
 *    records outlive their process and pids get reused, so a stale record plus a
 *    recycled pid is a live possibility and the consequence is killing something
 *    unrelated. The guard is that Claude Code must *currently* report that pid as a
 *    session named after this bead, and it is checked here against a pid that is alive
 *    and is emphatically not ours.
 * 3. **It must leave the interesting endings alone.** Delivered-but-unmerged, handed
 *    back for a decision, timed out: all of those have something on screen worth
 *    reading, and only a *closed bead* means there is not.
 *
 * No iTerm and no `bd` — `createAdvocates` is called directly with a fake tracker, and
 * `claudeSessionsDir` points at a directory this file writes. `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-reap-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const CONFIG = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
const STATE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'advocates.json');
const SESSIONS = path.join(tmp, 'claude-sessions');
fs.mkdirSync(SESSIONS, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { decide, closingFor, namesBead, REAP_DEFAULTS } = await import(LIB('reap.js'));

/* ------------------------------------------------------------------ fixtures */

const ago = (secs) => new Date(Date.now() - secs * 1000).toISOString();

/**
 * A workspace whose directory the shell's own rule would derive from `projectRoot`.
 *
 * `beadsDirFor` — which is what lib/claude.js uses to decide which workspace a running
 * session belongs to — hardcodes `~/beads/<repo>/.beads`, so the fixture has to name
 * that path even though nothing here ever reads it. Get it wrong and every session is
 * filed under no workspace at all, the advocate sees an empty list, and every check in
 * this file passes for the wrong reason.
 */
const WS_DIR = path.join(os.homedir(), 'beads', 'alpha', '.beads');
const REPO = path.join(tmp, 'projects', 'alpha');
fs.mkdirSync(REPO, { recursive: true });

const baseConfig = () => ({
  projectRoot: path.join(tmp, 'projects'),
  fallbackWorkspace: 'other',
  claudeSessionsDir: SESSIONS,
  workspaces: [{ name: 'alpha', dir: WS_DIR }],
  advocates: {
    enabled: true,
    workspaces: '*',
    maxWorkers: 1,
    // Everything that would touch git, a repo or an agent. This file is about one
    // signal and nothing else.
    propose: false,
    sessionLog: false,
    tidyWorktrees: false,
    closeGraceSeconds: 0,
    closeHardSeconds: 1,
  },
});

/** One `~/.claude/sessions/<pid>.json`, the shape lib/claude.js reads. */
function writeSessionRecord(pid, { name, status = 'idle', cwd = REPO } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `sess-${pid}`, name, cwd, status, statusUpdatedAt: Date.now() })
  );
}

const clearSessionRecords = () => {
  for (const f of fs.readdirSync(SESSIONS)) fs.rmSync(path.join(SESSIONS, f), { force: true });
};

/** A process that will sit there until something signals it. */
function spawnVictim() {
  const child = spawn('/bin/sh', ['-c', 'while :; do sleep 1; done'], { stdio: 'ignore' });
  child.unref();
  return child;
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

/** Poll rather than sleep a fixed time: the signal is delivered asynchronously. */
async function goneWithin(pid, ms) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return !alive(pid);
}

/**
 * An advocate over a fresh config, with a tracker that says what this file needs it to.
 *
 * `ready` is always empty — nothing here launches, and a queue would only add windows
 * to a test about closing them.
 */
function harness({ show, overrides = {} } = {}) {
  const cfg = baseConfig();
  cfg.advocates = { ...cfg.advocates, ...overrides };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  const events = [];
  const bd = {
    ready: async () => [],
    show: async (_ws, id) => show(id),
    listLabel: async () => [],
  };
  return { cfg, events, advocates: createAdvocates(cfg, { bd, bus: { emit: (e) => events.push(e) } }) };
}

/** Seed the persisted state the way a restart would find it, then build the advocate. */
function withWorker(worker, opts = {}) {
  fs.writeFileSync(STATE, JSON.stringify({ alpha: { workers: [worker], attempts: {} } }));
  return harness(opts);
}

const card = (advocates) => advocates.snapshot().find((a) => a.workspace === 'alpha');

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

console.log('\nclosing a finished session\n');

/* ------------------------------------------------- the decision, on its own */

const entry = (over = {}) => ({ id: 'al-1', title: 'a bead', pid: 4242, at: ago(600), sentAt: null, ...over });
const live = (over = {}) => ({ pid: 4242, name: 'DONE-Alpha - al-1 a bead', status: 'idle', ...over });

await check('an idle session whose grace is up is signalled', () => {
  assert.equal(decide(entry(), live()).act, 'term');
});

await check('a session that is gone from the records is dropped, not signalled', () => {
  assert.equal(decide(entry(), null).act, 'drop');
  assert.equal(decide(entry(), undefined).act, 'drop');
});

await check('a pid under another name is dropped — this is the one that kills the wrong process', () => {
  assert.equal(decide(entry(), live({ name: 'Alpha - al-9 something else' })).act, 'drop');
  assert.equal(decide(entry(), live({ name: '' })).act, 'drop');
  // The bead id anywhere in the name is enough: a session renames itself `DONE-…`
  // on the way out and the id is the only part the brief promises to keep.
  assert.equal(decide(entry(), live({ name: 'DONE-Alpha - al-1 …' })).act, 'term');
});

await check('a subtask id is not its parent — this is the other way to kill the wrong process', () => {
  // Beads number subtasks `<id>.1`, so every parent id is a prefix of its children's.
  // A worker on `al-1` must not match the window working `al-1.2`, nor `al-12`.
  assert.equal(decide(entry(), live({ name: 'Alpha - al-1.2 the subtask' })).act, 'drop');
  assert.equal(decide(entry(), live({ name: 'Alpha - al-12 a different bead' })).act, 'drop');
  assert.equal(decide(entry({ id: 'al-1.2' }), live({ name: 'Alpha - al-1 the parent' })).act, 'drop');
  assert.equal(decide(entry({ id: 'al-1.2' }), live({ name: 'DONE-Alpha - al-1.2 the subtask' })).act, 'term');
  // And the helper on its own, since lib/advocate.js joins workers to windows with it.
  assert.ok(namesBead('DONE-Deluvia - dv-qok i want sessions to auto close', 'dv-qok'));
  assert.ok(!namesBead('Deluvia - dv-qok.1 the follow-up', 'dv-qok'));
  assert.ok(!namesBead('', 'dv-qok'));
  assert.ok(!namesBead('Deluvia - dv-qok', ''));
});

await check('a busy session is left alone, however long its bead has been closed', () => {
  assert.equal(decide(entry(), live({ status: 'busy' })).act, 'wait');
  // …until the give-up window, when it stops being watched rather than being killed.
  const stale = decide(entry({ at: ago(3600) }), live({ status: 'busy' }));
  assert.equal(stale.act, 'drop');
  assert.match(stale.why, /leaving it open/);
});

await check('the grace period is real', () => {
  assert.equal(decide(entry({ at: ago(5) }), live()).act, 'wait');
  assert.equal(decide(entry({ at: ago(5) }), live(), { closeGraceSeconds: 0 }).act, 'term');
});

await check('SIGTERM is given closeHardSeconds before SIGKILL, and then it stops', () => {
  assert.equal(decide(entry({ sentAt: ago(1) }), live()).act, 'wait');
  assert.equal(decide(entry({ sentAt: ago(120) }), live()).act, 'kill');
  const done = decide(entry({ at: ago(3600), sentAt: ago(120) }), live());
  assert.equal(done.act, 'drop', 'past the give-up window it is left for a human');
});

await check('only a closed bead is a candidate at all', () => {
  const w = { id: 'al-1', title: 'a bead', pid: 4242, ended: false };
  assert.ok(closingFor(w, 'done'), 'closed — the one ending with nothing left on screen');
  for (const other of ['delivered', 'handback', 'unfinished', 'timeout', 'lapsed', 'silent', 'ended']) {
    assert.equal(closingFor(w, other), null, `${other} still has something worth reading`);
  }
  assert.equal(closingFor({ ...w, ended: true }, 'done'), null, 'it already exited — there is no window');
  assert.equal(closingFor({ ...w, pid: null }, 'done'), null, 'no pid, nothing to signal');
  assert.equal(closingFor(w, 'done', { enabled: false }), null, 'the off switch is honoured');
  assert.equal(REAP_DEFAULTS.closeFinishedSessions, true, 'and it is on by default');
});

/* ------------------------------------------------------ end to end, real process */

await check('a real process is signalled once its bead closes', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead' });
  const { advocates, events } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'closed', close_reason: 'Landed as #7 as abc1234' }) }
  );

  // First tick: reconcile sees the closed bead, finish() queues the window.
  await advocates.tick();
  assert.equal(card(advocates).workers.length, 0, 'the slot went back');
  // closeGraceSeconds is 0 here, so the same tick signals it.
  assert.ok(await goneWithin(victim.pid, 4000), 'the process is still running — nothing was signalled');
  assert.ok(
    events.some((e) => e.action === 'closed' && e.id === 'al-1'),
    'and the close is on the bus, so the advocate log says what it did'
  );

  // The record is cleared once the process is gone, rather than being retried forever.
  clearSessionRecords();
  await advocates.tick();
  assert.equal(card(advocates).closing.length, 0, 'nothing left waiting');
});

await check('a live pid that is not our session is never signalled', async () => {
  clearSessionRecords();
  const bystander = spawnVictim();
  // The record Claude Code has for that pid belongs to a different bead — which is
  // exactly what a reused pid looks like from here.
  writeSessionRecord(bystander.pid, { name: 'Alpha - al-99 an entirely different thing' });
  const { advocates } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'closed' }) }
  );

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(alive(bystander.pid), 'it signalled a process that was not its session');
  assert.equal(card(advocates).closing.length, 0, 'and it did not keep watching it either');
  bystander.kill('SIGKILL');
});

await check('closeFinishedSessions:false leaves the window alone', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead' });
  const { advocates } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'closed' }), overrides: { closeFinishedSessions: false } }
  );

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(alive(victim.pid), 'the off switch did not switch anything off');
  assert.equal(card(advocates).closing.length, 0);
  victim.kill('SIGKILL');
});

await check('a window still waiting survives a restart', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead', status: 'busy' });
  const { advocates } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'closed' }) }
  );

  // Busy, so it is queued and left alone.
  await advocates.tick();
  assert.equal(card(advocates).closing.length, 1, 'a busy session is waited for, not killed');
  assert.ok(alive(victim.pid));

  // The daemon restarts. The window is still open, so the record has to still be here.
  const restarted = createAdvocates(JSON.parse(fs.readFileSync(CONFIG, 'utf8')), {
    bd: { ready: async () => [], show: async () => ({ id: 'al-1', status: 'closed' }), listLabel: async () => [] },
    bus: { emit: () => {} },
  });
  assert.equal(card(restarted).closing.length, 1, 'a restart that forgets these is the pile all over again');

  // It goes idle, and the next tick closes it.
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead', status: 'idle' });
  await restarted.tick();
  assert.ok(await goneWithin(victim.pid, 4000), 'it never closed the window it was holding');
});

/* ---------------------------------------------------------------------- out */

console.log(`\n${ran - failures}/${ran} passed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
