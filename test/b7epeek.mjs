#!/usr/bin/env node
//
// b7e-peek — what a sibling worktree is actually adding to a file, right now
// (bc-dgx7.43). lib/peek.js and bin/b7e-peek.
//
//   npm test
//   node test/b7epeek.mjs
//
// Real worktrees, really edited — the same reason test/siblings.mjs and test/regions.mjs
// give: the whole assertion is about what `git worktree list`, `git diff` and `git log`
// actually report, and a stub would only prove the parser can read strings this file
// wrote. Replays the bead's own acceptance criteria:
//
//   1. From worktree A, peeking worktree B's committed change to a file with no `git -C`
//      anywhere in the argv the caller types.
//   2. A sibling whose work is entirely uncommitted, where `git diff main...<branch>`
//      answers empty — the exact silently-wrong case bc-khoe.27.10 hit by hand.
//   3. A worktree name given with or without the `worktree-` prefix, or as a bare
//      directory name, resolves the same worktree.
//   4. A branch whose directory has been removed still answers, from refs alone.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-peek');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7epeek-'));
process.on('exit', () => removeTreeSync(tmp));

/* ------------------------------------------------------------------------- the repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const REPO = path.join(tmp, 'repo');
const FILE = 'lib/toolbelt.js';
const line = (n) => `  const line${n} = ${n};`;

fs.mkdirSync(path.join(REPO, 'lib'), { recursive: true });
git(REPO, 'init', '-q', '-b', 'main');
git(REPO, 'config', 'user.email', 't@e');
git(REPO, 'config', 'user.name', 'test');
const BASE = Array.from({ length: 30 }, (_, i) => line(i + 1)).join('\n') + '\n';
fs.writeFileSync(path.join(REPO, FILE), BASE);
git(REPO, 'add', '-A');
git(REPO, 'commit', '-qm', 'base');

/** A worktree at `.claude/worktrees/<name>`, on branch `worktree-<name>` — this repo's own convention. */
function tree(name) {
  const dir = path.join(REPO, '.claude', 'worktrees', name);
  const branch = `worktree-${name}`;
  git(REPO, 'worktree', 'add', '-q', '-b', branch, dir, 'main');
  return {
    dir,
    branch,
    edit(from, to, text = 'CHANGED') {
      const lines = fs.readFileSync(path.join(dir, FILE), 'utf8').split('\n');
      for (let n = from; n <= to; n += 1) lines[n - 1] = `  const line${n} = '${text}';`;
      fs.writeFileSync(path.join(dir, FILE), lines.join('\n'));
      return this;
    },
    commit(msg = 'work') {
      git(dir, 'add', '-A');
      git(dir, 'commit', '-qm', msg);
      return this;
    },
  };
}

// Case: committed change only.
const alpha = tree('alpha').edit(4, 6).commit();

// Case: entirely uncommitted — `git diff main...<branch>` answers empty for this one.
const bravo = tree('bravo').edit(10, 11); // deliberately not committed

// Case: a branch removed on disk, surviving only in refs.
const gone = tree('gone').edit(20, 20).commit();
git(REPO, 'worktree', 'remove', '--force', gone.dir);

// Case: nothing touched at all.
tree('idle');

/* -------------------------------------------------------------------------- fake gh */

const BIN_DIR = path.join(tmp, 'bin');
fs.mkdirSync(BIN_DIR, { recursive: true });
fs.writeFileSync(
  path.join(BIN_DIR, 'gh'),
  `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === 'auth' && a[1] === 'status') process.exit(0);
if (a[0] === 'repo' && a[1] === 'view') { console.log('{"nameWithOwner":"mordam/widgets","viewerPermission":"WRITE"}'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') { console.log('[]'); process.exit(0); }
console.error('unexpected gh: ' + a.join(' '));
process.exit(1);
`,
  { mode: 0o755 }
);

/* --------------------------------------------------------------------- --bead fixture */

