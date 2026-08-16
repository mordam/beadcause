#!/usr/bin/env node
/**
 * The dispatcher turns the bead's tier into `--model` at spawn time.
 *
 *     npm test
 *     node test/tiermodel.mjs
 *
 * bc-nc6o.2, the second half of the routing epic. bc-nc6o.1 put a
 * `complexity:low|medium|high` label on the bead and nothing read it; this is the read,
 * and it is the point in the whole epic where a label starts costing money. Four things
 * have to be true and only the first of them is a pure function.
 *
 * 1. **The mapping, including the answers that are not tiers.** `low` and `medium` are
 *    the cheap model, `high` is the expensive one, and *both* ways of failing to name a
 *    tier — naming none, and naming two that contradict each other — land on the
 *    expensive one. The unknown-value case is asserted directly because it is the one an
 *    unlucky typo produces, and rounding `medium-high` to something plausible would hide
 *    it forever.
 * 2. **The flag actually reaches the command line.** The mapping being right is worth
 *    nothing if the model is decided into a variable nobody spends: these checks run the
 *    real `openWorkSession` end to end and read back the *shell command the window would
 *    have run*, which is the only artefact that proves it. See `MIRROR` below for how a
 *    launch is driven without a window appearing on anybody's screen.
 * 3. **Precedence.** `model` is a foundation field, so a routed model is a fourth source
 *    under one key. An amendment Adam approved for this agent by name still wins — both
 *    as a unit (`withModel`) and through a real amendment commit in a real repo, because
 *    the unit test would pass just as happily against a `launch` that never consulted the
 *    foundation at all.
 * 4. **A planner is not routed.** `openPlanSession` opens on an epic, and an epic's tier
 *    is a claim about the work underneath it rather than about the hour spent cutting
 *    that work up. This is the assertion that keeps that a decision rather than a thing
 *    that quietly changes the first time somebody tidies the two call sites together.
 *
 * Nothing here opens a window, reaches the network or touches a real tracker.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const LIB = (name) => path.join(ROOT, 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tiermodel-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// `placement` writes iTerm's dynamic profile before it decides anything, and this suite
// launches for real. Pointed at the scratch tree so a test run never edits the profile
// the machine's own sessions come up on.
process.env.BEADCAUSE_ITERM_PROFILE_DIR = path.join(tmp, 'iterm');
fs.mkdirSync(process.env.BEADCAUSE_ITERM_PROFILE_DIR, { recursive: true });
// The one suite that opts out of the launch guard, and the only one that has earned it:
// `MIRROR` below puts a **stub AppleScript** where `launch` looks for the real one, which
// is a narrower seam than the guard and a better one — it proves what the shell in that
// window would have run rather than merely that no window opened. Every other suite is
// refused at `launch`, on `argv[1]` alone if nobody set anything. See lib/launchguard.js.
process.env.BEADCAUSE_ALLOW_LAUNCH = '1';

const { MODEL_BY_TIER, FALLBACK_MODEL, TIERS, modelForTier, modelForBead } =
  await import(LIB('complexity.js'));
const { baseline, withModel, claudeArgs, AMENDABLE, amend } = await import(LIB('foundation.js'));

/* ------------------------------------------------------------------- the launcher */

/**
 * A copy of `lib/` with a **stub AppleScript** beside it, which is what lets this suite
 * run the real launcher without a window appearing on the screen.
 *
 * `lib/session.js` resolves `scripts/open-session.applescript` off its own location and
 * hands it to `/usr/bin/osascript`, so the only way to intercept the last step is to move
 * the library. A copy is cheap (one `cpSync`) and — this is the reason to prefer it over
 * a source-level assertion — it leaves every other link in the chain real: the real
 * `effective`, the real `withModel`, the real `claudeArgs`, the real `sessionCommand`.
 * What comes back is the exact string the shell in that window would have run.
 *
 * `node_modules` is symlinked in because a scratch directory has none above it, and two
 * modules in the transitive import graph take a bare specifier.
 *
 * The stub returns a session id and does nothing else, so `launch` takes its **success**
 * path — which matters: on success the three temp files are left for the session's own
 * shell to delete, and the command file being still on disk is what this reads.
 */
const MIRROR = path.join(tmp, 'mirror');
fs.mkdirSync(MIRROR);
fs.cpSync(path.join(ROOT, 'lib'), path.join(MIRROR, 'lib'), { recursive: true });
fs.mkdirSync(path.join(MIRROR, 'scripts'));
fs.writeFileSync(
  path.join(MIRROR, 'scripts', 'open-session.applescript'),
  'on run argv\n\treturn "stub-session"\nend run\n'
);
fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(MIRROR, 'node_modules'));

