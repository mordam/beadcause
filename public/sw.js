/* Cache the shell so the inbox opens instantly and the 3.5 MB mermaid bundle is
   fetched once. API traffic is never cached — an answered question must vanish. */
/* v18: /session became a page of its own (v17), and then the sessions page it was
   folded inside went away and `/sessions` began serving the advocate console. Both
   changed this list, so both had to move the version — an installed worker would
   otherwise go on handing the phone the cached /work.html shell, and a document
   deleted from the repo would keep opening from the home screen for as long as the
   cache lived. */
/* v19: /session grew a composer. No new path — the code is in session.js and the styles
   in style.css, both already here — but a phone holding v18 would cache a page that
   offers no way to answer a session, and the one thing worse than not having the box is
   having it on the laptop and not on the phone. */
/* v20: the answer box grew a microphone. `/dictate.js` is a new path and app.js asks
   it, at render time, whether to draw the mic at all — so a phone holding v18's cached
   app.js beside v20's would draw an answer box with no way to dictate into it, and a
   phone holding the new app.js without the new file would draw one every time and
   never listen. They have to arrive together, which is what a cache version is for. */
/* v21: Google sign-in. Nothing new in the shell — the login page is deliberately NOT
   cached, see fetchAndStore — but a phone holding v20's cache has app.js from before
   `needCredential` existed, which pops the token dialog at a browser that is signed in
   perfectly well. The version is also what evicts anything a v20 worker cached while
   the session had expired: it was network-first, so a redirect to /login could have
   been stored under `/`. */
/* v22: the space picker. `/spacebar.js` is a new path *and* every page's own script now
   asks it what to draw — app.js, prs.js, monitor.js, console.js and foundations.js all
   register on it — so a phone holding v21's cached app.js beside v22's picker would draw
   a dropdown nothing obeyed, and a phone holding v22's app.js without the file would draw
   the inbox with neither the picker nor the two chip rows it replaced: no way at all to
   change which repo you are looking at. They have to arrive together, which is what a
   cache version is for. */
/* v23: the inbox filter collapsed into one hover-open line, and grew a chip per kind
   of incoming thing. `/inboxfilter.js` is a new path *and* app.js now hands it the
   scope group and asks it whether each row is in view — so a phone holding v22's cached
   app.js beside v23's file would draw a panel nothing read, and a phone holding v23's
   app.js without the file would draw an inbox with no scope switch at all: the chips
   that used to be a permanent row are inside the new control, and nothing else draws
   them. They have to arrive together, which is what a cache version is for. */
/* v24: the endorsement queue. `/endorse` and its script are new paths, and index.html
   grew the 🗳️ that opens it — so a phone holding an older cached inbox would have
   neither the door nor the page behind it, and one holding the old `/` beside a v24
   daemon would show a top-bar button that 404s out of the cache the moment the tailnet
   is slow. The page they have to arrive with is the whole point of the version. */
/* v25: pull requests stopped being a tab and became inbox cards. `/prcard.js` is a new
   path *and* four cached files disagree without it: tabbar.js no longer draws the PRs
   tab, app.js draws cards it cannot render without prcard.js, inboxfilter.js builds its
   status sub-filter off the ladder in it, and prs.js takes its own row renderer apart
   from it — a board page cached at v24 beside a v25 prs.js is a blank board. Every one of
   those is an old app that looks complete, which is the failure a version exists to
   prevent. */
