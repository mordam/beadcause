#!/usr/bin/env node
/**
 * **The attic empties.**
 *
 *     npm test
 *     node test/attic.mjs
 *
 * `lib/tidy.js` has always had two halves and, until bc-2v7k, only one of them ran on
 * its own: it *moved* finished worktrees into `.claude/worktrees-retired/` every
 * fifteen minutes and nothing ever moved them out again. The only sweep that emptied
 * the attic was a shell script in the `ship` skill — outside this repo, run by a
 * human — so the attic reached a hundred entries and 1.2 GB on this checkout in two
 * days while every individual step was working as designed.
 *
 * Everything here is a real git repo with a real `origin`, because every claim in
 * `expireRetired` is a question about refs — is this branch contained in that one, is
 * this directory still a registration — and a fake git would only prove the fake works.
 *
 * Six failures are worth the file:
 *
 * 1. **The attic never empties.** The whole bug. An old, merged, clean, unlocked entry
 *    must actually stop existing, and its registration must go with it.
 * 2. **The attic empties too much.** Six ways an entry earns another day — too young,
 *    locked, dirty in a *tracked* file, unmerged, a session sitting in it, named by a
 *    live handoff — each one asserted on its own, because a gate that silently stopped
 *    working would be invisible behind the other five.
 * 3. **Untracked files gating the whole attic.** A retired worktree carries untracked
 *    and ignored files *by design* — that is what the soft delete is for — so the
 *    dirty test must ignore them. Retirement's own test does not, and inheriting that
 *    one would have jammed the attic shut on a stray `.DS_Store` forever.
 * 4. **Ancestry asked of a stale local `main`.** Nothing merges locally: `origin/main`
 *    moves and `main` sits where the last pull left it — fifty commits behind, on the
 *    checkout that filed this bug. An entry merged on the remote and not locally must
 *    still expire, or the attic is held shut by a ref nobody updates.
 * 5. **`rm -rf`.** Removal goes through `git worktree remove`, so the branch outlives
 *    the directory. A retired worktree's ref is the only human-readable label left on
 *    those commits, and losing it is the one thing here that cannot be undone.
 * 6. **Squash-merged work stranded forever.** A workspace on `pr.mergeMethod:
 *    "squash"` delivers through a commit the branch is not an ancestor of, so the
 *    ancestry gate is false for every entry it will ever hold. The sweep asks GitHub
 *    instead, and the last section of this file proves both halves: that the entry
 *    expires once it is asked, and that the two local tests suggested in place of
 *    asking — `git diff main...branch`, `git cherry` — cannot see a squash at all.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { expireRetired, describeExpiry } from '../lib/tidy.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-attic-'));

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
const check = async (fn, name) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

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

/* ------------------------------------------------------------------- the repo */

const origin = path.join(tmp, 'origin.git');
const main = path.join(tmp, 'repo');
git(tmp, 'init', '--quiet', '--bare', '--initial-branch=main', origin);
git(tmp, 'clone', '--quiet', origin, main);
git(main, 'config', 'user.email', 't@e');
git(main, 'config', 'user.name', 'test');
fs.writeFileSync(path.join(main, 'file.txt'), 'one\n');
fs.writeFileSync(path.join(main, '.gitignore'), 'ignored/\n');
git(main, 'add', '-A');
git(main, 'commit', '--quiet', '-m', 'one');
git(main, 'push', '--quiet', '-u', 'origin', 'main');

const RETIRED = path.join(main, '.claude', 'worktrees-retired');
fs.mkdirSync(RETIRED, { recursive: true });

const daysAgo = (d) => new Date(Date.now() - d * 86400000).toISOString();

/**
 * A retired worktree, as the daemon would have left it: a branch off main, a real
 * `git worktree` sitting in the attic, and the `.note` sidecar that carries its age.
 *
 * `merged` decides whether the branch's commit is folded back into main before the
 * worktree moves — which is the difference between "already in main, safe to remove"
 * and "this directory is the only copy". Three values, not two:
 *
 * - `true` — a merge commit, so the branch is an ancestor of main;
 * - `false` — nothing landed, and this directory is the only copy;
 * - `'squash'` — GitHub's squash merge: main gains **one new commit** carrying the
 *   branch's whole tree, and the branch's own commits are in nobody's history. Two
 *   commits on the branch, deliberately, because a one-commit branch squashes to a
 *   patch-identical commit and would make `git cherry` look like it works.
 */
