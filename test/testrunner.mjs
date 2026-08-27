#!/usr/bin/env node
/**
 * Adding a suite conflicts with nobody — and `npm test` still runs all of them.
 *
 *     npm test
 *     node test/testrunner.mjs
 *
 * `scripts/test.mjs` was written for a merge property, not a test-running one, so this
 * holds the merge property directly: a real `git merge-tree` of two branches that each
 * add a suite, asserted clean — with the *old* one-line `scripts.test` as the control,
 * asserted to conflict. Without the control the clean case proves nothing (two branches
 * adding two different files were never going to conflict); together they are the before
 * and after of bc-0nea, measured rather than asserted in prose.
 *
 * The rest is what a discovering runner can newly get wrong, and each of these failures
 * is silent — a suite that stops being run says nothing, and neither does a suite that
 * runs after the one whose failure invalidates it:
 *
 * - the delegation is total. `scripts.test` names no suite, because a single suite left
 *   in there is a line every session still has to edit;
 * - every `test/*.mjs` on disk is in the list, plus the two `scripts/` entries that are
 *   not `test/*.mjs` and would be dropped by a naive glob. This is the check that
 *   replaces reading the old chain: the chain used to *be* the inventory, and now the
 *   directory is;
 * - the order that matters is kept — lockfile, then selftest, then the tail, then
 *   test-swap last;
 * - a failure stops the run, propagates its exit code, and does not run what follows;
 * - a passing run leaves nothing behind in `$TMPDIR`, and a failing one leaves exactly
 *   the one directory it says it kept — bc-xl7n.105, which was 234 suites leaking a
 *   scratch directory a day until `TMPDIR` became this runner's to hand out and take
 *   back (bc-5isv). Nothing here pins that it stays that way, which is what this is.
 *
 * Everything below runs against temp trees, so nothing here depends on this repo's own
 * suites passing, and `git` is the only tool assumed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// This suite spawns real runners, and both of them now take a machine-wide gate slot
// (bc-xlz32.1). Under a gate they inherit `BEADCAUSE_GATE_HELD` and skip it; run alone
// while two other gates are live they would queue behind them and time out, so opt out
// here — the semaphore itself is proved in test/gateslots.mjs, against its own directory.
process.env.BEADCAUSE_GATE_SLOTS = '0';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const RUNNER = path.join(ROOT, 'scripts', 'test.mjs');

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-testrunner-'));

/* ------------------------------------------------ the delegation is total */

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

if (pkg.scripts.test === 'node scripts/test.mjs') ok('scripts.test delegates to the runner');
else bad('scripts.test delegates to the runner', `it says ${JSON.stringify(pkg.scripts.test)}`);

/**
 * The point of the bead, stated as narrowly as it can be: not "the line is short" but
 * "the line names nothing that a new suite would have to be added to".
 */
const named = pkg.scripts.test.match(/\btest\/[\w.-]+\.mjs\b/g) || [];
if (!named.length) ok('scripts.test names no suite — a new suite edits no shared line');
else bad('scripts.test names no suite — a new suite edits no shared line', `still names ${named.join(', ')}`);

/* ------------------------------------------------------ the list is the directory */

const list = (args = []) => {
  const run = spawnSync(process.execPath, [RUNNER, '--list', ...args], { encoding: 'utf8' });
  if (run.status !== 0) throw new Error(`--list exited ${run.status}: ${run.stderr}`);
  return run.stdout.trim().split('\n').filter(Boolean);
};

const suites = list();
const onDisk = fs
  .readdirSync(path.join(ROOT, 'test'))
  .filter((f) => f.endsWith('.mjs'))
  .map((f) => `test/${f}`)
  .sort();

const missing = onDisk.filter((f) => !suites.includes(f));
if (!missing.length) ok(`every test/*.mjs is in the list (${onDisk.length})`);
else bad('every test/*.mjs is in the list', `not run: ${missing.join(', ')}`);

/**
 * These two are the reason discovery is a list and not a glob — they do not live in
 * `test/` and do not end in `.mjs` between them, so the shape of the directory says
 * nothing about either.
 */
for (const extra of ['scripts/selftest.mjs', 'scripts/test-swap.js']) {
  if (suites.includes(extra)) ok(`${extra} is in the list`);
  else bad(`${extra} is in the list`, 'a suite outside test/ was dropped');
}