const { openWorkSession, openPlanSession, sessionCommand } = await import(path.join(MIRROR, 'lib', 'session.js'));

/** Where the launcher's three temp files land, so the command file can be read back. */
const SPOOL = path.join(tmp, 'spool');
fs.mkdirSync(SPOOL);
process.env.TMPDIR = SPOOL;

/** The checkout the window opens in. A real git repo, because the amendment test needs one. */
const CHECKOUT = path.join(tmp, 'checkout');
fs.mkdirSync(CHECKOUT);
const git = (...args) => execFileSync('git', args, { cwd: CHECKOUT, stdio: 'pipe' });
git('init', '-q');
git('config', 'user.name', 'beadcause test');
git('config', 'user.email', 'test@example.invalid');

const cfg = {
  sessionDirs: { demo: CHECKOUT },
  openSessions: true,
  // `prMode` shells out to `gh` otherwise, and what the brief says about pull requests is
  // not what this file is about.
  pr: { enabled: false },
  // `layout: false` skips the screen probe, and `stealFocus` skips asking which app is
  // frontmost and putting it back — two AppleScript round trips that would touch the
  // machine this is running on for no gain here.
  sessionWindows: { layout: false, stealFocus: true },
};
const ws = { name: 'demo', dir: CHECKOUT };

/** A tracker that answers `show` with one row, which is all the launcher asks it. */
const trackerSaying = (row) => ({ show: async () => row });

/** The `claude …` line the window would have run, read off the command file just written. */
function commandOf() {
  const files = fs.readdirSync(SPOOL).filter((f) => f.startsWith('beadcause-cmd-'));
  assert.equal(files.length, 1, `expected one command file, found ${files.length}`);
  const text = fs.readFileSync(path.join(SPOOL, files[0]), 'utf8');
  for (const f of fs.readdirSync(SPOOL)) fs.rmSync(path.join(SPOOL, f), { force: true });
  return text;
}

/** Open a work session on a bead carrying these labels, and hand back both halves. */
async function launchOn(id, labels, opts = {}) {
  const row = { id, title: `bead ${id}`, status: 'open', labels, ...opts };
  const opened = await openWorkSession(cfg, ws, { id, title: row.title }, { bd: trackerSaying(row) });
  return { opened, command: commandOf() };
}

/* --------------------------------------------------------------------- harness */

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
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

console.log('\nthe dispatcher turns the bead\'s tier into --model at spawn time\n');

/* --------------------------------------------------------------------- the mapping */

await check('two tiers buy the cheap model and one buys the expensive one', () => {
  assert.deepEqual(MODEL_BY_TIER, { low: 'sonnet', medium: 'sonnet', high: 'opus' });
  assert.deepEqual(Object.keys(MODEL_BY_TIER), TIERS, 'every tier is routed, and nothing else is');
  assert.equal(modelForTier('low'), 'sonnet');
  assert.equal(modelForTier('medium'), 'sonnet', 'medium is the ordinary bead, not a middle model');
  assert.equal(modelForTier('high'), 'opus');
});

await check('anything that is not a tier takes the expensive fallback', () => {
  assert.equal(FALLBACK_MODEL, 'opus', 'the fallback is the expensive one — see lib/complexity.js');
  assert.equal(modelForTier(''), FALLBACK_MODEL, 'the unrated bead, which is most of the tracker');
  assert.equal(modelForTier(null), FALLBACK_MODEL);
  assert.equal(modelForTier(undefined), FALLBACK_MODEL);
  // The unknown-value case, and it is the one worth naming: a proposal that said
  // `complexity: medium-high` files unrated, so the router must not round it to `medium`
  // and spend the cheap model on a bead nobody managed to rate.
  assert.equal(modelForTier('medium-high'), FALLBACK_MODEL);
  assert.equal(modelForTier('trivial'), FALLBACK_MODEL);
  assert.equal(modelForTier('HIGH'), 'opus', 'though a tier is still a tier however it was typed');
});

await check('modelForBead answers with the model, the tier it routed by, and any problem', () => {
  assert.deepEqual(modelForBead({ labels: ['complexity:low'] }), { model: 'sonnet', tier: 'low', problem: null });
  assert.deepEqual(modelForBead({ labels: ['complexity:high'] }), { model: 'opus', tier: 'high', problem: null });
  assert.deepEqual(
    modelForBead({ labels: ['repo:as', 'agent-filed'] }),
    { model: 'opus', tier: '', problem: null },
    'an unrated bead is a real answer and not a problem'
  );
  assert.deepEqual(modelForBead(null), { model: 'opus', tier: '', problem: null });
});

