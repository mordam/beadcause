/* The ledger — every bead this space has ever had, most recently touched first.
 *
 * There was no way to look back. The inbox is what is arriving, the advocate console is
 * what is running this minute, and a bead that closed last week had left both lists by
 * definition: it was reachable only if you still remembered its id and could be bothered
 * to type it into the graph's query string. Meanwhile 298 beads are closed in beadcause
 * alone and their close reasons are unusually good — "Landed as #92 as 677b5a5b — still
 * owed: DEPLOYED" is a better answer to "did that ship?" than the PR board can give —
 * so the record already existed in full and nothing at all displayed it.
 *
 * ## The row is a teaser and the sheet is the answer
 *
 * Unlike the endorsement queue, which puts the whole bead in the row because you are
 * being asked to decide something, this is a list you *scan*: a screenful of ids,
 * titles and close reasons, and one tap opens the bead detail sheet that already exists.
 * `/graph?ws=…&id=…&open=1` is that sheet, deep-linked — the `&open=1` half was built
 * for exactly this (public/graph.js, "a link made right after filing something is a link
 * to read the thing you filed"), so this page needed no new detail view and does not
 * have one.
 *
 * The rows are real `<a href>`s, which is what makes drawer.js hold the sheet *over* the
 * list. That matters more here than anywhere else in the app: this is the one list you
 * legitimately scroll four hundred rows down, and a full-page navigation would spend
 * that scroll on every bead you looked at. Long-press → open in a new tab still works,
 * because the href is real.
 *
 * ## One picker, several repos, one merged list
 *
 * `/api/history` takes exactly one workspace and refuses a missing one (bc-nib3.1). The
 * top-level picker does not: `All spaces` is every repo you have, and a *space* is a
 * group of them — "Climative" is three. So "which workspaces am I looking at" is not a
 * filter applied to the response here, it is the shape of the request, and a space of
 * three repos is three requests whose answers have to become one list.
 *
 * They are merged rather than concatenated, and the difference is the whole point of a
 * ledger: a list that showed all of repo A and then all of repo B, each internally
 * newest-first, would put a bead from last March above one from this morning. So this
 * keeps a small buffer per repo — each already sorted newest-first by the server — and
 * repeatedly emits whichever repo's next row is the newest of them all. A k-way merge,
 * which is also what makes "load more" mean something across repos: paging is per repo
 * underneath and by *time* on screen.
 *
 * The subtle half is that a repo whose buffer has run dry must be re-filled *before* the
 * next comparison, not after. Its next page is older than everything it has already
 * given us, but it can still be newer than what another repo is offering — so an empty
 * buffer with more behind it is not "this repo is done", and treating it as one is how a
 * merge silently drops a fortnight of one repo out of the middle of the list. `pump()`
 * is that rule, and it is why the loop below fetches inside the loop rather than once at
 * the top.
 *
 * ## What it does not do
 *
 * **It does not filter.** Status, priority, provenance and an id substring are bc-nib3.3
 * and land on top of this — the server already takes all four. The one narrowing this
 * page has is the picker every page has.
 *
 * **It does not stream.** Every other standing view mounts stream.js and refreshes off
 * the daemon's event log; this one does not, and a fifth long poll parked against a page
 * about what already happened would be paying for liveness nobody asked for. A record
 * does not move under you — and on the two-second scale where it does, ⟳ is honest and a
 * list that reordered itself while your thumb was travelling towards a row would not be.
 *
 * **Nothing here writes.** No token is spent, no bead is touched, and there is no
 * control on this page that reaches the Mac — which is also why it carries no
 * `⦿ observing` chip. See public/history.html.
 */
