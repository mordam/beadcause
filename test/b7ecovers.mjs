#!/usr/bin/env node
//
// b7e-covers — which of a workspace repo's own gate scripts actually read a given
// file, before you decide what to run (bc-dgx7.126).
//
//   npm test
//   node test/b7ecovers.mjs
//
// lib/covers.js is driven directly in test/covers.mjs; this covers what only the CLI
// does — argv parsing, exit codes, the all-or-nothing stdout rule, --why, --json,
// --refresh, and the default-to-git-diff behaviour — against fabricated trees.
//
// python3 is assumed present, the same assumption every sibling gate-tooling suite
// in this repo makes.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-covers');
const CHECKS_BIN = path.join(ROOT, 'bin', 'b7e-checks');

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-b7ecovers-test-'));
const cfgDir = path.join(tmp, '.config-beadcause');
fs.mkdirSync(cfgDir, { recursive: true });
const ENV = { ...process.env, BEADCAUSE_CONFIG_DIR: cfgDir };

const tree = (name, files) => {
  const dir = path.join(tmp, name);
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};

const run = (args) => spawnSync(process.execPath, [BIN, ...args], { encoding: 'utf8', env: ENV });

const plain = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/* ===================================================================== *
 * 1. usage and refusals
 * ===================================================================== */

console.log('\nusage and refusals\n');

check('--help prints usage and exits 0', () => {
  const r = run(['--help']);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /usage: b7e-covers/);
});

check('neither -w nor --dir is refused with exit 2', () => {
  const r = run([]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /one of -w\/--workspace or --dir is required/);
});

check('both -w and --dir together is refused with exit 2', () => {
  const r = run(['-w', 'x', '--dir', tmp]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /mutually exclusive/);
});

check('an unrecognised workspace name is refused with exit 2', () => {
  const r = run(['-w', 'nope-does-not-exist']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no workspace named/);
});

check('--dir against a tree with no scripts/check_*.py is refused with exit 2', () => {
  const dir = tree('cli-nomanifest', {});
  const r = run(['--dir', dir]);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /no manifest recognises/);
});

check('an unrecognised flag is refused with exit 2', () => {
  const dir = tree('cli-badflag', { 'scripts/check_a.py': 'pass\n' });
  const r = run(['--dir', dir, '--bogus']);
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unrecognised flag/);
});

/* ===================================================================== *
 * 2. plain mode — the pipe into b7e-checks --only
 * ===================================================================== */

console.log('\nplain mode\n');

const interludeTree = () =>
  tree('cli-interlude', {
    'scripts/check_saga_audit.py': `
import os
files = os.listdir(os.path.join("novel", "Book3"))
inventory = {"Book3": 1}
count = len([f for f in files if f.startswith("INTERLUDE")])
if count != inventory["Book3"]:
    raise SystemExit(1)
`,
    'scripts/check_entry069_species_naming.py': `
import os
with open(os.path.join("novel", "Book3", "INTERLUDE_034.summary.md")) as f:
    f.read()
`,
    'novel/Book3/INTERLUDE_034.summary.md': 'existing',
  });

check('a path covered only by a directory walk prints that gate\'s name, exit 0', () => {
  const dir = interludeTree();
  const r = run(['--dir', dir, 'novel/Book3/INTERLUDE_035.summary.md']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'scripts/check_saga_audit.py');
});

check('a path no gate covers: empty stdout, an explicit unmatched line on stderr, exit 1', () => {
  const dir = interludeTree();
  const r = run(['--dir', dir, 'reference/CHARACTER_CONCURRENCY.md']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
  assert.match(plain(r.stderr), /unmatched — no gate reads reference\/CHARACTER_CONCURRENCY\.md/);
});

check('one matched path plus one unmatched path: stdout is empty for the whole call — all or nothing, like b7e-affected', () => {
  const dir = interludeTree();
  const r = run(['--dir', dir, 'novel/Book3/INTERLUDE_034.summary.md', 'reference/CHARACTER_CONCURRENCY.md']);
  assert.equal(r.status, 1);
  assert.equal(r.stdout, '');
});

check('a query matching two gates prints both names, deduped and one per line', () => {
  const dir = interludeTree();
  const r = run(['--dir', dir, 'novel/Book3/INTERLUDE_034.summary.md']);
  assert.equal(r.status, 0);
  const lines = r.stdout.trim().split('\n').sort();
  assert.deepEqual(lines, ['scripts/check_entry069_species_naming.py', 'scripts/check_saga_audit.py']);
});

/* ===================================================================== *
 * 3. --why and --json
 * ===================================================================== */

console.log('\n--why and --json\n');

check('--why prints the reason per match, and marks an unmatched path rather than staying silent', () => {
  const dir = interludeTree();
  const r = run(['--dir', dir, '--why', 'novel/Book3/INTERLUDE_035.summary.md', 'reference/CHARACTER_CONCURRENCY.md']);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /scripts\/check_saga_audit\.py\twalks its directory — novel\/Book3\/INTERLUDE_035\.summary\.md/);
  assert.match(plain(r.stdout), /unmatched — no gate reads it/);
});

