/**
 * What actually ran here and what it said, in the sentence a delivery's `--tests`
 * wants — `bin/b7e-verified` is the argv shell; this is the log reading, the
 * red/green judgement and the diff-coverage check.
 *
 * bc-36xx.27: six sessions (bc-36xx.18, bc-khoe.30.8, bc-ka5y.16, bc-42ow.6,
 * bc-xl7n.76.1, bc-dgx7.8) each composed a `--tests` string by hand, from memory,
 * after a run that had scrolled past hours earlier, and no two used the same shape.
 * `bc-36xx.18` is the one worth naming: it attested `test/approval.mjs` was "a
 * pre-existing bug on main" when it was not — a missing `node_modules` symlink in
 * its OWN worktree, not main — and only found out after delivering, by hand, the
 * evidence for which was sitting on disk the whole time. This reads that evidence
 * back instead of asking a session to recall it.
 *
 * ## What counts as "a run"
 *
 * Any of three machine-written shapes:
 *
 *   1. A `lib/gaterun.js` run record (`.claude/gate-runs/*.jsonl`, written by
 *      `bin/b7e-gate` as it runs) — read with `readRun`, never re-parsed by hand.
 *   2. `bin/b7e-gate`'s own `--log` text (`[n/t] STATUS suite secs`, one line per
 *      suite) or its `--json` shape (one JSON object per suite, the trailing
 *      `{"summary":true,...}` line ignored).
 *   3. A shell transcript — a session's own scratchpad capture of running suites one
 *      at a time, each announced by a `$ node <suite>` (or bare `node <suite>`)
 *      line. A block's verdict is read by `transcriptVerdict`, which requires
 *      positive evidence of a pass rather than treating a missing `FAIL` line as
 *      one — see its docblock, and note that reading absence-of-`FAIL` as green is
 *      bc-36xx.18's own mistake, not a hypothetical. This is the shape three of the
 *      six sessions above actually left behind — a suite run in its own Bash call,
 *      one at a time, because the worktree guard refuses a loop — and it predates
 *      `bin/b7e-gate` entirely.
 *
 * A log matching none of these contributes no suites and is not silently counted as
 * partial evidence — a report that half-reads a hand-written narrative is worse than
 * one that says outright it found nothing to read.
 *
 * ## Auto-discovery, with no logs named
 *
 * Exactly one source: this worktree's most recent `lib/gaterun.js` run
 * (`latestRunFor`), which is scoped to a worktree by construction — the same
 * `runsDir`/`worktreeSlug` pair `bin/b7e-watch` reads. `bin/b7e-gate`'s own default
 * `--log` destination (`beadcause-gate-<pid>.log`, flat in `os.tmpdir()`) was
 * deliberately NOT added as a second source: nothing in that filename says which
 * worktree or which repo wrote it, so a scan of `os.tmpdir()` for one would as
 * happily return a stale log from an unrelated session on the same Mac as this
 * worktree's own — silently wrong in the permissive direction, which is worse than
 * finding nothing. `--log`-only callers are expected to name the path.
 *
 * Best-effort and silent when nothing is there; auto-discovery never replaces
 * giving explicit log paths.
 *
 * ## Red suites: never a second red/green implementation
 *
 * `lib/blame.js`'s `runBlame` (and its `verdictLine`) is reused as-is for whether a
 * red suite is already red on `origin/main` — the exact comparison `bin/b7e-blame`
 * and `bin/b7e-watch` already make, by named check rather than by exit code. This
 * file decides only which suites to ask it about.
 *
 * ## Diff coverage is best-effort, and says so
 *
 * "No suite covered this file" is decided the cheap way — whether the file's own
 * path (or its basename) appears as a substring in the source of any suite that
 * ran — not by tracing a real import graph. "That ran" is meant strictly: a suite a
 * run merely *planned* is never counted, because `latestRunFor` returns unfinished
 * runs and so auto-discovery reads one by default. A file reached through an indirection
 * this cannot see (a second `import` hop, a path built at runtime) can still be
 * silently uncovered by this measure; it is a lead to check by hand, not proof.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { REPO_ROOT } from './gate.js';
import { runBlame, verdictLine, extractFailures } from './blame.js';
import { readRun, latestRunFor } from './gaterun.js';

export { REPO_ROOT };

/* ===================================================================== *
 * parsing one log's text
 * ===================================================================== */

