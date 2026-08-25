/**
 * Close the window of a session whose bead is already closed.
 *
 * An advocate opens a window, the session works the bead, delivers it, and the bead
 * closes. Then the window stays. It stays because `claude … -- "$P"` is *interactive* —
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
 * - **The window has to have said it was finished.** `QUEUED-`, `DONE-` or `done-` at
 *   the front of its name is not a guess about the session, it is the session's own
 *   account of itself: the work brief writes the first at the end of the work,
 *   `rename-session.sh --done` writes the third for a session shipped by hand, and the
 *   merge queue writes the second on top of the first when the branch lands (see
 *   `saidFinished`, and lib/retitle.js). A window that closed its bead and never got
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

import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// The same gate `closeEmptyWindows` (lib/iterm.js) checks before its own Apple event —
// see `closeNeverStartedWindow` below, which closes a window the same irreversible way.
import { mayLaunch } from './launchguard.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESCRIBE_SCRIPT = path.join(ROOT, 'scripts', 'describe-session.applescript');
const CLOSE_WINDOW_SCRIPT = path.join(ROOT, 'scripts', 'close-window.applescript');

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
  /**
   * Also close the windows that have no tabs left in them at all.
   *
   * Its own switch, and deliberately *not* under `closeFinishedSessions`: that one is
   * the off switch for signalling a live session, and every argument for turning it off
   * — leave my windows where I put them, do not signal an agent you cannot see — is an
   * argument about a window with something in it. These have nothing in them. See
   * scripts/close-empty-windows.applescript for what they are and why closing one needs
   * none of the four guards above, and bc-30ve for the two that were caught.
   */
  closeEmptyWindows: true,
};

/**
 * Did this session say its work has *merged*?
 *
 * `rename-session.sh --done` writes `done- ` for a session shipped by hand, and
 * `markMerged` in lib/retitle.js writes `DONE-` when the merge queue lands a branch.
 * Either spelling, at the *front* only — a bead whose title happens to contain the word
 * "done" is not a session making a claim about itself.
 *
 * This is the narrow question, and it is only asked by the thing that writes the
 * prefix, so that it never writes it twice. Everything that wants to know whether a
 * window is *finished with* — the sweep below, and `leaseHandOpened` in
 * lib/advocate.js — wants `saidFinished`.
 */
export const saidDone = (name) => /^\s*done-/i.test(String(name || ''));

/**
 * Did this session say it was finished, whether or not the work has landed yet?
 *
 * Two prefixes, because since bc-r941 there are two honest endings and a worker can
 * only ever write the first of them. `QUEUED-` is what it renames itself when
 * `bin/deliver.js` puts its branch on the merge queue: its own work is over, the window
 * is idle, and nothing more will happen in it. `DONE-` is written later, from the
 * daemon, when the branch actually merges — see lib/retitle.js.
 *
 * Both mean "this session is not working the bead any more", which is the only thing
 * either caller here is asking. Keeping the sweep on `DONE-` alone would have quietly
 * stopped it reaping anything the moment the worker stopped writing that prefix — the
 * windows would have stayed open with their beads closed, which is the exact pile this
 * module was written for.
 */
export const saidFinished = (name) => saidDone(name) || /^\s*queued-/i.test(String(name || ''));

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
  if (!saidFinished(session.name)) return null;
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
 * `finish` in lib/advocate.js has nine, and they divide in three. Three are the
 * session's own account of having got as far as it could — `done`, the bead is closed;
 * `delivered`, the pull request is open and somebody has to press merge; `handback`,
 * the question is on the bead and somebody has to answer it. Four more —
 * `unfinished`, `timeout`, `lapsed`, `silent` — are nobody's account of anything. They
 * are this daemon inferring, from a window that went quiet, that something went wrong,
 * and a window somebody should read is exactly what that is.
 *
 * `never-started` is the eighth and it is neither: the launch's own temp files say the
 * shell in that window never ran a line of its command, which is a measurement rather
 * than an inference (`launchProgress`, lib/session.js). It is left out of the set anyway,
 * and could not usefully be in it: no `claude` ever started there, so the worker record
 * carries no pid and `closingFor` would refuse it on guard 2 whatever this said. The
 * window stays on screen, which is honest — a zsh prompt with a bead's name on the tab is
 * exactly the kind of window worth looking at by hand.
 *
 * `gone` is the ninth (bc-y7l2m) and it is the measurement the four inferences wish they
 * were: no live-session row for that id, over several minutes, on a Mac where other rows
 * are still being read. It is out of the set for a reason nothing else here has — **there
 * is no window.** That is the entire content of the ending. Everything below closes a
 * window that is still on screen, and the one case where a signal would go somewhere is
 * the one this must never reach: a pid that has been reused since. Guard 2 already refuses
 * it, and this is the belt in front of the guard.
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
 *
 * `stood-down` is the fourth, and the odd one: it is not the session's account of
 * anything — it never gets to have one — but a window whose bead belongs to another Mac
 * is the one window here that is certainly not worth reading. Another machine is doing
 * the work and this one was told to stop, so leaving it on screen would be leaving a
 * duplicate open next to the duplicate it lost to. The guards below still apply in full:
 * a session mid-sentence is `busy`, and busy waits. See lib/lease.js.
 */
