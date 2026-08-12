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
/* v25: /monitor became the space details screen — the selected space's own settings,
   written from the page through `POST /api/space`, plus a gear to /admin. No new path:
   monitor.html, monitor.js and style.css are all already in the shell. The version is
   what makes the three arrive together, and they have to: a phone holding v24's cached
   monitor.js beside v25's monitor.html would draw a gear over a page with no settings
   card, and one holding v25's script against v24's stylesheet would draw seven controls
   with no layout at all — a wall of unstyled buttons over the advocate cards. */
/* v26: the warm layer. `/warm.js` is a new path *and* all five standing pages now
   boot through it — app.js, prs.js, monitor.js, console.js and admin.js each ask it
   for the payload they had last time before asking the daemon for a fresh one, and
   the inbox draws its list through its reconciler. A phone holding v25's cached
   app.js beside v26's would call a file that is not there on every repaint; one
   holding v26's app.js without the file would fall back to the whole-list rebuild
   and a cold fetch per tab, which is the entire thing being fixed. They have to
   arrive together, which is what a cache version is for. */
/* v27: two tabs left the bar in the same breath, and each put its rows in the inbox.
   Pull requests became cards: `/prcard.js` is a new path *and* four cached files
   disagree without it — tabbar.js no longer draws the PRs tab, app.js draws cards it
   cannot render without prcard.js, inboxfilter.js builds its status sub-filter off the
   ladder in it, and prs.js takes its own row renderer from it, so a board page cached at
   v26 beside a v27 prs.js is a blank board. Chat went the same way with no new path at
   all, which is the more dangerous half: index.html without app.js is a ＋ that does
   nothing when tapped, app.js without index.html is an inbox whose rows say
   `data.consoles` and whose create button is not on the page, and either without
   style.css is a floating button with no shape sitting over the last card. Every one of
   those is an old app that looks complete — a bar with both tabs still on it most of all
   — which is the failure a version exists to prevent. */
/* v28: you can talk about an unendorsed bead before deciding on it. No new path — the
   discussion panel is part of endorse.js — which is exactly why the version has to
   move: a phone holding v27's cached style.css beside v28's endorse.js draws the thread,
   the agent chips and the ask box with none of the rules that make them a panel rather
   than a run of unstyled paragraphs under the verdicts, and one holding v27's endorse.js
   against the new daemon simply has no Discuss button and no 💬 count on a row that has
   a thread on it — which is the state this feature exists to end. Two cached files that
   have to arrive together is the whole job of a cache version. */
/* v29: tapping a pull request opens it full screen, with merge, close, comment and the
   conflict path (bc-l8jp.7). No new path — app.js and style.css are both already here —
   and that is exactly why the version has to move: the two have to arrive together. A
   phone holding v28's app.js beside v29's stylesheet draws a row whose tap still goes to
   GitHub; one holding v29's app.js against v28's stylesheet opens the sheet with no facts
   column, no pinned action bar and a comment box the buttons sit on top of. Both look like
   a working app, which is the failure a cache version exists to prevent. */
/* v30: every view moved onto the delta stream. `/stream.js` is a new path *and* all five
   standing pages mount it in place of the `setInterval` they used to refresh on — so a
   phone holding v29's cached admin.js, monitor.js or prs.js beside a v30 daemon still has
   the ten-second sweep this removed, and one holding v30's scripts without the file has
   four pages that never refresh at all: the timer is deleted in the same change that adds
   the poll, and nothing else brings a row up to date. That is the strictest version of
   what a cache version is for — the failure is not a broken page, it is a page that looks
   right and is quietly hours out of date. */
/* v31: the reader tab can publish a document to Confluence (bc-c6qp). No new path —
   doc.html, doc.js and style.css are all already here — and the three have to arrive
   together: a phone holding v30's doc.html beside v31's doc.js has nowhere to draw the
   footer into, so the button silently never appears; one holding v31's doc.html against
   v30's stylesheet draws an unstyled block of text under every document it opens, with
   an accent-coloured button in the middle of it. app.js moves too, because the link that
   opens a document from a card now carries the bead — and that is the only reason the
   published URL can end up on the bead instead of only in the daemon's state. */
