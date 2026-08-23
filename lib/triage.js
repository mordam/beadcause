/**
 * Re-run a sweep's failures alone and say which are real — `bin/b7e-triage` is the argv
 * shell; this is the parsing of a finished run's output and the serial re-run.
 *
 * bc-ka5y.15.16 names four sessions (bc-ka5y.15.5, bc-khoe.29, bc-khoe.30.4, bc-r2b5.2)
 * that each took a wide sweep's list of failed suite names and did this exact triage by
 * hand, differently: two verdicts were pure noise (a flake, or a suite that only needed
 * `scripts/vendor.js`) and two hid real reds inside the same-looking list — the argument
 * being that the list alone cannot be read; only a re-run can. This is the one answer.
 *
 * ## This is not b7e-gate
 *
 * `b7e-gate` (bc-khoe.39) runs the whole sweep concurrently and reports what failed —
 * that command owns discovery, the lock and the pool. This starts from its output (a log
 * path, or suite names directly) and finishes the job those four sessions did by hand:
 * re-running each failure alone, serially, to say whether it survives. `runSuite` and
 * `timeoutMsFor` (lib/gate.js) are reused rather than reimplemented, and this never
 * shells out to `bin/b7e-gate` itself — it takes its own per-tree lock, and triage
 * happens right after a sweep, so a caller doing that would be refused mid-triage for
 * doubling a load that has already finished.
 *
 * ## Parsing a log nobody agreed the shape of
 *
 * `b7e-gate` did not exist when three of the four sessions above ran, so each wrote its
 * own throwaway runner and none of their logs looked alike: `[n/t] FAIL <suite>` off a
 * hand-rolled pool, `FAIL <suite> (NNms)` off a `grep` of one, a bare suite name off
 * `grep -l`, a `==== FAILURES: N ====` header. `lib/blame.js`'s `suitesFromGateLog`
 * already covers `b7e-gate`'s own two *per-suite* log shapes (plain and `--json`) and is
 * reused here rather than duplicated — but not its final tally line (`P/T passed, F
 * failed: a, b, c`), which is the shape most *future* sweeps will actually hand this
 * command and which `suitesFromGateLog` was never asked to read; `parseFailures` below
 * adds that and the looser shapes the four sessions actually produced. A name with no
 * directory in it (`pagealias.mjs` rather than `test/pagealias.mjs`) is resolved against
 * the tree's own suite list by basename in `resolveSuite` — and a name that resolves to
 * none, or to more than one, is reported as `unresolved` rather than silently dropped: a
 * triage tool that drops a failure is worse than none.
 *
 * ## The three verdicts, and the one hazard in getting them
 *
 * `real` — still fails alone. `flake` — passes alone, first try. `needs vendor` — fails
 * alone, but only because `public/vendor` (gitignored) had never been built in this
 * tree; running `scripts/vendor.js` and re-running turns it green. That last fact is
 * already written down for `test/pagealias.mjs` specifically, but nothing about the
 * mechanism names that suite — it is checked generically, against whichever suite
 * actually fails with `public/vendor` missing, so any suite this tree adds that reads it
 * gets the same answer for the same reason. `scripts/vendor.js` is invoked as
 * `<root>/scripts/vendor.js` — never a path resolved through this file's own location —
 * because it roots itself from where it is *run from*, not from `--dir`
 * ([[scripts-vendor-js-roots-on-its-own-path-not-cwd]]): pointing it at the wrong copy
 * would build vendor for the wrong tree while printing a normal-looking success line.
 *
 * Every re-run is serial, one suite at a time, never beside another — removing the
 * concurrent load the first sweep ran under is the entire point of a triage step, and
 * `test/slowstart.mjs` cannot even be compared against a concurrent run: it fails only
 * there. `timeoutMsFor` already gives `*real.mjs` suites and `test/landcheck.mjs` a
 * longer budget; nothing here overrides that.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT, discoverSuites, runSuite, timeoutMsFor } from './gate.js';
import { suitesFromGateLog } from './blame.js';

export { REPO_ROOT };

/* ------------------------------------------------------------------------- parsing */