const CACHE = 'beadcause-v25';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  // The answer's flight to the mark. In the shell rather than left to network-first
  // because it is loaded on the tap that answers a question — the one moment the
  // link is least likely to be there and most likely to be slow.
  '/absorb.js',
  // The mic on the answer box. In the shell rather than network-first because the one
  // moment it is wanted is the moment a notification was opened on a phone that has
  // just woken up — the same argument as absorb.js above.
  '/dictate.js',
  // The bottom tab bar, on every standing view. Every one of them is useless
  // without it now — it is the only way off a page — so it belongs in the shell
  // rather than being fetched once per page over a phone link.
  '/tabbar.js',
  // The space picker in the top bar, on the same five pages and for the same reason: a
  // page cached without it is a page with no way to change which repo the app is about,
  // and on the inbox it is what the space and workspace chip rows became.
  '/spacebar.js',
  // The inbox's own filter — the scope switch and the kind chips, in one collapsed
  // line. In the shell for the same reason the picker is: without it the inbox has no
  // control on it at all to say which slice of the tracker you are looking at.
  '/inboxfilter.js',
  // One pull request, drawn once, for the inbox's cards and the board's rows. In the
  // shell because the inbox is: a cached inbox without it draws no PR cards at all, and
  // the filter reads the status ladder off it to build its sub-filter.
  '/prcard.js',
  // On every page that can open a detail drawer, and on both pages that can be one.
  '/drawer.js',
  '/doc.html',
  '/doc.js',
  '/graph.html',
  '/graph.js',
  // The third page a drawer can be: one session's facts and its transcript, linked
  // from every list in the app that names a session. In the shell for the same reason
  // /graph and /doc are — it is opened by a tap on a row, over a page you are already
  // reading, and fetching it fresh on that tap is the slowest moment to do it.
  '/session',
  '/session.html',
  '/session.js',
  // The pull request board. Both paths, the same way the advocate console has five:
  // /pulls is what you type when GitHub's own word for the tab is the one in your head.
  '/prs',
  '/pulls',
  '/prs.html',
  '/prs.js',
  // The endorsement queue. Three paths for one page, the same bargain the console
  // makes with its five: /endorse is what the 🗳️ in the inbox points at, /queue is
  // what you type, and /endorsements is what a notification could carry later.
  '/endorse',
  '/queue',
  '/endorse.html',
  '/endorse.js',
  '/console.html',
  '/console.js',
  // console.js does not merely use the send queue, it is built on it — the composer
  // takes its words from it. A cached console.html that could not fetch this would
  // be a blank screen rather than a degraded one, which is why it is in the shell
  // and not left to network-first.
  '/sendqueue.js',
  // The advocate console, and the sessions view it absorbed. Five paths for one page:
  // launchd opens '/monitor', '/advocates' is what you guess when typing, and
  // '/sessions', '/work' and '/work.html' are on the phone's home screen and in the
  // Android shell's history. All five are precached, because a redirect target left
  // out of the shell is a home-screen shortcut that only works with a signal.
  '/monitor',
  '/advocates',
  '/sessions',
  '/work',
  '/work.html',
  '/monitor.html',
  '/monitor.js',
  // Pause all / resume all. In the shell for the reason the terminal is: you open
  // it because something needs stopping now, and that is often the moment the link
  // is worst. The page is useless without the daemon — but it says so instantly
  // rather than after a timeout on a blank screen.
  '/admin',
  '/admin.html',
  '/admin.js',
  // The in-app terminal. Worth pre-caching rather than leaving to network-first:
  // it is the one page you open *because* something needs steering right now, and
  // 490 kB of xterm.js over a phone link is a long time to look at nothing.
  '/terminal',
  '/term.html',
  '/term.js',
  '/icon.svg',
  '/vendor/marked.js',
  '/vendor/purify.js',
  '/vendor/xterm.js',
  '/vendor/xterm.css',
  '/vendor/xterm-addon-fit.js',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Vendor bundles are immutable: cache-first.
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetchAndStore(e.request)));
    return;
  }

  // Everything else: network-first, cache as the offline fallback.
  e.respondWith(fetchAndStore(e.request).catch(() => caches.match(e.request).then((hit) => hit || caches.match('/'))));
});

function fetchAndStore(request) {
  return fetch(request).then((res) => {
    // Never store what came back from a redirect, and never store the login page.
    //
    // With sign-in on, a page requested without a credential answers 302 → /login
    // (lib/server.js). `fetch` follows that, so `res.ok` is true and the body is a
    // login screen — which, cached under `/`, is what an offline phone would be shown
    // for as long as the cache lived, signed in or not. The shell is only ever cached
    // from a response that really was the page asked for.
    const login = res.redirected || new URL(res.url || request.url).pathname === '/login';
    if (res.ok && !login) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(request, copy));
    }
    return res;
  });
}
