/*
  The brand dot, with beads going round it while the app is fetching.

  Every page in this app has a teal dot at the left of its top bar, and until now the
  only thing it ever did was `.dot.busy` — a ring pulsing outward, which ten files
  toggled by hand and which said the same flat thing whatever was happening. Five of the
  fourteen pages that carry a brand dot never toggled it at all, so on those the app simply
  went quiet while it loaded: no first frame, no spinner, nothing between the tap and the
  screen.

  What replaces it is an orbit. A ring of small beads travels a circle seen at an oblique
  angle — so on screen an ellipse — and the half nearest you is larger and brighter while
  the half going round the back is smaller and dimmer. Beads pass in front of the dot and
  then behind it. It is the app's own noun doing the one thing a loading signal has to do,
  and at 26px across it is a detail rather than a spinner bolted to the chrome.

  **Three things here are load-bearing.**

  **It is driven from one place, and that place is the fetch wrapper.** public/report.js
  already wraps `window.fetch` for the whole page — it is the only file loaded by all
  fifteen, and it is first — so it counts what is out and publishes the number as
  `window.beadcause.requests`. This file subscribes. That is what makes the signal
  universal without a line in any view: a page that fetches anything gets the orbit from
  its own load, including the five that never asked for one. Ten copies of `api()` across
  ten page scripts is exactly the argument for not doing this per view.

  **The old class still works.** `.dot.busy` is not deleted and its ten callers are not
  touched: the stylesheet now draws the orbit for `.busy` as well as for the `.loading`
  this file sets. Two of those callers mean something a request count cannot see —
  console.js and foundations.js light the dot while an *agent* is thinking, which is not a
  fetch at all — and rewriting them to route through here would have cost that fact to buy
  nothing. The two classes are two different reasons for one picture, which is why this
  file sets its own rather than sharing theirs: `busy` is the page's assertion, `loading`
  is the fetch watch's, and neither may switch the other off.

  **Depth is done with two clipped layers, not with z-index.** The near half and the far
  half are separate elements, each holding a whole ring of beads and each clipped to its
  own half of the orbit box — `far` to everything above the dot's centre line, `near` to
  everything below. `far` sits behind the dot and `near` in front, so a bead crossing the
  line is drawn by one layer up to that line and by the other beyond it. The clips are
  exactly complementary, so nothing is drawn twice and nothing is dropped, and the handoff
  happens at the far left and right of the ellipse, where the bead is 10.5px from the dot's
  centre and well clear of its 4.5px edge, so there is nothing there to see either way. Animating `z-index` per bead would have been fewer
  elements and one more browser behaviour to trust.

  Under `prefers-reduced-motion` the orbit is drawn and does not turn. That is deliberate
  and it is not the convention absorb.js follows: an animation that decorates an outcome
  should be skipped, but this *is* the message. A still ring of beads that appears while
  the app is fetching and goes when it settles says the same thing the moving one does,
  once, without asking anybody to watch it.
*/
(() => {
  'use strict';

  /**
   * How many beads go round. Seven, at 26px across, is the largest number that still
   * reads as distinct beads rather than a dotted line on a phone.
   */
  const BEADS = 7;

  /**
   * How long a request must be out before the orbit appears.
   *
   * Every cached view in this app answers in single-digit milliseconds, and a ring that
   * flashed on for one frame of every tap would be noise that the eye reads as a glitch.
   * A signal for the wait is worth nothing when there was no wait.
   */
  const SHOW_AFTER_MS = 140;

  /**
   * And how long it stays once it is up, however fast the answer then comes.
   *
   * Without this, a request that took 150ms would draw a ring for ten of them and the
   * debounce above would have bought nothing: the flicker would just have moved. Six
   * hundred is about a fifth of a turn, which is far enough round for the near beads to
   * visibly cross the dot — long enough to read as an orbit rather than as a blink, and
   * short enough that it is never the thing you are waiting on.
   */
  const MIN_SHOW_MS = 600;

  /** The class this file sets. See the header: it is deliberately not `busy`. */
  const CLASS = 'loading';

  /** Every brand dot on the page. Twelve pages call it `#pulse`; /doc and /graph do not. */
  const dots = () => Array.from(document.querySelectorAll('.brand .dot'));

  let running = false;
  let showAt = 0;
  let timer = null;

  /**
   * Build the two layers under one dot.
   *
   * Idempotent: a dot that already has an orbit is left exactly as it is, so this can be
   * called again if a page ever grows a second brand row.
   */
  function build(dot) {
    if (!dot || dot.querySelector('.orbit')) return;
    for (const half of ['far', 'near']) {
      const layer = document.createElement('span');
      layer.className = `orbit ${half}`;
      // Nothing here is content. A screen reader announcing seven empty spans on every
      // page would be the whole cost of this file and none of its point; what a blind
      // user needs from a load is the page arriving, which it does either way.
      layer.setAttribute('aria-hidden', 'true');
      const string = document.createElement('span');
      string.className = 'orbit-string';
      layer.appendChild(string);
      for (let i = 0; i < BEADS; i += 1) {
        const bead = document.createElement('span');
        bead.className = 'orbit-bead';
        // One `@keyframes` for all fourteen; the only thing that differs is where in it
        // each bead starts. The stylesheet turns this into a negative animation-delay.
        bead.style.setProperty('--i', String(i));
        layer.appendChild(bead);
      }
      dot.appendChild(layer);
    }
  }

  /** Put the orbit up or take it down, on every dot at once. */
  function paint(on) {
    if (on === running) return;
    running = on;
    if (on) showAt = Date.now();
    for (const dot of dots()) dot.classList.toggle(CLASS, on);
  }

  /**
   * The count moved. Everything about *when* the ring is on screen is decided here, and
   * deliberately not in the stylesheet: a CSS transition can delay an appearance but it
   * cannot cancel one, and cancelling is what SHOW_AFTER_MS is for.
   */
  function heard(n) {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (n > 0) {
      // Already up, or already on its way up with a timer this call just cleared —
      // either way the next thing to schedule is nothing.
      if (running) return;
      timer = setTimeout(() => {
        timer = null;
        paint(true);
      }, SHOW_AFTER_MS);
      return;
    }
    if (!running) return;
    const left = MIN_SHOW_MS - (Date.now() - showAt);
    if (left <= 0) {
      paint(false);
      return;
    }
    timer = setTimeout(() => {
      timer = null;
      // Re-checked rather than assumed: something may have started fetching again in
      // the meantime, and `heard` would have cleared this timer if it had — but the
      // count is the authority and reading it costs nothing.
      if (window.beadcause?.requests?.inFlight?.() > 0) return;
      paint(false);
    }, left);
  }

  function start() {
    const found = dots();
    if (!found.length) return; // /login has no brand row, and nothing to draw one on
    for (const dot of found) build(dot);
    // The optional chain is the same guard every other file in here uses on this
    // namespace: a page served from a cache made before report.js published the count
    // is a page with a dot that never turns, which is exactly how it was yesterday.
    window.beadcause?.requests?.onChange?.(heard);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.orbit = {
    /** Whether the orbit is on screen right now. For the suite, and for a console. */
    running: () => running,
  };
})();
