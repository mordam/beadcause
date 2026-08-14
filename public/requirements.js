/* The requirement graph, with its denominator — bc-fvmx.8.
 *
 * Two screens in one page: coverage per product token, and one requirement's edges
 * behind a tap. Both come from `/api/requirements`, which is a read of the index in the
 * common repo plus a parse of the corpus in the architecture checkout.
 *
 * ## Coverage is the headline, and that is the point of the page
 *
 * The failure this feature can plausibly die of is not being wrong — it is being partial
 * while *reading* as complete. Three hundred requirements exist; an edge is recorded only
 * where a merge landed naming one; so for a long time this page's honest answer is "18 of
 * 335". A screen that opened on a list of requirements-with-files would be taken for an
 * index of the codebase and quietly believed about the other 317.
 *
 * So the first line is the fraction, the token rows carry their own denominators, and
 * `observed` is drawn apart from `covered` — because an edge somebody forecast and an edge
 * a merge proved are different evidence, and collapsing them would inflate exactly the
 * number a reader is most likely to quote.
 *
 * ## Nothing here writes
 *
 * There is no promote button and there is not meant to be. Promotion writes into
 * `resources/reqs/**` in the architecture repo — a file the whole team clones and reviews
 * — so it happens from a terminal after a person has approved it (lib/reqpromote.js,
 * `beadcause-requirements promote`). A one-tap control on a phone for a change to somebody
 * else's repo is the wrong shape however convenient it looks, and this page carries no
 * `⦿ observing` chip for the same reason public/history.js carries none: nothing on it
 * reaches the Mac.
 *
 * ## An install with no corpus says so
 *
 * Every personal repo is in that state and it is not an error. `{ corpus: null }` comes
 * back as a sentence explaining what would have to exist, rather than an empty list that
 * looks like a graph with nothing in it.
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

  const out = document.getElementById('requirements');
  const pulse = document.getElementById('pulse');
  const refreshBtn = document.getElementById('req-refresh');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const state = { data: null, open: null, detail: null, loading: false };

  async function api(path) {
    const res = await fetch(path, { headers: { 'x-beadcause-token': token } });
    if (!res.ok) throw new Error(`${res.status}`);
    return res.json();
  }

  /** The bar under each token row. Two lengths, because there are two claims to make. */
  function bar(covered, observed, total) {
    if (!total) return '';
    const pc = Math.round((covered / total) * 100);
    const po = Math.round((observed / total) * 100);
    return `<div class="reqbar" role="img" aria-label="${covered} of ${total} covered, ${observed} proved by a merge">
      <span class="reqbar-covered" style="width:${pc}%"></span>
      <span class="reqbar-observed" style="width:${po}%"></span>
    </div>`;
  }

  function renderSummary(data) {
    const t = data.totals;
    const pct = t.total ? Math.round((t.covered / t.total) * 100) : 0;
    const dupes = data.duplicates?.length
      ? `<p class="lede">${data.duplicates.length} id${data.duplicates.length === 1 ? ' is' : 's are'} defined twice in the corpus itself —
         the second definition is invisible everywhere, including here.
         <code>${esc(data.duplicates.slice(0, 3).map((d) => `${d.id} (${d.ignored})`).join(', '))}</code></p>`
      : '';
    const orphans = data.orphans?.length
      ? `<p class="lede">${data.orphans.length} recorded against ids the corpus no longer has —
         usually a requirement that was renamed. <code>${esc(data.orphans.slice(0, 3).map((o) => o.id).join(', '))}</code></p>`
      : '';
    return `
      <h2 class="section-label">Coverage</h2>
      <p class="lede"><strong>${t.covered} of ${t.total} requirements</strong> have any code recorded against
        them (${pct}%). ${t.observed} of those are backed by a merge rather than a forecast;
        ${t.edges} edge${t.edges === 1 ? '' : 's'} in all.
        ${t.stub ? `${t.stub} requirement${t.stub === 1 ? ' has' : 's have'} no definition written yet.` : ''}</p>
      <p class="lede">A requirement appears here only once work landed naming it, so silence about one
        means nothing is written down — not that nothing implements it.</p>
      ${dupes}${orphans}`;
  }

  function renderTokens(data) {
    const rows = (data.tokens || [])
      .filter((t) => t.total)
      .map(
        (t) => `
        <button class="req-row" data-token="${esc(t.token)}">
          <span class="req-top">
            <span class="pill id">${esc(t.token)}</span>
            <span class="req-meta">${t.covered}/${t.total} covered · ${t.observed} proved · ${t.edges} edge${t.edges === 1 ? '' : 's'}</span>
          </span>
          ${bar(t.covered, t.observed, t.total)}
        </button>`
      )
      .join('');
    return `<h2 class="section-label">By product</h2><div class="req-list">${rows || '<div class="empty">No tokens in the corpus.</div>'}</div>`;
  }

  /** One token's requirements, with the covered ones first — those are the ones with anything to show. */
  function renderToken(data, token) {
    const graph = data.graph || {};
    const ids = Object.keys(graph)
      .filter((id) => id.split('.')[0] === token)
      .sort();
    if (!ids.length) return `<div class="empty">Nothing recorded against <code>${esc(token)}</code> yet.</div>`;
    const rows = ids
      .map((id) => {
        const edges = graph[id] || [];
        const files = [...new Set(edges.flatMap((e) => e.files || []))].slice(0, 4);
        const best = edges.some((e) => e.provenance === 'observed-from-diff' || e.provenance === 'human-confirmed')
          ? 'proved by a merge'
          : 'declared, not yet proved';
        return `<div class="req-row is-detail">
          <span class="req-top">
            <span class="pill id">${esc(id)}</span>
            <span class="req-meta">${edges.length} edge${edges.length === 1 ? '' : 's'} · ${best}</span>
          </span>
          <span class="req-files">${files.map((f) => `<code>${esc(f)}</code>`).join(' ') || '<em>no files recorded</em>'}</span>
        </div>`;
      })
      .join('');
    return `<h2 class="section-label"><code>${esc(token)}</code></h2><div class="req-list">${rows}</div>`;
  }

  function render() {
    const data = state.data;
    if (!data) {
      out.innerHTML = '<div class="empty">Reading the graph…</div>';
      return;
    }
    if (!data.corpus) {
      out.innerHTML = `<div class="empty"><strong>No requirements corpus on this Mac.</strong>
        Requirements live in <code>resources/reqs</code> in the architecture repo. Check it out, or
        name it as <code>requirements.corpus</code> in config.json, and this fills in.</div>`;
      return;
    }
    out.innerHTML = `${renderSummary(data)}${state.open ? renderToken(data, state.open) : renderTokens(data)}
      <p class="lede">Read one from a terminal with <code>beadcause-requirements show &lt;id&gt;</code>,
      or ask what a file carries with <code>beadcause-requirements files &lt;path&gt;</code>.</p>
      ${state.open ? '<button class="req-back" id="req-back">‹ every product</button>' : ''}`;

    for (const el of out.querySelectorAll('[data-token]')) {
      el.addEventListener('click', () => {
        state.open = el.dataset.token;
        render();
      });
    }
    document.getElementById('req-back')?.addEventListener('click', () => {
      state.open = null;
      render();
    });
  }

  async function load() {
    if (state.loading) return;
    state.loading = true;
    pulse?.classList.add('busy');
    try {
      state.data = await api('/api/requirements');
    } catch (err) {
      out.innerHTML = `<div class="empty"><strong>Could not read the graph.</strong>${esc(err.message)}</div>`;
      return;
    } finally {
      state.loading = false;
      pulse?.classList.remove('busy');
    }
    render();
  }

  refreshBtn?.addEventListener('click', load);

  if (!token) {
    out.innerHTML = `<div class="empty"><strong>This device is not paired.</strong>Open the inbox first — it is where a token is set.</div>`;
  } else {
    load();
  }
})();
