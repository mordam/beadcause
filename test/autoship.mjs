#!/usr/bin/env node
/**
 * Auto-ship — a merge that deploys itself, and everything that stops it doing so twice.
 *
 *     npm test
 *     node test/autoship.mjs
 *
 * `test/release.mjs` proves the queue and the bead per merge; this is what happens when
 * nobody is going to press the button. The failures it is written against are the ones
 * you would only find in production, at three in the morning, on the daemon this deploy
 * restarts:
 *
 * 1. **A deploy per merge.** Four merges in ten minutes is four restarts of the server
 *    you are reading the notification on. They have to be one, which is what the settle
 *    window is for — and a window that resets on every arrival never closes at all.
 * 2. **A retry loop.** A deploy that fails leaves its merges owed, so the naive sweep
 *    finds them again five minutes later and runs the failing deploy again, forever,
 *    unattended. One attempt per merge is enforced in the ledger and stamped *before*
 *    the deploy starts, because a beadcause deploy kills the process that started it.
 * 3. **Shipping something that was held back.** An epic saying `no-auto-ship` on a space
 *    that ships is the whole point of the override, and a bug there deploys the migration
 *    somebody deliberately parked.
 * 4. **Guessing when the tracker cannot answer.** Dolt is single-writer and six sessions
 *    share it. "I could not read the epic" must fall through to *nothing*, never to the
 *    space's own answer.
 * 5. **A bead that lies.** With auto-ship on, a ship bead saying "shipping is your tap"
 *    describes something waiting for you when nothing is.
 * 6. **A stowaway.** The window closes over a batch and the deploy fast-forwards to the
 *    branch a minute later — so a merge that landed in between goes out under a deploy
 *    that never considered it, with no bead stamped and nothing saying it shipped. The
 *    fix is that closing the window captures a commit; the test is that the commit is
 *    the one the branch was at *then*, not the one it reached afterwards.
 *
 * Nothing here deploys anything: `ship` is a stub that records what it was called with,
 * which is exactly the seam lib/release.js takes it through.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-autoship-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const { AUTO_SHIP_LABEL, NO_AUTO_SHIP_LABEL, opinionOf, opinionAbove, resolveAutoShip } = await import(
  LIB('autoship.js')
);
const { autoShipAllowed, SETTINGS, readSettings, applySettings, spaceDetail } = await import(LIB('spaces.js'));
const { LEDGER_PATH, loadLedger, markerOf, sweepReleases } = await import(LIB('release.js'));

const WS = { name: 'demo', dir: path.join(tmp, 'beads-demo') };

/* ===================================================================== the opinion */

console.log('\nwhat one bead says\n');

await check(() => assert.equal(opinionOf({ labels: [AUTO_SHIP_LABEL] }), true), '`auto-ship` says yes');
await check(() => assert.equal(opinionOf({ labels: [NO_AUTO_SHIP_LABEL] }), false), '`no-auto-ship` says no');
await check(() => assert.equal(opinionOf({ labels: ['ship', 'human'] }), null), 'anything else says nothing at all');
await check(() => assert.equal(opinionOf(null), null), 'and so does a bead that is not there');
await check(
  () => assert.equal(opinionOf({ labels: [AUTO_SHIP_LABEL, NO_AUTO_SHIP_LABEL] }), false),
  'a bead carrying both lands on the side that waits for a tap, not on a coin toss'
);

/* ====================================================================== the walk */

console.log('\nwalking up to the epic\n');

/** A tracker of beads by id, each with `labels` and `parent`, that counts its lookups. */
function beads(rows) {
  const by = new Map(rows.map((r) => [r.id, r]));
  const t = {
    lookups: 0,
    show: async (ws, id) => {
      t.lookups += 1;
      if (t.broken) throw new Error('database is busy');
      return by.get(id) || null;
    },
  };
  return t;
}

