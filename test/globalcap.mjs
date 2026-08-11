#!/usr/bin/env node
/**
 * The global session cap moving from 10 to 20 on a machine that already has a config.
 *
 *   npm test
 *   node test/globalcap.mjs
 *
 * Changing the number in `defaults()` fixes nothing here, and that is the whole reason
 * this file exists. `loadConfig` merges the stored config *over* the defaults, so every
 * install that has ever run beadcause has `"globalMaxWorkers": 10` written down and
 * would go on being capped at 10 while the source said 20 — a default that reaches new
 * machines only is a default nobody on an old machine can see, and this is the cap that
 * binds first on a busy day.
 *
 * So it moves once, the way `moveSquashDefault` moves the merge method, and the three
 * things worth asserting are the three ways that shape goes wrong:
 *
 * 1. **Moved in memory but not on disk** — this process is right and the next one is
 *    back to 10, forever, with nothing anywhere saying why.
 * 2. **Moved every time** — then a deliberate 10, set after the move, is overwritten on
 *    the next daemon start, and a setting you cannot set is not a setting.
 * 3. **Moved silently** — a cap that changes itself and says nothing is indistinguishable
 *    from a bug the next time somebody counts the windows on their Mac.
 *
 * The stepper that writes the same key from the console is covered in test/workers.mjs.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-globalcap-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const CONFIG = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
const STATE = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'state.json');

const { moveGlobalWorkersDefault, loadConfig, loadState } = await import('../lib/config.js');

let failures = 0;
let ran = 0;
const check = (name, fn) => {
  ran += 1;
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 6).join('\n       ')}`);
  }
};

/** A hand-kept config, the shape somebody actually has on disk — not a defaults dump. */
const store = (advocates) => {
  fs.writeFileSync(
    CONFIG,
    JSON.stringify({ token: 'x', workspaces: [], advocates }, null, 2)
  );
  fs.rmSync(STATE, { force: true });
};
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG, 'utf8'));

console.log('\nthe global session cap, moved once\n');

check('a stored 10 becomes 20, in memory and in the file', () => {
  store({ workspaces: ['alpha'], globalMaxWorkers: 10 });
  const said = moveGlobalWorkersDefault({ advocates: { globalMaxWorkers: 10 } });
  assert.ok(/10\s*→\s*20/.test(said), `it says what it did — ${said}`);
  assert.equal(onDisk().advocates.globalMaxWorkers, 20, 'this is failure 1');
  assert.equal(loadState().globalWorkersDefaultMoved, true, 'and it is a migration, not a policy');
});

check('and the file it wrote is still the hand-kept one, not a dump of every default', () => {
  store({ workspaces: ['alpha'], globalMaxWorkers: 10 });
  moveGlobalWorkersDefault({ advocates: { globalMaxWorkers: 10 } });
  const raw = onDisk();
  assert.deepEqual(Object.keys(raw), ['token', 'workspaces', 'advocates'], 'nothing else was added');
  assert.deepEqual(Object.keys(raw.advocates), ['workspaces', 'globalMaxWorkers'], 'nor inside the block');
});

check('a 10 set back afterwards is left alone — this is failure 2', () => {
  store({ globalMaxWorkers: 10 });
  moveGlobalWorkersDefault({ advocates: { globalMaxWorkers: 10 } });
  const deliberate = { advocates: { globalMaxWorkers: 10 } };
  assert.equal(moveGlobalWorkersDefault(deliberate), '', 'the flag is spent');
  assert.equal(deliberate.advocates.globalMaxWorkers, 10, 'and the number you chose stands');
});

check('nothing else is touched: 20, 4, or no advocates block at all', () => {
  store({ globalMaxWorkers: 10 });
  fs.rmSync(STATE, { force: true });
  assert.equal(moveGlobalWorkersDefault({ advocates: { globalMaxWorkers: 20 } }), '');
  assert.equal(moveGlobalWorkersDefault({ advocates: { globalMaxWorkers: 4 } }), '');
  assert.equal(moveGlobalWorkersDefault({}), '', 'a config with no advocates block is not a crash');
  assert.equal(loadState().globalWorkersDefaultMoved, undefined, 'and none of those spent the flag');
});

check('the real loadConfig does it, which is the only path that runs in anger', () => {
  store({ workspaces: [], globalMaxWorkers: 10 });
  const cfg = loadConfig();
  assert.equal(cfg.advocates.globalMaxWorkers, 20, 'the daemon that just started is on 20');
  assert.equal(onDisk().advocates.globalMaxWorkers, 20, 'and so is the one that starts next');
  // Twice, because a `beadcause-ask` and the daemon both call this on the same file.
  const again = loadConfig();
  assert.equal(again.advocates.globalMaxWorkers, 20);
});

