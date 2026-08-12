#!/usr/bin/env node
/**
 * `resolveSessionDir` — the one place a bead becomes a directory.
 *
 *     npm test
 *     node test/sessiondir.mjs
 *
 * Twenty-five call sites go through this function, and everything a session then does —
 * the worktree it makes, the branch it pushes, the pull request it opens, the deploy
 * that follows — happens in whatever it answered. So it has exactly two ways to be
 * wrong, and both are silent:
 *
 * 1. **It moves a workspace that was fine.** `sophab`, `deluvia`, `ehatt` and
 *    `beadcause` itself have no service tokens and never will, and the `sessionDirs` /
 *    `projectRoot` / `fallbackWorkspace` rules they rely on are the whole of how they
 *    open. Every one of those answers is pinned here against a config with no `repos`
 *    block at all, because "it still works for Climative" is not the claim that matters
 *    to the four workspaces that were working already.
 *
 * 2. **It sends a bead to the wrong checkout.** Not "fails to find one" — a session
 *    opened in a repo nobody meant it to touch, on a Mac nobody is sitting at. Which is
 *    why the four refusals below are refusals rather than fallbacks: an unknown token, a
 *    token two approved repos both declare, a bead labelled `repo:` twice, and a bare
 *    `repo:` with nothing after it all resolve to **nothing**, with a sentence. Only a
 *    bead carrying no `repo:` label at all resolves to the workspace's default repo,
 *    because that is a bead that said where it belongs.
 *
 * And one thing that is not about sessions at all: `ownWorkspace` in lib/deploy.js runs
 * this function backwards, to decide which tracker the daemon's own crashes are filed
 * on. Forwards, a multi-repo workspace answers with one repo; backwards, all of its
 * approved checkouts are that workspace, and the difference is a crash filed onto
 * somebody else's graph.
 *
 * Entirely on a temp tree: fake checkouts, fake `config/config.yaml`, fake `~/beads`,
 * no `~` and no bd.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-sessiondir-'));
// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

const { resolveSessionDir, resolveSessionRepo } = await import(LIB('session.js'));
const { repoWarnings, repoLabel, beadToken, forgetRepos } = await import(LIB('repos.js'));
const { ownWorkspace } = await import(LIB('deploy.js'));

let failures = 0;
const ok = (name) => console.log(`  ✓ ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  ✗ ${name}\n      ${detail}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/** Assert a call throws, and hand the message back so the sentence can be checked too. */
function refusal(name, fn, ...needles) {
  let err = null;
  try {
    fn();
  } catch (e) {
    err = e;
  }
  if (!err) return bad(name, 'it resolved instead of refusing — a session would have opened somewhere');
  const missing = needles.filter((n) => !err.message.includes(n));
  if (missing.length) return bad(name, `message does not say ${missing.map((m) => JSON.stringify(m)).join(', ')}: ${err.message}`);
  if (err.status !== 409) return bad(name, `status ${err.status}, expected 409 — lib/server.js turns that into the sentence on screen`);
  ok(name);
}

/* ------------------------------------------------------------------ the tree */

const ROOT = path.join(tmp, 'climative.dev');
const PROJECTS = path.join(tmp, 'projects');
const BEADS = path.join(tmp, 'beads');

/** A Climative checkout, which is a directory that declares a service token. */
function checkout(name, token) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  const lines = ['---', `serviceName: ${name}`];
  if (token !== null) lines.push(`serviceToken: ${token}`);
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), `${lines.join('\n')}\n`);
  return dir;
}

const ARCHITECTURE = checkout('architecture', 'architecture');
// Two checkouts declaring `as` is not a fixture contrivance: three real Climative repos
// declare it today, because `microservice-base` ships a placeholder token.
checkout('athena-service', 'as');
const AUDIT = checkout('audit-service', 'as');
const BUILDING = checkout('building-service', 'bs');
// Approved, cloned, and never touched by any of this — it is here so "unlisted resolves
// to nothing" is about a repo that exists rather than about a typo.
checkout('weather-service', 'ws');

/** A workspace, as far as this function is concerned: a name and a `.beads` directory. */
function workspace(name) {
  const dir = path.join(BEADS, name, '.beads');
  fs.mkdirSync(dir, { recursive: true });
  return { name, dir };
}

const climative = workspace('climative');
const sophab = workspace('sophab');
fs.mkdirSync(path.join(PROJECTS, 'sophab'), { recursive: true });