const chain = () =>
  beads([
    { id: 'zz-epic', issue_type: 'epic', labels: [NO_AUTO_SHIP_LABEL] },
    { id: 'zz-epic.1', parent: 'zz-epic', labels: [] },
    { id: 'zz-epic.1.1', parent: 'zz-epic.1', labels: [] },
    { id: 'zz-loose', labels: [] },
  ]);

await check(async () => {
  const found = await opinionAbove(chain(), WS, 'zz-epic.1.1');
  assert.deepEqual(found, { value: false, from: 'zz-epic' });
}, 'a bead two levels down finds the epic above it');

await check(async () => {
  const bd = beads([
    { id: 'zz-epic', labels: [NO_AUTO_SHIP_LABEL] },
    { id: 'zz-epic.1', parent: 'zz-epic', labels: [AUTO_SHIP_LABEL] },
  ]);
  const found = await opinionAbove(bd, WS, 'zz-epic.1');
  assert.deepEqual(found, { value: true, from: 'zz-epic.1' });
}, 'and the nearest opinion wins — the exception written on the work beats the rule above it');

await check(async () => assert.equal(await opinionAbove(chain(), WS, 'zz-loose'), null), 'a bead under nothing says nothing');
await check(async () => assert.equal(await opinionAbove(chain(), WS, 'zz-gone'), null), 'and so does an id the tracker has never heard of');

await check(async () => {
  const bd = beads([
    { id: 'zz-a', parent: 'zz-b', labels: [] },
    { id: 'zz-b', parent: 'zz-a', labels: [] },
  ]);
  assert.equal(await opinionAbove(bd, WS, 'zz-a'), null);
}, 'a parent cycle ends the walk instead of the process');

await check(async () => {
  const bd = chain();
  const seen = new Map();
  await opinionAbove(bd, WS, 'zz-epic.1', { seen });
  const first = bd.lookups;
  await opinionAbove(bd, WS, 'zz-epic.1', { seen });
  assert.equal(bd.lookups, first);
}, 'the memo means four merges under one epic walk it once');

/* ================================================================== the verdict */

console.log('\nwho decides, space or epic\n');

const cfgWith = (over = {}) => ({ workspaces: [WS], spaces: [{ name: 'Personal', workspaces: ['demo'] }], ...over });
const spaceSays = (v) => ({ workspaces: [WS], spaces: [{ name: 'Personal', workspaces: ['demo'], autoShip: v }] });

const prRow = (ids = []) => ({ number: 1, beads: ids.map((id) => ({ id, title: '', status: 'open' })) });

await check(async () => {
  const v = await resolveAutoShip(chain(), cfgWith(), WS, prRow(['zz-loose']));
  assert.deepEqual([v.auto, v.known], [false, true]);
}, 'off by default: a merge waits for the button, which is what every install does today');

await check(async () => {
  const v = await resolveAutoShip(chain(), cfgWith({ release: { autoShip: true } }), WS, prRow(['zz-loose']));
  assert.equal(v.auto, true);
}, 'the global default turns it on where no space overrides it');

await check(async () => {
  const v = await resolveAutoShip(chain(), { ...cfgWith({ release: { autoShip: true } }), ...spaceSays(false) }, WS, prRow(['zz-loose']));
  assert.equal(v.auto, false);
}, 'and a space saying no beats a global saying yes');

await check(async () => {
  const v = await resolveAutoShip(chain(), spaceSays(true), WS, prRow(['zz-epic.1']));
  assert.deepEqual([v.auto, v.known], [false, true]);
}, 'an epic saying `no-auto-ship` holds its work back on a space that ships');

await check(async () => {
  const bd = beads([{ id: 'zz-hot', labels: [AUTO_SHIP_LABEL] }]);
  const v = await resolveAutoShip(bd, spaceSays(false), WS, prRow(['zz-hot']));
  assert.equal(v.auto, true);
}, 'and one saying `auto-ship` ships on a space that does not');

await check(async () => {
  const bd = beads([
    { id: 'zz-hot', labels: [AUTO_SHIP_LABEL] },
    { id: 'zz-held', labels: [NO_AUTO_SHIP_LABEL] },
  ]);
  const v = await resolveAutoShip(bd, spaceSays(true), WS, prRow(['zz-hot', 'zz-held']));
  assert.equal(v.auto, false);
}, 'a pull request delivering two beads is held by either of them — not by whichever resolved first');

