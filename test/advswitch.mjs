#!/usr/bin/env node
/**
 * Turning a repo's advocate on and off from the console.
 *
 *   npm test
 *   node test/advswitch.mjs
 *
 * `advocates.workspaces` is an explicit opt-in list and until now the only ways into it
 * were an editor and `npm run configure`, both followed by a restart, because the daemon
 * reads the list once at boot. Giving climative an advocate on 2026-08-11 took a node
 * script plus `npm run swap`, and nothing on the console said the setting existed.
 *
 * A switch for it can be shipped looking finished and be wrong in six ways, which is
 * what this file is a list of:
 *
 * 1. **Written but not live.** The config gains the repo and the running daemon does
 *    not, so the switch appears to do nothing until something unrelated restarts it —
 *    which is the exact state the bead was filed about, now with a button on it.
 * 2. **Live but not written.** The advocate ticks until the next `launchctl kickstart`
 *    and then is gone, having opened windows for a day over a setting nobody stored.
 * 3. **Refused before it starts.** `POST /api/advocate` has always 404'd anything it
 *    could not find an advocate for, and `enable` is the one action whose whole purpose
 *    is to name a repo that has none. Read the workspace before the action and the
 *    switch answers "no advocate for climative" forever.
 * 4. **Off means killed.** An advocate is the only record of the iTerm windows it
 *    opened — which bead each is on, when to ask it to check in, when its bead closed
 *    and the window may be signalled. Dropping that record while sessions are running
 *    leaves live windows with nobody watching them.
 * 5. **A switch that writes a setting and changes nothing.** Three settings can make
 *    this control a lie — `advocates.enabled: false`, `workspaces: "*"`, and a space's
 *    own `advocate: false` — and none of them is visible from the page. The switch has
 *    to be refused, and the reason has to reach the console, or you come back an hour
 *    later to a repo that is switched on and has never ticked.
 * 6. **An observer arranging work for the daemon that acts.** An observer holds the
 *    real daemon's config file, so a press there would hand the *other* process a repo
 *    to open windows on.
 *
 * No iTerm and no `bd`: `createAdvocates` is called directly, the config it writes is
 * read back off disk the way a restart reads it, and the server half runs against the
 * real `createApp`. Only the observer case needs a child process, because `OBSERVING`
 * is read once at module load.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
// Not a bare `fs.rmSync`: both teardowns here run immediately before `process.exit`, so
// they cannot await, and the tree they are taking away is a scratch CONFIG_DIR the
// common repo may still be committing into. See test/helpers/tmp.mjs.
import { removeTreeSync, quiesce, removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);
const ROOT = path.join(HERE, '..');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-advswitch-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own config.json is not this suite's to write.
process.env.BEADCAUSE_CONFIG_DIR = process.env.BEADCAUSE_CONFIG_DIR || path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const CONFIG = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
const STATE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'advocates.json');

/* ===================================================================== observing

   Failure 6, and it is first because it needs a process of its own: `OBSERVING` is read
   once, at module load, so the refusal cannot be asserted in the same process as
   anything that expects the switch to work. The parent spawns this file again with the
   flag set and reads the exit code; this branch is the whole of that child. */

if (process.env.BEADCAUSE_ADVSWITCH_CHILD) {
  const { OBSERVING } = await import(LIB('config.js'));
  assert.equal(OBSERVING, true, 'this case must run with the flag on');
  const { createApp, listen } = await import(LIB('server.js'));
  const cfg = {
    host: '127.0.0.1',
    port: 0,
    token: 'observer-token',
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') }],
    claudeSessions: false,
    openSessions: false,
    ntfy: { enabled: false },
    advocates: { enabled: true, workspaces: [], propose: false },
  };
  const servers = listen(cfg, createApp(cfg).handler);
  const port = await boundPort(servers);
  try {
    for (const action of ['enable', 'disable']) {
      const res = await fetch(`http://127.0.0.1:${port}/api/advocate`, {
        method: 'POST',
        headers: { 'x-beadcause-token': cfg.token, 'content-type': 'application/json' },
        body: JSON.stringify({ action, workspace: 'alpha' }),
      });
      assert.equal(res.status, 403, `${action} must be refused on an observer`);
      assert.match((await res.json()).error, /observing/, 'and it must say why');
    }
    assert.deepEqual(cfg.advocates.workspaces, [], 'and the config in memory is untouched');
  } finally {
    for (const s of servers) s.close();
  }
  removeTreeSync(tmp);
  process.exit(0);
}