/* v32: the session view grew a button that brings that session's iTerm window to the
   front of the Mac and doubles it, and puts it back when you close the view (bc-fwsw).
   No new path — session.js and style.css are both already here — and that is why the
   version has to move: a phone holding v31's session.js beside v32's stylesheet draws
   no button at all, and one holding v32's session.js against v31's stylesheet drops an
   unstyled button into the middle of a label row and sizes the transcript as though it
   were not there, pushing the log off the bottom of the phone. Both look like a working
   page, which is the failure a cache version exists to prevent. */
/* v33: the Advocates tab is preloaded and then *kept* warm off the delta stream rather
   than left to age out of the warm layer (bc-xxzz). No new path — app.js, warm.js,
   stream.js and monitor.js are all already here — and all four have to arrive together,
   in both directions. monitor.js now asks `stream.workMoved(events)` instead of carrying
   its own copy of that judgement, so a phone holding v33's monitor.js beside v32's
   stream.js throws inside its wake handler and the advocates page stops refreshing
   altogether; one holding v32's app.js beside v33's warm.js has the reordered background
   warm but nothing that maintains what it fetched, which is the bug this change is about
   still being there behind a version that says it is fixed. Only the other direction is
   safe by construction: v32's warm.js under v33's app.js has no `refresh`, and app.js
   looks for it and does nothing — that page is as cold as it was and no more expensive,
   which is the fallback the warm layer promises everywhere else. */
/* v34: the History tab (bc-nib3.2). `/history`, `/history.html` and `/history.js` are
   new paths *and* `/tabbar.js` moves in the same change, which is the pairing that makes
   this a version bump rather than three additions to the list. A phone holding v33's
   cached tabbar.js has a three-tab bar with no History on it, so the page behind the new
   paths is unreachable from every screen in the app; one holding v34's tabbar.js without
   the three new entries has a tab that 404s out of the cache the moment the tailnet is
   slow — a bar whose whole job is that you can always leave a page, with an entry that
   goes nowhere. The bar and the page it points at have to arrive together, which is what
   a cache version is for. */
/* v35: the ✕ on the inbox's chat cards (bc-vau1). No new path — app.js and style.css are
   both already here — and it is the v32 pairing again, in both directions. A phone
   holding v34's app.js beside v35's stylesheet draws the row it always did and nothing
   else, because there is no ✕ in that app.js to lay out; one holding v35's app.js
   against v34's stylesheet drops a full-width ✕ *underneath* every chat row, since the
   card only became a flex wrapper in the new stylesheet and the button is a sibling of
   the link now rather than something inside it. The second is the one that matters:
   every conversation in the inbox is suddenly two rows tall with a stray button between
   them, and it still works, which is exactly the "looks like a working page" failure a
   cache version exists to prevent. */
/* v36: how a closed bead ended, on the bead detail sheet (bc-9cpg). No new path —
   graph.js and style.css are both already here — and it is the v32/v35 pairing once
   more, in both directions. A phone holding v35's graph.js beside v36's stylesheet
   opens the sheet it always did: the status pill says "closed" and nothing on the
   screen says why, which is the hole this closes. One holding v36's graph.js against
   v35's stylesheet is the direction that matters — `.closed-note` has no rules there,
   so a close reason that runs to 1664 characters lands as an unframed wall of prose
   between the pills and the title's own description, with a bare date line above it
   and nothing marking where the bead's own text starts. It reads as the description,
   which is the "looks like a working page" failure a cache version exists to prevent.
   */
/* v37: a strip of handles over the chat session, one per chat you have open (bc-2tr).
   No new path — console.html, console.js and style.css are all already here — and it is
   the v32 pairing again, in both directions. A phone holding v36's console.html
   beside v37's console.js has no `#chat-tabs` to draw into: the strip is guarded, so
   that half is merely the page as it was, which is the direction this is allowed to
   fail in. The other is not. v37's console.html against v36's stylesheet draws the nav
   as a run of unstyled links and ✕s across the top of the page, above the launcher and
   above every conversation — no pill, no truncation, and the horizontal scroll that
   makes a strip a strip replaced by six chat titles wrapping onto four lines and
   pushing the transcript off the bottom of the phone. It still works, which is exactly
   the "looks like a working page" failure a cache version exists to prevent. */
