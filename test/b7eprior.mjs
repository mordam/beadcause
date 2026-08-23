#!/usr/bin/env node
/**
 * `b7e-prior` — has somebody already done this, or part of it, and where is that work
 * sitting now? lib/prior.js and bin/b7e-prior.
 *
 *     npm test
 *     node test/b7eprior.mjs
 *
 * bc-zjab.10's own acceptance criteria are the three cases this replays, against a real
 * throwaway git repo (worktrees included) and a fake `gh`/`bd`:
 *
 * 1. A bead with a **live worktree** whose branch has unpushed commits and no pull
 *    request — bc-zjab.1's second session, which spent most of a session working this
 *    out by hand with six `git`/`gh` calls.
 * 2. A bead named in the **body of a pull request opened for a different branch** —
 *    bc-5e85, told to wait for bc-1eru, whose own pull request said in its body that it
 *    does *not* fix bc-5e85. `--head` can never find this; only a title/body search can.
 * 3. A bead **nobody has touched** — one line, exit 0.
 *
 * Plus a **retired** worktree (bc-y3qk.4's only hit was one), because `git worktree
 * list --porcelain` has to be read as covering both live and retired entries in one call
 * — retiring is `git worktree move`, so a retired entry is still registered, only under
 * a different path.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-prior');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eprior-'));
process.on('exit', () => removeTreeSync(tmp));

/* -------------------------------------------------------------------- the repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const origin = path.join(tmp, 'origin.git');
const REPO = path.join(tmp, 'repo');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, REPO);
git(REPO, 'config', 'user.email', 't@e');
git(REPO, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(REPO, 'file.txt'), 'one\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '--quiet', '-m', 'root');
git(REPO, 'push', '--quiet', '-u', 'origin', 'main');

/** A live worktree, its branch never pushed — the bc-zjab.1 shape. */
function liveUnpushed(name, tag) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  fs.writeFileSync(path.join(live, `${name}-a.txt`), 'a\n');
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', `${name}: first commit`);
  fs.writeFileSync(path.join(live, `${name}-b.txt`), 'b\n');
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', `${name}: second commit`);
  return { branch, dir: live };
}

/** A pushed branch with a worktree, then retired into the attic. */
function retired(name, tag) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  fs.writeFileSync(path.join(live, `${name}.txt`), 'x\n');
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', `${name}: retired work`);
  git(REPO, 'push', '--quiet', 'origin', branch);
  const retiredRoot = path.join(REPO, '.claude', 'worktrees-retired');
  fs.mkdirSync(retiredRoot, { recursive: true });
  const dest = path.join(retiredRoot, name);
  git(REPO, 'worktree', 'move', live, dest);
  return { branch, dir: dest };
}

// Case 1 — bc-zjab.1 shape: two unpushed commits, no PR.
const plan1 = liveUnpushed('plan-surface-warn', 'plan1');

// Case 2 (the PR-body one): the bead itself owns no branch at all — the pull request
// that names it lives on `waitedFor`'s own branch.
const waitedFor = liveUnpushed('chrome-exit-trap', 'wait1');

// Case: a retired worktree is the only hit — bc-y3qk.4's own shape.
const stuck = retired('stuck-sync', 'stuck1');

/* ---------------------------------------------------------------------- fake gh */

const PRS_FILE = path.join(tmp, 'prs.json');
fs.writeFileSync(
  PRS_FILE,
  JSON.stringify([
    {
      number: 488,
      url: 'https://github.com/mordam/widgets/pull/488',
      title: 'ws-wait1: A killed session leaves a headless Chrome',
      state: 'MERGED',
      headRefName: waitedFor.branch,
      baseRefName: 'main',
      body: 'Fixes ws-wait1. This does NOT fix ws-pr2 — that one needs its own session.',
      mergedAt: '2026-01-01T00:00:00Z',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      additions: 1,
      deletions: 1,
      changedFiles: 1,
      isDraft: false,
      mergeable: 'UNKNOWN',
      mergeStateStatus: '',
      statusCheckRollup: [],
    },
  ])
);

