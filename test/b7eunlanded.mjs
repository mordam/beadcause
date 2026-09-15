#!/usr/bin/env node
/**
 * `b7e-unlanded` — where does this exist, if it is not on main yet, and what does it
 * say there? lib/unlanded.js and bin/b7e-unlanded.
 *
 *     npm test
 *     node test/b7eunlanded.mjs
 *
 * bc-68ou.15's own acceptance criteria are the cases this replays, against a real
 * throwaway git repo (worktrees included) and a fake `gh`:
 *
 * 1. A symbol that lives only on an open pull request's branch — `bc-khoe.4`'s `viewHop`
 *    shape — resolves to file, line, PR number, state and merge state in one call.
 * 2. A path that does not exist on main at all — `bc-khoe.30.14`'s `public/releases.js`
 *    shape — prints the whole file from wherever it is, with no branch named by the
 *    caller.
 * 3. A path that exists nowhere at all — `bc-fh0sz`'s `lib/shutdown.js` shape — answers
 *    "nowhere", not an empty diff.
 * 4. `main` short-circuits the search once something has landed, so a symbol already on
 *    `main` does not walk every other branch — `--all` overrides it.
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
const BIN = path.join(ROOT, 'bin', 'b7e-unlanded');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-b7eunlanded-'));
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
fs.mkdirSync(path.join(REPO, 'lib'));
fs.writeFileSync(path.join(REPO, 'lib', 'pagealias.js'), "export function otherThing() {}\n");
git(REPO, 'add', '-A');
git(REPO, 'commit', '--quiet', '-m', 'root');
git(REPO, 'push', '--quiet', '-u', 'origin', 'main');

/** A branch with a symbol/file main does not have — pushed, no worktree left behind. */
function pushedBranch(name, tag, write) {
  const branch = `worktree-${name}-${tag}`;
  const live = path.join(REPO, '.claude', 'worktrees', name);
  git(REPO, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  write(live);
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', `${name}: adds it`);
  git(live, 'push', '--quiet', 'origin', branch);
  git(REPO, 'worktree', 'remove', '--force', live);
  return branch;
}

// Case 1 — bc-khoe.4 shape: a symbol on an open, conflicting PR's branch.
const prBranch = pushedBranch('viewthing', 'khoe4', (dir) => {
  fs.appendFileSync(path.join(dir, 'lib', 'pagealias.js'), 'export function viewHop(view) { return view; }\n');
});

// Case 2 — bc-khoe.30.14 shape: a whole file that does not exist on main at all.
const releasesContent = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const releasesBranch = pushedBranch('releases-view', 'khoe7', (dir) => {
  fs.writeFileSync(path.join(dir, 'public-releases.js'), releasesContent);
});

// Case 4 — something already on main, plus a branch that also independently has it,
// to prove the short-circuit and `--all`'s override of it.
git(REPO, 'checkout', '--quiet', 'main');
fs.appendFileSync(path.join(REPO, 'lib', 'pagealias.js'), '\nexport function landedThing() {}\n');
git(REPO, 'add', '-A');
git(REPO, 'commit', '--quiet', '-m', 'lands landedThing');
git(REPO, 'push', '--quiet', 'origin', 'main');
const alsoHasLanded = pushedBranch('also-landed', 'alsl1', (dir) => {
  // Inherits landedThing from main (branched after it landed) — a real branch, no edit.
  fs.writeFileSync(path.join(dir, 'unrelated.txt'), 'x\n');
});

/* ---------------------------------------------------------------------- fake gh */

const PRS_FILE = path.join(tmp, 'prs.json');
fs.writeFileSync(
  PRS_FILE,
  JSON.stringify([
    {
      number: 520,
      url: 'https://github.com/mordam/widgets/pull/520',
      title: 'viewthing: introduce viewHop',
      state: 'OPEN',
      headRefName: prBranch,
      baseRefName: 'main',
      body: '',
      mergedAt: null,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      additions: 3,
      deletions: 0,
      changedFiles: 1,
      isDraft: false,
      mergeable: 'CONFLICTING',
      mergeStateStatus: 'DIRTY',
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
  let out = rows;
  if (head) out = out.filter((r) => r.headRefName === head);
  console.log(JSON.stringify(out));
  process.exit(0);
}
if (a[0] === 'pr' && a[1] === 'view') {
  const rows = JSON.parse(fs.readFileSync(${JSON.stringify(PRS_FILE)}, 'utf8'));
  const row = rows.find((r) => String(r.number) === a[2]);
  if (!row) { console.error('no such pr'); process.exit(1); }
  console.log(JSON.stringify(row));
  process.exit(0);
}
console.error('unexpected gh: ' + a.join(' '));
process.exit(1);
`,
  { mode: 0o755 }
);

function run(args) {
  const res = spawnSync(process.execPath, [BIN, '--dir', REPO, ...args], {
    encoding: 'utf8',
    cwd: tmp,
    env: { ...process.env, HOME: tmp, PATH: `${BIN_DIR}${path.delimiter}${process.env.PATH}` },
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

console.log('\nb7e-unlanded\n');

check('--help prints usage and exits 0', () => {
  const { status, stdout } = run(['--help']);
  assert.equal(status, 0);
  assert.match(stdout, /usage: b7e-unlanded/);
});

check('no argument is refused', () => {
  const { status, stderr } = run([]);
  assert.notEqual(status, 0);
  assert.match(stderr, /nothing to look for/);
});

check('three positional arguments are refused', () => {
  const { status, stderr } = run(['a', 'b', 'c']);
  assert.notEqual(status, 0);
  assert.match(stderr, /too many arguments/);
});

check('acceptance 1: a symbol on an open, conflicting PR — file, line, PR facts in one call', () => {
  const { status, stdout } = run(['viewHop']);
  assert.equal(status, 0);
  assert.match(stdout, /#520/);
  assert.match(stdout, /OPEN/);
  assert.match(stdout, /DIRTY/);
  assert.match(stdout, new RegExp(prBranch));
  assert.match(stdout, /lib\/pagealias\.js:2/);
  assert.match(stdout, /viewHop/);
});

check('a symbol scoped to a path only searches that path', () => {
  const { status, stdout } = run(['viewHop', 'lib/pagealias.js']);
  assert.equal(status, 0);
  assert.match(stdout, /lib\/pagealias\.js:2/);
});

check('acceptance 2: a path absent from main prints the whole file, no branch named', () => {
  const { status, stdout } = run(['public-releases.js']);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(releasesBranch));
  assert.match(stdout, /12 lines/);
  for (let i = 1; i <= 12; i += 1) assert.match(stdout, new RegExp(`line ${i}(\\D|$)`));
});

check('--diff on that same path prints a diff instead of the whole file', () => {
  const { status, stdout } = run(['public-releases.js', '--diff']);
  assert.equal(status, 0);
  assert.match(stdout, /\+line 1\b/);
  assert.doesNotMatch(stdout, /^line 1$/m); // not the bare whole-file dump
});

check('acceptance 3: a path nowhere at all answers "nowhere", not an empty diff', () => {
  const { status, stdout } = run(['lib/shutdown.js']);
  assert.equal(status, 0);
  assert.match(stdout, /nowhere/);
  assert.doesNotMatch(stdout, /diff --git/); // never a diff header
});

check('a symbol nowhere at all also answers "nowhere"', () => {
  const { status, stdout } = run(['totallyNoSuchSymbolAnywhere']);
  assert.equal(status, 0);
  assert.match(stdout, /nowhere/);
});

check('main short-circuits: a landed symbol reports only main, not the branch that also has it', () => {
  const { status, stdout } = run(['landedThing']);
  assert.equal(status, 0);
  assert.match(stdout, /^main$/m);
  assert.doesNotMatch(stdout, new RegExp(alsoHasLanded));
});

check('--all overrides the short-circuit and also reports the branch', () => {
  const { status, stdout } = run(['landedThing', '--all']);
  assert.equal(status, 0);
  assert.match(stdout, /^main$/m);
  assert.match(stdout, new RegExp(alsoHasLanded));
});

check('--branch pins the place and skips the search', () => {
  const { status, stdout } = run(['viewHop', '--branch', prBranch]);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(prBranch));
  assert.match(stdout, /lib\/pagealias\.js:2/);
});

check('an unknown --branch is refused with exit 4', () => {
  const { status, stderr } = run(['viewHop', '--branch', 'worktree-does-not-exist-zzz']);
  assert.equal(status, 4);
  assert.match(stderr, /no such branch/);
});

check('--pr resolves the same branch as --branch would', () => {
  const { status, stdout } = run(['viewHop', '--pr', '520']);
  assert.equal(status, 0);
  assert.match(stdout, new RegExp(prBranch));
});

check('--branch and --pr together are refused', () => {
  const { status, stderr } = run(['viewHop', '--branch', prBranch, '--pr', '520']);
  assert.notEqual(status, 0);
  assert.match(stderr, /two ways of pinning/);
});

check('--json emits parseable, structurally complete output', () => {
  const { status, stdout } = run(['viewHop', '--json']);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.query, 'viewHop');
  assert.equal(parsed.isPath, false);
  assert.ok(parsed.places.some((p) => p.branch === prBranch));
  const place = parsed.places.find((p) => p.branch === prBranch);
  assert.equal(place.pr.number, 520);
  assert.ok(place.hits.some((h) => h.file === 'lib/pagealias.js' && /viewHop/.test(h.text)));
});

console.log(`\n${failures ? `\x1b[31m${failures} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}\n`);
process.exit(failures ? 1 : 0);
