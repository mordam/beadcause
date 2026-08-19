/*
  An answer becoming beads, and the beads going into the tracker.

  Answering used to end in a dead pause: the card dimmed to 50%, a "Recording your
  answer…" row appeared, and then nothing happened for as long as `bd` took to get
  the Dolt lock — one second, sometimes three — after which render() rebuilt the
  list and the card was simply gone. Dim, hang, jump cut. Nothing said where the
  thing you had just decided went, and on a slow write it read as a freeze rather
  than as work.

  What replaces it is a short sequence that says what actually happened: the answer
  became a bead, and the beads went into the tracker.

    collapse  the card shrinks and rounds down in place, from card to a single
              bead-sized circle, floating in front of a list that has already
              reflowed underneath it
    ignite    at bead size it pulses once, white → its colour, and holds
    travel    it arcs across the screen toward the app mark in the header
    attract   just short of the mark the motion goes magnetic: it stops coasting
              and starts being pulled
    thread    a line grows out of the mark to meet it — contact is capture
    absorb    it is drawn down the thread into the mark and swallowed, and the
              thread retracts with it

  Three things about this file are load-bearing:

  **It plays over the wait, not after it.** The caller starts a flight on the tap
  and only then issues the write. Everything up to `attract` runs while the request
  is out; the beads then hold in the magnetic zone, being pulled, for however long
  bd takes. Latency lands in the one part of the sequence that already looks like
  something is happening to them. A flight that began when the response landed
  would only have moved the pause.

  **It can be taken back.** The write can fail, and a tracker that rejected your
  answer must not be shown swallowing it. So the last step is gated: the caller
  calls `absorb()` on success or `recall()` on failure, from either side of the
  hold, and `recall()` flies the beads back the way they came so the card can
  re-open under them.

  **It does not live in the list.** Every element here is appended to a fixed
  overlay on <body>, because render() is about to destroy the card the flight
  started from — and, for the answered path, has already destroyed it by the time
  the bead exists.
*/
(() => {
  'use strict';

  /*
    Where a bead flies to. First match on the page wins, so the target can be
    swapped — the mark grew into that slot only recently, and before it there was a
    wordmark and a pulse dot — without any of the geometry below being redone.
  */
  const TARGETS = ['.brand h1.mark img', '.brand h1.mark', '.brand .dot', '.brand'];

  /* Milliseconds. The five that run before the gate sum to about 1.5s, which is
     roughly a slow bd write — so a fast answer barely holds, and a slow one holds
     in the magnetic zone rather than anywhere that looks stalled. */
  const D = {
    collapse: 280,
    ignite: 360,
    igniteFast: 165,
    travel: 620,
    stagger: 90,
    attract: 240,
    thread: 170,
    swallow: 260,
    home: 460,
    thump: 380,
  };

  const BEAD = 18; // what a card collapses to
  const MADE = 13; // a bead your decision made, rather than the one you answered
  /* How far off the mark's centre a bead coasts to, and how far the pull then takes
     it. The mark is 26px across, so both have to clear 13px or the bead lands on top
     of the thing it is about to be eaten by — and the thread, which is the whole
     picture of being caught, has nothing left to span. */
  const STANDOFF = 52;
  const NEAR = 30;
  /* Radians between one incoming bead and the next. They all set off from the same
     point and all end at the same mark, so without a fan they arrive stacked and four
     beads look like one. */
  const SPREAD = 0.34;
  /* And the same problem one level up. `slot` fans beads by their index *within* one
     flight, so two flights in the air at once — which is the ordinary case now that
     submits queue rather than blocking the next tap — put their leads on the identical
     standoff point, and three answers waiting to be swallowed read as one. So each
     live flight takes a lane: a further half-fan around the mark and a further ring
     out from it, held for as long as the flight is. Four is what a phone can hold
     before the outermost ring is off the top of the screen; a fifth simultaneous
     flight shares the last lane rather than flying somewhere silly. */
  const LANES = 4;
  const LANE_SPREAD = SPREAD * 1.6;
  const LANE_GAP = 21;
  const lanes = new Set();
  const takeLane = () => {
    for (let i = 0; i < LANES; i++) {
      if (lanes.has(i)) continue;
      lanes.add(i);
      return { lane: i, free: () => lanes.delete(i) };
    }
    // Overflow: share the outermost lane and never free it, because the flight that
    // really owns it is still in the air on it.
    return { lane: LANES - 1, free: () => {} };
  };

  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  /**
   * The palette, resolved to literal colours before anything animates.
   *
   * `element.animate()` keyframes are parsed as property values, so `var(--x)` in
   * one is at the mercy of whether the engine substitutes custom properties there.
   * Reading them off :root once per flight sidesteps the question entirely, and
   * costs one style read for a sequence that is about to run for a second and a
   * half. Both schemes come out of the same call, because the tokens are what the
   * media query swaps.
   */
  function palette() {
    const cs = getComputedStyle(document.documentElement);
    const pick = (name, fallback) => (cs.getPropertyValue(name) || '').trim() || fallback;
    return {
      answered: pick('--bead-answered', '#60a5fa'),
      made: pick('--bead-made', '#4ade80'),
      comment: pick('--accent', '#5eead4'),
      // What "white-hot" is. A token rather than a literal because the light scheme
      // draws this on a near-white page, and the glow around it is doing most of
      // the work there — if it ever stops being enough, this is the knob.
      flash: pick('--bead-flash', '#ffffff'),
    };
  }

  /* ------------------------------------------------------------------ layer */

  let layer = null;
  function flightLayer() {
    if (!layer || !layer.isConnected) {
      layer = document.createElement('div');
      layer.className = 'flight-layer';
      // Nothing in here is content and nothing in here is tappable: it is a picture
      // of a state change that the toast and the list already state in words.
      layer.setAttribute('aria-hidden', 'true');
      document.body.appendChild(layer);
    }
    return layer;
  }

  /* ------------------------------------------------------------------ maths */

  const centre = (r) => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

  function rectOf(thing) {
    const it = typeof thing === 'function' ? thing() : thing;
    if (!it) return null;
    if (typeof it.getBoundingClientRect === 'function') {
      const r = it.getBoundingClientRect();
      return r.width || r.height ? r : null;
    }
    return it.width || it.height ? it : null;
  }

  const markRect = () => {
    for (const sel of TARGETS) {
      const r = rectOf(document.querySelector(sel));
      if (r) return r;
    }
    return null;
  };

  /**
   * A quadratic arc from `a` to `b`, as transform keyframes relative to `a`.
   *
   * An arc rather than a straight shove, and sampled into keyframes rather than
   * drawn with `offset-path`, because the sampling works everywhere this app runs
   * and lets each bead take a visibly different route: `lift` is what separates one
   * approved bead's path from the next one's, so N of them read as N things rather
   * than as one thick line.
   */
  function arc(a, b, lift, steps = 24) {
    const cx = a.x + (b.x - a.x) * 0.35;
    const cy = Math.min(a.y, b.y) - lift;
    const frames = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps;
      const u = 1 - t;
      const x = u * u * a.x + 2 * u * t * cx + t * t * b.x;
      const y = u * u * a.y + 2 * u * t * cy + t * t * b.y;
      frames.push({ transform: `translate(${x - a.x}px, ${y - a.y}px)` });
    }
    return frames;
  }

  /**
   * Where one of `count` beads waits, `gap` out from the mark.
   *
   * Fanned around the direction it came in on, one slot per bead, so N beads hold as
   * an arc facing the mark rather than as a pile — and so each gets a thread of its
   * own to be caught by, which is what makes the capture legible at all.
   *
   * `lane` fans a whole *flight* the same way against the other flights in the air —
   * see LANES. Zero for the only flight there is, which is what it was before.
   */
  function slot(from, mark, gap, index, count, lane = 0) {
    const home = Math.atan2(from.y - mark.y, from.x - mark.x);
    const a = home + (index - (count - 1) / 2) * SPREAD + lane * LANE_SPREAD;
    const out = gap + lane * LANE_GAP;
    return { x: mark.x + Math.cos(a) * out, y: mark.y + Math.sin(a) * out };
  }

  /* -------------------------------------------------------------- animating */

  /**
   * Run one animation and bake its end state into the element.
   *
   * `fill: forwards` alone would stack: five filled animations on one element and
   * the sixth starts from wherever the pile of them left it, which is not where the
   * fifth's keyframes said. Committing and cancelling each one means every step
   * below starts from a position that is really in the style attribute.
   */
  async function step(el, frames, opts) {
    let anim;
    try {
      anim = el.animate(frames, { fill: 'forwards', easing: 'linear', ...opts });
    } catch {
      return; // no WAAPI: the caller's state machine still runs, just instantly
    }
    try {
      await anim.finished;
    } catch {
      return; // cancelled — the element is being torn down
    }
    try {
      anim.commitStyles();
      anim.cancel();
    } catch {
      /* An engine without commitStyles keeps the fill, which is the same picture. */
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  /* ---------------------------------------------------------------- a bead */

  /**
   * One bead's whole life, from the card it came out of to the mark that ate it.
   *
   * `gate` is the promise the caller resolves with the verdict. It is awaited after
   * the bead has arrived and is being pulled, so the write's latency is spent in the
   * hold and nowhere else.
   */
  async function flyOne({ index, count, lead, from, target, tone, gate, thump, ink, lane = 0 }) {
    const stage = flightLayer();
    const start = centre(from);
    const size = lead ? BEAD : MADE;

    const el = document.createElement('div');
    el.className = lead ? 'fbead lead' : 'fbead made';

    if (lead) {
      // The collapse proper: the card's own rectangle, shrinking and rounding down
      // to the bead at its centre. The card behind it has already gone, which is why
      // this has to carry the card's surface rather than being a dot that appears
      // over the top of one.
      el.classList.add('fghost');
      el.style.left = `${from.left}px`;
      el.style.top = `${from.top}px`;
      el.style.width = `${from.width}px`;
      el.style.height = `${from.height}px`;
      stage.appendChild(el);
      await step(
        el,
        [
          { left: `${from.left}px`, top: `${from.top}px`, width: `${from.width}px`, height: `${from.height}px`, borderRadius: '14px' },
          { left: `${start.x - size / 2}px`, top: `${start.y - size / 2}px`, width: `${size}px`, height: `${size}px`, borderRadius: '50%' },
        ],
        { duration: D.collapse, easing: 'cubic-bezier(0.32, 0, 0.24, 1)' }
      );
      el.classList.remove('fghost');
    } else {
      // A bead your decision made. It was never a card, so it has nothing to collapse
      // from — it is thrown clear of the same point, a beat behind the one you
      // answered, so the order reads as cause and effect.
      el.style.left = `${start.x - size / 2}px`;
      el.style.top = `${start.y - size / 2}px`;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      // Invisible until its beat comes round: it is on the overlay from the first
      // frame — that is what makes the count assertable the moment the card goes —
      // but a stack of white dots waiting under the collapse would give the game away.
      el.style.opacity = '0';
      stage.appendChild(el);
      await sleep(D.collapse + index * D.stagger);
      await step(
        el,
        [
          { transform: 'scale(0.1)', opacity: 0.2 },
          { transform: 'scale(1)', opacity: 1 },
        ],
        { duration: 160, easing: 'cubic-bezier(0.2, 1.4, 0.4, 1)' }
      );
    }

    // Ignite. White, then its colour, held. The bead you answered pulses once and
    // slowly; the beads it created pulse faster and green, because the thing you
    // decided and the things your decision made must not look identical.
    const lit = tone === 'made' ? ink.made : tone === 'comment' ? ink.comment : ink.answered;
    const flare = lit;
    await step(
      el,
      [
        { background: ink.flash, boxShadow: `0 0 0 0 ${flare}`, transform: 'scale(1)' },
        { background: ink.flash, boxShadow: `0 0 14px 5px color-mix(in srgb, ${flare} 55%, transparent)`, transform: 'scale(1.42)', offset: 0.42 },
        { background: lit, boxShadow: `0 0 9px 1px color-mix(in srgb, ${lit} 45%, transparent)`, transform: 'scale(1)' },
      ],
      {
        duration: tone === 'made' ? D.igniteFast : D.ignite,
        // Two fast pulses for a bead that was created, one slow one for the answer.
        iterations: tone === 'made' ? 2 : 1,
        easing: 'ease-in-out',
      }
    );

    // Travel. Resolved now rather than at launch: for the answered path the list has
    // repainted since the tap, and for a comment the row this returns to did not
    // exist when the tap happened.
    const to = rectOf(target);
    if (!to) {
      el.remove();
      await gate;
      return;
    }
    const mark = centre(to);
    const hold = slot(start, mark, STANDOFF, index, count, lane);
    // Each bead leans on its own arc. Derived from the index rather than from
    // Math.random so a screenshot test sees the same picture twice.
    const lift = 70 + ((index * 37) % 90);
    await step(el, arc(start, hold, lift), {
      duration: D.travel + index * 40,
      easing: 'cubic-bezier(0.36, 0.02, 0.22, 1)',
    });

    // Attract. The coast ends and the pull starts — a short tug in, then a hold that
    // trembles toward the mark for as long as the write takes.
    const near = slot(start, mark, NEAR, index, count, lane);
    await step(
      el,
      [
        { transform: `translate(${hold.x - start.x}px, ${hold.y - start.y}px)` },
        { transform: `translate(${near.x - start.x}px, ${near.y - start.y}px) scale(0.92)` },
      ],
      { duration: D.attract, easing: 'cubic-bezier(0.5, -0.4, 0.3, 1)' }
    );

    let tug;
    try {
      tug = el.animate(
        [
          { transform: `translate(${near.x - start.x}px, ${near.y - start.y}px) scale(0.92)` },
          { transform: `translate(${near.x - start.x - (near.x - mark.x) * 0.28}px, ${
              near.y - start.y - (near.y - mark.y) * 0.28
            }px) scale(1.04)` },
        ],
        { duration: 420, direction: 'alternate', iterations: Infinity, easing: 'ease-in-out' }
      );
    } catch {
      /* no WAAPI — it just sits there */
    }

    const verdict = await gate;
    tug?.cancel();
    // The tug left the element wherever the loop happened to be; put it back on the
    // standoff point it is really at, so the finishers measure from a known place.
    el.style.transform = `translate(${near.x - start.x}px, ${near.y - start.y}px) scale(0.92)`;

    if (verdict === 'absorb') {
      // Thread. A line out of the mark that grows until it touches the bead —
      // contact is the moment of capture, so the swallow cannot start before it.
      const dx = near.x - mark.x;
      const dy = near.y - mark.y;
      const dist = Math.hypot(dx, dy);
      const line = document.createElement('div');
      line.className = 'fthread';
      line.style.left = `${mark.x}px`;
      line.style.top = `${mark.y}px`;
      line.style.transform = `rotate(${Math.atan2(dy, dx)}rad)`;
      line.style.width = '0px';
      // Each thread is the colour of what it is reaching for, so four of them fanning
      // out of the mark still say which one is the answer and which are its beads.
      line.style.background = `linear-gradient(90deg, ${lit}, color-mix(in srgb, ${lit} 20%, transparent))`;
      stage.appendChild(line);
      await step(line, [{ width: '0px' }, { width: `${dist}px` }], {
        duration: D.thread,
        easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)',
      });

      // Absorb. Straight down the thread — no arc, it is not travelling any more,
      // it is being taken — and the thread retracts with it rather than after it.
      thump?.();
      await Promise.all([
        step(
          el,
          [
            { transform: `translate(${near.x - start.x}px, ${near.y - start.y}px) scale(0.92)`, opacity: 1 },
            { transform: `translate(${mark.x - start.x}px, ${mark.y - start.y}px) scale(0.15)`, opacity: 0 },
          ],
          { duration: D.swallow, easing: 'cubic-bezier(0.6, 0, 0.9, 0.5)' }
        ),
        step(line, [{ width: `${dist}px` }, { width: '0px' }], {
          duration: D.swallow,
          easing: 'cubic-bezier(0.6, 0, 0.9, 0.5)',
        }),
      ]);
      line.remove();
    } else if (verdict === 'land') {
      // Not absorbed, because the bead is not closed. It settles onto the row it
      // came back to and fades there — the same collapse, ending in the list rather
      // than in the mark.
      await step(
        el,
        [
          { transform: `translate(${near.x - start.x}px, ${near.y - start.y}px) scale(0.92)`, opacity: 1 },
          { transform: `translate(${mark.x - start.x}px, ${mark.y - start.y}px) scale(0.6)`, opacity: 0 },
        ],
        { duration: 260, easing: 'cubic-bezier(0.3, 0, 0.2, 1)' }
      );
    } else {
      // Recalled. Back the way it came, so the card can re-open under it: the tracker
      // refused this, and a bead that flew off screen anyway would be a lie about
      // where your answer went.
      // The scale is carried along the way back rather than dropped at the first
      // keyframe: the bead is sitting at 0.92 from the attract, and snapping it to 1
      // before it has moved reads as a flinch.
      const back = arc(start, near, lift).reverse();
      await step(
        el,
        back.map((f, i) => ({ transform: `${f.transform} scale(${0.92 + 0.08 * (i / (back.length - 1))})` })),
        { duration: D.home, easing: 'cubic-bezier(0.4, 0, 0.3, 1)' }
      );
      await step(el, [{ opacity: 1, transform: 'scale(1)' }, { opacity: 0, transform: 'scale(2.2)' }], {
        duration: 180,
        easing: 'ease-out',
      });
    }
    el.remove();
  }

  /* ---------------------------------------------------------------- launch */

  /**
   * Start a flight. Called on the tap, before the write.
   *
   *   from    the card the answer was in — an element or a rect
   *   made    how many beads the answer created (they fly green, and faster)
   *   tone    'answer' | 'comment' — what the one bead for the card itself is
   *   target  where they fly; a function, resolved at travel time, because for a
   *           comment the row it returns to has not been rendered yet. Defaults to
   *           the header mark.
   *
   * Returns the three ways it can end. All are idempotent and all can be called
   * before the beads have arrived — the verdict is a gate, not an interruption —
   * and each resolves when every bead has finished.
   */
  function launch({ from, made = 0, tone = 'answer', target = null } = {}) {
    const rect = rectOf(from);
    let settle;
    const gate = new Promise((r) => (settle = r));

    // prefers-reduced-motion goes straight to the end state, per the convention the
    // rest of the app follows: no layer, no elements, nothing moves. The caller's
    // sequence is unchanged, which is the point — the state machine is the same one.
    const skip = reduced() || !rect;
    const finish = (verdict) => {
      settle(verdict);
      return done;
    };

    const mark = () => document.querySelector(TARGETS.find((s) => document.querySelector(s)) || '.brand');
    const thump = () => {
      const el = mark();
      if (!el || reduced()) return;
      el.classList.remove('absorbing');
      // Reading offsetWidth is what lets the same class fire twice in a row when two
      // beads land a few hundred milliseconds apart.
      void el.offsetWidth;
      el.classList.add('absorbing');
      setTimeout(() => el.classList.remove('absorbing'), D.thump);
    };

    const ink = skip ? null : palette();
    // Taken before anything is put in the air and given back when the last bead has
    // finished, so a flight only ever shares a standoff point with a flight that has
    // already been swallowed. Not taken at all when nothing is going to move: a lane
    // held by a reduced-motion flight would push the next real one out for nothing.
    const held = skip ? { lane: 0, free: () => {} } : takeLane();
    const done = skip
      ? gate.then(() => {})
      : Promise.all(
          Array.from({ length: 1 + made }, (_, i) =>
            flyOne({
              index: i,
              count: 1 + made,
              lead: i === 0,
              from: rect,
              target: target || markRect,
              tone: i === 0 ? tone : 'made',
              gate,
              thump,
              ink,
              lane: held.lane,
            }).catch(() => {})
          )
        ).then(() => {
          held.free();
        });

    return {
      /** True when nothing will move, so a caller can skip its own flourishes too. */
      reduced: skip,
      /** The write landed and the bead is closed: thread, swallow, gone. */
      absorb: () => finish('absorb'),
      /** The write landed but the bead is still open: it settles back into the list. */
      land: () => finish('land'),
      /** The write failed: back the way they came, so the card can re-open. */
      recall: () => finish('recall'),
    };
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.absorb = { launch };
})();
