/**
 * When a backend fails to start, was that the build's fault or the machine's?
 *
 * bin/router.js used to answer "the build's", always. A backend that did not become
 * healthy within twenty seconds was declared *poisoned* and never retried until the
 * files moved again — which is exactly right for a syntax error, and exactly wrong for
 * a Mac with ten agent sessions, two other routers and eight headless Chromes on it.
 * That is what happened: a backend that binds in ~2s by hand did not answer inside the
 * window, the router condemned a build that was fine, and because there was no active
 * backend to fall back on, the port went on answering 503 — with nothing down in a way
 * launchd would restart, and one line in a log file as the only evidence.
 *
 * So the failures are separated here, as a policy with no I/O in it, which is what
 * lets it be tested without spawning anything:
 *
 *   - **exited** — the child died before it was healthy. That is the build: a syntax
 *     error, a throw at import, a bad config. Retrying it every three seconds is a wall
 *     of noise, so it is condemned, and only a file moving clears it.
 *   - **timeout** — the child is *still alive* and simply has not answered yet. That is
 *     evidence about the machine, not about the build. It is retried, the window
 *     scales, and the router recovers on its own once the load falls away.
 *   - **portlost** — the child died, and it died because the internal port it was given
 *     had been taken by something else in the moment between being chosen and being
 *     bound. That was counted as **exited** until bc-dw47, and the comment above
 *     `attemptStart` said why that was safe: "the next spawn would break identically."
 *     For this one cause it is the opposite of true — the next spawn gets a *different*
 *     port and works — so a build that was never broken was condemned, and the phone
 *     went on being served by the previous one until somebody read a log. It is a
 *     sentence about a laptop with twenty agent sessions on it, like a timeout, and it
 *     is cured immediately rather than later: see `PORT_ATTEMPTS`.
 *   - **stopped** — the child went away before it was healthy, and said nothing was
 *     wrong on the way out. Two ways in, and bc-r0tx is both of them. A **signal**: a
 *     child nobody in here killed, which on this laptop means memory pressure, a stray
 *     `pkill node`, or a runner tearing down a suite — evidence about the Mac, not the
 *     code. And a clean **exit 0**: a build with a syntax error, a throw at import or a
 *     bad config exits *non-zero*, always, so a zero is the child choosing to stop, and
 *     `bin/beadcause.js` has exactly one such path — its orphan guard, which
 *     `process.exit(0)`s a backend that has had no router contact for `ORPHAN_MS`
 *     (60s). A start that runs past a minute is reachable here: `healthDeadline` climbs
 *     to `HEALTH_CEILING_MS` (120s) on a machine that has proven slow, and the guard
 *     fires halfway through that window. Both arrived as **exited** until this bead,
 *     which is to say both condemned a build that was fine — the same failure bc-dw47
 *     and bc-excc are about, reached by a third road.
 *
 * Two knobs come out of that, and they are deliberately different shapes:
 *
 *   - `healthDeadline` — how long to wait for one child. It doubles per attempt *and*
 *     carries `slowness`, a memory of how slow this machine has been proving to be, so
 *     the window a busy Mac needs is not rediscovered from twenty seconds every time.
 *   - `deferralMs` / `outageRetryMs` — how long to wait before trying the whole thing
 *     again. Two of them because the stakes differ: when something is still being
 *     served, a slow retry costs nothing; when *nothing* is being served, every second
 *     of patience is a second of 503, so that one starts at two seconds.
 *
 * This module imports nothing. bin/router.js holds the port and depends on almost
 * nothing on purpose — see the note at the top of it — and a policy that could fail to
 * load would be a policy that costs you the port.
 */

/** Kinds of startup failure. The whole point of this file is telling them apart. */
export const TIMEOUT = 'timeout';
export const EXITED = 'exited';
export const PORTLOST = 'portlost';
export const STOPPED = 'stopped';

