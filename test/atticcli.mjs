#!/usr/bin/env node
/**
 * The attic sweep a *human* runs — lib/attic.js and bin/attic.js.
 *
 *     npm test
 *     node test/atticcli.mjs
 *
 * `test/attic.mjs` covers the gates, in `expireRetired`. This file covers the layer the
 * `ship` skill calls: strays, the report, `--backfill`, and the exit codes. They are
 * separate files because they are separate claims — one is "the attic empties, and only
 * of what it should", the other is "the person reading the output is told the truth".
 *
 * Which is the whole reason any of this is in the repo. The sweep was 210 lines of bash
 * in `~/.claude-personal/skills/ship/`, versioned by nothing and tested by nothing, run
 * by every ship. bc-bcdp is what that cost: one line of it inverted its own answer —
 * `git worktree list --porcelain | grep -qx "worktree $dir"` under `set -o pipefail`,
 * where `grep -q` exits at the first match, git dies of SIGPIPE still walking the rest,
 * and pipefail reports the *successful* match as a failure — so 68 of 85 perfectly
 * healthy attic entries were reported as unregistered strays, with the count moving run
 * to run. A session read that output, believed it, and filed a bug describing a hand-`mv`
 * that never happened and a name collision that did not exist. Nothing stood between the
 * script and its reader.
 *
 * So the thing asserted hardest here is that a healthy attic reports **zero** strays,
 * stably, over repeated runs — and that a real stray is still named, and still not
 * deleted. The rest is the report and the exit codes, because a ship reads both.
 *
 * Real `git` in a temp directory throughout: `git worktree` semantics are the subject,
 * and a fake would agree with whatever the code assumed. No network — `--no-pr`
 * everywhere, so nothing here shells out to `gh`.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const { sweepAttic, describeAttic, worthSaying } = await import(path.join(ROOT, 'lib', 'attic.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-atticcli-'));

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
/** Whole seconds, which is the shape `ship` step 8's `date -u +%FT%TZ` writes. */
const daysAgo = (days) => new Date(Date.now() - days * DAY).toISOString().replace(/\.\d+Z$/, 'Z');

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
 * why it was retired in the first place.
 */
function retire(main, name, { stamp = daysAgo(5), note = true } = {}) {
  const dir = path.join(atticOf(main), name);
  git(main, 'worktree', 'add', '-q', '-b', `worktree-${name}`, dir, 'HEAD');
  if (note) fs.writeFileSync(`${dir}.note`, `${stamp}  retired by beadcause after abc1234\n`);
  return dir;
}

const NO_PR = { prMerges: false };
const names = (list) => list.map((e) => e.name).sort();
const why = (list, name) => (list.find((e) => e.name === name) || {}).why || '';

/* ------------------------------------------------------- strays: bc-bcdp itself */

console.log('strays — the false bug report');

await check('a healthy attic reports zero strays, and says so the same way every run', async () => {
  const healthy = makeRepo('healthy');
  for (let n = 1; n <= 8; n++) retire(healthy, `entry-${n}`, { stamp: daysAgo(0.1) });
  // Five runs, because the bug this replaces raced: its count moved run to run with how
  // far git had got before the pipe closed, so "0 once" would not have caught it.
  for (let run = 0; run < 5; run++) {
    const r = await sweepAttic(healthy, NO_PR);
    assert.deepEqual(r.strays, [], `run ${run + 1} invented strays: ${JSON.stringify(r.strays)}`);
    assert.equal(r.young.length, 8, `run ${run + 1} lost entries`);
  }
});

const attic = makeRepo('attic');
retire(attic, 'ripe');
retire(attic, 'young', { stamp: daysAgo(0.5) });
retire(attic, 'no-note', { note: false });
// A directory somebody put there by hand, registered by nothing.
fs.mkdirSync(path.join(atticOf(attic), 'hand-moved'), { recursive: true });
// A note whose directory is already gone.
fs.writeFileSync(path.join(atticOf(attic), 'vanished.note'), `${daysAgo(9)}  retired\n`);

const dry = await sweepAttic(attic, { ...NO_PR, dryRun: true });

await check('a directory nobody registered is reported by name', () => {
  assert.match(why(dry.strays, 'hand-moved'), /not a registered worktree/);
});

