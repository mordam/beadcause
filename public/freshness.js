/*
  Is what you are looking at current? — the banner that says when it is not.

  ## The failure this exists for

  Every standing view holds a parked long poll (public/stream.js) and repaints when the
  daemon says something moved. When that works, the screen is live and nothing here draws
  anything. When it stops working — the phone slept, the tailnet dropped, the router
  swapped a backend mid-deploy, a token was rotated, the daemon died — the page does not
  go blank or throw. It keeps showing the list it had, forever, and a list that is
  eleven minutes old is pixel-for-pixel identical to one that is current.

  That is the failure this whole app exists to prevent, wearing its most convincing
  disguise: a question waiting on you, on a screen that is not showing it, with nothing
  saying the screen is behind. ⟳ existed for exactly this and asks the wrong thing of the
  reader — you have to already suspect.

  So: the app keeps itself fresh (the stream retries with backoff, and this nudges it),
  and when it cannot, it says so. Adam's words, answering bc-jhdp: *"the app should always
  getting refreshed. if it's not add an alert banner showing that data might be out of
  date."*

  ## Two silences, one banner

  They are different facts and the reader needs to be told which:

  - **"I cannot hear the daemon."** Our own clock: nothing has answered since T. Measured
    on the client because it is the only place that can be — a daemon that is unreachable
    cannot tell you it is unreachable.
  - **"The daemon is up and has not looked."** Its clock: it answers every poll instantly
    and has not read the tracker since breakfast, because a sweep is wedged or the
    interval is misconfigured. From the phone this is indistinguishable from a quiet
    morning; `sweptAt` on the payload (lib/server.js) is what makes it visible.

  One banner, one sentence, whichever is true — two banners would be two things to read
  at the moment there is least patience for reading.

  ## What it does not do

  **It does not fetch.** The stream owns the socket, the sequence and the backoff, and a
  second thing retrying on its own timer is how one page ends up with two poll loops that
  each think they are the one. This listens, counts, and draws. Its one action is
  **Retry now**, which asks the stream to start again immediately instead of waiting out
  the backoff — the same act the ⟳ button performs, in the place you are already looking
  when you want it.

  **It does not count time the page was not on screen.** A phone in a pocket is not a
  stale app, it is a paused one, and the stream deliberately stops while `document.hidden`
  (see `alive()` over there). Waking to an accusatory banner that clears itself half a
  second later would teach the reader to ignore the banner, which is the only thing it
  has. So the clock restarts on `visibilitychange`, with a grace window for the poll to
  land.

  ## Mounted like the picker, not like a view

  Its own file, loaded by every page with a top bar, drawing into a node it owns — the
  same arrangement as public/spacebar.js and public/accountbar.js, and for a stronger
  reason than either: the state it reports is *a page that has stopped repainting*, so it
  cannot live inside anybody's render.
*/
(() => {
  'use strict';

  const bar = document.querySelector('.topbar');
  if (!bar) return;

  /**
   * How long without hearing anything before the screen is called stale.
   *
   * The poll parks for 25 seconds and the daemon answers it before then; two missed
   * cycles plus the slack is around ninety. Long enough that a swap during a deploy —
   * which takes a couple of seconds and is the most common interruption there is — never
   * draws it, short enough that a phone that lost the tailnet on the way into a building
   * is told before the reader has made a decision on stale rows.
   */
  const STALE_MS = 90_000;

  /**
   * And how long after the page comes back before that clock counts again.
   *
   * The stream restarts on the same event; this is the room for its first answer to land.
   * Without it, every unlock draws the banner for the half second before the poll returns
   * — which is how a banner becomes something people learn to look past.
   */
  const WAKE_GRACE_MS = 8_000;

  /** How far behind the daemon's own sweep has to be before that is the thing worth saying. */
  const SWEEP_LATE_FACTOR = 6;

  const state = {
    /** When anything from the daemon last arrived. Optimistic at load: nothing is wrong yet. */
    heardAt: Date.now(),
    /** When the page last became visible, so hidden time is not counted against it. */
    wokeAt: Date.now(),
    /** What the daemon last said about its own sweep — an ISO string, or null before the first. */
    sweptAt: null,
    /** Its sweep interval in seconds, so "late" is measured against what it meant to do. */
    everySeconds: 30,
    /** Set while the stream is between attempts, purely so the banner can say "retrying". */
    retrying: false,
  };

  /* ------------------------------------------------------------------ the banner */

  const el = document.createElement('div');
  el.className = 'stale';
  el.setAttribute('role', 'status');
  el.hidden = true;
  el.innerHTML = `<span class="stale-what" id="stale-what"></span>
    <button type="button" class="stale-retry" id="stale-retry">Retry now</button>`;
  // After the bar rather than inside it: the bar is chrome that is always true, and this
  // is a fact about the page under it. Directly under the bar all the same, because the
  // one thing it must beat is the list it is warning you about.
  bar.insertAdjacentElement('afterend', el);

  const what = el.querySelector('#stale-what');
  const retry = el.querySelector('#stale-retry');

  /** "4m", "2h" — an age a thumb can read without arithmetic. */
  function ago(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    if (s < 90) return `${s}s`;
    const m = Math.round(s / 60);
    if (m < 90) return `${m}m`;
    return `${Math.round(m / 60)}h`;
  }

  /**
   * Which silence is happening, in one sentence — or null when neither is.
   *
   * Our own silence is tested first and wins outright: if nothing is reaching us, what
   * the daemon last said about its sweep is itself old news, and reporting *that* would
   * be quoting a stale number to explain staleness.
   */
  function why(now = Date.now()) {
    const sinceHeard = now - state.heardAt;
    const sinceWake = now - state.wokeAt;
    if (sinceHeard > STALE_MS && sinceWake > WAKE_GRACE_MS) {
      return `Out of date — nothing from the daemon for ${ago(sinceHeard)}.${
        state.retrying ? ' Retrying.' : ''
      }`;
    }
    // The daemon is answering. Is it looking? Null `sweptAt` is a daemon that has not
    // finished its first sweep — which is a second of startup, not a fault, and says
    // nothing worth interrupting for.
    if (state.sweptAt) {
      const late = state.everySeconds * 1000 * SWEEP_LATE_FACTOR;
      const since = now - new Date(state.sweptAt).getTime();
      if (Number.isFinite(since) && since > late) {
        return `The daemon is up but has not read the tracker for ${ago(since)}.`;
      }
    }
    return null;
  }

  let drawn = null;
  function paint() {
    const line = why();
    // Assigned only when it changed: this repaints on a one-second tick, and rewriting
    // the same string under a screen reader would make it re-announce every second.
    if (line !== drawn) {
      drawn = line;
      if (line) what.textContent = line;
    }
    el.hidden = !line;
  }

  /* --------------------------------------------------------------- coming in */

  /** Anything from the daemon arrived. The one call every other file has to make. */
  function heard(payload) {
    state.heardAt = Date.now();
    state.retrying = false;
    if (payload && typeof payload === 'object') {
      if (typeof payload.sweptAt === 'string') state.sweptAt = payload.sweptAt;
      const every = Number(payload.sweepEverySeconds);
      if (Number.isFinite(every) && every > 0) state.everySeconds = every;
    }
    paint();
  }

  /** The stream is between attempts. Not a clock of its own — only what the banner says. */
  function trying(on = true) {
    state.retrying = Boolean(on);
    paint();
  }

  // The stream stops while the page is hidden, so hidden time is not the app failing.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      state.wokeAt = Date.now();
      paint();
    }
  });

  /**
   * Retry now — ask whatever is following the stream to start again immediately.
   *
   * `window.beadcause.stream.wake()` if the page mounted one; a page's own `#refresh`
   * button as the fallback, which is what the four views without a stream still have. If
   * neither exists there is one honest move left, and reloading is it: the banner must
   * never be a button that does nothing.
   */
  retry.addEventListener('click', () => {
    trying(true);
    const woke = window.beadcause?.stream?.wake?.();
    if (woke) return;
    const btn = document.querySelector('.topbar #refresh');
    if (btn) return void btn.click();
    location.reload();
  });

  // One second, and it is a `setInterval` rather than a chain of timeouts on purpose: the
  // whole job is to notice that *nothing is happening*, so a clock that only ticks when
  // something happens is the one shape this cannot be built out of.
  setInterval(paint, 1000);
  paint();

  window.beadcause = window.beadcause || {};
  window.beadcause.fresh = {
    heard,
    trying,
    /** Milliseconds since anything arrived — for a test, and for anything that wants to ask. */
    age: () => Date.now() - state.heardAt,
    stale: () => Boolean(why()),
  };
})();
