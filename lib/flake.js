/**
 * How often does a suite actually fail, over N runs, with every run's output kept —
 * `bin/b7e-flake` is the argv shell; this is the loop and the log bookkeeping.
 *
 * bc-dgx7.73: three sessions each needed a failure RATE, not a verdict, and each built
 * the loop by hand. bc-beleq.1 (acceptance was "20 solo runs, pre-fix vs post-fix")
 * tried `for i in 1 2 3; do node test/advswitch.mjs 2>&1 | tail -5; done`, was refused by
 * the worktree-isolation guard as too complex to verify it stays in the worktree, tried
 * a backgrounded `seq 1 8` loop, was refused again, fell back to two solo runs redirected
 * into scratchpad files, then finally wrote a heredoc script with its own counters —
 * which outran the 180s Bash timeout and had to move to the background — and wrote a
 * SECOND, nearly identical script for the pre-fix side. bc-khoe.67 wrote a fourth shape,
 * `... | grep -E "^(✗|✘|×|FAIL)" | head -10 ...`, and the grep-through-a-pipe form threw
 * away the one thing it was after: its own debrief is "Run 3 failed but I lost its
 * output. Save every run to its own file from the start." bc-dgx7.57 wrote a fifth, for a
 * two-run sanity check before delivering.
 *
 * `bin/b7e-triage` (lib/triage.js) is close but answers a different question: it re-runs
 * each failure exactly once and classifies flake/vendor/real. It cannot produce a rate,
 * cannot prove a fix moved one, and keeps no per-run log — that is the gap this fills.
 *
 * ## Reused rather than reimplemented
 *
 * `runSuite` and `timeoutMsFor` (`lib/gate.js`) do the spawning, the per-suite `TMPDIR`
 * sandbox and the timeout — the same thing every one of those five hand-rolled loops got
 * wrong at least once (a `tail -5` that discarded output, a `| grep` that discarded exit
 * status, a script that raced the sandbox's own teardown). `runSuite` grew one new,
 * backward-compatible option here: `env`, merged UNDER the safety envs it always sets
 * (`NO_LAUNCH`, `HELD_ENV`, `TMPDIR`) — so `--env` can parameterise a run (bc-khoe.67's
 * own `PRESS_MS` sweep) but can never turn off the launch guard or hand two runs the same
 * scratch directory.
 *
 * ## Every run's log, kept, always — not just the failures
 *
 * The one lesson repeated across all three prior sessions is that deciding which run's
 * output is "worth keeping" *after the fact* is exactly the judgement that loses the one
 * you needed. So every run of every target gets its own log file on disk, whether it
 * passed or not, named by its index, and the record handed back always carries that
 * path. Nothing here ever pipes a run's output through anything that can throw part of
 * it away.
 *
 * ## Where the logs live
 *
 * Under `.claude/gate-runs` — the same directory `bin/b7e-gate` already writes JSONL run
 * records to, resolved through `lib/gaterun.js`'s `runsDir`/`mintRunId` so both land in
 * the *main checkout*, never inside a worktree's own tree (`git add -A` at delivery time
 * must not sweep a live run's log onto whichever branch happens to be open — see
 * [[gate-config-dir-must-be-outside-the-worktree]]), and both are visible from any
 * worktree by the same path. A flake run's id is prefixed `flake-` so a listing of the
 * directory never confuses one with a gate's own `<worktree>-<timestamp>-<rand>.jsonl`.
 *
 * ## Grouping failures by signature
 *
 * A rate alone ("6/20 failed") is not what bc-khoe.67's parameterised sweep or
 * bc-beleq.1's pre/post comparison actually needed — they needed to know whether every
 * failure was the *same* failure. `failureSignature` looks for, in order: an errno-style
 * code (`ENOTEMPTY`, `ENOENT`, ...), an `AssertionError` line, a `SomethingError:` line,
 * a signal, or the bare exit code — the first of these that is actually present in a
 * run's output is almost always the one line a human would point at first when asked
 * "why did this fail". It is a heuristic, not a parser for every suite's own output
 * format, and a `signatures` list that turns out to lump two different bugs under one
 * label is a report to sharpen this function, not a reason to distrust the rate above it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { REPO_ROOT, runSuite, timeoutMsFor } from './gate.js';
import { mintRunId, runsDir } from './gaterun.js';

export { REPO_ROOT };

const pad = (n, w = 3) => String(n).padStart(w, '0');

/** A target's own subdirectory name — same "strip to word chars" `runSuite`'s sandbox naming uses, so a target with a path separator in it never escapes the run directory. */
export const targetSlug = (target) => path.basename(target).replace(/\W+/g, '-') || 'target';

/**
 * `<mainCheckout>/.claude/gate-runs/flake-<slug>-<timestamp>-<rand>` — minted through
 * `lib/gaterun.js` so a flake run's id is built the exact same way a gate run's is,
 * just under its own namespace. Throws under the same condition `mintRunId` does: `cwd`
 * is not inside a git checkout. Callers that want a fixed, pre-chosen directory (tests,
 * mainly) pass `dir` to `runFlake` directly instead of calling this.
 */
export async function newFlakeRunDir(cwd) {
  const dir = await runsDir(cwd);
  const runId = `flake-${await mintRunId(cwd)}`;
  return path.join(dir, runId);
}

