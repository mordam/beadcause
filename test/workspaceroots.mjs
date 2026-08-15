#!/usr/bin/env node
/**
 * `workspaceRoots` — where trackers are looked for, and the two shapes a root can have.
 *
 *     npm test
 *     node test/workspaceroots.mjs
 *
 * Discovery used to know one shape: `~/beads/<name>/.beads`, a container directory with
 * one subdirectory per workspace. A tracker that lives *inside the repo it tracks* is the
 * other shape, and it is the one a team tracker has — Climative's `cl-` graph moved to
 * `~/climative.dev/architecture/.beads` so that forty service checkouts and the issues
 * about them arrive in one clone. Six things are worth a file:
 *
 * 1. **The default is unchanged, and that is the whole compatibility story.** A config
 *    with no `workspaceRoots` — every install written before this existed — discovers
 *    `~/beads/*` and nothing else, and `containerRoots` still excludes it from the repo
 *    search.
 * 2. **Both shapes, from one list.** A root with its own `.beads` is one workspace named
 *    after the directory it sits in; a root without one is scanned a level down.
 * 3. **A root that is a workspace is NOT excluded from the repo search.** This is the
 *    difference `containerRoots` draws, and it is the reason it exists: `~/beads` is the
 *    tracker's own tree and holds no checkout anybody works in, and every word of that is
 *    false about a repo that happens to hold a `.beads`.
 * 4. **Two roots reaching one directory are one workspace; two workspaces sharing a name
 *    are not both kept.** Almost everything else in the config is keyed by workspace
 *    name, so the second `climative` would silently share `sessionDirs`, `jira` and
 *    `advocates.perWorkspace` with the first.
 * 5. **The dead snapshot stays dead.** The old `cl-` workspace was moved to
 *    `~/beads-retired/…` — *outside* `~/beads` — precisely because discovery re-adds
 *    anything under a root on every start. A retired tracker beside the root must not
 *    come back, and a root that no longer exists must not throw.
 * 6. **A session opens in an out-of-tree workspace with no `sessionDirs` override.**
 *    `beadsDirFor` reimplements the shell's rule and used to answer `~/beads/<name>` come
 *    what may, so nothing ever mapped back to a workspace living elsewhere and every
 *    session on one of its beads refused with a 409.
 *
 * Entirely on a temp tree, with `HOME` pointed into it before anything under lib/ is
 * imported: `os.homedir()` reads `$HOME` at call time on POSIX, which is the only reason
 * a suite can say what the *default* root would be without depending on whose Mac it is.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupTmp } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-wsroots-'));
const REAL_HOME = process.env.HOME;
process.env.HOME = tmp;
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { workspaceRoots, containerRoots, isRepoRoot, discoverWorkspaces } = await import(LIB('workspaceroots.js'));
const { candidateRoot } = await import(LIB('reposcan.js'));
const { beadsDirFor, resolveSessionDir } = await import(LIB('session.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));
const names = (list) => list.map((w) => w.name).join(', ');

/* -------------------------------------------------------------------- the tree */

const BEADS = path.join(tmp, 'beads');
const tracker = (dir) => {
  fs.mkdirSync(path.join(dir, '.beads'), { recursive: true });
  return dir;
};

tracker(path.join(BEADS, 'sophab'));
tracker(path.join(BEADS, 'deluvia'));
// A directory under the container that is not a workspace — a stray clone, a `tmp`.
fs.mkdirSync(path.join(BEADS, 'notes'), { recursive: true });

// The other shape: a tracker inside the repo it tracks, in a tree of checkouts.
const CLIMATIVE = path.join(tmp, 'climative.dev');
const ARCHITECTURE = tracker(path.join(CLIMATIVE, 'architecture'));
for (const name of ['architecture', 'athena-service', 'audit-service']) {
  fs.mkdirSync(path.join(CLIMATIVE, name, '.git'), { recursive: true });
}

// The retired snapshot, deliberately beside `~/beads` rather than under it.
tracker(path.join(tmp, 'beads-retired', 'climative-20260812'));

/* ------------------------------------------------------- 1. nothing has changed */

console.log('\nthe install that has never heard of this setting');

