#!/usr/bin/env node
//
// b7e-suite — a handful of named suites, in one call the worktree guard will allow
// (bc-khoe.30.17).
//
//   npm test
//   node test/suite.mjs
//
// lib/suite.js does the name resolution; lib/gate.js (already proven by test/gate.mjs)
// does the actual running. This drives resolveName/resolveNames directly against
// fabricated suite lists — no reason to spawn a child for pure string matching — and a
// handful of calls through the real bin/b7e-suite binary against fabricated trees cover
// what only the CLI does: argv parsing, --all, the lock, MISSING before anything runs,
// and the exit code.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTreeSync } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const BIN = path.join(ROOT, 'bin', 'b7e-suite');

const suiteLib = await import(path.join(ROOT, 'lib', 'suite.js'));
const { resolveName, resolveNames } = suiteLib;
const gate = await import(path.join(ROOT, 'lib', 'gate.js'));

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

const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-suite-test-'));

/** A fresh `<tmp>/<name>/test/` directory holding the given files, same shape test/gate.mjs uses. */
const tree = (name, files) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
};
const alwaysPass = () => 'process.exit(0);\n';
const alwaysFail = (msg = 'broken') => `console.log('FAIL ${msg}');\nprocess.exit(1);\n`;
/** Strips ANSI color codes, so an assertion doesn't have to thread an escape sequence through a match. */
const plain = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/* ===================================================================== *
 * 1. resolveName — one name against a suite list
 * ===================================================================== */

console.log('\nresolveName turns what a session types into a real suite path\n');

const SUITES = ['test/lockfile.mjs', 'scripts/selftest.mjs', 'test/panes.mjs', 'test/releases.mjs', 'scripts/test-swap.js'];

check('an exact path resolves to itself', () => {
  assert.deepEqual(resolveName('test/panes.mjs', SUITES), { suites: ['test/panes.mjs'], missing: false });
});
check('a bare name with no extension resolves by stem, not just basename', () => {
  assert.deepEqual(resolveName('panes', SUITES), { suites: ['test/panes.mjs'], missing: false });
});
check('a bare name resolves against a suite outside test/ the same way', () => {
  assert.deepEqual(resolveName('selftest', SUITES), { suites: ['scripts/selftest.mjs'], missing: false });
});
check('a bare name resolves even when the real file ends in .js, not .mjs', () => {
  assert.deepEqual(resolveName('test-swap', SUITES), { suites: ['scripts/test-swap.js'], missing: false });
});
check('a bare filename with its own extension is matched by basename', () => {
  assert.deepEqual(resolveName('panes.mjs', SUITES), { suites: ['test/panes.mjs'], missing: false });
});
check('a name with no match anywhere in the tree is missing, not guessed at', () => {
  const r = resolveName('nosuchsuite', SUITES);
  assert.equal(r.missing, true);
  assert.deepEqual(r.suites, []);
  assert.match(r.reason, /no suite named nosuchsuite/);
});
check('a stem matching two suites is missing, and says which two', () => {
  const dup = ['test/a/foo.mjs', 'test/b/foo.mjs'];
  const r = resolveName('foo', dup);
  assert.equal(r.missing, true);
  assert.match(r.reason, /ambiguous/);
  assert.match(r.reason, /test\/a\/foo\.mjs/);
  assert.match(r.reason, /test\/b\/foo\.mjs/);
});
check('a glob with * matches every suite it covers', () => {
  const r = resolveName('test/*.mjs', SUITES);
  assert.equal(r.missing, false);
  assert.deepEqual(r.suites, ['test/lockfile.mjs', 'test/panes.mjs', 'test/releases.mjs']);
});
check('a glob matching nothing is missing, and says so as a glob', () => {
  const r = resolveName('test/nope*.mjs', SUITES);
  assert.equal(r.missing, true);
  assert.match(r.reason, /no suite matches/);
});
check('a glob is never mistaken for a regex — a literal . still only matches a literal .', () => {
  // 'test/panesXmjs' must NOT match 'test/panes.mjs' even though '.' is a regex wildcard —
  // globToRegExp escapes it. This is the same guarantee bin/b7e-gate --only relies on.
  const r = resolveName('test/panesXmjs', SUITES);
  assert.equal(r.missing, true);
});

/* ===================================================================== *
 * 2. resolveNames — a whole argv, in order, deduped, missing reported together
 * ===================================================================== */

console.log('\nresolveNames — a whole argv at once\n');

check('every name resolves, in the order given', () => {
  assert.deepEqual(resolveNames(['panes', 'releases'], SUITES), {
    resolved: ['test/panes.mjs', 'test/releases.mjs'],
    missing: [],
  });
});
check('the same suite named twice, two different ways, is deduped once', () => {
  assert.deepEqual(resolveNames(['panes', 'test/panes.mjs'], SUITES), {
    resolved: ['test/panes.mjs'],
    missing: [],
  });
});
check('a mix of good and missing names reports every missing one, and still resolves the rest', () => {
  const r = resolveNames(['panes', 'nosuchsuite', 'releases', 'alsomissing'], SUITES);
  assert.deepEqual(r.resolved, ['test/panes.mjs', 'test/releases.mjs']);
  assert.equal(r.missing.length, 2);
  assert.equal(r.missing[0].input, 'nosuchsuite');
  assert.equal(r.missing[1].input, 'alsomissing');
});
check('an empty argv resolves to nothing, cleanly', () => {
  assert.deepEqual(resolveNames([], SUITES), { resolved: [], missing: [] });
});

/* ===================================================================== *
 * 3. the CLI — argv parsing, --all, the lock, MISSING before anything runs
 * ===================================================================== */

console.log('\nthe CLI\n');

