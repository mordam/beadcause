#!/usr/bin/env node
/**
 * Space details — the settings the advocate console grew, and what a press changes.
 *
 *     npm test
 *     node test/spacedetails.mjs
 *
 * Seven settings moved from "open config.json in an editor on the Mac" to a card on a
 * phone. What makes that worth a suite is not the controls, it is what sits behind
 * them: every one of these fields is read by something that decides whether your phone
 * rings, whether an agent answers a comment unasked, or whether a worker merges its own
 * pull request into main. The failure modes are all silent, and all of the same shape —
 * the screen says one thing and the daemon does another.
 *
 * Five claims, and each is one nobody can make by reading the diff:
 *
 * 1. **`null` means inherit, and it is not the same as `false`.** `prPolicyFor` is
 *    explicit that a space may override the global in either direction, so "off" and
 *    "following a default that is off" have to be distinguishable — and stay
 *    distinguishable when the default moves. A screen that collapsed them would look
 *    right on the day it was written and be wrong the first time a global changed.
 *
 * 2. **A patch touches only what it names.** The card sends one field per press; two
 *    devices a poll apart must not be able to put back a setting neither of them
 *    touched.
 *
 * 3. **`name` and `workspaces` are not settable.** Moving a repo between spaces decides
 *    which questions may reach you at all. The endpoint refuses rather than dropping —
 *    a setting silently ignored is the exact failure this screen exists to end.
 *
 * 4. **The write reaches the running daemon *and* the file.** `cfg` in memory is what
 *    every push decision reads; `config.json` is what survives a restart. One without
 *    the other is a setting that is true in exactly one of the two places, and which
 *    one is a coin toss on when the daemon was last restarted.
 *
 * 5. **The per-repo panel resolves through the lists that outrank the space.**
 *    `ntfy.minimalWorkspaces` and `autoDispatchExclude` are per-workspace and beat a
 *    space's own answer, so a space set to `full` can contain a repo that pushes
 *    minimally. Showing the space's setting alone would be wrong about precisely the
 *    repo somebody had singled out.
 *
 * The server half runs against `createApp`, not a fake: the whole point of the endpoint
 * is that it mutates the live config object the rest of the process is holding, and a
 * fake would be free to be right about a contract the real server does not honour —
 * which is how the shadowed `/api/foundation` handler survived (see test/routes.mjs).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (f) => path.join(ROOT, 'lib', f);
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-spacedetails-'));
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

console.log('\nspace details');

const { readSettings, applySettings, spaceDetail, SETTINGS, prPolicyFor, isQuiet } = await import(LIB('spaces.js'));

/* ==================================================== 1. what a field can say */

check('a space that says nothing says null everywhere, not false', () => {
  const s = readSettings({ name: 'P', workspaces: ['a'] });
  assert.deepEqual(s, {
    muted: null,
    quietHours: null,
    quietDays: null,
    ntfyDetail: null,
    autoDispatch: null,
    autoMerge: null,
    requireApproval: null,
    autoShip: null,
  });
});

check('and `off` survives the global default it is overriding moving under it', () => {
  // The claim in one line: the space says false, the global says true, and the space
  // wins. If `false` and "unset" were the same value this would read `true` — which is
  // an unattended agent merging into main on a repo somebody had turned that off for.
  const cfg = { spaces: [{ name: 'P', workspaces: ['a'], autoMerge: false }], pr: { autoMerge: true } };
  assert.equal(prPolicyFor(cfg, 'a').autoMerge, false);
  assert.equal(readSettings(cfg.spaces[0]).autoMerge, false, 'the screen has to be able to draw it as off, not as unset');
});

check('a field the readers would ignore reads as unset, so the screen cannot promise it', () => {
  // "18:0" is what `minutesOfDay` refuses, which means the daemon is quiet at no time
  // at all. A card saying "quiet 18:0 → 09:00" over that would be worse than one saying
  // there are no quiet hours.
  const s = readSettings({ name: 'P', quietHours: { from: '18:0', to: '09:00' }, ntfyDetail: 'loud' });
  assert.equal(s.quietHours, null);
  assert.equal(s.ntfyDetail, null);
});

check('and what is stored is normalised, so two spellings of one answer are one answer', () => {
  const space = { name: 'P' };
  applySettings(space, { quietHours: { from: '9:00', to: '18:00' }, quietDays: ['Saturday', 'SUN', 'sat'] });
  assert.deepEqual(space.quietHours, { from: '09:00', to: '18:00' });
  // Week order, deduped, three letters — the shape `isQuiet` matches against.
  assert.deepEqual(space.quietDays, ['sun', 'sat']);
});

/* ============================================================ 2. what a patch does */

check('a patch touches only the keys it names', () => {
  const space = { name: 'P', workspaces: ['a'], muted: true, ntfyDetail: 'minimal', autoMerge: false };
  applySettings(space, { autoMerge: true });
  assert.equal(space.muted, true, 'a field nobody mentioned');
  assert.equal(space.ntfyDetail, 'minimal');
  assert.equal(space.autoMerge, true);
});

