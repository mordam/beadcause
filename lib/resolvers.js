/**
 * One pull request, one session resolving it — and two of those at a time on this Mac.
 *
 * *Resolve conflicts* on the full-screen PR view opens a session on the branch whose
 * whole job is the merge — see `conflictPromptFor` in lib/session.js. On 2026-08-11 one
 * press of it produced **two**, both briefed identically, both told (correctly, for one
 * of them) to work in the worktree the branch was already checked out in. They merged
 * `main` into the same tree at the same time, and the damage was not a conflict marker
 * somebody would notice: one session's `git merge --abort` landed between the other's
 * resolution and its `git add && git commit`, so commit 2183762 carried **unresolved
 * conflict markers into `public/console.js`** with two parents and a perfectly ordinary
 * merge-commit shape. `test/dismissed.mjs` went 2/16. It was caught by a human reading
 * the diff, and the repair had to check that `main`'s side was genuinely still in the
 * tree — an aborted merge can reset the index and still commit, which silently reverts
 * everything the base added while looking like a normal merge. That is bc-utyr.
 *
 * So the second press must not open a second window. What it does instead is the useful
 * half of what it was asking for: it **speaks to the session that already has this pull
 * request**, which is a thing the daemon can do (`messageSession`, lib/session.js) and
 * which answers the question the press was really asking — *is anything happening?*
 *
 * Three states, and the point of the file is that they are three rather than two:
 *
 * 1. **Nothing is on it.** Open a window, and remember the handle.
 * 2. **Something is on it and answers.** The nudge lands in that window's TUI and the
 *    caller is told which session took it. No second window.
 * 3. **Something is on it and cannot be asked.** An iTerm too old to report a session
 *    id gives a record with no handle, and "I cannot ask" is not "it is gone" — the
 *    same distinction `reclaim` keeps in lib/advocate.js, and for the same reason:
 *    treating it as gone is what opens the second window. So it is refused, with the
 *    age said out loud, and the record ages out by itself (`BLIND_MS`) rather than
 *    stranding the button for good.
 *
 * **Everything for one pull request is serialised** — `underLock` — and that is not
 * belt-and-braces, it is the actual shape of the incident. One press produced two
 * requests within a moment of each other. A check-then-launch with an `await` in the
 * middle would let both pass the check before either had anything to find, which is
 * exactly the race that put markers in a commit. Under the lock the second request
 * arrives after the first has a handle to hand it, so it becomes case 2.
 *
 * ## And a fourth state, because a sweep is not a thumb
 *
 * Everything above caps sessions **per pull request**, which was the whole of the
 * problem for as long as the only way to open a resolver was a tap: a human presses one
 * button at a time, so five pull requests meant five deliberate presses spread over an
 * afternoon. A merge landing does not work that way. One merge into `main` can leave
 * five open branches conflicting at once, and the sweep that reacts to it (bc-9d37)
 * hands all five here in the same tick. Per-pull-request serialisation is *satisfied*
 * by that: five different keys, five locks, five windows, five copies of this repo's
 * own gate — twelve minutes of node each — running simultaneously on one laptop.
 *
 * So there is a global cap of `MAX_LIVE`, and the requests that do not fit **queue**
 * rather than being refused. A refusal would put the work back on whoever asked, and
 * the sweep has nowhere to put it: it reacts to a merge that has already happened and
 * will not come round again until the next one. Queued is the honest answer — the work
 * is still going to happen, just not yet — and it is what the phone is told too, so a
 * tap during a busy sweep reads as *third in line* rather than as a dead button.
 *
 * Two things make the queue more than a list:
 *
 * - **A slot frees when a window closes, and that has to be *learned*.** A record here
 *   is dropped on evidence or on age, and the evidence used to arrive for free: every
 *   question about a resolver came with a nudge to deliver. Nothing presses a button on
 *   behalf of a queued entry, so the drain asks instead — `sessionAlive`, which reads
 *   the window without typing into it, because a nudge per drain into an agent that is
 *   working is worse than no queue. macOS refusing to answer holds the slot, the same
 *   rule the nudge path keeps: a refusal is not evidence about the session.
 * - **A queued pull request is asked about again before its window opens.** By the time
 *   a slot frees, minutes or hours have passed: another resolver may have pushed and
 *   taken this branch's conflict with it, `main` may have moved again, Adam may have
 *   merged it from his phone. Opening a window for a conflict that is gone is exactly
 *   the pointless window the button's own refusal exists to prevent, so `recheck` is
 *   asked at the moment of the launch rather than trusted from when the entry was made.
 *
 * ## The keys survive a restart; the handles cannot, and that is the third state again
 *
 * This file used to say *in memory, never on disk*, on the reasoning that a record
 * outliving the daemon "would only ever be a claim about a window nobody can address any
 * more" — so a restart forgets, the next press opens a window, and that is the right
 * answer. Every clause of that is still true. The conclusion stopped being, on the day
 * the sweep arrived.
 *
 * The argument assumed the thing asking again is **a press**, which is to say a person,
 * arriving minutes or hours after the restart with no memory of their own. The sweep is
 * neither. It runs *because a merge landed*, and on this Mac a merge landing is what
 * kickstarts the daemon — so the restart does not happen at some unrelated moment, it
 * happens immediately before the caller asks, every single time. Measured on
 * 2026-08-14: 475 boots against 19 sweeps, and PR #243 was handed here by 18 consecutive
 * sweeps over seven hours, of which **11 opened a window and 2 queued one**. Thirteen
 * resolvers for one branch. Four of the remaining five are the only times two sweeps
 * happened to fall inside a single build's lifetime. That is bc-9d37.11, and it is the
 * cap in this file failing in exactly the way it was written to prevent.
 *
 * So the keys go to disk and the handles do not, and the split is not a compromise —
 * **it is state 3 above, arrived at from a different direction.** A record read back
 * after a restart is precisely "something is on it and cannot be asked": we know a
 * window was opened on #243 four minutes ago, we know the branch, and we have nothing to
 * type into. The file already knows what to do with that, already refuses to open a
 * second one, and already ages it out by itself at `BLIND_MS` — half an hour, chosen as
 * the length of a resolver's job. Nothing new had to be decided; the restarted daemon
 * simply gets to be as honest as the old-iTerm case has been all along, instead of
 * claiming the branch is untouched.
 *
 * Two things stay in memory, on the old reasoning, which still holds for them:
 *
 * - **The handle**, obviously — it is worth exactly as long as the iTerm that holds it,
 *   and writing one down would be inventing an address.
 * - **The queue**, and more so. A waiting entry carries a closure that opens a window
 *   and a `recheck` that asks GitHub, neither of which can be written down. It also does
 *   not need to be: a queued conflict nobody reached is one the *next* sweep finds again
 *   from GitHub, which is a better source than a closure this daemon has been holding
 *   since breakfast — the same sentence `QUEUE_TTL_MS` is set by. A lost queue costs a
 *   delay. A lost registry costs a second window in the same tree, which is bc-utyr.
 */
