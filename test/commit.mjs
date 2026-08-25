#!/usr/bin/env node
//
// b7e-commit — the commit before the delivery, written the house way (bc-xl7n.119).
//
//   npm test
//   node test/commit.mjs
//
// lib/commit.js does the message shape and the git plumbing; this drives both it and
// the real bin/b7e-commit CLI against a fabricated git repo — a scratch checkout with
// its own author identity, so the suite never depends on (or pollutes) this laptop's
// own ~/.gitconfig. commitMessage() is pure and gets its own checks; commitAll() and
// the CLI need a real `git` underneath them, the same split test/triage.mjs and
// test/gate.mjs use for their own siblings.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-commit');

const { commitMessage, commitAll, currentBranch, CO_AUTHORED_BY } = await import(path.join(ROOT, 'lib', 'commit.js'));

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
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-commit-test-'));

const git = (dir, args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });

/** A fresh repo at `<tmp>/<name>/`, on `branch`, with one file already committed. */
function repo(name, branch = 'work') {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.name', 'Test Committer']);
  git(dir, ['config', 'user.email', 'test-committer@example.invalid']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'seed\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'seed']);
  if (branch !== 'main') git(dir, ['checkout', '--quiet', '-b', branch]);
  return dir;
}

const CFG = { workspaces: [{ name: 'beadcause' }], pr: { base: 'main' } };

/* -------------------------------------------------------------- commitMessage() */

check('subject is "<bead>: <first line>"', () => {
  const msg = commitMessage('bc-xl7n.119', 'clearAbandonedLocks the house way');
  assert.equal(msg.split('\n')[0], 'bc-xl7n.119: clearAbandonedLocks the house way');
});

check('backticks, $(...) and a heredoc terminator survive verbatim', () => {
  const body = 'fix `clearAbandonedLocks`\n\nran $(rm -rf /) by hand once, never again\nEOF\nmore text';
  const msg = commitMessage('bc-xl7n.93', body);
  assert.ok(msg.includes('fix `clearAbandonedLocks`'));
  assert.ok(msg.includes('$(rm -rf /)'));
  assert.ok(msg.includes('\nEOF\n'));
});

check('trailer is added exactly once when the body has none', () => {
  const msg = commitMessage('bc-xl7n.119', 'a subject\n\na body paragraph');
  const count = msg.split('\n').filter((l) => l.startsWith('Co-Authored-By:')).length;
  assert.equal(count, 1);
  assert.ok(msg.trimEnd().endsWith(CO_AUTHORED_BY));
});

check('trailer is not duplicated when the body already has one', () => {
  const msg = commitMessage('bc-xl7n.119', `a subject\n\na body\n\n${CO_AUTHORED_BY}`);
  const count = msg.split('\n').filter((l) => l.startsWith('Co-Authored-By:')).length;
  assert.equal(count, 1);
});

check('a differently-worded existing trailer still counts as present', () => {
  const msg = commitMessage('bc-xl7n.119', 'subject\n\nCo-Authored-By: Someone Else <else@example.com>');
  const count = msg.split('\n').filter((l) => l.startsWith('Co-Authored-By:')).length;
  assert.equal(count, 1, 'a second, standard trailer must not be appended alongside an existing one');
});

check('a single-line body gets a trailer and no stray blank body paragraph', () => {
  const msg = commitMessage('bc-xl7n.119', 'just a subject line');
  assert.equal(msg, `bc-xl7n.119: just a subject line\n\n${CO_AUTHORED_BY}\n`);
});

check('an empty body (or all whitespace) is refused with null, not an empty message', () => {
  assert.equal(commitMessage('bc-xl7n.119', ''), null);
  assert.equal(commitMessage('bc-xl7n.119', '   \n\n  \n'), null);
});

/* ------------------------------------------------------------------ commitAll() */

check('refuses on main, having written nothing', () => {
  const dir = repo('on-main', 'main');
  assert.throws(() => commitAll(dir, { beadId: 'bc-x', body: 'do a thing', cfg: CFG, workspaceName: 'beadcause' }), /main/);
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), '1', 'no second commit should exist');
});

check('refuses on an empty staged tree, having written nothing', () => {
  const dir = repo('empty-tree');
  assert.throws(
    () => commitAll(dir, { beadId: 'bc-x', body: 'do a thing', cfg: CFG, workspaceName: 'beadcause' }),
    /nothing staged|clean/
  );
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), '1');
});

check('refuses on an empty body, having written nothing', () => {
  const dir = repo('empty-body');
  fs.writeFileSync(path.join(dir, 'new.txt'), 'content\n');
  assert.throws(() => commitAll(dir, { beadId: 'bc-x', body: '   ', cfg: CFG, workspaceName: 'beadcause' }), /empty/);
  assert.equal(git(dir, ['status', '--porcelain']).trim() !== '', true, 'the new file must still be sitting unstaged');
});

check('stages everything, commits, and reports the sha/subject/files', () => {
  const dir = repo('happy-path');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'sub', 'b.txt'), 'b\n');
  const result = commitAll(dir, {
    beadId: 'bc-xl7n.119',
    body: 'ship the thing\n\nmore detail here',
    cfg: CFG,
    workspaceName: 'beadcause',
  });
  assert.equal(result.subject, 'bc-xl7n.119: ship the thing');
  assert.match(result.sha, /^[0-9a-f]{40}$/);
  assert.deepEqual(result.files.sort(), ['a.txt', 'sub/b.txt']);
  const body = git(dir, ['log', '-1', '--format=%B']);
  assert.ok(body.includes(CO_AUTHORED_BY));
});

