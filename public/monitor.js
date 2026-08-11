/* The advocate console — what every repo's advocate is doing, and why.
 *
 * bin/monitor.js gave each advocate one line: a workspace name, one state word, and
 * up to three bead ids. Behind that line sits a 929-line subsystem that surveys a
 * tracker, opens sessions, gives up on beads, argues for new ones, archives what its
 * sessions did to a git ref and sweeps the worktrees they left. None of that was
 * visible anywhere, so an advocate holding off for a perfectly good reason and an
 * advocate that had quietly broken looked identical.
 *
 * This page is the whole of `advocates.snapshot()` laid out per repo, plus the three
 * things the snapshot can only point at: the survey agent's live transcript, the
 * proposals waiting on you, and the session logs it pushed to refs.
 *
 * **It is also the sessions view.** `/sessions` was a second page over the same
 * `/api/work` payload — the same card per repo, the same claimed beads, the same live
 * `claude` rows, one advocate state line each — and every question it answered is
 * answered here, per repo, which is the way you actually arrive: "what is running" is
 * nearly always "what is running *in this repo*". The one thing it had that this page
 * did not was somewhere for a session row to go, and that stopped being true when the
 * detail moved out to `/session?pid=` and every list in the app got the same link. So
 * `/sessions`, `/work` and `/work.html` all serve this page now, and public/work.js is
 * gone.
 *
 * **It reads and it does not instrument.** Everything here comes from endpoints the
 * daemon already served — `/api/work`, `/api/questions`, `/api/advocate-log`,
 * `/api/session-archive` — and the only writes are the ones you press: the advocate
 * controls and answering a proposal. That is the property bin/monitor.js's header
 * claimed and it is worth keeping: a console wedged on a slow request must never
 * cost the daemon a question.
 *
 * Two disciplines carried over from the page it absorbed, because they are what make
 * this one honest rather than merely full:
 *
 *   - **A worker is a window we opened, not a process we can see.** The rows say what
 *     is actually known — the bead, when it opened, whether it was ever claimed — and
 *     name a pid only where the session took the bead id into its own name.
 *   - **A held-off advocate is drawn, never hidden.** Paused, quiet, cooling down and
 *     out-of-slots each say so in full, because an advocate you cannot see is
 *     indistinguishable from a repo with nothing left to do.
 *
 * Every session listed here — a worker row whose window is still running, a "Claude
 * sessions" row, an Elsewhere row — links to `/session?pid=…`, the same detail the
 * mirror sends you to, and it opens in the drawer over this console. The rows on this
 * page used to be inert `<div>`s, and the detail behind them existed in exactly one
 * place: folded inline under the row on /sessions. Giving every row the one address is
 * what made that page a strict duplicate of this one, and so what let it go. See
 * public/session.js.
 */