check('--json prints one object per query path, then a summary with names and unmatched', () => {
  const dir = interludeTree();
  const r = run(['--dir', dir, '--json', 'novel/Book3/INTERLUDE_035.summary.md', 'reference/CHARACTER_CONCURRENCY.md']);
  assert.equal(r.status, 1);
  const lines = r.stdout.trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual(lines[0], {
    path: 'novel/Book3/INTERLUDE_035.summary.md',
    matches: [{ name: 'scripts/check_saga_audit.py', reason: 'walks its directory' }],
  });
  assert.deepEqual(lines[1], { path: 'reference/CHARACTER_CONCURRENCY.md', matches: [] });
  assert.equal(lines[2].summary, true);
  assert.deepEqual(lines[2].unmatched, ['reference/CHARACTER_CONCURRENCY.md']);
});

/* ===================================================================== *
 * 4. --refresh and caching, through the CLI
 * ===================================================================== */

console.log('\n--refresh through the CLI\n');

check('a second CLI invocation reuses the cache; --refresh forces a rerun', () => {
  const dir = tree('cli-cache', {
    'scripts/check_a.py': 'import os\nwith open("run-count.txt", "a") as f:\n    f.write("x")\nos.listdir(".")\n',
    'run-count.txt': '',
  });
  run(['--dir', dir, 'run-count.txt']);
  run(['--dir', dir, 'run-count.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'run-count.txt'), 'utf8'), 'x', 'expected the second call to hit the cache');
  run(['--dir', dir, '--refresh', 'run-count.txt']);
  assert.equal(fs.readFileSync(path.join(dir, 'run-count.txt'), 'utf8'), 'xx', 'expected --refresh to force a real rerun');
});

/* ===================================================================== *
 * 5. default: the working tree diff vs the delivery base
 * ===================================================================== */

console.log('\ndefault paths — the working tree diff\n');

const git = (cwd, ...args) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  });

function makeGitRepo(name, files) {
  const work = path.join(tmp, name);
  fs.mkdirSync(work, { recursive: true });
  git(work, 'init', '-q', '-b', 'main');
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(work, rel)), { recursive: true });
    fs.writeFileSync(path.join(work, rel), body);
  }
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'init');
  return work;
}

check('with no path given, an uncommitted change to a covered file is picked up', () => {
  const work = makeGitRepo('cli-default', {
    'scripts/check_a.py': 'import os\nos.listdir("data")\n',
    'data/a.txt': 'one',
  });
  fs.writeFileSync(path.join(work, 'data', 'a.txt'), 'two');
  const r = run(['--dir', work]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), 'scripts/check_a.py');
});

/* ===================================================================== *
 * 6. end to end — pipes straight into b7e-checks --only
 * ===================================================================== */

console.log('\npiping into b7e-checks --only\n');

check('b7e-covers\' stdout, given to b7e-checks --only, runs exactly the matched gate', () => {
  const dir = interludeTree();
  const covered = run(['--dir', dir, 'novel/Book3/INTERLUDE_035.summary.md']);
  assert.equal(covered.status, 0, covered.stderr);
  const name = covered.stdout.trim();
  const only = spawnSync(process.execPath, [CHECKS_BIN, '--dir', dir, '--list', '--only', name], { encoding: 'utf8' });
  assert.equal(only.stdout.trim(), name);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall checks passed\n');
process.exit(failures ? 1 : 0);