const sessionsDir = path.join(tmp, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });
fs.writeFileSync(
  path.join(sessionsDir, `${process.pid}.json`),
  JSON.stringify({ pid: process.pid, cwd: alpha.dir, name: 'Beadcause - bc-peek.7 something', status: 'busy', startedAt: Date.now() })
);

const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify({ claudeSessionsDir: sessionsDir }, null, 2));

function run(args) {
  const res = spawnSync(process.execPath, [BIN, '--dir', REPO, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}` },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

/* ------------------------------------------------------------------------- harness */

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

console.log('\nb7e-peek\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-peek/);
});

check('nothing to look up is refused', () => {
  const { status, stderr } = run([]);
  assert.notEqual(status, 0);
  assert.match(stderr, /nothing to look up/);
});

check('an unknown name is refused with exit 4', () => {
  const { status, stderr } = run(['worktree-nowhere']);
  assert.equal(status, 4);
  assert.match(stderr, /no worktree or branch answers/);
});

check('acceptance 1: a committed change prints the hunk, no -C anywhere in the argv this needed', () => {
  const { status, stdout } = run([alpha.branch, FILE]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(alpha.branch));
  assert.match(stdout, /1 commit ahead of main/);
  assert.match(stdout, /\(committed\)/);
  assert.match(stdout, /-\s+const line5 = 5;/);
  assert.match(stdout, /\+\s+const line5 = 'CHANGED';/);
});

check("acceptance 2: entirely uncommitted work prints its hunk, where git diff main...branch would not", () => {
  const empty = git(REPO, 'diff', `main...${bravo.branch}`, '--', FILE);
  assert.equal(empty, '', 'the naive form really does answer empty for uncommitted work');

  const { status, stdout } = run([bravo.branch, FILE]);
  assert.equal(status, 0);
  assert.match(stdout, /\(uncommitted\)/);
  assert.match(stdout, /\+\s+const line10 = 'CHANGED';/);
});

check('acceptance 3a: the bare name, no worktree- prefix, resolves the same worktree', () => {
  const { status, stdout } = run(['alpha', FILE]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(alpha.branch));
});

check('acceptance 3b: the full branch name resolves too', () => {
  const { status, stdout } = run([alpha.branch, FILE]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(alpha.branch));
});

check('acceptance 4: a branch whose directory is gone still answers, from refs', () => {
  const { status, stdout } = run([gone.branch, FILE]);
  assert.equal(status, 0);
  assert.match(stdout, /pruned/);
  assert.match(stdout, /\(committed\)/);
  assert.match(stdout, /const line20 = 'CHANGED';/);
});

check('a worktree that has touched nothing prints "nothing pending" and still exits 0', () => {
  const { status, stdout } = run(['idle']);
  assert.equal(status, 0);
  assert.match(stdout, /nothing pending/);
});

check('with no path, every touched file is listed', () => {
  const { status, stdout } = run([alpha.branch]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(FILE.replace('.', '\\.')));
});

check('--stat prints counts, no hunk body', () => {
  const { status, stdout } = run([alpha.branch, FILE, '--stat']);
  assert.equal(status, 0);
  assert.match(stdout, /\+\d+ -\d+/);
  assert.doesNotMatch(stdout, /@@/);
});

check('--json emits parseable, structurally complete output', () => {
  const { status, stdout } = run([alpha.branch, FILE, '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.branch, alpha.branch);
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].file, FILE);
  assert.match(parsed.files[0].diff, /line5/);
});

check('--bead resolves the worktree from a live session, not a name', () => {
  const { status, stdout } = run(['--bead', 'bc-peek.7', FILE]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(alpha.branch));
});

check('an unknown bead is refused with exit 4', () => {
  const { status, stderr } = run(['--bead', 'bc-nope.1']);
  assert.equal(status, 4);
  assert.match(stderr, /no live session names/);
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