import fs from 'node:fs';
import path from 'node:path';
import { messageSession, sessionAlive } from './session.js';
import { writeJsonAtomic } from './atomic.js';
import { CONFIG_DIR } from './config.js';

/**
 * How long a record with a handle is kept at all.
 *
 * Garbage collection and nothing more: a handle is asked on every press, so a session
 * that exited hours ago answers `missing` and is forgotten on the spot whatever this
 * says. It is here so a daemon up for a fortnight is not holding a map of every pull
 * request anyone ever pressed the button on.
 */
const TTL_MS = 4 * 60 * 60 * 1000;

/**
 * And how long a record *without* one is believed.
 *
 * This is the number that decides something, because a record with no handle can only
 * be believed or disbelieved — there is nothing to ask. Half an hour is a resolver's
 * job: merge, resolve, run the repo's gate, push. Longer would strand the button on the
 * one Mac where iTerm reports nothing; shorter would let a slow test run turn into a
 * second window, which is the bug.
 */
const BLIND_MS = 30 * 60 * 1000;

/**
 * How many resolvers this Mac runs at once.
 *
 * Not a guess about iTerm, which would happily open twenty. It is about what each of
 * those windows *does*: merge, resolve, and then run the repo's own gate, which here is
 * every suite in test/ and a good twelve minutes of node. Two of those overlap
 * comfortably; five make each other slow enough that the sessions start reading their
 * own timeouts as failures, and the Mac is unusable while they do it.
 *
 * Two rather than one because the common case is not five, it is two — a merge that
 * conflicts a pair of branches — and serialising those costs a whole gate run of
 * wall-clock for nothing. The number is in prose nowhere: everything that says it out
 * loud interpolates it from here.
 */