/** The config Climative gets: a root, a default, and the list Adam approved. */
const withRepos = (extra = {}) => ({
  workspaces: [climative, sophab],
  repos: {
    climative: {
      root: ROOT,
      default: 'architecture',
      approved: ['architecture', 'athena-service', 'audit-service', 'building-service'],
    },
  },
  ...extra,
});

/** A bead, as far as this function is concerned: a row with labels. */
const bead = (...labels) => ({ id: 'cl-9f2', labels });

/* ------------------------------- 1. every workspace that was one repo still is */

console.log('\nthe workspaces that were already working');

{
  // No `repos` block anywhere — the shape of every install but this Mac's.
  const plain = { workspaces: [sophab] };
  check(
    'no repos block, no projectRoot: the workspace opens in its own ~/beads/<name>',
    resolveSessionDir(plain, sophab) === path.join(BEADS, 'sophab'),
    resolveSessionDir(plain, sophab)
  );

  // `beadsDirFor` reimplements a *shell* rule, and that rule names `~/beads/<repo>` — so
  // the workspace this branch can match is one whose `.beads` is under the real home.
  // Nothing is read there: the directory is only ever compared.
  const homed = { name: 'sophab', dir: path.join(os.homedir(), 'beads', 'sophab', '.beads') };
  const rooted = { workspaces: [homed], projectRoot: PROJECTS, fallbackWorkspace: 'default' };
  check(
    'projectRoot configured: the workspace opens in <projectRoot>/<name>',
    resolveSessionDir(rooted, homed) === path.join(PROJECTS, 'sophab'),
    resolveSessionDir(rooted, homed)
  );

  const pinned = { workspaces: [sophab], sessionDirs: { sophab: BUILDING } };
  check('sessionDirs.<workspace> still overrides both', resolveSessionDir(pinned, sophab) === BUILDING, resolveSessionDir(pinned, sophab));

  refusal(
    'and sessionDirs pointing at a missing directory still refuses',
    () => resolveSessionDir({ workspaces: [sophab], sessionDirs: { sophab: path.join(tmp, 'gone') } }, sophab),
    'points at a missing directory'
  );

  // The bead is the new argument, and a workspace that is one repo must ignore it
  // completely — including a bead carrying a label that means something elsewhere.
  check(
    'a bead makes no difference to a workspace with no approved list',
    resolveSessionDir(plain, sophab, bead(repoLabel('as'))) === path.join(BEADS, 'sophab'),
    resolveSessionDir(plain, sophab, bead(repoLabel('as')))
  );

  // A workspace named in `repos` but with nothing approved is still one repo: the block
  // is opt-in by content, not by presence, and half-written config must not move it.
  const empty = { workspaces: [sophab], repos: { sophab: { root: ROOT, approved: [] } } };
  check(
    'an empty approved list is not a multi-repo workspace',
    resolveSessionDir(empty, sophab) === path.join(BEADS, 'sophab'),
    resolveSessionDir(empty, sophab)
  );
}

/* --------------------------------------- 2. a bead resolves to the repo it names */

console.log('\na Climative bead opens in the checkout it is about');

{
  const cfg = withRepos();

  check(
    'repo:bs → building-service, because that checkout says it is `bs`',
    resolveSessionDir(cfg, climative, bead(repoLabel('bs'))) === BUILDING,
    resolveSessionDir(cfg, climative, bead(repoLabel('bs')))
  );
  check(
    'other labels on the bead are ignored',
    resolveSessionDir(cfg, climative, bead('climative', 'multi-repo', 'repo:bs', 'human')) === BUILDING
  );
  check(
    'the label is matched case-insensitively, like the tokens are',
    resolveSessionDir(cfg, climative, bead('Repo:BS')) === BUILDING,
    resolveSessionDir(cfg, climative, bead('Repo:BS'))
  );

  const { dir, repo } = resolveSessionRepo(cfg, climative, bead('repo:bs'));
  check(
    'resolveSessionRepo hands back which repo it was, so a caller can name it',
    dir === BUILDING && repo?.name === 'building-service' && repo?.token === 'bs',
    JSON.stringify({ dir, repo })
  );
  check('and null for a workspace that is one repo', resolveSessionRepo({ workspaces: [sophab] }, sophab).repo === null);

  check(
    'a bead carrying no repo: label belongs to the default repo',
    resolveSessionDir(cfg, climative, bead('climative', 'human')) === ARCHITECTURE,
    resolveSessionDir(cfg, climative, bead('climative', 'human'))
  );
  check('no bead at all is the same answer — the question is about the workspace', resolveSessionDir(cfg, climative) === ARCHITECTURE);
  check('a bare token string is accepted where a bead would go', resolveSessionDir(cfg, climative, 'bs') === BUILDING);
}

