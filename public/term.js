/* The in-app terminal — a real Claude Code session you drive from the phone.
 *
 * Everywhere else in beadcause you answer an agent. Here you steer one: the actual
 * TUI, on a pty on the Mac, over a WebSocket. What makes it usable on a phone is
 * three things that have nothing to do with streaming bytes.
 *
 *   - **A drop is not the end.** Locking the screen kills the socket within
 *     seconds; iOS kills it the moment the tab is backgrounded. The session on the
 *     other end keeps running regardless, so this reconnects on its own and replays
 *     the scrollback into a cleared screen. Coming back has to feel like waking a
 *     terminal, not like losing one.
 *   - **The keys the phone doesn't have.** Claude Code is driven by esc, ^C and
 *     shift-tab, and an Android soft keyboard offers none of them. The row above
 *     the keyboard is the feature, not the trim.
 *   - **Rotating reflows.** The pty is resized for real — see lib/terminal.js — so
 *     what the fit addon works out here is sent on and the TUI redraws at the new
 *     width instead of staying wrapped at forty columns.
 */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  /** Reconnect backoff. Fast at first — most drops are a screen lock, and you are looking at it. */
  const RETRY_MS = [400, 800, 1500, 3000, 5000, 8000];

  const state = {
    token: '',
    id: new URLSearchParams(location.search).get('id') || '',
    term: null,
    fit: null,
    ws: null,
    attempt: 0,
    retry: null,
    // Set while the socket is being replaced, so `close` doesn't schedule a second
    // reconnect on top of the one already running.
    closing: false,
    ended: false,
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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

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
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    return hrs < 24 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
  };

  /** A one-line note over the screen: connecting, reconnecting, ended. */
  function status(msg, kind = '') {
    const el = $('#status');
    if (!msg) {
      el.hidden = true;
      return;
    }
    el.textContent = msg;
    el.className = `term-status ${kind}`;
    el.hidden = false;
  }

  /* --------------------------------------------------------------- launcher */

  async function showLauncher() {
    $('#launcher').hidden = false;
    $('#screen-wrap').hidden = true;
    $('#end').hidden = true;

    let data;
    try {
      data = await api('/api/terminals');
    } catch (err) {
      return toast(err.message, true);
    }

    $('#disabled-note').hidden = data.enabled !== false;
    $('#ws-row').innerHTML = data.enabled === false
      ? ''
      : (data.workspaces || []).map((w) => `<button class="chip" data-ws="${esc(w)}">${esc(w)}</button>`).join('');
    for (const btn of $('#ws-row').querySelectorAll('[data-ws]')) {
      btn.addEventListener('click', () => openNew(btn.dataset.ws));
    }

    // Live and resumable ones are offered to rejoin. An exited terminal is still
    // listed by the API for a few minutes so a reconnect can show you its last
    // screen, but offering it here as something to "open" would be a lie.
    //
    // A resumable one is a conversation the daemon was restarted out from under: no
    // process right now, and tapping it starts one with `claude --resume`. It says so
    // rather than sitting in the list looking like every other running session.
    const live = (data.terminals || []).filter((t) => t.status === 'live' || t.status === 'resumable');
    $('#live-label').hidden = !live.length;
    $('#live').innerHTML = live
      .map((t) => {
        const sleeping = t.status === 'resumable';
        const bits = [t.workspace];
        if (t.bead) bits.push(t.bead.id);
        bits.push(sleeping ? 'resumable — the daemon restarted' : t.clients ? `${t.clients} watching` : 'nobody watching');
        return `<a class="work-row" href="/terminal?id=${encodeURIComponent(t.id)}">
          <span class="work-phase">${sleeping ? '↻' : '▶'}</span>
          <span class="work-main">
            <span class="work-title">${esc(t.bead?.title || t.dir)}</span>
            <span class="work-sub">${esc(bits.join(' · '))}</span>
          </span>
          <time>${esc(relTime(t.startedAt))}</time>
        </a>`;
      })
      .join('');
  }

  async function openNew(workspace, seed = '') {
    // The size is sent with the open request so the pty is created at it — a TUI
    // that samples its width once at startup would otherwise draw itself at 80
    // columns and only recover on the first rotation.
    const guess = guessSize();
    let data;
    try {
      data = await api('/api/terminal', {
        method: 'POST',
        body: JSON.stringify({ workspace, id: seed || undefined, cols: guess.cols, rows: guess.rows }),
      });
    } catch (err) {
      showLauncher();
      return toast(err.message, true);
    }
    state.id = data.terminal.id;
    history.replaceState(null, '', `/terminal?id=${encodeURIComponent(state.id)}`);
    startTerminal();
  }

  /**
   * What the terminal will be, before there is one to measure.
   *
   * Deliberately rough: it only has to be closer than 80x24, and the fit addon
   * sends the real numbers a moment later.
   */
  function guessSize() {
    const cols = Math.max(20, Math.floor(window.innerWidth / 9));
    const rows = Math.max(10, Math.floor((window.innerHeight - 150) / 18));
    return { cols, rows };
  }

  /* --------------------------------------------------------------- the screen */

  function buildTerminal() {
    const dark = !window.matchMedia('(prefers-color-scheme: light)').matches;
    const term = new window.Terminal({
      // A phone is short of pixels in both directions, and the TUI's box drawing
      // needs the columns more than the text needs the size.
      fontSize: 12,
      lineHeight: 1.1,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      cursorBlink: true,
      // The pty has its own ring buffer for reconnects; this is just how far back
      // you can scroll while connected.
      scrollback: 5000,
      // Reflow on resize rather than re-wrapping at the old width — this is the
      // half of "rotating the phone works" that lives in the browser.
      allowProposedApi: true,
      theme: dark
        ? { background: '#0b0f14', foreground: '#e6edf5', cursor: '#5eead4', selectionBackground: '#264050' }
        : { background: '#ffffff', foreground: '#16202b', cursor: '#0f766e', selectionBackground: '#cfe6e2' },
    });
    const fit = new window.FitAddon.FitAddon();
    term.loadAddon(fit);
    term.open($('#screen'));
    fit.fit();

    term.onData((data) => send(data));
    // Anything xterm.js classifies as a binary-safe key (a paste of non-UTF-8, a
    // meta-key sequence) arrives here instead. Both go the same way.
    term.onBinary((data) => send(data));

    state.term = term;
    state.fit = fit;
    return term;
  }

  /** Keystrokes go as a text control frame — the pty side turns them back into bytes. */
  function send(data) {
    if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'input', data }));
  }

  /**
   * Tell the daemon the new size, and only when it actually changed.
   *
   * Every resize crosses a process boundary and ends in an `stty` against the pty,
   * and an on-screen keyboard opening fires a torrent of viewport events — so this
   * is both debounced and compared.
   */
  let sizeTimer;
  let lastSize = '';
  function pushSize() {
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (!state.fit || !state.term) return;
      try {
        state.fit.fit();
      } catch {
        return;
      }
      const { cols, rows } = state.term;
      const key = `${cols}x${rows}`;
      if (key === lastSize) return;
      lastSize = key;
      if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'resize', cols, rows }));
    }, 120);
  }

  /* ------------------------------------------------------------- the socket */

  function connect() {
    if (state.ended) return;
    state.closing = false;
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}/ws/terminal?id=${encodeURIComponent(state.id)}`;

    let ws;
    try {
      // The token rides as a subprotocol because a browser cannot set a header on a
      // WebSocket handshake, and the query string is the one place it must not go —
      // that is what ends up in history and in every log on the way.
      ws = new WebSocket(url, ['beadcause.term.v1', `tok.${state.token}`]);
    } catch (err) {
      return scheduleRetry(err.message);
    }
    ws.binaryType = 'arraybuffer';
    state.ws = ws;
    status(state.attempt ? 'Reconnecting…' : 'Connecting…');

    ws.addEventListener('open', () => {
      state.attempt = 0;
      // The screen is cleared here rather than on close: what follows is the full
      // scrollback from the daemon, and printing it under whatever was already
      // there would show you the same output twice.
      state.term?.reset();
      lastSize = '';
    });

    ws.addEventListener('message', (ev) => {
      if (typeof ev.data !== 'string') {
        state.term?.write(new Uint8Array(ev.data));
        return;
      }
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === 'hello') return onHello(msg);
      if (msg.type === 'ready') {
        status('');
        // Send the true size once the replay is in: doing it before would resize
        // the pty while its scrollback was still being written at the old width.
        pushSize();
        state.term?.focus();
        return;
      }
      if (msg.type === 'exit') return onExit(msg);
    });

    ws.addEventListener('close', (ev) => {
      if (state.closing || state.ended) return;
      // 1008 is the daemon saying it has no such terminal — reaped, or lost to a
      // restart. Everything else is a drop, and a drop is what this page is built
      // to survive.
      if (ev.code === 1008) {
        state.ended = true;
        return status('That terminal is gone. Open a new one from the inbox.', 'bad');
      }
      scheduleRetry();
    });
    ws.addEventListener('error', () => {
      /* `close` always follows, and it is the one that knows the code. */
    });
  }

  function onHello(msg) {
    const t = msg.terminal || {};
    const label = t.bead ? `${t.bead.id} · ${t.workspace}` : t.workspace || 'Terminal';
    $('#title').textContent = label;
    document.title = `${label} · Beadcause`;
    // Reported from the hello rather than from boot: until the socket says what this
    // terminal is, all we have is an opaque id, and the mirror would name it that.
    window.beadcause?.presence?.report({
      view: 'terminal',
      id: state.id,
      workspace: t.workspace || '',
      key: t.bead?.id ? `${t.workspace}/${t.bead.id}` : '',
      detail: label,
    });
    $('#end').hidden = t.status !== 'live';
    // Said once, on the attach that did the resuming — see the note in lib/termsocket.js.
    // The pane is about to fill with a redraw that looks like an ordinary session, and
    // the missing scrollback needs an explanation that is not "something broke".
    if (msg.resumed) toast('The daemon restarted — this session was resumed. The screen before it is gone.');
    if (msg.truncated) toast('Scrollback was trimmed — the oldest output is gone.');
  }

  function onExit(msg) {
    state.ended = true;
    $('#end').hidden = true;
    status(`Session ended${msg.signal ? ` (${msg.signal})` : msg.code ? ` (exit ${msg.code})` : ''} — the screen above is its last.`, 'done');
  }

  function scheduleRetry() {
    if (state.ended) return;
    clearTimeout(state.retry);
    const wait = RETRY_MS[Math.min(state.attempt, RETRY_MS.length - 1)];
    state.attempt += 1;
    status(`Disconnected — reconnecting in ${Math.round(wait / 1000) || 1}s…`, 'bad');
    state.retry = setTimeout(connect, wait);
  }

  /** Drop the socket without giving up the terminal. Used when the tab is hidden. */
  function pause() {
    state.closing = true;
    clearTimeout(state.retry);
    try {
      state.ws?.close();
    } catch {
      /* already gone */
    }
    state.ws = null;
  }

  /* ---------------------------------------------------------------- the keys */

  /** `\x1b` in the HTML is two characters until something turns it into one. */
  const unescape = (s) =>
    String(s)
      .replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/\\t/g, '\t')
      .replace(/\\r/g, '\r')
      .replace(/\\n/g, '\n');

  function wireKeys() {
    for (const btn of document.querySelectorAll('#keyrow .key[data-seq]')) {
      const seq = unescape(btn.dataset.seq);
      // pointerdown, not click: a soft keyboard steals focus on tap, and by the
      // time click fires the viewport has moved under your finger.
      btn.addEventListener('pointerdown', (ev) => {
        ev.preventDefault();
        send(seq);
      });
    }
    // The one control that is about the keyboard rather than about a key: xterm.js
    // only raises the soft keyboard while its hidden textarea has focus, and every
    // tap on a button above takes that focus away.
    $('#kb').addEventListener('click', () => state.term?.focus());
  }

  /* ----------------------------------------------------------------- startup */

  function startTerminal() {
    $('#launcher').hidden = true;
    $('#screen-wrap').hidden = false;
    if (!state.term) buildTerminal();
    connect();
  }

  /**
   * Three ways onto this page, and only the first has a terminal already.
   *
   * `?id=` rejoins one. `?ws=&seed=` is the kebab on a question card — open one on
   * that bead without making me pick the workspace I just came from. Neither
   * means the launcher, which is only what you get when the page is opened cold.
   */
  function start() {
    if (!state.token) return;
    const params = new URLSearchParams(location.search);
    const ws = params.get('ws');
    if (state.id) return startTerminal();
    if (ws) {
      $('#launcher').hidden = true;
      return openNew(ws, params.get('seed') || '');
    }
    showLauncher();
  }

  $('#end').addEventListener('click', async () => {
    if (!state.id) return;
    try {
      await api('/api/terminal/close', { method: 'POST', body: JSON.stringify({ id: state.id }) });
      toast('Ending…');
    } catch (err) {
      toast(err.message, true);
    }
  });

  window.addEventListener('resize', pushSize);
  window.addEventListener('orientationchange', pushSize);
  // The visual viewport is what actually moves when the soft keyboard opens; the
  // window's own size does not change on Android, so `resize` alone would leave the
  // TUI drawn behind the keyboard.
  window.visualViewport?.addEventListener('resize', pushSize);

  /**
   * A backgrounded tab is a socket the OS will kill anyway — iOS does it within
   * seconds — so close it deliberately and reconnect on the way back. Doing it
   * ourselves means the return is a clean replay rather than a stalled socket that
   * has to time out first.
   */
  document.addEventListener('visibilitychange', () => {
    if (!state.id || state.ended) return;
    if (document.hidden) pause();
    else if (!state.ws) {
      state.attempt = 0;
      connect();
    }
  });

  wireKeys();
  bootToken();
  start();
})();
