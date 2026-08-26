/**
 * A workspace repo's own gate scripts — discovered by manifest, run as a batch, with an
 * optional `--baseline` comparison against a git ref. `bin/b7e-checks` is the argv
 * shell; this is the manifest, the running and the baseline diff.
 *
 * bc-dgx7.57: eight sessions (dv-3rn.3, dv-5i2.44, dv-ek4, dv-6cn, dv-gsh, dv-i5v,
 * dv-nnk, dv-5f3) each hand-assembled this exact loop — every `scripts/check_*.py`,
 * one process per script, its exit code read directly — because the worktree-isolation
 * guard refuses a bare `for f in scripts/check_*.py; do …; done` as "too complex to
 * verify it stays inside the worktree", and because `python3 check.py . | tail -1;
 * echo $?` reports `tail`'s exit status, not the check's (dv-ek4 found that one the hard
 * way: an earlier spelling was reporting green for red). No two of the eight spelled it
 * the same way. This is the one answer, plus the baseline half every one of them also
 * needed — dv-3rn.3 nearly attributed two already-red selftests to its own branch before
 * checking `origin/main` first.
 *
 * ## Discovery is a manifest, not a fixed list
 *
 * A repo's "own gate scripts" is repo-specific — deluvia's is `scripts/check_*.py` plus
 * `scripts/studio_status.py`'s DRIFT probe, and nothing here assumes any other repo
 * looks the same. `MANIFESTS` is tried in order, each entry's `detect(root)` deciding
 * whether it applies; a root none of them recognise gets a clean refusal (`manifestFor`
 * returns `null`) rather than a silent empty run.
 *
 * ## Most checks are exit-code-only; one is not
 *
 * `scripts/studio_status.py` never exits non-zero for "not ready" — that is its normal
 * state, by its own docstring — so its pass/fail rule is not the exit code, it is
 * whether `--json`'s `drift` array is empty. Every check carries its own `judge(result)`
 * for exactly this reason; `byExitCode` is the default every ordinary check uses.
 *
 * ## Why this does not import `lib/gate.js`'s `runGate`/`runSuite`
 *
 * `acquireLock` is reused as-is below — a lock keyed by the resolved root needs nothing
 * check-specific. `runGate`/`runSuite` are not reusable: they spawn `node <suite file>`
 * against *this* repo's own `test/*.mjs`, and a check here is `python3 <script> <root>
 * [flags]` against a *different* repo's tree, with its own argv shape and its own
 * pass/fail rule. This file mirrors `runGate`'s pool/timeout/streamed-onResult shape —
 * the part that generalises — rather than importing code built on an assumption that
 * does not hold here.
 *
 * ## `--baseline <ref>` reuses the `makeMainWorktree` pattern, not the function
 *
 * `lib/blame.js`'s `makeMainWorktree` is hardcoded to `origin/main`; `--baseline` takes
 * any ref, so this holds its own `git worktree add --detach` helper rather than widening
 * a function whose whole contract (`removeMainWorktree`, the one-`origin/main`-per-run
 * caching in `runBlame`) is built around that one ref never changing mid-run.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { acquireLock, selectSuites } from './gate.js';

export { acquireLock, selectSuites };

/** Five minutes — the same default `lib/gate.js` uses for an ordinary suite. A selftest
 * that stages a repo copy per case has been observed over a minute; this is generous
 * rather than tight. `--timeout` overrides it uniformly. */
export const DEFAULT_TIMEOUT_MS = 300_000;

/* ------------------------------------------------------------------------ manifests */

function checkPyFiles(root) {
  const dir = path.join(root, 'scripts');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^check_.*\.py$/.test(f))
    .sort();
}

/** The default judge: the process's own exit code, nothing else. */
export function byExitCode(r) {
  if (r.timedOut) return { ok: false, detail: 'timed out' };
  if (r.signal) return { ok: false, detail: `killed by ${r.signal}` };
  return { ok: r.code === 0, detail: lastLine(r.out) };
}

