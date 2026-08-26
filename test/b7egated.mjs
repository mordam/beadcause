#!/usr/bin/env node
//
// b7e-gated — does a gate run's own recorded tree still match the tree in front of
// you (bc-dgx7.39), against `lib/gaterun.js`'s `startRun`/`compareToTree` and the real
// CLI.
//
//   npm test
//   node test/b7egated.mjs
//
// A real git repo, the same shape test/b7ewatch.mjs already builds for the same
// module — this needs `git stash create`/`git write-tree`/`git diff` to behave like
// real git against a real working tree, and a fake filesystem would agree with itself
// about that and prove nothing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-gated');

const gaterun = await import(path.join(ROOT, 'lib', 'gaterun.js'));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
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
const checkAsync = async (name, fn) => {
  try {
    await fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

/* ===================================================================== *
 * fixture — a real repo plus a nested worktree, the same shape
 * test/b7ewatch.mjs builds for the same module.
 * ===================================================================== */

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7egated-test-'));

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

function makeRepo(name, files) {
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(work, '.gitignore'), 'node_modules\n.claude/gate-runs/\n');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  return work;
}

const main = makeRepo('main-repo', {
  'README.md': 'first line\n',
  'test/x.mjs': "console.log('ok');\n",
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===================================================================== *
 * 1. lib/gaterun.js — startRun stamps a tree, compareToTree reads it back
 * ===================================================================== */

console.log('\nlib/gaterun.js: the tree a run stamps, and what compareToTree makes of it\n');

await checkAsync('startRun stamps sha, a tree snapshot, and the untracked list', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  assert.equal(r.sha, git(main, 'rev-parse', 'HEAD').trim());
  assert.ok(r.tree, 'a clean tree should still stamp HEAD as its tree');
  assert.deepEqual(r.untracked, {});
});

await checkAsync('startRun with no origin remote at all leaves mergeBase null, not throwing — bc-dgx7.62', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  assert.equal(r.mergeBase, null, 'this fixture never adds an origin remote, so there is nothing to compute a merge-base against');
});

await checkAsync('an unedited tree compares as a match', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  const cmp = await gaterun.compareToTree(r);
  assert.equal(cmp.matches, true);
  assert.deepEqual(cmp.changed, []);
});

await checkAsync('a tracked file touched after the run started — reported by name, exit-worthy', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  fs.writeFileSync(path.join(main, 'README.md'), 'first line\nedited mid-run\n');
  const cmp = await gaterun.compareToTree(r);
  assert.equal(cmp.matches, false);
  assert.deepEqual(cmp.changed, ['README.md']);
  // restore for the checks after this one
  fs.writeFileSync(path.join(main, 'README.md'), 'first line\n');
});

await checkAsync('touched and then reverted to the exact same content compares as unchanged', async () => {
  // This is the acceptance case that a naive mtime or mtime-based check would fail,
  // and the reason the comparison is by content (`git diff`) rather than by whether
  // anything was written.
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  const orig = fs.readFileSync(path.join(main, 'README.md'), 'utf8');
  fs.writeFileSync(path.join(main, 'README.md'), orig + 'temporary\n');
  fs.writeFileSync(path.join(main, 'README.md'), orig);
  const cmp = await gaterun.compareToTree(r);
  assert.equal(cmp.matches, true, `expected a match, got changed=${JSON.stringify(cmp.changed)}`);
});

await checkAsync(
  'an ALREADY-dirty tree at run start compares as unchanged later, even though two `git stash create` calls mint different commit shas',
  async () => {
    // The trap this file exists to pin: `git stash create`'s synthetic commit carries its
    // own timestamp, so calling it twice over the SAME unedited dirty content returns two
    // DIFFERENT commit shas. A comparison that short-circuited on `nowTree === run.tree`
    // would misreport drift on every run started against a tree that already had local
    // edits in it — the common case for this tool, not the rare one.
    fs.writeFileSync(path.join(main, 'README.md'), 'first line\nalready dirty before the run starts\n');
    const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
    const r = gaterun.readRun(file);
    await sleep(1100); // stash-create's commit timestamp has 1s resolution
    const cmp = await gaterun.compareToTree(r);
    assert.equal(cmp.matches, true, `expected a match despite the timestamp gap, got changed=${JSON.stringify(cmp.changed)}`);
    fs.writeFileSync(path.join(main, 'README.md'), 'first line\n');
  }
);

