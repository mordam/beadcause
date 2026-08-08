/**
 * What the dispatched agent is actually doing, as a log you can read on the phone.
 *
 * Before this, `dispatchReply` buffered the agent's output with `execFile` and threw
 * it away — the only evidence a comment had been picked up was a phase chip saying
 * "thinking". For a run that can last minutes that is indistinguishable from nothing
 * happening, which is the exact failure auto-dispatch was built to fix.
 *
 * So the agent runs with `--output-format stream-json`, and every event is turned
 * into one CLI-shaped line here and appended to a per-bead file as it arrives. The
 * phone tails the file. Rendering server-side rather than shipping raw JSON to the
 * client keeps the format in one place — the client only ever sees text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';

const LOG_DIR = path.join(CONFIG_DIR, 'logs');

/** One file per bead. A key is `workspace/id`, and `/` is not a filename. */
export function logPath(key) {
  return path.join(LOG_DIR, `${String(key).replace(/[^A-Za-z0-9._-]/g, '_')}.log`);
}

export function append(key, text) {
  if (!text) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(logPath(key), text.endsWith('\n') ? text : `${text}\n`, { mode: 0o600 });
  } catch {
    /* a log that cannot be written must never take the agent down with it */
  }
}

/** Start fresh: a new dispatch is a new run, not a continuation of the last one. */
export function reset(key) {
  try {
    fs.rmSync(logPath(key), { force: true });
  } catch {
    /* nothing to remove */
  }
}

/**
 * The tail of the log, in whole lines.
 *
 * Capped at the end rather than the start because the interesting part of a run in
 * progress is always the last thing it did. The first partial line after a byte-cap
 * is dropped, so the phone never renders half a word as if it were a line.
 */
export function tail(key, { maxBytes = 64 * 1024 } = {}) {
  let fd;
  try {
    const st = fs.statSync(logPath(key));
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(Math.min(st.size, maxBytes));
    fd = fs.openSync(logPath(key), 'r');
    fs.readSync(fd, buf, 0, buf.length, start);
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    if (start > 0) lines.shift();
    return lines.filter((l) => l.length).slice(-400);
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const clip = (s, n = 300) => {
  const one = String(s ?? '').replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

/**
 * One `stream-json` event → the line a terminal would have shown.
 *
 * Unknown event types return null rather than raw JSON: the point of this pane is
 * to read like a CLI, and a wall of `{"type":"…"}` would defeat that. New event
 * types simply don't appear until they are handled here.
 */
export function renderEvent(event) {
  if (!event || typeof event !== 'object') return null;

  if (event.type === 'system' && event.subtype === 'init') {
    return `● session ${String(event.session_id || '').slice(0, 8)} · ${event.model || 'model'} · cwd ${event.cwd || '?'}`;
  }

  if (event.type === 'assistant' || event.type === 'user') {
    const content = event.message?.content;
    if (!Array.isArray(content)) return null;
    const out = [];
    for (const part of content) {
      if (part.type === 'text' && part.text?.trim()) out.push(clip(part.text, 600));
      else if (part.type === 'tool_use') {
        // The command is the useful half of a tool call; the rest is plumbing.
        const arg = part.input?.command || part.input?.file_path || part.input?.pattern || '';
        out.push(`  > ${part.name}${arg ? ` ${clip(arg, 160)}` : ''}`);
      } else if (part.type === 'tool_result') {
        const body = typeof part.content === 'string' ? part.content : part.content?.[0]?.text || '';
        if (body.trim()) out.push(`    ${clip(body, 200)}`);
      }
    }
    return out.length ? out.join('\n') : null;
  }

  if (event.type === 'result') {
    const cost = event.total_cost_usd != null ? ` · $${Number(event.total_cost_usd).toFixed(4)}` : '';
    const ms = event.duration_ms != null ? ` · ${Math.round(event.duration_ms / 1000)}s` : '';
    return `● ${event.is_error ? 'failed' : 'done'}${ms}${cost}`;
  }

  return null;
}