check('--help prints usage and exits 0 without running anything', () => {
  const run = spawnSync(process.execPath, [BIN, '--help'], { encoding: 'utf8' });
  assert.equal(run.status, 0);
  assert.match(run.stdout, /b7e-suite/);
});

check('with nothing given and no --all, it refuses with exit code 2', () => {
  const run = spawnSync(process.execPath, [BIN], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /no suite names given/);
});

{
  const dir = tree('cli-mixed', {
    'test/broken.mjs': alwaysFail('cli broken'),
    'test/wasfine.mjs': alwaysPass(),
  });

  check('a misspelled name is reported as MISSING before any suite starts, not a module-not-found stack', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'wasfine', 'ghostname'], { encoding: 'utf8' });
    assert.equal(run.status, 2);
    assert.match(run.stdout, /MISSING ghostname/);
    // The one real suite must never have run — nothing about a bad name should start work.
    assert.doesNotMatch(run.stdout, /wasfine/);
    assert.doesNotMatch(run.stdout + run.stderr, /MODULE_NOT_FOUND/);
  });

  check('bare names run the real suites and a real failure exits non-zero', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'broken', 'wasfine'], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(plain(run.stdout), /FAIL test\/broken\.mjs/);
    assert.match(plain(run.stdout), /ok test\/wasfine\.mjs/);
  });

  check('a clean set of suites exits 0', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'wasfine'], { encoding: 'utf8' });
    assert.equal(run.status, 0);
    assert.match(plain(run.stdout), /all 1 suite passed/);
  });

  check('--all reaches the same verdict as npm test on a clean tree, continuing past the first red', () => {
    const run = spawnSync(process.execPath, [BIN, '--dir', dir, '--all'], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'one of the two fixture suites is broken, so --all must fail too');
    assert.match(plain(run.stdout), /FAIL test\/broken\.mjs/);
    assert.match(plain(run.stdout), /ok test\/wasfine\.mjs/, '--all must not stop at the first red — the second suite still ran');
  });
}

await checkAsync('a second invocation on a tree already locked by a gate is refused, not queued', async () => {
  const dir = tree('locked', { 'test/slow.mjs': 'await new Promise((r) => setTimeout(r, 3000));\nprocess.exit(0);\n' });
  const first = spawn(process.execPath, [BIN, '--dir', dir, 'slow'], { stdio: 'ignore' });
  try {
    // A head start so `first` reaches acquireLock() before a probe races it for the same
    // lock — acquireLock is near the top of the CLI, well before the 3s fixture suite
    // even starts, so this only has to outrun process spawn overhead, not the suite.
    await new Promise((r) => setTimeout(r, 500));
    const deadline = Date.now() + 2000;
    let locked = false;
    while (Date.now() < deadline) {
      const probe = spawnSync(process.execPath, [BIN, '--dir', dir, 'slow'], { encoding: 'utf8' });
      if (probe.status === 2 && /already running/.test(probe.stderr)) {
        locked = true;
        break;
      }
    }
    assert.equal(locked, true, 'expected a concurrent invocation on the same tree to be refused with exit code 2');
  } finally {
    first.kill('SIGKILL');
  }
});

/*
 * And the lock file is gone afterwards — bc-dgx7.40, the same pair `test/gate.mjs` holds
 * still for `bin/b7e-gate`.
 *
 * `onExit` hands back a *disarm*, not a release: it marks the job done and splices it out,
 * and never runs `fn`. Calling only that leaves `beadcause-gate-<hash>.lock` in the OS temp
 * dir for ever, one permanent file per tree that has ever run — and nothing notices,
 * because `acquireLock` reads a lock whose pid is dead as stale and reclaims it, so the
 * next run on that tree works every time. So this is checked against the real CLI, on both
 * of its exit arms: the unit is fine and always was, and it is the binary's two-call shape
 * that is the thing to hold still. MISSING is the arm b7e-gate does not have — it releases
 * and leaves before `runGate` is ever reached, which is its own release site.
 *
 * The lock path is learned by taking and immediately releasing the lock ourselves, which is
 * the same `lockPathFor(root)` the CLI will compute — `lockPathFor` is not exported.
 */
const lockPathOf = (dir) => {
  const probe = gate.acquireLock(dir);
  assert.equal(probe.ok, true, 'the probe acquire should not be refused on a fresh tree');
  probe.release();
  return probe.lockPath;
};

check('a clean run removes its own lock file rather than leaving it to be reclaimed as stale', () => {
  const dir = tree('cli-lock-clean', { 'test/wasfine.mjs': alwaysPass() });
  const lockPath = lockPathOf(dir);
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'wasfine'], { encoding: 'utf8' });
  assert.equal(run.status, 0, `expected a clean exit, got ${run.status}: ${run.stderr}`);
  assert.equal(fs.existsSync(lockPath), false, `a clean run left ${lockPath} behind`);
});

check('a MISSING name releases the lock too — it leaves before runGate, on its own release site', () => {
  const dir = tree('cli-lock-missing', { 'test/wasfine.mjs': alwaysPass() });
  const lockPath = lockPathOf(dir);
  const run = spawnSync(process.execPath, [BIN, '--dir', dir, 'ghostname'], { encoding: 'utf8' });
  assert.equal(run.status, 2, `expected the MISSING exit code 2, got ${run.status}: ${run.stderr}`);
  assert.equal(fs.existsSync(lockPath), false, `a MISSING run left ${lockPath} behind`);
});

/* --------------------------------------------------------------------- */

removeTreeSync(tmp);

console.log(failures ? `\n${failures} check(s) failed\n` : '\nall suite checks passed\n');
process.exit(failures ? 1 : 0);
