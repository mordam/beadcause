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
 *   - **What the channel changes about your message, it admits to.** It used to close
 *     the newlines up — `write text` presses return at the end of a line, so two
 *     paragraphs went as one — and the page warned you before and after. It does not
 *     reflow any more, so what it says now is what a multi-line message *looks like* on
 *     the Mac: the composer there shows `[Pasted text #1 +6 lines]` rather than the
 *     words. `scripts/say-check.mjs` fails on any claim of a flattening that has stopped
 *     happening.
 *
 * ## And then you can go and find it
 *
 * The dead end after that one. You could read a session and answer it, and still not
 * know which of a dozen worktree windows on the desk it *is* — finding it meant going
 * through iTerm's window list by hand, comparing paths. So there is a button above the
 * box: it brings that window to the front of the Mac and doubles it in place, and
 * closing this view puts it back at exactly the bounds and position it had.
 *
 * Three things about it are the same shape as the composer, on purpose, because they
 * are the same fact seen twice:
 *
 *   - **It is gated on the same `reach`**, from the same response. A session in
 *     Terminal.app, tmux or over ssh has no iTerm window, and gets the reason rather
 *     than a button that would do nothing.
 *   - **The daemon owns whether it is up, and how big it used to be.** `focused` comes
 *     back with the facts, so a reload finds the window as it left it; the rectangle to
 *     restore to is held in lib/focus.js, keyed by pid, because a phone that locks or a
 *     tab that is swiped away would otherwise be the only thing that knew it.
 *   - **Every way of leaving puts it back.** The close sends a restore as the page is
 *     torn down; the ways of leaving that send nothing — a lock, a discarded tab — are
 *     covered by a lease the poll below is already renewing.
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
    /**
     * Whether its window is up on the Mac at double size — the daemon's answer, not
     * ours. Kept server-side (lib/focus.js) so a reload of this page finds the window
     * as it left it, rather than offering to enlarge one that already is.
     */
    focused: false,
    /** True while a focus or a restore is in flight. */
    focusing: false,
    /** What the last one said back, when it was worth saying. */
    focusNote: null,
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
   * The button that points the Mac at it — or the reason there is nothing to point at.
   *
   * The last dead end after the composer. You could watch a session think and answer
   * it, and still not know *which of a dozen worktree windows on the desk it is*. So
   * one tap raises that window and doubles it in place, and closing this view puts it
   * back exactly where it was; lib/focus.js holds the rectangle and explains why it is
   * held there rather than here.
   *
   * Gated on the same `reach` as the composer, from the same response, so the two can
   * never disagree about whether this session has a window at all. When it has not, the
   * label says so and no button is drawn — a button that did nothing would be the same
   * lie as a disabled box.
   *
   * **The sentence is not repeated.** The composer's blocked line sits directly under
   * this and states the reason in full; saying it twice, forty pixels apart, would read
   * as a bug rather than as thoroughness. This block says which of its two halves is
   * missing, and the why below covers both.
   */
  function windowHtml() {
    const reach = state.reach;
    if (!reach) {
      return `<div class="session-label">Its window <span>Not from this server.</span></div>`;
    }
    if (!reach.can) {
      return `<div class="session-label">Its window <span>There isn't one to bring up.</span></div>`;
    }
    const up = state.focused;
    const note = state.focusNote
      ? `<p class="say-note say-${esc(state.focusNote.kind)}">${esc(state.focusNote.text)}</p>`
      : '';
    // On the label row, at the far end, exactly where the mic sits on the composer's —
    // and for the reason written beside `.label-mic` in the stylesheet: the transcript
    // below is what this page is for, and a row of its own for one button is 44px of log
    // pushed under the fold. scripts/say-check.mjs measures precisely that.
    //
    // Which is also why the sentence is three words. `.session-label` wraps, and on a
    // 393px phone a label, a sentence and a button do not fit on one line — the button
    // silently drops onto a second row and costs the 44px anyway. "Twice the size" is
    // the half worth saying; that the window comes to the front is what the button says.
    return `<div class="session-label">Its window <span>${
      up ? 'Up, twice the size.' : 'Twice the size.'
    }</span><span class="label-win"><button class="win-btn" type="button"
        data-focus="${up ? 'restore' : 'focus'}" ${state.focusing ? 'disabled' : ''}>${
      up ? 'Put it back' : 'Bring it up'
    }</button></span></div>
      ${note}`;
  }

  /**
   * The box, or the reason there isn't one.
   *
   * A session out of reach gets the sentence the daemon wrote and no composer at all —
   * not a disabled one. A disabled box is an invitation with the door shut: you write
   * the message anyway, find out afterwards, and the words are gone. Saying it in the
   * place the box would have been is the whole of the second acceptance criterion.
   *
   * The hint under the box is live, and what it has to say has changed: the channel
   * used to close your newlines up, and now it keeps them. What is left worth saying
   * while you are still typing is what a multi-line message *looks like* on the Mac —
   * the composer there shows `[Pasted text #1 +6 lines]`, not the words — because
   * someone standing over that screen would otherwise read a placeholder as a lost
   * message. It submits in full either way.
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
    if (/\n/.test(state.draft)) hints.push('Line breaks are kept — it goes as one message, pasted.');
    if (busy) hints.push('It is mid-turn, so the session holds this until the turn lands.');

    const note = state.note
      ? `<p class="say-note say-${esc(state.note.kind)}">${esc(state.note.text)}</p>`
      : '';

    // On the label, not in the composer. The row below is a textarea between two round
    // buttons on a 393px phone, and a third one squeezes the box until its placeholder
    // wraps — 22px that pushed the transcript past the bottom of the screen, which
    // scripts/say-check.mjs measures precisely because reading the log is why the page
    // exists. The label has a whole empty half and nothing to lose.
    const mic = window.beadcause?.dictation?.buttonHtml({
      target: '.session-say textarea',
      note: '.session-say',
      label: 'Dictate this message',
    });
    return `<div class="session-label">Say something <span>It lands in the session as if typed.</span>${
      mic ? `<span class="label-mic">${mic}</span>` : ''
    }</div>
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
      <div class="win-block" data-win-block>${windowHtml()}</div>
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

  /* --------------------------------------------------- pointing the Mac at it */

  /**
   * Redraw the button alone.
   *
   * Same reason `repaintSay` exists: the transcript below is a `<pre>` several thousand
   * lines long, and rebuilding it to change one word on a button would take the
   * keyboard down with it on iOS. Delegated rather than re-wired, because unlike the
   * composer this half holds nothing you could lose.
   */
  function repaintWindow() {
    const block = out.querySelector('[data-win-block]');
    if (!block || !state.session) return render();
    block.innerHTML = windowHtml();
  }

  /**
   * Ask the daemon to raise that window, or to put it back.
   *
   * `focused` is read back off the response rather than toggled here: the daemon owns
   * the saved rectangle, and a page that decided for itself would offer "put it back"
   * for a window it had already lost — a window closed by hand between two taps comes
   * back as a 409, and the button has to return to offering the enlarge.
   */
  async function windowAct(action) {
    if (state.focusing) return;
    state.focusing = true;
    state.focusNote = null;
    repaintWindow();
    try {
      const res = await fetch('/api/session-focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify({ pid, action }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (data.reach) state.reach = data.reach;
        state.focused = false;
        state.focusNote = { kind: 'bad', text: data.error || `HTTP ${res.status}` };
        return;
      }
      state.focused = !!data.focused;
      state.focusNote = data.focused
        ? { kind: 'ok', text: 'It is at the front of the Mac now.' }
        : null;
    } catch (err) {
      state.focusNote = { kind: 'bad', text: `Couldn't reach the server: ${err.message}` };
    } finally {
      state.focusing = false;
      repaintWindow();
    }
  }

  // One delegated listener for the life of the page: the button is rebuilt on every
  // repaint, and re-binding it each time is a listener leak waiting to happen.
  out.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('[data-focus]');
    if (!btn || btn.disabled) return;
    ev.preventDefault();
    windowAct(btn.dataset.focus);
  });

  /**
   * Put the window back as this page goes away.
   *
   * `pagehide` and not `visibilitychange`, and the difference is the whole feature: a
   * phone that locks while you walk over to the Mac fires `visibilitychange`, and
   * shrinking the window at that moment would undo the one thing you asked for. What
   * `pagehide` fires on is *leaving* — the drawer's ✕, the back button, a closed tab, a
   * navigation away — which is the close the bead asked to restore on. The phone that
   * locked and never came back is covered instead by the lease in lib/focus.js, which
   * is measured from this page's own polling.
   *
   * `sendBeacon`, because a `fetch` started in a handler that is tearing the document
   * down is not promised to leave the machine. It cannot set a header, so the token
   * rides as `?t=` — the same query parameter every endpoint here already accepts, and
   * this URL is never one that gets shared or pasted.
   */
  addEventListener('pagehide', () => {
    if (!state.focused || !navigator.sendBeacon) return;
    const body = new Blob([JSON.stringify({ pid, action: 'restore' })], { type: 'application/json' });
    navigator.sendBeacon(`/api/session-focus?t=${encodeURIComponent(token)}`, body);
  });

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
    const live = box && box === document.activeElement ? box : null;
    // Both ends, and the direction with them. A caret is the case where the two ends are
    // equal, so carrying only `selectionStart` — which this did until bc-nh19 — hands back
    // a caret at the left edge of whatever you had picked out, and the direction is the
    // end the next Shift-arrow extends from. This box is repainted by a poll, which lands
    // by definition at the moment you are mid-sentence in it, so the words you selected to
    // type over are gone before you have typed anything. Same three fields as
    // public/mirror.js's composer (bc-c3ve).
    const at = live ? live.selectionStart : null;
    const to = live ? live.selectionEnd : null;
    const way = live ? live.selectionDirection || 'none' : 'none';

    block.innerHTML = sayHtml(state.session);
    wireSay();

    const fresh = block.querySelector('[data-say-text]');
    if (fresh && at !== null) {
      fresh.focus();
      fresh.setSelectionRange(at, to ?? at, way);
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
      // Said from the text that went rather than from a field on the response: the
      // daemon has nothing left to report about the shape of the message, because
      // nothing happens to it any more.
      state.note = {
        kind: 'ok',
        text: [
          data.queued ? 'Sent — the session is mid-turn and will answer when it lands.' : 'Sent.',
          /\n/.test(text) ? 'Line breaks and all, as one message.' : '',
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
      const wasUp = `${state.reach?.can}·${state.focused}`;

      state.session = data;
      state.reach = data.reach || null;
      // Not while a tap is in flight: this poll is two seconds stale by definition, and
      // letting it answer would flip the button back under the thumb that just pressed
      // it. The request's own response is the authority, and it is a moment away.
      if (!state.focusing) state.focused = !!data.focused;
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
      // The button says one of two things and the lease can change which without anyone
      // touching it: three minutes after this page stopped being watched, the daemon
      // puts the window back on its own, and a tab left open must say so.
      if (wasUp !== `${state.reach?.can}·${state.focused}`) repaintWindow();
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
  //
  // It used to go to `/sessions` from here, which was right while a sessions view
  // existed and became a ✕ that closed one view by opening a different tab the day
  // Advocates absorbed it. There is one rule now and it is in drawer.js's header:
  // to what was underneath, and to the inbox when nothing was.
  document.getElementById('session-close').addEventListener('click', () => window.beadcause.closeView());

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
