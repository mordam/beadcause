/**
 * Say whether a failing suite is already failing on `origin/main` — `bin/b7e-blame` is
 * the argv shell; this is the running, the worktree and the comparison.
 *
 * bc-khoe.42 names eight sessions (`bc-khoe.23`, `bc-b4fs.1`, `bc-36xx.6`, `bc-5k22`,
 * `bc-xl7n.74`, `bc-xl7n.79`, `bc-1kwl.22`, `bc-j52g`) that each decided, from scratch and
 * by a different method, whether a red suite was theirs — a re-run in the untouched main
 * checkout, an inspection of imports, a memory from an earlier advocate pass, an
 * assertion by inference. This is the one answer, and it does it the way
 * `[[verifying-a-bead-is-already-fixed]]` already prescribes: a throwaway **detached**
 * `git worktree` at `origin/main`, never the main checkout (routinely tens of commits
 * stale) and never `EnterWorktree` (a duplicate-check run makes no edits and should take
 * no lock a sibling session could then trip over).
 *
 * ## What "the same check" means
 *
 * A suite here is not a pass/fail bit, it is a list of named checks — every suite in this
 * repo's own convention prints `  ok   <name>` or `  FAIL <name>` (or a close variant of
 * that spacing) one line per check, and `test/systemcard.mjs` and `scripts/selftest.mjs`
 * both do. Comparing the two runs by *name* rather than by exit code is the entire point:
 * a suite that is red on `origin/main` for reasons **A** and **B**, and red here for
 * **A**, **B** and **C**, is not "already red on main" — it is red on main *and* you
 * introduced **C**. Collapsing that into red/green either way is the mistake this exists
 * to stop. Extraction is best-effort: a suite that never prints a named `FAIL` line
 * (most of this repo's suites do) cannot be compared by name, and the verdict says so
 * rather than guessing.
 *
 * ## One `origin/main` worktree, reused across every suite asked about
 *
 * Building it costs a `git worktree add` and a `node_modules` symlink — worth doing once
 * per invocation, not once per suite. It is created lazily, on the first suite that
 * actually fails locally (a suite that passes here needs no comparison at all), and torn
 * down in a `finally` — including when a suite crashes the whole run, and including when
 * nothing ever needed it.
 *
 * ## What this deliberately does not do
 *
 * It does not run `npm test`'s or `b7e-gate`'s discovery — the caller already knows which
 * suites it means, or is handing over a `b7e-gate` log to read the failing ones out of.
 * It does not fetch `origin` — the same assumption `[[gate-reds-here-are-usually-mains]]`
 * and every prior hand-run made, that `origin/main` is kept current by the daemon and the
 * sessions sweeping this repo, not by this command.
 */
import fs from 'node:fs';
import path from 'node:path';
import { runSuite, timeoutMsFor } from './gate.js';
import { makeAtWorktree, removeAtWorktree } from './at.js';

export { REPO_ROOT } from './gate.js';

/* ------------------------------------------------------------------- extraction */

/**
 * Every `FAIL <name>` line in a suite's combined stdout+stderr, in the order printed.
 * Tolerant of the spacing/punctuation variants this repo's `check()` helpers actually
 * use (`  FAIL name`, `FAIL  name`, `FAIL - name`) — see the header for what this buys
 * and what it cannot: a suite with no such line returns `[]`, which is a suite that
 * cannot be compared by name, not a suite with zero failures.
 */
const FAIL_LINE_RE = /^\s*FAIL\b\s*[-:]?\s*(.+)$/;
export function extractFailures(output) {
  const names = [];
  for (const rawLine of String(output || '').split('\n')) {
    const m = FAIL_LINE_RE.exec(rawLine);
    if (!m) continue;
    const name = m[1].trim();
    if (name) names.push(name);
  }
  return names;
}

/* ------------------------------------------------------------- reading a gate log */

/**
 * Every suite `b7e-gate` reported `FAIL` or `TIMEOUT` for, in the order first seen, out
 * of either shape its `--log` writes: the plain `[done/total] STATUS suite secs s` line,
 * or one JSON object per line in `--json` mode (the trailing `{"summary":true,...}` line
 * has no `suite` and is ignored). Duplicates (a suite line and, further down, nothing —
 * `b7e-gate` reports each suite once) are deduped defensively rather than assumed away.
 */
