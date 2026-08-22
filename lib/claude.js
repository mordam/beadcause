/**
 * Live Claude Code sessions on this Mac.
 *
 * Beads answer "what is being worked on". They cannot answer "who is working",
 * because a session that has not run `bd update --claim` leaves no trace in the
 * tracker at all — and that is the common case at the start of a session, which is
 * exactly when you want to know it exists.
 *
 * Claude Code writes one JSON record per running process to
 * `~/.claude/sessions/<pid>.json`, carrying its pid, cwd, name and busy/idle status.
 * That file is the source here. Two things about it matter:
 *
 * 1. **Records outlive their process.** Nothing removes them on exit, so the pid is
 *    the only thing separating "running now" from "ran on Tuesday" — every row is
 *    liveness-checked before it is reported.
 * 2. **A session is not linked to a bead.** Nothing in the record says which bead it
 *    is on, and this module does not guess. A session and a claimed bead in the same
 *    workspace are *probably* the same work, but reporting that as fact would invent
 *    a link the machine does not have. The view shows them side by side and lets you
 *    draw the line yourself — and the case worth seeing, a session with nothing
 *    claimed, is the one a guess would have papered over.
 *
 * Entirely best-effort: no directory, no rows, no error. Someone running this without
 * Claude Code installed gets a sessions view made only of beads, which is what it was
 * before this file existed.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { beadsDirFor } from './session.js';
import { namesBead } from './reap.js';

const HOME = os.homedir();
const run = promisify(execFile);

/**
 * Where Claude Code keeps its per-process records.
 *
 * Exported because lib/retitle.js *writes* one of these files, and a second spelling of
 * where they live is how a reader and a writer end up disagreeing about which directory
 * a window's name is in.
 */
export function sessionsDir(cfg) {
  if (cfg.claudeSessionsDir) return path.resolve(String(cfg.claudeSessionsDir).replace(/^~/, HOME));
  // CLAUDE_CONFIG_DIR is honoured for anyone who scopes it per account, but the
  // daemon runs under launchd where it is almost never set, so ~/.claude is the
  // answer in practice.
  return path.join(process.env.CLAUDE_CONFIG_DIR || path.join(HOME, '.claude'), 'sessions');
}

/**
 * Is this pid still running? Signal 0 asks the kernel without delivering anything.
 *
 * EPERM counts as alive: the process exists, it just belongs to someone else.
 */
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** The records are epoch milliseconds; everything else on the wire here is ISO. */
const toIso = (ms) => {
  const n = Number(ms);
  return Number.isFinite(n) && n > 0 ? new Date(n).toISOString() : null;
};

/**
 * Which configured workspace a directory belongs to.
 *
 * Uses `beadsDirFor` — the same rule the shell's own `_bd_set_workspace` follows —
 * rather than matching path segments, so this agrees with the tracker a session in
 * that directory would actually write to. A worktree resolves to its parent repo's
 * workspace, which is the point: every session and worktree of one repo shares one
 * issue graph.
 *
 * Note that with `projectRoot` configured, a directory *outside* it resolves to
 * `fallbackWorkspace`. That is not a bug in the mapping — it is what a shell there
 * does — which is why a session in `~/climative.dev` correctly files under climative.
 */
export function workspaceFor(cfg, dir) {
  if (!dir || !cfg.projectRoot) return null;
  const want = path.resolve(beadsDirFor(dir, cfg.projectRoot, cfg.fallbackWorkspace || 'default', cfg.workspaces));
  return (cfg.workspaces || []).find((w) => path.resolve(w.dir) === want)?.name || null;
}

/** Busy before idle, then most recently active — the order you want to read them in. */
const byActivity = (a, b) =>
  (a.status === 'busy' ? 0 : 1) - (b.status === 'busy' ? 0 : 1) ||
  String(b.at || '').localeCompare(String(a.at || ''));

