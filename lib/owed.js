/**
 * A close bd refused, and the promise to try it again.
 *
 * Closing the work bead is the last act of a delivery, and it is the one act here
 * that another bead can veto: bd refuses to close an issue blocked by an open
 * dependency (`Bd.closeGate` in lib/bd.js says how, and test/closegate.mjs pins it).
 * Every delivery parks its work bead behind its merge card for a good reason — an
 * unblocked work bead is one the advocate opens a second session onto — so the
 * refusal is not an edge case at all. It is what happens **every time** a card is
 * answered on the phone: the card being answered is itself the blocker, and it does
 * not close until after the merge has run.
 *
 * Before this, the refusal was a `console.error` and nothing else. bc-ec6 sat
 * `in_progress` over a merged pull request, its thread carrying two separate
 * sentences claiming it had been closed, and nothing anywhere was ever going to try
 * again. So a refused close is now written down here, with the reason it was refused
 * and the reason it should be closed, and the poll retries it once the gate clears —
 * which is usually seconds later, when the question that blocked it closes.
 *
 * ## Why its own file
 *
 * `state.json` has one writer, the daemon, and `saveState` is a read-modify-write of
 * the whole file (lib/config.js says so beside it). `bin/deliver.js` is a *different
 * process* — a worker session that merged its own work and was refused the close — and
 * it has to be able to record one of these too. So this is a small file of its own,
 * written the same atomic way, where a stray second writer costs at worst one record
 * rather than the daemon's entire poll state.
 *
 * Records are keyed `workspace/id`, so re-owing the same bead updates rather than
 * duplicates, and they are dropped the moment they stop meaning anything: the bead
 * closed, or the bead is gone. Nothing expires on a timer — a work bead that is still
 * open and still owed a close is a fact worth keeping until one of those two things
 * is true, however long that takes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './config.js';
import { writeJsonAtomic } from './atomic.js';

export const OWED_PATH = path.join(CONFIG_DIR, 'owed-closes.json');

const keyFor = (workspace, id) => `${workspace}/${id}`;

/** Everything owed, keyed `workspace/id`. An unreadable file reads as nothing owed. */
export function readOwed() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(OWED_PATH, 'utf8'));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const [key, rec] of Object.entries(raw)) {
    if (!rec || typeof rec !== 'object') continue;
    if (!rec.workspace || !rec.id) continue;
    out[key] = {
      workspace: String(rec.workspace),
      id: String(rec.id),
      reason: String(rec.reason || 'Closed on retry by beadcause'),
      why: String(rec.why || ''),
      at: String(rec.at || ''),
    };
  }
  return out;
}

function write(records) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  writeJsonAtomic(OWED_PATH, records);
}

/**
 * Remember that this bead should have closed and did not.
 *
 * `reason` is what the close will say when it finally goes through — it is written
 * now, by whoever knew what landed, because six months on the PR number is the only
 * way back to the diff and the retry has no idea what it is closing. `why` is the
 * refusal itself, kept for the log line and for anyone reading the file.
 */
export function oweClose({ workspace, id, reason, why = '', at = new Date().toISOString() }) {
  if (!workspace || !id) return null;
  const rec = { workspace: String(workspace), id: String(id), reason: String(reason || ''), why: String(why || ''), at };
  const records = readOwed();
  records[keyFor(rec.workspace, rec.id)] = rec;
  write(records);
  return rec;
}

/** Stop owing this one — it closed, or it stopped existing. */
export function forgetOwed(workspace, id) {
  const records = readOwed();
  const key = keyFor(workspace, id);
  if (!(key in records)) return false;
  delete records[key];
  write(records);
  return true;
}

/**
 * Try every close that was refused, and drop the ones that no longer mean anything.
 *
 * Called from the poll, before the advocates tick — a work bead that is finished but
 * still open is exactly the bead an advocate would hand to a fresh session, so the
 * retry has to get there first.
 *
 * Each record ends in one of five ways, and the caller logs the first three:
 *
 *   - `closed`  — the gate cleared and bd took the close. The record is dropped.
 *   - `already` — somebody else closed it. Dropped, quietly: the outcome is the one
 *                 that was wanted, and it is not this file's business who did it.
 *   - `gone`    — bd has never heard of it, or refuses the lookup because there is
 *                 nothing to look up. Dropped, because nothing will ever close
 *                 a bead that is not there.
 *   - `blocked` — still gated. Kept. This is the ordinary answer for the few seconds
 *                 between a merge and the card that blocked it closing.
 *   - `failed`  — bd refused or the lock was held. Kept, and tried again next poll.
 *
 * A workspace that is no longer in the config is left alone rather than dropped:
 * the bead is still there, and a workspace removed from the config today may well be
 * back tomorrow. It costs one entry in a file nobody reads.
 */
export async function sweepOwed(bd, workspaces) {
  const byName = new Map((workspaces || []).map((w) => [w.name, w]));
  const records = readOwed();
  const results = [];
  const done = [];

  for (const [key, rec] of Object.entries(records)) {
    const ws = byName.get(rec.workspace);
    if (!ws) continue;

    let issue;
    try {
      issue = await bd.show(ws, rec.id);
    } catch (err) {
      const detail = String(err?.message || err).split('\n')[0];
      // Two very different failures come back the same way, and only one of them is
      // worth keeping. `bd show` on an id that does not exist *errors* — it does not
      // return an empty row — so a bead somebody deleted would otherwise be retried
      // every thirty seconds for the life of the machine. Anything else is the Dolt
      // lock or a broken workspace, where not being able to look is emphatically not
      // a reason to forget.
      const missing = /no issue found|not found|no such issue/i.test(detail);
      results.push({ ...rec, key, status: missing ? 'gone' : 'failed', detail });
      if (missing) done.push(key);
      continue;
    }
    if (!issue) {
      results.push({ ...rec, key, status: 'gone' });
      done.push(key);
      continue;
    }
    if (issue.status === 'closed') {
      results.push({ ...rec, key, status: 'already' });
      done.push(key);
      continue;
    }

    const gate = await bd.gateFor(ws, issue);
    if (gate) {
      results.push({ ...rec, key, status: 'blocked', detail: gate.reason });
      continue;
    }

    try {
      await bd.close(ws, rec.id, rec.reason);
      results.push({ ...rec, key, status: 'closed' });
      done.push(key);
    } catch (err) {
      results.push({ ...rec, key, status: 'failed', detail: String(err?.message || err).split('\n')[0] });
    }
  }

  if (done.length) {
    // Re-read rather than reusing `records`: this loop has awaited on bd, and
    // `bin/deliver.js` may have owed something of its own in the meantime.
    const current = readOwed();
    for (const key of done) delete current[key];
    write(current);
  }
  return results;
}