const PLAIN_LINE_RE = /^\[(\d+)\/(\d+)\]\s+(ok|FAIL|TIMEOUT)\s+(\S+\.(?:mjs|js))\s/;
const RUN_ANNOUNCE_RE = /^\$?\s*node\s+(\S+\.(?:mjs|js))\b/;

/**
 * What a transcript block's own output is allowed to prove. `lib/blame.js`'s
 * `extractFailures` is the `FAIL` half and is reused as-is; these are the two halves
 * it deliberately does not answer, because reading a machine-written `b7e-gate` log
 * never needed them:
 *
 *   - `CRASH_RE` — node's own death rattle. A suite that dies before its first check
 *     prints an error headline, a `throw` and stack frames, and never prints a single
 *     `FAIL <name>` line. That is bc-36xx.18 exactly: a missing `node_modules`
 *     symlink killed `test/approval.mjs` with `ERR_MODULE_NOT_FOUND`, and the session
 *     read the absent `FAIL` as a pass.
 *   - `CHECK_OK_RE`/`PASS_SUMMARY_RE` — positive evidence that a check actually
 *     completed: this repo's own per-check `ok <name>` convention (the one
 *     `lib/blame.js`'s header names), node's TAP `ok 1 - name`, and the `N checks
 *     passed` summary its suites end on. `CHECK_FAIL_RE`, `FAIL_SUMMARY_RE` and
 *     `RATIO_SUMMARY_RE` are the losing counterparts, for the suites that report a
 *     tick-mark or a tally instead of a named `FAIL` line.
 *
 * All of them are read off ANSI-stripped lines. `lib/gaterun.js`'s own header records a
 * session whose hand-rolled `grep -c 'ok\|FAIL'` was "defeated outright by the
 * runner's own ANSI colour codes", and a pasted terminal transcript is the one shape
 * here that carries them — a JSONL record and a `--log` file do not.
 */
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (line) => String(line).replace(ANSI_RE, '');

/* A named failure this repo's own check helpers print, beyond the `FAIL <name>` line
 * `extractFailures` already reads: a tick-mark convention, and a losing tally. */
const CHECK_FAIL_RE = /^\s*(?:✗|✘|×)/;
const FAIL_SUMMARY_RE = /\b\d+\s+of\s+\d+\s+(?:checks?\s+)?failed\b/;
const RATIO_SUMMARY_RE = /(\d+)\s*\/\s*(\d+)\s+checks?\s+passed\b/;

/* Positive evidence that the check convention actually ran: a per-check `ok`/`✓`
 * line (this repo's, and node's own TAP `ok 1 - name`), or a `N checks passed` tally. */
const CHECK_OK_RE = /^\s*(?:ok|OK|PASS|✓|✔)\b/;
const PASS_SUMMARY_RE = /\bchecks?\s+passed\b/;

/* Node's own death rattle: an error headline, a stack frame, a `throw`, an internal
 * module path. `Error [ERR_MODULE_NOT_FOUND]:` — bc-36xx.18's — matches all four. */
const CRASH_RE =
  /^\s*(?:[A-Za-z_$][\w$]*Error(?:\s*\[[A-Z0-9_]+\])?\s*:|throw\b|at\s+\S.*:\d+:\d+\)?\s*$|node:internal\b)/;

/** `true` if `text`'s first non-blank line parses as JSON carrying a `type` field — a `lib/gaterun.js` run record. */
export function looksLikeRunRecord(text) {
  const firstLine = String(text || '')
    .split('\n')
    .find((l) => l.trim());
  if (!firstLine) return false;
  try {
    const obj = JSON.parse(firstLine);
    return Boolean(obj && typeof obj === 'object' && 'type' in obj);
  } catch {
    return false;
  }
}

/** Every `{"suite":..,"status":..}` line `b7e-gate --json` writes; the trailing `{"summary":true,...}` line has no `suite` and is skipped. */
function parseJsonLines(text) {
  const out = [];
  String(text || '')
    .split('\n')
    .forEach((rawLine, at) => {
      const line = rawLine.trim();
      if (!line.startsWith('{')) return;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        return;
      }
      if (obj && obj.suite && obj.status) {
        out.push({ suite: obj.suite, status: obj.status === 'ok' ? 'ok' : 'fail', at });
      }
    });
  return out;
}

/** Every `[n/t] STATUS suite secs` line `b7e-gate`'s plain `--log` writes. */
function parsePlainLines(text) {
  const out = [];
  String(text || '')
    .split('\n')
    .forEach((rawLine, at) => {
      const m = PLAIN_LINE_RE.exec(rawLine.trim());
      if (m) out.push({ suite: m[4], status: m[3] === 'ok' ? 'ok' : 'fail', at });
    });
  return out;
}

