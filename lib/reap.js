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
 * 1. **The session must have said it was finished.** Closed the bead, delivered a pull
 *    request, or handed the bead back — the three endings a session *reaches*, all of
 *    which put everything they know somewhere that is not the window. Not timed out,
 *    not lapsed, not gone silent: those are the daemon inferring that a window went
 *    quiet, and an inference about a window is a reason to read it. See `REAPABLE`.
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
 *
 * ## The windows that were already open
 *
 * All of the above starts from a *worker*: a row on an advocate's slot list, with the
 * pid it launched. That is the narrowest possible claim to a window and it is why the
 * signal is safe. It also means it can only ever reach a window the advocate is still
 * holding — and the pile it was written for was made of windows that had left the slot
 * list hours or days earlier, when auto-close did not exist. Nothing knew their pids,
 * so nothing was ever going to signal them; they had to be closed by hand once.
 *
 * The sweep below is that catch-up, made repeatable. It starts from the other end —
 * every live Claude Code session in this advocate's workspace, whether or not this
 * daemon opened it — and that is a genuinely wider claim than a worker row, so it is
 * a *separate setting* (`sweepFinishedWindows`) rather than a detail of the one above.
 * Two things bound it:
 *
 * - **The window has to have said it was finished.** `DONE-`/`done-` at the front of
 *   its name is not a guess about the session, it is the session's own account of
 *   itself: both the work brief and `rename-session.sh --done` write that prefix at
 *   the end of the work and nowhere else. A window that closed its bead and never got
 *   as far as renaming itself is therefore missed, on purpose — the failure of a
 *   session that did not finish its own protocol should be a window somebody reads.
 * - **The bead named in that name has to be closed** — the strictest reading of guard 1,
 *   and the guard that does most of the work here. A hand-run session named after a bead
 *   that is still open — the case this widening actually risks — is untouchable. Note it
 *   stays the strict reading even though guard 1 itself has since widened to cover
 *   delivered and handed-back work: those two are claims about a *worker* — this
 *   advocate launched that pid onto that bead — and a swept window has no worker, so
 *   there is nothing tying an open delivery card to the window in front of you.
 *
 * Then the ordinary four apply, because a swept window joins the same closing list as
 * a worker's: same name check, same idle check, same grace, same escalation. The only
 * number that differs is how long "idle" has to have lasted (`sweepIdleMinutes`,
 * default 20 rather than 90 seconds), because this window's identity is inferred from
 * its *name* and not from a launch we made, and a longer quiet is the cheapest way to
 * be sure the inference is not about to be contradicted by somebody typing.
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
  /**
   * Also close finished windows this daemon is no longer holding a worker for.
   *
   * Its own switch because it is its own claim: `closeFinishedSessions` acts on a pid
   * the advocate launched, this acts on any session in the workspace whose *name* says
   * `DONE-` and whose bead the tracker says is closed. See the header. On, because a
   * window nobody is holding is exactly the one nothing else will ever close, and the
   * two guards it keeps are the two that matter — but this is the line to set false if
   * you want your own windows left where you put them.
   */
  sweepFinishedWindows: true,
  /**
   * How long a window has to have been idle before the sweep will touch it.
   *
   * Minutes rather than `closeGraceSeconds`' seconds. There, the pid came from a launch
   * and the grace only covers the tail of a delivery; here the only evidence this is a
   * finished session is what it called itself, so the wait is long enough that anybody
   * who was actually reading it would have touched it in the meantime.
   */
  sweepIdleMinutes: 20,
  /**
   * How often the sweep looks at all. It costs a `bd show` per candidate window, and
   * unlike the closing list there is no event that makes a candidate appear — a window
   * that has been sitting there for a day is no more urgent for being looked at twice
   * a minute.
   */
  sweepIntervalMinutes: 5,
};

/**
 * Did this session say it was finished?
 *
 * The one marker both protocols agree on: the work brief tells a delivered session to
 * put `DONE-` in front of its own name, and `rename-session.sh --done` writes `done- `
 * for a shipped one by hand. Either spelling, at the *front* only — a bead whose title
 * happens to contain the word "done" is not a session making a claim about itself.
 */
export const saidDone = (name) => /^\s*done-/i.test(String(name || ''));

/**
 * The bead id a window's name is about, or null when there is nothing shaped like one.
 *
 * Beads ids are `<prefix>-<slug>` with dotted subtask suffixes (`dv-5i2.81`), always
 * lowercase, and a session name is `<Project> - <id> <title>`. Two things follow:
 *
 * - **Case-sensitive.** `DONE-Beadcause` is a dash-joined pair of words in exactly an
 *   id's shape and it sits at the front of every name this function is ever asked
 *   about. Lower case is what tells them apart, and it costs nothing: an id that has
 *   been upper-cased is not an id anything could look up.
 * - **The first match, not the only one.** The id is the *second field* of the name and
 *   the title comes after it, so anything else of that shape — a hyphenated word in the
 *   title, another bead the title mentions — is always further right. Requiring a
 *   unique match instead would mean a title containing `auto-close` made its window
 *   unsweepable, which is a silent, permanent no for the sake of a case where the
 *   left-most answer is the correct one anyway.
 *
 * A wrong guess here cannot signal the wrong process — the pid comes from the session
 * record and `decide` re-checks it against the same name — but it can look up the wrong
 * bead, so anything that is not an id is better read as no id at all.
 */
