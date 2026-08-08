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

  function workspaceHtml(w) {
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
      return `<article class="card work-card">${head}
        <p class="subtitle bad">⚠ ${esc(w.error)}</p>
        ${sessions.map(sessionRow).join('')}
      </article>`;
    }

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
      !beads && !sessions.length ? '<p class="subtitle">No claimed beads, and no session open here.</p>' : '';

    return `<article class="card work-card">${head}
      ${beads}${sessionBlock}${nothing}
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
      const cards = (data.workspaces || []).map(workspaceHtml).join('') + elsewhereHtml(data.elsewhere || []);
      out.innerHTML = cards || '<div class="empty">No workspaces configured.</div>';
    } catch (err) {
      out.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
    } finally {
      pulse.classList.remove('busy');
    }
  }

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