export const REAPABLE = new Set(['done', 'delivered', 'handback', 'stood-down']);

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
    // The conversation, and since ids are minted at launch it is guard 2 rather than
    // decoration: `decide` prefers it over the name check, because a name is something
    // the session writes about itself and an id is something the launcher chose. Still
    // null for every worker adopted from before ids existed, which is exactly when the
    // name check has to keep working. Never used to *address* the process — that is the
    // pid, and it always was.
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
  /**
   * Guard 2. A live pid that is not the session we launched is somebody else's process
   * wearing a recycled number, and it is the one case where being wrong is unrecoverable.
   *
   * **Two ways to ask, and the id is the better one.** The name check came first and is
   * still the fallback, but it is an inference: `namesBead` reads a string the *session*
   * writes about itself and can rewrite at any moment, and it can only ever protect an
   * entry that has a bead id to look for — which a resolver window, opened on a pull
   * request, does not. The session id is minted by the launcher before the window exists
   * (`continuityFlag` in lib/session.js) and is reported straight back off Claude Code's
   * own live-session record, so where there is one the question stops being "does this
   * window still call itself what we expect" and becomes "is this the same conversation",
   * which is the question we actually meant both times.
   *
   * The fallback matters and is not dead code: every worker launched before ids were
   * minted has no `sessionId` on its record, and those windows must keep being closable.
   */
  const named = entry.sessionId
    ? String(session.sessionId || '') === String(entry.sessionId)
    : namesBead(session.name, entry.id);
  if (!named) {
    return { act: 'drop', why: `pid ${entry.pid} is no longer the ${entry.id} session` };
  }

  const waited = secsSince(entry.at);
  const giveUp = waited > o.closeGiveUpMinutes * 60;

  /**
   * `force` — the nightly maintenance window, and the only caller allowed to skip the
   * two guards below. See lib/maintenance.js.
   *
   * **What it skips, and why each is safe to skip *there* and nowhere else.** Guard 3 is
   * "busy waits", and its argument is that signalling mid-sentence truncates the only
   * account of what happened. That argument holds because every ordinary caller reaches
   * here having *inferred* the window is finished — so a busy window means the inference
   * was wrong, and the right move is to believe the window. The maintenance window has
   * not inferred anything: it asked every session to wrap up and waited out
   * `maintenanceDrainMinutes` for them to do it, so a window still busy after that is one
   * that had its notice and did not take it. Guard 4, the grace period, exists to tell
   * "between two turns" apart from "after the last one"; a drain measured in tens of
   * minutes has already made that distinction far better than a few seconds could.
   *
   * **What it does not skip, and cannot.** Guards 1 and 2 are above this line on purpose.
   * A signal is the one act in beadcause with no undo, the pid came out of a file another
   * process wrote, and pids are recycled — so "is this still the session we launched" is
   * asked of a forced close exactly as it is of every other, and a `force` that reaches a
   * recycled pid still drops it rather than signalling. Nothing here makes the signal less
   * careful about *what* it hits; it only makes it less patient.
   *
   * `giveUp` still applies to both arms below. A window that has ignored SIGTERM and
   * SIGKILL is not one to keep poking at for the rest of the night, and the maintenance
   * window has its own outer bound over the top of this one.
   *
   * **It is deliberately not in `REAP_DEFAULTS`**, unlike every other option this function
   * reads, and that is not an oversight to tidy up: `REAP_DEFAULTS` is spread into the
   * advocate's `DEFAULTS`, so a key there becomes a *config key*. `"force": true` in
   * `config.json` would waive these guards for every close the daemon ever makes, which is
   * the one thing this must not be settable to. It is a per-call argument, from one caller,
   * for the duration of one phase.
   */
  if (session.status === 'busy' && !o.force) {
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
  if (waited < o.closeGraceSeconds && !o.force) return { act: 'wait', why: 'in grace' };
  // Outcome-neutral wording: the entry may be here because the bead closed, because a
  // pull request is waiting on a tap, or because a question is. `finish` has already
  // logged which, and a line claiming a closed bead over a delivered one would be the
  // log disagreeing with itself about why a window went.
  //
  // Except under `force`, where "and is idle" would be the one thing the line must not
  // say: the window may well be mid-turn, and that is the fact worth recording about a
  // signal sent anyway.
  if (o.force) {
    return {
      act: 'term',
      why: session.status === 'busy' ? 'the maintenance window closed it mid-turn' : 'the maintenance window closed it',
    };
  }
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

/* -------------------------------------------- the window that never ran its command */

/**
 * The closing record for a window `finish` recorded as `never-started` — see the note
 * on `REAPABLE` above for why that outcome cannot go through `closingFor`: no `claude`
 * ever started, so there is no pid to signal and no Claude Code session record to check
 * one against.
 *
 * What there is instead is `term`, the iTerm session id `open-session.applescript`
 * printed back at launch and the worker record has carried since bc-xl7n.113.2. It
 * addresses the window itself rather than a process in it, which is exactly what this
 * has to close.
 *
 * `null` when the worker has no `term` — every launch before that bead existed, and a
 * session with no handle is left alone on purpose: closing on the strength of nothing
 * is exactly the false positive the header on this file spends four guards avoiding for
 * the pid case, and there is no equivalent guard available here to make up for it.
 */
export function closingNeverStartedFor(worker) {
  if (!worker?.term) return null;
  return { id: worker.id, title: worker.title || worker.id, term: worker.term, at: new Date().toISOString() };
}

/**
 * Should a never-started window actually be closed, given a fresh look at it?
 *
 * Pure, and split from `closeNeverStartedWindow` below for the reason `decide` above is
 * split from `signal`: every interesting mistake this feature could make is a mistake in
 * here, and a test can call it a thousand times without a Mac.
 *
 * `tab` is what iTerm answers for the handle right now, off `describeSession` — `null`
 * when no session carries it any more, which is the ordinary and expected ending: the
 * window is already gone, by hand or otherwise, and there is nothing left to close.
 *
 * Two more guards, and they are the two the bead's own hazard paragraph names:
 *
 *   - **the tab still names this bead.** `term` is an exact handle, minted once and
 *     never reused while the window it named is still open — but "is it still open" is
 *     exactly the fact under test, so trusting the handle alone would be trusting the
 *     thing this exists to check. `namesBead` is the same test `decide` above makes of a
 *     pid's session name, asked here of a tab's.
 *   - **no `claude` process is on its tty.** `hasClaude` is answered by `ps`, never by
 *     AppleScript, because the one thing iTerm's object model cannot report is what is
 *     running inside a session. Anything other than `false` — `true`, or `null` because
 *     `ttyHasClaude` could not ask — is read the same way: a shell in that window may
 *     have got past its rc files after all, and an unanswered question about whether an
 *     agent is in there is never permission to close it.
 */
export function decideNeverStarted(entry, tab, { hasClaude = false } = {}) {
  if (!tab) return { act: 'drop', why: 'the window is gone' };
  if (!namesBead(tab.name, entry.id)) {
    return { act: 'drop', why: `that iTerm session no longer names ${entry.id} — leaving it alone` };
  }
  if (hasClaude !== false) {
    return { act: 'drop', why: 'a claude process is running there now — it is no longer never-started' };
  }
  return { act: 'close', why: 'it never ran its command, its tab still names the bead, and nothing is running in it' };
}

/** What `describe-session.applescript` printed, read back. `null` for `missing`. */
function parseDescribed(stdout) {
  const text = String(stdout || '').trim();
  if (!text || text === 'missing') return null;
  const nl = text.indexOf('\n');
  if (nl < 0) return null;
  return { tty: text.slice(0, nl).trim() || null, name: text.slice(nl + 1) };
}

/**
 * What iTerm knows about a handle right now — `{ tty, name }`, or `null` when nothing
 * carries it. Rejects on a real failure to ask (a TCC refusal, `osascript` timing out),
 * which the caller must not read as `null`: "could not ask" and "the answer is nothing"
 * are different facts, and only the second one means the window is gone.
 */
function describeSession(term, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', [DESCRIBE_SCRIPT, String(term)], { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${stderr || ''}${err.message}`.split('\n')[0] || 'could not describe that session'));
      resolve(parseDescribed(stdout));
    });
  });
}

