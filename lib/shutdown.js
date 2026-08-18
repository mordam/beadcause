/**
 * Kill what this process spawned, on the way out, including the ways out it did not choose.
 *
 * Both Chrome launchers in this repo — `scripts/helpers/chrome.mjs` for the 52
 * `scripts/*-check.mjs`, and `lib/browse.js` for the agent-facing browse tool — already
 * clean up on every path *through* their own code. A check that throws kills its Chrome
 * and deletes its profile; so does one that succeeds. What neither could clean up is the
 * path that never reaches their code again: the node process itself being killed.
 *
 * **That is the common case here, not the exotic one.** These run inside Claude Code
 * sessions on a laptop that holds eight or so at a time, and a session that is closed,
 * or reaped by lib/reap.js, or stopped mid-turn, takes a SIGTERM to the node pid. Chrome
 * was spawned as a child, not a process-group leader, so nothing else signals it: it is
 * reparented to pid 1 and lives until the machine is rebooted.
 *
 * **A leaked headless Chrome is not an idle background process — it takes the browser
 * away.** macOS LaunchServices counts a `--headless` instance as a running
 * `com.google.Chrome` like any other. Once one is orphaned, opening Chrome.app no longer
 * *starts* Chrome; it activates the headless instance, which has no UI and will never
 * make a window. Cmd-Q goes to the same place and appears to do nothing, and force
 * quitting the frontmost one leaves the others, so the symptom survives every obvious
 * remedy. Measured on 2026-08-18: five orphans, profiles named `beadcause-measure-*`,
 * command lines an exact match for `chromeArgs()`, the oldest from the previous evening
 * — and no way to open a browser on this Mac until they were killed by pid (bc-1eru).
 *
 * So the teardown a launcher already wrote is registered here as well, and run on `exit`
 * and on the three signals that mean "stop". Two rules make that safe:
 *
 * 1. **Teardowns must be synchronous.** `process.on('exit')` is the only hook that fires
 *    for `process.exit()` and for an uncaught exception, and nothing asynchronous
 *    scheduled inside it ever runs. A teardown that returns a promise here is a teardown
 *    that does not happen. Both callers therefore register a blunt sync twin —
 *    `proc.kill()` and `fs.rmSync` — of the graceful async teardown they run normally.
 * 2. **Signals are re-raised, not swallowed.** Installing a SIGTERM listener replaces
 *    node's default action, so a process that would have died of the signal would instead
 *    survive it, and one that reported 143 would report 0. After running the teardowns
 *    the handler removes itself and re-signals — but only if nothing else is listening.
 *    `bin/router.js`, `bin/monitor.js` and `bin/beadcause.js` all have their own SIGTERM
 *    shutdowns, and re-raising underneath one of those would run it a second time.
 *
 * There is deliberately no `uncaughtException` handler. Installing one *suppresses* the
 * crash, which would turn a bug into a hang; the `exit` listener already covers it,
 * because node exits through it after printing the trace.
 */

/** The sync teardowns to run when this process ends, in registration order. */
const live = new Set();

/** The signals worth catching: the two a supervisor sends, and the one a terminal sends. */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

let armed = false;

/**
 * Run every registered teardown once, in order, and forget it.
 *
 * Removed from the set *before* it is called, so a teardown that throws cannot be
 * retried by a later path and cannot be run twice by `exit` following a signal. Errors
 * are dropped rather than reported: this runs while the process is dying, there is no
 * one left to tell, and one launcher's failure to delete a temp directory must not stop
 * the next one from killing its browser.
 */
function runAll() {
  for (const fn of [...live]) {
    live.delete(fn);
    try {
      fn();
    } catch {
      /* dying; nowhere to report it */
    }
  }
}

/** Install the listeners, once per process, on first registration. */
function arm() {
  if (armed) return;
  armed = true;
  process.on('exit', runAll);
  for (const sig of SIGNALS) {
    const handler = () => {
      runAll();
      // Stand down, then let the signal mean what it meant before this file existed —
      // unless somebody else is still listening for it, in which case the exit is
      // theirs to decide and re-raising would only run their handler twice.
      process.off(sig, handler);
      if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
    };
    process.on(sig, handler);
  }
}

/**
 * Register `teardown` to run if this process ends before someone calls it properly.
 *
 * Returns an untrack function, and calling it is not optional: a long-lived process that
 * launches a browser per operation — the daemon serving `browse` — would otherwise hold
 * a closure over every browser it has ever opened, and kill a pid at exit that has since
 * been reused by something else. Untrack first, then tear down.
 *
 * @param {() => void} teardown synchronous; see rule 1 in the header.
 * @returns {() => void} removes it again.
 */
export function onProcessExit(teardown) {
  arm();
  live.add(teardown);
  return () => live.delete(teardown);
}

/** How many teardowns are pending. For tests; a leak here is a leak of pids. */
export const pendingCount = () => live.size;
