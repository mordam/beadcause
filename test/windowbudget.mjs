/**
 * One budget for every unattended window on this Mac, not two that cannot see each other.
 *
 * bc-29b3. `advocates.globalMaxWorkers` capped advocate *workers* across every repo;
 * `MAX_LIVE` in lib/resolvers.js capped *resolvers*; and a resolver is the same kind of
 * thing as a worker — a Claude Code session in an iTerm window running this repo's own
 * gate for twelve minutes. So a busy morning was legitimately twenty-two of them, the
 * number that actually mattered to the laptop was the sum, and the sum was enforced by
 * nobody. Two caps that add up to a number written down nowhere.
 *
 * Six claims, and five of them fail silently:
 *
 *   - **an advocate's free slots subtract live resolvers** — `globalFree` is
 *     `globalMaxWorkers - workers - resolvers`. Without it a Mac at its cap opens more
 *     windows and every count on every card still reads as correct;
 *   - **and the card says which windows they are.** "Held by globalMaxWorkers (2)" over
 *     nothing that looks like two live sessions is arithmetic nobody can check, and the
 *     missing windows are not on any advocate's card — they are on the PR board;
 *   - **a sweep yields to a full Mac, and says so in the queue's own words.** This is the
 *     other direction, and it is the one that would have been left half-done: without it
 *     workers give way to resolvers and resolvers take two more whatever else is running;
 *   - **the two sentences are different.** "2 resolvers are already running" and "this Mac
 *     is at its 20-window limit" are cleared by different windows closing, and a queue
 *     that says the first when the second is true sends you to the wrong number;
 *   - **a registry nobody has described still caps at `maxResolvers` on its own** — every
 *     consumer that is not the daemon is in that state, including four other suites;
 *   - **`maxResolvers` is a config key with a ceiling**, because the thing this bead was
 *     filed about is a cap nobody could turn down.
 *
 *     node test/windowbudget.mjs
 *
 * THE ONE THING THAT WOULD MAKE THIS SUITE GREEN FOR THE WRONG REASON is the module
 * instance. lib/advocate.js reaches the registry by importing `./resolvers.js`; if this
 * file's own import resolved to a second copy, every `remember` here would be invisible
 * to the code under test and the subtraction cases would pass by counting zero. The first
 * case asserts the shared instance directly rather than assuming it — `globals().resolvers`
 * has to see what this file wrote — so a future refactor that forks the module fails here
 * with a message about the fork rather than three cases away with a message about a cap.
 *
 * The tick harness is test/claimqueue.mjs's: `open` is injected, so a tick that would have
 * opened an iTerm window pushes a bead id onto an array. No iTerm, no `bd`, no `gh`, no
 * agent, and nothing written outside a temp directory.
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
// the daemon's own config.json and resolvers.json are not this suite's to read or write.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-windowbudget-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const SESSIONS = path.join(tmp, 'claude-sessions');
const REPO = path.join(tmp, 'projects', 'alpha');
for (const d of [SESSIONS, REPO]) fs.mkdirSync(d, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const {
  accountAgainst,
  maxLive,
  pending,
  pump,
  remember,
  reset,
  resolveFor,
  setMaxLive,
  MAX_LIVE,
  MAX_LIVE_CEILING,
} = await import(LIB('resolvers.js'));

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id) => ({ id, title: `do the thing for ${id}`, priority: 2, issue_type: 'task', created_at: OLD });

/** A resolver believed to be running, with a handle — so it is kept on its TTL, not on age. */
const resolving = (number) => remember('beadcause', number, { branch: `worktree-${number}`, term: `iterm-${number}` });

/**
 * One tick, over a tracker that says what the case needs it to.
 *
 * `globalMaxWorkers` is the whole subject, so it is the one knob every case sets. Three
 * per-repo workers so the per-repo cap is never what binds — a case that passed because
 * `maxWorkers` ran out would prove nothing about the global one.
 */
async function tick({ ready = [], globalMaxWorkers = 2 } = {}) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // advocates.json schedules a common-repo commit 2000ms out whose `git init` lands in
  // CONFIG_DIR, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form.
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));

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
      globalMaxWorkers,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Everything with a suite of its own, which would otherwise run real git, a real
      // `gh` or a real agent against a temp directory on every case here.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      holdOpenPrs: false,
      sessionLog: false,
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
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
  });
  await advocates.tick();
  return { opened, advocates, card: advocates.snapshot().find((a) => a.workspace === 'alpha') };
}