await check('a bead nobody can route on says so, and still gets a model', () => {
  const two = modelForBead({ labels: ['complexity:low', 'complexity:high'] });
  assert.equal(two.model, 'opus', 'contradictory labels must not fall to the cheap side');
  assert.equal(two.tier, null);
  assert.match(two.problem, /2 complexity tiers/);

  const bad = modelForBead({ labels: ['complexity:enormous'] });
  assert.equal(bad.model, 'opus');
  assert.match(bad.problem, /names no tier/);
});

/* ------------------------------------------------------------------- the flag */

await check('a foundation with a model renders it as --model, quoted for the shell', () => {
  const args = claudeArgs({ ...baseline('worker'), model: 'sonnet' });
  assert.ok(args.includes('--model'), args.join(' '));
  assert.equal(args[args.indexOf('--model') + 1], `'sonnet'`);
  assert.ok(!claudeArgs(baseline('worker')).includes('--model'), 'and nothing at all when none was set');
});

/* --------------------------------------------------------------- the door itself */

await check('a complexity:low bead spawns with --model sonnet', async () => {
  const { opened, command } = await launchOn('zz-low', ['complexity:low']);
  assert.match(command, /--model 'sonnet'/, command.slice(0, 400));
  assert.equal(opened.model, 'sonnet', 'and the launch reports it back for the card');
  assert.equal(opened.tier, 'low', 'beside the tier it was routed by, which is what makes it readable');
});

await check('a complexity:medium bead spawns with --model sonnet too', async () => {
  const { command } = await launchOn('zz-mid', ['complexity:medium', 'repo:demo']);
  assert.match(command, /--model 'sonnet'/);
});

await check('a complexity:high bead spawns with --model opus', async () => {
  const { opened, command } = await launchOn('zz-high', ['complexity:high']);
  assert.match(command, /--model 'opus'/);
  assert.equal(opened.model, 'opus');
  assert.equal(opened.tier, 'high');
});

await check('an untiered bead spawns with --model opus, and says nothing about it', async () => {
  const warned = [];
  const real = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    var { opened, command } = await launchOn('zz-none', ['agent-filed']);
  } finally {
    console.warn = real;
  }
  assert.match(command, /--model 'opus'/);
  assert.equal(opened.tier, '', 'an unrated bead is not a problem, it is the common case');
  // The quiet half of the acceptance, and it is deliberate: most of the tracker is
  // unrated, so a line per launch saying so would be a warning nobody could act on.
  assert.deepEqual(warned, [], `nothing was logged, but got: ${warned.join(' | ')}`);
});

await check('a bead whose labels contradict each other opens on opus and is said out loud', async () => {
  const warned = [];
  const real = console.warn;
  console.warn = (...a) => warned.push(a.join(' '));
  try {
    var { command } = await launchOn('zz-both', ['complexity:low', 'complexity:high']);
  } finally {
    console.warn = real;
  }
  assert.match(command, /--model 'opus'/);
  assert.equal(warned.length, 1, `expected one line, got ${warned.length}`);
  assert.match(warned[0], /zz-both/, 'and it names the bead, because the fix is on the bead');
  assert.match(warned[0], /2 complexity tiers/);
  assert.match(warned[0], /opus/, 'and says what it did rather than only what was wrong');
});

await check('the tier comes off the tracker row, not off the queue row handed in', async () => {
  // The advocate's queue row is a title and an id; the labels come from the `bd show` the
  // endorsement gate already paid for. A tier corrected since the survey ran is the case
  // this exists for, and passing the caller's object through would silently miss it.
  const bd = trackerSaying({ id: 'zz-late', title: 'rated since', status: 'open', labels: ['complexity:low'] });
  await openWorkSession(cfg, ws, { id: 'zz-late', title: 'rated since', labels: ['complexity:high'] }, { bd });
  assert.match(commandOf(), /--model 'sonnet'/, 'the tracker won, not the stale row');
});

/* --------------------------------------------------------------------- precedence */

await check('withModel applies a routed model, and leaves everything else alone', () => {
  assert.ok(AMENDABLE.includes('model'), 'model is amendable — which is the whole reason for the order below');
  const f = { ...baseline('worker'), amended: [] };
  assert.equal(withModel(f, 'sonnet').model, 'sonnet');
  assert.equal(withModel(f, null), f, 'nothing routed is a no-op, not a null model');
  assert.equal(withModel(f, ''), f);
  assert.equal(f.model, null, 'and the foundation it was handed is not mutated');
});

