/*
  The bar along the bottom of every standing view.

  These four pages — the inbox, the console, the sessions and the advocates — are
  separate documents, and each one used to end in an ✕ that hard-navigated to `/`.
  That made the inbox a hallway: console → advocates was two taps through a page
  you did not want. The ad-hoc cross-links that grew to paper over it (sessions →
  advocates, advocates → sessions) were the same complaint, admitting itself.

  So: one bar, the same on all four, fixed to the bottom where a thumb already is.
  Any view is one tap from any other, and nothing closes any more.

  It is built here rather than pasted into four <head>-alike blocks of HTML because
  there is no templating in this app and a bar that says different things on
  different pages is worse than no bar. One list, one place to add a fifth tab, and
  one place for the badges that hang off Sessions and Advocates — hence the
  `data-tab` on each item, which is the handle to find them by.

  The badges themselves are set from outside, through `beadcause.tabBadge`: the
  numbers arrive on the inbox's own poll (/api/questions carries them), and a bar
  that fetched them itself would be a fifth caller of an endpoint the page it is
  drawn on has already called. So on the inbox they are live, and on a page that
  never sets one there is simply no badge — which is the honest state, rather than
  a stale number that page has no way to refresh.
*/
(() => {
  const TABS = [
    // `paths` is every URL that *is* this view. The server maps several onto one
    // page (`/work` and `/sessions`, `/monitor` and `/advocates`) and the phone's
    // home screen still holds the old ones, so a tab has to recognise all of them
    // or the bar shows nothing as current on a page you are plainly looking at.
    { id: 'inbox', href: '/', icon: '📥', label: 'Inbox', paths: ['/', '/index.html'] },
    { id: 'console', href: '/console', icon: '🧾', label: 'Console', paths: ['/console', '/console.html'] },
    { id: 'sessions', href: '/sessions', icon: '🤖', label: 'Sessions', paths: ['/sessions', '/work', '/work.html'] },
    { id: 'advocates', href: '/monitor', icon: '📣', label: 'Advocates', paths: ['/monitor', '/advocates', '/monitor.html'] },
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
   * `aria-hidden` icon — a bare "2" read out after "Sessions" says nothing about
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
