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
 * 3. **It must leave the interesting endings alone.** Timed out, lapsed, gone silent:
 *    those are the daemon's *inference* that a window went quiet, and the inference is
 *    the reason to read it. The three a session actually reaches — bead closed, pull
 *    request delivered, bead handed back — all put what they know somewhere that is not
 *    the window, and all three close it. The middle two arrive with the bead still open
 *    and no done file written, so they get checks of their own below.
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
import { cleanupTmp } from './helpers/tmp.mjs';

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
const {
  decide,
  closingFor,
  closingNeverStartedFor,
  closeNeverStartedWindow,
  decideNeverStarted,
  namesBead,
  beadInName,
  saidDone,
  saidFinished,
  sweepCandidate,
  REAP_DEFAULTS,
} = await import(LIB('reap.js'));

/* ------------------------------------------------------------------ fixtures */

const ago = (secs) => new Date(Date.now() - secs * 1000).toISOString();

/**
 * The label the reap pass reads, and how many times one tick read it.
 *
 * Taken from lib/delivery.js rather than spelled out, so a rename cannot leave this file
 * counting a label nothing asks for and passing every check by measuring zero.
 */
const { DELIVERY_LABEL } = await import(LIB('delivery.js'));
const deliveryReads = (calls) => calls.listLabel[DELIVERY_LABEL] || 0;

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
function harness({ show, overrides = {}, labelled = () => [], empty = null } = {}) {
  const cfg = baseConfig();
  cfg.advocates = { ...cfg.advocates, ...overrides };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  const events = [];
  // **Counted per label**, because a tick asks this one method for more than one thing.
  // A delivery is asked about for every *idle* window and not only for one that exited —
  // the difference between a handful of calls a day and one per quiet window per tick if
  // the answer were not shared — and that is what the checks below pin. bc-jvt0.5's
  // whole-job sweep also reads a label on the same tick, once per interval, and a bare
  // total would have made this file's assertions go red for a call in another sweep that
  // has nothing to do with what they are measuring.
  const calls = { listLabel: {}, sweptEmpty: 0 };
  const bd = {
    ready: async () => [],
    show: async (_ws, id) => show(id),
    listLabel: async (_ws, label) => {
      calls.listLabel[label] = (calls.listLabel[label] || 0) + 1;
      return labelled(label);
    },
  };
  /**
   * The empty-window sweep, stubbed for every check in this file and not only the three
   * that assert on it. The real one drives iTerm, and while lib/launchguard.js already
   * refuses it inside a suite, a check that passes *because* of a refusal is a check
   * that would pass with the call deleted. Counted here so at least one of them proves
   * the tick makes it.
   */
  const sweepEmpty = async () => {
    calls.sweptEmpty += 1;
    return empty ? empty() : { closed: 0, ids: [], error: null };
  };
  return {
    cfg,
    events,
    calls,
    advocates: createAdvocates(cfg, { bd, bus: { emit: (e) => events.push(e) }, sweepEmpty }),
  };
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

await check('only an ending the session reached is a candidate at all', () => {
  const w = { id: 'al-1', title: 'a bead', pid: 4242, ended: false };
  // The three the brief gives a session, all of which put what they know somewhere
  // that is not the window: the bead, a card, a question.
  for (const reached of ['done', 'delivered', 'handback']) {
    assert.ok(closingFor(w, reached), `${reached} is the session's own account of finishing`);
  }
  // The four the daemon infers from a window going quiet. The inference is the reason
  // to read the window, so none of them may close it.
  for (const other of ['unfinished', 'timeout', 'lapsed', 'silent', 'ended']) {
    assert.equal(closingFor(w, other), null, `${other} is a window somebody should read`);
  }
  assert.equal(closingFor({ ...w, ended: true }, 'done'), null, 'it already exited — there is no window');
  assert.equal(closingFor({ ...w, ended: true }, 'delivered'), null, 'nor when you closed it yourself');
  assert.equal(closingFor({ ...w, pid: null }, 'done'), null, 'no pid, nothing to signal');
  assert.equal(closingFor(w, 'done', { enabled: false }), null, 'the off switch is honoured');
  assert.equal(closingFor(w, 'delivered', { enabled: false }), null, 'for all three of them');
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

/* -------------------------------- the two endings that leave the bead open */

/**
 * Delivered and handed back, against a *live* window.
 *
 * These are the endings a session reaches without exiting: the bead stays open on
 * purpose, and `claude` is interactive, so neither the closed-bead branch nor the done
 * file ever fires. Every check here therefore has an open bead, no done file, and a
 * process that is still running — which is the state the whole feature used to miss,
 * and the state in which it used to eventually record a *timeout* and charge the bead
 * an attempt for having done what the brief asked.
 */

/** An open delivery card, in the shape `cardsForDelivery` reads a bead out of. */
const deliveryCard = (bead, number = 42) => ({
  id: `${bead}-q`,
  status: 'open',
  title: `Merge #${number}?`,
  description: ['```beadpr', `bead: ${bead}`, `number: ${number}`, `url: https://example.invalid/pull/${number}`, '```'].join(
    '\n'
  ),
});

/** The attempts ledger as it was persisted — not on the card, and the point of the check. */
const attempts = () => JSON.parse(fs.readFileSync(STATE, 'utf8')).alpha?.attempts || {};

await check('a delivered window is closed, and is not written down as a timeout', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead' });
  const { advocates, events, calls } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'in_progress' }), labelled: () => [deliveryCard('al-1')] }
  );

  await advocates.tick();
  assert.equal(card(advocates).workers.length, 0, 'the slot went back');
  assert.ok(
    events.some((e) => e.action === 'delivered' && e.id === 'al-1'),
    'the ending it reached is the ending recorded'
  );
  assert.deepEqual(attempts(), {}, 'and a documented ending costs the bead no attempt');
  assert.equal(deliveryReads(calls), 1, 'one tracker call for the pass, not one per worker');
  assert.ok(await goneWithin(victim.pid, 4000), 'the window is still open');
});