export const MAX_LIVE = 2;

/**
 * How long a queued entry waits before the queue gives up on it.
 *
 * Four hours is deliberately the same as `TTL_MS`, and means the same thing: past it,
 * nothing here is describing the present any more. A conflict nobody reached in four
 * hours is one the next merge's sweep will find again from GitHub, which is a better
 * source than a closure this daemon has been holding since breakfast.
 */
const QUEUE_TTL_MS = TTL_MS;

/**
 * How often the drain asks whether a window has closed, while anything is waiting.
 *
 * Only while: the timer is started when something queues and stopped when the queue
 * empties, so a daemon nobody has swept on never runs it at all. Twenty seconds against
 * a resolver that takes a quarter of an hour is the wait being invisible without the
 * asking being constant — it costs two `osascript` readings, and only when the cap is
 * actually full.
 */
const DRAIN_MS = 20 * 1000;

/** `${workspace}#${number}` → what is on it. */
const live = new Map();

/**
 * Where the keys of `live` are kept so the next daemon can read them.
 *
 * Its own file rather than a corner of state.json: this is written whenever a window
 * opens or closes and read exactly once per process, which is the opposite traffic to
 * everything in there, and a reader that finds it missing or unparseable is meant to
 * carry on with an empty registry rather than fail.
 */
export const RESOLVERS_PATH = path.join(CONFIG_DIR, 'resolvers.json');

/**
 * Write the whole registry, minus the handles. Never throws.
 *
 * **Whole, from memory, every time** — not read-modify-write. That is the mistake
 * bc-xl7n.35 was filed for one file over: `keep()` in lib/sweepcard.js re-read a shared
 * map, edited one key and wrote it all back, so a writer holding a stale read dropped
 * every record added since it read. There is nothing to re-read here. `live` is the
 * source of truth and this file is its shadow, so the write can only ever be a
 * transcription of what this process already knows.
 *
 * A config directory that will not take the file costs the *next* daemon's knowledge and
 * not this one's window, so it is swallowed — the same trade lib/sweepcard.js and
 * lib/mergesweep.js make, and for the same reason: the window is already open by the
 * time we are called, and throwing here would turn a successful launch into a failure.
 */
function persist() {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    // `term` is deliberately not in this list rather than deleted from a spread: a handle
    // is an iTerm object, JSON.stringify would quietly turn it into something that looks
    // like a handle, and a record that *claims* an address is worse than one with none.
    writeJsonAtomic(
      RESOLVERS_PATH,
      [...live.values()].map(({ workspace, number, branch, dir, at }) => ({ workspace, number, branch, dir, at }))
    );
  } catch {
    /* the window is open either way; the next daemon just will not know about it */
  }
}

/**
 * Read back what the last daemon left, as records with no handle.
 *
 * Every one of them arrives in state 3 — believed, unaskable, and aged out by `find` at
 * `BLIND_MS`. `restored` is carried so the refusal can say *why* it has no handle, which
 * is a different sentence from the iTerm-too-old case and a different thing for Adam to
 * do about it: there is a window on his screen, and it is fine.
 *
 * Anything malformed is dropped rather than repaired. A record here decides whether a
 * window opens, and half of one is not evidence — the cost of dropping it is one extra
 * window, which is where we already were.
 */
function restore() {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(RESOLVERS_PATH, 'utf8'));
  } catch {
    return 0;
  }
  if (!Array.isArray(raw)) return 0;
  let n = 0;
  for (const rec of raw) {
    if (!rec || typeof rec !== 'object') continue;
    const number = Number(rec.number);
    if (!rec.workspace || !Number.isInteger(number) || number <= 0) continue;
    if (!rec.at || Number.isNaN(new Date(rec.at).getTime())) continue;
    live.set(keyFor(rec.workspace, number), {
      workspace: String(rec.workspace),
      number,
      branch: String(rec.branch || ''),
      dir: String(rec.dir || ''),
      term: null,
      at: String(rec.at),
      restored: true,
    });
    n += 1;
  }
  return n;
}

