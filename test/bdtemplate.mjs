#!/usr/bin/env node
/**
 * test/helpers/bdtemplate.mjs, against the real `bd` — the nine suites that use it
 * trust three claims about it, and this is where each one is actually checked rather
 * than assumed.
 *
 *     npm test
 *     node test/bdtemplate.mjs
 *
 *  1. **A copy is independent.** Writing into one materialized workspace must never be
 *     visible from the template it came from, or from a second, sibling copy of the
 *     same template. This is the property every suite that used to run its own fresh
 *     `bd init` already had for free — bc-xlz32.3 is not allowed to spend it.
 *  2. **Concurrent callers build the template once, not once each.** Nine suites can
 *     ask for the same prefix at close to the same moment; only one of them should ever
 *     pay for a real `bd init`, and the rest should get back a workspace, not a race.
 *  3. **The key includes the `bd` version.** A template built by one version must never
 *     be handed to a caller that asked under a different one — that is the whole reason
 *     the cache is keyed the way it is, and it is the one property a passing suite that
 *     never upgrades `bd` would never notice was missing.
 *
 * Skipped loudly where `bd` is not installed, exactly as the suites this exists for do
 * — a machine without the tracker cannot answer any of the three questions above.
 *
 * Its own cache lives under `BEADCAUSE_BD_TEMPLATE_DIR`, pointed at a scratch directory
 * for the whole file, never at a real machine's `~/.cache/beadcause-bd-template` —
 * this suite builds and tears down templates, and a real cache is shared with whatever
 * else on the machine is relying on it staying put.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTree } from './helpers/tmp.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HELPER = path.join(HERE, 'helpers', 'bdtemplate.mjs');

console.log('\nthe shared bd template cache, against the real bd\n');

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
  if (detail) console.log(`      ${String(detail).split('\n').slice(0, 6).join('\n      ')}`);
};
const check = (name, fn) => {
  try {
    fn();
    ok(name);
  } catch (err) {
    bad(name, err.message);
  }
};

const bdOnPath = !spawnSync('bd', ['version'], { encoding: 'utf8' }).error;
if (!bdOnPath) {
  console.log('  \x1b[33m—\x1b[0m skipped: no `bd` on PATH, so what the cache hands back cannot be asked here');
  console.log('\n0/0 passed\n');
  process.exit(0);
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-bdtemplate-'));
const cacheDir = path.join(scratch, 'cache');
// Set on `process.env` itself, not just handed to children: the in-process calls below
// (`await import(HELPER)`) read `process.env.BEADCAUSE_BD_TEMPLATE_DIR` directly, and
// without this they would build against — and pollute — the real machine-wide cache
// every other suite and gate run shares, rather than this file's own scratch one.
process.env.BEADCAUSE_BD_TEMPLATE_DIR = cacheDir;
const env = { ...process.env, BEADCAUSE_BD_TEMPLATE_DIR: cacheDir };

const bdList = (dir) => {
  const r = spawnSync('bd', ['list', '--json'], {
    cwd: dir,
    env: { ...process.env, BEADS_DIR: path.join(dir, '.beads') },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`bd list in ${dir}: ${(r.stderr || r.stdout || '').trim()}`);
  return JSON.parse(r.stdout || '[]');
};
const bdCreate = (dir, title) => {
  const r = spawnSync('bd', ['create', '--title', title, '--description', 'x'], {
    cwd: dir,
    env: { ...process.env, BEADS_DIR: path.join(dir, '.beads') },
    encoding: 'utf8',
    timeout: 30_000,
  });
  if (r.status !== 0) throw new Error(`bd create in ${dir}: ${(r.stderr || r.stdout || '').trim()}`);
};

/* ------------------------------------------------------------ 1. independence */