await check(async () => {
  const bd = chain();
  bd.broken = true;
  const v = await resolveAutoShip(bd, spaceSays(true), WS, prRow(['zz-epic.1']));
  assert.deepEqual([v.auto, v.known], [false, false]);
  assert.match(v.why, /could not read/);
}, 'a tracker mid-write is `known: false` — never the space’s answer, because that one deploys');

await check(async () => {
  const v = await resolveAutoShip(chain(), spaceSays(true), WS, prRow([]));
  assert.deepEqual([v.auto, v.known], [true, true]);
}, 'a merge naming no bead is the space’s to decide, and it says so');

/* =============================================================== the space setting */

console.log('\nthe setting on the space\n');

await check(() => assert.ok(SETTINGS.includes('autoShip')), '`autoShip` is a setting the details screen may write');
await check(() => assert.equal(readSettings({}).autoShip, null), 'unset reads as null, which is "inherit"');
await check(() => assert.equal(readSettings({ autoShip: false }).autoShip, false), 'and off reads as off — the two are different answers');
await check(() => assert.equal(readSettings({ autoShip: 'yes' }).autoShip, null), 'a value that is not a boolean inherits rather than being believed');

await check(() => {
  const space = { name: 'Personal', workspaces: ['demo'] };
  assert.deepEqual(applySettings(space, { autoShip: true }), ['autoShip']);
  assert.equal(space.autoShip, true);
  assert.deepEqual(applySettings(space, { autoShip: null }), ['autoShip']);
  assert.equal('autoShip' in space, false);
}, 'setting it writes it, and null deletes the key — the only way back to the default');

await check(() => assert.throws(() => applySettings({}, { autoShip: 'on' }), /true, false or null/), 'and anything else is refused rather than dropped');

await check(() => {
  const d = spaceDetail({ ...spaceSays(true), workspaces: [WS] }, 'Personal');
  assert.equal(d.settings.autoShip, true);
  assert.equal(d.defaults.autoShip, false);
  assert.equal(d.repos[0].autoShip, true);
}, 'the details screen gets what the space says, what it would inherit, and what the repo resolves to');

await check(() => assert.equal(autoShipAllowed({ workspaces: [WS] }, 'demo'), false), 'a workspace in no space at all follows the global, which is off');

/* ============================================================ and the repo under it */

console.log('\nthe setting on the repo, which outranks the space\n');

/**
 * The level this setting most needed, and the one that made the whole layer worth
 * generalising: the Personal space here is six repos and exactly one of them has a
 * deploy this Mac can run, so saying "ships itself" through the space armed five repos
 * nobody had asked about.
 *
 * Read through `autoShipAllowed` rather than the map, because that is the function
 * lib/release.js and lib/autoship.js call — a test that read `cfg.autoShipPerWorkspace`
 * would pass over a resolver that had stopped consulting it.
 */
const repoSays = (v, space) => ({
  ...spaceSays(space),
  ...(v === null ? {} : { autoShipPerWorkspace: { demo: v } }),
});

await check(() => {
  assert.equal(autoShipAllowed(repoSays(true, false), 'demo'), true);
  assert.equal(autoShipAllowed(repoSays(false, true), 'demo'), false);
}, 'the repo beats its space in both directions, which is what "off everywhere except this one" needs');

await check(() => {
  const cfg = repoSays(true, undefined);
  assert.equal(autoShipAllowed(cfg, 'demo'), true, 'the repo that asked ships');
  assert.equal(autoShipAllowed(cfg, 'sibling'), false, 'and the one beside it in the same space does not');
}, 'and only that repo — the reason this is not a space setting');

