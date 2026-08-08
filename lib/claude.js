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
import { beadsDirFor } from './session.js';

const HOME = os.homedir();

/** Where Claude Code keeps its per-process records. */
function sessionsDir(cfg) {
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
function workspaceFor(cfg, dir) {
  if (!dir || !cfg.projectRoot) return null;
  const want = path.resolve(beadsDirFor(dir, cfg.projectRoot, cfg.fallbackWorkspace || 'default'));
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
