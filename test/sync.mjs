#!/usr/bin/env node
/**
 * A shared tracker that stopped being shared — said on screen, instead of drawn as calm.
 *
 *     npm test
 *     node test/sync.mjs
 *
 * bc-hlu2. Until lib/sync.js landed, nothing in beadcause had ever called `bd dolt push`
 * or `bd dolt pull`: five comments discussed embedded versus server mode and not one line
 * synced anything, so two engineers running beadcause had two private issue graphs that
 * never met. Everything downstream of that — a second engineer installing against the
 * team's tracker, a question addressed to one person, two advocates not opening a session
 * on the same bead — is arithmetic over a graph both machines can see.
 *
 * **The failure path is what this suite is for, and that is not a preference.** A sync
 * that works is invisible by design and provable by looking at a second Mac. A sync that
 * quietly stopped looks *exactly* like a quiet team: the inbox is right, every count is
 * real, nothing is stale, and the only thing wrong is that it is right about one machine.
 * There is nothing on the screen to notice, so the only thing that can notice it is code
 * — which makes the code that notices the thing most worth a test, and the hardest to
 * exercise for real, because you cannot make two Macs disagree from inside a suite.
 *
 * So `bd` is a fake here, in the shape lib/bd.js presents to lib/sync.js, and it is what
 * lets the four outcomes and both transitions be produced on demand. The seams that a
 * fake cannot reach — the payload field, the poll cycle, the pane on the phone, the
 * colour on the monitor — are checked as static reads of the files that own them, which
 * is what test/sweepfail.mjs does for the sibling failure and for the same reason: the
 * inbox needs its whole document to render, and what a refactor silently breaks is the
 * wiring rather than the arithmetic.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sync-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const check = async (name, fn) => {
  ran += 1;
  try {
    await fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}\n      ${err.message.split('\n')[0]}`);
  }
};

console.log('a shared tracker that is no longer shared');

const { syncOnce, createSyncer, describeSync, isConflict, isStuck, syncEnabled, syncEveryMs, SYNC_FLOOR_SECONDS, STUCK_AFTER } =
  await import(LIB('sync.js'));

const WS = (name) => ({ name, dir: `/nowhere/${name}/.beads` });
const DIR = (name) => `/nowhere/${name}`;

/**
 * `bd`, as lib/sync.js sees it. `calls` is the transcript, which is how the ordering
 * assertion below is made at all — pull-before-push is not observable from the outcome.
 */
function fakeBd({ remote = { name: 'origin', url: 'git+ssh://git@example.com/team/repo.git' }, pull, push } = {}) {
  const calls = [];
  return {
    calls,
    async doltRemote(ws) {
      calls.push(`remote:${ws.name}`);
      if (remote instanceof Error) throw remote;
      return typeof remote === 'function' ? remote(ws) : remote;
    },
    async doltPull(ws) {
      calls.push(`pull:${ws.name}`);
      if (pull instanceof Error) throw pull;
      if (typeof pull === 'function') return pull(ws);
    },
    async doltPush(ws) {
      calls.push(`push:${ws.name}`);
      if (push instanceof Error) throw push;
      if (typeof push === 'function') return push(ws);
    },
  };
}

/* ------------------------------------------------------- one workspace, one sync */

await check('a workspace with no Dolt remote is skipped, and nothing is pushed or pulled at it', async () => {
  // The default state of every workspace on a solo install, and it must be silent: a
  // list naming four private repos every two minutes is what teaches you to stop reading
  // the one line that matters.
  const bd = fakeBd({ remote: null });
  const out = await syncOnce(bd, WS('solo'));
  assert.equal(out.state, 'no-remote');
  assert.deepEqual(bd.calls, ['remote:solo'], 'asked, and then left it alone');
});

await check('a workspace with a remote pulls and then pushes — in that order', async () => {
  // Not cosmetic. A push against a remote that has moved is refused, so pushing first
  // turns an ordinary two-machine afternoon into a failure on every single tick.
  const bd = fakeBd();
  const out = await syncOnce(bd, WS('team'));
  assert.equal(out.state, 'ok');
  assert.deepEqual(bd.calls, ['remote:team', 'pull:team', 'push:team']);
});

