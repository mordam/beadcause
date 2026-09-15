#!/usr/bin/env node
//
// b7e-onbead — who else is live on this bead right now: pid, worktree, work in hand,
// and how to reach them (bc-7qo.24).
//
//   npm test
//   node test/onbead.mjs
//
// bc-7qo.24's own acceptance criteria, replayed against a real throwaway git repo
// (worktrees included) and a fake `bd` — same fixture shape `test/b7eprior.mjs` and
// `test/siblings.mjs` use, for the same reason: every claim here is about what `git
// worktree list`, `git status` and `~/.claude/sessions/*.json` actually report, and a
// stub would only prove the parser can read strings this file wrote.
//
// 1. Two live windows in two worktrees on the same bead — both named, right pids,
//    right branches, a name each SendMessage would use.
// 2. One live window and one retired worktree — distinguished: the retired one is a
//    dead tree with its unpushed commit named, never reported as a peer.
// 3. An unworked bead — nothing, exit 0.
// 4. A committed-unpushed sibling branch, the exact thing bc-7qo.11 had to find with
//    `git diff main..worktree-<name>` by hand.
// 5. A window that names the bead but has cut no worktree yet — the gap bc-7qo.11 and
//    two siblings were standing in when they collided.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-onbead');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-onbead-'));
process.on('exit', () => removeTreeSync(tmp));

const { windowsFor, isEmpty, describeWindows } = await import(path.join(ROOT, 'lib', 'onbead.js'));

/* ------------------------------------------------------------------- harness */

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

/* ---------------------------------------------------------------------- repo */

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

/** A live worktree, its branch never pushed. */
function liveUnpushed(name, tag) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  fs.writeFileSync(path.join(live, `${name}.txt`), 'a\n');
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', `${name}: work`);
  return { branch, dir: live };
}

/** A live worktree that has done nothing since it was cut. */
function liveEmpty(name, tag) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  return { branch, dir: live };
}

/** A live worktree with uncommitted edits sitting in it. */
function liveDirty(name, tag) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  fs.writeFileSync(path.join(live, `${name}.txt`), 'uncommitted\n');
  return { branch, dir: live };
}

/** A pushed branch with a worktree, then retired into the attic — still on disk. */
function retired(name, tag) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  fs.writeFileSync(path.join(live, `${name}.txt`), 'x\n');
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', `${name}: retired work, never merged`);
  const retiredRoot = path.join(REPO, '.claude', 'worktrees-retired');
  fs.mkdirSync(retiredRoot, { recursive: true });
  const dest = path.join(retiredRoot, name);
  git(REPO, 'worktree', 'move', live, dest);
  return { branch, dir: dest };
}

/* -------------------------------------------------------------------- fixtures */

// Case 1 & 4: two live windows on the same bead, one with an unpushed commit ahead of
// main (bc-7qo.11's own shape), one that has done nothing yet.
const alpha = liveUnpushed('onbead-alpha', 'oba1');
const bravo = liveEmpty('onbead-bravo', 'oba1');

// Case 2: a retired worktree owning the same tag — a dead tree, distinct from a peer.
const stuck = retired('onbead-stuck', 'oba1');

// A dirty live worktree — uncommitted work in progress.
const charlie = liveDirty('onbead-charlie', 'oba2');

// A bead nobody has ever touched — untouched1 owns no branch anywhere.
const UNTOUCHED = 'ws-untouched1';

/* ---------------------------------------------------------------- fake sessions */

const sessionsDir = path.join(tmp, 'sessions');
fs.mkdirSync(sessionsDir, { recursive: true });

/** This test process's own pid is the only one a test can be sure is alive. */
function writeSession(name, record) {
  fs.writeFileSync(path.join(sessionsDir, name), JSON.stringify({ pid: process.pid, ...record }));
}

writeSession('alpha.json', { sessionId: 's1', name: 'Beadcause - ws-oba1 alpha window', cwd: alpha.dir, status: 'busy', startedAt: Date.now() - 5 * 60000 });
writeSession('bravo.json', { sessionId: 's2', name: 'Beadcause - ws-oba1 bravo window', cwd: bravo.dir, status: 'idle', startedAt: Date.now() - 2 * 60000 });
// A window naming ws-oba2 by name alone — no worktree cut yet at all.
writeSession('delta.json', { sessionId: 's3', name: 'Beadcause - ws-oba2 delta, reading first', cwd: REPO, status: 'busy', startedAt: Date.now() - 60000 });

const cfg = { claudeSessionsDir: sessionsDir };

/* --------------------------------------------------------------------- cases */

await check('two live windows on the same bead: both named, right pids, right branches', async () => {
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg });
  const a = rows.find((r) => r.branch === alpha.branch);
  const b = rows.find((r) => r.branch === bravo.branch);
  assert.ok(a, 'alpha is in the rows');
  assert.ok(b, 'bravo is in the rows');
  assert.equal(a.session.pid, process.pid);
  assert.equal(a.session.name, 'Beadcause - ws-oba1 alpha window');
  assert.equal(b.session.pid, process.pid);
  assert.equal(b.session.name, 'Beadcause - ws-oba1 bravo window');
  assert.equal(a.worktree.state, 'live');
  assert.equal(b.worktree.state, 'live');
});

await check('the unpushed live window reads as committed-unpushed, with its subject', async () => {
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg });
  const a = rows.find((r) => r.branch === alpha.branch);
  assert.equal(a.state, 'committed-unpushed');
  assert.equal(a.pushed, false);
  assert.ok(a.ahead >= 1);
  assert.match(a.subject, /onbead-alpha: work/);
});

await check('the untouched live window reads as empty', async () => {
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg });
  const b = rows.find((r) => r.branch === bravo.branch);
  assert.equal(b.state, 'empty');
});

