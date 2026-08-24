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
 *      line. A block's verdict is read the way `lib/blame.js`'s `extractFailures`
 *      already reads any suite's own `FAIL` lines: none between one announcement
 *      and the next (or EOF) is a pass. This is the shape three of the six sessions
 *      above actually left behind — a suite run in its own Bash call, one at a
 *      time, because the worktree guard refuses a loop — and it predates
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
 * ran — not by tracing a real import graph. A file reached through an indirection
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
  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.trim();
    if (!line.startsWith('{')) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    if (obj && obj.suite && obj.status) out.push({ suite: obj.suite, status: obj.status === 'ok' ? 'ok' : 'fail' });
  }
  return out;
}

/** Every `[n/t] STATUS suite secs` line `b7e-gate`'s plain `--log` writes. */
function parsePlainLines(text) {
  const out = [];
  for (const rawLine of String(text || '').split('\n')) {
    const m = PLAIN_LINE_RE.exec(rawLine.trim());
    if (m) out.push({ suite: m[4], status: m[3] === 'ok' ? 'ok' : 'fail' });
  }
  return out;
}

/**
 * A shell transcript: each `node <suite>` (or `$ node <suite>`) line opens a block
 * that runs to the next such line or EOF; the block's verdict is `fail` if
 * `extractFailures` finds a named `FAIL` line inside it, `ok` otherwise.
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
    const failed = extractFailures(block).length > 0;
    return { suite: mark.suite, status: failed ? 'fail' : 'ok' };
  });
}

/**
 * Every `{suite, status}` a log's text carries, trying every shape above and folding
 * the results together — a log can mix (a hand-run suite pasted above a `b7e-gate
 * --log` tail is real). A suite mentioned more than once keeps its last verdict,
 * the same "last result wins" rule `readRun` applies to its own file.
 */
export function parseLogText(text) {
  const found = [...parseJsonLines(text), ...parsePlainLines(text), ...parseTranscript(text)];
  const bySuite = new Map();
  for (const r of found) bySuite.set(r.suite, r.status);
  return [...bySuite.entries()].map(([suite, status]) => ({ suite, status }));
}

/* ===================================================================== *
 * one log source, normalised
 * ===================================================================== */

/** The `suites` array a `lib/gaterun.js` run record's own `start` line names — a read of one known field, not a second copy of `readRun`. */
function plannedSuitesFromRunFile(filePath) {
  try {
    const firstLine = fs
      .readFileSync(filePath, 'utf8')
      .split('\n')
      .find((l) => l.trim());
    const obj = JSON.parse(firstLine);
    return Array.isArray(obj.suites) ? obj.suites : [];
  } catch {
    return [];
  }
}

/**
 * One log path, normalised to `{ label, at, running, suites, attempted, passed,
 * failed }` — `suites` is every suite name this source names at all (passed or
 * failed), which is what diff-coverage checks against; `failed` is just the red
 * ones, which is what gets asked of `runBlame`. Throws only if `filePath` cannot be
 * read at all.
 */
export function readLogSource(filePath) {
  const text = fs.readFileSync(filePath, 'utf8');
  if (path.extname(filePath) === '.jsonl' || looksLikeRunRecord(text)) {
    const r = readRun(filePath);
    return {
      label: `b7e-gate run ${r.runId} (${r.worktree || '?'})`,
      at: r.startedAt || null,
      running: r.running,
      suites: plannedSuitesFromRunFile(filePath),
      attempted: r.done,
      passed: r.done - r.failed.length,
      failed: r.failed,
    };
  }
  const entries = parseLogText(text);
  const failed = entries.filter((e) => e.status === 'fail').map((e) => e.suite);
  return {
    label: filePath,
    at: fs.statSync(filePath).mtime.toISOString(),
    running: false,
    suites: entries.map((e) => e.suite),
    attempted: entries.length,
    passed: entries.length - failed.length,
    failed,
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
      sources.push({ label: p, error: err.message, suites: [], attempted: 0, passed: 0, failed: [] });
    }
  }

  const evidenced = sources.filter((s) => s.attempted > 0);
  if (!evidenced.length) {
    return { ok: false, reason: 'no run evidenced — no readable gate log named or found', sources };
  }

  const attempted = evidenced.reduce((n, s) => n + s.attempted, 0);
  const passed = evidenced.reduce((n, s) => n + s.passed, 0);
  const failedNames = [...new Set(evidenced.flatMap((s) => s.failed))];
  const allSuiteNames = [...new Set(evidenced.flatMap((s) => s.suites))];

  const blamed = failedNames.length ? (await runBlame(root, failedNames)).results : [];

  const diffFiles = touchedFiles(root, since);
  const uncovered = uncoveredFiles(root, diffFiles, allSuiteNames);

  return {
    ok: true,
    sources: evidenced,
    attempted,
    passed,
    blamed,
    since,
    diffFiles,
    uncovered,
    line: formatLine({ sources: evidenced, attempted, passed, blamed, since, diffFiles, uncovered }),
  };
}

/** The one line — fit for a delivery's `--tests` string. */
export function formatLine({ sources, attempted, passed, blamed, since, diffFiles, uncovered }) {
  const parts = [];
  const runners = sources.map((s) => `${s.label}${s.at ? ` at ${s.at}` : ''}${s.running ? ' (still running)' : ''}`);
  parts.push(`${runners.length} run${runners.length === 1 ? '' : 's'} (${runners.join('; ')})`);
  parts.push(`${passed}/${attempted} passed`);
  parts.push(blamed.length ? blamed.map(verdictLine).join('; ') : 'no reds');
  if (diffFiles.length) {
    parts.push(
      uncovered.length
        ? `diff ${since}...HEAD touches ${uncovered.length} file(s) no suite here covers: ${uncovered.join(', ')}`
        : `diff ${since}...HEAD: every touched file is covered by a suite that ran`
    );
  }
  return parts.join('; ');
}
