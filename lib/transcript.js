/**
 * A live Claude Code session's own transcript, tailed for the phone.
 *
 * The sessions page could say *that* a session was running (lib/claude.js) and, for
 * a bead the daemon dispatched itself, what its agent was saying (lib/agentlog.js).
 * Neither covers the ordinary case: a session Adam started at the keyboard, which
 * beadcause did not launch and therefore has no log of. From the phone that session
 * was a name, a pid and the word "busy" — indistinguishable from a session wedged an
 * hour ago on a permission prompt.
 *
 * Claude Code already writes the whole conversation to
 * `~/.claude/projects/<slug>/<session-id>.jsonl`, one JSON object per line, appended
 * as it happens. So this reads that file. Nothing is instrumented, nothing is asked
 * of the session, and a session that never heard of beadcause is as visible as one
 * it started itself.
 *
 * Three things worth knowing:
 *
 * 1. **Read-only, and keyed by pid.** Callers name a *running session*, never a path
 *    — see `/api/session-log`. The file is resolved here from the record Claude Code
 *    wrote, so no request can ask for a file of its own choosing.
 * 2. **Rendering happens here, not on the phone.** The client only ever sees text, in
 *    the same line grammar as the dispatched-agent pane, which is why `renderEvent`
 *    is imported rather than reimplemented.
 * 3. **A transcript is not redacted.** It holds every prompt and every byte of tool
 *    output from that session, which for a work repo can include things you would not
 *    put in a chat. It travels the same authenticated, tailnet-only path as the rest
 *    of `/api/` and no further — but it is the most sensitive thing this daemon
 *    serves, and `claudeSessions: false` turns the whole thing off.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { clip, renderEvent } from './agentlog.js';

const HOME = os.homedir();

/** A session id names a file, so it is checked before it is ever joined to a path. */
const SESSION_ID_RE = /^[A-Za-z0-9._-]{8,64}$/;

const expand = (p) => path.resolve(String(p).replace(/^~/, HOME));

/**
 * Every directory that might hold transcript folders — plural, and that matters.
 *
 * A Mac can run two Claude Code accounts out of two config directories — `~/.claude`
 * for work and, say, `~/.claude-personal` for everything else — selected per shell
 * with `CLAUDE_CONFIG_DIR`, and a session's transcript lands under whichever one it
 * was started with. The daemon runs under launchd, where that variable is *not* set.
 * Honouring it and nothing else would find the transcripts of sessions that happen
 * to share the daemon's environment and silently miss the rest.
 *
 * So it looks in all of them: the `projects` folder of every `~/.claude…` directory,
 * plus the `projects` sibling of a configured `claudeSessionsDir` — whoever pointed
 * that at an account's config directory meant the transcripts beside it too.
 * `claudeProjectsDir` overrides the lot, and takes a list.
 *
 * Deduplicated by real path, because those directories are commonly one store
 * wearing two names: on this machine `~/.claude-personal/projects` is a symlink to
 * `~/.claude/projects`, which would otherwise be scanned twice on every miss.
 */
function projectsRoots(cfg) {
  const seen = new Set();
  const out = [];
  const add = (dir) => {
    let real;
    try {
      real = fs.realpathSync(dir);
    } catch {
      return; // no such directory — not an error, just one fewer place to look
    }
    if (seen.has(real)) return;
    seen.add(real);
    out.push(real);
  };

  if (cfg.claudeProjectsDir) {
    [].concat(cfg.claudeProjectsDir).forEach((d) => add(expand(d)));
    return out;
  }

  if (process.env.CLAUDE_CONFIG_DIR) add(path.join(expand(process.env.CLAUDE_CONFIG_DIR), 'projects'));
  if (cfg.claudeSessionsDir) add(path.join(path.dirname(expand(cfg.claudeSessionsDir)), 'projects'));
  add(path.join(HOME, '.claude', 'projects'));
  try {
    for (const entry of fs.readdirSync(HOME)) {
      if (entry.startsWith('.claude')) add(path.join(HOME, entry, 'projects'));
    }
  } catch {
    /* an unreadable home directory leaves the explicit candidates above */
  }
  return out;
}

/**
 * Claude Code's folder name for a working directory: every character that is not
 * a letter or a digit becomes `-`.
 *
 * So `/Users/me/dev/app/.claude/worktrees/thing-4e7` becomes
 * `-Users-me-dev-app--claude-worktrees-thing-4e7` — the doubled dash is the `/.`,
 * which is what makes a worktree's own folder findable at all.
 */
export const slugFor = (dir) => String(dir).replace(/[^A-Za-z0-9]/g, '-');

