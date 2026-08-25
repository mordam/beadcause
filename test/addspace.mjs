#!/usr/bin/env node
/**
 * ＋ Add a bead-space — the route, its two rounds, and what it leaves behind.
 *
 *     npm test
 *     node test/addspace.mjs
 *
 * `test/newspace.mjs` covers the module under it: every refusal, every config write, in
 * isolation and without a server. What is left, and what this file is for, is the part
 * only the route can be wrong about — the **protocol** between the dialog and the daemon,
 * and the **three places** a successful add has to land.
 *
 * Five claims:
 *
 * 1. **A directory that is already a tracker is added in one round.** No question asked,
 *    because the directory answered it. This is the common case and the one a second
 *    round would make tedious.
 *
 * 2. **A directory that is not one comes back as a question, not an error.** `ok: false`
 *    with `needs: 'tracker'`, the bead-spaces to attach to, and a prefix already
 *    suggested — and, when the clone carries beads history, `carriesData` so the dialog
 *    withholds the choice that cannot be undone rather than drawing it and refusing.
 *
 * 3. **The add reaches the running daemon, not just the file.** The assertion is
 *    `/api/spaces` naming the new bead-space on the very next request, with no restart
 *    and no sweep in between: `cfg.workspaces` is what a tick serves, the `workspaces`
 *    Map is what the routes that name one repo resolve through, and `config.json` is what
 *    survives a boot. A write that did one of the three is a bead-space that appears in
 *    an hour, or one that vanishes at the next restart, and both look like the config
 *    being haunted.
 *
 * 4. **Attaching says when it has attached something useless.** A checkout with no
 *    `serviceToken` goes on the list — the list is the person's to write — but no bead can
 *    ever name it, and a reply that said only "ok" would be the screen lying by omission.
 *
 * 5. **A prefix another tracker already mints is refused at the route**, where the other
 *    trackers are known. The module cannot answer this one: it is a fact about the fleet,
 *    not about the directory.
 *
 * `bd` is a script this file writes, because what is being asserted is that the route
 * calls it in the right place with the right argv — which a real `bd` would answer more
 * slowly and no more truthfully. `git` is real, for the one case that is about what a
 * clone carries.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-addspace-'));
// Before anything under lib/ is imported: both resolve once, at module load, and a suite
// that let either see the real machine would write into the config this Mac is running on.
process.env.HOME = tmp;
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createApp, listen } = await import(LIB('server.js'));
const { CONFIG_PATH } = await import(LIB('config.js'));

let failures = 0;
const check = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}\n      ${err.message}`);
  }
};

const mk = (...p) => {
  const dir = path.join(tmp, ...p);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const trackerIn = (dir, prefix) => {
  const beads = path.join(dir, '.beads');
  fs.mkdirSync(beads, { recursive: true });
  fs.writeFileSync(path.join(beads, 'metadata.json'), JSON.stringify({ dolt_database: prefix }));
  return beads;
};

/* A `bd` that does what `bd init` does to the disk and nothing else: makes the .beads it
   was pointed at, and records the argv so the suite can read it back. */
const BD = path.join(tmp, 'fake-bd');
const BD_LOG = path.join(tmp, 'bd-calls.log');
fs.writeFileSync(
  BD,
  `#!/bin/sh
echo "$* | cwd=$PWD | BEADS_DIR=$BEADS_DIR" >> ${JSON.stringify(BD_LOG)}
[ "$1" = "init" ] && mkdir -p "$BEADS_DIR"
exit 0
`
);
fs.chmodSync(BD, 0o755);

/* One tracker to start with, so the install is not empty and `attach` has somewhere to
   attach to. */
const home = mk('beads', 'beadcause');
trackerIn(home, 'bc');

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'addspace-test-token',
  actor: 'beadcause-test',
  me: 'adam@example.com',
  workspaceRoots: [path.join(tmp, 'beads')],
  workspaces: [{ name: 'beadcause', dir: path.join(home, '.beads') }],
  projectRoot: path.join(tmp, 'proj'),
  bdBin: BD,
  spaces: [{ name: 'Personal', workspaces: ['beadcause'] }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const call = (pathname, opts = {}) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method: opts.method || 'GET',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': cfg.token },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body || '{}') });
          } catch {
            resolve({ status: res.statusCode, body: {} });
          }
        });
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });

const add = (body) => call('/api/workspaces', { method: 'POST', body: { action: 'add', ...body } });
const saved = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

console.log('addspace: the route');

await check('a directory that is already a tracker is added in one round', async () => {
  const dir = mk('elsewhere', 'sideproject');
  trackerIn(dir, 'sd');
  const { status, body } = await add({ source: 'path', value: dir });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, body.error);
  assert.equal(body.added.name, 'sideproject');
  assert.equal(body.added.beads, path.join(dir, '.beads'));
});

