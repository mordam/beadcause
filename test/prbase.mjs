#!/usr/bin/env node
/**
 * lib/prbase.js — which branch a pull request is opened into.
 *
 *     npm test
 *     node test/prbase.mjs
 *
 * `pr.base` was one string for the whole install, and it was right for as long as a
 * workspace was one repo. This is what has to hold now that one of them is forty:
 *
 * 1. **Nothing that is one repo today changes answer, or pays for the change.** The
 *    four workspaces with no `repos` block get `pr.base` exactly as they always did,
 *    and — asserted here rather than argued — they do it without running `gh` once. A
 *    `gh` call per delivery in `sophab` would be a network round trip bought for a
 *    question whose answer was already in the config.
 *
 * 2. **A multi-repo workspace asks the repo, and the repo wins over the setting.** Two
 *    approved checkouts with two different default branches must answer differently
 *    from the same config, or the setting is still the answer and nothing has changed.
 *
 * 3. **GitHub is asked, never `refs/remotes/origin/HEAD`.** That ref is written by
 *    `clone` and never refreshed, and on this Mac three of the forty-seven Climative
 *    checkouts name an `origin/HEAD` GitHub disagrees with — one of them a feature
 *    branch. So the test's checkouts are given an `origin/HEAD` that is
 *    *wrong on purpose*, and the assertion is that the answer comes from `gh` anyway.
 *
 * 4. **A `gh` that will not say is a fallback, not a refusal.** No `gh`, no auth, no
 *    network: `pr.base` again, because a base that is wrong is caught immediately by
 *    `gh pr create` and refusing outright would take a whole repo out of reach every
 *    time the wifi dropped.
 *
 * 5. **A yes is cached and a no is not.** The default branch of a repo changes about
 *    once in its life, so asking twice is waste; but a null means somebody is at a
 *    keyboard running `gh auth login`, and caching that would outlive the fix.
 *
 * 6. **A workspace with an integration branch of its own gets it, and nobody else
 *    moves.** `deluvia` lands on `atlas/public-launch`; the other nine workspaces on
 *    this install land on `main`, and the way to say that without making `main` wrong
 *    for the nine is `pr.basePerWorkspace`. Asserted from both ends — the named
 *    workspace answers its own branch, and a workspace not in the map answers exactly
 *    what it answered before the map existed — because an override that leaked would be
 *    invisible until somebody's pull request opened against a branch they had never
 *    heard of. And asserted once through `loadConfig`, because the whole point of the
 *    key is the one line in `defaults()` that names `deluvia`, and a resolver that
 *    works over a config nobody ships is a resolver nothing reaches.
 *
 * `gh` is a stub script on PATH that logs every call, so "did this ask GitHub?" is a
 * question the test can answer. Real git for the checkouts, no network, no repo of
 * yours, nothing under `~`.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeTreeSync } from './helpers/tmp.mjs';

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, String(err.message).split('\n').slice(0, 4).join('\n      '));
  }
};

/* ------------------------------------------------------------------ the world */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-prbase-'));
// The retrying, never-fatal removal rather than a bare `rmSync`: this suite runs `git
// init` in the tree it is about to take away, and a teardown must not be able to fail a
// run its assertions passed. See test/helpers/tmp.mjs.
process.on('exit', () => removeTreeSync(tmp));

// Before lib/config.js can be imported by anything below: `CONFIG_DIR` is read at
// module load, and a suite that let it resolve to `~/.config/beadcause` would write the
// developer's own config on a fresh checkout.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');

const BIN = path.join(tmp, 'bin');
const TREE = path.join(tmp, 'climative.dev');
const LOG = path.join(tmp, 'gh.log');
const MODE = path.join(tmp, 'gh.mode');
fs.mkdirSync(BIN, { recursive: true });
fs.mkdirSync(TREE, { recursive: true });

/**
 * The stub `gh`.
 *
 * Two commands, because those are the two lib/pr.js needs to answer this question:
 * `repo view --json nameWithOwner` is how it works out which repo a directory is, and
 * `repo view --json defaultBranchRef` is the question under test. The default branch is
 * read out of a file *in the checkout* — `.default-branch` — so one stub serves however
 * many repos the test makes, and `gh.mode` takes the whole thing offline.
 */
fs.writeFileSync(
  path.join(BIN, 'gh'),
  `#!/bin/sh
echo "$PWD $*" >> ${JSON.stringify(LOG)}
if [ "$(cat ${JSON.stringify(MODE)} 2>/dev/null)" = "down" ]; then
  echo "could not connect to github.com" >&2
  exit 1
fi
case "$*" in
  *nameWithOwner*) printf '{"nameWithOwner":"acme/%s"}\\n' "$(basename "$PWD")" ;;
  *defaultBranchRef*)
    if [ -f "$PWD/.default-branch" ]; then cat "$PWD/.default-branch"; else exit 1; fi ;;
  *) exit 1 ;;
esac
`,
  { mode: 0o755 }
);
process.env.PATH = `${BIN}${path.delimiter}${process.env.PATH}`;

