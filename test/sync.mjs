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

const { syncOnce, createSyncer, describeSync, isConflict, syncEnabled, syncEveryMs, SYNC_FLOOR_SECONDS } = await import(
  LIB('sync.js')
);

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
  const payload = SERVER.slice(SERVER.indexOf('function inboxPayload('), SERVER.indexOf('function inboxPayload(') + 2500);
  assert.match(payload, /syncTrouble:/, 'its own key');
  assert.doesNotMatch(payload, /mergeTrouble\([^)]*syncer/, 'not folded into the other one');
});

await check('a divergence pushes to the phone, and a conflict pushes harder', () => {
  // ntfy is the one channel that does not depend on you looking at anything.
  assert.match(NOTIFY, /export async function pushSyncTrouble/);
  assert.match(NOTIFY, /export async function pushSyncedAgain/);
  const push = NOTIFY.slice(NOTIFY.indexOf('export async function pushSyncTrouble'), NOTIFY.indexOf('export async function pushSyncedAgain'));
  assert.match(push, /conflicted\.length \? 4 : 3/, 'a conflict outranks a retryable failure');
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
