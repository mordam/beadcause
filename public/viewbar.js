/*
  One row of pills, across the top of every page (bc-khoe.1).

  ## What it replaced, and why two bars could not stay

  There were two of these, drawn alike and meaning different things. `public/tabbar.js`
  was a bar along the *bottom* of five pages that moved between **pages**; the chip row
  on /monitor (`public/montabs.js`) swaps a **pane**. A phone showed both at once, one at
  each end of the screen, and the only way to know which one a given control was on was
  to have learned it. On top of them the inbox has a third axis of the same kind inside
  its filter panel — the ten kinds in `public/inboxfilter.js`, which are categories doing
  a view pill's job. bc-khoe.2 amalgamated those ten to six and promoted them here.

  All of that collapses into this row. The bottom bar is deleted outright: the epic's
  claim is that Home *is* the app and everything else is one tap from it, and a second
  bar at the other end of the screen is the shape you get when that is not true.

  ## Why the top, and why it scrolls sideways

  The bottom is where a thumb is, which is the argument the bar was built on — and it is
  also the edge iOS puts the home indicator and the URL bar on, which is why the bar
  spent its life drifting (bc-7utr). The row is a row of the app shell now (see the shell
  note at the top of public/style.css): `body` is one viewport tall and clipped, the top
  bar and this row are flex rows above the one element that scrolls, so nothing here is
  laid out against a viewport that moves, because no viewport moves.

  It **scrolls horizontally and never wraps**. There are seven pills today — the six
  kinds bc-khoe.2 promoted out of the inbox's filter panel, plus the advocate console —
  and there will be roughly nine once bc-khoe.4 (Advocates, Mirror) and bc-khoe.7
  (Releases) have landed. A row that wraps to two lines on a 360px phone is
  the exact thing this epic exists to stop — it spends a second row of a screen that is
  mostly chrome already. So the row takes the width it needs and the current pill is
  scrolled into view on load, which is the one moment the offset can be wrong without
  anybody having touched it.

  ## A pill is a link only when there is somewhere to go

  There is one rule under all three shapes below and it is the whole of this section:
  **an `<a>` is for a document this page has not got.** A link to something already on
  screen throws the list, the conversation and your scroll position away to rebuild the
  same screen, and every exception here is that sentence applied to a different way of
  already having it.

  * **The current pill is a `<span>`** with `aria-current="page"` and no href. You are
    there. `aria-current` says so to a reader that cannot see the accent and the filled
    pill says it to one that can, and neither is colour on its own.
  * **A view whose pane is in this document is a `<button>`** (bc-khoe.30.3). Since the
    shell landed, `/` holds one `[data-pane]` container per view and moving between them
    is a `display: none` swapped for a `display: flex` — see public/panes.js. So the pill
    writes the hash and the panes answer it, and no second document is asked for. The row
    finds out by asking `panes.has(...)`; on the eleven pages that have no panes the
    answer is no and the pill is the link it always was.
  * **A kind pill is a `<button>` wherever Home is reachable without a load**
    (bc-khoe.2). Five of the six kinds *are* Home under a different narrowing, so a link
    would be a full document load — a refetch of every workspace, a rebuild of forty
    cards, an open card thrown away — to change which rows of a list already in hand get
    drawn. On the shell that holds from every pane, not just from Home: tapping `PRs`
    while History is up carries `data-view` as well as `data-kind`, so the tap switches
    pane and narrows in one go. On a page that is not the shell it is an
    `<a href="/?kind=…">` that goes there and arrives narrowed; `?kind=` is read once, at
    load, by public/inboxfilter.js.

  ## Which one is lit: the hash decides the view, the filter decides within Home

  The hash names one of three views and public/panes.js shows it; that view's pill is the
  lit one, and this file asks rather than deriving it — `panes.showing()` on the shell,
  and `viewOfPath` on the eleven pages that are still documents, which is the same answer
  read off the other half of the URL.

  Home is where it stops being a fact about the URL, and that is not a wrinkle in the
  grammar but a difference in kind. Five pills share Home's one address *and* its one
  (empty) hash, because they are not places — they are narrowings of a list already in
  hand, and a narrowing is not something the back button should walk. So within Home the
  *filter* is the answer, pushed in through `mark()` by inboxfilter.js's `paint`. Pushed
  rather than pulled because this file is on twelve pages and that one is on Home alone:
  a row that read the selection itself would have to know the storage key, which is a
  second place that knows what a kind is — the exact thing bc-khoe.2 exists to remove.

  `mark()` records the narrowing wherever it is called from and only repaints when Home
  is the pane on screen. That is what keeps the pill you last chose waiting for you when
  you come back to Home from another pane — the inbox goes on repainting while hidden,
  and a `mark` refused outright would leave the row lighting last week's answer.

  ## What is not a pill

  **No counts and no badges, on any of them.** The bar carried one — the proposals
  waiting, hung off Advocates — and it is gone with it. A number on a pill is a number
  that is only ever live on the one page whose poll happens to carry it, and stale
  everywhere else; the count that matters is in the list you are looking at.

  **Admin.** It had the rightmost tab and it loses it here: it is the screen you least
  want to hit by accident. bc-khoe.5 landed while this branch was parked and put it where
  it belongs — a row in the menu the top bar's gear-wrapped mark opens
  (`account-admin` in public/accountbar.js), drawn on every page rather than on the one
  that happened to have a ⚙. So it is reachable from everywhere and is on no row, which is
  what it was always supposed to be; /admin itself draws this row with nothing on it
  current. monitor.html's own ⚙ stays, because accountbar.js hoists it into that menu
  rather than duplicating it.

  **A create.** bc-l8jp.5 took the chat session off the bottom bar because it was the one
  entry that was also the way to *make* something, and a row drawn identically on every
  page cannot hold a create. That has not moved: `Chats` is a pill now, but it is the
  pill for the conversations you already have open, and starting one is still the ＋ on
  Home. A pill goes somewhere; it does not do anything.

  **The endorsement queue, `/flow` and `/requirements`.** All three draw the row — they
  were among the eight pages the bottom bar was the only way off — and none of them is on
  it. The queue's absence is a recorded decision (bc-j0zl, "never a sixth tab") and
  bc-khoe.2 honoured it: a bead held for endorsement is a thing waiting on a word from
  you, so it is a row under `Questions` rather than a pill of its own. The other two are
  pages you read when you are new to the system or arguing about it, not pages you check.
  A page can be reachable, load-bearing, and not a view.

  **The Mirror.** A mode of /monitor rather than a view — it follows *another* device and
  drops its own, so it is meaningless on the phone a pill is tapped from. bc-khoe.4 is
  where that is re-decided, together with the chip row it lives on.

  **The pull request board.** `/prs` had a pill of its own until bc-khoe.2 needed the
  word for the kind, and the three paths that serve it are on the Advocates pill now —
  they resolve to monitor.html with its board chip up, so the pill that lights there is
  the pill that points at that page. The board is two taps rather than one; bc-khoe.4 is
  where the console comes apart and that is re-decided.

  It is built here rather than pasted into eight <head>-alike blocks of HTML because
  there is no templating in this app, and a row that says different things on different
  pages is worse than no row. One list, one place to add a pill.

  ## Why the class is `.viewbar` and not `.pillrow`

  Because `.pill` was taken, twice over. It is this app's uppercase metadata badge — the
  P0, the type, the bead id on a card — with about twenty modifiers hanging off it, and
  `.pill-row` is already the flex-wrapping row those badges sit in. A row of navigation
  called `.pillrow` full of `.pill`s would have restyled every badge in the app and left
  two classes a hyphen apart meaning unrelated things. `.viewbar` / `.viewpill` collides
  with nothing, and the epic's own word for these — *view* pills — is the half that was
  free.
*/
(() => {
  /*
    The row, as of bc-khoe.2: the six kinds Home carries, plus the advocate console.

    Five of the six are **Home under a different narrowing** — they are the kinds table
    in public/inboxfilter.js, promoted out of a collapsed filter panel and onto the one
    row of chrome this app has. `History` is the sixth and is a page of its own, which is
    why it is the only kind here carrying an `href` at all: the other five get theirs
    from `hrefOf`, and only off Home.

    `kind` is the id of the row in that table, and the two lists are held to the same six
    ids, labels and icons by test/inboxkinds.mjs — this file is loaded on twelve pages
    and inboxfilter.js on one, so the row cannot read the table at paint time and a copy
    is the only shape available. A checked copy is not a second place that knows; an
    unchecked one is. What is deliberately *not* copied is the URL: the table knows what
    a kind is and this file knows where its pill goes, so there is no href written down
    twice for the check to have to catch.

    What is **not** here any more, since bc-khoe.30.2, is `paths` — every URL that *is* a
    given view. The server maps several onto one page (/monitor answers to nine of them
    now) and the phone's home screen still holds the old ones, so a pill has to recognise
    all of them or the row shows nothing as current on a page you are plainly looking at.
    That is the same question as "what does this hash mean", asked of the other half of
    the URL, and public/hashroute.js is where it is answered now — `viewOfPath` below.
    Three of these pills are views and it holds their addresses; the four with none are
    the four that are only ever Home, where the filter decides which is lit rather than
    the path. See `serveStatic` in lib/server.js, and test/pagepaths.mjs, which reads that
    table from hashroute.js.
  */
  const PILLS = [
    // Home with nothing narrowed: the P0 board and the work under it (bc-rfnr.9). First
    // because it is where you land, and because every pill to its right is a narrowing
    // of it rather than a different place.
    { id: 'epics', kind: 'epics', icon: '🎯', label: 'My Epics' },
    // Questions, PRs, Chats: what is arriving, in the order it tends to need answering.
    { id: 'question', kind: 'question', icon: '❓', label: 'Questions' },
    { id: 'pr', kind: 'pr', icon: '🚢', label: 'PRs' },
    { id: 'session', kind: 'session', icon: '💬', label: 'Chats' },
    // The record (bc-nib3.2): where you go to ask "what happened to that". A page rather
    // than a narrowing of Home — it has its own poll, its own filter bar and its own
    // vocabulary — and it kept the position it has had since it was a tab.
    { id: 'history', kind: 'history', href: '/history', icon: '📜', label: 'History' },
    // The work nobody is asking you about, which is why it is past the three that are —
    // and past the record of the ones that are finished.
    { id: 'bead', kind: 'bead', icon: '🧿', label: 'All Beads' },
    // Not a kind, and the one pill on this row that is neither Home nor a record. It
    // also carries the pull request board's three paths, which used to be a `PRs` pill
    // of their own: /prs, /pulls and /prs.html all serve monitor.html with its board
    // chip up (see `serveStatic`), so the pill that is current there is the pill that
    // points at that page — and the `PRs` label now belongs to the kind above, which is
    // the pull requests *in Home*. bc-khoe.4 is where the console comes apart and this
    // is re-decided; until then two taps still reach the board and nothing is stranded.
    { id: 'advocates', href: '/monitor', icon: '📣', label: 'Advocates' },
  ];

  const route = window.beadcause.route;
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  /**
   * Which view this document is, or null for one of the five pages that is on no pill.
   *
   * Asked of public/hashroute.js rather than matched against a table here, because the
   * table it would be matched against is the same one that says what `#advocates` means
   * — nine addresses and one hash, all naming the advocate console — and two copies of
   * that is how a phone's `/work.html` shortcut ends up on a row with nothing current.
   */
  const view = route.viewOfPath(location.pathname);

  /**
   * The panes of this document, on the one page that has any (bc-khoe.30.3).
   *
   * `?.` here where `route` above is reached flat, and the difference is which absence is
   * a bug. Every page needs the grammar, so a missing `route` is a page that cannot say
   * where it is and should fail loudly. Panes are a fact about the shell alone — this row
   * is drawn on twelve pages and eleven of them have nothing to show and hide — so a
   * missing `panes` is the ordinary case, and every question below is asked with that
   * answer as its default. See public/panes.js.
   */
  const panes = window.beadcause?.panes || null;

  /**
   * Which view this row is over *right now*.
   *
   * On the shell that changes without the document changing, which is the whole of
   * bc-khoe.30: the pane is swapped, `onShow` fires, and the row redraws against the new
   * answer. Everywhere else it is the address, decided once at load and never again.
   */
  const here = () => panes?.showing() || view;

  /** Is the row over Home this second? Five of the seven pills act rather than link. */
  const onHome = () => here() === route.HOME;

  /** Can this row reach Home without asking for a document? True on every pane of the
   *  shell, and on Home itself wherever it is the whole page. */
  const homeIsHere = () => onHome() || !!panes?.has(route.HOME);

  /** A kind pill's URL from anywhere else. `?kind=` is read once, at load, by
   *  inboxfilter.js — the service worker matches with `ignoreSearch`, so a query on the
   *  shell's own path still resolves to the precached document offline. */
  const hrefOf = (p) => p.href || `/?kind=${encodeURIComponent(p.kind)}`;

  const nav = document.createElement('nav');
  nav.className = 'viewbar';
  nav.setAttribute('aria-label', 'Views');

  /**
   * Which of Home's five pills the filter last chose.
   *
   * Recorded whether or not Home is on screen — see `mark()` — because on the shell the
   * inbox goes on repainting behind a pane you have switched to, and the narrowing you
   * left it on is the one that should be lit when you come back. `epics` until something
   * says otherwise, which is what an unnarrowed Home is.
   */
  let narrowed = route.HOME;

  /**
   * Which pill is lit. Two answers, and which one applies is a fact about the hash.
   *
   * Away from Home it is the view showing — the pane on the shell, the address on the
   * eleven pages that are still documents, both of them read through `here()`. On Home
   * five pills share one address *and* one empty hash, so neither can tell them apart and
   * the filter is the answer instead.
   */
  const lit = () => (onHome() ? narrowed : here() || '');

  /**
   * Draw the row.
   *
   * Three shapes of pill, and the difference between them is what a tap should do — the
   * argument for each is in the doc comment above. Two `data-` attributes carry the two
   * things a tap can ask for and a pill may carry **both**: `data-pane` is the view to
   * show and `data-kind` is the narrowing to move to within Home. `My Epics` tapped from
   * the History pane is exactly that pair, and so is every other kind pill tapped from a
   * pane that is not Home — switch, then narrow, in one tap and no document load.
   *
   * `showable` is `false` for the pane already up, so the pill for the pane you are on —
   * when it is not also the lit one, which happens on Home whenever a kind is selected —
   * does not rewrite a hash that is already right.
   */
  function draw() {
    const cur = lit();
    const home = onHome();
    nav.innerHTML = PILLS.map((p) => {
      const on = p.id === cur;
      const showable = !on && !!panes?.has(p.id) && p.id !== here();
      const narrows = !on && !!p.kind && !p.href && homeIsHere();
      const act = showable || narrows;
      /* Where the tap has to land first. The pane for a view pill; Home for a kind pill
         tapped from anywhere else, because a narrowing of a list means nothing until the
         list is the one on screen. Empty when the pane is already right. */
      const pane = showable ? p.id : narrows && !home ? route.HOME : '';
      const tag = on ? 'span' : act ? 'button' : 'a';
      const attrs = on
        ? 'aria-current="page"'
        : act
          ? `type="button"${pane ? ` data-pane="${esc(pane)}"` : ''}${narrows ? ` data-kind="${esc(p.kind)}"` : ''}`
          : `href="${esc(hrefOf(p))}"`;
      /* `data-pill` and not `data-view`: the chips on /monitor already carry a `data-view`
         and it means something else there — what public/presence.js should say this device
         is looking at — so one name for two things across two rows of chrome is exactly
         what this change exists to stop. `data-pane` above is the shell's own word for a
         container in public/index.html, which is the thing this attribute names. */
      return `<${tag} class="viewpill" data-pill="${esc(p.id)}" ${attrs}>` +
        `<span class="viewpill-icon" aria-hidden="true">${p.icon}</span>` +
        `<span class="viewpill-label">${esc(p.label)}</span>` +
        `</${tag}>`;
    }).join('');
  }
  draw();

  /* One listener on the row rather than one per pill, because `draw()` replaces every
     node in it each time the lit pill moves and per-node handlers would have to be
     rebound on each. A button with no filter file behind it does nothing rather than
     throwing — the same fallback every other caller of this API takes. */
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest?.('button.viewpill');
    if (!btn) return;
    e.preventDefault();
    /* The pane first and the narrowing second, and the order is the point: a kind pill
       tapped from another pane carries both, and picking the kind before Home is the pane
       on screen would narrow a list nobody is looking at and then paint over it. */
    if (btn.dataset.pane) panes?.go(btn.dataset.pane);
    if (btn.dataset.kind) window.beadcause?.inboxFilter?.pick?.(btn.dataset.kind);
  });

  /* Second row of the shell, under the top bar — not appended to the end of <body> the
     way the bottom bar was. Every page that draws this row draws a `.topbar`; the
     fallback is for one that somehow does not, where the top of the page is still the
     right place and a row lost off the bottom would be a page with no way out. */
  const bar = document.querySelector('.topbar');
  if (bar) bar.after(nav);
  else document.body.prepend(nav);

  /**
   * Put the current pill on screen.
   *
   * The row is wider than a phone as soon as there are more than about five pills, and
   * `scrollLeft` starts at 0 — so the pill that says where you are is the one most
   * likely to be off the right-hand edge, on the one screen where it matters most. Done
   * by arithmetic on the two rectangles rather than with `scrollIntoView`, which is
   * allowed to scroll every ancestor as well: the shell's scroller is one of those, and
   * a navigation that quietly scrolled the list under it would be a bug nobody could
   * name.
   *
   * Twice, because the first call runs before the webfont has settled and the second
   * catches the reflow. Both are cheap and neither animates: this is where the row
   * *starts*, not a movement anybody should see.
   */
  const reveal = () => {
    const cur = nav.querySelector('[aria-current="page"]');
    if (!cur) return;
    const c = cur.getBoundingClientRect();
    const n = nav.getBoundingClientRect();
    if (!n.width) return;
    nav.scrollLeft += c.left - n.left - (n.width - c.width) / 2;
  };
  reveal();
  addEventListener('load', reveal, { once: true });

  /* The pane moved under the row, so the row is over a different view than it was — a
     different pill is lit and a different set of them are links. Registered rather than
     polled, and a no-op on the eleven pages that have no panes to move. */
  panes?.onShow(() => {
    draw();
    reveal();
  });

  window.beadcause = window.beadcause || {};
  window.beadcause.views = {
    /** The row's own list, for anything that has to agree with it. */
    pills: PILLS,
    /** Which pill is lit right now. */
    lit,
    /**
     * Light a different pill, from the filter that actually knows.
     *
     * A no-op for an id the row does not draw: the row is on twelve pages and only one of
     * them has a filter behind it, so this has to be safe to call into thin air. Redraws
     * only when the answer moved — the inbox repaints every 25 seconds and `paint` rides
     * along with it, and rebuilding seven nodes on a timer would drop the focus ring off
     * a pill somebody is tabbing through.
     *
     * The narrowing is **recorded from anywhere and only painted over Home**. It used to
     * be refused outright off Home, which was the same thing while Home was a whole
     * document; on the shell the inbox repaints behind a pane you have switched away
     * from, and a refusal there would leave the row lighting the pill you chose two
     * switches ago the moment you came back.
     */
    mark(id) {
      if (narrowed === id || !PILLS.some((p) => p.id === id)) return;
      narrowed = id;
      if (!onHome()) return;
      draw();
      reveal();
    },
  };
})();
