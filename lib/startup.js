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
 * So the two failures are separated here, as a policy with no I/O in it, which is what
 * lets it be tested without spawning anything:
 *
 *   - **exited** — the child died before it was healthy. That is the build: a syntax
 *     error, a throw at import, a bad config. Retrying it every three seconds is a wall
 *     of noise, so it is condemned, and only a file moving clears it.
 *   - **timeout** — the child is *still alive* and simply has not answered yet. That is
 *     evidence about the machine, not about the build. It is retried, the window
 *     scales, and the router recovers on its own once the load falls away.
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
        ? `build ${deferred.build} was too slow to answer ${deferred.attempts} time(s) — the machine, not the build.`
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
    return {
      ok: false,
      code: 'retrying',
      summary: `serving build ${active.build}; build ${disk} was too slow to start and is being retried`,
      lines: [
        `${deferred.attempts} attempt(s) ran out of patience — a busy machine, not a broken build.`,
        `the next one is ${inWords(deferred.until, now)}, with a longer window.`,
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

  return {
    ok: true,
    code: 'serving',
    summary: `serving build ${active.build} from pid ${active.pid} — matches disk`,
    lines: [],
    fix: null,
  };
}
