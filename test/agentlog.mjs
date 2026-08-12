#!/usr/bin/env node
/**
 * `scripts/check-agent-log.js`, inside the gate.
 *
 *     npm test
 *     node test/agentlog.mjs
 *     npm run check          # the same harness, run on its own
 *
 * `/api/agent-log` is the whole contract the phone's session-log pane rests on, and
 * `lib/agentlog.js` and `lib/activity.js` had no cover in `npm test` at all — no suite
 * under `test/` so much as imports them. What covers them is `scripts/check-agent-log.js`,
 * which nothing runs unless somebody remembers to type `npm run check`. So a change that
 * left the pane polling a file that will never change again, or rendering raw JSON at
 * a phone, was green across the whole gate.
 *
 * ## Why it was out, and why that reason does not survive reading
 *
 * The `scripts/*-check.mjs` family is deliberately outside `npm test` because each one
 * needs headless Chrome, and two of them need a `public/vendor` a fresh worktree does not
 * have. That is a real reason and it still holds for them. It was never the reason this
 * one was out. `scripts/check-agent-log.js` says of itself: *"This is not the test suite —
 * there isn't one yet."* That was true when it was written and it is not true now; there
 * are a hundred and thirty-odd suites under `test/`, and what it describes is its own
 * shape rather than anything it needs. It takes a throwaway `BEADCAUSE_CONFIG_DIR`, an
 * ephemeral port and a `bdBin` of `/bin/false` — no Chrome, no `bd`, no git, no network,
 * nothing machine-specific, and **no way for it to skip**, which is the part that makes it
 * belong here rather than beside land-check. It runs in about a fifth of a second.
 *
 * ## Why a wrapper rather than moving the harness into `test/`
 *
 * `scripts/test.mjs` discovers `test/*.mjs`, so a suite is a *file in a directory* and
 * adding one conflicts with nobody — but only `test/*.mjs`, which is why the harness
 * cannot simply be discovered where it lives. Moving it would work and would cost
 * `npm run check`, which is documented twice as the thing that is safe to run with the
 * daemon up and is the fast way to answer *"did I break the pane?"* while changing it.
 * A wrapper buys the discovery and leaves every reference to the harness true. It sorts
 * into the middle of the run, where nothing depends on order, so the pinned FIRST/LAST
 * line in `scripts/test.mjs` — the one line every session has to edit — is untouched.
 *
 * ## A missing harness is a failure, not a skip
 *
 * If `scripts/check-agent-log.js` is renamed or deleted, this exits 1 and says where to
 * look. The failure being fixed here is cover that quietly stops existing; a wrapper that
 * shrugged when its target went would be a second helping of it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const HARNESS = path.join(ROOT, 'scripts', 'check-agent-log.js');

const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

/** It needs ~0.2s idle, so two minutes is six hundred times its own runtime and only ever
 *  trips on something genuinely stuck — a `listen` that never resolves, a `fetch` with
 *  nothing at the other end. A hang inside `npm test` is worse than any suite being slow,
 *  because the run after it never starts. No env override, unlike land-check's ten
 *  minutes: that one is load-dependent and this has no margin left to argue about. */
const TIMEOUT_MS = 2 * 60 * 1000;

if (!fs.existsSync(HARNESS)) {
  console.log(red(`\nscripts/check-agent-log.js is not there — /api/agent-log has no cover.`));
  console.log(red(`If it moved, point this suite at it; if it went, say why in its place.\n`));
  process.exit(1);
}

const started = Date.now();
const run = spawnSync(process.execPath, [HARNESS], {
  cwd: ROOT,
  stdio: 'inherit',
  timeout: TIMEOUT_MS,
});
const took = `${((Date.now() - started) / 1000).toFixed(1)}s`;

if (run.error && run.error.code === 'ETIMEDOUT') {
  console.log(red(`\nscripts/check-agent-log.js was still running after ${took} and was killed.`));
  console.log(red(`It needs a fifth of a second, so this is a hang, not a slow machine.\n`));
  process.exit(1);
}
if (run.error) {
  console.log(red(`\nscripts/check-agent-log.js could not be started — ${run.error.message}\n`));
  process.exit(1);
}
// Anywhere in this repo, an exit status of null means killed-by-signal rather than a
// check that failed, and the two read identically in a scrollback if nobody says which.
if (run.signal) {
  console.log(red(`\nscripts/check-agent-log.js was killed by ${run.signal} after ${took}\n`));
  process.exit(1);
}

if (run.status !== 0) {
  console.log(yellow(`\n  the session-log pane's contract is what just broke — see the FAIL lines above.\n`));
  process.exit(run.status ?? 1);
}

console.log(`  ✓ scripts/check-agent-log.js passed in ${took}\n`);
