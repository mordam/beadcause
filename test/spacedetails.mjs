#!/usr/bin/env node
/**
 * Space details — the settings the advocate console grew, and what a press changes.
 *
 *     npm test
 *     node test/spacedetails.mjs
 *
 * Ten settings moved from "open config.json in an editor on the Mac" to a card on a
 * phone. What makes that worth a suite is not the controls, it is what sits behind
 * them: every one of these fields is read by something that decides whether your phone
 * rings, whether an agent answers a comment unasked, whether a bead an agent filed may be
 * worked before you have read it, whether a worker merges its own pull request into
 * main, or which Slack channel other people read the question in. The failure modes are
 * all silent, and all of the same shape — the screen says one thing and the daemon does
 * another.
 *
 * The `autoEndorse` half of that is its own suite (test/autoendorse.mjs), because what it
 * switches off is a safety property rather than a preference; what belongs here is that
 * it is a setting like the others, three-state and writable from the card.
 *
 * Six claims, and each is one nobody can make by reading the diff:
 *
 * 1. **`null` means inherit, and it is not the same as `false`** — nor, on the Slack
 *    channel, the same as `""`. `prPolicyFor` is
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
 *    repo somebody had singled out. One of those rows is now also a *control* —
 *    `autoEndorse` has a per-repo override of its own — so the same endpoint takes a
 *    `workspace`, and what it must not do is let a card drawn for one space write the
 *    answer for a repo that space does not contain.
 *
 * 6. **A row is a workspace, and that is no longer always one repo.** Since lib/repos.js a
 *    workspace can be forty checkouts of an org sharing one tracker. These answers stay
 *    per space — bc-l853.7, argued above `autoDispatchAllowed` — so the card has to say
 *    how many checkouts each single answer governs, or it understates the reach of every
 *    setting on it by the size of the org.
 *
 * The server half runs against `createApp`, not a fake: the whole point of the endpoint
 * is that it mutates the live config object the rest of the process is holding, and a
 * fake would be free to be right about a contract the real server does not honour —
 * which is how the shadowed `/api/foundation` handler survived (see test/routes.mjs).
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

const spacesMod = await import(LIB('spaces.js'));
const { readSettings, applySettings, spaceDetail, SETTINGS, prPolicyFor, isQuiet, slackChannelFor, autoEndorseAllowed, autoShipAllowed } =
  spacesMod;

/* ==================================================== 1. what a field can say */