/**
 * `newFlakeRunDir`, but never throws — a `--dir` that is not a git checkout (every
 * fabricated tree `test/flake.mjs` drives the CLI against, same as `test/gate.mjs`'s own
 * fixtures) has no `.claude/gate-runs` to resolve, and a log-writing tool refusing to run
 * over that would be a worse bug than the one this command exists to fix. Falls back to a
 * plain directory under the system temp dir, same naming shape, minus the worktree slug.
 */
async function newFlakeRunDirBestEffort(cwd) {
  try {
    return await newFlakeRunDir(cwd);
  } catch {
    const rand = crypto.randomBytes(3).toString('hex');
    return path.join(fs.realpathSync(os.tmpdir()), `beadcause-flake-${Date.now()}-${rand}`);
  }
}

/* ------------------------------------------------------------------- failure signature */

const ERRNO_RE = /\b(E[A-Z]{2,10})\b/;
const ASSERT_LINE_RE = /^[ \t]*(AssertionError\b[^\n]*)/m;
const ERROR_LINE_RE = /^[ \t]*([A-Za-z][\w.]*Error:.*)$/m;

/** The one line out of a failing run's output worth grouping it by. Never throws — a run with no recognisable line at all falls back to its exit code or signal, which is always present. */
export function failureSignature(result) {
  if (result.timedOut) return 'timeout';
  const out = String(result.out || '');
  const errno = ERRNO_RE.exec(out);
  if (errno) return errno[1];
  const assertLine = ASSERT_LINE_RE.exec(out);
  if (assertLine) return assertLine[1].trim().slice(0, 160);
  const errLine = ERROR_LINE_RE.exec(out);
  if (errLine) return errLine[1].trim().slice(0, 160);
  if (result.signal) return `signal ${result.signal}`;
  return `exit ${result.code}`;
}

/* ------------------------------------------------------------------------------ running */

/**
 * Runs `target` `runs` times, `jobs` at once, writing every run's full output to its own
 * file under `dir` (created if missing) regardless of outcome. Returns one record per
 * run, in run order (`index` is 1-based, not completion order), plus the tally and the
 * failures grouped by `failureSignature`.
 */
export async function runFlakeTarget(root, target, { runs = 10, jobs = 4, timeoutOverrideMs = null, env, dir, onResult } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const timeoutMs = timeoutMsFor(target, timeoutOverrideMs);
  const results = new Array(runs);
  let next = 0;
  const worker = async () => {
    while (next < runs) {
      const i = next++;
      const r = await runSuite(root, target, { timeoutMs, env });
      const logPath = path.join(dir, `run-${pad(i + 1)}.log`);
      fs.writeFileSync(logPath, r.out || '');
      const record = {
        index: i + 1,
        status: r.status,
        code: r.code,
        signal: r.signal,
        timedOut: r.timedOut,
        ms: r.ms,
        logPath,
        signature: r.status === 'ok' ? null : failureSignature(r),
      };
      results[i] = record;
      onResult?.(target, record);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(jobs, runs)) }, worker));

  const failed = results.filter((r) => r.status !== 'ok');
  const bySignature = new Map();
  for (const f of failed) {
    const entry = bySignature.get(f.signature) || { signature: f.signature, count: 0, runs: [] };
    entry.count += 1;
    entry.runs.push(f);
    bySignature.set(f.signature, entry);
  }
  return {
    target,
    runs,
    dir,
    passed: results.length - failed.length,
    failed: failed.length,
    results,
    signatures: [...bySignature.values()],
  };
}

/**
 * The whole call: every target in `targets`, each run `runs` times. `dir`, given or not,
 * is where every run's logs land — one subdirectory per target under it, named by
 * `targetSlug`. Given nothing, a fresh directory under `.claude/gate-runs` is minted
 * (`newFlakeRunDir`); a caller that wants a fixed location (every test in `test/flake.mjs`,
 * a caller re-using a previous run's directory) passes one directly and it is used as-is.
 *
 * The load average at the start and the end is carried on the result so a clean sweep run
 * under real load is not mistaken for a clean sweep run quiet — bc-khoe.67's own
 * pre/post comparison is exactly the case a silent load spike would have made unreadable.
 */
export async function runFlake(root, targets, { runs = 10, jobs = 4, timeoutOverrideMs = null, env = {}, dir, onResult } = {}) {
  const loadStart = os.loadavg()[0];
  const runDir = dir || (await newFlakeRunDirBestEffort(root));
  const results = [];
  for (const target of targets) {
    const targetDir = path.join(runDir, targetSlug(target));
    const result = await runFlakeTarget(root, target, { runs, jobs, timeoutOverrideMs, env, dir: targetDir, onResult });
    results.push(result);
  }
  const loadEnd = os.loadavg()[0];
  return { dir: runDir, targets: results, loadStart, loadEnd, ok: results.every((t) => t.failed === 0) };
}

/* ----------------------------------------------------------------------------- reporting */

/** `<target>: P/N passed` or `<target>: P/N passed, F failed (SIG x2, SIG2 x1)`. */
export function targetSummaryLine(t) {
  if (!t.failed) return `${t.target}: ${t.passed}/${t.runs} passed`;
  const sigs = t.signatures.map((s) => `${s.signature} x${s.count}`).join(', ');
  return `${t.target}: ${t.passed}/${t.runs} passed, ${t.failed} failed (${sigs})`;
}

/** `{ target, run, log path }` — one line per failing run, the detail `targetSummaryLine` doesn't carry. */
export function failureLines(t) {
  return t.results.filter((r) => r.status !== 'ok').map((r) => `  run ${r.index}: ${r.signature} — ${r.logPath}`);
}
