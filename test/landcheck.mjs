#!/usr/bin/env node
/**
 * `scripts/land-check.mjs`, inside the gate.
 *
 *     npm test
 *     node test/landcheck.mjs
 *
 * `bin/deliver.js` is the one place in beadcause where an agent merges code, and
 * `scripts/land-check.mjs` is the only thing that runs it end to end — real `git` against
 * a real bare remote, a real `bd` in a scratch workspace, a fake `gh`. It was not in
 * `npm test`, and bc-4fq was a bug in deliver.js's argument handling that the whole suite
 * passed over both before and after the fix: eighty-odd suites, and not one of them could
 * tell the difference. Only land-check could. So this file is here to make it part of the gate,
 * and it is a wrapper rather than a copy — there is one harness, and it stays in
 * `scripts/` where a session can also run it on its own with `--keep`.
 *
 * ## Why a wrapper at all, rather than moving the harness into `test/`
 *
 * `scripts/test.mjs` discovers `test/*.mjs`, so a suite is a *file in a directory* and
 * adding one conflicts with nobody. land-check is also a thing you run by hand while
 * changing delivery — `--keep` leaves its whole world in `/tmp` to poke at — and moving
 * it would break every reference to it in README.md, docs/architecture.html and the ship
 * runbook. A wrapper buys the discovery without moving anything.
 *
 * ## Why the browser checks stay out and this one does not
 *
 * The `scripts/*-check.mjs` family is deliberately outside `npm test`: each needs headless
 * Chrome, and two of them need `public/vendor` to have been vendored, which a fresh
 * worktree does not have. Neither is true of land-check. It needs `bd`, which is the tool
 * this whole project is a client of and is installed on any machine that can run beadcause
 * at all — and `git`, which is assumed by half the suite already.
 *
 * ## The cost, honestly
 *
 * ~70s run on its own on this machine, ~90s from inside a full `npm test` where it is
 * competing with whatever else the laptop is doing — the second slowest thing in the gate
 * after `scripts/test-swap.js`. Nearly all of it is `bd` itself: ten deliveries across seven
 * scenarios, each creating a bead, running the real deliver.js (which shells out to `bd`
 * several times), then reading the bead back. It is *not* pinned last beside `test-swap`,
 * even though it earns the slot on time alone: `scripts/test.mjs` keeps that FIRST/LAST list
 * short precisely because it is the one line every session has to edit, and a suite with no
 * real ordering requirement is not worth reintroducing that conflict for. It sorts into the
 * middle beside `land.mjs` and `landed.mjs`, which is where you would look for it anyway.
 *
 * ## What it does when it cannot run
 *
 * Skips, exit 0, loudly — a machine without `bd` should not fail a gate over a tool it was
 * never going to use. Two ways that happens, and land-check already distinguishes them by
 * exit code, so this reads them rather than guessing:
 *
 * - **no `bd` at all** — nothing to point the harness at, so it is never started;
 * - **exit 2 from land-check** — `bd` is there but could not build a scratch workspace
 *   (wrong version, broken install). That code means "this environment cannot host the
 *   check", as distinct from 1, which means "a check failed".
 *
 * A *missing harness* is not a skip. If `scripts/land-check.mjs` is renamed or deleted,
 * this fails — because the failure mode being fixed here is coverage that quietly stops
 * existing, and a wrapper that shrugs at a missing target would be a second helping of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HARNESS = path.join(ROOT, 'scripts', 'land-check.mjs');

const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/** A hang inside `npm test` is worse than a slow suite, but a false timeout is worse still:
 *  a dozen sessions share this laptop and a loaded machine can take several times the 70s
 *  this needs when idle. Ten minutes only ever trips on something genuinely stuck. A kill
 *  leaves land-check's temp world behind, which is a cheap price for not hanging the gate. */
const TIMEOUT_MS = Number(process.env.BEADCAUSE_LANDCHECK_TIMEOUT_MS || 10 * 60 * 1000);

if (!fs.existsSync(HARNESS)) {
  console.log(red(`\nscripts/land-check.mjs is not there — deliver.js has no end-to-end cover.`));
  console.log(red(`If it moved, point this suite at it; if it went, say why in its place.\n`));
  process.exit(1);
}

/**
 * The same default land-check itself uses, and then `PATH` — resolving it here rather
 * than leaving it to the harness is what lets the skip below name a real reason, and the
 * resolved path is handed back down as `BD_BIN` so both halves agree on one binary.
 */
const onPath = (name) => {
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
};

const bdBin = (() => {
  const asked = process.env.BD_BIN;
  if (asked) {
    if (fs.existsSync(asked)) return asked;
    // `BD_BIN=bd` is a name, not a path, and land-check's own execFileSync would have
    // resolved it — so resolving it here too is what keeps the two from disagreeing about
    // whether there is a bd at all.
    return asked.includes(path.sep) ? null : onPath(asked);
  }
  if (fs.existsSync('/opt/homebrew/bin/bd')) return '/opt/homebrew/bin/bd';
  return onPath('bd');
})();

if (!bdBin) {
  const why = process.env.BD_BIN
    ? `BD_BIN points at ${process.env.BD_BIN}, which is not there`
    : 'no `bd` on PATH or at /opt/homebrew/bin/bd';
  console.log(yellow(`\n  ⊘ scripts/land-check.mjs skipped — ${why}.`));
  console.log(yellow(`    bin/deliver.js has no end-to-end cover in this run. Install bd, or set BD_BIN.\n`));
  process.exit(0);
}

console.log(`  running scripts/land-check.mjs with ${bdBin} — 70–90s, the slowest suite bar test-swap`);

const started = Date.now();
const run = spawnSync(process.execPath, [HARNESS], {
  cwd: ROOT,
  stdio: 'inherit',
  timeout: TIMEOUT_MS,
  env: { ...process.env, BD_BIN: bdBin },
});
const took = `${Math.round((Date.now() - started) / 1000)}s`;

if (run.error && run.error.code === 'ETIMEDOUT') {
  console.log(red(`\nscripts/land-check.mjs was still running after ${took} and was killed.`));
  console.log(red(`Raise BEADCAUSE_LANDCHECK_TIMEOUT_MS if the machine is just slow; otherwise it is stuck.\n`));
  process.exit(1);
}
if (run.error) {
  console.log(red(`\nscripts/land-check.mjs could not be started — ${run.error.message}\n`));
  process.exit(1);
}
if (run.signal) {
  console.log(red(`\nscripts/land-check.mjs was killed by ${run.signal} after ${took}\n`));
  process.exit(1);
}

// 2 is land-check's own "I cannot build a scratch beads workspace" — an environment that
// cannot host the check, not a check that failed. Skip, and say so where it will be read.
if (run.status === 2) {
  console.log(yellow(`  ⊘ scripts/land-check.mjs skipped — ${bdBin} could not build a scratch workspace.`));
  console.log(yellow(`    bin/deliver.js has no end-to-end cover in this run. See the lines above for bd's reason.\n`));
  process.exit(0);
}

if (run.status !== 0) process.exit(run.status ?? 1);

console.log(`  ✓ scripts/land-check.mjs passed in ${took}\n`);
