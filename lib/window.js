/**
 * Is another live window already on this bead — one call, not seven inventions.
 *
 * bc-dgx7.88, filed on the session-audit pattern that keeps recurring in the deluvia
 * tracker: seven sessions there each opened by asking whether a second agent window was
 * already working the same bead, and each wrote its own `ps` pipeline for it. No two were
 * the same, and the variation changed the answer — one flooded 50KB to a file nobody
 * read, three retried after their first form failed, and one got a false negative on a
 * question whose entire purpose is to stop two windows colliding on one bead. The bracket
 * idiom that stops a grep matching its own invocation (`grep 'beadcaus[e]/<id>'`) was
 * independently rediscovered by all seven.
 *
 * **This is a session-side self-check, not the daemon-side door.** `lib/onewindow.js`
 * (bc-7qo.19) refuses at *dispatch* time, when the daemon already knows a bead is live —
 * this is for a window that cannot assume the daemon's door caught every case (a
 * hand-opened session, a race, a stale lease) and wants the answer for itself, with an
 * exit code it can act on.
 *
 * ## What this reuses, and what it does not
 *
 * - **`liveProcessLines`** (lib/claude.js) is the one already-measured fact that a
 *   worker's whole brief sits on `claude`'s own command line from the instant the shell
 *   reaches it — before a rename, before a claim, before a single tool call. This module
 *   reads it directly (with `etime` folded into the same `ps` call, so there is exactly
 *   one process-table read per invocation) rather than importing `linesNameBead`, which
 *   answers only "is anything live on this one id" and throws the ages away.
 * - **`namesBead`** (lib/reap.js) is the word-boundary match already proven not to
 *   false-positive on a bead id quoted in prose, and — since its anchors disallow a
 *   trailing `.` or word character — not to match a *dotted child* of the id either. See
 *   the note `[[the-process-table-is-the-only-honest-witness-to-a-live-window]]`: a naive
 *   substring/line-count check answers "2" for a parent with one live child window, which
 *   the worker brief's own "two lines is the bug" rule would misread as a competitor.
 *   `namesBead`'s lookaround already rules that out; this module does not re-derive it.
 *
 *   **What it does NOT rule out, measured live against this Mac's real process table
 *   while building this** — a session's argv can carry not just its own brief but this
 *   very memory store, and a memory note is free to *quote* another bead's qualified id
 *   as worked example text (`beadcause-supersede -w deluvia -b dv-gr6.56 --original
 *   beadcause/bc-dgx7.79`, verbatim, from a note in this repo's own store). `--family`
 *   against `bc-dgx7` picked that up as two "live windows" on `bc-dgx7.79` that were
 *   nowhere near it — ordinary sessions whose loaded context happened to quote the
 *   qualified pair as an example. This is not a new hole this module opens: it is the
 *   same trade-off `linesNameBead` already accepts for the single-id case, now visible
 *   because `--family` asks the same question at fifty times the width. Not fixed here —
 *   telling "brief" from "example in a memory note" needs reading the argv semantically,
 *   which no caller of this primitive does — but worth a caveat rather than a surprise:
 *   `--family`'s census is a lead to go check, not a verified fact, more so than the
 *   single-bead exit-code gate above it (which is exactly what the rest of the codebase
 *   already trusts `namesBead` for, and no worse here than anywhere else it is used).
 * - **`ppidTable`** (lib/gates.js) — one `ps -Ao pid=,ppid=` read, walked upward from
 *   this process to find the ancestor `claude` process. That is "this session's own pid"
 *   for the MINE-vs-competitor split the worker brief's exit code needs, and it is the
 *   same walk `~/.claude/rename-session.sh` does in shell, ported to JS because this is
 *   the first caller here that needs to answer it programmatically rather than print it.
 * - **`childrenFrom`/`treeUnder`/`ancestorsOf`** (lib/ancestry.js) and **`isRoot`**
 *   (lib/ownership.js) give `--family` its widening: the nearest root (P0 or epic) over
 *   the named bead, and everything under it — the same "nearest root, not the `from`
 *   bead itself" rule `lib/homing.js` uses, ported here rather than reused because that
 *   module answers "what parent should a new bead get", a different question with a
 *   different empty-graph fallback.
 *
 * ## Overlap with bc-7qo.24 (`b7e-onbead`), noted rather than resolved by import
 *
 * `bc-7qo.24` asks a closely related question — "who else is live on this bead, and how
 * do I reach them" — and its `lib/onbead.js` already reuses the same three ground-truth
 * primitives this file does (`branchesFor`, `liveSessions`/`liveProcessLines`,
 * `namesBead`). It is **not imported here**: as of this writing it sits on an unmerged,
 * conflicted branch (PR #656, stuck three merge attempts with no resolver — bc-y4hw8),
 * so depending on it would make this module's own tests pass or fail depending on merge
 * order neither branch controls (see `[[dont-import-an-unmerged-siblings-module]]`). The
 * two tools answer different shapes of the same question and are kept distinct on
 * purpose, the way `b7e-siblings` and `b7e-onbead` were before them: `b7e-onbead` is an
 * investigative report for *reaching* a peer (worktree, dirty state, a `SendMessage`-able
 * name); this module is a fast boolean gate for a session's *own* self-check, with an
 * exit code and a `--family` census neither of b7e-onbead's acceptance criteria ask for.
 * Worth folding together once bc-7qo.24 actually lands, if that reads better then.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { sessionsDir } from './claude.js';
import { namesBead } from './reap.js';
import { ppidTable } from './gates.js';
import { childrenFrom, treeUnder, ancestorsOf } from './ancestry.js';
import { isRoot } from './ownership.js';

const run = promisify(execFile);

/** Is a pid still a live process? Best-effort, like every other reader in this file. */
function alive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Every live process's pid, elapsed time and full command line — one `ps` call, so a
 * caller checking a whole `--family` list against it pays for exactly one process-table
 * read no matter how many ids it is checking. `ps` is injectable, the same shape
 * `liveProcessLines` (lib/claude.js) and `psTable` (lib/gates.js) already take, so a test
 * never needs a real process table.
 */
