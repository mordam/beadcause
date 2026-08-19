#!/usr/bin/env node
/**
 * `npm test` — finds its suites instead of being told them.
 *
 *     npm test
 *     node scripts/test.mjs --list        # what would run, in order, without running it
 *     node scripts/test.mjs --dir <root>  # a different tree (this is how it is tested)
 *
 * This exists because of a merge problem, not a test problem. `scripts.test` used to be
 * a single line naming every suite in order, so *adding* a suite meant editing that one
 * line — and with a dozen sessions in flight, every one of them edited the same line.
 * git cannot merge that: two changes to one line is a CONFLICT however far apart the two
 * insertions read. bc-ec6 hit it three times in twenty minutes, on that line and on
 * nothing else in the repo, and each collision cost a downmerge, a resolution and a four
 * minute suite — by which time main had moved again. The cost of resolving was longer
 * than the interval between collisions, so a branch could lose that race indefinitely
 * while every individual step was correct.
 *
 * So adding a suite is now adding a file, which conflicts with nobody, and the
 * "did you remember to wire it into npm test?" review note is gone with it: a file in
 * `test/` runs whether or not its author remembered.
 *
 * ## Order still matters, in two places only
 *
 * Discovery is alphabetical, which is no order at all — and two suites do need to be
 * somewhere specific, so they are named here and only they are:
 *
 * - `test/lockfile.mjs` first, because a lock file that disagrees with package.json
 *   makes every later failure suspect: you cannot trust a suite that may have run
 *   against the wrong dependency tree.
 * - `scripts/selftest.mjs` second — the smoke test. If the daemon cannot start, the
 *   30-odd suites after it will each fail for the same uninteresting reason, and the
 *   first line of output should say so.
 * - `scripts/test-swap.js` last, because it drives a real blue/green swap under load
 *   and is the slowest thing here by an order of magnitude.
 *
 * Everything else is the long tail, where nothing depends on order — and that is exactly
 * where the collisions were. A new suite lands in the middle, sorted, and never touches
 * a line anyone else is holding.
 *
 * FIRST and LAST are filtered by existence rather than assumed, so deleting one of them
 * is a deletion and not a crash; the sorted middle is whatever is on disk. Both halves
 * are asserted against the directory in `test/testrunner.mjs`, which also proves the
 * merge property this file was written for with a real `git merge-tree`.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NO_LAUNCH } from '../lib/launchguard.js';
import { onExit } from '../lib/teardown.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const dirAt = argv.indexOf('--dir');
const ROOT = dirAt === -1 ? path.join(HERE, '..') : path.resolve(argv[dirAt + 1] || '.');

/** The two that have to run before the rest, in this order. */
const FIRST = ['test/lockfile.mjs', 'scripts/selftest.mjs'];
/** The one that has to run after the rest. */
const LAST = ['scripts/test-swap.js'];

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const testDir = path.join(ROOT, 'test');
const discovered = fs.existsSync(testDir)
  ? fs
      .readdirSync(testDir)
      .filter((f) => f.endsWith('.mjs'))
      .sort()
      .map((f) => `test/${f}`)
  : [];

const pinned = new Set([...FIRST, ...LAST]);
const suites = [
  ...FIRST.filter(exists),
  ...discovered.filter((f) => !pinned.has(f)),
  ...LAST.filter(exists),
];

if (listOnly) {
  console.log(suites.join('\n'));
  process.exit(0);
}

if (!suites.length) {
  console.log(`\x1b[31mno suites found under ${testDir}\x1b[0m`);
  process.exit(1);
}

/**
 * A `$TMPDIR` per suite, taken away by *this* process when the suite exits — bc-5isv.
 *
 * 242 files under `test/` and `scripts/` call `mkdtempSync`; 186 of them name a cleanup
 * helper. The gap is not carelessness — it is that a `finally` cannot run on a signal,
 * and a suite that leaks is invisible: the directory goes into a `$TMPDIR` shared with
 * twenty other sessions, where nobody can attribute it and nothing removes it. It reached
 * **13,458 directories and 15 GB on this Mac**, which is the size of the disk it is on.
 *
 * Fixing every call site is a chance per site to get one wrong. Setting `TMPDIR` for the child
 * is one line and cannot be got wrong by a suite at all: `os.tmpdir()` reads the variable
 * on every call, so every `mkdtemp` a suite makes — and every `mkdtemp` made by anything
 * the suite spawns, since the environment is inherited — lands inside a directory this
 * process owns and removes when the child is over. A suite that never cleaned up is now
 * indistinguishable from one that did.
 *
 * Under `$TMPDIR` with a `beadcause-` name rather than somewhere clever, for two reasons.
 * It is where a suite's scratch has always been, so nothing that reads a path is
 * surprised; and if *this* process is the one that gets killed, what it leaves behind is
 * one directory in exactly the shape lib/strays.js sweeps.
 *
 * `--list` never reaches here, so `node scripts/test.mjs --list` still creates nothing.
 */