await checkAsync('a new untracked file after the run started is named too', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  fs.writeFileSync(path.join(main, 'scratch.txt'), 'new file\n');
  const cmp = await gaterun.compareToTree(r);
  assert.equal(cmp.matches, false);
  assert.deepEqual(cmp.changed, ['scratch.txt']);
  fs.rmSync(path.join(main, 'scratch.txt'));
  const cmp2 = await gaterun.compareToTree(r);
  assert.equal(cmp2.matches, true, 'removing it again should cancel the drift out');
});

await checkAsync('an untracked file edited in place, while it STAYS untracked, is caught by content — not just by whether it is still there', async () => {
  // The real gap a by-NAME-only untracked comparison has: two untracked snapshots
  // that both simply contain "scratch.txt" read as identical regardless of what is
  // actually inside it. Content hashing (untrackedHashes) is what catches this.
  fs.writeFileSync(path.join(main, 'scratch2.txt'), 'first content\n');
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  const cmpUnedited = await gaterun.compareToTree(r);
  assert.equal(cmpUnedited.matches, true);

  fs.writeFileSync(path.join(main, 'scratch2.txt'), 'edited content, still untracked\n');
  const cmpEdited = await gaterun.compareToTree(r);
  assert.equal(cmpEdited.matches, false, 'editing an untracked file must be seen even though it never left the untracked list');
  assert.deepEqual(cmpEdited.changed, ['scratch2.txt']);
  fs.rmSync(path.join(main, 'scratch2.txt'));
});

await checkAsync(
  'a KNOWN, deliberate exception: an untracked file `git add`ed and committed with identical content still reads as moved',
  async () => {
    // `run.tree` only ever captures TRACKED content (`git stash create` cannot see an
    // untracked file at all), so a path absent from it at run-start is absent from the
    // comparison's tracked side no matter what happens to it later — `git diff
    // --name-only` reports it as "added" once it is committed, regardless of whether
    // its bytes match what the untracked-hash record says they were. This is a
    // deliberately accepted false positive, not a bug: see the doc comment on
    // `compareToTree` for why closing it (a merged tracked+untracked tree object) was
    // left as a possible follow-up rather than built here. Pinned as a test so nobody
    // "fixes" this file into asserting the opposite without reading why.
    fs.writeFileSync(path.join(main, 'new-file.txt'), 'brand new, untracked at run start\n');
    const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
    const r = gaterun.readRun(file);
    assert.ok(r.untracked['new-file.txt'], 'the new file should be recorded, by content hash');

    git(main, 'add', 'new-file.txt');
    git(main, 'commit', '-q', '-m', 'add new-file.txt, untouched since the run started');
    const cmp = await gaterun.compareToTree(r);
    assert.equal(cmp.matches, false, `expected the known false positive, got changed=${JSON.stringify(cmp.changed)}`);
    assert.deepEqual(cmp.changed, ['new-file.txt']);
  }
);

await checkAsync('--staged compares the index now, not the working tree', async () => {
  const { file } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  const r = gaterun.readRun(file);
  fs.writeFileSync(path.join(main, 'README.md'), 'first line\nstaged edit\n');
  git(main, 'add', 'README.md');
  const cmpWorking = await gaterun.compareToTree(r); // working tree == index here, both moved
  assert.equal(cmpWorking.matches, false);
  const cmpStaged = await gaterun.compareToTree(r, { staged: true });
  assert.equal(cmpStaged.matches, false);
  assert.deepEqual(cmpStaged.changed, ['README.md']);
  git(main, 'reset', 'README.md');
  fs.writeFileSync(path.join(main, 'README.md'), 'first line\n');
});

await checkAsync('a run written before this bead landed (no tree recorded) cannot be compared', () => {
  const dir = path.join(main, '.claude', 'gate-runs');
  const file = path.join(dir, 'main-no-tree-test.jsonl');
  fs.writeFileSync(
    file,
    JSON.stringify({ type: 'start', runId: 'main-no-tree-test', at: new Date().toISOString(), total: 1, suites: ['x'], worktree: 'main' }) +
      '\n'
  );
  const r = gaterun.readRun(file);
  assert.equal(r.tree, null);
  return gaterun.compareToTree(r).then((cmp) => {
    assert.equal(cmp.matches, null);
    assert.equal(cmp.reason, 'no-baseline');
    fs.rmSync(file);
  });
});

