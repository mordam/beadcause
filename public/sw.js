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
const CACHE = 'beadcause-v99';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  // The answer's flight to the mark. In the shell rather than left to network-first
  // because it is loaded on the tap that answers a question — the one moment the
  // link is least likely to be there and most likely to be slow.
  '/absorb.js',
  // And the queue those writes go on. The strongest shell argument of any file here:
  // the one moment it is wanted is the moment the link is bad, because a link good
  // enough to fetch it is a link the write would have gone straight out over. A page
  // cached without it answers questions one blocking round trip at a time.
  '/submitqueue.js',
  // The mic on the answer box. In the shell rather than network-first because the one
  // moment it is wanted is the moment a notification was opened on a phone that has
  // just woken up — the same argument as absorb.js above.
  '/dictate.js',
  // What the URL hash means — a view, a card to open on Home, or nothing. In the shell
  // because the two files below and above it call into it flat on boot: the row asks it
  // which view this address is, and the inbox asks it whether the hash names a card. A
  // page cached without it is a page that throws before it draws.
  '/hashroute.js',
  // The shell's panes — one container per view in index.html, and which of them the hash
  // is showing. In the shell for the same reason the grammar above it is: it is loaded on
  // the one page that is the app, it runs on boot, and a page cached without it is a page
  // whose views are three divs with no rule about which of them is up.
  '/panes.js',
  // And what fills them: the staged boot that builds the landed-on pane first and the
  // rest after the first paint, and the one poll it fans out to all of them. In the shell
  // beside panes.js and for the same reason — it runs on boot on the one page that is the
  // app, and a page cached without it is a page whose panes never get built at all.
  '/panestage.js',
  // The host for the views the repos declare about themselves. In the shell because it
  // is loaded on the one page that is the app and because the panes it adopts are the
  // only way to reach those views at all — a page cached without it is a page where a
  // repo's board is not merely stale but absent, with no pill saying it ever existed.
  // What it hosts is *not* precached: a repo's script and its payload come from that
  // repo's checkout, which only the daemon can read.
  '/viewhost.js',
  // The pill row across the top of every page. Every one of them is useless without it
  // — it is the only way off a page — so it belongs in the shell rather than being
  // fetched once per page over a phone link.
  '/viewbar.js',
  // How the app finds out that what it is made of has moved — the reload after a deploy
  // that changed public/, and the download-ask-install-restart the shell does when one
  // rebuilt the APK. In the shell rather than network-first because the moment it is
  // wanted is the moment a deploy has just ended: a page fetching it over a tailnet the
  // daemon is restarting on would miss the one event it exists to hear.
  '/update.js',
  // The space picker in the top bar, on the same five pages and for the same reason: a
  // page cached without it is a page with no way to change which repo the app is about,
  // and on the inbox it is what the space and workspace chip rows became.
  '/spacebar.js',
  // The account switcher beside it, and in the shell for a stronger version of the same
  // reason: a page cached without this file has no way to change which *life* the app is
  // about — and, because the menu is where the page's own top-right buttons now live, no
  // refresh, no endorsement queue and no way out to a browser either.
  '/accountbar.js',
  // Whether the screen is current, and the banner that says when it is not. In the shell
  // for the reason the other two are, taken one step further: the moment this file exists
  // for is a phone that cannot reach the daemon, which is exactly the moment a file that
  // is not cached cannot be fetched. A shell without it is an app that goes quiet about
  // being out of date precisely when it is.
  '/freshness.js',
  // The panel every filter bar in the app is drawn in — the collapsed line, the chips,
  // the hover-and-tap state machine. In the shell because two pages mount it and
  // neither has its whole control without it: the inbox loses the bead search and both
  // status sub-filters, the History tab loses all four of its filters.
  '/filtermenu.js',
  // The filters that are not behind a line — the scope switch on the inbox's chrome
  // (bc-khoe.24). In the shell for the same reason as the panel beside it: a cached page
  // without it draws the collapsed panel and no way at all to say whether you are looking
  // at the questions or at the live beads, which is the one control this app has that
  // decides what a screen is *able* to hold.
  '/filterpills.js',
  // The inbox's own filter — the kinds table behind the pill row, and the bead search
  // and two sub-filters left in one collapsed line. In the shell for the same reason
  // the picker is: without it the inbox draws every row it fetched, with nothing on
  // screen able to narrow it.
  '/inboxfilter.js',
  // Edit mode: the freeze and the anchor. In the shell because the inbox now asks it on
  // every repaint whether it may paint at all — a cached page without it answers false
  // and behaves exactly as it did before, which is survivable. It used to be here for a
  // second reason too, that a page carrying the ✏️ in its markup and not the file behind
  // it has a control that does nothing; bc-p49x.12 parked the button, so the module is
  // now the only way into the mode and a cached page without it has no edit mode at all.
  '/editmode.js',
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
  // The pull request board — a pane of the shell's Advocates view now (bc-d4d5, folded in
  // by bc-khoe.4), drawn by this script wherever that view is up.
  //
  // Its own three paths — /prs, /pulls, /prs.html — are **gone from this list**, under the
  // same rule the ledger's two obey below: they are a 302 now, and `Cache.put` refuses a
  // redirected response. They are the only hops in the app that carry a chip as well as a
  // view, `#advocates?tab=prs`, and `VIEW_HOPS` answers them with it.
  '/prs.js',
  // Releases (bc-khoe.7) — where everything in flight is, and where the deploy strip went
  // when it left the board above. A pane of the shell since bc-khoe.30.14, so the script
  // stays and its three addresses have left this list for `VIEW_HOPS`.
  //
  // The reason it had to be precached has not gone away, it has moved: this is the view you
  // open on a phone precisely when the daemon behind it is being restarted by the deploy it
  // is drawing. The shell is what is cached now, and it carries this script, so the pane
  // still draws with no daemon to ask.
  '/releases.js',
  // The endorsement queue. Three paths for one page, the same bargain the console
  // makes with its five: /endorse is where a held card in the inbox and the advocate
  // console's `N held for endorsement` pill both point, /queue is what you type, and
  // /endorsements is what a notification could carry later. The 🗳️ in the chrome that
  // used to be the main way in is gone (bc-w156) — the page is now reached from the row
  // it is about rather than from a fixed door, which is why it is still in the shell.
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
  // The advocate console, and the sessions view it absorbed — a pane of the shell since
  // bc-khoe.4, drawn by this script.
  //
  // All six of its addresses are **gone from this list**, for the reason the ledger's two
  // are below: launchd opens '/monitor', '/advocates' is what you guess when typing, and
  // '/sessions', '/work' and '/work.html' are on the phone's home screen and in the
  // Android shell's history — and every one of them is a 302 now, which is the one
  // response `Cache.put` refuses. Leaving a single one here would leave *nothing* cached
  // on every installed phone for as long as this worker lived. `VIEW_HOPS` is what
  // answers them when there is no daemon to ask.
  '/monitor.js',
  // The chip row on it, and which of its four panes is up. In the shell because that
  // page is: without this file the chips are dead and three of the four panes — the
  // board, the settings and the mirror — are unreachable from a cached advocates page.
  // (This line is not going anywhere: bc-khoe.30.6 ruled that the row stays a mode
  // switch rather than becoming pills, so bc-khoe.4 folds it into the shell's Advocates
  // pane intact. bc-khoe.1 only took its `--topbar-h` observer, which the app shell made
  // unnecessary.)
  '/montabs.js',
  // The ledger, which is what the pane above draws itself with. In the shell because it
  // is a pill: every pill has to open instantly from the row whatever the link is doing,
  // and this is the one view in the app you might reasonably open *because* you are
  // somewhere with no signal and are trying to remember what happened to something. Its
  // rows come from /api/history, which is never cached — so offline it is an honest
  // empty list rather than a stale one.
  //
  // `/history` and `/history.html` are **gone from this list** and that is not a
  // trimming, it is the same rule `/closed` obeys below: they are a 302 to `/#history`
  // on the daemon now (bc-khoe.30.7, `viewHop` in lib/server.js), the ledger having
  // become a pane of the shell rather than a document, and `Cache.put` refuses a
  // redirected response outright. One of them left here would leave *nothing* cached on
  // every installed phone for as long as this worker lived. Nothing is lost by their
  // going: the document they used to name is `/`, which is the first line in this list,
  // and `VIEW_HOPS` below is what answers them when there is no daemon to ask.
  '/history.js',
  // The selected space's own settings (bc-khoe.10). In the shell because it is a pill:
  // every pill has to open instantly from the row whatever the link is doing. Its rows
  // come from /api/space, which is never cached — so with no daemon it is an honest
  // "can't reach the server" rather than a card of switches that would write nowhere.
  '/config',
  '/settings',
  '/config.html',
  '/config.js',
  // And `/closed` and `/done` are **deliberately not here**, which is the one place in
  // this list where leaving a path out is a decision rather than an oversight.
  //
  // They are the ledger under a shorter name (bc-nib3.7) and every other multi-path page
  // above precaches all of its names, so the obvious next line is to add them. It would
  // break the entire shell. Those two are a **302** on the daemon, not an alias — they
  // have to be, because the filter they set lives in the query string and a rewrite
  // cannot touch that — and `Cache.put` rejects a redirected response outright. `install`
  // below is one all-or-nothing `addAll`, so a single unstoreable path in this list means
  // *nothing* is cached, on every phone, for as long as this worker lives. It would look
  // like an app that had merely got slower.
  //
  // What that used to cost is now nothing, and it took two goes. `fallback` matched on
  // the full URL to begin with, so `/history?status=closed` — the URL those two redirect
  // to, and the one a home-screen shortcut actually holds — missed the cache as cleanly
  // as `/closed` did and landed on the index page too; that half closed with bc-nib3.11
  // and `ignoreSearch`. What was left was the bare `/closed` a person types, and the
  // reason given here for leaving it was that resolving it meant knowing a redirect only
  // the daemon holds. That stopped being true when the ledger became a pane: the far end
  // of the hop is a *fragment of a document this worker already has*, so `VIEW_HOPS`
  // below holds the answer and `fallback` gives it. The two paths are still not in this
  // list, for the reason above, and now nothing depends on their being in it.
  //
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
  // **/sounds is deliberately not here**, and like `/closed` and `/done` above that is a
  // decision rather than an oversight.
  //
  // It is the notification-sound audition (bc-ka5y.15.3): three .wav files played blind
  // so they can be named before bc-ka5y.15.4 cuts the channels they go on. Precaching the
  // page without its sounds would give a phone with no signal a screen of buttons that do
  // nothing, which is worse than the page not being there; precaching the sounds too is
  // 78 kB of audio on every install, forever, for a screen that is opened a handful of
  // times in the life of the app. And an audition is not a thing anybody does offline —
  // every other page in this list is here because you open it *at* the bad moment, and
  // this is the opposite of that.
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
 * The addresses that name a **view** rather than a file, and where each one has to land
 * (bc-khoe.30.7).
 *
 * Every view is a pane of one document now (bc-khoe.30) and the hash is which pane. The
 * old paths still have to work — they are on the phone's home screen, in the Android
 * shell's history and in notifications this app sent months ago — so `lib/server.js`
 * answers each of them with a 302 to `/#<view>`, which is the only shape that can put a
 * fragment on the address bar.
 *
 * **A 302 is exactly what this worker cannot cache**, which is why none of these paths is
 * in `SHELL` and why they need answering here instead. With no daemon to ask, a request
 * for `/history` misses the cache twice over and falls through to `caches.match('/')`
 * below — the shell, served at `/history`, with an empty hash. That is Home, whatever
 * was tapped: the acceptance criterion of the whole change failing in the one place
 * nobody looks, on the phone the aliases exist for.
 *
 * So the worker holds the same table and answers the same hop. It is a redirect rather
 * than the document, deliberately, so that the address ends up saying which view is up —
 * serving `/` here under the old path would draw the right pane once and leave a URL that
 * disagrees with the screen, and the next tap would clear a hash that was never written.
 *
 * **It self-gates as the panes land.** A view whose pane is still `data-pending` keeps
 * its own document, keeps its paths in `SHELL`, and so is answered by the exact match at
 * the top of `fallback` long before this table is consulted — a path only reaches here
 * once it has left the shell, which is the same commit that makes it a redirect.
 * `test/pagealias.mjs` holds this table against `serveStatic`'s own run of `if`s, so the
 * two lists cannot drift.
 *
 * The values are the hash alone. `?t=` and anything else on the way in is carried across
 * by `viewAddress` below, on the same split `viewHop` makes in lib/server.js: what the
 * daemon reads stays in front of the `#`, what the view reads goes behind it.
 */