await check('a retired worktree is distinguished from a peer — dead tree, no session, its commit named', async () => {
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg: { claudeSessionsDir: path.join(tmp, 'no-sessions-here') } });
  const s = rows.find((r) => r.branch === stuck.branch);
  assert.ok(s, 'the retired worktree is still reported');
  assert.equal(s.worktree.state, 'retired');
  assert.equal(s.session, null, 'no live peer — it is a dead tree, not a window');
  assert.equal(s.state, 'committed-unpushed');
  assert.match(s.subject, /onbead-stuck: retired work, never merged/);
});

await check('a live window is never confused with a retired one on the same tag', async () => {
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg });
  const a = rows.find((r) => r.branch === alpha.branch);
  const s = rows.find((r) => r.branch === stuck.branch);
  assert.equal(a.worktree.state, 'live');
  assert.ok(a.session, 'alpha has a live peer');
  assert.equal(s.worktree.state, 'retired');
  assert.equal(s.session, null, 'stuck has no live peer');
});

await check('uncommitted work reads as dirty, not committed-unpushed', async () => {
  const rows = await windowsFor(REPO, 'ws-oba2', { cfg: { claudeSessionsDir: path.join(tmp, 'no-sessions-here') } });
  const c = rows.find((r) => r.branch === charlie.branch);
  assert.ok(c, 'charlie is reported');
  assert.equal(c.state, 'dirty');
});

await check('a window naming the bead with no worktree yet is still reported', async () => {
  const rows = await windowsFor(REPO, 'ws-oba2', { cfg });
  const delta = rows.find((r) => r.kind === 'session');
  assert.ok(delta, 'delta is reported even though it has cut no worktree');
  assert.equal(delta.session.pid, process.pid);
  assert.equal(delta.worktree, null);
  assert.equal(delta.branch, null);
  assert.equal(delta.state, 'no-worktree');
});

await check('an unworked bead: nothing, and isEmpty says so', async () => {
  const rows = await windowsFor(REPO, UNTOUCHED, { cfg });
  assert.deepEqual(rows, []);
  assert.equal(isEmpty(rows), true);
});

await check('describeWindows names the SendMessage address, and flags a shared name', async () => {
  const echo = liveEmpty('onbead-echo', 'oba1');
  writeSession('echo.json', { sessionId: 's4', name: 'Beadcause - ws-oba1 alpha window', cwd: echo.dir, status: 'busy', startedAt: Date.now() });
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg });
  const lines = describeWindows('ws-oba1', rows).join('\n');
  assert.match(lines, /SendMessage: "Beadcause - ws-oba1 alpha window"/);
  assert.match(lines, /shared by another row here/);
});

await check('a report never mentions claim-guard line ranges — disk state is git status alone', async () => {
  const rows = await windowsFor(REPO, 'ws-oba1', { cfg });
  const lines = describeWindows('ws-oba1', rows).join('\n');
  assert.doesNotMatch(lines, /lines? \d+[-–]\d+/i, 'nothing here reads like a claim-guard line range');
});

/* ---------------------------------------------------------------------- fake bd */

const FAKE_BD = path.join(tmp, 'bd');
const CALLS = path.join(tmp, 'calls.jsonl');
const WORLD = {
  issues: {
    'ws-oba1': { id: 'ws-oba1', title: 'Two live windows and a retired worktree', status: 'in_progress', issue_type: 'task', priority: 2, assignee: 'test-actor', parent: null },
    'ws-untouched1': { id: 'ws-untouched1', title: 'Nobody has ever worked this', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: null },
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

const configDir = path.join(tmp, 'config');
fs.mkdirSync(configDir, { recursive: true });
fs.writeFileSync(
  path.join(configDir, 'config.json'),
  JSON.stringify(
    { bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'onbead-ws', dir: path.join(tmp, 'tracker') }], sessionDirs: { 'onbead-ws': REPO }, claudeSessionsDir: sessionsDir },
    null,
    2
  )
);
fs.mkdirSync(path.join(tmp, 'tracker'), { recursive: true });

function run(args) {
  const res = spawnSync(process.execPath, [BIN, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: configDir },
  });
  if (res.error) throw res.error;
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

await check('CLI: usage on --help, exit 0', () => {
  const res = run(['--help']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /usage: b7e-onbead/);
});

await check('CLI: missing -w/-b is refused, exit 2', () => {
  const res = run(['-b', 'ws-oba1']);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /-w\/--workspace is required/);
});

await check('CLI: unknown workspace, exit 4', () => {
  const res = run(['-w', 'nope', '-b', 'ws-oba1']);
  assert.equal(res.status, 4);
  assert.match(res.stderr, /no workspace named "nope"/);
});

await check('CLI: unknown bead, exit 4', () => {
  const res = run(['-w', 'onbead-ws', '-b', 'ws-nope']);
  assert.equal(res.status, 4);
});

await check('CLI: an unworked bead prints nothing, exit 0', () => {
  const res = run(['-w', 'onbead-ws', '-b', 'ws-untouched1']);
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), '');
});

await check('CLI: --json carries the bd assignee and status alongside the rows', () => {
  const res = run(['-w', 'onbead-ws', '-b', 'ws-oba1', '--json']);
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.assignee, 'test-actor');
  assert.equal(parsed.status, 'in_progress');
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length >= 2);
});

await check('CLI: the printed report names the bead and its assignee', () => {
  const res = run(['-w', 'onbead-ws', '-b', 'ws-oba1']);
  assert.equal(res.status, 0);
  assert.match(res.stdout, /b7e-onbead ws-oba1 · onbead-ws — assignee test-actor \(in_progress\)/);
});

console.log(`\n${ran - failures}/${ran} passed`);
if (failures) process.exit(1);