const lastLine = (out) =>
  String(out || '')
    .trim()
    .split('\n')
    .slice(-1)[0] || '';

/**
 * `studio_status.py`'s own docstring: "the report never exits non-zero merely because a
 * gate is not ready — not ready is the normal state of a gate and is not an error." So a
 * non-zero exit here means it could not even produce a report (unreadable maps, no
 * `bd`), which is a failure regardless of drift; a zero exit is judged by parsing its
 * `--json` payload's `drift` array instead.
 *
 * Parses `r.stdout` — never `r.out`, which is stdout and stderr combined for display,
 * the same way `lib/gate.js`'s `runSuite` combines them for its own `out`. A `bd`
 * warning or a Python deprecation notice landing on stderr, interleaved into that
 * combined buffer at whatever moment its `data` event fired, would otherwise be enough
 * to break `JSON.parse` on a check that ran cleanly.
 */
export function judgeStudioStatus(r) {
  if (r.timedOut) return { ok: false, detail: 'timed out' };
  if (r.signal) return { ok: false, detail: `killed by ${r.signal}` };
  if (r.code !== 0) return { ok: false, detail: lastLine(r.out) || `exit ${r.code}` };
  let payload;
  try {
    payload = JSON.parse(r.stdout);
  } catch {
    return { ok: false, detail: 'exit 0 but --json output did not parse' };
  }
  const drift = Array.isArray(payload.drift) ? payload.drift : [];
  if (drift.length) {
    return { ok: false, detail: `DRIFT: ${drift.map((d) => `${d.gate} ${d.id}`).join(', ')}` };
  }
  return { ok: true, detail: 'no drift' };
}

/**
 * One manifest per repo shape, tried in `detect` order. `deluvia`'s is the only one
 * written today — a repo `--dir`/`-w` points at with none matching gets `manifestFor`
 * returning `null`, which `bin/b7e-checks` turns into a refusal rather than a silent
 * empty run.
 */
export const MANIFESTS = [
  {
    name: 'python-checks',
    detect: (root) => checkPyFiles(root).length > 0,
    discover: (root) => {
      const checks = checkPyFiles(root).map((f) => ({
        name: `scripts/${f}`,
        argv: [path.join('scripts', f), '.'],
        judge: byExitCode,
      }));
      const studioPath = path.join(root, 'scripts', 'studio_status.py');
      if (fs.existsSync(studioPath)) {
        checks.push({
          name: 'scripts/studio_status.py (DRIFT)',
          argv: [path.join('scripts', 'studio_status.py'), '.', '--json'],
          judge: judgeStudioStatus,
        });
      }
      return checks;
    },
  },
];

/** The manifest for `root`, or `null` if nothing recognises it. */
export function manifestFor(root) {
  return MANIFESTS.find((m) => m.detect(root)) || null;
}

/** What `manifestFor(root).discover(root)` returns, or `[]` if no manifest matches. */
export function discoverChecks(root) {
  const manifest = manifestFor(root);
  return manifest ? manifest.discover(root) : [];
}

/* -------------------------------------------------------------------------- running */

/**
 * One check, one `python3` child. `env`, if given, is merged over `process.env` — this
 * is how a caller running against a `dv-` workspace overrides `BEADS_DIR` to the target
 * repo's own workspace rather than whatever this process inherited (its own workspace,
 * almost always a different tracker) — a check that shells out to `bd` (like
 * `studio_status.py`) would otherwise silently query the wrong graph.
 */