const VIEW_HOPS = {
  '/history': { view: 'history' },
  '/history.html': { view: 'history' },
  // The advocate console (bc-khoe.4). Six, because the sessions view was merged into it
  // and brought its three with it; `/work.html` and `/monitor.html` are the two with no
  // file left to want them.
  '/monitor': { view: 'advocates' },
  '/advocates': { view: 'advocates' },
  '/monitor.html': { view: 'advocates' },
  '/sessions': { view: 'advocates' },
  '/work': { view: 'advocates' },
  '/work.html': { view: 'advocates' },
  // The board, which is a chip of that view rather than a view of its own — so these three
  // narrow where the six above do not. The pathname is what public/montabs.js used to read
  // to put the chip up, and after a hop there is no pathname left; `tab=prs` in the hash is
  // where that fact lives now.
  '/prs': { view: 'advocates', narrow: [['tab', 'prs']] },
  '/pulls': { view: 'advocates', narrow: [['tab', 'prs']] },
  '/prs.html': { view: 'advocates', narrow: [['tab', 'prs']] },
  // Releases (bc-khoe.30.14).
  '/releases': { view: 'releases' },
  '/deploys': { view: 'releases' },
  '/releases.html': { view: 'releases' },
  // The ledger under the name of the one question it is most often asked (bc-nib3.7).
  // Not in SHELL and never was; the difference is that the answer is now knowable here.
  '/closed': { view: 'history', narrow: [['status', 'closed']] },
  '/done': { view: 'history', narrow: [['status', 'closed']] },
};

