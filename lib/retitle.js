/**
 * Rename a window the daemon did not open, at the moment its work actually lands.
 *
 * The work brief has always asked a finished session to put a prefix in front of its
 * own name, because a `/resume` list and a wall of iTerm windows are the two places
 * where a session that shipped and a session that stalled halfway look identical. That
 * part still holds. What stopped holding is *when* a session can honestly say it.
 *
 * Before bc-r941 a worker merged its own branch, so the last thing it did was true:
 * the work was in `main` and `DONE-` said so. Now `bin/deliver.js` opens the pull
 * request and puts it on the merge queue, and a different agent merges it minutes or
 * hours later — see lib/mergequeue.js. A session renaming itself `DONE-` at that point
 * is claiming something it cannot know, and the failure it hides is exactly the one the
 * prefix exists to make visible: a bead closed over a branch nobody merged.
 *
 * So the two states are split. The worker writes `QUEUED-`, which is a claim about
 * itself and true when it is written. `markMerged` below writes `DONE-`, from the
 * daemon, at the moment something learns the branch is in. Nothing infers the merge;
 * the one thing that knows is the thing that renames — and there are three of those,
 * because a branch can land through any of them:
 *
 * - **the merge queue**, `finish` in lib/mergequeue.js — the ordinary road, and the
 *   same function that closes the merge-bead and the work bead;
 * - **the Merge tap on a delivery card**, `resolveDeliveryFor` in lib/server.js — a
 *   `--review` delivery files no merge-bead at all, so the queue never sees that pull
 *   request and would leave its window saying `QUEUED-` for good;
 * - **`reconcileLanded`** in lib/landed.js, for one merged on github.com, which nothing
 *   here was watching when it happened.
 *
 * All three rename *before* they close the bead. The close is what makes the window
 * reapable — lib/reap.js wants a finished name and a closed bead — so a rename after it
 * is racing the signal that closes the window it is renaming.
 *
 * ## Both stores, because they answer different questions
 *
 * A name lives in two places and only one of them survives the process, which is why
 * `~/.claude/rename-session.sh` writes both and why this does too:
 *
 * 1. `~/.claude/sessions/<pid>.json` — the live registry, keyed by pid. It feeds the
 *    status line and `/sessions`, and it is what `liveSessions` in lib/claude.js reads,
 *    so it is also what every guard in this codebase means by a window's name:
 *    `saidFinished` in lib/reap.js, `namesBead` on both sides of the reaper, and
 *    `leaseHandOpened` in lib/advocate.js. Writing only the transcript would rename the
 *    window for a human and leave the daemon reading the old name.
 * 2. The transcript's `{"type":"custom-title"}` line — what the `/resume` picker labels
 *    the conversation with, forever. This is the half that matters hours later, when
 *    the window is long closed and the list is all Adam has.
 *
 * Titles are append-only and last-wins in the transcript, so a wrong one is fixed by
 * writing another rather than by rewriting a file a live process has open. The append
 * preserves mtime on purpose: `/resume` orders by it, and retitling a session must not
 * shove it to the top of the list as if it had just been worked on.
 *
 * ## Nothing here is allowed to be a reason a merge fails
 *
 * Every path is best-effort and returns rather than throws. By the time this runs the
 * pull request is merged and the beads are closing; a window that has already gone, a
 * session record half-written by a session starting up, a transcript on a disk that is
 * full — none of those is a reason to make the merge look like it did not happen. The
 * caller logs what came back and carries on.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { liveSessions, sessionsDir } from './claude.js';
import { transcriptFile } from './transcript.js';
import { namesBead, saidDone } from './reap.js';

/** What a worker writes when its delivery is queued — its own work done, not landed. */
export const QUEUED_PREFIX = 'QUEUED-';

/** What a door that has seen the merge writes over it, once the branch is in `main`. */
export const DONE_PREFIX = 'DONE-';

