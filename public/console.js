/* The chat session — decide what to file, then file it.
 *
 * Every other screen in beadcause acts on beads that already exist. This one is
 * upstream of that: you describe the thing however it comes out, an agent asks the
 * questions that would change the answer, and what comes back is a *proposal* —
 * cards you read and edit on this screen. Nothing reaches the tracker until you
 * press the button, and the button is the only writer.
 *
 * Two rules hold the interaction together:
 *
 *   - **The proposal sheet is the review.** There is no second "are you sure"
 *     screen after it, because a confirmation you cannot change is just a delay.
 *     What is on those cards is exactly what gets created.
 *   - **The sheet never repaints under your hands.** A turn finishing while you are
 *     halfway through rewriting a description must not replace the textarea you are
 *     typing in — the same reason the inbox defers its list repaints. A revision
 *     that arrives while you have unsaved edits offers itself in a banner instead
 *     of taking the screen.
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const TYPES = ['task', 'bug', 'feature', 'epic', 'chore'];
  const PRIORITIES = [0, 1, 2, 3, 4];
  /** How long a primed Create button stays primed. Same 6s as the inbox's answers. */
  const ARM_MS = 6000;

  /**
   * Which repo the launcher is showing.
   *
   * This used to be `state.repo`, remembered in localStorage under
   * `beadcause.console.repo` — this page's own private answer to "which repo am I
   * working in", one of four such answers in the app. It is the space picker's now
   * (public/spacebar.js): server-owned, on every screen, and the same value that
   * decides whether your phone rings. The tab row below is a second face of it rather
   * than a second copy — tapping a tab moves the picker in the bar above.
   *
   * The stored key is deliberately not migrated. A tab remembered on one device is
   * exactly what the selection stopped being, and reading it once at startup would
   * silently narrow the whole app — including the notifications — on the strength of a
   * tap somebody made on this page last week.
   */
  const repoNow = () => window.beadcause?.space?.filter?.workspace || 'all';

  const state = {
    token: '',
    id: new URLSearchParams(location.search).get('id') || '',
    // The launcher: every workspace, every conversation, and which tab is on.
    workspaces: [],
    consoles: [],
    /**
     * A repo that exists only in the transcripts, when one is being read.
     *
     * The picker can only hold a workspace the server actually serves — `reconcileFilter`
     * resets anything else on the next payload, which is right, because a filter naming
     * a repo the daemon has never heard of would silence a space nobody can see. But a
     * workspace dropped from the config still has its conversations, and a tab is the
     * only way to them. So that one case stays local to this page: it filters this list
     * and nothing else, and any other tab clears it.
     */
    stray: '',
    console: null,
    seq: 0,
    // The cards as edited here. Authoritative over the server's copy while the
    // sheet is open, which is what makes typing in it safe.
    draft: null,
    draftDirty: false,
    // The server draft the local copy was taken from, so a genuine revision can be
    // told apart from an echo of our own save.
    baseDraft: '',
    pendingRevision: null,
    open: new Set(),
    armed: false,
    armedTimer: null,
    saveTimer: null,
    polling: false,
    creating: false,
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
      // Held payloads are somebody's, and as of this refusal not provably yours.
      window.beadcause?.warm?.forget?.();
      askForToken();
      throw new Error('token rejected');
    }
    const data = await res.json().catch(() => ({}));
    // The code as well as the message: a message queued mid-turn is refused with a
    // 409, and that is the one failure the send queue waits out rather than reports.
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
    return data;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const isLocalPath = (s) => /^(file:\/\/|~\/|\/)/.test(String(s || '').trim());

  function docUrl(p) {
    let s = String(p || '').trim();
    if (s.startsWith('file://')) s = decodeURIComponent(s.slice(7));
    if (s.startsWith('~')) s = s.replace(/^~/, '');
    return `/doc?p=${encodeURIComponent(s)}`;
  }

  /** Same treatment as a question brief: a path in the prose opens in the reader. */
  function renderMarkdown(md) {
    const patched = String(md || '').replace(
      /(^|[^!])\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g,
      (m, pre, label, href) => (isLocalPath(href) ? `${pre}[${label}](${docUrl(href)})` : m)
    );
    return window.DOMPurify.sanitize(window.marked.parse(patched, { breaks: true, gfm: true }), {
      ADD_ATTR: ['target', 'rel'],
    });
  }

  let toastTimer;
  function toast(msg, bad = false) {
    const el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('bad', bad);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), bad ? 6000 : 3000);
  }

  const relTime = (iso) => {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  };

  // `id` only scopes the graph — it does not open anything. `open` adds the second
  // half: the graph page raises that bead's sheet once it has drawn. Anywhere the id
  // is the whole reason for the link (a bead you just filed, the one this chat session
  // started from) wants beadUrl; a link that means "show me the neighbourhood" wants
  // graphUrl.
  const graphUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}`;
  const beadUrl = (ws, id) => `${graphUrl(ws, id)}&open=1`;

  /* --------------------------------------------------------------- launcher */

  async function showLauncher() {
    $('#launcher').hidden = false;
    $('#thread').hidden = true;
    $('#composer').hidden = true;
    document.body.classList.add('launching');

    // What this tab had last time, drawn before the request has left. The launcher is
    // a list of conversations per repo and it is read at a glance, so the whole cost
    // of arriving here used to be the wait in front of it. See public/warm.js.
    const warm = window.beadcause?.warm;
    const hit = warm?.read?.('/api/consoles');
    if (Array.isArray(hit?.data?.consoles)) adoptConsoles(hit.data);

    let data;
    try {
      data = await api('/api/consoles');
    } catch (err) {
      if (err.message !== 'token rejected') toast(err.message, true);
      return;
    }
    warm?.write?.('/api/consoles', data);
    adoptConsoles(data);
    // Only from a request that came back, and once per document — see public/warm.js.
    warm?.prewarm?.({ here: 'console', api });
  }

  /**
   * Become a `/api/consoles` payload and draw it.
   *
   * Split out of `showLauncher` because two things arrive with this shape now — the
   * fetch and the payload kept from the last visit — and a second copy of it is how a
   * warm launcher would come to disagree with a fetched one.
   */
  function adoptConsoles(data) {
    state.workspaces = data.workspaces || [];
    state.consoles = data.consoles || [];
    /* Nothing is fed to the picker from here, deliberately. This page's numbers are
       conversations per repo, and the count on the bar means beads asking you something
       — the same number on every screen, from /api/spaces. Two meanings for one badge,
       depending on which page you were on, is how a count stops being read at all. The
       tab row below keeps the conversation counts, where they say what they are. */
    // A stray tab whose transcripts have gone with it is an empty screen with no way of
    // knowing why.
    if (state.stray && !repoTabs().includes(state.stray)) state.stray = '';

    hidePicker();
    renderRepoTabs();
    renderRecent();
  }

  /**
   * Every repo that gets a tab.
   *
   * The configured workspaces in the server's order, then any repo that only
   * exists in the conversations — a workspace dropped from the config still has
   * its transcripts, and a tab is the only thing that would reach them.
   */
  function repoTabs() {
    const extra = [...new Set(state.consoles.map((c) => c.workspace))]
      .filter((w) => w && !state.workspaces.includes(w))
      .sort();
    return [...state.workspaces, ...extra];
  }

  /** In the selected space at all — what `All` means on this page. */
  const inSpace = (ws) => window.beadcause?.space?.matches?.(ws) ?? true;

  /** Which of them the picker is letting through, plus the stray if one is being read. */
  const tabsHere = () => repoTabs().filter((w) => w === state.stray || inSpace(w));

  const inRepo = (c) => (state.stray ? c.workspace === state.stray : inSpace(c.workspace));

  /**
   * The tab bar: All, then one per repo in the selected space, each carrying how many
   * conversations it holds.
   *
   * A count is drawn only where there is one. Every repo gets a tab whether or
   * not it has ever been talked to — the bar is also how you reach a repo to
   * start in — and a row of zeroes would report emptiness rather than offering a
   * place to begin.
   *
   * `All` means all of the *selected space*, not all of the Mac. With one repo picked
   * this row is a single tab and says the same thing twice, which is the honest picture:
   * there is one repo in scope and you are in it.
   */
  function renderRepoTabs() {
    const row = $('#ws-row');
    const now = state.stray || repoNow();
    const count = (ws) => state.consoles.filter((c) => c.workspace === ws).length;
    const tab = (id, label, n) => {
      const on = now === id;
      return `<button class="chip" role="tab" id="ws-tab-${esc(id)}" data-ws="${esc(id)}"
        aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(label)}${n ? ` ${n}` : ''}</button>`;
    };
    row.innerHTML =
      // All counts the space, not whatever a stray tab has narrowed the list to — it is
      // the tab that would take you back out to it.
      tab('all', 'All', state.consoles.filter((c) => inSpace(c.workspace)).length) +
      tabsHere()
        .map((ws) => tab(ws, ws, count(ws)))
        .join('');
    // The list is what the tab selects, so it is named by the tab that selected it.
    $('#recent').setAttribute('aria-labelledby', `ws-tab-${now}`);
    // ＋ on All has no repo to start in; on a repo tab it starts there and says so.
    $('#ws-new').setAttribute(
      'aria-label',
      now === 'all' ? 'Start a chat session' : `Start a chat session in ${now}`
    );
  }

  /**
   * Pick a repo — which is to say, move the space picker.
   *
   * The row and the bar are one control with two faces, so a tap here writes the same
   * server-owned filter the dropdown does and every other page changes with it. `All`
   * means every repo in the space that is selected, so it clears the workspace half and
   * leaves the space alone.
   *
   * The repaint comes back through `space.onChange`, not from here: a tap on this page
   * and a change made on the phone have to end in the same place.
   */
  function setRepo(repo) {
    const picker = window.beadcause?.space;
    if (!picker) return;
    // A repo that only exists in the transcripts cannot be the app's filter — see
    // `state.stray`. It is this list's filter and nothing else.
    if (repo !== 'all' && !state.workspaces.includes(repo)) {
      state.stray = repo;
      hidePicker();
      renderRepoTabs();
      renderRecent();
      return;
    }
    state.stray = '';
    picker.set(repo === 'all' ? { space: picker.filter.space, workspace: 'all' } : { space: picker.spaceOf(repo), workspace: repo });
    // Painted here as well as from `onChange`, and not redundantly: the picker only
    // notifies on a *change*, and leaving a stray tab for the repo that is already
    // selected changes nothing about the filter while changing everything about what
    // this list is showing.
    hidePicker();
    renderRepoTabs();
    renderRecent();
  }

  /**
   * The conversations in the selected repo.
   *
   * Live ones first, finished ones under them. A chat session is over when the
   * beads exist, and a list where everything sorts by recency puts the one thing
   * you have already dealt with at the top.
   */
  function renderRecent() {
    const rows = state.consoles.filter(inRepo);
    const live = rows.filter((c) => !c.closedAt);
    const closed = rows.filter((c) => c.closedAt);
    $('#recent-label').hidden = !rows.length;
    const now = state.stray || repoNow();
    const where = now === 'all' ? window.beadcause?.space?.label?.() || 'here' : now;
    $('#recent').innerHTML = rows.length
      ? [...live, ...closed].map(consoleRowHtml).join('')
      : `<div class="empty"><strong>${
          state.consoles.length ? `Nothing in ${esc(where)} yet` : 'No conversations yet'
        }</strong>＋ starts one${now === 'all' ? '' : ` in ${esc(now)}`}.</div>`;

    for (const btn of $('#recent').querySelectorAll('[data-close]')) {
      btn.addEventListener('click', (ev) => {
        // The row is a link. Closing it must not also open it.
        ev.preventDefault();
        ev.stopPropagation();
        closeConsole(btn.dataset.close, btn);
      });
    }
  }

  const pickerOpen = () => !$('#ws-pick').hidden;

  function hidePicker() {
    $('#ws-pick').hidden = true;
    $('#ws-new').setAttribute('aria-expanded', 'false');
  }

  /**
   * What ＋ does with no repo selected.
   *
   * The All tab is the one place the tabs cannot say where a new conversation
   * belongs, so ＋ asks instead of going dead — a disabled button on the view the
   * launcher opens in would take the primary action away from the default screen.
   */
  function showPicker() {
    const row = $('#ws-pick-row');
    // Only configured workspaces: a repo that survives here as transcripts alone
    // is somewhere you can read, not somewhere you can start. And only the ones in the
    // selected space — offering to start work in a repo the app is not showing you is
    // the one thing a filter has to stop.
    const startable = state.workspaces.filter((w) => window.beadcause?.space?.matches?.(w) ?? true);
    row.innerHTML = startable.map((w) => `<button class="chip" data-ws="${esc(w)}">${esc(w)}</button>`).join('');
    if (!startable.length) {
      row.innerHTML = `<span class="hint">${
        state.workspaces.length ? 'No workspaces in this space.' : 'No workspaces configured.'
      }</span>`;
    }
    $('#ws-pick').hidden = false;
    $('#ws-new').setAttribute('aria-expanded', 'true');
    row.querySelector('.chip')?.focus();
  }

  /**
   * Which agent this conversation is with, or null for a chat session.
   *
   * The agents screen starts conversations against the same record type, in the same
   * workspace, and they land in this list beside the ones started here — so without
   * this the Critic's chat is a row whose only tell is its title. The server names
   * the agent (lib/agents.js `withAgentNames`); a record written before agent chats
   * existed carries no `agent` at all, and those are all chat sessions.
   */
  const chatAgent = (c) => {
    const id = c.agent || 'console';
    return id === 'console' ? null : { name: c.agentName || id, emoji: c.agentEmoji || '🤖' };
  };

  function consoleRowHtml(c) {
    const bits = [];
    if (c.beadCount) bits.push(`${c.beadCount} proposed`);
    if (c.created?.length) bits.push(`${c.created.length} created`);
    if (c.seed) bits.push(`from ${c.seed.id}`);
    const done = Boolean(c.closedAt);
    const agent = chatAgent(c);
    // Two marks, because the one that is loudest is also the one that gets taken
    // over: the phase slot says 💬 for a chat session and the agent's own emoji for
    // an agent chat, but a running turn draws a spark there and a finished one a
    // tick — so the pill beside the repo is what holds when the slot is busy.
    const phase = c.status === 'thinking' ? '<span class="spark"></span>' : done ? '✓' : agent ? esc(agent.emoji) : '💬';
    return `<div class="console-row${done ? ' closed' : ''}${agent ? ' agent-chat' : ''}">
      <a class="work-row" href="/console?id=${encodeURIComponent(c.id)}">
        <span class="work-phase">${phase}</span>
        <span class="work-main">
          <span class="work-title">${esc(c.title || 'Untitled')}</span>
          <span class="work-sub"><span class="pill">${esc(c.workspace)}</span>${
            agent ? `<span class="pill agent">${esc(agent.emoji)} ${esc(agent.name)}</span>` : ''
          }${done ? '<span class="pill">closed</span>' : ''}${
            bits.length ? ` ${esc(bits.join(' · '))}` : ''
          }</span>
        </span>
        <time>${esc(relTime(c.updatedAt))}</time>
      </a>
      ${
        done
          ? // Nothing to close, and no "reopen" button either: saying anything to a
            // closed chat session reopens it, so the way back in is the row itself.
            ''
          : `<button class="row-x" data-close="${esc(c.id)}" aria-label="${
              agent ? `Close this chat with the ${esc(agent.name)}` : 'Close this chat session'
            }">✕</button>`
      }
    </div>`;
  }

  /**
   * Close one from the list.
   *
   * Soft — the transcript stays and the id keeps working — so this needs no
   * confirmation. Refused mid-turn by the server, which is the one case worth
   * hearing about.
   */
  async function closeConsole(id, btn) {
    if (btn) btn.disabled = true;
    try {
      await api('/api/console/close', { method: 'POST', body: JSON.stringify({ id }) });
      showLauncher();
    } catch (err) {
      if (btn) btn.disabled = false;
      if (err.message !== 'token rejected') toast(err.message, true);
    }
  }

  /** Open a chat session: on a workspace, or on a workspace seeded with one bead. */
  async function open(workspace, seed) {
    try {
      const made = await api('/api/console', {
        method: 'POST',
        body: JSON.stringify({ workspace, seed: seed || undefined }),
      });
      location.href = `/console?id=${encodeURIComponent(made.id)}`;
    } catch (err) {
      if (err.message !== 'token rejected') toast(err.message, true);
    }
  }

  /* ----------------------------------------------------------------- thread */

  /** Pinned to the bottom unless you have scrolled up to read something. */
  function atBottom() {
    const el = $('#thread');
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }

  function scrollDown(force) {
    const el = $('#thread');
    if (force || atBottom()) el.scrollTop = el.scrollHeight;
  }

  /** What the agent is doing right now, from its tool calls. */
  function toolsHtml(tools) {
    if (!tools?.length) return '';
    const last = tools.slice(-3);
    return `<div class="tools">${last
      .map((t) => `<span class="tool"><b>${esc(t.name)}</b> ${esc(t.brief || '')}</span>`)
      .join('')}</div>`;
  }

  /** Is there anything the sheet could actually show? What `openSheet` gates on. */
  const liveDraft = () => (state.draft?.beads?.length || 0) > 0;

  /**
   * What became of a proposal — read off the transcript rather than stored on it.
   *
   * `proposed: N` is written into the message when the turn lands and stays there for
   * the life of the chat session. The draft it pointed at does not: creating spends it,
   * the next turn replaces it, closing drops it. So what the button means is decided
   * by the first thing *after* the message that either consumed that draft or put
   * another one in its place — and a button whose draft is gone must say so rather
   * than open nothing.
   */
  function proposalFate(all, i) {
    for (let j = i + 1; j < all.length; j++) {
      const m = all[j];
      if (m.role === 'system' && m.kind === 'created') return { kind: 'filed', at: j, created: m.created || [] };
      if (m.role === 'assistant' && m.proposed) return { kind: liveDraft() ? 'revised' : 'spent' };
    }
    return { kind: liveDraft() ? 'live' : 'spent' };
  }

  /**
   * The line under a reply that proposed something, in whichever of its four states.
   *
   * Only the newest live proposal opens the sheet on what it proposed. A filed one
   * walks you down to the beads it became — they are already listed in the “✓ Created”
   * note, and reopening an editor for beads that exist would offer to file them
   * twice. A superseded one is honest that the sheet now holds a later draft. And one
   * whose draft went away without becoming anything is disabled, because the only
   * thing left to say is that there is nothing to look at.
   */
  function proposalHtml(m, all, i) {
    const n = m.proposed;
    const beads = `${n} bead${n === 1 ? '' : 's'}`;
    const fate = proposalFate(all, i);
    if (fate.kind === 'filed' && fate.created.length) {
      const c = fate.created.length;
      return `<button class="proposed-link filed" data-goto="${fate.at}">✓ filed ${c} bead${
        c === 1 ? '' : 's'
      }</button>`;
    }
    if (fate.kind === 'filed') {
      return `<button class="proposed-link" disabled>🧾 proposed ${beads} — none were created</button>`;
    }
    if (fate.kind === 'revised') {
      return `<button class="proposed-link revised" data-open-sheet>🧾 proposed ${beads} — revised since; open the current draft</button>`;
    }
    if (fate.kind === 'spent') {
      return `<button class="proposed-link" disabled>🧾 proposed ${beads} — draft discarded</button>`;
    }
    return `<button class="proposed-link" data-open-sheet>🧾 proposed ${beads} — review</button>`;
  }

  function messageHtml(m, i, all) {
    if (m.role === 'user') return `<div class="msg you">${esc(m.text)}</div>`;

    if (m.role === 'system' && m.kind === 'created') {
      // Pill and title in one anchor, not a linked id sitting beside inert text. The
      // title is the big thing on the row and it looked tappable long before it was;
      // the id pill on its own is a 40px-wide target on a phone.
      const pills = (m.created || [])
        .map(
          (x) =>
            `<a class="created-row" href="${esc(beadUrl(state.console.workspace, x.id))}" target="_blank" rel="noopener">
               <span class="pill id created">${esc(x.id)}</span>
               <span class="created-title">${esc(x.title)}</span>
             </a>`
        )
        .join('');
      const warn = (m.warnings || []).length
        ? `<div class="warnings">${m.warnings.map((w) => `<span>${esc(w)}</span>`).join('')}</div>`
        : '';
      return `<div class="msg created-note" data-msg="${i}">
        <strong>✓ Created ${m.created.length} bead${m.created.length === 1 ? '' : 's'}</strong>
        <div class="created-list">${pills}</div>${warn}</div>`;
    }

    // What beadcause did to the agent between turns. Its own row rather than an
    // assistant bubble: the chat session did not say this, and a note about it
    // being restarted is the last thing that should look like the agent talking.
    if (m.role === 'system' && m.kind === 'reseeded') {
      return `<div class="msg reseed-note"><strong>↻ Foundation changed</strong>${esc(m.text)}</div>`;
    }

    // A quiet divider rather than a message. The chat session being closed or picked back
    // up belongs in the scrollback, but rendering it in an assistant bubble would
    // read as something the agent said.
    if (m.role === 'system' && (m.kind === 'closed' || m.kind === 'reopened')) {
      return `<div class="note-line">${m.kind === 'closed' ? '✓' : '↻'} ${esc(m.text || '')}</div>`;
    }

    // Assistant. A pending turn shows what it is doing; a finished one shows what
    // it said, plus a line pointing at the proposal it just made.
    const parts = [];
    const body = (m.text || '') + (m.streaming ? (m.text ? '\n\n' : '') + m.streaming : '');
    if (body.trim()) parts.push(`<div class="md">${renderMarkdown(body)}</div>`);
    if (m.pending) {
      parts.push(
        `<div class="working"><span class="spark"></span>${
          body.trim() ? 'still working' : m.tools?.length ? 'reading' : 'thinking'
        }…</div>${toolsHtml(m.tools)}`
      );
    } else if (m.tools?.length && !body.trim()) {
      parts.push(toolsHtml(m.tools));
    }
    if (m.interrupted) parts.push(`<div class="warnings"><span>this turn was cut short by a restart</span></div>`);
    if (m.proposalError) parts.push(`<div class="warnings"><span>${esc(m.proposalError)}</span></div>`);
    if (m.proposed) parts.push(proposalHtml(m, all, i));
    if (!parts.length) return '';
    return `<div class="msg claude${m.pending ? ' live' : ''}">${parts.join('')}</div>`;
  }

  function renderThread() {
    const c = state.console;
    const pin = atBottom();

    const head = c.seed
      ? `<div class="seed-note">Starting from <a class="seed-link" href="${esc(beadUrl(c.workspace, c.seed.id))}" target="_blank" rel="noopener"><span class="pill id">${esc(c.seed.id)}</span> <span class="seed-title">${esc(c.seed.title)}</span></a></div>`
      : '';

    const msgs = c.messages.map(messageHtml).filter(Boolean).join('');
    const empty = !msgs
      ? `<div class="empty"><strong>Nothing said yet</strong>Describe what you have in mind — as loosely as you like. It will ask what it needs to know.</div>`
      : '';
    const err = c.status === 'error' && c.error ? `<div class="msg bad">${esc(c.error)}</div>` : '';

    $('#thread').innerHTML = head + msgs + empty + err;
    for (const a of $('#thread').querySelectorAll('.md a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
    for (const b of $('#thread').querySelectorAll('[data-open-sheet]')) b.addEventListener('click', openSheet);
    for (const b of $('#thread').querySelectorAll('[data-goto]')) b.addEventListener('click', gotoCreated);

    $('#title').textContent = c.seed ? `From ${c.seed.id}` : c.workspace;
    $('#pulse').classList.toggle('busy', c.status === 'thinking');
    // The composer is deliberately untouched here. It stays live for the whole turn
    // — never disabled, placeholder unchanged, keyboard never dismissed — and what a
    // running turn changes is only where the words go: see `queue`.
    queue.sync(c.status === 'thinking');

    const count = c.draft?.beads?.length || 0;
    $('#draft-btn').hidden = !count;
    $('#draft-count').textContent = String(count);

    scrollDown(pin);
  }

  /**
   * Take a server chat session, keeping whatever is under the user's hands.
   *
   * The draft is the only contested field: it lives on the server so the agent can
   * see your edits, and on this screen so you can make them. A revision that lands
   * while the sheet has unsaved changes is parked rather than applied.
   */
  function adopt(c) {
    state.console = c;
    state.seq = c.seq;
    // Every update to the thread comes through here, so this is the one place that
    // knows both which chat session is open and what it has become — a title that changed
    // when the agent named it, a chat session that has since been closed.
    window.beadcause?.presence?.report({
      view: 'console',
      id: c.id,
      workspace: c.workspace || '',
      key: c.seed?.id ? `${c.workspace}/${c.seed.id}` : '',
      detail: c.title || '',
    });

    const incoming = JSON.stringify(c.draft || null);
    if (incoming === state.baseDraft) {
      // Nothing new from the server — our local copy (edited or not) still stands.
    } else if (state.draftDirty && sheetOpen()) {
      state.pendingRevision = c.draft;
    } else {
      state.draft = c.draft ? structuredClone(c.draft) : null;
      state.baseDraft = incoming;
      state.draftDirty = false;
      state.pendingRevision = null;
      if (sheetOpen()) renderSheet();
    }
    renderThread();
    if (sheetOpen()) renderRevisionBanner();
  }

  /**
   * Follow the conversation. One long poll at a time, restarted as soon as it
   * returns — the same feed the inbox lives on, scoped to this chat session, so a turn
   * that spends ninety seconds reading files is watched rather than waited on.
   */
  async function poll() {
    if (state.polling) return;
    state.polling = true;
    for (;;) {
      try {
        const c = await api(`/api/console/poll?id=${encodeURIComponent(state.id)}&since=${state.seq}&wait=25`);
        adopt(c);
      } catch (err) {
        if (err.message === 'token rejected') break;
        // Off the tailnet, or the daemon restarted. Back off rather than hammer.
        $('#pulse').classList.remove('busy');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
    state.polling = false;
  }

  /* ------------------------------------------------------------------ saying */

  /**
   * Send one turn's worth of words, whether one message or several queued ones.
   *
   * The optimistic bubble is the point of doing this here rather than in the queue:
   * the round trip is a process spawn, and a message that vanishes for a second
   * reads as having been eaten. If the send fails the bubble comes back out again —
   * the queue still holds the words, and showing them in the thread *and* above the
   * composer would read as having said the same thing twice.
   */
  async function deliver(text) {
    const msg = { role: 'user', text, at: new Date().toISOString() };
    state.console.messages.push(msg);
    state.console.status = 'thinking';
    renderThread();
    scrollDown(true);
    try {
      await api('/api/console/message', { method: 'POST', body: JSON.stringify({ id: state.id, text }) });
    } catch (err) {
      const i = state.console.messages.indexOf(msg);
      if (i >= 0) state.console.messages.splice(i, 1);
      state.console.status = 'idle';
      renderThread();
      throw err;
    }
  }

  /**
   * The queue is what lets the composer stay open: say something mid-turn and it
   * waits here, visibly, until the turn lands. Nothing here pushes past the server's
   * refusal — the 409 stands, and this is the side that waits.
   */
  const queue = window.beadcause.sendQueue.create({
    deliver,
    onError: (err, { willRetry }) => {
      if (err.message === 'token rejected') return; // the dialog is already up
      // A 409 is the console saying "not yet", which is exactly what the queue is
      // for; saying so in a red toast would be reporting the feature as a fault.
      if (err.status === 409 || willRetry) return;
      toast(`${err.message} — tap the message above the box to get it back`, true);
    },
  });
  // The pending strip above the composer: drawn by the queue, because it is the same
  // strip on the agents screen and two copies of it would drift.
  queue.attach({ el: '#queued', box: '#say', onRestore: autoGrow });

  function send(text) {
    if (!String(text || '').trim() || !state.console) return;
    $('#say').value = '';
    autoGrow($('#say'));
    queue.say(text);
  }

  /* ------------------------------------------------------------------ sheet */

  const sheetOpen = () => $('#sheet').classList.contains('open');

  /**
   * Walk to what a filed proposal became. The ids are already on the screen, in the
   * “✓ Created” note below the reply, so this is a scroll and a flash rather than a
   * screen of its own — and from there each pill opens the bead.
   */
  function gotoCreated(e) {
    const note = $(`#thread .created-note[data-msg="${e.currentTarget.dataset.goto}"]`);
    if (!note) return;
    note.scrollIntoView({ behavior: 'smooth', block: 'center' });
    note.classList.remove('flash');
    void note.offsetWidth; // restart the animation if it is already running
    note.classList.add('flash');
  }

  function openSheet() {
    if (!liveDraft()) {
      // Reachable only if the draft went away between the repaint that drew the
      // button and the tap. Saying nothing is the bug this screen used to have.
      toast('Nothing to review — that proposal has been filed or replaced.');
      return;
    }
    $('#sheet').hidden = false;
    requestAnimationFrame(() => $('#sheet').classList.add('open'));
    renderSheet();
  }

  function closeSheet() {
    $('#sheet').classList.remove('open');
    disarm();
    // After the slide-down, not before, or it would vanish rather than leave.
    setTimeout(() => {
      if (!sheetOpen()) $('#sheet').hidden = true;
    }, 220);
    // Anything typed and not yet flushed goes now, so the next turn sees it.
    if (state.draftDirty) saveDraft(true);
  }

  const priorityLabel = (p) => ['critical', 'high', 'medium', 'low', 'backlog'][p] ?? 'medium';

  /** One bead: a summary row you tap to open, and the fields underneath it. */
  function beadHtml(b, i, all) {
    const isOpen = state.open.has(b.ref);
    const others = all.filter((x) => x.ref !== b.ref);
    const externals = b.dependsOn.filter((d) => !all.some((x) => x.ref === d));

    const summary = `<button class="bead-head" data-toggle="${esc(b.ref)}" aria-expanded="${isOpen}">
      <span class="bead-title">${esc(b.title || 'Untitled bead')}</span>
      <span class="meta">
        <span class="pill p${b.priority}">P${b.priority}</span>
        <span class="pill">${esc(b.type)}</span>
        ${b.parent ? `<span class="pill">under ${esc(b.parent)}</span>` : ''}
        ${b.dependsOn.length ? `<span class="pill">after ${esc(b.dependsOn.join(', '))}</span>` : ''}
        ${b.labels.map((l) => `<span class="pill">${esc(l)}</span>`).join('')}
      </span>
    </button>`;

    if (!isOpen) return `<div class="bead card">${summary}</div>`;

    const chips = (name, values, current, labelFor) =>
      values
        .map(
          (v) =>
            `<button class="chip" data-set="${name}" data-ref="${esc(b.ref)}" data-value="${esc(v)}"
              aria-pressed="${String(v) === String(current)}">${esc(labelFor ? labelFor(v) : v)}</button>`
        )
        .join('');

    const depChips = others
      .map(
        (o) =>
          `<button class="chip" data-dep="${esc(o.ref)}" data-ref="${esc(b.ref)}"
            aria-pressed="${b.dependsOn.includes(o.ref)}"
            ${b.parent === o.ref ? 'disabled title="already implied by the parent"' : ''}>${esc(o.title || o.ref)}</button>`
      )
      .join('');

    const parentChips =
      `<button class="chip" data-set="parent" data-ref="${esc(b.ref)}" data-value="" aria-pressed="${!b.parent}">none</button>` +
      others
        .map(
          (o) =>
            `<button class="chip" data-set="parent" data-ref="${esc(b.ref)}" data-value="${esc(o.ref)}"
              aria-pressed="${b.parent === o.ref}">${esc(o.title || o.ref)}</button>`
        )
        .join('');

    return `<div class="bead card open">
      ${summary}
      <div class="bead-body">
        <label class="field">
          <span>Title</span>
          <textarea rows="1" data-field="title" data-ref="${esc(b.ref)}">${esc(b.title)}</textarea>
        </label>

        <div class="field">
          <span>Type</span>
          <div class="chip-row">${chips('type', TYPES, b.type)}</div>
        </div>

        <div class="field">
          <span>Priority</span>
          <div class="chip-row">${chips('priority', PRIORITIES, b.priority, (p) => `P${p} ${priorityLabel(p)}`)}</div>
        </div>

        <label class="field">
          <span>Description</span>
          <textarea rows="3" data-field="description" data-ref="${esc(b.ref)}"
            placeholder="Why this exists and what needs doing.">${esc(b.description)}</textarea>
        </label>

        <label class="field">
          <span>Acceptance</span>
          <textarea rows="2" data-field="acceptance" data-ref="${esc(b.ref)}"
            placeholder="How we know it is done.">${esc(b.acceptance)}</textarea>
        </label>

        ${
          b.design || b.notes
            ? `<label class="field"><span>Design</span>
                 <textarea rows="2" data-field="design" data-ref="${esc(b.ref)}">${esc(b.design)}</textarea></label>
               <label class="field"><span>Notes</span>
                 <textarea rows="2" data-field="notes" data-ref="${esc(b.ref)}">${esc(b.notes)}</textarea></label>`
            : ''
        }

        <label class="field">
          <span>Labels</span>
          <input type="text" data-field="labels" data-ref="${esc(b.ref)}" value="${esc(b.labels.join(', '))}"
            placeholder="comma, separated" autocapitalize="none" autocorrect="off">
        </label>

        ${
          others.length
            ? `<div class="field"><span>Parent</span><div class="chip-row">${parentChips}</div></div>
               <div class="field"><span>Blocked by</span><div class="chip-row">${depChips}</div></div>`
            : ''
        }

        ${
          externals.length
            ? `<div class="field"><span>Also waits on</span><div class="chip-row">${externals
                .map(
                  (d) =>
                    `<button class="chip" data-dep="${esc(d)}" data-ref="${esc(b.ref)}" aria-pressed="true">${esc(d)}</button>`
                )
                .join('')}</div></div>`
            : ''
        }

        <button class="danger-btn" data-remove="${esc(b.ref)}">Remove this bead</button>
      </div>
    </div>`;
  }

  function renderSheet() {
    const beads = state.draft?.beads || [];
    if (!beads.length) return closeSheet();

    $('#sheet-title').textContent = `${beads.length} bead${beads.length === 1 ? '' : 's'} to create`;
    const warnings = (state.draft.warnings || []).length
      ? `<div class="warnings sheet-warn">${state.draft.warnings.map((w) => `<span>${esc(w)}</span>`).join('')}</div>`
      : '';
    $('#sheet-body').innerHTML =
      `<p class="lede">In <strong>${esc(state.console.workspace)}</strong>. Tap a bead to change anything about it — this is what will be created.</p>` +
      warnings +
      `<div id="revision-slot"></div>` +
      beads.map((b, i) => beadHtml(b, i, beads)).join('');

    for (const t of $('#sheet-body').querySelectorAll('textarea')) autoGrow(t);
    wireSheet();
    renderRevisionBanner();
    updateCreateButton();
  }

  /** A revision that arrived while you were editing. Offered, never imposed. */
  function renderRevisionBanner() {
    const slot = $('#revision-slot');
    if (!slot) return;
    if (!state.pendingRevision) return (slot.innerHTML = '');
    slot.innerHTML = `<div class="revision">
      <span>The agent revised this proposal while you were editing.</span>
      <button class="secondary" id="take-revision">Use its version</button>
    </div>`;
    $('#take-revision').addEventListener('click', () => {
      state.draft = structuredClone(state.pendingRevision);
      state.baseDraft = JSON.stringify(state.pendingRevision);
      state.pendingRevision = null;
      state.draftDirty = false;
      renderSheet();
    });
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 340)}px`;
  }

  const beadFor = (ref) => (state.draft?.beads || []).find((b) => b.ref === ref);

  function wireSheet() {
    const body = $('#sheet-body');

    for (const b of body.querySelectorAll('[data-toggle]')) {
      b.addEventListener('click', () => {
        const ref = b.dataset.toggle;
        state.open.has(ref) ? state.open.delete(ref) : state.open.add(ref);
        renderSheet();
      });
    }

    // Typing never re-renders: the field you are in must survive its own keystrokes.
    for (const el of body.querySelectorAll('[data-field]')) {
      el.addEventListener('input', () => {
        const bead = beadFor(el.dataset.ref);
        if (!bead) return;
        const field = el.dataset.field;
        bead[field] =
          field === 'labels'
            ? el.value.split(',').map((s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-')).filter(Boolean)
            : el.value;
        if (el.tagName === 'TEXTAREA') autoGrow(el);
        markDirty();
      });
    }

    for (const el of body.querySelectorAll('[data-set]')) {
      el.addEventListener('click', () => {
        const bead = beadFor(el.dataset.ref);
        if (!bead) return;
        const what = el.dataset.set;
        const value = el.dataset.value;
        if (what === 'priority') bead.priority = Number(value);
        else if (what === 'parent') {
          bead.parent = value || null;
          // bd refuses an explicit dependency on your own parent — the hierarchy
          // already carries it — so choosing a parent retires that edge here too.
          if (bead.parent) bead.dependsOn = bead.dependsOn.filter((d) => d !== bead.parent);
        } else bead[what] = value;
        markDirty();
        renderSheet();
      });
    }

    for (const el of body.querySelectorAll('[data-dep]')) {
      el.addEventListener('click', () => {
        const bead = beadFor(el.dataset.ref);
        if (!bead) return;
        const dep = el.dataset.dep;
        bead.dependsOn = bead.dependsOn.includes(dep)
          ? bead.dependsOn.filter((d) => d !== dep)
          : [...bead.dependsOn, dep];
        markDirty();
        renderSheet();
      });
    }

    for (const el of body.querySelectorAll('[data-remove]')) {
      el.addEventListener('click', () => {
        const ref = el.dataset.remove;
        state.draft.beads = state.draft.beads.filter((b) => b.ref !== ref);
        // Nothing may point at a bead that is no longer being created.
        for (const b of state.draft.beads) {
          b.dependsOn = b.dependsOn.filter((d) => d !== ref);
          if (b.parent === ref) b.parent = null;
        }
        state.open.delete(ref);
        markDirty();
        state.draft.beads.length ? renderSheet() : closeSheet();
        renderThread();
      });
    }
  }

  function markDirty() {
    state.draftDirty = true;
    disarm();
    updateCreateButton();
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(() => saveDraft(), 700);
  }

  /**
   * Push the edited cards back. Not just persistence — it is how the agent gets to
   * see what you changed, so the next turn argues with the proposal on your screen
   * rather than the one it last wrote.
   */
  async function saveDraft(immediate) {
    clearTimeout(state.saveTimer);
    if (!state.draftDirty) return;
    const payload = state.draft ? { beads: state.draft.beads } : null;
    try {
      const out = await api('/api/console/draft', {
        method: 'POST',
        body: JSON.stringify({ id: state.id, draft: payload }),
      });
      state.draftDirty = false;
      // Adopt the server's normalisation (dropped edges, cleaned labels) so what is
      // on screen is what would be created — but not while a field has focus.
      state.baseDraft = JSON.stringify(out.draft || null);
      if (out.draft && !document.activeElement?.matches?.('#sheet-body textarea, #sheet-body input')) {
        state.draft = structuredClone(out.draft);
        if (sheetOpen()) renderSheet();
      }
      updateCreateButton();
    } catch (err) {
      if (err.message !== 'token rejected') toast(`could not save: ${err.message}`, true);
      if (immediate) state.draftDirty = true;
    }
  }

  /* ----------------------------------------------------------------- create */

  function updateCreateButton() {
    const n = state.draft?.beads?.length || 0;
    const btn = $('#create');
    btn.disabled = !n || state.creating;
    btn.textContent = state.creating
      ? 'Creating…'
      : state.armed
        ? `Tap again to create ${n}`
        : `Create ${n} bead${n === 1 ? '' : 's'}`;
    btn.classList.toggle('armed', state.armed);
  }

  function disarm() {
    clearTimeout(state.armedTimer);
    if (!state.armed) return;
    state.armed = false;
    updateCreateButton();
  }

  /**
   * Two taps, like answering a question. The first tap says what is about to
   * happen; the second does it. Creating six beads in someone's tracker off a
   * pocket tap is not undoable in any way that matters.
   */
  async function createBeads() {
    if (!state.draft?.beads?.length || state.creating) return;
    if (!state.armed) {
      state.armed = true;
      updateCreateButton();
      state.armedTimer = setTimeout(disarm, ARM_MS);
      return;
    }
    disarm();
    if (state.draftDirty) await saveDraft(true);

    state.creating = true;
    updateCreateButton();
    try {
      const out = await api('/api/console/create', {
        method: 'POST',
        body: JSON.stringify({ id: state.id, draft: { beads: state.draft.beads }, close: true }),
      });
      state.draft = null;
      state.baseDraft = 'null';
      state.draftDirty = false;
      toast(`created ${out.created.length} bead${out.created.length === 1 ? '' : 's'}`);
      closeSheet();
      for (const w of out.warnings || []) toast(w, true);
      // Accepting ends the conversation: the beads exist and the chat session that argued
      // them into shape is done, so it closes itself and drops you back to the list.
      // Unless there were warnings — those have to be read on the screen that
      // produced them, and this leaves you there to read them.
      if (out.closed) {
        history.replaceState(null, '', '/console');
        state.id = '';
        state.console = null;
        state.seq = 0;
        showLauncher();
      }
    } catch (err) {
      if (err.message !== 'token rejected') toast(err.message, true);
    } finally {
      state.creating = false;
      updateCreateButton();
    }
  }

  /* ------------------------------------------------------------------ start */

  function addBead() {
    if (!state.draft) state.draft = { beads: [], warnings: [] };
    let ref = `bead-${state.draft.beads.length + 1}`;
    while (state.draft.beads.some((b) => b.ref === ref)) ref += '-x';
    state.draft.beads.push({
      ref,
      title: '',
      type: 'task',
      priority: 2,
      description: '',
      acceptance: '',
      design: '',
      notes: '',
      labels: [],
      parent: null,
      dependsOn: [],
    });
    state.open.add(ref);
    markDirty();
    renderSheet();
    renderThread();
  }

  async function showThread() {
    $('#launcher').hidden = true;
    $('#thread').hidden = false;
    $('#composer').hidden = false;
    document.body.classList.remove('launching');
    try {
      adopt(await api(`/api/console?id=${encodeURIComponent(state.id)}`));
    } catch (err) {
      if (err.message === 'token rejected') return;
      $('#thread').innerHTML = `<div class="empty"><strong>Not found</strong>${esc(err.message)}. <a href="/console">Start a new one</a>.</div>`;
      $('#composer').hidden = true;
      return;
    }
    poll();
  }

  /**
   * Three ways in, and they all end at a chat session id in the URL.
   *
   * `?ws=&seed=` is the one a card links to: it opens a chat session on that bead and
   * replaces itself with the real one, so a link on a bead card needs no JS of its
   * own and no POST from the page it sits on.
   */
  function start() {
    if (state.id) return showThread();
    const params = new URLSearchParams(location.search);
    if (params.get('ws')) return open(params.get('ws'), params.get('seed'));
    showLauncher();
  }

  /**
   * The launcher's controls, wired once.
   *
   * Delegated rather than re-bound on every paint: the tab bar and the list are
   * rebuilt whenever a tab changes or a conversation closes, and listeners hung on
   * the buttons themselves would have to be hung again each time.
   */
  function wireLauncher() {
    $('#ws-row').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-ws]');
      if (btn) setRepo(btn.dataset.ws);
    });

    /* The picker moved — from this row, from the dropdown above it, or from the phone in
       your pocket. All three end here, so the row and the list agree however it happened.
       Only while the launcher is up: repainting it behind an open conversation would
       rebuild a screen nobody is looking at. */
    window.beadcause?.space?.onChange(() => {
      if ($('#launcher').hidden) return;
      // A stray tab is a filter of this page's own, and the app moving out from under it
      // is exactly when it stops being what you are looking at.
      state.stray = '';
      hidePicker();
      renderRepoTabs();
      renderRecent();
    });

    // A tab bar answers to the arrow keys, and only one of its tabs is in the tab
    // order — otherwise five repos are five stops on the way to the list.
    $('#ws-row').addEventListener('keydown', (ev) => {
      const step = ev.key === 'ArrowRight' ? 1 : ev.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      ev.preventDefault();
      const tabs = [...$('#ws-row').querySelectorAll('[data-ws]')];
      const at = tabs.findIndex((t) => t.dataset.ws === (state.stray || repoNow()));
      const next = tabs[(at + step + tabs.length) % tabs.length];
      if (!next) return;
      setRepo(next.dataset.ws);
      $(`#ws-row [data-ws="${CSS.escape(next.dataset.ws)}"]`)?.focus();
    });

    $('#ws-new').addEventListener('click', () => {
      // One repo in scope is a repo to start in, whichever of the two said so — the tab
      // row, or the picker in the bar. A stray is not: it has no `.beads` the daemon
      // serves, so there is nowhere to start.
      const now = repoNow();
      if (now !== 'all' && !state.stray) return open(now);
      pickerOpen() ? hidePicker() : showPicker();
    });

    $('#ws-pick-row').addEventListener('click', (ev) => {
      const btn = ev.target.closest('[data-ws]');
      if (btn) open(btn.dataset.ws);
    });

    // Escape closes the picker without starting anything, the same way it closes
    // the agent chooser on the inbox.
    $('#launcher').addEventListener('keydown', (ev) => {
      if (ev.key !== 'Escape' || !pickerOpen()) return;
      hidePicker();
      $('#ws-new').focus();
    });
  }

  function wire() {
    wireLauncher();
    // Dictating the next bead. The status line goes above the composer rather than
    // under the box — this composer is a flex row pinned to the bottom of the screen,
    // and a paragraph dropped into it would stand up as a third column — so it lands
    // on the strip that already carries transient news about what you are saying.
    window.beadcause?.dictation?.attach($('#say'), { note: '#queued', label: 'Dictate this' });
    $('#composer').addEventListener('submit', (e) => {
      e.preventDefault();
      send($('#say').value);
    });
    $('#say').addEventListener('input', () => autoGrow($('#say')));
    $('#say').addEventListener('keydown', (e) => {
      // The keyboard says "send", so Enter sends. A newline is shift+Enter, which
      // is what anyone writing more than a line already reaches for.
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send($('#say').value);
      }
    });
    $('#draft-btn').addEventListener('click', openSheet);
    $('#sheet-close').addEventListener('click', closeSheet);
    $('#sheet-add').addEventListener('click', addBead);
    $('#create').addEventListener('click', createBeads);
    $('#discuss').addEventListener('click', () => {
      closeSheet();
      $('#say').focus();
    });
    // A half-written edit must not die with the tab.
    addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && state.draftDirty) saveDraft(true);
    });
  }

  bootToken();
  wire();
  if (state.token) start();
})();