function retire(name, { age = 5, merged = true, land = 'both' } = {}) {
  const branch = `worktree-${name}`;
  const live = path.join(main, '.claude', 'worktrees', name);
  git(main, 'worktree', 'add', '--quiet', '-b', branch, live, 'main');
  fs.writeFileSync(path.join(live, `${name}.txt`), `${name}\n`);
  git(live, 'add', '-A');
  git(live, 'commit', '--quiet', '-m', name);
  if (merged === 'squash') {
    fs.writeFileSync(path.join(live, `${name}-again.txt`), `${name} again\n`);
    git(live, 'add', '-A');
    git(live, 'commit', '--quiet', '-m', `${name} again`);
    git(main, 'merge', '--squash', '--quiet', branch);
    git(main, 'commit', '--quiet', '-m', `${name} (squashed)`);
    git(main, 'push', '--quiet', 'origin', 'main');
  } else if (merged) {
    // A merge commit, so the branch really is contained — and pushed or not
    // according to `land`, which is how the stale-local-`main` case is built.
    git(main, 'merge', '--quiet', '--no-ff', '-m', `merge ${name}`, branch);
    if (land !== 'local') git(main, 'push', '--quiet', 'origin', 'main');
    if (land === 'remote') git(main, 'reset', '--hard', '--quiet', 'HEAD~1');
  }
  const dest = path.join(RETIRED, name);
  git(main, 'worktree', 'move', live, dest);
  fs.writeFileSync(path.join(RETIRED, `${name}.note`), `${daysAgo(age)}  retired by test\n`);
  return { name, branch, dest };
}

const registered = (p) =>
  git(main, 'worktree', 'list', '--porcelain')
    .split('\n')
    .includes(`worktree ${p}`);

/* -------------------------------------------------------------------- the cases */

console.log('\nattic expiry');

// One repo, one sweep, every case in it at once — which is also the honest shape,
// since a real attic is a hundred entries in every state at the same time.
const old = retire('old-and-merged', { age: 5 });
const young = retire('young', { age: 0.5 });
const locked = retire('locked-one', { age: 5 });
const dirty = retire('dirty-one', { age: 5 });
const messy = retire('untracked-only', { age: 5 });
const unmerged = retire('unmerged-one', { age: 5, merged: false });
const occupied = retire('someone-in-it', { age: 5 });
const claimed = retire('handed-off', { age: 5 });
const unstamped = retire('no-note', { age: 5 });
fs.rmSync(path.join(RETIRED, 'no-note.note'));
// The delivered-by-pull-request pair. Both are squash-merged in git's eyes — one
// landed, one has a PR still open — and only GitHub can tell them apart; see the
// squash section at the bottom.
const squashed = retire('squash-landed', { age: 5, merged: 'squash' });
const squashOpen = retire('squash-open', { age: 5, merged: 'squash' });
// Last, and it has to be: `land: 'remote'` rewinds local `main` to leave it behind
// `origin/main` for good, so anything retired after it could not push.
const remoteOnly = retire('merged-on-origin', { age: 5, land: 'remote' });

git(main, 'worktree', 'lock', locked.dest);
fs.writeFileSync(path.join(dirty.dest, 'file.txt'), 'edited by hand\n');
// Untracked *and* ignored, which is the normal state of a retired worktree and must
// not count: a build directory and a stray dotfile are why the soft delete exists.
fs.mkdirSync(path.join(messy.dest, 'ignored'), { recursive: true });
fs.writeFileSync(path.join(messy.dest, 'ignored', 'build.log'), 'noise\n');
fs.writeFileSync(path.join(messy.dest, 'scratch.txt'), 'noise\n');
fs.mkdirSync(path.join(main, '.claude', 'handoffs'), { recursive: true });
fs.writeFileSync(path.join(main, '.claude', 'handoffs', 'LATEST.md'), `pick up in ${claimed.name}\n`);