{
  const mod = await import(HELPER);
  const wsA = path.join(scratch, 'independence-a');
  const wsB = path.join(scratch, 'independence-b');
  const rA = mod.provisionBdWorkspace({ prefix: 'ta', destRoot: wsA, timeout: 60_000 });
  const rB = mod.provisionBdWorkspace({ prefix: 'ta', destRoot: wsB, timeout: 60_000 });

  check('both copies provision cleanly', () => {
    assert.equal(rA.ok, true, rA.reason);
    assert.equal(rB.ok, true, rB.reason);
  });

  check('a write in one copy is invisible in a sibling copy of the same template', () => {
    bdCreate(wsA, 'only in A');
    assert.equal(bdList(wsA).length, 1, 'A should see its own bead');
    assert.equal(bdList(wsB).length, 0, 'B saw a bead nobody wrote into it');
  });

  check('a copy is a private directory .beads sets 0700, not the process umask', () => {
    const mode = fs.statSync(path.join(wsB, '.beads')).mode & 0o777;
    assert.equal(mode, 0o700, `.beads was 0${mode.toString(8)}, a real bd init warns below 0700`);
  });

  const templateDir = mod.ensureBdTemplate({ prefix: 'ta', timeout: 60_000 }).dir;
  check('the template itself is untouched by either copy writing', () => {
    assert.equal(bdList(templateDir).length, 0, 'the template gained a bead a copy wrote');
  });
}

/* ------------------------------------------------ 2. one build, several waiters */

{
  const raceDir = path.join(scratch, 'race');
  const dests = ['r1', 'r2', 'r3'].map((n) => path.join(raceDir, n));
  const runner = path.join(raceDir, 'runner.mjs');
  fs.mkdirSync(raceDir, { recursive: true });
  fs.writeFileSync(
    runner,
    [
      `import { provisionBdWorkspace } from ${JSON.stringify(HELPER)};`,
      `const r = provisionBdWorkspace({ prefix: 'race', destRoot: process.argv[2], timeout: 60_000 });`,
      `process.stdout.write(JSON.stringify(r));`,
    ].join('\n')
  );
  const started = Date.now();
  const runs = await Promise.all(
    dests.map(
      (dest) =>
        new Promise((resolve) => {
          const child = fork(runner, [dest], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
          let out = '';
          child.stdout.on('data', (d) => (out += d));
          child.on('exit', () => resolve(out.trim()));
        })
    )
  );
  const took = Date.now() - started;
  const results = runs.map((r) => JSON.parse(r));

  check('three concurrent callers for the same prefix all get a workspace', () => {
    for (const r of results) assert.equal(r.ok, true, r.reason);
  });

  check('three concurrent callers do not each pay for a fresh bd init', () => {
    // A serial run of three real `bd init`s is tens of seconds; one build plus two
    // waiters queued behind its lock is one build's worth of wall clock. 20s gives a
    // loaded Mac room without letting a genuine "built three times" past it.
    assert.ok(took < 20_000, `took ${took}ms — reads like the lock let more than one build run`);
  });

  check('the three destinations are independent copies, not one workspace three ways', () => {
    bdCreate(dests[0], 'only in r1');
    assert.equal(bdList(dests[0]).length, 1);
    assert.equal(bdList(dests[1]).length, 0);
    assert.equal(bdList(dests[2]).length, 0);
  });
}

/* ------------------------------------------------------- 3. keyed on bd version */

{
  const mod = await import(HELPER);
  const built = mod.ensureBdTemplate({ prefix: 'tv', timeout: 60_000 });
  check('a template builds under the real bd version', () => {
    assert.equal(built.ok, true, built.reason);
  });

  // A fake `bd` on PATH that answers a DIFFERENT version than the real one, so the
  // template it would need does not exist yet — proving the cache is actually keyed on
  // the string rather than always resolving to the one real binary's directory.
  const fakeBinDir = path.join(scratch, 'fakebd');
  fs.mkdirSync(fakeBinDir, { recursive: true });
  const fakeBd = path.join(fakeBinDir, 'bd');
  fs.writeFileSync(
    fakeBd,
    [
      '#!/bin/sh',
      'if [ "$1" = version ]; then echo "bd version 999.999.999 (fake)"; exit 0; fi',
      // `command -v` searches the real PATH, not this script's own directory, so it
      // finds the actual binary regardless of where bd lives on this machine.
      'exec "$(command -v bd)" "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );

  check('a different bd version needs a template of its own — no stale reuse', () => {
    const before = fs.existsSync(path.join(mod.templateCacheRoot(), 'bd-version-999.999.999-fake-'));
    assert.equal(before, false, 'a template for the fake version already existed before it was ever asked for');
    const r = mod.ensureBdTemplate({ prefix: 'tv', bdBin: fakeBd, timeout: 60_000 });
    assert.equal(r.ok, true, r.reason);
    assert.notEqual(r.dir, built.dir, 'the fake-version template reused the real bd version\'s directory');
  });
}

console.log(`\n${ran - failures}/${ran} passed\n`);
await removeTree(scratch);
process.exit(failures ? 1 : 0);