check('a space that says nothing says null everywhere, not false', () => {
  const s = readSettings({ name: 'P', workspaces: ['a'] });
  assert.deepEqual(s, {
    muted: null,
    quietHours: null,
    quietDays: null,
    ntfyDetail: null,
    slackChannel: null,
    slackDetail: null,
    autoDispatch: null,
    autoEndorse: null,
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

check('the Slack channel has three answers, and two of them are not the same nothing', () => {
  // The claim the whole control is shaped around: no key follows `slack.channel`, and a
  // key set to nothing means this space never posts however the global is set. A screen
  // that collapsed them would take away the only way to say "not this space" — and it
  // would take it away silently, the day somebody set a global channel.
  const cfg = { slack: { enabled: true, channel: 'C-GLOBAL' }, spaces: [], workspaces: [{ name: 'a' }] };
  cfg.spaces = [{ name: 'Inherits', workspaces: ['a'] }];
  assert.equal(readSettings(cfg.spaces[0]).slackChannel, null);
  assert.equal(slackChannelFor(cfg, 'a'), 'C-GLOBAL', 'no key at all follows the global');

  cfg.spaces = [{ name: 'Never', workspaces: ['a'], slackChannel: '' }];
  assert.equal(readSettings(cfg.spaces[0]).slackChannel, '', 'not null — the card draws these two differently');
  assert.equal(slackChannelFor(cfg, 'a'), null, 'and it posts nowhere with a global channel set');

  cfg.spaces = [{ name: 'Own', workspaces: ['a'], slackChannel: ' C-OWN ' }];
  assert.equal(readSettings(cfg.spaces[0]).slackChannel, 'C-OWN');
});

check('a field the readers would ignore reads as unset, so the screen cannot promise it', () => {
  // "18:0" is what `minutesOfDay` refuses, which means the daemon is quiet at no time
  // at all. A card saying "quiet 18:0 → 09:00" over that would be worse than one saying
  // there are no quiet hours.
  const s = readSettings({
    name: 'P',
    quietHours: { from: '18:0', to: '09:00' },
    ntfyDetail: 'loud',
    slackDetail: 'loud',
  });
  assert.equal(s.quietHours, null);
  assert.equal(s.ntfyDetail, null);
  assert.equal(s.slackDetail, null);
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

check('setting the channel to nothing keeps the key, and clearing it removes the key', () => {
  const space = { name: 'P', slackChannel: 'C-OWN', slackDetail: 'minimal' };
  applySettings(space, { slackChannel: '' });
  assert.equal(space.slackChannel, '', 'Never stores the empty string rather than deleting it');
  applySettings(space, { slackChannel: null });
  assert.ok(!('slackChannel' in space), 'Inherit is the only thing that takes the key away');
  applySettings(space, { slackDetail: null });
  assert.deepEqual(space, { name: 'P' });
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
  ['the same on the Slack side', { slackDetail: 'loud' }],
  ['a channel that is not a string', { slackChannel: 42 }],
  ['a channel sent as a boolean, which is what a three-state button would send', { slackChannel: false }],
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
  slack: { enabled: true, channel: 'C-GLOBAL', excludeWorkspaces: ['alpha'] },
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
  // Slack has the same shape of per-repo veto, and the panel is the only place it shows:
  // the space says nothing, so beta follows the global channel, and alpha is on
  // `slack.excludeWorkspaces` and reaches no channel at all.
  assert.equal(byName.beta.slackChannel, 'C-GLOBAL');
  assert.equal(byName.alpha.slackChannel, null);
  assert.equal(byName.beta.slackDetail, 'full');
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
  // What Inherit resolves to on the Slack row — `null` where nothing is configured, so
  // the button can read "Inherit (none)" rather than promising a channel.
  assert.equal(d.defaults.slackChannel, 'C-GLOBAL');
  assert.equal(d.defaults.slackDetail, 'full');
  assert.equal(spaceDetail({ ...RESOLVE, slack: {} }, 'Work').defaults.slackChannel, null);
  // Not a setting and not editable here, but the card needs it: a channel set on a space
  // while Slack is globally off is a control that changes nothing, and the row says so.
  assert.equal(d.effective.slack, true);
  assert.equal(spaceDetail({ ...RESOLVE, slack: {} }, 'Work').effective.slack, false);
});

check('and `Other` is not a space — it is a group the picker offers, with nothing to set', () => {
  assert.equal(spaceDetail(RESOLVE, 'Other'), null);
  assert.equal(spaceDetail(RESOLVE, 'nope'), null);
});

/* ================================ 6. a workspace that is many repos, one answer */

/* `lib/repos.js` made a workspace able to be forty checkouts of one org sharing a single
   tracker, and bc-l853.7 asked whether these five answers should then differ per repo
   inside it. The decision is that they should not — the argument is the block above
   `autoDispatchAllowed`, and the tracker being the trust boundary is the short version.
   What that decision *obliges* is here: one row labelled `climative`, in a panel titled
   "what each repo resolves to", counted as one repo while the answer beside it governed
   forty. The reach of every setting on the card was understated fortyfold on the one
   screen where you decide whether a worker merges its own diff. */

const ORG = path.join(tmp, 'org.dev');
function checkout(name, token) {
  const dir = path.join(ORG, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), token === null ? `serviceName: ${name}\n` : `serviceToken: ${token}\n`);
  return dir;
}
checkout('architecture', 'architecture');
checkout('athena-service', 'as');
// Cloned, approved, and it names no service — so no bead can reach it, and it is not a
// checkout this answer governs.
checkout('nameless', null);

const MANY = {
  workspaces: [{ name: 'org' }, { name: 'solo' }],
  spaces: [{ name: 'Work', workspaces: ['org', 'solo'], autoMerge: false }],
  repos: { org: { root: ORG, default: 'architecture', approved: ['architecture', 'athena-service', 'nameless'] } },
};

check('a row says how many checkouts its single answer governs', () => {
  const byName = Object.fromEntries(spaceDetail(MANY, 'Work').repos.map((r) => [r.name, r]));
  assert.equal(byName.org.checkouts, 2, 'two resolved; the one declaring no token can hold no bead and is not counted');
  assert.equal(byName.org.autoMerge, false, 'and the answer itself is the space`s, for all of them at once');
});

check('and a workspace that is one repo says nothing new, so an old client reads what it always did', () => {
  const solo = spaceDetail(MANY, 'Work').repos.find((r) => r.name === 'solo');
  assert.ok(!('checkouts' in solo), 'absent, not 1 — the same payload every install has ever been sent');
});

check('an approved list that resolved to nothing says 0 rather than falling silent', () => {
  const none = {
    workspaces: [{ name: 'org' }],
    spaces: [{ name: 'Work', workspaces: ['org'] }],
    repos: { org: { root: ORG, approved: ['nameless'] } },
  };
  assert.equal(spaceDetail(none, 'Work').repos[0].checkouts, 0, 'a list where nothing resolved holds no work, and that is worth seeing');
});

check('the five policy answers still take a workspace and nothing finer — the decision, where it can be broken', () => {
  // Not a style rule: an argument added here is a per-repo policy answer, and the moment
  // one exists this panel, the README section and the space details card are all wrong
  // about the unit. Whoever adds it should have to come through this line.
  const { autoDispatchAllowed, autoEndorseAllowed, autoShipAllowed } = spacesMod;
  for (const fn of [autoDispatchAllowed, autoEndorseAllowed, autoShipAllowed, prPolicyFor]) {
    assert.equal(fn.length, 2, `${fn.name} takes (cfg, workspaceName)`);
  }
});

check('and the card draws the count rather than leaving it in the payload', () => {
  const js = read('public/monitor.js');
  assert.match(js, /checkout\$\{r\.checkouts === 1 \? '' : 's'\}, one answer/, 'the row never says what it stands for');
  assert.match(js, /'What each repo resolves to', String\(total\)/, 'the panel still counts one per row');
});

/* ================================================================ the wiring */

check('the page carries the settings card and the gear to admin', () => {
  const html = read('public/monitor.html');
  assert.ok(html.includes('id="gear"'), 'no gear in the top bar');
  assert.ok(html.includes('href="/admin"'), 'the gear points nowhere');
  const js = read('public/monitor.js');
  assert.ok(js.includes('/api/space?space='), 'the page never reads a space');
  assert.ok(js.includes("data-space-set"), 'nothing on the page writes one');
  // The channel is the one control here that is typed rather than pressed, so it has a
  // press of its own that reads the field — and a draft in `state`, because this page
  // repaints off a stream event and a half-typed id in the DOM is one a poll can take.
  assert.ok(js.includes('data-space-channel'), 'no way to send a typed channel');
  assert.ok(js.includes('slackDraft'), 'the typed channel is not held against a repaint');
  const css = read('public/style.css');
  assert.ok(css.includes('.space-channel input'), 'the channel field has no box');
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

const never = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { slackChannel: '' } } });
check('pressing Never writes a channel of "" — the one answer a missing key cannot give', () => {
  assert.deepEqual(never.body.changed, ['slackChannel']);
  assert.equal(never.body.settings.slackChannel, '', 'and comes back as "" rather than as null');
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(onDisk.spaces.find((s) => s.name === 'Work').slackChannel, '', 'the key is on disk, empty');
});

const channel = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { slackChannel: ' C-TYPED ' } } });
check('and a typed channel reaches the running daemon through the resolver, trimmed', () => {
  assert.equal(channel.status, 200);
  // `slack.enabled` is not set on this config, so the resolver still answers null — which
  // is the point: the setting is stored and it is the global switch that gates it.
  assert.equal(live.spaces.find((s) => s.name === 'Work').slackChannel, 'C-TYPED');
  live.slack = { enabled: true, channel: 'C-GLOBAL' };
  assert.equal(slackChannelFor(live, 'alpha'), 'C-TYPED', 'the space beats the global');
  delete live.slack;
});

const badChannel = await call('/api/space', { method: 'POST', body: { space: 'Work', settings: { slackChannel: true } } });
check('a channel that is not a string is a 400 rather than a `true` in the config file', () => {
  assert.equal(badChannel.status, 400);
  assert.equal(live.spaces.find((s) => s.name === 'Work').slackChannel, 'C-TYPED', 'unchanged');
});

/* --------------------------------------------- and the same route, one level down */

const repoOn = await call('/api/space', {
  method: 'POST',
  body: { space: 'Work', workspace: 'alpha', settings: { autoEndorse: true } },
});
check('a `workspace` in the body writes that repo`s own answer, not the space`s', () => {
  assert.equal(repoOn.status, 200);
  assert.deepEqual(repoOn.body.changed, ['autoEndorse']);
  assert.equal(live.autoEndorsePerWorkspace.alpha, true, 'on the object the running daemon holds');
  // The claim through the one resolver every caller uses — bin/file.js and lib/session.js
  // included — rather than through the map it was written into.
  assert.equal(autoEndorseAllowed(live, 'alpha'), true);
  assert.equal(autoEndorseAllowed(live, 'beta'), false, 'and the repo beside it in the same space is untouched');
  assert.ok(!('autoEndorse' in live.spaces.find((s) => s.name === 'Work')), 'the space itself said nothing');
});

check('the reply is the whole card, so the row that was pressed redraws with the rest', () => {
  const byName = Object.fromEntries(repoOn.body.repos.map((r) => [r.name, r]));
  assert.equal(byName.alpha.own.autoEndorse, true);
  assert.equal(byName.alpha.autoEndorse, true);
  assert.equal(byName.beta.own.autoEndorse, null, 'and Inherit is still the lit button on the other');
  assert.equal(byName.beta.inherits.autoEndorse, false);
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(onDisk.autoEndorsePerWorkspace.alpha, true, 'and it survives a restart');
});

const repoClear = await call('/api/space', {
  method: 'POST',
  body: { space: 'Work', workspace: 'alpha', settings: { autoEndorse: null } },
});
check('clearing a repo puts it back to following the space rather than to off', () => {
  assert.deepEqual(repoClear.body.changed, ['autoEndorse']);
  assert.ok(!('alpha' in live.autoEndorsePerWorkspace), 'the key is gone');
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.ok(!('alpha' in (onDisk.autoEndorsePerWorkspace || {})), 'from the file too');
});

const foreign = await call('/api/space', {
  method: 'POST',
  body: { space: 'Personal', workspace: 'alpha', settings: { autoEndorse: true } },
});
check('a repo that is not in the space named is a 400, not a write nobody could see', () => {
  // The card in front of one space would otherwise be able to change the answer for a
  // repo it does not draw, and there would be nowhere the change showed up.
  assert.equal(foreign.status, 400);
  assert.match(foreign.body.error, /not a repo in Personal/);
  assert.ok(!('alpha' in (live.autoEndorsePerWorkspace || {})));
});

/**
 * The three that joined `autoEndorse` in the per-repo layer, through the route the card
 * presses and then through the resolvers `bin/deliver.js` and `lib/release.js` call.
 *
 * Sent as one body because the card can press one at a time and the wire has to survive
 * both; `changed` comes back in `WORKSPACE_SETTINGS` order rather than the order they
 * arrived in, which is what the screen lists under the control.
 */
const repoShip = await call('/api/space', {
  method: 'POST',
  body: { space: 'Work', workspace: 'alpha', settings: { autoShip: true, autoMerge: false } },
});
check('the answers about landing and shipping write per repo too, and only for that repo', () => {
  assert.equal(repoShip.status, 200);
  assert.deepEqual(repoShip.body.changed, ['autoMerge', 'autoShip']);
  assert.equal(autoShipAllowed(live, 'alpha'), true, 'on the object the running daemon holds');
  assert.equal(prPolicyFor(live, 'alpha').autoMerge, false);
  assert.equal(autoShipAllowed(live, 'beta'), false, 'and the repo beside it in the same space is untouched');
  assert.equal(prPolicyFor(live, 'beta').autoMerge, true);
  const onDisk = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  assert.equal(onDisk.autoShipPerWorkspace.alpha, true, 'and it survives a restart');
  assert.equal(onDisk.autoMergePerWorkspace.alpha, false);
});

const repoRefused = await call('/api/space', {
  method: 'POST',
  body: { space: 'Work', workspace: 'alpha', settings: { quietHours: null } },
});
check('and a setting that does not resolve per repo is refused rather than stored somewhere odd', () => {
  assert.equal(repoRefused.status, 400);
  assert.match(repoRefused.body.error, /not a per-repo setting/);
  assert.ok(!live.quietHoursPerWorkspace, 'nothing was invented to hold it');
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
await cleanupTmp(tmp);

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n${ran} passed\n`);
process.exit(failures ? 1 : 0);