await check('a handed-back window is closed, without asking the tracker anything', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  // No `DONE-`: the brief tells a session that hands back not to claim it finished.
  writeSessionRecord(victim.pid, { name: 'Alpha - al-1 a bead' });
  const { advocates, events, calls } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    { show: async () => ({ id: 'al-1', status: 'in_progress', labels: ['human'] }) }
  );

  await advocates.tick();
  assert.ok(
    events.some((e) => e.action === 'handback' && e.id === 'al-1'),
    'a `human` label on an open bead under a quiet window is a handback'
  );
  assert.deepEqual(attempts(), {}, 'which the brief asks for, so it costs no attempt');
  assert.equal(deliveryReads(calls), 0, 'the label was already in hand — no reason to ask about deliveries');
  assert.ok(await goneWithin(victim.pid, 4000), 'the window is still open');
});

await check('a window still working is neither finished nor signalled', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'Alpha - al-1 a bead', status: 'busy' });
  const { advocates, calls } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    // Everything says delivered *except* the session, which is mid-sentence. A label
    // written while a session is still typing must not end it.
    { show: async () => ({ id: 'al-1', status: 'in_progress', labels: ['human'] }), labelled: () => [deliveryCard('al-1')] }
  );

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(card(advocates).workers.length, 1, 'a busy session still holds its slot');
  assert.equal(card(advocates).closing.length, 0, 'and nothing was queued against it');
  assert.equal(deliveryReads(calls), 0, 'nor was the tracker asked about a session that has not stopped');
  assert.ok(alive(victim.pid), 'it signalled a session that was still working');
  victim.kill('SIGKILL');
});

await check('a quiet window that reached no ending at all is left where it is', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'Alpha - al-1 a bead' });
  const { advocates } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    // Open bead, no `human` label, no card: idle is not by itself an ending, and this
    // is the window that most wants reading.
    { show: async () => ({ id: 'al-1', status: 'in_progress' }) }
  );

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(card(advocates).workers.length, 1, 'it kept its slot until the timeout says otherwise');
  assert.equal(card(advocates).closing.length, 0);
  assert.ok(alive(victim.pid), 'idle alone was enough to close a window');
  victim.kill('SIGKILL');
});

