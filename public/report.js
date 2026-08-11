/*
  Every error the phone sees, sent back to the daemon.

  `POST /api/error` has existed since bc-p38c.1 and nothing was calling it. This is the
  caller: one file, loaded by every page, whose whole job is that an error the app hits
  in a room somewhere stops being a red toast that nobody can act on afterwards. The
  daemon turns what arrives here into a P0 bead — or a comment on the bead that already
  covers it — and the advocate is on it before you have read the notification.

  **Four sources, and they were four different kinds of lost.**

  1. **An uncaught exception.** Nothing caught these at all. A render that throws
     halfway leaves half a screen and says nothing, on either side.
  2. **A rejected promise nobody awaited.** Same, and worse: the failure is silent even
     in the console on a phone, where there is no console.
  3. **A fetch that failed.** Which is what most errors here actually are — the daemon
     is on a tailnet address and the phone is on a train.
  4. **Any `toast(msg, true)`.** If the app thought a failure was worth a red bar across
     the screen, it is worth a bead. This is the one that needed the four copied `toast`
     functions to grow a line each; the other three are wired here and nowhere else.

  **It is additive, and that is a hard constraint rather than a nicety.** The toast still
  appears, unchanged, whether or not a report can be sent — so everything below is inside
  a `try`, nothing is awaited on a path a user is waiting on, and a report that cannot be
  delivered is *dropped*. Not retried and not queued: the failure this exists to record
  is not worth breaking the screen that was going to tell you about it anyway. A page
  where `/report.js` failed to load is a page exactly as good as it was last week.

  **Nothing from the URL goes with a report.** The pages authenticate with `?t=<token>`
  when a document request would otherwise be bounced to sign-in (scripts/shot.mjs does
  this on every agent screenshot), so `location.href` is a credential — that is bc-sqab,
  where the token reached a transcript by being printed. So the page is reported as
  `location.pathname`, with the query and the fragment thrown away rather than filtered,
  and every free-text field a report carries — the message, the stack, the source — is
  swept for a `t=`/`token=`/`key=` shaped parameter on the way out anyway. Two guards for
  one secret, because a stack frame from an inline handler carries the document URL and
  neither of us will be looking when that happens.

  **What it will not report**, each one a false P0 it would otherwise have filed:

  - **A fetch the page abandoned.** An `AbortError` is the long poll being torn down,
    which is bookkeeping, not a failure.
  - **Anything at all once the page is going away.** A navigation rejects every fetch in
    flight, so a tap on the tab bar used to be worth one "Failed to fetch" per open
    request. `pagehide` closes the shutter.
  - **A 4xx.** Those are the daemon declining on purpose — a 409 close gate, a 403 for a
    feature switched off in the config, a 401 that means sign in again. `>= 500` is the
    line, because a 500 is the daemon failing rather than answering.
  - **The echo of a failure already reported.** A failed fetch is reported here *and*
    toasted by the caller a moment later; one incident must not be two beads. A red toast
    whose text carries the message of a fetch failure just reported is that same
    incident arriving twice.
  - **A refusal.** `toast(msg, 'refused')` is red on purpose and files nothing — see
    `refused` below.

  **And a ceiling**: eight reports per page per minute, and the same error not twice
  inside thirty seconds. A render loop that throws on every frame files a handful and
  then stops, instead of several hundred while the daemon's own dedupe catches up.

  **A deploy hushes this page, and the daemon is the one that says so.** A restart makes
  every open page fail every fetch at once, and the reconnect would file one P0 per
  screen per endpoint for the single fact that you pressed Ship. Only the deploy journal
  knows that is what happened, so the *authority* is `reportingQuiet` in lib/deploy.js
  and `POST /api/error` refuses on its own — which is what makes it hold for a phone
  still running last week's cached copy of this file. What is here is the other half of
  that conversation: a refusal carries an `until`, and this page then stops asking. Not
  queueing — dropping. Replaying them the moment the daemon is back is the same storm,
  a minute later. The toast still appears throughout; the user should see the failure,
  and the tracker should not.
*/
(() => {
  'use strict';

  /** Where a report goes. Never routed through the wrapper below — see `nativeFetch`. */
  const ENDPOINT = '/api/error';

  /** Where the pages keep the daemon token. The same key `api()` reads in every page. */
  const TOKEN_KEY = 'beadcause.token';

  /** The window the cap is measured over, and how many reports may leave inside it. */
  const WINDOW_MS = 60 * 1000;
  const MAX_PER_WINDOW = 8;

  /**
   * How long one distinct error waits before it may be reported again from this page.
   *
   * The daemon already dedupes — the second occurrence is a comment, not a bead — so
   * this is not about beads. It is about a page in a render loop turning one bug into a
   * comment every 40 ms on a bead somebody is trying to read, which is bc-5f9b.
   */
  const REPEAT_MS = 30 * 1000;

  /** Enough of a stack to see where it came from; the daemon cuts it to 24 too. */
  const STACK_LINES = 24;

  /** A message longer than this is not a message, it is a payload somebody stringified. */
  const MESSAGE_LIMIT = 2000;

  /**
   * The furthest ahead a daemon may push this page's quiet window, whatever it says.
   *
   * The `until` in a refusal is a wall clock from another machine, arriving over a wire,
   * and the failure it could cause is the worst one available here: a page that has
   * quietly stopped reporting anything and looks exactly like a page with no errors. A
   * deploy of this app is seconds and its grace period is thirty of them, so ten minutes
   * is far past any honest answer while still being a ceiling.
   */
  const MAX_QUIET_MS = 10 * 60 * 1000;

  /**
   * The `fetch` this page was born with, kept before the wrapper below replaces it.
   *
   * Two things depend on it. A report must not be reported: sending through the wrapper
   * would mean the failure of a report is itself a fetch failure, and the loop has no
   * floor. And a later wrapper — a devtools shim, another module — must not be able to
   * put the reporter back inside the thing it is watching.
   */
  const nativeFetch = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;

  /** Timestamps of the reports that have left inside the current window. */
  let recent = [];

  /** The last time each distinct error was reported, so a loop cannot flood. */
  const lastSeen = new Map();

  /**
   * The messages of failures reported in the last `REPEAT_MS`, for the echo rule.
   *
   * A fetch failure is reported here and then handed to the caller, which toasts it —
   * so the same incident arrives twice, a few milliseconds apart, wearing two different
   * messages. The second is dropped when it carries the first inside it.
   */
  const echoes = new Map();

  /**
   * Set the moment the page starts going away, and never unset.
   *
   * A navigation rejects every fetch still in flight, and it does so *after* the
   * decision to leave — so without this, one tap on the tab bar was worth a "Failed to
   * fetch" report per open request, from a page that was working perfectly.
   *
   * `pagehide` alone, deliberately. `unload` is the obvious one and it is the one that
   * makes a page ineligible for the back/forward cache merely by being listened for —
   * on a phone, where every tab tap in this app is a navigation, that is a real cost
   * paid for nothing. `pagehide` is the event that exists to be listened for instead.
   */
  let leaving = false;
  try {
    window.addEventListener('pagehide', () => {
      leaving = true;
    });
  } catch {
    /* an environment without that event is an environment that cannot navigate */
  }

  /**
   * When this page may report again, after the daemon said a deploy was in flight.
   *
   * Only ever set from an answer to a report, never guessed: this page cannot tell a
   * deploy from a train tunnel, and a page that hushed itself on its own reading of a
   * failed fetch would be a page that stops reporting exactly when the app is broken.
   * The daemon holds the deploy journal and refuses on its own account (lib/deploy.js);
   * this is only how a page stops re-asking a question already answered.
   */
  let quietUntil = 0;

  /* --------------------------------------------------------------- redaction */

  /**
   * A query parameter that is a credential, in any string on its way out.
   *
   * The value is eaten greedily up to the next delimiter, which on a stack frame takes
   * the `:12:5` with it — a deliberate trade. A frame inside the document itself is
   * rare (every line of this app is in an external file), and losing a line number is
   * cheaper by a wide margin than putting the daemon token on a bead.
   */
  const CREDENTIAL = /([?&#](?:t|token|key|secret|password|pass|auth)=)[^&#\s'"]*/gi;

  const scrub = (text) => String(text ?? '').replace(CREDENTIAL, '$1REDACTED');

  const oneLine = (text) => scrub(text).replace(/\s+/g, ' ').trim();

  /* -------------------------------------------------------------------- caps */

  /**
   * Whether a report may leave, and the bookkeeping that says so next time.
   *
   * Two gates in one call because they share the clock: the per-page ceiling, and the
   * per-error cooldown. Asked once per report, and it is the only thing between a
   * `requestAnimationFrame` that throws and several thousand rows in the tracker.
   */
  function allowed(key, now) {
    recent = recent.filter((t) => now - t < WINDOW_MS);
    if (recent.length >= MAX_PER_WINDOW) return false;
    const last = lastSeen.get(key);
    if (last !== undefined && now - last < REPEAT_MS) return false;
    recent.push(now);
    lastSeen.set(key, now);
    // One entry per distinct error for the life of the page is bounded by how many
    // distinct errors a page has; a page with more than this many has other problems,
    // and the oldest are the ones whose cooldown has expired anyway.
    if (lastSeen.size > 64) {
      for (const [k, t] of lastSeen) {
        if (now - t >= REPEAT_MS) lastSeen.delete(k);
      }
    }
    return true;
  }

  /**
   * Remember a failure's own words, so the toast that repeats them is not a second bead.
   *
   * It does a second job that is worth naming rather than discovering: every fetch on a
   * page that cannot reach the daemon fails with the same words, so the first one
   * reported silences the rest for `REPEAT_MS`. Twelve endpoints unreachable is one
   * fact, and it reads better on one bead than on twelve.
   */
  function remember(text, now) {
    const key = oneLine(text).toLowerCase();
    if (key.length < 8) return; // too short to be distinctive; "failed" matches anything
    echoes.set(key, now);
    for (const [k, t] of echoes) {
      if (now - t >= REPEAT_MS) echoes.delete(k);
    }
  }

  /** Whether this message is a failure already reported, arriving a second time. */
  function isEcho(message, now) {
    const text = oneLine(message).toLowerCase();
    if (!text) return false;
    for (const [k, t] of echoes) {
      if (now - t < REPEAT_MS && (text === k || text.includes(k))) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ sending */

  /**
   * One report, on its way, and nothing waits for it.
   *
   * `keepalive` so a report raised on the way out of the page still leaves — the one
   * case where the request outlives the document that made it. The promise is settled
   * both ways and thrown away: a rejection here is the daemon being unreachable, which
   * is the case where there is nothing to report *to*, and an unhandled rejection would
   * be an error raised by the error reporter.
   */
  function post(report) {
    if (!nativeFetch) return;
    try {
      const headers = { 'content-type': 'application/json' };
      let token = '';
      try {
        token = window.localStorage?.getItem(TOKEN_KEY) || '';
      } catch {
        /* private mode, or a full quota. The session cookie may still carry it. */
      }
      if (token) headers['x-beadcause-token'] = token;
      nativeFetch(ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(report),
        keepalive: true,
      }).then(hush, () => {});
    } catch {
      /* a report that cannot even be built is a report that is dropped */
    }
  }

  /**
   * The one thing an answer to a report is read for: "a deploy is happening, stop".
   *
   * Everything else in the answer is ignored, including whether it filed anything —
   * there is nothing a page could usefully do with the id of a bead about itself, and
   * `{ok: false}` for a tracker that is down is already handled by dropping.
   *
   * Guarded to the point of paranoia because it runs on the error path: a response
   * without `json` is the shape a test stub and a `keepalive` beacon both have, a body
   * that is not JSON is an interposing proxy, and both of those are "no answer" rather
   * than something to raise an error about from inside the error reporter.
   */
  function hush(res) {
    try {
      if (!res || typeof res.json !== 'function') return;
      res.json().then((body) => {
        const until = Date.parse(body?.quiet?.until || '');
        if (!Number.isFinite(until)) return;
        const now = Date.now();
        // Never shortened by a later answer, and never trusted past the ceiling.
        quietUntil = Math.max(quietUntil, Math.min(until, now + MAX_QUIET_MS));
      }, () => {});
    } catch {
      /* a body that cannot be read is an answer this page did not get */
    }
  }

  /**
   * The one funnel. Everything below calls this and nothing else calls `post`.
   *
   * Wrapped whole in a `try` on purpose: this runs on the error path of a page that is
   * already having a bad time, and the one outcome that would be worse than losing the
   * report is throwing from the handler that was meant to record it.
   */
  function report(kind, fields = {}) {
    try {
      if (leaving) return false;
      const now = Date.now();
      // Ahead of the cap and the cooldown, both of which spend something: a report
      // refused for the duration of a deploy must not also cost this page one of its
      // eight, or the first real error after the window would find no room left.
      if (now < quietUntil) return false;
      const message = oneLine(fields.message);
      if (!message) return false;
      if (isEcho(message, now)) return false;
      const source = oneLine(fields.source);
      const line = Number(fields.line);
      const column = Number(fields.column);
      const stack = scrub(fields.stack).split('\n').slice(0, STACK_LINES).join('\n');
      // The key the cap counts by. Deliberately not the daemon's fingerprint: this one
      // is about one page's chatter, so it keeps the kind and the exact text apart
      // rather than folding two occurrences of a bug together the way a bead does.
      if (!allowed(`${kind}|${source}:${fields.line}|${message}`, now)) return false;
      const payload = {
        kind,
        message: message.slice(0, MESSAGE_LIMIT),
        // Never `location.href`: the query is where the daemon token rides. See bc-sqab.
        url: String(window.location?.pathname || ''),
        userAgent: String(window.navigator?.userAgent || ''),
        at: new Date().toISOString(),
      };
      if (source) payload.source = source;
      if (Number.isFinite(line) && line > 0) payload.line = line;
      if (Number.isFinite(column) && column > 0) payload.column = column;
      if (stack) payload.stack = stack;
      post(payload);
      return true;
    } catch {
      return false;
    }
  }

  /* ----------------------------------------------------------------- handlers */

  /**
   * An uncaught exception.
   *
   * Not in the capture phase, and that is the whole of how a failed `<img>` or a script
   * that 404s is kept out: those fire `error` at the element and only reach `window` by
   * capture, and an asset that did not load is not an exception. A real one is an
   * `ErrorEvent` and has a `message`; the guard says both things at once.
   *
   * `event.error` is the Error itself where the browser has it — a cross-origin script
   * gets "Script error." and nothing else, which is still worth more than a red toast
   * nobody saw, and the daemon's fingerprint falls back to the message for exactly it.
   */
  window.addEventListener('error', (event) => {
    if (!event || typeof event.message !== 'string' || !event.message) return;
    report('error', {
      message: event.message,
      source: event.filename,
      line: event.lineno,
      column: event.colno,
      stack: event.error?.stack,
    });
  });

  /**
   * A rejected promise nobody awaited.
   *
   * The reason is whatever was thrown, which is usually an Error and is under no
   * obligation to be one. A bare object stringifies to `[object Object]`, which is the
   * same useless message for every distinct bug — so an object with no `message` is
   * described by its own JSON instead, cut short, which at least fingerprints apart.
   */
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event?.reason;
    report('rejection', { message: reasonText(reason), stack: reason?.stack });
  });

  function reasonText(reason) {
    if (reason instanceof Error || (reason && typeof reason.message === 'string' && reason.message)) {
      const name = reason.name && reason.name !== 'Error' ? `${reason.name}: ` : '';
      return `unhandled rejection — ${name}${reason.message}`;
    }
    if (reason && typeof reason === 'object') {
      let shape = '';
      try {
        shape = JSON.stringify(reason).slice(0, 200);
      } catch {
        shape = Object.prototype.toString.call(reason);
      }
      return `unhandled rejection — ${shape}`;
    }
    return `unhandled rejection — ${String(reason)}`;
  }

  /* -------------------------------------------------------------------- fetch */

  /**
   * Every fetch this page makes, watched on the way back.
   *
   * The wrapper is transparent: the same promise, the same response, the same rejection,
   * re-thrown so every existing `catch` behaves exactly as it did. The page cannot tell
   * it is there, which is the only acceptable shape for something wrapped around the one
   * function the whole app is built on.
   *
   * The path in the message rather than only in `source`, because the list of these
   * beads is read as a list of symptoms and "POST /api/answer failed" is one you
   * recognise. Its *query* never is: `?id=bc-4f2` would file a bead per bead you opened,
   * and it is also the one place a token could be.
   */
  if (nativeFetch) {
    window.fetch = function fetch(input, init) {
      let where = null;
      try {
        where = target(input, init);
      } catch {
        where = null;
      }
      let out;
      try {
        out = nativeFetch(input, init);
      } catch (err) {
        // A `fetch` that throws synchronously rather than rejecting — a malformed
        // Request. Reported, then re-thrown exactly as it came.
        if (where) failed(where, err, init);
        throw err;
      }
      if (!where || !out || typeof out.then !== 'function') return out;
      return out.then(
        (res) => {
          // 4xx is the daemon declining on purpose. 5xx is the daemon failing.
          if (res && res.status >= 500) {
            const message = `${where.method} ${where.path} failed — HTTP ${res.status}`;
            if (report('fetch', { message, source: where.path })) remember(`HTTP ${res.status}`, Date.now());
          }
          return res;
        },
        (err) => {
          failed(where, err, init);
          throw err;
        }
      );
    };
  }

  /** A fetch that never came back, unless the page is the reason it did not. */
  function failed(where, err, init) {
    try {
      if (err?.name === 'AbortError' || init?.signal?.aborted) return;
      const why = oneLine(err?.message) || String(err?.name || 'the request failed');
      if (report('fetch', { message: `${where.method} ${where.path} failed — ${why}`, source: where.path, stack: err?.stack })) {
        // The caller is about to toast `why` on its own. One incident, one bead.
        remember(why, Date.now());
      }
    } catch {
      /* never from here */
    }
  }

  /**
   * What a fetch was for: a method and a same-origin path, with the query gone.
   *
   * `null` for anything not worth watching — the report endpoint itself (a loop with no
   * floor), and anything cross-origin, which this app does not do and which would put
   * somebody else's URL on a bead if it started.
   */
  function target(input, init) {
    const raw = typeof input === 'string' ? input : input?.url || String(input || '');
    if (!raw) return null;
    const url = new URL(raw, window.location?.href || 'http://localhost/');
    if (window.location?.origin && url.origin !== window.location.origin) return null;
    if (url.pathname === ENDPOINT) return null;
    const method = String(init?.method || (typeof input === 'object' && input?.method) || 'GET').toUpperCase();
    return { method, path: url.pathname };
  }

  /* -------------------------------------------------------------------- toast */

  /**
   * A red toast, filed.
   *
   * The four `toast(msg, bad)` functions call this and pass nothing but the message —
   * every one of them is a copy of the others, and giving each a stack to unpick would
   * have been the fifth copy of this comment. The stack is taken here instead, and then
   * the frames that are *this machinery* are dropped: report.js's own, and the `toast`
   * function that called it. What is left on top is the `catch` that decided the thing
   * was worth showing red, which is the line you want on the bead — the toast function
   * itself is the same line for every failure on the page, and would have collapsed
   * every red toast on the inbox into one bead.
   */
  function fromToast(message) {
    return report('toast', { message, stack: callerStack() });
  }

  /**
   * A stack with the reporter and the toast that called it cut off the top.
   *
   * Both dialects, because the phone is the reporter this exists for and the phone runs
   * Safari: V8 writes `at toast (file:line:col)`, Safari and Firefox write
   * `toast@file:line:col`. A frame that survives a rename of `toast` is not worth
   * chasing — if the filter ever misses, the fingerprint lands on the toast function
   * and the reports merely group more coarsely than they should.
   */
  function callerStack() {
    try {
      const raw = new Error('report').stack;
      if (!raw) return '';
      const kept = String(raw)
        .split('\n')
        .filter((line) => {
          if (/^\s*[A-Za-z]*Error\b/.test(line)) return false;
          if (/\breport\.js\b/.test(line)) return false;
          if (/^\s*at\s+(?:Object\.)?(?:toast|fromToast)\b/.test(line)) return false;
          if (/^\s*(?:toast|fromToast)@/.test(line)) return false;
          return true;
        });
      return kept.join('\n').trim();
    } catch {
      return '';
    }
  }

  /* ---------------------------------------------------------------------- api */

  window.beadcause = window.beadcause || {};
  window.beadcause.report = {
    /**
     * What the four toasts call: `window.beadcause?.report?.toast?.(msg)`, guarded at
     * every call site, because a page whose reporter did not load must behave exactly
     * as it did before there was one.
     */
    toast: fromToast,
    /** A failure a page knows about and does not toast. Nothing uses it yet. */
    error: (message, fields = {}) => report('manual', { ...fields, message }),
    /**
     * Whether a report for this would leave right now, without sending one. For the
     * suite, and for a console when a report has silently not arrived: the answer is
     * almost always the cap or the cooldown.
     */
    capacity: () => Math.max(0, MAX_PER_WINDOW - recent.filter((t) => Date.now() - t < WINDOW_MS).length),
    /**
     * When this page will report again, as ms since the epoch, or 0 for "now".
     *
     * The second thing to check when a report has silently not arrived, after
     * `capacity()`: a deploy in the last minute is the other reason, and it is the one
     * that looks like nothing at all from the page's side.
     */
    quietUntil: () => quietUntil,
  };
})();
