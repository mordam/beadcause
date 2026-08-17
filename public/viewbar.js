/*
  One row of pills, across the top of every page (bc-khoe.1).

  ## What it replaced, and why two bars could not stay

  There were two of these, drawn alike and meaning different things. `public/tabbar.js`
  was a bar along the *bottom* of five pages that moved between **pages**; the chip row
  on /monitor (`public/montabs.js`) swaps a **pane**. A phone showed both at once, one at
  each end of the screen, and the only way to know which one a given control was on was
  to have learned it. On top of them the inbox has a third axis of the same kind inside
  its filter panel — the ten kinds in `public/inboxfilter.js`, which are categories doing
  a view pill's job.

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

  It **scrolls horizontally and never wraps**. There are five pills today and there will
  be roughly nine once bc-khoe.2 (the six kinds), bc-khoe.4 (Advocates, Mirror) and
  bc-khoe.7 (Releases) have landed, and a row that wraps to two lines on a 360px phone is
  the exact thing this epic exists to stop — it spends a second row of a screen that is
  mostly chrome already. So the row takes the width it needs and the current pill is
  scrolled into view on load, which is the one moment the offset can be wrong without
  anybody having touched it.

  ## A pill is an <a href>, and the current one is not

  Tapping where you already are should do nothing. An `<a>` pointed at the page you are
  on throws the list, the conversation and your scroll position away to rebuild the same
  screen — so the current pill is a `<span>` with `aria-current="page"` and no href at
  all. `aria-current` is what says "this one" to a reader that cannot see the accent; the
  filled pill is what says it to one that can, and neither is colour on its own.

  ## What is not a pill

  **No counts and no badges, on any of them.** The bar carried one — the proposals
  waiting, hung off Advocates — and it is gone with it. A number on a pill is a number
  that is only ever live on the one page whose poll happens to carry it, and stale
  everywhere else; the count that matters is in the list you are looking at.

  **Admin.** It had the rightmost tab and it loses it here: it is the screen you least
  want to hit by accident, and bc-khoe.5 puts it in the gear menu the top bar's mark
  opens. Until that lands the route is the ⚙ at monitor.html:44 — which is why this bead
  must not remove that, and why /admin is the one page below that draws the row with
  nothing on it current.

  **The chat session.** bc-l8jp.5 took it off the bar and the argument has not moved: it
  was the one entry that was also the way to *create* something, and a row drawn
  identically everywhere cannot hold a create. The conversations you have open are rows
  in Home and starting one is the ＋ there; bc-khoe.2 gives them a Chats kind pill.

  **The endorsement queue, `/flow` and `/requirements`.** All three draw the row — they
  were among the eight pages the bottom bar was the only way off — and none of them is on
  it. The queue's absence is a recorded decision (bc-j0zl, "never a sixth tab") and
  bc-khoe.2 folds it into a Questions pill rather than giving it one of its own; the other
  two are pages you read when you are new to the system or arguing about it, not pages you
  check. A page can be reachable, load-bearing, and not a view.

  **The Mirror.** A mode of /monitor rather than a view — it follows *another* device and
  drops its own, so it is meaningless on the phone a pill is tapped from. bc-khoe.4 is
  where that is re-decided, together with the chip row it lives on.

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
  const PILLS = [
    // `paths` is every URL that *is* this view. The server maps several onto one page —
    // /monitor answers to six of them, three inherited from the sessions view it
    // absorbed — and the phone's home screen still holds the old ones, so a pill has to
    // recognise all of them or the row shows nothing as current on a page you are
    // plainly looking at. See `serveStatic` in lib/server.js, and test/pagepaths.mjs.
    { id: 'inbox', href: '/', icon: '🏠', label: 'Home', paths: ['/', '/index.html'] },
    {
      id: 'advocates',
      href: '/monitor',
      icon: '📣',
      label: 'Advocates',
      paths: ['/monitor', '/advocates', '/monitor.html', '/sessions', '/work', '/work.html'],
    },
    // The record (bc-nib3.2): where you go to ask "what happened to that". Third,
    // because the first three read left to right in the order the work does — what is
    // arriving, what is running, what is finished — and because that is the position it
    // has had since it was a tab. Nothing anybody has learned moves in this change.
    { id: 'history', href: '/history', icon: '📜', label: 'History', paths: ['/history', '/history.html'] },
    // The board, in the slot Admin has left. bc-l8jp.6 took it off the bottom bar on the
    // rule that a tab is a claim a page is somewhere you *live*, and bc-d4d5 then found
    // that taking it off had left nothing at all pointing at it — so it became a chip on
    // /monitor. This row is where that ends: it costs one pill out of nine rather than a
    // fifth of a bar, which is the width the old argument was actually about. Its three
    // paths serve monitor.html, so the pill is current there and the chip row puts the
    // board up.
    { id: 'prs', href: '/prs', icon: '🚢', label: 'PRs', paths: ['/prs', '/pulls', '/prs.html'] },
  ];

  const here = location.pathname.replace(/\/+$/, '') || '/';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const nav = document.createElement('nav');
  nav.className = 'viewbar';
  nav.setAttribute('aria-label', 'Views');
  nav.innerHTML = PILLS.map((p) => {
    const on = p.paths.includes(here);
    const tag = on ? 'span' : 'a';
    const attrs = on ? 'aria-current="page"' : `href="${esc(p.href)}"`;
    return `<${tag} class="viewpill" data-view="${esc(p.id)}" ${attrs}>` +
      `<span class="viewpill-icon" aria-hidden="true">${p.icon}</span>` +
      `<span class="viewpill-label">${esc(p.label)}</span>` +
      `</${tag}>`;
  }).join('');

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

  window.beadcause = window.beadcause || {};
  /** The row's own list, for anything that has to agree with it. */
  window.beadcause.views = PILLS;
})();
