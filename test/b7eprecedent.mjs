#!/usr/bin/env node
/**
 * `b7e-precedent` — the sibling bead that already did this shape of change, and the
 * patch it made. lib/precedent.js and bin/b7e-precedent.
 *
 *     npm test
 *     node test/b7eprecedent.mjs
 *
 * bc-dgx7.64's own acceptance criteria, replayed against a real throwaway git repo and
 * a fake `bd`:
 *
 * 1. A sibling under the bead's immediate parent whose commit landed on `main` — named
 *    without being told which sibling or which commit, the way `bc-khoe.30.22` had to
 *    grep for it by hand and guessed wrong first.
 * 2. **The duplicate-commit shape** `bc-dgx7.53` hit: a pre-merge branch commit and the
 *    squash-merge of it both open with `<id>: ` and both land on `main` once merged —
 *    the merge commit (the one carrying `(#PR)`) is what gets reported.
 * 3. A sibling whose commit exists only on an **unmerged branch** — not precedent, and
 *    must not appear.
 * 4. `--root` widening past the immediate parent to a cousin family.
 * 5. A family that has landed nothing — one line, exit 0, not a failure.
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
const BIN = path.join(ROOT, 'bin', 'b7e-precedent');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eprecedent-'));
process.on('exit', () => removeTreeSync(tmp));

/* -------------------------------------------------------------------- the repo */

const git = (cwd, ...args) =>
  execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'test', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 'test', GIT_COMMITTER_EMAIL: 't@e' },
  }).trim();

const REPO = path.join(tmp, 'repo');
fs.mkdirSync(REPO, { recursive: true });
git(REPO, 'init', '--quiet', '--initial-branch=main');
git(REPO, 'config', 'user.email', 't@e');
git(REPO, 'config', 'user.name', 'test');

function commit(file, content, subject) {
  fs.writeFileSync(path.join(REPO, file), content);
  git(REPO, 'add', '-A');
  git(REPO, 'commit', '--quiet', '-m', subject);
  return git(REPO, 'rev-parse', 'HEAD');
}

git(REPO, 'checkout', '-q', '-b', 'main');
commit('root.txt', 'root\n', 'root commit');

// ws-epic.10.1 — landed straight onto main, one commit, carries a PR number.
const sha101 = commit('a.txt', 'a\n', 'ws-epic.10.1: fix widget (#101)');

// ws-epic.10.2 — the bc-dgx7.53 shape: a branch commit with no PR, merged into main by
// a merge commit that DOES carry one. Both open with the same `<id>: ` and both end up
// ancestors of main; the merge commit is the one that must be reported.
git(REPO, 'checkout', '-q', '-b', 'ws-epic.10.2-branch');
commit('b.txt', 'b\n', 'ws-epic.10.2: fix gadget');
git(REPO, 'checkout', '-q', 'main');
git(REPO, 'merge', '--no-ff', '--no-edit', '-m', 'ws-epic.10.2: fix gadget (#102)', 'ws-epic.10.2-branch');
const sha102 = git(REPO, 'rev-parse', 'HEAD');

// ws-epic.10.3 — a commit that opens with its id, on a branch that is NEVER merged.
// Must not be reported as precedent — see the header.
git(REPO, 'checkout', '-q', '-b', 'ws-epic.10.3-branch');
commit('d.txt', 'd\n', 'ws-epic.10.3: unrelated fix (#103)');
git(REPO, 'checkout', '-q', 'main');

// ws-epic.20.1 — landed, but under a different mid-level parent (ws-epic.20) —
// findable only by widening the search with --root.
const sha201 = commit('c.txt', 'c\n', 'ws-epic.20.1: something else entirely (#201)');

// ws-quiet.1 — a family whose only child never landed either, for the "nothing has
// landed" acceptance case.
git(REPO, 'checkout', '-q', '-b', 'ws-quiet.1-branch');
commit('q.txt', 'q\n', 'ws-quiet.1: quiet attempt (#301)');
git(REPO, 'checkout', '-q', 'main');

/* ---------------------------------------------------------------------- fake bd */

