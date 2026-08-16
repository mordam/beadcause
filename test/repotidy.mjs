#!/usr/bin/env node
/**
 * **The worktree sweep, across every checkout one advocate spans.**
 *
 *     npm test
 *     node test/repotidy.mjs
 *
 * bc-u53i. `tidy` in lib/advocate.js was the last of the advocate's loops still asking
 * `resolveSessionDir(cfg, a.workspace)` with no bead — one directory, the workspace's
 * `default` repo — long after the sweeps that decide the *queue* had learned to ask all
 * of them (bc-l853.4, test/repoqueue.mjs).
 *
 * It is worth saying why that was left behind, because it is not the same bug the other
 * three had. Those are questions whose wrong answer hands out an iTerm window: a bead
 * whose pull request is open one repo along looks, to a sweep that asked only
 * `architecture`, exactly like a bead nobody has started. Nothing here is like that. A
 * worktree in `athena-service` that is never retired breaks nothing — it sits there, and
 * so does the attic behind it, in thirty-nine repos, forever. A leak rather than a bug,
 * which is why it could wait and why it still had to be fixed.
 *
 * `.claude/worktrees/` is per checkout, so this genuinely is N sweeps rather than one
 * merged answer, and the three claims below are what that has to mean:
 *
 * 1. **Both checkouts are swept**, and the non-default one is the case — that is the
 *    bead's acceptance criterion, and the version of this suite that only asserted the
 *    total would have passed with `architecture` swept twice.
 * 2. **The card names each repo**, because "retired swr-cache-8t3" without a repo in
 *    front of it is not something anybody can act on in a workspace of forty.
 * 3. **One checkout that cannot be swept does not take the others down**, the same rule
 *    the queue's sweeps keep — and it says on the card that it did not answer, rather
 *    than reporting a clean sweep of a repo it never looked at.
 *
 * And the fourth, which is the one that would be a regression rather than a gap: a
 * single-repo workspace — every workspace on this Mac except Climative — must produce
 * the string it always produced, with no repo prefix and no per-repo rows at all.
 *
 * Real git, for the reason test/retire.mjs is real git: every claim here is a question
 * about worktree registrations, and a fake would only prove the fake works. `gh` is not
 * faked and not needed — `pr.enabled: false` in the config turns `prMerges` off, so the
 * sweep asks git alone, and every worktree here is genuinely merged into local `main`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (name) => path.join(HERE, '..', 'lib', name);

// `realpathSync` for the reason test/retire.mjs gives: `git worktree list` reports every
// path resolved, and on macOS `os.tmpdir()` is `/var/…` where git says `/private/var/…`.
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-repotidy-')));

// Before anything under lib/ is imported: CONFIG_DIR resolves once, at module load, and
// the daemon's own advocates.json is not this suite's to read or to write.
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

const { createAdvocates } = await import(LIB('advocate.js'));
const { forgetRepos } = await import(LIB('repos.js'));
const { cleanupTmp, quiesce, removeTree } = await import(path.join(HERE, 'helpers', 'tmp.mjs'));

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
    console.error(`  FAIL ${name}`);
    console.error(`       ${(err && err.message ? err.message : String(err)).split('\n').join('\n       ')}`);
  }
}

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 't@e',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 't@e',
    },
  }).trim();

/* ----------------------------------------------------------------- the checkouts */

const ORG = path.join(tmp, 'climative.dev');

/**
 * One approved Climative repo: a git checkout with a `config/config.yaml` naming its
 * service token, which is what lib/repos.js reads to decide a repo is placeable at all.
 */
function checkout(name, token) {
  const dir = path.join(ORG, name);
  fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config', 'config.yaml'), `serviceToken: ${token}\n`);
  git(tmp, 'init', '--quiet', '--initial-branch=main', dir);
  fs.writeFileSync(path.join(dir, 'file.txt'), 'one\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', 'one');
  return dir;
}

/**
 * A worktree in the state a delivered session leaves behind: branched off main, one
 * commit, merged back, clean, and under `.claude/worktrees/`. Everything the sweep
 * checks says yes, so anything left unswept is the sweep never having looked.
 */