const strays = suites.filter((s) => !onDisk.includes(s) && !s.startsWith('scripts/'));
if (!strays.length) ok('the list holds nothing that is not on disk');
else bad('the list holds nothing that is not on disk', strays.join(', '));

if (suites.length === new Set(suites).size) ok('no suite is listed twice');
else bad('no suite is listed twice', 'a suite would run twice');

/* ------------------------------------------------------------- the order that matters */

const expected = [
  'test/lockfile.mjs',
  'scripts/selftest.mjs',
  ...onDisk.filter((f) => f !== 'test/lockfile.mjs'),
  'scripts/test-swap.js',
];
if (JSON.stringify(suites) === JSON.stringify(expected)) {
  ok('the order is lockfile, selftest, the tail sorted, test-swap last');
} else {
  const at = suites.findIndex((s, i) => s !== expected[i]);
  bad(
    'the order is lockfile, selftest, the tail sorted, test-swap last',
    `first difference at ${at}: expected ${expected[at]}, got ${suites[at]}`,
  );
}

/* ------------------------------------------------- how it behaves on a failure */

/**
 * A temp tree instead of this repo: the semantics under test are "stop at the first
 * failure", and the only honest way to see them is to fail on purpose.
 */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};
/**
 * A private `$TMPDIR` per tree, isolated from the one this process itself runs under —
 * bc-xl7n.105. The real `$TMPDIR` is shared with however many other sessions are on this
 * Mac at once, so a bare listing-diff there is exactly the flaky test that measurement
 * would be; scoping each tree's run to a directory nothing else touches is what makes
 * "did this leave anything behind" answerable without noise.
 */
const tmpdirFor = (dir) => {
  const t = path.join(dir, '.tmpdir');
  fs.mkdirSync(t, { recursive: true });
  return t;
};
const runIn = (dir) =>
  spawnSync(process.execPath, [RUNNER, '--dir', dir], {
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: tmpdirFor(dir) },
  });
/** Top-level `beadcause-*` entries a run's own `$TMPDIR` still holds. */
const leftoverSpools = (dir) => fs.readdirSync(tmpdirFor(dir)).filter((f) => f.startsWith('beadcause-'));

/** Writes a file named after itself, so "did this suite run?" is a question of fact. */
const marker = (name, exit = 0) =>
  `import fs from 'node:fs';\nfs.writeFileSync(new URL('./${name}.ran', import.meta.url), '');\nprocess.exit(${exit});\n`;

const failing = tree('failing', {
  'test/a-pass.mjs': marker('a-pass'),
  'test/b-fail.mjs': marker('b-fail', 3),
  'test/c-pass.mjs': marker('c-pass'),
});
const failedRun = runIn(failing);
const didRun = (dir, name) => fs.existsSync(path.join(dir, 'test', `${name}.ran`));

if (failedRun.status === 3) ok('a failing suite propagates its exit code');
else bad('a failing suite propagates its exit code', `exit was ${failedRun.status}, wanted 3`);

if (didRun(failing, 'a-pass')) ok('the suites before the failure ran');
else bad('the suites before the failure ran', 'a-pass never ran');

if (!didRun(failing, 'c-pass')) ok('the suites after the failure did not run');
else bad('the suites after the failure did not run', 'c-pass ran after b-fail failed');

if (/b-fail\.mjs failed/.test(failedRun.stdout)) ok('the failing suite is named in the output');
else bad('the failing suite is named in the output', failedRun.stdout.trim().split('\n').slice(-3).join(' / '));

/**
 * bc-xl7n.105: a failing suite's own `TMPDIR` scratch is deliberately kept, but nothing
 * else should be — one spool, not one per suite that ran before the failure.
 */
const failingSpools = leftoverSpools(failing);
if (failingSpools.length === 1) ok('a failing run keeps exactly one scratch directory, not one per suite');
else bad('a failing run keeps exactly one scratch directory, not one per suite', `found ${failingSpools.length}: ${failingSpools.join(', ')}`);

if (failingSpools[0] && failedRun.stdout.includes(path.join(tmpdirFor(failing), failingSpools[0])))
  ok('the kept directory is the one the output says it kept');