/** What the sweep does with one conflicting pull request. No iTerm, no GitHub. */
function hand(state, number, { now = Date.now() } = {}) {
  return resolveFor(
    'beadcause',
    number,
    async () => {
      state.opened.push(number);
      return { dir: `/repo/${number}`, mode: 'acceptEdits', term: `iterm-${number}` };
    },
    { branch: `worktree-${number}`, owner: 'Adam', now, say: async () => 'sent' }
  );
}

/* ------------------------------------------------------------------- harness */

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  // Every case states its own resolvers, its own cap and its own account of the Mac —
  // `reset` puts all three back, which is why it must clear the cap and the hook too.
  reset();
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

console.log('one window budget across workers and resolvers (bc-29b3)');

/* ------------------------------------------- the advocate half: it subtracts */

await check('the advocate and the registry are the same module, so the count is real', async () => {
  resolving(101);
  const { advocates } = await tick({ ready: [bead('bc-1')], globalMaxWorkers: 5 });
  assert.equal(
    advocates.globals().resolvers,
    1,
    'a second copy of lib/resolvers.js would answer 0 here and make every case below pass by counting nothing'
  );
});

await check('two ready beads and no resolvers fill a cap of two', async () => {
  const { opened, card } = await tick({ ready: [bead('bc-1'), bead('bc-2')], globalMaxWorkers: 2 });
  assert.deepEqual(opened, ['bc-1', 'bc-2'], 'the baseline the next two cases are measured against');
  assert.match(card.note, /opening 2 session\(s\)/, card.note);
});

await check('one live resolver takes one of those slots', async () => {
  resolving(101);
  const { opened } = await tick({ ready: [bead('bc-1'), bead('bc-2')], globalMaxWorkers: 2 });
  assert.deepEqual(opened, ['bc-1'], 'the resolver is a window on this Mac, so only one worker fits beside it');
});

await check('two live resolvers fill the cap on their own, and the card says which windows they are', async () => {
  resolving(101);
  resolving(102);
  const { opened, card, advocates } = await tick({ ready: [bead('bc-1'), bead('bc-2')], globalMaxWorkers: 2 });
  assert.deepEqual(opened, [], 'nothing may open — this is the whole of the bead');
  assert.match(card.note, /held by globalMaxWorkers \(2\)/, card.note);
  assert.match(
    card.note,
    /2 of them are sessions resolving pull requests/,
    'without this the note quotes a cap of 2 over zero live sessions, and the two missing windows are on no card at all'
  );
  const g = advocates.globals();
  assert.equal(g.live, 0, 'no worker is open');
  assert.equal(g.resolvers, 2, 'and the console row is told separately, because it adds them itself');
  assert.equal(g.maxWorkers, 2, 'against the one total');
});

await check('one resolver and a cap of one is a held card, not a silent empty queue', async () => {
  resolving(101);
  const { opened, card } = await tick({ ready: [bead('bc-1')], globalMaxWorkers: 1 });
  assert.deepEqual(opened, []);
  assert.match(card.note, /1 of them is a session resolving a pull request/, card.note);
});

/* ------------------------------------ the resolver half: it yields as well */

