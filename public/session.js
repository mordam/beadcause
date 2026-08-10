/* One session, addressed by pid — the same detail wherever in the app you tapped.
 *
 * A session shows up in four places: as a row on /sessions, as an advocate worker row
 * and a "Claude sessions" row on /advocates, in the Elsewhere card, and in the mirror.
 * The detail behind it existed in exactly one of them — folded inline under the row on
 * /sessions — so the same tap on the same session meant "show me what it is doing"
 * there and nothing at all everywhere else.
 *
 * So the detail moved out here, to a page of its own that every one of those rows
 * links to. Three things follow from that, and each of them is why this is a page
 * rather than a fifth copy of the pane:
 *
 *   - **The pid is the whole address.** `/session?pid=1234`. Nothing else identifies a
 *     running process, the transcript is resolved from the record Claude Code wrote for
 *     that pid (see lib/transcript.js), and a URL that named a file instead would be a
 *     way to read any file on the Mac.
 *   - **It opens over the tab you were on**, because public/drawer.js owns `/session`
 *     the same way it owns `/graph` and `/doc`: the row is a real anchor, the drawer
 *     intercepts the tap, and back — or the panel's ✕ — puts you back in the list with
 *     your place in it. A pasted URL still lands on the page itself, which is the
 *     fallback the whole drawer design leans on.
 *   - **A pid that has gone says so.** `/api/session-log` 404s for a process that is
 *     not running, and that is a different fact from a session with nothing to show:
 *     "it finished" and "it has done nothing yet" must never read the same.
 *
 * The facts and the transcript are what public/work.js used to fold inline, moved
 * verbatim rather than redesigned — the point of the change is that there is one of
 * them, not that it looks new. The room a full page has goes to the transcript, which
 * is the half you came for.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('session');
  const pulse = document.getElementById('pulse');
  const titleEl = document.getElementById('session-title');
  const pid = Number(new URLSearchParams(location.search).get('pid'));

  // A file read on the Mac, so this is cheap — and it is the number that decides
  // whether the pane feels live.
  const POLL_MS = 2000;

  const state = {
    /** The session record, as /api/session-log echoes it back. */
    session: null,
    /** Its transcript, as text. Kept out here so a repaint cannot blank the pane. */
    logText: '',
    /** Where the transcript came from, so an empty pane can say why it is empty. */
    file: null,
    /** Set once the pid is gone, or the request failed. Ends the polling. */
    gone: null,
    first: true,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /** How long it has been going — the number that tells you it's stuck. */
  function age(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  }

  /** "just now" already reads as a phrase; everything else wants the "ago". */
  const ago = (iso) => {
    const a = age(iso);
    return !a || a === 'just now' ? a : `${a} ago`;
  };

  /** The clock time — "17h" doesn't say whether it spanned lunch. */
  const clock = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  /**
   * What the header says — and it is read twice.
   *
   * In a drawer this is what public/drawer.js watches and hands up to the panel's own
   * header, so setting it here is the whole of how the panel learns whose session this
   * is. On its own it is the page's title bar. Either way it is the session's own name
   * where it has one, and the pid where it has not: a session is unnamed for its first
   * minute, and "(unnamed session)" over a page about pid 4212 says less than the pid.
   */
  function setTitle() {
    const name = state.session?.name || '';
    const text = name || (Number.isInteger(pid) && pid > 0 ? `pid ${pid}` : 'Session');
    titleEl.textContent = text;
    document.title = `${text} · Beadcause`;
  }

  /**
   * Every fact the process record carries, and no bead.
   *
   * Nothing on this machine records which bead a given process is on — see
   * lib/claude.js — so this does not guess at one. The advocate knows which windows
   * *it* opened, and its worker rows say so themselves; a session opened at the
   * keyboard has no such link and inventing one here would make the honest case (a
   * session on nothing the tracker knows about) invisible.
   */
  function factsHtml(s) {
    // Short labels on purpose: the column is a fixed width so the values line up, and
    // on a 390px screen every character spent on the label is one taken off a path that
    // is already going to wrap.
    //
    // The live dot rides on the process row rather than on a status line of its own. It
    // is the one at-a-glance answer to "is this moving" and has to be here somewhere —
    // but a line above the facts saying "busy · pid 4242" was the process row read out
    // twice, and this page exists to be the one place these facts are stated.
    const facts = [
      ['where', s.cwd || 'not recorded'],
      ['workspace', s.workspace || 'not in a configured workspace'],
      [
        'process',
        `pid ${s.pid}${s.kind ? ` · ${s.kind}` : ''}${s.status ? ` · ${s.status}` : ''}`,
        s.status === 'busy' ? '<span class="spark"></span>' : '<span class="idle">○</span>',
      ],
      ['started', s.startedAt ? `${clock(s.startedAt)} · ${ago(s.startedAt)}` : 'not recorded'],
      ['active', s.at ? `${clock(s.at)} · ${ago(s.at)}` : 'not recorded'],
      // Eight characters is what identifies a session in Claude Code's own output,
      // and the rest of the uuid is no more useful on a phone.
      ['session', s.sessionId ? s.sessionId.slice(0, 8) : 'not recorded'],
    ];
    return `<dl class="session-facts">${facts
      .map(([k, v, mark]) => `<div><dt>${esc(k)}</dt><dd>${mark || ''}${esc(v)}</dd></div>`)
      .join('')}</dl>`;
  }

  function render() {
    if (state.gone) {
      out.innerHTML = `<div class="empty"><strong>${esc(state.gone.title)}</strong>${esc(state.gone.detail)}</div>`;
      return;
    }
    const s = state.session;
    if (!s) return; // the boot line is already on screen

    // No heading row: the session's name is in the header above — the panel's in a
    // drawer, the page's own top bar out of one — and repeating it here, with the pid
    // and status the facts state exactly, was this page saying everything twice before
    // it said anything once.
    out.innerHTML = `<div class="session-detail session-solo">
      ${factsHtml(s)}
      <div class="session-label">Transcript <span>Its own log, as the terminal showed it.</span></div>
      <pre class="agent-log" data-session-log>${esc(state.logText || 'opening the transcript…')}</pre>
    </div>`;
  }

  /**
   * One request for the lot: the record and the tail of its transcript.
   *
   * The pane is written straight into the `<pre>` on later polls rather than through
   * render(), because the facts have not changed just because the session typed another
   * line, and rebuilding the page twice a second to find out would be absurd.
   */
  async function poll() {
    if (state.gone) return;
    pulse.classList.add('busy');
    try {
      const res = await fetch(`/api/session-log?pid=${encodeURIComponent(pid)}`, {
        headers: { 'x-beadcause-token': token },
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 404) {
        // The process is not running. Said plainly, and it ends the polling: a page
        // that kept asking would be hammering the daemon about a pid that will never
        // come back, and a session that exited is not an error.
        state.gone = {
          title: 'That session has finished',
          detail: data.error || `Nothing is running as pid ${pid}.`,
        };
        setTitle();
        return render();
      }
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      state.session = data;
      state.file = data.file || null;
      state.logText =
        (data.lines || []).join('\n') ||
        // Where it looked, so an empty pane says why it is empty rather than implying
        // the session has done nothing.
        (data.file ? `Nothing to show yet.\n${data.file}` : 'No transcript file for this session.');

      setTitle();
      window.beadcause?.presence?.report({ view: 'session', id: String(pid), detail: data.name || `pid ${pid}` });

      const pre = out.querySelector('[data-session-log]');
      if (state.first || !pre) {
        state.first = false;
        render();
        const fresh = out.querySelector('[data-session-log]');
        if (fresh) fresh.scrollTop = fresh.scrollHeight;
        return;
      }
      // Follow the tail only if you were already at the bottom, so scrolling back to
      // read something isn't yanked away by the next line.
      const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
      pre.textContent = state.logText;
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (err) {
      // A transport failure is not a session that has gone, so it does not stop the
      // polling — it says so where the transcript would be and tries again.
      state.logText = `⚠ ${err.message}`;
      if (state.session) {
        const pre = out.querySelector('[data-session-log]');
        if (pre) pre.textContent = state.logText;
      } else {
        out.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
      }
    } finally {
      pulse.classList.remove('busy');
    }
  }

  // Opened on its own, the ✕ means the tab. In a drawer it never gets here —
  // drawer.js takes the click first, and `data-drawer-close` is what tells it to.
  document.getElementById('session-close').addEventListener('click', () => {
    window.close();
    setTimeout(() => (location.href = '/sessions'), 120);
  });

  setTitle();

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else if (!Number.isInteger(pid) || pid <= 0) {
    out.innerHTML = '<div class="empty"><strong>No session named</strong>A session is addressed by its pid.</div>';
  } else {
    poll();
    setInterval(poll, POLL_MS);
  }
})();