else bad('the kept directory is the one the output says it kept', failedRun.stdout.trim().split('\n').slice(-2).join(' / '));

const green = tree('green', {
  'test/a-pass.mjs': marker('a-pass'),
  'test/b-pass.mjs': marker('b-pass'),
});
const greenRun = runIn(green);
if (greenRun.status === 0 && didRun(green, 'a-pass') && didRun(green, 'b-pass')) {
  ok('a tree where everything passes exits 0, having run everything');
} else {
  bad('a tree where everything passes exits 0, having run everything', `exit ${greenRun.status}`);
}

/**
 * The point of bc-xl7n.105: a suite that never cleaned up its own scratch is
 * indistinguishable from one that did, because `$TMPDIR` is this runner's for the
 * duration and it removes the whole thing itself once every suite has passed.
 */
const greenSpools = leftoverSpools(green);
if (!greenSpools.length) ok('a passing run adds no net beadcause-* directories to $TMPDIR');
else bad('a passing run adds no net beadcause-* directories to $TMPDIR', `left behind: ${greenSpools.join(', ')}`);

/**
 * FIRST and LAST are filtered by existence rather than assumed: a tree without them is
 * every temp tree above, and a repo that deletes one of them should get a deletion and
 * not a crash on a path that is no longer there.
 */
if (!/lockfile|selftest|test-swap/.test(greenRun.stdout)) ok('a missing FIRST or LAST entry is skipped, not a crash');
else bad('a missing FIRST or LAST entry is skipped, not a crash', 'it tried to run a file that is not there');

const empty = tree('empty', {});
const emptyRun = runIn(empty);
if (emptyRun.status !== 0) ok('a tree with no suites at all fails rather than passing vacuously');
else bad('a tree with no suites at all fails rather than passing vacuously', 'exit 0 on nothing');

/* -------------------------------------------------- the property being bought */

/**
 * The whole bead, in git's own words. Two branches, each adding one suite, merged with
 * `git merge-tree` — which is the same three-way merge GitHub refuses a pull request
 * over, run without touching a working tree.
 */
const mergeConflicts = (name, base, sideA, sideB) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  const git = (...args) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const write = (files) => {
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
  };
  execFileSync('git', ['init', '-q', '-b', 'base', dir], { encoding: 'utf8' });
  write(base);
  git('add', '-A');
  git('commit', '-qm', 'base');
  for (const [branch, files] of [['a', sideA], ['b', sideB]]) {
    git('checkout', '-q', '-b', branch, 'base');
    write(files);
    git('add', '-A');
    git('commit', '-qm', branch);
  }
  const merged = spawnSync('git', ['-C', dir, 'merge-tree', '--write-tree', 'a', 'b'], {
    encoding: 'utf8',
  });
  return merged.status !== 0;
};

const SUITE = 'process.exit(0);\n';

/**
 * The control. Reconstructing the old line from today's suites rather than pasting a
 * frozen copy of it, so this reads as "the shape we left behind", not "a string from
 * August".
 */
const oldLine = `node ${suites.join(' && node ')}`;
const oldPkg = (line) => `${JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, test: line } }, null, 2)}\n`;
const insert = (line, suite) => line.replace(' && node scripts/test-swap.js', ` && node ${suite} && node scripts/test-swap.js`);

const controlConflicts = mergeConflicts(
  'merge-old',
  { 'package.json': oldPkg(oldLine) },
  { 'package.json': oldPkg(insert(oldLine, 'test/alpha.mjs')), 'test/alpha.mjs': SUITE },
  { 'package.json': oldPkg(insert(oldLine, 'test/beta.mjs')), 'test/beta.mjs': SUITE },
);
if (controlConflicts) ok('the control: two suites added to the old one-line chain CONFLICT');
else bad('the control: two suites added to the old one-line chain CONFLICT', 'they merged — this test is measuring nothing');

const nowConflicts = mergeConflicts(
  'merge-new',
  { 'package.json': `${JSON.stringify(pkg, null, 2)}\n`, 'test/existing.mjs': SUITE },
  { 'test/alpha.mjs': SUITE },
  { 'test/beta.mjs': SUITE },
);
if (!nowConflicts) ok('two branches each adding a suite merge cleanly');
else bad('two branches each adding a suite merge cleanly', 'git merge-tree reports a conflict — the point of the change is gone');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