await check('and it is served, pinned and on file — all three, with no restart', async () => {
  // The live half: this request goes through the same `workspaces` Map every route that
  // names one repo resolves through, and it has not been rebuilt since.
  const spaces = await call('/api/spaces');
  assert.ok(spaces.body.workspaces.includes('sideproject'), JSON.stringify(spaces.body.workspaces));
  // The file half.
  assert.equal(saved().workspaceDirs.sideproject, '~/elsewhere/sideproject');
  // And it draws under Other, because nothing put it in a group and nothing here should.
  assert.ok(!(saved().spaces || []).some((s) => (s.workspaces || []).includes('sideproject')));
});

await check('a tracker under a configured root is served without being pinned', async () => {
  // `workspaceDirs` is for one the roots cannot reach. Pinning one they can freezes it, so
  // renaming its directory would drop the bead-space rather than move it.
  const dir = mk('beads', 'undertheroot');
  trackerIn(dir, 'ur');
  const { body } = await add({ source: 'path', value: dir });
  assert.equal(body.ok, true, body.error);
  assert.equal(saved().workspaceDirs?.undertheroot, undefined, 'it was pinned anyway');
  const spaces = await call('/api/spaces');
  assert.ok(spaces.body.workspaces.includes('undertheroot'));
});

await check('adding the same name twice is refused', async () => {
  const dir = mk('elsewhere2', 'sideproject');
  trackerIn(dir, 'sd');
  const { status, body } = await add({ source: 'path', value: dir });
  assert.equal(status, 400);
  assert.match(body.error, /already a bead-space/);
});

console.log('addspace: the second round');

await check('a directory with no tracker comes back as a question', async () => {
  const dir = mk('proj', 'safeleaf');
  fs.writeFileSync(path.join(dir, 'README.md'), '# safeleaf\n');
  const { status, body } = await add({ source: 'path', value: dir });
  assert.equal(status, 200);
  assert.equal(body.ok, false);
  assert.equal(body.needs, 'tracker');
  assert.equal(body.name, 'safeleaf');
  assert.equal(body.dir, dir);
  assert.equal(body.carriesData, false);
  assert.equal(body.prefix, 'sa', 'a prefix is suggested, not asked for blind');
  assert.ok(body.beadSpaces.includes('beadcause'), 'and the list to attach to comes with it');
});

await check('answering "a bead-space of its own" runs bd init in the tracker root', async () => {
  const dir = path.join(tmp, 'proj', 'safeleaf');
  const { status, body } = await add({
    source: 'path',
    value: dir,
    tracker: { mode: 'new', prefix: 'sa' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, body.error);
  const log = fs.readFileSync(BD_LOG, 'utf8').trim().split('\n').pop();
  assert.match(log, /^init --prefix sa --role maintainer --skip-agents --non-interactive /, log);
  // `fs.realpathSync` because macOS puts the temp tree under /private/var and hands back
  // /var — the shell's $PWD is the resolved one, and comparing the two strings is a suite
  // that fails on a Mac and passes everywhere else.
  assert.match(log, new RegExp(`cwd=${fs.realpathSync(path.join(tmp, 'beads', 'safeleaf'))} `), log);
  assert.match(log, new RegExp(`BEADS_DIR=${path.join(tmp, 'beads', 'safeleaf', '.beads')}$`), log);
  // The tracker is in the container root and the checkout stayed where it was.
  assert.equal(body.added.dir, path.join(tmp, 'beads', 'safeleaf'));
  // And nothing pins the session: the checkout is `<projectRoot>/<name>`, which is the
  // rule. A pin that restates the rule is one that stops following it the day the tree
  // moves, and lib/repos.js warns about a `sessionDirs` entry on a bead-space that has an
  // approved repo list.
  assert.equal(saved().sessionDirs?.safeleaf, undefined);
});

await check('but a checkout the rule would not find is pinned', async () => {
  const dir = mk('outside', 'stray');
  const { body } = await add({ source: 'path', value: dir, tracker: { mode: 'new', prefix: 'st' } });
  assert.equal(body.ok, true, body.error);
  assert.equal(body.added.dir, path.join(tmp, 'beads', 'stray'), 'the tracker is still in the container root');
  assert.equal(saved().sessionDirs.stray, '~/outside/stray');
});

await check('a prefix another tracker already mints is refused', async () => {
  const dir = mk('proj', 'beancounter');
  const { status, body } = await add({
    source: 'path',
    value: dir,
    tracker: { mode: 'new', prefix: 'bc' },
  });
  assert.equal(status, 400);
  assert.match(body.error, /beadcause already mints bc- ids/);
});

await check('answering "file its beads in one I already have" writes an approved path', async () => {
  const dir = mk('proj', 'athena');
  const { status, body } = await add({
    source: 'path',
    value: dir,
    tracker: { mode: 'attach', workspace: 'beadcause' },
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.ok, true, body.error);
  assert.deepEqual(saved().repos.beadcause.approved, ['~/proj/athena']);
  // It is not a bead-space, so it must not have become one.
  const spaces = await call('/api/spaces');
  assert.ok(!spaces.body.workspaces.includes('athena'));
});

await check('and it says so when what it attached can never be named', async () => {
  // No config/config.yaml, so `repoList` cannot resolve a service token — the repo is on
  // the list and no bead can point at it. Reported, never repaired: the token is a fact
  // about the checkout, and writing one here would be the app inventing it.
  const { body } = await add({
    source: 'path',
    value: mk('proj', 'tokenless'),
    tracker: { mode: 'attach', workspace: 'beadcause' },
  });
  assert.equal(body.ok, true, body.error);
  assert.match(body.warning || '', /serviceToken/);
});

await check('attaching a bead-space to itself twice is refused', async () => {
  const { status, body } = await add({
    source: 'path',
    value: path.join(tmp, 'proj', 'athena'),
    tracker: { mode: 'attach', workspace: 'beadcause' },
  });
  assert.equal(status, 400);
  assert.match(body.error, /already a bead-repo/);
});

await check('attaching to a bead-space this Mac does not serve is a 404', async () => {
  const { status, body } = await add({
    source: 'path',
    value: mk('proj', 'orphan'),
    tracker: { mode: 'attach', workspace: 'nosuch' },
  });
  assert.equal(status, 404);
  assert.match(body.error, /not a bead-space this Mac serves/);
});

console.log('addspace: cloning, and the history that must not be built over');

await check('a git URL is cloned and then asked about', async () => {
  const origin = mk('origin');
  const git = (...args) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
      cwd: origin,
      stdio: 'pipe',
    });
  git('init', '-q');
  fs.writeFileSync(path.join(origin, 'README.md'), '# cloned\n');
  git('add', '-A');
  git('commit', '-qm', 'first');

  // `file://` rather than a bare path: the URL field wants a scheme, so that "add this
  // directory" and "clone this thing" cannot be the same press with two outcomes.
  const { status, body } = await add({
    source: 'git',
    value: `file://${origin}`,
    cloneTo: path.join(tmp, 'proj', 'cloned'),
  });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.needs, 'tracker', JSON.stringify(body));
  assert.equal(body.cloned, true);
  assert.equal(fs.existsSync(path.join(tmp, 'proj', 'cloned', 'README.md')), true, 'the clone did not land');
});

