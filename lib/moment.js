/**
 * `b7e-moment` — what else was this machine doing at a given instant, joined from
 * sources that already exist and had never been read together.
 *
 * bc-dgx7.55 is the session audit's finding: three auto-filed `app-error` beads
 * (bc-19vt, bc-y8wf, bc-l8ub), three sessions, the same opening question — what was
 * happening on this Mac at the bead's `created_at` — and three different hand-rolled
 * answers, none reusable by the next session.
 *
 * - `bc-19vt` read the daemon log by hand: `grep -n "api/queues"
 *   ~/Library/Logs/beadcause.log | tail -20`, then `sed -n <n>,<n+25>p` on a
 *   21,878,663-byte file. The diagnosis — `[cache] board: gave up its refresh slot
 *   after 150s` beside `slow GET /api/queues 150057ms cold` — took ten minutes to find
 *   because the answer was in the log and nowhere in the code.
 * - `bc-y8wf` never opened the log. It grepped `~/.config/beadcause/deploys` for the
 *   hour by hand, found one surviving record and nothing conclusive, then listed
 *   `app-error` beads to see what else had been filed around it.
 * - `bc-l8ub` did neither. It filtered `bd list --json` for `app-error` by hand and
 *   cross-referenced `git log --since/--until` on this repo, and that pairing —
 *   another `app-error` bead three minutes earlier, two merges either side, merges here
 *   self-deploy — was the actual finding.
 *
 * Four sources, each already implemented somewhere else in this tree and never joined:
 * `lib/deploy.js` (deploy records, `reportingQuiet`'s window logic), `lib/logstamp.js`
 * (the daemon log's own ISO-stamp format and path), `lib/errors.js` (the `app-error`
 * label and the occurrence-comment shapes a recurring report already writes), and
 * `lib/gitref.js` (`git log`, already wrapped with a stable identity). This module is
 * the join; `bin/b7e-moment` is the argv parsing and the printing around it.
 *
 * **One block per source, and a source with nothing to say, says so.** The failure this
 * replaces is not "the data wasn't there" — every one of the three hand answers found
 * *something* — it is that omitting a source that came back empty is indistinguishable
 * from never having asked it. `momentReport` below always returns all five keys.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

import { listDeploys } from './deploy.js';
import { ERROR_LABEL } from './errors.js';
import { git } from './gitref.js';

/** Where launchd points the daemon's stdout/stderr — see lib/logstamp.js. */
export const DAEMON_LOG = path.join(os.homedir(), 'Library', 'Logs', 'beadcause.log');

/** `--window 15m` default — either side of the moment. */
export const DEFAULT_WINDOW_MS = 15 * 60_000;

const WINDOW_RE = /^(\d+)(ms|s|m|h)?$/;
const UNIT_MS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** `"15m"`, `"90s"`, `"1h"`, a bare number of minutes — or null for anything else. */
export function parseWindow(str) {
  const m = WINDOW_RE.exec(String(str ?? '').trim());
  if (!m) return null;
  return Number(m[1]) * UNIT_MS[m[2] || 'm'];
}

/**
 * The window itself, as ISO strings on both ends — `at` is echoed back so a caller
 * that resolved it from a bead's `created_at` (rather than a bare `--at`) can still
 * print what it resolved to.
 */
export function windowFor(atIso, windowMs = DEFAULT_WINDOW_MS) {
  const at = Date.parse(atIso);
  if (!Number.isFinite(at)) return null;
  return {
    at: new Date(at).toISOString(),
    start: new Date(at - windowMs).toISOString(),
    end: new Date(at + windowMs).toISOString(),
  };
}

/* --------------------------------------------------------------- the bead's own history */

/**
 * The occurrence-comment shapes `lib/errors.js` writes on a repeat report:
 * `occurrenceNote` ("**Occurrence 3** — ...", "**It happened again** — ...") and
 * `coalescedNote` ("**4 more occurrences** — ..."). Matched on the shape rather than
 * re-imported from lib/errors.js, because the question here is "does this comment say
 * this happened before", not "was it written by that exact function" — a bead moved
 * from another source, or hand-annotated the same way, should still answer.
 */