export function liveSessions(cfg) {
  if (cfg.claudeSessions === false) return [];

  const dir = sessionsDir(cfg);
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    let rec;
    try {
      rec = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch {
      // Half-written by a session starting up, or shaped by a version that wrote
      // something else. One unreadable record must not lose the other eight.
      continue;
    }
    const pid = Number(rec.pid);
    if (!alive(pid)) continue;
    out.push({
      pid,
      // Which conversation this process is on, and so which transcript file is its
      // own — see lib/transcript.js for the live tail and lib/sessionlog.js for the
      // record kept after it exits. Captured while the session is alive because it is
      // the only way back to what it did once the process is gone, and read fresh on
      // every request rather than remembered, because `/clear` rewrites it in place.
      sessionId: String(rec.sessionId || ''),
      // The `<project> - <task>` name a session gives itself. Blank until it has
      // been named, which is normal and reads better than a fabricated label.
      name: String(rec.name || ''),
      cwd: String(rec.cwd || ''),
      where: rec.cwd ? path.basename(String(rec.cwd)) : '',
      workspace: workspaceFor(cfg, rec.cwd),
      status: String(rec.status || ''),
      kind: String(rec.kind || ''),
      at: toIso(rec.statusUpdatedAt || rec.updatedAt || rec.startedAt),
      startedAt: toIso(rec.startedAt),
    });
  }
  return out.sort(byActivity);
}

/**
 * Every live process's own command line — the ground truth `resight` in lib/advocate.js
 * falls back to when a session has not yet renamed itself.
 *
 * **The gap this closes (bc-xl7n.114).** `liveSessions` above answers "what does a
 * session call itself", and that field starts blank and stays blank until the session's
 * own first turn gets around to running `rename-session.sh` — which is a model doing
 * what its brief asks, not a fact the launch itself pins down. A window that spends its
 * first several minutes reading code and running a slow test suite before its first
 * rename, or whose rename silently fails, is invisible to `namesBead(s.name, id)` for
 * exactly as long as that takes — and a long tool call is precisely when a window looks
 * quietest and most abandoned to anything watching from outside it.
 *
 * The brief itself carries no such gap. `sessionCommand` in lib/session.js puts the
 * whole prompt — "You are working bead **`<workspace>/<id>`**…" — on `claude`'s own
 * command line, so the *qualified* bead id is on the process's argv from the instant the
 * shell reaches it, before any session record exists at all. Reading it is the same
 * check a human would run by hand (`ps aux | grep <workspace>/<id>`), and it is
 * bc-xl7n.114's own direction (2) — done here rather than left to a case-by-case grep
 * because it is one process table read either way. See `linesNameBead` below for why the
 * match has to be qualified rather than a bare id.
 *
 * Best-effort, like `liveSessions`: no `ps`, no rows, no error — a caller checking many
 * ids against one read never has to guard the failure itself. `ps` is injectable for
 * tests, in the shape `listChromes` in lib/strays.js already takes it.
 */
export async function liveProcessLines({ ps } = {}) {
  let out;
  try {
    out = ps ? await ps() : (await run('ps', ['-Ao', 'pid=,args='], { maxBuffer: 32 * 1024 * 1024 })).stdout;
  } catch {
    return [];
  }
  const found = [];
  for (const line of String(out).split('\n')) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const [, pidStr, args] = m;
    const pid = Number(pidStr);
    if (!alive(pid)) continue;
    found.push({ pid, args });
  }
  return found;
}

/**
 * Is any live process's command line naming this bead? One id against one read.
 *
 * **The bare id is not enough, and measuring this against a real Mac is what proved it.**
 * `namesBead` on its own answers "does this text contain the id, on a word boundary" —
 * which is right for a *session's own chosen name*, a short string with nothing else in
 * it. A live Claude Code process's argv is not that: it can carry its whole system
 * prompt, memory notes and all, and a memory note is exactly the kind of prose that
 * quotes a bead id as an *example* — "`x-1.2` does not name `x-1`" is a real sentence
 * from this file's own memory store, and it cost test/epicqueue.mjs a false positive the
 * first time this ran on a Mac with an ordinary number of windows open. So this matches
 * the *qualified* form instead — `<workspace>/<id>`, exactly what `sessionCommand` in
 * lib/session.js puts on the command line ("You are working bead **`<workspace>/<id>`**
 * …") — because a workspace-qualified pair is what a brief's own argv carries and prose
 * discussing an id in isolation does not.
 */
export const linesNameBead = (lines, workspace, id) =>
  Boolean(workspace && id) && lines.some((l) => namesBead(l.args, `${workspace}/${id}`));

/** Convenience for a single workspace/id pair, one `ps` read of its own — tests and one-off callers. */
export async function liveProcessesNaming(workspace, id, opts = {}) {
  if (!workspace || !id) return [];
  const lines = await liveProcessLines(opts);
  return lines.filter((l) => namesBead(l.args, `${workspace}/${id}`));
}
