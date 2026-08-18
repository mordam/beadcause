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

const {
  syncOnce,
  createSyncer,
  describeSync,
  isConflict,
  isStuck,
  syncEnabled,
  syncEveryMs,
  SYNC_FLOOR_SECONDS,
  STUCK_AFTER,
  FLAP_AFTER,
  FLAP_WINDOW_MS,
} = await import(LIB('sync.js'));

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

await check('and it stays stuck — it does not fall back out of it and re-announce every five ticks', async () => {
  // The other half of bc-y3qk.4's complaint, found by replaying a *sustained* outage
  // through the syncer after the flap damping went in and counting more pushes than the
  // flapping case produced.
  //
  // The streak was compared against the state this function had already promoted. The
  // fifth identical `failed` becomes `stuck`; the sixth tick's `failed` then differs from
  // the stored `stuck`, so the count restarted, the word fell back to `failed` — and that
  // is a word change, which is the one thing that always reaches the phone. A workspace
  // failing identically all afternoon buzzed every ten minutes for ever, and told you it
  // had stopped being stuck each time round.
  const s = createSyncer({ bd: fakeBd({ pull: new Error('connection refused') }) });
  let noises = 0;
  for (let i = 0; i < 40; i += 1) noises += (await s.sweep([WS('team')])).changed.length;
  assert.equal(noises, 2, 'the break, and the promotion — and nothing else in forty ticks');
  assert.equal(s.get('team').state, 'stuck', 'and it is still stuck at the end of them');
  assert.equal(s.get('team').streak, 40, 'with a count that never restarted');
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

/* --------------------------------------------------- a tracker that will not settle */

/**
 * `bd` that fails every other tick, and a clock the suite winds by hand.
 *
 * Both halves are necessary and neither is a convenience. The failure has to alternate
 * because the whole complaint is a workspace that never sustains anything — a fake that
 * fails and stays failed exercises the transition rule that already worked. And the
 * clock has to be injectable because the rule is *four inside an hour*: with a real
 * `Date.now()` a suite runs its whole flap in under a millisecond, which proves the
 * counting and proves nothing at all about the window or about settling, and there is no
 * honest way to wait an hour in a test.
 */
const flappyBd = () => {
  let broken = false;
  return fakeBd({
    pull: () => {
      broken = !broken;
      if (broken) throw new Error('connection refused');
    },
  });
};

/** A syncer whose clock the caller owns. `tick` moves it; nothing else does. */
const withClock = (bd) => {
  let at = 1_700_000_000_000;
  const s = createSyncer({ bd, now: () => at });
  return { s, tick: (ms) => { at += ms; }, sweep: (names = ['team']) => s.sweep(names.map(WS)) };
};

await check('the ordinary incident is untouched — one push when it breaks, one when it returns', async () => {
  // The first thing to protect. Damping that quietens a single outage would be a
  // regression dressed as a fix, and this is the case the whole file was built for.
  let broken = true;
  const bd = fakeBd({ pull: () => { if (broken) throw new Error('nope'); } });
  const { s, sweep } = withClock(bd);
  const first = await sweep();
  assert.equal(first.changed[0].transition, 'broke');
  assert.equal(first.changed[0].damped, false, 'the break is said');
  broken = false;
  const back = await sweep();
  assert.equal(back.changed[0].transition, 'recovered');
  assert.equal(back.changed[0].damped, false, 'and so is the return');
  assert.equal(s.get('team').flapping, false, 'two transitions is an incident, not a pattern');
});

await check('a workspace that keeps changing its mind is called flapping, once', async () => {
  // Nine recoveries against ten failures, nineteen pushes, one workspace, one day. The
  // bead is that log.
  const { s, sweep } = withClock(flappyBd());
  const said = [];
  for (let i = 0; i < 12; i += 1) {
    const out = await sweep();
    for (const o of out.changed) said.push(o.flapped ? 'flapping' : o.damped ? null : o.transition);
  }
  const heard = said.filter(Boolean);
  assert.equal(heard.length, FLAP_AFTER, `${FLAP_AFTER} notifications for twelve ticks of alternating`);
  assert.equal(heard.at(-1), 'flapping', 'and the last thing said names the pattern rather than the tick');
  assert.equal(said.filter((x) => x === 'flapping').length, 1, 'said exactly once');
  assert.equal(s.get('team').flapping, true);
});

await check('and then it is quiet, however long it goes on for', async () => {
  const { sweep } = withClock(flappyBd());
  let noises = 0;
  for (let i = 0; i < 200; i += 1) {
    for (const o of (await sweep()).changed) if (!o.damped) noises += 1;
  }
  // Bounded, which is the acceptance criterion read literally: 200 ticks of perfect
  // alternation is ~100 transitions and the phone hears four of them.
  assert.equal(noises, FLAP_AFTER);
});

await check('the transitions are still on the log and still on the monitor', async () => {
  // Damping is a claim about the phone and about nothing else. Three separate passes
  // over this bead worked out what the tracker had been doing by counting `[sync]`
  // lines, and a log with the boring half deleted cannot be counted.
  const { sweep } = withClock(flappyBd());
  let changed = 0;
  for (let i = 0; i < 20; i += 1) changed += (await sweep()).changed.length;
  assert.ok(changed > FLAP_AFTER, 'every transition is still reported as changed');
});

await check('an hour of holding one way and it is trusted again', async () => {
  const bd = flappyBd();
  const { s, tick, sweep } = withClock(bd);
  for (let i = 0; i < 10; i += 1) await sweep();
  assert.equal(s.get('team').flapping, true);

  // Hold. The fake alternates on every *pull*, so the way to make it stop is to stop
  // pulling — which is exactly what an hour of no ticks is.
  tick(FLAP_WINDOW_MS + 1);
  const out = await sweep();
  const [row] = out.results;
  assert.equal(row.flapping, false, 'the transitions have aged out');
  assert.equal(row.settled, true, 'and the tick it happens on says so, once');
  assert.equal((await sweep()).results[0].settled, false, 'only once');
});

await check('a transition after it settles is news again', async () => {
  // The damping is not a fuse. A workspace that misbehaved this morning and is fine now
  // must be able to interrupt you this afternoon.
  const bd = flappyBd();
  const { tick, sweep } = withClock(bd);
  for (let i = 0; i < 10; i += 1) await sweep();
  tick(FLAP_WINDOW_MS + 1);
  await sweep();
  const next = await sweep();
  assert.ok(next.changed.length, 'something moved');
  assert.equal(next.changed[0].damped, false, 'and it was said');
});

await check('a failure that becomes stuck is never damped, however hard it is flapping', async () => {
  // The one sentence that must survive this. `stuck` and `conflict` mean the promise of
  // a retry has stopped being true, and a workspace that will not settle is exactly
  // where somebody most needs to hear it.
  //
  // And this is the case that made the rule a state test rather than a transition test.
  // Under a workspace that is *steadily* failing the word moves with no transition at
  // all, so `transition === null` would have carried it through. A flapping one goes
  // back to `ok` between failures, so the same escalation arrives as an ordinary
  // `broke` — indistinguishable from the blips being damped, unless the state is what
  // is asked about.
  let text = 'connection refused';
  let broken = false;
  const bd = fakeBd({
    pull: () => {
      broken = !broken;
      if (broken) throw new Error(text);
    },
  });
  const { s, sweep } = withClock(bd);
  for (let i = 0; i < 10; i += 1) await sweep();
  assert.equal(s.get('team').flapping, true, 'flapping first, so damping is in force');

  // Now make it fail with the shape that will never clear, two ticks running so it is
  // failing when the word moves rather than mid-alternation.
  text = STOMP;
  let escalation = null;
  for (let i = 0; i < 4 && !escalation; i += 1) {
    escalation = (await sweep()).changed.find((o) => o.state === 'stuck') || null;
  }
  assert.ok(escalation, 'it became stuck');
  assert.equal(escalation.transition, 'broke', 'and it arrives as an ordinary break, because it had just recovered');
  assert.equal(escalation.damped, false, 'and it is said out loud anyway');
  assert.equal(escalation.flapped, false, 'STUCK is said instead of the word flapping, not beside it');
});

await check('a flapping row says so in trouble(), beside the two words it is not', async () => {
  const { s, sweep } = withClock(flappyBd());
  let row = null;
  for (let i = 0; i < 12; i += 1) {
    await sweep();
    row = s.trouble()[0] || row;
  }
  assert.ok(row, 'it is in trouble on the ticks it is failing');
  assert.equal(row.flapping, true);
  assert.equal(row.conflict, false, 'and it is not a conflict');
  assert.ok(row.flaps >= FLAP_AFTER, 'with the count that earned the word');
});

await check('two workspaces flap independently', async () => {
  // One noisy tracker must not damp a quiet one; the counter is per workspace or it is
  // a way of losing the notification that mattered.
  const bd = flappyBd();
  const { s, sweep } = withClock(bd);
  for (let i = 0; i < 12; i += 1) await sweep(['team']);
  assert.equal(s.get('team').flapping, true);
  assert.equal(s.get('other'), null, 'nothing has been recorded about the other one');
  const out = await sweep(['other']);
  assert.equal(out.changed[0]?.damped ?? false, false, 'and its first word is heard');
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
const NEWS = read('lib/news.js');
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

await check('a divergence reaches the phone, and a conflict says it will not clear', () => {
  // It is an event on the bus now rather than an ntfy push (bc-ka5y.15.1): the Android
  // app draws the card, on the one channel this app is allowed to be insistent about.
  // What was checked of the push is checked of the event, because the argument did not
  // move — only the wire did.
  assert.match(NEWS, /export function syncStuckEvent/);
  assert.match(NEWS, /export function syncClearEvent/);
  const push = NEWS.slice(NEWS.indexOf('export function syncStuckEvent'), NEWS.indexOf('export function syncClearEvent'));
  // A conflict and a stuck sync both need a person at a keyboard; a retryable failure
  // does not. The two loud ones keep separate titles, because they are different jobs:
  // one is a decision about whose write wins, the other is a command to type.
  assert.match(push, /tracker CONFLICT/, 'a conflict says so in the title');
  assert.match(push, /tracker STUCK/, 'a stuck tracker says so in the title');
  assert.match(push, /quiet: false/, 'and a muted space cannot silence it — this is the class that may insist');
  // The state, so the card can be taken away again. A blockage is the only kind of
  // arrival here that stops being true, and `syncClearEvent` is the half that says so.
  assert.match(push, /state: 'stuck'/, 'it is a state rather than an arrival');
  const clear = NEWS.slice(NEWS.indexOf('export function syncClearEvent'), NEWS.indexOf('export function syncLines'));
  assert.match(clear, /state: 'clear'/, 'and the recovery is the same event saying it ended');
  assert.match(clear, /key: 'stuck\/sync'/, 'under the same key, which is what cancels the card');
  const lines = NEWS.slice(NEWS.indexOf('export function syncLines'));
  assert.match(lines, /will not clear on its own/, 'and the body does not promise a retry');
  // The fix it prints has to be a directory that exists. A workspace is not necessarily
  // under `~/beads` — Climative's lives inside the `architecture` checkout — so the path
  // comes off the workspace, and a suggested `cd` into somewhere invented is the fastest
  // way to teach somebody that this notification is not to be trusted.
  assert.match(lines, /cd \$\{r\.dir\}/, 'the workspace says where it is');
  assert.doesNotMatch(lines, /~\/beads\//, 'and nothing here assumes a layout');
});

await check('and a tracker that will not settle reaches it as a third thing, on the same card', () => {
  // Its own event because it is told *instead of* the incidents rather than about one,
  // and so it has to carry the count and say that the silence after it is deliberate.
  assert.match(NEWS, /export function syncFlappingEvent/);
  const flap = NEWS.slice(NEWS.indexOf('export function syncFlappingEvent'), NEWS.indexOf('export function syncStuckEvent'));
  assert.match(flap, /tracker FLAPPING/, 'it says which of the three this is');
  assert.match(flap, /key: 'stuck\/sync'/, 'on the one card the tracker gets, replacing whatever was on it');
  assert.match(flap, /state: 'stuck'/, 'and the card stays up — a flapping tracker is not in sync in any usable sense');
  assert.match(flap, /quiet: false/, 'a muted space cannot silence this class either');
  assert.match(flap, /transitions in the last hour/, 'with the count that earned the word');
});

await check('the poll cycle damps the phone and nothing above it', () => {
  const from = SERVER.indexOf('const sweepSync = async () => {');
  const sweep = SERVER.slice(from, SERVER.indexOf('let jiraSweptAt'));
  assert.ok(sweep.length > 400, 'the slice still finds sweepSync');
  // The filters, which are the fix. A damped transition reaches neither push.
  assert.match(sweep, /const broke = out\.changed\.filter\(\s*\(o\) =>\s*!o\.damped/, 'a damped break is not pushed');
  assert.match(sweep, /const recovered = out\.changed\.filter\(\(o\) => !o\.damped/, 'nor a damped recovery');
  assert.match(sweep, /bus\.emit\(\s*syncFlappingEvent\(/, 'and the pattern is pushed once instead');
  // All three name the same card key, so on a tick where one workspace starts flapping
  // and another goes stuck, whichever is emitted last is the one left on the screen.
  assert.ok(
    sweep.indexOf('syncFlappingEvent(') < sweep.indexOf('syncStuckEvent('),
    'and STUCK is emitted after it, so it wins the card'
  );
  // Off `results`, because settling is the absence of a transition and so happens on a
  // tick where nothing changed. Reading `changed` for it would mean it never fired.
  assert.match(sweep, /\(out\.results \|\| \[\]\)\.filter\(\(o\) => o\.settled/, 'the settle is read off every result');
  // The log is not damped, and this is the half worth pinning: it is the only record of
  // what the tracker was doing, and three passes over this bead were made by counting it.
  assert.match(sweep, /flapping — not notified/, 'the log keeps the transition and notes the phone was spared');
  assert.match(sweep, /for \(const o of out\.changed\) \{/, 'and still logs every one of them');
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
