#!/usr/bin/env node
/**
 * lib/attic.js — the sweep that empties `.claude/worktrees-retired/`.
 *
 *     npm test
 *     node test/attic.mjs
 *
 * This file is the reason the sweep moved into the repo, so it is worth saying what it
 * is defending against. The sweep was 210 lines of bash in `~/.claude-personal/skills/`,
 * versioned by nothing and tested by nothing, and run by every ship. bc-bcdp is what
 * that cost: one line of it inverted its own answer — `git worktree list --porcelain |
 * grep -qx "worktree $dir"` under `set -o pipefail`, where `grep -q` exits at the first
 * match, git dies of SIGPIPE still walking the rest, and pipefail reports the successful
 * match as a failure — so 68 of 85 perfectly healthy attic entries were reported as
 * unregistered strays, with the count moving run to run. A session read that output,
 * believed it, and filed a bug describing a hand-`mv` that never happened and a name
 * collision that did not exist. Nothing stood between the script and its reader.
 *
 * So the two things asserted hardest here are the two that were wrong:
 *
 * 1. **A healthy attic has no strays**, stably, over repeated runs — and a real stray is
 *    still reported, and still not deleted.
 * 2. **Every gate keeps what it says it keeps.** Age, lock, detached HEAD, unmerged,
 *    dirty, claimed by a handoff. Each one is the difference between a resumable
 *    directory and destroying the only copy of somebody's commits, and each is checked
 *    against a real worktree in a real repo rather than a mock: `git worktree` semantics
 *    are the whole subject, and a fake would agree with whatever the code assumed.
 *
 * Real `git` throughout, in a temp directory, with the clock injected — a test that has
 * to `touch` its way to four days old is a test nobody writes. No network: the
 * `origin/main` case pushes to a bare repo next door.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { sweepAttic, describeAttic, worthSaying, parseStamp } = await import(path.join(ROOT, 'lib', 'attic.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-attic-'));

let failures = 0;
let ran = 0;
async function check(name, fn) {
  ran += 1;
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (err) {
    failures += 1;
    console.log(`  FAIL ${name}`);
    console.log(`       ${String(err.message).split('\n').slice(0, 8).join('\n       ')}`);
  }
}

/* ---------------------------------------------------------------- fixtures */

/** git with an identity of its own, so this never depends on the machine's. */
const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

const DAY = 86400000;
const NOW = Date.parse('2026-08-10T12:00:00Z');
/** Whole seconds, which is the shape `ship` step 8's `date -u +%FT%TZ` writes. */
const secondsAgo = (days) => new Date(NOW - days * DAY).toISOString().replace(/\.\d+Z$/, 'Z');
/** Milliseconds, which is the shape lib/tidy.js's `toISOString()` writes. */
const millisAgo = (days) => new Date(NOW - days * DAY).toISOString();

/** A repo with a main branch, one commit, and an attic. Returns the main checkout. */
function makeRepo(name) {
  const main = path.join(tmp, name);
  fs.mkdirSync(main, { recursive: true });
  git(main, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(main, 'file.txt'), 'one\n');
  git(main, 'add', 'file.txt');
  git(main, 'commit', '-q', '-m', 'one');
  fs.mkdirSync(path.join(main, '.claude', 'worktrees-retired'), { recursive: true });
  return main;
}

const atticOf = (main) => path.join(main, '.claude', 'worktrees-retired');

/**
 * One retired entry: a real registered worktree under the attic, with a `.note`.
 *
 * `git worktree add` at HEAD gives a branch that is already an ancestor of `main`, which
 * is the ordinary state of a retired worktree — everything it did is in main, which is
 * why it was retired. The interesting cases below break exactly one of those properties.
 */
function retire(main, name, { stamp = secondsAgo(5), detach = false, note = true } = {}) {
  const dir = path.join(atticOf(main), name);
  if (detach) git(main, 'worktree', 'add', '-q', '--detach', dir, 'HEAD');
  else git(main, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir, 'HEAD');
  if (note) fs.writeFileSync(`${dir}.note`, `${stamp}  retired by beadcause after abc1234\n`);
  return dir;
}

const names = (list) => list.map((e) => e.name).sort();
const why = (list, name) => (list.find((e) => e.name === name) || {}).why || '';

/* ---------------------------------------------------------------- the stamp */

console.log('the .note stamp, from either writer');

await check('whole seconds, as `ship` step 8 writes them', () => {
  assert.equal(parseStamp('2026-08-09T23:31:04Z'), Date.parse('2026-08-09T23:31:04Z'));
});