await check('an orphan .note is reported as one', () => {
  assert.match(why(dry.strays, 'vanished.note'), /orphan .note/);
});

await check('and neither is ever deleted — guessing is how you lose work', async () => {
  await sweepAttic(attic, NO_PR);
  assert.ok(fs.existsSync(path.join(atticOf(attic), 'hand-moved')), 'a stray directory must survive');
  assert.ok(fs.existsSync(path.join(atticOf(attic), 'vanished.note')), 'an orphan note must survive');
});

await check('a just-removed entry is not then reported as a stray', async () => {
  // The listing is re-read after the removals for exactly this reason: taken before
  // them, every entry the sweep had just taken would look unregistered.
  const fresh = makeRepo('not-stray');
  retire(fresh, 'gone');
  const r = await sweepAttic(fresh, NO_PR);
  assert.deepEqual(names(r.removed), ['gone']);
  assert.deepEqual(r.strays, [], JSON.stringify(r.strays));
});

/* ---------------------------------------------------------------- the report */

console.log('\nthe report, which is the part a human reads');

await check('the young are a count, not a row each', () => {
  assert.deepEqual(names(dry.young), ['young']);
  assert.ok(!names(dry.skipped).includes('young'), 'young is the normal case, not an exception');
  assert.match(describeAttic(dry).join('\n'), /\(young\)\s+1 entry under the 2d line/);
});

await check('one summary line, and a row for every exception', () => {
  const text = describeAttic(dry).join('\n');
  assert.match(text, /^attic sweep \(>2d\): would remove 1, kept 2/m);
  assert.match(text, /would remove\s+ripe\s+5\.0d\s+would remove \(worktree-ripe\)/);
  assert.match(text, /SKIPPED\s+no-note/);
  assert.match(text, /STRAY\s+hand-moved/);
  assert.match(text, /STRAY\s+vanished\.note/);
});

await check('a real run says removed where a dry run said would-remove', async () => {
  const real = makeRepo('real');
  retire(real, 'ripe');
  const text = describeAttic(await sweepAttic(real, NO_PR)).join('\n');
  assert.match(text, /attic sweep \(>2d\): removed 1, kept 0/);
  assert.match(text, /removed\s+ripe\s+5\.0d\s+removed \(worktree-ripe kept\)/);
  assert.ok(!/would remove/.test(text), text);
});

await check('a sweep with nothing to say can be silent, and still counts what it kept', async () => {
  const quiet = makeRepo('quiet');
  retire(quiet, 'not-yet', { stamp: daysAgo(0.2) });
  const r = await sweepAttic(quiet, NO_PR);
  assert.equal(worthSaying(r), false, 'a zero-removal run is the normal, correct result');
  assert.match(describeAttic(r).join('\n'), /kept 1/, 'silence is the caller’s choice, not the report’s');
});

/* ---------------------------------------------------------------- backfill */

console.log('\n--backfill, for entries older than the convention');

await check('a stamp is written from directory mtime, and the entry becomes sweepable', async () => {
  const old = makeRepo('backfill');
  const dir = retire(old, 'ancient', { note: false });
  const long = new Date(Date.now() - 9 * DAY);
  fs.utimesSync(dir, long, long);

  const before = await sweepAttic(old, { ...NO_PR, dryRun: true });
  assert.match(why(before.skipped, 'ancient'), /no \.note/);

  // A dry run proposes and writes nothing — the bash version it replaces backfilled for
  // real under --dry-run, which is a dry run with a side effect.
  const proposed = await sweepAttic(old, { ...NO_PR, dryRun: true, backfill: true });
  assert.deepEqual(names(proposed.backfilled), ['ancient']);
  assert.ok(!fs.existsSync(`${dir}.note`), 'a dry run must not leave a note behind');
  assert.match(describeAttic(proposed).join('\n'), /would backfill 1 note/);

  const filled = await sweepAttic(old, { ...NO_PR, backfill: true });
  assert.deepEqual(names(filled.removed), ['ancient'], 'a backfilled stamp is a stamp');
  assert.ok(!fs.existsSync(dir), 'and the entry it just stamped is old enough to go');
  assert.ok(!fs.existsSync(`${dir}.note`), 'note and directory go together');
});

