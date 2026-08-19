#!/usr/bin/env node
/**
 * A test may not open a window — and the brief it would have written names the right bead.
 *
 *     npm test
 *     node test/launchseam.mjs
 *
 * Two defects that arrived together on 2026-08-14, when `node test/shipbead.mjs` opened a
 * real, unattended Claude Code window. It came up in the suite's own `mkdtemp` directory,
 * which the suite then deleted from under the live session, holding a brief addressed to
 * bead `undefined` over the title `(untitled)`. It could do nothing, and it cost an
 * agent-hour finding that out.
 *
 * **bc-xl7n.42 — nothing stood in front of the side effect.** Nine suites call the real
 * `openWorkSession` / `openPlanSession` with only `bd` stubbed. They pass because a gate
 * throws first, which means the day a gate stops throwing the suite does not go red — it
 * opens the window. The refusal now sits at `launch`, where the osascript call is, rather
 * than at any of the callers: lib/shipbead.js paid for that lesson twice already, and a
 * guarantee every caller has to remember is not one. lib/launchguard.js is the argument;
 * what is asserted here is that both of its layers exist, that the door actually consults
 * it, and that exactly one suite opts out and has a stub AppleScript to justify it.
 *
 * **bc-xl7n.43 — the brief was written off the caller's argument.** `openWorkSession`
 * reads a row from the tracker through four gates and then rendered its brief, its window
 * title and its done-file record off the object the *caller* handed in. A bare id string
 * is something every gate on that path tolerates — they all go through `bd show` — and
 * `'zz-work'.id` is `undefined`. So the checks below hand every door a bare **string** on
 * purpose. A suite that passed a well-formed object would prove nothing: that is exactly
 * the shape that was already passing while the bug was live.
 *
 * The two fixes are one test file because the first is what makes the second testable. A
 * launch that does not happen leaves no window and no command file, so the refusal carries
 * the brief and the tab title it refused — and that is the only way to assert what a door
 * *would* have opened without opening it.
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
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-launchseam-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

/**
 * Where `launch` would write its three temp files, pointed somewhere countable.
 *
 * The refusal is supposed to happen *before* a byte is written, and "before" is not a
 * detail: the incident's window died because the files it depended on were in a directory
 * the suite deleted. An empty spool at the end of the run is the proof, and it is worth
 * more than reading the guard's position in the source.
 */
const SPOOL = path.join(tmp, 'spool');
fs.mkdirSync(SPOOL);
process.env.TMPDIR = SPOOL;

const { NO_LAUNCH, ALLOW_LAUNCH, mayLaunch, startedByASuite, launchRefusal } = await import(
  LIB('launchguard.js')
);
const { openWorkSession, openPlanSession } = await import(LIB('session.js'));

/* ------------------------------------------------------------------- the fixture */

/** The checkout a window would open in. Real, because `resolveSessionRepo` looks. */
const CHECKOUT = path.join(tmp, 'checkout');
fs.mkdirSync(CHECKOUT);
execFileSync('git', ['init', '-q'], { cwd: CHECKOUT, stdio: 'pipe' });

const cfg = {
  sessionDirs: { demo: CHECKOUT },
  openSessions: true,
  // `prMode` shells out to `gh` otherwise, and what the brief says about pull requests is
  // not what this file is about.
  pr: { enabled: false },
  sessionWindows: { layout: false, stealFocus: true },
};
const ws = { name: 'demo', dir: CHECKOUT };

/** An ordinary open bead, fully endorsed — every gate on the path has to pass. */
const workRow = {
  id: 'zz-work',
  title: 'the drawer forgets its scroll position',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  description: 'a bead like any other',
};

const epicRow = { ...workRow, id: 'zz-epic', title: 'an epic worth planning', issue_type: 'epic' };

/** A tracker that answers `show` with one row, which is all the launcher asks it. */
const trackerSaying = (row) => ({ show: async () => row });

/**
 * Drive a door to its refusal and hand back the error.
 *
 * `assert.rejects` cannot do this: what is being asserted is the *content* of the thing
 * that was refused, not merely that something was.
 */
const refusedBy = (fn) => fn().then(() => null, (err) => err);

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

console.log('\na test may not open a window, and the brief names the right bead\n');

/* ================================================ 1. the guard, as a pure function */

await check('layer 1 — a process started on a suite may not launch, and was told nothing', () => {
  assert.equal(startedByASuite(['node', '/repo/test/shipbead.mjs']), true);
  assert.equal(startedByASuite(['node', '/repo/test/deep/helper.mjs']), false, 'one level, not a walk');
  assert.equal(startedByASuite(['node', '/repo/bin/router.js']), false, 'the daemon is not a test');
  assert.equal(startedByASuite(['node', '/repo/scripts/test.mjs']), false, 'the runner itself launches nothing');
  assert.equal(startedByASuite([]), false, 'an argv with nothing in it is not a suite');
  // The whole point of this layer: no env, no cooperation, still refused.
  assert.equal(mayLaunch({}, ['node', '/repo/test/shipbead.mjs']), false);
});