/* v38: what a session left behind, and the way in to it — `/bead-session?workspace=&id=`
   (bc-nib3.5) plus the row on the bead detail sheet that opens it (bc-nib3.6). Three new
   paths, and both halves of the pairing bite. A phone holding v37's style.css against
   v38's beadsession.js draws the three "not available" sentences and the memory block
   with no styling at all, which on the page that says nothing is there most of the time
   is indistinguishable from a page that failed to load. And the sheet's own half is the
   v32/v36 pairing once more: v37's graph.js beside v38's stylesheet opens the sheet it
   always did, with no way through to the session — merely the app as it was, which is
   the direction this is allowed to fail in — while v38's graph.js against v37's
   stylesheet lands `.sheet-session` as an unframed line of text between the pills and
   the description, reading as part of the bead's own prose rather than as the one thing
   on the sheet you can tap through to. It still works, which is exactly the "looks like
   a working page" failure a cache version exists to prevent. */
/* v39: the space details card grew the two Slack rows — the channel a space posts to
   and how much of the question goes in it (bc-ikj6). No new path: monitor.js and
   style.css are both already here, and it is the v32 pairing again. The harmless
   direction is v38's monitor.js against v39's stylesheet, which is the card as it was
   with one unused rule behind it. The other is not: v39's monitor.js beside v38's
   style.css draws the channel row's text field with no box, no height and no width rule
   at all — a bare platform input in a row of pill buttons, in the platform's own form
   font, sized to whatever the flex row leaves it, on a 393px screen where the three
   buttons beside it then wrap around it. It still takes a channel id, which is exactly
   the "looks like a working page" failure a cache version exists to prevent. */
/* v40: Endorse all in the endorsement queue's header — one tap for the whole drawn
   list rather than a tick per bead (bc-mf88). No new path: endorse.js and style.css are
   both already here, and it is the v32 pairing again. The harmless direction is v39's
   endorse.js against v40's stylesheet, which is the queue exactly as it was with three
   unused rules behind it. The other is not: v40's endorse.js beside v39's style.css has
   no `.eq-head-row`, so the flex row never forms — the accent-filled button drops onto
   its own line directly under "101 beads waiting on you" and above the subtitle, full
   bleed across a 393px screen, which is both the shape and the position this control was
   deliberately not given. And when it arms, `.eq-all-hint` is missing too, so the
   sentence naming the count and every repo the tap covers renders at body size in the
   middle of the header rather than as a hint under the button, reading as the page's own
   prose rather than as the question it is. It still endorses the right beads, which is
   exactly the "looks like a working page" failure a cache version exists to prevent —
   and here the working page is one whose most consequential button is the biggest thing
   on the screen and no longer says which tap does what. */
const CACHE = 'beadcause-v40';
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
  // What each of the five standing pages boots from. In the shell rather than left to
  // network-first because the whole point of it is the first frame after a tab tap:
  // a page that has to fetch its cache before it can read it has already lost the
  // wait it exists to remove.
  '/warm.js',
  // How each of those five pages stays current: one long poll on the daemon's event
  // log, mounted in place of the timer each of them used to refresh on. In the shell
  // for a stronger reason than warm.js is — a cached page without it does not merely
  // start slower, it never updates, because the `setInterval` it replaced is gone.
  '/stream.js',
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
  // And the fourth: the same detail for a session that has *finished*, addressed by bead
  // rather than by pid. Its own paths because it is its own document — a pid stops
  // identifying anything once the process is gone, and this is the page you reach from a
  // bead that closed months ago. `/archive` is here because it is a path a person types.
  '/bead-session',
  '/archive',
  '/beadsession.html',
  '/beadsession.js',
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
  // The ledger. In the shell because it is a tab: every tab has to open instantly from
  // the bar whatever the link is doing, and this is the one page in the app you might
  // reasonably open *because* you are somewhere with no signal and are trying to
  // remember what happened to something. Its rows come from /api/history, which is
  // never cached — so offline it is an honest empty list rather than a stale one.
  '/history',
  '/history.html',
  '/history.js',
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