const FAKE_BD = path.join(tmp, 'bd');
const WORLD = {
  issues: {
    'ws-epic': { id: 'ws-epic', title: 'The family epic', status: 'open', issue_type: 'epic', priority: 1, assignee: '', parent: null },
    'ws-epic.10': { id: 'ws-epic.10', title: 'Mid epic one', status: 'open', issue_type: 'epic', priority: 1, assignee: '', parent: 'ws-epic' },
    'ws-epic.10.1': { id: 'ws-epic.10.1', title: 'Fix widget', status: 'closed', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-epic.10' },
    'ws-epic.10.2': { id: 'ws-epic.10.2', title: 'Fix gadget', status: 'closed', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-epic.10' },
    'ws-epic.10.3': { id: 'ws-epic.10.3', title: 'Unrelated fix, never merged', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-epic.10' },
    'ws-epic.10.9': { id: 'ws-epic.10.9', title: 'The bead under test', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-epic.10' },
    'ws-epic.20': { id: 'ws-epic.20', title: 'Mid epic two', status: 'open', issue_type: 'epic', priority: 1, assignee: '', parent: 'ws-epic' },
    'ws-epic.20.1': { id: 'ws-epic.20.1', title: 'Something else entirely', status: 'closed', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-epic.20' },
    'ws-quiet': { id: 'ws-quiet', title: 'A quiet epic', status: 'open', issue_type: 'epic', priority: 2, assignee: '', parent: null },
    'ws-quiet.1': { id: 'ws-quiet.1', title: 'Quiet attempt, never merged', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-quiet' },
    'ws-quiet.2': { id: 'ws-quiet.2', title: 'The bead under test, quiet family', status: 'open', issue_type: 'task', priority: 2, assignee: '', parent: 'ws-quiet' },
  },
};

fs.writeFileSync(
  FAKE_BD,
  `#!/usr/bin/env node
const args = process.argv.slice(2);
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
if (verb === 'export') {
  const lines = Object.values(world.issues).map((issue) => {
    const deps = issue.parent ? [{ issue_id: issue.id, depends_on_id: issue.parent, type: 'parent-child' }] : [];
    return JSON.stringify({ ...issue, dependencies: deps });
  });
  process.stdout.write(lines.join('\\n') + '\\n');
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
  JSON.stringify(
    { bdBin: FAKE_BD, actor: 'beadcause-test', workspaces: [{ name: 'precedent-ws', dir: path.join(tmp, 'tracker') }], sessionDirs: { 'precedent-ws': REPO } },
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

console.log('\nb7e-precedent\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-precedent/);
});

check('a missing -w is refused', () => {
  const { status, stderr } = run(['-b', 'ws-epic.10.9']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-w\/--workspace is required/);
});

check('a missing -b is refused', () => {
  const { status, stderr } = run(['-w', 'precedent-ws']);
  assert.notEqual(status, 0);
  assert.match(stderr, /-b\/--bead is required/);
});

check('an unknown bead is refused, not reported as no precedent', () => {
  const { status, stderr } = run(['-w', 'precedent-ws', '-b', 'ws-nope']);
  assert.notEqual(status, 0);
  assert.match(stderr, /no bead ws-nope/);
});

check('acceptance 1+2+3: immediate-parent siblings — landed ones named, the merge commit picked over its own pre-merge branch commit, the unmerged one absent', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-epic.10.9']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-epic\.10\.1/);
  assert.match(stdout, new RegExp(sha101));
  assert.match(stdout, /ws-epic\.10\.2/);
  assert.match(stdout, new RegExp(sha102));
  assert.match(stdout, /\(#102\)/);
  assert.doesNotMatch(stdout, /ws-epic\.10\.3/, 'the never-merged sibling must not appear');
  // A widened search was not asked for — the cousin family under ws-epic.20 is not here.
  assert.doesNotMatch(stdout, /ws-epic\.20\.1/);
});

check('a sibling with a duplicate commit reports the files of the MERGE commit, not the pre-merge one', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-epic.10.9', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  const row = parsed.rows.find((r) => r.id === 'ws-epic.10.2');
  assert.ok(row, `expected a row for ws-epic.10.2:\n${stdout}`);
  assert.equal(row.sha, sha102);
  assert.equal(row.pr, 102);
  assert.ok(row.files.includes('b.txt'));
});

check('--root widens past the immediate parent to a cousin family', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-epic.10.9', '--root', 'ws-epic']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-epic\.20\.1/);
  assert.match(stdout, new RegExp(sha201));
  assert.match(stdout, /ws-epic\.10\.1/); // still finds the closer ones too
});

check('--file prints the sha^1..sha diff from the sibling that touched it', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-epic.10.9', '--file', 'a.txt']);
  assert.equal(status, 0);
  assert.match(stdout, /ws-epic\.10\.1/);
  assert.match(stdout, /\+a/);
});

check('--file for a path no landed sibling touched says so, exit 0', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-epic.10.9', '--file', 'nope.txt']);
  assert.equal(status, 0);
  assert.match(stdout, /None of the .* landed siblings? .* touched nope\.txt/);
});

check('acceptance 5: a family that has landed nothing says so in one line and exits 0', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-quiet.2']);
  assert.equal(status, 0);
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, `expected one line, got:\n${stdout}`);
  assert.match(stdout, /has landed anything/);
});

check('--json emits parseable, structurally complete output for the quiet family', () => {
  const { status, stdout } = run(['-w', 'precedent-ws', '-b', 'ws-quiet.2', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.rows.length, 0);
  assert.equal(parsed.root, 'ws-quiet');
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