function worktree(repo, name) {
  const dir = path.join(repo, '.claude', 'worktrees', name);
  git(repo, 'worktree', 'add', '--quiet', '-b', `worktree-${name}`, dir, 'main');
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', name);
  git(repo, 'merge', '--quiet', '--no-ff', '-m', `merge ${name}`, `worktree-${name}`);
  return dir;
}

/**
 * Backdate a tree past `QUIET_MINUTES`, which is 10 and which every fixture here would
 * otherwise fail: a worktree created this second is "touched 1 minute(s) ago" and the
 * gate keeps it, which would hold the whole suite green while sweeping nothing. Run
 * after every mutation — writing into a directory bumps the directory too — and skip
 * `.git`, exactly as `lastTouched` does.
 */
const QUIET = new Date(Date.now() - 60 * 60 * 1000);
function quieten(dir) {
  const walk = (d) => {
    let entries = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git') continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      try {
        fs.utimesSync(p, QUIET, QUIET);
      } catch {
        /* vanished mid-walk */
      }
    }
  };
  walk(dir);
}

/** The attic's directories, without the `<name>.note` stamp the sweep leaves beside each. */
const retiredIn = (repo) => {
  try {
    return fs
      .readdirSync(path.join(repo, '.claude', 'worktrees-retired'))
      .filter((n) => !n.endsWith('.note'))
      .sort();
  } catch {
    return [];
  }
};

/* ----------------------------------------------------------------------- a tick */

/**
 * One advocate tick, with the sweep on and everything else off.
 *
 * `pr.enabled: false` is doing real work rather than tidying the fixture: it is what
 * turns `prMerges` off, so the sweep never reaches `gh` and this suite needs no fake
 * binary on PATH. Every worktree it is asked about is merged locally, which is the
 * question the sweep then asks.
 */
async function tick({ repos, sessionDirs = {}, workspaces }) {
  const dir = process.env.BEADCAUSE_CONFIG_DIR;
  // `quiesce` + `removeTree` rather than a bare recursive `rmSync`: every write of
  // `advocates.json` schedules a common-repo commit 2000ms out whose `git init` lands in
  // `CONFIG_DIR`, and rmdir on a directory that gained a file since it was read is
  // ENOTEMPTY. test/tmpadoption.mjs fails the repo for the bare form (bc-9d37.9).
  await quiesce();
  for (const f of fs.readdirSync(dir)) await removeTree(path.join(dir, f));
  // Memoised against the block and the token files' mtimes, and two cases a millisecond
  // apart can share a stamp. Nothing in the daemon needs this; a suite rewriting the
  // same paths in the same second does.
  forgetRepos();

  const cfg = {
    projectRoot: path.join(tmp, 'projects'),
    fallbackWorkspace: 'other',
    claudeSessionsDir: path.join(tmp, 'claude-sessions'),
    spaces: [],
    workspaces,
    repos,
    sessionDirs,
    pr: { enabled: false },
    advocates: {
      enabled: true,
      workspaces: '*',
      maxWorkers: 1,
      settleSeconds: 0,
      launchCooldownSeconds: 0,
      tidyWorktrees: true,
      // Each of these has its own suite and each would otherwise run a real agent, a
      // real `gh` or a real `bd` against a temp directory on every case here.
      propose: false,
      respectQuietHours: false,
      reconcileLanded: false,
      askSuperseded: false,
      flagInMain: false,
      flagNotInMain: false,
      sessionLog: false,
      planEpics: false,
    },
  };
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));

  const bd = {
    ready: async () => [],
    listLabel: async () => [],
    show: async () => null,
    children: async () => [],
    listStatus: async () => [],
  };
  const advocates = createAdvocates(cfg, {
    bd,
    bus: { emit() {} },
    open: async () => {
      throw new Error('nothing is ready — no window may be opened');
    },
    openPlan: async () => {
      throw new Error('nothing is ready — no window may be opened');
    },
  });
  await advocates.tick();
  return advocates.snapshot();
}

/* -------------------------------------------------------------------- the cases */