/**
 * `[n/t] FAIL <suite>` or `[n/t] TIMEOUT <suite>`, with or without a trailing duration —
 * `suitesFromGateLog`'s own version of this shape requires something after the suite
 * name (b7e-gate always prints a duration), which a hand-rolled runner's last line on a
 * suite does not always do. The captured token must itself look like a suite (end in
 * `.mjs`/`.js`) — narrower than `suitesFromGateLog`'s `\S+`, and deliberately so: unlike
 * that function, which only ever reads a log `b7e-gate` itself wrote, this also reads
 * prose a session left behind, and "FAIL" shows up there in a command example
 * (`grep FAIL branch-gate.log`) as often as in an actual result line.
 */
const BRACKET_RE = /^\[\d+\/\d+\]\s+(?:FAIL|TIMEOUT)\s+(\S+\.(?:mjs|js))/;
/** `FAIL <suite>` on its own, or followed by a `(NNms)`/`(N.Ns)` off a `grep` of a log. */
const GREP_RE = /\bFAIL\b\s*[-:]?\s*(\S+\.(?:mjs|js))/;
/** A whole line that is nothing but a suite path — the shape a `grep -l` or a hand-copied list under a `==== FAILURES ====` header leaves behind. */
const BARE_SUITE_RE = /^(?:test|scripts)\/[\w.-]+\.(?:mjs|js)$/;
/**
 * `b7e-gate`'s own final tally — `P/T passed, F failed: a, b, c` (lib/gate.js's
 * `summaryLine`) — which names every failure on one line but is not itself a per-suite
 * line, so `suitesFromGateLog` (built to read `b7e-gate`'s per-suite lines only) does
 * not see it.
 */
const SUMMARY_RE = /^\d+\/\d+\s+passed,\s*\d+\s+failed:\s*(.+)$/;

/**
 * Every suite name mentioned as a failure in `text`, in the order first seen, out of any
 * shape described above the file. Deduped. A returned name may be a full suite path
 * (`test/pagealias.mjs`) or a bare basename (`pagealias.mjs`); `resolveSuite` is what
 * turns the latter into the former against a real tree.
 */
export function parseFailures(text) {
  const names = [];
  const seen = new Set();
  const take = (name) => {
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  for (const name of suitesFromGateLog(text)) take(name);
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const m = BRACKET_RE.exec(line) || GREP_RE.exec(line);
    if (m) {
      take(m[1]);
      continue;
    }
    const summary = SUMMARY_RE.exec(line);
    if (summary) {
      for (const name of summary[1].split(',').map((s) => s.trim())) take(name);
      continue;
    }
    if (BARE_SUITE_RE.test(line)) take(line);
  }
  return names;
}

/**
 * Turns a name `parseFailures` (or a caller) hands over into a real suite path in
 * `allSuites`. An exact match wins outright; otherwise the name is matched by basename —
 * one match resolves, zero or several do not, and the reason says which. Never guesses.
 */
export function resolveSuite(name, allSuites) {
  if (allSuites.includes(name)) return { suite: name, reason: null };
  const base = path.basename(name);
  const matches = allSuites.filter((s) => path.basename(s) === base);
  if (matches.length === 1) return { suite: matches[0], reason: null };
  if (matches.length === 0) return { suite: null, reason: `no suite named ${name} found in this tree` };
  return { suite: null, reason: `${name} is ambiguous — matches ${matches.join(', ')}` };
}

/* --------------------------------------------------------------------------- vendor */

/** Best-effort `<root>/scripts/vendor.js` — `false` if it does not exist or throws. */
function buildVendor(root) {
  const script = path.join(root, 'scripts', 'vendor.js');
  if (!fs.existsSync(script)) return false;
  try {
    execFileSync(process.execPath, [script], { cwd: root, stdio: 'pipe', timeout: 60_000 });
    return true;
  } catch {
    return false;
  }
}