await check(() => {
  assert.equal(autoShipAllowed({ ...spaceSays(true), autoShipPerWorkspace: { demo: 'yes' } }, 'demo'), true);
  assert.equal(autoShipAllowed({ ...spaceSays(undefined), autoShipPerWorkspace: { demo: 'yes' } }, 'demo'), false);
}, 'an override that is not a real boolean inherits rather than being believed');

await check(() => {
  const cfg = { ...repoSays(true, undefined), workspaces: [WS, { name: 'sibling' }] };
  cfg.spaces[0].workspaces = ['demo', 'sibling'];
  const byName = Object.fromEntries(spaceDetail(cfg, 'Personal').repos.map((r) => [r.name, r]));
  assert.equal(byName.demo.autoShip, true, 'the resolved answer the tag draws');
  assert.equal(byName.demo.own.autoShip, true, 'the button that is lit');
  assert.equal(byName.demo.inherits.autoShip, false, 'and what Inherit would mean if it were pressed');
  assert.equal(byName.sibling.own.autoShip, null, 'the repo beside it lights Inherit, not Off');
}, 'the repo row carries all three claims a three-state control is made of');

await check(async () => {
  // The whole chain, in the order lib/release.js walks it: the epic still has the last
  // word, because "hold this migration back" has to survive a repo that ships by default.
  const cfg = repoSays(true, undefined);
  const held = await resolveAutoShip(chain(), cfg, WS, prRow(['zz-epic.1']));
  assert.deepEqual([held.auto, held.known], [false, true]);
  assert.match(held.why, /holds its work back/);
  const sent = await resolveAutoShip(chain(), cfg, WS, prRow(['zz-loose']));
  assert.deepEqual([sent.auto, sent.known], [true, true], 'and with no opinion above it the repo answers');
}, 'a bead that says no still beats a repo that ships itself');

/* ================================================================ the settle window */

console.log('\none deploy, however many merges\n');

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();

const row = (over = {}) => ({
  number: 1,
  title: 'zz-work: something small',
  url: 'https://github.com/acme/demo/pull/1',
  base: 'main',
  branch: 'worktree-something-work',
  author: 'someone',
  state: 'MERGED',
  merged: true,
  pushed: true,
  local: true,
  deployed: null,
  deployTracked: false,
  deployDeclared: true,
  mergeCommit: 'a'.repeat(40),
  mergedAt: new Date().toISOString(),
  beads: [{ id: 'zz-loose', title: '', status: 'open' }],
  ...over,
});

const card = (over = {}) => ({
  workspace: 'demo',
  repo: 'acme/demo',
  base: 'main',
  error: null,
  deployTracked: false,
  deployDeclared: true,
  deployHint: 'runs `writer`',
  prs: [row()],
  ...over,
});

/** The tracker lib/release.js files into, plus the `show` the walk needs. */
function tracker(rows = []) {
  const known = new Map(rows.map((r) => [r.id, r]));
  const t = {
    created: [],
    closed: [],
    beads: [],
    n: 0,
    listLabel: async (ws, label) => t.beads.filter((b) => (b.labels || []).includes(label)),
    show: async (ws, id) => known.get(id) || null,
    create: async (ws, spec) => {
      t.n += 1;
      const id = `zz-ship-${t.n}`;
      t.created.push({ id, spec });
      t.beads.push({ id, description: spec.body, labels: spec.labels, status: 'open' });
      return id;
    },
    close: async (ws, id) => {
      t.closed.push(id);
      t.beads = t.beads.filter((b) => b.id !== id);
    },
  };
  return t;
}

/** Records the deploys it was asked for instead of starting any. */
function shipper() {
  const s = {
    calls: [],
    fn: async (ws, queue, opts) => {
      s.calls.push({ workspace: ws.name, numbers: opts.numbers, count: queue.count, pin: opts.pin ?? null });
      if (s.fails) throw new Error('launchctl said no');
      return { id: `d-${s.calls.length}` };
    },
  };
  return s;
}

const ON = { workspaces: [WS], spaces: [{ name: 'Personal', workspaces: ['demo'], autoShip: true }], release: { beads: true } };
const forget = () => fs.rmSync(LEDGER_PATH, { force: true });
const MINUTE = 60000;

