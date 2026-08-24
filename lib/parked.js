/**
 * The conversations that are waiting on you — and the fact that makes closing them safe.
 *
 * **The pile this exists for.** Thirteen idle Claude windows were open on this Mac with
 * nothing on any advocate's slot list: four merge-queue conflict resolvers, a merge-queue
 * window, a MergeAdvocate, three P0 advocates, two sessions opened by hand. Every one of
 * them had said its last word and was waiting on Adam — a merge, a decision, an answer —
 * and not one of them could be told apart from a session still working without opening it
 * and reading it. Which is the whole of what beadcause exists to stop: a screen you have
 * to read before you can dismiss any of it.
 *
 * lib/reap.js already closes the *worker* case, and it can only ever close that one,
 * because `closingFor` starts from a worker row and `openConflictSession`,
 * `openMergeAdvocateSession` and `openEpicAdvocateSession` create windows no worker row
 * has ever tracked. Widening the reap to those was refused for years for a good reason:
 * closing a window destroys the only copy of everything that agent worked out, and an
 * hour of context is worth more than a rectangle on a screen.
 *
 * **This file is what removes that reason.** `claude --resume <id>` brings a conversation
 * back exactly as it was — the mechanism is already proven twice over, in lib/console.js
 * for the chat session and lib/terminal.js for the in-app ptys — so a window whose id is
 * written down here is *not* destroyed when it closes. It is parked. Closing it costs the
 * rectangle and nothing else, which is the trade the old refusal was actually about.
 *
 * So the order of operations is the argument: **write the record, then close the window.**
 * Never the other way around, and never the close without the record — a window closed
 * with nothing parked is the failure the old refusal predicted, and it is unrecoverable.
 * `parkable` below is the gate that keeps those two in step.
 *
 * ## What is in a record, and why each field is load-bearing
 *
 * - **`sessionId`** — the conversation. Minted at launch (`--session-id`), never
 *   discovered afterwards: `reconcile` reads ids out of `~/.claude/sessions/<pid>.json`
 *   (lib/advocate.js), and a window that exits between two ticks is one whose id was
 *   never learnt. A park whose id was a guess is a park that cannot be resumed.
 * - **`dir`** — the working directory. Measured on Claude Code 2.1.x: `--resume <id>`
 *   finds the conversation from *anywhere*, so this is not needed to locate the
 *   transcript. It is needed for something the transcript cannot supply — the agent's
 *   **worktree**. Its branch, its uncommitted edits, the files every path in its context
 *   refers to, the `BEADS_DIR` its shell resolves and the claim guard's idea of which
 *   tree it is in are all properties of the directory, not of the conversation. A resume
 *   in the wrong one is an agent with a perfect memory of files that are not there. This
 *   is also why a retired worktree has to come back *before* the resume, not after.
 * - **`waitingOn`** — one sentence, in Adam's words, about what has to happen. It is what
 *   the console row says instead of making him open the window, and it is the only field
 *   here written for a person rather than for the machine.
 * - **`resumes`** — how many times this conversation has already been brought back. Not
 *   decoration: a conversation resumed five times is one that keeps asking, and that is a
 *   fact worth having on the row before a sixth window opens.
 *
 * ## Keyed by bead where there is one, by session where there is not
 *
 * `workspace/<bead>` for anything opened on a bead, which is what lets the dispatch seam
 * find the parked conversation by asking the only question it has an answer to: *am I
 * about to open a window on this bead?* A conflict resolver has a pull request and no
 * bead, so it is keyed `workspace/pr-<number>`; anything else falls back to
 * `session/<id>`, which is findable from the console and from nowhere else. The fallback
 * is deliberately the worst of the three — a window that parks under it can be brought
 * back by hand and will never be brought back automatically, and that is the honest
 * outcome for a window nothing knew the purpose of.
 *
 * Everything here is pure. The store is one key in `state.json`, keyed the same way as
 * `answered`, `ringing` and `dismissed` beside it, and test/parked.mjs drives every branch
 * with no filesystem at all.
 */