export function suitesFromGateLog(text) {
  const suites = [];
  const seen = new Set();
  const take = (suite) => {
    if (suite && !seen.has(suite)) {
      seen.add(suite);
      suites.push(suite);
    }
  };
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('{')) {
      try {
        const obj = JSON.parse(line);
        if (obj && obj.suite && (obj.status === 'FAIL' || obj.status === 'TIMEOUT')) take(obj.suite);
      } catch {
        /* not JSON after all — fall through to the plain-text shape below */
      }
      continue;
    }
    const m = /^\[\d+\/\d+\]\s+(FAIL|TIMEOUT)\s+(\S+)\s/.exec(line);
    if (m) take(m[2]);
  }
  return suites;
}

/* ------------------------------------------------------------------- the worktree */

/**
 * `origin/main`, detached — `lib/at.js`'s `makeAtWorktree`, generalised (`bc-dgx7.63`) to
 * take any ref, called here with `origin/main` and `{ vendor: false }` to keep this
 * file's own behaviour exactly what it always was: `node_modules` symlinked from `root`'s
 * own, never `public/vendor` — the suites this command targets are `scripts/test.mjs`'s
 * discovery, i.e. `npm test`'s own, and browser checks — the only suites that want a
 * built `vendor/` — are not among them (`[[browser-checks-not-in-npm-test]]`).
 *
 * `root` must be a checkout of *this* repo (any worktree of it will do — `git worktree`
 * commands work from any of a repo's worktrees, they share one `.git`) with an `origin`
 * remote carrying a `main` branch.
 */
export function makeMainWorktree(root) {
  return makeAtWorktree(root, 'origin/main', { vendor: false });
}

/** `lib/at.js`'s `removeAtWorktree`, re-exported under this file's own long-standing name. */
export const removeMainWorktree = removeAtWorktree;

/* ---------------------------------------------------------------------- the blame */

/**
 * Runs `suite` in `root` exactly once. Either a terminal verdict already (`no-local`, or
 * `clean` because it passed) or `{ needsMain: true, local, localFail, timeoutMs }` for a
 * caller to compare against `origin/main` — kept separate from that comparison so
 * `runBlame` below never re-runs the local half of a suite it has already run, once per
 * suite rather than once per suite per comparison.
 */
async function runLocal(root, suite, timeoutOverrideMs) {
  if (!fs.existsSync(path.join(root, suite))) {
    return { terminal: { suite, verdict: 'no-local', detail: `${suite} does not exist in ${root}` } };
  }
  const timeoutMs = timeoutMsFor(suite, timeoutOverrideMs);
  const local = await runSuite(root, suite, { timeoutMs });
  const localFail = extractFailures(local.out);
  if (local.status === 'ok') {
    return { terminal: { suite, verdict: 'clean', localStatus: local.status, localFail: [], mainFail: null } };
  }
  return { needsMain: true, timeoutMs, local, localFail };
}

/** The comparison half, given an already-run local result and a built `origin/main` worktree. */
async function compareAgainstMain(mainDir, suite, { local, localFail, timeoutMs }) {
  if (!fs.existsSync(path.join(mainDir, suite))) {
    return {
      suite,
      verdict: 'yours',
      localStatus: local.status,
      localFail,
      mainFail: null,
      detail: `${suite} does not exist at origin/main`,
    };
  }
  const main = await runSuite(mainDir, suite, { timeoutMs });
  const mainFail = extractFailures(main.out);
  let verdict;
  if (main.status === 'ok') {
    verdict = 'yours';
  } else if (!localFail.length && !mainFail.length) {
    verdict = 'unclear';
  } else {
    const onlyLocal = localFail.filter((n) => !mainFail.includes(n));
    verdict = onlyLocal.length ? 'partial' : 'main-red';
  }
  return { suite, verdict, localStatus: local.status, mainStatus: main.status, localFail, mainFail };
}

