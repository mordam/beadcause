import { enlarged, probe } from './iterm.js';
import { focusSession } from './session.js';

/**
 * Point the Mac at one session's window, make it big, and put it back afterwards.
 *
 * `/session?pid=…` can tail a session's transcript and type into it, and until now
 * could not tell you *which window on the desk it is*. On a Mac with a dozen worktree
 * sessions open that is the difference between reading about a session and standing in
 * front of it, and the hunt through iTerm's window list is the whole reason the page
 * felt like a viewer rather than a remote control.
 *
 * So: tap, and the window comes to the front at twice its size. Close the view, and it
 * goes back exactly where it was.
 *
 * ## Why the bounds are kept here and not in the page
 *
 * The rectangle a window has to be put back to is read off the window itself, in the
 * same `osascript` call that enlarges it — and the phone that asked is a device that
 * locks, reloads and gets swiped away. Held in the page, one background tab would
 * strand a double-size window on the Mac with nothing left anywhere that knew how big
 * it used to be. Held here, keyed by pid, the restore survives a reload; and the page
 * asking again gets the *same* saved rectangle rather than overwriting it with the
 * enlarged one, which is the whole of why doubling twice in a row still restores to
 * where you started.
 *
 * ## What puts it back when nothing closes the view
 *
 * A phone locks mid-read. A tab is swiped away. Chrome discards the page. None of
 * those send anything, so the explicit restore cannot be the only one — and a window
 * left at double size forever is exactly the mess this must not make.
 *
 * The answer costs no new machinery, because the page already polls. `/api/session-log`
 * runs every two seconds while the view is open and touches the lease; the sweep below
 * puts back anything whose lease has lapsed. So "somebody still has this session's page
 * open" is measured rather than promised, and every way of walking away — deliberate or
 * not — ends with the window where it was.
 *
 * Closing the view properly is instant and does not wait for that: the page sends a
 * restore as it is torn down, which covers the ✕, the back button and a closed tab. The
 * lease is only for the ways of leaving that send nothing, and `LEASE_MS` says why it is
 * as long as it is.
 *
 * ## What is deliberately *not* here
 *
 * **Nothing is persisted.** These rectangles live for as long as this process does, and
 * a daemon that restarts — or a blue/green swap — forgets them, leaving the window big.
 * That is the lesser evil: a pid is reused by the operating system, so a rectangle read
 * off disk after a reboot could move a window belonging to an entirely different
 * process, and a window you have to resize by hand once beats a window that jumps.
 *
 * **Focus is not handed back on close.** `restoreApp` exists in lib/iterm.js and is used
 * when the daemon opens a session behind your back, where borrowing the keyboard is an
 * accident. Here it is the request: you asked for that window to be in front because you
 * are about to use it, and putting Chrome back over it a moment later would undo the one
 * thing the button is for.
 */

/**
 * How long after the last poll a held window is put back. See the header.
 *
 * Three minutes, and the number is a compromise between the two ways of being wrong.
 * Too short and it undoes the feature: you tap the button, put the phone in your
 * pocket and walk to the Mac — the phone locks, the polling stops, and the window
 * shrinks back while you are standing in front of it. Too long and a tab swiped away
 * leaves a double-size window on the desk for the afternoon. Walking to a Mac takes
 * well under three minutes; noticing a window that is too big takes rather more.
 */
export const LEASE_MS = 180_000;

/** How often the lapse is checked. The miss is bounded by this, not by the lease. */
const SWEEP_MS = 20_000;

/**
 * pid → `{ rect, tty, at }`, for every window currently held at double size.
 *
 * `rect` is where the window was *before* it was enlarged and is never overwritten
 * while the entry lives; `tty` is the handle to put it back with, kept here rather than
 * re-resolved because a restore has to work for a session whose process has since
 * exited; `at` is the lease.
 */
const held = new Map();

let timer = null;

/**
 * The two calls that touch the Mac, passed rather than reached for.
 *
 * `ask` is `focusSession` and `measure` is `probe`, and every function below defaults
 * to them — the server never passes either. They are parameters so that the rules this
 * module actually enforces (the saved rectangle is written once, a restore consumes it,
 * a lapsed lease puts the window back) can be exercised by test/focus.mjs against a
 * window made of numbers. There is no other way to test them: the real ones need a Mac
 * with iTerm open, and a test that drove those would resize whatever window answered.
 */

/** Is this session's window currently held big? What the page draws its button from. */
export const isHeld = (pid) => held.has(pid);

/** Every pid held, for a test or a status read. */
export const heldPids = () => [...held.keys()];

/**
 * The page is still open — keep the window big.
 *
 * Called from `/api/session-log`, which is the poll the view already makes. Untouched
 * pids are left alone rather than treated as an error: most sessions are not held, and
 * this runs twice a second per open page.
 */
export function touch(pid, now = Date.now()) {
  const entry = held.get(pid);
  if (entry) entry.at = now;
  return !!entry;
}

/** Drop the record without touching the window. The window has gone, or a test is done. */
export function forget(pid) {
  held.delete(pid);
  if (!held.size) stopSweep();
}