{
  const plain = {};
  check(
    'no workspaceRoots means ~/beads and only ~/beads',
    JSON.stringify(workspaceRoots(plain)) === JSON.stringify([BEADS]),
    JSON.stringify(workspaceRoots(plain))
  );
  check(
    'and it discovers exactly what it discovered before',
    names(discoverWorkspaces(plain)) === 'deluvia, sophab',
    names(discoverWorkspaces(plain))
  );
  check(
    'a directory under the root with no .beads in it is not a workspace',
    !discoverWorkspaces(plain).some((w) => w.name === 'notes'),
    names(discoverWorkspaces(plain))
  );
  check('~/beads is still a container, so still excluded from the repo search', containerRoots(plain).includes(BEADS));
  check(
    'and candidateRoot still refuses to offer anything under it',
    candidateRoot({ ...plain, assetRoots: [BEADS] }, 'sophab') === null,
    String(candidateRoot({ ...plain, assetRoots: [BEADS] }, 'sophab'))
  );
  // An empty array is the same answer as no array at all: a config that has had every
  // root deleted is a config that has said nothing, not one that has said "nowhere".
  check('an empty list falls back to the default rather than to nothing', JSON.stringify(workspaceRoots({ workspaceRoots: [] })) === JSON.stringify([BEADS]));
}

/* ------------------------------------------------------------- 2. the two shapes */

console.log('\na root can hold workspaces, or be one');

const cfg = { workspaceRoots: ['~/beads', ARCHITECTURE] };

{
  check('~ is expanded once, here, because every reader compares paths', workspaceRoots(cfg)[0] === BEADS, workspaceRoots(cfg)[0]);
  check('a root with its own .beads is a workspace', isRepoRoot(ARCHITECTURE));
  check('a container root is not', !isRepoRoot(BEADS));

  const found = discoverWorkspaces(cfg);
  check('both shapes are discovered from one list', names(found) === 'architecture, deluvia, sophab', names(found));
  check(
    'the in-repo one is named after the directory it sits in, and points at its .beads',
    found.find((w) => w.name === 'architecture')?.dir === path.join(ARCHITECTURE, '.beads'),
    found.find((w) => w.name === 'architecture')?.dir
  );
}

/* --------------------------------- 3. the exclusion follows the shape, not the path */

console.log('\nwhat is excluded from the repo search, and what is not');

{
  check('the container root is excluded', !containerRoots(cfg).includes(ARCHITECTURE) && containerRoots(cfg).includes(BEADS), JSON.stringify(containerRoots(cfg)));
  // The whole point of the distinction. `~/climative.dev/architecture` holds a tracker
  // *and* is a checkout somebody works in every day; excluding it the way `~/beads` is
  // excluded would take the repo out of the search on the one install this shape is for.
  check(
    'a tree of checkouts under a root that IS a workspace is still offered',
    candidateRoot({ ...cfg, assetRoots: [tmp] }, 'climative') === CLIMATIVE,
    String(candidateRoot({ ...cfg, assetRoots: [tmp] }, 'climative'))
  );
}

/* --------------------------------------------------- 4. one directory, and one name */

console.log('\nthe same tracker twice, and two trackers with one name');

{
  const twice = { workspaceRoots: [BEADS, `${BEADS}/`, path.join(BEADS, '..', 'beads')] };
  check(
    'a root written three ways is one root',
    JSON.stringify(workspaceRoots(twice)) === JSON.stringify([BEADS]),
    JSON.stringify(workspaceRoots(twice))
  );
  check('so its workspaces are found once each', names(discoverWorkspaces(twice)) === 'deluvia, sophab', names(discoverWorkspaces(twice)));

  // Two different trackers that would both be called `sophab`. Everything keyed by
  // workspace name — sessionDirs, jira, advocates.perWorkspace, a space's list — would
  // apply to whichever one won, and which won would be the order the roots were typed in.
  const OTHER = path.join(tmp, 'other');
  tracker(path.join(OTHER, 'sophab'));
  const clash = { workspaceRoots: [BEADS, OTHER] };
  const found = discoverWorkspaces(clash);
  check('a name found twice is kept once', found.filter((w) => w.name === 'sophab').length === 1, names(found));
  check(
    'and it is the one under the root named first',
    found.find((w) => w.name === 'sophab')?.dir === path.join(BEADS, 'sophab', '.beads'),
    found.find((w) => w.name === 'sophab')?.dir
  );
  fs.rmSync(OTHER, { recursive: true, force: true });
}

/* ------------------------------------------------ 5. the retired snapshot stays dead */

console.log('\nwhat must not come back, and what must not throw');

{
  // `~/beads-retired/climative-20260812` is a real tracker directory, and it is outside
  // `~/beads` for exactly this reason: discovery reads a root and takes what is in it, so
  // a dead snapshot left under one is resurrected on every restart.
  check(
    'a retired tracker beside the root is not discovered',
    !discoverWorkspaces(cfg).some((w) => w.dir.includes('beads-retired')),
    names(discoverWorkspaces(cfg))
  );
  const gone = { workspaceRoots: [BEADS, path.join(tmp, 'never-existed')] };
  check('a root that is not there yet is skipped rather than thrown over', names(discoverWorkspaces(gone)) === 'deluvia, sophab', names(discoverWorkspaces(gone)));
}