await check('an ok outcome carries where the beads went', async () => {
  const out = await syncOnce(fakeBd(), WS('team'));
  assert.equal(out.remote.url, 'git+ssh://git@example.com/team/repo.git');
  assert.match(describeSync(out), /in sync with git\+ssh:\/\/git@example\.com\/team\/repo\.git/);
});

await check('a pull that failed is a failure, and it says it was the pull', async () => {
  const bd = fakeBd({ pull: new Error('dial tcp: connect: network is unreachable') });
  const out = await syncOnce(bd, WS('team'));
  assert.equal(out.state, 'failed');
  assert.equal(out.phase, 'pull');
  assert.equal(out.error, 'dial tcp: connect: network is unreachable');
  assert.ok(!bd.calls.includes('push:team'), 'and nothing was pushed on top of a failed pull');
});

await check('a push that failed is a failure, and it says it was the push', async () => {
  const out = await syncOnce(fakeBd({ push: new Error('Permission denied (publickey)') }), WS('team'));
  assert.equal(out.state, 'failed');
  assert.equal(out.phase, 'push');
});

await check('a remote that cannot even be listed is a failure rather than a silent skip', async () => {
  // The dangerous direction: an unreadable `bd dolt remote list` looks exactly like a
  // workspace that has no remote, and treating it as one would silently stop syncing a
  // shared tracker and say nothing at all.
  const out = await syncOnce(fakeBd({ remote: new Error('dolt: database is locked') }), WS('team'));
  assert.equal(out.state, 'failed');
  assert.equal(out.phase, 'remote');
});

await check("bd's own `failed in <ws>:` prefix is dropped — the row already names the repo", async () => {
  const out = await syncOnce(fakeBd({ pull: new Error('bd dolt pull failed in team: dolt: database is locked') }), WS('team'));
  assert.equal(out.error, 'dolt: database is locked');
});

await check('syncOnce never throws, whatever bd does', async () => {
  // It runs inside a poll cycle whose other sweeps must not be stopped by this one.
  const hostile = {
    doltRemote: () => Promise.reject(new TypeError('undefined is not a function')),
  };
  const out = await syncOnce(hostile, WS('team'));
  assert.equal(out.state, 'failed');
});

/* --------------------------------------------------------------- conflict, apart */

await check('a Dolt merge conflict is its own outcome, not one more failure', async () => {
  // The distinction the whole design rests on. A failed sync retries and very often
  // fixes itself; a conflict is two machines that wrote the same bead and no number of
  // retries has ever resolved one. Filing it under the word "retrying" is how a
  // divergence sits there for a fortnight.
  const out = await syncOnce(fakeBd({ pull: new Error('merge conflict in issues: 2 rows') }), WS('team'));
  assert.equal(out.state, 'conflict');
  assert.match(describeSync(out), /CONFLICT/);
});

await check('the shapes Dolt says it in are all read as conflicts', () => {
  for (const text of [
    'merge conflict in issues',
    'automatic merge failed; 3 conflicts',
    'the two histories cannot be merged',
    'unresolved conflicts remain',
    'merge is not fast-forward',
  ]) {
    assert.ok(isConflict(text), `"${text}" is a conflict`);
  }
});

await check('and an ordinary network failure is not', () => {
  for (const text of ['connection refused', 'Permission denied (publickey)', 'dolt: database is locked', '']) {
    assert.ok(!isConflict(text), `"${text}" is not a conflict`);
  }
});

/* --------------------------------------------------- the record, and the two noises */

await check('a failure reaches trouble(), named, with what bd said', async () => {
  const s = createSyncer({ bd: fakeBd({ push: new Error('Permission denied (publickey)') }) });
  await s.sweep([WS('team')]);
  const [row] = s.trouble();
  assert.equal(row.workspace, 'team');
  assert.equal(row.channel, 'sync');
  assert.equal(row.conflict, false);
  assert.equal(row.error, 'Permission denied (publickey)');
  assert.equal(row.phase, 'push');
  assert.ok(row.at, 'stamped with when');
  // The directory a person would type the fix in, taken off the workspace rather than
  // built from its name: a workspace is not necessarily under `~/beads` — Climative's
  // lives inside the `architecture` checkout — and a notification suggesting a `cd` into
  // a path that does not exist teaches you the message is not to be trusted.
  assert.equal(row.dir, DIR('team'));
});