export async function processLines({ ps } = {}) {
  let out;
  try {
    out = ps ? await ps() : (await run('ps', ['-Ao', 'pid=,etime=,args='], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch {
    return [];
  }
  const found = [];
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, pidStr, etime, args] = m;
    const pid = Number(pidStr);
    if (!alive(pid)) continue;
    found.push({ pid, etime, args });
  }
  return found;
}

/**
 * This session's own `claude` pid — the ancestor of this process that owns a live
 * `~/.claude/sessions/<pid>.json` record — or `null` when none is found (run outside
 * Claude Code, or the record has not been written yet). Same walk as
 * `~/.claude/rename-session.sh`, ported to JS: from `process.pid`, follow `ppid` upward
 * until a pid with a session file turns up, giving up after a dozen hops (`init`/a
 * detached shell has no session file and would otherwise walk forever on a stale table).
 */
export async function ownClaudePid(cfg, { ppids, pid = process.pid } = {}) {
  const dir = sessionsDir(cfg);
  const table = ppids || (await ppidTable());
  let at = pid;
  const seen = new Set();
  for (let hops = 0; at && hops < 12 && !seen.has(at); hops += 1) {
    seen.add(at);
    if (fs.existsSync(path.join(dir, `${at}.json`))) return at;
    at = table.get(at);
  }
  return null;
}

/**
 * Every live window naming `<workspace>/<id>` right now — pid, elapsed time and the
 * bead it was matched against. Empty when nobody is on it, which is the ordinary case
 * and not a failure.
 */
export function windowsNaming(lines, workspace, id) {
  if (!workspace || !id) return [];
  return lines.filter((l) => namesBead(l.args, `${workspace}/${id}`)).map((l) => ({ pid: l.pid, etime: l.etime, bead: id }));
}

/**
 * `--family`: the bead itself if it is already a root (P0 or epic), else the nearest
 * root above it, plus every bead under that root — the same "nearest root, not the bead
 * itself" rule `lib/homing.js`'s `rootOver` uses. Returns just the root id when the graph
 * has nothing above the bead and the bead itself is not a root either (an orphan with no
 * P0 ancestor — bc-rfnr.7's own case), because there is no wider set to report.
 */
export function familyIds(index, id) {
  const key = String(id || '');
  const beads = index?.beads || new Map();
  const parents = index?.parents || new Map();
  const own = beads.get(key);
  const rootId = own && isRoot(own) ? key : ancestorsOf(parents, key).find((a) => isRoot(beads.get(a) || {})) || key;
  const children = childrenFrom(parents);
  const rows = treeUnder(children, beads, rootId);
  return [rootId, ...rows.map((r) => r.id)];
}

/** One row per (bead, live window) pair across a whole `--family` list — the census. */
export function censusFamily(lines, workspace, ids) {
  const rows = [];
  for (const id of ids || []) rows.push(...windowsNaming(lines, workspace, id));
  return rows;
}