/* The window: arm, join, fire once. */
forget();
{
  const bd = tracker();
  const s = shipper();
  const t0 = Date.now();
  const sweep = (prs, at, cfg = ON) =>
    sweepReleases(bd, cfg, { repos: [card({ prs })] }, { deploys: [], now: at, ship: s.fn });

  // The watermark: nothing merged yet, nothing filed, nothing armed.
  await sweep([], t0);

  const first = await sweep([row({ number: 4 })], t0 + MINUTE);
  await check(() => assert.equal(s.calls.length, 0), 'the first merge deploys nothing on sight');
  await check(() => assert.equal(first.armed[0]?.workspace, 'demo'), 'it arms the settle window instead');
  await check(() => assert.ok(loadLedger().demo.armedAt), 'and the window lives in the ledger, so the deploy it waits for cannot lose it');
  await check(() => assert.equal(bd.created.length, 1), 'the ship bead is still filed, exactly as it is today');
  await check(
    () => assert.match(bd.created[0].spec.body, /ships itself/),
    'and it says so, rather than promising a tap that nothing is waiting for'
  );

  const armedAt = loadLedger().demo.armedAt;
  const second = await sweep([row({ number: 4 }), row({ number: 5 })], t0 + 5 * MINUTE);
  await check(() => assert.equal(s.calls.length, 0), 'a merge arriving inside the window deploys nothing either');
  await check(() => assert.equal(loadLedger().demo.armedAt, armedAt), 'and does not push the window back — it joins the batch');
  await check(() => assert.equal(second.armed.length, 0), 'an armed workspace is not re-armed');

  await sweep([row({ number: 4 }), row({ number: 5 })], t0 + 12 * MINUTE);
  await check(() => assert.equal(s.calls.length, 1), 'when the window closes, one deploy');
  await check(() => assert.deepEqual(s.calls[0].numbers.sort(), [4, 5]), 'carrying both merges');
  await check(() => assert.equal(s.calls[0].count, 2), 'and the queue it was given is the whole of what it makes live');
  await check(() => assert.equal(loadLedger().demo.armedAt, null), 'the window is disarmed by firing');
  await check(() => assert.ok(loadLedger().demo.handled['4'].autoShipAt), 'and every merge in the batch is stamped as tried');

  // The merges are still owed — nothing has reported a successful deploy — which is
  // exactly the state a naive sweep would fire on again.
  await sweep([row({ number: 4 }), row({ number: 5 })], t0 + 30 * MINUTE);
  await check(() => assert.equal(s.calls.length, 1), 'a merge already tried never arms the window again — there is no retry loop here');

  const late = await sweep([row({ number: 4 }), row({ number: 5 }), row({ number: 6 })], t0 + 31 * MINUTE);
  await check(() => assert.equal(s.calls.length, 1), 'a merge arriving after the deploy started does not extend it into a second one');
  await check(() => assert.deepEqual(late.armed[0]?.numbers, [6]), 'it starts a window of its own instead, for itself alone');
  await check(async () => {
    await sweep([row({ number: 4 }), row({ number: 5 }), row({ number: 6 })], t0 + 45 * MINUTE);
    assert.equal(s.calls.length, 2);
    assert.deepEqual(s.calls[1].numbers, [6]);
  }, 'which fires on its own clock, for the one merge nobody has tried');
}

/* A failed deploy: the beads stay, the button stays, and nothing tries again. */
forget();
{
  const bd = tracker();
  const s = shipper();
  s.fails = true;
  const t0 = Date.now();
  const sweep = (prs, at) => sweepReleases(bd, ON, { repos: [card({ prs })] }, { deploys: [], now: at, ship: s.fn });

  await sweep([], t0);
  await sweep([row({ number: 7 })], t0 + MINUTE);
  const fired = await sweep([row({ number: 7 })], t0 + 12 * MINUTE);
  await check(() => assert.equal(s.calls.length, 1), 'the deploy is attempted once');
  await check(() => assert.match(fired.skipped.join(' '), /auto-ship did not start/), 'and its refusal is reported rather than thrown');
  await check(() => assert.match(fired.skipped.join(' '), /Ship still works/), 'saying what is left, which is the button that was always there');
  await check(() => assert.equal(bd.closed.length, 0), 'the ship bead stays open, because nothing shipped');

  await sweep([row({ number: 7 })], t0 + 40 * MINUTE);
  await check(() => assert.equal(s.calls.length, 1), 'and the failure is never retried unattended against a thing that restarts the server');
}