await check('a Mac with no room queues the sweep rather than opening a window', async () => {
  accountAgainst(() => ({ live: 20, cap: 20 }));
  const state = { opened: [] };
  const out = await hand(state, 115);
  assert.deepEqual(state.opened, [], 'the resolver cap had room — the Mac did not');
  assert.equal(out.queued.number, 115, 'and it is in line rather than refused, because the sweep has nowhere to put a refusal');
  assert.match(out.note, /#115 is 1st in line/, out.note);
  assert.match(
    out.note,
    /this Mac is at its 20-window limit — 20 sessions and 0 resolvers are already open/,
    'the sentence has to name the cap that is actually holding it, or it sends you to the wrong number'
  );
});

await check('and it opens as soon as the Mac has room, without anybody pressing anything', async () => {
  let workers = 20;
  accountAgainst(() => ({ live: workers, cap: 20 }));
  const state = { opened: [] };
  await hand(state, 115);
  assert.deepEqual(state.opened, []);
  await pump({ probe: async () => true });
  assert.deepEqual(state.opened, [], 'still full — the drain must not open on a Mac that has not freed anything');
  workers = 19;
  await pump({ probe: async () => true });
  assert.deepEqual(state.opened, [115], 'a worker finished, so the window it was waiting for opens');
  assert.deepEqual(pending(), [], 'and the queue is empty');
});

await check('the two reasons to wait are two different sentences', async () => {
  accountAgainst(() => ({ live: 0, cap: 20 }));
  const state = { opened: [] };
  await hand(state, 115);
  await hand(state, 116);
  const third = await hand(state, 117);
  assert.deepEqual(state.opened, [115, 116], 'the Mac had room; the resolver cap did not');
  assert.match(third.note, /2 resolvers are already running on this Mac/, third.note);
  assert.doesNotMatch(third.note, /window limit/, 'this one is not the Mac being full, and saying so would be a lie');
});

await check('a registry nobody has described caps on its own, exactly as it did before', async () => {
  // No `accountAgainst` — which is every test in test/resolvers.mjs and test/resolverqueue.mjs,
  // every sweep-card suite, and any consumer of lib/resolvers.js that is not the daemon.
  const state = { opened: [] };
  for (const n of [115, 116, 117]) await hand(state, n);
  assert.deepEqual(state.opened, [115, 116], 'the default cap still binds with no budget to measure against');
  assert.match((await hand(state, 118)).note, /2 resolvers are already running/);
});

await check('a hook that throws caps on what can be counted rather than taking the sweep down', async () => {
  accountAgainst(() => {
    throw new Error('the daemon is mid-reload');
  });
  const state = { opened: [] };
  await hand(state, 115);
  assert.deepEqual(state.opened, [115], 'a broken account of the Mac is not a reason to refuse a conflict');
});

/* --------------------------------------------------- the cap is a config key */

await check('maxResolvers moves the cap, clamped, and nonsense leaves the default alone', async () => {
  assert.equal(MAX_LIVE, 2, 'the shipped default, which the README and the config table both quote');
  assert.equal(maxLive(), 2, 'and it is what a process nobody has configured answers');
  assert.equal(setMaxLive(4), 4);
  const state = { opened: [] };
  for (const n of [115, 116, 117, 118, 119]) await hand(state, n);
  assert.deepEqual(state.opened, [115, 116, 117, 118], 'four, because the config said four');
  assert.equal(setMaxLive(99), MAX_LIVE_CEILING, 'a digit too many clamps rather than being honoured');
  assert.equal(setMaxLive(0), 1, 'and zero would queue every conflict on the Mac for ever');
  assert.equal(setMaxLive('3'), 3, 'a string is what a JSON config hands you when it has been hand-edited');
  assert.equal(setMaxLive(undefined), 3, 'a missing key leaves what is there — Number(null) is 0, and 0 is not a cap anyone meant');
  assert.equal(setMaxLive('lots'), 3, 'nor is nonsense');
});

await check('reset puts the cap and the account of the Mac back, so one case cannot leak into the next', async () => {
  setMaxLive(5);
  accountAgainst(() => ({ live: 99, cap: 1 }));
  reset();
  assert.equal(maxLive(), MAX_LIVE);
  const state = { opened: [] };
  await hand(state, 115);
  assert.deepEqual(state.opened, [115], 'the previous case’s full Mac is not this one’s');
});

/* ----------------------------------------------------- and the daemon wires it */

await check('the daemon is what ties the two together, and it is one line either way', async () => {
  const server = fs.readFileSync(LIB('server.js'), 'utf8');
  assert.match(server, /setMaxLive\(cfg\.advocates\?\.maxResolvers\)/, 'the config key reaches the registry at boot');
  assert.match(
    server,
    /accountAgainst\(\(\) => \{/,
    'and the registry is told what else is open — without this the yielding is one-way and nothing anywhere fails'
  );
  const advocate = fs.readFileSync(LIB('advocate.js'), 'utf8');
  assert.match(
    advocate,
    /globalLimit\(\) - totalWorkers\(\) - totalResolvers\(\)/,
    'the subtraction is the other direction, and it is the one line the whole first half of this suite is about'
  );
  const config = fs.readFileSync(LIB('config.js'), 'utf8');
  assert.match(config, /maxResolvers: 2/, 'a key with no default is a key nobody discovers');
});

await cleanupTmp(tmp);
console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