/**
 * One transcript block's verdict, from what it printed and nothing else — there is no
 * exit code in a transcript to fall back on.
 *
 * `lib/blame.js` is explicit that its `extractFailures` returning `[]` means "cannot be
 * compared by name", **not** "zero failures", and it only ever asks after it already
 * knows the suite's exit status. A transcript reader has no such second opinion, so
 * "no `FAIL` line" cannot be read as a pass: that is exactly how a suite that died
 * before running a single check — `bc-36xx.18`'s missing `node_modules` symlink, which
 * is the incident this whole command is named for — comes back green. So a block is:
 *
 *   - `fail` if it names a failure (`extractFailures`, a `✗` line, a `2 of 28 failed`
 *     or a short `1/2 checks passed` tally) **or** if it carries Node's own death
 *     rattle (an `Error` headline, a stack frame, a `throw`, a `node:internal` path);
 *   - `ok` only on positive evidence that this repo's check convention actually ran —
 *     an `ok <name>`/`✓ <name>` line, or a full `N checks passed` tally;
 *   - `unknown` otherwise, which is a block that proves nothing either way and is
 *     counted as neither passed nor red, and named in the report as unreadable.
 *
 * `unknown` is deliberately not handed to `runBlame`: re-running is what `b7e-gate`
 * and `b7e-blame` are for, and a report that quietly re-ran a suite to fill in a gap
 * in the evidence it was handed would be reporting on a run its caller never made.
 */
function transcriptVerdict(block) {
  const lines = block.split('\n').map(stripAnsi);
  if (extractFailures(lines.join('\n')).length) return 'fail';
  let sawPass = false;
  for (const line of lines) {
    if (CHECK_FAIL_RE.test(line) || FAIL_SUMMARY_RE.test(line)) return 'fail';
    const ratio = RATIO_SUMMARY_RE.exec(line);
    if (ratio) {
      if (Number(ratio[1]) < Number(ratio[2])) return 'fail';
      sawPass = true;
      continue;
    }
    if (CHECK_OK_RE.test(line) || PASS_SUMMARY_RE.test(line)) {
      sawPass = true;
      continue;
    }
    if (CRASH_RE.test(line)) return 'fail';
  }
  return sawPass ? 'ok' : 'unknown';
}

/**
 * A shell transcript: each `node <suite>` (or `$ node <suite>`) line opens a block that
 * runs to the next such line or EOF, and `transcriptVerdict` reads that block. The
 * entry is stamped with the announcement's own line number, not the block's end — a
 * re-run's verdict belongs at the point the re-run was launched, which is what makes
 * `parseLogText`'s last-wins fold below mean "last in the log".
 */
function parseTranscript(text) {
  const lines = String(text || '').split('\n');
  const marks = [];
  lines.forEach((line, i) => {
    const m = RUN_ANNOUNCE_RE.exec(line.trim());
    if (m) marks.push({ i, suite: m[1] });
  });
  return marks.map((mark, idx) => {
    const end = idx + 1 < marks.length ? marks[idx + 1].i : lines.length;
    const block = lines.slice(mark.i + 1, end).join('\n');
    return { suite: mark.suite, status: transcriptVerdict(block), at: mark.i };
  });
}

/**
 * Every `{suite, status}` a log's text carries, trying every shape above and folding
 * the results together — a log can mix (a hand-run suite pasted above a `b7e-gate
 * --log` tail is real). A suite mentioned more than once keeps the verdict written
 * **latest in the file**, the same "last result wins" rule `readRun` applies to its
 * own file: every parser stamps each entry with the line it read it off, and the fold
 * runs in that order rather than in parser order. Concatenating the parsers and
 * folding raw would instead let whichever parser ran last always win — which put the
 * transcript reader, the one shape with no exit code behind it, permanently on top of
 * `b7e-gate`'s own log in exactly the mixed file this docblock says is real.
 */
export function parseLogText(text) {
  const found = [...parseJsonLines(text), ...parsePlainLines(text), ...parseTranscript(text)].sort(
    (a, b) => a.at - b.at
  );
  const bySuite = new Map();
  for (const r of found) bySuite.set(r.suite, r.status);
  return [...bySuite.entries()].map(([suite, status]) => ({ suite, status }));
}

/* ===================================================================== *
 * one log source, normalised
 * ===================================================================== */