const sessions = [{ pid: 4242, cwd: occupied.dest }];

// The stale local `main` this whole sweep has to survive: the remote-only entry was
// merged and pushed, then rewound locally — which is exactly what a checkout looks
// like when every merge happens on github.com and nobody pulls.
await check(async () => {
  const localHas = git(main, 'branch', '--contains', remoteOnly.branch, '--format=%(refname:short)');
  assert.ok(!localHas.split('\n').includes('main'), 'local main should not contain it');
  const remoteHas = git(main, 'branch', '-r', '--contains', remoteOnly.branch, '--format=%(refname:short)');
  assert.ok(remoteHas.split('\n').includes('origin/main'), 'origin/main should contain it');
}, 'the fixture really is merged on origin/main and not on local main');

const dry = await expireRetired(main, { sessions, days: 2, dryRun: true });
await check(async () => {
  assert.ok(
    dry.removed.some((r) => r.name === old.name),
    `dry run should have named it: ${JSON.stringify(dry.removed)}`
  );
  assert.ok(fs.existsSync(old.dest), 'a dry run must not remove anything');
  assert.ok(fs.existsSync(path.join(RETIRED, `${old.name}.note`)), 'nor its note');
}, 'a dry run says what it would remove and removes nothing');

const swept = await expireRetired(main, { sessions, days: 2 });
const why = (name) => swept.kept.find((k) => k.name === name)?.why || '';

await check(async () => {
  assert.ok(!fs.existsSync(old.dest), 'the directory should be gone');
  assert.ok(!fs.existsSync(path.join(RETIRED, `${old.name}.note`)), 'and its note with it');
  assert.ok(!registered(old.dest), 'and its registration');
  assert.ok(
    swept.removed.some((r) => r.name === old.name),
    'and it should be reported'
  );
}, 'an old, merged, clean, unlocked entry is removed for good');

await check(async () => {
  assert.equal(git(main, 'rev-parse', '--verify', `${old.branch}^{commit}`).length, 40);
}, 'its branch outlives the directory — `git worktree remove`, never `rm -rf`');

await check(async () => {
  assert.ok(!fs.existsSync(remoteOnly.dest), `kept it: ${why(remoteOnly.name)}`);
}, 'an entry merged on origin/main expires even when local main is behind');

await check(async () => {
  assert.ok(!fs.existsSync(messy.dest), `kept it: ${why(messy.name)}`);
}, 'untracked and ignored files do not hold an entry — carrying them is the point');

await check(async () => {
  assert.ok(fs.existsSync(young.dest), 'still inside the window');
  // Young is the bulk of a healthy attic and deliberately silent: a row each, every
  // fifteen minutes, would bury the one entry that is actually stuck.
  assert.ok(!swept.kept.some((k) => k.name === young.name), 'and not worth a row');
}, 'an entry inside the window is left alone, and says nothing about it');

for (const [entry, want] of [
  [locked, /locked/],
  [dirty, /uncommitted tracked/],
  [unmerged, /not merged/],
  [occupied, /pid 4242/],
  [claimed, /handoff/],
  [unstamped, /no \.note/],
]) {
  await check(async () => {
    assert.ok(fs.existsSync(entry.dest), 'the directory should still be there');
    assert.match(why(entry.name), want, `reason was: ${why(entry.name) || '(none)'}`);
  }, `${entry.name} is kept, and named with the reason`);
}

await check(async () => {
  const line = describeExpiry(swept);
  assert.match(line, /expired /, line);
  assert.match(line, new RegExp(locked.name), line);
}, 'the one-liner carries both what went and what is stuck');

await check(async () => {
  const off = await expireRetired(main, { sessions, days: 0 });
  assert.deepEqual(off.removed, [], 'days: 0 must remove nothing');
  assert.deepEqual(off.kept, [], 'and not even survey');
}, 'tidyAtticDays: 0 keeps the attic forever, which is what it did before');