const OCCURRENCE_RE = /^\*\*(Occurrence \d+|It happened again|\d+ more occurrences?)\*\*/;

/** Which of a bead's comments are occurrence notes, oldest first, with their times. */
export function occurrencesFrom(comments) {
  return (comments || [])
    .filter((c) => OCCURRENCE_RE.test(String(c?.text ?? '').trim()))
    .map((c) => ({ at: c.created_at || c.at || null, text: String(c.text).trim() }))
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
}

/* ------------------------------------------------------------------------ sibling beads */

/**
 * Every OTHER bead carrying `app-error` (whatever its status — a closed one is still
 * evidence of what else broke that hour) whose `created_at` falls inside the window.
 * This is `bc-y8wf`'s `bd list --label app-error` step, generalised to any window
 * rather than eyeballed against `tail`.
 */
export function siblingsIn(rows, { start, end, exclude = null } = {}) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return (rows || [])
    .filter((r) => r && String(r.id) !== String(exclude))
    .filter((r) => {
      const t = Date.parse(r.created_at || '');
      return Number.isFinite(t) && t >= startMs && t <= endMs;
    })
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')));
}

export { ERROR_LABEL };

/* ----------------------------------------------------------------------------- deploys */

function readDeployRecord(dir, id) {
  try {
    const rec = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    return rec && typeof rec === 'object' && rec.id === id ? rec : null;
  } catch {
    return null;
  }
}

/**
 * `listDeploys()` in lib/deploy.js reads a module-level `DEPLOY_DIR`, fixed at import
 * time from `CONFIG_DIR` — there is no way to point it at a fixture after the fact.
 * `--deploys <dir>` needs exactly that, so this duplicates the (short) read-and-sort
 * lib/deploy.js already does, parameterised by directory, and the default path below
 * calls the real `listDeploys()` untouched rather than re-reading `DEPLOY_DIR` a second
 * way.
 */
export function deploysFrom(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => readDeployRecord(dir, n.slice(0, -5)))
    .filter(Boolean)
    .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)) || String(b.id).localeCompare(String(a.id)));
}

/** Every deploy record from `dir` (or the real journal), newest first. */
export function allDeploys(dir = null) {
  return dir ? deploysFrom(dir) : listDeploys({ limit: 500 });
}

/**
 * A deploy record `overlaps` the window when any part of its life — `requestedAt` to
 * `finishedAt`, or to "now" for one still in flight (no `finishedAt` written yet) —
 * intersects it. `requestedAt`/`finishedAt` are lib/deploy.js's own field names.
 */
export function deploysIn(records, { start, end }, now = Date.now()) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  return (records || []).filter((r) => {
    const s = Date.parse(r?.requestedAt || '');
    if (!Number.isFinite(s)) return false;
    const parsedEnd = Date.parse(r?.finishedAt || '');
    const e = Number.isFinite(parsedEnd) ? parsedEnd : now;
    return s <= endMs && e >= startMs;
  });
}

/* -------------------------------------------------------------------------- merges */

/**
 * `git log` in the window, on the checkout `b7e-moment` was run from — commits are the
 * same objects whichever worktree of this repo reads them, so which checkout does not
 * matter the way it does for a `bin/` command resolved off `PATH`.
 */
export async function mergesIn(root, { start, end }) {
  let out;
  try {
    out = await git(root, ['log', `--since=${start}`, `--until=${end}`, '--date=iso-strict', '--pretty=%H%x09%ad%x09%s']);
  } catch (err) {
    return { error: String(err?.message || err).split('\n')[0] };
  }
  const commits = out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, at, ...rest] = line.split('\t');
      return { hash: hash.slice(0, 10), at, subject: rest.join('\t') };
    });
  return { commits };
}

/* ------------------------------------------------------------------------ daemon log */

/** `2026-08-18T22:41:03.512Z ` — lib/logstamp.js's own format, captured. */
const STAMP_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) (.*)$/;

const SLOW_RE = /\bslow [A-Z]+ \S+ \d+ms\b/;

