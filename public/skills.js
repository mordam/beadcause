/* The skill library, its candidates, and whether anything uses it — bc-dgx7.5.
 *
 * One screen for the whole of the epic's loop: a session ends, an audit agent reads its
 * archive next to the ones before it and files what repeats as a candidate bead, an
 * endorsed candidate ships as a `b7e-<verb>` command, and agents call it instead of doing
 * the work by hand. Everything on the page comes from `/api/skills`, which reads three
 * things that already exist and stores nothing of its own (lib/skills.js).
 *
 * ## The untracked four are the first thing drawn, not the last
 *
 * Four of the six numbers this view was asked for — calls per skill, time to adopt, dead
 * skills, prompt bytes removed — are downstream of one fact nothing records yet: that a
 * skill was called. A screen with a candidate list, an audit count and a library on it,
 * and no adoption section at all, is not a screen that is missing something; it is a
 * screen that says adoption is fine. So the lede counts them, the section names each one
 * with why it cannot be measured and which bead would measure it, and no number anywhere
 * else on the page is drawn unless something actually recorded it.
 *
 * The one adoption number that *is* real is the miss — a session that hand-rolled work a
 * shipped command already covers, which the audit agent records on its run rather than
 * filing. It carries a caveat worth stating out loud on the screen: with an empty library
 * there can be no misses **by construction**, so zero is not evidence of anything until
 * something has shipped.
 *
 * ## Every workspace, and no picker
 *
 * The other read-only pages take the space picker's selection. This one does not, and
 * deliberately: the programme is one thing across this Mac — one audit agent, one library,
 * one backlog of candidates — and narrowing it to a space would answer "is the library
 * working *in sophab*", which is a question nobody has. The rows carry their workspace and
 * their checkout, so a multi-repo install still reads correctly. `/api/skills` does take
 * `?workspace=` and `?space=` for a caller that wants them.
 *
 * Nothing here writes. A candidate is endorsed on the endorsement queue, which every
 * waiting row links to; the bead itself opens in the graph, which is the one destination
 * that works for a candidate in any of the four states.
 */