/** `${workspace}#${number}` → the tail of the queue of requests for it. */
const locks = new Map();

/** What is waiting for a window, oldest first. Each entry knows how to open its own. */
const waiting = [];

/** The interval that drains `waiting`, or null when nothing is waiting. */
let drainTimer = null;

/** The drain in flight, so two callers cannot both start the same queued entry. */
let draining = null;

const keyFor = (workspace, number) => `${workspace}#${Number(number)}`;

/**
 * Run `fn` with nothing else running for this pull request.
 *
 * A promise chain per key rather than a flag, because the thing being protected spans
 * an `await` — the whole decide-then-launch — and a flag can only be read, not waited
 * on. Requests queue in arrival order and each one sees what the one before it left.
 *
 * The chain is dropped once nothing is waiting behind it, so a busy day does not leave
 * a resolved promise per pull request behind forever. `fn`'s own failure must not break
 * the chain: a launch that threw is a window that did not open, and the next press has
 * to be able to try.
 */
async function underLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const mine = prev.then(() => new Promise((r) => (release = r)));
  locks.set(key, mine);
  await prev;
  try {
    return await fn();
  } finally {
    release();
    // Only if nothing queued behind us — otherwise the next request owns the chain and
    // deleting it here would let a third one overtake it.
    if (locks.get(key) === mine) locks.delete(key);
  }
}

/** What is remembered about the session on one pull request, or null. */
export function find(workspace, number, now = Date.now()) {
  const key = keyFor(workspace, number);
  const rec = live.get(key);
  if (!rec) return null;
  const age = now - new Date(rec.at).getTime();
  if (age > TTL_MS || (!rec.term && age > BLIND_MS)) {
    live.delete(key);
    // Ageing out is a real change of mind, not bookkeeping: past `BLIND_MS` this file has
    // stopped believing in that window, and a restart that read the record back would
    // start believing in it again for another half hour.
    persist();
    return null;
  }
  return rec;
}