await check('milliseconds, as lib/tidy.js writes them', () => {
  // The one that mattered: half the attic is written by the daemon, and treating its
  // stamps as unparseable would keep every daemon-retired entry forever.
  assert.equal(parseStamp('2026-08-08T17:35:33.804Z'), Date.parse('2026-08-08T17:35:33Z'));
});

await check('anything else is not a stamp, rather than a wrong date', () => {
  for (const bad of ['', 'retired', '2026-08-09', 'yesterday', '09/08/2026', undefined]) {
    assert.equal(parseStamp(bad), null, `parsed: ${bad}`);
  }
});

/* ---------------------------------------------------------------- the gates */

console.log('\nthe five gates, plus age');

const gates = makeRepo('gates');

// Old, merged, clean, unlocked, unclaimed — the only shape that goes.
retire(gates, 'ripe');
// Carrying untracked files, which is what the soft delete is *for*: it must not save it.
fs.writeFileSync(path.join(retire(gates, 'ripe-untracked'), 'scratch.md'), 'notes\n');

// Age.
retire(gates, 'young', { stamp: secondsAgo(0.5) });
retire(gates, 'no-note', { note: false });
retire(gates, 'bad-stamp', { stamp: 'sometime-last-week' });

// Locked — a live session's claim.
git(gates, 'worktree', 'lock', retire(gates, 'locked'));

// Detached: no branch, so no ancestry question can be asked.
retire(gates, 'detached', { detach: true });

// Unmerged: a commit that exists nowhere but here.
const unmerged = retire(gates, 'unmerged');
fs.writeFileSync(path.join(unmerged, 'only-here.txt'), 'irreplaceable\n');
git(unmerged, 'add', 'only-here.txt');
git(unmerged, 'commit', '-q', '-m', 'only here');

// Dirty: a tracked file edited and not committed.
fs.writeFileSync(path.join(retire(gates, 'dirty'), 'file.txt'), 'edited\n');

// Claimed by a live handoff, and a second one named only by a spent `archive/` handoff.
retire(gates, 'claimed');
retire(gates, 'archived-claim');
fs.mkdirSync(path.join(gates, '.claude', 'handoffs', 'archive'), { recursive: true });
fs.writeFileSync(path.join(gates, '.claude', 'handoffs', 'live.md'), 'continue in claimed\n');
fs.writeFileSync(path.join(gates, '.claude', 'handoffs', 'archive', 'old.md'), 'was in archived-claim\n');

// A stray: a directory somebody put there by hand, registered by nothing.
fs.mkdirSync(path.join(atticOf(gates), 'hand-moved'), { recursive: true });
// An orphan note: its directory is already gone.
fs.writeFileSync(path.join(atticOf(gates), 'vanished.note'), `${secondsAgo(9)}  retired\n`);

const dry = await sweepAttic(gates, { now: NOW, dryRun: true });

const RIPE = ['archived-claim', 'ripe', 'ripe-untracked'];

await check('a dry run removes exactly the entries that pass every gate', () => {
  assert.deepEqual(names(dry.removed), RIPE);
});

await check('and removes nothing from disk', () => {
  assert.ok(fs.existsSync(path.join(atticOf(gates), 'ripe')), 'a dry run must not touch anything');
  assert.ok(fs.existsSync(path.join(atticOf(gates), 'ripe.note')));
});

await check('an entry under the age line is counted, not listed', () => {
  assert.deepEqual(names(dry.young), ['young']);
  assert.match(why(dry.young, 'young'), /younger than 2d/);
  assert.ok(!names(dry.skipped).includes('young'), 'young is the normal case, not an exception');
});

await check('a lock is a claim and is honoured', () => {
  assert.match(why(dry.skipped, 'locked'), /LOCKED/);
});

await check('an unmerged branch is kept, because removing it destroys its only copy', () => {
  assert.match(why(dry.skipped, 'unmerged'), /NOT merged into main/);
});

await check('tracked edits are kept; untracked files are not a reason to keep anything', () => {
  assert.match(why(dry.skipped, 'dirty'), /dirty/);
  assert.ok(names(dry.removed).includes('ripe-untracked'), 'the soft delete exists to carry untracked files');
});

await check('a detached HEAD has no branch to check ancestry against, so it stays', () => {
  assert.match(why(dry.skipped, 'detached'), /detached HEAD/);
});