(() => {
  'use strict';

  /**
   * The same `?t=` pickup the inbox does, and this page needs it more.
   *
   * scripts/open-monitor.sh opens this at login in whatever browser is default, and
   * that profile may never have been paired — it is a Mac window, not the phone that
   * scanned the QR. Taking the token from the URL means the login window works the
   * first time; stripping it afterwards keeps it out of the address bar and out of
   * the history entry.
   */
  const token = (() => {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    return localStorage.getItem('beadcause.token') || '';
  })();

  const out = document.getElementById('mon');
  const pulse = document.getElementById('pulse');
  const tally = document.getElementById('tally');
  const observing = document.getElementById('observing');

  /* Three `bd` calls per workspace behind /api/work, so this refreshes on a timer
     rather than streaming. The transcript poll below is the fast one — a file read. */
  const REFRESH_MS = 20000;
  const LOG_MS = 2500;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** How long it has been going — the number that tells you it is stuck. */
  function age(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  }

  /**
   * "surveyed 14m ago" — the past-tense form, for the timeline in the card foot.
   *
   * `age` already returns a whole phrase for the first minute, so "just now" takes no
   * "ago" after it. Everything else is a bare duration and needs one.
   */
  function ago(iso, verb) {
    if (!iso) return `never ${verb}`;
    const a = age(iso);
    return `${verb} ${esc(a)}${a === 'just now' ? '' : ' ago'}`;
  }

  const graphUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;

  /** The one address a session has anywhere in the app — see public/session.js. */
  const sessionUrl = (pid) => `/session?pid=${encodeURIComponent(pid)}`;

  const P_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];

  /* --------------------------------------------------------------------- state */

  /**
   * Which sections you had open, kept across refreshes and across reloads.
   *
   * The page repaints every twenty seconds and after every control press. A
   * transcript that collapsed under you mid-read would make the one panel worth
   * watching the one panel you cannot watch.
   */
  const state = {
    work: null,
    proposals: new Map(), // workspace → [question]
    logs: new Map(), // workspace → { lines, running }
    archives: new Map(), // workspace → { bead, ref, sessions } or { text }
    open: new Set(readOpen()),
    picks: new Map(), // question key → Map(1-based bead index → 'yes' | 'no')
    error: null,
  };

  function readOpen() {
    try {
      return JSON.parse(localStorage.getItem('beadcause.mon.open') || '[]');
    } catch {
      return [];
    }
  }

  const isOpen = (key) => state.open.has(key);

  function toggle(key) {
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    localStorage.setItem('beadcause.mon.open', JSON.stringify([...state.open]));
  }

  const picksFor = (key) => {
    if (!state.picks.has(key)) state.picks.set(key, new Map());
    return state.picks.get(key);
  };

  /**
   * Is there a process behind this pid *in the payload we are drawing*?
   *
   * Only the worker rows need to ask. A session row came out of `sessions` and is live
   * by construction; a worker's `pid` is whatever the last advocate tick found by
   * matching a session name against the bead id, and the window may have gone since.
   * So a worker with a live pid goes to `/session?pid=…` and one without keeps its bead
   * link, which is the one honest thing left to point at.
   */
  function livePid(pid) {
    if (pid == null || pid === '') return false;
    const want = Number(pid);
    if (!Number.isInteger(want) || want <= 0 || !state.work) return false;
    return (
      (state.work.elsewhere || []).some((s) => s.pid === want) ||
      (state.work.workspaces || []).some((w) => (w.sessions || []).some((s) => s.pid === want))
    );
  }

  /**
   * A live `claude` process, wherever on this page it is listed.
   *
   * One function for what used to be three near-identical blocks — the "other work in
   * this repo" section, a repo with no advocate, and the Elsewhere card — because they
   * had drifted into three slightly different rows for the same thing, and because
   * making a row a link to somewhere was exactly the change that must not be made in
   * two of three places.
   */
  function sessionRow(s) {
    // The label names the session as well as the destination: `aria-label` replaces the
    // row's text outright, so one saying only "what pid 30342 is doing" would take the
    // session's own name away from the reader who needs it most.
    return `<a class="work-row session-row" href="${esc(sessionUrl(s.pid))}" aria-label="${esc(
      s.name || `pid ${s.pid}`
    )} — what it is doing">
      <span class="work-phase">${s.status === 'busy' ? '<span class="spark"></span>' : '○'}</span>
      <span class="work-main">
        <span class="work-title">${esc(s.name || '(unnamed session)')}</span>
        <span class="work-sub">${esc(s.where || s.cwd)} · pid ${esc(s.pid)}${
          s.status ? ` · ${esc(s.status)}` : ''
        }</span>
      </span>
      <time>${esc(age(s.at))}</time>
    </a>`;
  }

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

  /* ------------------------------------------------------------------- pieces */

  /**
   * One line for what the advocate is doing right now, in the order that decides it.
   *
   * The order matters and mirrors `tickOne`: an error beats everything because a
   * tracker it cannot read makes every other field stale; paused beats quiet because
   * you set it; quiet beats the queue because it explains a queue that isn't moving.
   */
  function stateOf(a) {
    if (a.error) return { text: `cannot read the tracker — ${a.error}`, tone: 'bad' };
    if (a.paused) return { text: `paused · ${plural(a.queue, 'bead')} ready`, tone: 'held' };
    if (a.quiet) return { text: `quiet hours · watching, not launching`, tone: 'held' };
    if (a.surveying) return { text: 'surveying for work worth proposing', tone: 'live' };
    if (a.workers.length) return { text: `${a.workers.length} of ${plural(a.limit, 'session')}`, tone: 'live' };
    if (a.queue) return { text: `${plural(a.queue, 'bead')} ready, none picked up`, tone: 'warn' };
    return { text: 'clear — no ready beads', tone: '' };
  }

  /**
   * How many sessions this advocate may open at once — and the way to change it.
   *
   * The number it steps is `limit`, the same field the chip above quotes, and pressing
   * a button changes it on the running daemon: no config edit, no restart. So the
   * control has to be honest about three things a plain `−  3  +` would hide:
   *
   * - **the range**, which is the daemon's `MAX_WORKERS_CEILING` and travels in the
   *   snapshot rather than being written here. An end of the range is a *disabled*
   *   button, not one that silently does nothing;
   * - **what it costs**, which is why the title says the number is windows on this
   *   Mac. Nine sessions is a decision, not a slider position;
   * - **the cap it cannot argue with.** `globalMaxWorkers` is a total across every
   *   advocate, so a repo stepped to 5 under a global 3 will still only get 3. The
   *   press worked and the number is real — it is the *other* number that is binding,
   *   and saying so is the difference between a control that looks broken and one
   *   that explains itself. `tickOne` writes the same sentence into the note once it
   *   is actually blocked; this says it the moment you press, which is when you are
   *   looking.
   */
  function limitStepper(a) {
    const key = esc(a.workspace);
    const ceiling = a.ceiling || 9;
    const step = (delta, label, title, off) =>
      `<button class="adv-btn adv-step" data-adv="limit" data-ws="${key}" data-value="${a.limit + delta}" title="${esc(
        title
      )}"${off ? ' disabled' : ''}>${label}</button>`;
    return `<span class="adv-limit${a.globalHeld ? ' held' : ''}" title="${esc(
      a.globalHeld
        ? `${a.limit} sessions at once — but globalMaxWorkers is ${a.globalMax} across every advocate, so this repo will not get more than that`
        : `How many sessions this advocate may open at once — one iTerm window each, on this Mac`
    )}">
      ${step(-1, '−', 'One fewer session at a time', a.limit <= 1)}
      <b>${a.limit}</b>
      ${step(1, '+', `One more session at a time (up to ${ceiling})`, a.limit >= ceiling)}
    </span>`;
  }

  /**
   * The repo the advocate is arguing for, and how much of it is its business.
   *
   * This is the "relates to its domain" half. The tracker's own numbers come first,
   * then the two that say what this advocate can actually act on: `queue` is what it
   * would take (ready, minus questions, minus held, minus anything under the priority
   * floor), and `deferredByPriority` is the part of `ready` it is deliberately leaving
   * alone. The difference between "4 ready" and "4 ready, 3 of them below the floor" is
   * the difference between an advocate that is idle and one that is behaving as told.
   *
   * `heldByChildren` is the third such subtraction, and it earns a pill for the same
   * reason: an epic whose children are the work is ready by bd's reckoning and not by
   * the advocate's, so without this the queue is one shorter than `bd ready` says and
   * nothing on screen accounts for the difference. Its `why` goes in the tooltip —
   * the pill is the number, "bc-3zo9.1 is ready under it" is the answer to the
   * question the number provokes.
   */
  function domainHtml(w, a) {
    const c = w?.counts || {};
    const waiting = (a && a.heldByChildren) || [];
    const pills = [
      c.open != null ? `<span class="pill">${c.open} open</span>` : '',
      c.ready ? `<span class="pill">${c.ready} ready</span>` : '',
      // Ready in every way but the one that counts — see lib/endorse.js. It sits next to
      // `ready` because it is the part of the tracker's own ready number that has been
      // taken out of it, and an unexplained gap between the two reads as a bug.
      c.held ? `<span class="pill muted">${c.held} held for endorsement</span>` : '',
      c.inProgress ? `<span class="pill on">${c.inProgress} in progress</span>` : '',
      c.blocked ? `<span class="pill p1">${c.blocked} blocked</span>` : '',
      a && a.queue ? `<span class="pill mine">${a.queue} for the advocate</span>` : '',
      a && a.deferredByPriority
        ? `<span class="pill muted">${a.deferredByPriority} below the priority floor</span>`
        : '',
      waiting.length
        ? `<span class="pill muted" title="${esc(waiting.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${waiting.length} waiting on ${waiting.length === 1 ? 'its children' : 'their children'}</span>`
        : '',
    ].filter(Boolean);
    return `<div class="mon-domain">${pills.join('')}</div>`;
  }

  /** A collapsible section. `count` sits in the summary so a shut panel still counts. */
  function section(key, title, count, body, { tone = '', badge = '' } = {}) {
    const open = isOpen(key);
    return `<div class="mon-sec${open ? ' open' : ''}">
      <button class="mon-sum" data-toggle="${esc(key)}" aria-expanded="${open}">
        <span class="mon-caret" aria-hidden="true">▾</span>
        <span class="mon-sum-title">${esc(title)}</span>
        ${count ? `<span class="mon-n${tone ? ` ${tone}` : ''}">${esc(count)}</span>` : ''}
        ${badge}
      </button>
      ${open ? `<div class="mon-body">${body}</div>` : ''}
    </div>`;
  }

  /**
   * One session the advocate opened.
   *
   * Everything on this row is something we know rather than something we inferred.
   * `ended` is the session's own word for it — the command writes its exit status to
   * a file before the window closes — and it is worth its own chip, because "opened,
   * never claimed, and the window is gone" is the state that costs the bead an
   * attempt and is otherwise invisible until the row disappears.
   */
  function workerRow(a, w) {
    const chips = [
      w.claimed ? '<span class="tag ok">claimed</span>' : '<span class="tag">not claimed yet</span>',
      w.ended ? '<span class="tag warn">the window has exited</span>' : '',
      // Where a reclaim got to. Asked and unanswered is the state worth seeing: the
      // clock is running on that slot, and the row is the only place it shows.
      w.asked ? `<span class="tag warn">asked to check in ${esc(age(w.asked))} ago</span>` : '',
      w.checkedInAt
        ? `<span class="tag ok">checked in ${esc(age(w.checkedInAt))} ago${
            w.checkinNote ? ` · ${esc(w.checkinNote)}` : ''
          }</span>`
        : '',
      w.sessionStatus ? `<span class="tag">${esc(w.sessionStatus)}</span>` : '',
      w.pid ? `<span class="tag dim">pid ${esc(w.pid)}</span>` : '',
      w.attempt > 1 ? `<span class="tag warn">attempt ${esc(w.attempt)}</span>` : '',
      // Nothing to address, so Reclaim cannot ask about this one — it will free the
      // slot on your word alone, the way the old button did. Says so rather than
      // looking identical to a window that answers.
      w.reachable === false ? '<span class="tag dim">no window handle</span>' : '',
    ].filter(Boolean);
    // Where the pid names a process that is still running, the row goes to that
    // session's own detail — the transcript is the answer to "is this moving", and it is
    // why you were reading this section. Where it does not, the bead stays the
    // destination: a worker whose window has exited has no session to show, and
    // `/session?pid=…` for a dead pid is a 404, which is a worse row than the one it
    // replaced.
    const live = livePid(w.pid);
    return `<a class="work-row adv-worker" href="${esc(live ? sessionUrl(w.pid) : graphUrl(a.workspace, w.id))}">
      <span class="work-phase">${w.claimed && !w.ended ? '<span class="spark"></span>' : w.ended ? '◍' : '◔'}</span>
      <span class="work-main">
        <span class="work-title">${esc(w.title || w.id)}</span>
        <span class="work-sub"><span class="pill id">${esc(w.id)}</span>${chips.join('')}</span>
      </span>
      <time>${esc(age(w.at))}</time>
    </a>`;
  }

  /**
   * A window whose bead is closed and whose process is still up.
   *
   * Deliberately not a `workerRow`: the slot is already back, the bead is already
   * closed, and the only live question is whether the window has taken its signal
   * yet. Links to the session rather than the bead for the same reason — the bead has
   * nothing left to say and the process is the thing that is still there.
   */
  function closingRow(c) {
    return `<a class="work-row adv-worker" href="${esc(sessionUrl(c.pid))}">
      <span class="work-phase">◍</span>
      <span class="work-main">
        <span class="work-title">${esc(c.title || c.id)}</span>
        <span class="work-sub"><span class="pill id">${esc(c.id)}</span>
          <span class="tag dim">pid ${esc(c.pid)}</span>
          ${c.signalled ? '<span class="tag warn">signalled</span>' : '<span class="tag">waiting for it to settle</span>'}
        </span>
      </span>
      <time>${esc(age(c.at))}</time>
    </a>`;
  }

  /**
   * What it would pick up next, in the order it would take it.
   *
   * Always drawn, including while sessions are open — public/work.js hides this the
   * moment anything is running, which is exactly when "and then what" is the question
   * you have. The note underneath is the advocate's own sentence about why the head
   * of this list has not been started yet.
   */
  function nextHtml(a) {
    if (!a.next?.length) {
      return `<p class="subtitle">Nothing ready. ${
        a.lastProposalAt ? `Last asked you about new work ${esc(age(a.lastProposalAt))} ago.` : 'It has never proposed any.'
      }</p>`;
    }
    const rows = a.next
      .map(
        (b, i) => `<a class="work-row mon-next-row" href="${esc(graphUrl(a.workspace, b.id))}">
          <span class="work-phase mon-rank">${i + 1}</span>
          <span class="work-main">
            <span class="work-title">${esc(b.title)}</span>
            <span class="work-sub"><span class="pill id">${esc(b.id)}</span><span class="tag">${esc(
              P_LABEL[b.priority] ?? `P${b.priority}`
            )}</span><span class="tag dim">${esc(b.type)}</span></span>
          </span>
          <time>${esc(age(b.createdAt))}</time>
        </a>`
      )
      .join('');
    const more = a.queue > a.next.length ? `<p class="subtitle">…and ${a.queue - a.next.length} more in the queue.</p>` : '';
    return rows + more;
  }

  /**
   * The survey agent thinking out loud.
   *
   * The one panel here that is not a report of state: it is the live transcript of
   * the read-only agent that decides whether there is any work worth proposing —
   * every `bd` call and every file it reads. When an advocate does something you did
   * not expect, this is where the reason is, so it is polled while it is open and
   * force-opened while the agent is actually running.
   */
  function thinkingHtml(a) {
    const log = state.logs.get(a.workspace);
    if (!log) return '<p class="subtitle">Loading the transcript…</p>';
    if (!log.lines?.length) {
      return `<p class="subtitle">Nothing logged yet. The advocate writes here when it surveys for work to propose — ${
        a.lastProposalAt ? `it last did that ${esc(age(a.lastProposalAt))} ago.` : 'it has not done that yet.'
      }</p>`;
    }
    return `<pre class="agent-log mon-log">${esc(log.lines.join('\n'))}</pre>`;
  }

  /**
   * The beads it wants to file, each with its own yes and no.
   *
   * An advocate may work what exists without asking; filing something *for* you makes
   * you answerable for an idea an agent had, so nothing is created until you press it.
   * The full text of each bead is here — description, done-when, and the advocate's
   * argument for why your tracker should carry it — because a title and two buttons
   * is precisely what makes a suggestion impossible to judge.
   */
  function proposalHtml(q) {
    const beads = q.proposal?.beads || [];
    const picks = picksFor(q.key);
    const rows = beads
      .map((b, i) => {
        const n = i + 1;
        const pick = picks.get(n) || '';
        return `<div class="mon-bead${pick ? ` picked-${pick}` : ''}">
          <div class="mon-bead-head">
            <span class="mon-rank">${n}</span>
            <strong>${esc(b.title)}</strong>
            <span class="tag">${esc(P_LABEL[b.priority] ?? `P${b.priority}`)}</span>
            <span class="tag dim">${esc(b.type)}</span>
          </div>
          ${b.description ? `<p class="mon-bead-body">${esc(b.description)}</p>` : ''}
          ${b.acceptance ? `<p class="mon-bead-meta"><strong>Done when:</strong> ${esc(b.acceptance)}</p>` : ''}
          ${b.rationale ? `<p class="mon-bead-meta why">Why: ${esc(b.rationale)}</p>` : ''}
          ${b.deps?.length ? `<p class="mon-bead-meta"><strong>Depends on:</strong> ${esc(b.deps.join(', '))}</p>` : ''}
          <div class="mon-bead-acts">
            <button class="adv-btn${pick === 'yes' ? ' on' : ''}" data-pick="yes" data-key="${esc(q.key)}" data-n="${n}">Create</button>
            <button class="adv-btn${pick === 'no' ? ' on danger' : ''}" data-pick="no" data-key="${esc(q.key)}" data-n="${n}">Decline</button>
          </div>
        </div>`;
      })
      .join('');

    const approved = [...picks.entries()].filter(([, v]) => v === 'yes').length;
    const undecided = beads.length - picks.size;
    return `<div class="mon-proposal" data-key="${esc(q.key)}">
      <div class="mon-prop-head">
        <span class="pill id">${esc(q.id)}</span>
        <span class="mon-prop-title">${esc(q.title)}</span>
        <time>${esc(age(q.createdAt))}</time>
      </div>
      ${rows}
      <div class="mon-prop-foot">
        <button class="adv-btn" data-pick-all="yes" data-key="${esc(q.key)}">All</button>
        <button class="adv-btn" data-pick-all="no" data-key="${esc(q.key)}">None</button>
        <span class="mon-prop-count">${
          undecided ? `${plural(undecided, 'bead')} undecided` : `${approved} of ${beads.length} to create`
        }</span>
        <button class="adv-btn primary" data-submit="${esc(q.key)}"${undecided ? ' disabled' : ''}>${
          approved ? `Create ${approved}` : 'Decline all'
        }</button>
      </div>
    </div>`;
  }

  /**
   * What its finished sessions left behind.
   *
   * Three separate facts that all answer "and then what happened": the session log
   * pushed to `refs/beadcause/session/<bead>`, the archived branches still waiting to
   * reach main, and the last worktree sweep. None of them had ever been rendered
   * anywhere — the archive ref in particular is a session's entire record of itself.
   */
  function landedHtml(a) {
    const arc = state.archives.get(a.workspace);
    const parts = [];

    if (a.archive) {
      parts.push(`<div class="work-row mon-plain">
        <span class="work-phase">⎘</span>
        <span class="work-main">
          <span class="work-title">Archived ${esc(a.archive.bead)} — ${plural(a.archive.commits, 'commit')}</span>
          <span class="work-sub"><code>${esc(a.archive.ref)}</code></span>
        </span>
        <button class="adv-btn" data-archive="${esc(a.workspace)}" data-bead="${esc(a.archive.bead)}">Read</button>
      </div>`);
    }
    if (a.pendingNotes) {
      parts.push(
        `<p class="subtitle">${plural(
          a.pendingNotes,
          'archived session'
        )} whose branch has not reached main yet — the landing gets noted when it does.</p>`
      );
    }
    if (a.tidy?.summary) {
      parts.push(`<div class="adv-note">🧹 ${esc(a.tidy.summary)} <span class="dim">· ${esc(age(a.tidy.at))} ago</span></div>`);
    }
    // Beads closed because their pull request merged on github.com — the daemon writing
    // to the tracker on its own, which otherwise shows up nowhere but a log file.
    if (a.landed?.summary) {
      parts.push(`<div class="adv-note">🔀 ${esc(a.landed.summary)} <span class="dim">· ${esc(age(a.landed.at))} ago</span></div>`);
    }
    if (arc?.error) parts.push(`<div class="adv-note bad">${esc(arc.error)}</div>`);
    if (arc?.sessions?.length) {
      parts.push(
        `<div class="mon-arc-list">${arc.sessions
          .map(
            (s) =>
              `<button class="mon-arc-row" data-read="${esc(a.workspace)}" data-commit="${esc(s.commit)}">
                <span>${esc(s.subject)}</span><time>${esc(age(s.at))}</time>
              </button>`
          )
          .join('')}</div>`
      );
    }
    if (arc?.text != null) parts.push(`<pre class="agent-log mon-log">${esc(arc.text)}</pre>`);

    return parts.length ? parts.join('') : '<p class="subtitle">Nothing archived or swept yet.</p>';
  }

  /* -------------------------------------------------------------------- cards */

  function advocateCard(w, a, proposals) {
    const st = stateOf(a);
    const key = a.workspace;
    const sessions = w?.sessions || [];
    // Beads claimed in this repo that the advocate did not open a window on: your
    // own sessions. Kept separate rather than merged — nothing records which process
    // is on which bead, and the advocate only knows about the windows it opened.
    const mine = new Set(a.workers.map((x) => x.id));
    const others = (w?.working || []).filter((x) => !mine.has(x.id));

    const controls = [
      limitStepper(a),
      `<button class="adv-btn" data-adv="${a.paused ? 'resume' : 'pause'}" data-ws="${esc(key)}">${
        a.paused ? 'Resume' : 'Pause'
      }</button>`,
      // Not "free slots" any more, because it no longer just frees them: it asks each
      // open session whether it is still working and takes back only the slots whose
      // window has gone. The label is the promise — a button called "free slots" that
      // sometimes keeps them all would be worse than either behaviour.
      a.workers.length
        ? `<button class="adv-btn" data-adv="reclaim" data-ws="${esc(key)}" title="Ask each open session whether it is still working. Windows that have gone give their slots back; the rest keep them and are asked to check in or finish.">Reclaim sessions</button>`
        : '',
      // Clears the attempt counters, so beads it gave up on are eligible again. Only
      // offered when it has actually given up on something — otherwise it is a button
      // that does nothing and reads as though it might.
      `<button class="adv-btn" data-adv="forget" data-ws="${esc(key)}" title="Clear attempt counters so beads it gave up on are eligible again">Forget attempts</button>`,
    ]
      .filter(Boolean)
      .join('');

    const secs = [
      section(
        `${key}:work`,
        'Working now',
        a.workers.length ? `${a.workers.length}/${a.limit}` : `0/${a.limit}`,
        a.workers.length
          ? a.workers.map((x) => workerRow(a, x)).join('')
          : '<p class="subtitle">No sessions open from this advocate.</p>',
        { tone: a.workers.length ? 'live' : '' }
      ),
      // Only drawn when there is one, and there usually is not: a window sits here for
      // the grace period and then goes. It is the one state where the advocate is
      // about to signal a process, and a number that appears and clears within a
      // minute or two is how you see the thing working without reading the log.
      (a.closing || []).length
        ? section(
            `${key}:closing`,
            'Closing',
            String(a.closing.length),
            a.closing.map(closingRow).join(''),
            { tone: 'warn' }
          )
        : '',
      section(`${key}:next`, 'Up next', a.queue ? String(a.queue) : '', nextHtml(a), { tone: a.queue ? 'warn' : '' }),
      section(`${key}:log`, 'Thinking', '', thinkingHtml(a), {
        badge: a.surveying ? '<span class="tag live"><span class="spark"></span>live</span>' : '',
      }),
      proposals.length
        ? section(
            `${key}:prop`,
            'Waiting on you',
            String(proposals.reduce((n, q) => n + (q.proposal?.beads?.length || 0), 0)),
            proposals.map(proposalHtml).join(''),
            { tone: 'warn' }
          )
        : '',
      section(`${key}:landed`, 'Landed & tidied', a.archive ? plural(a.archive.commits, 'commit') : '', landedHtml(a)),
      others.length || sessions.length
        ? section(
            `${key}:else`,
            'Other work in this repo',
            String(others.length + sessions.length),
            (others.length
              ? `<div class="session-label">Claimed beads <span>Not opened by the advocate.</span></div>` +
                others
                  .map(
                    (x) => `<a class="work-row" href="${esc(graphUrl(key, x.id))}">
                      <span class="work-phase">${x.icon ? esc(x.icon) : '◗'}</span>
                      <span class="work-main">
                        <span class="work-title">${esc(x.title)}</span>
                        <span class="work-sub"><span class="pill id">${esc(x.id)}</span>${esc(x.actor || '')}${
                          x.phase ? ` · ${esc(x.phase)}` : ''
                        }${x.detail ? ` — ${esc(x.detail)}` : ''}</span>
                      </span>
                      <time>${esc(age(x.since))}</time>
                    </a>`
                  )
                  .join('')
              : '') +
              (sessions.length
                ? `<div class="session-label">Claude sessions <span>${
                    others.length ? 'Which is on which bead is not recorded.' : 'Nothing claimed in the tracker.'
                  }</span></div>` + sessions.map(sessionRow).join('')
                : '')
          )
        : '',
    ]
      .filter(Boolean)
      .join('');

    // The note is the advocate's own sentence for why it is doing what it is doing.
    // Dropped when it merely restates the chip — both are written by the same tick.
    const note = a.note && !st.text.toLowerCase().includes(a.note.toLowerCase().split(/[ ·—]/)[0]) ? a.note : '';

    return `<article class="card work-card mon-card${a.error ? ' bad' : ''}" data-ws="${esc(key)}">
      <div class="work-head">
        <h2>${esc(key)}</h2>
        <span class="mon-state ${st.tone}">${esc(st.text)}</span>
        <span class="adv-actions">${controls}</span>
      </div>
      ${domainHtml(w, a)}
      ${note ? `<div class="adv-note">${esc(note)}</div>` : ''}
      ${
        // A limit the global cap will not honour. Said here rather than left to the
        // note, because the note only appears once a tick has actually been blocked
        // — which can be half an hour after the press that caused it, and until then
        // the stepper reads as though 5 were in force when 3 is.
        a.globalHeld
          ? `<div class="adv-note warn">Held by globalMaxWorkers (${a.globalMax}) — that is a total across every advocate, so this repo will not open more than ${a.globalMax} at once whatever its own limit says.</div>`
          : ''
      }
      ${
        // The workspace's own error, and only when it is not the advocate's error
        // said twice. They are separate facts — the advocate holds its last failure
        // in memory, /api/work asks bd afresh — and usually the same sentence.
        w?.error && w.error !== a.error ? `<div class="adv-note bad">⚠ ${esc(w.error)}</div>` : ''
      }
      ${secs}
      <div class="work-foot">
        <div class="meta mon-times">${[
          ago(a.lastSurveyAt, 'surveyed'),
          ago(a.lastLaunchAt, 'launched'),
          ago(a.lastProposalAt, 'proposed'),
        ].join(' · ')}</div>
        <a class="work-graph" href="${esc(graphUrl(key))}">Graph →</a>
      </div>
    </article>`;
  }

  /**
   * A workspace with no advocate at all.
   *
   * Drawn, and drawn plainly, because "this repo has nobody arguing for it" is a
   * fact about the domain and not an absence of one. `advocatedWorkspaces` filters on
   * config and on the space's own `advocate: false`, and neither is visible from here
   * — so the card says what is true and stops short of guessing which it was.
   */
  function plainCard(w) {
    const sessions = w.sessions || [];
    return `<article class="card work-card mon-card plain">
      <div class="work-head">
        <h2>${esc(w.name)}</h2>
        <span class="mon-state dim">no advocate</span>
      </div>
      ${domainHtml(w, null)}
      ${w.error ? `<div class="adv-note bad">⚠ ${esc(w.error)}</div>` : ''}
      ${(w.working || [])
        .map(
          (x) => `<a class="work-row" href="${esc(graphUrl(w.name, x.id))}">
            <span class="work-phase">${x.icon ? esc(x.icon) : '◗'}</span>
            <span class="work-main">
              <span class="work-title">${esc(x.title)}</span>
              <span class="work-sub"><span class="pill id">${esc(x.id)}</span>${esc(x.actor || '')}</span>
            </span>
            <time>${esc(age(x.since))}</time>
          </a>`
        )
        .join('')}
      ${sessions.map(sessionRow).join('')}
      <div class="work-foot">
        <div class="meta"></div>
        <a class="work-graph" href="${esc(graphUrl(w.name))}">Graph →</a>
      </div>
    </article>`;
  }

  /**
   * What launchd is running — the line that would have caught the three-day bug.
   *
   * bin/router.js landed, the installer was updated to point the LaunchAgent at it,
   * and the plist in ~/Library/LaunchAgents went on naming bin/beadcause.js. Every
   * deploy kickstarted that label, the port answered every request, and the hot-swap
   * had never once run. The detection existed within a day — a banner at daemon
   * startup and a diagnosis on `npm run swap:status` — and both landed somewhere
   * nobody stands: launchd's log file, and a command you type only once you already
   * suspect something.
   *
   * This is the same verdict on a surface that gets looked at. Two shapes, because
   * they are two different jobs:
   *
   *   - **Fine** — one dim line, above the cards, saying which program launchd runs.
   *     It is here on a good day precisely so that its absence means nothing and its
   *     text means something. A health line you only ever see when broken teaches you
   *     to read "no line" as "healthy", which is exactly what the console said for
   *     three days while it was wrong.
   *   - **Not fine** — a loud block in the same place, with what launchd is actually
   *     running, why that means the hot-swap is not live, and the one command that
   *     fixes it, selectable so it can be copied off a phone.
   *
   * Inside `#mon` rather than beside it, so it hides with the advocates tab when the
   * mirror pane comes up over this one — see showTab in public/mirror.js.
   */
  function serviceHtml(svc) {
    if (!svc) return ''; // An older daemon behind a newer page: say nothing, invent nothing.
    if (svc.ok) {
      return `<div class="svc ok" title="${esc(svc.plist)}">
        <span class="svc-dot">✓</span>
        <span>launchd runs <code>${esc(svc.label || svc.program || 'nothing')}</code> — hot-swap live</span>
      </div>`;
    }
    return `<div class="svc bad">
      <div class="svc-head"><span class="svc-dot">⚠</span>HOT-SWAP IS NOT LIVE<span class="pill id">${esc(svc.code)}</span></div>
      ${
        // The headline fact, and the whole of the acceptance this was filed for. Only
        // when there is one: `not-installed` and `unreadable` have no program to name,
        // and the sentence below says which of the two it is.
        svc.label ? `<div class="svc-what">launchd runs <code>${esc(svc.label)}</code></div>` : ''
      }
      <div class="svc-line">${esc(svc.detail)}</div>
      ${
        svc.fix
          ? `<div class="svc-fix">${esc(svc.fixBefore || 'fix it:')} <code>${esc(svc.fix)}</code> ${esc(svc.fixAfter)}</div>`
          : ''
      }
      <div class="svc-foot">${esc(svc.plist)}</div>
    </div>`;
  }

  /**
   * And whether that program is serving anything — the line under the line above.
   *
   * The launchd line answers "is the right program running". This answers the question
   * that turned out to sit underneath it: a router can be the right program, hold the
   * port, pass every check launchd makes, and have *no backend behind it* — in which
   * case the phone gets a 503 and the only record is a log file. Twice in one evening a
   * build that was perfectly fine was condemned for being slow to start on a loaded Mac,
   * and stayed condemned, because "poisoned" made no distinction between a syntax error
   * and a busy machine.
   *
   * What this can show is the *degraded* half of that, and only that: serving a stale
   * build because the newer one died, or because it was too slow and is being retried.
   * A total outage is not visible from a page the daemon cannot serve — bin/router.js
   * answers that one itself, in the 503 body and in a push to the phone.
   *
   * Amber rather than red: the app is up and answering on all of these, which is a
   * different sentence from HOT-SWAP IS NOT LIVE above it, and colour is how you tell
   * "look at this soon" from "nothing you are reading is current".
   */
  function routerHtml(r) {
    if (!r) return ''; // start:bare, or an older daemon: say nothing, invent nothing.
    if (r.ok) {
      return `<div class="svc ok" title="${esc(r.disk || '')}">
        <span class="svc-dot">✓</span>
        <span>serving build <code>${esc(r.build || '?')}</code>${r.pid ? ` from pid ${esc(r.pid)}` : ''}</span>
      </div>`;
    }
    return `<div class="svc warn">
      <div class="svc-head"><span class="svc-dot">⚠</span>${
        r.serving ? 'THE PHONE IS ON AN OLDER BUILD' : 'NOTHING IS BEING SERVED'
      }<span class="pill id">${esc(r.code)}</span></div>
      <div class="svc-what">${esc(r.summary)}</div>
      ${r.detail ? `<div class="svc-line">${esc(r.detail)}</div>` : ''}
      ${r.fix ? `<div class="svc-fix">force it: <code>${esc(r.fix)}</code></div>` : ''}
      <div class="svc-foot">disk ${esc(r.disk || '?')}</div>
    </div>`;
  }

  /* ------------------------------------------------------------------- render */

  function render() {
    const data = state.work;
    if (!data) return;

    // Which daemon am I looking at? Two consoles side by side are otherwise
    // identical, and the one that acts is not the one you have been clicking.
    // `hidden` rather than absent text: the live instance must show nothing at all,
    // so a badge that failed to render can never be mistaken for "not observing".
    observing.hidden = !data.observing;
    observing.title = data.observing
      ? 'This instance watches and never acts: no sessions, proposals, worktree sweeps, session logs, reply agents or pushes.'
      : '';
    // Everything on this page belongs to one repo — an advocate, its workers, the
    // sessions it opened, the proposals it is waiting on — so the space picker in the
    // bar above filters the lot. See public/spacebar.js.
    const advocates = new Map(
      (data.advocates || []).filter((a) => inSpace(a.workspace)).map((a) => [a.workspace, a])
    );
    const spaces = (data.workspaces || []).filter((w) => inSpace(w.name));

    // Advocated repos first, and the busiest of those at the top: this page is about
    // the advocates, and a repo with three sessions open is why you opened it.
    const withAdv = spaces.filter((w) => advocates.has(w.name));
    const without = spaces.filter((w) => !advocates.has(w.name));
    withAdv.sort((x, y) => {
      const a = advocates.get(x.name);
      const b = advocates.get(y.name);
      return b.workers.length - a.workers.length || b.queue - a.queue || x.name.localeCompare(y.name);
    });

    // An advocate whose workspace vanished from /api/work still has state worth
    // showing — it is held in the daemon's memory, not in bd.
    const orphans = [...advocates.keys()].filter((n) => !spaces.some((w) => w.name === n));

    const cards =
      withAdv.map((w) => advocateCard(w, advocates.get(w.name), state.proposals.get(w.name) || [])).join('') +
      orphans.map((n) => advocateCard(null, advocates.get(n), state.proposals.get(n) || [])).join('') +
      without.map(plainCard).join('') +
      elsewhereHtml(data.elsewhere || []);

    // Above every card, including the "nothing configured" case: a daemon serving the
    // wrong program is the one thing you want said before anything it goes on to say
    // about the repos.
    // Empty because nothing is configured, or empty because you are looking at one
    // space and it has no advocates? The bar above is the fix for one of those and not
    // for the other, so the two do not share a sentence.
    const nothing = (data.workspaces || []).length
      ? `<div class="empty">Nothing in ${esc(window.beadcause?.space?.label?.() || 'this space')}.</div>`
      : '<div class="empty">No workspaces configured.</div>';
    out.innerHTML = serviceHtml(data.service) + routerHtml(data.router) + (cards || nothing);

    const live = [...advocates.values()].reduce((n, a) => n + a.workers.length, 0);
    // Over the selection, like everything else on the page: the proposals map holds
    // every workspace's, because the inbox sweep it comes from is not filtered.
    const waiting = [...state.proposals.entries()]
      .filter(([ws]) => inSpace(ws))
      .reduce((n, [, qs]) => n + qs.length, 0);
    tally.textContent = [live ? `${live} working` : '', waiting ? `${waiting} to answer` : '']
      .filter(Boolean)
      .join(' · ');
    tally.className = `mon-tally${waiting ? ' warn' : ''}`;
  }

  /** Is this repo in the selected space? See public/spacebar.js. */
  const inSpace = (workspace) => window.beadcause?.space?.matches?.(workspace) ?? true;

  function elsewhereHtml(sessions) {
    // A session outside every workspace is in no space, so it is out while one is
    // selected — `matches('')` is what decides that, in one place, for the whole app.
    if (!sessions.length || !inSpace('')) return '';
    return `<article class="card work-card mon-card plain">
      <div class="work-head"><h2>Elsewhere</h2><span class="mon-state dim">${esc(
        plural(sessions.length, 'session')
      )} outside every workspace</span></div>
      ${sessions.map(sessionRow).join('')}
    </article>`;
  }

  /* --------------------------------------------------------------------- load */

  async function load() {
    pulse.classList.add('busy');
    try {
      // Two requests, in parallel and independent: the proposals are ordinary inbox
      // questions, and a `bd` sweep that fails must not take the advocate state —
      // which is in memory and always available — down with it.
      const [work, questions] = await Promise.all([
        api('/api/work'),
        api('/api/questions?scope=human').catch(() => ({ questions: [] })),
      ]);
      state.work = work;
      // This page sweeps the inbox for the proposals, so it has the picker's numbers
      // for free — fresher than /api/spaces, which is one poll behind by design.
      const counts = {};
      for (const q of questions.questions || []) counts[q.workspace] = (counts[q.workspace] || 0) + 1;
      window.beadcause?.space?.adopt({
        spaces: questions.spaces,
        workspaces: questions.workspaces,
        counts,
        filter: questions.filter,
      });
      state.proposals = new Map();
      for (const q of questions.questions || []) {
        if (!q.proposal?.beads?.length) continue; // Every other question in the inbox.
        if (!state.proposals.has(q.workspace)) state.proposals.set(q.workspace, []);
        state.proposals.get(q.workspace).push(q);
      }
      state.error = null;
      render();
      pumpLogs();
    } catch (err) {
      state.error = err.message;
      out.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
    } finally {
      pulse.classList.remove('busy');
    }
  }

  /**
   * Fetch the transcript for every advocate whose panel is open, plus any that is
   * surveying right now.
   *
   * The second half is what makes the panel worth having: a survey runs for minutes
   * and finishes without you, so an advocate that starts thinking opens its own panel
   * rather than leaving the evidence to be found later.
   */
  async function pumpLogs() {
    const advocates = state.work?.advocates || [];
    const want = advocates.filter((a) => isOpen(`${a.workspace}:log`) || a.surveying);
    if (!want.length) return;
    let changed = false;
    await Promise.all(
      want.map(async (a) => {
        if (a.surveying && !isOpen(`${a.workspace}:log`)) {
          state.open.add(`${a.workspace}:log`);
          changed = true;
        }
        try {
          const log = await api(`/api/advocate-log?workspace=${encodeURIComponent(a.workspace)}`);
          const prev = state.logs.get(a.workspace);
          if (!prev || prev.lines.length !== log.lines.length || prev.running !== log.running) changed = true;
          state.logs.set(a.workspace, log);
        } catch {
          // A workspace that lost its advocate mid-poll 404s here. Nothing to say.
        }
      })
    );
    if (changed) {
      render();
      // Pin the transcript to its foot, the way a terminal does: this is a live log,
      // and the newest line is the one you are here for.
      for (const el of out.querySelectorAll('.mon-log')) el.scrollTop = el.scrollHeight;
    }
  }

  /* ------------------------------------------------------------------ actions */

  /** Pause, resume, free the slots, forget the attempt counters, or set the limit. */
  async function control(ws, action, btn, value) {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await api('/api/advocate', {
        method: 'POST',
        // `value` is sent as a number or not at all. A `"4"` string would be clamped
        // to the same 4 by the daemon, but the endpoint is the contract and a
        // stringly-typed count is the sort of thing that stays wrong quietly.
        body: JSON.stringify({ workspace: ws, action, ...(value == null ? {} : { value: Number(value) }) }),
      });
      await load();
    } catch (err) {
      btn.textContent = was;
      btn.disabled = false;
      btn.closest('.mon-card')?.insertAdjacentHTML('beforeend', `<div class="adv-note bad">${esc(err.message)}</div>`);
    }
  }

  /**
   * Answer a proposal: create the beads you picked, decline the rest.
   *
   * The sentence is for you and the array is for the server — the same split
   * public/app.js makes, and for the same reason: the numbers must not have to be
   * read back out of prose. Nothing is sent until every bead has a decision, which
   * is what the disabled submit enforces.
   */
  async function submitProposal(key, btn) {
    const q = (state.proposals.get(key.split('/')[0]) || []).find((x) => x.key === key);
    if (!q) return;
    const beads = q.proposal?.beads || [];
    const picks = picksFor(key);
    const approved = [...picks.entries()]
      .filter(([, v]) => v === 'yes')
      .map(([n]) => n)
      .sort((a, b) => a - b);
    const declined = beads.length - approved.length;
    const text = approved.length
      ? `CREATE: ${approved.join(',')} — filing ${approved.length} of ${plural(beads.length, 'proposed bead')}${
          declined ? `, declining ${declined}` : ''
        }.`
      : `Not now — none of the ${plural(beads.length, 'proposed bead')}.`;

    btn.disabled = true;
    btn.textContent = '…';
    try {
      await api('/api/respond', {
        method: 'POST',
        body: JSON.stringify({ workspace: q.workspace, id: q.id, response: text, ...(approved.length ? { create: approved } : {}) }),
      });
      state.picks.delete(key);
      await load();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      out.querySelector(`.mon-proposal[data-key="${CSS.escape(key)}"]`)
        ?.insertAdjacentHTML('beforeend', `<div class="adv-note bad">${esc(err.message)}</div>`);
    }
  }

  /** List the archived sessions for a bead, or read one of them back. */
  async function openArchive(ws, bead) {
    try {
      const arc = await api(`/api/session-archive?workspace=${encodeURIComponent(ws)}&id=${encodeURIComponent(bead)}`);
      state.archives.set(ws, arc);
    } catch (err) {
      state.archives.set(ws, { error: err.message });
    }
    render();
  }

  async function readArchived(ws, commit) {
    try {
      const one = await api(`/api/session-archive?workspace=${encodeURIComponent(ws)}&commit=${encodeURIComponent(commit)}`);
      state.archives.set(ws, { ...state.archives.get(ws), text: one.text });
    } catch (err) {
      state.archives.set(ws, { ...state.archives.get(ws), error: err.message });
    }
    render();
  }

  /* ------------------------------------------------------------------- events */

  out.addEventListener('click', (e) => {
    const sum = e.target.closest('[data-toggle]');
    if (sum) {
      toggle(sum.dataset.toggle);
      render();
      if (sum.dataset.toggle.endsWith(':log')) pumpLogs();
      return;
    }

    const adv = e.target.closest('[data-adv]');
    if (adv) {
      e.preventDefault();
      // `value` only exists on the stepper. Undefined for every other action, which
      // is what the server expects — nothing else here carries a number.
      control(adv.dataset.ws, adv.dataset.adv, adv, adv.dataset.value);
      return;
    }

    const pick = e.target.closest('[data-pick]');
    if (pick) {
      e.preventDefault();
      const picks = picksFor(pick.dataset.key);
      const n = Number(pick.dataset.n);
      // Tapping the choice you already made clears it — undecided is a real state,
      // and there has to be a way back to it.
      if (picks.get(n) === pick.dataset.pick) picks.delete(n);
      else picks.set(n, pick.dataset.pick);
      render();
      return;
    }

    const all = e.target.closest('[data-pick-all]');
    if (all) {
      e.preventDefault();
      const key = all.dataset.key;
      const q = (state.proposals.get(key.split('/')[0]) || []).find((x) => x.key === key);
      const picks = picksFor(key);
      (q?.proposal?.beads || []).forEach((_, i) => picks.set(i + 1, all.dataset.pickAll));
      render();
      return;
    }

    const sub = e.target.closest('[data-submit]');
    if (sub) {
      e.preventDefault();
      submitProposal(sub.dataset.submit, sub);
      return;
    }

    const arc = e.target.closest('[data-archive]');
    if (arc) {
      e.preventDefault();
      openArchive(arc.dataset.archive, arc.dataset.bead);
      return;
    }

    const read = e.target.closest('[data-read]');
    if (read) {
      e.preventDefault();
      readArchived(read.dataset.read, read.dataset.commit);
    }
  });

  document.getElementById('refresh').addEventListener('click', load);
  /* The space picker moved. Nothing is refetched — /api/work already holds every repo
     and which of them is drawn is decided at paint time. */
  window.beadcause?.space?.onChange(() => render());
  // Two `bd` calls per workspace every twenty seconds is worth paying for the pane
  // you are looking at and nothing else — the mirror tab sits over this one, and a
  // hidden page must not keep sweeping every tracker on the Mac.
  setInterval(() => !out.hidden && load(), REFRESH_MS);
  setInterval(() => !out.hidden && pumpLogs(), LOG_MS);

  // How the tab bar brings this pane back up to date when you return to it.
  window.beadcause = window.beadcause || {};
  window.beadcause.monitor = { refresh: load };

  /* Where this device is, for a mirror on some other screen. There is no selection to
     publish — being here is the whole report — and the id stays `sessions` because that
     is what lib/presence.js whitelists and what the mirror already has a name for; this
     page is simply what the name now points at.

     This page can also *be* a mirror, and presence.js's own header was right that a
     device which followed itself would be absurd — so `showTab` in mirror.js revises
     this to `null` while the mirror pane is up, and mirror.js drops its own device from
     the list it follows. Both halves are needed: the report is honest about which pane
     you are on, and the list cannot circle back on this one even mid-switch. */
  window.beadcause?.presence?.report({ view: 'sessions' });

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    load();
  }
})();