await check('layer 2 — the env var reaches where argv cannot', () => {
  // A daemon spawned by a suite: `argv[1]` says bin/router.js and nothing about it looks
  // like a test. This is the hole layer 1 cannot see, and the reason there are two.
  assert.equal(mayLaunch({}, ['node', '/repo/bin/router.js']), true, 'the daemon must still open windows');
  assert.equal(mayLaunch({ [NO_LAUNCH]: '1' }, ['node', '/repo/bin/router.js']), false);
});

await check('the way out is explicit, and beats both layers', () => {
  assert.equal(mayLaunch({ [ALLOW_LAUNCH]: '1' }, ['node', '/repo/test/tiermodel.mjs']), true);
  assert.equal(mayLaunch({ [ALLOW_LAUNCH]: '1', [NO_LAUNCH]: '1' }, ['node', '/repo/bin/router.js']), true);
  // Nothing is the safe answer only for a process that is neither.
  assert.equal(mayLaunch({}, ['node', '/repo/bin/router.js']), true);
});

await check('the refusal is a 409 with a name on it, not a launch that merely failed', () => {
  const err = launchRefusal('▶ zz-work · demo', 'the brief');
  assert.equal(err.status, 409, 'a refusal is a conflict, not a 500');
  assert.equal(err.noLaunch, true, 'nothing could tell this from iTerm being unreachable');
  assert.equal(err.tabTitle, '▶ zz-work · demo');
  assert.equal(err.prompt, 'the brief');
  assert.match(err.message, /may not open sessions/);
});

/* ============================== 2. the door consults it — no window, nothing written */

await check('openWorkSession refuses at the launch, with every gate above it passing', async () => {
  const err = await refusedBy(() => openWorkSession(cfg, ws, workRow, { bd: trackerSaying(workRow) }));
  assert.ok(err, 'a window was opened by a test run');
  assert.equal(err.noLaunch, true, `refused by something else: ${err.message}`);
  assert.equal(err.status, 409);
});

await check('openPlanSession too — every door into an unattended window, not one', async () => {
  const err = await refusedBy(() => openPlanSession(cfg, ws, epicRow, { bd: trackerSaying(epicRow) }));
  assert.ok(err, 'a planning window was opened by a test run');
  assert.equal(err.noLaunch, true, `refused by something else: ${err.message}`);
});

await check('and it refuses before it writes anything — the spool is still empty', () => {
  // Two launches have now been refused. The incident's window was reading temp files out
  // of a directory its own suite deleted; a guard that fires after they are written would
  // leave the same litter behind on every test run.
  assert.deepEqual(fs.readdirSync(SPOOL), [], 'the refusal happens after the temp files are written');
});