/**
 * The exit code a server uses when the *only* thing that went wrong was the bind.
 *
 * A backend's stdio is inherited so that its logging lands in the same launchd file as
 * the router's — which means the router cannot read a word of what it said. The exit
 * code is the whole channel between them, so "nothing would bind" has to have its own,
 * or it arrives as the same `code 1` a syntax error arrives as. `lib/server.js` and
 * `bin/router.js` both exit with this from their bind handlers.
 *
 * Three, because 1 is every other failure, 2 is what node itself uses for a bad
 * invocation, and anything above 128 is indistinguishable from a signal.
 */
export const PORT_TAKEN_EXIT = 3;

/**
 * Spawns allowed per bring-up for a *port* that was taken, on top of `HEALTH_ATTEMPTS`.
 *
 * Separate from `HEALTH_ATTEMPTS` and larger, because it is a different question. A
 * timeout asks "is this machine going to manage it in a longer window", which is worth
 * asking twice; losing a port asks nothing at all — the port is gone, the next one is
 * free, and the only cost of trying again is a process start. Three, so that losing the
 * race twice in a row still comes up, and a config asking for a port something else
 * permanently owns still gives up rather than spinning.
 */
export const PORT_ATTEMPTS = 3;

/**
 * Which kind of failure a child that *stopped before it was healthy* is.
 *
 * Pure, so bin/router.js does not have to hold the exit-code convention itself and this
 * can be checked without spawning anything.
 *
 * Both halves of a child's death are needed, and the signal has to be asked about
 * *first*: a signalled child has no exit code at all, so `code` is `null` and every
 * question about a number is a question about the wrong thing. Until bc-r0tx only the
 * code was passed, `null` fell through to `EXITED`, and a backend the OOM killer took
 * condemned the build it was running.
 *
 * Zero is the other one, and it is the surprising one: nothing broken exits zero. A
 * syntax error, a throw at import and a bad config are all non-zero, so a zero here is a
 * child that decided to stop — which in this repo is `bin/beadcause.js`'s orphan guard
 * and nothing else.
 */
export function exitKind(code, signal = null) {
  if (signal) return STOPPED;
  if (code === PORT_TAKEN_EXIT) return PORTLOST;
  // Zero, `null` and `undefined` all land on `STOPPED`, and the two absences are not an
  // oversight: no code at all is the shape of a signalled child whose signal was not
  // passed in, and the whole lesson of this bead is which way to lean when the evidence
  // is missing. Condemning a build is the expensive answer, so it is the one that has to
  // be *earned* — by a non-zero number, from a child that named it.
  return code ? EXITED : STOPPED;
}

/**
 * Whether a failure is the *build's* fault, i.e. whether it may condemn one.
 *
 * The one place the router asks this. Only `exited` may: a timeout is about the machine,
 * a lost port is about everything else running on it, and a stopped child is about
 * whatever ended it — condemning a build for any of the three is how a good build stops
 * being served for as long as it takes to notice.
 */
export function poisonable(kind) {
  return kind === EXITED;
}

/** How long to wait for the first child of the first attempt, on an idle machine. */
export const HEALTH_BASE_MS = 20000;
/**
 * Children spawned per bring-up before giving up on it for now.
 *
 * Two, and the second one is not for a slow start — waiting longer is what helps a slow
 * start, and killing a child that was nearly up throws away the work it had done on the
 * machine that was already struggling. The second attempt is for the other thing a
 * timeout can mean: a child that is wedged and will never answer however long you wait.
 */
export const HEALTH_ATTEMPTS = 2;
/** No single wait is longer than this, however slow the machine has proven to be. */
export const HEALTH_CEILING_MS = 120000;
/** The most `slowness` can climb to, so the ceiling is reachable and no further. */
export const MAX_SLOWNESS = 6;

/** First pause after a bring-up that timed out while something was still being served. */
export const DEFER_BASE_MS = 30000;
/** And the longest such pause: past this, a stale build is stale for five minutes. */
export const DEFER_CEILING_MS = 300000;

/** First pause after a bring-up that timed out while *nothing* was being served. */
export const OUTAGE_BASE_MS = 2000;
/** And the longest. Short, because the alternative to trying again is a 503. */
export const OUTAGE_CEILING_MS = 60000;

/** An Error a caller can tell apart from any other. */
export function startupError(kind, message) {
  const err = new Error(message);
  err.kind = kind;
  return err;
}

const clamp = (ms, ceiling) => Math.min(ms, ceiling);