const spool = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-suites-'));
// The run's own directory goes the same way the suites' do, on every ending including a
// signal. See lib/teardown.js; the plain `rmSync` at the bottom is the ordinary path.
const disarmSpool = onExit(() => {
  try {
    fs.rmSync(spool, { recursive: true, force: true, maxRetries: 1 });
  } catch {
    /* a teardown must never be why a run ends badly */
  }
});

/**
 * One child per suite, output inherited, and a stop at the first non-zero — the same
 * semantics `&&` gave, kept deliberately: a suite that fails usually invalidates the
 * ones after it, and thirty screens of consequential failures bury the one that matters.
 */
for (const [i, suite] of suites.entries()) {
  console.log(`\x1b[2m── [${i + 1}/${suites.length}] ${suite}\x1b[0m`);
  // Named for the suite so a directory still standing after a crash says which one made
  // it, and unique so a suite run twice cannot collide with itself.
  const sandbox = fs.mkdtempSync(path.join(spool, `${path.basename(suite).replace(/\W+/g, '-')}-`));
  const run = spawnSync(process.execPath, [path.join(ROOT, suite)], {
    cwd: ROOT,
    stdio: 'inherit',
    // Layer 2 of the launch guard, and the half that reaches where `argv[1]` cannot: two
    // of the suites below start a real daemon, and a daemon is running `bin/router.js` —
    // nothing about that process looks like a test. Inherited by every child of every
    // child, which is exactly the reach that is wanted. lib/launchguard.js says why.
    env: { ...process.env, [NO_LAUNCH]: '1', TMPDIR: sandbox },
  });
  const broke = run.error || run.signal || run.status !== 0;
  if (!broke) {
    /**
     * Whatever the suite left, gone — and it is this process doing it, which is the point.
     *
     * `force` and `maxRetries` because a suite that spawned a daemon may still have one
     * letting go of a file (the ENOTEMPTY family test/helpers/tmp.mjs exists for), and
     * because a failure here must never change what the run reports: the exit code of a
     * gate says what its assertions said, and a scratch directory that would not go is a
     * few megabytes lib/strays.js will collect tomorrow.
     */
    try {
      fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* left for the stray sweep */
    }
  } else {
    /**
     * A failing suite keeps its scratch, and the run says where it is.
     *
     * This is the one directory anybody ever wants back — the config the suite was
     * working in, the log the daemon it started wrote — and until now it was left in a
     * `$TMPDIR` shared with twenty other sessions under a name nothing recorded, which is
     * why "diff the directory listing before and after" was the only way to find it. The
     * run stops at the first failure, so at most one of these survives a run, and
     * lib/strays.js collects it a day later.
     */
    disarmSpool();
    console.log(`\x1b[2m   scratch kept in ${sandbox}\x1b[0m`);
  }
  if (run.error) {
    console.log(`\n\x1b[31m${suite} could not be started — ${run.error.message}\x1b[0m\n`);
    process.exit(1);
  }
  if (run.signal) {
    console.log(`\n\x1b[31m${suite} was killed by ${run.signal} — stopped at ${i + 1} of ${suites.length}\x1b[0m\n`);
    process.exit(1);
  }
  if (run.status !== 0) {
    console.log(`\n\x1b[31m${suite} failed (exit ${run.status}) — stopped at ${i + 1} of ${suites.length}\x1b[0m\n`);
    process.exit(run.status);
  }
}

disarmSpool();
fs.rmSync(spool, { recursive: true, force: true, maxRetries: 3 });
console.log(`\n\x1b[32mall ${suites.length} suites passed\x1b[0m\n`);