await check('a live handoff naming it forbids removal, and a spent archive/ one does not', () => {
  assert.match(why(dry.skipped, 'claimed'), /named by a live handoff/);
  // Same age, same branch state, same everything — the only difference between the two
  // is which directory the handoff naming it sits in.
  assert.ok(names(dry.removed).includes('archived-claim'), 'archive/ is spent by definition');
});

await check('a missing .note is a skip with the flag that fixes it', () => {
  assert.match(why(dry.skipped, 'no-note'), /--backfill/);
});

await check('an unparseable stamp says what it could not read', () => {
  assert.match(why(dry.skipped, 'bad-stamp'), /unparseable .note stamp: sometime-last-week/);
});

/* ------------------------------------------------------- strays: bc-bcdp itself */

console.log('\nstrays — the false bug report');

await check('a healthy attic reports zero strays, and says so the same way every run', async () => {
  const healthy = makeRepo('healthy');
  for (let n = 1; n <= 8; n++) retire(healthy, `entry-${n}`, { stamp: secondsAgo(0.1) });
  // Five runs, because the bug this replaces raced: its count moved run to run with how
  // far git had got before the pipe closed, so "0 once" would not have caught it.
  for (let run = 0; run < 5; run++) {
    const r = await sweepAttic(healthy, { now: NOW });
    assert.deepEqual(r.strays, [], `run ${run + 1} invented strays: ${JSON.stringify(r.strays)}`);
    assert.equal(r.young.length, 8, `run ${run + 1} lost entries`);
  }
});

await check('a directory nobody registered is reported by name', () => {
  assert.match(why(dry.strays, 'hand-moved'), /not a registered worktree/);
});

await check('an orphan .note is reported as one', () => {
  assert.match(why(dry.strays, 'vanished.note'), /orphan .note/);
});

await check('and neither is ever deleted — guessing is how you lose work', async () => {
  await sweepAttic(gates, { now: NOW, dryRun: true });
  assert.ok(fs.existsSync(path.join(atticOf(gates), 'hand-moved')), 'a stray directory must survive');
  assert.ok(fs.existsSync(path.join(atticOf(gates), 'vanished.note')), 'an orphan note must survive');
});

/* ---------------------------------------------------------------- removal */

console.log('\nthe removal itself');

const wet = await sweepAttic(gates, { now: NOW });

await check('the same entries go for real', () => {
  assert.deepEqual(names(wet.removed), RIPE);
  assert.ok(!fs.existsSync(path.join(atticOf(gates), 'ripe')), 'the directory is gone');
  assert.ok(!fs.existsSync(path.join(atticOf(gates), 'ripe.note')), 'and so is its note');
});

await check('the branch is kept — it is the only human-readable label on those commits', () => {
  const branches = git(gates, 'branch', '--format=%(refname:short)').split('\n');
  assert.ok(branches.includes('worktree-ripe'), branches.join(','));
  assert.ok(branches.includes('worktree-ripe-untracked'), branches.join(','));
});

await check('the registration goes with the directory, leaving nothing dangling', () => {
  const list = git(gates, 'worktree', 'list', '--porcelain');
  assert.ok(!list.includes(`${path.join(atticOf(gates), 'ripe')}\n`), list);
  // Which is also why the removed entries are not then reported as strays.
  assert.ok(!names(wet.strays).includes('ripe'), 'a just-removed entry is not a stray');
});

await check('everything it refused is still there afterwards', () => {
  for (const kept of ['young', 'locked', 'unmerged', 'dirty', 'detached', 'claimed', 'no-note', 'bad-stamp']) {
    assert.ok(fs.existsSync(path.join(atticOf(gates), kept)), `${kept} was removed and must not have been`);
  }
});

await check('a second sweep is a no-op — it does not re-report what it took', async () => {
  const again = await sweepAttic(gates, { now: NOW });
  assert.deepEqual(again.removed, []);
  assert.deepEqual(names(again.strays), ['hand-moved', 'vanished.note']);
});

/* ---------------------------------------------------------------- backfill */

console.log('\n--backfill, for entries older than the convention');

await check('a stamp is written from directory mtime, and the entry becomes sweepable', async () => {
  const old = makeRepo('backfill');
  const dir = retire(old, 'ancient', { note: false });
  const long = new Date(NOW - 9 * DAY);
  fs.utimesSync(dir, long, long);

  const before = await sweepAttic(old, { now: NOW, dryRun: true });
  assert.match(why(before.skipped, 'ancient'), /--backfill/);

  // A dry run answers the question it is being asked — what would go once these had
  // stamps — and still writes nothing. The bash version backfilled for real here.
  const proposed = await sweepAttic(old, { now: NOW, dryRun: true, backfill: true });
  assert.deepEqual(names(proposed.backfilled), ['ancient']);
  assert.deepEqual(names(proposed.removed), ['ancient'], 'a backfilled stamp is a stamp');
  assert.ok(!fs.existsSync(`${dir}.note`), 'a dry run must not leave a note behind');

  const filled = await sweepAttic(old, { now: NOW, backfill: true });
  assert.deepEqual(names(filled.removed), ['ancient']);
  assert.ok(!fs.existsSync(dir), 'and a real one takes the entry it just stamped');
  assert.ok(!fs.existsSync(`${dir}.note`), 'note and directory go together');
});