/**
 * The transcript file for a session, or null.
 *
 * The slug is a guess about a rule that is not ours, so a miss falls back to looking
 * for the file by name in every folder of every root. That is a `stat` per folder —
 * tens, not thousands, and only on the miss — and it means a directory whose slug we
 * get wrong still shows a transcript rather than an empty pane blaming the session.
 */
export function transcriptFile(cfg, { cwd, sessionId } = {}) {
  if (!sessionId || !SESSION_ID_RE.test(sessionId)) return null;
  const roots = projectsRoots(cfg);
  const name = `${sessionId}.jsonl`;

  if (cwd) {
    const slug = slugFor(cwd);
    for (const root of roots) {
      const guess = path.join(root, slug, name);
      if (fs.existsSync(guess)) return guess;
    }
  }

  for (const root of roots) {
    let dirs;
    try {
      dirs = fs.readdirSync(root);
    } catch {
      continue;
    }
    for (const dir of dirs) {
      const candidate = path.join(root, dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

/** The last `bytes` bytes of a file, as text, or null. */
function readTail(file, start, length) {
  let fd;
  try {
    const buf = Buffer.alloc(length);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, length, start);
    return buf.toString('utf8');
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * One transcript line → the line a terminal would have shown, or null to skip it.
 *
 * The two message shapes are the ones `renderEvent` already knows, so they are
 * delegated: keeping one line grammar for both panes is the whole reason that
 * function is exported. What is handled here is what only a real session has —
 * a human typing, and a compaction.
 *
 * A transcript also carries a dozen bookkeeping types (`mode`, `last-prompt`,
 * `file-history-snapshot`, hook `attachment`s…). They fall through to null on
 * purpose: this pane is meant to read like a terminal, and none of them was ever
 * on screen.
 */
export function renderLine(entry) {
  if (!entry || typeof entry !== 'object') return null;

  let text = null;
  if (entry.type === 'user' && typeof entry.message?.content === 'string') {
    // The prompt. `renderEvent` only understands the array form, because a
    // dispatched agent is never typed at half way through.
    const prompt = clip(entry.message.content, 400);
    text = prompt ? `❯ ${prompt}` : null;
  } else if (entry.type === 'system' && entry.subtype === 'compact_boundary') {
    text = '● context compacted';
  } else {
    text = renderEvent(entry);
  }
  if (!text) return null;

  // A subagent's messages are appended to the same file as the session that spawned
  // it. Marked rather than dropped — it is real work, and the alternative is a pane
  // that goes silent for the ten minutes an agent is doing all the work.
  if (entry.isSidechain) return text.replace(/^/gm, '┆ ');
  return text;
}

/**
 * The tail of a session's transcript, as lines of text.
 *
 * **The window grows until there is something worth reading, and that is the whole
 * trick.** One transcript line is a whole message, and a `tool_result` carrying a
 * 200 kB file is an ordinary Tuesday — so bytes are a terrible proxy for lines. A
 * fixed window lands mid-line, the partial first line has to be dropped, and what is
 * left is a handful of entries: measured on this very session, 256 kB of recent
 * transcript was ten lines, six of which rendered. A pane showing six lines of the
 * busiest session on the page reads as "barely anything is happening", which is the
 * opposite of the truth.
 *
 * So it counts what it will actually *show* — after the bookkeeping types are
 * dropped — and reads a wider window until it has a screenful or hits the ceiling.
 * Re-parsing on each widening costs a few milliseconds and happens at most twice;
 * the common case is a session with ordinary-sized messages, where the first window
 * already holds hundreds of lines and the loop runs exactly once.
 *
 * Returns `{ file, lines }` — `file` even when there are no lines, so the pane can
 * say where it looked instead of implying the session has done nothing.
 */
export function tailTranscript(cfg, session, { maxLines = 400, want = 30, maxBytes = 2 * 1024 * 1024 } = {}) {
  const file = transcriptFile(cfg, session);
  if (!file) return { file: null, lines: [] };

  let size;
  try {
    size = fs.statSync(file).size;
  } catch {
    return { file, lines: [] };
  }

  let out = [];
  for (let window = 256 * 1024; ; window *= 4) {
    const start = Math.max(0, size - window);
    const text = readTail(file, start, Math.min(size, window));
    if (text === null) return { file, lines: [] };

    const raw = text.split('\n');
    // The first line is only whole if the window began at the start of the file.
    if (start > 0) raw.shift();

    out = [];
    for (const line of raw) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        // A line still being written, or one written by a newer version in a shape
        // this doesn't know. One bad line must not cost the other three hundred.
        continue;
      }
      const rendered = renderLine(entry);
      if (rendered) out.push(...rendered.split('\n'));
    }

    if (out.length >= want || start === 0 || window >= maxBytes) break;
  }
  return { file, lines: out.slice(-maxLines) };
}
