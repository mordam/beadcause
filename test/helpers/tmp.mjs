/**
 * Taking a suite's scratch directory away, without letting the teardown fail the run.
 *
 * A suite that ends `fs.rmSync(tmp, { recursive: true, force: true })` is making a claim
 * it cannot actually support: that nothing is still writing under `tmp`. Most of the time
 * that is true. It stops being true the moment the code under test spawns something —
 * and the common repo (lib/commonrepo.js) spawns git.
 *
 * ## The failure this exists for
 *
 * bc-5uy8, and bc-3qsw, bc-r87b, bc-t69u and bc-94c6 with it. `test/dedupe.mjs` printed
 * `26/26 ok` and then exited 1 from its own last line:
 *
 *     Error: ENOTEMPTY: directory not empty, rmdir '…/beadcause-dedupe-XXXX/config/.git/hooks'
 *
 * Every write of `advocates.json` calls `snapshot()`, which schedules a commit 2000ms
 * later; the commit calls `ensureRepo()`, which runs `git init` in `CONFIG_DIR` — and
 * under test `CONFIG_DIR` is the scratch directory. dedupe.mjs takes about 1600ms, so on
 * a quiet machine the timer never fires and on a busy one it fires with a few hundred
 * milliseconds to spare. When it fires, `git init` is still laying down
 * `.git/hooks/*.sample` while `rmSync` walks the same directory, and `rmdir` on a
 * directory that gained a file since it was read is ENOTEMPTY. The depth in the message
 * moves between runs — `config/.git` on one, `config/.git/hooks` on the next — which is
 * what a racing writer looks like rather than a leftover.
 *
 * `force: true` does not cover it. `force` means "a path that is not there is not an
 * error" — it is about ENOENT, and this is the opposite problem: a path that is *more*
 * there than it was a moment ago.
 *
 * What it cost is the reason this is a helper and not a line in one suite:
 * `scripts/test.mjs` stops at the first failing suite, so a scratch directory nobody was
 * asserting anything about halted the gate at 32 of 105 and the 73 after it never ran —
 * and the run before and the run after were both green. An intermittent red whose own
 * checks all passed is the kind of failure people learn to re-run instead of read.
 *
 * ## The two halves, and why both
 *
 * `quiesce()` is the real fix and belongs first: it flushes the common repo's pending
 * snapshot and waits for the commit, so there is no git child left to race. Use it in any
 * suite whose scratch directory is `BEADCAUSE_CONFIG_DIR`.
 *
 * `removeTree()` is the backstop, for everything `quiesce` cannot know about — a helper
 * that shells out, a daemon still shutting down, Spotlight on a Mac. It retries the
 * removal, and when it still cannot it *warns and returns*. That is deliberate: the exit
 * code of a suite should say what its assertions said, and a directory under
 * `os.tmpdir()` that survives is a few kilobytes the OS clears, not a regression. A
 * teardown must never be able to fail a run on its own.
 *
 * `test/tmpteardown.mjs` covers all of it, including the control that makes the quiesce
 * worth having: immediately after a snapshot is scheduled the repo is not yet on disk,
 * and after `quiesce()` it is.
 */
import fs from 'node:fs';

/** Removal failures worth waiting out — something else is mid-write, not mid-delete. */
const TRANSIENT = new Set(['ENOTEMPTY', 'EBUSY', 'EPERM', 'EACCES', 'EEXIST', 'EMFILE', 'ENFILE']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Let the common repo finish whatever it has scheduled, so nothing is writing under the
 * scratch directory when it is removed.
 *
 * **It has to be the same module instance the code under test used** — the pending timer
 * is module state, and a second copy of commonrepo.js would flush a timer nobody set
 * while the real one kept running. That is what the URL here is for: resolved against
 * this file it is `<repo>/lib/commonrepo.js`, which is the same specifier lib/advocate.js
 * gets from its own `./commonrepo.js`, so Node's module map hands back the one instance.
 * Suites reach lib/ by several different spellings and any of them would have been a way
 * to get this subtly wrong.
 *
 * Dynamic rather than a static import so a suite that never touched lib/ does not load it
 * — importing lib/commonrepo.js pulls in lib/config.js, which resolves `CONFIG_DIR` at
 * module load, and a teardown has no business being the thing that first does that.
 *
 * Never throws. A snapshot that will not commit is lib/commonrepo.js's business (it logs
 * and carries on there too); here it only means there is nothing left to wait for.
 */
export async function quiesce() {
  try {
    const { flush } = await import(new URL('../../lib/commonrepo.js', import.meta.url).href);
    await flush();
  } catch {
    // Not importable, or the commit failed — either way nothing to wait on.
  }
}

/**
 * `rm -rf`, retried, and never fatal.
 *
 * Ten attempts over roughly a second and a half of backoff, which is an order of
 * magnitude more than a `git init` needs to finish writing its hooks. ENOENT is success:
 * the directory being gone is the whole point.
 */
export async function removeTree(dir, { retries = 10, delayMs = 25 } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (attempt >= retries || !TRANSIENT.has(err.code)) {
        // Not `throw` — see the note at the top. The assertions have already spoken.
        console.log(`  note  could not remove ${dir}: ${err.code || err.message} (left for the OS)`);
        return false;
      }
      await sleep(delayMs * (attempt + 1));
    }
  }
}

/**
 * The same retry, for a teardown that cannot await — `process.on('exit', …)`, or the
 * synchronous `done(code)` several suites call right before `process.exit`.
 *
 * Those are where a bare `rmSync` is worst, not best: a throw inside an exit handler is
 * an uncaught exception on the way out, so what the suite prints stops matching what it
 * did. There is no quiesce available here — waiting is what an exit handler cannot do —
 * so this is the retry alone, blocking on `Atomics.wait` because a timer would never run.
 * The whole budget is under a second of wall clock, and only when something is genuinely
 * still writing.
 */
export function removeTreeSync(dir, { retries = 10, delayMs = 25 } = {}) {
  const clock = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return true;
    } catch (err) {
      if (err.code === 'ENOENT') return true;
      if (attempt >= retries || !TRANSIENT.has(err.code)) {
        console.log(`  note  could not remove ${dir}: ${err.code || err.message} (left for the OS)`);
        return false;
      }
      Atomics.wait(clock, 0, 0, delayMs * (attempt + 1));
    }
  }
}

/**
 * The two together, in the order that matters — the last line of a suite:
 *
 *     await cleanupTmp(tmp);
 *
 * Quiesce first, because retrying a removal against a git child that is still going is
 * only a slower way to find out; then remove, tolerantly, for whatever the quiesce could
 * not know about.
 */
export async function cleanupTmp(dir, { quiesceFirst = true } = {}) {
  if (quiesceFirst) await quiesce();
  return removeTree(dir);
}
