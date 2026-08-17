/*
  The warm layer — what the app already has, kept instead of thrown away.

  Two things live here, and they are the same idea at two scales.

  **Across documents.** Every standing view is its own page — `/`, `/console`,
  `/prs`, `/monitor`, `/admin` — so tapping a tab is a navigation: the document is
  discarded, the next one is parsed, and its script then fetches everything it needs
  before it can draw a row. The shell itself is instant, because sw.js precaches it;
  what you wait for is the fetch, and on the two heaviest views that fetch is a `bd`
  sweep across seven workspaces. So the payload each view boots from is kept here,
  and a page paints it before its own request has left — then refreshes underneath.
  Behind that, once the view you asked for is on screen, the *other* views' payloads
  are fetched in the background, so the tab you tap next is already warm.

  **Filled once is not the same as kept warm.** That background fill happens once per
  document and the TTL below then ages what it fetched out — which is fine for a page
  you pass through and wrong for the inbox, which is a page you sit on for hours. So a
  warmed payload is *maintained* rather than merely stored: the inbox is parked on the
  delta stream anyway, and an entry the log has not contradicted is as true as it was
  when it was fetched, however old it is — `refresh()` says so and resets its clock for
  no request at all. What an entry that *has* been contradicted costs is then decided
  per path, on what the request costs the daemon, and `/api/prs` is deliberately never
  re-asked here because it is a `gh` call per repo. See `MAINTAINED` in public/app.js
  for the table and the argument behind each row.

  **Within a document.** A list that is rebuilt with `innerHTML` on every refresh
  throws away every card, including the twenty that did not change — and with them
  the rendered mermaid diagrams, the open ⋮ menu, the caret in a textarea and the
  scroll position, all of which then have to be put back by hand. `paint()` takes a
  keyed list of chunks and touches only the ones whose HTML actually differs.

  Deliberately in `sessionStorage`, not `localStorage`. A tab switch is a navigation
  inside one tab, which is exactly what sessionStorage survives — and closing the app
  takes the cache with it, so bead text does not sit on the phone's disk between one
  evening and the next. A cold start after that is a cold start, which is the case the
  inbox-first boot is for.

  Nothing here is load-bearing. Every reader treats a miss as "no cache" and does what
  it did before, and `sessionStorage` throwing — Safari's private mode, a full quota —
  is a miss. A page that cannot warm is a page that is merely as fast as it was.
*/
(() => {
  'use strict';

  const PREFIX = 'beadcause.warm:';
  // Older than this and it is not worth painting: you have been away long enough that
  // a stale list is more confusing than a spinner. Well beyond a tab switch, which is
  // the case this exists for, and well short of "the app was open all night".
  const TTL_MS = 15 * 60 * 1000;
  // The floor on how often the background warm may re-ask for one path. Two of these
  // are a `bd` sweep, and a page load must not be able to turn into a sweep per view
  // just by being reloaded — so a path the warm has fetched this recently is left
  // alone even if it is stale.
  const PREWARM_FLOOR_MS = 60 * 1000;
  // How long to let the view you actually asked for have the link to itself before
  // the background fetches start. Not `requestIdleCallback`: that is unimplemented in
  // enough WebViews to need a fallback anyway, and the thing being waited for here is
  // a network round trip, not a free main thread.
  const PREWARM_DELAY_MS = 1200;

  /**
   * Every standing view, and the payload each one boots from.
   *
   * **The order is the order they are warmed in, and it is the pills first, in the
   * row's own order.** The background warm is deliberately sequential (see `prewarm`),
   * so a view near the end of this list waits out every sweep before it. The rule is
   * that a view a thumb can reach **in one tap** must not wait on one it cannot:
   * `/api/prs` is a `gh` call per repo and `/api/unendorsed` is a `bd` sweep of every
   * workspace, and both of those are now one tap away, so both moved up past the two
   * pages that are not. One list, one place to add a view — the same argument as `PILLS`
   * in public/viewbar.js, and the two have to stay in step: a view added there and
   * forgotten here is a pill that is still cold, which is invisible until you are on a
   * phone wondering why one is slower than the others.
   *
   * A **view** is not the same thing as a pill, and two entries here prove it. /admin
   * lost its place on the navigation in bc-khoe.1 — it is the screen you least want to
   * hit by accident, and bc-khoe.5 puts it in the gear menu — and the chat session never
   * had one after bc-l8jp.5, because it is created from ＋ and listed in Home. Both are
   * still standing pages somebody arrives at, so both are still warmed. What belongs
   * here is a page somebody arrives at, not a place on a row.
   *
   * `/api/prs` is deliberately **not** listed under `inbox`, even though the inbox now
   * draws a card per pull request off it. A path under a view is a path that view does not
   * warm for the others, and the inbox is the one page that would then leave the board
   * cold — precisely when a kind filter means the inbox never asks for it at all. It reads
   * and writes the same entry directly instead (`warmBoard` and `loadBoard` in app.js), so
   * one sweep still serves both screens.
   */
  const VIEWS = [
    { id: 'inbox', paths: ['/api/questions?scope=human'] },
    // The heaviest of the first three pills and the one this order is for: `/api/work` is
    // two `bd` calls per workspace, so it is the view that most needs to be warm — and
    // the one whose entry the inbox goes on to *maintain* off the stream rather than
    // merely fill once. See `refresh` below and `MAINTAINED` in public/app.js.
    { id: 'advocates', paths: ['/api/work', '/api/questions?scope=human'] },
    // The ledger (bc-nib3.2) is here in the row's order and is the one view that warms
    // **nothing** — a recorded decision rather than a gap, because a pill missing from
    // this list is a pill that stays cold and nobody notices until they are on a phone
    // wondering why one is slower than the others.
    //
    // Every path above is a constant, which is the whole mechanism: the list is fetched
    // from whatever page you are on, for the pages you are not. History has no constant
    // to offer. Its boot request carries the space picker's current selection —
    // `workspace=`, or `space=`, or neither — so any path written here would be the
    // right ledger only for whoever happened to have the picker set the way this file
    // guessed, and warming every selection is a sweep of the whole tracker to fill a
    // cache for a page that may not be opened.
    //
    // It is also the view that needs it least: the one screen in the app explicitly
    // about what has already happened, where an instant first frame of slightly stale
    // rows buys less than it does anywhere else.
    { id: 'history', paths: [] },
    // The last of the four pills, and the most expensive thing on this list: `/api/prs`
    // shells out to `gh` once per repo. It is here rather than last because bc-khoe.1
    // made it one tap away, and a view a thumb can reach in one tap must not wait on one
    // it cannot.
    { id: 'prs', paths: ['/api/prs'] },
    // Below the row. None of these three is a pill, and all three are still reached in
    // one tap from somewhere else — the queue from the 🗳 in the inbox's top bar or the
    // advocate console's `N held for endorsement` pill, /admin from the ⚙ on /monitor
    // until bc-khoe.5's gear menu exists, a conversation from a row in Home or the ＋.
    //
    // The queue is the second most expensive boot in the app — `/api/unendorsed` is a
    // `bd` sweep of every workspace and then a `bd show` per row for the provenance line
    // (lib/endorsequeue.js) — and warming it is the whole of why arriving there is
    // instant: it is the one screen whose rows are the full bead.
    { id: 'endorse', paths: ['/api/unendorsed'] },
    //
    // `/api/work` was under /admin once, because /admin fetched it — for the single
    // `observing` boolean, which the delta stream now carries on every wake (bc-rk2o).
    // It is off this list rather than merely unused: a path under a view is a path that
    // view does not warm for the others, and leaving it here would have left /monitor
    // cold every time you arrived from /admin. /admin still *reads* a held `/api/work`
    // for its first frame; it is simply no longer the page that fills it.
    { id: 'admin', paths: ['/api/admin'] },
    { id: 'console', paths: ['/api/consoles'] },
  ];

  /* ------------------------------------------------------------------ storage */

  const store = (() => {
    try {
      // Touched rather than merely read: a storage that exists and throws on write is
      // the case that matters, and it only says so when written to.
      const probe = `${PREFIX}probe`;
      sessionStorage.setItem(probe, '1');
      sessionStorage.removeItem(probe);
      return sessionStorage;
    } catch {
      return null;
    }
  })();

  /** Every path we are holding, for the sweeps that clear or count them. */
  function keys() {
    if (!store) return [];
    const out = [];
    for (let i = 0; i < store.length; i += 1) {
      const k = store.key(i);
      if (k && k.startsWith(PREFIX)) out.push(k.slice(PREFIX.length));
    }
    return out;
  }

  /**
   * The cached payload for a path, or null.
   *
   * Null covers every way this can fail — never stored, stored by a version that
   * wrote a different shape, past its TTL, or unparseable — because every caller
   * does the same thing with all four: fetch, the way it always did.
   */
  function read(path, { now = Date.now(), ttl = TTL_MS } = {}) {
    if (!store) return null;
    let raw;
    try {
      raw = store.getItem(PREFIX + path);
    } catch {
      return null;
    }
    if (!raw) return null;
    let entry;
    try {
      entry = JSON.parse(raw);
    } catch {
      drop(path);
      return null;
    }
    if (!entry || typeof entry !== 'object' || !('data' in entry)) return null;
    const age = now - (Number(entry.at) || 0);
    if (age < 0 || age > ttl) {
      // Dropped rather than merely refused: an entry this old is never going to
      // become useful again, and leaving it there is quota spent on nothing.
      drop(path);
      return null;
    }
    return { data: entry.data, at: Number(entry.at) || 0, seq: Number(entry.seq) || 0, age };
  }

  /**
   * Keep a payload for the next document that wants it.
   *
   * `seq` is where in `/api/poll`'s event log the payload was true, when the endpoint
   * says — `/api/questions` carries one. Without it the entry is still paintable; it
   * just cannot be checked against the log, so whoever reads it refreshes anyway.
   *
   * A quota failure clears everything and gives up rather than retrying: the entries
   * we are holding are the reason there is no room, and a cache that spends every
   * write failing is worse than no cache.
   */
  function write(path, data, seq = 0) {
    if (!store || data == null) return false;
    let raw;
    try {
      raw = JSON.stringify({ at: Date.now(), seq: Number(seq) || 0, data });
    } catch {
      return false; // something un-JSONable got in; not worth a second attempt
    }
    try {
      store.setItem(PREFIX + path, raw);
      return true;
    } catch {
      forget();
      return false;
    }
  }

  function drop(path) {
    try {
      store?.removeItem(PREFIX + path);
    } catch {
      /* nothing to do about it, and nothing depends on it */
    }
  }

  /**
   * Throw the lot away.
   *
   * Called when the credential is refused, which is the one moment a held payload
   * stops being yours — and on a quota failure, above.
   */
  function forget() {
    for (const path of keys()) drop(path);
  }

  /**
   * Bring a held payload up to date without asking for it again — and reset its clock.
   *
   * The gap this closes: `prewarm` fills a path once per document and the TTL then ages
   * the entry out fifteen minutes later, so an inbox left open — which is the way this
   * app is actually used — had a *cold* Advocates tab for all but the first quarter of an
   * hour, and nothing to re-warm it, because `prewarmed` never goes back to false. The
   * entry was not wrong when it was dropped; it was merely old, and the delta stream
   * knows the difference.
   *
   * So: a page that is parked on `/api/poll` calls this on every wake. `mutate` folds
   * whatever the wake carried into the data — the advocate roster rides every wake
   * whatever woke it — and the write underneath stamps `at` afresh, which is what stops
   * a quiet hour ageing out a payload nothing has invalidated. It costs no request, and
   * it is the only way an entry can stay young without one.
   *
   * Returning `mutate`'s `null` means "I cannot maintain this shape", and is a miss, not
   * a write: a payload from an older daemon that lacks the fields being folded in should
   * be re-fetched rather than half-patched. A miss for any reason — nothing held, aged
   * out while the screen was dark, a `mutate` that threw — is the caller's cue that a
   * fetch is the only way back.
   *
   * @param {string} path
   * @param {function} mutate  `(data) => data | null`
   * @param {number} [seq]     the log position the result is true at; the entry's own by default
   * @returns {boolean} whether an entry is now held, fresh, for this path
   */
  function refresh(path, mutate, seq = null) {
    const hit = read(path);
    if (!hit) return false;
    let next;
    try {
      next = mutate ? mutate(hit.data) : hit.data;
    } catch {
      // A held payload we cannot reason about. Nothing here is load-bearing and the
      // caller's fallback is a fetch, so this is a miss rather than a thrown error.
      return false;
    }
    if (next == null) return false;
    return write(path, next, seq == null ? hit.seq : seq);
  }

  /** Has this path been fetched inside `ms`? What stops the background warm churning. */
  function fresh(path, ms = PREWARM_FLOOR_MS, now = Date.now()) {
    const hit = read(path, { now });
    return Boolean(hit && hit.age <= ms);
  }

  /* ---------------------------------------------------------------- prewarming */

  // Once per document, and never again. A tab switch is a new document, so switching
  // is exactly what re-warms the set — while a page left open all afternoon does not
  // sit there re-sweeping five endpoints on a timer for tabs nobody is going to tap.
  let prewarmed = false;

  /**
   * Fetch the other views' payloads, behind the one you are looking at.
   *
   * Sequential, not parallel, and on purpose: two of these are a `bd` sweep, and
   * firing five at once at a daemon that runs them on one machine would make the view
   * you are actually waiting for slower — which is the opposite of the point.
   *
   * It gives up rather than retries at every turn. The document going hidden stops it
   * (a phone in a pocket must not be warming tabs), a fetch that throws stops that one
   * path and not the rest, and a path fetched inside the floor is skipped. Nothing it
   * does is visible if it never runs.
   *
   * @param {object} o
   * @param {string} o.here     tab id of the view doing the warming; its own paths are skipped
   * @param {function} o.api    the page's own fetch wrapper — `api(path) -> Promise<data>`
   * @param {function} [o.seqOf] pulls the event-log sequence out of a payload, if it carries one
   */
  function prewarm({ here, api, seqOf = (d) => d?.seq || 0, delay = PREWARM_DELAY_MS } = {}) {
    if (!store || typeof api !== 'function' || prewarmed) return;
    prewarmed = true;
    const mine = new Set(VIEWS.find((v) => v.id === here)?.paths || []);
    // Deduped across views: /api/work is two views' boot payload and
    // /api/questions?scope=human is three's, and warming either twice would be a
    // second `bd` sweep for a payload we already hold.
    const wanted = [];
    for (const view of VIEWS) {
      for (const path of view.paths) if (!mine.has(path) && !wanted.includes(path)) wanted.push(path);
    }
    setTimeout(async () => {
      for (const path of wanted) {
        if (typeof document !== 'undefined' && document.hidden) break;
        if (fresh(path)) continue;
        try {
          const data = await api(path);
          write(path, data, seqOf(data));
        } catch {
          /* one cold tab, which is where it started */
        }
      }
    }, delay);
  }

  /* -------------------------------------------------------------- the keyed list */

  /**
   * What a repaint would have to do to the DOM, as data.
   *
   * Split out from `paint` because this is the part with the decisions in it and the
   * part a test can hold: `paint` below is a dozen lines of `insertBefore` over what
   * this returns. `prev` and `next` are both `[{key, html}]` in document order.
   *
   * A repeated key is a bail, not a best effort. Two chunks claiming one identity
   * cannot both be placed, and the wrong answer would be a card that silently stopped
   * updating — so the caller is told to rebuild the whole list, which is exactly what
   * it used to do anyway.
   */
  function plan(prev, next) {
    const seen = new Set();
    for (const chunk of next) {
      if (seen.has(chunk.key)) return { ops: null, removed: null, bail: `duplicate key ${chunk.key}` };
      seen.add(chunk.key);
    }
    const before = new Map(prev.filter((c) => c.key != null).map((c) => [c.key, c.html]));
    const ops = next.map((c) => ({
      key: c.key,
      html: c.html,
      // `undefined` in `before` is a node this file did not paint — a raw rebuild, or
      // the first repaint after one. Treated as a change rather than as a match,
      // because we have no idea what is in it.
      action: !before.has(c.key) ? 'insert' : before.get(c.key) === c.html ? 'keep' : 'replace',
    }));
    const removed = prev.filter((c) => c.key != null && !seen.has(c.key)).map((c) => c.key);
    return { ops, removed, bail: null };
  }

  // What each node we placed was built from. A WeakMap rather than an attribute on the
  // element: the strings are whole cards, and writing them into the DOM would double
  // the size of the list to save a lookup.
  const painted = new WeakMap();

  function build(html, key) {
    const tpl = document.createElement('template');
    tpl.innerHTML = html;
    // Exactly one root, or this is not a chunk we can key. Every chunk the inbox
    // passes is a single <article> or <section>; a future one that is not gets the
    // old whole-list rebuild rather than a guess about where its pieces go.
    if (tpl.content.children.length !== 1) return null;
    const node = tpl.content.firstElementChild;
    node.dataset.warmKey = key;
    painted.set(node, html);
    return node;
  }

  /**
   * Draw a keyed list into a container, touching only what changed.
   *
   * Returns `{ changed, kept, rebuilt }` — what it did, so a caller can decide whether
   * anything downstream needs re-running. `changed` counts inserts and replaces;
   * `kept` counts the nodes that were left exactly as they were, which is the number
   * this whole file exists to make large.
   *
   * The fallback is the old behaviour, in full: one bad chunk and the container is
   * rebuilt from the joined HTML, and from then on it always is. A list that is merely
   * as slow as it was yesterday is a working list.
   */
  function paint(container, chunks) {
    if (!container) return { changed: 0, kept: 0, rebuilt: false };
    const raw = () => {
      container.innerHTML = chunks.map((c) => c.html).join('');
      return { changed: chunks.length, kept: 0, rebuilt: true };
    };
    if (container.warmOff) return raw();

    const prev = [...container.children].map((el) => ({ key: el.dataset.warmKey, html: painted.get(el), el }));
    const step = plan(
      prev.map(({ key, html }) => ({ key, html })),
      chunks
    );
    if (!step.ops) return raw();

    const byKey = new Map();
    for (const p of prev) if (p.key != null) byKey.set(p.key, p.el);
    for (const key of step.removed) {
      byKey.get(key)?.remove();
      byKey.delete(key);
    }

    let changed = 0;
    let kept = 0;
    let cursor = container.firstElementChild;
    for (const op of step.ops) {
      let node;
      if (op.action === 'keep') {
        node = byKey.get(op.key);
        kept += 1;
      } else {
        node = build(op.html, op.key);
        if (!node) {
          // Give up wholesale rather than half-painted: the container is in a
          // half-reconciled state right now, and `raw` is what puts it right.
          container.warmOff = true;
          return raw();
        }
        const existing = byKey.get(op.key);
        if (existing) {
          if (cursor === existing) cursor = node;
          existing.replaceWith(node);
        }
        byKey.set(op.key, node);
        changed += 1;
      }
      if (cursor === node) {
        cursor = node.nextElementSibling;
        continue;
      }
      // Moves it if it is already somewhere else, which is what a reorder is.
      container.insertBefore(node, cursor);
    }
    // Everything wanted is now placed before the cursor, so whatever is left from it
    // onward is either a key that went away or a node nothing here put there.
    while (cursor) {
      const next = cursor.nextElementSibling;
      cursor.remove();
      cursor = next;
    }
    return { changed, kept, rebuilt: false };
  }

  /* ------------------------------------------------------------------- exports */

  window.beadcause = window.beadcause || {};
  window.beadcause.warm = {
    VIEWS,
    TTL_MS,
    PREWARM_FLOOR_MS,
    read,
    write,
    refresh,
    drop,
    forget,
    fresh,
    keys,
    prewarm,
    plan,
    paint,
    // Whether anything is being held at all — false in a browser that refused the
    // storage, which is what a caller checks before promising itself a warm boot.
    get available() {
      return Boolean(store);
    },
  };
})();