await check('a conflict row says so, so the screen can use a different sentence', async () => {
  const s = createSyncer({ bd: fakeBd({ pull: new Error('merge conflict in issues') }) });
  await s.sweep([WS('team')]);
  assert.equal(s.trouble()[0].conflict, true);
});

await check('a workspace with no remote is never in trouble', async () => {
  const s = createSyncer({ bd: fakeBd({ remote: null }) });
  await s.sweep([WS('solo')]);
  assert.deepEqual(s.trouble(), []);
});

await check('the first failure is the noise, and the second is not', async () => {
  // Without this the phone gets a notification every two minutes for as long as the
  // wifi is down — which is the notification you learn to swipe away, and then keep
  // swiping away on the day it means something else.
  const bd = fakeBd({ push: new Error('nope') });
  const s = createSyncer({ bd });
  const first = await s.sweep([WS('team')]);
  assert.equal(first.changed.length, 1);
  assert.equal(first.changed[0].transition, 'broke');
  const second = await s.sweep([WS('team')]);
  assert.deepEqual(second.changed, [], 'still broken is not news');
  assert.equal(s.trouble().length, 1, 'but it is still on the screen');
});

await check('coming back is the other noise, and it clears the screen', async () => {
  let broken = true;
  const bd = fakeBd({ push: () => { if (broken) throw new Error('nope'); } });
  const s = createSyncer({ bd });
  await s.sweep([WS('team')]);
  broken = false;
  const out = await s.sweep([WS('team')]);
  assert.equal(out.changed[0].transition, 'recovered');
  assert.deepEqual(s.trouble(), [], 'the pane stops saying so the moment it is true again');
});

await check('a failure that becomes a conflict is news again', async () => {
  // It has stopped being the kind of problem that fixes itself, and the first
  // notification said it would retry.
  let text = 'connection refused';
  const bd = fakeBd({ pull: () => { throw new Error(text); } });
  const s = createSyncer({ bd });
  await s.sweep([WS('team')]);
  text = 'merge conflict in issues';
  const out = await s.sweep([WS('team')]);
  assert.equal(out.changed.length, 1);
  assert.equal(out.changed[0].state, 'conflict');
  assert.equal(out.changed[0].transition, null, 'it never stopped being broken');
});

await check('a sync that works says nothing at all', async () => {
  const s = createSyncer({ bd: fakeBd() });
  const out = await s.sweep([WS('team')]);
  assert.deepEqual(out.changed, []);
  assert.deepEqual(s.trouble(), []);
});

await check('workspaces are swept together, and one failing does not stop the others', async () => {
  const bd = {
    async doltRemote() {
      return { name: 'origin', url: 'u' };
    },
    async doltPull(ws) {
      if (ws.name === 'bad') throw new Error('nope');
    },
    async doltPush() {},
  };
  const s = createSyncer({ bd });
  const out = await s.sweep([WS('bad'), WS('good')]);
  assert.equal(out.results.length, 2);
  assert.equal(s.get('good').state, 'ok');
  assert.equal(s.get('bad').state, 'failed');
});

await check('a workspace still syncing from the last tick is skipped, not started twice', async () => {
  // `setInterval` does not wait for an async callback, so a sync slower than its own
  // interval would otherwise have a second one started on top of it: two `bd dolt push`
  // against one embedded Dolt, fighting over the single write lock.
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  const bd = fakeBd({ pull: () => gate });
  const s = createSyncer({ bd });
  const slow = s.sweep([WS('team')]);
  const overlapping = await s.sweep([WS('team')]);
  assert.deepEqual(overlapping.skipped, ['team']);
  assert.deepEqual(overlapping.results, [], 'and it did not sync it a second time');
  release();
  await slow;
  const after = await s.sweep([WS('team')]);
  assert.deepEqual(after.skipped, [], 'and the guard lifts once the first one finishes');
});

/* ------------------------------------------------- stuck, which is not the same as failed */

const STOMP = 'merge origin/main: Error 1105: error: local changes would be stomped by merge:\n\tevents\n Please commit your changes before you merge.';