/** What the daemon reads off a query string — kept in the search, never swept into the
    hash, because a fragment is not sent to a server. `t` is the pairing token; the same
    set is `DAEMON_QUERY` in lib/server.js. */
const DAEMON_QUERY = new Set(['t']);

/**
 * One entry of `VIEW_HOPS` as an absolute address, carrying the request's own query.
 *
 * Absolute because `Response.redirect` requires it — a relative URL is a `TypeError`,
 * which inside `fallback` would be a rejected promise on the offline path and so an
 * error page rather than the view.
 */
function viewAddress(hop, url) {
  const kept = new URLSearchParams();
  const filters = new URLSearchParams();
  for (const [k, v] of url.searchParams) (DAEMON_QUERY.has(k) ? kept : filters).append(k, v);
  for (const [k, v] of hop.narrow || []) filters.set(k, v);
  const search = kept.toString();
  const query = filters.toString();
  return new URL(`/${search ? `?${search}` : ''}#${hop.view}${query ? `?${query}` : ''}`, url.origin).href;
}

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
    // Then the same path with its query string set aside (bc-nib3.11).
    //
    // `Cache.match` keys on the *whole* URL, and no path in SHELL has ever had a query
    // string on it — so every URL in this app that carries its state in the query was a
    // clean miss here and fell through to the index page below. That is the History
    // tab's four filters (bc-nib3.3) and every shortcut built on them: a phone opening
    // `/history?status=closed&priority=P0` with no signal got the inbox, silently, which
    // is the one moment that page is most worth having.
    //
    // `ignoreSearch` compares the two sides on path alone, so the request resolves to
    // the cached `/history.html` and the page reads its own filters off
    // `location.search` exactly as it does online. The exact match above still goes
    // first, because a cache holding both `/history` and `/history?status=closed` should
    // answer the URL that was asked for rather than whichever went in first.
    //
    // It cannot serve the login page, for the reason that page is never in the cache at
    // all: `fetchAndStore` refuses to store a redirected response or `/login` itself, so
    // there is no entry here for a `/login?next=…` to widen onto. And `/api/*` never
    // reaches this function — the fetch handler returns above it — so no answered
    // question can be resurrected by dropping a query string.
    .then((hit) => hit || caches.match(request, { ignoreSearch: true }))
    // Then: is this address a *view* rather than a file? See `VIEW_HOPS` above. Below
    // the two cache lookups on purpose, so a path that is still precached under its own
    // name is still answered with what was cached under it.
    .then((hit) => hit || (VIEW_HOPS[url.pathname] ? Response.redirect(viewAddress(VIEW_HOPS[url.pathname], url), 302) : null))
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