const calls = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean) : []);
const forgetCalls = () => fs.writeFileSync(LOG, '');
const offline = (down) => fs.writeFileSync(MODE, down ? 'down' : 'up');
offline(false);

/**
 * A checkout with a real `.git`, a default branch GitHub will report, and an
 * `origin/HEAD` that says something else.
 *
 * The disagreement is the point: it is exactly the state three real Climative checkouts
 * are in, and a resolver that read the cheap local ref would pass every other assertion
 * in this file and still open pull requests into the wrong branch.
 */
function checkout(name, { ghSays, originHeadSays }) {
  const dir = path.join(TREE, name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync('git', ['-c', 'init.defaultBranch=main', 'init', '-q', dir]);
  fs.writeFileSync(path.join(dir, '.default-branch'), `${ghSays}\n`);
  if (originHeadSays) {
    // A symbolic ref can be written without the branch existing, which is precisely how
    // a stale one survives in a real clone.
    execFileSync('git', ['-C', dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', `refs/remotes/origin/${originHeadSays}`]);
  }
  return dir;
}

const architecture = checkout('architecture', { ghSays: 'main', originHeadSays: 'develop' });
const apiService = checkout('climative-api-service', { ghSays: 'develop', originHeadSays: 'main' });
const frontendBase = checkout('frontend-base', { ghSays: 'main', originHeadSays: 'TECH-5989-bootstrap-nginx' });
const sophab = checkout('sophab', { ghSays: 'trunk', originHeadSays: null });

/** One workspace of many repos, and one that is a repo — from the same `pr.base`. */
const multi = {
  pr: { base: 'main' },
  repos: {
    climative: {
      root: TREE,
      default: 'architecture',
      approved: ['architecture', 'climative-api-service', 'frontend-base'],
    },
  },
};
const single = { pr: { base: 'main' } };

const { baseFor, configuredBase } = await import('../lib/prbase.js');
const { defaultBranch, forgetAvailability } = await import('../lib/pr.js');

/* ------------------------------------------------------------------- the setting */

console.log('\nthe configured base');

await check('pr.base is the answer when it is set', () => {
  assert.equal(configuredBase({ pr: { base: 'trunk' } }), 'trunk');
});

await check('and `main` when there is nothing to read', () => {
  assert.equal(configuredBase({}), 'main');
  assert.equal(configuredBase({ pr: {} }), 'main');
  assert.equal(configuredBase({ pr: { base: '   ' } }), 'main');
});

/* ------------------------------------------ a workspace with a branch of its own */

console.log("\na workspace whose base is not the install's");

/** The shape as `defaults()` ships it: one named workspace, everybody else absent. */
const perWorkspace = { pr: { base: 'main', basePerWorkspace: { deluvia: 'atlas/public-launch' } } };

await check('the named workspace answers its own branch', () => {
  assert.equal(configuredBase(perWorkspace, 'deluvia'), 'atlas/public-launch');
});

await check('and every other workspace still answers pr.base', () => {
  // The half worth asserting: nine workspaces on this install merge into `main`, and an
  // override that leaked onto one of them is silent until a pull request opens against a
  // branch nobody named.
  for (const other of ['beadcause', 'sophab', 'ehatt', 'climative', '']) {
    assert.equal(configuredBase(perWorkspace, other), 'main', other || '(no workspace)');
  }
  assert.equal(configuredBase(perWorkspace), 'main');
});

await check('the override outranks pr.base rather than falling back to it', () => {
  const cfg = { pr: { base: 'trunk', basePerWorkspace: { deluvia: 'atlas/public-launch' } } };
  assert.equal(configuredBase(cfg, 'deluvia'), 'atlas/public-launch');
  assert.equal(configuredBase(cfg, 'sophab'), 'trunk');
});

await check('and stands in for it when pr.base is not set at all', () => {
  assert.equal(configuredBase({ pr: { basePerWorkspace: { deluvia: 'atlas/public-launch' } } }, 'deluvia'), 'atlas/public-launch');
});

await check('anything that is not a legible branch name is ignored, not coerced', () => {
  // A map keyed by workspace name is hand-edited, and `true` there asked for nothing —
  // reading it as a branch would open pull requests against `true`. The same rule the
  // per-workspace booleans in lib/spaces.js keep, for the same reason.
  for (const junk of [true, 1, null, {}, [], '', '   ']) {
    const cfg = { pr: { base: 'main', basePerWorkspace: { deluvia: junk } } };
    assert.equal(configuredBase(cfg, 'deluvia'), 'main', JSON.stringify(junk));
  }
});

await check('a config written before the map existed answers exactly as it did', () => {
  assert.equal(configuredBase({ pr: { base: 'trunk' } }, 'deluvia'), 'trunk');
  assert.equal(configuredBase({}, 'deluvia'), 'main');
});

/* --------------------------------------------------------- a workspace of one repo */

console.log('\na workspace that is one repo');

forgetAvailability();
forgetCalls();

await check('answers pr.base, not the repo', async () => {
  assert.equal(await baseFor(single, 'sophab', sophab), 'main');
});

await check('and does it without running gh at all', () => {
  assert.deepEqual(calls(), [], `gh was run: ${calls().join(' | ')}`);
});

await check('carries the workspace override, and still runs no gh', async () => {
  const cfg = { pr: { base: 'main', basePerWorkspace: { deluvia: 'atlas/public-launch' } } };
  assert.equal(await baseFor(cfg, 'deluvia', sophab), 'atlas/public-launch');
  assert.deepEqual(calls(), [], `gh was run: ${calls().join(' | ')}`);
});

await check('a repos block with nothing approved in it is still one repo', async () => {
  const empty = { pr: { base: 'main' }, repos: { climative: { root: TREE, approved: [] } } };
  assert.equal(await baseFor(empty, 'climative', apiService), 'main');
  assert.deepEqual(calls(), []);
});

await check('and no directory at all is the setting, whatever the workspace holds', async () => {
  assert.equal(await baseFor(multi, 'climative', null), 'main');
  assert.deepEqual(calls(), []);
});

/* ------------------------------------------------------- a workspace of many repos */

console.log('\na workspace that is many repos');

forgetAvailability();
forgetCalls();

await check('the default repo answers what GitHub says', async () => {
  assert.equal(await baseFor(multi, 'climative', architecture), 'main');
});

await check('a repo whose default branch is not main answers with its own', async () => {
  assert.equal(await baseFor(multi, 'climative', apiService), 'develop');
});

await check('two repos, one config, two different answers', async () => {
  const a = await baseFor(multi, 'climative', architecture);
  const b = await baseFor(multi, 'climative', apiService);
  assert.deepEqual([a, b], ['main', 'develop']);
});

await check('the stale origin/HEAD is never consulted — a feature branch there is ignored', async () => {
  // `frontend-base` really is in this state on this Mac. GitHub says `main`; the local
  // ref says a TECH- branch, because that is what the clone was told.
  const local = execFileSync('git', ['-C', frontendBase, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(local, 'origin/TECH-5989-bootstrap-nginx');
  assert.equal(await baseFor(multi, 'climative', frontendBase), 'main');
});

await check('nor for the repo whose local ref happens to look reasonable', async () => {
  const local = execFileSync('git', ['-C', apiService, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(local, 'origin/main');
  assert.equal(await baseFor(multi, 'climative', apiService), 'develop');
});

await check('but many repos still ask the repo first — the override is only their fallback', async () => {
  // One string cannot be the right base for forty repos, so where GitHub has an answer
  // the repo keeps winning. The override is what `pr.base` *means* for this workspace,
  // and it is reached on exactly the path `pr.base` was reached on before.
  const both = { ...multi, pr: { base: 'main', basePerWorkspace: { climative: 'atlas/public-launch' } } };
  assert.equal(await baseFor(both, 'climative', apiService), 'develop');
  offline(true);
  forgetAvailability();
  assert.equal(await baseFor(both, 'climative', apiService), 'atlas/public-launch');
  offline(false);
  forgetAvailability();
  forgetCalls();
});

/* -------------------------------------------------------------- gh that cannot say */

console.log('\na gh that will not answer');

forgetAvailability();
forgetCalls();
offline(true);

await check('falls back to pr.base rather than refusing', async () => {
  assert.equal(await baseFor(multi, 'climative', apiService), 'main');
});

await check('and it did try', () => {
  assert.ok(calls().length > 0, 'gh was never run');
});

await check('a checkout gh cannot see at all has no default branch', async () => {
  assert.equal(await defaultBranch(apiService), null);
});

/* ------------------------------------------------------------------- remembering */

console.log('\nwhat is remembered');

forgetAvailability();
forgetCalls();
offline(false);

await check('a real answer is asked for once and kept', async () => {
  assert.equal(await defaultBranch(apiService), 'develop');
  const asked = calls().filter((l) => l.includes('defaultBranchRef')).length;
  assert.equal(asked, 1, `asked ${asked} times`);
  assert.equal(await defaultBranch(apiService), 'develop');
  assert.equal(calls().filter((l) => l.includes('defaultBranchRef')).length, 1, 'asked GitHub twice for one repo');
});

forgetAvailability();
forgetCalls();
offline(true);

await check('a null is not — the next call asks again, and gets the answer', async () => {
  assert.equal(await defaultBranch(architecture), null);
  offline(false);
  assert.equal(await defaultBranch(architecture), 'main');
});

/* -------------------------------------------------------------- what ships */

console.log('\nthe config this install actually ships');

await check('deluvia is pointed at atlas/public-launch out of the box', async () => {
  // Through `loadConfig` rather than by restating the literal here: the key is only
  // worth anything because `defaults()` names deluvia, and a defaults block that lost
  // that line should fail here rather than three weeks from now, on a deluvia delivery
  // opened against a branch its work never merges into.
  const { loadConfig } = await import('../lib/config.js');
  const shipped = loadConfig();
  assert.equal(configuredBase(shipped, 'deluvia'), 'atlas/public-launch');
  assert.equal(configuredBase(shipped, 'beadcause'), 'main');
});

console.log(failures ? `\n${failures} failing\n` : '\nall good\n');
process.exit(failures ? 1 : 0);
