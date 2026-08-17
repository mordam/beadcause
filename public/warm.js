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
  document, and what it fetched then sits there while the world moves under it — which
  is fine for a page you pass through and wrong for the inbox, which is a page you sit
  on for hours. So a warmed payload is *maintained* rather than merely stored: the inbox
  is parked on the delta stream anyway, and an entry the log has not contradicted is as
  true as it was when it was fetched, however old it is — `refresh()` says so and resets
  its clock for no request at all. (That restamp used to be what stopped a quiet hour
  ageing an entry out under a TTL. Nothing expires now, so what it buys today is the
  other two things `at` decides: the background warm's floor, and which entry the store
  gives up first when it is full.) What an entry that *has* been contradicted costs is decided
  per path, on what the request costs the daemon, and `/api/prs` is deliberately never
  re-asked here because it is a `gh` call per repo. See `MAINTAINED` in public/app.js
  for the table and the argument behind each row.

  **Within a document.** A list that is rebuilt with `innerHTML` on every refresh
  throws away every card, including the twenty that did not change — and with them
  the rendered mermaid diagrams, the open ⋮ menu, the caret in a textarea and the
  scroll position, all of which then have to be put back by hand. `paint()` takes a
  keyed list of chunks and touches only the ones whose HTML actually differs.

  **Across closing the app.** This was `sessionStorage` until bc-1kwl.14, on the argument
  that a tab switch is a navigation inside one tab — which sessionStorage survives — and
  that letting the cache die with the app kept bead text off the phone's disk between one
  evening and the next. The first half is true and the second half was the wrong trade,
  and Adam settled it on 2026-08-15: **bead text on disk between sessions is fine.** What
  it was buying was a *reopen* that started from nothing, and a reopen from nothing is a
  cold `/api/questions` — one `bd human list` per workspace, measured at 4.5s and 15 child
  processes, of which 7ms is our own code. That is the wait this whole file exists to
  remove, and it was being paid every single time the app was closed and opened again.

  So the store is `localStorage`. Not IndexedDB and not the service worker's cache: both
  are asynchronous, and the one thing that has to happen here is a *synchronous* read
  before the first paint — `warmBoot()` in public/app.js draws the kept list in the same
  frame the shell arrives in, and an `await` in front of that is a spinner again. What
  localStorage costs by comparison is a smaller quota, which is what the bound below is
  for. It is scoped to the origin and the app is one origin, so it survives a WebView
  being torn down and rebuilt, which is what "closing the app" is on the phone — and the
  proof that it does is already in the app: the pairing token has lived in `localStorage`
  since the first version, and a phone that is still paired this morning is a phone whose
  WebView kept it overnight. Nothing here had to be assumed about the platform.

  **And no TTL.** There used to be a fifteen-minute one, on the grounds that a stale list
  is more confusing than a spinner. It is gone, and the argument two paragraphs up is why:
  the inbox is parked on `/api/poll`, an entry the log has not contradicted is as true as
  it was when it was fetched, and an entry it *has* contradicted is corrected by the
  catch-up that the kept `seq` makes possible — `/api/poll?since=<seq>` rather than a cold
  sweep, and `resync: true` with the whole payload when the log cannot reach back that far.
  Age was never the question. Whether the log has been followed since is, and the answer
  is carried by the entry itself. `public/freshness.js` is what says how long ago anything
  actually looked; a very old kept list is its case, and it needs no banner here.

  What is left, now that nothing expires, is that the store only ever grows — so it has a
  bound, and `BUDGET_BYTES` below is it.

  **And the background warm had to be told, which nothing else did.** Every standing page
  already read its held payload at the top of its own boot, so the console, the board and
  the advocates monitor started reopening from disk the moment the store did — there was
  no per-view work left in bc-1kwl.15, only a consequence nobody had gone back for.
  `prewarm` runs once per *document*, so it runs again on every reopen, and it was written
  when a reopen found an empty store: going and fetching all five paths was then the only
  way any tab was warm. With the store durable it is instead a second copy of five
  payloads already on the disk — and two of them are the app's most expensive requests.
  So those two are marked `holdOnly` and the background warm leaves a held one alone. See
  `prewarm`, and `MAINTAINED` in public/app.js for the same decision on the other warmer.

  Nothing here is load-bearing. Every reader treats a miss as "no cache" and does what
  it did before, and `localStorage` throwing — Safari's private mode, a full quota — is a
  miss. A page that cannot warm is a page that is merely as fast as it was.
