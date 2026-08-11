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

  /** How often the conversations you are *not* looking at say what they are doing. */
  const STATUS_MS = 15000;

  /**
   * Whether the dismissed conversations are being shown — and where that answer lives.
   *
   * `sessionStorage`, not `localStorage`, and that is the whole design. Closing a row
   * is how you say you are done with it, so the list has to open on the live ones or
   * the ✕ buys you nothing; a preference remembered forever would quietly undo the
   * default for good, one tap a month ago. A tab is the right lifetime: a reload — the
   * launcher's own, or one of the chats it opened — must not re-hide the list you were
   * reading, and opening the app tomorrow starts clean again.
   *
   * It used to be a *navigation* that made this matter, because opening a conversation
   * was one. It is a repaint now (see `switchTo`), so within a visit the toggle would
   * survive in a plain variable. Storage is still what carries it across a reload, and
   * a reload of `/console?id=…` is still how a phone comes back to this screen.
   *
   * Unlike the repo tab above, this is nobody else's filter — it is a view of one list
   * on one screen, it decides nothing about what notifies you, so there is no reason
   * for the server to own it.
   */
  const SHOW_DISMISSED_KEY = 'beadcause.console.dismissed';
  const readShowDismissed = () => {
    try {
      return sessionStorage.getItem(SHOW_DISMISSED_KEY) === '1';
    } catch {
      // Private mode, or a WebView with storage denied. Not a reason to fail to draw.
      return false;
    }
  };

  const state = {
    token: '',
    /**
     * Which conversation is in front, or `''` for the launcher.
     *
     * Not "the chat session this page is about" any more. This page holds several at
     * once — see `chats` below — and this names the one the thread, the composer and
     * the sheet are currently acting on. Everything else is still loaded, in memory,
     * exactly as it was left.
     */
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
    showDismissed: readShowDismissed(),
    /**
     * Every conversation opened this visit, keyed by id — see `chatFor`.
     *
     * This is the whole change: the transcript, the sequence number, the draft, which
     * cards are expanded, where the thread was scrolled and what is half-typed in the
     * composer all used to be one set of fields on `state`, describing the id in
     * `?id=`. Opening another chat was a page load that threw all of it away.
     */
    chats: new Map(),
    armed: false,
    armedTimer: null,
    creating: false,
  };

  /**
   * The state of one conversation, made on first sight and then kept.
   *
   * Nothing is ever evicted. A transcript is a few kilobytes of JSON and the entire
   * promise of holding several open is that going back to one is free — an eviction
   * policy would make it free *sometimes*, which is worse than not offering it.
   */
  function chatFor(id) {
    const held = state.chats.get(id);
    if (held) return held;
    const chat = {
      id,
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
      saveTimer: null,
      /** Where this thread was left, or null for one that has never been drawn. */
      scrollTop: null,
      /** What was typed into the composer and not said. */
      say: '',
      queue: makeQueue(id),
    };
    state.chats.set(id, chat);
    return chat;
  }

  /** The conversation in front: what the thread, the composer and the sheet act on. */
  const cur = () => state.chats.get(state.id) || null;

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
    // The bar belonged to whichever conversation was in front. Arriving here used to be
    // a page load, which cleared it; a switch has to say so itself, or the list sits
    // under another chat's title with its proposal count still offering to open.
    $('#title').textContent = 'Chat session';
    $('#pulse').classList.remove('busy');
    $('#draft-btn').hidden = true;

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

  /** Closed is dismissed: still there, still openable, out of the way until asked for. */
  const isDismissed = (c) => Boolean(c.closedAt);

  /** Whether a row is drawn at all, which is the one thing the toggle changes. */
  const shown = (c) => state.showDismissed || !isDismissed(c);

  /**
   * The tab bar: All, then one per repo in the selected space, each carrying how many
   * conversations it holds.
   *
   * A count is drawn only where there is one. Every repo gets a tab whether or
   * not it has ever been talked to — the bar is also how you reach a repo to
   * start in — and a row of zeroes would report emptiness rather than offering a
   * place to begin.
   *
   * It counts what the list would *show*, dismissed ones included only while they are
   * being shown. A tab reading 3 over a list of nothing is the same broken screen the
   * empty state below is written to avoid, one line higher up.
   *
   * `All` means all of the *selected space*, not all of the Mac. With one repo picked
   * this row is a single tab and says the same thing twice, which is the honest picture:
   * there is one repo in scope and you are in it.
   */
  function renderRepoTabs() {
    const row = $('#ws-row');
    const now = state.stray || repoNow();
    const count = (ws) => state.consoles.filter((c) => c.workspace === ws && shown(c)).length;
    const tab = (id, label, n) => {
      const on = now === id;
      return `<button class="chip" role="tab" id="ws-tab-${esc(id)}" data-ws="${esc(id)}"
        aria-selected="${on}" tabindex="${on ? 0 : -1}">${esc(label)}${n ? ` ${n}` : ''}</button>`;
    };
    row.innerHTML =
      // All counts the space, not whatever a stray tab has narrowed the list to — it is
      // the tab that would take you back out to it.
      tab('all', 'All', state.consoles.filter((c) => inSpace(c.workspace) && shown(c)).length) +
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
   * Live ones first, dismissed ones under them — and by default no dismissed ones at
   * all. Closing a row is the ✕ beside it and it means "I have dealt with this": the
   * transcript stays, the id keeps working, saying anything to it brings it back, and
   * until then it is out of the way. They used to sort to the bottom instead, which
   * kept the list in the right order and let it grow forever.
   *
   * An empty list is where this can go wrong, so the emptiness says which kind it is:
   * nothing here yet, or nothing left that you have not already finished with.
   */
  function renderRecent() {
    const rows = state.consoles.filter(inRepo);
    const live = rows.filter((c) => !isDismissed(c));
    const dismissed = rows.filter(isDismissed);
    const listed = state.showDismissed ? [...live, ...dismissed] : live;
    $('#recent-label').hidden = !listed.length;
    const now = state.stray || repoNow();
    const where = now === 'all' ? window.beadcause?.space?.label?.() || 'here' : now;
    const nothingYet = `<strong>${
      state.consoles.length ? `Nothing in ${esc(where)} yet` : 'No conversations yet'
    }</strong>＋ starts one${now === 'all' ? '' : ` in ${esc(now)}`}.`;
    // Everything here has been dismissed. Not the same screen as an empty one, and
    // saying "nothing yet" over ten conversations you had would read as data loss.
    // `where` is the picker's word for the selection and it is "everything" on All,
    // which reads as nonsense in this sentence where it is fine in the one above.
    const allDismissed = `<strong>${now === 'all' ? 'Nothing still open' : `Nothing open in ${esc(now)}`}</strong>${
      dismissed.length === 1 ? 'One conversation is' : `${dismissed.length} conversations are`
    } dismissed — <em>Dismissed</em> above shows them. ＋ starts a new one${
      now === 'all' ? '' : ` in ${esc(now)}`
    }.`;
    $('#recent').innerHTML = listed.length
      ? listed.map(consoleRowHtml).join('')
      : `<div class="empty">${dismissed.length ? allDismissed : nothingYet}</div>`;

    renderDismissToggle(dismissed.length);

    for (const btn of $('#recent').querySelectorAll('[data-close]')) {
      btn.addEventListener('click', (ev) => {
        // The row is a link. Closing it must not also open it.
        ev.preventDefault();
        ev.stopPropagation();
        closeConsole(btn.dataset.close, btn);
      });
    }
  }

  /**
   * The toggle beside the tabs, and the count that makes the filtered list obvious.
   *
   * Drawn from the same numbers the list was just drawn from — how many dismissed
   * conversations are under the selected tab, whether or not they are being shown —
   * so the two can never disagree about what is being hidden. With none under this
   * tab there is nothing to reveal and the button goes away entirely; the state
   * stays, because switching to a repo that has some should show them if that is what
   * you asked for a moment ago.
   */
  function renderDismissToggle(n) {
    const btn = $('#ws-dismissed');
    btn.hidden = !n;
    btn.setAttribute('aria-pressed', String(state.showDismissed));
    btn.innerHTML = `Dismissed <span class="chip-count">${n}</span>`;
    btn.setAttribute(
      'aria-label',
      `${state.showDismissed ? 'Hide' : 'Show'} ${n} dismissed conversation${n === 1 ? '' : 's'}`
    );
  }

  /** Show them or put them away, and remember it for as long as this tab is open. */
  function setShowDismissed(on) {
    state.showDismissed = on;
    try {
      sessionStorage.setItem(SHOW_DISMISSED_KEY, on ? '1' : '0');
    } catch {
      // Storage denied. The toggle still works; it just forgets on the next page.
    }
    // The tabs too: their counts are of the rows that would be listed.
    renderRepoTabs();
    renderRecent();
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
    const done = isDismissed(c);
    const agent = chatAgent(c);
    // Two marks, because the one that is loudest is also the one that gets taken
    // over: the phase slot says 💬 for a chat session and the agent's own emoji for
    // an agent chat, but a running turn draws a spark there and a finished one a
    // tick — so the pill beside the repo is what holds when the slot is busy.
    const phase = c.status === 'thinking' ? '<span class="spark"></span>' : done ? '✓' : agent ? esc(agent.emoji) : '💬';
    // Still a real link to the real address — it can be copied, opened in a new tab,
    // and read by anything that reads links — but a plain tap on it is caught in
    // `wireLauncher` and answered with a repaint. The href is what a reload lands on;
    // `data-id` is what the tap switches to.
    return `<div class="console-row${done ? ' closed' : ''}${agent ? ' agent-chat' : ''}">
      <a class="work-row" data-id="${esc(c.id)}" href="/console?id=${encodeURIComponent(c.id)}">
        <span class="work-phase">${phase}</span>
        <span class="work-main">
          <span class="work-title">${esc(c.title || 'Untitled')}</span>
          <span class="work-sub"><span class="pill">${esc(c.workspace)}</span>${
            agent ? `<span class="pill agent">${esc(agent.emoji)} ${esc(agent.name)}</span>` : ''
          }${done ? '<span class="pill">dismissed</span>' : ''}${
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
          : // "Dismiss", not "close", because that is what a tap here does now: it
            // leaves the list rather than the app, and the toggle it leaves under says
            // the same word back.
            `<button class="row-x" data-close="${esc(c.id)}" aria-label="${
              agent ? `Dismiss this chat with the ${esc(agent.name)}` : 'Dismiss this chat session'
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
      // What we hold for it is now a transcript missing its own closing line, so it is
      // dropped rather than kept: the row still opens, and opening it fetches.
      state.chats.delete(id);
      showLauncher();
    } catch (err) {
      if (btn) btn.disabled = false;
      if (err.message !== 'token rejected') toast(err.message, true);
    }
  }

  /**
   * Open a chat session: on a workspace, or on a workspace seeded with one bead.
   *
   * `replace` for the `?ws=&seed=` way in, which is a URL that *creates* something:
   * pushing over it would leave a back gesture pointing at an address that starts
   * another conversation every time it is visited.
   */
  async function open(workspace, seed, { replace = false } = {}) {
    try {
      const made = await api('/api/console', {
        method: 'POST',
        body: JSON.stringify({ workspace, seed: seed || undefined }),
      });
      // The POST hands the conversation back with the id, so a new chat is on screen
      // without a second request for something we were just given.
      if (made.console) adopt(made.console);
      switchTo(made.id, { replace });
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
  const liveDraft = () => (cur()?.draft?.beads?.length || 0) > 0;

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
            `<a class="created-row" href="${esc(beadUrl(cur().console.workspace, x.id))}" target="_blank" rel="noopener">
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
    const chat = cur();
    if (!chat?.console) return;
    const c = chat.console;
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
    // running turn changes is only where the words go: see `makeQueue`.
    chat.queue.sync(c.status === 'thinking');

    const count = c.draft?.beads?.length || 0;
    $('#draft-btn').hidden = !count;
    $('#draft-count').textContent = String(count);

    scrollDown(pin);
  }

  /**
   * Where the app says you are. Only ever the conversation in front — a chat held in
   * the background is loaded, not looked at, and reporting it would put this phone in
   * two places at once.
   */
  const reportPresence = (c) =>
    window.beadcause?.presence?.report({
      view: 'console',
      id: c.id,
      workspace: c.workspace || '',
      key: c.seed?.id ? `${c.workspace}/${c.seed.id}` : '',
      detail: c.title || '',
    });

  /**
   * Take a server chat session, keeping whatever is under the user's hands.
   *
   * Keyed by the id in the payload rather than by whatever is in front: a response can
   * outlive the switch that asked for it, and the one thing it must not do is write one
   * conversation's transcript over another's. Only the foreground one repaints.
   *
   * The draft is the only contested field: it lives on the server so the agent can
   * see your edits, and on this screen so you can make them. A revision that lands
   * while the sheet has unsaved changes is parked rather than applied.
   */
  function adopt(c) {
    const chat = chatFor(c.id);
    const front = c.id === state.id;
    chat.console = c;
    chat.seq = c.seq;
    // Every update to the thread comes through here, so this is the one place that
    // knows both which chat session is open and what it has become — a title that changed
    // when the agent named it, a chat session that has since been closed.
    if (front) reportPresence(c);

    const incoming = JSON.stringify(c.draft || null);
    if (incoming === chat.baseDraft) {
      // Nothing new from the server — our local copy (edited or not) still stands.
    } else if (chat.draftDirty && (!front || sheetOpen())) {
      chat.pendingRevision = c.draft;
    } else {
      chat.draft = c.draft ? structuredClone(c.draft) : null;
      chat.baseDraft = incoming;
      chat.draftDirty = false;
      chat.pendingRevision = null;
      if (front && sheetOpen()) renderSheet();
    }
    if (!front) return;
    renderThread();
    if (sheetOpen()) renderRevisionBanner();
  }

  /* ------------------------------------------------------------- following */

  /** Which poll loop is the live one. Switching retires the old one by bumping it. */
  let pollRun = 0;
  /** The long poll currently parked on the server, so a switch can cut it short. */
  let inFlight = null;

  /**
   * Point the transcript poll at whatever is in front.
   *
   * One long poll for the page, never one per open chat. A conversation you are not
   * looking at does not need its transcript streamed, and a parked 25-second request
   * per open tab is how a phone's connection budget goes; what the others need is
   * their *status*, and `watchBackground` gets that for all of them in one request.
   *
   * The old poll is aborted rather than left to expire. It is parked on the server for
   * up to twenty-five seconds, and a chat brought forward inside that window would
   * otherwise sit unwatched for the rest of it — which is precisely the case this whole
   * change exists to make instant.
   */
  function repoll() {
    stopPolling();
    if (state.id) poll(pollRun);
  }

  /**
   * Retire the live loop without starting another.
   *
   * Bumping the run is what the loop itself checks, so it stops at its next turn rather
   * than being left to notice; the abort is what stops it *waiting* twenty-five seconds
   * first. Its own place is the conversation that would not load — there is nothing to
   * follow, and a loop reading `state.id` would spend the rest of the visit taking a
   * 404 every five seconds.
   */
  function stopPolling() {
    pollRun += 1;
    const stale = inFlight;
    inFlight = null;
    stale?.abort();
  }

  /**
   * Follow the conversation in front. One long poll at a time, restarted as soon as it
   * returns — the same feed the inbox lives on, scoped to this chat session, so a turn
   * that spends ninety seconds reading files is watched rather than waited on.
   */
  async function poll(run) {
    while (run === pollRun && state.id) {
      const id = state.id;
      const chat = chatFor(id);
      try {
        inFlight = new AbortController();
        const c = await api(`/api/console/poll?id=${encodeURIComponent(id)}&since=${chat.seq}&wait=25`, {
          signal: inFlight.signal,
        });
        if (run !== pollRun) return;
        adopt(c);
      } catch (err) {
        // A switch cut it off, and the conversation now in front has a loop of its own.
        if (run !== pollRun) return;
        if (err.message === 'token rejected') return;
        // Off the tailnet, or the daemon restarted. Back off rather than hammer.
        $('#pulse').classList.remove('busy');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  /** The background status feed, when there is anything in the background. */
  let statusTimer = null;

  /**
   * What the conversations you are not looking at are doing.
   *
   * `/api/consoles` already carries every conversation's status — it is where the
   * launcher list gets its spark — so all of the background costs one request every
   * fifteen seconds instead of a long poll each. Their transcripts go stale, and that
   * is the trade: bringing one forward starts its own poll, which returns everything
   * said since its sequence number in a single response.
   *
   * It is not decoration. A background chat's turn *ending* is what releases anything
   * left queued above its composer, and nothing else on this page would notice.
   */
  function watchBackground() {
    clearTimeout(statusTimer);
    // Nothing in front means the launcher, which fetches this list for itself; one chat
    // open means there is no background to ask about.
    if (!state.id || state.chats.size < 2) return;

    const tick = async () => {
      clearTimeout(statusTimer);
      if (!state.id || state.chats.size < 2) return;
      try {
        const data = await api('/api/consoles');
        window.beadcause?.warm?.write?.('/api/consoles', data);
        state.workspaces = data.workspaces || [];
        state.consoles = data.consoles || [];
        for (const row of state.consoles) {
          const chat = state.chats.get(row.id);
          // The one in front has a poll of its own, and that is the newer word.
          if (!chat?.console || row.id === state.id) continue;
          chat.console.status = row.status;
          chat.console.title = row.title || chat.console.title;
          chat.console.closedAt = row.closedAt;
          chat.queue.sync(row.status === 'thinking');
        }
      } catch {
        /* Nothing on screen depends on this; the next tick tries again. */
      }
      if (state.id && state.chats.size > 1) statusTimer = setTimeout(tick, STATUS_MS);
    };
    tick();
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
  async function deliver(id, text) {
    const chat = chatFor(id);
    const msg = { role: 'user', text, at: new Date().toISOString() };
    chat.console.messages.push(msg);
    chat.console.status = 'thinking';
    if (id === state.id) {
      renderThread();
      scrollDown(true);
    }
    try {
      await api('/api/console/message', { method: 'POST', body: JSON.stringify({ id, text }) });
    } catch (err) {
      const i = chat.console.messages.indexOf(msg);
      if (i >= 0) chat.console.messages.splice(i, 1);
      chat.console.status = 'idle';
      if (id === state.id) renderThread();
      throw err;
    }
  }

  /** An id as it can appear inside a quoted attribute selector. */
  const cssValue = (s) => String(s).replace(/["\\]/g, '\\$&');

  /**
   * One send queue per conversation, not one per page.
   *
   * The queue is what lets the composer stay open: say something mid-turn and it waits
   * there, visibly, until the turn lands. Nothing here pushes past the server's refusal
   * — the 409 stands, and this is the side that waits.
   *
   * Which is exactly why it cannot be shared once this page holds more than one chat. A
   * queued message belongs to the conversation it was said to, and a single queue would
   * deliver those words into whichever chat happened to be in front when the turn
   * landed — quietly, into a stranger's thread. That is worse than losing them.
   *
   * The strip above the composer is still drawn by the queue itself, because it is the
   * same strip the agents screen has and two hand-written copies would drift. Every
   * chat's queue attaches to that one element through a selector carrying its own id,
   * which only matches while `#queued` is stamped with it — so a background queue
   * moving repaints nothing, and bringing a chat forward is `repaint()` on its queue.
   */
  function makeQueue(id) {
    const q = window.beadcause.sendQueue.create({
      deliver: (text) => deliver(id, text),
      onError: (err, { willRetry }) => {
        if (err.message === 'token rejected') return; // the dialog is already up
        // A 409 is the console saying "not yet", which is exactly what the queue is
        // for; saying so in a red toast would be reporting the feature as a fault.
        if (err.status === 409 || willRetry) return;
        // A toast points at the strip above the composer, and that strip is showing
        // some other conversation's words right now.
        if (id !== state.id) return;
        toast(`${err.message} — tap the message above the box to get it back`, true);
      },
    });
    q.attach({ el: `#queued[data-chat="${cssValue(id)}"]`, box: '#say', onRestore: autoGrow });
    return q;
  }

  function send(text) {
    const chat = cur();
    if (!String(text || '').trim() || !chat?.console) return;
    $('#say').value = '';
    chat.say = '';
    autoGrow($('#say'));
    chat.queue.say(text);
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
    const chat = cur();
    if (chat?.draftDirty) saveDraft(chat, true);
  }

  const priorityLabel = (p) => ['critical', 'high', 'medium', 'low', 'backlog'][p] ?? 'medium';

  /** One bead: a summary row you tap to open, and the fields underneath it. */
  function beadHtml(b, i, all) {
    const isOpen = cur().open.has(b.ref);
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
    const chat = cur();
    const beads = chat?.draft?.beads || [];
    if (!beads.length) return closeSheet();

    $('#sheet-title').textContent = `${beads.length} bead${beads.length === 1 ? '' : 's'} to create`;
    const warnings = (chat.draft.warnings || []).length
      ? `<div class="warnings sheet-warn">${chat.draft.warnings.map((w) => `<span>${esc(w)}</span>`).join('')}</div>`
      : '';
    $('#sheet-body').innerHTML =
      `<p class="lede">In <strong>${esc(chat.console.workspace)}</strong>. Tap a bead to change anything about it — this is what will be created.</p>` +
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
    const chat = cur();
    if (!slot || !chat) return;
    if (!chat.pendingRevision) return (slot.innerHTML = '');
    slot.innerHTML = `<div class="revision">
      <span>The agent revised this proposal while you were editing.</span>
      <button class="secondary" id="take-revision">Use its version</button>
    </div>`;
    $('#take-revision').addEventListener('click', () => {
      chat.draft = structuredClone(chat.pendingRevision);
      chat.baseDraft = JSON.stringify(chat.pendingRevision);
      chat.pendingRevision = null;
      chat.draftDirty = false;
      renderSheet();
    });
  }

  function autoGrow(el) {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 340)}px`;
  }

  const beadFor = (ref) => (cur()?.draft?.beads || []).find((b) => b.ref === ref);

  function wireSheet() {
    const body = $('#sheet-body');

    for (const b of body.querySelectorAll('[data-toggle]')) {
      b.addEventListener('click', () => {
        const ref = b.dataset.toggle;
        const open = cur().open;
        open.has(ref) ? open.delete(ref) : open.add(ref);
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
        const chat = cur();
        chat.draft.beads = chat.draft.beads.filter((b) => b.ref !== ref);
        // Nothing may point at a bead that is no longer being created.
        for (const b of chat.draft.beads) {
          b.dependsOn = b.dependsOn.filter((d) => d !== ref);
          if (b.parent === ref) b.parent = null;
        }
        chat.open.delete(ref);
        markDirty();
        chat.draft.beads.length ? renderSheet() : closeSheet();
        renderThread();
      });
    }
  }

  function markDirty() {
    const chat = cur();
    if (!chat) return;
    chat.draftDirty = true;
    disarm();
    updateCreateButton();
    clearTimeout(chat.saveTimer);
    chat.saveTimer = setTimeout(() => saveDraft(chat), 700);
  }

  /**
   * Push the edited cards back. Not just persistence — it is how the agent gets to
   * see what you changed, so the next turn argues with the proposal on your screen
   * rather than the one it last wrote.
   */
  async function saveDraft(chat, immediate) {
    clearTimeout(chat.saveTimer);
    if (!chat.draftDirty) return;
    const payload = chat.draft ? { beads: chat.draft.beads } : null;
    try {
      const out = await api('/api/console/draft', {
        method: 'POST',
        body: JSON.stringify({ id: chat.id, draft: payload }),
      });
      chat.draftDirty = false;
      // Adopt the server's normalisation (dropped edges, cleaned labels) so what is
      // on screen is what would be created — but not while a field has focus.
      chat.baseDraft = JSON.stringify(out.draft || null);
      if (out.draft && !document.activeElement?.matches?.('#sheet-body textarea, #sheet-body input')) {
        chat.draft = structuredClone(out.draft);
        if (chat.id === state.id && sheetOpen()) renderSheet();
      }
      if (chat.id === state.id) updateCreateButton();
    } catch (err) {
      // A save flushed on the way out of a conversation still failed in it, and the
      // words are still there — but the screen has moved on and a red toast over
      // another chat would name nothing you can see.
      if (err.message !== 'token rejected' && chat.id === state.id) toast(`could not save: ${err.message}`, true);
      if (immediate) chat.draftDirty = true;
    }
  }

  /* ----------------------------------------------------------------- create */

  function updateCreateButton() {
    const n = cur()?.draft?.beads?.length || 0;
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
    const chat = cur();
    if (!chat?.draft?.beads?.length || state.creating) return;
    if (!state.armed) {
      state.armed = true;
      updateCreateButton();
      state.armedTimer = setTimeout(disarm, ARM_MS);
      return;
    }
    disarm();
    if (chat.draftDirty) await saveDraft(chat, true);

    state.creating = true;
    updateCreateButton();
    try {
      const out = await api('/api/console/create', {
        method: 'POST',
        body: JSON.stringify({ id: chat.id, draft: { beads: chat.draft.beads }, close: true }),
      });
      chat.draft = null;
      chat.baseDraft = 'null';
      chat.draftDirty = false;
      toast(`created ${out.created.length} bead${out.created.length === 1 ? '' : 's'}`);
      closeSheet();
      for (const w of out.warnings || []) toast(w, true);
      // Accepting ends the conversation: the beads exist and the chat session that argued
      // them into shape is done, so it closes itself and drops you back to the list.
      // Unless there were warnings — those have to be read on the screen that
      // produced them, and this leaves you there to read them.
      if (out.closed) {
        // Let go of it rather than hold a transcript with no closing line in it. The
        // row is still in the list and still opens; opening it fetches.
        state.chats.delete(chat.id);
        switchTo('', { replace: true });
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
    const chat = cur();
    if (!chat) return;
    if (!chat.draft) chat.draft = { beads: [], warnings: [] };
    let ref = `bead-${chat.draft.beads.length + 1}`;
    while (chat.draft.beads.some((b) => b.ref === ref)) ref += '-x';
    chat.draft.beads.push({
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
    chat.open.add(ref);
    markDirty();
    renderSheet();
    renderThread();
  }

  /* --------------------------------------------------------------- switching */

  const urlFor = (id) => (id ? `/console?id=${encodeURIComponent(id)}` : '/console');

  /** Put the thread, the composer and the sheet on screen. */
  function showThreadChrome() {
    $('#launcher').hidden = true;
    $('#thread').hidden = false;
    $('#composer').hidden = false;
    document.body.classList.remove('launching');
  }

  /** What the conversation being left is holding, so it is still holding it later. */
  function stash() {
    const chat = cur();
    if (!chat) return;
    chat.scrollTop = $('#thread').scrollTop;
    chat.say = $('#say').value;
  }

  /** Draw a conversation we already have, exactly as it was left. */
  function draw(chat) {
    renderThread();
    // After the render, not before: a repaint pins the thread to the bottom, and where
    // you had scrolled to is the last word on where this one opens.
    if (chat.scrollTop == null) scrollDown(true);
    else $('#thread').scrollTop = chat.scrollTop;
    $('#say').value = chat.say || '';
    autoGrow($('#say'));
    chat.queue.repaint();
    reportPresence(chat.console);
  }

  /** Fetch one for the first time. Everything after this is drawn from memory. */
  async function load(chat) {
    $('#thread').innerHTML = '<div class="empty">Loading…</div>';
    $('#say').value = '';
    try {
      adopt(await api(`/api/console?id=${encodeURIComponent(chat.id)}`));
    } catch (err) {
      if (err.message === 'token rejected') return false;
      $('#thread').innerHTML = `<div class="empty"><strong>Not found</strong>${esc(err.message)}. <a href="/console">Start a new one</a>.</div>`;
      $('#composer').hidden = true;
      return false;
    }
    chat.queue.repaint();
    return true;
  }

  /**
   * Bring a conversation to the front — or, with `''`, the launcher.
   *
   * This is what the map is for. A chat that has been loaded is drawn from what is
   * already here, with nothing between the tap and the transcript: the scroll position
   * is where you left it, the composer still holds what you were half-way through
   * typing, and the queue above it is that conversation's own.
   *
   * The URL is kept honest on every switch, because it is the only durable name for
   * where you are: a reload, a bookmark and the link on a bead card all land on the
   * chat it names, and the system back gesture walks back out through the ones you
   * came through. `push` is false when the history is what asked.
   */
  async function switchTo(id, { push = true, replace = false } = {}) {
    if (id && id === state.id) return;
    // The sheet belongs to a conversation, and it is the one thing on this screen that
    // would otherwise stay up over a different one. Closing it flushes its edits.
    closeSheet();
    stash();
    state.id = id;
    if (replace) history.replaceState(null, '', urlFor(id));
    else if (push) history.pushState(null, '', urlFor(id));

    if (id) {
      const chat = chatFor(id);
      showThreadChrome();
      // Which conversation the one strip above the composer is currently showing —
      // read by every open chat's queue, and matched by exactly one of them.
      $('#queued').dataset.chat = id;
      if (chat.console) draw(chat);
      else if (!(await load(chat))) return stopPolling();
    } else {
      $('#queued').removeAttribute('data-chat');
      $('#queued').hidden = true;
      showLauncher();
    }

    repoll();
    watchBackground();
  }

  /**
   * Three ways in, and they all end at a chat session id in the URL.
   *
   * `?ws=&seed=` is the one a card links to: it opens a chat session on that bead and
   * replaces itself with the real one, so a link on a bead card needs no JS of its
   * own and no POST from the page it sits on.
   */
  function start() {
    // Cleared first, so the switch below is a switch rather than a no-op: `state.id` is
    // seeded from the URL at boot, which is where we are being asked to go.
    const wanted = state.id;
    state.id = '';
    if (wanted) return switchTo(wanted, { replace: true });
    const params = new URLSearchParams(location.search);
    if (params.get('ws')) return open(params.get('ws'), params.get('seed'), { replace: true });
    return switchTo('', { replace: true });
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

    /* A conversation opens *here*, without a page load. The rows are still links to
       real addresses — copy one, open it in a new tab, and it works — but a plain tap
       is answered by bringing that chat to the front, which is what lets the one you
       were reading a moment ago still be loaded when you come back to it.

       Anything but a plain left tap is the browser's: a modified click means "somewhere
       else", and a switch would be the one thing that is not. The row ✕ has already
       stopped the event by the time this runs. */
    $('#recent').addEventListener('click', (ev) => {
      if (ev.defaultPrevented || ev.button || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      const a = ev.target.closest('a.work-row[data-id]');
      if (!a) return;
      ev.preventDefault();
      switchTo(a.dataset.id);
    });

    // Not delegated like the tabs: this button is in the page, not rebuilt by a paint.
    $('#ws-dismissed').addEventListener('click', () => setShowDismissed(!state.showDismissed));

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
    /* The back gesture, which is now how you leave a conversation as well as how you
       arrived at one. Every switch writes the URL, so the history is the list of chats
       you came through and walking back out of them costs no more than walking in.

       The drawer listens to `popstate` too, for its own pushed entry — that one leaves
       the address alone, which is why this compares before it acts. */
    addEventListener('popstate', () => {
      const id = new URLSearchParams(location.search).get('id') || '';
      if (id === state.id) return;
      switchTo(id, { push: false });
    });

    // A half-written edit must not die with the tab.
    addEventListener('visibilitychange', () => {
      const chat = cur();
      if (document.visibilityState === 'hidden' && chat?.draftDirty) saveDraft(chat, true);
    });
  }

  bootToken();
  wire();
  if (state.token) start();
})();