/* Off: byte for byte what it does today. */
forget();
{
  const bd = tracker();
  const s = shipper();
  const t0 = Date.now();
  const OFF = { ...ON, spaces: [{ name: 'Personal', workspaces: ['demo'], autoShip: false }] };
  const sweep = (prs, at) => sweepReleases(bd, OFF, { repos: [card({ prs })] }, { deploys: [], now: at, ship: s.fn });

  await sweep([], t0);
  await sweep([row({ number: 8 })], t0 + MINUTE);
  await sweep([row({ number: 8 })], t0 + 40 * MINUTE);
  await check(() => assert.equal(s.calls.length, 0), 'with auto-ship off, nothing deploys itself');
  await check(() => assert.equal(loadLedger().demo.armedAt ?? null, null), 'and no window is ever armed');
  await check(() => assert.equal(bd.created.length, 1), 'the bead is filed the way it always was');
  await check(() => assert.match(bd.created[0].spec.body, /shipping is/), 'and it still says the tap is yours');
  await check(() => assert.deepEqual(markerOf(bd.created[0].spec.body), { repo: 'acme/demo', number: 8 }), 'marker and all');
}

/* An epic holding its own work back, on a space that ships everything else. */
forget();
{
  const bd = tracker([{ id: 'zz-risky', issue_type: 'epic', labels: [NO_AUTO_SHIP_LABEL] }]);
  const s = shipper();
  const t0 = Date.now();
  const held = row({ number: 9, beads: [{ id: 'zz-risky', title: 'the migration', status: 'open' }] });
  const sweep = (prs, at) => sweepReleases(bd, ON, { repos: [card({ prs })] }, { deploys: [], now: at, ship: s.fn });

  await sweep([], t0);
  await sweep([held], t0 + MINUTE);
  await sweep([held], t0 + 40 * MINUTE);
  await check(() => assert.equal(s.calls.length, 0), 'a merge under an epic that says no is not shipped by a space that says yes');
  await check(() => assert.equal(bd.created.length, 1), 'it still gets its bead, and its tap');
  await check(() => assert.match(bd.created[0].spec.body, /shipping is/), 'whose words are the ones for a merge that waits');
}

/* A repo that declares no deploy cannot ship itself, whatever anyone says. */
forget();
{
  const bd = tracker();
  const s = shipper();
  const t0 = Date.now();
  // `deployTracked` so the sweep still files for it — the case this is about is "beadcause
  // can see whether it shipped but cannot make it ship".
  const bare = card({ deployDeclared: false, deployTracked: true, prs: [] });
  const sweep = (prs, at) =>
    sweepReleases(bd, ON, { repos: [{ ...bare, prs }] }, { deploys: [], now: at, ship: s.fn });

  await sweep([], t0);
  await sweep([row({ number: 10, deployDeclared: false })], t0 + MINUTE);
  await sweep([row({ number: 10, deployDeclared: false })], t0 + 40 * MINUTE);
  await check(() => assert.equal(s.calls.length, 0), 'a workspace with no declared deploy is untouched by all of this');
  await check(() => assert.equal(bd.created.length, 1), 'and files its bead to wait for a session, exactly as before');
}

/* ------------------------------------------------- the commit the window closed on */

/**
 * A checkout whose `origin/main` this test can move by hand.
 *
 * `update-ref` rather than a second repo and a real remote: what `pinFor` reads is the
 * remote-tracking ref, and the whole question here is what it said at one instant versus
 * another. A push would prove git's plumbing, which is not in doubt.
 */