await check('a tracker that will not answer is not evidence that nothing was delivered', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead' });
  const { advocates } = withWorker(
    { id: 'al-1', title: 'a bead', at: ago(300), dir: REPO, attempt: 1 },
    {
      show: async () => ({ id: 'al-1', status: 'in_progress' }),
      labelled: () => {
        throw new Error('dolt is mid-write');
      },
    }
  );

  await advocates.tick();
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(card(advocates).workers.length, 1, 'a refused answer took the slot away anyway');
  assert.ok(alive(victim.pid), 'and it signalled on the strength of it');
  victim.kill('SIGKILL');
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

await check('AND `QUEUED-` COUNTS AS FINISHED, WHICH IS WHAT THE WORKER ACTUALLY WRITES', () => {
  // Since bc-r941 a worker cannot honestly say `DONE-`: it hands its branch to the merge
  // queue and the merge happens in another process, minutes or hours later. So it writes
  // `QUEUED-` and lib/retitle.js upgrades the window when the branch lands. A sweep still
  // keyed on `DONE-` alone would have quietly stopped reaping anything — the windows
  // would sit open with their beads closed, which is the pile this module was written for.
  assert.ok(saidFinished('QUEUED-Alpha - al-1 a bead'));
  assert.ok(saidFinished('DONE-Alpha - al-1 a bead'), 'and the merged spelling still counts');
  assert.ok(!saidFinished('Alpha - al-1 a bead'));
  // `saidDone` stays narrow on purpose: it is the question lib/retitle.js asks so that it
  // never writes the prefix twice.
  assert.ok(!saidDone('QUEUED-Alpha - al-1 a bead'), 'queued is not merged');
  const cand = sweepCandidate(idle({ name: 'QUEUED-Alpha - al-1 a bead' }));
  assert.equal(cand?.id, 'al-1', 'a delivered window whose bead closed is still reapable');
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

/* ------------------------------------------- the windows with nothing left in them */

await check('a tick closes the windows that have lost their last tab', async () => {
  clearSessionRecords();
  const closed = [];
  const { advocates, calls } = withNoWorkers({
    show: async () => ({ id: 'al-1', status: 'open' }),
    empty: () => {
      closed.push('once');
      return { closed: 2, ids: ['42590', '42729'], error: null };
    },
  });

  await advocates.tick();
  assert.equal(calls.sweptEmpty, 1, 'asked once per tick');
  assert.equal(closed.length, 1);
  // Once per tick and not once per advocate: the frame belongs to no workspace, because
  // the session that could have said which one is exactly what is missing from it.
  await advocates.tick();
  assert.equal(calls.sweptEmpty, 2);
});

await check('and does not, when the switch is off', async () => {
  clearSessionRecords();
  const { advocates, calls } = withNoWorkers({
    show: async () => ({ id: 'al-1', status: 'open' }),
    overrides: { closeEmptyWindows: false },
  });

  await advocates.tick();
  assert.equal(calls.sweptEmpty, 0);
});

await check('and a sweep that throws is not reported as the whole tick failing', async () => {
  clearSessionRecords();
  const { advocates, calls } = withNoWorkers({
    show: async () => ({ id: 'al-1', status: 'open' }),
    empty: () => {
      throw new Error('osascript is not allowed assistive access');
    },
  });

  // The tick's own catch lives in lib/server.js and files a crash bead over what it
  // catches. Housekeeping that closed no windows must not spend one.
  await advocates.tick();
  assert.equal(calls.sweptEmpty, 1);
});

await check('and a sweep that could not talk to iTerm does not take the tick with it', async () => {
  clearSessionRecords();
  const victim = spawnVictim();
  writeSessionRecord(victim.pid, { name: 'DONE-Alpha - al-1 a bead', idleSecs: 3600 });
  const { advocates, calls } = withNoWorkers({
    show: async () => ({ id: 'al-1', status: 'closed' }),
    empty: () => ({ closed: 0, ids: [], error: 'iTerm got an error: -1743' }),
  });

  await advocates.tick();
  assert.equal(calls.sweptEmpty, 1);
  // The sweep runs last, so a failure in it must not lose the work of everything above
  // it — the window that *was* found this tick is still on the closing list.
  assert.equal(card(advocates).closing.length, 1, 'the rest of the tick still happened');
  victim.kill('SIGKILL');
});

/*
 * bc-xl7n.131.1. `unreportedStuck` itself is pure and covered in test/cards.mjs; what is
 * under test here is the half that is not — the `reportedStuck` Set's *lifetime* and the
 * one call site that feeds it. Both are wiring, and wiring is invisible to a unit test:
 * deleting the whole block from `sweepEmptyWindows`, or moving the Set's declaration
 * inside the sweep so that every tick starts with a blank memory, left both suites green.
 * The second of those is the exact once-a-tick log shape bc-xl7n.110 was filed over, so it
 * has to be measured across ticks or it is not measured at all — hence the three ticks and
 * the log, rather than another call to the pure function.
 */

/** Run `fn` with `console.log` collected, so a tick's own reporting can be read back. */
async function saidWhile(fn) {
  const said = [];
  const realLog = console.log;
  console.log = (...a) => said.push(a.map(String).join(' '));
  try {
    await fn();
  } finally {
    console.log = realLog;
  }
  return said;
}

/** The one line the stuck half of the sweep writes, whoever else logged this tick. */
const stuckLines = (said) => said.filter((l) => l.includes('would not close'));

/**
 * A sweep that hands back a different pile each tick, clamping at the last one — so a
 * check states what iTerm answers on tick 1, 2 and 3 and reads like the sequence it is.
 */
function sweepingStuck(piles) {
  let tick = 0;
  return () => ({
    closed: 0,
    ids: [],
    error: null,
    stuck: piles[Math.min(tick++, piles.length - 1)],
  });
}

await check('a window that would not close is said once, not once a tick', async () => {
  clearSessionRecords();
  const { advocates, calls } = withNoWorkers({
    show: async () => ({ id: 'al-1', status: 'open' }),
    // The same two frames on the desk for two ticks, then a third joining them. A stuck
    // window is stuck: that repetition is the premise here, not an edge case.
    empty: sweepingStuck([
      ['47768', '47792'],
      ['47768', '47792'],
      ['47768', '47792', '48037'],
    ]),
  });

  const said = await saidWhile(async () => {
    await advocates.tick();
    await advocates.tick();
    await advocates.tick();
  });

  assert.equal(calls.sweptEmpty, 3, 'three ticks, three sweeps');
  const lines = stuckLines(said);
  // Two lines out of three ticks is the whole property: one for the pair, one for the
  // newcomer, and nothing at all for the tick that brought no news. A memory that did not
  // outlive the tick would say all three, which is what the daemon did 2,330 times.
  assert.equal(lines.length, 2, 'the second tick added nothing to say');
  assert.match(lines[0], /2 iTerm window\(s\).*47768, 47792/);
  assert.match(lines[1], /1 iTerm window\(s\).*48037/);
  assert.ok(!lines[1].includes('47768'), 'and the newcomer is announced alone');
});

await check('and an id that leaves the desk and comes back is said again', async () => {
  clearSessionRecords();
  const { advocates } = withNoWorkers({
    show: async () => ({ id: 'al-1', status: 'open' }),
    // iTerm reuses window ids, so 47768 returning after a tick without it is a different
    // frame that has never been reported. The memory forgets by what is on the desk rather
    // than by uptime, and this is the direction of that forgetting the call site owes: it
    // hands the same Set back every tick, so the pruning inside it is what is observed.
    empty: sweepingStuck([['47768'], [], ['47768']]),
  });

  const said = await saidWhile(async () => {
    await advocates.tick();
    await advocates.tick();
    await advocates.tick();
  });

  const lines = stuckLines(said);
  assert.equal(lines.length, 2, 'said, forgotten, said again');
  for (const l of lines) assert.match(l, /1 iTerm window\(s\).*47768/);
});

/* -------------------------------------- the window that opened and never ran anything */

/*
 * bc-xl7n.113.3. `finish` in lib/advocate.js already tells this bead's window apart from
 * every one `closingFor` above closes — it comes in as the `never-started` kind, with no
 * pid at all — so what is under test here is only the part that is new: the record built
 * from `term` instead of a pid, and the decision made from a fresh read of the handle
 * rather than a live-sessions lookup. End-to-end wiring through a tick is
 * test/neverstarted.mjs, which already has the fixture for triggering the outcome; this
 * file stays with the pure decision and the one real call that must send no Apple event.
 */

console.log('\nclosing a window that never ran anything\n');

await check('no term handle, no closing record', () => {
  assert.equal(closingNeverStartedFor({ id: 'al-1', title: 'a bead' }), null);
  assert.equal(closingNeverStartedFor({ id: 'al-1', title: 'a bead', term: '' }), null);
  assert.equal(closingNeverStartedFor(null), null);
});

await check('a term handle makes a record addressed by it, not by a pid', () => {
  const rec = closingNeverStartedFor({ id: 'al-1', title: 'a bead', term: 'ITERM-SESS-1' });
  assert.deepEqual(rec, { id: 'al-1', title: 'a bead', term: 'ITERM-SESS-1', at: rec.at });
  assert.equal(closingNeverStartedFor({ id: 'al-1', term: 'x' }).title, 'al-1', 'falls back to the id');
});

await check('the window being gone is the ordinary, expected ending', () => {
  assert.deepEqual(decideNeverStarted(entry(), null), { act: 'drop', why: 'the window is gone' });
});

await check('a tab that no longer names the bead is left alone — the term id is not enough on its own', () => {
  const verdict = decideNeverStarted(entry(), { tty: '/dev/ttys011', name: 'Alpha - al-9 something else' });
  assert.equal(verdict.act, 'drop');
  assert.match(verdict.why, /no longer names al-1/);
});

await check('a claude process on its tty means it is not never-started any more', () => {
  const tab = { tty: '/dev/ttys011', name: 'Alpha - al-1 a bead' };
  assert.equal(decideNeverStarted(entry(), tab, { hasClaude: true }).act, 'drop');
  // An unanswered question about whether an agent is there is never permission to close —
  // same as `null` reading as `true` everywhere else this kind of guard appears.
  assert.equal(decideNeverStarted(entry(), tab, { hasClaude: null }).act, 'drop');
});

await check('nothing running, tab still names the bead: close it', () => {
  const tab = { tty: '/dev/ttys011', name: 'Alpha - al-1 a bead' };
  const verdict = decideNeverStarted(entry(), tab, { hasClaude: false });
  assert.equal(verdict.act, 'close');
  const verdict2 = decideNeverStarted(entry(), tab);
  assert.equal(verdict2.act, 'close', 'hasClaude defaults to false, not to "unknown"');
});

await check('the subtask/parent id trap applies here too', () => {
  assert.equal(
    decideNeverStarted(entry({ id: 'al-1' }), { tty: '/dev/ttys011', name: 'Alpha - al-1.2 the subtask' }).act,
    'drop'
  );
  assert.equal(
    decideNeverStarted(entry({ id: 'al-1.2' }), { tty: '/dev/ttys011', name: 'Alpha - al-1.2 the subtask' }).act,
    'close'
  );
});

await check(
  'the real closer sends no Apple event inside a suite, and says why — this process may not close a window either',
  async () => {
    // No stubbing at all: this is the function lib/advocate.js calls for real.
    // `mayLaunch` reads `startedByASuite` off `process.argv`, which for this process is
    // `node test/reap.mjs` — the same gate `closeEmptyWindows` (lib/iterm.js) checks
    // before its own osascript call, asked here first and before any of the three round
    // trips a real close would otherwise make.
    const verdict = await closeNeverStartedWindow({ id: 'al-1', title: 'a bead', term: 'ITERM-SESS-1' });
    assert.deepEqual(verdict, { act: 'refused', why: 'this process may not send Apple events' });
  }
);

/* ---------------------------------------------------------------------- out */

console.log(`\n${ran - failures}/${ran} passed\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
