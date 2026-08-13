/*
  The bar along the bottom of every standing view.

  These pages — it started as four: the inbox, the chat session, the sessions and the
  advocates — are separate documents, and each one used to end in an ✕ that
  hard-navigated to `/`. That made the inbox a hallway: chat session → advocates was
  two taps through a page you did not want. The ad-hoc cross-links that grew to paper
  over it (sessions → advocates, advocates → sessions) were the same complaint,
  admitting itself — and in the end those two were one view drawn twice, so Sessions
  is gone and Advocates answers for both.

  So: one bar, the same on all of them, fixed to the bottom where a thumb already is.
  Any view is one tap from any other, and nothing closes any more.

  **A tab is not a shortcut to a page; it is a claim that the page is somewhere you
  live.** That is what took **PRs** out of the bar again (bc-l8jp.6): the pull request
  board is somewhere you glance and then act on, and its rows are incoming work, so the
  rows moved into the inbox and the board kept its URLs without keeping a fifth of the
  bar. A page can be reachable, load-bearing and not a tab — and several are.

  Kept its URLs and lost its way in, as it turned out, which is bc-d4d5: the board is a
  pane on the advocates page now. "Not a tab" was right and "reachable" was not, and the
  fix for the second is not to undo the first.

  **Chat** went the same way in the same breath (bc-l8jp.5), for a second reason on top
  of that one: it was the one tab that was also the way to *create* something, and a bar
  drawn identically on every page cannot hold a create — whatever it did would have to
  mean the same thing on all of them, and creating does not. So the conversations you
  have open are inbox rows like the pull requests, and starting one is ＋ on the inbox.
  The bar navigates; the inbox creates.

  The same rule is what keeps the **Mirror** out of this list (bc-3xb), and it is worth
  knowing before you fill either of the places those two left. The Mirror is a *mode* of
  the advocates page — the same repos and sessions seen from the phone rather than from
  this Mac — and it is the one surface here that is meaningless on the device a bottom tab
  is tapped from: it follows another device and drops its own (`notMe` in mirror.js), so a
  phone tapping a Mirror tab would read "Looking for a device…" forever. It stays an
  in-page pane on monitor.html. That there is now room on the bar is not an argument for
  putting it here; see README, "The Mirror is a pane, not a tab".

  It is built here rather than pasted into five <head>-alike blocks of HTML because
  there is no templating in this app and a bar that says different things on
  different pages is worse than no bar. One list, one place to add a tab, and one
  place for the badge that hangs off Advocates — hence the `data-tab` on each item,
  which is the handle to find it by.

  The badge itself is set from outside, through `beadcause.tabBadge`: the number
  arrives on the inbox's own poll (/api/questions carries it), and a bar that fetched
  it itself would be a fifth caller of an endpoint the page it is drawn on has
  already called. So on the inbox it is live, and on a page that never sets one there
  is simply no badge — which is the honest state, rather than a stale number that
  page has no way to refresh.
*/
(() => {
  const TABS = [
    // `paths` is every URL that *is* this view. The server maps several onto one page
    // — Advocates answers to five of them, three inherited from the sessions view it
    // absorbed — and the phone's home screen still holds the old ones, so a tab has
    // to recognise all of them or the bar shows nothing as current on a page you are
    // plainly looking at.
    { id: 'inbox', href: '/', icon: '📥', label: 'Inbox', paths: ['/', '/index.html'] },
    // There was a **Chat** tab here, and it is gone (bc-l8jp.5). Not because the chat
    // session mattered less than the ones that are left, but because it was the one
    // tab that was two things at once: a *list* of conversations you had already
    // started, and the only way to start another. Both belong somewhere better. The
    // list is a category in the inbox now — the conversations you have open are
    // incoming things, exactly like a question or a pull request, and the inbox's kind
    // filter already had a table to add them to. Starting one is the ＋ on the inbox,
    // which is the primary action of the whole app and was never a navigation.
    //
    // **`/console` is still a live route with no tab pointing at it.** The id and the
    // href live in stored conversation records and on people's home screens, so the
    // page answers to both of its paths exactly as before (see `serveStatic`, and
    // test/pagepaths.mjs); it is reached from a row in the inbox or from ＋ rather
    // than from here, and the bar on it marks nothing as current because you are not
    // on one of these views. It freed a slot on what was then a five-tab bar, which is
    // what §6 step 8 of the UX review and bc-3xb were both arguments about — and the
    // tab below went the same way in the same breath, so that argument is settled twice
    // over rather than narrowly.
    //
    // The 💬 the tab had taken by the end (bc-6np, over the 🧾 it started with) went with
    // it, and it is not lost: the inbox's own session rows draw an open conversation with
    // exactly that, which is where the icon now does its work.
    // There was a **PRs** tab here too, next to Advocates. It is gone (bc-l8jp.6) and the
    // reason is the same as the gap above it: a tab is a claim that a screen is somewhere
    // you *live*, and the pull request board is somewhere you glance — "did that ship?" —
    // and then act on twice a day. The rows themselves are incoming work like everything
    // else the inbox holds, so they are cards in the inbox now, under their own filter
    // with a sub-filter over the status ladder.
    //
    // **That rule has not moved, and the board has (bc-d4d5).** Taking it off the bar
    // left nothing at all pointing at it: the only route in was the link on a PR card in
    // the inbox, so on a day with no pull request in the inbox there was no way to reach
    // **Ship** short of typing a URL. It is a pane on the advocates page now — the third
    // chip on the row above this bar — which is the Mirror's argument for the second
    // time: a *mode* of the page you already watch work from, not a page you live on.
    // So `/prs`, `/pulls` and `/prs.html` are in the Advocates `paths` below, and this
    // bar marks Advocates as current on all three, which is exactly what the tab means.
    //
    // The sessions view too. `/sessions`, `/work` and `/work.html` all serve this page
    // now, and they stay in `paths` so the bar marks the right tab for a phone opening
    // the shortcut it has had on its home screen for months.
    {
      id: 'advocates',
      href: '/monitor',
      icon: '📣',
      label: 'Advocates',
      paths: [
        '/monitor',
        '/advocates',
        '/monitor.html',
        '/sessions',
        '/work',
        '/work.html',
        '/prs',
        '/pulls',
        '/prs.html',
      ],
    },
    // The record (bc-nib3.2). It earns a tab by this file's own rule rather than in
    // spite of it: **the historical record is somewhere you live** — it is where you go
    // to ask "what happened to that", and before it existed a bead that closed last week
    // was reachable only if you still remembered its id. The inbox is what is arriving,
    // Advocates is what is running this minute, and neither of them can answer a
    // question about the past, because a thing that is finished has by definition left
    // both lists.
    //
    // Here rather than at either end, which is two decisions. The bar had to grow in the
    // **middle**: Inbox is leftmost because it is home and it is `/`, Admin is rightmost
    // because it is the tab you least want to hit by accident, so neither of the two
    // positions anybody has learned moves to a different edge. And of the two middle
    // slots this takes the later one, so that the first three read left to right in the
    // order the work does — what is arriving, what is running, what is finished — and
    // Inbox and Advocates, the pair you cross between all day, stay next to each other.
    { id: 'history', href: '/history', icon: '📜', label: 'History', paths: ['/history', '/history.html'] },
    // The fifth tab this file's header left room for. Pause all / resume all lives
    // on its own page, and it has to be reachable from wherever you noticed you
    // wanted it — which is the point of the bar.
    { id: 'admin', href: '/admin', icon: '⏸', label: 'Admin', paths: ['/admin', '/admin.html'] },
  ];

  const here = location.pathname.replace(/\/+$/, '') || '/';
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

  const nav = document.createElement('nav');
  nav.className = 'tabbar';
  nav.setAttribute('aria-label', 'Views');
  nav.innerHTML = TABS.map((t) => {
    const on = t.paths.includes(here);
    // The current tab is a <span>, not a link: tapping where you already are
    // should do nothing, and an <a href> pointed at this page would throw the
    // list, the conversation and your scroll position away to rebuild the same
    // screen. aria-current is what says "this one" to a reader that cannot see
    // the accent; the rule above the icon is what says it to one that can.
    const tag = on ? 'span' : 'a';
    const attrs = on ? 'aria-current="page"' : `href="${esc(t.href)}"`;
    // The badge sits on the icon, not beside the label, so the number is on the
    // thing you tap rather than next to it. `hidden` until something sets it —
    // zero is not a state worth drawing.
    return `<${tag} class="tab-item" data-tab="${esc(t.id)}" ${attrs}>
      <span class="tab-icon" aria-hidden="true">${t.icon}<span class="tab-badge" data-badge hidden></span></span>
      <span class="tab-label">${esc(t.label)}</span>
    </${tag}>`;
  }).join('');

  document.body.append(nav);

  /**
   * Hang a count off a tab, or take it away.
   *
   * `label` is what a screen reader gets, because the badge itself is inside the
   * `aria-hidden` icon — a bare "2" read out after "Advocates" says nothing about
   * two of what. Passing 0 (or nothing) clears both the badge and the label, so a
   * tab that has been answered goes back to reading exactly as it did before.
   */
  const badge = (id, n, label) => {
    const item = nav.querySelector(`.tab-item[data-tab="${CSS.escape(String(id))}"]`);
    if (!item) return;
    const el = item.querySelector('[data-badge]');
    const count = Number(n) || 0;
    el.textContent = count > 9 ? '9+' : String(count);
    el.hidden = !count;
    // Removed rather than emptied: an aria-label of "" is not "no label", it is a
    // label of nothing, and some readers then announce nothing at all.
    if (count && label) item.setAttribute('aria-label', label);
    else item.removeAttribute('aria-label');
  };

  window.beadcause = window.beadcause || {};
  window.beadcause.tabBadge = badge;
  // What tells the stylesheet to keep the bar's height clear at the foot of the
  // page. The bar is fixed, so nothing reserves that space on its own, and without
  // this the last row of the inbox sits under it.
  document.body.classList.add('has-tabbar');
})();
