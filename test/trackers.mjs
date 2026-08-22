/**
 * Retiring a **tracker** from the app — bc-qid8b.
 *
 * Named for trackers rather than for retiring because this repo already retires something
 * else: `test/retire.mjs` is the sweep that moves a finished *worktree* into
 * `.claude/worktrees-retired/`. Two unrelated things, one verb, and the file names are
 * where that has to be kept straight.
 *
 * The space picker is a native `<select>` (public/spacebar.js), which cannot carry a
 * button per row, so a repo you had finished with stayed in the dropdown for ever unless
 * you hand-edited `workspaceDirs` in ~/.config/beadcause/config.json on a machine you had
 * to be sitting at. `/api/workspaces` is the way out, and the admin page is where it is
 * pressed — the one screen about what this Mac is doing rather than about beads.
 *
 * Six promises, and none of them is the arithmetic:
 *
 * 1. **It takes effect without a restart.** `workspaceDirs.<name>: null` in the file is
 *    only half the write. Every sweep re-reads `cfg.workspaces` per tick and every route
 *    that acts on one named repo resolves through the `workspaces` Map, so a retire that
 *    wrote the file alone would go on sweeping the tracker — and the screen would say it
 *    had stopped. Asserted against the live `cfg` object the server closed over.
 *
 * 2. **It is a rule, not a fact.** The `null` is what makes it survive the next start:
 *    `reconcileWorkspaces` re-runs discovery on every load, and an entry merely deleted
 *    from `workspaces` comes straight back the moment the directory is looked at again.
 *    Asserted by running discovery over the config the endpoint actually wrote.
 *
 * 3. **The name stays in its space, and that is not drift.** Retiring writes one key and
 *    leaves `spaces[].workspaces` alone, which is what makes a bring-back one key too —
 *    the repo returns to the space it was always in. So `spaceDetail` has to tell a
 *    deliberate retirement apart from a checkout that vanished, because the screen warns
 *    about one and not the other.
 *
 * 4. **Bring back finds the tracker rather than replaying a remembered path.** The `null`
 *    replaced the directory, so the name no longer knows where it lived; between the two
 *    presses the tracker may have moved. A restore that could not find one is a refusal
 *    that leaves the retirement standing, because an entry pointing at nothing is a sweep
 *    that fails once per tick.
 *
 * 5. **The last one is refused.** Every screen in the app is a list of beads from
 *    somewhere, and an install serving nothing is a working daemon whose only way back is
 *    the config file this button exists to avoid.
 *
 * 6. **The beads are untouched.** This is a line about what gets *read*. The tracker stays
 *    on disk, which is the whole reason the button is safe enough to put on a screen.
 *
 * Nothing here runs `bd`: `bdBin` points at a path that cannot exist, so a route that
 * swept a tracker to answer would fail rather than pass slowly.
 *
 * `npm test`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-trackers-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
function check(name, fn) {
  ran += 1;
  try {
    fn();
    console.log(`  \x1b[32m✓\x1b[0m ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      ${err.message.split('\n')[0]}`);
  }
}

console.log('\nretiring a tracker');

/* Three trackers under one root, which is what makes discovery real here: `restorable`
   and the restore itself both ask `discoverWorkspaces`, and a fixture that only listed
   names in `cfg.workspaces` would let a broken lookup pass. A `.beads` directory is the
   whole test for a workspace — nothing reads a tracker. */
const BEADS = path.join(tmp, 'beads');
for (const name of ['alpha', 'beta', 'gamma']) {
  fs.mkdirSync(path.join(BEADS, name, '.beads'), { recursive: true });
}
const dirOf = (name) => path.join(BEADS, name, '.beads');

const { createApp, listen } = await import(LIB('server.js'));
const { CONFIG_PATH, reconcileWorkspaces } = await import(LIB('config.js'));
const { spaceDetail } = await import(LIB('spaces.js'));
const { discoverWorkspaces } = await import(LIB('workspaceroots.js'));

const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'retire-token',
  actor: 'beadcause-test',
  workspaceRoots: [BEADS],
  workspaceDirs: {},
  workspaces: ['alpha', 'beta', 'gamma'].map((name) => ({ name, dir: dirOf(name) })),
  // A `bd` that cannot exist: none of this may sweep a tracker, and this is where that
  // would show up.
  bdBin: path.join(tmp, 'no-such-bd'),
  // `gamma` is in no space on purpose — it is the stray the picker draws under "Other",
  // and the one whose retirement must not be reported as a space's drift.
  spaces: [
    { name: 'Work', workspaces: ['alpha'] },
    { name: 'Side', workspaces: ['beta'] },
  ],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