/* ------------------------------------------- 6. a session opens without sessionDirs */

console.log('\nthe shell rule, and the 409 it used to cause');

{
  const PROJECTS = path.join(tmp, 'neadamthal.projects');
  fs.mkdirSync(path.join(PROJECTS, 'sophab'), { recursive: true });
  const workspaces = discoverWorkspaces(cfg);
  const architecture = workspaces.find((w) => w.name === 'architecture');
  const sophab = workspaces.find((w) => w.name === 'sophab');

  check(
    'a name nothing knows still guesses ~/beads/<name>/.beads',
    beadsDirFor(path.join(PROJECTS, 'widgets'), PROJECTS, 'architecture', workspaces) === path.join(BEADS, 'widgets', '.beads'),
    beadsDirFor(path.join(PROJECTS, 'widgets'), PROJECTS, 'architecture', workspaces)
  );
  check(
    'a name the config knows resolves to where that workspace actually is',
    beadsDirFor(tmp, PROJECTS, 'architecture', workspaces) === path.join(ARCHITECTURE, '.beads'),
    beadsDirFor(tmp, PROJECTS, 'architecture', workspaces)
  );
  check(
    'and a workspace under the container root is unaffected',
    beadsDirFor(path.join(PROJECTS, 'sophab'), PROJECTS, 'architecture', workspaces) === path.join(BEADS, 'sophab', '.beads'),
    beadsDirFor(path.join(PROJECTS, 'sophab'), PROJECTS, 'architecture', workspaces)
  );

  // The 409 this fixes: with `projectRoot` set and the fallback naming the out-of-tree
  // workspace, no directory used to map back to it and the only way out was to pin
  // `sessionDirs.architecture` by hand.
  const rooted = { ...cfg, workspaces, projectRoot: PROJECTS, fallbackWorkspace: 'architecture' };
  check(
    'the out-of-tree workspace opens in the checkout its tracker lives in',
    resolveSessionDir(rooted, architecture) === ARCHITECTURE,
    resolveSessionDir(rooted, architecture)
  );
  check(
    'and the ordinary workspace still opens in <projectRoot>/<name>',
    resolveSessionDir(rooted, sophab) === path.join(PROJECTS, 'sophab'),
    resolveSessionDir(rooted, sophab)
  );

  // Still *checked* rather than assumed. Where the fallback is some other workspace, a
  // shell in the checkout really would write to a different graph, and refusing is the
  // whole reason the check is there.
  const wrongFallback = { ...rooted, fallbackWorkspace: 'deluvia' };
  let refused = '';
  try {
    resolveSessionDir(wrongFallback, architecture);
  } catch (err) {
    refused = String(err?.message || '');
  }
  check('a fallback naming a different workspace still refuses', /different issue graph/.test(refused), refused || 'no refusal');

  // And with no projectRoot at all — the shape almost every install has — the workspace's
  // own directory is the answer, which for an in-repo root is the checkout itself.
  check(
    'with no projectRoot the in-repo workspace opens in the repo',
    resolveSessionDir({ ...cfg, workspaces }, architecture) === ARCHITECTURE,
    resolveSessionDir({ ...cfg, workspaces }, architecture)
  );
}

/* ------------------------------------------- 7. the reconciler is told where to look */

console.log('\nreconciling against a root the caller named');

{
  // `npm run configure` changes `workspaceRoots` mid-run and has to catch the workspace
  // list up before the questions that are keyed by workspace name. The first version of
  // that passed `null` as the config to mean "do not save", which also meant "look in the
  // default root" — so the wizard printed "Workspaces found:" without the workspace the
  // root had just been added for, and every question after it was asked over the old list.
  const { reconcileWorkspaces } = await import(LIB('config.js'));
  const written = path.join(process.env.BEADCAUSE_CONFIG_DIR, 'config.json');
  const merged = reconcileWorkspaces([], { ...cfg }, { persist: false });
  check('the roots on the config passed in are the roots looked in', names(merged) === 'architecture, deluvia, sophab', names(merged));
  check('and persist:false writes nothing at all', !fs.existsSync(written), written);
}

process.env.HOME = REAL_HOME;
await cleanupTmp(tmp);
console.log(failures ? `\n${failures} failed\n` : '\nall passed\n');
process.exit(failures ? 1 : 0);