const { createAdvocates, advocatedWorkspaces, saveAdvocated, switchBlocked, options } = await import(
  LIB('advocate.js')
);

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
    console.log(`       ${String(err && err.message ? err.message : err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

/* ------------------------------------------------------------------ fixtures */

const OLD = '2020-01-01T00:00:00Z';
const bead = (id, over = {}) => ({ id, title: id, priority: 2, issue_type: 'task', created_at: OLD, ...over });

/** Two workspaces, one advocated: the shape the switch exists to move a repo between. */
const baseConfig = () => ({
  projectRoot: path.join(tmp, 'projects'),
  claudeSessionsDir: path.join(tmp, 'claude-sessions'),
  spaces: [],
  workspaces: [
    { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') },
    { name: 'beta', dir: path.join(tmp, 'beta', '.beads') },
  ],
  advocates: {
    enabled: true,
    workspaces: ['alpha'],
    maxWorkers: 2,
    settleSeconds: 0,
    launchCooldownSeconds: 0,
    // Every other feature with a suite of its own: each would otherwise run real git,
    // a real agent or a `gh` call against a temp directory on every tick here.
    propose: false,
    sessionLog: false,
    tidyWorktrees: false,
    respectQuietHours: false,
    reconcileLanded: false,
    askSuperseded: false,
    flagInMain: false,
  },
});

/**
 * Advocates over a fresh config on disk, the way the daemon comes up.
 *
 * `ready` is what the tracker says; `opened` is every window that would have been
 * opened, which is the assertion a disable has to survive.
 *
 * **Async, and quiesces before it wipes.** This reset runs between almost every check,
 * and every `enable`/`disable`/`tick`/`control` in the check before it may have called
 * `saveState()`, which schedules a debounced commit into the common repo
 * (lib/commonrepo.js) — a real `git init`/`commit` child process, landing up to 2000ms
 * later, in this same `BEADCAUSE_CONFIG_DIR`. A bare `fs.rmSync` here raced exactly that
 * child: this suite is the one `git init` mid-write in `.git/hooks` was caught by
 * (bc-beleq.1), because unlike the harness's *own* teardown at the bottom of the file, this
 * reset never flushed the pending commit or retried the removal — see the two-halves note
 * in test/helpers/tmp.mjs. `quiesce()` forces that commit to run now and waits for it, so
 * there is no writer left when we delete; `removeTree` is the retrying backstop for
 * anything quiesce does not know about, same as the final teardown already gets.
 */
async function harness({ advocates: adv = {}, ready = [], workers = [], ...overrides } = {}) {
  await quiesce();
  for (const f of fs.readdirSync(process.env.BEADCAUSE_CONFIG_DIR)) {
    await removeTree(path.join(process.env.BEADCAUSE_CONFIG_DIR, f));
  }
  const cfg = { ...baseConfig(), ...overrides, advocates: { ...baseConfig().advocates, ...adv } };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2));
  if (workers.length) fs.writeFileSync(STATE, JSON.stringify({ alpha: { workers, attempts: {} } }));
  const opened = [];
  const events = [];
  const advocates = createAdvocates(cfg, {
    bd: {
      // Keyed by workspace — `a-1` is alpha's, `b-1` is beta's. One fake tracker
      // answering every advocate the same way would have alpha opening beta's beads,
      // and "nothing opened while it was off" is the assertion that would then fail
      // for a reason that has nothing to do with the switch.
      ready: async (ws) => ready.filter((b) => b.id.startsWith(ws.name === 'beta' ? 'b-' : 'a-')),
      listLabel: async () => [],
      // An open bead for every worker: `reconcile` retires a worker whose bead it
      // cannot find, which would drain a "still running" case before it was looked at.
      show: async (_ws, id) => ({ id, title: id, status: 'open' }),
      children: async () => [],
    },
    bus: { emit: (e) => events.push(e) },
    open: async (_cfg, _ws, b) => {
      opened.push(b.id);
      return { dir: tmp, mode: 'test', term: null };
    },
  });
  return { advocates, cfg, opened, events };
}

const onDisk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
const card = (advocates, name) => advocates.snapshot().find((a) => a.workspace === name);
const row = (advocates, name) => advocates.roster().find((r) => r.workspace === name);
/** The restart: the process that pressed the button is gone, and the file has to say it. */
const afterRestart = () => createAdvocates(onDisk(), { bd: {}, bus: { emit: () => {} } });

/* =================================================================== the switch */

console.log('\nan advocate switched on and off from the console\n');

await check('switching one on gives it an advocate now, and after a restart', async () => {
  const { advocates, cfg } = await harness();
  assert.equal(card(advocates, 'beta'), undefined, 'beta starts with none — that is the setting');

  advocates.enable('beta');

  assert.ok(card(advocates, 'beta'), 'failure 1: the running daemon has one');
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha', 'beta'], 'failure 2: and so does the file');
  assert.equal(cfg.advocates.workspaces.includes('beta'), true, 'on the object the daemon is holding');
  assert.ok(card(afterRestart(), 'beta'), 'and the daemon that starts next');
});

await check('and it ticks: the switch is what stood between this repo and a session', async () => {
  const { advocates, opened } = await harness({ ready: [bead('b-1')] });
  await advocates.tick();
  assert.deepEqual(opened, [], 'beta is off, so nothing opened on its queue');

  advocates.enable('beta');
  await advocates.tick();
  assert.deepEqual(opened, ['b-1'], 'and now it is picked up — no restart in between');
});

await check('switching one off with nothing running takes it away at once', async () => {
  const { advocates } = await harness();
  advocates.disable('alpha');
  assert.equal(card(advocates, 'alpha'), undefined, 'the card is gone');
  assert.deepEqual(onDisk().advocates.workspaces, [], 'and the list it was in');
  assert.equal(card(afterRestart(), 'alpha'), undefined, 'including for the next start');
});

await check('switching one off with sessions open drains — failure 4, the one that hurts', async () => {
  const worker = { id: 'a-1', title: 'still working', at: new Date().toISOString(), attempt: 1 };
  const { advocates, opened } = await harness({ ready: [bead('a-2')], workers: [worker] });

  advocates.disable('alpha');
  const drained = card(advocates, 'alpha');
  assert.ok(drained, 'the advocate is still here, because its windows are');
  assert.equal(drained.draining, true, 'and says so, so the card can');
  assert.deepEqual(
    drained.workers.map((w) => w.id),
    ['a-1'],
    'the running session is untouched — not signalled, not forgotten'
  );
  assert.deepEqual(onDisk().advocates.workspaces, [], 'the setting is off from the moment you press');

  await advocates.tick();
  assert.deepEqual(opened, [], 'and nothing new is launched, with a ready bead sitting there');
  assert.equal(card(advocates, 'alpha').queue, 0, 'nor is its queue still being surveyed');
  assert.match(card(advocates, 'alpha').note, /switched off/, 'and the card says which of the two it is');
});

await check('and it goes on the first tick that finds it empty', async () => {
  const worker = { id: 'a-1', title: 'still working', at: new Date().toISOString(), attempt: 1 };
  const { advocates } = await harness({ workers: [worker] });
  advocates.disable('alpha');
  await advocates.tick();
  assert.ok(card(advocates, 'alpha'), 'still draining, and still written down');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(STATE, 'utf8')).alpha.workers.map((w) => w.id),
    ['a-1'],
    'a restart mid-drain still knows which windows are open'
  );

  // The session ends the way every session ends: its bead goes, `reconcile` retires the
  // worker, and this is the tick that finds nothing left to wait for.
  await advocates.control('alpha', 'reclaim');
  await advocates.tick();
  assert.equal(card(advocates, 'alpha'), undefined, 'nothing left to drain, nothing left of it');
  assert.equal(JSON.parse(fs.readFileSync(STATE, 'utf8')).alpha, undefined, 'nor in the file');
});

await check('switching a draining one back on takes the drain off', async () => {
  const worker = { id: 'a-1', title: 'still working', at: new Date().toISOString(), attempt: 1 };
  const { advocates, opened } = await harness({ ready: [bead('a-2')], workers: [worker] });
  advocates.disable('alpha');
  advocates.enable('alpha');

  assert.equal(card(advocates, 'alpha').draining, false, 'it is an advocate again');
  assert.deepEqual(
    card(advocates, 'alpha').workers.map((w) => w.id),
    ['a-1'],
    'holding the same session it never let go of'
  );
  await advocates.tick();
  assert.deepEqual(opened, ['a-2'], 'and surveying again');
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha'], 'with the setting back where it was');
});

await check('pressing on over an advocate that has one is a repaint, not an error', async () => {
  const { advocates } = await harness();
  advocates.enable('alpha');
  advocates.enable('alpha');
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha'], 'and never a second copy in the list');
});

await check('a repo that is not configured at all is a 404, not a new list entry', async () => {
  const { advocates } = await harness();
  assert.throws(() => advocates.enable('gamma'), (err) => err.status === 404);
  assert.throws(() => advocates.disable('gamma'), (err) => err.status === 404);
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha'], 'nothing was written');
});

/* ============================================================ what refuses, and why

   Failure 5. Each of these three would leave a repo switched on in the file and with no
   advocate anywhere, and the console cannot see any of them — so the daemon refuses the
   write and says which it was. */

await check('a space with advocate: false vetoes the switch, and keeps vetoing it', async () => {
  const { advocates, cfg } = await harness({ spaces: [{ name: 'Halifax', workspaces: ['beta'], advocate: false }] });
  assert.throws(() => advocates.enable('beta'), (err) => err.status === 409 && /Halifax/.test(err.message));
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha'], 'the list is untouched');
  assert.equal(row(advocates, 'beta').can, false, 'and the console is told not to draw a switch');
  assert.match(row(advocates, 'beta').why, /advocate: false/);

  // And the veto still wins over a list written by hand, which is the acceptance
  // criterion: whatever the switch says, a vetoed space has no advocate.
  cfg.advocates.workspaces = ['alpha', 'beta'];
  assert.deepEqual(advocatedWorkspaces(cfg).map((w) => w.name), ['alpha']);
});

await check('the master switch off refuses it — a list nothing reads is not a setting', async () => {
  const { advocates } = await harness({ advocates: { enabled: false } });
  assert.throws(() => advocates.enable('beta'), (err) => err.status === 409 && /advocates\.enabled/.test(err.message));
  assert.equal(row(advocates, 'beta').can, false);
});

await check('"*" refuses it rather than being expanded into a frozen list', async () => {
  // Expanding the star would make one Off button work and silently stop every repo
  // added afterwards from getting an advocate — which is the one thing "*" says.
  const { advocates } = await harness({ advocates: { workspaces: '*' } });
  assert.throws(() => advocates.disable('alpha'), (err) => err.status === 409 && /"\*"/.test(err.message));
  assert.equal(onDisk().advocates.workspaces, '*', 'still the star it was written as');
  assert.equal(row(advocates, 'alpha').can, false);
  assert.equal(row(advocates, 'alpha').advocated, true, 'and it does have one — that is why');
});

await check('the roster is every configured workspace, whether or not it has one', async () => {
  const { advocates } = await harness();
  assert.deepEqual(advocates.roster().map((r) => [r.workspace, r.advocated, r.can]), [
    ['alpha', true, true],
    ['beta', false, true],
  ]);
  assert.equal(row(advocates, 'alpha').why, '', 'no reason where there is nothing to explain');
});

await check('the list is rewritten, never pushed onto — a shared default is not one repo`s', async () => {
  // `options()` spreads DEFAULTS, so a config with no `workspaces` key hands back the
  // module-level array. Push onto that and every later reader in the process — including
  // one holding a different config object — gets a workspace nobody asked for.
  const one = { workspaces: [{ name: 'alpha', dir: tmp }], advocates: { enabled: true } };
  saveAdvocated(one, 'alpha', true);
  assert.deepEqual(one.advocates.workspaces, ['alpha']);
  const two = { workspaces: [{ name: 'beta', dir: tmp }], advocates: { enabled: true } };
  assert.deepEqual(options(two).workspaces, [], 'the defaults were not written into');
  assert.equal(switchBlocked(two, 'beta'), '', 'and beta is still switchable');
});

