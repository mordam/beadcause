#!/usr/bin/env node
/**
 * The two consumers of a relay definition, wired to the bead's own checkout.
 *
 *     npm test
 *     node test/relaywiring.mjs
 *
 * lib/relaydefs.js decided *where a definition may come from*, and test/relaydefs.mjs is
 * that module's own contract. This file is about the two places outside it that actually
 * ask — `openWorkSession` in lib/session.js and bin/relaystep.js — and they ask differently
 * enough that one suite covering both is the honest shape:
 *
 * 1. **The launcher asks off the checkout, not off the workspace** (bc-ogicx.5). The
 *    directory `resolveSessionRepo` already resolved is the argument, which is what makes
 *    several relays in one workspace fall out for a multi-repo workspace for free — each
 *    checkout answers for itself. Asserted through the *brief*, because that is the only
 *    place a window's chain is visible without opening one: lib/launchguard.js refuses the
 *    launch and hangs the prompt it refused on the error, so every gate, every disk read
 *    and the whole of `workPromptFor` really runs and no window opens.
 * 2. **A checkout that defines nothing is bit-identical to today.** That is every checkout
 *    on this Mac, so it is the check that would actually catch a regression.
 * 3. **A file that will not parse falls back to today, and says so.** Never a hold and
 *    never a throw — the window still opens, on the config's relay, and the sentence
 *    survives to the caller for lib/advocate.js to say (bc-ogicx.6).
 * 4. **The CLI checks a role against every relay at once** (bc-ogicx.7). It is handed a
 *    workspace, a role and a step — no bead and no checkout — so it cannot know which
 *    relay a `--role` was meant to belong to. Asserted both as `rolesAcross` and by running
 *    the real command, because the interesting half is *which directories it decides to
 *    ask*, and that lives in the bin rather than in lib.
 * 5. **A repo-defined relay is not a route around the endorsement gate** (bc-ogicx.9). The
 *    epic's one non-negotiable, and the only criterion of that bead nothing in this repo
 *    covered: a definition may change what a window is briefed with and may not change
 *    whether the window opens at all.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-relaywiring-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });
// And where `launch` would spool its three temp files, if it ever got that far.
const SPOOL = path.join(tmp, 'spool');
fs.mkdirSync(SPOOL);
process.env.TMPDIR = SPOOL;

const { forgetRelayDefs, rolesAcross, RELAY_DIR } = await import(path.join(ROOT, 'lib', 'relaydefs.js'));
const { openWorkSession } = await import(path.join(ROOT, 'lib', 'session.js'));
const { UNENDORSED } = await import(path.join(ROOT, 'lib', 'endorse.js'));

/* --------------------------------------------------------------------- the fixture */

