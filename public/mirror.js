/* The mirror — whatever the phone has open, on a screen with room for it.
 *
 * The phone is a good place to be *told* something and a poor place to read it: a
 * question's brief is scrolled a paragraph at a time, its thread is behind a tap, and
 * the bead it depends on is a page away. This tab follows the phone — the same card,
 * the same chat session, the same list — and draws the version that would not fit: the
 * whole body, every comment, the options as buttons you can actually press.
 *
 * Three things make it a mirror rather than a second inbox:
 *
 *   - **It follows; it does not choose.** The view comes from `/api/presence`, which
 *     the phone publishes as it moves (public/presence.js). Tapping something here
 *     takes the wheel deliberately and says so, with one press to hand it back.
 *   - **It waits on the bus, not on a timer.** The presence event wakes the parked
 *     `/api/poll`, so a card opening in a hand shows up here as fast as the network
 *     allows, and nothing is polled in between.
 *   - **Every button here is an endpoint that already existed.** Answering, commenting
 *     and talking to a chat session are the phone's own writes; this page has no privilege
 *     of its own and adds no state to the daemon.
 *
 * **And a pane rather than a tab of its own (bc-3xb).** This landed in the same window as
 * the bottom tab bar, which left /monitor carrying two rows of tabs and an open question
 * about which row this belongs on. It belongs here: the three properties above make it a
 * *mode* of the advocates page — that page's repos and sessions, seen from the other
 * device — and the first of them makes it the one surface in the app that is meaningless
 * on a phone, which is where a bottom tab is tapped. `notMe` below drops this device from
 * the list, and `showTab` reports `view: null` while the pane is up, precisely so a mirror
 * cannot follow itself; a phone that tapped a Mirror tab would hit both of those and read
 * "Looking for a device…" for as long as it looked. The bar had no sixth place when this
 * was decided and has a free one now, and the answer is the same either way — see README,
 * "The Mirror is a pane, not a tab".
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const pane = document.getElementById('mirror');
  const advPane = document.getElementById('mon');
  const tabsEl = document.getElementById('mon-tabs');
  const dot = document.getElementById('mirror-dot');

  /* A chat session is in-memory on the daemon, so following one closely costs a map
     lookup. Everything else behind this view costs `bd`, and is fetched on a move. */
  const CONSOLE_MS = 1500;
  const RETRY_MS = 3000;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function age(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  }

  /** Markdown if the page got the vendored parsers, plain text if it didn't. */
  function md(text) {
    const src = String(text || '');
    if (!src.trim()) return '';
    if (!window.marked || !window.DOMPurify) return `<pre class="mir-plain">${esc(src)}</pre>`;
    return window.DOMPurify.sanitize(window.marked.parse(src, { breaks: true, gfm: true }));
  }

  const P_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];
  const pri = (n) => (n == null ? '' : P_LABEL[n] ?? `P${n}`);

  const VIEW_NAME = {
    inbox: 'the inbox',
    card: 'a card',
    graph: 'the graph',
    console: 'a chat session',
    sessions: 'the sessions view',
    // One session's own detail — the transcript pane. Streamed off the Mac rather
    // than read out of the tracker, so the mirror points at the same one rather than
    // drawing a second copy of it; see pointerHtml.
    session: 'a session',
    // No richer pane behind it here — the mirror falls through to its own "nowhere
    // richer than this" line, which is the honest answer. Named anyway, so the header
    // reads "has the pull requests open" rather than the raw view id.
    prs: 'the pull requests',
    terminal: 'a terminal',
    doc: 'a document',
    other: 'somewhere else',
  };

  /* --------------------------------------------------------------------- state */

  const state = {
    seq: 0,
    devices: [],
    // Which device to follow. Empty means "whichever spoke last", which is the right
    // answer while there is only ever one phone awake.
    pin: localStorage.getItem('beadcause.mirror.pin') || '',
    // Set when you tap something in here. The phone keeps moving underneath; this is
    // what stops the page sliding out from under your own click.
    override: null,
    detail: null,
    detailKey: '',
    error: null,
    // Composer text per target, so a refresh — or the phone moving and coming back —
    // cannot eat a half-typed answer.
    drafts: new Map(),
    // And which option each composer is answering with, `key → option id`. Clicking
    // a choice here fills the box rather than sending it, exactly as it does on the
    // phone; this is what remembers the click after you have edited its words, and
    // it is the only thing that can say whether the answer commissions work.
    picks: new Map(),
    busy: '',
    note: null,
    active: localStorage.getItem('beadcause.mirror.tab') === 'mirror',
    // Set while the tab is hidden and the phone has moved, so the tab itself can say
    // there is something new behind it.
    moved: false,
  };

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'x-beadcause-token': token,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  /* -------------------------------------------------------------------- target */

  /**
   * Every device except the one this tab is running on.
   *
   * The page around this pane reports its own view now (it is the advocates *and* the
   * sessions view, so a mirror elsewhere should be able to follow a phone sitting on
   * it). Without this filter that report comes straight back down the bus, sorts to
   * the front of the list on its next heartbeat because the list is newest-first, and
   * this pane starts following the device it is drawn on — a mirror showing "Mac has
   * the sessions view open" and nothing richer behind it. `presence.device` is stable
   * per browser profile, which is exactly the granularity that makes "me" decidable
   * here; with presence.js absent, nothing reports and nothing is dropped.
   */
  const notMe = (d) => d.device !== window.beadcause?.presence?.device;

  const following = () =>
    (state.pin && state.devices.find((d) => d.device === state.pin)) || (state.pin ? null : state.devices[0]) || null;

  /**
   * What this pane is showing: the phone's view, or the one you took over.
   *
   * An override keeps the device it was launched from, so the header can still say
   * whose thread you stepped out of and offer the way back.
   */
  function target() {
    const dev = following();
    if (state.override) return { ...state.override, from: 'you', device: dev };
    if (!dev) return null;
    return { ...dev, from: 'phone', device: dev };
  }

  const targetKey = (t) => (t ? [t.view, t.workspace, t.id, t.key, t.scope, t.space].join('|') : '');

  /**
   * Fetch whatever the current view needs, and only when it has actually changed.
   *
   * The key is the view's identity rather than the presence record: a heartbeat, a
   * `hidden` flag flipping, another device arriving — none of those change what
   * should be on screen, and each would otherwise cost a `bd show`.
   */
  async function ensureDetail(force = false) {
    const t = target();
    const key = targetKey(t);
    if (!force && key === state.detailKey) return;
    state.detailKey = key;
    state.detail = null;
    state.error = null;
    if (!t) return render();
    render(); // paint the frame first — a slow `bd` must not leave a blank tab.
    try {
      state.detail = await fetchFor(t);
    } catch (err) {
      state.error = err.message;
    }
    // Another move landed while we were fetching; that fetch owns the screen now.
    if (targetKey(target()) === key) render();
  }

  function fetchFor(t) {
    const ws = encodeURIComponent(t.workspace || '');
    const id = encodeURIComponent(t.id || '');
    switch (t.view) {
      case 'card':
        return t.workspace && t.id ? api(`/api/question?workspace=${ws}&id=${id}`) : null;
      case 'graph':
        return t.workspace && t.id ? api(`/api/bead?workspace=${ws}&id=${id}`) : null;
      case 'console':
        return t.id ? api(`/api/console?id=${id}`) : null;
      case 'inbox':
        return api(`/api/questions?scope=${encodeURIComponent(t.scope || 'human')}`);
      case 'sessions':
        return api('/api/work');
      default:
        return null;
    }
  }

  /* -------------------------------------------------------------------- header */

  function deviceChips() {
    if (!state.devices.length) return '';
    const chips = state.devices
      .map((d) => {
        const on = following()?.device === d.device;
        const where = d.view ? VIEW_NAME[d.view] || d.view : 'idle';
        // The age is on the chip, not just in the header: a device keeps its record
        // for fifteen minutes after it goes quiet, and a browser that was closed an
        // hour ago must not read as one that is being held right now.
        return `<button class="chip" data-mact="pin" data-device="${esc(d.device)}" aria-pressed="${on}">
          ${esc(d.label)}<span class="mir-chip-sub">${esc(where)} · ${esc(age(d.at))}${d.hidden ? ' · asleep' : ''}</span>
        </button>`;
      })
      .join('');
    // Only worth offering once there is a second device: with one phone, "follow the
    // most recent" and "follow that one" are the same instruction.
    const auto =
      state.devices.length > 1
        ? `<button class="chip" data-mact="pin" data-device="" aria-pressed="${!state.pin}">whoever moved last</button>`
        : '';
    return `<div class="chip-row mir-devices">${chips}${auto}</div>`;
  }

  function headHtml(t) {
    if (!t) return '';
    const dev = t.device;
    const what = t.from === 'you' ? 'You opened this here' : `${dev ? esc(dev.label) : 'The phone'} has ${VIEW_NAME[t.view] || 'nothing'} open`;
    const when = t.from === 'phone' && dev?.since ? ` · ${esc(age(dev.since))}` : '';
    const stale = t.from === 'phone' && dev?.hidden ? ' · the screen is off, this is where it was left' : '';
    const back =
      t.from === 'you'
        ? `<button class="mir-btn" data-mact="unfollow">Follow the phone again</button>`
        : '';
    return `<div class="mir-head">
      <p class="subtitle">${what}${when}${esc(stale)}. ${back}</p>
    </div>`;
  }

  /* --------------------------------------------------------------------- views */

  function metaPills(q) {
    return [
      q.workspace ? `<span class="pill">${esc(q.workspace)}</span>` : '',
      q.id ? `<span class="pill id">${esc(q.id)}</span>` : '',
      q.priority != null ? `<span class="pill ${pri(q.priority).toLowerCase()}">${esc(pri(q.priority))}</span>` : '',
      q.type || q.issue_type ? `<span class="tag dim">${esc(q.type || q.issue_type)}</span>` : '',
      q.status ? `<span class="tag">${esc(String(q.status).replace('_', ' '))}</span>` : '',
    ]
      .filter(Boolean)
      .join('');
  }

  function commentsHtml(comments) {
    if (!comments?.length) return '<p class="subtitle">No comments on it yet.</p>';
    return comments
      .map(
        (c) => `<div class="mir-comment">
          <div class="mir-comment-head">${esc(c.author || c.actor || 'someone')} <time>${esc(age(c.created_at || c.at))}</time></div>
          <div class="md">${md(c.text || c.body || '')}</div>
        </div>`
      )
      .join('');
  }

  /**
   * The composer.
   *
   * Two buttons because they are two different acts, and the phone draws them apart
   * for the same reason: a comment leaves the question open and sends an agent to
   * answer it, and an answer closes it. The text is held in `state.drafts` so a
   * repaint — and there are many — cannot swallow it.
   */
  function composerHtml(key, { placeholder, picked = null }) {
    const text = state.drafts.get(key) || '';
    return `<div class="mir-composer">
      <textarea class="mir-input" data-draft="${esc(key)}" rows="3" placeholder="${esc(placeholder)}">${esc(text)}</textarea>
      <div class="mir-actions">
        ${window.beadcause?.dictation?.buttonHtml({ label: 'Dictate this answer' }) || ''}
        <button class="mir-btn" data-mact="comment" ${text.trim() ? '' : 'disabled'}>Comment &amp; ask an agent</button>
        <button class="mir-btn primary" data-mact="respond" ${text.trim() ? '' : 'disabled'}>${
          // Same rule as the phone's: a choice marked `closes: false` is a
          // commission, so the button over it must not promise a close.
          picked?.closes === false ? 'Answer &amp; commission' : 'Answer &amp; close'
        }</button>
      </div>
    </div>`;
  }

  function cardHtml(t, q) {
    if (!q) return `<div class="empty">That card is gone — it may have been answered.</div>`;
    const opts = q.decision?.options || [];
    const sections = (q.sections || []).map((s) => `<div class="md">${md(s.markdown)}</div>`).join('');
    const proposal = q.proposal?.beads?.length
      ? `<div class="mir-block">
          <h3>${q.proposal.beads.length} bead${q.proposal.beads.length === 1 ? '' : 's'} it wants to file</h3>
          ${q.proposal.beads
            .map(
              (b, i) => `<div class="mir-prop">
                <div class="mir-prop-head"><span class="mir-rank">${i + 1}</span><strong>${esc(b.title || '')}</strong></div>
                ${b.description ? `<div class="md">${md(b.description)}</div>` : ''}
                <div class="mir-sub">${[b.type ? esc(b.type) : '', b.priority != null ? esc(pri(b.priority)) : '']
                  .filter(Boolean)
                  .join(' · ')}</div>
              </div>`
            )
            .join('')}
          <p class="subtitle">Per-bead buttons live on the Advocates tab. From here, answer in words —
            <code>CREATE: 1,3</code> files those two and declines the rest.</p>
        </div>`
      : '';
    // A click fills the composer below; it does not answer. The phone settled that
    // — a choice you may want to qualify in a sentence has to reach the box before
    // it reaches the thread — and a mirror that answered on one click while the
    // phone was filling a box would be two different apps over one bead.
    const key = t.key || `${q.workspace}/${q.id}`;
    const picked = opts.find((o) => o.id === state.picks.get(key)) || null;
    const options = opts.length
      ? `<div class="mir-options">${opts
          .map(
            (o) => `<button class="mir-opt${o.id === picked?.id ? ' picked' : ''}" data-mact="option" data-opt="${esc(
              o.id
            )}" data-response="${esc(o.response)}" aria-pressed="${o.id === picked?.id}">
              <span>${esc(o.label)}</span>${
                o.closes === false ? '<small>↪ commissions the work — the bead stays open</small>' : ''
              }${o.hint ? `<small>${esc(o.hint)}</small>` : ''}
            </button>`
          )
          .join('')}</div>`
      : '';

    return `<article class="card mir-card">
      <div class="mir-meta">${metaPills(q)}</div>
      <h2>${esc(q.question || q.title)}</h2>
      ${q.question && q.title !== q.question ? `<p class="subtitle">${esc(q.title)}</p>` : ''}
      ${sections || '<p class="subtitle">The bead carries no body — the title is the whole of it.</p>'}
      ${proposal}
      ${options}
      <div class="mir-block">
        <h3>Thread</h3>
        ${commentsHtml(q.comments)}
      </div>
      ${composerHtml(key, { placeholder: 'Answer it, or say what you want looked into…', picked })}
      <div class="mir-links">
        <a href="/graph?ws=${encodeURIComponent(q.workspace)}&id=${encodeURIComponent(q.id)}" target="_blank" rel="noopener">Graph →</a>
      </div>
    </article>`;
  }

  function inboxHtml(t, data) {
    const all = data?.questions || [];
    // The phone's own two filters, applied to the same list it was sent, so the
    // mirror shows what is on that screen rather than everything there is.
    const rows = all
      .filter((q) => (!t.space || t.space === 'all' ? true : (q.space || 'Other') === t.space))
      .filter((q) => (!t.workspace ? true : q.workspace === t.workspace));
    if (!rows.length) return `<div class="empty">Nothing waiting in what the phone is filtered to.</div>`;
    return `<article class="card mir-card">
      <div class="mir-meta"><span class="tag">scope: ${esc(t.scope || 'human')}</span>${
        t.space && t.space !== 'all' ? `<span class="tag">${esc(t.space)}</span>` : ''
      }${t.workspace ? `<span class="pill">${esc(t.workspace)}</span>` : ''}</div>
      <h2>${rows.length} waiting</h2>
      ${rows
        .map(
          (q) => `<button class="work-row mir-row" data-mact="open" data-ws="${esc(q.workspace)}" data-id="${esc(q.id)}">
            <span class="work-phase">${q.awaitingAgent ? '◍' : '◔'}</span>
            <span class="work-main">
              <span class="work-title">${esc(q.question || q.title)}</span>
              <span class="work-sub"><span class="pill id">${esc(q.id)}</span><span class="tag dim">${esc(q.workspace)}</span>${
                q.priority != null ? `<span class="tag">${esc(pri(q.priority))}</span>` : ''
              }${q.commentCount ? `<span class="tag dim">${q.commentCount} comment${q.commentCount === 1 ? '' : 's'}</span>` : ''}</span>
            </span>
            <time>${esc(age(q.createdAt))}</time>
          </button>`
        )
        .join('')}
    </article>`;
  }

  function beadHtml(t, b) {
    if (!b) {
      return `<article class="card mir-card">
        <h2>${esc(t.workspace || 'the graph')}</h2>
        <p class="subtitle">Nothing is selected on it. Tap a bead on the phone and its full text lands here.</p>
        <div class="mir-links"><a href="/graph?ws=${encodeURIComponent(t.workspace || '')}" target="_blank" rel="noopener">Open the graph →</a></div>
      </article>`;
    }
    return `<article class="card mir-card">
      <div class="mir-meta">${metaPills(b)}</div>
      <h2>${esc(b.title || b.id)}</h2>
      ${[b.description, b.design, b.notes].filter(Boolean).map((x) => `<div class="md">${md(x)}</div>`).join('') ||
        '<p class="subtitle">No body on this bead.</p>'}
      <div class="mir-block"><h3>Thread</h3>${commentsHtml(b.comments)}</div>
      <div class="mir-links">
        <a href="/graph?ws=${encodeURIComponent(b.workspace)}&id=${encodeURIComponent(b.id)}" target="_blank" rel="noopener">Centre the graph on it →</a>
      </div>
    </article>`;
  }

  function consoleHtml(t, c) {
    if (!c) return `<div class="empty">That chat session is gone.</div>`;
    const msgs = (c.messages || [])
      .map((m) => {
        if (m.role === 'user') return `<div class="msg you">${esc(m.text)}</div>`;
        if (m.role === 'system') return `<div class="msg mir-sys">${esc(m.text || m.kind || '')}</div>`;
        const body = m.text || m.streaming || '';
        return `<div class="msg claude"><div class="md">${md(body)}</div>${
          m.pending && !body ? '<span class="spark"></span>' : ''
        }</div>`;
      })
      .join('');
    const draft = state.drafts.get(`console:${c.id}`) || '';
    return `<article class="card mir-card">
      <div class="mir-meta">${c.workspace ? `<span class="pill">${esc(c.workspace)}</span>` : ''}${
        c.seed?.id ? `<span class="pill id">${esc(c.seed.id)}</span>` : ''
      }<span class="tag">${esc(c.status || '')}</span>${c.closedAt ? '<span class="tag warn">closed</span>' : ''}</div>
      <h2>${esc(c.title || 'Chat session')}</h2>
      <div class="mir-thread">${msgs || '<p class="subtitle">Nothing said yet.</p>'}</div>
      <div class="mir-composer">
        <textarea class="mir-input" data-draft="console:${esc(c.id)}" rows="3" placeholder="Say something to it…">${esc(draft)}</textarea>
        <div class="mir-actions">
          ${window.beadcause?.dictation?.buttonHtml({ label: 'Dictate this message' }) || ''}
          ${c.closedAt ? '' : '<button class="mir-btn" data-mact="close-console" data-id="' + esc(c.id) + '">Close it</button>'}
          <button class="mir-btn primary" data-mact="send" data-id="${esc(c.id)}" ${draft.trim() ? '' : 'disabled'}>Send</button>
        </div>
      </div>
      <div class="mir-links"><a href="/console?id=${encodeURIComponent(c.id)}" target="_blank" rel="noopener">Open it on its own page →</a></div>
    </article>`;
  }

  function sessionsHtml(data) {
    const rows = (data?.workspaces || []).filter((w) => w.sessions?.length || w.counts?.inProgress);
    if (!rows.length) return `<div class="empty">Nothing is running anywhere.</div>`;
    return rows
      .map(
        (w) => `<article class="card mir-card">
          <h2>${esc(w.name)}</h2>
          <div class="mir-meta">${[
            w.counts?.open != null ? `<span class="pill">${w.counts.open} open</span>` : '',
            w.counts?.ready ? `<span class="pill">${w.counts.ready} ready</span>` : '',
            w.counts?.inProgress ? `<span class="pill">${w.counts.inProgress} in progress</span>` : '',
          ]
            .filter(Boolean)
            .join('')}</div>
          ${(w.sessions || [])
            .map((s) => {
              const body = `<span class="work-phase">${s.status === 'busy' ? '<span class="spark"></span>' : '○'}</span>
                <span class="work-main">
                  <span class="work-title">${esc(s.name || s.bead || '(unnamed session)')}</span>
                  <span class="work-sub">${esc(s.where || s.cwd || '')}${s.pid ? ` · pid ${esc(s.pid)}` : ''}</span>
                </span>
                <time>${esc(age(s.at))}</time>`;
              // The same `/session?pid=…` every other list in the app links to, opening
              // in the drawer over this tab. A row here used to be a plain div, which on
              // the one screen with room to read a transcript was the worst place for
              // the detail to be out of reach. Still a div without a pid, because the
              // pid *is* the address — `?pid=undefined` would be a link to a page that
              // can only tell you it was given nothing.
              return s.pid
                ? `<a class="work-row session-row" href="/session?pid=${encodeURIComponent(s.pid)}">${body}</a>`
                : `<div class="work-row session-row">${body}</div>`;
            })
            .join('')}
        </article>`
      )
      .join('');
  }

  /**
   * The three views that stream off the Mac: point at the same one, don't copy it.
   *
   * A terminal, a document and a session's transcript are all files or pipes on the
   * Mac rather than rows in a tracker, and a second renderer of any of them here would
   * be a second thing to keep in step for no gain — the phone is not showing a
   * cut-down version that this screen could improve on. So the mirror says what the
   * phone is looking at and offers the same address, which for a session is the very
   * one every list in the app already links to.
   */
  const POINTS_AT = {
    terminal: { what: 'a terminal', href: (t) => `/terminal?id=${encodeURIComponent(t.id)}` },
    doc: { what: 'a document', href: (t) => `/doc?p=${encodeURIComponent(t.id)}` },
    session: { what: "a session's transcript", href: (t) => `/session?pid=${encodeURIComponent(t.id)}` },
  };

  function pointerHtml(t) {
    const at = POINTS_AT[t.view] || POINTS_AT.doc;
    return `<article class="card mir-card">
      <h2>${esc(t.detail || t.id || at.what)}</h2>
      <p class="subtitle">The phone is in ${esc(at.what)}. It streams from the Mac rather than from the tracker, so the
        mirror points at it rather than copying it — open the same one here.</p>
      <div class="mir-links"><a href="${esc(at.href(t))}" target="_blank" rel="noopener">Open ${esc(at.what)} →</a></div>
    </article>`;
  }

  /* -------------------------------------------------------------------- render */

  function bodyHtml(t) {
    if (state.error) return `<div class="empty"><strong>Couldn't read it</strong>${esc(state.error)}</div>`;
    switch (t.view) {
      case 'card':
        return state.detail === null && !state.error ? loading() : cardHtml(t, state.detail);
      case 'inbox':
        return state.detail === null ? loading() : inboxHtml(t, state.detail);
      case 'graph':
        return state.detail === null && t.id ? loading() : beadHtml(t, state.detail);
      case 'console':
        return state.detail === null ? loading() : consoleHtml(t, state.detail);
      case 'sessions':
        return state.detail === null ? loading() : sessionsHtml(state.detail);
      case 'terminal':
      case 'doc':
      case 'session':
        return pointerHtml(t);
      default:
        return `<div class="empty">The phone is somewhere this page has no richer version of.</div>`;
    }
  }

  const loading = () => '<div class="empty">Reading it…</div>';

  function render() {
    if (!state.active) return;
    const t = target();
    const focus = document.activeElement?.dataset?.draft || '';
    const caret = document.activeElement?.selectionStart ?? null;

    if (!state.devices.length) {
      pane.innerHTML = `<div class="empty"><strong>No device has said where it is</strong>Open the inbox on the
        phone — every page reports its view, and this tab follows it.</div>`;
      return;
    }

    pane.innerHTML =
      deviceChips() +
      headHtml(t) +
      (state.note ? `<div class="adv-note${state.note.bad ? ' bad' : ''}">${esc(state.note.text)}</div>` : '') +
      (t ? bodyHtml(t) : '<div class="empty">That device is not looking at anything.</div>');

    // Put the cursor back. Repaints here are driven by the phone, which means they
    // land at the least convenient moment by definition.
    if (focus) {
      const el = pane.querySelector(`[data-draft="${CSS.escape(focus)}"]`);
      if (el) {
        el.focus();
        const at = caret == null ? el.value.length : caret;
        el.setSelectionRange(at, at);
      }
    }
    // A live chat session is read from the bottom, like every other terminal.
    const thread = pane.querySelector('.mir-thread');
    if (thread) thread.scrollTop = thread.scrollHeight;
  }

  function note(text, bad = false) {
    state.note = { text, bad };
    render();
    clearTimeout(note._t);
    note._t = setTimeout(() => {
      state.note = null;
      render();
    }, bad ? 6000 : 3000);
  }

  /* ------------------------------------------------------------------- actions */

  const draftFor = (key) => (state.drafts.get(key) || '').trim();

  async function respond(t, text, close, option = null) {
    const key = t.key || `${t.workspace}/${t.id}`;
    try {
      if (close) {
        // The option id rides along so the server can see whether this answer
        // commissions work — see lib/decision.js. Absent for a typed answer, which
        // is always an ending.
        const res = await api('/api/respond', {
          method: 'POST',
          body: JSON.stringify({ workspace: t.workspace, id: t.id, response: text, ...(option ? { option } : {}) }),
        });
        note(res?.handedBack ? 'Answered — left open and handed back as work.' : 'Answered — the card is closed.');
      } else {
        await api('/api/comment', { method: 'POST', body: JSON.stringify({ workspace: t.workspace, id: t.id, text }) });
        note('Commented — an agent has been sent to answer it.');
      }
      state.drafts.delete(key);
      // The pick goes with the words it filled in, or the next card to open under
      // this key arrives already claiming a choice nobody has made on it.
      state.picks.delete(key);
      await ensureDetail(true);
    } catch (err) {
      note(err.message, true);
    }
  }

  pane.addEventListener('input', (e) => {
    const box = e.target.closest('[data-draft]');
    if (!box) return;
    const was = draftFor(box.dataset.draft);
    state.drafts.set(box.dataset.draft, box.value);
    // Editing a choice's words is qualifying it, so the pick survives typing —
    // emptying the box is the one edit that ends it. Same rule as the phone's.
    if (!box.value.trim()) state.picks.delete(box.dataset.draft);
    // Only repaint when the buttons have to change state — every keystroke would
    // otherwise rebuild the pane under the thumb it was typed with.
    if (Boolean(was) !== Boolean(box.value.trim())) render();
  });

  pane.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-mact]');
    if (!btn) return;
    e.preventDefault();
    const act = btn.dataset.mact;
    const t = target();

    if (act === 'pin') {
      state.pin = btn.dataset.device || '';
      localStorage.setItem('beadcause.mirror.pin', state.pin);
      state.override = null;
      return ensureDetail();
    }

    if (act === 'unfollow') {
      state.override = null;
      return ensureDetail();
    }

    if (act === 'open') {
      state.override = { view: 'card', workspace: btn.dataset.ws, id: btn.dataset.id, key: `${btn.dataset.ws}/${btn.dataset.id}` };
      return ensureDetail();
    }

    /**
     * A choice, clicked: its words go in the composer and the click is remembered.
     *
     * The same three rules the phone's own buttons follow, and the same reasons —
     * another choice's words are replaced, words of your own are appended to, and
     * clicking the choice you have already made takes it back, but only while the
     * box still says exactly what that click put there.
     */
    if (act === 'option') {
      const key = t.key || `${t.workspace}/${t.id}`;
      const opts = state.detail?.decision?.options || [];
      const response = btn.dataset.response || '';
      const current = draftFor(key);
      if (state.picks.get(key) === btn.dataset.opt && current === response.trim()) {
        state.picks.delete(key);
        state.drafts.delete(key);
      } else {
        state.picks.set(key, btn.dataset.opt);
        const mine = current && !opts.some((o) => o.response.trim() === current);
        state.drafts.set(key, mine ? `${current}\n${response}` : response);
      }
      render();
      // Put the cursor where the words just landed. render() only restores focus it
      // found on a composer, and what had it a moment ago was the button.
      const box = pane.querySelector(`[data-draft="${CSS.escape(key)}"]`);
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
      return;
    }

    if (act === 'comment' || act === 'respond') {
      const key = t.key || `${t.workspace}/${t.id}`;
      const text = draftFor(key);
      if (!text) return;
      btn.disabled = true;
      // Which choice the sentence is making, when it is making one — and only on an
      // answer. A comment settles nothing, so it can commission nothing.
      return respond(t, text, act === 'respond', act === 'respond' ? state.picks.get(key) || null : null);
    }

    if (act === 'send') {
      const key = `console:${btn.dataset.id}`;
      const text = draftFor(key);
      if (!text) return;
      btn.disabled = true;
      try {
        await api('/api/console/message', { method: 'POST', body: JSON.stringify({ id: btn.dataset.id, text }) });
        state.drafts.delete(key);
        await ensureDetail(true);
      } catch (err) {
        note(err.message, true);
      }
      return;
    }

    if (act === 'close-console') {
      try {
        await api('/api/console/close', { method: 'POST', body: JSON.stringify({ id: btn.dataset.id }) });
        await ensureDetail(true);
      } catch (err) {
        note(err.message, true);
      }
    }
  });

  /* ---------------------------------------------------------------------- feed */

  /**
   * One parked request, restarted the moment it returns.
   *
   * It runs whether or not this tab is showing, which is deliberate: the whole
   * argument for presence riding the bus is that a move is known instantly, and a
   * mirror that started listening when you looked at it would be a poll with extra
   * steps. The cost is a socket — the presence branch of `/api/poll` explicitly does
   * not sweep `bd`.
   */
  async function feed() {
    for (;;) {
      try {
        // `want=presence` keeps this listener from making the daemon sweep every
        // tracker on each event: this page reads `presence`, and nothing else here.
        const data = await api(`/api/poll?since=${state.seq}&wait=25&want=presence`);
        state.seq = data.seq ?? state.seq;
        const before = targetKey(target());
        if (Array.isArray(data.presence)) state.devices = data.presence.filter(notMe);
        const after = targetKey(target());
        if (after !== before) {
          if (state.active) await ensureDetail();
          else state.moved = true;
        } else if (state.active) {
          // The devices list itself may have moved — a heartbeat, a screen going off.
          render();
        }
        // Something happened to the bead we are showing. Nothing else would tell us:
        // presence says where the phone is, not what the tracker did underneath it.
        const touched = (data.events || []).some((ev) => ev.type !== 'presence' && ev.key && ev.key === target()?.key);
        if (touched && state.active) await ensureDetail(true);
        dot.hidden = !state.moved;
      } catch {
        await new Promise((r) => setTimeout(r, RETRY_MS));
      }
    }
  }

  // A chat session is the one view that changes without the phone moving and without a bus
  // event — the agent is mid-sentence. Cheap enough to follow closely: it is a read
  // out of the daemon's own memory.
  setInterval(() => {
    if (state.active && target()?.view === 'console') ensureDetail(true);
  }, CONSOLE_MS);

  /* ---------------------------------------------------------------------- tabs */

  function showTab(which) {
    state.active = which === 'mirror';
    localStorage.setItem('beadcause.mirror.tab', which);
    advPane.hidden = state.active;
    pane.hidden = !state.active;
    for (const b of tabsEl.querySelectorAll('[data-tab]')) b.setAttribute('aria-pressed', String(b.dataset.tab === which));
    // What this device is looking at, which the chip just changed. On the mirror pane
    // you are looking at *another* device, so this one is nowhere — `null` keeps the
    // record and marks it idle rather than dropping it, which is what a mirror on a
    // third screen should see. See the presence note at the foot of monitor.js.
    window.beadcause?.presence?.report({ view: state.active ? null : 'sessions' });
    if (state.active) {
      state.moved = false;
      dot.hidden = true;
      ensureDetail(true);
    } else {
      window.beadcause?.monitor?.refresh();
    }
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) showTab(b.dataset.tab);
  });

  if (!token) {
    pane.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    showTab(state.active ? 'mirror' : 'advocates');
    feed();
  }
})();