/**
 * How long a parked conversation is worth keeping.
 *
 * Not a guess: `~/.claude/projects/**` is where the transcripts actually live and nothing
 * beadcause owns prunes them, but a *worktree* is retired after two days
 * (`RETIRE_DAYS` in lib/tidy.js) and removed for good after that. A parked record whose
 * worktree is gone can still be resumed — the transcript outlives the tree — but it comes
 * back into a directory that no longer holds the branch it was working, which is a worse
 * kind of confusion than a fresh session. Seven days is a fortnight of slack past the
 * point where resuming is the right answer, and the cap below is what actually bounds the
 * file.
 */
export const PARK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** A hard cap under the TTL, so a bad clock cannot let the file grow without bound. */
export const PARK_MAX = 200;

/**
 * The numbers, here rather than in lib/advocate.js's `DEFAULTS`, for the reason
 * `REAP_DEFAULTS` and `LEASE_DEFAULTS` are in their own files: the argument for each one
 * is written beside its value, and a tunable whose reason lives three files away is a
 * tunable somebody changes without reading the reason.
 */
export const PARK_DEFAULTS = {
  /**
   * How long a window may sit idle before its conversation is parked and its window
   * closed.
   *
   * **Ten minutes, and the number is a statement about what "idle" proves.** lib/reap.js
   * waits ninety seconds, and it is right to: by the time a worker reaches that code it
   * has already closed its bead or delivered a pull request, so the only question left is
   * whether it has stopped talking. Nothing has proved anything here — the ending is being
   * inferred from silence alone — and ten minutes is long enough that a session pausing
   * between two turns, or waiting out a slow `npm test`, is not mistaken for one that has
   * finished having anything to say.
   *
   * It is deliberately *not* longer. The failure this exists for is a screen of windows
   * nobody can tell apart, and an hour's grace would mean the screen is full for an hour
   * before anything helps — which is most of a working session, and is the state of
   * affairs already.
   */
  parkIdleMinutes: 10,
  /**
   * How long a window whose *worker slot this advocate still holds* may sit idle before
   * the park sweep stops waiting for `reconcile` to name its ending and parks it anyway.
   *
   * `parkIdle` steps over any window on the slot list, and that skip is right for the
   * first few minutes: `reconcile` knows what the session was asked, so it can say
   * "delivered as a pull request" where this sweep can only say "it went quiet", and two
   * things deciding the same pid in the same tick is a race. What the skip did not have
   * was an end. A worker whose ending `reconcile` cannot classify — the delivery card not
   * filed yet, no `human` label, the bead still open — kept its window until
   * `workerTimeoutMinutes`, which is **two hours** by default, and `timeout` is not in
   * `REAPABLE`, so even then the close came from the next park sweep rather than from the
   * ending. Measured on this Mac: `bc-zjab.12` went idle at 15:08Z with
   * `** BEAD WORK DONE ** CAN BE CLOSED **` on screen and was parked at 16:05Z — "quiet
   * for 58m" — and only because an unrelated bug had knocked it off the slot list.
   *
   * Twenty minutes is forty ticks of grace for a sentence, against a window that would
   * otherwise sit for two hours. Nothing about the close changes: the conversation is
   * written to the park store and the write is checked before anything is signalled, which
   * is the property that makes this sweep allowed to close a window at all.
   */
  parkWorkerIdleMinutes: 20,
  /**
   * How long a status that is neither `idle` nor `busy` may stand before it is read as
   * stale rather than as a session doing something this daemon has no word for.
   *
   * `parkDecision` used to answer `wait` to every such status, forever, and forever is not
   * a figure of speech: a Claude Code record only moves when the session moves, so a
   * window whose session went away in some state nobody here enumerates is invisible to
   * every sweep on this Mac at once — `sweepCandidate` in lib/reap.js asks for exactly
   * `idle` too. Measured: pid 76398 has carried `status: "shell"` since 2026-08-19T03:37Z,
   * four days and sixteen hours, holding a worktree lock, with nothing on this Mac able to
   * touch it.
   *
   * An hour, because the honest reading of an unknown status is "somebody may be typing in
   * there" and an hour is well past any pause that stays true of. `busy` is deliberately
   * not covered: that is the one status that means an agent is mid-sentence, and the guard
   * against signalling into it is the most protective thing here.
   */
  parkStuckMinutes: 60,
  /**
   * How many times one conversation may be brought back after its window disappeared.
   *
   * **One, and the number is the whole loop guard.** A window that is closed by hand, or
   * killed, or lost with its terminal, leaves a conversation that is worth an hour of
   * context and costs nothing to reopen — so the first disappearance is repaired, free,
   * and the bead is charged no attempt for something no session did wrong. What must not
   * follow is the shape lib/advocate.js warns about beside `parkDecision`: "or the same
   * window reopens forever". A conversation whose *resumed* window also disappears is no
   * longer an accident being undone. Something about that agent, that worktree or that
   * bead is making windows die, and reopening the same transcript into it a third time
   * would produce the same death and the same repair, on a loop nobody is watching.
   *
   * So the second disappearance falls through to the fresh brief the attempt counter is
   * already arranging, and `maxAttemptsPerBead` bounds *that* the way it always has. Two
   * counters, deliberately: `resumes` bounds how many times a **conversation** is carried
   * over, `attempts` bounds how many times a **bead** is tried. Raising this is how you
   * would ask for a conversation to survive a flaky terminal all afternoon; it is not a
   * knob anything here turns on its own.
   *
   * Only `gone` parks are counted against it. A `handback` or `delivered` park is resumed
   * because Adam did something, and there is no runaway loop to guard: the loop needs him
   * in it.
   */
  maxResumes: 1,
};

