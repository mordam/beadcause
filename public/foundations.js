/* The agents screen — what each agent is, and how to change it.
 *
 * Four tabs over one agent, because the four questions you actually arrive with are
 * different questions: what is it allowed to do (Foundation), what has it been
 * allowed to become (History), why did it do that (Chat), and what is it doing right
 * now (Activity).
 *
 * Two rules hold the editing together:
 *
 *   - **An edit here is an amendment, not a settings change.** It goes to the same
 *     ref, with the same justification field, as an amendment an agent asked for and
 *     Adam approved. The dialog asks why for that reason and not as ceremony: the
 *     git log is meant to read as the history of what an agent was allowed to
 *     become, and half the entries saying nothing would end that.
 *   - **Protected fields render locked, and say why.** `writes` and `protocolOwner`
 *     change by editing lib/foundation.js in a release. Showing them greyed with a
 *     reason beats hiding them — "why can I not change this" is a question the
 *     screen should answer, not raise.
 *
 * The chat is the chat session's conversation record with a different agent on the
 * other end, so it streams, resumes and survives a daemon restart identically. Only
 * the rendering is reimplemented here, and deliberately only the rendering: the
 * proposal sheet is the complicated half of console.js and a chat has no proposal.
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const state = {
    token: '',
    workspace: '',
    workspaces: [],
    agents: [],
    id: new URLSearchParams(location.search).get('id') || '',
    agent: null,
    tab: new URLSearchParams(location.search).get('tab') || 'foundation',
    // The foundation as edited on screen, authoritative over the server's copy
    // while the tab is open — same rule as the chat session's draft sheet.
    edits: {},
    chat: null,
    chatSeq: 0,
    polling: false,
  };

  /* ---------------------------------------------------------------- plumbing */

  function bootToken() {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      const keep = new URLSearchParams(location.search);
      keep.delete('t');
      history.replaceState(null, '', location.pathname + (keep.toString() ? `?${keep}` : ''));
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
        start();
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
    // The code as well as the message: a message sent mid-turn is refused with a
    // 409, and that is the one failure the send queue waits out rather than reports.
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function renderMarkdown(md) {
    return window.DOMPurify.sanitize(window.marked.parse(String(md || ''), { breaks: true, gfm: true }), {
      ADD_ATTR: ['target', 'rel'],
    });
  }

  let toastTimer;
  /** Red when something went wrong — and `bad === true` files it. See app.js's toast. */
  function toast(msg, bad = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('bad', Boolean(bad));
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3000);
    if (bad === true) window.beadcause?.report?.toast?.(msg);
  }

  const relTime = (iso) => {
    if (!iso) return '';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  };

  /* -------------------------------------------------------------- the list */

  function renderList() {
    $('#title').textContent = 'Agents';
    $('#list').hidden = false;
    $('#detail').hidden = true;
    $('#ws-btn').hidden = false;
    $('#ws-btn').textContent = `📁 ${state.workspace}`;
    $('#back').setAttribute('href', '/');

    $('#agent-list').innerHTML = state.agents
      .map((a) => {
        const marks = [];
        if (a.busy) marks.push(`<span class="pill st-in_progress">${a.busy} live</span>`);
        if (a.amended?.length) marks.push(`<span class="pill">${a.amended.length} amended</span>`);
        if (a.declined) marks.push(`<span class="pill">${a.declined} declined</span>`);
        marks.push(a.writes ? '<span class="pill">writes</span>' : '<span class="pill">read-only</span>');
        return `
        <article class="card agent-card" data-open="${esc(a.id)}" role="button" tabindex="0">
          <div class="card-head">
            <div class="meta">
              <span class="pill id">${esc(a.id)}</span>
              ${marks.join('')}
              ${a.lastRunAt ? `<time>${esc(relTime(a.lastRunAt))}</time>` : ''}
            </div>
            <p class="q">${esc(a.title)}</p>
            <p class="subtitle">${esc(a.purpose)}</p>
          </div>
        </article>`;
      })
      .join('');

    for (const el of document.querySelectorAll('[data-open]')) {
      const go = () => open(el.dataset.open);
      el.addEventListener('click', go);
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); }
      });
    }
  }

  /* ------------------------------------------------------------- one agent */

  async function open(id) {
    state.id = id;
    state.edits = {};
    const url = new URLSearchParams({ id, tab: state.tab });
    history.replaceState(null, '', `${location.pathname}?${url}`);
    await loadAgent();
  }

  async function loadAgent() {
    const q = new URLSearchParams({ id: state.id });
    if (state.workspace) q.set('workspace', state.workspace);
    // `/api/foundation/agent`, not `/api/foundation` — the bare path is the foundation
    // *requests* channel, and asking it for an agent got `{requests, workspaces}` back,
    // which made `state.agent` undefined and threw in renderDetail() below. See the
    // handler's own note in lib/server.js.
    const data = await api(`/api/foundation/agent?${q}`);
    state.agent = data.agent;
    state.workspace = data.workspace;
    renderDetail();
  }

  function renderDetail() {
    const a = state.agent;
    $('#list').hidden = true;
    $('#detail').hidden = false;
    $('#title').textContent = a.title;
    $('#ws-btn').hidden = false;
    $('#ws-btn').textContent = `📁 ${state.workspace}`;
    $('#back').setAttribute('href', '/foundations');

    for (const t of document.querySelectorAll('.tab')) {
      const on = t.dataset.tab === state.tab;
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      $(`#tab-${t.dataset.tab}`).hidden = !on;
    }

    renderFoundation();
    renderHistory();
    renderActivity();
    if (state.tab === 'chat') openChat();
  }

  /* ------------------------------------------------------------- foundation */

  /** How each amendable field is edited. Anything not here renders read-only. */
  const FIELDS = [
    { key: 'purpose', label: 'Purpose', kind: 'text', hint: 'One line. What this agent is for.' },
    { key: 'model', label: 'Model', kind: 'text', hint: 'Blank inherits whatever the CLI defaults to.' },
    { key: 'role', label: 'Role', kind: 'long', hint: 'The system prompt. What it is, and how it should behave.' },
    { key: 'tools', label: 'Tools', kind: 'list', hint: 'The --tools flag. Blank means the CLI default.' },
    { key: 'allowedTools', label: 'Allowlist', kind: 'list', hint: 'One per line. This is what it may actually run.' },
    { key: 'timeoutMs', label: 'Timeout', kind: 'ms', hint: 'How long one run may take before it is killed.' },
    { key: 'permissionMode', label: 'Permission mode', kind: 'text', hint: 'Interactive sessions only.' },
  ];

  const LOCKED_WHY = {
    writes: 'Whether this agent may change anything. Release-only: an agent that could grant itself write access would make the review step a formality.',
    protocolOwner: 'The module that parses this agent’s output. Release-only: a changed output contract breaks the parser silently, and looks like the agent being unhelpful.',
    id: 'The agent’s name. Release-only.',
  };

  const val = (key) => (key in state.edits ? state.edits[key] : state.agent[key]);

  function renderFoundation() {
    const a = state.agent;
    const rows = FIELDS.map((f) => {
      const v = val(f.key);
      const amended = (a.amended || []).includes(f.key);
      const flag = amended ? '<span class="pill">amended</span>' : '';
      let input;
      if (f.kind === 'long') {
        input = `<textarea class="f-input" data-field="${f.key}" rows="8">${esc(v || '')}</textarea>`;
      } else if (f.kind === 'list') {
        input = `<textarea class="f-input" data-field="${f.key}" rows="${Math.min(12, (v || []).length + 1)}">${esc((v || []).join('\n'))}</textarea>`;
      } else if (f.kind === 'ms') {
        input = `<input class="f-input" data-field="${f.key}" inputmode="numeric" value="${v == null ? '' : Math.round(v / 1000)}"><span class="f-unit">seconds</span>`;
      } else {
        input = `<input class="f-input" data-field="${f.key}" value="${esc(v == null ? '' : v)}">`;
      }
      return `
        <div class="f-row">
          <label class="f-label">${esc(f.label)} ${flag}</label>
          ${input}
          <p class="f-hint">${esc(f.hint)}</p>
        </div>`;
    }).join('');

    const locked = (a.protectedFields || [])
      .map(
        (k) => `
        <div class="f-row locked">
          <label class="f-label">${esc(k)} <span class="pill">locked</span></label>
          <div class="f-locked">${esc(String(a[k]))}</div>
          <p class="f-hint">${esc(LOCKED_WHY[k] || 'Release-only.')}</p>
        </div>`
      )
      .join('');

    const dirty = Object.keys(state.edits).length;
    $('#tab-foundation').innerHTML = `
      ${rows}
      <h2 class="section-label">Not editable here</h2>
      ${locked}
      <div class="f-actions">
        <button id="f-reset" class="secondary" type="button" ${dirty ? '' : 'disabled'}>Discard</button>
        <button id="f-save" class="primary" type="button" ${dirty ? '' : 'disabled'}>
          ${dirty ? `Save ${dirty} change${dirty > 1 ? 's' : ''}` : 'No changes'}
        </button>
      </div>`;

    for (const el of document.querySelectorAll('.f-input')) {
      el.addEventListener('input', () => {
        const f = FIELDS.find((x) => x.key === el.dataset.field);
        const parsed = parseField(f, el.value);
        // Compare against the server's copy so typing a value back to what it was
        // clears the edit rather than leaving a no-op amendment queued.
        if (JSON.stringify(parsed) === JSON.stringify(state.agent[f.key])) delete state.edits[f.key];
        else state.edits[f.key] = parsed;
        updateSaveButton();
      });
    }
    $('#f-reset').addEventListener('click', () => { state.edits = {}; renderFoundation(); });
    $('#f-save').addEventListener('click', saveFoundation);
  }

  function parseField(f, raw) {
    const s = String(raw);
    if (f.kind === 'list') {
      const items = s.split('\n').map((x) => x.trim()).filter(Boolean);
      return items.length ? items : null;
    }
    if (f.kind === 'ms') {
      const n = Number(s.trim());
      return s.trim() === '' || !Number.isFinite(n) ? null : Math.round(n * 1000);
    }
    return s.trim() === '' ? null : s;
  }

  /** Repaint only the buttons — re-rendering would take the textarea out from under you. */
  function updateSaveButton() {
    const dirty = Object.keys(state.edits).length;
    const save = $('#f-save');
    const reset = $('#f-reset');
    if (!save) return;
    save.disabled = !dirty;
    reset.disabled = !dirty;
    save.textContent = dirty ? `Save ${dirty} change${dirty > 1 ? 's' : ''}` : 'No changes';
  }

  async function saveFoundation() {
    const fields = Object.keys(state.edits);
    if (!fields.length) return;
    $('#save-summary').textContent = `Changing ${fields.join(', ')} on the ${state.agent.id} agent.`;
    $('#save-why').value = '';
    const dlg = $('#save-dialog');
    dlg.showModal();
    dlg.addEventListener(
      'close',
      async () => {
        if (dlg.returnValue !== 'save') return;
        const why = $('#save-why').value.trim();
        if (!why) return toast('A justification is required — that is the point of the history.', 'refused');
        try {
          const out = await api('/api/foundation/amend', {
            method: 'POST',
            body: JSON.stringify({ id: state.agent.id, workspace: state.workspace, set: state.edits, justification: why }),
          });
          state.edits = {};
          state.agent = { ...state.agent, ...out.agent };
          await loadAgent();
          toast(`Amended ${fields.join(', ')}`);
        } catch (err) {
          toast(err.message, true);
        }
      },
      { once: true }
    );
  }

  /* ---------------------------------------------------------------- history */

  function renderHistory() {
    const h = state.agent.amendmentHistory || [];
    if (!h.length) {
      $('#tab-history').innerHTML = `
        <div class="empty"><strong>Never amended</strong>
        This agent is exactly what the release says it is. Every change from here on
        shows up in this list, with the reason it was made.</div>`;
      return;
    }
    $('#tab-history').innerHTML = h
      .map((c) => {
        const declined = /: decline/.test(c.subject || '');
        const body = (c.message || '').split('\n').slice(1).join('\n').trim();
        return `
        <article class="card hist ${declined ? 'declined' : ''}">
          <div class="card-head">
            <div class="meta">
              <span class="pill ${declined ? 'p0' : ''}">${declined ? 'declined' : 'approved'}</span>
              <span class="pill id">${esc((c.commit || '').slice(0, 7))}</span>
              <time>${esc(relTime(c.at))}</time>
            </div>
            <p class="q">${esc(c.subject || '')}</p>
            <div class="md">${renderMarkdown(body)}</div>
          </div>
        </article>`;
      })
      .join('');
  }

  /* --------------------------------------------------------------- activity */

  function renderActivity() {
    const a = state.agent;
    const live = (a.activity || [])
      .map(
        (x) => `
      <article class="card">
        <div class="card-head">
          <div class="meta">
            <span class="pill st-in_progress">${esc(x.phase)}</span>
            <span class="pill id">${esc(x.key)}</span>
            <time>${esc(relTime(x.at))}</time>
          </div>
          <p class="subtitle">${esc(x.detail || '')}</p>
        </div>
      </article>`
      )
      .join('');

    const runs = (a.runs || [])
      .map((r) => {
        const bits = [];
        if (r.workspace) bits.push(`<span class="pill">${esc(r.workspace)}</span>`);
        if (r.bead) bits.push(`<span class="pill id">${esc(r.bead)}</span>`);
        if (r.status) bits.push(`<span class="pill">${esc(r.status)}</span>`);
        if (r.paused) bits.push('<span class="pill p0">paused</span>');
        if (r.error) bits.push(`<span class="pill p0">${esc(r.error)}</span>`);
        // Not `r.key`: an advocate's key IS its workspace, which is already the first
        // pill, and a row that says "beadcause / beadcause" reads as a rendering bug.
        const sub =
          r.title ||
          [
            r.lastProposalAt ? `last proposed ${relTime(r.lastProposalAt)}` : '',
            r.lastLaunchAt ? `last opened a session ${relTime(r.lastLaunchAt)}` : '',
            r.pendingNotes ? `${r.pendingNotes} session(s) awaiting a landing note` : '',
          ]
            .filter(Boolean)
            .join(' · ') ||
          'has not run yet';
        return `
        <article class="card">
          <div class="card-head">
            <div class="meta">${bits.join('')}${r.at ? `<time>${esc(relTime(r.at))}</time>` : ''}</div>
            <p class="subtitle">${esc(sub)}</p>
          </div>
        </article>`;
      })
      .join('');

    $('#tab-activity').innerHTML = `
      <h2 class="section-label">Right now</h2>
      ${live || '<div class="empty">Nothing running.</div>'}
      <h2 class="section-label">Recent</h2>
      ${runs || `<div class="empty">${esc(a.runsNote || 'Nothing recorded yet.')}</div>`}`;
  }

  /* ------------------------------------------------------------------- chat */

  async function openChat() {
    if (state.chat) return;
    // Resume the newest chat with this agent rather than opening a fresh one every
    // visit: a conversation you had yesterday about why it did something is exactly
    // the context you want when you come back to ask the follow-up.
    try {
      const { consoles } = await api('/api/consoles');
      const mine = (consoles || []).filter((c) => c.agent === state.agent.id);
      if (mine.length) {
        state.chat = await api(`/api/console?id=${encodeURIComponent(mine[0].id)}`);
        renderChat();
        pollChat();
        return;
      }
    } catch {
      /* falls through to opening a new one */
    }
    renderChat();
  }

  async function ensureChat() {
    if (state.chat) return state.chat;
    const out = await api('/api/console', {
      method: 'POST',
      body: JSON.stringify({ workspace: state.workspace, agent: state.agent.id }),
    });
    state.chat = out.console;
    return state.chat;
  }

  function renderChat() {
    const c = state.chat;
    const thread = $('#chat-thread');
    // The composer is never disabled here either: what a running turn changes is
    // where the words go, not whether you may write them.
    queue.sync(c?.status === 'thinking');
    if (!c || !c.messages?.length) {
      thread.innerHTML = `
        <div class="empty"><strong>Talk to the ${esc(state.agent.id)}</strong>
        It runs with its real foundation — the same role, allowlist and model it has
        at work — so what it can and cannot do here is what it can and cannot do
        for real.</div>`;
      return;
    }
    thread.innerHTML = c.messages
      .map((m) => {
        if (m.role === 'user') return `<div class="msg you">${esc(m.text)}</div>`;
        const body = m.text || m.streaming || '';
        const cls = m.error ? 'msg claude bad' : 'msg claude';
        const tools = (m.tools || []).length
          ? `<div class="agent-log">${esc(m.tools.map((t) => t.brief || t.name).join(' · '))}</div>`
          : '';
        return `<div class="${cls}">${tools}<div class="md">${renderMarkdown(body)}</div>${
          m.pending ? '<div class="agent-log">…</div>' : ''
        }</div>`;
      })
      .join('');
    thread.scrollTop = thread.scrollHeight;
  }

  async function pollChat() {
    if (state.polling || !state.chat) return;
    state.polling = true;
    try {
      for (;;) {
        if (state.tab !== 'chat' || !state.chat) break;
        const c = await api(`/api/console/poll?id=${encodeURIComponent(state.chat.id)}&since=${state.chat.seq}&wait=25`);
        state.chat = c;
        renderChat();
        $('#pulse').classList.toggle('busy', c.status === 'thinking');
      }
    } catch (err) {
      toast(err.message, true);
    } finally {
      state.polling = false;
      $('#pulse').classList.remove('busy');
    }
  }

  /**
   * Send one turn's worth — one message, or every message queued during the last
   * turn, as a single turn.
   *
   * The optimistic bubble is here rather than in the queue for the same reason as the
   * bead console's: opening a chat spawns a process, and words that disappear for a
   * second while that happens read as having been eaten. A failure takes the bubble
   * back out, because the queue is holding the words and drawing them in both places
   * would look like the message went twice.
   */
  async function deliver(text) {
    const c = await ensureChat();
    const msg = { role: 'user', text, at: new Date().toISOString() };
    state.chat.messages = [...(state.chat.messages || []), msg];
    state.chat.status = 'thinking';
    renderChat();
    try {
      await api('/api/console/message', { method: 'POST', body: JSON.stringify({ id: c.id, text }) });
    } catch (err) {
      state.chat.messages = (state.chat.messages || []).filter((m) => m !== msg);
      state.chat.status = 'idle';
      renderChat();
      throw err;
    }
    state.chat = await api(`/api/console?id=${encodeURIComponent(c.id)}`);
    renderChat();
    pollChat();
  }

  /**
   * The same queue the bead console uses, drawing the same strip above this
   * composer. Only the *conversation* is rendered separately on this screen — a
   * message that has not gone yet is not part of one.
   */
  const queue = window.beadcause.sendQueue.create({
    deliver,
    onError: (err, { willRetry }) => {
      if (err.message === 'token rejected') return;
      if (err.status === 409 || willRetry) return;
      toast(`${err.message} — tap the message above the box to get it back`, true);
    },
  });
  queue.attach({ el: '#chat-queued', box: '#chat-say' });

  function sendChat(e) {
    e.preventDefault();
    const box = $('#chat-say');
    const text = box.value.trim();
    if (!text) return;
    box.value = '';
    queue.say(text);
  }

  /* ------------------------------------------------------------------- boot */

  function wire() {
    for (const t of document.querySelectorAll('.tab')) {
      t.addEventListener('click', () => {
        state.tab = t.dataset.tab;
        const url = new URLSearchParams({ id: state.id, tab: state.tab });
        history.replaceState(null, '', `${location.pathname}?${url}`);
        renderDetail();
      });
    }
    // Same composer as the bead console's, so the same mic in the same corner — see
    // the note there for why the status line sits above it rather than inside it.
    window.beadcause?.dictation?.attach($('#chat-say'), { note: '#chat-queued', label: 'Dictate this' });
    $('#chat-composer').addEventListener('submit', sendChat);
    $('#chat-say').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(e); }
    });
    $('#back').addEventListener('click', (e) => {
      if (!state.id) return; // already on the list; let the link go to the inbox
      e.preventDefault();
      state.id = '';
      state.chat = null;
      state.edits = {};
      history.replaceState(null, '', location.pathname);
      renderList();
    });
    /*
      📁 cycles the repo — inside the selected space, and by moving the space picker
      rather than this page's own copy of the choice.

      This screen has always been about exactly one workspace at a time, so it is the
      one page where the picker is not a filter but the thing itself. The button stays
      because it is a one-tap way round a space's repos and because with `All spaces`
      picked it is the only thing on screen naming which repo these foundations are —
      but it writes through the picker, so the phone and every other page follow it.
    */
    $('#ws-btn').addEventListener('click', async () => {
      const picker = window.beadcause?.space;
      const inside = picker?.inside?.().length ? picker.inside() : state.workspaces;
      if (inside.length < 2) return;
      const next = inside[(inside.indexOf(state.workspace) + 1) % inside.length];
      state.chat = null;
      if (picker) {
        // The refetch comes back through onChange, so a tap here and a tap on the phone
        // end in the same place.
        picker.set({ space: picker.spaceOf(next), workspace: next });
        return;
      }
      state.workspace = next;
      await start();
    });

    /* Somewhere else picked a different repo. This page has to refetch rather than
       repaint — the agents, their foundations and the chat are all per-workspace. */
    window.beadcause?.space?.onChange(() => {
      const want = picked();
      if (!want || want === state.workspace) return;
      state.workspace = want;
      state.chat = null;
      start();
    });
  }

  /**
   * Which repo's foundations to read: the picker's, when it names one.
   *
   * Three cases, and the first is the one worth spelling out. **Nothing narrowed means
   * nothing chosen**, so the answer is empty and the server's own default stands — which
   * is what this screen has always opened on, and reaching into the picker for "the first
   * workspace in the list" would quietly move it.
   *
   * A repo picked is that repo. A *space* picked keeps whichever workspace the page is
   * already on as long as it is inside that space, and otherwise moves to the first one
   * that is — the alternative being a screen editing an agent in a repo the app is not
   * showing you.
   */
  function picked() {
    const picker = window.beadcause?.space;
    if (!picker) return '';
    const { space, workspace } = picker.filter;
    if (workspace !== 'all') return workspace;
    if (space === 'all') return '';
    const inside = picker.inside();
    return inside.includes(state.workspace) ? state.workspace : inside[0] || '';
  }

  async function start() {
    try {
      state.workspace = picked() || state.workspace;
      const q = state.workspace ? `?workspace=${encodeURIComponent(state.workspace)}` : '';
      const data = await api(`/api/foundations${q}`);
      state.agents = data.agents;
      state.workspace = data.workspace;
      state.workspaces = data.workspaces || [];
      if (state.id) await loadAgent();
      else renderList();
    } catch (err) {
      toast(err.message, true);
    }
  }

  bootToken();
  wire();
  if (state.token) start();
})();
