/**
 * One headless Chrome, launched on a port nobody else can guess.
 *
 * Every `scripts/*-check.mjs` needs the same four things — a throwaway profile, a
 * headless Chrome, a DevTools websocket attached to its one page, and a `close()` that
 * takes all of it away again — and until this file existed each of them carried its own
 * copy of that, thirty-odd near-identical lines apiece. Copies drift, but that is not
 * why this was extracted. They shared a bug, and it could only be fixed once:
 *
 * **They each picked Chrome's debugging port arithmetically from their own pid.**
 *
 *     const port = 9700 + Math.floor(process.pid % 100);   // eleven checks
 *     const port = 9600 + Math.floor(process.pid % 100);   // six
 *     const port = 9800 + Math.floor(process.pid % 100);   // five
 *
 * A hundred addresses per base. This laptop runs eight or so agent sessions at a time,
 * `npm run checks` runs four checks at once by itself, and two pids congruent mod 100
 * land on the same number — which is not rare, it is one in a hundred per pair, every
 * run, forever. Measured live during bc-thid: 9605, 9609, 9700, 9701, 9723, 9749, 9758,
 * 9798 and 9874 were all held by other sessions' Chromes at the same moment.
 *
 * **The failure does not look like a port clash, which is what made it expensive.**
 * Chrome handed a port already in use does not exit and does not complain. It simply
 * never publishes a target of its own — so the loser's `fetch('/json/list')` is answered
 * by the *winner's* Chrome, the check attaches to a page belonging to another session's
 * daemon, and drives it. Every DOM assertion then fails and every assertion that reads
 * `config.json` off disk still passes, because that half never went near a browser.
 * That reads exactly like "the change under test broke the page". It cost three
 * consecutive false failures of `space-check.mjs` against a five-line, innocent edit to
 * `public/monitor.js`, and the thing that finally told them apart was copying the script
 * to a second filename — a different pid, therefore a different port — and watching the
 * identical code pass.
 *
 * **The fix is the one the checks' own fixture servers already use: ask for zero.**
 * `--remote-debugging-port=0` makes the kernel choose, so there is nothing to collide
 * with and nothing to guess; Chrome writes the number it was given into
 * `DevToolsActivePort` inside the profile directory, which is a `mkdtemp` made
 * milliseconds earlier and belongs to exactly one process. `lib/browse.js` has done it
 * this way since bc-8yw and this is its argument, generalised. It also stops the repo
 * publishing a predictable CDP endpoint on loopback, which is a thing `lib/lookup.js`
 * refuses loopback partly *because* of: a debugging port will open a tab for anybody who
 * can reach it.
 *
 * **And it fails loudly now, which is the other half of the bead.** There is no longer a
 * case where the port is held by somebody else — but Chrome can still die on startup, or
 * come up and never open a page. Both are waited on against a deadline and then thrown,
 * with the profile and the process cleaned up on the way out, rather than left to time
 * out sixty polls later as `Chrome never exposed a page target`, which reads like a
 * broken check.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { onExit, killAndRemoveSync } from '../../lib/teardown.js';

/** Where Chrome is on this machine. `CHROME_PATH` first, so a moved install is sayable. */
export const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** How long Chrome gets to start, publish a port and open a page before it is a failure. */
export const LAUNCH_TIMEOUT_MS = 20_000;

/** How long a Chrome asked politely to leave has before it is killed outright. */
export const SIGKILL_AFTER_MS = 2_000;

/** And the whole budget for the teardown, after which the directory is somebody else's. */
export const TEARDOWN_TIMEOUT_MS = 8_000;

/** How long a directory has to stay deleted before the deletion is believed. See below. */
const CONFIRM_MS = 40;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The command line every check used to carry its own copy of.
 *
 * The three `--disable-*-backgrounding` flags are not tidiness: an offscreen renderer is
 * throttled to about a frame a second, and a check that measures a layout while that is
 * happening measures the throttling instead of the page. Four of the older checks were
 * missing two of them and are now on the same footing as the rest.
 */
