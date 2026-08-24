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
  5. **Anything the service worker hit** (bc-u3g4). Added last and lost worst: public/sw.js
     runs in its own global and none of the four above can reach into it, so the shell
     failing to cache on install was silent for as long as that worker lived. It notices
     and relays; this file is what sends. See the `service worker` section below.

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
  - **One failure of the long poll.** `/api/poll` is parked almost all of the time, so it
    is what every momentary loss of the connection lands on — a phone waking, a tailnet
    reconnecting, an extension that wraps `fetch`. The app recovers on its own and the
    staleness banner says so meanwhile. The *second* failure with nothing answering in
    between is reported, because that one is a poll that never came back. See `PARKED`.
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
  screen per endpoint for the single fact that you pressed Ship. Nothing on this side can
  know that is what happened — the deploy journal does, and for a blue/green swap, which
  is a restart that writes no deploy record at all, the marker bin/router.js leaves on the
  handover does (bc-kttd). So the *authority* is `reportingQuiet` in lib/deploy.js
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

  /** What public/sw.js relays its own failures under. Changing it means changing both. */
  const SW_MESSAGE = 'beadcause:sw-error';

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

  /* ---------------------------------------------------------------- in flight */

  /**
   * How many requests this page is waiting on, published for anything that draws it.
   *
   * This file already wraps `fetch` for the whole page, and wrapping it a second time
   * to answer a second question would mean two shims around the one function the app is
   * built on, each transparent only as long as the other stays polite. So the count
   * lives here beside the failure watch — the wrapper is unchanged in what it hands
   * back, and everything else it now does is a `++` and a `--`.
   *
   * The consumer is public/orbit.js, which turns it into the beads orbiting the brand
   * dot. Nothing here knows that; this end publishes a number and a subscription, and
   * a page with no orbit script is a page where nobody is listening.
   *
   * @see QUIET for the two requests that deliberately do not count.
   */
  let inFlight = 0;

  /** Everything that wants to hear the number change. */
  const watchers = new Set();

  /**
   * Requests that are out almost all of the time, and mean nothing about a view.
   *
   * `/api/poll` is public/stream.js's long poll: it *parks* for twenty-five seconds by
   * design, so a signal built on "is a request out" would read as permanently loading on
   * every standing view and never say anything again. `/api/presence` is the heartbeat
   * behind the thumbs on the mirror — somebody else's finger, on a timer, not this
   * screen fetching anything.
   *
   * The report endpoint is already excluded a layer down: `target()` returns null for it
   * and for anything cross-origin, and an uncounted request is exactly what null means
   * here too.
   */
  const QUIET = ['/api/poll', '/api/presence'];

  /** One more request out. */
  function entered() {
    inFlight += 1;
    if (inFlight === 1) tellWatchers();
  }

  /**
   * One fewer. Floored at zero because a wrapper that double-counted a settle once would
   * otherwise leave the count negative for the life of the page, and a negative count
   * is a spinner that never stops.
   */
  function settled() {
    inFlight = Math.max(0, inFlight - 1);
    if (inFlight === 0) tellWatchers();
  }

  /**
   * Only the edges are published — nothing subscribes to "three instead of two", and a
   * page loading nine endpoints at once would otherwise wake every watcher eighteen
   * times for one visible state.
   */
  function tellWatchers() {
    for (const fn of watchers) {
      try {
        fn(inFlight);
      } catch {
        /* a watcher that throws is not this file's problem, and must not be the app's */
      }
    }
  }

  /* ------------------------------------------------------------------- parked */

  /**
   * Requests this page holds open by design, and why the first failure of one is not news.
   *
   * `/api/poll` is public/stream.js's long poll. It parks for twenty-five seconds at a
   * time, continuously, for the whole life of every open page — so it is the one request
   * in the app that is nearly always in flight, and therefore the one that *any*
   * momentary loss of the connection lands on. A phone waking, a tailnet reconnecting, a
   * Wi-Fi handover, an extension that wraps `fetch` and drops one in passing: none of
   * those is a bug in this app, and every one of them was a P0 with an advocate on it
   * inside the hour. That is bc-y8wf — a single occurrence, never repeated in the two
   * days it stayed open, filed from a stack whose top two frames are a browser
   * extension's request interceptor.
   *
   * **Nothing is lost by staying quiet the first time**, and that is an argument rather
   * than a hope. The failure is already visible where a person can act on it: stream.js
   * retries on a backoff and public/freshness.js raises the staleness banner, so the
   * screen says so while this file says nothing. And a poll that stays broken is not
   * silenced — the *second* failure with nothing answering in between is reported, which
   * is precisely the case the blips were drowning: a proxy that kills long connections, a
   * daemon answering every short request and no park.
   *
   * So a bead about the poll now means something stronger than it used to: it failed
   * twice running, with nothing answering in between.
   *
   * This is deliberately narrower than `QUIET` above, which also holds `/api/presence`.
   * The heartbeat is a short request on a timer, out for a few milliseconds at a time; it
   * is only caught by an outage that a dozen other requests are catching too, and the
   * echo rule already folds those onto one bead. The poll is the one that is out when
   * nothing else is.
   */
  const PARKED = ['/api/poll'];

  /**
   * The furthest apart two failures may be and still be one incident.
   *
   * stream.js retries a broken poll on a backoff that tops out at a minute, and a park
   * lasts twenty-five seconds, so two consecutive failures land within ninety seconds of
   * each other at the very worst. Anything further apart is a second blip rather than a
   * poll that never came back, and escalating on it would be the same false P0 wearing a
   * longer clock.
   */
  const STRIKE_MS = 3 * 60 * 1000;

  /** When each parked path last failed with nothing having answered on it since. */
  const strikes = new Map();

  /**
   * Whether this failure of a parked path is the second in a row, and so worth a bead.
   *
   * Asked only from `failed`, and only for a path in `PARKED`: every other path is
   * reported the first time it fails, exactly as before.
   */
  function struckTwice(path, now) {
    const last = strikes.get(path);
    strikes.set(path, now);
    return last !== undefined && now - last < STRIKE_MS;
  }

  /**
   * Something answered on this path, so whatever was wrong is over.
   *
   * Called for *every* response, whatever its status. A 500 is the daemon failing and is
   * filed on its own account a few lines down — but it is also proof that the connection
   * is there, and reachability is the only thing `strikes` counts.
   */
  function answered(path) {
    strikes.delete(path);
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
      // Counted only once we know a handler is going on it, so the two early returns
      // above can never leave the count one high with nothing coming back to lower it.
      const counted = !QUIET.includes(where.path);
      if (counted) entered();
      return out.then(
        (res) => {
          if (counted) settled();
          // Whatever it says, something answered — which is what clears a parked path's
          // standing failure. See `PARKED`.
          answered(where.path);
          // 4xx is the daemon declining on purpose. 5xx is the daemon failing.
          if (res && res.status >= 500) {
            const message = `${where.method} ${where.path} failed — HTTP ${res.status}`;
            if (report('fetch', { message, source: where.path })) remember(`HTTP ${res.status}`, Date.now());
          }
          return res;
        },
        (err) => {
          if (counted) settled();
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
      const now = Date.now();
      // A request the page holds open is in flight for almost all of the page's life, so
      // one failure of it is a blip the app recovers from on its own and says so on the
      // screen. Two in a row, with nothing answering in between, is not. See `PARKED`.
      if (PARKED.includes(where.path) && !struckTwice(where.path, now)) return;
      const why = oneLine(err?.message) || String(err?.name || 'the request failed');
      if (report('fetch', { message: `${where.method} ${where.path} failed — ${why}`, source: where.path, stack: err?.stack })) {
        // The caller is about to toast `why` on its own. One incident, one bead.
        remember(why, now);
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

  /* ----------------------------------------------------------- service worker */

  /**
   * The one part of this app that none of the above can see (bc-u3g4).
   *
   * public/sw.js runs in its own global: its own `self.onerror`, no `window`, no
   * `localStorage` to read the token out of, and no page scripts. Nothing above catches
   * anything that happens in there, and what happens in there is the shell failing to
   * cache and a response failing to be stored — failures that look like a slow app and
   * survive a reload.
   *
   * So the worker notices and this end sends. Everything a report costs is spent here,
   * unchanged: the cap, the cooldown, the deploy quiet window, the scrub, the token.
   * The worker holds none of that and needs none of it, which is the point of the split
   * — see the long comment at the top of the reporting block in sw.js.
   *
   * **`startMessages()` is load-bearing, not defensive.** A message posted to a page is
   * queued until that page's message channel is started, and setting `onmessage` starts
   * it implicitly while `addEventListener` does *not*. Without the call this listener is
   * correct, registered, and never fires — which is the precise failure this whole file
   * exists to stop, wearing the costume of a feature that works.
   */
  try {
    const sw = window.navigator?.serviceWorker;
    if (sw && typeof sw.addEventListener === 'function') {
      sw.addEventListener('message', (event) => {
        const data = event?.data;
        if (!data || data.type !== SW_MESSAGE) return;
        // No `source`: the worker deliberately sends none, so the daemon fingerprints on
        // the stack's own frame or on the message. See `report` in sw.js.
        report('sw', { message: data.message, stack: data.stack });
      });
      sw.startMessages?.();
    }
  } catch {
    /* a browser with no service worker is a browser with no worker to hear from */
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

  /**
   * The one fact this file knows that is not about failure: what the page is waiting on.
   *
   * `onChange` fires immediately with the number as it stands, because a listener that
   * mounted while a request was already out would otherwise not hear about it until the
   * *next* one — and on a cold page the request already out is the whole of the load it
   * exists to draw. It hands back an unsubscribe for symmetry; nothing needs one yet.
   */
  window.beadcause.requests = {
    inFlight: () => inFlight,
    onChange(fn) {
      if (typeof fn !== 'function') return () => {};
      watchers.add(fn);
      try {
        fn(inFlight);
      } catch {
        /* as above: a watcher's own failure is not a reason to refuse it a subscription */
      }
      return () => watchers.delete(fn);
    },
  };
})();
