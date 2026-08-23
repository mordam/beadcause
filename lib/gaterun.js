/**
 * The record `b7e-gate` writes as it runs, and what `b7e-watch` makes of it.
 *
 * bc-gdub.3 is the session audit that found the same twenty minutes spent by hand in
 * six sessions: launch the full suite in the background, then poll it — `tail -1
 * sweep.log`, `grep -c 'ok\|FAIL' gate.log`, `ps -o etime=` — thirty-odd times in a
 * row, each session's own spelling, one of them defeated outright by the runner's own
 * ANSI colour codes. There was nowhere to ask the question except the log, because
 * nothing wrote the answer down in a shape a program could read. This is that shape:
 * one JSONL file per gate run, a `start` line, one `result` line per suite as it
 * finishes, an `end` line when the run is over. A reader only ever parses these
 * lines — colour codes in whatever a suite printed to its own stdout cannot change
 * the answer, because nothing here greps a log.
 *
 * `bin/b7e-gate` (bc-khoe.39, landed first) is the writer, wired through its own
 * `onResult` callback; `bin/b7e-watch` is the reader. Whether a red suite is already
 * red on `origin/main` is deliberately not this file's job — `lib/blame.js`
 * (`bin/b7e-blame`, bc-khoe.42) already runs exactly that comparison, by named check
 * rather than by exit code, with its own tested worktree-and-timeout handling; a
 * second implementation here would be the "three separately-built control sets"
 * mistake the epic (bc-dgx7) exists to avoid repeating. `bin/b7e-watch` calls
 * `runBlame` directly for whichever suites are still red.
 *
 * Runs live at `<mainCheckout>/.claude/gate-runs`, deliberately outside every
 * worktree's own working tree — inside one, `git add -A` at delivery time would sweep
 * a live run's own JSONL file onto whichever branch happened to be open (see the
 * `gate-config-dir-must-be-outside-the-worktree` memory note this shape is built to
 * avoid repeating). Two worktrees, two sessions, therefore see the same directory: a
 * run started in one is readable from any other by `--run <id>`.
 *
 * Not registered in `lib/evidence.js`: these are churn, gone with the worktree they
 * describe, the same shape as `logs/` and `workers/` under `~/.config/beadcause` —
 * and they never touch `CONFIG_DIR` or a `refs/beadcause/*` ref, which is the only
 * thing `test/evidence.mjs` actually watches for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { git, ok, mainCheckout } from './gitref.js';

/** `<mainCheckout>/.claude/gate-runs`, created on first write. */
export async function runsDir(cwd) {
  const main = await mainCheckout(cwd);
  return path.join(main, '.claude', 'gate-runs');
}

/**
 * `worktree-b7e-watch-gdub3`, or `main` for the main checkout itself — the slug a run
 * is filed under, so "this worktree's most recent run" is a filename prefix and never
 * a scan of every run's contents.
 */
export async function worktreeSlug(cwd) {
  const main = await mainCheckout(cwd);
  const real = fs.realpathSync(path.resolve(cwd));
  const mainReal = fs.realpathSync(main);
  if (real === mainReal) return 'main';
  const rel = path.relative(mainReal, real);
  const parts = rel.split(path.sep);
  // `.claude/worktrees/<name>/...` — every worktree in this repo lives there.
  const i = parts.indexOf('worktrees');
  if (i > -1 && parts[i - 1] === '.claude' && parts[i + 1]) return parts[i + 1];
  return 'main';
}

const pad = (n, w = 2) => String(n).padStart(w, '0');
/**
 * Millisecond resolution, not just seconds — a run id also decides sort order
 * (`listRunFiles` sorts by filename, newest first), and two runs of a fast suite
 * started back to back can land in the same second.
 */