/**
 * How long attempt `attempt` of a bring-up may take, on a machine `slowness` slow.
 *
 * Doubling in both directions: within a bring-up, because the second attempt is worth
 * more patience than the first, and across bring-ups, because a machine that has just
 * failed to start a backend in forty seconds will not start one in twenty.
 */
export function healthDeadline(attempt = 0, slowness = 0, base = HEALTH_BASE_MS) {
  const steps = Math.max(0, attempt) + Math.max(0, Math.min(slowness, MAX_SLOWNESS));
  return clamp(Math.round(base * 2 ** steps), Math.max(HEALTH_CEILING_MS, base));
}

/**
 * What the machine has just taught us, as a number to widen the next window with.
 *
 * Up on a bring-up that ran out of patience. Down — by one, not to zero — when the
 * *first* attempt came up cleanly, because that is the only evidence that the window is
 * now wider than it needs to be. A start that needed the second attempt keeps what it
 * has: it succeeded *because* the window had been widened.
 */
export function nextSlowness(slowness = 0, { timedOut = false, attempt = 0 } = {}) {
  const now = Math.max(0, Math.min(slowness, MAX_SLOWNESS));
  if (timedOut) return Math.min(now + 1, MAX_SLOWNESS);
  return attempt === 0 ? Math.max(0, now - 1) : now;
}

/** Pause before retrying a build that timed out, while something is still served. */
export function deferralMs(consecutive = 1, base = DEFER_BASE_MS) {
  const n = Math.max(1, consecutive);
  return clamp(Math.round(base * 2 ** (n - 1)), Math.max(DEFER_CEILING_MS, base));
}

/** Pause before trying again when nothing is being served at all. */
export function outageRetryMs(consecutive = 1, base = OUTAGE_BASE_MS) {
  const n = Math.max(1, consecutive);
  return clamp(Math.round(base * 2 ** (n - 1)), Math.max(OUTAGE_CEILING_MS, base));
}

const secs = (ms) => (ms >= 10000 ? `${Math.round(ms / 1000)}s` : `${(ms / 1000).toFixed(1)}s`);

/** "in 42s", or "now" for anything already due. Deadlines are absolute epoch ms. */
function inWords(until, now) {
  const left = until - now;
  return left > 0 ? `in ${secs(left)}` : 'now';
}

/**
 * The router's state as one verdict, said the same way everywhere it is said.
 *
 * There are four surfaces for this and they used to have four vocabularies: the log
 * line, `npm run swap:status`, the 503 the phone gets, and — new, and the reason this
 * bead exists — the health line on the advocate console. `ok: true` is a real answer
 * rather than an absence, for the same reason lib/service.js's serviceHealth returns
 * one: a line you only ever see when something is wrong is a line whose silence you
 * cannot read.
 *
 * Takes the snapshot bin/router.js already publishes on /internal/router/state, so
 * nothing has to be plumbed twice, and returns `{ok, code, summary, lines, fix}` — the
 * same shape lib/service.js hands the console for the LaunchAgent verdict.
 */