/* ------------------------------------------------------------------ reporting */

/*
  The worker's own failures, handed to a page so the page can report them (bc-u3g4).

  public/report.js put a reporter on every page and it cannot see this file at all: a
  service worker runs in its own global, with its own `self.onerror`, and it does not
  load page scripts. So the one piece of the app whose failures are hardest to notice
  was also the only piece with nothing watching it. `caches.addAll(SHELL)` rejecting on
  install — one path in the list that 404s after a rename — leaves the whole shell
  uncached and says nothing; a `cache.put` rejecting on a full phone quietly stops
  anything being stored at all. Both survive a reload, and both look like "the app is a
  bit slow offline".

  **It relays rather than posting, and that is the whole design.** The obvious shape is
  a `fetch('/api/error')` from here, and it is the wrong one twice over. The endpoint is
  behind the daemon token, which lives in `localStorage` — a thing this global does not
  have — so a direct post would work only where Google sign-in is on and the session
  cookie happened to ride along, and would silently 401 everywhere else: reporting that
  reports nothing is worse than no reporting, because it reads as no errors. And
  report.js is four hundred lines of judgement about *what not to file* — the
  eight-per-minute cap, the thirty-second cooldown, the deploy quiet window, the
  credential scrub, the shutter on `pagehide` — every one of which was a false P0 filed
  on a page that was working perfectly. A second copy of that here would drift from the
  first. So this end does the one thing only it can do (notice), and the page does the
  one thing only it can do (send).

  **It cannot loop.** The relay is a `postMessage`, not a request, and the report itself
  leaves the page as `POST /api/error` — which the fetch handler below ignores twice
  over, being neither a GET nor outside `/api/`. There is no path by which the failure
  of a report re-enters this file.

  **A failure with no page open is dropped, not queued.** `clients.matchAll` answers an
  empty list when nothing is on screen, and a worker holding reports for the next visit
  would be a worker replaying a storm into a daemon that has just come back up — the
  same argument report.js makes about the deploy window. Every event this file can raise
  (install, activate, fetch) is raised *because* a page asked for something, so the empty
  case is close to hypothetical anyway.
*/

/** What report.js listens for. Changing it means changing both files. */
const REPORT_MESSAGE = 'beadcause:sw-error';

/**
 * How long one distinct worker failure waits before it is relayed again.
 *
 * The page caps and dedupes on its own, so this is not what stops a bead per frame; it
 * stops a `postMessage` per request from a worker whose cache has gone bad, which would
 * be several hundred a minute at exactly the moment the phone can least spare them.
 * Deliberately the same thirty seconds report.js uses, so the two ends agree about what
 * "again" means.
 */
const RELAY_REPEAT_MS = 30 * 1000;

/** The last time each distinct failure was relayed. Reset whenever the worker is. */
const relayed = new Map();

/**
 * Say that something failed here, to whichever page is on screen.
 *
 * Wrapped whole in a `try` for the reason report.js's funnel is: this runs on the error
 * path of a worker that is already having a bad time, and throwing from the handler
 * meant to record a failure is the one outcome worse than losing the record.
 *
 * No explicit `source` goes with it, deliberately. The daemon fingerprints a report by
 * source-and-line first (lib/errors.js), and a constant `/sw.js` with no line would make
 * every distinct failure in this file — a broken install, a full cache, a bad request —
 * match each other and comment onto one bead. The stack carries a real frame where the
 * browser has one, and where it does not the message alone is the honest key.
 */
function report(where, error) {
  try {
    const detail = (error && (error.message || error.name)) || String(error);
    const message = `service worker — ${where}: ${detail}`;
    const now = Date.now();
    const last = relayed.get(message);
    if (last !== undefined && now - last < RELAY_REPEAT_MS) return;
    // One entry per distinct failure, and a worker with more than this many has nothing
    // left worth deduplicating.
    if (relayed.size > 32) relayed.clear();
    relayed.set(message, now);
    self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then((all) => {
      // The focused page first, because it is the one whose report.js is certainly
      // running and not about to be discarded. Only one is told: two pages reporting one
      // failure is two requests racing the daemon's own dedupe for one bug.
      const client = all.find((c) => c.focused) || all[0];
      if (!client) return;
      client.postMessage({ type: REPORT_MESSAGE, message, stack: String((error && error.stack) || '') });
    }, () => {});
  } catch {
    /* never from here */
  }
}