check('never passes --author — identity is whatever git resolves for the checkout', () => {
  const dir = repo('author-identity');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  commitAll(dir, { beadId: 'bc-x', body: 'change something', cfg: CFG, workspaceName: 'beadcause' });
  const authorEmail = git(dir, ['log', '-1', '--format=%ae']).trim();
  assert.equal(authorEmail, 'test-committer@example.invalid', "must be the checkout's own configured identity");
});

check('backticks and $(...) in the body commit verbatim through real git, not expanded', () => {
  const dir = repo('shell-hazard');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const canary = path.join(tmp, 'should-not-exist-b7e-commit-canary');
  const dangerous = `fix \`clearAbandonedLocks\`\n\nran $(touch ${canary}) by hand`;
  commitAll(dir, { beadId: 'bc-xl7n.93', body: dangerous, cfg: CFG, workspaceName: 'beadcause' });
  const msg = git(dir, ['log', '-1', '--format=%B']);
  assert.ok(msg.includes('fix `clearAbandonedLocks`'));
  assert.ok(msg.includes(`$(touch ${canary})`));
  assert.equal(fs.existsSync(canary), false, 'the $(...) must never have been executed');
});

check('--amend is exempt from the empty-tree refusal', () => {
  const dir = repo('amend-message-only');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  const first = commitAll(dir, { beadId: 'bc-x', body: 'first message', cfg: CFG, workspaceName: 'beadcause' });
  // Nothing new staged — amend should still be allowed, changing only the message.
  const second = commitAll(dir, {
    beadId: 'bc-x',
    body: 'corrected message',
    amend: true,
    cfg: CFG,
    workspaceName: 'beadcause',
  });
  assert.equal(second.subject, 'bc-x: corrected message');
  assert.notEqual(second.sha, first.sha);
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), '2', 'amend must not add a second commit on top');
});

check('currentBranch names the branch, not "HEAD", on an ordinary checkout', () => {
  const dir = repo('branch-name', 'worktree-something-abc123');
  assert.equal(currentBranch(dir), 'worktree-something-abc123');
});

/* ---------------------------------------------------------------------- the CLI */

// An isolated BEADCAUSE_CONFIG_DIR, exactly the shape test/blockcli.mjs and
// test/asktail.mjs use, so this suite never reads or writes this laptop's own
// config.json (which is the real beadcause workspace's own tracker, right now).
const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
// reconcileWorkspaces (lib/config.js) drops any saved workspace whose `dir` does not
// exist on disk, on every load — so the directory has to be real, even though nothing
// in this suite ever asks `bd` a question through it.
const demoWsDir = path.join(tmp, 'demo', '.beads');
fs.mkdirSync(demoWsDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify({ workspaces: [{ name: 'demo', dir: demoWsDir }], pr: { base: 'main' } }, null, 2)
);
// HOME is overridden too — lib/workspaceroots.js's defaultWorkspaceRoot() reads
// os.homedir() fresh on every loadConfig() and reconciles the saved workspace list
// against whatever it finds under `<home>/beads`, live, on every call. Leaving the
// real HOME in place would have this suite's own discovery silently splice this
// laptop's real workspaces (and rewrite the isolated config.json to match) the moment
// any of them existed, exactly the way test/blockcli.mjs points HOME at its own tmp
// tree for the same reason.
const cliEnv = { ...process.env, BEADCAUSE_CONFIG_DIR: configDir, HOME: tmp };

function run(dir, args, input) {
  return spawnSync(process.execPath, [BIN, ...args], { cwd: dir, input, encoding: 'utf8', env: cliEnv });
}

check('CLI: --help exits 0 without touching git or reading config', () => {
  const dir = repo('cli-help');
  const r = run(dir, ['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /b7e-commit/);
});

check('CLI: missing -w/-b is refused with usage, exit 1', () => {
  const dir = repo('cli-usage');
  const r = run(dir, ['-w', 'demo']);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /usage/);
});

check('CLI: an unknown workspace name is refused, not silently accepted', () => {
  const dir = repo('cli-unknown-ws');
  const r = run(dir, ['-w', 'nope', '-b', 'bc-x'], 'a message');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /workspaces: demo/);
});

check('CLI: commits a stdin body with backticks and prints the sha/subject/files', () => {
  const dir = repo('cli-happy');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const r = run(dir, ['-w', 'demo', '-b', 'bc-xl7n.119'], 'do a `thing`\n\nmore body\n');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /1 file:/);
  assert.match(r.stdout, /x\.txt/);
  assert.match(r.stdout, /bc-xl7n\.119: do a `thing`/);
  const msg = git(dir, ['log', '-1', '--format=%B']);
  assert.ok(msg.includes(CO_AUTHORED_BY));
});

check('CLI: --file reads the body from a path instead of stdin', () => {
  const dir = repo('cli-file');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const msgFile = path.join(tmp, 'cli-file-msg.txt');
  fs.writeFileSync(msgFile, 'from a file, not stdin\n');
  const r = run(dir, ['-w', 'demo', '-b', 'bc-x', '--file', msgFile]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /from a file, not stdin/);
});

check('CLI: refuses on main with a non-zero exit and writes nothing', () => {
  const dir = repo('cli-main', 'main');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const r = run(dir, ['-w', 'demo', '-b', 'bc-x'], 'a message');
  assert.notEqual(r.status, 0);
  assert.equal(git(dir, ['rev-list', '--count', 'HEAD']).trim(), '1');
});

check('CLI: refuses on an empty stdin body with a non-zero exit', () => {
  const dir = repo('cli-empty-body');
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x\n');
  const r = run(dir, ['-w', 'demo', '-b', 'bc-x'], '   \n');
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /empty/);
});

console.log('');
console.log(failures ? `\x1b[31m${ran - failures}/${ran} passed\x1b[0m` : `\x1b[32m${ran}/${ran} passed\x1b[0m`);

removeTreeSync(tmp);
process.exit(failures ? 1 : 0);