export function explain(snap, now = Date.now()) {
  if (!snap) return null;
  const active = snap.active;
  const disk = snap.disk;
  const deferred = snap.deferred && (!snap.deferred.build || snap.deferred.build === disk) ? snap.deferred : null;

  if (!active) {
    const why = snap.poisoned
      ? `build ${snap.poisoned} died before it was healthy — a syntax error, a bad import, something the code did.`
      : deferred
        ? // `why` when the deferral carried one. Only a lost port does (bin/router.js
          // writes it), and it needs to: "too slow to answer" sends whoever reads this
          // looking at load and at the build, and the answer is neither.
          deferred.why || `build ${deferred.build} was too slow to answer ${deferred.attempts} time(s) — the machine, not the build.`
        : 'no backend has come up yet.';
    return {
      ok: false,
      code: 'no-backend',
      summary: 'the router is holding the port and serving nothing — every request is a 503',
      lines: [
        why,
        // Always, whichever it was. With nothing behind the port there is nothing left
        // to protect by condemning a build, so bin/router.js ignores both the poison
        // and the deferral here and keeps trying — see `recover`.
        `it is retrying on its own${snap.retryAt ? ` — next attempt ${inWords(snap.retryAt, now)}` : ''}.`,
        'force one now: npm run swap',
      ],
      fix: 'npm run swap',
    };
  }

  if (snap.poisoned && snap.poisoned === disk) {
    return {
      ok: false,
      code: 'poisoned',
      summary: `serving build ${active.build}; build ${disk} on disk died before it was healthy`,
      lines: [
        `the phone is being served by pid ${active.pid} on the previous build.`,
        'the build on disk failed at startup, so it is not retried until the files change.',
        'fix the build, or force it: npm run swap',
      ],
      fix: 'npm run swap',
    };
  }

  if (deferred) {
    // The same diagnosis as `why` below, cut down to the clause that fits on one line
    // beside a build id. Keyed off the deferral's `kind` rather than off the presence of
    // `why`, which is what it used to be: with only two readings that worked, and the
    // third — a child stopped before it was healthy, bc-r0tx — would have come out
    // claiming a port problem it never had. A deferral with no kind is a slow start,
    // which is what every deferral was before bc-dw47.
    const clause =
      deferred.kind === PORTLOST
        ? 'could not get a port'
        : deferred.kind === STOPPED
          ? 'was stopped before it was healthy'
          : 'was too slow to start';
    return {
      ok: false,
      code: 'retrying',
      summary: `serving build ${active.build}; build ${disk} ${clause} and is being retried`,
      lines: [
        deferred.why || `${deferred.attempts} attempt(s) ran out of patience — a busy machine, not a broken build.`,
        `the next one is ${inWords(deferred.until, now)}${deferred.why ? '' : ', with a longer window'}.`,
        'force it sooner: npm run swap',
      ],
      fix: 'npm run swap',
    };
  }

  if (snap.stale) {
    return {
      ok: false,
      code: 'stale',
      summary: `serving build ${active.build}, disk is at ${disk} — a swap is due`,
      lines: ['the files moved a moment ago and the swap has not happened yet.'],
      fix: null,
    };
  }

  // Last, because it is the one problem here that no backend state can be confused
  // with — and because everything above it is more urgent. The backend states are all
  // about what the phone is being served *right now*; this one is about the process in
  // front of them, which is serving perfectly and is simply not the code on disk.
  //
  // It is also the only verdict in this function that does not clear itself. A stale
  // build swaps in seconds, a deferral retries on the clock, a poisoned build clears
  // when the files move — this one lasts until somebody restarts the daemon, because
  // the router cannot replace itself while it owns the socket (see `routerStamp` in
  // lib/build.js). Which is exactly why it needs a surface: bin/router.js says it once
  // in launchd's log at the moment it happens, and `--status` marks the router line,
  // and neither is a place anybody stands. bc-b4fs's Tailscale fix sat un-run on this
  // Mac for a day behind a console health line that said ✓ serving, because the build
  // it named really was current — the *backend's* build. That is bc-0i27.16.
  if (snap.router?.sourceChanged) {
    return {
      ok: false,
      code: 'router-source',
      summary: `serving build ${active.build}, but the router in front of it is older than its own source`,
      lines: [
        'the hot-swap is fine — what is behind the port is current. The process holding',
        'the port is not: bin/router.js, lib/build.js, lib/config.js or lib/service.js',
        'moved since it started.',
        // Said because the obvious response is the wrong one, and it is one keystroke
        // away on the same screen: `npm run swap` replaces the backend, which is
        // already current, and leaves this exactly as it was.
        'a swap will not clear it — the router cannot replace itself while it owns the socket.',
        // `restart` rides in the snapshot rather than being built here: this module
        // imports nothing (see the note at the top), so the uid and the LaunchAgent
        // label are bin/router.js's to know, and there is one of each in the program.
        snap.router.restart ? `restart it: ${snap.router.restart}` : 'restart the daemon to clear it.',
      ],
      fix: snap.router.restart || null,
    };
  }

  return {
    ok: true,
    code: 'serving',
    summary: `serving build ${active.build} from pid ${active.pid} — matches disk`,
    lines: [],
    fix: null,
  };
}
