/*
  What landed — the closed beads, newest first, a page at a time.

  The one screen in this app that is purely read. There is nothing to answer, nothing to
  endorse, nothing to ship; every row is a link into the bead's own detail sheet and that
  is the whole of the navigation. Which makes it the simplest view here, and worth keeping
  that way — three things below are deliberate omissions rather than gaps.

  **No poll and no stream.** Every standing view mounts `/stream.js` and repaints on the
  event log. This one does not, because a history does not move: a bead that closed at
  nine will still have closed at nine, and the only change this list can ever see is one
  row arriving at the top. Against that, mounting the stream would put a fifth long poll
  on the daemon for a page you look at for ten seconds. ⟳ is the refresh, and it is
  enough — it also drops the server's sweep cache, which a poll would not.

  **Not in warm.js.** The warm layer prefetches the *other* tabs' payloads in the
  background so the next tab tap is instant, and its own header says the quiet part: two
  of those payloads are a `bd` sweep, and a page load must not turn into a sweep per
  view. This page is not a tab, it is not somewhere you live, and prewarming it would buy
  a sweep across seven workspaces on every load of every other page to save a second on a
  screen nobody opens hourly.

  **The picker refetches rather than repaints.** `public/prs.js` and `public/endorse.js`
  both hold every workspace's rows and merely redraw when the space picker moves. This one
  cannot, and the reason is paging: the server slices, so narrowing to one repo is a
  different page-one, not a filter over the page already on screen. See the header of
  lib/history.js.
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

  const out = document.getElementById('hx');
  const pulse = document.getElementById('pulse');

  /* How many rows a page asks for. Not the server's own default: 40 is about two thumb
     flicks on a phone, which is the unit "show more" should feel like. */
  const PAGE = 40;

  /* A close reason longer than this gets an expander instead of the whole wall of text.
     A character count rather than a measured height, because the alternative is laying
     the row out twice to find out — and the threshold only has to be *about* right: the
     median reason in this tracker is a line and a half, and five of 369 are over 500
     characters. Nothing is ever hidden by it, only folded; the text is in the DOM. */
  const CLAMP_CHARS = 240;

  const state = {
    /* Everything fetched so far, in order, across every "show more". The server pages a
       total order (see `newestClosedFirst`), so appending is safe: page two cannot repeat
       a row from page one, which is the whole reason that order is total. */
    rows: [],
    /* The answer to the last request, minus its rows — the counts, `more`, the sweep
       time and any workspace that failed. */
    meta: null,
    loading: false,
    error: null,
    first: true,
    /* Rows whose reason has been unfolded, by key. Kept out here so an append does not
       fold one back up under your thumb. */
    open: new Set(),
    /* The selection page one was last fetched for, as `space/workspace`. What makes the
       boot fetch and the picker's first notification the same request rather than two —
       see `asked` and the foot of this file. */
    asked: null,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* The bead's own detail sheet, in the drawer over this list. `open=1` is what lands on
     the bead's text rather than on the force layout it lives in — see the foot of
     public/graph.js. A real href, not a click handler, so long-press → open in new tab
     and a pasted URL both still work; drawer.js intercepts the plain tap. */
  const beadUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}&open=1`;

  /* ------------------------------------------------------------------- time */

  const DAY_MS = 86400000;

  const startOfDay = (d) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
  };

  /**
   * Which day heading a row belongs under — "Today", "Yesterday", then the date.
   *
   * Headings rather than a column of "3h ago / 5h ago / 1d ago", which is what this list
   * was before them: 369 rows of relative time is unreadable as a history, because the
   * question you arrive with is "what did I get done on Tuesday" and no amount of "2d
   * ago" answers it. The year is left off within this year and shown outside it.
   */
  function dayLabel(iso) {
    if (!iso) return 'When it closed is not recorded';
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return 'When it closed is not recorded';
    const days = Math.round((startOfDay(new Date()) - startOfDay(t)) / DAY_MS);
    if (days <= 0) return 'Today';
    if (days === 1) return 'Yesterday';
    const sameYear = t.getFullYear() === new Date().getFullYear();
    return t.toLocaleDateString(undefined, {
      weekday: days < 7 ? 'long' : undefined,
      day: 'numeric',
      month: 'short',
      year: sameYear ? undefined : 'numeric',
    });
  }

  /** The clock time on the row, since the day is already the heading above it. */
  function timeLabel(iso) {
    if (!iso) return '';
    const t = new Date(iso);
    if (Number.isNaN(t.getTime())) return '';
    return t.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }

  /** How stale the answer on screen is, for the line at the foot. */
  function ago(iso) {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    return `${Math.round(s / 3600)}h ago`;
  }

  /* ------------------------------------------------------------------ a row */

  function rowHtml(row, showDay) {
    const unfolded = state.open.has(row.key);
    const long = row.reason.length > CLAMP_CHARS;
    const pills = [`<span class="pill id">${esc(row.id)}</span>`];
    if (row.type) pills.push(`<span class="pill">${esc(row.type)}</span>`);
    /* The workspace, and only when the picker is not already saying it. On `All` this is
       the one thing a bare bead id does not tell you; narrowed to one repo it is the
       same word on all forty rows. */
    if (row.workspace && (state.meta?.filter?.workspace || 'all') === 'all') {
      pills.push(`<span class="pill">${esc(row.workspace)}</span>`);
    }

    const reason = row.reason
      ? `<p class="closed-why${unfolded ? ' unfolded' : ''}">${esc(row.reason)}</p>${
          long
            ? /* A span rather than a <button>, because the whole card is the <a> that
                 opens the bead and a button inside an anchor is not valid HTML. It takes
                 Enter and Space in the handler below, so a keyboard still reaches it. */
              `<span class="closed-more" role="button" tabindex="0" data-expand="${esc(row.key)}">${
                unfolded ? 'Fold the reason' : 'Read the whole reason'
              }</span>`
            : ''
        }`
      : /* Closed with nothing said. Worth drawing rather than leaving the row bare: the
           absence is the fact — this is a bead somebody closed without a word about what
           happened to it, which is a different thing from one closed by a delivery. */
        '<p class="closed-why none">Closed with no reason given.</p>';

    return `${showDay ? `<h2 class="section-label">${esc(dayLabel(row.closedAt))}</h2>` : ''}
      <a class="card closed-row" href="${esc(beadUrl(row.workspace, row.id))}">
        <div class="card-head">
          <div class="meta">
            ${pills.join('')}
            ${row.closedAt ? `<time datetime="${esc(row.closedAt)}">${esc(timeLabel(row.closedAt))}</time>` : ''}
          </div>
          <p class="closed-title">${esc(row.title)}</p>
          ${row.parent ? `<p class="closed-parent">under ${esc(row.parent)}</p>` : ''}
          ${reason}
        </div>
      </a>`;
  }

  /* ------------------------------------------------------------ the whole page */

  function emptyHtml() {
    const narrowed = (state.meta?.filter?.workspace || 'all') !== 'all' || (state.meta?.filter?.space || 'all') !== 'all';
    const where = window.beadcause?.space?.label?.() || '';
    return `<div class="empty"><strong>Nothing has closed yet</strong>${
      narrowed
        ? `No bead in ${esc(where || 'this selection')} has been closed. Widen the picker to see the rest.`
        : 'When a bead is answered, revoked or landed by a delivery, it appears here.'
    }</div>`;
  }

  function footHtml() {
    const m = state.meta;
    const lines = [];

    if (state.error) {
      lines.push(`<p class="board-foot bad">${esc(state.error)}</p>`);
    }
    for (const e of m?.errors || []) {
      /* Named, never swallowed: a repo missing from this list would otherwise read as a
         repo where nothing has ever been finished. */
      lines.push(`<p class="board-foot bad">${esc(e.workspace)} did not answer — ${esc(e.error)}</p>`);
    }

    if (m && state.rows.length) {
      /* Never below one: the button is only drawn when `more` is true, so a count of
         nought or less would be arithmetic over two numbers that disagree — a payload
         assembled before the last append — and "Show -3 more" on a button that works is
         worse than a plain one. */
      const left = Math.max(1, Math.min(PAGE, m.counts.matched - state.rows.length));
      const more = m.more
        ? `<button class="secondary hx-more" id="hx-more"${state.loading ? ' disabled' : ''}>${
            state.loading ? 'Loading…' : `Show ${left} more`
          }</button>`
        : '';
      const shown = `${state.rows.length} of ${plural(m.counts.matched, 'closed bead')}`;
      /* What is *outside* the picker, said rather than hidden. Without it a narrowed
         history reads as the whole tracker, and "12 closed beads" over a month of work
         is the kind of number somebody quotes. */
      const elsewhere =
        m.counts.matched < m.counts.total ? ` · ${m.counts.total - m.counts.matched} more outside this selection` : '';
      lines.push(more);
      lines.push(`<p class="board-foot">${esc(shown)}${esc(elsewhere)} · swept ${esc(ago(m.at))}</p>`);
    }

    return `<div class="hx-foot" id="hx-foot">${lines.filter(Boolean).join('')}</div>`;
  }

  /** Every row, drawn from scratch — a fresh load, a picker move, a ⟳. */
  function render() {
    if (!state.rows.length) {
      out.innerHTML = (state.error || state.meta?.errors?.length ? '' : emptyHtml()) + footHtml();
      wire();
      return;
    }
    let lastDay = null;
    const html = state.rows
      .map((row) => {
        const day = dayLabel(row.closedAt);
        const showDay = day !== lastDay;
        lastDay = day;
        return rowHtml(row, showDay);
      })
      .join('');
    out.innerHTML = html + footHtml();
    wire();
  }

  /**
   * The next page, put in above the foot rather than by redrawing the list.
   *
   * `innerHTML` on the container would collapse its height for a frame, and the browser
   * clamps a scroll offset it can no longer honour — so a "show more" that rebuilt the
   * page would throw you back to the top of a list you had scrolled two pages into,
   * which is the one thing paging must not do.
   */
  function append(rows) {
    const foot = document.getElementById('hx-foot');
    if (!foot) return render();
    let lastDay = state.rows.length > rows.length ? dayLabel(state.rows[state.rows.length - rows.length - 1].closedAt) : null;
    const html = rows
      .map((row) => {
        const day = dayLabel(row.closedAt);
        const showDay = day !== lastDay;
        lastDay = day;
        return rowHtml(row, showDay);
      })
      .join('');
    foot.insertAdjacentHTML('beforebegin', html);
    foot.outerHTML = footHtml();
    wire();
  }

  /** Repaint the foot alone — a load starting or failing, with the rows left alone. */
  function repaintFoot() {
    const foot = document.getElementById('hx-foot');
    if (!foot) return render();
    foot.outerHTML = footHtml();
    wire();
  }

  function wire() {
    const more = document.getElementById('hx-more');
    if (more) more.addEventListener('click', () => load({ offset: state.rows.length }));
  }

  /* One listener for the whole list rather than one per expander, because the rows are
     rebuilt on every load and a per-row listener would have to be re-attached each time. */
  out.addEventListener('click', (ev) => {
    const el = ev.target.closest?.('[data-expand]');
    if (!el) return;
    /* Both, and in this order: the anchor around it would otherwise open the bead sheet
       over the reason you just asked to read. */
    ev.preventDefault();
    ev.stopPropagation();
    toggle(el.dataset.expand);
  });

  out.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const el = ev.target.closest?.('[data-expand]');
    if (!el) return;
    ev.preventDefault();
    ev.stopPropagation();
    toggle(el.dataset.expand);
  });

  /* Folded in place, without a repaint: the row is the only thing that changed, and
     redrawing the list to unfold one paragraph would move everything under it. */
  function toggle(key) {
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    const unfolded = state.open.has(key);
    const el = out.querySelector(`[data-expand="${CSS.escape(String(key))}"]`);
    if (!el) return;
    el.textContent = unfolded ? 'Fold the reason' : 'Read the whole reason';
    el.previousElementSibling?.classList.toggle('unfolded', unfolded);
  }

  /* ---------------------------------------------------------------- the fetch */

  /**
   * Which request is the current one. Anything older is answered into the void.
   *
   * Not a `if (state.loading) return` guard, which is what this was first, and the
   * difference is a state the page can actually reach on every open: the boot fetch goes
   * out on the filter the picker has *before* `/api/spaces` has landed, which is
   * everything — and when it lands a moment later carrying a narrowed filter, `onChange`
   * fires while that first request is still in flight. Dropping the second request there
   * leaves the list showing every repo under a picker that says `beadcause`. So both go,
   * and only the newer one is allowed to paint.
   */
  let generation = 0;

  /**
   * One page. `offset` 0 replaces the list; anything else appends to it.
   *
   * The filter is sent rather than applied afterwards — the server slices, because the
   * server pages. `space.filter` is the picker's own `{space, workspace}`, which is the
   * same pair the daemon has stored and the same pair `matchesFilter` reads.
   */
  async function load({ offset = 0, refresh = false } = {}) {
    const mine = ++generation;
    const stale = () => mine !== generation;
    state.loading = true;
    if (offset) repaintFoot();
    pulse.classList.add('busy');
    const filter = window.beadcause?.space?.filter || { space: 'all', workspace: 'all' };
    const q = new URLSearchParams({
      space: filter.space || 'all',
      workspace: filter.workspace || 'all',
      offset: String(offset),
      limit: String(PAGE),
    });
    if (refresh) q.set('refresh', '1');
    if (!offset) state.asked = `${filter.space || 'all'}/${filter.workspace || 'all'}`;
    try {
      const res = await fetch(`/api/closed?${q}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      if (stale()) return;
      const fresh = data.beads || [];
      state.meta = { ...data, beads: undefined };
      state.error = null;
      state.first = false;
      state.loading = false;
      if (offset) {
        /* Belt and braces against a double tap on "show more": the server's order is
           total, so a repeat can only come from asking for the same offset twice, and a
           duplicated key would give two rows the same expander. */
        const seen = new Set(state.rows.map((r) => r.key));
        const add = fresh.filter((r) => !seen.has(r.key));
        state.rows = state.rows.concat(add);
        append(add);
        return;
      }
      state.rows = fresh;
      /* A fresh list is a different set of rows, so an unfolded reason on a row that is
         no longer here is a fold nobody asked for. */
      const live = new Set(state.rows.map((r) => r.key));
      for (const key of [...state.open]) if (!live.has(key)) state.open.delete(key);
      render();
    } catch (err) {
      if (stale()) return;
      state.error = err.message;
      state.loading = false;
      /* With rows already on screen this is a line at the foot rather than the loss of
         everything you were reading — the same bargain public/endorse.js makes. */
      if (state.rows.length) repaintFoot();
      else render();
    } finally {
      /* Only the newest request owns the spinner and the button: an older one finishing
         after it must not report the page as settled. */
      if (!stale()) {
        state.loading = false;
        pulse.classList.remove('busy');
      }
    }
  }

  window.beadcause?.presence?.report({ view: 'history' });

  /* The picker moved, on this device or the other one: a different page-one. See the
     header — this is the one list here that cannot narrow what it already holds.
     Guarded on the selection actually having changed, and that guard is what makes the
     boot below safe rather than merely tidy: `onChange` also fires once when the
     picker's own `/api/spaces` lands, carrying the stored filter, so without it every
     open of this page would fetch page one twice. */
  window.beadcause?.space?.onChange(({ filter } = {}) => {
    if (!token) return;
    const want = `${filter?.space || 'all'}/${filter?.workspace || 'all'}`;
    if (want === state.asked) return;
    load({ offset: 0 });
  });

  document.getElementById('hx-refresh').addEventListener('click', () => load({ offset: 0, refresh: true }));

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    /* The boot fetch is ours, not the picker's. Waiting for `onChange` would have been
       one fewer request in the good case and a page that never loads at all in the bad
       one: `load()` in public/spacebar.js returns silently on a non-200 or a thrown
       fetch — "no bar rather than a wrong one" — so `adopt` is never reached and nothing
       is ever notified. A history that hangs on "Reading what has closed…" because the
       *picker* could not be drawn is the wrong failure; this way the list arrives on the
       filter the daemon last stored, and if `/api/spaces` then lands with a different
       one the guard above fetches again. */
    load({ offset: 0 });
  }
})();