export function chromeArgs(profile, extra = []) {
  return [
    '--headless=new',
    // Zero, never a number. See the top of this file — it is the whole point of it.
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    // A fresh profile means Chrome would otherwise run its first-run dance, and an
    // unattended check has nobody to dismiss it.
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--hide-scrollbars',
    ...extra,
    'about:blank',
  ];
}

/**
 * The port Chrome actually got, read out of the profile it wrote it into.
 *
 * `DevToolsActivePort` is two lines — the port, then the browser's websocket path — and
 * Chrome writes it once it is listening. Polled rather than watched because the file
 * appears in a directory that already exists, and a hundred milliseconds of latency at
 * startup is not worth an `fs.watch` and its platform footnotes.
 */
async function activePort(profile, proc, deadline) {
  const file = path.join(profile, 'DevToolsActivePort');
  for (;;) {
    try {
      const first = fs.readFileSync(file, 'utf8').split('\n')[0].trim();
      if (first) return Number(first);
    } catch {
      /* not written yet */
    }
    // Chrome dying at startup is a different fault from Chrome being slow, and saying so
    // saves the reader twenty seconds of wondering which one they are looking at. The
    // `error` case is a Chrome that never started at all — a moved install, a bad
    // `CHROME_PATH` — and it has to be *listened for* rather than polled, because an
    // unhandled `error` on a ChildProcess is a thrown exception out of the event loop
    // that no `try` around this call can catch.
    if (proc.spawnFailure) throw new Error(`Chrome would not start: ${proc.spawnFailure.message}`);
    if (proc.exitCode != null || proc.signalCode)
      throw new Error(`Chrome exited during launch (code ${proc.exitCode ?? proc.signalCode})`);
    if (Date.now() > deadline) throw new Error('Chrome never published a debugging port');
    await sleep(100);
  }
}

/**
 * A DevTools session over the websocket: `send(method, params)`, and `on(fn)` for events.
 *
 * The `on` half is only used by `scripts/shot.mjs`, which listens for console and network
 * failures while it photographs a page. It is here rather than there because thirty-one
 * checks had the same function without it and one had it with, and a superset is cheaper
 * to keep true than two shapes.
 */
export function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    const listeners = [];
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      if (msg.method) {
        for (const fn of listeners) fn(msg.method, msg.params);
        return;
      }
      const q = msg.id != null && pending.get(msg.id);
      if (!q) return;
      pending.delete(msg.id);
      msg.error ? q.reject(new Error(msg.error.message)) : q.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('could not attach to Chrome'));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        on: (fn) => listeners.push(fn),
        close: () => {
          try {
            ws.close();
          } catch {
            /* already gone */
          }
        },
      });
  });
}