/**
 * One suite's verdict, run against an `origin/main` worktree the caller already built
 * (see `makeMainWorktree`) — or without one, in which case a suite that turns out to
 * need a comparison resolves to `unknown` rather than building its own. `runBlame` below
 * is the caller that builds one lazily and reuses it across several suites; this is the
 * single-suite entry point for anyone else.
 *
 * Verdicts: `clean` (passes here, `origin/main` never consulted), `main-red` (fails
 * here, every named `FAIL` also fails on `origin/main` — not yours), `partial` (red on
 * both sides, but at least one named `FAIL` here is not on `origin/main` — partly
 * yours), `yours` (`origin/main` passes clean, or does not have the file at all —
 * squarely yours), `unclear` (red on both sides, but neither run named a `FAIL` — no
 * names to compare, decide by hand), `unknown` (no `origin/main` worktree to compare
 * against — inconclusive, not evidence either way), `no-local` (the suite path does not
 * exist in `root` at all — a usage mistake, most likely).
 */
export async function blameSuite(root, suite, { mainDir, timeoutOverrideMs } = {}) {
  const first = await runLocal(root, suite, timeoutOverrideMs);
  if (first.terminal) return first.terminal;
  if (!mainDir) {
    return {
      suite,
      verdict: 'unknown',
      localStatus: first.local.status,
      localFail: first.localFail,
      mainFail: null,
      detail: 'no origin/main worktree was available to compare against',
    };
  }
  return compareAgainstMain(mainDir, suite, first);
}

/**
 * Every suite in `suites`, against `root`. Builds one `origin/main` worktree the first
 * time a suite actually needs it (a run where every suite passes locally never builds
 * one at all) and removes it in a `finally`, `keepWorktree` aside — so a crash partway
 * through the list still cleans up. Returns `{ results, mainDir }`; `mainDir` is `null`
 * unless `keepWorktree` was asked for and a worktree was actually built (useful for a
 * caller that wants to poke at the failure by hand afterward).
 */
export async function runBlame(root, suites, { timeoutOverrideMs, keepWorktree = false } = {}) {
  const results = [];
  let mainDir = null;
  let mainScratchRoot = null;
  let mainSetupError = null;

  const ensureMain = () => {
    if (mainDir || mainSetupError) return;
    try {
      const made = makeMainWorktree(root);
      mainDir = made.dir;
      mainScratchRoot = made.scratchRoot;
    } catch (err) {
      mainSetupError = err;
    }
  };

  try {
    for (const suite of suites) {
      const first = await runLocal(root, suite, timeoutOverrideMs);
      if (first.terminal) {
        results.push(first.terminal);
        continue;
      }
      ensureMain();
      if (mainSetupError) {
        results.push({
          suite,
          verdict: 'unknown',
          localStatus: first.local.status,
          localFail: first.localFail,
          mainFail: null,
          detail: `could not set up an origin/main worktree — ${mainSetupError.message}`,
        });
        continue;
      }
      results.push(await compareAgainstMain(mainDir, suite, first));
    }
  } finally {
    if (mainDir && !keepWorktree) removeMainWorktree(root, mainDir, mainScratchRoot);
  }

  return { results, mainDir: keepWorktree ? mainDir : null };
}

/* ---------------------------------------------------------------------- reporting */

/** One line, no color — what a `--json`-less caller other than the CLI itself would want. */
export function verdictLine(r) {
  switch (r.verdict) {
    case 'clean':
      return `${r.suite}: passes here — nothing to blame`;
    case 'main-red':
      return `${r.suite}: red on main too — ${r.localFail.length} failing check(s), same on both sides`;
    case 'partial':
      return `${r.suite}: red on main too, but with new failures — ${r.localFail.length} here, ${r.mainFail.length} on main`;
    case 'yours':
      return `${r.suite}: green on main — yours (${r.localFail.length} failing check(s) here)`;
    case 'unclear':
      return `${r.suite}: red on both sides, but neither run named a failing check — compare by hand`;
    case 'unknown':
      return `${r.suite}: could not run at main — ${r.detail}`;
    case 'no-local':
      return `${r.suite}: ${r.detail}`;
    default:
      return `${r.suite}: ${r.verdict}`;
  }
}

/** `0` if nothing here needs your attention (every red suite is already main's, or passed outright), `1` otherwise. */
export function exitCodeFor(results) {
  return results.every((r) => r.verdict === 'clean' || r.verdict === 'main-red') ? 0 : 1;
}
