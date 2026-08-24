/**
 * The whole suite, without bailing — one runner instead of a scratchpad script per session.
 *
 * `bin/b7e-gate` is the thin CLI shell; everything that can be gotten wrong lives here so
 * `test/gate.mjs` can drive it directly, against a fabricated tree, without spawning a
 * process that spawns processes. bc-khoe.39 names nine sessions that each hand-wrote this —
 * a 6-way `execFile` pool over `scripts/test.mjs --list`, a per-suite timeout, a tally at
 * the end — and none of the nine agreed on parallelism, timeout or whether to skip
 * `scripts/test-swap.js`. This is the one answer.
 *
 * ## Discovery is reused, not reimplemented
 *
 * `scripts/test.mjs --list --dir <root>` is the single source of truth for what a suite
 * *is* — the pinned order (`test/lockfile.mjs`, `scripts/selftest.mjs` first,
 * `scripts/test-swap.js` last) and the sorted middle both live there, and duplicating that
 * logic here would be a second place for the two lists to drift apart. Shelling out costs
 * one child process at startup and buys a discovery that can never disagree with `npm test`
 * about what a suite is.
 *
 * ## Two things `npm test` cannot do, which is the whole of this file
 *
 * **It does not stop at the first red.** Every suite in the selection runs; the exit code
 * is non-zero if any of them failed, but the other 340 still ran and are still reported.
 * That is the entire reason nine sessions wrote a runner instead of typing `npm test`.
 *
 * **It runs suites concurrently, for real.** [[parallel-runner-must-not-use-spawnsync]] is
 * the trap here: `spawnSync` blocks the one JS thread, so N "workers" built on it run
 * strictly one at a time and a serial run wears a parallel runner's clothes. This uses
 * `spawn` (async), a pool of `--jobs` workers pulling the next suite off a shared index,
 * each holding its own `TMPDIR` sandbox the way `scripts/test.mjs` and `scripts/checks.mjs`
 * both already do (bc-5isv) — so nothing here can leak the shared `$TMPDIR` twenty other
 * sessions are using, whatever concurrency it is asked to run at.
 *
 * ## Two suites cannot take the pool, and one kind wants longer alone
 *
 * `scripts/test-swap.js` drives a real blue/green swap under load and `test/slowstart.mjs`
 * fails under concurrent load and passes alone — both documented flakes under a parallel
 * runner ([[the-parallel-gate-runner-and-what-reproduces-on-main]],
 * [[slowstart-fails-under-load]]). Both are held out of the pool and run afterward, one at
 * a time. Suites that drive the *real* `bd` against shared state — every `test/*real.mjs`
 * plus `test/landcheck.mjs`, which drives a real `git`+`bd` end to end through
 * `bin/deliver.js` — get a longer per-suite timeout by default, so a loaded Mac reports a
 * slow pass rather than manufacturing a red one; `--timeout` overrides this uniformly when
 * given, because an explicit ask is a real ask.
 *
 * ## One gate per tree at a time
 *
 * A second invocation against the same root while the first is still running would double
 * the load a busy Mac is already under, so it refuses instead — a lock file under the
 * system temp directory, keyed by the resolved root, holding the running pid. A lock whose
 * pid is no longer alive is stale and is silently reclaimed, because a runner that leaves a
 * permanent lock behind after a crash is worse than the race it was trying to prevent.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NO_LAUNCH } from './launchguard.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** This repo's own root — the one `scripts/test.mjs` discovery is always read from. */
export const REPO_ROOT = path.join(HERE, '..');
const TEST_RUNNER = path.join(REPO_ROOT, 'scripts', 'test.mjs');

/** Ordinary suites: five minutes is generous for anything that is not real-bd or real-git. */
export const DEFAULT_TIMEOUT_MS = 300_000;
/** The suites below get fifteen — a loaded Mac should report them slow, not report them red. */
export const SLOW_TIMEOUT_MS = 900_000;

/**
 * Drives the real `bd` against shared state, or the real `git`+`bd` through
 * `bin/deliver.js` — both documented flakes under load, neither fixable by code here.
 * Named explicitly rather than by convention alone, because `test/landcheck.mjs` does not
 * end in `real.mjs` and a future suite doing the same thing may not either.
 */
const SLOW_NAMES = new Set(['test/landcheck.mjs']);
const SLOW_RE = /real\.mjs$/i;

