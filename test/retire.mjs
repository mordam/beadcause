#!/usr/bin/env node
/**
 * **The sweep that retires a live worktree.**
 *
 *     npm test
 *     node test/retire.mjs
 *
 * `lib/tidy.js` has two sweeps and, until this file, only the second one was tested.
 * `expireRetired` — the attic — has `test/attic.mjs` and `test/atticcli.mjs`;
 * `sweepWorktrees`, the half the advocate runs every fifteen minutes with `prMerges`
 * on (lib/advocate.js), was named in no test file in the repo.
 *
 * It is the more dangerous half. The attic acts on a directory somebody already
 * decided was finished; this one acts on a worktree somebody may be **sitting in**,
 * and every one of its gates is the only thing standing between an unattended
 * fifteen-minute timer and a session's working directory moving out from under it.
 * That has actually happened here once — it is why `QUIET_MINUTES` exists at all,
 * twenty minutes after the sweep first shipped — and the gate written in response was
 * then unasserted for as long as the one it replaced.
 *
 * Everything below is a real git repo with a real `origin` and real worktrees, for the
 * same reason `test/attic.mjs` is: every claim here is a question about refs and
 * registrations, and a fake git would only prove the fake works. The one thing faked is
 * `gh`, because the question it answers — *did GitHub merge this?* — cannot be asked of
 * a local repo at all.
 *
 * What is worth the file:
 *
 * 1. **The sweep does not sweep.** The ordinary case: an unlocked, unoccupied, quiet,
 *    clean, merged worktree must actually move into `.claude/worktrees-retired/`, keep
 *    its branch, and leave the `.note` stamp that is the only record of when and
 *    against what.
 * 2. **The sweep sweeps too much.** Eight ways a worktree earns another fifteen
 *    minutes — outside `.claude/worktrees/`, locked, on a detached HEAD, occupied, just
 *    touched, dirty in a *tracked* file, dirty in an *untracked* one, unmerged — each
 *    asserted on its own with its own reason, because a gate that silently stopped
 *    working would be invisible behind the other seven.
 * 3. **Untracked files not counting.** This sweep and the attic's deliberately disagree
 *    about them: an untracked file in a *live* worktree is unsaved work, and in a
 *    retired one it is the point of the soft delete. Inheriting the attic's
 *    `--untracked-files=no` here would sweep away a file nobody had committed yet.
 * 4. **The squash.** A squash-merged branch is an ancestor of nothing, so the local
 *    test is false forever and the worktree would sit unswept while its work shipped
 *    last week. GitHub is the authority, it is asked only behind `prMerges`, and the
 *    number it gives is what lands in the note.
 * 5. **A stale local `main`.** Nothing merges locally: `origin/main` moves and `main`
 *    sits where the last pull left it. Ancestry asked of the local ref alone was fifty
 *    commits wrong on this checkout.
 * 6. **Overwriting a retirement.** Two worktrees can carry the same basename a week
 *    apart, and the destination is a path, not a key. A collision must suffix, because
 *    clobbering the older entry is the one irreversible thing in the file.
 *
 * Every gate in `sweepWorktrees` was deleted one at a time to watch this go red —
 * seventeen of eighteen mutations, the exception being the `path.resolve(wt.path) ===
 * path.resolve(main)` line. Nothing can catch that one and nothing should try: the main
 * checkout is never *under* `.claude/worktrees/`, so the location gate on the line below
 * it has already refused it. It is the one line in the sweep whose removal changes no
 * behaviour, which is worth knowing before somebody spends an afternoon writing a case
 * for it.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { sweepWorktrees, describeSweep } from '../lib/tidy.js';
import { removeTree } from './helpers/tmp.mjs';

/**
 * `realpathSync` around the scratch directory, and it is load-bearing rather than tidy.
 *
 * On macOS `os.tmpdir()` is `/var/folders/…`, `/var` is a symlink to `/private/var`, and
 * `git worktree list` reports every path fully resolved. Without this the suite compares
 * `/var/…` against `/private/var/…` — two spellings of one directory sharing none of
 * their first eight characters — and half of it fails for a reason that has nothing to
 * do with the sweep. The unresolved spelling is still wanted, deliberately, in the one
 * case below that is *about* it.
 */
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-retire-')));

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

/* --------------------------------------------------------------------- fake gh */

