/* The detail drawer: a graph, a document or a session opens *over* the tab you were reading.
 *
 * `/graph?ws=…&id=…` and `/doc?p=…` were full-page navigations, linked from all four
 * views. They are not destinations — they are detail about the thing you just
 * tapped — so paying for one with your place in the list, and finding that the way
 * back is an ✕ to the inbox, is the wrong trade on a phone. They slide in from the
 * right instead, and dismiss back to the tab that was underneath.
 *
 * `/session?pid=…` is the third, and it is here for a second reason on top of that
 * one: a session is listed in four places, and until it had one address the detail
 * behind it could only ever exist in whichever list had been taught to fold it open.
 * See public/session.js.
 *
 * One file, loaded by both sides of the drawer, picking its half at load:
 *
 *   - **the tab** (inbox, sessions, advocates, chat session) intercepts clicks on
 *     `/graph?`, `/doc?` and `/session?` links and loads the page that already exists
 *     into an iframe inside the panel. The iframe is the point: it keeps d3 out of the
 *     inbox's bundle and marked out of the graph's, and no page had to learn how to
 *     render the other one. The anchors keep their real hrefs, so long-press →
 *     open in new tab, and a pasted URL, still land on the standalone page.
 *   - **inside the drawer**, the page stops being a page: it hides its own top bar,
 *     hands its title up to the panel's header, retargets a link to another document
 *     rather than escaping the drawer, and dismisses on a swipe right.
 *
 * That last part is why the panel has a header at all. Both pages were built to be
 * opened on their own, so both carry a full top bar with a pulse dot, an h1 and a ✕
 * that means "close this tab" — and in a drawer that is wrong twice over: a second
 * header stacked under the tab's, and a ✕ that navigated the whole app to the inbox
 * rather than dismissing the panel. So the chrome moves out here, where it can mean
 * what it says: one header, one ✕, and the ✕ closes the drawer. The pages keep
 * theirs for the case they were built for — a pasted URL, a long-press → new tab —
 * because there the top bar is the only chrome there is.
 *
 * The drawer pushes exactly one history entry, so Android's back button and iOS's
 * back-swipe close it and land you on the tab you were on rather than on a blank
 * inbox. Exactly one, and that is the fiddly part: an iframe's *initial* navigation
 * adds no entry but every one after it does, so a drawer that re-pointed its iframe
 * by `src` would make back walk you through every document you had opened before it
 * finally gave you the tab. In-drawer navigation goes through `location.replace()`,
 * and a closed drawer throws its iframe away so the next open is an initial load
 * again.
 *
 * The tab itself is never navigated and its scroll is never touched — which is the
 * whole reason the drawer exists, and also why there is no scroll-restore code
 * here. The inbox's own anchoring (see capturePlace in app.js) keeps working behind
 * the panel, undisturbed.
 *
 * ## Closing a subordinate view — the rule, and this is the one place it is written
 *
 * `beadcause.closeView()`, at the foot of this file, is what a *page's* ✕ calls —
 * doc.js, graph.js and session.js, none of which answers this for itself any more.
 * The panel's own ✕ is not a page's and goes straight to `close()` below, which is
 * case 1 of the same rule with the mechanism to hand. The rule is one sentence:
 *
 *   **A subordinate view closes to the view it opened over, and to the inbox when
 *   there is not one.**
 *
 * Which is three cases and no more:
 *
 *   1. **In a drawer** — the view underneath is the tab the panel is over, so
 *      closing is a dismissal and not a navigation at all. The drawer spent one
 *      history entry to get here and `history.back()` is what gives it back, so the
 *      phone's own back button needs one press afterwards rather than two.
 *   2. **A tab this app opened** — long-press → open in new tab, or a `target=_blank`
 *      out of a brief. The view underneath is the tab that opened it, and handing
 *      that back is `window.close()`.
 *   3. **Anything else** — a pasted URL, a notification, a home-screen shortcut.
 *      Nothing is underneath: the inbox is the main page, and that is where it goes.
 *
 * It reads like an obvious rule and the app had three of them, which is the bug this
 * replaced (bc-l8jp.3). `/session`'s ✕ went to `/sessions`, correct on the day the
 * sessions view existed and, since Advocates absorbed it, a ✕ that closed one view by
 * opening a different tab. `/doc` and `/graph` went to `/` by way of their own copies
 * of the window.close()-then-navigate dance, so a change to what closing means was
 * three edits and the third was always the one forgotten. And the drawer's `back()`
 * lands wherever you came from — right, and the only exit in the app that can put you
 * on the PR board, which is what the bug was reported as.
 *
 * Case 3 is deliberately *not* "wherever you came from". A standalone detail page is
 * the fallback for an address that arrived from outside the app, where the history
 * behind it belongs to whatever you were doing before the app — and `back()` there is
 * a promise the ✕ cannot keep.
 */