console.log('\nthe worktree sweep across many checkouts');

const architecture = checkout('architecture', 'architecture');
const athena = checkout('athena-service', 'as');
worktree(architecture, 'arch-one');
worktree(athena, 'athena-one');
quieten(architecture);
quieten(athena);

const MULTI = {
  repos: { climative: { root: ORG, default: 'architecture', approved: ['architecture', 'athena-service'] } },
  workspaces: [{ name: 'climative', dir: path.join(tmp, 'beads', 'climative', '.beads') }],
};

const card = (await tick(MULTI)).find((a) => a.workspace === 'climative');

/** The acceptance criterion: the non-default checkout's worktree is retired too. */
await check('a worktree in a non-default approved repo is retired', () => {
  assert.deepEqual(retiredIn(athena), ['athena-one'], 'athena-service was never swept');
  assert.deepEqual(retiredIn(architecture), ['arch-one'], 'and the default repo still is');
});

/** And the card is readable in a workspace of forty: every line says which repo. */
await check('the summary names the checkout each retirement is in', () => {
  assert.match(card.tidy.summary, /architecture: retired arch-one/, card.tidy.summary);
  assert.match(card.tidy.summary, /athena-service: retired athena-one/, card.tidy.summary);
  assert.equal(card.tidy.retired, 2, 'and the count is the workspace total');
  assert.deepEqual(
    card.tidy.repos.map((r) => [r.repo, r.retired]),
    [
      ['architecture', 1],
      ['athena-service', 1],
    ],
    'with a row per checkout, in the order the approved list is written'
  );
});

/**
 * A repo on the approved list that is not a git checkout at all — somebody's half-done
 * clone, or a directory moved out from under the list. `mainCheckout` throws for it, and
 * the question is whether the *other* repo still gets swept.
 */
const broken = path.join(ORG, 'rules-engine-service');
fs.mkdirSync(path.join(broken, 'config'), { recursive: true });
fs.writeFileSync(path.join(broken, 'config', 'config.yaml'), 'serviceToken: res\n');
worktree(architecture, 'arch-two');
quieten(architecture);

const partial = (
  await tick({
    ...MULTI,
    repos: {
      climative: { root: ORG, default: 'architecture', approved: ['architecture', 'rules-engine-service'] },
    },
  })
).find((a) => a.workspace === 'climative');

await check('one checkout that cannot be swept does not stop the others', () => {
  assert.deepEqual(retiredIn(architecture), ['arch-one', 'arch-two'], 'the answerable repo was still swept');
  assert.match(partial.tidy.summary, /architecture: retired arch-two/, partial.tidy.summary);
  assert.match(partial.tidy.summary, /1 of 2 checkouts did not answer/, partial.tidy.summary);
  assert.equal(partial.tidy.repos[1].repo, 'rules-engine-service');
  assert.ok(partial.tidy.repos[1].error, 'and the row carries the reason rather than a clean zero');
});

/**
 * Every workspace on this Mac but Climative, and the half that would be a regression
 * rather than a gap: the same string it has always produced, and nothing per-repo on the
 * card at all — the rule every other multi-repo field on this card keeps.
 */
const plain = checkout('alpha', 'alpha');
worktree(plain, 'plain-one');
quieten(plain);

const single = (
  await tick({
    repos: {},
    sessionDirs: { alpha: plain },
    workspaces: [{ name: 'alpha', dir: path.join(tmp, 'beads', 'alpha', '.beads') }],
  })
).find((a) => a.workspace === 'alpha');

await check('a single-repo workspace sweeps exactly as it always did', () => {
  assert.deepEqual(retiredIn(plain), ['plain-one']);
  assert.equal(single.tidy.summary, 'retired plain-one', 'no repo prefix on a workspace of one');
  assert.equal(single.tidy.retired, 1);
  assert.equal(single.tidy.repos, undefined, 'and no per-repo rows to draw');
});

/* ----------------------------------------------------------------------- teardown */

await cleanupTmp(tmp);
console.log(`\n${ran - failures}/${ran} ok`);
process.exit(failures ? 1 : 0);