const BIN_DIR = path.join(tmp, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.writeFileSync(
  path.join(BIN_DIR, 'gh'),
  `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
const arg = (f) => { const i = a.indexOf(f); return i === -1 ? null : a[i + 1]; };
if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
if (a[0] === 'repo' && a[1] === 'view') { console.log('{"nameWithOwner":"mordam/widgets","viewerPermission":"WRITE"}'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') {
  const rows = JSON.parse(fs.readFileSync(${JSON.stringify(PRS_FILE)}, 'utf8'));
  const head = arg('--head');
  const search = arg('--search');
  let out = rows;
  if (head) out = out.filter((r) => r.headRefName === head);
  if (search) {
    // GitHub's own search is not a plain substring match, but this only has to be
    // faithful enough to prove the caller filters again in JS — see lib/prior.js.
    const needle = search.replace(/ in:title,body$/, '');
    out = out.filter((r) => r.title.includes(needle) || r.body.includes(needle));
  }
  console.log(JSON.stringify(out));
  process.exit(0);
}
console.error('unexpected gh: ' + a.join(' '));
process.exit(1);
`,
  { mode: 0o755 }
);

/* ---------------------------------------------------------------------- fake bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');
const WORLD = {
  issues: {
    'ws-plan1': { id: 'ws-plan1', title: 'Owns the unpushed branch', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: null },
    'ws-wait1': { id: 'ws-wait1', title: 'Owns the branch a PR body names another bead from', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: null },
    'ws-pr2': { id: 'ws-pr2', title: 'Named only in another branch\'s pull request body', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: null },
    'ws-stuck1': { id: 'ws-stuck1', title: 'Owns a retired worktree', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: null },
    'ws-untouched': { id: 'ws-untouched', title: 'Nobody has ever worked this', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: null },
  },
};
fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(CALLS)}, JSON.stringify(args) + '\\n');
const world = ${JSON.stringify(WORLD)};
const die = (m) => { process.stderr.write(m + '\\n'); process.exit(1); };
const verb = args[0];
if (verb === 'show') {
  const id = args[1];
  const issue = world.issues[id];
  if (!issue) die('Error fetching ' + id + ': no issue found matching "' + id + '"');
  process.stdout.write(JSON.stringify([issue]));
  process.exit(0);
}
die('stub bd: unexpected verb "' + verb + '"');
`,
  { mode: 0o755 }
);

/* -------------------------------------------------------------------- config */

const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'prior-ws', dir: path.join(tmp, 'tracker') }], sessionDirs: { 'prior-ws': REPO } }, null, 2)
);
fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}` },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* ------------------------------------------------------------------- harness */

let failures = 0;
const check = (name, fn) => {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 10).join('\n       ')}`);
  }
};

console.log('\nb7e-prior\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-prior/);
});

check('a missing -w is refused', () => {
  const { status, stderr } = run(['-b', 'ws-plan1']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('an unknown bead is refused, not reported as untouched', () => {
  const { status, stderr } = run(['-w', 'prior-ws', '-b', 'ws-nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no bead ws-nope/);
});

check('acceptance 1: a live worktree, two unpushed commits, no PR — named in one call', () => {
  const { status, stdout } = run(['-w', 'prior-ws', '-b', 'ws-plan1']);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(plan1.branch));
  assert.match(stdout, /live worktree/);
  assert.match(stdout, /not pushed/);
  assert.match(stdout, /2 commits? ahead of/);
  assert.match(stdout, /No pull request open or merged/);
});

check('acceptance 2: a bead named only in another branch\'s pull request body', () => {
  const { status, stdout } = run(['-w', 'prior-ws', '-b', 'ws-pr2']);
  assert.equal(status, 0);
  // ws-pr2 owns no branch of its own — nothing to say there — but the PR section
  // must still surface #488, found by title/body search rather than --head.
  assert.match(stdout, /#488/);
  assert.match(stdout, /names it in the title or body/);
});

check('the branch a PR belongs to reports it as "its own branch", not a body match', () => {
  const { status, stdout } = run(['-w', 'prior-ws', '-b', 'ws-wait1']);
  assert.equal(status, 0);
  assert.match(stdout, /#488/);
  assert.match(stdout, new RegExp(`its own branch, ${waitedFor.branch}`));
});

check('a retired worktree is the only hit and is still named', () => {
  const { status, stdout } = run(['-w', 'prior-ws', '-b', 'ws-stuck1']);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(stuck.branch));
  assert.match(stdout, /retired worktree/);
  assert.match(stdout, /pushed to origin/);
});

check('acceptance 3: an untouched bead says so in one line and exits 0', () => {
  const { status, stdout } = run(['-w', 'prior-ws', '-b', 'ws-untouched']);
  assert.equal(status, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one line, got:\n${stdout}`);
  assert.match(stdout, /nothing anywhere names it/);
});

check('--json emits parseable, structurally complete output', () => {
  const { status, stdout } = run(['-w', 'prior-ws', '-b', 'ws-plan1', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.results.length, 1);
  assert.equal(parsed.results[0].id, 'ws-plan1');
  assert.ok(parsed.results[0].branches.some((b) => b.branch === plan1.branch));
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