/**
 * Is a `claude` process attached to this tty right now?
 *
 * `ps -t <tty> -o comm=` lists every process on that terminal; a bare `comm` of `claude`
 * is what `sessionCommand` (lib/session.js) invokes, so this is the same name that
 * process would be running under whether it is one line into its work or an hour in.
 *
 * `null`, not `false`, when the question could not be answered at all — `ps` failing for
 * a reason other than "that tty does not exist" is not evidence either way, and
 * `decideNeverStarted` already treats `null` exactly as it treats `true`.
 */
function ttyHasClaude(tty, { timeout = 5000 } = {}) {
  if (!tty) return Promise.resolve(null);
  return new Promise((resolve) => {
    execFile('/bin/ps', ['-t', tty, '-o', 'comm='], { timeout }, (err, stdout) => {
      // ps exits non-zero both when the tty has nothing on it any more and when it never
      // existed — the file-not-found is the honest case, so this reads as "no claude"
      // rather than "could not tell". A caller who wants to be pickier about the two has
      // nothing more to go on than this does: ps does not say which happened.
      if (err) return resolve(false);
      resolve(
        String(stdout || '')
          .split('\n')
          .some((line) => line.trim() === 'claude')
      );
    });
  });
}

/** Ask iTerm to close the window for this handle. `true` if it did. */
function closeWindowByTerm(term, { timeout = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/osascript', [CLOSE_WINDOW_SCRIPT, String(term)], { timeout }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`${stderr || ''}${err.message}`.split('\n')[0] || 'could not close that window'));
      resolve(String(stdout || '').trim() === 'closed');
    });
  });
}