// The one object the whole process holds: what the endpoint mutates is this, and every
// assertion about "the running daemon" below reads it back out of here.
const live = { ...cfg, port: 0 };
const app = createApp(live);
const servers = listen(live, app.handler);
const port = await boundPort(servers);
live.port = port;

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
        res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
      }
    );
    req.on('error', reject);
    if (opts.body) req.write(JSON.stringify(opts.body));
    req.end();
  });

const names = (rows) => (rows || []).map((r) => r.name).sort();
const onDisk = () => JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));

/* ============================================================ 1. what it lists */

const listed = await call('/api/workspaces');
check('GET names every tracker this Mac serves, with no `bd` on the machine at all', () => {
  assert.equal(listed.status, 200);
  assert.deepEqual(names(listed.body.workspaces), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(listed.body.retired, [], 'nothing retired yet');
});

check('and says which space each would disappear from, including the stray', () => {
  const bySpace = Object.fromEntries(listed.body.workspaces.map((w) => [w.name, w.space]));
  assert.deepEqual(bySpace, { alpha: 'Work', beta: 'Side', gamma: null });
});

/* ================================================= 2. the retire, and its reach */

const gone = await call('/api/workspaces', { method: 'POST', body: { action: 'retire', workspace: 'beta' } });
check('POST retire answers, and the file records the rule that keeps it out', () => {
  assert.equal(gone.status, 200);
  assert.equal(gone.body.ok, true);
  // `null` and not "absent": absent is a fact about the moment it was typed, and
  // discovery would find the directory again on the next start.
  assert.equal(onDisk().workspaceDirs.beta, null);
});

check('the *running* daemon stops serving it — the object every sweep re-reads per tick', () => {
  assert.deepEqual(
    live.workspaces.map((w) => w.name),
    ['alpha', 'gamma'],
    'cfg.workspaces still names the retired tracker'
  );
});

const after = await call('/api/spaces');
check('and the picker is handed a list without it, which is the point of the press', () => {
  assert.equal(after.status, 200);
  assert.deepEqual([...after.body.workspaces].sort(), ['alpha', 'gamma']);
});

// Awaited out here rather than inside `check`, which is synchronous: a promise handed to
// it would resolve after the run had been counted, and a broken assertion would read as a
// pass. Every request below is made the same way, in the order the checks read.
const sideAfter = await call('/api/space?space=Side');
check('a route that resolves a repo by name no longer finds it', () => {
  assert.deepEqual(sideAfter.body.workspaces, [], 'Side still resolves a retired repo');
});

/* ================================== 3. it survives a restart, because it is a rule */

check('discovery over the config it wrote still refuses the tracker', () => {
  // The next start's answer, computed the way `loadConfig` computes it. The directory is
  // still there — that is the whole point — so anything short of the `null` brings it back.
  const found = discoverWorkspaces(onDisk()).map((w) => w.name);
  assert.deepEqual(found.sort(), ['alpha', 'gamma']);
});

check('and reconciliation does not put it back either', () => {
  const merged = reconcileWorkspaces(onDisk().workspaces, onDisk(), { persist: false });
  assert.deepEqual(
    merged.map((w) => w.name).sort(),
    ['alpha', 'gamma']
  );
});

check('the beads are untouched — this is a line about what gets read', () => {
  assert.ok(fs.existsSync(dirOf('beta')), 'the tracker was deleted from disk');
});

/* ========================= 4. a retirement is not the drift warning's business */

check('the space still names it, which is what makes a bring-back one key', () => {
  assert.deepEqual(live.spaces.find((s) => s.name === 'Side').workspaces, ['beta']);
});

check('and spaceDetail calls that retired, not missing — the screen warns about one, not both', () => {
  const d = spaceDetail(live, 'Side');
  assert.deepEqual(d.missing, [], 'a deliberate retirement was reported as config drift');
  assert.deepEqual(d.retired, ['beta']);
  assert.deepEqual(d.workspaces, [], 'and it is not offered as a live repo either');
});

check('a name nobody retired is still drift, so the warning that mattered survives', () => {
  const drifted = { ...live, spaces: [{ name: 'Ghost', workspaces: ['nobody'] }] };
  const d = spaceDetail(drifted, 'Ghost');
  assert.deepEqual(d.missing, ['nobody']);
  assert.equal(d.retired, undefined, 'absent, so an older client draws what it always did');
});

/* ================================================ 5. what the retired row offers */

const withRetired = await call('/api/workspaces');
check('the retired half of the list carries the space it will return to', () => {
  assert.deepEqual(withRetired.body.retired, [{ name: 'beta', space: 'Side', restorable: true }]);
});

// Retired, then the directory moved out from under it — the row must not promise a
// bring-back that would find nothing.
await call('/api/workspaces', { method: 'POST', body: { action: 'retire', workspace: 'gamma' } });
fs.renameSync(path.join(BEADS, 'gamma'), path.join(tmp, 'gamma-moved'));
const withMoved = await call('/api/workspaces');
check('and a tracker whose directory has gone says so instead of offering a dead button', () => {
  assert.equal(withMoved.body.retired.find((r) => r.name === 'gamma').restorable, false);
  // And the one still on disk is unaffected by its neighbour's absence.
  assert.equal(withMoved.body.retired.find((r) => r.name === 'beta').restorable, true);
});

/* ============================================================== 6. bringing it back */

const back = await call('/api/workspaces', { method: 'POST', body: { action: 'restore', workspace: 'beta' } });
check('restore returns the tracker to the space it was always in', () => {
  assert.equal(back.status, 200);
  assert.deepEqual(
    live.workspaces.map((w) => w.name).sort(),
    ['alpha', 'beta']
  );
  const d = spaceDetail(live, 'Side');
  assert.deepEqual(d.workspaces, ['beta']);
  assert.equal(d.retired, undefined);
});

check('and the key is gone from the file, not set to something else', () => {
  assert.equal('beta' in onDisk().workspaceDirs, false);
});

const lostRestore = await call('/api/workspaces', { method: 'POST', body: { action: 'restore', workspace: 'gamma' } });
check('a restore that can find no tracker is refused, and the retirement stands', () => {
  assert.equal(lostRestore.status, 404);
  assert.match(lostRestore.body.error, /could be found/);
  // The refusal must not leave the config half-written: `gamma` is still retired, so the
  // next start does not go looking for a directory that is not there.
  assert.equal(live.workspaceDirs.gamma, null);
  assert.equal(
    live.workspaces.some((w) => w.name === 'gamma'),
    false
  );
});

/* ====================================================== 7. what it will not do */

const unserved = await call('/api/workspaces', { method: 'POST', body: { action: 'retire', workspace: 'nope' } });
check('a tracker nobody serves cannot be retired', () => {
  assert.equal(unserved.status, 404);
  assert.match(unserved.body.error, /not a tracker/);
});

const notRetired = await call('/api/workspaces', { method: 'POST', body: { action: 'restore', workspace: 'alpha' } });
check('a tracker nobody retired cannot be restored', () => {
  assert.equal(notRetired.status, 404);
  assert.match(notRetired.body.error, /not retired/);
});

const nonsense = await call('/api/workspaces', { method: 'POST', body: { action: 'delete', workspace: 'alpha' } });
check('an action nobody has heard of is a 400 rather than a guess', () => {
  assert.equal(nonsense.status, 400);
  assert.match(nonsense.body.error, /unknown action/);
});

// Down to `alpha` and `beta`; take one and the other is the last.
const secondLast = await call('/api/workspaces', { method: 'POST', body: { action: 'retire', workspace: 'beta' } });
const theLast = await call('/api/workspaces', { method: 'POST', body: { action: 'retire', workspace: 'alpha' } });
check('the last tracker is refused — an install serving nothing has no way back on screen', () => {
  assert.equal(secondLast.status, 200);
  assert.equal(theLast.status, 400);
  assert.match(theLast.body.error, /only tracker/);
  assert.deepEqual(
    live.workspaces.map((w) => w.name),
    ['alpha'],
    'the refusal still emptied the install'
  );
});

/* ================================================== 8. the screen it is pressed on */

check('the admin page draws the card, and still has no space picker', () => {
  const html = read('public/admin.html');
  assert.match(html, /id="repos"/, 'nothing on the page for the list to be drawn into');
  // The one page with no picker, on purpose — see the header of public/spacebar.js. The
  // control that cleans the picker up must not be the thing that finally puts one here.
  assert.equal(html.includes('spacebar.js'), false);
});

check('and its script asks the route, arms the destructive half, and offers the way back', () => {
  const js = read('public/admin.js');
  assert.match(js, /'\/api\/workspaces'/);
  // Armed like Revoke: a retire stops the questions arriving, which is worth reading
  // before the press rather than after it.
  assert.match(js, /data-confirm="Tap again — \$\{esc\(/);
  assert.match(js, /data-restore=/, 'no Bring back button, so the press is one-way on screen');
});

/* ---------------------------------------------------------------------- teardown */

for (const s of servers) s.close();
cleanupTmp(tmp);

console.log(`\n${failures ? `\x1b[31m${failures} of ${ran} failed\x1b[0m` : `\x1b[32m${ran} passed\x1b[0m`}`);
process.exit(failures ? 1 : 0);
