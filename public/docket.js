/* The docket — an epic's whole arc, in the order it happened.
 *
 * bc-it26z. A card gives you the bead and nothing around it, and Adam's account of what
 * that costs is the whole brief: "the cards coming to me are sometimes hard to understand
 * quickly because a lot of context is missing." This is where a card sends you for the
 * rest of it. lib/docket.js is the read model and carries the argument for every rule
 * about *what* is in the payload; this file is only the drawing.
 *
 * ## Four blocks, and the order is the argument
 *
 *   1. **Where it is.** The epic's own title and description, and one line of counts.
 *      First because it is the question a reader arrives with — you tapped through from a
 *      card, and the thing you need in the first second is whether this epic is nearly
 *      done or barely started.
 *   2. **The phases**, when the epic has a plan (lib/plan.js). A planner already broke
 *      this work into named groups; a page that made the reader re-derive that from a
 *      list of thirty beads would be throwing away the best writing on the bead.
 *   3. **The map** — every bead in the family, indented by depth, in the order they were
 *      filed. The bead you came from is lit.
 *   4. **The chronology.** Everything dated, grouped by day.
 *
 * ## The fold, and why it is per day rather than one switch
 *
 * The payload marks each event `machine: true` or not — the rules are lib/docket.js's and
 * each one is tied to the single place in the tree that writes the thing. A day draws its
 * decisions, closes and deliveries always, and puts its claims, agent comments and
 * session runs behind one control that says how many there are.
 *
 * Per day rather than one page-level switch because the question is always local: "why
 * did nothing happen for four days" is asked *of a particular gap*, and the answer is
 * usually eleven folded lines on one of them. A single switch answers it by expanding
 * everything at once, which on a fortnight's epic is a screen you have to leave.
 *
 * ## Oldest first, with a toggle
 *
 * A docket is read forwards — it is a story about how the work went, and a feed order
 * makes the first thing you meet the most recent thing you already knew. But the state
 * you are *acting* on is at the far end, so the order is one tap away and the choice is
 * remembered in `localStorage` per device.
 *
 * ## Two modes, one document
 *
 * With an `id` in the query this is one epic. Without one it is the index — every root
 * with children, newest activity first — which is the third of the three shapes bc-it26z
 * settled: reachable from a card, and browsable when you want to catch up instead. One
 * page because "which epic" is the only difference, and a second document would be a
 * second copy of the same fetch, the same styles and the same empty state.
 *
 * ## It reads, and that is all it does
 *
 * Every request here is a GET and there is no poll. A docket describes a fortnight; the
 * one thing it must not do is compete for the daemon with the inbox that is waiting on an
 * answer. `test/docket.mjs` asserts the absence of a non-GET in this file, because
 * "read-only" stays true right up until somebody adds a convenience button.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('docket');
  const pulse = document.getElementById('pulse');
  const titleEl = document.getElementById('arc-title');

  const params = new URLSearchParams(location.search);
  // `ws` as well as `workspace`, because /graph spells it `ws` and every row that links
  // to both pages would otherwise have to remember which spelling goes where.
  const ws = params.get('workspace') || params.get('ws') || '';
  const bead = params.get('id') || '';

  const ORDER_KEY = 'beadcause.docket.order';
  const state = {
    /** The `/api/docket` answer, or the `/api/dockets` rows in index mode. */
    docket: null,
    index: null,
    /** Which days have had their machine lines opened. Keyed by `YYYY-MM-DD`. */
    open: new Set(),
    /** `'old'` (the arc) or `'new'` (what just happened). Remembered per device. */
    order: localStorage.getItem(ORDER_KEY) === 'new' ? 'new' : 'old',
    stopped: null,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* --------------------------------------------------------------- saying when */

  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /** `Tue 12 Aug` — the heading on a day. The year only when it is not this one. */
  function dayLabel(key) {
    const d = new Date(`${key}T12:00:00`);
    if (Number.isNaN(d.getTime())) return key;
    const year = d.getFullYear() === new Date().getFullYear() ? '' : ` ${d.getFullYear()}`;
    return `${DAY[d.getDay()]} ${d.getDate()} ${MONTH[d.getMonth()]}${year}`;
  }

  /** `14:07` — the clock on a line. "3h ago" does not say whether it was Tuesday. */
  function clock(at) {
    const d = new Date(at);
    if (Number.isNaN(d.getTime())) return '';
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }

  /** `4 days`, `3 months` — how long the whole arc has been running. */
  function spanOf(from, to) {
    const a = new Date(from).getTime();
    const b = new Date(to).getTime();
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
    const days = Math.round((b - a) / 86400000);
    if (days < 1) return 'today';
    if (days === 1) return '1 day';
    if (days < 60) return `${days} days`;
    return `${Math.round(days / 30)} months`;
  }

  /* ----------------------------------------------------------------- the links */

  const graphUrl = (id) => `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}&open=1`;
  const docketUrl = (workspace, id) =>
    `/docket?ws=${encodeURIComponent(workspace)}&id=${encodeURIComponent(id)}`;

  /* ------------------------------------------------------------- the top block */

  const STATUS_LABEL = { in_progress: 'claimed', blocked: 'blocked', open: 'open', closed: 'closed' };

  const statusPill = (status) =>
    `<span class="pill st-${esc(status)}">${esc(STATUS_LABEL[status] || status)}</span>`;

  /**
   * The counts, as a sentence rather than a bar.
   *
   * "9 of 24 closed" is a fact. A bar at 37% invites the reading that the remaining 63%
   * is the same size as the first, which on a tracker where one bead can be a fortnight
   * is exactly the thing not to imply — see `progressOf` in lib/docket.js, which counts
   * for the same reason.
   *
   * `asking` and `held` are drawn as their own clauses, in the warn colour, because they
   * are the two states waiting on **you** rather than on work: an epic that looks stalled
   * is usually one of those two, and that is the sentence worth reading first.
   */
  function progressHtml(p) {
    const c = p?.counts || {};
    const parts = [`<strong>${c.closed || 0}</strong> of <strong>${c.total || 0}</strong> closed`];
    if (c.in_progress) parts.push(`${c.in_progress} claimed`);
    if (c.blocked) parts.push(`${c.blocked} blocked`);
    const span = spanOf(p?.firstAt, p?.lastAt);
    if (span) parts.push(`over ${esc(span)}`);
    const waiting = [];
    if (c.asking) waiting.push(`${c.asking} asking you`);
    if (c.held) waiting.push(`${c.held} held for endorsement`);
    return `<p class="dk-progress">${parts.join(' · ')}${
      waiting.length ? ` · <span class="dk-waiting">${esc(waiting.join(' · '))}</span>` : ''
    }</p>`;
  }

  /**
   * The epic's own account of itself, clamped.
   *
   * Not rendered as markdown, and that is a decision rather than a shortcut: the
   * renderer lives in public/app.js, nothing under `public/` imports from anything else,
   * and a fourth copy of it would be a fourth place for the same escaping bug. What this
   * block is for is orientation — the first two paragraphs of what the epic says it is —
   * and the whole of it, formatted, is one tap away on the bead's own card and on
   * `/graph`. So: plain text, the fences and emphasis marks taken off the way the inbox's
   * own `plainly` does, clamped by CSS rather than by slicing so nothing is cut mid-word.
   */
  const plainly = (s) =>
    String(s || '')
      .replace(/```[\s\S]*?```/g, '')
      .replace(/\*\*/g, '')
      .replace(/`/g, '')
      .trim();

  function headHtml(d) {
    const r = d.root;
    const focusIsRoot = d.focus === r.id;
    const blurb = plainly(r.description).split('\n\n').slice(0, 2).join('\n\n');
    return `<section class="dk-head">
      <div class="dk-chips">
        <span class="pill">${esc(d.workspace || ws)}</span>
        <a class="pill id" href="${esc(graphUrl(r.id))}">${esc(r.id)}</a>
        ${r.priority != null ? `<span class="pill p${esc(r.priority)}">P${esc(r.priority)}</span>` : ''}
        ${statusPill(r.status)}
        ${r.issue_type ? `<span class="pill">${esc(r.issue_type)}</span>` : ''}
      </div>
      <h2 class="dk-title">${esc(r.title)}</h2>
      ${
        focusIsRoot
          ? ''
          : `<p class="dk-came-from">You came from <a href="#bead-${esc(d.focus)}">${esc(d.focus)}</a>, which is under this.</p>`
      }
      ${progressHtml(d.progress)}
      ${blurb ? `<div class="dk-blurb">${esc(blurb)}</div>` : ''}
    </section>`;
  }

  /* ---------------------------------------------------------------- the phases */

  /**
   * The plan's groups, each with the state of the beads it named.
   *
   * A phase is done when every bead in it is closed, running when any is claimed, and
   * waiting otherwise — computed here from the family rather than stored anywhere,
   * because a plan is written once and the beads under it move for weeks afterwards. A
   * plan that recorded its own progress would be a second copy of the tracker, wrong
   * within a day.
   *
   * A bead a plan names that is no longer in the family is drawn as `gone` rather than
   * dropped: `bd update --parent` moves beads and does not renumber, so a group pointing
   * at a bead that has left is a real thing to see and not a rendering bug to hide.
   */
  function phasesHtml(d) {
    const groups = d.plan?.groups;
    if (!groups?.length) return '';
    const by = new Map(d.family.map((b) => [b.id, b]));
    const rows = groups.map((g) => {
      const beads = (g.beads || []).map((id) => by.get(id) || null);
      const known = beads.filter(Boolean);
      const done = known.length && known.every((b) => b.status === 'closed');
      const running = known.some((b) => b.status === 'in_progress');
      const word = done ? 'done' : running ? 'running' : 'waiting';
      return `<li class="dk-phase dk-phase-${word}">
        <span class="dk-phase-mark" aria-hidden="true">${done ? '●' : running ? '◐' : '○'}</span>
        <span class="dk-phase-body">
          <span class="dk-phase-name">${esc(g.name)}</span>
          <span class="dk-phase-beads">${(g.beads || [])
            .map((id) => {
              const b = by.get(id);
              return `<a class="pill id${b ? (b.status === 'closed' ? ' done' : '') : ' gone'}"
                href="#bead-${esc(id)}">${esc(id)}</a>`;
            })
            .join('')}</span>
        </span>
        <span class="dk-phase-word">${word}</span>
      </li>`;
    });
    return `<section class="dk-block">
      <div class="section-label">Phases <span>${groups.length} group${groups.length === 1 ? '' : 's'}, as the planner wrote them</span></div>
      <ul class="dk-phases">${rows.join('')}</ul>
    </section>`;
  }

  /* ------------------------------------------------------------------- the map */

  /**
   * Every bead in the family, indented by depth, oldest first.
   *
   * Oldest first is the server's ordering and the argument is `familyOf`'s: a board
   * sorts done-last because a board is a list of what to do next, and a docket is the
   * opposite question. A bead that closed in June keeps the place it had.
   *
   * The row links to `/graph`, not to another docket: every bead here is already in
   * *this* family, so a docket link would be a link to the page you are on. The one
   * exception is the index, where a row is a different epic and does link to its docket.
   *
   * `asks you` is the pill that matters most on this page — the inbox's own word for a
   * bead carrying `human`, drawn here so an epic's stall is visible in the map and not
   * only in the counts.
   */
  function mapHtml(d) {
    const rows = d.family.map((b) => {
      const asks = (b.labels || []).includes('human') && b.status !== 'closed';
      const held = (b.labels || []).includes('unendorsed') && b.status !== 'closed';
      return `<a class="dk-row${b.status === 'closed' ? ' done' : ''}${b.id === d.focus ? ' focus' : ''}"
        id="bead-${esc(b.id)}" href="${esc(graphUrl(b.id))}" style="--depth:${Math.min(b.depth, 5)}">
        <span class="pill id">${esc(b.id)}</span>
        ${asks ? '<span class="pill dk-asks">asks you</span>' : ''}
        ${held ? '<span class="pill muted">held</span>' : ''}
        ${b.status === 'open' ? '' : statusPill(b.status)}
        <span class="dk-row-title">${esc(b.title)}</span>
      </a>`;
    });
    return `<section class="dk-block">
      <div class="section-label">The map <span>${d.family.length} bead${
        d.family.length === 1 ? '' : 's'
      }, in the order they were filed</span></div>
      <div class="dk-map">${rows.join('')}</div>
    </section>`;
  }

  /* ------------------------------------------------------------ the chronology */

  const GLYPH = {
    filed: '＋',
    claimed: '◐',
    planned: '⌗',
    ruled: '⚑',
    replied: '✎',
    commented: '💬',
    closed: '●',
    session: '🖥',
    'pr-opened': '⇧',
    'pr-merged': '⤵',
  };

  /** Who spoke, in the three words lib/docket.js's `voiceOf` can honestly offer. */
  const VOICE = { agent: 'an agent', daemon: 'beadcause', person: '' };

  /**
   * One line of the stream.
   *
   * The bead id leads every line, because the whole difficulty this page exists to fix is
   * not knowing which piece of a family a thing happened to. The sentence is deliberately
   * plain and past tense: this is a record, and a record that editorialises is one you
   * have to discount as you read it.
   */
  function eventHtml(e) {
    const who = e.who ? ` (${esc(e.who)})` : '';
    const voice = VOICE[e.voice] || '';
    let what = '';
    if (e.kind === 'filed') what = 'filed';
    else if (e.kind === 'claimed') what = `claimed${e.who ? ` by ${esc(e.who.split('@')[0])}` : ''}`;
    else if (e.kind === 'planned')
      what = `planned into ${e.groups?.length || 0} group${e.groups?.length === 1 ? '' : 's'} — ${(e.groups || [])
        .map((g) => esc(g.name))
        .join(', ')}`;
    else if (e.kind === 'ruled') what = '<strong>you ruled</strong>';
    else if (e.kind === 'replied') what = '<strong>you said</strong>';
    else if (e.kind === 'commented') what = `${voice ? `${voice}${who} ` : ''}commented`;
    else if (e.kind === 'closed') what = 'closed';
    else if (e.kind === 'session') what = 'a session ran';
    else if (e.kind === 'pr-opened') what = `#${esc(e.number)} opened${e.repo ? ` in ${esc(e.repo)}` : ''}`;
    else if (e.kind === 'pr-merged') what = `#${esc(e.number)} <strong>merged</strong>`;

    const body =
      e.kind === 'closed'
        ? e.reason
          ? `<div class="dk-ev-text">${esc(e.reason)}</div>`
          : ''
        : e.text
          ? `<div class="dk-ev-text">${esc(e.text)}</div>`
          : '';

    const link = e.url
      ? `<a class="dk-ev-out" href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>`
      : '';

    return `<li class="dk-ev dk-ev-${esc(e.kind)}${e.machine ? ' machine' : ''}">
      <span class="dk-ev-when">${esc(clock(e.at))}</span>
      <span class="dk-ev-glyph" aria-hidden="true">${GLYPH[e.kind] || '•'}</span>
      <span class="dk-ev-body">
        <span class="dk-ev-head">
          <a class="pill id" href="#bead-${esc(e.bead)}">${esc(e.bead)}</a>
          <span class="dk-ev-what">${what}</span>
          ${link}
        </span>
        ${body}
      </span>
    </li>`;
  }

  /**
   * The stream, in days.
   *
   * The fold is per day and its control says how many lines are behind it — a control
   * that did not would be asking you to tap to find out whether it was worth tapping. The
   * day heading is always drawn even when every event on it is folded: a day on which
   * only the machine did anything is a real answer to "what happened that week", and a
   * page that skipped it would read as a gap in the record rather than as quiet.
   */
  function chronologyHtml(d) {
    const events = state.order === 'new' ? [...d.events].reverse() : d.events;
    if (!events.length) {
      return `<section class="dk-block">
        <div class="section-label">The chronology</div>
        <div class="empty"><strong>Nothing dated</strong>Every bead in this family arrived without a
        timestamp, which is not something the tracker does — so this is almost certainly a
        record that predates the field rather than work that never happened.</div>
      </section>`;
    }

    const days = new Map();
    for (const e of events) {
      const key = String(e.at).slice(0, 10);
      if (!days.has(key)) days.set(key, []);
      days.get(key).push(e);
    }

    const blocks = [...days.entries()].map(([key, list]) => {
      const shown = list.filter((e) => !e.machine);
      const hidden = list.filter((e) => e.machine);
      const open = state.open.has(key);
      const lines = open ? list : shown;
      return `<div class="dk-day">
        <div class="dk-day-head">
          <span class="dk-day-name">${esc(dayLabel(key))}</span>
          ${
            hidden.length
              ? `<button type="button" class="dk-fold" data-day="${esc(key)}" aria-expanded="${open}">${
                  open ? '− hide' : `+ ${hidden.length}`
                } machine line${hidden.length === 1 ? '' : 's'}</button>`
              : ''
          }
        </div>
        <ul class="dk-evs">${lines.map(eventHtml).join('')}</ul>
      </div>`;
    });

    return `<section class="dk-block">
      <div class="section-label">The chronology
        <span>${events.length} event${events.length === 1 ? '' : 's'}${
          d.prsKnown ? '' : ' · pull requests not swept yet, so deliveries may be missing'
        }</span>
      </div>
      <div class="dk-order">
        <button type="button" class="secondary" data-act="order">${
          state.order === 'old' ? 'Oldest first ↓' : 'Newest first ↑'
        }</button>
      </div>
      <div class="dk-days">${blocks.join('')}</div>
    </section>`;
  }

  /* ----------------------------------------------------------------- the index */

  /**
   * Every epic with a docket, newest activity first.
   *
   * Counts on the row rather than a title alone, because the reason to come here cold is
   * to find the thing that is stuck — and "3 asking you" is what that looks like from
   * outside. Rows link to dockets, which is the one place in this file where a row does
   * not go to `/graph`.
   */
  function indexHtml(rows) {
    if (!rows.length) {
      return `<div class="empty"><strong>No beadepics yet</strong>A docket is drawn for a bead that has
        children under it. Nothing in this workspace has any — which is a fact about the
        tracker rather than about this page.</div>`;
    }
    const items = rows.map((r) => {
      const c = r.counts || {};
      const waiting = [];
      if (c.asking) waiting.push(`${c.asking} asking you`);
      if (c.held) waiting.push(`${c.held} held`);
      return `<a class="dk-index-row${r.status === 'closed' ? ' done' : ''}" href="${esc(docketUrl(r.workspace, r.id))}">
        <span class="dk-index-top">
          <span class="pill">${esc(r.workspace)}</span>
          <span class="pill id">${esc(r.id)}</span>
          ${r.priority != null ? `<span class="pill p${esc(r.priority)}">P${esc(r.priority)}</span>` : ''}
          ${r.status === 'open' ? '' : statusPill(r.status)}
        </span>
        <span class="dk-index-title">${esc(r.title)}</span>
        <span class="dk-index-counts">${c.closed || 0} of ${c.total || 0} closed${
          waiting.length ? ` · <span class="dk-waiting">${esc(waiting.join(' · '))}</span>` : ''
        }</span>
      </a>`;
    });
    return `<section class="dk-block">
      <div class="section-label">Beadepics <span>${rows.length}, most recently touched first</span></div>
      <div class="dk-index">${items.join('')}</div>
    </section>`;
  }

  /* ----------------------------------------------------------------- rendering */

  function setTitle() {
    const name = state.docket ? state.docket.root.title : bead ? 'Docket' : 'Beadepics';
    titleEl.textContent = name;
    document.title = `Beadcause · ${name}`;
    // Nothing is posted up to a drawer panel from here. public/drawer.js reads the
    // `.topbar h1` above and watches it with a `MutationObserver` for exactly this — a
    // page that renames itself after its first paint — so writing the heading *is*
    // handing the name up, and a second channel for it would be a second thing to keep
    // in step.
  }

  function render() {
    if (state.stopped) {
      out.innerHTML = `<div class="empty"><strong>${esc(state.stopped.title)}</strong>${esc(
        state.stopped.detail || ''
      )}</div>`;
      return;
    }
    if (state.index) {
      out.innerHTML = indexHtml(state.index);
      return;
    }
    const d = state.docket;
    if (!d) return;
    out.innerHTML = [headHtml(d), phasesHtml(d), mapHtml(d), chronologyHtml(d)].join('');
    setTitle();
  }

  /* ------------------------------------------------------------------- loading */

  async function api(path) {
    const res = await fetch(path, { headers: { 'x-beadcause-token': token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /**
   * Load, once.
   *
   * No polling. A docket describes a fortnight of work and the one thing it must not do
   * is compete for the daemon with the inbox that is waiting on an answer — the sweep
   * behind it is a whole `bd export`, which is the second most expensive call in the app.
   * What a reader who wants it again has is the browser's own reload, which lands on
   * `refresh=1`'s door with no code here at all.
   */
  async function load() {
    pulse.classList.add('busy');
    try {
      if (bead) {
        state.docket = await api(`/api/docket?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(bead)}`);
      } else {
        const got = await api(`/api/dockets${ws ? `?workspace=${encodeURIComponent(ws)}` : ''}`);
        state.index = got.rows || [];
      }
    } catch (err) {
      state.stopped = {
        title: bead ? 'That docket could not be drawn' : 'The beadepics could not be listed',
        detail: err.message,
      };
    } finally {
      pulse.classList.remove('busy');
      render();
    }
  }

  /* ------------------------------------------------------------------- the taps */

  out.addEventListener('click', (ev) => {
    const fold = ev.target.closest('[data-day]');
    if (fold) {
      const key = fold.dataset.day;
      if (state.open.has(key)) state.open.delete(key);
      else state.open.add(key);
      render();
      return;
    }
    if (ev.target.closest('[data-act="order"]')) {
      state.order = state.order === 'old' ? 'new' : 'old';
      localStorage.setItem(ORDER_KEY, state.order);
      render();
    }
  });

  // Opened on its own, the ✕ means the tab. In a drawer it never gets here — drawer.js
  // takes the click first, and `data-drawer-close` is what tells it to.
  document.getElementById('arc-close').addEventListener('click', () => window.beadcause.closeView());

  setTitle();

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else if (bead && !ws) {
    out.innerHTML = `<div class="empty"><strong>No workspace named</strong>A docket is one workspace's
      family — the same bead id can exist in two trackers, and guessing which would be the one
      mistake this page cannot recover from.</div>`;
  } else {
    load();
  }
})();