/**
 * The name this window should be wearing now that its work has merged, or null.
 *
 * Null means "leave it alone", and it has two causes worth separating in your head. A
 * window already saying `done-`/`DONE-` has been through here, or was shipped by hand
 * with `rename-session.sh --done`; writing the prefix twice would be the only visible
 * bug this module could have. And a window with no name at all — a session that never
 * renamed itself — gets nothing invented for it, because a fabricated name would be
 * indistinguishable from one the session chose, and the guards downstream would then be
 * reading the daemon's guess as the session's own account of itself.
 *
 * Everything else keeps its name exactly, id and title included: only the prefix
 * changes, and `QUEUED-` is *replaced* rather than stacked under. That is what keeps
 * `beadInName` working — it is case-sensitive precisely so an upper-cased prefix at the
 * front of a name can never be read as the bead id sitting second.
 */
export function mergedTitle(name) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  if (saidDone(raw)) return null;
  const rest = raw.replace(/^queued-\s*/i, '');
  return `${DONE_PREFIX}${rest}`;
}

/**
 * Point the live registry at a new name, the way `/rename` would have.
 *
 * `nameSessionId` is stamped alongside because `/clear` rewrites this record in place
 * with a new session id while keeping `name` — without it the status line would keep
 * flying a name chosen for a conversation that has ended. Written through a temp file
 * and a rename so a session reading its own record mid-write never sees half of one.
 */
function writeRecord(cfg, pid, title) {
  const file = path.join(sessionsDir(cfg), `${pid}.json`);
  let rec;
  try {
    rec = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return false;
  }
  rec.name = title;
  rec.nameSource = 'user';
  if (rec.sessionId) rec.nameSessionId = rec.sessionId;
  const tmp = `${file}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(rec, null, 2)}\n`);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {
      /* Nothing to clean up, which is the ordinary case. */
    }
    return false;
  }
}

/**
 * Append the title the `/resume` picker will use, without disturbing the file's mtime.
 *
 * One complete line in one append, because the session that owns this transcript is
 * appending to it too and a partial line would corrupt the conversation rather than
 * the title.
 */
function writeTranscriptTitle(cfg, session, title) {
  const file = transcriptFile(cfg, { cwd: session.cwd, sessionId: session.sessionId });
  if (!file) return false;
  const entry = {
    type: 'custom-title',
    customTitle: title,
    sessionId: session.sessionId,
    uuid: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
  };
  try {
    const st = fs.statSync(file);
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
    fs.utimesSync(file, st.atime, st.mtime);
    return true;
  } catch {
    return false;
  }
}

/**
 * Give one live session a new name in both stores.
 *
 * Returns what actually landed rather than a boolean, because the two halves fail
 * independently and for different reasons — a missing transcript is a session whose
 * conversation was cleared, a missing record is a window that closed while we were
 * looking at it — and a caller reporting "renamed" over neither is the shape of bug
 * this module is here to stop being written.
 */
export function retitle(cfg, session, title) {
  const record = writeRecord(cfg, session.pid, title);
  const transcript = writeTranscriptTitle(cfg, session, title);
  return { pid: session.pid, sessionId: session.sessionId || '', title, record, transcript };
}

/**
 * Mark every live window working `id` as merged, and say what was renamed.
 *
 * The match is `namesBead`, the same rule the reaper and lib/advocate.js join windows
 * to beads with — id bounded by non-word characters, so a worker on `dv-qok` is never
 * matched by a window named for `dv-qok.1`. Two windows on one bead is a real state on
 * this Mac rather than an error, so this renames both instead of picking one.
 *
 * An empty array is the ordinary answer and not a failure: most merges land long after
 * the window that delivered them was reaped, and a queue merging a pull request Adam
 * opened by hand has no window to rename at all.
 */
export function markMerged(cfg, id, { sessions = null } = {}) {
  if (!cfg || !id) return [];
  let live;
  try {
    live = sessions || liveSessions(cfg);
  } catch {
    return [];
  }
  const out = [];
  for (const s of live) {
    if (!namesBead(s.name, id)) continue;
    const title = mergedTitle(s.name);
    if (!title) continue;
    out.push(retitle(cfg, s, title));
  }
  return out;
}

/** One line for the merge queue's log, or `''` when there was no window to rename. */
export function describeMarked(marked) {
  if (!marked?.length) return '';
  const half = marked.filter((m) => !m.record || !m.transcript).length;
  const where = marked.map((m) => `pid ${m.pid}`).join(', ');
  return `renamed ${marked.length} window${marked.length === 1 ? '' : 's'} DONE- (${where})${
    half ? ` — ${half} of them in only one of the two stores` : ''
  }`;
}
