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

  Those two came off — History with bc-khoe.30.5, Advocates with bc-khoe.4 — and a third
  arrived and came off in its turn: **Config**, which bc-khoe.50 added as `data-pending`
  and bc-khoe.60 filled. Every view the grammar knows has a live pane now, so the two
  paragraphs above describe the mechanism rather than a current snapshot, and this is the
  shape it is for: a view joins the grammar the moment the row needs it to light a pill,
  and its pane can arrive afterwards without the pill leading anywhere blank in between.
  The one rule that comes with it is in test/pagealias.mjs — while a container is pending
  its addresses must stay documents, because `show()` falling to Home is the right answer
  for a hash and the wrong answer for a home-screen shortcut.

  ## The second half of the address (bc-k7lrc)

  A hash names a view and may narrow it — `#history?status=closed`, decision 5 in
  public/hashroute.js. `show` below is about the first half only, and it *returns early*
  when the view has not changed, which is right: moving from `?b=one` to `?b=two` hides
  nothing and moves no scroll position. It also meant that the one change to the URL a
  view could never be told about was a change to its own address. The back button walked
  between two briefs and the pane went on drawing the first one.

  So `sync` reads both halves and `onQuery` reports the second. Two of the five views
  already kept state there and each had grown its own copy of the write — an `address`
  object in public/history.js and another in public/montabs.js, the same fifteen lines
  twice, including the same "only while this pane is showing" refusal. `setQuery` is those
  lines once, which is what lets the third kind of caller have them: a **repo view**, whose
  script is in somebody else's checkout and cannot be expected to rediscover the refusal.
  That is the whole of what makes a repo view deep-linkable — see `ctx.setQuery` in
  public/viewhost.js, and `#deluvia.briefs?b=<slug>`.

  The two existing `address` objects are deliberately left alone. They work, they are
  covered, and folding them in is a change to the ledger's filters and the console's chips
  for no behaviour — worth doing on the day one of them needs touching anyway, not on the
  day the mechanism they inspired arrives. The one consequence, written down so it is not
  rediscovered as a bug: those two call `replaceState` themselves, so `currentQuery` goes
  stale behind them and the *next* move of their view's query is reported when it might
  not have been. Harmless, because neither of them takes `onQuery` — the ledger reads its
  filters once as its pane is built — and it stops being true for whichever of them is
  folded in first.

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

  /**
   * Every view id the grammar knows, so a stray `data-pane` cannot invent one.
   *
   * Asked per call rather than snapshotted into a `Set` at load, because the grammar is no
   * longer fixed by the time this file has finished running: a repo's own views are
   * admitted by `route.add` after `/api/views` answers, which is several hundred
   * milliseconds later (public/viewhost.js). A snapshot taken here would say no to every
   * one of them, and the pane they had just built would be a pane nothing could show.
   */
  const known = (id) => route.VIEWS.some((v) => v.id === id);

  /**
   * The panes this document can actually show, in the order they appear in the markup.
   *
   * Read off the DOM rather than from a table here, because the document is what decides:
   * `index.html` holds three and the beads that fill the empty two are the ones that get
   * to say when they are showable. A `data-pane` naming something that is not a view is
   * skipped rather than trusted — the hash grammar is a closed list and a pane outside it
   * would be a pane no hash could ever name.
   *
   * Scoped to `.pane`, not bare `[data-pane]` (bc-khoe.30.11): `data-pane` is also
   * viewbar.js's word for a pill — a view pill's value is name-for-name the view id it
   * switches to, which is exactly what this map is keyed by — and the advocate console's
   * chip row reuses the same attribute again for the section a chip shows. Neither pill
   * nor chip carries `.pane`. Today the only element this loop ever sees is scoped by
   * script order (this file runs before viewbar.js draws the row), so the collision has
   * never fired; the class scope is what keeps that true for a re-scan, a pane added at
   * runtime, or any other caller that does not get to lean on load order.
   */
  const panes = new Map();
  /** Containers that exist but cannot be shown yet, by view id — see `data-pending`. */
  const pending = new Map();
  for (const el of document.querySelectorAll('.pane')) {
    const id = el.dataset.pane;
    if (!id || !known(id)) continue;
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
   * The query hung on the pane that is up — the `b=one` of `#deluvia.briefs?b=one`.
   *
   * Held here rather than read where it is wanted, because it is the thing `sync` has to
   * *compare*. A hash moving from `?b=one` to `?b=two` names the same view, so `show`
   * returns early on it and always has — rightly, since nothing is hidden and no scroll
   * position moves. That early return is also why, until this, the one URL change a view
   * could never be told about was a change to its own address: the back button walked
   * between two briefs and the pane went on drawing the first one.
   */
  let currentQuery = '';

  /** Called with `(view, query)` when the query of the pane that is up changes. */
  const queryListeners = [];

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

  /**
   * Show whatever the hash currently names, and tell the pane if its query moved.
   *
   * Two answers out of one read, because they come from one hash and taking it twice is
   * how they get to disagree. `show` is unchanged and still decides everything about which
   * container is painted; what is added is the second half of the address — a view's own
   * query — which nothing was watching.
   *
   * `route.queryFor` is asked about the pane that was **actually shown**, not the one the
   * hash named. They differ exactly when a hash names a view this document cannot show —
   * a repo view whose pane has not been adopted yet, a pending container — and `show`
   * answers those with Home. A query hung on a name that lost is not Home's, so it is
   * dropped with the view it belonged to rather than handed to whoever is up.
   */
  function sync() {
    const shown = show(route.parse(location.hash).view);
    const q = shown ? route.queryFor(shown, location.hash) : '';
    if (q !== currentQuery) {
      currentQuery = q;
      for (const fn of queryListeners) fn(shown, q);
    }
    return shown;
  }

  /*
    The hash is the only input. A pill tap goes through `go` below, the back button and a
    deep link arrive as `hashchange`, and both end here — so "which pane is up" is a pure
    function of the URL and there is no second state to fall out of step with it.
  */
  sync();
  addEventListener('hashchange', sync);

  /**
   * Register a container that was not in the markup — a repo's own view.
   *
   * Every pane above was parsed with the document, which is right for the five views this
   * app *is*: they are known before the page exists, so their containers can be. A repo
   * view is not known until `/api/views` answers, so its container is built at that point
   * and handed here (public/viewhost.js).
   *
   * What it must not do is disturb what is already up. A pane adopted while you are
   * reading Home has to arrive hidden and stay hidden, and the `sync` at the end is what
   * covers the one case where it must not: landing directly on `#deluvia.studio` from a
   * home-screen shortcut, where the hash named this pane before the pane existed and
   * `show` had already fallen back to Home. That fall-back is correct at the moment it is
   * taken — a hash naming nothing is Home — and this is the moment it stops being true.
   *
   * Refuses an id the grammar does not know, exactly as the markup loop does, so the
   * order is forced: `route.add` first, then this. A container registered under a name no
   * hash can ever produce would be a pane with no way in.
   */
  function adopt(view, el) {
    if (!el || !known(view) || panes.has(view) || pending.has(view)) return false;
    el.hidden = true;
    panes.set(view, el);
    sync();
    return true;
  }

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
    go(view, query) {
      const hash = route.hashFor(view, query);
      if (hash == null) return null;
      route.go(hash);
      return sync();
    },
    /**
     * Rewrite the query of the pane that is up, without leaving it.
     *
     * The address a view keeps its own state in — which brief is open, which chip, which
     * filters. `public/history.js` and `public/montabs.js` each grew their own `address`
     * object for this and each wrote the same fifteen lines; this is those lines, once,
     * where a repo view can reach them too (`ctx.setQuery` in public/viewhost.js).
     *
     * **Only the pane on screen may write.** The staged boot builds a pane while Home is
     * showing and a repo view's `build` runs whenever its payload lands, so a view writing
     * from behind a pane nobody is looking at would move the address out from under the
     * view that owns it. Both of the files above already refuse for this reason; the
     * refusal is here now so a view cannot forget to make it.
     *
     * `replaceState` by default, because the thing being written is a *narrowing* rather
     * than a place — a filter chip, an accordion opening — and a panel of them would fill
     * the back stack with steps between you and the screen you arrived from. `push: true`
     * is for the narrowing that really is a place: tapping into one brief from a list of
     * them is somewhere you expect the back button to leave.
     *
     * Either way `currentQuery` is brought up to date here, so the writer is never told
     * about its own write: `replaceState` fires no `hashchange` at all, and the push's
     * `hashchange` finds nothing changed and calls nobody. `onQuery` therefore means "the
     * address moved under you" — a back button, a deep link, another pane's link — which
     * is the only case a view has to redraw for.
     */
    setQuery(view, query, { push = false } = {}) {
      if (current !== view) return false;
      const hash = route.hashFor(view, query);
      if (hash == null) return false;
      if (hash === location.hash) return false;
      if (push) route.go(hash);
      else history.replaceState(null, '', location.pathname + location.search + hash);
      currentQuery = route.queryFor(view, location.hash);
      return true;
    },
    /** The query on the pane that is up, as the string between `?` and the end. */
    query: () => currentQuery,
    /** Can this document show that view without a document load? */
    has: (view) => panes.has(view),
    /** Register a container built after the page was parsed. See `adopt` above. */
    adopt,
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
    /**
     * Called with `(view, query)` when the address of the pane that is up moves.
     *
     * Not on the writer's own `setQuery`, and not on the first `sync` — that one runs as
     * this file is parsed, before anything has had the chance to register, and a view
     * landed on by a deep link reads its query directly instead (`ctx.query`). So this
     * fires for exactly one thing: somebody else moved the URL. The back button, mostly.
     */
    onQuery(fn) {
      if (typeof fn === 'function') queryListeners.push(fn);
    },
  };
})();