export function beadInName(name) {
  return String(name || '').match(/(?<![\w.-])[a-z]{2,5}-[a-z0-9]{1,8}(?:\.\d+)*(?![\w.-])/)?.[0] || null;
}

/**
 * The bead a live session is a *candidate* to be swept for, or null.
 *
 * Everything here is decidable from the session record alone; whether that bead is
 * actually closed is a question for the tracker, and lib/advocate.js asks it — which is
 * also why the expensive half is last. Pure, and separate from the asking, for the same
 * reason `decide` is: this is where the mistake would be, and a test can run it a
 * thousand times without a process or a tracker existing.
 */
export function sweepCandidate(session, opts = {}) {
  const o = { ...REAP_DEFAULTS, ...opts };
  if (!o.sweepFinishedWindows) return null;
  if (!session) return null;
  const pid = Number(session.pid);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  if (!saidDone(session.name)) return null;
  // Anything but a settled `idle` is a session that may still be mid-sentence, and an
  // empty status is a record that has not said — which is not the same as idle.
  if (session.status !== 'idle') return null;
  if (secsSince(session.at) < o.sweepIdleMinutes * 60) return null;
  const id = beadInName(session.name);
  return id ? { id, pid, sessionId: session.sessionId || null } : null;
}

/**
 * The closing record for a swept window. Same shape as `closingFor`'s, so it joins the
 * same list and goes through the same `decide` — `swept` only so a log line can say
 * where it came from, since a window this daemon never launched is the interesting one
 * to be able to account for afterwards.
 */
export function sweepingFor(candidate, bead) {
  return {
    id: candidate.id,
    title: bead?.title || candidate.id,
    pid: candidate.pid,
    sessionId: candidate.sessionId || null,
    at: new Date().toISOString(),
    sentAt: null,
    swept: true,
  };
}

/**
 * The endings a window may be closed on.
 *
 * `finish` in lib/advocate.js has seven, and they divide in two. Three are the
 * session's own account of having got as far as it could — `done`, the bead is closed;
 * `delivered`, the pull request is open and somebody has to press merge; `handback`,
 * the question is on the bead and somebody has to answer it. The other four —
 * `unfinished`, `timeout`, `lapsed`, `silent` — are nobody's account of anything. They
 * are this daemon inferring, from a window that went quiet, that something went wrong,
 * and a window somebody should read is exactly what that is.
 *
 * `delivered` and `handback` were left out to begin with, on the theory that a session
 * waiting on a decision has something on screen worth reading. It does not, and that is
 * not luck: both endings put everything they know **on the bead**, by design, because
 * being answerable from a phone is the whole of what they are for. Nor does the answer
 * come back through the window. Merge, changes-requested and decline all comment on the
 * bead and reopen it (lib/server.js), an answered question unblocks it, and every one of
 * those routes ends the same way — the advocate opens a *new* session, on the same
 * branch, with the note waiting for it. The window that delivered is never the channel.
 * It is a second copy of a card, and it costs a read.
 *
 * The cost of leaving them was the same cost as the pile this file was written for, and
 * worse for being permanent: a `done` window closes within the minute, so anything still
 * on screen an hour later was delivered, handed back, or broken — three things that look
 * identical until each is read. With this, a window still there is a window in trouble.
 *
 * Reaching them at all is lib/advocate.js's half of the job: both are endings a session
 * arrives at *without exiting*, so until they were also tested against a live idle
 * window, an outcome in this set could only ever be recorded once the window was gone.
 */
export const REAPABLE = new Set(['done', 'delivered', 'handback']);

const secsSince = (at) => (at ? (Date.now() - new Date(at).getTime()) / 1000 : Infinity);

/**
 * The closing record for a finished worker, or null if it is not a candidate.
 *
 * `ended` is the interesting no: the session wrote its done file, which means the
 * shell got past `claude` and ran `exit`, which means there is no window left. Those
 * are the sessions that already do the right thing, and they are the majority. It
 * matters more since `delivered` and `handback` joined `REAPABLE`, because those two
 * arrive both ways — from a window you closed by hand, where the done file is the proof
 * there is nothing to signal, and from one still sitting there idle, where there is.
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
      ? { act: 'drop', why: `still busy ${Math.round(waited / 60)}m after it finished — leaving it open` }
      : { act: 'wait', why: 'busy' };
  }
  if (entry.sentAt) {
    if (secsSince(entry.sentAt) < o.closeHardSeconds) return { act: 'wait', why: 'SIGTERM sent' };
    return giveUp
      ? { act: 'drop', why: 'it ignored both signals — leaving it open' }
      : { act: 'kill', why: 'it ignored SIGTERM' };
  }
  if (waited < o.closeGraceSeconds) return { act: 'wait', why: 'in grace' };
  // Outcome-neutral wording: the entry may be here because the bead closed, because a
  // pull request is waiting on a tap, or because a question is. `finish` has already
  // logged which, and a line claiming a closed bead over a delivered one would be the
  // log disagreeing with itself about why a window went.
  return { act: 'term', why: `it finished ${Math.round(waited)}s ago and is idle` };
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