(() => {
  'use strict';

  const token = (() => {
    try {
      return localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  })();

  const out = document.getElementById('skills');
  const pulse = document.getElementById('pulse');
  const refreshBtn = document.getElementById('skills-refresh');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const state = { data: null, loading: false };

  /** How a candidate's state reads on a chip, and the order the counts are drawn in. */
  const STATES = [
    { id: 'waiting', label: 'waiting on you' },
    { id: 'accepted', label: 'accepted' },
    { id: 'declined', label: 'declined' },
    { id: 'superseded', label: 'superseded' },
  ];

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many || `${one}s`}`;

  /* The bead's title opens `<command> — …`, which is exactly what the pill beside it says.
     Both drawn, the phone spends a line and a half repeating a word; so the pill keeps the
     command and the title drops its own copy. A title somebody rewrote is left alone. */
  const said = (r) =>
    r.command && r.title.startsWith(`${r.command} — `) ? r.title.slice(r.command.length + 3) : r.title;

  /** A date as something a person reads. Absolute past a week — "34 days ago" is not a date. */
  function ago(iso) {
    if (!iso) return '';
    const then = Date.parse(iso);
    if (!Number.isFinite(then)) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${plural(mins, 'minute')} ago`;
    const hours = Math.round(mins / 60);
    if (hours < 24) return `${plural(hours, 'hour')} ago`;
    const days = Math.round(hours / 24);
    if (days <= 7) return `${plural(days, 'day')} ago`;
    return new Date(then).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  /** The bead, wherever it is in its life. `/graph` takes any id in any state. */
  const beadHref = (row) => `/graph?ws=${encodeURIComponent(row.workspace)}&id=${encodeURIComponent(row.id)}`;

  /** Where a held candidate is acted on — the queue, opened on that row. */
  const queueHref = (row) => `/endorse?bead=${encodeURIComponent(`${row.workspace}/${row.id}`)}`;

  /**
   * The state of the loop in one paragraph, with the size of the hole in it.
   *
   * The count of untracked metrics is in the first sentence on purpose. It is the one
   * number that stops the rest of the page being read as the whole picture.
   */
  function renderLede(d) {
    const lib = d.library || [];
    const c = d.candidates?.counts || {};
    const untracked = (d.untracked || []).length;
    const shipped = lib.length
      ? `<strong>${plural(lib.length, 'skill')}</strong> in the library.`
      : '<strong>Nothing has shipped yet</strong> — the library is empty, so every finding is still a candidate.';
    const filed = c.filed
      ? `${plural(c.filed, 'candidate')} filed${c.waiting ? `, <strong>${c.waiting} waiting on you</strong>` : ''}.`
      : 'No candidate has been filed.';
    const ran = d.audit?.runs
      ? `${plural(d.audit.runs, 'audit run')} over ${plural(d.audit.audited || 0, 'archived session')}.`
      : 'The audit agent has not run yet.';
    return `
      <h2 class="section-label">The loop</h2>
      <p class="lede">${shipped} ${filed} ${ran}</p>
      <p class="lede skill-caveat">${plural(untracked, 'number')} below ${
        untracked === 1 ? 'is' : 'are'
      } <strong>not tracked</strong> — nothing records a skill call yet, and adoption, dead
        skills and the bytes saved all hang off that one fact. They are drawn rather than
        omitted so this screen cannot be read as the whole picture.</p>`;
  }

  /**
   * The library. Empty is the expected answer today and gets a sentence rather than a
   * blank — an empty list under a heading reads as a failed fetch.
   */
  function renderLibrary(d) {
    const lib = d.library || [];
    if (!lib.length) {
      return `<h2 class="section-label">The library</h2>
        <div class="empty"><strong>No <code>b7e-</code> command exists yet.</strong>
          A skill is an executable in <code>bin/</code>, registered in both bin maps, tested and
          documented — bc-dgx7.2 is that definition and bc-dgx7.3 is the first one. Until one
          lands there is nothing to adopt, which is why the misses below are zero by
          construction rather than by measurement.</div>`;
    }
    const rows = lib
      .map(
        (s) => `<div class="skill-row">
          <span class="skill-top">
            <span class="pill id">${esc(s.command)}</span>
            <span class="skill-meta">${esc(s.where.join(', '))}</span>
          </span>
          <span class="skill-meta">${
            s.candidate
              ? `proposed by <a href="/graph?ws=${encodeURIComponent(s.candidate.workspace)}&id=${encodeURIComponent(
                  s.candidate.id
                )}">${esc(s.candidate.id)}</a>`
              : 'no candidate bead names it — written by hand rather than through the pipeline'
          }</span>
          <span class="skill-meta skill-untracked">calls · distinct sessions · last call — not tracked</span>
        </div>`
      )
      .join('');
    return `<h2 class="section-label">The library</h2><div class="skill-list">${rows}</div>`;
  }

  /** The four counts as chips, then every candidate newest first. */
  function renderCandidates(d) {
    const rows = d.candidates?.rows || [];
    const counts = d.candidates?.counts || {};
    const chips = STATES.map(
      (s) => `<span class="skill-chip is-${s.id}">${counts[s.id] || 0} ${esc(s.label)}</span>`
    ).join('');
    if (!rows.length) {
      return `<h2 class="section-label">Candidates</h2>
        <div class="empty"><strong>Nothing filed yet.</strong>
          The audit agent files a candidate when the same hand-rolled shape turns up in
          ${d.audit?.minSessions || 3} sessions or more. ${
            d.audit?.runs
              ? 'It has run and found nothing worth a command.'
              : 'It has not run yet — see the agent below.'
          }</div>`;
    }
    /* The row is a `<div>` and the *title* is the link, rather than the whole row being
       one. A waiting candidate has two places worth going — the bead, and the queue where
       it is taken off hold — and a link inside a link is not markup a browser owes us
       anything for, so the row that has two destinations cannot be one of them itself. */
    const list = rows
      .map((r) => {
        const state = STATES.find((s) => s.id === r.state);
        const why = r.state === 'superseded' && r.supersededBy ? ` by ${esc(r.supersededBy)}` : '';
        const reason = r.closeReason ? `<span class="skill-meta">${esc(r.closeReason)}</span>` : '';
        return `<div class="skill-row">
          <span class="skill-top">
            ${r.command ? `<span class="pill id">${esc(r.command)}</span>` : ''}
            <span class="skill-chip is-${esc(r.state)}">${esc(state?.label || r.state)}${why}</span>
          </span>
          <a class="skill-title skill-open" href="${esc(beadHref(r))}">${esc(said(r))}</a>
          ${reason}
          <span class="skill-meta">${esc(r.id)} · ${esc(r.workspace)} · filed ${esc(ago(r.at))}${
            r.state === 'waiting' ? ` · <a class="skill-act" href="${esc(queueHref(r))}">endorse it</a>` : ''
          }</span>
        </div>`;
      })
      .join('');
    const waiting = rows.find((r) => r.state === 'waiting');
    const queue = waiting
      ? `<p class="lede">${
          counts.waiting === 1 ? 'One is' : `${counts.waiting} are`
        } held for endorsement — <a class="skill-act" href="${esc(
          queueHref(waiting)
        )}">the queue</a> is where they are taken off hold.</p>`
      : '';
    return `<h2 class="section-label">Candidates</h2>
      <div class="skill-chips">${chips}</div>
      ${queue}
      <div class="skill-list">${list}</div>`;
  }

  /** What the audit agent has actually done, and the misses — the one real adoption number. */
  function renderAudit(d) {
    const a = d.audit || {};
    const misses = a.misses || [];
    const checkouts = (d.checkouts || []).filter((c) => c.runs || c.library.length || c.problem);
    const missLine = misses.length
      ? `<p class="lede">${plural(misses.length, 'miss')} recorded — a session that did by hand
          what a shipped command already covers. ${esc(
            misses
              .slice(0, 4)
              .map((m) => `${m.slug || m.existing || 'unnamed'} (${m.key})`)
              .join(', ')
          )}</p>`
      : `<p class="lede skill-caveat">No misses recorded${
          (d.library || []).length ? '' : ', and with an empty library there can be none — a miss is a command that existed and went unused'
        }.</p>`;
    const where = checkouts.length
      ? `<div class="skill-list">${checkouts
          .map(
            (c) => `<div class="skill-row">
              <span class="skill-top"><span class="pill id">${esc(c.key)}</span>
                <span class="skill-meta">${
                  c.problem
                    ? esc(c.problem)
                    : `${plural(c.runs, 'run')} · ${plural(c.audited, 'session')} read · ${plural(
                        c.library.length,
                        'skill'
                      )}`
                }</span></span>
            </div>`
          )
          .join('')}</div>`
      : '';
    return `<h2 class="section-label">The audit agent</h2>
      <p class="lede">${
        a.enabled ? 'Switched on' : '<strong>Switched off</strong>'
      }. It runs when ${plural(a.every || 0, 'session')} have ended unread, no more often than
        every ${plural(a.cooldownMinutes || 0, 'minute')}, and reads up to
        ${plural(a.max || 0, 'archive')} at a time. A finding has to be visible in
        ${plural(a.minSessions || 0, 'session')} to be filed.</p>
      <p class="lede">${plural(a.runs || 0, 'run')} so far, ${plural(
        a.audited || 0,
        'session archive'
      )} read${a.lastAt ? `, most recently ${esc(ago(a.lastAt))}` : ' — it has not run yet'}.</p>
      ${missLine}
      ${where}`;
  }

  /** What nothing records, said out loud, with the bead that would record it. */
  function renderUntracked(d) {
    const rows = (d.untracked || [])
      .map(
        (u) => `<div class="skill-row is-untracked">
          <span class="skill-top">
            <span class="skill-chip is-untracked">not tracked</span>
            <span class="skill-meta">${esc(u.owed)}</span>
          </span>
          <span class="skill-title">${esc(u.metric)}</span>
          <span class="skill-meta">${esc(u.why)}</span>
        </div>`
      )
      .join('');
    return `<h2 class="section-label">Not tracked</h2>
      <p class="lede">Every one of these needs a record of a skill being called, and nothing
        writes one yet. They are here so the numbers above are read for what they are.</p>
      <div class="skill-list">${rows}</div>`;
  }

  function renderErrors(d) {
    if (!d.errors?.length) return '';
    return `<h2 class="section-label">Could not read</h2>
      <div class="skill-list">${d.errors
        .map((e) => `<div class="skill-row is-untracked"><span class="skill-meta">${esc(e)}</span></div>`)
        .join('')}</div>`;
  }

  function render() {
    const d = state.data;
    if (!d) {
      out.innerHTML = '<div class="empty">Reading the library…</div>';
      return;
    }
    out.innerHTML =
      renderLede(d) + renderLibrary(d) + renderCandidates(d) + renderAudit(d) + renderUntracked(d) + renderErrors(d);
  }

  async function load(refresh) {
    if (state.loading) return;
    state.loading = true;
    pulse?.classList.add('busy');
    try {
      const res = await fetch(`/api/skills${refresh ? '?refresh=1' : ''}`, {
        headers: { 'x-beadcause-token': token },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      state.data = await res.json();
    } catch (err) {
      out.innerHTML = `<div class="empty"><strong>Could not read the library.</strong>${esc(err.message)}</div>`;
      return;
    } finally {
      state.loading = false;
      pulse?.classList.remove('busy');
    }
    render();
  }

  refreshBtn?.addEventListener('click', () => load(true));

  if (!token) {
    out.innerHTML = `<div class="empty"><strong>This device is not paired.</strong>Open the inbox first — it is where a token is set.</div>`;
  } else {
    load(false);
  }
})();