(() => {
  'use strict';

  const token = (() => {
    try {
      return localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  })();

  const out = document.getElementById('history');
  const pulse = document.getElementById('pulse');
  const refreshBtn = document.getElementById('hist-refresh');

  /* How many rows one repo is asked for at a time, and how many are added to the
     screen per "load more". The fetch is the larger of the two on purpose: under a
     space of four repos a screenful of merged rows can come entirely from one of them,
     and a fetch size equal to the page size would then make every screenful a round
     trip. bc-nib3.1 pages in the daemon over a list it has already sorted, so a bigger
     limit costs it almost nothing. */
  const FETCH = 60;
  const PAGE = 40;

  const state = {
    /** The picker selection this list is of, as a string, so a repaint can tell
     *  whether the ground moved. */
    key: '',
    /** One per workspace in view: `{ workspace, buf, offset, more, total, error }`.
     *  `buf` is that repo's fetched-but-not-yet-emitted rows, newest first. */
    sources: [],
    /** What is on screen, merged, newest first. */
    rows: [],
    /** Bumped on every rebuild. An in-flight fetch whose generation has moved on
     *  belongs to a space you are no longer looking at, and must not append to this
     *  list — the picker is a dropdown and two taps in a second is normal. */
    gen: 0,
    loading: false,
    /** Has anything at all been asked for yet? Until it has, the page says so rather
     *  than claiming the ledger is empty. */
    ready: false,
    /** Has the picker told us which repos exist? An empty selection means two
     *  completely different things either side of this, and they look identical on
     *  screen: "no repo is configured under this space" and "the answer has not come
     *  back yet". */
    heard: false,
    /** The picker never answered at all — see the backstop at the foot of this file.
     *  Distinct from `heard`, because "no repo is configured" and "nobody could tell
     *  me" are the same empty list and must not be the same sentence. */
    mute: false,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** How long ago, in the two characters a phone has room for. As in endorse.js. */
  function age(iso) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const mins = Math.round((Date.now() - t) / 60000);
    if (mins < 1) return 'now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    const days = Math.round(hrs / 24);
    if (days < 365) return `${days}d`;
    return `${Math.round(days / 365)}y`;
  }

  /** The sort key. Epoch ms, and 0 for a row whose date will not parse — which sends
   *  it to the bottom rather than to a random place in the middle. String compare
   *  would work for the ISO the server sends and would quietly stop working the day
   *  one repo answered with an offset instead of `Z`. */
  const when = (row) => {
    const t = Date.parse(row && row.updated);
    return Number.isFinite(t) ? t : 0;
  };

  /* ------------------------------------------------------------------ the fetch */

  /**
   * One page of one repo, appended to its buffer.
   *
   * `more` is the server's own boolean and is trusted — except for the one case that
   * would spin this page forever: a response with no rows in it ends the repo whatever
   * it claims. A `more: true` over an empty page is a server bug, and the shape of that
   * bug here would be an infinite fetch loop rather than a missing row, so it is worth
   * the two lines to refuse it.
   */
  async function fetchPage(src, refresh) {
    const q = new URLSearchParams({
      workspace: src.workspace,
      limit: String(FETCH),
      offset: String(src.offset),
    });
    // Only on ⟳, and only for the first page of it: the daemon caches the unfiltered
    // sweep for ten seconds, so asking every page of a long scroll to re-sweep would
    // turn a free scroll into one full `bd list` per screenful.
    if (refresh) q.set('refresh', '1');
    const res = await fetch(`/api/history?${q}`, { headers: { 'x-beadcause-token': token } });
    if (!res.ok) throw new Error(res.status === 404 ? 'no ledger here' : `HTTP ${res.status}`);
    const data = await res.json();
    // A repo whose `bd` fell over is a **200** with a row in `errors[]` and no rows —
    // not a failed request. So the status code is not the whole of "did this work", and
    // trusting it alone is how a repo silently disappears out of a merged space view
    // looking exactly like a repo with nothing in it.
    const oops = (Array.isArray(data.errors) ? data.errors : []).find(
      (e) => !e || typeof e === 'string' || !e.workspace || e.workspace === src.workspace
    );
    if (oops) throw new Error(String((oops && (oops.error || oops.message)) || oops || 'bd would not answer'));
    const rows = Array.isArray(data.rows) ? data.rows : [];
    src.offset += rows.length;
    src.buf.push(...rows);
    if (Number.isFinite(data.total)) src.total = data.total;
    src.more = rows.length === 0 ? false : typeof data.more === 'boolean' ? data.more : rows.length >= FETCH;
  }

  /** Every live repo with an empty buffer, re-filled — see the header's third section. */
  async function pump(gen, refresh) {
    const hungry = state.sources.filter((s) => !s.buf.length && s.more && !s.error);
    if (!hungry.length) return;
    await Promise.all(
      hungry.map((s) =>
        fetchPage(s, refresh).catch((err) => {
          // A repo that will not answer drops out of the merge and says so under the
          // list. The other repos' rows are still worth showing — a space where one of
          // four is unreadable is not a space with no history.
          s.error = String((err && err.message) || err);
          s.more = false;
        })
      )
    );
    return gen;
  }

  /** The newest row across every buffer, removed from the one it came from. */
  function shiftNewest() {
    let best = null;
    for (const s of state.sources) {
      if (!s.buf.length) continue;
      if (!best || when(s.buf[0]) > when(best.buf[0])) best = s;
    }
    return best ? best.buf.shift() : null;
  }

  /** Is there anything left to show, buffered or unfetched? */
  const hasMore = () => state.sources.some((s) => s.buf.length || (s.more && !s.error));

  /**
   * Add up to `n` more rows to the list.
   *
   * Guarded by `gen` at every await, because the picker can move mid-flight and rows
   * from the space you just left must not land in the list for the one you are on.
   */
  async function loadMore(n = PAGE, refresh = false) {
    if (state.loading || !hasMore()) return;
    const gen = state.gen;
    state.loading = true;
    paint();
    try {
      const target = state.rows.length + n;
      let first = refresh;
      while (state.rows.length < target) {
        await pump(gen, first);
        first = false;
        if (gen !== state.gen) return;
        const row = shiftNewest();
        if (!row) break;
        state.rows.push(row);
      }
    } finally {
      if (gen === state.gen) {
        state.loading = false;
        state.ready = true;
        paint();
      }
    }
  }

  /**
   * Throw the list away and read it again — on a picker move, and on ⟳.
   *
   * The whole list, rather than the first page with the rest kept: the rows below are
   * a merge over per-repo offsets, and an offset means nothing once the set of repos
   * has changed underneath it.
   */
  function rebuild(workspaces, refresh = false) {
    state.gen += 1;
    state.sources = workspaces.map((workspace) => ({
      workspace,
      buf: [],
      offset: 0,
      more: true,
      total: null,
      error: null,
    }));
    state.rows = [];
    state.loading = false;
    // An empty selection has nothing to wait for, so it is `ready` the moment the
    // picker has spoken — and not before, or the first frame of every visit would
    // read "no repos" until /api/spaces landed.
    state.ready = !workspaces.length && state.heard;
    paint();
    if (workspaces.length) loadMore(PAGE, refresh);
  }

  /* ----------------------------------------------------------------- the drawing */

  const graphUrl = (ws, id) =>
    `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}&open=1`;

  /** P0 and P1 are the only priorities the stylesheet colours, deliberately — see
   *  `.pill.p0` — so this hands the number through and lets that decide. */
  const priorityPill = (p) =>
    Number.isFinite(p) ? `<span class="pill p${p}">P${p}</span>` : '';

  function rowHtml(row, showWorkspace) {
    const id = String(row.id ?? '');
    const ws = String(row.workspace ?? '');
    const status = String(row.status ?? '');
    const closed = status === 'closed';
    const sess = !!row.hasSession;
    const iso = String(row.updated ?? '');
    // A session marker has to survive being read out and being looked at in a hurry,
    // so it is three things at once: the glyph, the accent rule down the left edge
    // (`.hist-row.has-session`), and a word in the row's own label. Colour alone is
    // what the tab bar's own check refuses to accept as a mark, and a list of two
    // hundred rows is exactly where a 3px tint stops being legible.
    const marker = sess
      ? `<span class="hist-sess" title="A session was archived for this bead" aria-label="has an archived session">🗄</span>`
      : '';
    const why = closed && row.closeReason ? `<span class="hist-why">${esc(row.closeReason)}</span>` : '';
    // Three pills and no more, which is a width decision rather than a taste one: five
    // uppercase chips plus a marker wrap onto a second line at 393px, and a list of two
    // hundred rows that each wrap is a list you cannot skim. So the two that carry a
    // colour — the status, and a priority the stylesheet only tints at P0/P1 — stay
    // pills beside the id, and the type and the repo become the quiet text after them.
    const kind = [row.type, showWorkspace ? ws : ''].filter(Boolean).map(esc).join(' · ');
    return `<a class="hist-row${sess ? ' has-session' : ''}${closed ? ' is-closed' : ''}"
       href="${esc(graphUrl(ws, id))}">
      <span class="hist-main">
        <span class="hist-top">
          <span class="pill id">${esc(id)}</span>
          <span class="pill st-${esc(status)}">${esc(status.replace(/_/g, ' '))}</span>
          ${priorityPill(row.priority)}
          <span class="hist-kind${showWorkspace ? ' hist-ws' : ''}">${kind}</span>
          ${marker}
        </span>
        <span class="hist-title">${esc(row.title ?? '')}</span>
        ${why}
      </span>
      <time datetime="${esc(iso)}" title="${esc(iso)}">${esc(age(iso))}</time>
    </a>`;
  }

  /** "142 beads in beadcause" — but only when it is a fact. A total is the sum over
   *  every repo in view, so one repo that has not answered yet, or answered with an
   *  error, makes the sum a smaller number presented as the whole of it. */
  function countLine(label) {
    const live = state.sources.filter((s) => !s.error);
    if (!live.length || live.length !== state.sources.length) return '';
    if (live.some((s) => s.total == null)) return '';
    const total = live.reduce((a, s) => a + s.total, 0);
    return `<p class="hist-count">${plural(total, 'bead')} in ${esc(label)}</p>`;
  }

  function troubleHtml() {
    const bad = state.sources.filter((s) => s.error);
    if (!bad.length) return '';
    const which = bad.map((s) => `${esc(s.workspace)} (${esc(s.error)})`).join(', ');
    return `<p class="hist-trouble">⚠ Could not read ${which}. Everything below is the rest of the selection.</p>`;
  }

  /** The foot of the list: what is left, and the way to ask for it. */
  function footHtml() {
    if (state.loading) return `<div class="hist-foot"><span class="hist-more-note">Reading…</span></div>`;
    if (hasMore()) {
      return `<div class="hist-foot" data-sentinel>
        <button type="button" class="hist-more" id="hist-more">Load more</button>
      </div>`;
    }
    if (state.rows.length) return `<div class="hist-foot"><span class="hist-more-note">That is all of it.</span></div>`;
    return '';
  }

  function paint() {
    // `busy`, which is the class the stylesheet actually animates — see `.dot.busy`.
    if (pulse) pulse.classList.toggle('busy', state.loading);

    if (!token) {
      out.innerHTML = `<div class="empty"><strong>This device is not paired.</strong>Open the inbox first — it is where a token is set.</div>`;
      return;
    }

    const space = window.beadcause && window.beadcause.space;
    const label = space ? space.label() : 'everything';

    if (!state.sources.length) {
      // Two different nothings. No repo in the selection is a picker sitting on a space
      // whose repos have all left the config; not knowing yet is the first second of
      // the page, and saying "no history" then would be a lie that looks identical.
      out.innerHTML = !state.ready
        ? `<div class="empty">Reading the ledger…</div>`
        : state.mute
          ? `<div class="empty"><strong>Could not ask which repos exist.</strong>The daemon did not answer /api/spaces, so there is nothing to be the ledger of. ⟳ to try again.</div>`
          : `<div class="empty"><strong>No repos in ${esc(label)}.</strong>Nothing is configured under this selection.</div>`;
      return;
    }

    if (!state.rows.length) {
      // "Still coming" and "there is nothing" are the same blank screen, and here they
      // are not the same wait: a cold daemon sweeping five hundred beads on a loaded
      // Mac has been measured at 28s, and `{rows: [], total: 0}` is a perfectly good
      // answer for a repo nobody has filed anything in. So the first is said out loud
      // and the second is only said once the answer is actually in.
      if (state.loading || !state.ready) {
        out.innerHTML = `${troubleHtml()}<div class="empty"><strong>Reading the ledger…</strong>The first read of a repo can take a while — every bead in it, once, and then it is held for a few seconds.</div>`;
        return;
      }
      // "Nothing in beadcause yet" is a claim about the tracker, and a selection where
      // every repo failed to answer gives no grounds for making it — saying both, as
      // this did until the test below caught it, is a warning immediately contradicted
      // by a confident sentence underneath it.
      if (state.sources.every((s) => s.error)) {
        out.innerHTML = `${troubleHtml()}<div class="empty"><strong>Nothing could be read.</strong>Whether there is any history in ${esc(label)} is not something this page can say. ⟳ to try again.</div>`;
        return;
      }
      out.innerHTML = `${troubleHtml()}<div class="empty"><strong>Nothing in ${esc(label)} yet.</strong>Every bead this selection has ever had would be here.</div>`;
      return;
    }

    // The repo chip is drawn only when the selection holds more than one, because
    // under a single repo it is the same word on every row — noise in the one place
    // where the id has to be the thing your eye lands on.
    const showWorkspace = state.sources.length > 1;
    out.innerHTML = `${countLine(label)}${troubleHtml()}
      <div class="hist-list card">${state.rows.map((r) => rowHtml(r, showWorkspace)).join('')}</div>
      ${footHtml()}`;
    watchFoot();
  }

  /* ------------------------------------------------------------------ load more */

  /**
   * Reaching the end of the list asks for more of it.
   *
   * The button is the real control and the observer merely presses it: a sentinel that
   * *is* a button keeps the page usable by a keyboard and by a reader, both of which
   * can reach the end of a list without ever producing a scroll event, and it is the
   * fallback on any engine without IntersectionObserver. `rootMargin` starts the fetch
   * a screen early so the list grows before a fast thumb arrives at the bottom of it.
   */
  let observer = null;
  function watchFoot() {
    // Every repaint replaces the foot, so the node the observer was watching is
    // detached by the time we get here. Disconnected first and unconditionally: an
    // observer left on a removed element is a callback that can still fire.
    if (observer) observer.disconnect();
    const btn = out.querySelector('#hist-more');
    if (!btn) return;
    btn.addEventListener('click', () => loadMore());
    if (typeof IntersectionObserver !== 'function') return;
    if (observer) observer.disconnect();
    observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: '600px 0px' }
    );
    observer.observe(btn);
  }

  /* ----------------------------------------------------------------- the picker */

  /** The workspaces in view, as a stable string, so a repaint can tell a real move
   *  from the picker re-announcing what it already said. */
  const keyOf = (list) => JSON.stringify(list);

  function follow(heard) {
    const space = window.beadcause && window.beadcause.space;
    // Without the picker there is nothing to be the ledger *of* — /api/history has no
    // "every workspace" mode and this page deliberately does not invent one.
    const list = space ? space.inside() : [];
    const key = keyOf(list);
    if (heard) state.heard = true;
    if (key === state.key && state.sources.length) return;
    state.key = key;
    rebuild(list);
  }

  if (window.beadcause && window.beadcause.space) {
    window.beadcause.space.onChange(() => follow(true));
  }

  /* The picker announces itself once /api/spaces answers, and says nothing at all if
     that fetch fails — it is designed to leave a page showing everything rather than
     showing an error, which is right for the four pages that filter a list they
     already have and wrong for this one, whose entire request is the answer. So: a
     backstop, and a page that says which of the two silences this is. */
  setTimeout(() => {
    if (state.heard || !token) return;
    state.heard = true;
    if (!state.sources.length) {
      state.mute = true;
      state.ready = true;
      paint();
    }
  }, 8000);

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      // Deliberately not `follow()`: the selection has not moved, so `follow` would
      // decide there was nothing to do. ⟳ means "read it again" whatever the picker
      // says — and `refresh=1` with it, because the daemon holds the sweep for ten
      // seconds and the one press that means "I do not believe this" must not be
      // answered out of the cache it is doubting.
      const space = window.beadcause && window.beadcause.space;
      rebuild(space ? space.inside() : [], true);
    });
  }

  paint();
  // The picker fires `follow` itself once /api/spaces lands. This is the case where it
  // never will — no token, or a page opened with the picker already loaded — and it
  // costs nothing when the announcement does arrive, because `follow` is idempotent
  // against `state.key`.
  if (token) follow();
})();
