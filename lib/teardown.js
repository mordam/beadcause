/**
 * Cleanup that also runs when nobody called it.
 *
 * Every browser check in this repo ends the same way:
 *
 *     try { …assertions… } finally { close(); fs.rmSync(tmp, { recursive: true }); }
 *
 * and a `finally` covers exactly one of the three ways a process ends. It runs when the
 * body returns and when the body throws. It does **not** run when the process is
 * signalled — and being signalled is not the exotic case here, it is the ordinary one:
 * `scripts/checks.mjs` sends `SIGTERM` to any check that overruns its timeout, `npm test`
 * hands the same on, and Ctrl-C on a run somebody is watching is a `SIGINT`. In every one
 * of those the `finally` never runs, Chrome is reparented to launchd, and it goes on
 * running forever, because nothing about a headless Chrome makes it notice that whoever
 * asked for it has gone. That is bc-5isv: fifteen orphaned processes and 15 GB of
 * abandoned scratch directories, measured on this Mac.
 *
 * `onExit` is the missing arm. Register the same teardown here and it runs on the normal
 * path *and* on a signal, exactly once either way.
 *
 * ## Why the signal handlers are what they are
 *
 * **`exit` can only run synchronous code.** Node stops the event loop before it fires, so
 * a promise inside one is never resolved and an `fs.promises.rm` never happens. Everything
 * registered here must be synchronous — `proc.kill()` and `fs.rmSync()` both are, which is
 * why this is enough for the thing it was written for and would not be enough for a
 * teardown that needed to talk to anything.
 *
 * **Listening for a signal disables Node's default action for it.** Without a listener,
 * `SIGTERM` ends the process; with one, it does not, and a program that only ran its
 * cleanup would then sit there ignoring the signal it was just sent. So each handler ends
 * by re-raising: the listener is removed and the signal sent again, so the process dies of
 * the signal it was actually sent, with the right exit status, rather than of a
 * `process.exit(1)` that loses which signal it was. A supervisor reading `128 + n` gets
 * the truth.
 *
 * **`SIGKILL` cannot be caught, by anything, ever.** That is not a gap to be closed here;
 * it is why lib/strays.js exists.
 *
 * ## Once, and in reverse
 *
 * A run that both throws and is then signalled must not tear down twice — the second
 * `rmSync` of a path that is already gone is harmless, but the second `proc.kill` of a
 * recycled pid is not. So each registration is latched, and the `off()` returned by
 * `onExit` is what a normal path uses to say "already done" rather than racing its own
 * handler. Reverse order because these nest: a profile is removed after the Chrome
 * holding it, and the Chrome was registered first.
 */
import fs from 'node:fs';

/** The registered teardowns, newest last. */
const jobs = [];

/** Whether the process-level listeners are attached — one set, however many jobs. */
let wired = false;

/** Run everything still registered, newest first, swallowing whatever any of them throws. */
function drain() {
  while (jobs.length) {
    const job = jobs.pop();
    if (job.done) continue;
    job.done = true;
    try {
      job.fn();
    } catch {
      /* a teardown must never be the reason a process ends badly */
    }
  }
}

/**
 * The signals worth catching.
 *
 * `SIGHUP` is in the list because a check run from a terminal that is then closed gets
 * one, and that is the same abandonment as a `SIGTERM` from the timeout. `SIGINT` is
 * Ctrl-C. There is no `SIGKILL`, because there cannot be.
 */
const SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

function wire() {
  if (wired) return;
  wired = true;
  process.on('exit', drain);
  for (const sig of SIGNALS) {
    process.on(sig, () => {
      drain();
      // Re-raise, so the process dies of what it was sent. See the header.
      process.removeAllListeners(sig);
      try {
        process.kill(process.pid, sig);
      } catch {
        // A platform that will not re-raise must still not leave the process running,
        // and `128 + n` is the status a shell would have reported for the signal.
        process.exit(sig === 'SIGINT' ? 130 : sig === 'SIGTERM' ? 143 : 129);
      }
    });
  }
}

/**
 * Run `fn` when this process ends, however it ends — and hand back the way to say
 * "already done".
 *
 * `fn` must be synchronous: see the header. Calling the returned `off()` unregisters it
 * *and* marks it done, so the ordinary `finally` path stays exactly what it was and the
 * handler behind it becomes a no-op rather than a second teardown.
 */
export function onExit(fn) {
  wire();
  const job = { fn, done: false };
  jobs.push(job);
  return () => {
    job.done = true;
    const at = jobs.indexOf(job);
    if (at !== -1) jobs.splice(at, 1);
  };
}

/** For suites: how many teardowns are still armed. Nothing in the program reads it. */
export const armed = () => jobs.filter((j) => !j.done).length;

/** Sleep, synchronously. The only way to wait for anything from inside an exit handler. */
const block = (ms) => {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // No SharedArrayBuffer is a platform this will simply spin through, which costs a
    // few hundred wasted comparisons and is still correct.
  }
};

/**
 * End a child, and keep taking its directory away until it stays away.
 *
 * Two facts that have to be held at once, and neither is this file's discovery:
 *
 * **`kill()` is not a wait.** It returns once the signal is queued, and what it is queued
 * for is a process *tree*. A headless Chrome's renderer, GPU and crashpad children outlive
 * their parent by a moment and go on writing into the profile, so a delete in that moment
 * races them — and the losing side is a directory that comes *back* after `rmSync`
 * reported it gone. lib/browse.js pays for that in a paragraph of its own (bc-rcrt), where
 * it can `await` the exit. Here there is nothing to await.
 *
 * **Nothing can be awaited from an exit handler.** `process.on('exit')` runs after the
 * event loop has stopped, so a promise never settles, and the child's own `exit` event
 * never arrives however long the handler waits for it. That rules out every graceful shape
 * and leaves one: keep *asking*.
 *
 * So the loop is the answer rather than a workaround. It is not a fixed sleep — that would
 * be a guess, and the first version of this was a single `rmSync` immediately after the
 * signal, which left the profile behind **every time**, which is how this function came to
 * exist. It removes, checks, and goes round again until the directory is gone and stays
 * gone or the budget runs out; and because the exit is what it is really waiting for, a
 * child that has not gone by `killAfterMs` gets SIGKILL. SIGTERM first, because it is the
 * only signal Chrome can act on and a Chrome that shuts down properly takes its children
 * with it — most of the race removed rather than waited out.
 *
 * Returns whether the directory is actually gone. Never throws: a teardown that can fail a
 * run is the bug, not the mechanism that reports it, and whatever survives this is exactly
 * what lib/strays.js collects a day later.
 */
export function killAndRemoveSync(proc, dir, { timeoutMs = 3000, killAfterMs = 1500 } = {}) {
  try {
    proc?.kill('SIGTERM');
  } catch {
    /* already reaped */
  }
  const started = Date.now();
  let hardened = false;
  for (;;) {
    try {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* something in it is still open; go round again */
    }
    if (!dir || !fs.existsSync(dir)) {
      // One more short beat and one more look: a directory that is gone while a renderer
      // is still running is a directory that can come back, and that is the failure this
      // whole function exists for.
      block(60);
      if (!dir || !fs.existsSync(dir)) return true;
    }
    const spent = Date.now() - started;
    if (!hardened && spent >= killAfterMs) {
      hardened = true;
      try {
        proc?.kill('SIGKILL');
      } catch {
        /* it went between the check and the signal */
      }
    }
    if (spent >= timeoutMs) return dir ? !fs.existsSync(dir) : true;
    block(60);
  }
}