check('null clears the key rather than storing a false, which is the only way back to inherit', () => {
  const space = { name: 'P', autoMerge: false, quietHours: { from: '18:00', to: '09:00' }, quietDays: ['sat'] };
  applySettings(space, { autoMerge: null, quietHours: null, quietDays: null });
  assert.deepEqual(space, { name: 'P' }, 'the keys are gone, not set to false');
  assert.equal(readSettings(space).autoMerge, null);
});

check('and an empty day list clears it too — "quiet on no days" is not a second shape', () => {
  const space = { name: 'P', quietDays: ['sat'] };
  applySettings(space, { quietDays: [] });
  assert.ok(!('quietDays' in space));
});

check('what changed is what actually moved, not what was sent', () => {
  const space = { name: 'P', autoMerge: false };
  assert.deepEqual(applySettings(space, { autoMerge: false }), [], 'setting it to what it already was');
  assert.deepEqual(applySettings(space, { autoMerge: true }), ['autoMerge']);
  // Pressing Inherit on a field that was already inheriting: nothing moved, and saying
  // so is more honest than a tick.
  assert.deepEqual(applySettings(space, { muted: null }), []);
});

/* ==================================================== 3. what it refuses, out loud */

for (const [what, patch] of [
  ['a field that is not a setting', { name: 'Renamed' }],
  ['the workspace list', { workspaces: ['a', 'b'] }],
  ['a string where a boolean goes', { autoMerge: 'false' }],
  ['a detail level nothing reads', { ntfyDetail: 'loud' }],
  ['half a quiet-hours window', { quietHours: { from: '18:00' } }],
  ['a day nobody has', { quietDays: ['sat', 'funday'] }],
  ['a patch that is not an object', ['muted']],
]) {
  check(`refuses ${what}, with a reason`, () => {
    const space = { name: 'P', workspaces: ['a'] };
    assert.throws(() => applySettings(space, patch), /.+/);
    // And left it exactly as it was: a refusal that half-applied would be worse than
    // either accepting or refusing outright.
    assert.deepEqual(space, { name: 'P', workspaces: ['a'] });
  });
}

check('SETTINGS is the whole of what may be written, and names neither the space nor its repos', () => {
  assert.ok(!SETTINGS.includes('name'));
  assert.ok(!SETTINGS.includes('workspaces'));
});

/* ================================================= 5. what each repo resolves to */

const RESOLVE = {
  workspaces: [{ name: 'alpha' }, { name: 'beta' }, { name: 'gamma' }],
  spaces: [{ name: 'Work', workspaces: ['alpha', 'beta', 'nowhere'], ntfyDetail: 'full', autoMerge: true }],
  ntfy: { detail: 'full', minimalWorkspaces: ['beta'] },
  autoDispatchExclude: ['alpha'],
  pr: { autoMerge: false },
};

check('the per-repo panel is the answer the daemon gives, not the space`s own setting', () => {
  const d = spaceDetail(RESOLVE, 'Work');
  const byName = Object.fromEntries(d.repos.map((r) => [r.name, r]));
  // The space says `full`; beta is on the per-repo minimal list, which outranks it.
  assert.equal(byName.beta.ntfyDetail, 'minimal');
  assert.equal(byName.alpha.ntfyDetail, 'full');
  // Same shape for the other per-repo list.
  assert.equal(byName.alpha.autoDispatch, false);
  assert.equal(byName.beta.autoDispatch, true);
  // And the space beating the global, which is the direction the PR policy needed.
  assert.equal(byName.alpha.autoMerge, true);
});

check('a repo the space names and the daemon does not have is called out, not silently dropped', () => {
  const d = spaceDetail(RESOLVE, 'Work');
  assert.deepEqual(d.workspaces, ['alpha', 'beta']);
  assert.deepEqual(d.missing, ['nowhere'], 'config drift the screen has to be able to say');
  assert.ok(!d.repos.some((r) => r.name === 'nowhere'), 'and nothing invented for it');
});

check('the defaults travel, so an Inherit button can say what it would inherit to', () => {
  const d = spaceDetail(RESOLVE, 'Work');
  assert.equal(d.defaults.autoMerge, false);
  assert.equal(d.defaults.ntfyDetail, 'full');
  assert.equal(d.defaults.autoDispatch, true);
});

check('and `Other` is not a space — it is a group the picker offers, with nothing to set', () => {
  assert.equal(spaceDetail(RESOLVE, 'Other'), null);
  assert.equal(spaceDetail(RESOLVE, 'nope'), null);
});

/* ================================================================ the wiring */

check('the page carries the settings card and the gear to admin', () => {
  const html = read('public/monitor.html');
  assert.ok(html.includes('id="gear"'), 'no gear in the top bar');
  assert.ok(html.includes('href="/admin"'), 'the gear points nowhere');
  const js = read('public/monitor.js');
  assert.ok(js.includes('/api/space?space='), 'the page never reads a space');
  assert.ok(js.includes("data-space-set"), 'nothing on the page writes one');
});