/**
 * `gh`, for the one question a local repo cannot answer.
 *
 * `lib/pr.js` reaches GitHub twice per lookup — once to find out which account can see
 * the checkout (`repo view`), once for the pull request itself — so both are answered
 * here. Everything else exits 1, which is exactly what `gh` does for a branch with no
 * pull request and is the path `viewForBranch` swallows into a null.
 *
 * It is on `PATH` for the whole file on purpose, including the sweeps run with
 * `prMerges: false`. A test that proved "no GitHub answer" by removing `gh` would prove
 * nothing about the flag; with `gh` present and answering MERGED, a worktree left as
 * "not merged" can only mean the flag gated the call.
 */
const SQUASHED_PR = {
  number: 77,
  url: 'https://github.test/test/repo/pull/77',
  title: 'squashed on purpose',
  state: 'MERGED',
  isDraft: false,
  mergeable: 'UNKNOWN',
  mergeStateStatus: 'UNKNOWN',
  headRefName: 'worktree-squashed',
  baseRefName: 'main',
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  statusCheckRollup: [],
  reviewDecision: null,
  mergedAt: '2026-08-11T00:00:00Z',
  mergeCommit: { oid: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
};

const fakeBin = path.join(tmp, 'bin');
fs.mkdirSync(fakeBin, { recursive: true });
fs.writeFileSync(
  path.join(fakeBin, 'gh'),
  `#!/bin/sh
case "$1 $2" in
  "repo view") echo '{"nameWithOwner":"test/repo"}' ;;
  "pr view")
    case "$3" in
      worktree-squashed) cat <<'JSON'
${JSON.stringify(SQUASHED_PR)}
JSON
      ;;
      *) echo "no pull requests found for branch $3" >&2; exit 1 ;;
    esac ;;
  *) echo "fake gh: unsupported $*" >&2; exit 1 ;;
esac
`,
  { mode: 0o755 }
);
process.env.PATH = `${fakeBin}${path.delimiter}${process.env.PATH}`;

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

const LIVE = path.join(main, '.claude', 'worktrees');
const RETIRED = path.join(main, '.claude', 'worktrees-retired');

/**
 * A live worktree, as a session that obeyed its repo's rules would have left it: a
 * branch off main, one commit on it, sitting under `.claude/worktrees/`.
 *
 * `merged` is the whole question the sweep turns on, and it has three answers rather
 * than two — `'squash'` puts the branch's *tree* on main under a new commit and none of
 * its history, which is what a squash-merged pull request does and what makes the
 * ancestry test false forever. `land: 'remote'` pushes the merge and then rewinds the
 * local branch, which is what every checkout on this Mac looks like: GitHub moved,
 * nobody pulled.
 *
 * `at` places the directory somewhere other than `.claude/worktrees/`, for the one gate
 * that is about location rather than state.
 */
function live(name, { merged = true, land = 'both', at = null } = {}) {
  const branch = `worktree-${name}`;
  const dir = at || path.join(LIVE, name);
  git(main, 'worktree', 'add', '--quiet', '-b', branch, dir, 'main');
  fs.writeFileSync(path.join(dir, `${name}.txt`), `${name}\n`);
  git(dir, 'add', '-A');
  git(dir, 'commit', '--quiet', '-m', name);
  if (merged === 'squash') {
    // A squash: main gains the tree and not the commit, so `merge-base --is-ancestor`
    // is false and stays false. Only GitHub can say this landed.
    git(main, 'merge', '--quiet', '--squash', branch);
    git(main, 'commit', '--quiet', '-m', `squashed ${name}`);
    git(main, 'push', '--quiet', 'origin', 'main');
  } else if (merged) {
    git(main, 'merge', '--quiet', '--no-ff', '-m', `merge ${name}`, branch);
    if (land !== 'local') git(main, 'push', '--quiet', 'origin', 'main');
    if (land === 'remote') git(main, 'reset', '--hard', '--quiet', 'HEAD~1');
  }
  return { name, branch, dir };
}

/**
 * Backdate everything in a worktree past `QUIET_MINUTES`.
 *
 * Every fixture here is seconds old, and `lastTouched` would keep the lot of them with
 * "touched 1 minute(s) ago" — the gate would hold the whole suite green while doing
 * none of the work the rest of it is about. Run last, after every mutation, because
 * writing into a directory bumps the directory too.
 *
 * `.git` is skipped for the same reason `lastTouched` skips it: git writes there on
 * every `status`, and a sweep that read its own bookkeeping as occupancy would never
 * retire anything.
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
      if (e.name === '.git' || e.name === 'node_modules') continue;
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

const registered = (p) =>
  git(main, 'worktree', 'list', '--porcelain')
    .split('\n')
    .includes(`worktree ${p}`);

/* -------------------------------------------------------------------- the cases */

console.log('\nworktree retirement');

// One repo, one sweep, every case in it at once — which is also the honest shape: a
// real checkout is thirty worktrees in every state at the same time.
const plain = live('plain-merged');
const locked = live('locked-one');
const occupied = live('someone-in-it');
const dirty = live('tracked-edit');
const messy = live('untracked-only');
const unmerged = live('unmerged-one', { merged: false });
const squashed = live('squashed', { merged: 'squash' });
const collide = live('collide');
const outside = live('outside-one', { at: path.join(tmp, 'elsewhere') });
const detached = live('detached-one');
// Merged and clean like `plain`, and kept only by being seconds old — everything
// downstream of the quiet gate would retire it. It is simply never quietened below.
const fresh = live('just-touched');
// Last, and it has to be: `land: 'remote'` rewinds local `main` for good, so anything
// merged after it could not push.
const remoteOnly = live('merged-on-origin', { land: 'remote' });

git(main, 'worktree', 'lock', locked.dir);
fs.writeFileSync(path.join(dirty.dir, 'file.txt'), 'edited and not committed\n');
// Untracked and *not* ignored: unsaved work in a live worktree, which this sweep must
// refuse and the attic sweep deliberately does not.
fs.writeFileSync(path.join(messy.dir, 'scratch.txt'), 'written and never added\n');
// A detached HEAD has no ref to check containment against, and `git worktree add
// --detach` is how one appears — a session that checked out a sha to look at something.
git(detached.dir, 'checkout', '--quiet', '--detach', 'HEAD');
// The collision: an entry of that name is already in the attic, from a worktree of the
// same name a week ago. It is a directory, not a registration, exactly as a hand
// retirement by the `ship` skill leaves one.
fs.mkdirSync(path.join(RETIRED, 'collide'), { recursive: true });
fs.writeFileSync(path.join(RETIRED, 'collide', 'older.txt'), 'the earlier retirement\n');
// A real directory for the occupying session to be sitting in. It has to exist: `real()`
// in lib/tidy.js falls back to a plain resolve for a path that is gone, and a cwd that
// resolves to nothing is a session the sweep is *supposed* to stop honouring.
fs.mkdirSync(path.join(occupied.dir, 'lib'), { recursive: true });

for (const wt of [plain, locked, occupied, dirty, messy, unmerged, squashed, collide, outside, detached, remoteOnly]) {
  quieten(wt.dir);
}

const sessions = [{ pid: 4242, cwd: path.join(occupied.dir, 'lib') }];

await check(async () => {
  const localHas = git(main, 'branch', '--contains', remoteOnly.branch, '--format=%(refname:short)');
  assert.ok(!localHas.split('\n').includes('main'), 'local main should not contain it');
  const remoteHas = git(main, 'branch', '-r', '--contains', remoteOnly.branch, '--format=%(refname:short)');
  assert.ok(remoteHas.split('\n').includes('origin/main'), 'origin/main should contain it');
}, 'the fixture really is merged on origin/main and not on local main');

await check(async () => {
  const contains = git(main, 'branch', '--contains', squashed.branch, '--format=%(refname:short)').split('\n');
  assert.ok(!contains.includes('main'), 'a squashed branch is an ancestor of nothing — that is the whole case');
  assert.equal(fs.readFileSync(path.join(main, 'squashed.txt'), 'utf8'), 'squashed\n', 'but its tree is on main');
}, 'the squash fixture really is a squash — tree on main, branch not an ancestor');

/* ------------------------------------------------------------------- a dry run */

const dry = await sweepWorktrees(main, { sessions, dryRun: true });
await check(async () => {
  assert.ok(
    dry.retired.some((r) => r.name === plain.name),
    `dry run should have named it: ${JSON.stringify(dry.retired)}`
  );
  assert.ok(fs.existsSync(plain.dir), 'a dry run must not move anything');
  assert.ok(!fs.existsSync(path.join(RETIRED, `${plain.name}.note`)), 'nor stamp a note');
  assert.ok(
    dry.retired.every((r) => r.dryRun),
    'and every row should say it was a dry run'
  );
}, 'a dry run says what it would retire and retires nothing');

/* ----------------------------------------------------- the sweep, without GitHub */

const swept = await sweepWorktrees(main, { sessions });
const why = (name) => swept.left.find((l) => l.name === name)?.why || '';

await check(async () => {
  const dest = path.join(RETIRED, plain.name);
  assert.ok(!fs.existsSync(plain.dir), `still live: ${why(plain.name)}`);
  assert.ok(fs.existsSync(path.join(dest, `${plain.name}.txt`)), 'its files should have moved with it');
  assert.ok(registered(dest), 'and the registration should point at the new path');
  assert.ok(
    swept.retired.some((r) => r.name === plain.name && r.to === dest),
    'and it should be reported, with where it went'
  );
}, 'a clean, quiet, unlocked, merged worktree is moved into the attic');

await check(async () => {
  assert.equal(git(main, 'rev-parse', '--verify', `${plain.branch}^{commit}`).length, 40);
}, 'its branch outlives the move — that is what makes a retirement resumable');

await check(async () => {
  const note = path.join(RETIRED, `${plain.name}.note`);
  const first = fs.readFileSync(note, 'utf8').split('\n')[0];
  const [stamp] = first.split(/\s+/);
  assert.ok(Number.isFinite(Date.parse(stamp)), `not an ISO stamp: ${first}`);
  // `retiredAt` in lib/tidy.js reads exactly this token to decide the entry's age, so
  // an unparseable one means the attic keeps it forever and says it does not know.
  assert.match(first, /retired by beadcause after [0-9a-f]{7,}/, first);
}, 'the .note stamp is written, ISO first, naming what it was retired after');

await check(async () => {
  assert.ok(!fs.existsSync(remoteOnly.dir), `still live: ${why(remoteOnly.name)}`);
}, 'a worktree merged on origin/main retires even when local main is behind');

await check(async () => {
  const dest = path.join(RETIRED, `${collide.name}-2`);
  assert.ok(fs.existsSync(dest), `expected a suffixed destination: ${why(collide.name)}`);
  assert.equal(
    fs.readFileSync(path.join(RETIRED, collide.name, 'older.txt'), 'utf8'),
    'the earlier retirement\n',
    'the older retirement must survive untouched'
  );
}, 'a name already in the attic is suffixed, never overwritten');

await check(async () => {
  assert.ok(fs.existsSync(fresh.dir), 'a worktree touched seconds ago must be left alone');
  assert.match(why(fresh.name), /touched \d+ minute\(s\) ago/, `reason was: ${why(fresh.name) || '(none)'}`);
}, 'QUIET_MINUTES keeps a just-touched worktree, whatever git says about it');

for (const [entry, want] of [
  [locked, /^locked$/],
  [occupied, /a session is working in it \(pid 4242\)/],
  [dirty, /1 uncommitted file$/],
  [messy, /1 uncommitted file$/],
  [unmerged, /^not merged into main$/],
  [squashed, /^not merged into main$/],
  [detached, /detached HEAD/],
]) {
  await check(async () => {
    assert.ok(fs.existsSync(entry.dir), 'the worktree should still be live');
    assert.match(why(entry.name), want, `reason was: ${why(entry.name) || '(none)'}`);
  }, `${entry.name} is left alone, and named with the reason`);
}

await check(async () => {
  // Occupancy is the gate that has actually failed in the wild, and it failed on exactly
  // this: git reports resolved paths, a process keeps whatever prefix it was started
  // with, and `/var/folders/…` and `/private/var/folders/…` are one directory sharing
  // none of their first eight characters. A plain `path.resolve` answers "nobody is in
  // it" every time. The symlink here is explicit rather than borrowed from macOS, so the
  // check means the same thing on a machine where the tmpdir is not one.
  const link = path.join(tmp, 'repo-via-link');
  fs.symlinkSync(main, link);
  const viaLink = [{ pid: 909, cwd: path.join(link, '.claude', 'worktrees', occupied.name, 'lib') }];
  const again = await sweepWorktrees(main, { sessions: viaLink });
  assert.ok(fs.existsSync(occupied.dir), 'it must survive a cwd that reaches it another way');
  assert.match(again.left.find((l) => l.name === occupied.name)?.why || '', /pid 909/);
}, 'a session whose cwd reaches the worktree through a symlink still holds it');

await check(async () => {
  assert.ok(fs.existsSync(outside.dir), 'a worktree outside .claude/worktrees is not this sweep to move');
  assert.ok(!swept.retired.some((r) => r.name === outside.name), 'nor to claim it retired');
  assert.ok(!swept.left.some((l) => l.name === outside.name), 'and not worth a row either — it is simply not ours');
}, 'a worktree outside .claude/worktrees/ is invisible to the sweep');

await check(async () => {
  assert.ok(!swept.retired.some((r) => r.name === path.basename(main)), 'the main checkout is never retired');
  assert.ok(!swept.left.some((l) => l.name === path.basename(main)), 'and never even surveyed');
  assert.ok(fs.existsSync(path.join(main, 'file.txt')), 'and it is obviously still there');
}, 'the main checkout is excluded by location, not by luck');

await check(async () => {
  const stillThere = fs.readFileSync(path.join(RETIRED, plain.name, `${plain.name}.txt`), 'utf8');
  assert.equal(stillThere, `${plain.name}\n`, "the attic is the other sweep's job");
  assert.ok(registered(path.join(RETIRED, plain.name)), 'and its registration is untouched');
}, 'what is already in the attic is left there — this sweep only fills it');

await check(async () => {
  const line = describeSweep(swept);
  assert.match(line, new RegExp(`retired [^·]*${plain.name}`), line);
  assert.match(line, new RegExp(`${dirty.name} \\(1 uncommitted file\\)`), line);
  // `locked` is the normal state of every worktree somebody is using; a card that
  // listed them all would bury the one with uncommitted work in it.
  assert.ok(!line.includes(locked.name), `the one-liner should not carry the locked one: ${line}`);
}, 'the one-liner carries what went and what is blocked, and not the merely locked');

/* -------------------------------------------------------- the sweep, with GitHub */

const asked = await sweepWorktrees(main, { sessions, prMerges: true });
const whyThen = (name) => asked.left.find((l) => l.name === name)?.why || '';

await check(async () => {
  const dest = path.join(RETIRED, squashed.name);
  assert.ok(!fs.existsSync(squashed.dir), `still live: ${whyThen(squashed.name)}`);
  assert.ok(registered(dest), 'and it should be a registration at the new path');
}, 'a squash-merged worktree retires once GitHub is allowed to answer');

await check(async () => {
  const first = fs.readFileSync(path.join(RETIRED, `${squashed.name}.note`), 'utf8').split('\n')[0];
  // "#77" and a sha are different stories about the same removal, and only one of them
  // can be looked up later.
  assert.match(first, /retired by beadcause after #77/, first);
}, 'and its note names the pull request, not a sha nothing merged');

await check(async () => {
  assert.ok(fs.existsSync(unmerged.dir), 'a branch GitHub has never heard of stays put');
  assert.match(whyThen(unmerged.name), /not merged into main, and its PR is not merged either/, whyThen(unmerged.name));
}, 'a branch with no pull request is still refused, and the reason says GitHub was asked');

await check(async () => {
  assert.ok(fs.existsSync(locked.dir), 'a lock outranks a merged PR');
  assert.match(whyThen(locked.name), /^locked$/, whyThen(locked.name));
  assert.ok(fs.existsSync(dirty.dir), 'so does uncommitted work');
}, 'prMerges loosens the merge question and nothing else');

/* ------------------------------------------------------------------ degenerate */

await check(async () => {
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-retire-none-'));
  git(bare, 'init', '--quiet', '--initial-branch=main', '.');
  fs.writeFileSync(path.join(bare, 'f'), 'x\n');
  git(bare, 'add', '-A');
  git(bare, 'commit', '--quiet', '-m', 'one');
  const none = await sweepWorktrees(bare);
  assert.deepEqual(none.retired, []);
  assert.deepEqual(none.left, []);
  await removeTree(bare);
}, 'a repo with no worktrees at all is a no-op, not a crash');

await check(async () => {
  // The sweep is run from wherever the daemon happens to be, which is routinely a
  // worktree rather than the checkout — `--git-common-dir` is what makes that the same
  // question, and getting it wrong would sweep nothing and say nothing.
  const from = path.join(RETIRED, plain.name);
  const seen = await sweepWorktrees(from, { sessions, dryRun: true });
  assert.equal(path.resolve(seen.retiredRoot), path.resolve(RETIRED), 'it should resolve to the parent repo');
}, 'the sweep run from inside a worktree still operates on the whole repo');

/* --------------------------------------------------------------------- report */

console.log(`\n${failures ? '\x1b[31m✗' : '\x1b[32m✓'} retire: ${ran - failures}/${ran} passed\x1b[0m\n`);
// A locked worktree keeps a handle on its directory; a teardown must never be able to
// fail a run on its own — see test/helpers/tmp.mjs.
await removeTree(tmp);
process.exit(failures ? 1 : 0);
