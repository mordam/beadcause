/**
 * Close the window of a session whose bead is already closed.
 *
 * An advocate opens a window, the session works the bead, delivers it, and the bead
 * closes. Then the window stays. It stays because `claude "$P"` is *interactive* —
 * the brief is its first prompt, not its whole life — so when the last turn ends the
 * TUI goes back to waiting for a human who, by construction, is not there. The shell
 * behind it never reaches the `; printf '%s' "$?" > <done>; exit` that `launch` in
 * lib/session.js appends, because `claude` has not exited.
 *
 * The cost is not the window. It is that a screen full of them is indistinguishable
 * from a screen full of sessions that stopped to ask something, so every one of them
 * has to be read before any of them can be dismissed — which is the whole of what
 * beadcause exists to stop. Seven of them were sitting on this Mac when this was
 * written, all named `DONE-…`, all idle, every one of their beads closed hours
 * earlier.
 *
 * So the daemon finishes the sentence the session could not: when a worker's bead is
 * closed and its process is still there, signal it. `claude` exits, the shell runs the
 * two commands after it, the done file lands, and iTerm closes the window behind the
 * shell exactly as it does for a session that ended on its own.
 *
 * **Everything here is about not killing the wrong thing.** A signal is the one act in
 * beadcause with no undo, and the pid it is aimed at came out of a file written by
 * another process minutes ago. Four guards, in order:
 *
 * 1. **The bead must be closed.** Not delivered, not handed back, not timed out —
 *    closed. That is the only ending where nothing is waiting on what is on screen.
 * 2. **Claude Code must still claim that pid as a live session named after the bead.**
 *    The pid alone is worthless: pids are reused, and `~/.claude/sessions/<pid>.json`
 *    records outlive their process (see lib/claude.js). A row that is no longer there,
 *    or is there under a different bead's name, means the process we meant is gone and
 *    something else may be wearing its number. Drop it; never signal on a guess.
 * 3. **It must be idle.** A session goes on working for a moment after its delivery
 *    closes the bead — it renames itself `DONE-`, it writes its last message — and
 *    that moment is `busy`. Signalling into it truncates the only account of what
 *    happened.
 * 4. **It must have been idle for a grace period.** Because "idle" is a status file
 *    written by the session itself, and the gap between two turns looks exactly like
 *    the end of the last one.
 *
 * When all four hold: SIGTERM, then SIGKILL if that was ignored, then give up and say
 * so. Giving up is a real outcome and it leaves the window open — a session that will
 * not take a signal is one worth looking at by hand, and a daemon that kept escalating
 * forever would be worse than the windows.
 */

/**
 * Is this session's name the name of a session working *this* bead?
 *
 * `name.includes(id)` is the obvious test and it is wrong in one specific, live way:
 * a bead's subtasks are `dv-qok.1`, `dv-qok.2`, so every parent id is a prefix of its
 * children's. A worker on `dv-qok` matched against a window named
 * `Deluvia - dv-qok.1 …` therefore matches, and everything downstream of that match —
 * the pid on the card, and now a signal — is aimed at another session's window.
 *
 * So the id has to sit on its own: no word character, dot or dash on either side. The
 * dash matters because ids contain one (`dv-qok`), and it is what stops a suffixed id
 * matching a bare one from the other direction. Everything the brief asks a session to
 * do to its own name — a `DONE-` prefix, a trailing task description — leaves the id
 * bounded by spaces, which is the case this has to keep working.
 *
 * Exported because lib/advocate.js joins workers to sessions with the same rule, and
 * two spellings of "is this the same session" is how a guard and the thing it guards
 * disagree.
 */
