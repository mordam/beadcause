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
 *
 * ## And then you can answer it
 *
 * Watching a session think and not being able to say anything to it was the last dead
 * end in the app: every other conversation here — the bead console, the agent chat, the
 * pty on /term — is one beadcause started and therefore owns, and this is the one
 * already on your screen. So there is a box under the facts, and the transcript below
 * it is the reply. Nothing renders the answer: the pane was already tailing the file
 * the session writes, so the response arrives on the next poll through the channel that
 * was there all along.
 *
 * Three things about it are the feature rather than decoration, and each is a way of
 * not lying to you about a message you typed on a phone in another room:
 *
 *   - **A session that cannot be reached says so instead of offering a box.** Reach is
 *     `pid → controlling tty → the iTerm window showing it` (see `sessionReach` in
 *     lib/session.js); a session with no terminal, or one in Terminal.app or tmux,
 *     is running fine and simply out of reach of the only channel there is. It arrives
 *     on the same response as the facts, so the composer can never contradict them.
 *   - **Nothing typed is thrown away.** A send that fails puts the words back in the
 *     box and says why; a repaint restores the draft; and the box is not cleared until
 *     the daemon has said it delivered.
 *   - **What the channel changes about your message, it admits to.** `write text`
 *     presses return at the end of a line, so a two-paragraph message goes as one
 *     line — said before you send it and again after.
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
    /** Whether it can be typed into, and the sentence to show when it cannot. */
    reach: null,
    /**
     * What you have typed and not yet sent.
     *
     * Held out here rather than read off the textarea, because a repaint replaces the
     * element — and a half-written message that disappears because reach flipped while
     * you were typing is exactly the kind of loss this page is not allowed to have.
     */
    draft: '',
    /** The last thing the send said back: `{ kind: 'ok'|'warn'|'bad', text }`. */
    note: null,
    /** True while a send is in flight, so a double tap cannot send twice. */
    sending: false,
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

  /**
   * The box, or the reason there isn't one.
   *
   * A session out of reach gets the sentence the daemon wrote and no composer at all —
   * not a disabled one. A disabled box is an invitation with the door shut: you write
   * the message anyway, find out afterwards, and the words are gone. Saying it in the
   * place the box would have been is the whole of the second acceptance criterion.
   *
   * The hint under the box is live, because the one surprise this channel has is that
   * it flattens. Better to read "will be sent as one line" while you are still writing
   * the second paragraph than to be told about it once it is too late to phrase it
   * differently.
   */
  function sayHtml(s) {
    const reach = state.reach;
    if (reach && !reach.can) {
      return `<div class="session-label">Say something <span>Not to this one.</span></div>
        <p class="say-blocked">${esc(reach.why || 'This session cannot be typed into.')}</p>`;
    }
    if (!reach) {
      // Reach comes back on the same response as the facts, so this is only ever seen
      // by a client talking to a daemon that predates the endpoint. Silence would leave
      // the page looking exactly as it did before the feature existed, which is the
      // right amount of degradation and the wrong amount of explanation.
      return `<div class="session-label">Say something <span>Not from this server.</span></div>
        <p class="say-blocked">This daemon does not know how to pass a message to a session yet.</p>`;
    }

    const busy = s.status === 'busy';
    const hints = [];
    if (/\n/.test(state.draft)) hints.push('Newlines close up — this goes as one line.');
    if (busy) hints.push('It is mid-turn, so the session holds this until the turn lands.');

    const note = state.note
      ? `<p class="say-note say-${esc(state.note.kind)}">${esc(state.note.text)}</p>`
      : '';

    return `<div class="session-label">Say something <span>It lands in the session as if typed.</span></div>
      <form class="session-say" data-say>
        <textarea data-say-text rows="1" enterkeyhint="send" autocomplete="off"
          placeholder="Say something to this session…"></textarea>
        <button class="primary send" type="submit" data-say-send aria-label="Send"
          ${state.sending ? 'disabled' : ''}>↑</button>
      </form>
      ${hints.length ? `<p class="say-hint">${esc(hints.join(' '))}</p>` : ''}
      ${note}`;
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
      <div class="say-block" data-say-block>${sayHtml(s)}</div>
      <div class="session-label">Transcript <span>Its own log, as the terminal showed it.</span></div>
      <pre class="agent-log" data-session-log>${esc(state.logText || 'opening the transcript…')}</pre>
    </div>`;
    wireSay();
  }

  /**
   * Give the freshly-drawn box its draft back, and its behaviour.
   *
   * Re-wired on every render rather than delegated from `out`, because the form is
   * rebuilt wholesale and there is exactly one of it — and the draft has to be put back
   * in the same breath as the element is created, or a repaint mid-sentence is a
   * repaint that ate the sentence.
   */
  function wireSay() {
    const form = out.querySelector('[data-say]');
    if (!form) return;
    const box = form.querySelector('[data-say-text]');
    box.value = state.draft;
    autoGrow(box);

    box.addEventListener('input', () => {
      const had = /\n/.test(state.draft);
      state.draft = box.value;
      autoGrow(box);
      // Only when the hint itself would change: repainting the page on every keystroke
      // would take the caret with it.
      if (had !== /\n/.test(state.draft)) repaintSay();
    });
    box.addEventListener('keydown', (ev) => {
      // The keyboard says "send", so Enter sends and shift+Enter is a newline — the
      // same bargain the bead console strikes, so the two composers do not disagree.
      if (ev.key === 'Enter' && !ev.shiftKey) {
        ev.preventDefault();
        say();
      }
    });
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      say();
    });
  }

  const autoGrow = (el) => {
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 260)}px`;
  };

  /**
   * Redraw the composer alone, keeping the caret where it was.
   *
   * The transcript below is a `<pre>` several thousand lines long and the facts have
   * not changed because a hint appeared, so `render()` for this would rebuild the
   * expensive half of the page to move a line of small text — and take the keyboard
   * down with it on iOS, which is the part that actually matters.
   */
  function repaintSay() {
    const block = out.querySelector('[data-say-block]');
    if (!block || !state.session) return render();

    const box = block.querySelector('[data-say-text]');
    // Only worth restoring if it was the focused element — putting the caret back into
    // a box you were not typing in would open the keyboard over the transcript.
    const at = box && box === document.activeElement ? box.selectionStart : null;

    block.innerHTML = sayHtml(state.session);
    wireSay();

    const fresh = block.querySelector('[data-say-text]');
    if (fresh && at !== null) {
      fresh.focus();
      fresh.setSelectionRange(at, at);
    }
  }

  /**
   * Send what is in the box, and be honest about what happened to it.
   *
   * The rule the whole function is built around: **the box is cleared only once the
   * daemon has said it delivered.** Every other path — a refusal, a closed window, a
   * dropped connection — leaves the words exactly where they were and puts the reason
   * underneath them. There is no queue and no retry here on purpose: mid-turn typing is
   * held by the *session*, which is what the CLI does with anything typed while it
   * works, so a second queue on this side would be beadcause holding words back that
   * the session was ready to take.
   *
   * There is no optimistic echo either. The transcript below is the reply channel, and
   * showing a message there before the session has written it would put a line in the
   * pane that is not in the file — the one place on this page where invented content
   * would be indistinguishable from a real transcript.
   */
  async function say() {
    // What is being sent, frozen. The box stays live while the request is in flight —
    // shutting it would be the composer closing mid-thought, which is the thing
    // public/sendqueue.js exists to have stopped doing elsewhere — so by the time this
    // returns, `state.draft` may be the *next* message. Clearing it blindly on success
    // would delete words that were never sent.
    const going = state.draft;
    const text = going.trim();
    if (!text || state.sending) return;

    state.sending = true;
    state.note = { kind: 'ok', text: 'Sending…' };
    repaintSay();

    try {
      const res = await fetch('/api/session-say', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify({ pid, text }),
      });
      const data = await res.json().catch(() => ({}));

      if (!res.ok) {
        // A 409 carries the reach it was refused for, so a tab left open since before
        // the window closed corrects itself here rather than offering the box again.
        if (data.reach) state.reach = data.reach;
        state.note = { kind: 'bad', text: `${data.error || `HTTP ${res.status}`} Your message is still here.` };
        return;
      }

      // Only the words that actually went. Anything typed since stays put.
      if (state.draft === going) state.draft = '';
      state.note = {
        kind: data.flattened ? 'warn' : 'ok',
        text: [
          data.queued ? 'Sent — the session is mid-turn and will answer when it lands.' : 'Sent.',
          data.flattened ? 'It went as one line: the newlines were closed up.' : '',
          'Watch the transcript below.',
        ]
          .filter(Boolean)
          .join(' '),
      };
    } catch (err) {
      state.note = { kind: 'bad', text: `Couldn't reach the server: ${err.message}. Your message is still here.` };
    } finally {
      state.sending = false;
      repaintSay();
    }
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

      // What the composer is drawn from, and the two things about it that can change
      // under a page left open: whether it is still reachable (a window closed by hand)
      // and whether it is mid-turn (which decides what the hint says).
      const was = `${state.reach?.can}·${state.reach?.why}·${state.session?.status}`;

      state.session = data;
      state.reach = data.reach || null;
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

      // …and the composer alone if what it says has actually changed. Not on every
      // poll: it holds the caret and, on iOS, the keyboard.
      if (was !== `${state.reach?.can}·${state.reach?.why}·${state.session?.status}`) repaintSay();
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
