/*
  The delta stream — one parked request per document, instead of a clock per view.

  `/api/poll` is the daemon's ordered event log: it parks until the sequence moves and
  only then sweeps `bd`, so an idle app costs one held socket rather than a sweep
  across seven workspaces every few seconds. The inbox has lived on it since the warm
  layer landed; the other four standing views still re-ask for their whole payload on
  a `setInterval`, and each of them converting on its own would mean five hand-rolled
  long-polls with five subtly different answers to the same four questions: when may I
  follow, what happens when the socket breaks, what happens when the screen goes dark,
  and where in the log was the thing on screen true.

  So the loop lives here once — a sibling of warm.js and presence.js, which exist for
  the same reason — and each view mounts it. What this file owns is the *following*:

  - **The place in the log.** `seq` is where the payload on screen was true. A view
    hands it over after a cold fetch (`stream.seq = data.seq`) and never has to thread
    it through its own refresh path again.
  - **The park, and the abort.** One request at a time, restarted the moment it
    answers, cancelled the instant this view stops being the one on screen.
  - **The fallback.** Every failure drops to a timer rather than stopping. The one
    thing that must never happen is a view that has quietly gone deaf, and a view
    cannot be trusted to re-derive that rule correctly five times.
  - **The dark screen.** A tab in the background parks nothing; coming back picks the
    log up from where it was left, which is what makes the return instant.

  What it deliberately does *not* own is what an event means. `onPoll` is handed the
  whole answer — `{ seq, resync, events[], … }` — and the view decides whether an
  event names a row it is drawing. The inbox adopts the questions the poll carries;
  the advocate console cares about `events`, and none of its payload is on the poll at
  all. That is the split: this file knows *when* something moved, the view knows *what
  moved means to me*.

  Nothing here is load-bearing in the sense warm.js is not: a page served without this
  file falls back to whatever it did before, because `mount` is reached through
  `window.beadcause?.stream?.mount?.()` and a view that gets nothing back keeps its
  timer. A view that cannot follow is a view that is merely as current as it was.

  Not converted, on purpose: public/mirror.js parks on `/api/poll?want=presence` and
  never stops — it follows another device whether or not its own pane is showing, and
  it has no fallback because there is nothing to fall back *to*. Those are three of the
  four rules above deliberately inverted, so it is a different loop rather than this
  one with options.
*/
(() => {
  'use strict';

  /** How long the daemon may hold the request. Its own ceiling is 55s. */
  const WAIT_S = 25;
  /** Used only when a mount asks for a fallback timer without saying how often. */
  const FALLBACK_MS = 25000;

  /**
   * Follow the event log for one view.
   *
   * @param {object} opts
   * @param {(path: string, init?: object) => Promise<any>} opts.api
   *   The page's own fetch helper — not a shared one, because the five pages disagree
   *   about what a 401 means: the inbox forgets the token and puts up sign-in, admin
   *   throws. That decision belongs to the page, so the request is made through it.
   * @param {() => boolean} [opts.ready]
   *   Everything beyond having a place in the log that has to be true before this may
   *   park: a token, and for the inbox the scope whose channel the poll actually
   *   carries. Re-asked on every turn of the loop, so a view that stops being
   *   followable mid-park is dropped on the answer rather than on the next tick.
   * @param {'presence'|null} [opts.want]
   *   `'presence'` tells the daemon this listener does not read the question lists, so
   *   an event does not make it sweep `bd` to build a payload nobody will look at. Any
   *   view that does not draw the inbox should pass it.
   * @param {boolean} [opts.shade] Claims a notification tray — the Android shell only.
   * @param {(data: object) => void} [opts.onPoll]
   *   Every answer, quiet ones included, after `seq` has moved. `data.questions` is
   *   null when the park simply timed out; `data.events` is what moved otherwise.
   * @param {(data: object) => void} [opts.onResync]
   *   The log lost its place — the daemon restarted, or you were away longer than it
   *   keeps. A view whose payload does not ride the poll refetches here; a view whose
   *   does gets it in the same answer and can leave this out. Called before `onPoll`.
   * @param {() => void} [opts.onFallback]
   *   The clock, which runs only when the log cannot be followed. Omit it and a view
   *   that cannot follow simply does not refresh — right for a view that has no
   *   refresh loop today, wrong for one converting off a timer.
   * @param {() => number} [opts.fallbackMs] How often that clock ticks.
   * @param {(err: Error) => boolean} [opts.keepPlace]
   *   Whether a failed poll should keep `seq` rather than drop to the fallback. True
   *   for the refusals a page is already handling — a rejected token puts up its own
   *   dialog and will reload from scratch — false for the network, which is the case
   *   the fallback exists for.
   */
  function mount(opts = {}) {
    const {
      api,
      ready = () => true,
      want = null,
      shade = false,
      wait = WAIT_S,
      onPoll,
      onResync,
      onFallback,
      fallbackMs = () => FALLBACK_MS,
      keepPlace = () => false,
    } = opts;

    if (typeof api !== 'function') throw new TypeError('stream.mount needs an api(path, init) to poll through');

    /**
     * Where in the log this view was true.
     *
     * 0 means "we do not know" — nothing fetched yet, or a daemon old enough to send
     * no sequence at all — and it is what makes `canFollow` false, so the fallback
     * takes over rather than a park that could never be answered.
     */
    let seq = Number(opts.seq) || 0;
    let following = false;
    let abort = null;
    let timer = null;
    let stopped = false;

    const canFollow = () => !stopped && seq > 0 && Boolean(ready());

    const path = (since) =>
      `/api/poll?since=${since}&wait=${wait}` + (want ? `&want=${encodeURIComponent(want)}` : '') + (shade ? '&shade=1' : '');

    async function follow() {
      if (following || !canFollow()) return;
      following = true;
      try {
        while (canFollow() && !document.hidden) {
          const at = seq;
          abort = new AbortController();
          let data;
          try {
            data = await api(path(at), { signal: abort.signal });
          } finally {
            abort = null;
          }
          // Something moved us on while we were parked — a cold load that reset the
          // place, or a view that stopped being followable. Either way this answer is
          // about a list nobody is looking at any more.
          if (!canFollow() || at !== seq) break;
          seq = Number(data?.seq) || 0;
          if (data?.resync) onResync?.(data);
          onPoll?.(data || {});
          // An old daemon answering without a sequence. There is nothing to follow, so
          // hand over to the clock rather than spinning on `since=0`.
          if (!seq) break;
        }
      } catch (err) {
        // An abort is us, on the way somewhere else. Anything else — the daemon
        // restarting, the tailnet dropping — loses our place, and losing it is what
        // hands the view back to its timer until a fresh fetch says where we are.
        if (err?.name !== 'AbortError' && !keepPlace(err)) seq = 0;
      } finally {
        following = false;
        schedule();
      }
    }

    /** Stop waiting on an answer about something this view has stopped showing. */
    function unfollow() {
      abort?.abort();
      abort = null;
    }

    /**
     * Pick whichever of the two refresh paths is currently possible.
     *
     * Called after anything that could change the answer — a fresh sequence, a scope
     * change, a screen waking — and it is what guarantees exactly one of the park and
     * the clock is ever live. Cheap and idempotent, so a view may call it freely.
     */
    function schedule() {
      clearInterval(timer);
      timer = null;
      if (stopped) return;
      if (canFollow() && !document.hidden) {
        follow();
        return;
      }
      // Whatever is parked is parked on something this view has stopped drawing.
      // Dropped here rather than left to time out, so the two never overlap.
      unfollow();
      if (!onFallback) return;
      const ms = Number(fallbackMs()) || FALLBACK_MS;
      timer = setInterval(() => {
        if (!document.hidden) onFallback();
      }, ms);
    }

    // A parked socket in a pocket costs both ends nothing once it is dropped, and the
    // daemon lets the waiter go when the request closes. Owned here rather than left
    // to each view because getting it wrong is invisible: the tab keeps working and
    // the phone keeps a socket open all night.
    const onVisibility = () => (document.hidden ? unfollow() : schedule());
    document.addEventListener('visibilitychange', onVisibility);

    return {
      /** Where in the log this view believes it is. */
      get seq() {
        return seq;
      },
      /**
       * Where a cold fetch says it is. The one thing a view must remember to do: the
       * sweep it just paid for is also what tells the log where to pick up, and
       * without this the view stays on its clock for ever.
       */
      set seq(v) {
        seq = Number(v) || 0;
      },
      get following() {
        return following;
      },
      canFollow,
      schedule,
      unfollow,
      /** For a page handing over — stops both paths and lets the listener go. */
      stop() {
        stopped = true;
        clearInterval(timer);
        timer = null;
        unfollow();
        document.removeEventListener('visibilitychange', onVisibility);
      },
    };
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.stream = { mount, WAIT_S, FALLBACK_MS };
})();