/* --------------------------------------------------------------------------- triage */

/**
 * Re-runs every entry in `failures` (suite paths, bare basenames, or a mix — whatever
 * `parseFailures` or a caller hands over) one at a time, never concurrently. Returns one
 * record per input, in the order given:
 *
 *   - `{ input, suite: null, verdict: 'unresolved', reason }` — no suite in this tree's
 *     own list resolves to this name, or more than one does.
 *   - `{ input, suite, verdict: 'flake', status, ms }` — passed on the first re-run.
 *   - `{ input, suite, verdict: 'needs vendor', status, ms }` — failed with
 *     `public/vendor` missing, passed once `scripts/vendor.js` had built it.
 *   - `{ input, suite, verdict: 'real', status, ms, tail }` — still fails; `tail` is the
 *     last few lines of its output.
 *
 * `scripts/vendor.js` is attempted at most once per call, the first time a re-run
 * actually fails while `public/vendor` is absent — never up front, since most triage
 * runs name suites that have nothing to do with it.
 */
export async function triage(root, failures, { timeoutOverrideMs } = {}) {
  const all = discoverSuites(root);
  const vendorPath = path.join(root, 'public', 'vendor');
  const results = [];
  let vendorAttempted = false;

  for (const input of failures) {
    const { suite, reason } = resolveSuite(input, all);
    if (!suite) {
      results.push({ input, suite: null, verdict: 'unresolved', reason });
      continue;
    }

    const timeoutMs = timeoutMsFor(suite, timeoutOverrideMs);
    let r = await runSuite(root, suite, { timeoutMs });

    if (r.status === 'ok') {
      results.push({ input, suite, verdict: 'flake', status: r.status, ms: r.ms });
      continue;
    }

    if (!vendorAttempted && !fs.existsSync(vendorPath)) {
      vendorAttempted = true;
      if (buildVendor(root)) {
        const retry = await runSuite(root, suite, { timeoutMs });
        if (retry.status === 'ok') {
          results.push({ input, suite, verdict: 'needs vendor', status: retry.status, ms: retry.ms });
          continue;
        }
        r = retry;
      }
    }

    results.push({
      input,
      suite,
      verdict: 'real',
      status: r.status,
      ms: r.ms,
      tail: String(r.out || '').trim().split('\n').slice(-15).join('\n'),
    });
  }

  return results;
}

/* ------------------------------------------------------------------------- reporting */

/** One line, no color: `<suite>   <verdict>   <secs>s`, plus a reason for `unresolved`. */
export function resultLine(r) {
  if (r.verdict === 'unresolved') return `${r.input}: unresolved — ${r.reason}`;
  const secs = (r.ms / 1000).toFixed(1);
  return `${r.suite}: ${r.verdict} (${secs}s)`;
}

/** `P/T real, F flake, V needs vendor, U unresolved` — only the non-zero counts shown. */
export function triageSummaryLine(results) {
  const total = results.length;
  const real = results.filter((r) => r.verdict === 'real').length;
  const flake = results.filter((r) => r.verdict === 'flake').length;
  const vendor = results.filter((r) => r.verdict === 'needs vendor').length;
  const unresolved = results.filter((r) => r.verdict === 'unresolved').length;
  const parts = [`${real}/${total} real`];
  if (flake) parts.push(`${flake} flake`);
  if (vendor) parts.push(`${vendor} needs vendor`);
  if (unresolved) parts.push(`${unresolved} unresolved`);
  return parts.join(', ');
}

/** `0` nothing survived triage (every failure explained away); `1` at least one is `real` or `unresolved`. */
export function exitCodeFor(results) {
  return results.some((r) => r.verdict === 'real' || r.verdict === 'unresolved') ? 1 : 0;
}