function checkout(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.email', 'test@localhost');
  git('config', 'user.name', 'test');
  const commit = (text) => {
    fs.writeFileSync(path.join(dir, 'file'), `${text}\n`);
    git('add', 'file');
    git('commit', '--quiet', '-m', text);
    return git('rev-parse', 'HEAD');
  };
  return { dir, commit, land: (sha) => git('update-ref', 'refs/remotes/origin/main', sha) };
}

forget();
{
  const repo = checkout('pinned');
  const bd = tracker();
  const s = shipper();
  const t0 = Date.now();
  const sweep = (prs, at) =>
    sweepReleases(bd, ON, { repos: [card({ prs, dir: repo.dir })] }, { deploys: [], now: at, ship: s.fn });

  await sweep([], t0);

  const batch = repo.commit('the merges the window is armed for');
  repo.land(batch);
  await sweep([row({ number: 20 })], t0 + MINUTE);
  await check(() => assert.equal(s.calls.length, 0), 'the window arms with nothing pinned — there is nothing to pin yet');

  // What the runner would have raced against: main moves between the sweep that fires
  // and the deploy that fetches. Landed *before* the fire here, which is the harder case
  // — the pin has to be read at the close and not from the batch's own merges.
  await sweep([row({ number: 20 })], t0 + 12 * MINUTE);
  await check(() => assert.equal(s.calls[0]?.pin, batch), 'closing the window deploys the commit the branch was at when it closed');
  await check(
    () => assert.equal(loadLedger().demo.handled['20'].pin, batch),
    'and the ledger records it beside the stamp, in the write that happens before the deploy is spawned'
  );

  const after = repo.commit('a merge that arrived after the window closed');
  repo.land(after);
  await check(() => assert.equal(s.calls[0].pin, batch), 'a commit landing afterwards does not change what the deploy already pinned');

  const next = await sweep([row({ number: 20 }), row({ number: 21 })], t0 + 13 * MINUTE);
  await check(() => assert.deepEqual(next.armed[0]?.numbers, [21]), 'it arms a window of its own');
  await sweep([row({ number: 20 }), row({ number: 21 })], t0 + 25 * MINUTE);
  await check(() => assert.equal(s.calls[1]?.pin, after), 'and rides the next deploy, on the commit that window closes on');
}

/* A repo with no checkout to ask still ships — unpinned is what it always did. */
forget();
{
  const bd = tracker();
  const s = shipper();
  const t0 = Date.now();
  const sweep = (prs, at) => sweepReleases(bd, ON, { repos: [card({ prs, dir: path.join(tmp, 'nothing-here') })] }, { deploys: [], now: at, ship: s.fn });
  await sweep([], t0);
  await sweep([row({ number: 22 })], t0 + MINUTE);
  await sweep([row({ number: 22 })], t0 + 12 * MINUTE);
  await check(() => assert.equal(s.calls.length, 1), 'a pin nobody can read is not a reason to refuse a deploy that would otherwise run');
  await check(() => assert.equal(s.calls[0].pin, null), 'it goes unpinned, which is the fast-forward this always did');
  await check(() => assert.equal(loadLedger().demo.handled['22'].pin, undefined), 'and the ledger says nothing rather than saying null');
}

/* A caller that passes no `ship` cannot auto-ship — which is every existing test. */
forget();
{
  const bd = tracker();
  const t0 = Date.now();
  await sweepReleases(bd, ON, { repos: [card({ prs: [] })] }, { deploys: [], now: t0 });
  const out = await sweepReleases(bd, ON, { repos: [card({ prs: [row({ number: 11 })] })] }, { deploys: [], now: t0 + 40 * MINUTE });
  await check(() => assert.equal(out.armed.length + out.shipped.length, 0), 'no `ship`, no window and no deploy — the feature is opt-in at the seam');
  await check(() => assert.equal(bd.created.length, 1), 'and the queue does everything else it always did');
}

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} passed\x1b[0m\n`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