/* ================================================================ the console half

   Source assertions, the shape test/globalcap.mjs uses for the global row: there is no
   DOM here, and what these pin is the wiring. Each is a way the switch could be shipped
   looking finished and be inert. */

const page = fs.readFileSync(path.join(ROOT, 'public', 'monitor.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

await check('the console draws the switch from the roster the daemon sends', async () => {
  assert.match(page, /data\.roster/, 'the roster is read off the payload');
  assert.match(page, /data-adv="enable"/, 'and its button posts the action the server reads');
  assert.match(page, /data-adv="disable"/);
  assert.match(page, /function plainCard\(w, r\)/, 'a repo with no advocate is where the On switch lives');
});

await check('and both are refused on an observer, like every other setting on that page', async () => {
  const guard = page.slice(page.indexOf('if (data.observing) {'));
  assert.match(guard.slice(0, 500), /\[data-adv="enable"\]/);
  assert.match(guard.slice(0, 500), /\[data-adv="disable"\]/);
});

await check('the reason a switch is not drawn is styled, rather than being invisible text', async () => {
  assert.ok(css.includes('.adv-why'), 'no .adv-why in public/style.css');
});

/* ================================================================= the server half

   Failure 3, which is invisible in the diff: `enable` is the one action that must reach
   a workspace with no advocate, and this endpoint has always looked one up first. */

const http = await import('node:http');
const { createApp, listen } = await import(LIB('server.js'));

const live = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  port: 0,
  token: 'adv-switch-token',
  actor: 'beadcause-test',
  spaces: [{ name: 'Halifax', workspaces: ['gamma'], advocate: false }],
  workspaces: [
    { name: 'alpha', dir: path.join(tmp, 'alpha', '.beads') },
    { name: 'beta', dir: path.join(tmp, 'beta', '.beads') },
    { name: 'gamma', dir: path.join(tmp, 'gamma', '.beads') },
  ],
  // A `bd` that cannot exist: nothing this endpoint does may sweep a tracker.
  bdBin: path.join(tmp, 'no-such-bd'),
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: true, workspaces: ['alpha'], propose: false },
};
fs.writeFileSync(CONFIG, JSON.stringify(live, null, 2));
const app = createApp(live);
const servers = listen(live, app.handler);
const port = await boundPort(servers);
live.port = port;