await check('the refusal that will never clear is read as stuck on the very first tick', async () => {
  // Measured on bc-y3qk.5: 73 logged ticks of this exact string, every one of them
  // filed as `failed` — a word that promises the next interval may fix it. It cannot.
  // A plain `dolt merge` typed by hand fails identically against a verifiably clean
  // tree, so the state on the next tick is the state on this one.
  //
  // First tick and not the fifth, because the daemon restarts constantly (505 times in
  // the log this came from) and an in-memory streak almost never gets to five. A shape
  // that is recognisable on sight is the only kind of recognition that survives that.
  const out = await syncOnce(fakeBd({ pull: new Error(STOMP) }), WS('team'));
  assert.equal(out.state, 'stuck');
  assert.equal(out.phase, 'pull');
});

await check('the shapes Dolt refuses a dirty working set in are all read as stuck', () => {
  for (const text of [
    'error: local changes would be stomped by merge:',
    'Please commit your changes before you merge.',
    'local changes would be stomped by merge: events',
  ]) {
    assert.ok(isStuck(text), `"${text}" is stuck`);
  }
});

await check('and an ordinary network failure is not stuck, nor is a conflict', () => {
  for (const text of ['connection refused', 'Permission denied (publickey)', 'merge conflict in issues', '']) {
    assert.ok(!isStuck(text), `"${text}" is not stuck`);
  }
  // The two words stay apart: a conflict is two people's work disagreeing and needs a
  // decision about whose wins; a stuck sync is one machine unable to move.
  assert.ok(!isConflict(STOMP), 'the stomp refusal is not a merge conflict');
});

await check('a stuck sync never describes itself as retrying, and says how long instead', () => {
  const line = describeSync({ state: 'stuck', phase: 'pull', error: 'stomped by merge', streak: 73 });
  assert.match(line, /STUCK/);
  assert.match(line, /73 identical failures/);
  assert.doesNotMatch(line, /retr/i, 'the word that was wrong for a week');
});

await check('a stuck pull still pushes — the half that gets this Mac’s beads out', async () => {
  // The costliest line of the whole outage. `pull` then `push` returned on the first
  // failure, so a pull that was refused a *no-op merge* (`main..origin/main` was zero
  // commits) stood in front of the push, and 208 local commits never reached the team.
  // A stuck pull means the remote was reachable and the local merge refused, so the
  // push is both viable and the one that matters.
  const bd = fakeBd({ pull: new Error(STOMP) });
  const out = await syncOnce(bd, WS('team'));
  assert.ok(bd.calls.includes('push:team'), 'it pushed anyway');
  assert.equal(out.state, 'stuck', 'and is still honest that it is not pulling');
  assert.equal(out.pushed, true);
  assert.match(describeSync(out), /beads did get out/);
});

await check('but an ordinary failed pull still does not push behind it', async () => {
  // Unchanged, and deliberately: a `failed` pull is usually the network, so a push
  // behind it is a second two-minute timeout bought for nothing.
  const bd = fakeBd({ pull: new Error('connection refused') });
  const out = await syncOnce(bd, WS('team'));
  assert.equal(out.state, 'failed');
  assert.ok(!bd.calls.includes('push:team'));
});

await check('a push that fails behind a stuck pull does not hide the stuck pull', async () => {
  const out = await syncOnce(fakeBd({ pull: new Error(STOMP), push: new Error('Permission denied (publickey)') }), WS('team'));
  assert.equal(out.state, 'stuck');
  assert.equal(out.phase, 'pull', 'the pull is the thing that needs a person');
  assert.ok(!out.pushed);
});

/* ------------------------------------------------------------ the one recovery it may try */

/** `bd` with the recovery call lib/sync.js reaches for on a stuck pull. */
const recoverableBd = ({ commits = true, clearsIt = true } = {}) => {
  const calls = [];
  let committed = false;
  return {
    calls,
    async doltRemote() {
      return { name: 'origin', url: 'u' };
    },
    async doltPull() {
      calls.push('pull');
      if (committed && clearsIt) return;
      throw new Error(STOMP);
    },
    async doltCommit() {
      calls.push('commit');
      if (!commits) throw new Error('nothing to commit');
      committed = true;
    },
    async doltPush() {
      calls.push('push');
    },
  };
};

await check('a stuck pull is committed and retried once — the remedy Dolt itself names', async () => {
  // "Please commit your changes before you merge." Committing *keeps* the changes,
  // which is what makes it safe to do unattended on a tracker twenty agent sessions
  // are writing into. Discarding them would also clear the refusal and is not a thing
  // a daemon may decide.
  const bd = recoverableBd();
  const out = await syncOnce(bd, WS('team'));
  assert.deepEqual(bd.calls, ['pull', 'commit', 'pull', 'push']);
  assert.equal(out.state, 'ok', 'and it came back without anybody typing anything');
});