function startSweep() {
  if (timer || !held.size) return;
  timer = setInterval(() => {
    sweep().catch(() => {});
  }, SWEEP_MS);
  // Never hold the process open. A pending restore is not a reason for the daemon —
  // or a test — to refuse to exit, and the window outlives us either way.
  if (typeof timer.unref === 'function') timer.unref();
}

/** Stop the timer. Exported for tests, which must not leave an interval behind. */
export function stopSweep() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

/**
 * Bring the window up and double it — or, if it is already up, just raise it again.
 *
 * Three `osascript` calls in a row, and the order is the point.
 *
 * The screens are measured **first, on their own**. They were measured alongside the
 * raise to begin with — the probe does not depend on which window this is, so running
 * the two together looked free — and it is not: both calls talk to iTerm, an `activate`
 * holds the Apple event queue, and the probe timed out on the very first real run. It
 * fails silently, resolving to no screens at all, and the window that should have been
 * clamped grew 368px off the left edge of the display. So it goes first, alone, and the
 * ~150ms it costs is paid before anything has moved.
 *
 * Then the window is read *and* raised in one call — so the Mac responds to the tap
 * while the arithmetic happens — and the third sets the rectangle worked out from that
 * reading. The read and the set cannot be merged: the reading is the record of where
 * the window was, and it has to be taken before the same call changes it.
 *
 * A second tap on a window already held does **not** re-read and re-save: the saved
 * rectangle is the one from before any of this, and overwriting it with the enlarged
 * one is precisely how a window would end up with no way back. It re-raises instead,
 * which is what a second tap means anyway — you lost it behind something.
 *
 * Resolves `{ ok: true, rect }`, or `{ ok: false, gone: true }` when the window has
 * closed. A refusal from macOS is thrown, not turned into `gone`: "iTerm would not talk
 * to us" and "that window is gone" must not be the same answer.
 */
export async function bringUp(pid, tty, { factor = 2, ask = focusSession, measure = probe } = {}) {
  const already = held.get(pid);
  if (already) {
    const seen = await ask(already.tty, { front: true });
    if (!seen) {
      forget(pid);
      return { ok: false, gone: true };
    }
    already.at = Date.now();
    return { ok: true, rect: already.rect, again: true };
  }

  // Never fatal: with no measurement the window grows from its top left corner instead
  // of about its centre, which is `magnify`'s safe direction, not a failed tap.
  const measured = await measure().catch(() => null);
  const before = await ask(tty, { front: true });
  if (!before) return { ok: false, gone: true };

  const target = enlarged(before, measured, factor);
  const still = await ask(tty, { bounds: target });
  // The window closed between the reading and the set. Nothing was resized, so there is
  // nothing to remember — and remembering it would leave a phantom the sweep acts on.
  if (!still) return { ok: false, gone: true };

  held.set(pid, { rect: before, tty, at: Date.now() });
  startSweep();
  return { ok: true, rect: before, target };
}

/**
 * Put it back exactly where it was.
 *
 * The record is dropped **before** the window is touched, so a sweep firing in the same
 * moment cannot set the same bounds twice or, worse, act on an entry this call is in
 * the middle of consuming. Nothing held is not an error: a close and a lapsed lease can
 * both arrive, and the second one is a no-op rather than a complaint.
 *
 * …and it is **put back if the call throws**, because dropping it first has one bad
 * ending on its own: `osascript` refused, and the only record of where that window
 * belongs has just been thrown away, so the window stays big forever with nothing left
 * anywhere that could fix it. Returned to the map with its original lease, it is still
 * lapsed and the next sweep tries again. `MAX_TRIES` is what stops that becoming a
 * refusal logged every twenty seconds until the daemon restarts — a TCC denial does not
 * heal itself, and after three attempts the honest thing is to stop.
 *
 * Nothing here checks that the session is still alive, deliberately — a window whose
 * session exited while it was big is exactly the window most in need of being put back,
 * and the tty on the record is a handle iTerm can still answer for.
 */
export async function putBack(pid, { ask = focusSession } = {}) {
  const entry = held.get(pid);
  if (!entry) return { restored: false };
  forget(pid);
  try {
    const seen = await ask(entry.tty, { bounds: entry.rect });
    return { restored: !!seen, rect: entry.rect };
  } catch (err) {
    entry.tries = (entry.tries || 0) + 1;
    // A later tap re-held it while this was in flight: that record is the current one
    // and describes the same window, so leave it alone.
    if (entry.tries < MAX_TRIES && !held.has(pid)) {
      held.set(pid, entry);
      startSweep();
    }
    throw err;
  }
}

/** How many times a refused restore is retried before the window is left where it is. */
const MAX_TRIES = 3;

/** Put back every window whose page stopped polling. Failures are logged, never thrown. */
export async function sweep(now = Date.now(), opts = {}) {
  const lapsed = [...held.entries()].filter(([, e]) => now - e.at > LEASE_MS).map(([pid]) => pid);
  for (const pid of lapsed) {
    try {
      await putBack(pid, opts);
      console.log(`[beadcause] put pid ${pid}'s window back — nothing has watched it since`);
    } catch (err) {
      // `putBack` has already decided whether this is worth another go — three, then it
      // gives up and the window stays big, which is where a daemon restart would have
      // left it anyway.
      console.error(`[beadcause] could not put pid ${pid}'s window back:`, err.message);
    }
  }
  return lapsed;
}