/**
 * The backstop, for anything this file throws outside the three handlers below.
 *
 * A worker's global `error` and `unhandledrejection` are the same two events report.js
 * hangs a page off, and they are here for the same reason: the failures worth having are
 * the ones nobody thought to wrap.
 */
self.addEventListener('error', (event) => {
  report('uncaught', (event && event.error) || { message: (event && event.message) || 'an error with no message' });
});

self.addEventListener('unhandledrejection', (event) => {
  report('unhandled rejection', event && event.reason);
});

/* ------------------------------------------------------------------ lifecycle */

/**
 * The headline case, and the one this reporting is mostly about.
 *
 * `addAll` is all-or-nothing: one path in SHELL that 404s after a rename rejects the
 * whole thing, nothing at all is cached, and the only symptom is an app that is slow —
 * for as long as this version of the worker lives.
 *
 * Reported and then **re-thrown**. Swallowing it would leave the browser believing the
 * install succeeded over a cache that is empty, which is the same silence one layer
 * down.
 */
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
      .catch((err) => {
        report(`install — the shell could not be cached (${SHELL.length} paths)`, err);
        throw err;
      })
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
      .catch((err) => {
        report('activate — the old caches could not be swept', err);
        throw err;
      })
  );
});

self.addEventListener('fetch', (e) => {
  let url;
  try {
    url = new URL(e.request.url);
  } catch (err) {
    // Not reachable from a browser, which does not dispatch a fetch for a URL it could
    // not parse — which is exactly why it is worth a line rather than a crash: if it
    // ever happens, the alternative is a handler that throws on every request the app
    // makes, silently, from inside the thing serving them.
    report('fetch — the request URL could not be read', err);
    return;
  }
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return;

  // Vendor bundles are immutable: cache-first.
  if (url.pathname.startsWith('/vendor/')) {
    e.respondWith(caches.match(e.request).then((hit) => hit || fetchAndStore(e.request)));
    return;
  }

  // Everything else: network-first, cache as the offline fallback.
  e.respondWith(fetchAndStore(e.request).catch(() => fallback(e.request, url)));
});

/**
 * What answers when the network did not — and what is worth reporting about it.
 *
 * **Being offline is not a failure**, and that is the line that keeps this from filing a
 * bead every time the phone goes into a tunnel. A rejected `fetch` is expected here, and
 * a hit out of the cache is the whole point of having one. What is *not* expected is the
 * cache itself refusing to answer: a `caches.match` that rejects is storage gone bad or
 * evicted out from under an installed app, and today that is a blank screen with nothing
 * said anywhere.
 *
 * The last resort stays what it was — the index page, answered to a request for
 * something else, which is a deliberate trade for an offline navigation. When even that
 * is missing the request is rejected rather than answered with `undefined`: both are a
 * network error to the browser, but one of them says which request it was.
 */
function fallback(request, url) {
  // Made up front and compared by identity below, because the two ways this can end
  // without a response have to be told apart and their messages cannot do it: an empty
  // cache is a phone that has never been online, and a *rejecting* cache is storage that
  // has gone bad under an installed app. Only the second is worth waking anybody for.
  const missing = new Error(`nothing cached for ${url.pathname}`);
  return caches
    .match(request)
    .then((hit) => hit || caches.match('/'))
    .then((hit) => {
      if (hit) return hit;
      throw missing;
    })
    .catch((err) => {
      if (err !== missing) report(`fetch — the cache could not answer ${url.pathname}`, err);
      throw err;
    });
}

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
      // Nothing waits for the store, and nothing ever did — the response goes back to
      // the page either way. What is new is that the *failure* to store is said out
      // loud: a phone with no room left rejects every `put`, so the cache stops being
      // maintained and the app goes on working perfectly until the day it is offline.
      // That was an unhandled rejection in a worker nobody was watching.
      caches
        .open(CACHE)
        .then((c) => c.put(request, copy))
        .catch((err) => report('cache — a response could not be stored', err));
    }
    return res;
  });
}