await check('it tries that exactly once, and does not loop on it', async () => {
  const bd = recoverableBd({ clearsIt: false });
  const out = await syncOnce(bd, WS('team'));
  assert.equal(bd.calls.filter((c) => c === 'commit').length, 1);
  assert.equal(bd.calls.filter((c) => c === 'pull').length, 2);
  assert.equal(out.state, 'stuck');
});

await check('when committing cannot clear it, the outcome says so rather than suggesting it again', async () => {
  // The case this was measured against: there was nothing to commit, because the
  // working root differed from HEAD *physically* and no diff could see it.
  const out = await syncOnce(recoverableBd({ commits: false }), WS('team'));
  assert.equal(out.state, 'stuck');
  assert.equal(out.recovery, 'commit-failed');
});

await check('a bd with no recovery call at all is simply not asked for one', async () => {
  // Every fake in this suite predates `doltCommit`, and an adapter that has not got it
  // must degrade to the old behaviour rather than throwing inside the poll cycle.
  const out = await syncOnce(fakeBd({ pull: new Error(STOMP) }), WS('team'));
  assert.equal(out.state, 'stuck');
});

/* ------------------------------------------------ the general rule: N of the same thing */

await check('five identical failures stop being called transient', async () => {
  // For every error that is not a shape `isStuck` knows on sight. A dropped network
  // really does clear, so the first few say so; ten minutes of a byte-identical
  // sentence is not a blip whatever it is.
  const s = createSyncer({ bd: fakeBd({ pull: new Error('connection refused') }) });
  for (let i = 1; i < STUCK_AFTER; i += 1) {
    await s.sweep([WS('team')]);
    assert.equal(s.get('team').state, 'failed', `tick ${i} is still just a failure`);
  }
  const out = await s.sweep([WS('team')]);
  assert.equal(s.get('team').state, 'stuck');
  assert.equal(s.get('team').streak, STUCK_AFTER);
  assert.equal(out.changed.length, 1, 'and crossing the line is news');
  assert.equal(out.changed[0].state, 'stuck');
});

await check('a failure whose reason moved has not been failing the same way', async () => {
  // Otherwise a wandering series of unrelated blips adds up to an escalation naming an
  // error that is no longer happening.
  let text = 'connection refused';
  const s = createSyncer({ bd: fakeBd({ pull: () => { throw new Error(text); } }) });
  for (let i = 0; i < STUCK_AFTER - 1; i += 1) await s.sweep([WS('team')]);
  text = 'Permission denied (publickey)';
  await s.sweep([WS('team')]);
  assert.equal(s.get('team').streak, 1, 'the count starts again');
  assert.equal(s.get('team').state, 'failed');
});

await check('becoming stuck is announced once, and then it is quiet', async () => {
  // The whole complaint on bc-y3qk.4 is a phone buzzing on every transition. This adds
  // one more transition per incident and must not add a second.
  const s = createSyncer({ bd: fakeBd({ pull: new Error(STOMP) }) });
  const first = await s.sweep([WS('team')]);
  assert.equal(first.changed[0].transition, 'broke');
  for (let i = 0; i < 20; i += 1) {
    assert.deepEqual((await s.sweep([WS('team')])).changed, [], 'still stuck is not news');
  }
  assert.equal(s.trouble().length, 1, 'but it stays on the screen for as long as it is true');
});

await check('a stuck workspace recovers like any other, and clears the pane', async () => {
  let broken = true;
  const bd = fakeBd({ pull: () => { if (broken) throw new Error(STOMP); } });
  const s = createSyncer({ bd });
  await s.sweep([WS('team')]);
  assert.equal(s.get('team').state, 'stuck');
  broken = false;
  const out = await s.sweep([WS('team')]);
  assert.equal(out.changed[0].transition, 'recovered');
  assert.deepEqual(s.trouble(), []);
});