const call = (pathname, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: body ? 'POST' : 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': live.token },
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out ? JSON.parse(out) : null }));
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });

const on = await call('/api/advocate', { action: 'enable', workspace: 'beta' });
await check('a press on a repo with no advocate is the switch, not "no advocate for beta"', async () => {
  assert.equal(on.status, 200, JSON.stringify(on.body));
  assert.ok(
    on.body.advocates.some((a) => a.workspace === 'beta'),
    'and the reply carries the advocate that now exists'
  );
  assert.ok(on.body.roster.find((r) => r.workspace === 'beta')?.advocated, 'and the roster the switch is drawn from');
  assert.deepEqual(live.advocates.workspaces, ['alpha', 'beta'], 'on the object the daemon is holding');
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha', 'beta'], 'and in the file the next start reads');
});

const off = await call('/api/advocate', { action: 'disable', workspace: 'beta' });
await check('and pressing it again takes it away', async () => {
  assert.equal(off.status, 200, JSON.stringify(off.body));
  assert.ok(!off.body.advocates.some((a) => a.workspace === 'beta'));
  assert.deepEqual(onDisk().advocates.workspaces, ['alpha']);
});

const vetoed = await call('/api/advocate', { action: 'enable', workspace: 'gamma' });
await check('a vetoed space answers with the reason, not with a setting nothing reads', async () => {
  assert.equal(vetoed.status, 409, JSON.stringify(vetoed.body));
  assert.match(vetoed.body.error, /Halifax/);
  assert.deepEqual(live.advocates.workspaces, ['alpha'], 'and wrote nothing');
});