/**
 * The two suite rosters a `lib/gaterun.js` run file names about itself: `planned`,
 * the `suites` array on its own `start` line, and `ran`, the suites that have
 * actually written a `result` line. A read of two known fields, not a second copy of
 * `readRun` — which exposes only counts and the failed names, and so cannot answer
 * "which suites actually ran".
 *
 * The distinction is load-bearing and not a tidiness: a run record is written as the
 * run goes, so a still-running run names its whole plan on line one and has results
 * for a prefix of it. Only `ran` may be handed to `uncoveredFiles` — crediting a
 * touched file to a suite that has not started yet is precisely the false green this
 * command exists to catch. Torn last lines are skipped for the same reason `readRun`
 * skips them: a reader can open the file mid-`appendFileSync`.
 */
function rostersFromRunFile(filePath) {
  const planned = [];
  const ran = [];
  try {
    for (const raw of fs.readFileSync(filePath, 'utf8').split('\n')) {
      const line = raw.trim();
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // torn line — the writer was mid-append
      }
      if (obj.type === 'start' && Array.isArray(obj.suites)) planned.push(...obj.suites);
      else if (obj.type === 'result' && obj.suite && !ran.includes(obj.suite)) ran.push(obj.suite);
    }
  } catch {
    /* unreadable — no roster, which reads as "no suite covered anything" */
  }
  return { planned, ran };
}

/**
 * One log path, normalised to `{ label, at, running, suites, planned, attempted,
 * passed, failed, unknown }`.
 *
 * `suites` is the roster diff-coverage is allowed to check against, and it is every
 * suite this source shows a **result** for — never a suite it merely shows a plan to
 * run. For a `lib/gaterun.js` record those differ whenever the run is unfinished, and
 * an unfinished run is the ordinary case here: `latestRunFor` happily returns a run
 * still being written, so auto-discovery hits it by default. Crediting a touched file
 * to a planned-but-unstarted suite would let the one command whose job is to stop
 * false `--tests` claims make one itself.
 *
 * `planned` is kept alongside so the report can say how much of the run this is,
 * rather than printing `1/1 passed` for one suite of a planned four hundred.
 * `failed` is the red ones, which is what gets asked of `runBlame`; `unknown` is the
 * suites whose own output stated no verdict either way. Throws only if `filePath`
 * cannot be read at all.
 */
export function readLogSource(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (path.extname(filePath) === '.jsonl' || looksLikeRunRecord(text)) {
    const r = readRun(filePath);
    const { planned, ran } = rostersFromRunFile(filePath);
    return {
      label: `b7e-gate run ${r.runId} (${r.worktree || '?'})`,
      at: r.startedAt || null,
      running: r.running,
      suites: ran,
      planned: planned.length || r.total || 0,
      attempted: r.done,
      passed: r.done - r.failed.length,
      failed: r.failed,
      unknown: [],
    };
  }
  const entries = parseLogText(text);
  const failed = entries.filter((e) => e.status === 'fail').map((e) => e.suite);
  const unknown = entries.filter((e) => e.status === 'unknown').map((e) => e.suite);
  return {
    label: filePath,
    at: fs.statSync(filePath).mtime.toISOString(),
    running: false,
    // Result-bearing only, the same rule the `.jsonl` branch above applies: a block
    // that stated no verdict is a suite that may have died at its first `import`,
    // and its own source still mentions every file it would have covered.
    suites: entries.filter((e) => e.status !== 'unknown').map((e) => e.suite),
    planned: entries.length,
    attempted: entries.length,
    passed: entries.length - failed.length - unknown.length,
    failed,
    unknown,
  };
}

/* ===================================================================== *
 * auto-discovery
 * ===================================================================== */

/**
 * This worktree's most recent `lib/gaterun.js` run, if any — see the file header
 * for why that is the only source auto-discovery trusts. `cwd` need not be a real
 * git checkout at all (a fabricated test tree given as `--dir` is not); a lookup
 * that cannot resolve one finds nothing rather than throwing.
 */
export async function discoverLogPaths(cwd) {
  try {
    const latest = await latestRunFor(cwd);
    return latest ? [latest] : [];
  } catch {
    return []; // not a git checkout, or no gate-runs directory yet
  }
}