/** Cannot share the pool with anything else — see the header. Always run alone, afterward. */
export const SOLO = new Set(['scripts/test-swap.js', 'test/slowstart.mjs']);

export const isSlow = (suite) => SLOW_NAMES.has(suite) || SLOW_RE.test(suite);
export const isSolo = (suite) => SOLO.has(suite);

/** `overrideMs` is what `--timeout` becomes — given or not, this is the one place that decides. */
export const timeoutMsFor = (suite, overrideMs) =>
  overrideMs != null ? Math.max(0, overrideMs) : isSlow(suite) ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;

/* ------------------------------------------------------------------------ discovery */

/** `scripts/test.mjs --list --dir <root>` — the one place a suite list is decided. */
export function discoverSuites(root) {
  const out = execFileSync(process.execPath, [TEST_RUNNER, '--list', '--dir', path.resolve(root)], {
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

/* ---------------------------------------------------------------- --only / --skip */

/**
 * A suite path or a glob with `*` — never a regex, so a suite named `test/a.b.mjs` cannot
 * have its own dots misread. `b7e-affected` (not shipped yet) would print exact suite
 * paths, one per `--only`, and those pass straight through unchanged: a pattern with no
 * `*` compiles to an exact match.
 */
export function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export const matchesAny = (suite, patterns) => patterns.some((p) => globToRegExp(p).test(suite));

/** `only` narrows, `skip` removes — same list, applied in that order. */
export function selectSuites(all, { only = [], skip = [] } = {}) {
  let picked = only.length ? all.filter((s) => matchesAny(s, only)) : all.slice();
  if (skip.length) picked = picked.filter((s) => !matchesAny(s, skip));
  return picked;
}

/* --------------------------------------------------------------------------- lock */

/** Never inside a worktree — this is `os.tmpdir()`, keyed by the resolved root. */
function lockPathFor(root) {
  const key = crypto.createHash('sha1').update(fs.realpathSync(path.resolve(root))).digest('hex').slice(0, 16);
  return path.join(fs.realpathSync(os.tmpdir()), `beadcause-gate-${key}.lock`);
}

/** `EPERM` means the pid exists and belongs to someone else — still alive, from here. */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/**
 * The live `b7e-gate` lock on `root`, if any — `{ pid, startedAt, lockPath }`, or `null`
 * when nothing holds it (never written, or held by a pid that is no longer alive).
 * Read-only, unlike `acquireLock` below, which reuses this for the same check before
 * deciding whether to write it. `bin/b7e-gates` (bc-khoe.55) is the reason it is
 * exported: for any run that went through this lock at all, "which worktree is this pid
 * in" is this one file read, with no `lsof` involved.
 */
export function gateLockStatus(root) {
  const lockPath = lockPathFor(root);
  if (!fs.existsSync(lockPath)) return null;
  let held = null;
  try {
    held = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return null;
  }
  if (held && typeof held.pid === 'number' && isPidAlive(held.pid)) {
    return { pid: held.pid, startedAt: held.startedAt, lockPath };
  }
  return null;
}

/**
 * `{ ok: true, release }` on success, `{ ok: false, pid, startedAt }` if another gate on
 * this root is already running. A lock whose pid is no longer alive is stale and is
 * reclaimed rather than left to block every future run — a crash must not be a permanent
 * refusal.
 */
export function acquireLock(root) {
  const lockPath = lockPathFor(root);
  const status = gateLockStatus(root);
  if (status) return { ok: false, pid: status.pid, startedAt: status.startedAt, lockPath: status.lockPath };
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    try {
      fs.rmSync(lockPath, { force: true });
    } catch {
      /* a teardown must never be why a run ends badly */
    }
  };
  return { ok: true, release, lockPath };
}

/* ------------------------------------------------------------------------ running */

const rmQuietly = (dir) => {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* left for the stray sweep, same as scripts/test.mjs and scripts/checks.mjs */
  }
};

/**
 * One suite, one child, its own `TMPDIR` sandbox — kept if it failed, removed if it did not.
 * `live`, if given a Set, gets the child added and removed so a caller can end every
 * in-flight child on its own exit (see `runGate`'s `signalAbort` wiring).
 */
export function runSuite(root, suite, { timeoutMs = DEFAULT_TIMEOUT_MS, sandboxRoot, live } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const base = sandboxRoot || fs.realpathSync(os.tmpdir());
    const sandbox = fs.mkdtempSync(path.join(base, `${path.basename(suite).replace(/\W+/g, '-')}-`));
    let child;
    try {
      child = spawn(process.execPath, [path.join(root, suite)], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        // Layer 2 of the launch guard — see scripts/test.mjs, which sets the same thing for
        // the same reason: a suite that starts a real daemon must never open a real window.
        env: { ...process.env, [NO_LAUNCH]: '1', TMPDIR: sandbox },
      });
    } catch (err) {
      rmQuietly(sandbox);
      resolve({
        suite,
        status: 'FAIL',
        code: null,
        signal: null,
        timedOut: false,
        ms: Date.now() - started,
        out: `could not start — ${err.message}\n`,
      });
      return;
    }
    live?.add(child);
    let out = '';
    let timedOut = false;
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, timeoutMs)
      : null;
    child.on('error', (err) => {
      live?.delete(child);
      if (timer) clearTimeout(timer);
      rmQuietly(sandbox);
      resolve({
        suite,
        status: 'FAIL',
        code: null,
        signal: null,
        timedOut: false,
        ms: Date.now() - started,
        out: `${out}could not start — ${err.message}\n`,
      });
    });
    child.on('close', (code, signal) => {
      live?.delete(child);
      if (timer) clearTimeout(timer);
      if (timedOut) out += `\ntimed out after ${(timeoutMs / 1000).toFixed(0)}s — killed\n`;
      const ok = !timedOut && !signal && code === 0;
      const status = timedOut ? 'TIMEOUT' : ok ? 'ok' : 'FAIL';
      if (ok) rmQuietly(sandbox);
      resolve({ suite, status, code, signal, timedOut, ms: Date.now() - started, out, scratch: ok ? null : sandbox });
    });
  });
}

