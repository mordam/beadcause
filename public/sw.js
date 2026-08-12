/* Cache the shell so the inbox opens instantly and the 3.5 MB mermaid bundle is
   fetched once. API traffic is never cached — an answered question must vanish. */

/*
  The version below is this app's one guarantee that the files a phone is holding agree
  with each other. `activate` deletes every cache whose key is not this one, and
  `install` re-fetches the whole of SHELL as a single all-or-nothing `addAll` — so
  moving it hands the phone one generation of the shell, and leaving it lets the phone
  go on serving whatever mixture of old and new files it happens to have.

  **Whether a change owes a bump is not "did I touch public/".** It is: does this change
  leave a mixed pair of my own files that is *broken* rather than merely *older*? Broken
  is a new script calling a function its cached sibling does not have yet, markup whose
  script is not on the cached page, or — the case that actually bites — a stylesheet
  that lays out a control the cached page draws anyway. Merely older is a purely
  additive file nothing else reaches for: cached HTML without the new tag is the app as
  it was, and that legitimately skips the bump. `test/swbump.mjs` reads your branch and
  says which of the two it thinks you have; every note in `docs/sw-cache/` argues one of
  them, and the two or three nearest yours are the quickest way to check its answer.

  **The argument for each version is its own file, `docs/sw-cache/vNN.md`.** It used to
  be a comment block right here, appended to by every branch that bumped — which made
  the top of this file the most conflict-prone region in the repo, with around eight
  worker sessions live at once (bc-5ghk). One file per version is the fix
  `scripts/test.mjs` already made for the suite list: bumping means *adding a file*, and
  two branches that add different files do not conflict at all.

  **The name is exactly `vNN.md`, and that is load-bearing.** Two branches that both
  pick v39 then collide on one path, which git reports as an add/add conflict — and
  being told is the entire point, because the `const` below will not tell you: two
  branches that write the identical string to it merge clean and in silence, leaving two
  changes under one cache key and a cache that never invalidates. A slug in the name
  (`v39-chat-tabs.md`) would let both of them land quietly, so there is not one.

  **When it does conflict, keep both notes and renumber yours** to the next free number
  — `git mv docs/sw-cache/v39.md docs/sw-cache/v40.md` — moving the version pairs named
  *inside* its prose up with it, because that prose is the only record of which two
  files must not be mixed. Then set the `const` by hand, to the highest number in the
  directory, and re-read the line: git may well have merged it silently. `node
  test/swcache.mjs` checks precisely that, in about a second.
*/
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
