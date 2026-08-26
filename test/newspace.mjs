#!/usr/bin/env node
/**
 * Adding a bead-space from the app — the refusals, and the two config writes.
 *
 *     npm test
 *     node test/newspace.mjs
 *
 * `lib/newspace.js` is the first thing in this daemon that makes a directory, runs
 * `git clone`, and runs `bd init`, all from a button on a phone. Every other write in the
 * app changes a line in a config file; these change the disk. So what is worth a suite is
 * not that the happy path works — it is every gate in front of it, because each one is
 * the only thing standing between a mistyped field and something irreversible.
 *
 * Eight claims:
 *
 * 1. **A relative path is refused.** A phone has no working directory and the daemon's is
 *    `/` under launchd, so resolving one would silently name something in the filesystem
 *    root. This is the refusal most likely to be "helpfully" repaired by somebody later.
 *
 * 2. **`~/x/.beads` and `~/x` are the same bead-space.** The first is the form somebody
 *    copies out of a config file, and `namedWorkspaces` already accepts either — a dialog
 *    that refused it would be refusing the path the person actually has.
 *
 * 3. **A name that is already served, or retired, is refused** — and the two say different
 *    things. The name is the key for `sessionDirs`, `jira`, `advocates.perWorkspace` and
 *    every group's list, so two trackers sharing one would silently share all of them; a
 *    retired name is a press on the admin screen away from coming back, and adding over
 *    the top of it would leave the daemon carrying both.
 *
 * 4. **A clone never lands on top of anything.** `git clone` into a directory with
 *    something in it is refused before git is spawned, because the alternative is git's
 *    own half-written failure inside somebody's checkout.
 *
 * 5. **A tracker under a configured root is not pinned.** `workspaceDirs` is for a
 *    tracker the roots cannot reach; pinning one they can freezes it, so renaming its
 *    directory drops the bead-space instead of moving it. Asserted as *no key written*,
 *    which is the only way to catch a pin that is a no-op today and a bug next month.
 *
 * 6. **A clone that carries `refs/dolt/data` is never `bd init`-ed over.** This is the
 *    expensive one. `bd bootstrap` will not clone over a database that exists, so a
 *    tracker made here means the team's history can never arrive and every later
 *    `bd dolt pull` meets two unrelated histories — the one outcome lib/team.js says
 *    never retries its way out. Asserted on a real clone with a real `refs/dolt/` ref,
 *    both loose and packed, because a fresh clone can carry it either way.
 *
 * 7. **`bd init` runs in the tracker directory, with `--skip-agents`.** Both halves, from
 *    the recorded argv and cwd. Without the flag `bd init` writes `AGENTS.md`,
 *    `CLAUDE.md` and `.claude/` into the current directory; without the cwd they land in
 *    a checkout anyway. This is a real, silent, committed-by-accident loss and it has one
 *    line of defence in each of two places.
 *
 * 8. **Attaching writes a path and never invents a token.** The approved entry is a path
 *    because the clone went wherever the dialog said, and a repo with no `serviceToken`
 *    is reported rather than given one — lib/repos.js reads that from the checkout on
 *    purpose, and a token written here to make a reply tidy would be a fact about a repo
 *    invented by the app that added it.
 *
 * The runner is injected everywhere a process would be spawned, so nothing here needs
 * `bd` on `PATH`. `git` is real — the clone cases are questions about what a clone
 * *carries*, and a fake git could only prove the fake works.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-newspace-'));
// Before anything under lib/ is imported: `os.homedir()` is read at call time by the
// module, but `tilde()` and the default roots are about HOME, and a suite that let them
// see the real one would write `~`-relative paths that depend on whose Mac it is.
process.env.HOME = tmp;

const {
  attachBeadRepo,
  carriesBeadsData,
  cloneRepo,
  defaultCloneRoot,
  defaultTrackerRoot,
  initTracker,
  inspect,
  nameProblem,
  pinBeadSpace,
  pinSessionDir,
  prefixesInUse,
  readSource,
  repoNameFromUrl,
  suggestPrefix,
  tilde,
} = await import(LIB('newspace.js'));

const mk = (...parts) => {
  const dir = path.join(tmp, ...parts);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};
const beadsIn = (dir, prefix = 'xx') => {
  const beads = path.join(dir, '.beads');
  fs.mkdirSync(beads, { recursive: true });
  fs.writeFileSync(path.join(beads, 'metadata.json'), JSON.stringify({ dolt_database: prefix }));
  return beads;
};

let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}\n      ${err.message}`);
  }
};
const checkAsync = async (label, fn) => {
  try {
    await fn();
    console.log(`  ok  ${label}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL  ${label}\n      ${err.message}`);
  }
};

console.log('newspace: reading a source');

check('a relative path is refused rather than resolved against the daemon cwd', () => {
  const out = readSource({ source: 'path', value: 'projects/safeleaf' }, {});
  assert.match(out.problem, /does not say where it starts/);
  assert.equal(out.dir, '');
});

check('~ expands, and the name is the last segment', () => {
  const out = readSource({ source: 'path', value: '~/projects/safeleaf' }, {});
  assert.equal(out.problem, null);
  assert.equal(out.name, 'safeleaf');
  assert.equal(out.dir, path.join(tmp, 'projects', 'safeleaf'));
});

check('a path ending in .beads names the same bead-space as its parent', () => {
  const a = readSource({ source: 'path', value: '/x/safeleaf/.beads' }, {});
  const b = readSource({ source: 'path', value: '/x/safeleaf' }, {});
  assert.equal(a.name, 'safeleaf');
  assert.deepEqual([a.name, a.dir], [b.name, b.dir]);
});

check('a URL that is not a git URL is refused', () => {
  assert.match(readSource({ source: 'git', value: 'safeleaf' }, {}).problem, /not a git URL/);
});

check('the clone directory defaults under projectRoot, and cloneTo overrides it', () => {
  const cfg = { projectRoot: '~/proj' };
  const auto = readSource({ source: 'git', value: 'https://github.com/o/safeleaf.git' }, cfg);
  assert.equal(auto.name, 'safeleaf');
  assert.equal(auto.dir, path.join(tmp, 'proj', 'safeleaf'));
  const said = readSource({ source: 'git', value: 'git@github.com:o/safeleaf.git', cloneTo: '~/elsewhere/sl' }, cfg);
  assert.equal(said.dir, path.join(tmp, 'elsewhere', 'sl'));
});

check('every URL shape names the same repo', () => {
  for (const u of [
    'https://github.com/Climative/safeleaf',
    'https://github.com/Climative/safeleaf.git',
    'https://github.com/Climative/safeleaf/',
    'git@github.com:Climative/safeleaf.git',
    'ssh://git@github.com/Climative/safeleaf.git',
  ]) {
    assert.equal(repoNameFromUrl(u), 'safeleaf', u);
  }
});

check('a tracker is made in the container root, never in projectRoot', () => {
  // The distinction the two roots exist for: the clone goes where the checkouts are, the
  // `.beads` goes where the trackers are. One helper answering both would have put a
  // tracker beside somebody's source.
  const cfg = { projectRoot: '~/proj' };
  assert.equal(defaultCloneRoot(cfg), path.join(tmp, 'proj'));
  assert.equal(defaultTrackerRoot(cfg), path.join(tmp, 'beads'));
});

console.log('newspace: is the name free');

check('a served name and a retired name are refused, and say different things', () => {
  const cfg = { workspaceDirs: { oldproject: null } };
  assert.equal(nameProblem(cfg, ['beadcause'], 'safeleaf'), null);
  assert.match(nameProblem(cfg, ['beadcause'], 'beadcause'), /already a bead-space/);
  assert.match(nameProblem(cfg, ['beadcause'], 'oldproject'), /Restore/);
});

check('a prefix is suggested past a collision, and every one in use is known', () => {
  const one = mk('beads', 'sophab');
  beadsIn(one, 'sp');
  const served = [{ name: 'sophab', dir: path.join(one, '.beads') }];
  assert.deepEqual([...prefixesInUse(served)], [['sp', 'sophab']]);
  assert.equal(suggestPrefix('safeleaf', served), 'sa');
  assert.equal(suggestPrefix('spindle', served), 'spi', 'sp is taken, so it walks');
});

console.log('newspace: looking at the disk');

check('a directory with a .beads in it is a bead-space, and one without is not', () => {
  const withOne = mk('proj', 'hastracker');
  beadsIn(withOne);
  const without = mk('proj', 'notracker');
  assert.equal(inspect(withOne).beads, path.join(withOne, '.beads'));
  assert.equal(inspect(without).beads, null);
  assert.equal(inspect(path.join(tmp, 'nothing-here')).exists, false);
});

console.log('newspace: cloning');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], {
    cwd,
    stdio: 'pipe',
  });

// One real repo to clone, with one commit in it.
const origin = mk('origin');
git(origin, 'init', '-q');
fs.writeFileSync(path.join(origin, 'README.md'), '# safeleaf\n');
git(origin, 'add', '-A');
git(origin, 'commit', '-qm', 'first');

await checkAsync('a clone into a directory with something in it is refused before git runs', async () => {
  const busy = mk('proj', 'busy');
  fs.writeFileSync(path.join(busy, 'keep.txt'), 'mine');
  let spawned = false;
  const out = await cloneRepo({
    url: origin,
    dir: busy,
    run: async () => {
      spawned = true;
      return { ok: true };
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /already has something in it/);
  assert.equal(spawned, false, 'git must not be spawned at all');
  assert.equal(fs.readFileSync(path.join(busy, 'keep.txt'), 'utf8'), 'mine', 'and nothing touched');
});

await checkAsync('a real clone lands, and the parent is made for it', async () => {
  const dir = path.join(tmp, 'made', 'up', 'safeleaf');
  const out = await cloneRepo({ url: origin, dir });
  assert.equal(out.ok, true, out.error);
  assert.equal(fs.existsSync(path.join(dir, 'README.md')), true);
});

await checkAsync('a failed clone reports git\'s own first line', async () => {
  const out = await cloneRepo({ url: path.join(tmp, 'no-such-repo'), dir: path.join(tmp, 'made', 'nope') });
  assert.equal(out.ok, false);
  assert.match(out.error, /^git clone failed: /);
});

console.log('newspace: the tracker that must not be made twice');

check('a clone carrying refs/dolt/data is recognised, loose or packed', () => {
  const loose = path.join(tmp, 'teamclone-loose');
  execFileSync('git', ['clone', '-q', origin, loose], { stdio: 'pipe' });
  assert.equal(carriesBeadsData(loose), false, 'an ordinary clone carries none');
  fs.mkdirSync(path.join(loose, '.git', 'refs', 'dolt'), { recursive: true });
  assert.equal(carriesBeadsData(loose), true, 'a loose refs/dolt/ is beads history');

  const packed = path.join(tmp, 'teamclone-packed');
  execFileSync('git', ['clone', '-q', origin, packed], { stdio: 'pipe' });
  fs.appendFileSync(
    path.join(packed, '.git', 'packed-refs'),
    '\n0000000000000000000000000000000000000000 refs/dolt/data\n'
  );
  assert.equal(carriesBeadsData(packed), true, 'and so is a packed one');
});

console.log('newspace: bd init');

await checkAsync('bd init runs in the tracker directory with --skip-agents', async () => {
  const seen = [];
  const out = await initTracker({
    root: path.join(tmp, 'beads'),
    name: 'safeleaf',
    prefix: 'sa',
    bin: '/opt/bd',
    actor: 'me@example.com',
    run: async (bin, args, opts) => {
      seen.push({ bin, args, opts });
      // A runner that pretends: the real one leaves a .beads behind, so this must too or
      // the check below it — which is the one that catches a silent no-op — cannot pass.
      fs.mkdirSync(path.join(opts.cwd, '.beads'), { recursive: true });
      return { ok: true, stdout: '', stderr: '' };
    },
  });
  assert.equal(out.ok, true, out.error);
  const [call] = seen;
  assert.equal(call.bin, '/opt/bd');
  assert.deepEqual(call.args, ['init', '--prefix', 'sa', '--role', 'maintainer', '--skip-agents', '--non-interactive']);
  assert.equal(call.opts.cwd, path.join(tmp, 'beads', 'safeleaf'), 'never the checkout');
  assert.equal(call.opts.env.BEADS_DIR, path.join(tmp, 'beads', 'safeleaf', '.beads'));
  assert.equal(call.opts.env.BEADS_ACTOR, 'me@example.com');
});

await checkAsync('bd init that reports success but writes nothing is a failure here', async () => {
  const out = await initTracker({
    root: path.join(tmp, 'beads'),
    name: 'ghost',
    prefix: 'gh',
    run: async () => ({ ok: true, stdout: '', stderr: '' }),
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /is not there/);
});

await checkAsync('a bad prefix is refused before anything is made', async () => {
  let spawned = false;
  const out = await initTracker({
    root: path.join(tmp, 'beads'),
    name: 'shouty',
    prefix: 'SAFELEAF',
    run: async () => {
      spawned = true;
      return { ok: true };
    },
  });
  assert.equal(out.ok, false);
  assert.match(out.error, /not a usable id prefix/);
  assert.equal(spawned, false);
  assert.equal(fs.existsSync(path.join(tmp, 'beads', 'shouty')), false, 'and no directory left behind');
});

console.log('newspace: the config writes');

check('a tracker the roots already reach is not pinned', () => {
  const cfg = { workspaceRoots: ['~/beads'], workspaces: [] };
  const dir = mk('beads', 'discovered');
  beadsIn(dir);
  const out = pinBeadSpace(cfg, { name: 'discovered', dir, discoverable: true });
  assert.equal(cfg.workspaceDirs, undefined, 'no key written at all');
  assert.match(out.changed.join(' '), /no pin needed/);
  assert.deepEqual(cfg.workspaces, [{ name: 'discovered', dir: path.join(dir, '.beads') }]);
});

check('a tracker anywhere else is pinned, and the path is written with a ~', () => {
  const cfg = { workspaces: [{ name: 'aaa', dir: '/aaa/.beads' }] };
  const dir = mk('elsewhere', 'safeleaf');
  beadsIn(dir);
  pinBeadSpace(cfg, { name: 'safeleaf', dir, discoverable: false });
  assert.equal(cfg.workspaceDirs.safeleaf, '~/elsewhere/safeleaf');
  assert.deepEqual(
    cfg.workspaces.map((w) => w.name),
    ['aaa', 'safeleaf'],
    'and the served list stays sorted'
  );
});

check('sessionDirs is pinned only when the checkout is not where the rule looks', () => {
  const cfg = { projectRoot: '~/proj' };
  assert.deepEqual(pinSessionDir(cfg, { name: 'safeleaf', dir: path.join(tmp, 'proj', 'safeleaf') }).changed, []);
  assert.equal(cfg.sessionDirs, undefined);
  pinSessionDir(cfg, { name: 'safeleaf', dir: path.join(tmp, 'elsewhere', 'safeleaf') });
  assert.equal(cfg.sessionDirs.safeleaf, '~/elsewhere/safeleaf');
});

check('sessionDirs is left alone on an install with no projectRoot', () => {
  // There is no rule to be an exception to: sessions open in the bead-space's own
  // directory, and a pin here would be inventing a mapping nobody asked for.
  const cfg = {};
  assert.deepEqual(pinSessionDir(cfg, { name: 'x', dir: '/anywhere/x' }).changed, []);
  assert.equal(cfg.sessionDirs, undefined);
});

check('attaching a bead-repo writes a path, and twice is refused', () => {
  const cfg = { repos: { climative: { root: '~/climative.dev', approved: ['architecture'] } } };
  const first = attachBeadRepo(cfg, { workspace: 'climative', dir: path.join(tmp, 'elsewhere', 'athena') });
  assert.equal(first.already, false);
  assert.deepEqual(cfg.repos.climative.approved, ['architecture', '~/elsewhere/athena']);
  const again = attachBeadRepo(cfg, { workspace: 'climative', dir: path.join(tmp, 'elsewhere', 'athena') });
  assert.equal(again.already, true);
  assert.equal(cfg.repos.climative.approved.length, 2, 'and nothing appended');
});

check('a bare approved name and its expansion are the same repo', () => {
  // `athena-service` under the root and `~/climative.dev/athena-service` are one
  // checkout written two ways, and attaching the second over the first would put the
  // same repo on the list twice with two names.
  const cfg = { repos: { climative: { root: tilde(path.join(tmp, 'climative.dev')), approved: ['athena-service'] } } };
  const out = attachBeadRepo(cfg, { workspace: 'climative', dir: path.join(tmp, 'climative.dev', 'athena-service') });
  assert.equal(out.already, true);
});

check('attaching to a bead-space with no repos block at all makes one', () => {
  const cfg = {};
  attachBeadRepo(cfg, { workspace: 'sophab', dir: '/x/plugin' });
  assert.deepEqual(cfg.repos.sophab.approved, ['/x/plugin']);
});

fs.rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.error(`\nnewspace: ${failures} failed`);
  process.exit(1);
}
console.log('\nnewspace: all good');