*/
(() => {
  'use strict';

  const PREFIX = 'beadcause.warm:';
  // The shape of a stored entry, and the only defence left now that entries do not
  // expire. A fifteen-minute TTL made a version skew almost impossible — nothing could
  // outlive a deploy by long enough to be read by different code. A durable entry is
  // *guaranteed* to meet a newer build, so the build that wrote it has to say so, and
  // anything that does not match is a miss rather than a payload of unknown vintage.
  // Bump it whenever what goes into `data` changes shape in a way a reader would trip on.
  const STORE_V = 2;
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
    //
    // It is also one of the two `holdOnly` entries, which is a rule about the *background*
    // warm and nothing else: fill this path when nothing is held for it, and never go and
    // replace one that is. The two so marked are the two most expensive paths on this
    // list, and they are the two the order above cannot help — moving a `gh`-per-repo
    // sweep earlier in the queue does not make it cheaper, it only makes it sooner. See
    // `prewarm`.
    { id: 'prs', paths: ['/api/prs'], holdOnly: true },
    // Below the row. None of these three is a pill, and all three are still reached in
    // one tap from somewhere else — the queue from the 🗳 in the inbox's top bar or the
    // advocate console's `N held for endorsement` pill, /admin from the ⚙ on /monitor
    // until bc-khoe.5's gear menu exists, a conversation from a row in Home or the ＋.
    //
    // The queue is the second most expensive boot in the app — `/api/unendorsed` is a
    // `bd` sweep of every workspace and then a `bd show` per row for the provenance line
    // (lib/endorsequeue.js) — and warming it is the whole of why arriving there is
    // instant: it is the one screen whose rows are the full bead. It is the other
    // `holdOnly` entry, for the reason given against `/api/prs` above.
    { id: 'endorse', paths: ['/api/unendorsed'], holdOnly: true },
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

  /**
   * The bound, and the whole of it.
   *
   * Nothing expires any more, so nothing prunes any more, so this file's only remaining
   * limit was the browser's — and the way it used to meet that limit was `forget()`: a
   * quota failure threw the entire store away. That was defensible while every entry was
   * a fifteen-minute session-scoped one and the worst case was one cold tab. With durable
   * entries it means a single oversized payload — a board with forty pull requests on it,
   * fetched in the background for a screen nobody asked for — can take the inbox you are
   * opening with it, which is precisely the wait this file exists to remove.
   *
   * So: **a byte budget, and eviction oldest-first, and the inbox goes last.**
   *
   * - **A budget rather than a count.** The entries here differ by two orders of magnitude
   *   in size — `/api/admin` is a handful of counts and `/api/questions` is every open
   *   bead's text — so "newest N" would bound the wrong quantity and still let one payload
   *   fill the origin. 1.5 MB against a ~5 MB origin quota leaves room for the token, the
   *   drafts and the send queue, which live in the same storage and are not ours to spend.
   * - **Oldest `at` first.** `at` is when the entry was last known true, and `refresh()`
   *   restamps it for free on every wake — so the entry nothing has restamped in longest
   *   is the entry nothing is maintaining, which is the one to give up.
   * - **The inbox last of all, whatever its age.** This is the rule the ordering above
   *   cannot give on its own: from the console or the board the inbox's entry is written
   *   *first* by the background warm and is therefore the oldest thing in the store, so
   *   plain oldest-first would evict exactly the payload a reopen needs. It is the app's
   *   front door, it is what a notification opens, and it is the only view whose cold path
   *   is a `bd` sweep per workspace. It is given up only when there is nothing else left.
   * - **A payload too big to ever fit evicts nothing at all.** Checked before the first
   *   eviction rather than discovered after the last, so the pathological case — one
   *   enormous write — fails alone instead of emptying the store on its way down.
   */
  const BUDGET_BYTES = 1.5 * 1024 * 1024;

  const store = (() => {
    try {
      // Touched rather than merely read: a storage that exists and throws on write is
      // the case that matters, and it only says so when written to.
      const probe = `${PREFIX}probe`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return localStorage;
    } catch {
      return null;
    }
  })();

  /**
   * Whether a path is one the store gives up last. See `BUDGET_BYTES`.
   *
   * Matched on the route rather than on the whole key, because the inbox's entry is keyed
   * by the scope it was drawn at — `?scope=human` is the one `VIEWS` names and the one a
   * notification opens, and `?scope=both` is the same screen with the filter widened. A
   * device left on `both` reopens onto that entry, and protecting only the default would
   * quietly leave exactly that device paying the cold sweep this bead is about.
   */
  const LAST_TO_GO = new Set((VIEWS.find((v) => v.id === 'inbox')?.paths || []).map((p) => p.split('?')[0]));
  const lastToGo = (path) => LAST_TO_GO.has(path.split('?')[0]);

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
   * Null covers every way this can fail — never stored, stored by a build that wrote a
   * different shape, unparseable, or stamped in the future — because every caller does
   * the same thing with all four: fetch, the way it always did.
   *
   * **Age is no longer one of them.** See the header: an entry the event log has not
   * contradicted is as true as it was when it was fetched, and whether the log has been
   * followed since is the caller's question rather than this one's. `age` still comes
   * back, because `fresh()` below needs it for a quite different question — has this been
   * *fetched* recently enough that the background warm may skip it — and because a caller
   * that wants to make its own judgement should be able to.
   */
  function read(path, { now = Date.now() } = {}) {
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
    if (entry.v !== STORE_V) {
      // Written by a build that stored a different shape. Dropped rather than merely
      // refused: it will never match again, and it is holding quota the current build
      // has a use for.
      drop(path);
      return null;
    }
    const age = now - (Number(entry.at) || 0);
    if (age < 0) {
      // A clock that went backwards. Not paintable-but-old — unorderable, which is what
      // the eviction below sorts on, so it goes rather than corrupting that ordering.
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
   * **A write that does not fit evicts, and a write that can never fit fails alone.**
   * This used to answer a quota failure with `forget()`, which is the one thing a durable
   * store must not do — see `BUDGET_BYTES` for the ordering it uses instead. The failure
   * mode is unchanged from the caller's side: `false` means "not held", every reader
   * already treats that as a miss, and a page that cannot warm is merely as fast as it
   * was. What has changed is that failing to hold *this* payload no longer costs the
   * others.
   */
  function write(path, data, seq = 0) {
    if (!store || data == null) return false;
    const key = PREFIX + path;
    let raw;
    try {
      raw = JSON.stringify({ v: STORE_V, at: Date.now(), seq: Number(seq) || 0, data });
    } catch {
      return false; // something un-JSONable got in; not worth a second attempt
    }
    // Before anything is given up for it. A payload larger than the whole budget would
    // empty the store on its way to failing anyway, so it fails here instead, and the
    // stale entry it was meant to replace goes with it — that one *is* superseded.
    if (key.length + raw.length > BUDGET_BYTES) {
      drop(path);
      return false;
    }
    // Bounded by how many entries there are to give up, rather than by "until it fits".
    // A storage whose `removeItem` throws — which is a thing Safari does under a full
    // disk — would otherwise be an endless loop here, on the front of a page load, and a
    // spinning app is a great deal worse than a cold one.
    for (let tries = keys().length + 1; tries > 0; tries -= 1) {
      if (held(path) + key.length + raw.length <= BUDGET_BYTES && put(key, raw)) return true;
      // Either over our own budget or refused by the browser — the origin's quota is
      // shared with the token, the drafts and the send queue, so ours can be inside its
      // budget and still not fit. Same answer to both: give one up and try again.
      if (!evict(path)) break;
    }
    drop(path);
    return false;
  }

  /** How many characters our own entries are holding, ignoring one path we are replacing. */
  function held(except) {
    let n = 0;
    for (const path of keys()) {
      if (path === except) continue;
      let raw;
      try {
        raw = store.getItem(PREFIX + path);
      } catch {
        continue;
      }
      n += PREFIX.length + path.length + (raw ? raw.length : 0);
    }
    return n;
  }

  function put(key, raw) {
    try {
      store.setItem(key, raw);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Give up exactly one entry to make room, and say whether there was one to give.
   *
   * The ordering is `BUDGET_BYTES`'s: oldest `at` first, and the inbox's own paths only
   * once nothing else is left. `keep` is the path being written, which is never a
   * candidate — evicting it would make room by throwing away the thing we are here to
   * store, and the write would then succeed having achieved nothing.
   */
  function evict(keep) {
    let worst = null;
    for (const path of keys()) {
      if (path === keep) continue;
      const hit = read(path);
      // Unreadable — foreign, superseded, from a build that stored a different shape.
      // Dropped here rather than left to `read`'s own housekeeping, because the loop
      // above only terminates if every `true` from this function really did free
      // something, and two of `read`'s four miss paths do not remove anything.
      if (!hit) {
        drop(path);
        return true;
      }
      const rank = [lastToGo(path) ? 1 : 0, hit.at];
      if (!worst || rank[0] < worst.rank[0] || (rank[0] === worst.rank[0] && rank[1] < worst.rank[1])) {
        worst = { path, rank };
      }
    }
    if (!worst) return false;
    drop(worst.path);
    return true;
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
   * Called when a held payload stops being yours: the credential refused, a sign-out, a
   * device revoked, an account switched. That list matters more than it used to. These
   * entries survive the app closing now, so "it will be gone by tomorrow" has stopped
   * being true of anything here and every one of those moments has to say so out loud.
   *
   * It is deliberately **not** what a full store does any more. See `write`.
   */
  function forget() {
    for (const path of keys()) drop(path);
  }

  /**
   * Bring a held payload up to date without asking for it again — and reset its clock.
   *
   * The gap this closes: `prewarm` fills a path once per document, and `prewarmed` never
   * goes back to false — so on an inbox left open, which is the way this app is actually
   * used, whatever the background warm fetched in the first second is all any other tab
   * was ever going to get. Under the old fifteen-minute TTL that was worse than merely
   * unhelpful: the Advocates tab went *cold* a quarter of an hour in and nothing could put
   * it back. The entry was not wrong when it was dropped; it was merely old, and the delta
   * stream knows the difference. bc-1kwl.14 has since removed the TTL outright and the
   * entry now survives the app closing, which is the same argument taken to its end.
   *
   * So: a page that is parked on `/api/poll` calls this on every wake. `mutate` folds
   * whatever the wake carried into the data — the advocate roster rides every wake
   * whatever woke it — and the write underneath stamps `at` afresh. It costs no request,
   * and it is the only way an entry is marked live without one: `at` is what the
   * background warm's floor reads, and what the store's eviction order sorts on.
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
   * **And a `holdOnly` path is skipped whenever anything is held for it, at any age.**
   * This is bc-1kwl.15, and it is the one thing durability changed about this function.
   * `prewarm` runs once per *document*, so it runs again on every reopen — and for its
   * first two weeks that was simply correct, because a `sessionStorage` store came back
   * from a close empty and the only way the board was ever warm was this loop going and
   * fetching it. Now the entry survives the close. Re-fetching it is no longer what makes
   * the tab warm; it is a second copy of a payload already on the disk, and for these two
   * paths the copy costs `gh` once per repo (74s measured, bc-1kwl.1) and a `bd list` per
   * workspace plus a `bd show` per row (48s). Two minutes of the daemon's day, spent in
   * the background of every single app open, to replace two payloads that were already
   * paintable — that is precisely the reopen quietly turning into a `gh` sweep, and the
   * bead exists to stop it.
   *
   * What corrects them instead is what already corrected them: the page that boots from
   * one sweeps it on arrival, behind the frame it painted from the held copy (`warmBoot`
   * in public/prs.js, `load` in public/endorse.js), and while the inbox is up the log
   * restamps the entry for free and stops restamping the moment something contradicts it.
   * That is the same decision `MAINTAINED` in public/app.js already records for these two
   * and only these two — `refetch: false` — and this is that decision applied to the
   * other warmer. A path with no held entry at all is still fetched here, so the first
   * run on a new device, and the run after an eviction, are unchanged.
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
    // Hold-only is a property of the *path*, and a path is only hold-only if every view
    // that boots from it says so. One listed by an ordinary view as well is a path that
    // view is still owed — `filled` is what makes that decidable in one pass rather than
    // by trusting the order `VIEWS` happens to be in.
    const holdOnly = new Set();
    const filled = new Set();
    for (const view of VIEWS) {
      for (const path of view.paths) {
        if (mine.has(path)) continue;
        if (!wanted.includes(path)) wanted.push(path);
        (view.holdOnly ? holdOnly : filled).add(path);
      }
    }
    setTimeout(async () => {
      for (const path of wanted) {
        if (typeof document !== 'undefined' && document.hidden) break;
        if (fresh(path)) continue;
        // Held at any age is enough for these two. See the note above.
        if (holdOnly.has(path) && !filled.has(path) && read(path)) continue;
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
    STORE_V,
    BUDGET_BYTES,
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