await check('a stuck row reaches trouble(), flagged apart from a conflict', async () => {
  const s = createSyncer({ bd: fakeBd({ pull: new Error(STOMP) }) });
  await s.sweep([WS('team')]);
  const [row] = s.trouble();
  assert.equal(row.stuck, true);
  assert.equal(row.conflict, false, 'a screen must not call this a conflict');
  assert.equal(row.streak, 1);
  assert.equal(row.error.includes('stomped by merge'), true);
});

/* ----------------------------------------------------------------- the cadence */

await check('the cadence is a setting, not a constant', () => {
  assert.equal(syncEveryMs({ sync: { seconds: 600 } }), 600_000);
  assert.equal(syncEveryMs({}), 120_000, 'two minutes by default');
});

await check('and it has a floor, because there is no such thing as a usefully faster sync', () => {
  assert.equal(syncEveryMs({ sync: { seconds: 1 } }), SYNC_FLOOR_SECONDS * 1000);
  assert.equal(syncEveryMs({ sync: { seconds: 'nonsense' } }), 120_000);
});

await check('syncing can be turned off, and off is a real answer', () => {
  assert.equal(syncEnabled({}), true);
  assert.equal(syncEnabled({ sync: { enabled: false } }), false);
});

await check('the config ships the block, so it is documented where every other setting is', async () => {
  // `defaults()` is not exported, so this loads a config the way a daemon does: an empty
  // config directory, which `loadConfig` fills in from those defaults and writes.
  const { loadConfig } = await import(LIB('config.js'));
  const cfg = loadConfig();
  assert.equal(cfg.sync.enabled, true);
  assert.equal(typeof cfg.sync.seconds, 'number');
  assert.ok(!('workspaces' in cfg.sync), 'and deliberately no list of which — a remote is the list');
});

/* ------------------------------------------------------- the bd adapter's parsing */

await check('the remote is read from --json, with the url and not just the name', async () => {
  // The human-readable form of an unconfigured workspace is the sentence "No remotes
  // configured.", and parsing prose for a *default off* is how a shared workspace ends
  // up silently not syncing. Both shapes below are bd 1.1.2's, measured.
  const { Bd } = await import(LIB('bd.js'));
  const bd = new Bd({ bin: 'unused', actor: 'beadcause' });
  bd.json = async () => [{ name: 'origin', url: 'git+ssh://git@github.com/Climative/architecture.git', sql_url: 'x' }];
  assert.deepEqual(await bd.doltRemote(WS('team')), {
    name: 'origin',
    url: 'git+ssh://git@github.com/Climative/architecture.git',
  });
  bd.json = async () => [];
  assert.equal(await bd.doltRemote(WS('solo')), null, 'an empty list is a solo workspace');
});

/* --------------------------------------------------- the seams a fake cannot reach */

const SERVER = read('lib/server.js');
const NOTIFY = read('lib/notify.js');
const APP = read('public/app.js');
const CSS = read('public/style.css');
const MON = read('bin/monitor.js');