function stamp(d = new Date()) {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(
    d.getUTCMinutes()
  )}${pad(d.getUTCSeconds())}${pad(d.getUTCMilliseconds(), 3)}Z`;
}

/** A run id is also its filename stem: `<worktree>-<timestamp>-<rand>`. */
function newRunId(slug) {
  const rand = Math.random().toString(36).slice(2, 6);
  return `${slug}-${stamp()}-${rand}`;
}

function fileFor(dir, runId) {
  return path.join(dir, `${runId}.jsonl`);
}
export function runFile(dir, runId) {
  return fileFor(dir, runId);
}

/**
 * Starts a run: picks an id, writes the `start` line, returns `{ runId, file }` for
 * the caller to pass to `appendResult`/`endRun`. Throws if `cwd` is not inside a git
 * checkout — a caller running against a fabricated, non-git test tree (`b7e-gate
 * --dir <scratch>` in `test/gate.mjs`) is expected to catch that and record nothing,
 * rather than this function guessing at a location to write to.
 */
export async function startRun(cwd, { suites, label } = {}) {
  const dir = await runsDir(cwd);
  fs.mkdirSync(dir, { recursive: true });
  const slug = await worktreeSlug(cwd);
  const runId = newRunId(slug);
  const file = fileFor(dir, runId);
  const branch = ((await ok(git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']))) || '').trim();
  const line = {
    type: 'start',
    runId,
    at: new Date().toISOString(),
    total: suites.length,
    suites,
    worktree: slug,
    cwd: path.resolve(cwd),
    branch,
    label: label || undefined,
  };
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
  return { runId, file };
}

/** One suite's result, appended as it finishes. `status` is `'ok'` or `'fail'`. */
export function appendResult(file, { suite, status, elapsed, tail }) {
  const line = { type: 'result', suite, status, elapsed, at: new Date().toISOString() };
  if (tail) line.tail = tail;
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
}

/** Closes the run out. `status` is `'ok'` if nothing failed, else `'fail'`. */
export function endRun(file, { status, elapsed }) {
  const line = { type: 'end', at: new Date().toISOString(), status, elapsed };
  fs.appendFileSync(file, JSON.stringify(line) + '\n');
}

/**
 * Every run file in the directory, newest first by the timestamp in its own name —
 * not by mtime, which an `rsync` or a restored backup can leave meaning nothing.
 */
export function listRunFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse()
    .map((f) => path.join(dir, f));
}

/**
 * Parses one run file into a summary. Never throws on a malformed line — a run file
 * read while its writer is mid-`appendFileSync` can end in a torn last line, and
 * that is "still running", not a reason to blow up the caller.
 */
export function readRun(file) {
  const runId = path.basename(file, '.jsonl');
  const raw = fs.readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  let start = null;
  let end = null;
  const bySuite = new Map(); // last result wins, in case a suite is ever re-run within one file
  for (const l of lines) {
    let obj;
    try {
      obj = JSON.parse(l);
    } catch {
      continue; // torn line — the writer was mid-append
    }
    if (obj.type === 'start') start = obj;
    else if (obj.type === 'end') end = obj;
    else if (obj.type === 'result' && obj.suite) bySuite.set(obj.suite, obj);
  }
  const results = [...bySuite.values()];
  const failed = results.filter((r) => r.status === 'fail');
  const startedAt = start ? Date.parse(start.at) : NaN;
  const now = end ? Date.parse(end.at) : Date.now();
  return {
    runId,
    file,
    running: !end,
    total: start ? start.total : null,
    done: results.length,
    failed: failed.map((f) => f.suite),
    worktree: start ? start.worktree : null,
    branch: start ? start.branch : null,
    startedAt: start ? start.at : null,
    endedAt: end ? end.at : null,
    elapsedSeconds: Number.isFinite(startedAt) ? Math.round((now - startedAt) / 1000) : null,
    status: end ? end.status : 'running',
  };
}

/**
 * The most recent run for a worktree — filename-prefix match, so this never opens a
 * file it does not need to. `--run <id>` in `bin/b7e-watch` skips straight to
 * `readRun(runFile(dir, id))` instead and needs none of this.
 */
export async function latestRunFor(cwd, { worktree } = {}) {
  const dir = await runsDir(cwd);
  const slug = worktree || (await worktreeSlug(cwd));
  const files = listRunFiles(dir).filter((f) => path.basename(f).startsWith(`${slug}-`));
  return files.length ? files[0] : null;
}