await check('a clone carrying beads history is never bd init-ed over', async () => {
  const dir = path.join(tmp, 'proj', 'cloned');
  fs.mkdirSync(path.join(dir, '.git', 'refs', 'dolt'), { recursive: true });
  const before = fs.readFileSync(BD_LOG, 'utf8');
  const { status, body } = await add({ source: 'path', value: dir, tracker: { mode: 'new', prefix: 'cl' } });
  assert.equal(status, 400);
  assert.match(body.error, /npm run onboard/);
  assert.equal(fs.readFileSync(BD_LOG, 'utf8'), before, 'bd was spawned anyway');
});

await check('and the question round says so, so the dialog never draws the choice', async () => {
  const { body } = await add({ source: 'path', value: path.join(tmp, 'proj', 'cloned') });
  assert.equal(body.needs, 'tracker');
  assert.equal(body.carriesData, true);
});

console.log('addspace: the wiring');

const read = (rel) => fs.readFileSync(path.join(HERE, '..', rel), 'utf8');

await check('every page with the picker also loads the dialog behind its last row', async () => {
  // history.html (bc-khoe.30.15) and releases.html (bc-khoe.30.22) were in this list until
  // both pages were deleted and their views became panes in the shell. The list is still a
  // hand-written one, so a NEW page that draws the picker escapes this check until someone
  // adds it here.
  const pages = ['index.html', 'monitor.html', 'console.html', 'foundations.html', 'config.html', 'endorse.html'];
  const missing = pages.filter((p) => read(`public/${p}`).includes('/spacebar.js') && !read(`public/${p}`).includes('/addspace.js'));
  assert.deepEqual(missing, []);
});

await check('the service worker ships it, or the row is drawn over nothing', async () => {
  // The pair that breaks: a cached shell with the new spacebar.js and no addspace.js draws
  // ＋ Add a bead-space and does nothing at all when it is pressed.
  const sw = read('public/sw.js');
  assert.ok(sw.includes("'/addspace.js'"), 'not in SHELL');
  assert.ok(sw.includes("'/spacebar.js'"), 'and neither is the picker');
});

await check('the picker draws the row and opens the dialog with it', async () => {
  const bar = read('public/spacebar.js');
  assert.match(bar, /Add a bead-space/);
  assert.match(bar, /addSpace\?\.open/, 'the row is drawn but nothing opens it');
});

for (const s of servers) s.close();
// `cleanupTmp` rather than a bare `fs.rmSync`: this suite spawns nothing, but the daemon
// it built writes config.json under the tree, and a teardown that races its own last
// write ends the whole run from after the final green check. test/tmpadoption.mjs fails
// the repo for the bare form.
await cleanupTmp(tmp);

if (failures) {
  console.error(`\naddspace: ${failures} failed`);
  process.exit(1);
}
console.log('\naddspace: all good');