/* ------------------------------------------- 3. and every other answer is a refusal */

console.log('\nand nothing is guessed at');

{
  const cfg = withRepos();

  refusal(
    'a token no approved repo declares refuses — it does NOT become architecture',
    () => resolveSessionDir(cfg, climative, bead('repo:ws')),
    'no approved climative repo declares the service token "ws"'
  );
  refusal(
    'a token two approved repos declare refuses, and names both',
    () => resolveSessionDir(cfg, climative, bead('repo:as')),
    'athena-service',
    'audit-service',
    'will not guess'
  );
  refusal(
    'two different repo: labels refuse rather than taking the first',
    () => resolveSessionDir(cfg, climative, bead('repo:bs', 'repo:architecture')),
    'carries 2 service tokens'
  );
  check(
    'but the same token twice is one answer written twice',
    resolveSessionDir(cfg, climative, bead('repo:bs', 'repo:BS')) === BUILDING
  );
  refusal(
    'a bare repo: label refuses — it must not read as an unlabelled bead',
    () => resolveSessionDir(cfg, climative, bead('repo:')),
    'bare "repo:" label'
  );
  refusal(
    'and with no default set, a bead naming nothing refuses too',
    () => resolveSessionDir({ ...withRepos(), repos: { climative: { root: ROOT, approved: ['athena-service', 'building-service'] } } }, climative),
    'does not name a repo that resolved'
  );

  // The unapproved checkout is on disk and declares `ws`; the refusal above is the proof
  // that approval, not the directory, is what makes a repo reachable.
  check('the unlisted checkout is on disk, so that refusal was about approval', fs.existsSync(path.join(ROOT, 'weather-service')));
}

/* -------------------------------------------------- 4. beadToken on its own */

console.log('\nbeadToken');

{
  assert.deepEqual(beadToken(null), { token: '', problem: null });
  assert.deepEqual(beadToken({ labels: ['human'] }), { token: '', problem: null });
  assert.deepEqual(beadToken({ labels: ['repo:as'] }), { token: 'as', problem: null });
  assert.deepEqual(beadToken('as'), { token: 'as', problem: null });
  ok('no bead, no label, one label and a bare string all answer {token, problem}');
  check('a bead with no labels array at all is not a crash', beadToken({ id: 'cl-1' }).token === '');
  check('and repoLabel is the one spelling', repoLabel('as') === 'repo:as' && repoLabel(' as ') === 'repo:as');
}

/* ------------------------------------- 5. sessionDirs and an approved list disagree */

console.log('\nwhen the config says two things');

{
  const cfg = withRepos({ sessionDirs: { climative: ARCHITECTURE } });
  check(
    'the repo the bead named wins over the sessionDirs pin',
    resolveSessionDir(cfg, climative, bead('repo:bs')) === BUILDING,
    resolveSessionDir(cfg, climative, bead('repo:bs'))
  );
  const warned = repoWarnings(cfg).filter((w) => w.includes('sessionDirs.climative'));
  check('and the contradiction is a warning at load, not a surprise at 3am', warned.length === 1, JSON.stringify(repoWarnings(cfg)));
  check('a workspace with no approved list gets no such warning', !repoWarnings({ sessionDirs: { sophab: BUILDING } }).length);
}

/* ------------------------------------------------ 6. ownWorkspace runs it backwards */

console.log('\nthe reverse map (lib/deploy.js)');

{
  const cfg = withRepos();
  check('the default repo maps back to the workspace', ownWorkspace(cfg, ARCHITECTURE) === 'climative');
  check(
    'and so does an approved repo that is NOT the default — the whole point',
    ownWorkspace(cfg, BUILDING) === 'climative',
    String(ownWorkspace(cfg, BUILDING))
  );
  check('a repo sharing a duplicate token still maps back — it is approved, it is the workspace', ownWorkspace(cfg, AUDIT) === 'climative');
  check('an unapproved checkout under the same root maps to nothing', ownWorkspace(cfg, path.join(ROOT, 'weather-service')) === null);
  check('and a single-repo workspace still maps by its session directory', ownWorkspace({ workspaces: [sophab] }, path.join(BEADS, 'sophab')) === 'sophab');
}

forgetRepos();
fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n${failures} failed` : '\nall good');
process.exit(failures ? 1 : 0);
