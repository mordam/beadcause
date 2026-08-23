/*
  The shell's panes — one per view, in one document, shown and hidden by the hash
  (bc-khoe.30.3).

  ## What this replaces

  Tapping a view pill used to load a document. History was `/history`, the advocate
  console was `/monitor`, and each tap threw away the list you were reading, the card you
  had open and where you were in it, to fetch and rebuild a screen that was mostly the
  same screen — the same top bar, the same pill row, the same workspaces re-surveyed. On
  a phone on a slow connection that is a second of white, several times a minute, to move
  between views of one app.

  So Home stops being *the* document and becomes one **pane** of it. Every view is a
  `[data-pane]` element in `public/index.html`, all but one hidden, and moving between
  them is a `display: none` swapped for a `display: flex`. Nothing is fetched, nothing is
  rebuilt, and a pane you leave is still there — with its scroll position — when you come
  back. `public/hashroute.js` says what a hash means; this file is what does something
  about it.

  ## Why `display: none`, and not any of the other ways to hide something

  `visibility: hidden` and an offscreen transform both leave the element **in layout**.
  Every page here is a viewport-height flex column whose last row takes the slack
  (`.pagescroll`, see the shell note at the top of public/style.css), and three panes in
  that column would divide the slack three ways whether or not two of them are painted:
  the visible pane would get a third of the screen and scroll inside it, which is the
  original bug wearing a third mechanism. `display: none` takes the element out of the
  column entirely, so the shown pane is the only flex item and takes the whole of it.

  The cost of that is the thing below.

  ## Scroll position has to be carried by hand

  An element with `display: none` has no layout box, so it has no scrollport, so its
  `scrollTop` is **not preserved**: it reads 0 while hidden and comes back as 0 when
  shown. That is not a browser being unhelpful — there is nothing for the number to be
  measured against — but it is exactly the thing this epic is buying. A pane you switch
  away from and back to has to be where you left it, or the swap has saved a fetch and
  lost the only thing the fetch was costing you.

  So every scroller inside a pane (`.pagescroll`, which is marked in the markup precisely
  because "the thing that scrolls" is a claim the page makes rather than one a class can
  be inferred from) has its `scrollTop` read into `saved` on the way out and written back
  on the way in. By index rather than by id, because a pane may hold more than one and
  none of them is required to have a name.

  Restoring is synchronous, in the same turn as the unhide: assigning `scrollTop` forces
  the layout it needs, and the pane's content is already in the DOM — it was never
  unbuilt, only unpainted — so there is no height still to arrive and no frame to wait
  for.

  ## A pane whose builder has not landed yet

  `index.html` holds a container for **every** view, and two of them are empty:
  `data-pending` names the bead that fills each (bc-khoe.30.5 for History, **bc-khoe.4**
  for Advocates). A pending pane is registered nowhere and can never be shown — `has()`
  says no, `show()` falls to Home — and `public/viewbar.js` reads the same answer, so
  those two pills stay the `<a href>` they have always been and still load `/history` and
  `/monitor` as documents.

  That is the whole of what keeps this bead shippable on its own. The alternative was to
  land the panes empty and have two of the seven pills lead to a blank screen until two
  further beads merge — on an app that deploys itself the moment a branch lands, and that
  Adam reads on a phone. `data-pending` costs one attribute and one `continue` below, and
  each of those beads deletes its own by filling its own container.

  The Advocates value is the one that has moved. It said bc-khoe.30.6, which is the bead
  that *decided* how the advocate console becomes a pane rather than the one that builds
  it; the fold itself is bc-khoe.4, which is behind bc-khoe.10 because bc-khoe.10 removes
  one of the four sections that would otherwise be folded in. The attribute names the bead
  whose merge deletes it, so it has to name the fold and not the ruling. What the ruling
  was — the chip row stays a mode switch inside this one pane, and this is the one pane
  that stands down while it is hidden — is in README.md under "The advocate console is one
  pane, and its chip row stays", and it is the reason this container is one pane rather
  than the three or four the chips look like.

  Those two came off — History with bc-khoe.30.5, Advocates with bc-khoe.4 — and there is
  one pending container again: **Config** (bc-khoe.60), which bc-khoe.50 added. So the
  paragraphs above are the mechanism rather than a snapshot, and this is the shape it is
  for: a view joins the grammar the moment the row needs it to light a pill, and its pane
  arrives afterwards. The one rule that comes with it is in test/pagealias.mjs — while a
  container is pending its addresses must stay documents, because `show()` falling to Home
  is the right answer for a hash and the wrong answer for a home-screen shortcut.

  ## Why a file of its own, and not a few lines in viewbar.js

  `public/viewbar.js` draws the pill row on **twelve** pages and exactly one of them is
  this shell. Pane switching is a fact about the one document that has panes, so it lives
  in a file only that document loads, and the row asks it a question (`has`, `showing`)
  rather than owning the answer. On the other eleven pages `window.beadcause.panes` is
  simply absent, which is why the row reaches for it with `?.` where it reaches for
  `route` flat: a missing router is a bug, a missing set of panes is Tuesday.

  ## What is deliberately not here

  **No building and no fetching.** Every pane in this document is markup that was parsed
  with the page. Building each one's contents — the landed-on one first, the rest after
  first paint — is bc-khoe.30.4, and it will hang off `onShow` and the `[data-pane]`
  elements this file already knows about. Nothing here polls, nothing here renders, and a
  hidden pane is left running exactly as it was: hidden is not paused.

  **No path routing.** Landing on `/history` or `/work.html` and having it resolve to a
  pane of `/` is bc-khoe.30.7. Until then those addresses are still their own documents,
  which is also why the two panes above are pending.

  **A pill tap is always a step (bc-khoe.30.9).** `route.go` clears Home's hash with
  `pushState` rather than by assignment, for the same reason every other pill tap writes
  a new history entry: assigning `location.hash` pushes on its own, so leaving *only* the
  clear-to-Home case on `replaceState` would have been the one transition in this row that
  the back button could not walk. `go`'s `dismiss` argument is what a card closing back to
  Home would pass instead — nothing here does yet, since a card in this shell is not
  bc-khoe.30.9's to build.
*/
(() => {
  const route = window.beadcause.route;

  /** Every view id the grammar knows, so a stray `data-pane` cannot invent one. */
  const known = new Set(route.VIEWS.map((v) => v.id));

  /**
   * The panes this document can actually show, in the order they appear in the markup.
   *
   * Read off the DOM rather than from a table here, because the document is what decides:
   * `index.html` holds three and the beads that fill the empty two are the ones that get
   * to say when they are showable. A `data-pane` naming something that is not a view is
   * skipped rather than trusted — the hash grammar is a closed list and a pane outside it
   * would be a pane no hash could ever name.
   */
  const panes = new Map();
  /** Containers that exist but cannot be shown yet, by view id — see `data-pending`. */
  const pending = new Map();
  for (const el of document.querySelectorAll('[data-pane]')) {
    const id = el.dataset.pane;
    if (!known.has(id)) continue;
    if (el.dataset.pending) pending.set(id, el.dataset.pending);
    else panes.set(id, el);
  }

  /** Which pane is up. `null` until the first `sync`, and on a document with no panes. */
  let current = null;

  /** `scrollTop` of each scroller of each pane, from the last time it was hidden. */
  const saved = new Map();

  /** Everything inside a pane that scrolls — plus the pane itself, if it is the scroller. */
  const scrollers = (el) => [
    ...(el.classList?.contains('pagescroll') ? [el] : []),
    ...el.querySelectorAll('.pagescroll'),
  ];

  const listeners = [];

  /**
   * Show one pane and hide the rest, carrying the scroll positions across.
   *
   * An id with no pane here falls to Home, which is the same answer `parse` gives a hash
   * it does not recognise and for the same reason: there is always a view, and a blank
   * screen is never the right way to say "not that one". Returns the id actually shown,
   * or `null` on a document that has no panes at all.
   */
  function show(view) {
    const id = panes.has(view) ? view : route.HOME;
    if (!panes.has(id)) return null;
    if (current === id) return id;
    const leaving = current && panes.get(current);
    if (leaving) saved.set(current, scrollers(leaving).map((s) => s.scrollTop));
    for (const [key, el] of panes) el.hidden = key !== id;
    current = id;
    const back = saved.get(id);
    if (back) {
      scrollers(panes.get(id)).forEach((s, i) => {
        if (back[i] != null) s.scrollTop = back[i];
      });
    }
    for (const fn of listeners) fn(id);
    return id;
  }

  /** Show whatever the hash currently names. The one way a pane is ever chosen. */
  const sync = () => show(route.parse(location.hash).view);

  /*
    The hash is the only input. A pill tap goes through `go` below, the back button and a
    deep link arrive as `hashchange`, and both end here — so "which pane is up" is a pure
    function of the URL and there is no second state to fall out of step with it.
  */
  sync();
  addEventListener('hashchange', sync);

  window.beadcause = window.beadcause || {};
  window.beadcause.panes = {
    /**
     * Move to a view: write the hash, then show what the hash now says.
     *
     * Both halves, rather than trusting `hashchange` to arrive: Home's hash is the empty
     * string and `route.go` clears it with `pushState`, which does **not** fire
     * `hashchange` — so a row that only wrote the URL would leave the Home pill dead from
     * every other pane. `sync` is idempotent, so the redundant call on every other
     * transition costs a map lookup and an early return.
     */
    go(view) {
      const hash = route.hashFor(view);
      if (hash == null) return null;
      route.go(hash);
      return sync();
    },
    /** Can this document show that view without a document load? */
    has: (view) => panes.has(view),
    /** Which pane is up, or `null` before the first sync. */
    showing: () => current,
    /** Every view this document can show, in markup order. */
    ids: () => [...panes.keys()],
    /** The containers that are here but not yet fillable, as `{ view: bead }`. */
    pending: () => Object.fromEntries(pending),
    /** Called with the view id every time the shown pane changes. */
    onShow(fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
  };
})();