/** Enough of a sentence to read on a row without wrapping three lines on a phone. */
const trim = (text, max = 240) => {
  const flat = String(text || '').trim().replace(/\s+/g, ' ');
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

/**
 * Claude Code's own session ids, and nothing else.
 *
 * The same shape lib/transcript.js insists on, and it is checked here as well as there
 * for a reason worth stating: this value ends up on a **command line**, as the argument
 * to `--resume`. A record whose id came back from a half-written state file must not be
 * able to put anything else there. The check is the guard; `shq` at the call site is the
 * seatbelt.
 */
const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/;

/**
 * The workspace **name**, given either shape of the thing callers have to hand.
 *
 * Every store in this file is keyed and filtered by the name, and the daemon's own
 * advocate record carries the name (`a.name`) beside the workspace *object*
 * (`a.workspace`) — where every `bd.*` call in lib/advocate.js takes the object. So the
 * two are one keystroke apart at the call site, and passing the wrong one used to fail in
 * the worst way available: `${object}/${id}` is a perfectly good string, so a key came out
 * `[object Object]/bc-x` and was written, read back and resumed under itself, while every
 * `rec.workspace === workspace` comparison against an object was simply never true and
 * every list came back empty. An empty list is what a quiet laptop looks like, so nothing
 * anywhere said so — bc-2uj4.6, where the idle sweep had never closed a single window.
 *
 * Normalising rather than throwing, deliberately. This runs in a daemon: a throw here
 * lands inside the `try` that wraps the park, which would turn a caller's mistake into
 * *no park at all* — the one outcome the whole file exists to prevent — and it would do it
 * as quietly as the bug did. Taking `{ name }` and using it is the answer that cannot
 * regress. lib/advocate.js still passes `a.name` at every call site, and says why.
 */
const nameOf = (workspace) =>
  workspace && typeof workspace === 'object' ? String(workspace.name || '') : String(workspace ?? '');

/** The key for a window opened on a bead — the one a dispatch can find again. */
export const beadKey = (workspace, id) => `${nameOf(workspace)}/${id}`;

/** The key for a resolver window, which has a pull request and no bead. */
export const prKey = (workspace, number) => `${nameOf(workspace)}/pr-${number}`;

/** The last resort: findable from the console, and from nothing automatic. */
export const sessionKey = (sessionId) => `session/${sessionId}`;

/**
 * Is there enough here to bring this conversation back?
 *
 * **This is the gate in front of the close, and it is the whole safety argument of the
 * feature.** A window may only be signalled once this has returned true about it, because
 * the moment it closes the record is the only route back to what that agent knew. Three
 * things have to hold, and each corresponds to a way the resume fails silently later:
 *
 * - an id that is actually a session id, because the alternative is `--resume undefined`;
 * - a directory, because a record with no directory can only be resumed from wherever the
 *   daemon happens to be standing — which is not the worktree the agent was working in,
 *   and every file path in its context is relative to that;
 * - a workspace, because every reader of this store is scoped to one.
 *
 * Note what is *not* required: a bead. A resolver window has none and parks perfectly
 * well under `prKey`.
 */
export function parkable(rec) {
  if (!rec || typeof rec !== 'object') return false;
  if (!SESSION_ID_RE.test(String(rec.sessionId || ''))) return false;
  if (!String(rec.dir || '').trim()) return false;
  if (!nameOf(rec.workspace).trim()) return false;
  return true;
}

/**
 * Write down a parked conversation. Returns a new map — the caller merges it into state,
 * so this stays a pure function.
 *
 * `resumes` accumulates across parks rather than resetting, because the interesting
 * number is how many times this conversation has been round the loop, not how many times
 * it has been parked since the last resume. A conversation on its fourth trip is one the
 * console should say so about.
 *
 * **And it is taken from the caller as well as from the record, which is what makes the
 * count actually accumulate.** `prior` alone was enough only while a park was the first
 * thing that ever happened to a conversation. It is not: a resume *drops* the record —
 * `dropPark(countResume(...))` in lib/advocate.js, on purpose, because a record left
 * behind is a conversation two dispatches try to resume at once — so by the time the
 * resumed window parks again there is no `prior` to carry anything, and every second trip
 * was being written down as the first. The trip count therefore rides on the worker in
 * between, and arrives back here through `rec.resumes`. `Math.max` rather than either one
 * outright: whichever of the two knows about more trips is the one telling the truth, and
 * a caller that knows nothing passes nothing rather than resetting the count to zero.
 *
 * Parking the same key twice **overwrites**, and that is right: the second park is the
 * same conversation later, with a newer session id if it was resumed in between and a
 * newer sentence about what it is waiting for. Keeping the older one would resume a
 * transcript that stops before the last thing the agent learnt.
 */
export function recordPark(parked, key, rec, now = new Date()) {
  const prior = (parked || {})[key];
  return {
    ...(parked || {}),
    [key]: {
      at: now.toISOString(),
      sessionId: String(rec.sessionId),
      dir: String(rec.dir),
      workspace: nameOf(rec.workspace),
      bead: rec.bead ? String(rec.bead) : null,
      kind: String(rec.kind || 'worker'),
      title: trim(rec.title, 120),
      waitingOn: trim(rec.waitingOn),
      /**
       * Which ending put it here — and it decides what the resumed agent is told, so it
       * is a field rather than something inferred from `waitingOn`.
       *
       * `handback` and `delivered` wake up to `resumePrompt`: something was answered or
       * merged, and the turn's whole job is to deliver that answer. `gone` wakes up to
       * `interruptedPrompt`: **nothing** was answered, nobody decided anything, the window
       * simply went away. Telling a resumed agent that Adam answered when he did not is
       * the one failure here that the agent cannot detect — it will go looking for a
       * decision that was never made — so the two turns must never be chosen by
       * string-matching the sentence beside them.
       */
      ending: rec.ending ? String(rec.ending) : null,
      // Carried across the overwrite, and taken off the caller, for the reason in the
      // header: this counts trips, not parks-since-resume.
      resumes: Math.max(Number(prior?.resumes) || 0, Number(rec.resumes) || 0),
    },
  };
}

/**
 * The parked conversation under this key, or null.
 *
 * Null for anything that would not survive a resume, which is stricter than "null for a
 * missing key": a half-written record must read as *nothing is parked here* rather than
 * as a conversation the dispatch will try to bring back and fail to. The failure to keep
 * out is a resume that opens a window in the wrong directory on a transcript that is not
 * there — which looks, from the console, exactly like the session having been resumed.
 */
export function parkedAt(parked, key) {
  const rec = (parked || {})[key];
  if (!parkable(rec)) return null;
  return {
    at: typeof rec.at === 'string' ? rec.at : null,
    sessionId: String(rec.sessionId),
    dir: String(rec.dir),
    workspace: nameOf(rec.workspace),
    bead: rec.bead ? String(rec.bead) : null,
    kind: String(rec.kind || 'worker'),
    title: String(rec.title || ''),
    waitingOn: String(rec.waitingOn || ''),
    // Null for every record written before endings were kept, which is the right answer
    // for those: all of them were parked by `parkWorker`'s original two endings, and null
    // reads as "not `gone`" everywhere it is asked.
    ending: rec.ending ? String(rec.ending) : null,
    resumes: Number(rec.resumes) || 0,
  };
}

/**
 * Every parked conversation, newest first — what the console draws instead of a screen
 * full of windows nobody can tell apart.
 *
 * `workspace` narrows it; omitted, it is every one of them, which is the answer the
 * sessions page wants and the per-advocate panel does not.
 */
export function parkedList(parked, workspace = null) {
  const only = nameOf(workspace);
  return Object.entries(parked || {})
    .map(([key, rec]) => [key, parkedAt(parked, key)])
    .filter(([, rec]) => rec && (!only || rec.workspace === only))
    .sort((a, b) => Date.parse(b[1].at || 0) - Date.parse(a[1].at || 0))
    .map(([key, rec]) => ({ key, ...rec }));
}

/**
 * The literal string a workspace *object* leaves behind when it reaches a template.
 *
 * Not a general-purpose sentinel — it is the exact fingerprint of one bug, bc-2uj4.6, and
 * naming it here is what lets `adoptStrays` be narrow enough to be safe.
 */
const STRAY = '[object Object]';

/**
 * Repair the records the object-for-name bug wrote, so the fix for it does not throw away
 * the conversations it already parked.
 *
 * `parkWorker` in lib/advocate.js parked a handed-back or delivered worker under
 * `beadKey(a.workspace, …)` — the object — so the key came out `[object Object]/bc-x` and
 * the record's own `workspace` came out the string `"[object Object]"`. Those records are
 * real conversations, sitting on real branches, waiting for a real answer; `resumeFor` found
 * them again only because it asked the same wrong question. Correcting the question without
 * correcting the store would make every one of them unresumable *silently* — the dispatch
 * would open a fresh window and say nothing, which the header of this file calls the one
 * outcome worth guarding against.
 *
 * So this is deliberately the narrowest repair that can work, and every condition is doing
 * something:
 *
 * - **only records whose `workspace` is exactly `"[object Object]"`.** Anything else is a
 *   record somebody meant, and a migration that rewrites those is a migration that can lose
 *   a park it did not understand.
 * - **only where the record's own `dir` resolves back to this workspace**, asked through
 *   the same rule a live session's directory is resolved by. The name cannot be recovered
 *   from the record — that is what the bug destroyed — so it is recovered from the one
 *   field that still says where the agent was standing. A record whose directory belongs to
 *   another workspace is left for that workspace's advocate; a record whose directory maps
 *   to nothing at all is left alone and ages out under `PARK_TTL_MS`, which is the honest
 *   answer for a park nothing can place.
 * - **the tail of the key is carried across unchanged**, so `pr-342` stays a resolver key
 *   and a bead id stays a bead id without this having to know which it was looking at.
 *
 * Pure, like everything else here: it returns a new map and the caller decides whether to
 * write it. Returns the same object it was given when there is nothing to do, which is the
 * case on every install that never ran the broken version and on every tick after the first.
 */
export function adoptStrays(parked, workspace, workspaceOfDir) {
  const name = nameOf(workspace);
  if (!name || typeof workspaceOfDir !== 'function') return parked || {};
  const prefix = `${STRAY}/`;
  let out = null;
  for (const [key, rec] of Object.entries(parked || {})) {
    if (!rec || typeof rec !== 'object') continue;
    if (rec.workspace !== STRAY || !key.startsWith(prefix)) continue;
    if (workspaceOfDir(rec.dir) !== name) continue;
    out = out || { ...(parked || {}) };
    delete out[key];
    out[`${name}/${key.slice(prefix.length)}`] = { ...rec, workspace: name };
  }
  return out || parked || {};
}

/**
 * Take a conversation off the park list, having brought it back.
 *
 * Called *after* the window is open, never before it: a record dropped in advance of a
 * launch that then fails is a conversation nothing can find again. The window being open
 * is what makes the record redundant, and until then it is the only copy.
 */
export function dropPark(parked, key) {
  const out = { ...(parked || {}) };
  delete out[key];
  return out;
}

/**
 * The same conversation, parked again after its resume — with the trip counted.
 *
 * Separate from `recordPark` because the increment belongs to the *resume*, and doing it
 * at park time would count a window that came up and was never brought back.
 */
export function countResume(parked, key) {
  const rec = (parked || {})[key];
  if (!rec || typeof rec !== 'object') return parked || {};
  return { ...(parked || {}), [key]: { ...rec, resumes: (Number(rec.resumes) || 0) + 1 } };
}

/**
 * Drop what is too old to bring back, newest kept first.
 *
 * Pruned on age and count only, never against what is live — the same decision as
 * `pruneAnswered` beside it and for a sharper version of the same reason. Everything in
 * here is by definition a conversation with **no process behind it**: pruning on absence
 * would empty the store on the first sweep after the windows closed, which is the moment
 * the records start being useful.
 */
/* ------------------------------------------- the windows that are open right now */

/**
 * Every window beadcause has opened and not yet accounted for, keyed by session id.
 *
 * **Why a second store rather than reusing the advocate's slot list.** `a.workers` is a
 * list of *slots* — one bead, one worker, counted against a limit, reconciled every tick.
 * Four of the eight doors in lib/session.js open a window that is not a worker and never
 * was: a conflict resolver has a pull request and no bead, a MergeAdvocate is re-entrant
 * across an afternoon, a P0 advocate takes no slot by design. Those are most of the pile
 * this feature exists for, and putting them on the slot list would make every number on
 * the console wrong to fix a problem about windows.
 *
 * **Keyed by session id, which is the identity nothing else has.** Everything that has
 * ever tried to match a window to what opened it has matched on the *name* — `namesBead`
 * in lib/advocate.js, `saidFinished` in lib/reap.js — and a name is something the session
 * writes about itself and can change. The id is minted by the launcher before the window
 * exists (`continuityFlag` in lib/session.js) and is what `lib/claude.js` reports back off
 * the live-session record, so the join is exact: this row *is* that process, or that
 * process is gone.
 */
export function registerOpen(opened, rec, now = new Date()) {
  if (!parkable(rec)) return opened || {};
  return {
    ...(opened || {}),
    [String(rec.sessionId)]: {
      at: now.toISOString(),
      sessionId: String(rec.sessionId),
      dir: String(rec.dir),
      workspace: nameOf(rec.workspace),
      bead: rec.bead ? String(rec.bead) : null,
      pr: rec.pr ? String(rec.pr) : null,
      kind: String(rec.kind || 'worker'),
      title: trim(rec.title, 120),
    },
  };
}

/** Forget a window — it parked, it closed, or it was never ours to close. */
export function dropOpen(opened, sessionId) {
  const out = { ...(opened || {}) };
  delete out[String(sessionId)];
  return out;
}

/** Every open window, newest first; `workspace` narrows it. */
export function openList(opened, workspace = null) {
  const only = nameOf(workspace);
  return Object.entries(opened || {})
    .filter(([, rec]) => parkable(rec) && (!only || rec.workspace === only))
    .sort((a, b) => Date.parse(b[1].at || 0) - Date.parse(a[1].at || 0))
    .map(([, rec]) => ({ ...rec }));
}

/**
 * What to do about one open window — the whole decision, as a pure function.
 *
 * Deliberately the same shape as `decide` in lib/reap.js, because it is the same kind of
 * judgement made one step earlier, and the two are read together: this one decides whether
 * a window has finished having anything to say, and that one decides how to close it
 * safely once this has said so.
 *
 * - **no live session with this id** → `drop`. The window is already gone: Adam closed it,
 *   or it ended itself and the shell ran `exit`. There is nothing to park and nothing to
 *   signal. Note this is an *identity* miss and not a pid miss, so it cannot be fooled by
 *   pid reuse the way a bare pid check could be.
 * - **busy** → `wait`. It is working. This is the guard that matters most and it is the
 *   cheapest one: a window mid-turn must never be closed, whatever else is true.
 * - **idle, but not for long enough** → `wait`. Because "idle" is a status the session
 *   writes about itself and the gap between two turns looks exactly like the end of the
 *   last one. The grace here is minutes rather than lib/reap.js's ninety seconds, and the
 *   difference is deliberate: there, a *worker* had already reached one of its documented
 *   endings, so the only question was whether it had stopped talking. Here the ending is
 *   being *inferred* from silence alone, and an inference deserves a longer look.
 * - **idle long enough** → `park`. Its next move is Adam's, whatever it was opened to do.
 *
 * - **anything else** → `wait`, but no longer forever. An unrecognised status is a
 *   sentence this file cannot read, so the honest first answer is "somebody may be in
 *   there" and the safe direction is to leave the window open — which is what every
 *   version of this did, unconditionally. Unconditional is what made it a hole. A Claude
 *   Code record only moves when the session moves, so a window abandoned in a state
 *   nothing here enumerates is invisible to every sweep at once — `sweepCandidate` in
 *   lib/reap.js asks for exactly `idle` too — and it stays on the screen for as long as
 *   the Mac is up. One was measured at four days and sixteen hours in `shell`, holding a
 *   worktree lock. So the wait is bounded by `stuckMinutes`: past that, a status that has
 *   not moved is stale rather than mysterious, and the window is parked like any other.
 *   `busy` keeps its unconditional `wait` above, because that is the one status that
 *   means an agent is mid-sentence.
 */
export function parkDecision(
  rec,
  live,
  { idleMinutes = 10, stuckMinutes = PARK_DEFAULTS.parkStuckMinutes, now = new Date() } = {}
) {
  if (!parkable(rec)) return { act: 'drop', why: 'nothing about it could be parked' };
  if (!live) return { act: 'drop', why: 'its window is gone' };
  if (live.status === 'busy') return { act: 'wait', why: 'it is working' };
  const idleFor = (now.getTime() - Date.parse(live.at || rec.at || '')) / 60000;
  if (!Number.isFinite(idleFor)) return { act: 'wait', why: 'it has not said when it went quiet' };
  if (live.status !== 'idle') {
    const status = live.status || 'unknown';
    return idleFor < stuckMinutes
      ? { act: 'wait', why: `its status is "${status}"`, idleFor }
      : {
          act: 'park',
          why: `its status has said "${status}" for ${Math.round(idleFor)}m — nothing is in there`,
          idleFor,
        };
  }
  if (idleFor < idleMinutes) return { act: 'wait', why: `quiet for ${Math.round(idleFor)}m of ${idleMinutes}m`, idleFor };
  return { act: 'park', why: `quiet for ${Math.round(idleFor)}m — it is waiting on you`, idleFor };
}

export function prunePark(parked, now = new Date()) {
  const cutoff = now.getTime() - PARK_TTL_MS;
  const rows = Object.entries(parked || {})
    .filter(([, rec]) => parkable(rec))
    .map(([key, rec]) => [key, rec, Date.parse(rec.at || '')])
    // An unreadable timestamp is kept and sorted last rather than dropped: the
    // conversation is still resumable, and the date is the smaller half of the record.
    .filter(([, , at]) => !Number.isFinite(at) || at >= cutoff)
    .sort((a, b) => (Number.isFinite(b[2]) ? b[2] : 0) - (Number.isFinite(a[2]) ? a[2] : 0))
    .slice(0, PARK_MAX);
  return Object.fromEntries(rows.map(([key, rec]) => [key, rec]));
}