await check(async () => {
  // A stray directory is somebody having moved things by hand. Reporting it is the
  // shell sweep's job; removing it is nobody's.
  const stray = path.join(RETIRED, 'not-a-worktree');
  fs.mkdirSync(stray, { recursive: true });
  fs.writeFileSync(path.join(RETIRED, 'not-a-worktree.note'), `${daysAgo(9)}  by hand\n`);
  const again = await expireRetired(main, { sessions, days: 2 });
  assert.ok(fs.existsSync(stray), 'an unregistered directory is not this sweep to delete');
  assert.ok(!again.removed.some((r) => r.name === 'not-a-worktree'), 'nor to claim it removed');
}, 'an unregistered directory in the attic is left completely alone');

await check(async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-attic-none-'));
  git(empty, 'init', '--quiet', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(empty, 'f'), 'x\n');
  git(empty, 'add', '-A');
  git(empty, 'commit', '--quiet', '-m', 'one');
  const none = await expireRetired(empty, { days: 2 });
  assert.deepEqual(none.removed, []);
  assert.deepEqual(none.kept, []);
  fs.rmSync(empty, { recursive: true, force: true });
}, 'a repo with no attic at all is a no-op, not a crash');

/* ------------------------------------------------------------ the squash case */

/**
 * A squash-merged branch is delivered work whose commits are in nobody's history,
 * and the attic is where that used to be permanent.
 *
 * `pr.mergeMethod: "squash"` is a legitimate setting, and under it *every* delivered
 * worktree failed the ancestry gate forever — kept, and described as "removing it
 * destroys its only copy" about work that shipped last week. The fix is that the
 * sweep asks GitHub, and the two local tests that get suggested instead of asking
 * are proven here not to work, so nobody re-suggests them from a comment alone.
 *
 * `gh` here is a fake on PATH answering three questions, because the claim is about
 * which branches the sweep asks about and what it does with the answer — not about
 * gh's own JSON. It logs every call, so "did it ask, and about what" is assertable.
 */
const GHBIN = path.join(tmp, 'bin');
const GHLOG = path.join(tmp, 'gh.log');
fs.mkdirSync(GHBIN, { recursive: true });
fs.writeFileSync(
  path.join(GHBIN, 'gh'),
  `#!/bin/sh
echo "$*" >> ${JSON.stringify(GHLOG)}
case "$1 $2" in
  "auth status") exit 0 ;;
  "repo view") echo '{"nameWithOwner":"test/repo"}' ; exit 0 ;;
  "pr view")
    case "$3" in
      ${squashed.branch}) echo '{"number":20,"state":"MERGED","headRefName":"${squashed.branch}","url":"https://example.invalid/20","title":"landed"}' ; exit 0 ;;
      ${squashOpen.branch}) echo '{"number":21,"state":"OPEN","headRefName":"${squashOpen.branch}","url":"https://example.invalid/21","title":"still open"}' ; exit 0 ;;
    esac
    echo 'no pull requests found for branch' >&2
    exit 1 ;;
esac
echo "unexpected gh: $*" >&2
exit 1
`,
  { mode: 0o755 }
);
process.env.PATH = `${GHBIN}${path.delimiter}${process.env.PATH}`;

await check(async () => {
  const local = git(main, 'branch', '--contains', squashed.branch, '--format=%(refname:short)').split('\n');
  const remote = git(main, 'branch', '-r', '--contains', squashed.branch, '--format=%(refname:short)').split('\n');
  assert.ok(!local.includes('main'), 'a squashed branch is an ancestor of nothing');
  assert.ok(!remote.includes('origin/main'), 'on the remote either');
  // Its work is on main all the same — that is what makes the directory removable,
  // and what the ancestry gate above cannot see.
  const tree = git(main, 'ls-tree', '--name-only', 'origin/main').split('\n');
  assert.ok(tree.includes('squash-landed.txt'), `main should carry its files: ${tree.join(', ')}`);
  assert.ok(tree.includes('squash-landed-again.txt'), `both commits' worth: ${tree.join(', ')}`);
}, 'the fixture really is squash-merged: landed on main, ancestor of nothing');