export function runCheck(root, check, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    let child;
    try {
      child = spawn('python3', check.argv, {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, ...(env || {}) },
      });
    } catch (err) {
      resolve({
        name: check.name,
        ok: false,
        code: null,
        signal: null,
        timedOut: false,
        ms: Date.now() - started,
        out: `could not start — ${err.message}\n`,
        detail: `could not start — ${err.message}`,
      });
      return;
    }
    let out = '';
    let stdout = '';
    let timedOut = false;
    child.stdout.on('data', (d) => {
      out += d;
      stdout += d;
    });
    child.stderr.on('data', (d) => (out += d));
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill('SIGTERM');
          setTimeout(() => child.kill('SIGKILL'), 5000).unref();
        }, timeoutMs)
      : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolve({
        name: check.name,
        ok: false,
        code: null,
        signal: null,
        timedOut: false,
        ms: Date.now() - started,
        out: `${out}could not start — ${err.message}\n`,
        detail: `could not start — ${err.message}`,
      });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (timedOut) out += `\ntimed out after ${(timeoutMs / 1000).toFixed(0)}s — killed\n`;
      const r = { suite: check.name, code, signal, timedOut, ms: Date.now() - started, out, stdout };
      const verdict = (check.judge || byExitCode)(r);
      resolve({ name: check.name, code, signal, timedOut, ms: r.ms, out, ok: !!verdict.ok, detail: verdict.detail });
    });
  });
}

/**
 * Every check in `checks`, `jobs` at a time, streaming each result through `onResult` as
 * it finishes — the same shape `runGate` reports in, so `bin/b7e-checks` can borrow its
 * printing style. Returns `{ results, passed, failed, total, ok }`.
 */
export async function runChecks(root, checks, { jobs = 4, timeoutMs = DEFAULT_TIMEOUT_MS, onResult, env } = {}) {
  const total = checks.length;
  const results = [];
  let done = 0;
  let next = 0;

  const worker = async () => {
    while (next < checks.length) {
      const check = checks[next++];
      const r = await runCheck(root, check, { timeoutMs, env });
      done += 1;
      results.push(r);
      onResult?.(r, done, total);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, checks.length || 1)) }, worker));

  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  return { results, passed, failed, total, ok: failed.length === 0 };
}

/* ------------------------------------------------------------------------- baseline */

/**
 * A throwaway detached `git worktree` at `ref`, `node_modules` never involved (these
 * are `python3` checks, not `node` suites). `root` must be a checkout with `ref`
 * resolvable from it. Caller owns teardown via `removeRefWorktree`.
 */
export function makeRefWorktree(root, ref) {
  const scratchRoot = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-checks-'));
  const dir = path.join(scratchRoot, 'ref');
  execFileSync('git', ['worktree', 'add', '--detach', '-q', dir, ref], { cwd: root, stdio: 'pipe' });
  return { dir, scratchRoot };
}

/** Removes a worktree made by `makeRefWorktree`, best-effort and always. */
export function removeRefWorktree(root, dir, scratchRoot) {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', dir], { cwd: root, stdio: 'pipe' });
  } catch {
    /* best effort — prune and the scratch rm below are what actually guarantee cleanup */
  }
  try {
    execFileSync('git', ['worktree', 'prune'], { cwd: root, stdio: 'pipe' });
  } catch {
    /* nothing more to do about a prune that itself fails */
  }
  if (scratchRoot) fs.rmSync(scratchRoot, { recursive: true, force: true });
}

/**
 * Classify each of `current`'s results against a baseline run — `already-red` (failed on
 * both), `newly-red` (passed at the baseline, or did not exist there, and fails now),
 * `green` (passes now, whatever the baseline said). Matched by check **name**, the same
 * "compare by name, not by pass/fail bit" rule `lib/blame.js` uses, because a check that
 * did not exist at the baseline ref has nothing to be blamed on but itself.
 */
export function classifyAgainstBaseline(current, baseline) {
  const baselineByName = new Map(baseline.map((r) => [r.name, r]));
  return current.map((r) => {
    if (r.ok) return { ...r, baseline: 'green' };
    const at = baselineByName.get(r.name);
    return { ...r, baseline: at && !at.ok ? 'already-red' : 'newly-red' };
  });
}

/* --------------------------------------------------------------------- reporting */

/** The one-line tally, matching `lib/gate.js`'s `summaryLine` shape. */
export function summaryLine({ passed, total, failed }) {
  if (!failed.length) return `all ${total} check${total === 1 ? '' : 's'} passed`;
  return `${passed}/${total} passed, ${failed.length} failed: ${failed.map((f) => f.name).join(', ')}`;
}