/**
 * `slow`/`[cache]`/error, called out the way `bc-19vt`'s hand read did — the two lines
 * that were the whole diagnosis (`[cache] board: gave up its refresh slot after 150s`,
 * `slow GET /api/queues 150057ms cold`) match the first two branches exactly; see
 * lib/timing.js (the `slow ${key} ${ms}ms` template) and the `[cache]` prefix used
 * throughout lib/prboard.js and friends.
 */
export function classifyLine(line) {
  if (line.includes('[cache]')) return 'cache';
  if (SLOW_RE.test(line)) return 'slow';
  if (/\b(error|exception|refused|crash(?:ed)?|ENOSPC)\b/i.test(line)) return 'error';
  return null;
}

/** How many matched lines are kept in full; the rest are still counted. */
export const LOG_LINE_CAP = 500;

/**
 * The daemon log, inside the window — streamed line by line (`readline` over a
 * `createReadStream`), never read whole into memory. The file this was filed over is
 * 21,878,663 bytes and grows for the life of the daemon; `fs.readFileSync` on it is
 * itself most of `bc-19vt`'s ten minutes.
 *
 * Every line the daemon writes carries a leading stamp (lib/logstamp.js) except a
 * continuation of a multi-line write, which inherits the stamp of the line before it —
 * `lastStamp` below is exactly that inheritance. Because the file is append-only and
 * each stamp is real wall-clock time at the moment of the write, stamps are
 * non-decreasing top to bottom; the read stops as soon as one exceeds the window's end
 * rather than continuing to the end of the file.
 */
export async function scanLog(logFile, { start, end } = {}) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  // `exists` starts true: reaching the `finally` below without the catch firing means
  // the stream opened without error, whether or not the file had any lines to give it.
  const result = { path: logFile, exists: true, lines: [], counts: { slow: 0, cache: 0, error: 0 }, omitted: 0 };

  // `fs.createReadStream` never throws synchronously for a missing file — the open
  // happens internally, and ENOENT only ever surfaces as an `error` event once reading
  // actually starts. So the whole read is one try/catch, and only ENOENT is swallowed
  // (as "this source has nothing to say"); anything else — a permissions error, a read
  // failure partway through — is a real problem and propagates.
  const stream = fs.createReadStream(logFile, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lastStamp = null;
  try {
    for await (const line of rl) {
      const m = STAMP_RE.exec(line);
      const stampMs = m ? Date.parse(m[1]) : lastStamp;
      if (m) lastStamp = stampMs;
      if (stampMs == null || !Number.isFinite(stampMs)) continue;
      if (stampMs > endMs) break;
      if (stampMs < startMs) continue;
      const kind = classifyLine(line);
      if (kind) result.counts[kind] += 1;
      if (result.lines.length < LOG_LINE_CAP) {
        result.lines.push({ at: m ? m[1] : null, text: line, kind });
      } else {
        result.omitted += 1;
      }
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    result.exists = false;
  } finally {
    rl.close();
    stream.destroy();
  }
  return result;
}

/* --------------------------------------------------------------------------- the join */

/**
 * Every source, joined over one window. `bead` is null when no bead id was given (a
 * bare `--at`); every other key is always present, empty rather than absent when a
 * source found nothing — see the module doc comment for why that distinction matters.
 */
export async function momentReport(
  bd,
  ws,
  {
    at,
    windowMs = DEFAULT_WINDOW_MS,
    beadId = null,
    beadComments = null,
    root = process.cwd(),
    logFile = DAEMON_LOG,
    deploysDir = null,
  } = {}
) {
  const win = windowFor(at, windowMs);
  if (!win) throw new Error(`not a parseable timestamp: ${at}`);

  const bead = beadId ? { id: beadId, occurrences: occurrencesFrom(beadComments) } : null;

  let siblingRows = [];
  if (bd && ws) {
    try {
      siblingRows = await bd.listLabelAny(ws, ERROR_LABEL);
    } catch {
      siblingRows = [];
    }
  }
  const siblings = siblingsIn(siblingRows, { ...win, exclude: beadId });

  const deploys = deploysIn(allDeploys(deploysDir), win);
  const merges = await mergesIn(root, win);
  const log = await scanLog(logFile, win);

  return { window: win, bead, siblings, deploys, merges, log };
}