check('a fresh install gets 20 without any of this', () => {
  fs.rmSync(CONFIG, { force: true });
  fs.rmSync(STATE, { force: true });
  const cfg = loadConfig();
  assert.equal(cfg.advocates.globalMaxWorkers, 20, 'straight from defaults()');
  assert.equal(loadState().globalWorkersDefaultMoved, undefined, 'nothing was migrated');
});

/* ================================================================ the console half

   Source assertions, in the shape test/service.mjs uses for the health lines: there is
   no DOM here, and what these pin is the wiring rather than the pixels. Each one is a
   way the control could be shipped looking finished and be inert. */

const ROOT = new URL('..', import.meta.url).pathname;
const page = fs.readFileSync(path.join(ROOT, 'public', 'monitor.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');

check('the console draws the global row from the payload, not from a card', () => {
  assert.match(page, /globalHtml\(data\.globals/, 'the row is fed the field the daemon sends');
  assert.match(page, /data-adv="globalLimit"/, 'and its buttons post the action the server reads');
});

check('and it is disabled while observing, like every other setting on that page', () => {
  // An observer loads the live daemon's config file, so a press here would change how
  // many windows the *other* process opens after its next restart.
  const guard = page.slice(page.indexOf('if (data.observing) {'));
  assert.match(guard.slice(0, 400), /\[data-adv="globalLimit"\]/);
});

check('the row is actually styled, rather than inheriting a health line', () => {
  assert.ok(css.includes('.svc-set'), 'no .svc-set in public/style.css');
});

/* ============================================================== the server half

   The press itself, against the real `createApp` rather than a fake. The thing worth
   proving here is the one that is invisible in the diff: `globalMaxWorkers` belongs to
   no repo, so the request carries no workspace — and POST /api/advocate has always
   404'd anything it cannot find an advocate for. Read the action second and the only
   control on the page for the cap that binds first answers "no advocate for (none
   given)" forever. */

const http = await import('node:http');
const net = await import('node:net');
const { createApp, listen } = await import('../lib/server.js');

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

// The one object the whole process holds — what the endpoint mutates is this.
const live = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  port,
  token: 'global-cap-token',
  actor: 'beadcause-test',
  workspaces: [],
  // A `bd` that cannot exist: nothing this endpoint does may sweep a tracker.
  bdBin: path.join(tmp, 'no-such-bd'),
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: true, workspaces: [], globalMaxWorkers: 5, propose: false },
};
const app = createApp(live);
const servers = listen(live, app.handler);

const call = (pathname, body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
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
    req.write(JSON.stringify(body));
    req.end();
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await call('/api/health', {});
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const stepped = await call('/api/advocate', { action: 'globalLimit', value: 9 });
check('a press with no workspace is the global cap, not a 404', () => {
  assert.equal(stepped.status, 200, JSON.stringify(stepped.body));
  assert.equal(stepped.body.globals.maxWorkers, 9, 'the reply carries what is now in force');
  assert.equal(live.advocates.globalMaxWorkers, 9, 'on the object the daemon is holding');
  assert.equal(onDisk().advocates.globalMaxWorkers, 9, 'and in the file the next start reads');
});

const clamped = await call('/api/advocate', { action: 'globalLimit', value: 500 });
check('out of range comes back as the number in force, so the page repaints the truth', () => {
  assert.equal(clamped.status, 200);
  assert.equal(clamped.body.globals.maxWorkers, 36);
  assert.equal(clamped.body.globals.ceiling, 36, 'and the range the stepper may offer');
});

const empty = await call('/api/advocate', { action: 'globalLimit' });
check('a press that forgot its number is a 400, not a Mac capped at one session', () => {
  assert.equal(empty.status, 400);
  assert.match(empty.body.error, /needs a number/);
  assert.equal(live.advocates.globalMaxWorkers, 36, 'unchanged');
});

const stranger = await call('/api/advocate', { action: 'limit', workspace: 'nope', value: 2 });
check('and every other action still has to name an advocate that exists', () => {
  assert.equal(stranger.status, 404, 'the workspace check was moved, not removed');
});

servers.forEach((s) => s.close());
// Every config write schedules a debounced commit into the common repo. Left pending,
// one fires two seconds later against a directory this file has just deleted and prints
// a failure that has nothing to do with anything asserted here. `flush` takes the
// scheduled one; the settle is for a commit already in flight when it was called, which
// `flush` replaces rather than waits for.
await (await import('../lib/commonrepo.js')).flush();
await new Promise((r) => setTimeout(r, 500));

console.log(`\n${ran - failures}/${ran} passed\n`);
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) process.exit(1);