/**
 * Close one never-started window, if a fresh look right now says it is still safe to.
 *
 * The real thing lib/advocate.js calls once per entry on `a.closingWindows` — up to
 * three Apple/`ps` round trips, always in this order, so the tab is never re-read after
 * the tty has already been asked about and the close never runs on a decision older than
 * either. Returns `decideNeverStarted`'s own `{ act, why }` shape, plus the one outcome
 * that function never returns on its own:
 *
 *   - **`refused`** — `mayLaunch` said no. The same gate `closeEmptyWindows` (lib/iterm.js)
 *     checks before its own Apple event, asked here first and before any of the three
 *     round trips: a process that may not open a window on this Mac may not close one
 *     either, and a suite must never be able to reach the `execFile` below by forgetting
 *     to stub this.
 *
 * A `close` verdict that the actual close then fails to confirm — the window went while
 * this was checking it, which is the only race left once `mayLaunch` has passed — comes
 * back as `drop`, not `close`, so the caller logs and counts what actually happened.
 */
export async function closeNeverStartedWindow(entry, { timeout = 5000 } = {}) {
  if (!mayLaunch()) return { act: 'refused', why: 'this process may not send Apple events' };
  const tab = await describeSession(entry.term, { timeout });
  const hasClaude = tab ? await ttyHasClaude(tab.tty, { timeout }) : false;
  const verdict = decideNeverStarted(entry, tab, { hasClaude });
  if (verdict.act !== 'close') return verdict;
  const closed = await closeWindowByTerm(entry.term, { timeout });
  return closed ? verdict : { act: 'drop', why: 'the window went away between the check and the close' };
}