await check('mtime is a late proxy, so a backfill can only ever keep something longer', async () => {
  const fresh = makeRepo('backfill-fresh');
  retire(fresh, 'touched-today', { note: false });
  const r = await sweepAttic(fresh, { now: NOW, dryRun: true, backfill: true });
  // The directory was created just now, so its mtime says "young" even if it was
  // retired a week ago — which is the safe direction to be wrong in.
  assert.deepEqual(r.removed, []);
  assert.deepEqual(names(r.young), ['touched-today']);
});

/* ------------------------------------------------- origin/main vs a stale local main */

console.log('\nwhich main — origin/main first, local main as the fallback');

await check('a branch merged on GitHub is removable even when local main has not caught up', async () => {
  const repo = makeRepo('remote');
  const bare = path.join(tmp, 'origin.git');
  git(tmp, 'init', '-q', '--bare', bare);
  git(repo, 'remote', 'add', 'origin', bare);

  // A retired worktree whose commits are in origin/main and nowhere local.
  const dir = retire(repo, 'shipped');
  fs.writeFileSync(path.join(dir, 'shipped.txt'), 'landed\n');
  git(dir, 'add', 'shipped.txt');
  git(dir, 'commit', '-q', '-m', 'shipped');
  const stale = git(repo, 'rev-parse', 'HEAD').trim();
  git(repo, 'merge', '-q', '--no-ff', '-m', 'merge shipped', 'worktree-shipped');
  git(repo, 'push', '-q', 'origin', 'main');
  // …and a local main left fifty commits behind, which is the ordinary state of this
  // repo: `origin/main` moves and the local branch stays where the last pull left it.
  git(repo, 'reset', '-q', '--hard', stale);

  assert.throws(() => git(repo, 'merge-base', '--is-ancestor', 'worktree-shipped', 'main'), 'fixture: local main must be stale');
  const r = await sweepAttic(repo, { now: NOW, dryRun: true });
  assert.deepEqual(names(r.removed), ['shipped'], 'origin/main is the ref that knows');
});

await check('with no remote at all, local main is the answer and not an error', async () => {
  const repo = makeRepo('no-remote');
  retire(repo, 'local-only');
  const r = await sweepAttic(repo, { now: NOW, dryRun: true });
  assert.deepEqual(names(r.removed), ['local-only']);
});

await check('a ref that does not exist answers no, and the entry survives another day', async () => {
  // A repo whose only branch is not `main`: neither ref resolves, so nothing can be
  // proved merged and nothing is removed. Wrong in the safe direction.
  const repo = path.join(tmp, 'no-main');
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'trunk');
  fs.writeFileSync(path.join(repo, 'f'), 'x\n');
  git(repo, 'add', 'f');
  git(repo, 'commit', '-q', '-m', 'one');
  fs.mkdirSync(atticOf(repo), { recursive: true });
  retire(repo, 'orphaned');
  const r = await sweepAttic(repo, { now: NOW, dryRun: true });
  assert.deepEqual(r.removed, []);
  assert.match(why(r.skipped, 'orphaned'), /NOT merged into main/);
});

/* ---------------------------------------------------------------- scope */

console.log('\nwhat it will not touch');

await check('nothing outside the attic, including live worktrees and the main checkout', async () => {
  const repo = makeRepo('scope');
  fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
  const live = path.join(repo, '.claude', 'worktrees', 'in-use');
  git(repo, 'worktree', 'add', '-q', '-b', 'worktree-in-use', live, 'HEAD');
  fs.writeFileSync(`${live}.note`, `${secondsAgo(9)}  not retired at all\n`);
  retire(repo, 'in-attic');

  const r = await sweepAttic(repo, { now: NOW });
  assert.deepEqual(names(r.removed), ['in-attic'], 'only the attic is swept');
  assert.ok(fs.existsSync(live), 'a live worktree is not the attic sweep’s business');
  assert.ok(fs.existsSync(path.join(repo, 'file.txt')), 'and neither is the main checkout');
});

