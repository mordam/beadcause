/* Current sessions: who is working, on which bead, and the way into each repo's graph.
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
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('work');
  const pulse = document.getElementById('pulse');
  const REFRESH_MS = 45000;

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
   * One live `claude` process.
   *
   * A div, not a link: there is nowhere honest to send you. The bead it might be on
   * is unknown, and the workspace graph is already one tap away in the card foot.
   */
  function sessionRow(s) {
    const busy = s.status === 'busy';
    return `<div class="work-row session-row">
      <span class="work-phase">${busy ? '<span class="spark"></span>' : '○'}</span>
      <span class="work-main">
        <span class="work-title">${esc(s.name || '(unnamed session)')}</span>
        <span class="work-sub">${esc(s.where || s.cwd)} · pid ${esc(s.pid)}${
          s.status ? ` · ${esc(s.status)}` : ''
        }</span>
      </span>
      <time>${esc(age(s.at))}</time>
    </div>`;
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

    const head = `<div class="work-head">
      <h2>${esc(w.name)}</h2>
      <span class="work-count${summary.length ? ' on' : ''}">${
        summary.length ? esc(summary.join(' · ')) : 'idle'
      }</span>
    </div>`;

    if (w.error) {
      // The sessions come off the filesystem rather than from bd, so they survive a
      // workspace whose database is mid-write and are still worth showing.
      // The advocate's own state comes from memory, not from bd, so it survives a
      // workspace whose database is mid-write — and an advocate that cannot read
      // its tracker is precisely what you want to see here.
      return `<article class="card work-card">${head}
        <p class="subtitle bad">⚠ ${esc(w.error)}</p>
        ${advocateHtml(advocate)}${sessions.map(sessionRow).join('')}
      </article>`;
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

    return `<article class="card work-card">${head}
      ${adv}${beads}${sessionBlock}${nothing}
      <div class="work-foot">
        <div class="meta">${pills.join('')}</div>
        <a class="work-graph" href="${esc(graphUrl(w.name))}">Graph →</a>
      </div>
    </article>`;
  }

  /**
   * Sessions in a directory that maps to no configured workspace.
   *
   * Only reachable without `projectRoot` set, but they are still sessions, and a page
   * called "current sessions" that quietly dropped some would be lying by omission.
   */
  function elsewhereHtml(sessions) {
    if (!sessions.length) return '';
    return `<article class="card work-card">
      <div class="work-head">
        <h2>Elsewhere</h2>
        <span class="work-count on">${esc(plural(sessions.length, 'session'))}</span>
      </div>
      <div class="session-label">Claude sessions <span>Not in any configured workspace.</span></div>
      ${sessions.map(sessionRow).join('')}
    </article>`;
  }

  async function load() {
    pulse.classList.add('busy');
    try {
      const res = await fetch('/api/work', { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      const data = await res.json();
      const advocates = new Map((data.advocates || []).map((a) => [a.workspace, a]));
      const cards =
        (data.workspaces || []).map((w) => workspaceHtml(w, advocates.get(w.name))).join('') +
        elsewhereHtml(data.elsewhere || []);
      out.innerHTML = cards || '<div class="empty">No workspaces configured.</div>';
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

  document.getElementById('work-refresh').addEventListener('click', load);
  // Cheap enough to keep current, expensive enough not to poll like the inbox:
  // two `bd` calls per workspace, about two seconds for six.
  setInterval(load, REFRESH_MS);

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    load();
  }
})();