/* ===================================================================== *
 * 2. the CLI — spawned for real, against the same fixture
 * ===================================================================== */

console.log('\nthe CLI\n');

// A worktree nested under `.claude/worktrees/`, this repo's own real layout — proves a
// run started against one resolves the same shared `.claude/gate-runs` from the other.
// Cut here, after the `main`-only checks above, so its own directory does not show up
// as an untracked entry under `main` while those were asserting an exact `untracked`.
const wt1 = path.join(main, '.claude', 'worktrees', 'wt1');
git(main, 'worktree', 'add', '-q', '-b', 'wt1-branch', wt1, 'main');

const run = (cwd, args = []) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8' });

check('no run at all for this worktree — exit 2, says so', () => {
  const scratch = makeRepo('cli-empty', { 'test/x.mjs': "console.log('ok');\n" });
  const r = run(scratch);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no gate run found/);
});

check('--run naming a run that does not exist — exit 2', () => {
  const scratch = makeRepo('cli-badrun', { 'test/x.mjs': "console.log('ok');\n" });
  const r = run(scratch, ['--run', 'nope']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no run nope/);
});

await checkAsync('an unedited tree — exit 0, says unchanged', async () => {
  await gaterun.startRun(wt1, { suites: ['test/x.mjs'] });
  const r = run(wt1);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /tree unchanged since it started/);
});

await checkAsync('a tracked file touched — exit 1, names it', async () => {
  await gaterun.startRun(wt1, { suites: ['test/x.mjs'] });
  fs.writeFileSync(path.join(wt1, 'README.md'), 'first line\ntouched via wt1\n');
  const r = run(wt1);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stdout, /tree has moved under it/);
  assert.match(r.stdout, /README\.md/);
  git(wt1, 'checkout', '--', 'README.md');
});

await checkAsync('--json prints a matching machine-readable line', async () => {
  await gaterun.startRun(wt1, { suites: ['test/x.mjs'] });
  fs.writeFileSync(path.join(wt1, 'README.md'), 'first line\ntouched again\n');
  const r = run(wt1, ['--json']);
  assert.equal(r.status, 1, r.stderr);
  const parsed = JSON.parse(r.stdout);
  assert.equal(parsed.matches, false);
  assert.deepEqual(parsed.changed, ['README.md']);
  git(wt1, 'checkout', '--', 'README.md');
});

await checkAsync('--run <id> started from one worktree is readable from another', async () => {
  const { runId } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
  // Asked for from wt1 — a different worktree, a different session's cwd entirely.
  const r = run(wt1, ['--run', runId]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(runId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(r.stdout, /\(main,/, "the run's own worktree tag travels with it, not the caller's");
});

await checkAsync(
  "--run <id>, read from wt1, compares the RUN's own directory (main) — not wt1's, which is on a different branch entirely",
  async () => {
    const { runId } = await gaterun.startRun(main, { suites: ['test/x.mjs'] });
    // wt1 is on its own branch (wt1-branch) and its README.md content has nothing to
    // do with main's run — if the comparison mistakenly targeted the CALLER's cwd
    // (bc-dgx7.39's own bug before it was caught in this file) this would misreport
    // drift on every cross-worktree lookup, since the two trees never matched to begin
    // with.
    const before = run(wt1, ['--run', runId]);
    assert.equal(before.status, 0, before.stderr);
    assert.match(before.stdout, /tree unchanged since it started/);

    // Editing wt1's OWN tree must not be seen — the comparison is against main's tree.
    fs.writeFileSync(path.join(wt1, 'README.md'), 'this is wt1, unrelated to the run in main\n');
    const stillClean = run(wt1, ['--run', runId]);
    assert.equal(stillClean.status, 0, stillClean.stderr);
    assert.match(stillClean.stdout, /tree unchanged since it started/);
    git(wt1, 'checkout', '--', 'README.md');

    // Editing main's tree — the run's own directory — from wt1's vantage point must be seen.
    fs.writeFileSync(path.join(main, 'README.md'), 'first line\nedited in main, the run\'s own directory\n');
    const nowDirty = run(wt1, ['--run', runId]);
    assert.equal(nowDirty.status, 1, nowDirty.stderr);
    assert.match(nowDirty.stdout, /README\.md/);
    fs.writeFileSync(path.join(main, 'README.md'), 'first line\n');
  }
);

removeTreeSync(tmp);

if (failures) {
  console.log(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nall b7e-gated checks passed');