check('and the service worker version moved, or a cached phone gets the gear without the card', () => {
  // monitor.html, monitor.js and style.css are all already in the shell, so the version
  // is the only thing that makes the three arrive together.
  assert.ok(/const CACHE = 'beadcause-v(2[5-9]|[3-9]\d)'/.test(read('public/sw.js')), 'CACHE was not bumped past v24');
});

/* ============================================================== the server half */

const { createApp, listen } = await import(LIB('server.js'));
const { CONFIG_PATH } = await import(LIB('config.js'));

const cfg = {
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'space-details-token',
  actor: 'beadcause-test',
  // A `bd` that cannot exist: neither of these endpoints may sweep a tracker, and this
  // is where that would show up.
  workspaces: [{ name: 'alpha', dir: path.join(tmp, 'beads', 'alpha', '.beads') }, { name: 'beta', dir: path.join(tmp, 'beads', 'beta', '.beads') }],
  bdBin: path.join(tmp, 'no-such-bd'),
  spaces: [
    { name: 'Work', workspaces: ['alpha', 'beta'] },
    { name: 'Personal', workspaces: [], muted: true },
  ],
  pr: { autoMerge: true },
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

// The one object the whole process holds: what the endpoint mutates is this, and every
// assertion about "the running daemon" below reads it back out of here.
const live = { ...cfg, port };
const app = createApp(live);
const servers = listen(live, app.handler);

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

for (let i = 0; i < 100; i += 1) {
  try {
    await call('/api/health');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 50));
  }
}

const got = await call('/api/space?space=Work');
check('GET /api/space answers with no `bd` on the machine at all', () => {
  assert.equal(got.status, 200);
  assert.equal(got.body.space, 'Work');
  assert.deepEqual(got.body.workspaces, ['alpha', 'beta']);
  assert.equal(got.body.settings.autoMerge, null, 'nothing set yet');
  assert.equal(got.body.defaults.autoMerge, true, 'and the global it would inherit');
});

const missing = await call('/api/space?space=Other');
check('and the synthetic Other group is a 404, not an empty card', () => {
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /Other/);
});

const wrote = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { autoMerge: false } } });
check('POST changes what the *running* daemon would do, on the object it is holding', () => {
  assert.equal(wrote.status, 200);
  assert.deepEqual(wrote.body.changed, ['autoMerge']);
  // The claim, made through the same resolver bin/deliver.js and lib/session.js use,
  // against the same cfg object the server closed over. Nothing was reloaded.
  assert.equal(prPolicyFor(live, 'alpha').autoMerge, false);
});

check('and it survives a restart, because the file moved too', () => {
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(onDisk.spaces.find((s) => s.name === 'Work').autoMerge, false);
});

const cleared = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { autoMerge: null } } });
check('clearing puts the space back to following the global rather than to false', () => {
  assert.deepEqual(cleared.body.changed, ['autoMerge']);
  assert.equal(cleared.body.settings.autoMerge, null);
  assert.equal(prPolicyFor(live, 'alpha').autoMerge, true, 'the global is back in force');
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.ok(!('autoMerge' in onDisk.spaces.find((s) => s.name === 'Work')), 'the key is gone from the file');
});

/* One sweep, so the picker's summary is *cached* rather than computed fresh — which is
   the only state where the check below can fail. Every workspace errors (there is no
   `bd` on this machine by construction, and the two lines it logs are that, deliberately)
   and the sweep still caches a row per configured space, which is exactly the stale copy
   `/api/spaces` would otherwise serve. */
await call('/api/questions?scope=human');

const muted = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { muted: true } } });
check('muting takes effect on the push path immediately, not at the next restart', () => {
  assert.equal(muted.status, 200);
  assert.equal(isQuiet(live.spaces.find((s) => s.name === 'Work')), true);
});

const picker = await call('/api/spaces');
check('and the picker`s cached summary is refreshed, so the 🔕 is not a poll behind', () => {
  // Before this, `spacesPending` was rebuilt only by the thirty-second sweep — so the
  // bar above the card you had just muted in went on saying the space was live.
  const row = picker.body.spaces.find((s) => s.name === 'Work');
  assert.equal(row.muted, true);
  assert.equal(row.quiet, true);
  // And the rest of the cached row is untouched: rebuilding it from `summarise(cfg, [])`
  // would zero every count in the picker and drop the synthetic "Other" group with them.
  assert.deepEqual(row.workspaces, ['alpha', 'beta']);
});

const refused = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { name: 'Renamed' } } });
check('a field that is not a setting is a 400 with the reason, and changes nothing', () => {
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /not a space setting/);
  assert.equal(live.spaces.find((s) => s.name === 'Work').name, 'Work');
});

const nosuch = await call('/api/space', { method: 'POST', body: { space: 'Nowhere', settings: { muted: true } } });
check('and a space nobody has is a 404 rather than a space quietly created', () => {
  assert.equal(nosuch.status, 404);
  assert.equal(live.spaces.length, 2);
});

servers.forEach((s) => s.close());
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