/** Remember the session that just took a pull request. */
export function remember(workspace, number, { branch = '', dir = '', term = null } = {}, now = new Date()) {
  const rec = {
    workspace,
    number: Number(number),
    branch: String(branch || ''),
    dir: String(dir || ''),
    term: term || null,
    at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
  live.set(keyFor(workspace, number), rec);
  persist();
  return rec;
}

/** Drop what is remembered — a session that answered `missing`, or a test. */
export function forget(workspace, number) {
  const had = live.delete(keyFor(workspace, number));
  if (had) persist();
  return had;
}

/** Every session currently believed to be resolving something. Newest first. */
export function list(now = Date.now()) {
  const out = [];
  for (const rec of [...live.values()]) {
    if (find(rec.workspace, rec.number, now)) out.push(rec);
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Everything waiting for a window, oldest first — which is the order it will get one.
 *
 * Without the closures: the caller wants to say what is in line, and `launch` and
 * `recheck` are functions that would only be `[Function]` in any answer built from this.
 */
export function pending() {
  return waiting.map((entry, i) => inLine(entry, i + 1));
}

/** One waiting entry as anything outside this file may see it: no closures, and its place. */
const inLine = ({ workspace, number, branch, at }, place) => ({ workspace, number, branch, at, place });

/**
 * Tests, and nothing else: back to a daemon that has never run and left nothing behind.
 *
 * The file goes too. A suite that reset only the memory would carry one case's windows
 * into the next one through the disk, which is the opposite of what `reset` is for — and
 * it would do it invisibly, because nothing reads the file until a `restart`.
 */
export function reset() {
  live.clear();
  locks.clear();
  waiting.length = 0;
  stopDrain();
  draining = null;
  try {
    fs.rmSync(RESOLVERS_PATH, { force: true });
  } catch {
    /* nothing was there, or nothing can be done about it */
  }
}

/**
 * What a daemon boot does, without the daemon: forget the process's state, read the disk.
 *
 * Exported for tests, because **this bug is invisible from inside one process**. Every
 * assertion in test/resolvers.mjs before bc-9d37.11 was about a single lifetime, which is
 * why a cap that failed thirteen times in seven hours had a green suite over it. The two
 * things it does are the two halves of the finding: the handles are gone (so the second
 * sweep cannot nudge), and the keys are not (so it must not launch).
 *
 * The queue is *not* restored, and that is the design and not an omission — see the
 * header. Returns how many records came back, which is the thing worth logging at boot.
 */
export function restart() {
  live.clear();
  locks.clear();
  waiting.length = 0;
  stopDrain();
  draining = null;
  return restore();
}

/**
 * What is typed into a session that already has this pull request.
 *
 * One line, for the reason `checkinMessage` is one line: it lands in a window an agent
 * is working in, and six lines of it is six lines to scroll past. It says what happened
 * rather than inventing an instruction from it — the session's brief has not changed and
 * re-stating it would read as a new task — and it names the one thing a second request
 * usually means, which is that nobody can tell whether this is stuck.
 *
 * ## Three reasons a second request arrives, and they are not the same sentence
 *
 * This used to say *Adam pressed Resolve conflicts again* whatever asked, which is true
 * of a thumb and false of the other two — and it is the same falsehood `conflictPromptFor`
 * carries a `sweptAfter` to avoid (bc-9d37.2). One function with a parameter rather than
 * three messages, for that function's reason: three messages drift, and the one that
 * drifts is the one nobody presses a button to read.
 *
 * - **A second press.** The default, and unchanged.
 * - **`sweptAfter`** — a merge landed and lib/prsweep.js swept the branches behind it, one
 *   of which already had a resolver. Nobody pressed anything, and a session told a person
 *   did invents an audience to match: somebody at the Mac, waiting for it to hurry up.
 * - **`instruction`** — Adam answered the sweep card that reported this pull request handed
 *   back, and his sentence is the decision the session stopped for (bc-9d37.8). That one
 *   *is* new work, so it is the one variant that does not end in "there is nothing to do".
 */
export function nudgeMessage(number, owner = 'Adam', { sweptAfter = null, instruction = '' } = {}) {
  // One line means one line, and Adam types into a phone: his newlines become spaces
  // here rather than six lines in somebody's window.
  const said = String(instruction || '').trim().replace(/\s+/g, ' ');
  // A boolean is not a pull request number — `Number(true)` is `1`, and "#1 merged" is
  // precisely the confident falsehood this guard exists to stop. The same guard as
  // `conflictPromptFor`'s, and copied deliberately: a sweep that cannot name the merge
  // still gets the swept sentence, it just does not invent a number for it.
  const landed = typeof sweptAfter === 'boolean' ? NaN : Number(sweptAfter);
  const merged = Number.isInteger(landed) && landed > 0 ? `#${landed}` : 'A pull request';
  const tail =
    `so there is nothing new to do and no second session is being opened. ` +
    `If you are stuck, say what on the pull request (\`gh pr comment ${number}\`) and stop; ` +
    `starting a second merge in this tree is what that request must not cause.`;
  if (said) {
    return (
      `** BEADCAUSE ** ${owner} answered the sweep card about #${number} with an instruction for you: ` +
      `“${said}” — take that as the decision on the conflict, not as a suggestion, and carry on in this ` +
      `window. You already have #${number}, so no second session is being opened for it.`
    );
  }
  if (sweptAfter) {
    return (
      `** BEADCAUSE ** Nobody pressed anything — ${merged} merged and beadcause swept the branches ` +
      `still open behind it, and #${number} is one that no longer fits. You already have it, ${tail}`
    );
  }
  return `** BEADCAUSE ** ${owner} pressed Resolve conflicts on #${number} again — you already have it, ${tail}`;
}

/** How long ago, in the words a refusal can use. */
function ago(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  if (mins < 1) return 'a moment ago';
  if (mins === 1) return 'a minute ago';
  if (mins < 60) return `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? 'an hour ago' : `${hours} hours ago`;
}

/** 1st, 2nd, 3rd, 11th — a place in the queue, in the words a sentence can use. */
function nth(n) {
  const teen = n % 100;
  if (teen >= 11 && teen <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] || 'th'}`;
}

/** The sentence a queued pull request reads back, on the phone and in the log. */
function queuedNote(number, place) {
  return (
    `#${number} is ${nth(place)} in line — ${MAX_LIVE} resolvers are already running on this Mac, ` +
    `and a window opens for it as soon as one of them is done`
  );
}

/** Start the drain if anything is waiting for a window, and leave it alone if it is running. */
function scheduleDrain() {
  if (drainTimer || !waiting.length) return;
  drainTimer = setInterval(() => {
    pump().catch((err) => console.error(`[resolvers] drain failed — ${String(err.message || err).split('\n')[0]}`));
  }, DRAIN_MS);
  // Never a reason to keep the process up: a queue is a claim about windows, and a
  // daemon on its way out has nothing to open them into.
  drainTimer.unref?.();
}

function stopDrain() {
  if (drainTimer) clearInterval(drainTimer);
  drainTimer = null;
}

/**
 * Start one queued entry, if it should still be started at all.
 *
 * Under the same per-pull-request lock a press takes, and for the same reason: the
 * drain and a press that arrives during it are two requests deciding about one pull
 * request, which is the shape bc-utyr took. Under the lock, whichever is second finds
 * what the first left.
 *
 * `recheck` is the question the entry was queued with, asked now rather than then —
 * `true` to go ahead, a string saying why not, or any other falsy value for a bare no.
 * It **throwing** is not an answer: GitHub being unreachable for a moment is not the
 * conflict having cleared, and dropping the entry on it is the same mistake as reading
 * a macOS refusal as a closed window. So it goes back to the head of the line.
 */
async function start(entry, now) {
  return underLock(keyFor(entry.workspace, entry.number), async () => {
    const held = find(entry.workspace, entry.number, now);
    if (held) return { skipped: `a session is already on #${entry.number}` };
    if (entry.recheck) {
      let go;
      try {
        go = await entry.recheck();
      } catch (err) {
        return { retry: String(err.message || err).split('\n')[0] };
      }
      if (go !== true) {
        return {
          dropped:
            typeof go === 'string' && go
              ? go
              : `GitHub no longer reports #${entry.number} as conflicting — nothing left to open a window for`,
        };
      }
    }
    let opened;
    try {
      opened = await entry.launch();
    } catch (err) {
      return { failed: String(err.message || err).split('\n')[0] };
    }
    remember(
      entry.workspace,
      entry.number,
      { branch: entry.branch, dir: opened?.dir || '', term: opened?.term || null },
      new Date(now)
    );
    return { opened };
  });
}

/**
 * Free what has finished, and start what fits — the whole of the queue moving.
 *
 * Called by its own timer while anything is waiting, and directly by a test or by
 * anything that has just learned a resolver is done. Coalesced rather than queued: two
 * callers asking "is there room now" want the same answer, and running two drains at
 * once is how one entry gets started twice.
 *
 * The probe is only ever asked when the cap is **full**, because that is the only time
 * its answer changes anything, and it is only ever asked of a record with a handle —
 * one without cannot be asked at all and ages out at `BLIND_MS`, which is the third
 * state this file is built around.
 *
 * Resolves a summary of what moved. Nothing here throws for one entry's sake: a launch
 * that failed is one window that did not open, and the four behind it still should.
 */
export function pump({ probe = sessionAlive, now = Date.now() } = {}) {
  if (draining) return draining;
  draining = (async () => {
    const out = { opened: [], freed: [], dropped: [], failed: [], waiting: 0 };
    try {
      // Entries nobody reached in four hours. Ahead of everything else, so the cap is
      // never held full on behalf of something that is not going to open.
      for (let i = waiting.length - 1; i >= 0; i -= 1) {
        if (now - Date.parse(waiting[i].at) <= QUEUE_TTL_MS) continue;
        const [gone] = waiting.splice(i, 1);
        out.dropped.push({ workspace: gone.workspace, number: gone.number, why: 'waited more than four hours for a window' });
      }

      for (const rec of list(now)) {
        if (!waiting.length || list(now).length < MAX_LIVE) break;
        if (!rec.term) continue; // Nothing to ask. It ages out on its own.
        let alive;
        try {
          alive = await probe(rec.term);
        } catch (err) {
          // Held, deliberately. A refusal from macOS says nothing about the session,
          // and freeing a slot on the strength of one takes it from an agent mid-merge.
          console.error(`[resolvers] could not ask about #${rec.number}'s window — ${String(err.message || err).split('\n')[0]}`);
          continue;
        }
        if (alive) continue;
        forget(rec.workspace, rec.number);
        out.freed.push({ workspace: rec.workspace, number: rec.number });
      }

      while (waiting.length && list(now).length < MAX_LIVE) {
        const entry = waiting[0];
        const result = await start(entry, now);
        if (result.retry) {
          // Back at the head, untouched. Asking about the one behind it would only fail
          // the same way, so the drain stops here and the next one asks again.
          console.error(`[resolvers] #${entry.number} stays in line — ${result.retry}`);
          break;
        }
        waiting.shift();
        if (result.opened) out.opened.push({ workspace: entry.workspace, number: entry.number, branch: entry.branch, opened: result.opened });
        else if (result.dropped) out.dropped.push({ workspace: entry.workspace, number: entry.number, why: result.dropped });
        else if (result.failed) out.failed.push({ workspace: entry.workspace, number: entry.number, why: result.failed });
        else if (result.skipped) out.dropped.push({ workspace: entry.workspace, number: entry.number, why: result.skipped });
      }
    } finally {
      out.waiting = waiting.length;
      if (waiting.length) scheduleDrain();
      else stopDrain();
    }

    const said = [
      out.opened.length ? `opened ${out.opened.map((o) => `#${o.number}`).join(', ')}` : '',
      out.freed.length ? `${out.freed.length} window${out.freed.length === 1 ? '' : 's'} closed` : '',
      out.dropped.length ? `dropped ${out.dropped.map((d) => `#${d.number}`).join(', ')}` : '',
      out.failed.length ? `could not open ${out.failed.map((f) => `#${f.number}`).join(', ')}` : '',
      out.waiting ? `${out.waiting} still in line` : '',
    ].filter(Boolean);
    if (said.length) console.log(`[resolvers] ${said.join(', ')}`);
    return out;
  })();
  return draining.finally(() => {
    draining = null;
  });
}

/**
 * Get a pull request resolved, without ever getting it resolved twice.
 *
 * `launch` is the thing that actually opens the window — `openConflictSession`, passed
 * in rather than imported so this file owns the decision and not the act, and so a test
 * can assert the decision without an iTerm. It resolves to whatever that returns, and
 * the `term` on it is the handle the next press will be answered with. `branch` comes
 * from the caller's row rather than from that result, which does not carry one: it is
 * only ever quoted back in a sentence, and a sentence naming the wrong branch is worse
 * than one naming none.
 *
 * Resolves to exactly one of:
 *
 *   { opened }              a window was opened; `opened` is `launch`'s result
 *   { reused, note }        a live session was told; nothing was opened
 *   { queued, note }        the Mac is full; a window opens for it when one frees
 *   { error, status, held? }  nothing was opened and nothing could be told; `held` is present
 *                           when the reason is that something already has it and has no handle —
 *                           an iTerm that cannot be asked, or a window this daemon has restarted
 *                           away from. A caller that logs outcomes should not call that a failure.
 *
 * `recheck` belongs to the queued case and is asked only there — at the moment a slot
 * frees, which may be an hour after this call. `true` to open the window, a string
 * saying why not, or any other falsy value. Without one a queued entry opens its window
 * whenever its turn comes, which is right for a caller that has no way to ask again and
 * wrong for one that does: everything that reaches GitHub should pass one.
 *
 * A throw from `launch` travels out untouched *on this path*: the caller already knows
 * how to turn iTerm's refusals into an HTTP status, and a failure to open is not a state
 * worth remembering — the record is written only once a window exists. On the queued
 * path there is no caller left to tell, so the drain logs it instead.
 *
 * `say` failing is *not* `missing`, the same rule `messageSession` states: macOS
 * refusing the Apple event and the window being gone must not be the same answer,
 * because the second one opens a window. So a refusal is reported as itself.
 *
 * `sweptAfter` and `instruction` are *why this was asked*, and they are only ever used on
 * the path where a session already has this pull request — the line typed into it. This
 * file does not build the brief for a window it opens (that is `launch`'s, and the caller
 * closes over it); the nudge is the one sentence it writes itself, and until bc-9d37.6 it
 * was the one place a sweep still claimed a thumb. See `nudgeMessage`.
 */
export async function resolveFor(
  workspace,
  number,
  launch,
  { branch = '', say = messageSession, owner = 'Adam', now = Date.now(), recheck = null, sweptAfter = null, instruction = '' } = {}
) {
  return underLock(keyFor(workspace, number), async () => {
    const held = find(workspace, number, now);
    if (held) {
      if (!held.term) {
        const when = ago(now - new Date(held.at).getTime());
        const where = held.branch ? ` on ${held.branch}` : '';
        return {
          status: 409,
          // `held` rides out with it so a caller that is not a thumb can tell this apart
          // from a failure. To a press these are both "nothing opened, go and look"; to
          // the sweep one of them is a window doing its job and the other is trouble, and
          // logging the first as `could not open` is what made bc-9d37.11 hard to see.
          held,
          error: held.restored
            ? `a session was opened on #${number} ${when} and this daemon has restarted since — the window ` +
              `is still on your screen${where}, it just cannot be typed into any more, so nothing is being ` +
              `opened for it here`
            : `a session was opened on #${number} ${when} and this iTerm ` +
              `cannot be asked whether it is still there — check the window${where} ` +
              `rather than opening a second one`,
        };
      }
      let answer;
      try {
        answer = await say(held.term, nudgeMessage(number, owner, { sweptAfter, instruction }));
      } catch (err) {
        return { status: err.status || 502, error: `could not reach the session already on #${number} — ${String(err.message || err).split('\n')[0]}` };
      }
      if (answer !== 'missing') {
        // The note is read back on a card and in the log, so it says the same true thing
        // the nudge did rather than the press it used to assume — see `nudgeMessage`.
        const what = instruction
          ? 'gave it your answer'
          : sweptAfter
            ? 'told it the sweep found this one again'
            : 'told it you pressed again';
        return {
          reused: held,
          note:
            `#${number} already has a session on it${held.branch ? `, on ${held.branch}` : ''} — ` +
            `${what} rather than opening a second one`,
        };
      }
      // Proven gone. This is the only place a record is dropped on evidence rather than
      // on age, and it is the common case: the resolver finished, the window closed.
      forget(workspace, number);
    }

    // Already in line. Said as its place rather than as a refusal, because a second ask
    // about a queued pull request is the same question a second press asks — *is
    // anything happening?* — and "third in line" answers it.
    const already = waiting.findIndex((e) => e.workspace === workspace && Number(e.number) === Number(number));
    if (already >= 0) return { queued: inLine(waiting[already], already + 1), note: queuedNote(number, already + 1) };

    // The global cap, and the only place it is applied. It sits *after* everything about
    // this pull request in particular: a second press over a live session is answered by
    // that session whether or not the Mac is full, and queueing it would be a window
    // opened later for work already being done.
    if (list(now).length >= MAX_LIVE) {
      const entry = {
        workspace,
        number: Number(number),
        branch: String(branch || ''),
        launch,
        recheck,
        at: new Date(now).toISOString(),
      };
      waiting.push(entry);
      scheduleDrain();
      // Not logged here, the same as every other answer on this path: the caller has the
      // repo's name and logs the whole outcome in one line. The *drain* logs, because by
      // then there is no caller left to do it.
      const place = waiting.length;
      return { queued: inLine(entry, place), note: queuedNote(number, place) };
    }

    const opened = await launch();
    remember(workspace, number, { branch, dir: opened?.dir || '', term: opened?.term || null }, new Date(now));
    return { opened };
  });
}

/**
 * The boot, and the whole point of the file having a disk at all.
 *
 * At module load, because a module is loaded once per process and a process is exactly
 * one daemon lifetime — there is no hook to forget to call and no ordering to get wrong.
 * It is the last thing in the file because `restore` reaches `keyFor`, which is a `const`
 * further up: called any earlier this is a temporal dead zone, not a registry.
 *
 * Silent when there was nothing to read, which is every test and every daemon that shut
 * down cleanly with no resolver running. When there *was*, it says so once — the sweep
 * that runs seconds from now is about to refuse to open windows on these, and this is the
 * line that makes that refusal legible rather than mysterious.
 */
const restoredAtBoot = restore();
if (restoredAtBoot) {
  console.log(
    `[resolvers] ${restoredAtBoot} window${restoredAtBoot === 1 ? '' : 's'} restored from the last daemon — ` +
      `${list().map((r) => `#${r.number}`).join(', ')}; no handle for ${restoredAtBoot === 1 ? 'it' : 'them'}, ` +
      `so nothing here will open a second one for the next ${Math.round(BLIND_MS / 60000)} minutes`
  );
}