await check('a repo with no attic at all is a no-op, not a failure', async () => {
  const repo = makeRepo('no-attic');
  fs.rmSync(atticOf(repo), { recursive: true, force: true });
  const r = await sweepAttic(repo, { now: NOW });
  assert.equal(r.ran, false);
  assert.deepEqual(r.removed, []);
  assert.match(describeAttic(r).join('\n'), /nothing to do/);
  assert.equal(worthSaying(r), false, 'a quiet ship should be able to say nothing');
});

await check('it refuses to run from a worktree, rather than removing the tree it stands in', async () => {
  const repo = makeRepo('from-worktree');
  const dir = retire(repo, 'somewhere');
  await assert.rejects(() => sweepAttic(dir, { now: NOW }), /is a worktree, not the main checkout/);
});

await check('and refuses a directory that is not a repo', async () => {
  const plain = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  await assert.rejects(() => sweepAttic(plain, { now: NOW }), /not a git repo/);
});

/* ---------------------------------------------------------------- the report */

console.log('\nthe report, which is the part a human reads');

await check('one summary line, a row per exception, and a count for the boring bulk', () => {
  const text = describeAttic(wet).join('\n');
  assert.match(text, /^attic sweep \(>2d\): removed 3, kept \d+/m);
  assert.match(text, /removed\s+ripe\s+5\.0d\s+removed \(worktree-ripe kept\)/);
  assert.match(text, /SKIPPED\s+unmerged/);
  assert.match(text, /STRAY\s+hand-moved/);
  assert.match(text, /\(young\)\s+1 entry under the 2d line/);
});

await check('a dry run says would-remove everywhere it says removed', () => {
  const text = describeAttic(dry).join('\n');
  assert.match(text, /attic sweep \(>2d\): would remove 3/);
  assert.match(text, /would remove\s+ripe\s/);
  assert.ok(!/^\s+removed\s/m.test(text), text);
});

await check('and a sweep with nothing to say can be silent', async () => {
  const quiet = makeRepo('quiet');
  retire(quiet, 'not-yet', { stamp: secondsAgo(0.2) });
  const r = await sweepAttic(quiet, { now: NOW });
  assert.equal(worthSaying(r), false, 'a zero-removal run is the normal, correct result');
  assert.match(describeAttic(r).join('\n'), /kept 1/, 'silence is the caller’s choice, not the report’s');
});

/* ---------------------------------------------------------------- the CLI */

console.log('\nbin/attic.js — exit 0 when it ran, 2 for a bad invocation');

const cli = (args, cwd = ROOT) => {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'bin', 'attic.js'), ...args], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out, err: '' };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || ''), err: String(err.stderr || '') };
  }
};

await check('a sweep that ran exits 0, even having skipped things', () => {
  const r = cli([path.join(tmp, 'gates'), '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /attic sweep/);
  assert.match(r.out, /SKIPPED/, 'a ship must not fail because the attic held something unmergeable');
});

await check('--quiet on a boring attic prints nothing at all', () => {
  const r = cli([path.join(tmp, 'quiet'), '--quiet']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), '', r.out);
});

await check('no arguments, a bad flag, a bad --days and a worktree are all exit 2', () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli([path.join(tmp, 'gates'), '--wat']).code, 2);
  assert.equal(cli([path.join(tmp, 'gates'), '--days', 'soon']).code, 2);
  assert.equal(cli([path.join(tmp, 'gates'), path.join(tmp, 'quiet')]).code, 2, 'two checkouts is a typo, not a batch');
  const wt = cli([path.join(tmp, 'gates', '.claude', 'worktrees-retired', 'locked')]);
  assert.equal(wt.code, 2);
  assert.match(wt.err, /worktree, not the main checkout/);
});

await check('--days takes a fraction, which is the only honest way to test an expiry', () => {
  const r = cli([path.join(tmp, 'quiet'), '--days=0.1', '--dry-run']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /would remove 1/, r.out);
});

await check('--help says how to call it and exits 0', () => {
  const r = cli(['--help']);
  assert.equal(r.code, 0);
  assert.match(r.out, /usage: beadcause-attic <main-checkout>/);
});

/* ---------------------------------------------------------------- verdict */

console.log('');
fs.rmSync(tmp, { recursive: true, force: true });
if (failures) {
  console.log(`\x1b[31m${failures} of ${ran} checks failed\x1b[0m`);
  process.exit(1);
}
console.log(`\x1b[32mall ${ran} checks passed\x1b[0m`);
