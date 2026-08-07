/* Beadcause — mobile decision inbox for `bd human` questions. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const listEl = $('#list');
  const filtersEl = $('#filters');
  const pulseEl = $('#pulse');
  const toastEl = $('#toast');

  const state = {
    token: '',
    questions: [],
    workspace: 'all',
    open: new Set(),
    armed: null, // key of the option awaiting its confirm tap
    armedTimer: null,
  };

  /* ---------------------------------------------------------------- token */

  function bootToken() {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      // Keep the token out of the address bar (and out of the home-screen title).
      history.replaceState(null, '', location.pathname + location.hash);
    }
    state.token = localStorage.getItem('beadcause.token') || '';
    if (!state.token) askForToken();
  }

  function askForToken() {
    const dlg = $('#setup');
    dlg.showModal();
    dlg.addEventListener(
      'close',
      () => {
        const val = $('#token-input').value.trim();
        if (!val) return;
        localStorage.setItem('beadcause.token', val);
        state.token = val;
        load();
      },
      { once: true }
    );
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-beadcause-token': state.token, ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      localStorage.removeItem('beadcause.token');
      askForToken();
      throw new Error('token rejected');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /* -------------------------------------------------------------- helpers */

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** Local files can't be loaded by the browser directly — route them through the server. */
  function assetUrl(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    if (/^(https?:|data:)/i.test(s)) return s;
    if (/^file:\/\//i.test(s) || s.startsWith('/') || s.startsWith('~')) {
      const abs = s.startsWith('~') ? s.replace(/^~/, '') : s;
      return `/api/asset?p=${encodeURIComponent(abs)}&t=${encodeURIComponent(state.token)}`;
    }
    return s;
  }

  function relTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!then) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  const isLocalPath = (s) => /^(file:\/\/|~\/|\/)/.test(String(s || '').trim());

  /** A file on the Mac opens in the reader tab, not as a dead file:// link. */
  function docUrl(p) {
    let s = String(p || '').trim();
    if (s.startsWith('file://')) s = decodeURIComponent(s.slice(7));
    if (s.startsWith('~')) s = s.replace(/^~/, '');
    return `/doc?p=${encodeURIComponent(s)}`;
  }

  function renderMarkdown(md) {
    let patched = String(md || '');
    // Rewrite local image paths before parsing — DOMPurify would strip file:// URLs.
    patched = patched.replace(
      /!\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g,
      (_, alt, href, title) => `![${alt}](${assetUrl(href)}${title})`
    );
    // A link to a file on disk becomes a reader-tab link. (The leading group
    // keeps this from matching the image syntax rewritten above.)
    patched = patched.replace(
      /(^|[^!])\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g,
      (m, pre, label, href) => (isLocalPath(href) ? `${pre}[${label}](${docUrl(href)})` : m)
    );
    const html = window.marked.parse(patched, { breaks: true, gfm: true });
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
  }

  /** Every link in a brief opens in its own tab — you're mid-answer, don't navigate away. */
  function openLinksInNewTab(root) {
    for (const a of root.querySelectorAll('.md a[href], .links a[href], .docs a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }

  /* --------------------------------------------------------------- drafts */

  const draftKey = (key) => `beadcause.draft.${key}`;
  const getDraft = (key) => localStorage.getItem(draftKey(key)) || '';
  const setDraft = (key, text) => {
    if (text.trim()) localStorage.setItem(draftKey(key), text);
    else localStorage.removeItem(draftKey(key));
  };
  const clearDraft = (key) => localStorage.removeItem(draftKey(key));

  /** Don't yank the textarea out from under a thumb mid-sentence. */
  const isTyping = () => !!document.activeElement?.matches?.('[data-role="answer"]');

  /**
   * Answering means focused OR holding text. The second half matters: you tap a
   * doc link to go read the spec, focus leaves, and the answer you'd started must
   * still be sitting there when you come back.
   */
  const isAnswering = () =>
    isTyping() || [...listEl.querySelectorAll('[data-role="answer"]')].some((t) => t.value.trim());

  /* -------------------------------------------------------------- mermaid */

  let mermaidReady = null;
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid.js';
      s.onload = () => {
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          fontFamily: 'inherit',
        });
        resolve(window.mermaid);
      };
      s.onerror = () => reject(new Error('mermaid failed to load'));
      document.head.appendChild(s);
    });
    return mermaidReady;
  }

  let diagramSeq = 0;
  async function drawDiagrams(root) {
    const targets = [
      ...root.querySelectorAll('.diagram[data-src]'),
      ...root.querySelectorAll('pre > code.language-mermaid'),
    ];
    if (!targets.length) return;
    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch {
      return;
    }
    for (const node of targets) {
      const isFence = node.tagName === 'CODE';
      const src = isFence ? node.textContent : node.dataset.src;
      const host = isFence ? node.closest('pre') : node;
      try {
        const { svg } = await mermaid.render(`mmd-${++diagramSeq}`, src);
        if (isFence) {
          const box = document.createElement('div');
          box.className = 'diagram';
          box.innerHTML = svg;
          host.replaceWith(box);
        } else {
          host.innerHTML = svg;
          delete host.dataset.src;
        }
      } catch (err) {
        if (!isFence) host.textContent = `diagram error: ${err.message}`;
      }
    }
  }

  /* --------------------------------------------------------------- render */

  const PHASE_ICON = {
    thinking: '🤔',
    researching: '🔍',
    drafting: '✍️',
    building: '🔨',
    blocked: '⛔',
    waiting: '⏳',
    done: '✅',
  };
  // Phases where an agent is actively working — these get the animated dot.
  const LIVE_PHASES = new Set(['thinking', 'researching', 'drafting', 'building']);

  /** What an agent is doing about this question right now. */
  function activityHtml(q) {
    const a = q.activity;
    if (a?.phase) {
      const live = LIVE_PHASES.has(a.phase);
      return `<div class="activity${live ? ' live' : ''}">
        <span class="spark"></span>
        <span class="phase">${PHASE_ICON[a.phase] || '•'} ${esc(a.phase)}</span>
        ${a.detail ? `<span class="detail">${esc(a.detail)}</span>` : ''}
        ${a.at ? `<time>${esc(relTime(a.at))}</time>` : ''}
      </div>`;
    }
    if (q.awaitingAgent) {
      return `<div class="activity waiting">
        <span class="spark"></span>
        <span class="phase">⏳ you replied</span>
        <span class="detail">waiting on an agent to pick this up</span>
      </div>`;
    }
    return '';
  }

  /**
   * The agent state worth showing as a pending reply at the foot of the thread.
   *
   * `done` is excluded deliberately: a finished agent has already left a real
   * comment above, so a ghost bubble under it would just be a duplicate.
   */
  function pendingActivity(q) {
    if (q.activity?.phase && q.activity.phase !== 'done') return q.activity;
    if (q.awaitingAgent) return { phase: 'waiting', detail: 'waiting on an agent to pick this up' };
    return null;
  }

  /** A placeholder shaped like the agent comment that is about to land here. */
  function pendingHtml(a) {
    const live = LIVE_PHASES.has(a.phase);
    return `<div class="comment from-agent pending${live ? ' live' : ''}">
      <span class="who"><span class="spark"></span>${PHASE_ICON[a.phase] || '•'} ${esc(a.phase)}</span>
      <div class="pending-detail">${esc(a.detail || 'working on your comment…')}</div>
    </div>`;
  }

  function cardHtml(q) {
    const d = q.decision;
    const opts = d?.options || [];
    const open = state.open.has(q.key);
    const hasBrief = Boolean(
      d?.diagrams?.length || d?.links?.length || d?.docs?.length || d?.images?.length || q.sections.length || d?.context
    );

    const options = opts
      .map((o) => {
        const armed = state.armed === `${q.key}|${o.id}`;
        // The arm/disarm state is painted in place by paintArmed() — it must never
        // go through render(), which would rebuild the list under a half-typed answer.
        return `<button class="option${armed ? ' confirm' : ''}" data-act="option" data-key="${esc(q.key)}" data-opt="${esc(
          o.id
        )}" data-label="${esc(o.label)}">
          <span class="label">${armed ? 'Tap again to confirm · ' : ''}${esc(o.label)}</span>
          ${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}
        </button>`;
      })
      .join('');

    const brief = open ? briefHtml(q) : '';
    const draft = getDraft(q.key);

    return `<article class="card" id="card-${esc(q.key.replace(/[^\w-]/g, '_'))}" data-key="${esc(q.key)}">
      <div class="card-head">
        <div class="meta">
          <span class="pill">${esc(q.workspace)}</span>
          <span class="pill id">${esc(q.id)}</span>
          ${q.priority != null ? `<span class="pill p${q.priority}">P${q.priority}</span>` : ''}
          ${q.dependentCount ? `<span class="pill">blocks ${q.dependentCount}</span>` : ''}
          ${draft && !open ? '<span class="draft-flag">draft saved</span>' : ''}
          <time>${esc(relTime(q.createdAt))}</time>
        </div>
        ${activityHtml(q)}
        <p class="q">${esc(q.question || q.title)}</p>
        ${q.question && q.title !== q.question ? `<p class="subtitle">${esc(q.title)}</p>` : ''}
        ${(q.errors || []).map((e) => `<p class="subtitle bad">⚠ ${esc(e)}</p>`).join('')}
      </div>
      ${options ? `<div class="options">${options}</div>` : ''}
      <div class="actions">
        <button class="linkish" data-act="toggle" data-key="${esc(q.key)}">
          ${open ? 'Hide details' : draft ? 'Resume your answer' : hasBrief ? 'Show details' : 'Write an answer'}
        </button>
      </div>
      <div class="brief"${open ? '' : ' hidden'}>${brief}</div>
    </article>`;
  }

  function briefHtml(q) {
    const d = q.decision;
    const parts = [];

    if (d?.context) parts.push(`<div class="md">${renderMarkdown(d.context)}</div>`);

    for (const src of d?.diagrams || []) {
      parts.push(`<div class="diagram" data-src="${esc(src)}">drawing…</div>`);
    }

    for (const img of d?.images || []) {
      parts.push(`<img src="${esc(assetUrl(img))}" alt="" loading="lazy">`);
    }

    if (d?.docs?.length) {
      parts.push(
        `<div class="docs">${d.docs
          .map(
            (doc) =>
              `<a href="${esc(docUrl(doc.path))}" target="_blank" rel="noopener noreferrer"><span>${esc(
                doc.label
              )}<span class="path">${esc(doc.path)}</span></span></a>`
          )
          .join('')}</div>`
      );
    }

    if (d?.links?.length) {
      parts.push(
        `<div class="links">${d.links
          .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`)
          .join('')}</div>`
      );
    }

    for (const s of q.sections || []) {
      if (s.field !== 'description') parts.push(`<div class="section-label">${esc(s.field)}</div>`);
      parts.push(`<div class="md">${renderMarkdown(s.markdown)}</div>`);
    }

    // The same agent state as the card head, repeated at the END of the thread.
    // The banner is correct but it's above a long brief, so after typing a comment
    // you're at the bottom and never see it — which reads as nothing happening.
    const working = pendingActivity(q);

    if (q.comments?.length || working) {
      parts.push('<div class="section-label">Thread</div>');
      parts.push(
        `<div class="comments">${(q.comments || [])
          .map(
            (c) =>
              `<div class="comment${c.author && c.author !== 'beadcause' ? ' from-agent' : ''}">
                <span class="who">${esc(c.author || '')} · ${esc(relTime(c.created_at))}</span>
                <div class="md">${renderMarkdown(c.text || '')}</div>
              </div>`
          )
          .join('')}${working ? pendingHtml(working) : ''}</div>`
      );
    }

    parts.push(`<div class="freeform">
      <textarea data-role="answer" placeholder="Answer in your own words…" rows="3">${esc(getDraft(q.key))}</textarea>
      <div class="row">
        <button class="primary" data-act="answer" data-key="${esc(q.key)}">Answer &amp; close</button>
        <button class="secondary" data-act="note" data-key="${esc(q.key)}">Comment only</button>
      </div>
      <button class="discuss" data-act="discuss" data-key="${esc(q.key)}">
        <span class="glyph">&gt;_</span> Discuss in a Claude session on the Mac
      </button>
    </div>`);

    // A second way out, at the end of the brief. The toggle in the card head is the
    // only one otherwise, and after reading a long brief with diagrams and a thread
    // it is several screens above you.
    parts.push(`<div class="collapse-row">
      <button class="collapse" data-act="collapse" data-key="${esc(q.key)}">↑ Collapse</button>
    </div>`);

    return parts.join('');
  }

  /** Repaint the armed option in place. Cheap, and never touches the textarea. */
  function paintArmed() {
    for (const btn of listEl.querySelectorAll('.option')) {
      const armed = state.armed === `${btn.dataset.key}|${btn.dataset.opt}`;
      btn.classList.toggle('confirm', armed);
      const label = btn.querySelector('.label');
      if (label) label.textContent = (armed ? 'Tap again to confirm · ' : '') + btn.dataset.label;
    }
  }

  let pendingRender = false;

  /**
   * Rebuilding the list destroys every textarea in it, drops focus, closes the
   * keyboard and resets scroll — so an answer being written looks like it was
   * thrown away. While a card is being answered, defer instead; the flush
   * happens on blur, or when the answer is submitted.
   */
  function render(force = false) {
    if (!force && isAnswering()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    const scrollY = window.scrollY;

    const visible =
      state.workspace === 'all' ? state.questions : state.questions.filter((q) => q.workspace === state.workspace);

    if (!state.questions.length) {
      listEl.innerHTML = `<div class="empty"><strong>Nothing to decide</strong>No open questions labelled <code>human</code>.</div>`;
    } else if (!visible.length) {
      listEl.innerHTML = `<div class="empty">Nothing waiting in ${esc(state.workspace)}.</div>`;
    } else {
      listEl.innerHTML = visible.map(cardHtml).join('');
    }

    const spaces = [...new Set(state.questions.map((q) => q.workspace))].sort();
    filtersEl.hidden = spaces.length < 2;
    if (!filtersEl.hidden) {
      const counts = (ws) => state.questions.filter((q) => q.workspace === ws).length;
      filtersEl.innerHTML = [
        `<button class="chip" data-ws="all" aria-pressed="${state.workspace === 'all'}">All ${state.questions.length}</button>`,
        ...spaces.map(
          (ws) => `<button class="chip" data-ws="${esc(ws)}" aria-pressed="${state.workspace === ws}">${esc(ws)} ${counts(ws)}</button>`
        ),
      ].join('');
    }

    // innerHTML replacement collapses the page height for an instant; put the
    // reader back where they were rather than at the top of the list.
    if (scrollY) window.scrollTo(0, scrollY);

    openLinksInNewTab(listEl);
    drawDiagrams(listEl);
  }

  /* --------------------------------------------------------------- actions */

  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', bad);
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), bad ? 5000 : 2600);
  }

  const byKey = (key) => state.questions.find((q) => q.key === key);

  function disarm() {
    state.armed = null;
    clearTimeout(state.armedTimer);
  }

  async function submit(key, text, { close }) {
    const q = byKey(key);
    if (!q) return;
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    card?.classList.add('answering');
    // Writes go through bd, which can retry against the Dolt lock for a second or
    // two. Say so, rather than leaving a dimmed card and no explanation.
    const sending = document.createElement('div');
    sending.className = 'sending';
    sending.innerHTML = `<span class="spark"></span>${close ? 'Recording your answer…' : 'Adding your comment…'}`;
    card?.appendChild(sending);
    try {
      await api(close ? '/api/respond' : '/api/comment', {
        method: 'POST',
        body: JSON.stringify(
          close ? { workspace: q.workspace, id: q.id, response: text } : { workspace: q.workspace, id: q.id, text }
        ),
      });
      clearDraft(key);
      if (close) {
        state.questions = state.questions.filter((x) => x.key !== key);
        state.open.delete(key);
        // Inside the Android shell, drop the notification for this question now.
        // Otherwise it sits in the shade with buttons that would answer a bead that
        // is already closed.
        window.BeadcauseNative?.answered?.(key);
        toast(`Answered ${q.id}`);
        // Forced: the answered card's textarea is still in the DOM holding text,
        // so a deferred render would never fire and the card would linger.
        render(true);
      } else {
        toast(`Comment added — an agent will be told`);
        card?.classList.remove('answering');
        sending.remove();
        // Reflect the awaiting-agent flag the server just set, without waiting
        // for the next poll.
        q.awaitingAgent = true;
        await expand(key, true);
      }
    } catch (err) {
      card?.classList.remove('answering');
      sending.remove();
      toast(err.message, true);
    }
  }

  /** Pull the full record (comments included) the first time a card is opened. */
  async function expand(key, force = false) {
    const q = byKey(key);
    if (!q) return;
    if (force || !q.comments) {
      try {
        const full = await api(`/api/question?workspace=${encodeURIComponent(q.workspace)}&id=${encodeURIComponent(q.id)}`);
        Object.assign(q, full);
      } catch {
        q.comments = q.comments || [];
      }
    }
    state.open.add(key);
    render(true);
  }

  listEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const key = btn.dataset.key;
    const act = btn.dataset.act;

    if (act === 'toggle') {
      disarm();
      paintArmed();
      if (state.open.has(key)) {
        state.open.delete(key);
        render(true); // explicit user action
      } else {
        await expand(key);
      }
      return;
    }

    // Same as the head toggle, but it also puts you back on the card. Collapsing
    // from the foot of a tall brief otherwise removes several screens of content
    // from above you and leaves the scroll position pointing at whatever card
    // happens to have slid up into it.
    if (act === 'collapse') {
      disarm();
      paintArmed();
      state.open.delete(key);
      render(true);
      listEl
        .querySelector(`.card[data-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (act === 'option') {
      const q = byKey(key);
      const opt = q?.decision?.options.find((o) => o.id === btn.dataset.opt);
      if (!opt) return;
      const token = `${key}|${opt.id}`;
      if (state.armed !== token) {
        // Two taps to answer — a stray tap in a pocket shouldn't close a bead.
        state.armed = token;
        clearTimeout(state.armedTimer);
        state.armedTimer = setTimeout(() => {
          disarm();
          paintArmed();
        }, 6000);
        paintArmed();
        return;
      }
      disarm();
      await submit(key, opt.response, { close: true });
      return;
    }

    // Opens iTerm2 on the Mac with `claude` already reading this bead. Writes
    // nothing here, so — unlike answering — it deliberately never calls render():
    // the card stays exactly as it is, half-typed answer and all.
    if (act === 'discuss') {
      const q = byKey(key);
      if (!q) return;
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Opening a session…';
      try {
        const res = await api('/api/session', {
          method: 'POST',
          body: JSON.stringify({ workspace: q.workspace, id: q.id }),
        });
        toast(`Session open in ${res.dir.split('/').pop()} — go to your Mac`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
      }
      return;
    }

    if (act === 'answer' || act === 'note') {
      const card = btn.closest('.card');
      const box = card.querySelector('[data-role="answer"]');
      const text = box.value.trim();
      if (!text) return toast('Write something first', true);
      await submit(key, text, { close: act === 'answer' });
      if (act === 'note') box.value = '';
    }
  });

  // Every keystroke is kept, so collapsing the card, a background refresh, or
  // the phone killing the tab can't eat a half-written answer.
  listEl.addEventListener('input', (ev) => {
    const box = ev.target.closest('[data-role="answer"]');
    if (!box) return;
    const key = box.closest('.card')?.dataset.key;
    if (key) setDraft(key, box.value);
  });

  // Focus left an empty box: nothing is in flight, so let any deferred refresh in.
  listEl.addEventListener('focusout', (ev) => {
    if (!ev.target.matches?.('[data-role="answer"]')) return;
    if (pendingRender && !isAnswering()) render();
  });

  filtersEl.addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-ws]');
    if (!chip) return;
    state.workspace = chip.dataset.ws;
    render(true);
  });

  /* ----------------------------------------------------------------- load */

  let loading = false;
  async function load() {
    if (!state.token || loading) return;
    loading = true;
    pulseEl.classList.add('busy');
    try {
      const data = await api('/api/questions');
      const openKeys = state.open;
      // Keep any already-fetched detail so an open card doesn't flicker.
      const prev = new Map(state.questions.map((q) => [q.key, q]));
      state.questions = data.questions.map((q) => (prev.has(q.key) ? Object.assign(prev.get(q.key), q) : q));
      state.open = new Set([...openKeys].filter((k) => state.questions.some((q) => q.key === k)));
      render();
      focusHash();
    } catch (err) {
      if (err.message !== 'token rejected') {
        listEl.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
      }
    } finally {
      loading = false;
      pulseEl.classList.remove('busy');
    }
  }

  /** #workspace/id from an ntfy notification tap. */
  let hashHandled = '';
  async function focusHash() {
    const key = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!key || key === hashHandled || !byKey(key)) return;
    hashHandled = key;
    await expand(key);
    const el = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('#refresh').addEventListener('click', load);
  addEventListener('hashchange', () => {
    hashHandled = '';
    focusHash();
  });
  // These keep fetching; render() decides whether it's safe to repaint.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
  setInterval(() => {
    if (!document.hidden) load();
  }, 25000);

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // The one thing the page exposes to its host. The Android shell calls this when
  // you come back from the notification shade or a document, so the list is fresh
  // without a reload — a reload would discard scroll position and any draft sitting
  // in a textarea. render() still refuses to repaint mid-answer.
  window.beadcause = { refresh: load };

  bootToken();
  load();
})();
