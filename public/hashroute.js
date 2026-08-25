/*
  The hash, and the one grammar every reader of it agrees on (bc-khoe.30.2).

  ## Why there has to be a grammar at all

  The URL hash is a single slot and two different things want it. It has meant one thing
  since the app had notifications — `#<workspace>/<beadId>`, a card to open on Home — and
  that form is what `lib/notify.js` puts in every ntfy `click`, what `lib/slack.js` links
  to, and what the Android shell deep-links with. Those URLs are not ours any more. They
  are sitting in a notification shade, in a Slack channel and in the phone's own
  notification history, and a phone opening one a week from now must land where it landed
  the day it arrived. There is no migration available and there never will be: **the old
  form cannot break, ever.**

  bc-khoe.30 wants the same slot for something new. Every view becomes a pane of one
  document and the hash is how you move between them — `/#history`, `/#advocates` — so
  that a pill tap costs a `display:none` rather than a document load. Two grammars over
  one slot, written in two files, is how you get a deep link that quietly changes a filter
  instead of opening a card. That is not hypothetical; see *the bug this exists to
  prevent*, below.

  So: one module parses the hash and one module writes it, and both readers — the card
  opener in `public/app.js` and the pill row in `public/viewbar.js` — come here rather
  than doing their own string work.

  ## The grammar, in four decisions

  **1. A view is a bare name; a card is everything with a shape.** The view names are a
  closed list of five and they are held here (`VIEWS`). Everything else is read as a card
  key, and a card key is recognised by *shape* rather than by lookup, because there are
  three of them and the app mints all three: `workspace/id` for a bead — the only form
  that has ever been in a notification — plus `pr:` and `jira:` prefixes for the two rows
  that are synthesised rather than stored (see `byKey` in public/app.js). A closed list on
  one side and three fixed shapes on the other is what makes the two halves incapable of
  colliding: no view name contains a `/` or a `:`, and no bead key is a bare word.

  **2. A card hash always means Home.** `parse` answers with a `view` for *every* hash,
  and for a card that view is `epics` — Home, unnarrowed. A deep link names a question and
  questions live on Home, so a bead link that arrives while another pane is showing is
  "switch to Home, then focus the card", not "focus a card on a pane that cannot draw
  one". Encoding it here rather than at the call site is the point: after bc-khoe.30.3
  there will be several panes and the answer must not depend on which one happens to be
  up.

  **3. An unrecognised hash falls to Home and changes nothing.** `kind: 'none'`, `view:
  'epics'`, no key. A hash nobody minted is a typo, a stale link to a view that has been
  renamed, or a fragment some other tool appended — none of which is a reason to show a
  blank pane, and none of which is a reason to *write* anything. `view` is therefore
  always answerable and `key` is only ever set on a card, which is the property that lets
  a caller act on the answer without re-checking `kind`.

  **4. One slot, so the last write wins, and nothing is held twice.** There is no combined
  form — no `#history/beadcause/bc-x` — because decision 2 means there is nothing to
  combine: a card's view is always Home, so a hash naming a card already names its view.
  Setting a view hash drops any card that was in the slot, and opening a card drops the
  view, and both are correct because both are what a tap just asked for.

  **5. A view may carry a query, and only a view may (bc-khoe.30.5).** `#history?status=
  closed&priority=P0` is the History pane narrowed, and the part after the `?` is handed
  back as an opaque string for that view to read — this file has no opinion about what a
  filter means, only about where one is written down. It is a *query* rather than more
  path because that is the spelling the ledger has always used (`/history?status=closed`,
  which `parseQuery` in lib/history.js takes), so a pane that used to be a page keeps one
  vocabulary for its filters instead of growing a second.

  Why the hash at all, when the ledger had a perfectly good query string: on the shell
  there is one address for every view, so a filter left in `location.search` outlives the
  pane that wrote it. Tap History, narrow it to P0, tap Home, and Home's URL is
  `/?status=P0` — the address the phone's home screen holds, carrying another view's
  filter, and `route.go('')` keeps `search` on purpose (it is where `?t=` and everything
  else lives). In the hash it is part of the name of the view, so leaving the view is what
  drops it.

  The split is on the **raw** hash and at the **first** `?`, before any decoding, and only
  a head that is one of the closed list of view names may have one. That is what keeps
  decision 1 intact: a card key is encoded (`hashForCard`), so a `?` inside one arrives as
  `%3F` and can never be read as the start of a query, and a hash whose head is not a view
  name is parsed exactly as it was before this decision existed.

  ## The bug this exists to prevent

  `focusHash` in public/app.js used to take the whole hash, decode it, and hand it
  straight to `byKey`. When `byKey` came back empty on the `agent` scope it widened the
  scope to `both`, wrote that to `localStorage` and reloaded — a good rescue for a deep
  link to a question the current scope hides, and completely wrong for anything that was
  never a key at all. Land `/#history` on Home under that code and the app silently
  changes a filter you had set, on its way to doing nothing. Every hash was a key, so
  every hash was a card that could not be found. Now only decision 1's shapes are keys,
  and the rescue fires for the thing it was written for.

  ## What is deliberately not here

  **No DOM, no `location` read at load.** Everything below is a pure function of its
  argument, so the whole grammar runs in a `node:vm` with an empty context and
  test/hashgrammar.mjs asserts against it directly rather than against a browser. `go` is
  the one line that touches the URL, and it takes the object to write on.

  **No pane switching and no scroll restoring.** Those are bc-khoe.30.3 and .30.4. This
  file answers *what a hash means*; what to do about it belongs to whoever asked.

  **The paths, though, are here** — `/monitor`, `/sessions`, `/work.html` and the six
  others that are all one page. They look like a routing table rather than a hash grammar,
  and they are here because they are the *other* half of the same question: which view an
  address names. bc-khoe.30.7 has to land every one of those on the right pane, and it
  will do that by mapping the path to a view id, which is `viewOfPath`. Keeping them
  beside the hashes is what stops the two answers drifting. They were public/viewbar.js's
  until this bead; that file now asks rather than knows, and test/pagepaths.mjs reads them
  from here.
*/
(() => {
  /**
   * Every view, its hash, and every address that already means it.
   *
   * `id` is the pill id in public/viewbar.js, on purpose — the row lights the pill named
   * by the view, and a second vocabulary between "the view" and "the pill for the view"
   * would be one more thing to keep in step for nothing.
   *
   * Home's hash is the **empty string** rather than `#home`. It is the default and always
   * has been: `/` with no hash is Home, and `${baseUrl}/#<key>` — the notification's own
   * URL — is Home with a card open. Giving Home a name of its own would mint a second way
   * to say the thing every existing link already says by saying nothing.
   *
   * `paths` is every URL the server maps onto that view. The server has been merging
   * pages for months and keeping the old addresses (see `serveStatic` in lib/server.js
   * and test/pagepaths.mjs), so `/work.html` and `/prs` are the advocate console as much
   * as `/monitor` is, and a phone's home screen still holds them.
   */
  const VIEWS = [
    { id: 'epics', hash: '', paths: ['/', '/index.html'] },
    { id: 'history', hash: '#history', paths: ['/history', '/history.html'] },
    {
      id: 'advocates',
      hash: '#advocates',
      paths: ['/monitor', '/advocates', '/monitor.html', '/sessions', '/work', '/work.html', '/prs', '/pulls', '/prs.html'],
    },
    // Where everything in flight is (bc-khoe.7). Three addresses, because the page is
    // about the journey and the deploy strip that moved onto it was what most people came
    // for: `/releases` is what it is, `/deploys` is the word somebody types, and the
    // `.html` is what the service worker precaches by name.
    { id: 'releases', hash: '#releases', paths: ['/releases', '/deploys', '/releases.html'] },
    // The selected space's own settings (bc-khoe.10), and the last row for the same reason
    // it is the last pill: you reach it about once a month.
    //
    // It is here because a pill pointing at a page that is *not* a view is a pill that
    // marks nothing current on the page it links to — the row asks `viewOfPath` and
    // /config was not one of the answers it had, so the one screen the pill reaches drew
    // the row with nothing lit and the Config pill as a live `<a href="/config">` on
    // /config itself. That is bc-khoe.50, and this row is its answer: three addresses
    // rather than one, because the screen has two honest names — the *config* of a space
    // and where its *settings* are — and the `.html` is what the service worker precaches.
    //
    // **Its pane is still `data-pending` (bc-khoe.60), and that is what keeps these three
    // documents.** A view whose container is empty must not hop: `public/panes.js` answers
    // a hash naming a pending pane by showing Home, so a 302 here would put the phone on
    // the inbox from a home-screen shortcut. test/pagealias.mjs holds both directions of
    // that — a filled pane owes hops, a pending one must not have them — so the flip
    // happens in bc-khoe.60's commit and cannot happen early by accident.
    { id: 'config', hash: '#config', paths: ['/config', '/settings', '/config.html'] },
  ];

  /** Where a hash falls when it names nothing — and where a card is always opened. */
  const HOME = 'epics';

  /** The bare names a hash may be, mapped to their view. Home's empty hash is not one. */
  const NAMED = new Map(VIEWS.filter((v) => v.hash).map((v) => [v.hash.slice(1), v.id]));

  /**
   * Is this string one of the three shapes the app mints as a card key?
   *
   * A bead is `workspace/id` and is the only one that has ever been in a notification. The
   * other two are prefixed exactly so they can never collide with it (`prRows` and the
   * ticket rows in public/app.js), and they are recognised here for the same reason
   * `byKey` knows about them: a card is a card whichever list it came out of, and a hash
   * that named one and was read as a typo would be a card the app refused to open.
   */
  const isCardKey = (s) => s.includes('/') || s.startsWith('pr:') || s.startsWith('jira:');

  /**
   * What a hash means. Answers for every input, including nonsense and undefined.
   *
   *   parse('#history')                  -> { kind: 'view', view: 'history', key: null }
   *   parse('#history?status=closed')    -> { kind: 'view', view: 'history', query: 'status=closed' }
   *   parse('#beadcause%2Fbc-khoe')      -> { kind: 'card', view: 'epics', key: 'beadcause/bc-khoe' }
   *   parse('')                          -> { kind: 'view', view: 'epics', key: null }
   *   parse('#wat')                      -> { kind: 'none', view: 'epics', key: null }
   *
   * `view` is always a view id and `key` is null unless `kind` is `card`, so a caller that
   * only wants one of the two never has to test `kind` first. `query` is always a string
   * and is `''` for everything but a view hash that carries one — never null, so a reader
   * can hand it straight to `URLSearchParams` without testing it.
   *
   * The decode is inside a `try`: `decodeURIComponent` throws on a lone `%`, and a
   * malformed hash — which is to say, a URL somebody hand-edited — must not be able to
   * throw out of whatever ran this on boot. A hash that will not decode is taken as
   * written, which either matches a shape or falls to Home like any other nonsense.
   */
  function parse(hash) {
    const raw = String(hash == null ? '' : hash).replace(/^#/, '');
    if (!raw) return { kind: 'view', view: HOME, key: null, query: '', raw: '' };
    /* Decision 5, and it is deliberately the *first* thing done to the string: the split
       is on the raw hash, so a `%3F` inside an encoded card key is still one character of
       that key rather than the start of a query. Only a bare view name may carry one —
       anything else falls through to exactly the code that was here before. */
    const at = raw.indexOf('?');
    if (at !== -1) {
      const named = NAMED.get(raw.slice(0, at));
      if (named) return { kind: 'view', view: named, key: null, query: raw.slice(at + 1), raw };
    }
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      /* taken as written */
    }
    const view = NAMED.get(key);
    if (view) return { kind: 'view', view, key: null, query: '', raw };
    if (isCardKey(key)) return { kind: 'card', view: HOME, key, query: '', raw };
    return { kind: 'none', view: HOME, key: null, query: '', raw };
  }

  /**
   * The hash that names a view, or `null` for an id that is not one.
   *
   * Home's is `''`, which is a legal answer and not a refusal — hence `null` rather than
   * `''` for the failure, so the two are told apart by a caller writing what it is given.
   *
   * `query` is decision 5's half — the string a view wants kept beside its name, with or
   * without a leading `?`, and empty or absent for the bare hash every other caller wants.
   * Home is the one view a query cannot be hung on: its hash is the empty string, so
   * there is no name for one to belong to, and `/?…` is the address the phone's home
   * screen holds. Asked for one anyway it answers the bare hash, because the caller's next
   * line writes whatever this returns and a `null` there would be a pill that stopped
   * working over a filter Home does not have.
   */
  const hashFor = (view, query) => {
    const v = VIEWS.find((one) => one.id === view);
    if (!v) return null;
    const q = String(query == null ? '' : query).replace(/^\?/, '');
    return q && v.hash ? `${v.hash}?${q}` : v.hash;
  };

  /**
   * The query currently hung on **one named** view, and `''` for every other hash.
   *
   * `parse` answers with a `view` for every input, including a card and a typo, because
   * there is always a pane to show. A *query*, though, belongs to the view that was named
   * — so a caller asking "what are my filters" has to know both what the hash says and
   * whether the hash is talking to it, and both of `public/history.js` and
   * `public/montabs.js` read `parse(...).query` without that second half. It has never
   * bitten either of them, because each reads for keys the other does not write and each
   * is called once as its own pane is built. It would bite the third caller: a repo view
   * is handed its query on `build`, and a repo view's `build` runs several hundred
   * milliseconds after `/api/views` answers, which is long after somebody may have moved
   * to another pane.
   *
   * So the check is here rather than at each call site, and it is the whole reason this
   * exists as a function: `queryFor('deluvia.briefs')` is `''` while the ledger is up, and
   * `''` for a card hash, and `''` for Home — which has no name for a query to hang on.
   */
  const queryFor = (view, hash) => {
    const at = parse(hash);
    return at.kind === 'view' && at.view === view ? at.query : '';
  };

  /**
   * The hash that opens a card, in the exact form the daemon has always minted.
   *
   * `#` + `encodeURIComponent(key)` is `lib/notify.js`'s line, and `lib/slack.js`'s, and
   * it is the reason a bead key's `/` arrives as `%2F` rather than as a path. Written
   * here so there is one place that says it, and asserted against those two files by
   * test/hashgrammar.mjs — that assertion is the whole of "the old links cannot break".
   */
  const hashForCard = (key) => `#${encodeURIComponent(String(key == null ? '' : key))}`;

  /**
   * Which view an address is, or `null` for a page that is not a view.
   *
   * Trailing slashes are stripped because `/history/` and `/history` are the same page to
   * anybody typing, and `/` survives that as itself. A page with no view — `/flow`,
   * `/requirements`, `/endorse`, `/admin`, `/console` — answers `null` on purpose: those
   * five draw the pill row and are on no pill, and bc-khoe.30 leaves them as documents.
   */
  const viewOfPath = (p) => {
    const here = String(p == null ? '' : p).replace(/\/+$/, '') || '/';
    return VIEWS.find((v) => v.paths.includes(here))?.id || null;
  };

  /**
   * Write the slot. The only line in the app that assigns to `location.hash`.
   *
   * `loc` is for a test and for a document that is not this one; a page passes nothing.
   * Clearing it is the case worth the extra line: `location.hash = ''` leaves a bare `#`
   * hanging on the URL, which is then a *different* URL from the one the phone's home
   * screen holds, so a clear is always written with `pushState`/`replaceState` rather than
   * by assignment.
   *
   * Which of the two depends on `dismiss` (bc-khoe.30.9). Setting a hash always pushes —
   * that is what assigning `location.hash` does on its own — so the only place this was
   * ever a question is *clearing* it, and clearing it means two different things today: a
   * pill tap landing on Home is a *step* (one more view visited, so back should walk to
   * the pane you came from) and a card closing back to Home is a *dismissal* (nothing new
   * was visited, so back should still leave the app). `dismiss` is falsy by default because
   * every caller so far — `panes.js`'s pill handler — is a step; pass `true` for the
   * dismissal case once one exists.
   */
  function go(hash, loc, hist, dismiss) {
    const l = loc || (typeof location === 'undefined' ? null : location);
    if (!l) return false;
    const next = String(hash == null ? '' : hash);
    if (next) {
      l.hash = next;
      return true;
    }
    const h = hist || (typeof history === 'undefined' ? null : history);
    const url = `${l.pathname}${l.search}`;
    if (dismiss) {
      if (h?.replaceState) h.replaceState(null, '', url);
      else l.hash = '';
    } else if (h?.pushState) h.pushState(null, '', url);
    else if (h?.replaceState) h.replaceState(null, '', url);
    else l.hash = '';
    return true;
  }

  /**
   * Admit one more view to the grammar, at runtime (bc — repo views).
   *
   * The list above is closed and stays closed: those five are what *this app* is, they
   * are in the service worker's precache, and a sixth appearing there would be a change
   * to beadcause. What this adds is a different kind of view — one a **repo** declares
   * about itself, discovered from `/api/views` after boot and gone again when that repo
   * leaves the account. See public/viewhost.js and lib/repoviews.js.
   *
   * It is the same grammar and not a second one, which is the whole point: a repo view is
   * named by a hash, falls back to Home when it is not there, carries a query like any
   * other view, and is opened by `panes.go` through `hashFor`. Nothing downstream learns
   * a new word.
   *
   * **The id is `<workspace>.<id>` and the hash is that id verbatim.** A dot rather than
   * a slash or a colon, because decision 1 reads both of those as the shape of a bead card
   * key — a view hashed `#deluvia/studio` would parse as a card, and the pill would open
   * the inbox looking for a bead that does not exist. A bare word with a dot in it is not
   * a card under any of the three shapes, and `parse` consults `NAMED` before `isCardKey`
   * either way, so the two halves still cannot collide.
   *
   * Answers whether it took it. A duplicate is refused rather than replacing what is
   * there — the built-in five are the ones that would be shadowed, and a repo that could
   * take the name `history` could take the ledger off the row.
   */
  function add(view) {
    const id = String(view?.id || '');
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*\.[a-z0-9][a-z0-9-]*$/.test(id)) return false;
    if (VIEWS.some((v) => v.id === id)) return false;
    const paths = (Array.isArray(view?.paths) ? view.paths : []).map((x) => String(x));
    VIEWS.push({ id, hash: `#${id}`, paths, repo: true });
    NAMED.set(id, id);
    return true;
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.route = {
    /** Every view, its hash, and every address that means it. */
    VIEWS,
    /** Where a hash falls when it names nothing, and where a card always opens. */
    HOME,
    parse,
    hashFor,
    /** The query hung on one named view, `''` when the hash is talking to somebody else. */
    queryFor,
    hashForCard,
    viewOfPath,
    go,
    /** Admit a repo's own view to the grammar. See `add` above. */
    add,
    /** Every view a repo declared, as opposed to the five this app is. */
    repoViews: () => VIEWS.filter((v) => v.repo).map((v) => v.id),
  };
})();