await check('the poll cycle syncs, and the failure it cannot handle files itself', () => {
  assert.match(SERVER, /const sweepSync = async \(\)/, 'the sweep exists');
  assert.match(SERVER, /await sweepSync\(\)/, 'and the cycle calls it');
  assert.match(SERVER, /sweepFailed\('the tracker sync'/, 'and a bug in it becomes a bead like the other five');
});

await check('the failure reaches the payload, in a field of its own', () => {
  // The whole thing is downstream of this. A record nothing carries to a client is a
  // record only the daemon's stdout has, on a Mac nobody is sitting at.
  assert.match(SERVER, /syncTrouble: syncer\.trouble\(\)/);
});

await check('and it is NOT merged into the read-failure list', () => {
  // `mergeTrouble` keeps one row per workspace and the most recent wins, so a locked
  // Dolt read arriving a second after a divergence would hide the divergence — and the
  // two say opposite things about the list underneath them.
  // Sliced to where the *next* declaration starts rather than to a character count.
  // bc-0i27.6 added a dozen lines above `syncTrouble:` and a fixed 2500-character
  // window stopped reaching it — which read here as the key having been taken off the
  // payload, in a suite nowhere near that diff.
  const from = SERVER.indexOf('function inboxPayload(');
  const rest = SERVER.slice(from + 1);
  const next = rest.search(/\n {2}(?:async )?function /);
  const payload = next === -1 ? SERVER.slice(from) : rest.slice(0, next);
  assert.ok(payload.includes('questions: rows'), 'inboxPayload no longer builds the payload — this slice has gone stale');
  assert.match(payload, /syncTrouble:/, 'its own key');
  assert.doesNotMatch(payload, /mergeTrouble\([^)]*syncer/, 'not folded into the other one');
});

await check('a divergence pushes to the phone, and a conflict pushes harder', () => {
  // ntfy is the one channel that does not depend on you looking at anything.
  assert.match(NOTIFY, /export async function pushSyncTrouble/);
  assert.match(NOTIFY, /export async function pushSyncedAgain/);
  const push = NOTIFY.slice(NOTIFY.indexOf('export async function pushSyncTrouble'), NOTIFY.indexOf('export async function pushSyncedAgain'));
  // A conflict and a stuck sync both need a person at a keyboard; a retryable failure
  // does not. The two loud ones share the priority and keep separate titles, because
  // they are different jobs: one is a decision about whose write wins, the other is a
  // command to type.
  assert.match(push, /needsHands \? 4 : 3/, 'the two that need a person outrank a retryable failure');
  assert.match(push, /conflicted\.length \|\| stuck\.length/, 'and that is what needsHands means');
  assert.match(push, /tracker STUCK/, 'a stuck tracker says so in the title');
  assert.match(push, /will not clear on its own/, 'and does not promise a retry');
  assert.match(push, /OBSERVING/, 'and an observer instance stays silent, like every other push');
  // The fix it prints has to be a directory that exists. A workspace is not necessarily
  // under `~/beads` — Climative's lives inside the `architecture` checkout — so the path
  // comes off the workspace, and a suggested `cd` into somewhere invented is the fastest
  // way to teach somebody that this notification is not to be trusted.
  assert.match(push, /cd \$\{r\.dir\}/, 'the workspace says where it is');
  assert.doesNotMatch(push, /~\/beads\//, 'and nothing here assumes a layout');
});

await check('the inbox draws it as a pane of its own, outside the empty state', () => {
  assert.match(APP, /data\.syncTrouble/, 'the field is read');
  assert.match(APP, /key: '@synctrouble'/, 'its own chunk in the list');
  const empty = APP.slice(APP.indexOf('function emptyHtml()'), APP.indexOf('function emptyHtml()') + 1400);
  assert.doesNotMatch(empty, /syncTroubleHtml/, 'the list is usually not empty when this happens');
});

await check('the pane names the repo, prints the error, and calls a conflict a conflict', () => {
  const pane = APP.slice(APP.indexOf('function syncTroubleHtml()'), APP.indexOf('function syncTroubleHtml()') + 1800);
  assert.match(pane, /t\.workspace/, 'names the repo');
  assert.match(pane, /t\.error/, 'and says what went wrong');
  assert.match(pane, /conflict/i, 'and distinguishes the one that will not clear on its own');
});

await check('what it draws has a rule of its own, in a colour the page defines for both themes', () => {
  // Two identical red boxes stacked would read as one problem said twice — and the
  // whole reason they are two panes is that they are opposite claims about the beads
  // underneath them.
  assert.match(CSS, /^\.trouble-sync \{/m);
  assert.match(CSS, /\.trouble-sync[\s\S]{0,220}--warn/, 'and not the read-failure red');
});

await check('the monitor knows the event, so it is not an uncoloured line in a log of forty', () => {
  assert.match(SERVER, /type: 'sync'/, 'the daemon emits it');
  assert.match(MON, /^ {2}sync: C\./m, 'and the monitor colours it');
  assert.match(MON, /case 'sync':/, 'and says what happened');
});

await check('nothing here ever adds a remote', () => {
  // Where a tracker is published is not a decision a daemon may make on somebody's
  // behalf, and it is not a reversible one: a push to a public repo is on the internet
  // whatever you do next. Matched against the `bd` argv shape rather than the prose,
  // because every file here *discusses* `bd dolt remote add` at length and the thing
  // being forbidden is calling it.
  const ADD = /['"]remote['"]\s*,\s*['"]add['"]|doltRemoteAdd|doltAddRemote/;
  for (const f of ['lib/sync.js', 'lib/server.js', 'lib/bd.js']) {
    assert.doesNotMatch(read(f), ADD, `${f} never adds a remote`);
  }
});

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} passed`);
process.exit(failures ? 1 : 0);
