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
 * The second half of the file is the *sweep* — the same signal aimed at a window this
 * daemon holds no worker for, which is what the windows already open when the above
 * shipped all were. It starts from a session record rather than from a launch, so the
 * checks are about the two guards that replace the worker row: the window's name has to
 * begin `DONE-`, and the bead that name points at has to be closed. The one that matters
 * most is the negative — a hand-run window named after a bead still in progress — and it
 * is checked against a real process, like the rest.
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
const { decide, closingFor, namesBead, beadInName, saidDone, sweepCandidate, REAP_DEFAULTS } = await import(
  LIB('reap.js')
);

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

/**
 * One `~/.claude/sessions/<pid>.json`, the shape lib/claude.js reads.
 *
 * `idleSecs` is how long ago the status was last written, which is what the window
 * sweep measures "idle for long enough" against — every sweep check needs to be able
 * to say the window has been quiet for twenty minutes without waiting twenty minutes.
 */
function writeSessionRecord(pid, { name, status = 'idle', cwd = REPO, idleSecs = 0 } = {}) {
  fs.writeFileSync(
    path.join(SESSIONS, `${pid}.json`),
    JSON.stringify({
      pid,
      sessionId: `sess-${pid}`,
      name,
      cwd,
      status,
      statusUpdatedAt: Date.now() - idleSecs * 1000,
    })
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

/**
 * An advocate holding nothing at all — which is the whole premise of the window sweep.
 *
 * The state has to be written and not merely left: every check above seeds a worker,
 * and inheriting one would mean the sweep never sees its candidate, because a window
 * the advocate is holding is `reconcile`'s to deal with.
 */
function withNoWorkers(opts = {}) {
  fs.writeFileSync(STATE, JSON.stringify({ alpha: { workers: [], closing: [], attempts: {} } }));
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

/* ------------------------------------------- the windows nobody is holding */

/*
 * The sweep starts from a live session rather than from a worker row, so its whole risk
 * is reading a window as finished when it is not. Both halves of that get checked: the
 * name-and-clock half here, and the closed-bead half against a real process below.
 */

const idle = (over = {}) => ({
  pid: 4242,
  name: 'DONE-Alpha - al-1 a bead',
  status: 'idle',
  at: ago(3600),
  sessionId: 'sess-4242',
  ...over,
});

await check('only a window that called itself finished is a candidate', () => {
  assert.ok(saidDone('DONE-Alpha - al-1 a bead'));
  assert.ok(saidDone('done- Sophab - sp-iai s-sheet, shipped'), 'the by-hand spelling counts too');
  assert.ok(!saidDone('Alpha - al-1 a bead'), 'a session still working says nothing');
  assert.ok(!saidDone('Alpha - al-1 the thing is done'), 'and "done" in a title is not a claim');
  assert.ok(!saidDone(''));
  assert.equal(sweepCandidate(idle({ name: 'Alpha - al-1 a bead' })), null);
});

await check('the bead id comes out of the name, or nothing does', () => {
  assert.equal(beadInName('DONE-Alpha - al-1 a bead'), 'al-1');
  assert.equal(beadInName('DONE-Beadcause - bc-t6je no deploys entry'), 'bc-t6je');
  assert.equal(beadInName('Deluvia - dv-5i2.81 Entry 091'), 'dv-5i2.81', 'a subtask id is an id');
  // `DONE-Beadcause` is a dash-joined pair of words in exactly an id's shape, and it is
  // in front of every swept window's name. Case is what tells them apart.
  assert.equal(beadInName('DONE-Beadcause'), null);
  assert.equal(beadInName('DONE-Alpha - nothing here'), null);
  // The id is the second field, so the left-most match is it — and a title is allowed
  // to contain hyphenated words and to mention other beads.
  assert.equal(beadInName('DONE-Alpha - al-1 the auto-close catch-up'), 'al-1');
  assert.equal(beadInName('DONE-Alpha - al-1 supersedes al-2'), 'al-1');
  assert.equal(sweepCandidate(idle({ name: 'DONE-Alpha - al-1 supersedes al-2' }))?.id, 'al-1');
});

await check('a busy or freshly-quiet window is not a candidate', () => {
  assert.deepEqual(sweepCandidate(idle()), { id: 'al-1', pid: 4242, sessionId: 'sess-4242' });
  assert.equal(sweepCandidate(idle({ status: 'busy' })), null);
  assert.equal(sweepCandidate(idle({ status: '' })), null, 'a record that has not said is not idle');
  assert.equal(sweepCandidate(idle({ at: ago(60) })), null, 'a minute quiet is a gap between turns');
  assert.equal(sweepCandidate(idle({ at: ago(300) })), null, 'and so, at this end, is five');
  assert.equal(sweepCandidate(idle({ at: ago(300) }), { sweepIdleMinutes: 2 })?.id, 'al-1', 'the wait is tunable');
  assert.equal(sweepCandidate(idle({ pid: 0 })), null);
  assert.equal(sweepCandidate(null), null);
  assert.equal(sweepCandidate(idle(), { sweepFinishedWindows: false }), null, 'its own off switch');
  assert.equal(REAP_DEFAULTS.sweepFinishedWindows, true, 'and it is on by default');
  assert.equal(REAP_DEFAULTS.sweepIdleMinutes, 20);
});

await check('a finished window with no worker behind it is closed', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  // Nothing on the slot list knows this pid — which is the state every window in the
  // pile this was written for was in.
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead', idleSecs: 3600 });
  const { advocates, events } = withNoWorkers({
    show: async (id) => {
      assert.equal(id, 'al-1', 'it asked the tracker about a bead it read out of the window name');
      return { id, status: 'closed', title: 'a bead' };
    },
  });

  await advocates.tick();
  assert.ok(await goneWithin(victim.pid, 4000), 'the window nobody was holding is still open');
  assert.ok(events.some((e) => e.action === 'closed' && e.id === 'al-1'), 'and it said so on the bus');
});

await check('a window whose bead is still open is left alone — this is the one that matters', async () => {
  clearSessionRecords();
  // A session named after a bead that is not closed is the case the widening risks: a
  // window opened by hand, on work still in progress, that happens to be idle.
  const mine = spawnVictim();
  writeSessionRecord(mine.pid, { name: 'done- Alpha - al-1 mid-flight', idleSecs: 7200 });
  const { advocates } = withNoWorkers({ show: async (id) => ({ id, status: 'in_progress' }) });

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(alive(mine.pid), 'it signalled a window whose bead was open');
  assert.equal(card(advocates).closing.length, 0, 'and it is not waiting to, either');
  mine.kill('SIGKILL');
});

await check('a bead the tracker will not answer for is not evidence of anything', async () => {
  clearSessionRecords();
  const mine = spawnVictim();
  writeSessionRecord(mine.pid, { name: 'DONE-Alpha - al-9 a bead in another tracker', idleSecs: 3600 });
  const { advocates } = withNoWorkers({
    show: async () => {
      throw new Error('no issue found matching "al-9"');
    },
  });

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(alive(mine.pid), 'an unreadable tracker read as a closed bead');
  mine.kill('SIGKILL');
});

for (const off of [{ sweepFinishedWindows: false }, { closeFinishedSessions: false }]) {
  const which = Object.keys(off)[0];
  await check(`${which}:false leaves a window nobody is holding alone`, async () => {
    clearSessionRecords();
    const mine = spawnVictim();
    writeSessionRecord(mine.pid, { name: 'DONE-Alpha - al-1 a bead', idleSecs: 3600 });
    const { advocates } = withNoWorkers({
      show: async (id) => ({ id, status: 'closed' }),
      overrides: off,
    });

    await advocates.tick();
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(alive(mine.pid), `${which} did not switch anything off`);
    assert.equal(card(advocates).closing.length, 0);
    mine.kill('SIGKILL');
  });
}

await check('the sweep does not queue a window the closing list already has', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead', idleSecs: 3600 });
  // A worker on the slot list whose bead has closed. `reconcile` retires it and queues
  // the window; the sweep, running on the same pid a moment later, must recognise it
  // rather than adding a second record and signalling twice. A real grace period so the
  // window is still there to be double-counted when the sweep looks.
  const { advocates } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'closed' }), overrides: { closeGraceSeconds: 300 } }
  );

  await advocates.tick();
  assert.equal(card(advocates).workers.length, 0, 'the worker was retired');
  assert.equal(card(advocates).closing.length, 1, 'one window, one closing record');
  assert.ok(alive(victim.pid), 'and the grace period is still the grace period');
  victim.kill('SIGKILL');
});

/* ---------------------------------------------------------------------- out */

console.log(`\n${ran - failures}/${ran} passed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exit(failures ? 1 : 0);