await check('`launch` is the only way to the AppleScript, and the guard is above it', () => {
  const src = read('lib/session.js');
  const uses = src.match(/\[SCRIPT,/g) || [];
  assert.equal(uses.length, 1, 'a second call site opens windows the guard never sees');
  const guard = src.indexOf('assertMayLaunch(');
  assert.ok(guard !== -1, 'lib/session.js does not consult the launch guard at all');
  assert.ok(guard < src.indexOf('[SCRIPT,'), 'the guard is downstream of the thing it guards');
});

/* ========================= 3. the brief is the row's, given a bare id (bc-xl7n.43) */

await check('a bare id string still produces a brief that names the bead', async () => {
  // The shape that opened the useless window: every gate here takes a string, because
  // they all go through `bd show`. Only the brief did not.
  const err = await refusedBy(() => openWorkSession(cfg, ws, 'zz-work', { bd: trackerSaying(workRow) }));
  assert.equal(err.noLaunch, true, `refused by something else: ${err.message}`);
  assert.match(err.prompt, /bd show zz-work/, 'the brief tells the session to look up the wrong bead');
  assert.match(err.prompt, /the drawer forgets its scroll position/, 'the title came off the caller, not the row');
  assert.ok(!/undefined/.test(err.prompt), 'the brief still renders `undefined` somewhere');
  assert.ok(!err.prompt.includes('(untitled)'), 'the brief is addressed to an untitled bead');
});

await check('the window title and the done-file record name it too', async () => {
  const err = await refusedBy(() => openWorkSession(cfg, ws, 'zz-work', { bd: trackerSaying(workRow) }));
  assert.match(err.tabTitle, /zz-work/, 'a screen of iTerm tabs cannot say which bead this is');
  assert.ok(!/undefined/.test(err.tabTitle));
});

await check('a stale title on the caller loses to the row the gate already paid for', async () => {
  // Not only the string case: the advocate's survey row can be minutes old, and the `bd
  // show` above it is free by then. Renaming a bead should not open a window still calling
  // it by its old name.
  const stale = { id: 'zz-work', title: 'what it was called last week' };
  const err = await refusedBy(() => openWorkSession(cfg, ws, stale, { bd: trackerSaying(workRow) }));
  assert.match(err.prompt, /the drawer forgets its scroll position/);
  assert.ok(!err.prompt.includes('what it was called last week'), 'the brief quotes the stale title');
});

await check('openPlanSession renders off the row as well', async () => {
  const err = await refusedBy(() => openPlanSession(cfg, ws, 'zz-epic', { bd: trackerSaying(epicRow) }));
  assert.match(err.prompt, /bd show zz-epic/);
  assert.match(err.prompt, /an epic worth planning/);
  assert.ok(!/undefined/.test(err.prompt));
  assert.match(err.tabTitle, /zz-epic/);
});

/* ================== 4. and the caller's own decisions survive being overruled */

await check('batch, group and filesBusy still reach the brief — they are not on the bead', async () => {
  // The reason `openWorkSession` merges rather than simply swapping `row` in: these three
  // are decisions the advocate made about *this launch* and there is nowhere on the bead
  // for any of them to live. A fix that took the row wholesale would delete three briefs.
  const decorated = {
    id: 'zz-work',
    title: 'stale',
    batch: [{ id: 'zz-two', title: 'the second bead' }],
    // As an epic worker leaves one — `prompt` and `epic` are not optional to
    // `workPromptFor`, which quotes the first and names the second.
    group: {
      name: 'the drawer group',
      epic: 'zz-epic',
      prompt: 'the drawer and its scroll position are one change',
      beads: [],
      prs: [{ repo: 'mordam/beadcause' }],
    },
    filesBusy: { files: ['lib/session.js'] },
  };
  const err = await refusedBy(() => openWorkSession(cfg, ws, decorated, { bd: trackerSaying(workRow) }));
  assert.equal(err.noLaunch, true, `refused by something else: ${err.message}`);
  assert.match(err.prompt, /zz-two/, 'the batch brief was dropped');
  assert.match(err.prompt, /the drawer group/, 'the group brief was dropped');
  assert.match(err.prompt, /lib\/session\.js/, 'the busy-files brief was dropped');
  // And the identity is still the row's, which is the whole trick.
  assert.ok(!err.prompt.includes('> stale'), 'the caller’s title came back in with its decorations');
});

/* ====================================== 5. the default holds without being remembered */

await check('the runner sets it for every child it spawns', () => {
  const src = read('scripts/test.mjs');
  assert.match(src, /from '\.\.\/lib\/launchguard\.js'/, 'the runner spells the variable a second time');
  // Open at the end on purpose: what this check is for is that the guard is set on every
  // child, and the runner has since had a second reason to build a child environment —
  // bc-5isv gives each suite a `TMPDIR` of its own in the same object. Pinning the
  // closing brace made a correct addition to that object read as a removed guard, which
  // is a check that fails for the one change it should not care about. The comma or the
  // brace is what says `NO_LAUNCH` is a complete entry and not the prefix of a longer name.
  assert.match(src, /env: \{ \.\.\.process\.env, \[NO_LAUNCH\]: '1'\s*[,}]/, 'suites are spawned without the guard set');
});

await check('exactly one suite opts out, and it has a stub AppleScript to justify it', () => {
  // This file names the variable through the imported constant on purpose, so it is not
  // itself a hit — but it is excluded anyway rather than relying on that, since a comment
  // here should not be able to break the check.
  const optOut = fs
    .readdirSync(path.join(ROOT, 'test'))
    .filter((f) => f.endsWith('.mjs') && f !== 'launchseam.mjs')
    .filter((f) => fs.readFileSync(path.join(ROOT, 'test', f), 'utf8').includes(ALLOW_LAUNCH));
  assert.deepEqual(optOut, ['tiermodel.mjs'], 'a suite turned the launch guard off');
  // The opt-out is only defensible because a narrower seam is in place underneath it.
  const src = read('test/tiermodel.mjs');
  assert.match(src, /open-session\.applescript/, 'tiermodel.mjs opts out with no stub AppleScript');
  assert.match(src, /stub-session/, 'the stub no longer stands in for the real script');
});

/* --------------------------------------------------------------------- teardown */

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