/**
 * End Chrome, wait for the writing to stop, then delete the profile — and say whether it went.
 *
 * `kill()` is not a wait. It returns once the signal is queued, and what it is queued for
 * is a *tree*: Chrome's renderer, GPU and crashpad children go on writing into the profile
 * for a moment after the browser process has taken the signal. A `rmSync` fired in that
 * moment races them and loses — and it loses quietly, because the losing shape is not an
 * exception. `rmSync` walks a directory that is being repopulated behind it, so it either
 * throws `ENOTEMPTY` or *succeeds* against a directory that then comes straight back —
 * and both were watched happening against a real Chrome while this was written. Neither
 * says anything: the check exits 0 either way. Measured on 2026-08-18, a `gate-check.mjs`
 * run that succeeded took TMPDIR from seven `beadcause-*` directories to eight, the oldest
 * of them from the previous morning (bc-5e85).
 *
 * **`{ maxRetries: 3 }` is therefore gone rather than raised.** It is `rmSync`'s own
 * internal retry of a *failed unlink*, so it cannot see the second shape at all, and it is
 * not free either — it backs off inside a tree walk that is failing at several depths at
 * once. Measured here: the same real teardown took 740ms with it and 190ms without, for
 * the same outcome. The retry that belongs to this problem is the loop below, which
 * re-asks the only question that settles it — *is the directory gone* — and keeps asking
 * until it is or the budget runs out.
 *
 * `lib/browse.js` reached the same three steps from the same evidence (bc-rcrt) and is the
 * place to read them argued at length; the difference here is that this one may not await,
 * and that is not a style choice. `close()` is called by every `scripts/*-check.mjs`, several of them immediately
 * before `process.exit()`, which does not wait for a pending promise — an async teardown
 * would be cut short at exactly the call sites that most need it to finish. It is also
 * registered as a process-exit teardown, where nothing asynchronous ever runs again. So
 * the wait is `Atomics.wait` on a throwaway `SharedArrayBuffer`, which is what
 * `test/helpers/tmp.mjs` uses for the same reason, and the event loop stops for it.
 *
 * SIGTERM first, and only then SIGKILL, for the reason `bin/router.js` gives: SIGTERM is
 * the one Chrome can act on, and a Chrome that shuts down properly takes its children
 * with it — which removes the race rather than outwaiting it. SIGKILL is for one that
 * will not go, and it is second because it is not free: it drops the browser process and
 * leaves the children it was about to collect to be reparented to pid 1, which is the
 * leak bc-1eru is about. Two seconds is long enough that no healthy Chrome ever reaches it.
 *
 * @param {import('node:child_process').ChildProcess} proc the browser process.
 * @param {string} profile its `--user-data-dir`, which this deletes.
 * @returns {boolean} whether the directory is gone. False is a real answer, not a throw:
 *   the caller is on its way out and a browser this cannot end is not one it can fix.
 */
