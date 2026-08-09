import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';

/**
 * What an agent is currently doing about a question.
 *
 * The phase is mirrored into beads as a `agent:<phase>` state label (via
 * `bd set-state`), so any session or tool can see it. The human-readable detail
 * line lives here instead — it changes every few seconds while an agent works,
 * and that churn doesn't belong in an issue tracker's history.
 */

const STATUS_PATH = path.join(CONFIG_DIR, 'status.json');

// Known phases get an icon and ordering; anything else still renders.
export const PHASES = {
  thinking: { icon: '🤔', label: 'thinking' },
  researching: { icon: '🔍', label: 'researching' },
  drafting: { icon: '✍️', label: 'drafting' },
  building: { icon: '🔨', label: 'building' },
  blocked: { icon: '⛔', label: 'blocked' },
  waiting: { icon: '⏳', label: 'waiting on you' },
  done: { icon: '✅', label: 'done' },
  idle: { icon: '', label: 'idle' },
};

export function readAll() {
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeAll(obj) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(STATUS_PATH, obj);
}

export function setActivity(key, { phase, detail, actor, now }) {
  const all = readAll();
  if (!phase || phase === 'idle') delete all[key];
  else all[key] = { phase, detail: detail || '', actor: actor || '', at: now || new Date().toISOString() };
  writeAll(all);
  return all[key] || null;
}

export function clearActivity(key) {
  const all = readAll();
  if (key in all) {
    delete all[key];
    writeAll(all);
  }
}

/** Drop entries for questions that no longer exist, so the file can't grow forever. */
export function pruneActivity(liveKeys) {
  const all = readAll();
  let changed = false;
  for (const k of Object.keys(all)) {
    if (!liveKeys.has(k)) {
      delete all[k];
      changed = true;
    }
  }
  if (changed) writeAll(all);
}

/**
 * Beads is the fallback source: another session may have run `bd set-state`
 * directly, without going through beadcause.
 */
export function activityFor(key, issueLabels, store) {
  const stored = store[key];
  const fromLabel = (issueLabels || []).find((l) => l.startsWith('agent:'));
  const labelPhase = fromLabel ? fromLabel.slice(6) : null;

  if (stored && (!labelPhase || labelPhase === stored.phase)) return stored;
  if (labelPhase && labelPhase !== 'idle') {
    return { phase: labelPhase, detail: stored?.detail || '', actor: stored?.actor || '', at: stored?.at || null };
  }
  return null;
}