(() => {
  'use strict';

  const CLOSE = 'beadcause:drawer-close';
  const OPEN = 'beadcause:drawer-open';
  const TITLE = 'beadcause:drawer-title';
  const DETAIL = new Set(['/graph', '/graph.html', '/doc', '/doc.html', '/session', '/session.html']);
  const SLIDE_MS = 240;
  /* Where a subordinate view with nothing underneath it closes to — the inbox, which
     is the main page. Named once, here, because "which page is home" is exactly the
     kind of answer that gets copied into four files and then changed in three. */
  const HOME = '/';
  /* Long enough for window.close() to have taken the tab if it was ever going to.
     A browser that refuses it does so silently, so the only way to tell is to still
     be here afterwards. */
  const CLOSE_MS = 120;

  /** The href of a link the drawer owns, normalised — null for everything else. */
  function detailUrl(href) {
    if (!href) return null;
    let u;
    try {
      u = new URL(href, location.href);
    } catch {
      return null;
    }
    if (u.origin !== location.origin || !DETAIL.has(u.pathname)) return null;
    return u.pathname + u.search + u.hash;
  }

  /** A tap the browser should keep for itself: new tab, new window, middle click. */
  const plain = (e) =>
    e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey && !e.defaultPrevented;

  const hit = (e, sel) => (e.target && e.target.closest ? e.target.closest(sel) : null);

  /* ------------------------------------------------------------------- tab */

  function tab() {
    let wrap = null;
    let panel = null;
    let titleEl = null;
    let frame = null;
    let open = false;
    let pushed = false;
    let sweep = 0;

    /** Built once, on the first tap — a tab that never opens one pays nothing. */
    function build() {
      if (wrap) return;
      wrap = document.createElement('div');
      wrap.className = 'drawer-wrap';
      wrap.hidden = true;
      wrap.innerHTML =
        '<div class="drawer-backdrop" data-role="backdrop"></div>' +
        '<aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-title" tabindex="-1">' +
        '<header class="drawer-head">' +
        '<h2 class="drawer-title" id="drawer-title" data-role="title"></h2>' +
        '<button class="icon-btn" data-role="close" aria-label="Close">✕</button>' +
        '</header>' +
        '<div class="drawer-edge" data-role="edge" aria-hidden="true"></div>' +
        '</aside>';
      document.body.appendChild(wrap);
      panel = wrap.querySelector('.drawer');
      titleEl = wrap.querySelector('[data-role="title"]');

      // The only ✕ in here. The page inside has put its own away (see .in-drawer in
      // style.css), because that one meant "close this tab" — which an iframe cannot do,
      // and which fell back to navigating the whole app to the inbox.
      wrap.querySelector('[data-role="close"]').addEventListener('click', () => close());

      const backdrop = wrap.querySelector('[data-role="backdrop"]');
      backdrop.addEventListener('click', () => close());
      // The backdrop is the only part of the drawer that has the tab directly
      // behind it, and a drag there should dismiss rather than scroll the list.
      backdrop.addEventListener('touchmove', (e) => e.preventDefault(), { passive: false });

      // Swipe right from the drawer's own left edge — the gesture the OS already
      // taught the thumb. It lives on a strip in front of the iframe because touches
      // inside an iframe never reach this document; the page in there forwards its
      // own swipes instead (see drawer(), below).
      let x0 = 0;
      let y0 = 0;
      let live = false;
      const edge = wrap.querySelector('[data-role="edge"]');
      edge.addEventListener(
        'touchstart',
        (e) => {
          live = e.touches.length === 1;
          if (live) {
            x0 = e.touches[0].clientX;
            y0 = e.touches[0].clientY;
          }
        },
        { passive: true }
      );
      edge.addEventListener(
        'touchend',
        (e) => {
          if (!live) return;
          live = false;
          const t = e.changedTouches[0];
          if (t.clientX - x0 > 60 && t.clientX - x0 > Math.abs(t.clientY - y0) * 2) close();
        },
        { passive: true }
      );
    }

    /** What the header says, sent up by the page inside once it knows. */
    function setTitle({ title, kind } = {}) {
      if (!titleEl) return;
      titleEl.textContent = title || 'Detail';
      // A file keeps the monospace it wore in the reader's own bar; a bead id does
      // not need it. The page says which it is rather than the header guessing.
      titleEl.dataset.kind = kind || '';
    }

    /** Point the drawer at a URL, without spending a history entry on it. */
    function load(url) {
      // Retargeting is a new page, so the header stops claiming the old one's name
      // the instant the load starts rather than when the new page gets around to
      // saying its own.
      setTitle({ title: 'Loading…' });
      if (frame) {
        frame.contentWindow.location.replace(url);
        return;
      }
      frame = document.createElement('iframe');
      frame.className = 'drawer-frame';
      frame.title = 'Detail';
      frame.src = url;
      panel.appendChild(frame);
    }

    /** The drawer's copy of a page knows it is in one — `embed=1` says so out loud. */
    function embedded(url) {
      const u = new URL(url, location.origin);
      u.searchParams.set('embed', '1');
      return u.pathname + u.search + u.hash;
    }

    function show(url) {
      build();
      const first = !open;
      if (first) {
        history.pushState({ bcDrawer: 1 }, '');
        pushed = true;
      }
      load(embedded(url));
      if (!first) return;
      open = true;
      clearTimeout(sweep);
      wrap.hidden = false;
      // Two frames: `hidden` off, then the class. Asked for in one, the panel is
      // already home by the time the transition starts and it snaps into place.
      requestAnimationFrame(() => requestAnimationFrame(() => wrap.classList.add('open')));
      panel.focus({ preventScroll: true });
    }

    function close({ fromHistory = false } = {}) {
      if (!open) return;
      open = false;
      wrap.classList.remove('open');
      // Let it slide out before the iframe goes; dropping the iframe first would
      // leave a bare panel sliding away. Gone rather than hidden, so a graph left
      // open is not still polling behind the tab you went back to.
      sweep = setTimeout(() => {
        wrap.hidden = true;
        if (frame) {
          frame.remove();
          frame = null;
        }
      }, SLIDE_MS);
      if (pushed && !fromHistory) history.back();
      pushed = false;
    }

    document.addEventListener('click', (e) => {
      if (!plain(e)) return;
      const a = hit(e, 'a[href]');
      if (!a) return;
      const url = detailUrl(a.getAttribute('href'));
      if (!url) return;
      e.preventDefault();
      show(url);
    });

    addEventListener('popstate', () => close({ fromHistory: true }));

    // Capture, and swallowed: with a drawer up, Escape means the drawer, not the
    // open card the tab underneath would otherwise close.
    addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || !open) return;
        e.preventDefault();
        e.stopPropagation();
        close();
      },
      true
    );

    addEventListener('message', (e) => {
      if (e.origin !== location.origin || !frame || e.source !== frame.contentWindow) return;
      const msg = e.data || {};
      if (msg.type === CLOSE) close();
      else if (msg.type === TITLE) setTitle(msg);
      else if (msg.type === OPEN) {
        const url = detailUrl(msg.url);
        if (url) load(embedded(url));
      }
    });
  }

  /* ---------------------------------------------------------- in the drawer */

  function drawer() {
    document.documentElement.classList.add('in-drawer');
    const post = (msg) => parent.postMessage(msg, location.origin);

    // The page's own top bar is hidden in here — one drawer, one header — so what it
    // said has to go somewhere, and it goes up to the panel's. Watched rather than
    // read once: the graph renames itself every time the scope toggle moves between
    // one bead and the whole workspace, and a header that froze on the first name
    // would be quietly lying from the second tap on.
    const kind = location.pathname.startsWith('/doc')
      ? 'doc'
      : location.pathname.startsWith('/session')
        ? 'session'
        : 'graph';
    const heading = document.querySelector('.topbar h1');
    const sendTitle = () => post({ type: TITLE, kind, title: (heading ? heading.textContent : document.title).trim() });
    sendTitle();
    if (heading)
      new MutationObserver(sendTitle).observe(heading, { childList: true, characterData: true, subtree: true });

    // Capture, so this lands before the page's own handler rather than after it:
    // the ✕ means "close this", and in here that is the drawer — not window.close(),
    // which an iframe cannot do, and not a jump to the inbox, which would bury the
    // tab you came from under a second copy of the app. The page's own ✕ is hidden
    // in here now, so this is a backstop rather than the path a thumb takes: a
    // stylesheet that has not landed yet must not leave a live button that navigates
    // the whole app away.
    document.addEventListener(
      'click',
      (e) => {
        if (!plain(e)) return;
        const el = hit(e, 'a[href], button');
        if (!el) return;
        if (el.matches('#doc-close, #graph-close, [data-drawer-close]')) {
          e.preventDefault();
          e.stopPropagation();
          post({ type: CLOSE });
          return;
        }
        const url = el.tagName === 'A' && detailUrl(el.getAttribute('href'));
        if (!url) return;
        // A sibling document, or a bead's graph: the drawer is already the right
        // shape for it, so it retargets rather than opening a tab behind the app.
        e.preventDefault();
        e.stopPropagation();
        post({ type: OPEN, url });
      },
      true
    );

    // A swipe right dismisses — but only from somewhere that has nothing else to do
    // with a horizontal drag. The graph pans, a wide table or a code block scrolls
    // sideways, and stealing those would make the gesture feel broken in the view
    // that most needs it to be predictable.
    const KEEPS_ITS_OWN = 'svg, .graph-main, .sheet, pre, table, input, textarea, select';
    let x0 = 0;
    let y0 = 0;
    let live = false;
    addEventListener(
      'touchstart',
      (e) => {
        live = e.touches.length === 1 && !hit(e, KEEPS_ITS_OWN);
        if (live) {
          x0 = e.touches[0].clientX;
          y0 = e.touches[0].clientY;
        }
      },
      { passive: true }
    );
    addEventListener(
      'touchend',
      (e) => {
        if (!live) return;
        live = false;
        const t = e.changedTouches[0];
        if (t.clientX - x0 > 64 && t.clientX - x0 > Math.abs(t.clientY - y0) * 2) post({ type: CLOSE });
      },
      { passive: true }
    );
  }

  /* ------------------------------------------------------------- the way out */

  /**
   * What the ✕ on a subordinate view does. The rule is in this file's header; this
   * is the whole of the code that implements it, and every ✕ that means "close this
   * view" calls it rather than deciding for itself.
   *
   * Exported rather than wired to a selector, because the three pages that need it
   * already have their own buttons and their own reasons to be doing something else
   * first — `/session` posts its presence away, and a page that grows a "are you
   * sure" one day needs to run before the exit, not instead of it.
   */
  function closeView() {
    // In a drawer. The ✕ inside the panel is drawer.js's own and never reaches here;
    // this is the page's own button, which the capture handler above normally takes
    // first. It is still worth answering: a stylesheet that has not landed leaves
    // that button live, and navigating an iframe to the inbox would paint a second
    // copy of the whole app inside the panel.
    if (window.top !== window.self) {
      parent.postMessage({ type: CLOSE }, location.origin);
      return;
    }
    // A tab this app opened is one it can give back. Called unconditionally rather
    // than behind a `window.opener` test: `rel=noopener` and the Android shell both
    // leave the opener null on tabs that can nonetheless be closed, and a browser
    // that refuses simply does nothing.
    window.close();
    // Still here, so it refused, or there was no tab to close: the inbox.
    setTimeout(() => {
      location.href = HOME;
    }, CLOSE_MS);
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.closeView = closeView;

  // A detail page opened on its own is left exactly as it was — no drawer over a
  // drawer's worth of the same thing, and the standalone page stays the fallback a
  // pasted URL lands on. It still gets `closeView` above, which is the half of this
  // file such a page does need: it has a ✕ and it has to mean something.
  if (window.top !== window.self) drawer();
  else if (!DETAIL.has(location.pathname)) tab();
})();