export function namesBead(name, id) {
  if (!name || !id) return false;
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\w.-])${escaped}(?![\\w.-])`).test(String(name));
}

/** Tunables, all overridable under `advocates` in config.json. */
export const REAP_DEFAULTS = {
  /** Close a work session once its bead is closed. The whole feature's off switch. */
  closeFinishedSessions: true,
  /**
   * How long the session gets between its bead closing and the first signal.
   *
   * Long enough for the tail of a delivery — the rename, the marker line, the last
   * message — to finish and settle, and short enough that a window is gone before you
   * would have walked past it. The idle check above is the real guard; this is what
   * covers the seconds where the status file has not caught up with the session.
   */
  closeGraceSeconds: 90,
  /** How long SIGTERM gets to work before SIGKILL. */
  closeHardSeconds: 45,
  /** After this, stop trying and leave the window alone. */
  closeGiveUpMinutes: 30,
};

/**
 * The one ending a window may be closed on.
 *
 * `finish` in lib/advocate.js has seven, and six of them leave something worth
 * reading on screen: `delivered` is waiting on a merge, `handback` on a decision,
 * `unfinished`/`timeout`/`lapsed`/`silent` on somebody working out what went wrong.
 * Only `done` — the bead is closed — means the session has nothing left to say that
 * is not already on the bead.
 */
export const REAPABLE = new Set(['done']);

const secsSince = (at) => (at ? (Date.now() - new Date(at).getTime()) / 1000 : Infinity);

/**
 * The closing record for a finished worker, or null if it is not a candidate.
 *
 * `ended` is the interesting no: the session wrote its done file, which means the
 * shell got past `claude` and ran `exit`, which means there is no window left. Those
 * are the sessions that already do the right thing, and they are the majority.
 */
export function closingFor(worker, outcome, { enabled = true } = {}) {
  if (!enabled) return null;
  if (!REAPABLE.has(outcome)) return null;
  if (worker.ended) return null;
  const pid = Number(worker.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  return {
    id: worker.id,
    title: worker.title || worker.id,
    pid,
    // Kept only so a log line can name the conversation; never used to address it.
    sessionId: worker.sessionId || null,
    at: new Date().toISOString(),
    sentAt: null,
  };
}

/**
 * What to do about one closing record, given what Claude Code says about that pid now.
 *
 * Pure, and separated from the signalling on purpose: every interesting mistake this
 * feature could make is a mistake in this function, and a test can call it a hundred
 * times without a process existing anywhere.
 *
 * `session` is the row from `liveSessions` whose pid matches, or null/undefined when
 * there is no longer one — which is the good ending, not an error.
 */
export function decide(entry, session, opts = {}) {
  const o = { ...REAP_DEFAULTS, ...opts };
  if (!session) return { act: 'drop', why: 'the window is gone' };
  // Guard 2. A live pid that is not the session we launched is somebody else's
  // process wearing a recycled number, and it is the one case where being wrong is
  // unrecoverable.
  if (!namesBead(session.name, entry.id)) {
    return { act: 'drop', why: `pid ${entry.pid} is no longer the ${entry.id} session` };
  }

  const waited = secsSince(entry.at);
  const giveUp = waited > o.closeGiveUpMinutes * 60;

  if (session.status === 'busy') {
    return giveUp
      ? { act: 'drop', why: `still busy ${Math.round(waited / 60)}m after its bead closed — leaving it open` }
      : { act: 'wait', why: 'busy' };
  }
  if (entry.sentAt) {
    if (secsSince(entry.sentAt) < o.closeHardSeconds) return { act: 'wait', why: 'SIGTERM sent' };
    return giveUp
      ? { act: 'drop', why: 'it ignored both signals — leaving it open' }
      : { act: 'kill', why: 'it ignored SIGTERM' };
  }
  if (waited < o.closeGraceSeconds) return { act: 'wait', why: 'in grace' };
  return { act: 'term', why: `its bead closed ${Math.round(waited)}s ago and it is idle` };
}

/**
 * Send one signal. True if it was delivered, false if the process had already gone.
 *
 * ESRCH is not a failure — it is the process having exited between the decision and
 * the signal, which is a race this runs into all the time and which resolves the
 * record the same way a clean exit does. EPERM is: it means something is running as
 * another user under a pid we believe is ours, and the caller should hear about it.
 */
export function signal(pid, sig = 'SIGTERM') {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') return false;
    throw err;
  }
}