/** A checkout `resolveSessionRepo` will accept, optionally shipping a definition. */
let seq = 0;
function checkout(files = null) {
  seq += 1;
  const dir = path.join(tmp, `repo-${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: dir, stdio: 'pipe' });
  if (files) {
    fs.mkdirSync(path.join(dir, RELAY_DIR), { recursive: true });
    for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, RELAY_DIR, name), body);
  }
  forgetRelayDefs();
  return dir;
}

/** Two named relays, the shape bc-ogicx.1 settled. `mien` staffs `design` and nothing else. */
const TWO_RELAYS = `
relays:
  story:
    profile: ai-context/agents/{role}/{role}.md
    filer: ward
    departments:
      dept:story:
        name: Story
        lead: script
        members: [aria, clio, muse]
        check: [clio]
  design:
    filer: ward
    departments:
      dept:design:
        name: Design
        lead: palette
        members: [palette, mien]
        check: [clio]
default: story
`;

/**
 * The config side — one unnamed relay, keyed by workspace, exactly as it is today.
 *
 * Its department key is `dept:story` too, and deliberately: the two definitions have to be
 * told apart by their *members*, not by which label the bead happens to be carrying.
 */
const relaysBlock = {
  demo: {
    profile: 'ai-context/agents/{role}/{role}.md',
    filer: 'ward',
    executive: ['vox'],
    departments: {
      'dept:story': { name: 'Story', lead: 'lore', members: ['lore', 'tally'], check: ['tally'] },
    },
  },
};

const cfgFor = (dir, { relays = relaysBlock } = {}) => ({
  sessionDirs: { demo: dir },
  openSessions: true,
  // `prMode` shells out to `gh` otherwise, and what the brief says about pull requests is
  // not what this file is about.
  pr: { enabled: false },
  sessionWindows: { layout: false, stealFocus: true },
  relays,
});

const ws = (dir) => ({ name: 'demo', dir });

const row = (over = {}) => ({
  id: 'zz-work',
  title: 'the drawer forgets its scroll position',
  status: 'open',
  issue_type: 'task',
  priority: 2,
  labels: [],
  description: 'a bead like any other',
  ...over,
});

/**
 * The brief a launch *would* have carried, without opening a window.
 *
 * A launch that is **not** refused is a window a suite opened, which is the failure
 * test/launchseam.mjs exists over — so the refusal is asserted rather than tolerated.
 */
async function briefFor(cfg, dir, bead) {
  const err = await openWorkSession(cfg, ws(dir), bead, { bd: { show: async () => bead } }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'a window was opened by a test run');
  assert.equal(err.noLaunch, true, `refused by something other than the launch guard: ${err.message}`);
  return err.prompt;
}

/* --------------------------------------------------------------------- the harness */

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
    console.log(`       ${String(err?.stack || err).split('\n').slice(0, 6).join('\n       ')}`);
  }
}

console.log('\nthe relay a window comes up under is read from that window’s own checkout\n');

/* =========================================== 1. the launcher asks off the checkout */

await check('the checkout’s own definition is what the brief renders, not the config’s', async () => {
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const brief = await briefFor(cfgFor(dir), dir, row({ assignee: 'aria' }));
  assert.match(brief, /This window is a relay/, 'the brief is not a relay at all');
  assert.match(brief, /1\. draft {2}aria/, 'the chain did not come from the checkout');
  assert.match(brief, /2\. check {2}clio/, 'the checkout’s `check:` is missing from the chain');
  // `lore` is the config relay's lead and is in no relay the checkout declares. Its
  // absence is what says the file *replaced* the config rather than merging with it.
  assert.ok(!brief.includes('lore'), 'the config relay leaked into a checkout-defined chain');
});

await check('a second relay in the same file is selected by the bead’s department label', async () => {
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const brief = await briefFor(cfgFor(dir), dir, row({ assignee: 'palette', labels: ['dept:design'] }));
  assert.match(brief, /Design department/, 'the design relay was not the one selected');
  assert.match(brief, /1\. draft {2}palette/);
});

await check('a role in the other relay is not a relay here — the selection is not a union', async () => {
  // `mien` staffs `design` only, and this bead names `dept:story`. Two relays in one
  // workspace have to stay two: a launcher that unioned them would open a Story window
  // over a Design role, which is the wrong-department dispatch the selection rule exists
  // to refuse. bin/relaystep.js unions deliberately, for a different question — see 4.
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const brief = await briefFor(cfgFor(dir), dir, row({ assignee: 'mien', labels: ['dept:story'] }));
  assert.ok(!brief.includes('This window is a relay'), '`mien` was dispatched as a Story role');
});

/* ================================== 2. a checkout that defines nothing is unchanged */

await check('no .beadcause/ at all still dispatches on the config’s relay, unchanged', async () => {
  const bare = checkout();
  const brief = await briefFor(cfgFor(bare), bare, row({ assignee: 'lore' }));
  assert.match(brief, /1\. draft {2}lore/, 'the config relay stopped resolving');
  assert.match(brief, /2\. check {2}tally/);
});

await check('a definition replaces the config whole — the config’s roles do not survive it', async () => {
  const defined = checkout({ 'relays.yaml': TWO_RELAYS });
  const brief = await briefFor(cfgFor(defined), defined, row({ assignee: 'lore' }));
  assert.ok(!brief.includes('This window is a relay'), 'the config relay survived a definition');
});

await check('a workspace with no relay anywhere gets no relay section at all', async () => {
  const bare = checkout();
  const brief = await briefFor(cfgFor(bare, { relays: {} }), bare, row({ assignee: 'lore' }));
  assert.ok(!brief.includes('This window is a relay'), 'a workspace with no relay got one');
});

await check('the packet stays the config’s — a repo file cannot drop the human pair', async () => {
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const brief = await briefFor(cfgFor(dir), dir, row({ assignee: 'aria' }));
  assert.match(brief, /needs-approval/, 'the review packet went missing');
  assert.match(brief, /human/, 'an approval that never reaches a lock screen');
});

/* =============================== 3. a file that will not parse falls back, and says so */

await check('a refused definition dispatches on the config’s relay rather than on nothing', async () => {
  const dir = checkout({ 'relays.yaml': 'relays: [not, a, map]\n' });
  const brief = await briefFor(cfgFor(dir), dir, row({ assignee: 'lore' }));
  assert.match(brief, /1\. draft {2}lore/, 'a broken file took the workspace’s relay down with it');
});

await check('a refused definition is never a hold and never a throw — only a sentence', () => {
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'session.js'), 'utf8');
  const at = src.indexOf('relayDefFor(cfg, workspace.name, dir, row)');
  assert.ok(at !== -1, 'lib/session.js no longer resolves the relay from the checkout');
  // The sentence has to survive to the caller or lib/advocate.js has nothing to say.
  assert.match(src.slice(at), /relayProblem: relayProblem \|\| null/, 'the problem dies inside the launcher');
  // And nothing on this path may refuse a dispatch over it.
  assert.ok(!/throw[^;]*relayProblem/.test(src), 'a definition problem became a refusal');
});

/* ============================ 4. the CLI checks against every relay, not against one */

await check('rolesAcross unions every relay the checkout declares', () => {
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const { roles, problems } = rolesAcross(cfgFor(dir), 'demo', [dir]);
  assert.deepEqual([...roles].sort(), ['aria', 'clio', 'mien', 'muse', 'palette', 'script', 'ward']);
  assert.deepEqual(problems, []);
  // The config's own roles are *not* in it: this checkout defines, so it replaces.
  assert.ok(!roles.has('lore'), 'the config relay leaked past a definition');
});

await check('a checkout that defines nothing contributes the config’s roles, and only those', () => {
  const dir = checkout();
  const { roles } = rolesAcross(cfgFor(dir), 'demo', [dir]);
  assert.deepEqual([...roles].sort(), ['lore', 'tally', 'vox', 'ward']);
  // No checkouts to ask at all is the same answer — a workspace whose directory moved
  // still has the list this command has always checked against.
  assert.deepEqual([...rolesAcross(cfgFor(dir), 'demo', []).roles].sort(), ['lore', 'tally', 'vox', 'ward']);
});

await check('several checkouts union, and one that defines nothing still brings the config in', () => {
  const defined = checkout({ 'relays.yaml': TWO_RELAYS });
  const bare = checkout();
  const { roles } = rolesAcross(cfgFor(bare), 'demo', [defined, bare]);
  assert.ok(roles.has('mien'), 'the defining checkout was not asked');
  assert.ok(roles.has('lore'), 'the checkout that defines nothing did not fall through to the config');
});

await check('a refused file is a sentence, not a narrower list nobody was told about', () => {
  const bad = checkout({ 'relays.yaml': 'relays:\n  story:\n    packet: [x]\n' });
  const { roles, problems } = rolesAcross(cfgFor(bad), 'demo', [bad]);
  assert.equal(problems.length, 1, 'a refused file said nothing');
  assert.match(problems[0], /relays\.yaml/);
  // It fell through, so the config's roles are the list — which is exactly why the
  // sentence matters: without it the narrowing is invisible.
  assert.ok(roles.has('lore'));
});

await check('bin/relaystep.js checks --role against the union, in the workspace’s own checkout', () => {
  // End-to-end, because the half worth testing is which directories the bin decides to
  // ask, and that lives in the command rather than in lib.
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const configDir = path.join(tmp, `cli-${seq}`);
  fs.mkdirSync(configDir, { recursive: true });
  const beads = path.join(dir, '.beads');
  fs.mkdirSync(beads, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'config.json'),
    JSON.stringify(
      {
        // `workspaces: []` **explicitly**, not merely omitted: `loadConfig` spreads the
        // file over `defaults()`, whose `workspaces` is already `discoverWorkspaces()` run
        // against the real `~/beads`, so an omitted key leaks every real workspace on this
        // Mac into a fixture that then answers about one of those. Empty roots stop the
        // scan and `workspaceDirs` pins the only workspace this check is about.
        workspaces: [],
        workspaceRoots: [],
        workspaceDirs: { demo: dir },
        sessionDirs: { demo: dir },
        // Pointed at a binary that fails immediately, so a role the command *accepts*
        // still writes nothing: the pass is exit 4 (the tracker refused the entry) rather
        // than exit 3 (this workspace has no such role), and those two are exactly what
        // has to be told apart here.
        bdBin: '/usr/bin/false',
        relays: {
          demo: {
            filer: 'ward',
            departments: { 'dept:story': { name: 'Story', lead: 'lore', members: ['lore'] } },
          },
        },
      },
      null,
      2,
    ),
  );
  const run = (role) => {
    try {
      execFileSync(
        process.execPath,
        [path.join(ROOT, 'bin', 'relaystep.js'), '-w', 'demo', '-b', 'zz-1', '--role', role, '--step', 'draft', '-m', 'x'],
        { env: { ...process.env, BEADCAUSE_CONFIG_DIR: configDir }, stdio: 'pipe' },
      );
      return { code: 0, err: '' };
    } catch (e) {
      return { code: e.status, err: String(e.stderr || '') };
    }
  };
  // `mien` is a role in the checkout's `design` relay and in nothing the config says. A
  // command still checking one relay would refuse it.
  const good = run('mien');
  // 4 and not 0: it got past the role gate and on to the write, which `/usr/bin/false`
  // then refused. 3 would be this command turning down a role that really exists.
  assert.equal(good.code, 4, `a real role never reached the tracker: ${good.err}`);
  const typo = run('clip');
  assert.equal(typo.code, 3, `a typo was not refused as one: ${typo.err}`);
  assert.match(typo.err, /is not a role in demo/);
  assert.match(typo.err, /mien/, 'the list it offered was not the union');
  assert.ok(!/lore/.test(typo.err), 'the config relay leaked past a checkout that defines');
});

/* ===================== 5. the endorsement gate is unmoved by a repo-defined relay */

/**
 * bc-ogicx.9's last criterion, and the epic's own non-negotiable: **a repo-defined relay
 * must not be a route to dispatching unendorsed work.**
 *
 * Everything else in this suite is about a definition changing what a window is *briefed
 * with*. This is the one thing a definition must not be able to change at all — and it is
 * the one worth an assertion of its own rather than an argument from the source, because
 * the two facts that make it true are in different files and neither mentions the other.
 * `assertEndorsed` (lib/endorse.js) is the first thing `openWorkSession` does; the relay is
 * resolved forty lines further down, off the row that gate returned. Reordering those, or
 * resolving a relay before the gate so a chain could be logged for a held bead, would break
 * nothing else in this repo.
 *
 * The refusal is told apart from every other way a launch can fail by its own two fields:
 * `unendorsed: true`, and **no `prompt`** — lib/launchguard.js hangs the brief it refused on
 * its error, so an error carrying one is a launch that got as far as building a brief. There
 * is nothing to assert about a window not opening otherwise; the whole point is that this
 * refusal happens before the checkout is even read.
 */
const held = (over = {}) => row({ assignee: 'aria', labels: [UNENDORSED], ...over });

await check('a bead in a repo-defined relay would relay — the control for the two below', async () => {
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const brief = await briefFor(cfgFor(dir), dir, row({ assignee: 'aria' }));
  assert.match(brief, /This window is a relay/, 'the refusals below would prove nothing');
  assert.match(brief, /1\. draft {2}aria/);
});

await check('an unendorsed bead in a repo-defined relay refuses at the launcher door', async () => {
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const bead = held();
  const err = await openWorkSession(cfgFor(dir), ws(dir), bead, { bd: { show: async () => bead } }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'an unendorsed bead opened a window');
  assert.equal(err.unendorsed, true, `refused, but not by the endorsement gate: ${err.message}`);
  assert.match(err.message, new RegExp(UNENDORSED));
  assert.equal(err.prompt, undefined, 'a brief was built for a bead that may not be worked');
  assert.notEqual(err.noLaunch, true, 'it reached the launch guard, so the gate did not stop it');
});

await check('the tracker decides it, not the row the relay would have been resolved off', async () => {
  // The advocate's queue row is not evidence: `assertEndorsed` asks `bd show` regardless,
  // and this is the case that says so — a caller-supplied row with no marker on it, over a
  // bead the tracker says is held, in a checkout that ships a definition naming its role.
  const dir = checkout({ 'relays.yaml': TWO_RELAYS });
  const looksFine = row({ assignee: 'aria' });
  const err = await openWorkSession(cfgFor(dir), ws(dir), looksFine, {
    bd: { show: async () => ({ ...looksFine, labels: [UNENDORSED] }) },
  }).then(
    () => null,
    (e) => e,
  );
  assert.ok(err, 'the caller’s own row was taken as proof of endorsement');
  assert.equal(err.unendorsed, true, `refused, but not by the endorsement gate: ${err.message}`);
  assert.equal(err.prompt, undefined);
});

await cleanupTmp(tmp);

console.log(`\n${ran - failures}/${ran} checks passed\n`);
process.exit(failures ? 1 : 0);
