/* The chip row on the one page that has one, and the last of the app's second bars.
 *
 * The pill row across the top of every page moves between *pages*; this row swaps a
 * *pane* on monitor.html, and the two are drawn alike because they are both rows of
 * things you tap. What separates them is that everything here is a **mode** of the page
 * you already watch work from: the same space's repos and sessions, seen another way.
 *
 * **This file is on its way out and the bead that ends it is bc-khoe.4**, which folds
 * Advocates and Mirror into the pill row and re-points the standing-down below at the
 * page's own lifecycle. bc-khoe.1 deleted the bottom bar and this file's `--topbar-h`
 * observer and stopped there, deliberately: a chip row that still works is a smaller
 * thing to hand over than half a fold-in.
 *
 * There are three of them now, which is why this file exists at all.
 *
 *   - **Advocates** is the page itself: what is running this minute.
 *   - **PRs** is the shipping screen (bc-d4d5). It was `/prs` with a fifth of the bottom
 *     bar, then `/prs` with nothing pointing at it — reachable only from the link on an
 *     inbox card, which meant that on a day with no PR card in the inbox there was no
 *     route to the **Ship** button at all. It is a mode of this page by the same
 *     argument the Mirror is: you glance at it, act on one row and leave.
 *   - **Mirror** is the phone's screen on a screen with room for it (bc-3xb).
 *
 * The swap was two lines in mirror.js while there were two panes, and a two-way boolean
 * cannot be made three-way by adding a chip: the pane that is going *away* has to be
 * told as well as the one arriving, and with three panes "the other one" is no longer a
 * name for anything. So the row is owned here, the panes subscribe, and mirror.js and
 * prs.js each answer only for themselves.
 *
 * **The pane that is hidden is not merely invisible — it is stood down.** Each of these
 * holds a parked `/api/poll` and, in the board's case, a `gh` sweep per repo behind
 * every wake; a page with three of them running at once would ask three times over for
 * two panes nobody is looking at. Every subscriber gets told which chip is up on every
 * change *and once at boot*, so "start when I am shown, stop when I am not" is the same
 * piece of code as "start at boot" and there is no first-paint special case to forget.
 *
 * The mapping lives in the HTML — `data-pane` is the section a chip shows and
 * `data-view` is what public/presence.js should say this device is looking at — because
 * a chip and its pane are one thing and splitting them across two files is how the
 * third one gets added to only one of them. `data-view` is empty on the Mirror
 * deliberately: you are looking at *another* device there, so this one is nowhere, and
 * a mirror that could follow itself is the absurdity presence.js's own header warns
 * about.
 */
(() => {
  'use strict';

  const tabsEl = document.getElementById('mon-tabs');
  if (!tabsEl) return;

  /*
   * There used to be a `ResizeObserver` here, and what it was for is worth knowing
   * before somebody puts it back (bc-ugd4, deleted in bc-khoe.1).
   *
   * The strip was `position: sticky` at `top: var(--topbar-h)`, and this file published
   * that variable by measuring `.topbar`. It could not be a constant in the stylesheet:
   * the bar is 104px with the space picker's row and 61px without, and the picker hides
   * itself whenever the daemon is watching fewer than two workspaces — so on the same
   * build, the same page, the height is a fact about the *payload*. It also carries
   * `env(safe-area-inset-top)`, which is zero in a browser and not zero in the installed
   * app on a notched phone, and the bar is `flex-wrap: wrap`, so a narrow enough screen
   * can rewrap it at any moment. An observer answered all four without knowing about any
   * of them.
   *
   * None of that is true any more, because there is nothing to stick to. Every page is an
   * app shell now (bc-khoe.1): `body` is one viewport tall and clipped, the top bar and
   * the pill row are rows of a flex column, and this strip is the row under them. The
   * viewport does not scroll, so nothing can scroll it away and no offset has to be
   * measured. If a future change makes some strip sticky under moving chrome again, this
   * is the block that comes back — but a variable nothing reads is worse than no
   * variable, because it reads as load-bearing.
   */

  /** Which chip was up last time. */
  const KEY = 'beadcause.mon.tab';
  /* What that was called while mirror.js owned the row and there were two of them. Read
     once, never written: a phone that left the Mirror up yesterday should come back to
     it, and the alternative is every such device silently landing on Advocates once. */
  const LEGACY = 'beadcause.mirror.tab';

  /* The paths that *are* the board. Arriving on one of them selects the PRs chip
     whatever was up last time — they are on the phone's home screen and in the
     notifications the ship path sends, and a notification that opened the advocates
     roster instead would be the link quietly not working. The server maps all three
     onto monitor.html; see serveStatic in lib/server.js and viewbar.js's `paths`. */
  const PR_PATHS = ['/prs', '/pulls', '/prs.html'];

  const chips = [...tabsEl.querySelectorAll('[data-tab]')];
  const paneOf = new Map(chips.map((c) => [c.dataset.tab, document.getElementById(c.dataset.pane)]));
  const viewOf = new Map(chips.map((c) => [c.dataset.tab, c.dataset.view || null]));
  const subs = [];
  let active = null;

  const known = (which) => paneOf.has(which);

  function stored() {
    try {
      return localStorage.getItem(KEY) || localStorage.getItem(LEGACY) || '';
    } catch {
      return '';
    }
  }

  function initial() {
    const here = location.pathname.replace(/\/+$/, '') || '/';
    if (PR_PATHS.includes(here)) return 'prs';
    const last = stored();
    return known(last) ? last : chips[0]?.dataset.tab || '';
  }

  /**
   * Put a chip up, and tell everything that cares.
   *
   * The subscribers are called in a `try` each, and a thrower is re-raised on its own
   * turn of the loop rather than here: three panes share this call, and one of them
   * failing must not leave the other two believing they are still on screen — which
   * with a parked poll each is not a cosmetic difference. Re-raising asynchronously is
   * what keeps public/report.js's `error` handler seeing it, so the failure is still a
   * P0 bead rather than something swallowed.
   */
  function show(which) {
    if (!known(which)) which = chips[0]?.dataset.tab || '';
    if (!known(which) || which === active) return;
    const prev = active;
    active = which;
    try {
      localStorage.setItem(KEY, which);
    } catch {
      /* Private mode, or a quota. The chip still moves. */
    }
    for (const c of chips) {
      const on = c.dataset.tab === which;
      c.setAttribute('aria-pressed', String(on));
      const pane = paneOf.get(c.dataset.tab);
      if (pane) pane.hidden = !on;
    }
    window.beadcause?.presence?.report({ view: viewOf.get(which) || null });
    for (const fn of subs) {
      try {
        fn(which, prev);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  });

  window.beadcause = window.beadcause || {};
  window.beadcause.monTabs = {
    show,
    /** Which chip is up, or null before the first paint. */
    active: () => active,
    /**
     * Be told which chip is up, now and whenever it changes.
     *
     * `fn(which, prev)` — `prev` is null on the boot call, which is the handle a pane
     * needs to tell "I am being shown for the first time" from "I am being come back
     * to". Registering after the first paint calls back immediately, so load order
     * between this file and its panes is not a thing anybody has to hold in their head.
     */
    onChange(fn) {
      if (typeof fn !== 'function') return;
      subs.push(fn);
      if (active) fn(active, null);
    },
  };

  /* After the page's own scripts have run, so every pane has registered before the
     first call. They are all plain `<script>`s at the foot of monitor.html, so this
     fires once, after the last of them. */
  document.addEventListener('DOMContentLoaded', () => show(initial()));
})();