/**
 * The whole gate: discover (or take a given list), filter, split solo from concurrent, run
 * the concurrent pool at `jobs` workers, then the solo suites one at a time, streaming each
 * result through `onResult` as it finishes. Returns `{ results, passed, failed, total, ok }`.
 *
 * `suites`, if given, replaces discovery — this is how a test drives a small fabricated
 * list without shelling out to `scripts/test.mjs` twice.
 */
export async function runGate(
  root,
  { only = [], skip = [], jobs = 6, timeoutOverrideMs = null, onResult, signalAbort, suites } = {},
) {
  const all = suites || discoverSuites(root);
  const selected = selectSuites(all, { only, skip });
  const total = selected.length;
  const results = [];
  let done = 0;

  const sandboxRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-gate-run-'));
  const live = new Set();
  let off = null;
  if (signalAbort) {
    off = signalAbort(() => {
      for (const child of live) {
        try {
          child.kill('SIGTERM');
        } catch {
          /* already gone */
        }
      }
    });
  }

  const record = async (suite) => {
    const timeoutMs = timeoutMsFor(suite, timeoutOverrideMs);
    const r = await runSuite(root, suite, { timeoutMs, sandboxRoot, live });
    done += 1;
    results.push(r);
    onResult?.(r, done, total);
    return r;
  };

  const concurrent = selected.filter((s) => !isSolo(s));
  const solo = selected.filter((s) => isSolo(s));

  let next = 0;
  const worker = async () => {
    while (next < concurrent.length) {
      const suite = concurrent[next++];
      await record(suite);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, concurrent.length || 1)) }, worker));

  for (const suite of solo) await record(suite);

  off?.();
  rmQuietly(sandboxRoot);

  const failed = results.filter((r) => r.status !== 'ok');
  const passed = results.length - failed.length;
  return { results, passed, failed, total, ok: failed.length === 0 };
}

/* ---------------------------------------------------------------------- reporting */

/** The one-line tally: `all N suites passed`, or `P/T passed, F failed: a, b, c`. */
export function summaryLine({ passed, total, failed }) {
  if (!failed.length) return `all ${total} suite${total === 1 ? '' : 's'} passed`;
  return `${passed}/${total} passed, ${failed.length} failed: ${failed.map((f) => f.suite).join(', ')}`;
}

/** `--json`: one object per finished suite, the same fields a human line is built from. */
export function toJsonRecord(result, done, total) {
  return {
    index: done,
    total,
    suite: result.suite,
    status: result.status,
    code: result.code,
    signal: result.signal,
    seconds: Number((result.ms / 1000).toFixed(1)),
  };
}
