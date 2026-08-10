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
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

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
 * One child per suite, output inherited, and a stop at the first non-zero — the same
 * semantics `&&` gave, kept deliberately: a suite that fails usually invalidates the
 * ones after it, and thirty screens of consequential failures bury the one that matters.
 */
for (const [i, suite] of suites.entries()) {
  console.log(`\x1b[2m── [${i + 1}/${suites.length}] ${suite}\x1b[0m`);
  const run = spawnSync(process.execPath, [path.join(ROOT, suite)], {
    cwd: ROOT,
    stdio: 'inherit',
  });
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

console.log(`\n\x1b[32mall ${suites.length} suites passed\x1b[0m\n`);