export function killAndRemove(proc, profile, { sigkillAfterMs = SIGKILL_AFTER_MS, timeoutMs = TEARDOWN_TIMEOUT_MS } = {}) {
  try {
    proc.kill('SIGTERM');
  } catch {
    /* already gone */
  }
  const clock = new Int32Array(new SharedArrayBuffer(4));
  const started = Date.now();
  let hardened = false;
  // Backed off rather than flat, and the first wait comes *before* the first attempt: the
  // common case is a Chrome that goes in a few tens of milliseconds, and deleting a
  // profile out from under one that is still in it is how a run earns a crashpad dump to
  // delete as well. The ceiling is low because the whole budget is small.
  for (let wait = 25; ; wait = Math.min(wait * 2, 250)) {
    const elapsed = Date.now() - started;
    if (!hardened && elapsed >= sigkillAfterMs) {
      hardened = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    Atomics.wait(clock, 0, 0, wait);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch {
      /* still letting go of it */
    }
    // Not the absence of a throw — see above; the directory can come back after a call
    // that reported success, and that is the shape this whole function exists for.
    //
    // Which is also why *gone* is not the answer on its own. A writer that is still going
    // recreates the path within a millisecond or two of losing it, so a single `existsSync`
    // taken straight after the delete can land in that gap and report a clean teardown to
    // a caller whose directory reappears a moment later — the original bug, one layer in.
    // Asked twice, with a wait between, that gap closes: anything still writing is caught
    // by the second look, and a browser that has actually gone cannot fail it.
    if (!fs.existsSync(profile)) {
      Atomics.wait(clock, 0, 0, CONFIRM_MS);
      if (!fs.existsSync(profile)) return true;
    }
    if (Date.now() - started >= timeoutMs) return false;
  }
}

/**
 * Launch one, attach to its page, and hand back `{ s, close, port, profile }`.
 *
 * `prefix` names the temp profile so a leaked one is traceable to the check that leaked
 * it — `beadcause-space-`, `beadcause-warm-`. `port` is returned for the same reason: it
 * is worth being able to print which Chrome a run was actually talking to, now that the
 * answer is no longer derivable from the pid.
 *
 * Both endings go through `killAndRemove`, which is where the interesting part is: the
 * delete has to outlast the browser rather than merely follow it. `close()` therefore
 * blocks for as long as that takes — about 175ms against a real Chrome — and stays
 * synchronous on purpose, because every check calls it and several of them call
 * `process.exit()` on the next line.
 *
 * Every failure path kills the process and deletes the profile before it throws. The old
 * copies did not, and a check that threw left a headless Chrome and a temp directory
 * behind on a laptop that runs these all night.
 */
export async function launchChrome(prefix, { chrome = CHROME, args = [], timeoutMs = LAUNCH_TIMEOUT_MS } = {}) {
  const profile = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const proc = spawn(chrome, chromeArgs(profile, args), { stdio: 'ignore' });
  // Parked on the process rather than rethrown: `activePort` is what is watching, and it
  // is the only place that knows whether we are still inside the deadline.
  proc.on('error', (e) => {
    proc.spawnFailure = e;
  });
  const teardown = () => {
    // First, so the ordinary path cannot also be torn down by the exit handler below.
    disarm();
    // Said out loud, because the alternative is the state this was filed from: a laptop
    // with eight profile directories in TMPDIR and nothing anywhere naming what left them.
    if (!killAndRemove(proc, profile)) {
      process.stderr.write(`  note  ${profile} outlived its teardown and was left for the OS\n`);
    }
  };
  /**
   * The same teardown again, for the endings a `finally` cannot reach — bc-5isv.
   *
   * Every caller of this function wraps its work in `try … finally { close() }`, and that
   * covers a return and a throw. It does not cover a signal, and a signal is how a check
   * usually dies when something has gone wrong: `scripts/checks.mjs` sends `SIGTERM` to
   * anything that overruns its timeout, and Ctrl-C sends `SIGINT`. In both, `close()` is
   * never called, Chrome is reparented to launchd, and it runs forever — fifteen of them
   * and 15 GB of profiles were counted on this Mac before this line existed. `disarm()`
   * above is what stops the ordinary path doing it twice.
   *
   * The lesson underneath it is the one thing here that had to be learnt rather than
   * reasoned out, and bc-1eru arrived at it from the other side at the same time. A signal
   * followed by an `rmSync` in the same breath left the profile behind **every time**:
   * Chrome's renderer and GPU children go on writing for a moment after their parent is
   * signalled, so the directory comes back after `rmSync` reported it gone — and from an
   * exit handler there is nothing to `await`, because the event loop has already stopped.
   * Both arms now remove, look, and go round again until it stays gone: `teardown` above
   * through `killAndRemove`, this one through `killAndRemoveSync`.
   *
   * They stay two functions because they are not the same call. `killAndRemove` is this
   * file's, sized for a real Chrome on the ordinary path and covered by
   * test/chromeprofile.mjs; `killAndRemoveSync` is the repo-wide one every other signal
   * path already uses — lib/browse.js, scripts/checks.mjs, the two daemon checks — on a
   * tighter budget, because an exit handler is holding up a process that has been told to
   * go. See lib/teardown.js.
   */
  const disarm = onExit(() => killAndRemoveSync(proc, profile));
  try {
    const deadline = Date.now() + timeoutMs;
    const port = await activePort(profile, proc, deadline);
    let target = null;
    for (;;) {
      try {
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
      } catch {
        /* the endpoint is up but not answering yet */
      }
      if (target) break;
      if (Date.now() > deadline) throw new Error(`Chrome never exposed a page target on :${port}`);
      await sleep(100);
    }
    const s = await connect(target.webSocketDebuggerUrl);
    return {
      s,
      port,
      profile,
      close: () => {
        s.close();
        teardown();
      },
    };
  } catch (e) {
    teardown();
    throw e;
  }
}
