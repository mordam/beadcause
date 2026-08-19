/*
  The delta stream — one long poll, mounted by every standing view.

  `/api/poll` is an ordered event log. Hand it the sequence your screen was true at
  and it parks until the daemon's counter moves; when it answers it says what moved,
  and it sweeps `bd` only if something did. That is a different bargain from a timer
  in two ways that both matter: an idle app costs one held socket rather than a sweep
  across seven workspaces per tick, and a bead that moves lands on the screen in the
  moment it moved rather than up to a minute later. Faster *and* cheaper.

  The inbox had the only consumer of it, hand-rolled inside app.js, and the other four
  views refreshed by throwing their whole payload away on a `setInterval`. Five
  hand-rolled long-polls with five subtly different abort and resync behaviours is the
  outcome this file exists to avoid — the same argument as warm.js and presence.js,
  which are the precedent for "one behaviour, five documents".

  **What it does and does not decide.** It owns the socket, the sequence, the abort and
  the visibility rule. It does not know what an event means to your rows — that is the
  view's, because only the view knows whether `type: 'merged'` is a lamp, a count or
  nothing at all. So the whole contract is: here is the payload, here are the events
  since you last looked, and here is whether you fell off the end of the log.

  **Nothing here is load-bearing.** Every failure ends the loop and calls `onSettle`,
  which is where a caller puts whatever it did before this existed. A view that cannot
  follow the stream is a view that is merely as slow as it was yesterday; a view that
  has quietly stopped refreshing is the one thing that must never happen.

  ## Parking without paying for a sweep

  The daemon sweeps `bd` for a parked poll only when that poll asked for the inbox
  questions. `want: 'presence'` says it did not, and then a wake costs the daemon
  nothing but the events themselves — while still carrying the advocate snapshot, the
  presence list, the observer flag and the workspace names, which between them are most
  of what the four non-inbox views draw. So a view that does not draw the inbox should
  say so: four parked clients all asking for questions would mean four `bd` sweeps per
  event, which is the timer's bill arriving by another route.

  ## One park per page, even when the page is several views

  The shell is one document with a pane per view (bc-khoe.30), so "every standing view
  mounts this" would be five mounts behind one screen. It is not: public/panestage.js
  fans one poll's wakes out to the panes through `listen`, and the panes' `want`s are
  unioned into the one request rather than each becoming a park of its own.

  That leaves one hole, and `standby` is what fills it. The inbox owns the real mount and
  follows the log only in `human` scope — so on a wider scope its poll is off, and panes
  riding its wakes would go quiet with it while the pages they replaced kept polling. A
  standby mount runs exactly when no ordinary one is following: `arbitrate` stands them
  down the moment an ordinary loop starts and puts them back when the last one ends, and
  `alive()` refuses one that is started from anywhere else meanwhile. Two mounts, never
  two sockets.
*/
(() => {
  'use strict';

  /** How long to let the daemon hold the request. Its own ceiling is 55. */
  const WAIT_S = 25;

  /**
   * The ceiling on the retry backoff.
   *
   * A minute, because that is roughly what the slowest of the timers this replaced was
   * doing anyway — so a page whose daemon has gone is, at its very worst, back to where
   * it started, and it is there for as long as the daemon is gone rather than forever.
   */
  const MAX_RETRY_MS = 60000;

  /**
   * An event that says nothing about the tracker.
   *
   * Presence is a thumb moving on a phone. It wakes the poll on purpose — the mirror
   * wants it immediately — but a card opening in a hand has not changed a bead, a
   * count or a lamp, so a view that refetched for it would have built a timer out of
   * somebody else's scrolling. Every view that asks "did anything actually move"
   * means "anything but this".
   */
  const QUIET_TYPES = new Set(['presence']);

  /** Did anything in this batch change something a view might be drawing? */
  const moved = (events) => (events || []).some((e) => !QUIET_TYPES.has(e?.type));

  /**
   * Did any of these events have one of `types`?
   *
   * The finer half of the same question, and how a view avoids fetching a payload the
   * event cannot have changed: the PR board has no opinion about a comment landing on
   * a bead, and the advocate console has none about a deploy finishing.
   */
  const touched = (events, types) => {
    const want = new Set([].concat(types));
    return (events || []).some((e) => want.has(e?.type));
  };

  /**
   * Advocate actions the poll's own snapshot has already answered.
   *
   * `advocates.snapshot()` rides every wake whatever woke it, so an advocate pausing,
   * checking in, going idle or bumping into the slot cap is a repaint of data that has
   * already arrived — not a reason to go and ask anything. Everything else an advocate
   * does moves a row that comes out of `bd` or off the filesystem.
   */
  const ROSTER_ONLY = new Set(['checked-in', 'surveying', 'idle', 'paused', 'resumed', 'forgot', 'limit']);

  /**
   * Did anything here change something behind `/api/work` — `bd`, or the live sessions?
   *
   * The advocates page asks this to decide whether to sweep, and the inbox asks it to
   * decide whether the copy it is holding *for* that page has gone stale. One function
   * rather than two, because the two answers have to be the same one: an inbox that
   * thought a claimed bead was a repaint would hand the advocates tab a warm payload
   * missing exactly the row you tapped through to see.
   */
  const workMoved = (events) =>
    (events || []).some((e) => !QUIET_TYPES.has(e?.type) && !(e?.type === 'advocate' && ROSTER_ONLY.has(e?.action)));

  /**
   * The events that can have changed a lamp or a button on the PR board.
   *
   * It lived in public/prs.js, which was the only page that had an opinion about it —
   * and then the inbox grew one too, because it holds `/api/prs` warm for that page and
   * has to know whether what it is holding is still true. Two lists would be one list
   * that drifts, and the drift is invisible: an inbox that thought a merge was nothing
   * would keep restamping a board with the wrong lamps on it, and the lamps' whole claim
   * is that they are true. So this is the one copy, for the same reason `workMoved` is
   * one function and not two.
   */
  const BOARD_EVENTS = ['merged', 'changes', 'pr-declined', 'deploy', 'advocate'];

  /** Did anything here change something behind `/api/prs`? */
  const boardMoved = (events) => touched(events, BOARD_EVENTS);

  /**
   * The events that can change what is waiting for endorsement.
   *
   * A bead filed while you were asleep (`created`), a verdict landing from the other
   * device (`endorsement`), an agent amending one it was asked to change (`amended`),
   * and both halves of a discussion — the dispatch (`discussion`) and the reply that
   * comes back as a comment (`commented`), because the folded row draws a 💬 count and
   * a bead you asked three questions about last night must not read as one nobody has
   * opened.
   *
   * Here rather than in public/endorse.js for the reason BOARD_EVENTS is here: two
   * pages ask this question. The queue asks it to decide whether to sweep, and the
   * inbox asks it to decide whether the copy it is holding *for* that page is still
   * true — and the two answers have to be the same one, or the inbox hands the queue a
   * warm payload missing exactly the bead that was filed while you were reading.
   */
  const QUEUE_EVENTS = ['created', 'endorsement', 'amended', 'commented', 'discussion'];

  /** Did anything here change something behind `/api/unendorsed`? */
  const queueMoved = (events) => touched(events, QUEUE_EVENTS);

  /**
   * Everything on the page that wants the events without owning a poll.
   *
   * One park per page is the rule this file exists to keep — public/montabs.js stands a
   * hidden pane's poll *down* for the same reason, and a shared script that opened its
   * own would put a second parked request behind every page in the app, on every device,
   * for one boolean. public/update.js is that script: it needs to know a deploy settled
   * and nothing else, and the page it is loaded onto is already being told.
   *
   * So a listener registered here is handed the same `events` array the view's own
   * `onWake` gets, from whichever `follow()` on the page answered — and a page with no
   * stream at all (the login screen, a doc in the reader) simply never calls it, which
   * is why every listener must also have a way of asking cold. A throw in one listener
   * is contained: it is somebody else's screen, not the poll's.
   */
  const listeners = new Set();

  function listen(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /**
   * Hand every listener what the poll just answered.
   *
   * `events` is the first argument because it was the only one for public/update.js, which
   * wants a boolean about deploys and nothing else. The payload came second when
   * public/panestage.js started fanning wakes out to the shell's panes (bc-khoe.30.4): a
   * pane that used to own a `follow` read `data` in its `onWake` — the advocate snapshot,
   * the presence list, the workspace names all ride every wake — and a fan-out that dropped
   * it would have been a channel every pane had to go and re-fetch behind. Second rather
   * than folded into one object so the listener that predates it is untouched.
   */
  function tell(events, extra) {
    for (const fn of listeners) {
      try {
        fn(events, extra);
      } catch (err) {
        console.error('[stream] listener failed', err);
      }
    }
  }

  /**
   * Park on the log and keep parking.
   *
   * @param {object} o
   * @param {function} o.api        the page's own fetch wrapper — `(path, {signal}) => Promise<data>`
   * @param {number} [o.seq]        where in the log the screen is; 0 means "we do not know"
   * @param {string|function} [o.want] `'presence'` to park without asking the daemon to sweep
   *                                       `bd`; a function is read per request, for a mount
   *                                       whose want is a union that can widen under it
   * @param {number} [o.wait]       seconds to let the daemon hold each request
   * @param {boolean} [o.cold]      may the first request omit `since` to learn a sequence?
   * @param {number} [o.retryMs]    how long after a broken poll to try again; 0 to stop instead
   * @param {boolean} [o.visibility] register the hidden/visible rule (default true)
   * @param {boolean} [o.standby]   only run while no ordinary mount is following — see below
   * @param {function} [o.ready]    an extra condition of the view's own — a token, a scope, a pane
   * @param {function} [o.onWake]   `({data, events, resync})` — an answered poll
   * @param {function} [o.onSettle] the loop has ended; fall back to whatever you did before
   * @returns {{start: function, stop: function, seq: number, following: boolean}}
   */
  function follow({
    api,
    seq = 0,
    want = null,
    wait = WAIT_S,
    cold = false,
    retryMs = 5000,
    visibility = true,
    standby = false,
    ready = () => true,
    onWake = null,
    onSettle = null,
  } = {}) {
    let at = Number(seq) || 0;
    let following = false;
    let abort = null;
    // Set by `stop()` and cleared by `start()`, so a stop that lands while a request is
    // in flight cannot be undone by the loop coming round again. Without it, aborting
    // mid-request would abort and then immediately re-park.
    let stopped = false;
    // Whether this mount has ever had an answer. Only the very first request may go out
    // without a `since` — see `url`.
    let asked = false;
    let retryTimer = null;
    // How long to wait before the next attempt, doubling while the failures continue and
    // reset by the first answer. A daemon that is down for an hour — a deploy, a laptop
    // asleep, a tailnet that has gone — must not be asked twelve times a minute for the
    // whole hour by every page somebody left open.
    let backoff = retryMs;

    /**
     * Can the loop go round again?
     *
     * A sequence to start from is the condition, not a nicety: a view with no place in
     * the log has nothing to park on, and for the inbox that is exactly when the timer
     * takes over. `cold` lifts it for the views whose own payload carries no sequence:
     * they are allowed to go and ask the log where they are.
     *
     * `standby && busy()` is the last clause and it is what keeps "one park per page" true
     * of a mount nobody times. A standby is a mount that only exists to keep the page fed
     * when the view that owns the real poll has stood its own down, and the two would
     * otherwise both be in flight for the seconds between one starting and the other
     * noticing — a page holding two sockets, which is the one thing this file is for. Read
     * here rather than only in `arbitrate` because a `start()` can arrive from anywhere: a
     * visibility handler, `wake()`, a retry timer.
     */
    const alive = () =>
      !stopped &&
      (at > 0 || cold) &&
      ready() &&
      !(typeof document !== 'undefined' && document.hidden) &&
      !(standby && busy());

    function url(since) {
      const q = new URLSearchParams();
      // A missing `since` is the daemon's "this client has no place in the log": it
      // answers at once rather than parking, which is how a view whose payload carries
      // no sequence learns one — and with `want=presence` that first request sweeps
      // nothing. Exactly once per mount, and only for a mount that asked for it: a poll
      // that keeps sending one is a busy loop against the daemon, and for the inbox —
      // whose park does ask for the questions — it would be a busy loop that swept `bd`
      // across every workspace each time round.
      //
      // `since=0` is a different thing and a legitimate one: a daemon that has emitted
      // nothing since it started really is at zero, and a poll parked there waits for
      // the first event like any other. That is why the second request always carries
      // one even when the first came back with a zero.
      if (asked || !cold) {
        q.set('since', String(Math.max(0, since)));
        q.set('wait', String(wait));
      }
      // Read per request rather than closed over, so a mount whose want is the union of
      // several panes' can widen without becoming a second mount — public/panestage.js
      // re-parks the one it has instead. A second `follow` would leave the first in
      // `mounted` forever, and `arbitrate` would dutifully start it again.
      const asking = typeof want === 'function' ? want() : want;
      if (asking) q.set('want', asking);
      return `/api/poll?${q.toString()}`;
    }

    async function loop() {
      if (following || !alive()) return;
      following = true;
      // An ordinary mount taking the socket is what stands every standby down — aborting
      // the request rather than waiting for it to notice, because a standby that noticed
      // at its own next turn would hold a second park for up to `wait` seconds.
      if (!standby) arbitrate();
      // A deliberate ending — a stop, a scope change, an old daemon — is not a failure
      // and must not be retried. Only the catch below sets this.
      let broke = false;
      try {
        while (alive()) {
          const from = at;
          abort = new AbortController();
          let data;
          try {
            data = await api(url(from), { signal: abort.signal });
          } finally {
            abort = null;
            asked = true;
          }
          // Somebody moved the sequence under us — a cold fetch of the view's own
          // payload came back while we were parked — or the view has stopped wanting
          // this. Either way this answer is about a screen nobody is looking at.
          if (!alive() || from !== at) break;
          // A sequence that is *absent* is not the same fact as a sequence of zero, and
          // conflating them is how this becomes a busy loop. Zero is a real place in the
          // log — a daemon that has emitted nothing since it started — and a poll parked
          // there waits like any other. Absent means whatever answered does not keep a
          // log at all: an old daemon, a proxy, a stub. There is nothing to follow, and
          // asking again would be a request at full speed for as long as the page is
          // open, which is worse than the timer this replaced by any measure.
          // Something answered — which is the only fact public/freshness.js needs, and it
          // is deliberately stamped here rather than in the view's `onWake`: a poll that
          // answers with no events at all is a daemon that is perfectly alive and a view
          // that will not repaint, and that is precisely the case a staleness banner must
          // not fire on. The payload rides along because the daemon's own sweep age is on
          // it. Optional at every call: a page served before that file existed has no
          // `window.beadcause.fresh` and this is a no-op.
          window.beadcause?.fresh?.heard?.(data);
          const told = data && data.seq !== undefined && data.seq !== null && Number.isFinite(Number(data.seq));
          if (told) at = Number(data.seq);
          // Something answered, so whatever was wrong is over.
          backoff = retryMs;
          const events = Array.isArray(data.events) ? data.events : [];
          // `resync` is the daemon saying the log rolled past where this client was,
          // or that it restarted and the counter went back to zero. Then `events` is
          // empty and true by accident, and the only honest move is a full refetch —
          // which is the view's, because only it knows what "everything" is here.
          onWake?.({ data, events, resync: Boolean(data.resync) });
          // …and anything else on the page that wants the same events. See `listen`.
          tell(events, { data, resync: Boolean(data.resync) });
          // Nothing that keeps a log answered, so there is nothing to follow: the
          // caller's fallback — a timer, or the ⟳ — is the refresh from here.
          if (!told) break;
        }
      } catch (err) {
        // An abort is us, on the way to somewhere else, and a refused credential has
        // already put the sign-in prompt up — neither is a reason to forget where in
        // the log we were, and neither is worth retrying. Anything else (the daemon
        // restarting, the tailnet going) forgets the sequence, because the one we are
        // holding may no longer mean anything, and is retried.
        if (err?.name !== 'AbortError' && err?.message !== 'token rejected') {
          at = 0;
          broke = true;
        }
      } finally {
        following = false;
        onSettle?.();
        // …and an ordinary mount letting go is what puts them back up. `onSettle` first,
        // because a view's fallback may itself restart this loop and a standby started
        // ahead of that would be stood straight back down.
        if (!standby) arbitrate();
        // The four views that mount this have no timer left behind them, so a poll that
        // broke and stayed broken is a screen that has quietly stopped refreshing —
        // the one failure this must never have. `retryMs: 0` is for the inbox, which
        // has a timer of its own and puts itself back on it in `onSettle`.
        if (broke && retryMs && !stopped) {
          clearTimeout(retryTimer);
          retryTimer = setTimeout(start, backoff);
          backoff = Math.min(backoff * 2, MAX_RETRY_MS);
          // Not a second clock — the banner draws on ours either way. This only lets it
          // say *retrying* rather than leaving the reader to wonder whether anything is
          // still trying at all, which is the difference between a warning and an alarm.
          window.beadcause?.fresh?.trying?.(true);
        }
      }
    }

    function start() {
      stopped = false;
      clearTimeout(retryTimer);
      retryTimer = null;
      loop();
    }

    /**
     * Drop the parked request and go round again, now.
     *
     * For a mount whose `want` is a function that has just answered something wider: the
     * request in flight was built with the old one and will not be replaced for up to
     * `wait` seconds otherwise. Through a timer rather than a straight `stop(); start()`,
     * which is the shape that does not work: the abort rejects a promise the loop is
     * awaiting, so `following` is still true on the next line and `start` would find the
     * loop already running and do nothing. Same reason the retry above is a timer.
     */
    function repark() {
      stop();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(start, 0);
    }

    /** Stop waiting on an answer about a screen we have stopped showing. */
    function stop() {
      stopped = true;
      clearTimeout(retryTimer);
      retryTimer = null;
      abort?.abort();
      abort = null;
    }

    if (visibility && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        // A parked socket in a pocket. The daemon drops the waiter when the request
        // closes, so this costs nothing on either end — and coming back re-asks from
        // the sequence we left off at, which is what makes the return instant.
        if (document.hidden) stop();
        else start();
      });
    }

    const api_ = {
      start,
      stop,
      repark,
      /** Whether this mount yields the socket to any ordinary one — see `arbitrate`. */
      standby,
      get seq() {
        return at;
      },
      /**
       * Tell the stream where the screen now is.
       *
       * Written by a view whose own cold fetch carries a sequence — `/api/questions`
       * does — so the refresh behind that fetch is a parked poll rather than a second
       * sweep. Setting it while a request is parked is what makes the loop drop that
       * answer rather than apply it over a newer list.
       */
      set seq(v) {
        at = Number(v) || 0;
      },
      get following() {
        return following;
      },
    };
    mounted.add(api_);
    return api_;
  }

  /**
   * Every stream mounted on this page, so something that is not a view can wake them.
   *
   * The banner in public/freshness.js is the caller: its **Retry now** must not wait out
   * a backoff that may be up to a minute long, and it has no reference to whatever the
   * page passed to `follow`. Registered here rather than handed around because a page can
   * mount more than one (the monitor's mirror follows presence beside the view's own
   * poll), and waking one of two is a button that half works.
   */
  const mounted = new Set();

  /** Is an ordinary — non-standby — mount holding the socket right now? */
  const busy = () => {
    for (const s of mounted) if (!s.standby && s.following) return true;
    return false;
  };

  /**
   * Hand the socket to the ordinary mounts, and give it back to the standbys when they
   * let go.
   *
   * A **standby** is a mount that exists only so the page is fed when the view that owns
   * the real poll has stood its own down. public/panestage.js is the caller and the shell
   * is the case: the inbox follows the log only in `human` scope, so on any wider scope
   * its poll is off and a page whose History and Advocates panes ride the same stream
   * would have gone quiet with it — panes that are hidden rather than absent, going stale
   * where the pages they replaced were not.
   *
   * The rule is one park per page whichever mount is holding it, which is what this
   * enforces centrally rather than leaving to whoever mounts second. Standbys are stopped
   * the moment an ordinary loop starts and started again when the last of them ends, and
   * `alive()` refuses a standby that starts from anywhere else while one is running — so
   * a `visibilitychange` racing a `start()` cannot end with two sockets held either.
   *
   * Answers how many standbys it started, because `wake` below counts what it nudged.
   */
  function arbitrate() {
    const taken = busy();
    let started = 0;
    for (const s of mounted) {
      if (!s.standby) continue;
      try {
        if (taken) s.stop();
        else {
          s.start();
          started += 1;
        }
      } catch {
        /* one stream that will not move must not stop the next */
      }
    }
    return started;
  }

  /**
   * Start every stopped stream again, now. Answers how many it nudged, so a caller can
   * tell "I woke something" from "there is nothing here to wake" and fall back.
   *
   * The standbys are not in the loop and are left to `arbitrate`: starting one beside the
   * ordinary mount it stands in for is exactly the second socket this file exists to
   * avoid, and on a page whose ordinary mounts all refuse to run it is `arbitrate` that
   * puts the standby up instead.
   */
  function wake() {
    let woke = 0;
    for (const s of mounted) {
      if (s.standby) continue;
      try {
        s.start();
        woke += 1;
      } catch {
        /* one stream that will not start must not stop the next */
      }
    }
    woke += arbitrate();
    return woke;
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.stream = {
    follow,
    listen,
    wake,
    moved,
    touched,
    workMoved,
    boardMoved,
    queueMoved,
    QUIET_TYPES,
    ROSTER_ONLY,
    BOARD_EVENTS,
    QUEUE_EVENTS,
    WAIT_S,
  };
})();
