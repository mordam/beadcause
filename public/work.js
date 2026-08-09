/* Current sessions: who is working, on which bead, and what they are doing right now.
 *
 * The inbox answers "what needs me". This is the other half — a bead only reaches
 * the inbox if it is labelled `human`, so everything the sessions on the Mac are
 * actually doing was invisible from the phone.
 *
 * A session appears here through either of two independent signals, and the page
 * keeps them apart on purpose:
 *
 *   - a bead it has CLAIMED (`status = in_progress`) — every session emits this just
 *     by running `bd update --claim`, and it is the half that says *which bead*;
 *   - a live `claude` process — the half that catches a session which has claimed
 *     nothing at all, and so appears nowhere in the tracker.
 *
 * Nothing on the Mac records which bead a given process is on, so the two are never
 * paired up here. A workspace with a session and no claimed bead is a real thing to
 * see — it is usually the thing you most want to see — and a guess would have hidden
 * it behind a confident wrong answer.
 *
 * Two things about the shape of the page:
 *
 * **The cards are an accordion, one open at a time.** Six workspaces of beads and
 * sessions is several screens on a phone, and the whole page had to be paged through
 * to reach the one repo you opened it for. Collapsed, every heading still carries its
 * own summary — "5 on a bead · 5 sessions" — so the scan happens in one screen and
 * only the card you want unfolds.
 *
 * **Tapping a session opens what it is doing.** The row used to be a dead end: a
 * name, a pid and the word "busy", which reads the same for a session mid-thought as
 * for one wedged an hour ago on a permission prompt. Its detail tails the session's
 * own Claude Code transcript (`/api/session-log`), so the answer to "is this moving"
 * is the last thing it actually said.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('work');
  const pulse = document.getElementById('pulse');
  const observing = document.getElementById('observing');
  const REFRESH_MS = 45000;
  // The transcript is a file read on the Mac, so this is cheap — and it is the number
  // that decides whether the pane feels live. Only ever runs while a pane is open.
  const LOG_MS = 2000;

  /* A card key no workspace can collide with: workspace names are directory names
     under ~/beads, which never contain a space. */
  const ELSEWHERE = 'sessions elsewhere';

  const state = {
    data: null,
    /** Which card is unfolded. At most one — that is what makes it an accordion. */
    card: null,
    /** The pid of the session whose detail is open, if any. */
    session: null,
    /** Its transcript, kept out here so a repaint doesn't blank the pane. */
    logText: '',
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

  /** The clock time, for the detail view — "17h" doesn't say whether it spanned lunch. */
  const clock = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  const graphUrl = (ws, id) =>
    `/graph?ws=${encodeURIComponent(ws)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /**
   * One claimed bead — a session that told the tracker what it is doing.
   *
   * The row goes to that bead in the graph, where its neighbours and its full detail
   * already live, so there is no second detail view to keep in step. The id is a pill
   * rather than buried in the sub-line: which bead this is, is the point of the row.
   */
  function beadRow(ws, x) {
    return `<a class="work-row" href="${esc(graphUrl(ws, x.id))}" aria-label="${esc(x.id)} in the dependency graph">
      <span class="work-phase">${x.icon ? esc(x.icon) : '◗'}</span>
      <span class="work-main">
        <span class="work-title">${esc(x.title)}</span>
        <span class="work-sub">
          <span class="pill id">${esc(x.id)}</span>${x.actor ? ` ${esc(x.actor)}` : ''}${
            x.phase ? ` · ${esc(x.phase)}` : ''
          }${x.detail ? ` — ${esc(x.detail)}` : ''}
        </span>
      </span>
      <time>${esc(age(x.since))}</time>
    </a>`;
  }

  /**
   * What one live session is, and what it is saying.
   *
   * Every fact here comes off the process record — no bead, because nothing on this
   * machine records which bead a process is on. The pane below is the honest answer
   * to the question the row used to raise and leave hanging.
   */
  function sessionDetail(s) {
    // Short labels on purpose: the column is a fixed width so the values line up, and
    // on a 390px screen every character spent on the label is one taken off a path
    // that is already going to wrap.
    const facts = [
      ['where', s.cwd || 'not recorded'],
      ['workspace', s.workspace || 'not in a configured workspace'],
      ['process', `pid ${s.pid}${s.kind ? ` · ${s.kind}` : ''}${s.status ? ` · ${s.status}` : ''}`],
      ['started', s.startedAt ? `${clock(s.startedAt)} · ${ago(s.startedAt)}` : 'not recorded'],
      ['active', s.at ? `${clock(s.at)} · ${ago(s.at)}` : 'not recorded'],
      // Eight characters is what identifies a session in Claude Code's own output,
      // and the rest of the uuid is no more useful on a phone.
      ['session', s.sessionId ? s.sessionId.slice(0, 8) : 'not recorded'],
    ];
    return `<div class="session-detail">
      <dl class="session-facts">${facts
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
        .join('')}</dl>
      <div class="session-label">Transcript <span>Its own log, as the terminal showed it.</span></div>
      <pre class="agent-log" data-session-log="${esc(s.pid)}">${esc(state.logText || 'opening the transcript…')}</pre>
    </div>`;
  }

  /**
   * One live `claude` process.
   *
   * A button now, not a div: it used to be inert because there was nowhere honest to
   * send you — the bead it might be on is unknown — but its own transcript is
   * somewhere honest, and it is the thing you opened this page to find out.
   */
  function sessionRow(s) {
    const busy = s.status === 'busy';
    const open = state.session === s.pid;
    return `<button class="work-row session-row" type="button" data-session="${esc(s.pid)}" aria-expanded="${open}">
      <span class="work-phase">${busy ? '<span class="spark"></span>' : '○'}</span>
      <span class="work-main">
        <span class="work-title">${esc(s.name || '(unnamed session)')}</span>
        <span class="work-sub">${esc(s.where || s.cwd)} · pid ${esc(s.pid)}${
          s.status ? ` · ${esc(s.status)}` : ''
        }</span>
      </span>
      <time>${esc(age(s.at))}</time>
      <span class="chev" aria-hidden="true">›</span>
    </button>${open ? sessionDetail(s) : ''}`;
  }

  /**
   * The accordion shell: a heading that is always readable, and a body that folds.
   *
   * The summary lives in the heading rather than the body on purpose — collapsed, the
   * heading is all that is left, and "climative" on its own would make the fold cost
   * you the very thing you were scanning for.
   */
  function cardHtml(key, title, summary, on, body) {
    const open = state.card === key;
    return `<article class="card work-card${open ? ' open' : ''}">
      <h2 class="work-head">
        <button class="work-toggle" type="button" data-card="${esc(key)}" aria-expanded="${open}">
          <span class="work-name">${esc(title)}</span>
          <span class="work-count${on ? ' on' : ''}">${esc(summary)}</span>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </h2>
      <div class="work-body"${open ? '' : ' hidden'}>${body}</div>
    </article>`;
  }

  /**
   * The repo's advocate.
   *
   * Three things, in the order you need them: what it is doing right now, which
   * beads it has windows open on, and what it will take next. The last one is what
   * makes the block worth having — everything else on this page is a report of the
   * past, and this is the one line that says what is about to happen without you.
   *
   * A paused or quiet advocate is drawn, not hidden. An advocate you cannot see is
   * indistinguishable from a repo with nothing left to do, which is the exact
   * confusion the whole feature exists to end.
   */
  function advocateHtml(a) {
    if (!a) return '';

    const ready = a.queue ? ` · ${plural(a.queue, 'bead')} ready` : '';
    const state = a.error
      ? `⚠ ${esc(a.error)}`
      : a.paused
        ? `paused${ready}`
        : a.quiet
          ? `quiet${ready} — watching, not launching`
          : a.surveying
            ? 'surveying for work to propose'
            : a.workers.length
              ? `${a.workers.length} of ${a.limit} session${a.limit === 1 ? '' : 's'}${ready}`
              : a.queue
                ? `${plural(a.queue, 'bead')} ready`
                : 'clear';
    // The note explains what the state doesn't. When it merely repeats it — which
    // is the common case, because both are generated from the same tick — it is
    // dropped rather than printed twice.
    const note = a.note && !state.toLowerCase().includes(a.note.toLowerCase().split(/[ ·—]/)[0]) ? a.note : '';

    // A worker is a window we opened, not a process we can see. So the row says
    // what we actually know — the bead, when we opened it, whether it was ever
    // claimed — and names the pid only where the session took the bead id into its
    // own name, which is the only honest way the two are ever connected.
    const workers = a.workers
      .map(
        (w) => `<a class="work-row adv-worker" href="${esc(graphUrl(a.workspace, w.id))}">
          <span class="work-phase">${w.claimed ? '<span class="spark"></span>' : '◔'}</span>
          <span class="work-main">
            <span class="work-title">${esc(w.title || w.id)}</span>
            <span class="work-sub"><span class="pill id">${esc(w.id)}</span>${
              w.claimed ? 'claimed' : 'opened, not claimed yet'
            }${w.pid ? ` · pid ${esc(w.pid)}` : ''}${w.attempt > 1 ? ` · attempt ${esc(w.attempt)}` : ''}</span>
          </span>
          <time>${esc(age(w.at))}</time>
        </a>`
      )
      .join('');

    const next =
      !a.workers.length && a.next?.length
        ? `<div class="adv-next">next: ${a.next.map((b) => `<span class="pill id">${esc(b.id)}</span> ${esc(b.title)}`).join(' · ')}</div>`
        : '';

    const buttons = [
      `<button class="adv-btn" data-adv="${a.paused ? 'resume' : 'pause'}" data-ws="${esc(a.workspace)}">${
        a.paused ? 'Resume' : 'Pause'
      }</button>`,
      // "I closed those windows myself" — the sessions belong to iTerm, so nothing
      // here can see them go, and without this the slots stay held until they lapse.
      a.workers.length
        ? `<button class="adv-btn" data-adv="release" data-ws="${esc(a.workspace)}">Free slots</button>`
        : '',
    ]
      .filter(Boolean)
      .join('');

    return `<div class="adv">
      <div class="session-label">Advocate <span class="${a.error ? 'bad' : ''}">${state}</span>
        <span class="adv-actions">${buttons}</span>
      </div>
      ${workers}${next}
      ${note && !a.error ? `<div class="adv-note">${esc(note)}</div>` : ''}
      ${
        // What the last sweep did with the worktrees sessions leave behind. Only
        // when it actually did something — a sweep that found nothing to do is the
        // normal case, and saying so every fifteen minutes is noise.
        a.tidy?.summary ? `<div class="adv-note">🧹 ${esc(a.tidy.summary)}</div>` : ''
      }
    </div>`;
  }

  function workspaceHtml(w, advocate) {
    const counts = w.counts || {};
    const sessions = w.sessions || [];
    const pills = [
      counts.open != null ? `<span class="pill">${counts.open} open</span>` : '',
      counts.ready ? `<span class="pill">${counts.ready} ready</span>` : '',
      counts.blocked ? `<span class="pill p1">${counts.blocked} blocked</span>` : '',
    ].filter(Boolean);

    // Two numbers, because they mean different things and either can be zero while
    // the other isn't: beads claimed, and processes running.
    const summary = [
      w.working.length ? `${w.working.length} on a bead` : '',
      sessions.length ? plural(sessions.length, 'session') : '',
      // Only when it is holding something back: an advocate quietly working is
      // already visible in the two numbers beside it.
      advocate?.paused ? 'advocate paused' : '',
    ].filter(Boolean);

    if (w.error) {
      // The sessions come off the filesystem rather than from bd, so they survive a
      // workspace whose database is mid-write and are still worth showing. The
      // heading says "error" when there is nothing else to count, because a fold
      // must never hide the fact that a workspace could not be read.
      //
      // The advocate rides along for the same reason: its state comes from memory
      // rather than from bd, so it survives a database mid-write — and an advocate
      // that cannot read its tracker is precisely what you want to see here.
      const body = `<p class="subtitle bad">⚠ ${esc(w.error)}</p>
        ${advocateHtml(advocate)}${sessions.map(sessionRow).join('')}`;
      return cardHtml(w.name, w.name, summary.length ? `${summary.join(' · ')} · error` : 'error', true, body);
    }

    const adv = advocateHtml(advocate);
    const beads = w.working.map((x) => beadRow(w.name, x)).join('');

    let sessionBlock = '';
    if (sessions.length) {
      // Say plainly which case this is. "Two sessions, nothing claimed" is the state
      // worth acting on, and it is invisible if the block is just a list.
      const note = w.working.length
        ? 'Which of these is on which bead is not recorded.'
        : 'Nothing claimed in the tracker yet.';
      sessionBlock = `<div class="session-label">Claude sessions <span>${esc(note)}</span></div>${sessions
        .map(sessionRow)
        .join('')}`;
    }

    const nothing =
      !beads && !sessions.length && !adv
        ? '<p class="subtitle">No claimed beads, and no session open here.</p>'
        : '';

    // The advocate first, inside the fold: it is the thing that acts on this
    // workspace, so it reads before the beads it opened windows on.
    const body = `${adv}${beads}${sessionBlock}${nothing}
      <div class="work-foot">
        <div class="meta">${pills.join('')}</div>
        <a class="work-graph" href="${esc(graphUrl(w.name))}">Graph →</a>
      </div>`;

    return cardHtml(w.name, w.name, summary.length ? summary.join(' · ') : 'idle', Boolean(summary.length), body);
  }

  /**
   * Sessions in a directory that maps to no configured workspace.
   *
   * Only reachable without `projectRoot` set, but they are still sessions, and a page
   * called "current sessions" that quietly dropped some would be lying by omission.
   */
  function elsewhereHtml(sessions) {
    if (!sessions.length) return '';
    const body = `<div class="session-label">Claude sessions <span>Not in any configured workspace.</span></div>
      ${sessions.map(sessionRow).join('')}`;
    return cardHtml(ELSEWHERE, 'Elsewhere', plural(sessions.length, 'session'), true, body);
  }

  /**
   * Repaint from `state`, keeping the two things a repaint destroys.
   *
   * The page's own scroll, and the transcript pane's — the cards refresh every 45
   * seconds, and a pane that jumped to the tail each time would make reading back
   * through a run impossible. Following the tail is only right if you were already
   * at the bottom.
   */
  function render() {
    if (!state.data) return;
    const scrollY = window.scrollY;
    const pre = out.querySelector('[data-session-log]');
    const pane = pre
      ? { top: pre.scrollTop, atBottom: pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40 }
      : null;

    // Keyed by workspace rather than passed positionally: `/api/work` sends the
    // advocates as their own list, and only some workspaces have one.
    const advocates = new Map((state.data.advocates || []).map((a) => [a.workspace, a]));
    const cards =
      (state.data.workspaces || []).map((w) => workspaceHtml(w, advocates.get(w.name))).join('') +
      elsewhereHtml(state.data.elsewhere || []);
    out.innerHTML = cards || '<div class="empty">No workspaces configured.</div>';

    const next = out.querySelector('[data-session-log]');
    if (next) {
      next.scrollTop = !pane || pane.atBottom ? next.scrollHeight : pane.top;
    } else if (state.session != null) {
      // The session you were watching has exited, and its row went with it. Stop
      // tailing a pane that is no longer on the page.
      state.session = null;
      state.logText = '';
    }
    window.scrollTo(0, scrollY);
  }

  /**
   * Tail the open session's transcript.
   *
   * Written straight into the `<pre>` rather than through render(): the cards have
   * not changed just because a session typed another line, and rebuilding them twice
   * a second to find out would be absurd.
   */
  async function pollLog() {
    const pid = state.session;
    if (pid == null) return;
    let text;
    try {
      const res = await fetch(`/api/session-log?pid=${encodeURIComponent(pid)}`, {
        headers: { 'x-beadcause-token': token },
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      text =
        (data.lines || []).join('\n') ||
        // Where it looked, so an empty pane says why it is empty rather than
        // implying the session has done nothing.
        (data.file ? `Nothing to show yet.\n${data.file}` : 'No transcript file for this session.');
    } catch (err) {
      text = `⚠ ${err.message}`;
    }
    // You closed it, or opened another, while this was in flight.
    if (state.session !== pid) return;
    state.logText = text;
    const pre = out.querySelector(`[data-session-log="${CSS.escape(String(pid))}"]`);
    if (!pre) return;
    const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
    pre.textContent = text;
    // Follow the tail only if you were already at the bottom, so scrolling back to
    // read something isn't yanked away by the next line.
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  }

  /* One card, one session. Folding a card closes the session inside it: its pane
     belongs to a row that is about to be hidden, and a pane left "open" behind a
     fold would reappear on its own when you came back. */
  out.addEventListener('click', (ev) => {
    const toggle = ev.target.closest('[data-card]');
    if (toggle) {
      const key = toggle.dataset.card;
      state.card = state.card === key ? null : key;
      state.session = null;
      state.logText = '';
      return render();
    }
    const row = ev.target.closest('[data-session]');
    if (row) {
      const pid = Number(row.dataset.session);
      state.session = state.session === pid ? null : pid;
      state.logText = '';
      render();
      // Don't make you wait two seconds for the first line.
      if (state.session != null) pollLog();
    }
  });

  async function load() {
    pulse.classList.add('busy');
    try {
      const res = await fetch('/api/work', { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      state.data = await res.json();
      // Which daemon this is. The sessions listed below belong to the Mac, not to
      // this instance, so without the badge an observer looks exactly like the one
      // that opened them.
      observing.hidden = !state.data.observing;
      if (state.first) {
        state.first = false;
        // Unfold the busiest card, which is the first one — arriving at six closed
        // headings would make the fold cost a tap on every visit for no reason.
        state.card =
          (state.data.workspaces || []).find((w) => w.working.length || (w.sessions || []).length)?.name || null;
      }
      render();
    } catch (err) {
      out.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
    } finally {
      pulse.classList.remove('busy');
    }
  }

  /**
   * Pause, resume, or free an advocate's slots.
   *
   * The failure is written into the button rather than thrown away: this is the
   * one control on the page that changes what the Mac will do next, and a tap that
   * silently did nothing would leave you unsure whether the advocate is stopped.
   */
  async function control(ws, action, btn) {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      const res = await fetch('/api/advocate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify({ workspace: ws, action }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await load();
    } catch (err) {
      btn.textContent = was;
      btn.disabled = false;
      btn.closest('.adv')?.insertAdjacentHTML('beforeend', `<div class="adv-note bad">${esc(err.message)}</div>`);
    }
  }

  out.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-adv]');
    if (!btn) return;
    e.preventDefault();
    control(btn.dataset.ws, btn.dataset.adv, btn);
  });

  // The sessions view has no selection to publish — being here is the whole report.
  window.beadcause?.presence?.report({ view: 'sessions' });

  document.getElementById('work-refresh').addEventListener('click', load);
  // Cheap enough to keep current, expensive enough not to poll like the inbox:
  // two `bd` calls per workspace, about two seconds for six.
  setInterval(load, REFRESH_MS);
  setInterval(() => {
    if (state.session != null) pollLog();
  }, LOG_MS);

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    load();
  }
})();
