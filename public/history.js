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
 * ## One picker, one request — and why there is no merging here
 *
 * The picker has exactly three states and `/api/history` takes exactly the same three:
 * one repo is `workspace=`, a space is `space=`, and `All spaces` is neither. So the
 * selection is not a filter applied to the response — it *is* the request, handed
 * straight through, and what comes back is already merged, sorted and paged across every
 * repo in the selection, with a `total` counted over all of them and one row in
 * `errors[]` per repo whose `bd` fell over.
 *
 * That is worth saying out loud because this page was first built the other way, and the
 * other way looked reasonable: one request per repo, and a k-way merge here over a
 * buffer each, re-filling whichever ran dry before the next comparison. It worked. It
 * was also a second implementation of something `lib/history.js` already does — and the
 * merge is the part with the subtlety in it, so having two of them was one to disagree
 * with the other. `ledgerWorkspaces` in lib/server.js resolves all three picker states,
 * the synthetic `Other` group included, which is what makes one request enough.
 *
 * What that leaves here is a cursor: `offset`, a `more` the server counted rather than
 * inferred, and the rows appended in the order they arrived. Paging is by time across
 * the whole selection because the server sorted the whole selection, not because
 * anything here put two lists together.
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

  /* One screenful and a bit, which is one request. The server pages over a list it has
     already swept and sorted, so the size is a readability decision rather than a cost
     one — and the sweep behind the first of them is held for ten seconds, which is what
     makes the rest of a long scroll free. */
  const PAGE = 40;

  /** The picker's own sentinel for "not narrowed" — see public/spacebar.js. */
  const ALL = 'all';

  const state = {
    /** The picker selection this list is of, as a string, so a repaint can tell
     *  whether the ground moved. */
    key: '',
    /** The selection as the server takes it: `{ workspace }`, `{ space }`, or neither. */
    scope: null,
    /** Where the next page starts, and whether there is one. `more` is the server's,
     *  counted rather than inferred from `rows.length === limit`. */
    offset: 0,
    more: true,
    /** How many beads the selection holds in total, and the repos whose `bd` fell
     *  over — both straight off the response. */
    total: null,
    errors: [],
    /** How old the last answer was, off `x-beadcause-kept` — `null` until one has
     *  landed, which is what keeps the mark off a first paint. See `parseKept`. */
    kept: null,
    /** What is on screen, newest first, in the order the server sent it. */
    rows: [],
    /** Bumped on every rebuild. An in-flight fetch whose generation has moved on
     *  belongs to a space you are no longer looking at, and must not append to this
     *  list — the picker is a dropdown and two taps in a second is normal. */
    gen: 0,
    loading: false,
    /** Has an answer landed yet? Until one has, "the ledger is empty" is a thing this
     *  page does not know, and a blank list saying so would be a guess. */
    ready: false,
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

  /**
   * How old the answer was, off the header the daemon puts it on.
   *
   *     x-beadcause-kept: stale; age=41; refreshing
   *
   * The daemon serves a kept answer immediately and sweeps behind it (lib/cache.js), so
   * a list can be up to date, ten seconds old, or — if `bd` has started refusing — much
   * older than that with a failure attached. Those are three different things to be
   * looking at and only the first is the one this page used to claim silently.
   *
   * A missing or unparseable header is `null` rather than a guess: an older daemon does
   * not send one, and "I do not know how old this is" must not draw as "this is fresh".
   */
  function parseKept(value) {
    if (!value) return null;
    const parts = String(value).split(';').map((s2) => s2.trim());
    const age = parts.find((s2) => s2.startsWith('age='));
    return {
      stale: parts[0] === 'stale',
      ageSec: age ? Number(age.slice(4)) || 0 : 0,
      refreshing: parts.includes('refreshing'),
    };
  }

  /* ------------------------------------------------------------------ the fetch */

  /**
   * The selection, as the three parameters `/api/history` takes.
   *
   * A repo wins over its space: the picker fills the space half in whenever you pick a
   * workspace (see `filterOf` in spacebar.js), so `{space: 'Personal', workspace:
   * 'beadcause'}` means *one repo*, and sending both would be asking the server to
   * decide which of the two we meant. `All spaces` sends neither, which is the
   * endpoint's own default rather than a magic value.
   */
  function scopeOf(filter) {
    const space = (filter && filter.space) || ALL;
    const workspace = (filter && filter.workspace) || ALL;
    if (workspace !== ALL) return { workspace };
    if (space !== ALL) return { space };
    return {};
  }

  /**
   * One page, appended to what is already on screen.
   *
   * `refresh` is only ever set on the first page of a ⟳ — the daemon holds the sweep for
   * ten seconds, and asking every page of a long scroll to re-sweep would turn a free
   * scroll into a full `bd list` per screenful.
   */
  async function fetchPage(refresh) {
    const q = new URLSearchParams({ limit: String(PAGE), offset: String(state.offset) });
    for (const [k, v] of Object.entries(state.scope || {})) q.set(k, v);
    if (refresh) q.set('refresh', '1');
    const res = await fetch(`/api/history?${q}`, { headers: { 'x-beadcause-token': token } });
    if (!res.ok) throw new Error(res.status === 404 ? 'no ledger here' : `HTTP ${res.status}`);
    // Every page carries it, and the latest one wins: a scroll that begins on a kept
    // answer and reaches its fourth page after the sweep landed is looking at fresh rows
    // by then, and the mark should have gone.
    state.kept = parseKept(res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-beadcause-kept') : null);
    const data = await res.json();
    const rows = Array.isArray(data.rows) ? data.rows : [];
    state.rows.push(...rows);
    state.offset += rows.length;
    if (Number.isFinite(data.total)) state.total = data.total;
    // A repo whose `bd` fell over is a row in here and a **200** — not a failed request,
    // and the other repos' rows come back around it. Read every time rather than only
    // when it is non-empty, so a repo that recovers on ⟳ stops being warned about.
    state.errors = Array.isArray(data.errors) ? data.errors : [];
    // The server's, counted from a total it actually has. The one thing not trusted is a
    // `more: true` over a page with no rows in it: that is a server bug whose shape here
    // would be an endless fetch loop rather than a missing row.
    state.more = rows.length === 0 ? false : typeof data.more === 'boolean' ? data.more : rows.length >= PAGE;
  }

  /** Is there anything left to ask for? */
  const hasMore = () => state.more;

  /**
   * Ask for the next page.
   *
   * Guarded by `gen` across the await, because the picker can move mid-flight — it is a
   * dropdown and two taps in a second is normal — and a page belonging to the space you
   * just left must not be appended to the list for the one you are on.
   */
  async function loadMore(refresh = false) {
    if (state.loading || !hasMore()) return;
    const gen = state.gen;
    state.loading = true;
    paint();
    try {
      await fetchPage(refresh);
    } catch (err) {
      if (gen !== state.gen) return;
      // Whatever is already on screen stays there. A failed second page is not a reason
      // to throw away the first.
      state.errors = [{ workspace: labelOf(), error: String((err && err.message) || err) }];
      state.more = false;
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
   * The whole list rather than the first page with the rest kept: `offset` counts into a
   * list the server sorted over one particular selection, and it means nothing once that
   * selection has changed underneath it.
   */
  function rebuild(scope, refresh = false) {
    state.gen += 1;
    state.scope = scope;
    state.rows = [];
    state.offset = 0;
    state.more = true;
    state.total = null;
    state.errors = [];
    state.kept = null;
    state.loading = false;
    // There is always something to ask for now — every selection is a legal request,
    // including the empty one — so the page is never `ready` before an answer.
    state.ready = false;
    paint();
    loadMore(refresh);
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

  /** "142 beads in beadcause" — but only when it is a fact. The server counts `total`
   *  over the repos that answered, so a selection with a repo in `errors[]` would be a
   *  smaller number presented as the whole of it. */
  function countLine(label) {
    // Suppressed by a repo that could not be read *at all*, because then the number is a
    // count of some of the selection presented as the whole of it. A repo being drawn
    // over a failed refresh is not that: every one of its rows is here and counted, they
    // are simply older, which `keptSuffix` says on the same line.
    if (state.total == null || state.errors.some((e) => !e || !e.stale)) return '';
    return `<p class="hist-count">${plural(state.total, 'bead')} in ${esc(label)}${keptSuffix()}</p>`;
  }

  /**
   * The mark that says you are looking at a kept answer — and it is deliberately quiet.
   *
   * A spinner over the list would be worse than the staleness it is announcing: the whole
   * point of the daemon answering out of memory is that the rows are *there*, instantly,
   * and covering them to say "these arrived instantly" would be the one change that undoes
   * the improvement. So it is a clause at the end of the count line, in the muted colour
   * the count is already in, and it disappears on the repaint that brings fresh rows.
   *
   * Nothing is drawn for a fresh answer, and nothing is drawn before one has landed — the
   * first paint of a cold page must not accuse the daemon of holding something back.
   */
  function keptSuffix() {
    const k = state.kept;
    if (!k || !k.stale) return '';
    const secs = Math.max(0, Math.round(k.ageSec));
    const ago = secs < 60 ? `${secs}s` : `${Math.round(secs / 60)}m`;
    return ` <span class="hist-kept">· as of ${ago} ago${k.refreshing ? ', refreshing' : ''}</span>`;
  }

  /**
   * The repos that would not answer — and the ones being drawn over a failure.
   *
   * Two different sentences, because they are two different situations and the old one
   * was wrong about the second. A repo with `stale: true` **is** on screen: its rows are
   * the last good sweep, and what has failed is the attempt to replace them. Saying
   * "could not read it, everything below is the rest of the selection" about a repo whose
   * rows are half the list is both alarming and untrue. What a person needs told there is
   * that the list has stopped moving, and how long ago it stopped.
   */
  function troubleHtml() {
    if (!state.errors.length) return '';
    const named = (e) => `${esc((e && e.workspace) || 'a repo')} (${esc((e && e.error) || 'would not answer')})`;
    const dead = state.errors.filter((e) => !e || !e.stale);
    const held = state.errors.filter((e) => e && e.stale);
    const lines = [];
    if (dead.length) {
      const rest = state.rows.length ? ' Everything below is the rest of the selection.' : '';
      lines.push(`⚠ Could not read ${dead.map(named).join(', ')}.${rest}`);
    }
    if (held.length) {
      const when = state.kept && state.kept.stale ? ` The rows below are as of ${Math.max(0, Math.round(state.kept.ageSec))}s ago.` : '';
      lines.push(`⚠ ${held.map(named).join(', ')} — showing the last good read.${when}`);
    }
    return lines.map((l) => `<p class="hist-trouble">${l}</p>`).join('');
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

    const label = labelOf();

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
      // "Nothing in beadcause yet" is a claim about the tracker, and a selection that
      // came back with nothing *and* an error in it gives no grounds for making one —
      // saying both, as this did until the test below caught it, is a warning
      // immediately contradicted by a confident sentence underneath it.
      if (state.errors.length) {
        out.innerHTML = `${troubleHtml()}<div class="empty"><strong>Nothing could be read.</strong>Whether there is any history in ${esc(label)} is not something this page can say. ⟳ to try again.</div>`;
        return;
      }
      out.innerHTML = `<div class="empty"><strong>Nothing in ${esc(label)} yet.</strong>Every bead this selection has ever had would be here.</div>`;
      return;
    }

    // The repo is named on each row only when the selection can hold more than one,
    // because under a single repo it is the same word all the way down — noise in the
    // one place where the id has to be what your eye lands on.
    const showWorkspace = !(state.scope && state.scope.workspace);
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

  /** What the picker is on, defaulting to everything — which is both the picker's own
   *  default and the endpoint's, so a page that renders before /api/spaces has landed
   *  asks the same question it would have asked afterwards. */
  const filterNow = () => (window.beadcause && window.beadcause.space && window.beadcause.space.filter) || null;

  /** What is selected, in words, for the count line and the empty states. */
  const labelOf = () =>
    (window.beadcause && window.beadcause.space && window.beadcause.space.label()) || 'everything';

  function follow() {
    const scope = scopeOf(filterNow());
    // A stable string, so the picker re-announcing what it already said — which it does
    // on load, and again after every write — does not throw a list away and re-fetch it.
    const key = JSON.stringify(scope);
    if (key === state.key && state.scope) return;
    state.key = key;
    rebuild(scope);
  }

  if (window.beadcause && window.beadcause.space) {
    window.beadcause.space.onChange(follow);
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      // Deliberately not `follow()`: the selection has not moved, so `follow` would
      // decide there was nothing to do. ⟳ means "read it again" whatever the picker
      // says — and `refresh=1` with it, because the daemon holds the sweep for ten
      // seconds and the one press that means "I do not believe this" must not be
      // answered out of the cache it is doubting.
      rebuild(scopeOf(filterNow()), true);
    });
  }

  paint();
  // The picker fires `follow` itself once /api/spaces lands. This is the case where it
  // never will — no token, or a page opened with the picker already loaded — and it
  // costs nothing when the announcement does arrive, because `follow` is idempotent
  // against `state.key`.
  if (token) follow();
})();