await check(async () => {
  // bc-5lcc, kept executable. These are the two tests that get proposed as a local
  // substitute for asking GitHub, and this is why the sweep does not use them.
  const diff = git(main, 'diff', '--name-only', `origin/main...${squashed.branch}`);
  assert.ok(diff.length > 0, `a three-dot diff is taken from the merge base, so it is not empty: ${diff}`);
  const cherry = git(main, 'cherry', '-v', 'origin/main', squashed.branch)
    .split('\n')
    .filter(Boolean);
  assert.ok(cherry.length >= 2, `two commits, so no squash can be patch-identical: ${cherry.join(' / ')}`);
  assert.ok(
    cherry.every((line) => line.startsWith('+')),
    `git cherry calls every one of them not-upstream: ${cherry.join(' / ')}`
  );
}, 'neither `git diff main...branch` nor `git cherry` can see that the squash landed');

await check(async () => {
  // From the default sweep at the top of this file — prMerges off, as `expireRetired`
  // defaults and as `--no-pr` asks for.
  assert.ok(fs.existsSync(squashed.dest), 'still there');
  assert.match(why(squashed.name), /not merged/, `reason was: ${why(squashed.name) || '(none)'}`);
}, 'without the PR question a squash-merged entry is stranded — the bug, still reproducible');

const prSwept = await expireRetired(main, { sessions, days: 2, prMerges: true });
const prWhy = (name) => prSwept.kept.find((k) => k.name === name)?.why || '';

await check(async () => {
  assert.ok(!fs.existsSync(squashed.dest), `kept it: ${prWhy(squashed.name)}`);
  assert.ok(!registered(squashed.dest), 'and its registration went with it');
  assert.ok(
    prSwept.removed.some((r) => r.name === squashed.name),
    'and it should be reported'
  );
  assert.equal(git(main, 'rev-parse', '--verify', `${squashed.branch}^{commit}`).length, 40, 'branch kept');
}, 'a squash-merged entry expires once GitHub is asked — and keeps its branch');

await check(async () => {
  assert.ok(fs.existsSync(squashOpen.dest), 'an open PR is not a merged one');
  assert.match(prWhy(squashOpen.name), /not merged/, `reason was: ${prWhy(squashOpen.name) || '(none)'}`);
}, 'a branch whose pull request is open is still the only copy');

await check(async () => {
  assert.ok(fs.existsSync(unmerged.dest), 'no PR at all, so nothing says it landed');
  assert.match(prWhy(unmerged.name), /not merged/, `reason was: ${prWhy(unmerged.name) || '(none)'}`);
}, 'a branch with no pull request is unaffected by asking — `gh` failing is an answer');

await check(async () => {
  // Read defensively: a sweep that asked nothing at all never creates the log, and
  // "it did not ask" is the failure this check is for — not an ENOENT about a file.
  const asked = (fs.existsSync(GHLOG) ? fs.readFileSync(GHLOG, 'utf8') : '')
    .split('\n')
    .filter((l) => l.startsWith('pr view '))
    .map((l) => l.split(' ')[2]);
  assert.ok(asked.includes(squashed.branch), `it has to ask about the squashed one: ${asked.join(', ')}`);
  // The cheap local gates run first and settle most entries on their own. Asking
  // GitHub about all of them would be one network round trip per attic entry, every
  // fifteen minutes, for an answer git already had.
  assert.ok(!asked.includes(locked.branch), `nothing to ask about a locked entry: ${asked.join(', ')}`);
  assert.ok(!asked.includes(young.branch), `nor one inside the window: ${asked.join(', ')}`);
}, 'GitHub is asked only about the entries the local gates could not settle');

/* --------------------------------------------------------------------- report */

console.log(`\n${failures ? '\x1b[31m✗' : '\x1b[32m✓'} attic: ${ran - failures}/${ran} passed\x1b[0m\n`);
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* a locked worktree can hold a handle; the tmpdir is the OS's problem now */
}
process.exit(failures ? 1 : 0);