const nobody = await call('/api/advocate', { action: 'enable', workspace: 'nope' });
await check('a workspace that does not exist is still a 404', async () => {
  assert.equal(nobody.status, 404);
});

const stranger = await call('/api/advocate', { action: 'limit', workspace: 'nope', value: 2 });
await check('and every other action still has to name an advocate that exists', async () => {
  assert.equal(stranger.status, 404, 'the workspace check was moved past, not removed');
});

const work = await call('/api/work');
await check('/api/work carries a row per configured workspace, which is what the page draws', async () => {
  assert.equal(work.status, 200);
  assert.deepEqual(
    work.body.roster.map((r) => r.workspace),
    ['alpha', 'beta', 'gamma']
  );
  assert.equal(work.body.roster.find((r) => r.workspace === 'gamma').can, false, 'with the veto said out loud');
});

servers.forEach((s) => s.close());

/* The child described at the top of this file, and the one thing it proves: an observer
   holds the *real* daemon's config file, so a press there would hand the other process a
   repo to open windows on. Its own config dir, because it writes one. */
const observerDir = path.join(tmp, 'observer');
fs.mkdirSync(observerDir, { recursive: true });
const { spawnSync } = await import('node:child_process');
const child = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], {
  env: {
    ...process.env,
    BEADCAUSE_OBSERVE: '1',
    BEADCAUSE_CONFIG_DIR: observerDir,
    BEADCAUSE_ADVSWITCH_CHILD: '1',
  },
  encoding: 'utf8',
});
await check('an observer refuses both — it must not arrange work for the daemon that acts', async () => {
  assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
});

// Every config write schedules a debounced commit into the common repo. Left pending,
// one fires two seconds later against a directory this file has just deleted.
await (await import(LIB('commonrepo.js'))).flush();
await new Promise((r) => setTimeout(r, 300));

console.log(`\n${ran - failures}/${ran} passed\n`);
removeTreeSync(tmp);
process.exit(failures ? 1 : 0);