await check('mtime is a late proxy, so a backfill can only ever keep something longer', async () => {
  const fresh = makeRepo('backfill-fresh');
  retire(fresh, 'touched-today', { note: false });
  const r = await sweepAttic(fresh, { ...NO_PR, backfill: true });
  // The directory was created just now, so its mtime says "young" even if it was
  // retired a week ago — which is the safe direction to be wrong in.
  assert.deepEqual(r.removed, []);
  assert.deepEqual(names(r.young), ['touched-today']);
});

/* ---------------------------------------------------------------- scope */

console.log('\nwhat it will not touch');

await check('nothing outside the attic, including live worktrees and the main checkout', async () => {
  const repo = makeRepo('scope');
  fs.mkdirSync(path.join(repo, '.claude', 'worktrees'), { recursive: true });
  const live = path.join(repo, '.claude', 'worktrees', 'in-use');
  git(repo, 'worktree', 'add', '-q', '-b', 'worktree-in-use', live, 'HEAD');
  fs.writeFileSync(`${live}.note`, `${daysAgo(9)}  not retired at all\n`);
  retire(repo, 'in-attic');

  const r = await sweepAttic(repo, NO_PR);
  assert.deepEqual(names(r.removed), ['in-attic'], 'only the attic is swept');
  assert.ok(fs.existsSync(live), 'a live worktree is not the attic sweep’s business');
  assert.ok(fs.existsSync(path.join(repo, 'file.txt')), 'and neither is the main checkout');
});

await check('a repo with no attic at all is a no-op, not a failure', async () => {
  const repo = makeRepo('no-attic');
  fs.rmSync(atticOf(repo), { recursive: true, force: true });
  const r = await sweepAttic(repo, NO_PR);
  assert.equal(r.ran, false);
  assert.deepEqual(r.removed, []);
  assert.match(describeAttic(r).join('\n'), /nothing to do/);
});

await check('--days 0 keeps everything, which is what the daemon means by it too', async () => {
  const repo = makeRepo('keep-all');
  retire(repo, 'ancient', { stamp: daysAgo(90) });
  const r = await sweepAttic(repo, { ...NO_PR, days: 0 });
  assert.deepEqual(r.removed, []);
  assert.ok(fs.existsSync(path.join(atticOf(repo), 'ancient')));
});

await check('it refuses to run from a worktree, rather than removing the tree it stands in', async () => {
  const repo = makeRepo('from-worktree');
  const dir = retire(repo, 'somewhere');
  await assert.rejects(() => sweepAttic(dir, NO_PR), /is a worktree, not the main checkout/);
});

await check('and refuses a directory that is not a repo', async () => {
  const plain = path.join(tmp, 'not-a-repo');
  fs.mkdirSync(plain, { recursive: true });
  await assert.rejects(() => sweepAttic(plain, NO_PR), /not a git repo/);
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
  const r = cli([path.join(tmp, 'attic'), '--dry-run', '--no-pr']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /attic sweep/);
  assert.match(r.out, /SKIPPED/, 'a ship must not fail because the attic held something it could not remove');
  assert.match(r.out, /STRAY/);
});

await check('--quiet on a boring attic prints nothing at all', () => {
  const r = cli([path.join(tmp, 'quiet'), '--quiet', '--no-pr']);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.out.trim(), '', r.out);
});

await check('no arguments, a bad flag, a bad --days and a worktree are all exit 2', () => {
  assert.equal(cli([]).code, 2);
  assert.equal(cli([path.join(tmp, 'attic'), '--wat']).code, 2);
  assert.equal(cli([path.join(tmp, 'attic'), '--days', 'soon']).code, 2);
  assert.equal(cli([path.join(tmp, 'attic'), path.join(tmp, 'quiet')]).code, 2, 'two checkouts is a typo, not a batch');
  const wt = cli([path.join(tmp, 'attic', '.claude', 'worktrees-retired', 'young')]);
  assert.equal(wt.code, 2);
  assert.match(wt.err, /worktree, not the main checkout/);
});

await check('--days takes a fraction, which is the only honest way to test an expiry', () => {
  const r = cli([path.join(tmp, 'quiet'), '--days=0.1', '--dry-run', '--no-pr']);
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