await check('an approved amendment wins over the tier, because Adam approved it by name', () => {
  const amended = { ...baseline('worker'), model: 'haiku', amended: ['model'] };
  assert.equal(withModel(amended, 'sonnet').model, 'haiku');
  // The other direction, so this is a rule about `model` and not about `amended` being
  // non-empty: an agent amended somewhere else is still routed by its bead.
  const elsewhere = { ...baseline('worker'), amended: ['role'] };
  assert.equal(withModel(elsewhere, 'sonnet').model, 'sonnet');
});

await check('and it wins through a real amendment, all the way to the command line', async () => {
  await amend(CHECKOUT, 'worker', { model: 'haiku' }, {
    bead: 'zz-amend',
    justification: 'the test approved it',
    by: 'test',
  });
  const { opened, command } = await launchOn('zz-easy2', ['complexity:low']);
  assert.match(command, /--model 'haiku'/, 'the tier said sonnet and the amendment said otherwise');
  assert.ok(!/--model 'sonnet'/.test(command));
  assert.equal(opened.model, 'haiku', 'and the card is told what actually went on the command line');
  assert.equal(opened.tier, 'low', 'while the tier still says what it would have been routed by');
});

/* ----------------------------------------------------------------- not the planner */

await check('a planner is not routed by the tier of the epic it is planning', async () => {
  // Deliberate, and asserted so it stays deliberate: an epic's tier is a claim about the
  // work underneath it, not about the hour spent deciding how to cut that work up. The
  // amendment above is still in force, which is why this looks for the absence of a
  // *routed* model rather than the absence of the flag.
  const epic = { id: 'zz-epic', title: 'an epic', status: 'open', issue_type: 'epic', labels: ['complexity:low'] };
  const opened = await openPlanSession(cfg, ws, { id: 'zz-epic', title: 'an epic' }, {
    kids: [],
    bd: trackerSaying(epic),
  });
  const command = commandOf();
  assert.ok(!/--model 'sonnet'/.test(command), 'the epic said low and the planner ignored it');
  assert.equal(opened.tier, undefined, 'a planner reports no tier at all, rather than an empty one');
});

/* -------------------------------------------------- and where the card reads it */

await check('the advocate records what it opened the window on, and puts it on the card', async () => {
  // The other half of the acceptance, and the half a launch cannot prove on its own: the
  // model is decided in a second and the window then runs for an hour, so "what is this
  // session costing" has to be answerable from the card while it is still running. The
  // bead does not carry it — what the run *actually* used is bc-nc6o.3, off the finished
  // session — so this record is the only place the selection is readable in the meantime.
  const { createAdvocates } = await import(LIB('advocate.js'));
  const REPO = path.join(tmp, 'advocate-repo');
  fs.mkdirSync(REPO, { recursive: true });
  const acfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'alpha',
    spaces: [],
    workspaces: [{ name: 'alpha', dir: path.join(tmp, 'alpha-beads') }],
    sessionDirs: { alpha: REPO },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 3,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      // Every one of these has a suite of its own and would otherwise run real git, a
      // real `gh` or a real agent against a scratch directory on every tick.
      propose: false,
      tidyWorktrees: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      holdOpenPrs: false,
      sessionLog: false,
      planEpics: false,
    },
  };
  const ready = [{ id: 'zz-card', title: 'a rated bead', priority: 2, labels: ['complexity:low'] }];
  const bd = {
    ready: async () => ready,
    listLabel: async () => [],
    show: async (_ws, id) => ({ id, status: 'in_progress', labels: ['complexity:low'] }),
    children: async () => [],
    listStatus: async () => [],
    addLabel: async () => {},
    removeLabel: async () => {},
  };
  const advocates = createAdvocates(acfg, {
    bd,
    bus: { emit() {} },
    // Exactly what `openWorkSession` returns, which the checks above have already pinned
    // to the command line — so this stub can only be wrong in the direction of being out
    // of date with a shape those would have caught.
    open: async () => ({ dir: REPO, mode: 'test', term: null, model: 'sonnet', tier: 'low' }),
    prs: async () => ({ ok: true, reason: '', checked: 0, beads: new Map() }),
  });
  await advocates.tick();
  const card = advocates.snapshot().find((a) => a.workspace === 'alpha');
  assert.ok(card, 'the advocate ran');
  const worker = (card.workers || []).find((w) => w.id === 'zz-card');
  assert.ok(worker, `no worker on the card: ${JSON.stringify(card.workers)}`);
  assert.equal(worker.model, 'sonnet');
  assert.equal(worker.tier, 'low', 'the tier travels beside it — "opus" alone cannot be read');
});

console.log(`\n${failures ? `${failures} of ${ran} failed` : `all ${ran} checks passed`}`);
await cleanupTmp(tmp);
process.exit(failures ? 1 : 0);
