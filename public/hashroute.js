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
  closed list of three and they are held here (`VIEWS`). Everything else is read as a card
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
   *   parse('#beadcause%2Fbc-khoe')      -> { kind: 'card', view: 'epics', key: 'beadcause/bc-khoe' }
   *   parse('')                          -> { kind: 'view', view: 'epics', key: null }
   *   parse('#wat')                      -> { kind: 'none', view: 'epics', key: null }
   *
   * `view` is always a view id and `key` is null unless `kind` is `card`, so a caller that
   * only wants one of the two never has to test `kind` first.
   *
   * The decode is inside a `try`: `decodeURIComponent` throws on a lone `%`, and a
   * malformed hash — which is to say, a URL somebody hand-edited — must not be able to
   * throw out of whatever ran this on boot. A hash that will not decode is taken as
   * written, which either matches a shape or falls to Home like any other nonsense.
   */
  function parse(hash) {
    const raw = String(hash == null ? '' : hash).replace(/^#/, '');
    if (!raw) return { kind: 'view', view: HOME, key: null, raw: '' };
    let key = raw;
    try {
      key = decodeURIComponent(raw);
    } catch {
      /* taken as written */
    }
    const view = NAMED.get(key);
    if (view) return { kind: 'view', view, key: null, raw };
    if (isCardKey(key)) return { kind: 'card', view: HOME, key, raw };
    return { kind: 'none', view: HOME, key: null, raw };
  }

  /**
   * The hash that names a view, or `null` for an id that is not one.
   *
   * Home's is `''`, which is a legal answer and not a refusal — hence `null` rather than
   * `''` for the failure, so the two are told apart by a caller writing what it is given.
   */
  const hashFor = (view) => {
    const v = VIEWS.find((one) => one.id === view);
    return v ? v.hash : null;
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
   * screen holds, so Home is cleared with `replaceState` instead — no history entry,
   * because arriving at Home from a card is a dismissal rather than a step.
   */
  function go(hash, loc, hist) {
    const l = loc || (typeof location === 'undefined' ? null : location);
    if (!l) return false;
    const next = String(hash == null ? '' : hash);
    if (next) {
      l.hash = next;
      return true;
    }
    const h = hist || (typeof history === 'undefined' ? null : history);
    if (h?.replaceState) h.replaceState(null, '', `${l.pathname}${l.search}`);
    else l.hash = '';
    return true;
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.route = {
    /** The three views, their hashes and every address that means them. */
    VIEWS,
    /** Where a hash falls when it names nothing, and where a card always opens. */
    HOME,
    parse,
    hashFor,
    hashForCard,
    viewOfPath,
    go,
  };
})();