/** Log paths, and directories among them expanded to the `.jsonl`/`.log`/`.txt` files inside — one level, not recursive. */
function expandPaths(paths) {
  const out = [];
  for (const p of paths) {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
      for (const name of fs
        .readdirSync(p)
        .filter((n) => n.endsWith('.jsonl') || n.endsWith('.log') || n.endsWith('.txt'))
        .sort()) {
        out.push(path.join(p, name));
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

/* ===================================================================== *
 * diff coverage
 * ===================================================================== */

/** Every file `since...HEAD` touches, in `root` — `[]` on any git failure rather than throwing, the same shape `bin/b7e-owes.js`'s own `--rev` reading uses. */
export function touchedFiles(root, since) {
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${since}...HEAD`], { cwd: root, encoding: 'utf8' });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Of `files`, the ones whose own path (or basename) is not a substring of any
 * suite's own source, among `suites` (paths relative to `root`) — see the file
 * header for what this proves and what it does not.
 */
export function uncoveredFiles(root, files, suites) {
  if (!files.length || !suites.length) return files.slice();
  const source = suites
    .map((s) => {
      try {
        return fs.readFileSync(path.join(root, s), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  return files.filter((f) => !source.includes(f) && !source.includes(path.basename(f)));
}

/* ===================================================================== *
 * the report
 * ===================================================================== */

/**
 * The whole answer: reads every log (given, or discovered), tallies suites passed
 * over attempted, asks `runBlame` about every suite that came up red, and checks the
 * diff for files no suite named here even mentions.
 *
 * `{ ok: false, reason }` when nothing evidences a run — no path given resolved to a
 * readable log naming at least one suite, and nothing was found to auto-discover.
 * Otherwise `{ ok: true, line, sources, attempted, passed, blamed, diff }`.
 */
export async function buildReport(root, logPaths, { since = 'main' } = {}) {
  const given = logPaths && logPaths.length ? logPaths : await discoverLogPaths(root);
  const expanded = expandPaths(given);

  const sources = [];
  for (const p of expanded) {
    try {
      sources.push(readLogSource(p));
    } catch (err) {
      sources.push({ label: p, error: err.message, suites: [], attempted: 0, passed: 0, failed: [], unknown: [] });
    }
  }

  const evidenced = sources.filter((s) => s.attempted > 0);
  if (!evidenced.length) {
    return { ok: false, reason: 'no run evidenced — no readable gate log named or found', sources };
  }

  const attempted = evidenced.reduce((n, s) => n + s.attempted, 0);
  const passed = evidenced.reduce((n, s) => n + s.passed, 0);
  const failedNames = [...new Set(evidenced.flatMap((s) => s.failed))];
  const unknownNames = [...new Set(evidenced.flatMap((s) => s.unknown || []))].filter(
    (n) => !failedNames.includes(n)
  );
  // Only the suites this evidence shows a RESULT for — never a run's planned roster.
  const allSuiteNames = [...new Set(evidenced.flatMap((s) => s.suites))];

  const blamed = failedNames.length ? (await runBlame(root, failedNames)).results : [];

  const diffFiles = touchedFiles(root, since);
  const uncovered = uncoveredFiles(root, diffFiles, allSuiteNames);

  const shape = { sources: evidenced, attempted, passed, blamed, unknown: unknownNames, since, diffFiles, uncovered };
  return { ok: true, ...shape, line: formatLine(shape) };
}

/**
 * The one line — fit for a delivery's `--tests` string.
 *
 * A source that has not finished says so twice: `(still running)`, and the count of
 * how many of its planned suites have actually reported. `12/12 passed` off a run
 * that has 12 results out of a planned 421 is true and useless, and reads in a
 * delivery as if the gate were green.
 */
export function formatLine({ sources, attempted, passed, blamed, unknown = [], since, diffFiles, uncovered }) {
  const parts = [];
  const runners = sources.map((s) => {
    const partial = s.planned > s.attempted ? `, ${s.attempted} of ${s.planned} suites so far` : '';
    return `${s.label}${s.at ? ` at ${s.at}` : ''}${s.running ? ' (still running)' : ''}${partial}`;
  });
  parts.push(`${runners.length} run${runners.length === 1 ? '' : 's'} (${runners.join('; ')})`);
  parts.push(`${passed}/${attempted} passed`);
  parts.push(blamed.length ? blamed.map(verdictLine).join('; ') : 'no reds');
  if (unknown.length) {
    parts.push(`${unknown.length} suite(s) whose output states no verdict either way: ${unknown.join(', ')}`);
  }
  if (diffFiles.length) {
    parts.push(
      uncovered.length
        ? `diff ${since}...HEAD touches ${uncovered.length} file(s) no suite here covers: ${uncovered.join(', ')}`
        : `diff ${since}...HEAD: every touched file is covered by a suite that ran`
    );
  }
  return parts.join('; ');
}
