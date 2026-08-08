/* The dependency graph.
 *
 * beadcause draws this itself rather than framing `bd graph --html`, for the three
 * reasons in lib/graph.js. The two that shape this file:
 *
 * - **It grows.** Nodes arrive five at a time, in dependency order, instead of the
 *   whole graph landing at once after a wait. deluvia is 108 nodes and takes five
 *   seconds to fetch; a blank screen for five seconds reads as broken, where a
 *   counter that starts at "5 of 108" reads as working.
 * - **A node is a way in, not a label.** bd's 130x40 boxes truncate every title.
 *   Tapping one here opens a card you can actually read, and that card opens the
 *   whole bead in a sheet.
 *
 * The third thing, and the reason for the marks below: a graph where every node is
 * drawn the same way can only tell you what exists. Three channels separate what is
 * happening from that, and they are deliberately three different channels so none of
 * them can be mistaken for another:
 *
 * - **colour** is status, as it always was — the outline and the left bar.
 * - **motion** is now: a claimed bead pulses, and nothing else on the page moves.
 * - **contrast** is recency: what moved inside this session stays bright and carries
 *   a bar under its top edge, and the rest fades back.
 */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const workspace = params.get('ws') || '';
  const bead = params.get('id') || '';
  const token = localStorage.getItem('beadcause.token') || '';

  const BATCH = 5;          // beads added per tick
  const TICK = 130;         // ms between batches — fast enough to feel alive
  const NODE_W = 132;
  const NODE_H = 40;

  const $ = (id) => document.getElementById(id);
  const main = $('graph-main');
  const titleEl = $('graph-title');
  const scopeEl = $('scope');
  const growth = $('growth');
  const growthText = $('growth-text');
  const growthPause = $('growth-pause');
  const emptyEl = $('empty');
  const card = $('card');
  const sheet = $('sheet');

  let scope = bead ? params.get('scope') || 'bead' : 'all';
  let sim = null;
  let timer = null;
  let paused = false;
  let selected = null;
  let userMoved = false;   // a pan or pinch stops the auto-fit fighting you

  /* --------------------------------------------------------------- theme */

  // Read from the stylesheet rather than duplicating hex here, so the graph
  // follows the app into light mode with nothing to keep in sync.
  const css = (name, fallback) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

  const STATUS = () => ({
    open: css('--accent', '#5eead4'),
    in_progress: css('--warn', '#fbbf24'),
    blocked: css('--danger', '#f87171'),
    closed: css('--muted', '#8ba0b6'),
    deferred: css('--line', '#263140'),
  });
  const statusColor = (s) => STATUS()[s] || STATUS().open;

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* ------------------------------------------------------------------ ages */

  // Every age on this page is measured from the *server's* clock, sent with the
  // graph. The `moved` marks were decided server-side against the same instant, so
  // a phone a few minutes fast would otherwise print "2m" beside a bead the server
  // had already ruled too old to mark — the label and the mark disagreeing about
  // the same bead.
  let now = Date.now();
  // How far back "moved" was measured, as an age. Printed alongside the count,
  // because the count alone is not interpretable: "28 moved" reads as alarming or as
  // nothing at all depending on whether the window was ten minutes or a day, and a
  // session left open overnight makes the second one entirely possible.
  let movedWindow = '';

  /** Compact age. The badge on a node has room for three characters, not "3 hours ago". */
  const ago = (iso) => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    const m = Math.round((now - t) / 60000);
    if (m < 1) return '<1m';
    if (m < 60) return `${m}m`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h}h`;
    const d = Math.round(h / 24);
    return d < 7 ? `${d}d` : `${Math.round(d / 7)}w`;
  };

  /* ----------------------------------------------------------------- api */

  async function api(path) {
    const res = await fetch(path, { headers: { 'x-beadcause-token': token } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  function fail(msg) {
    stop();
    growth.hidden = true;
    emptyEl.hidden = false;
    emptyEl.innerHTML = `<strong>Can't draw this graph</strong>${esc(msg)}`;
  }

  /* -------------------------------------------------------------- canvas */

  const svg = d3.select('#canvas');
  let g, gLinks, gNodes, zoom;

  function resetCanvas() {
    svg.selectAll('*').remove();
    const defs = svg.append('defs');
    defs
      .append('marker')
      .attr('id', 'arrow')
      .attr('viewBox', '0 -5 10 10')
      .attr('refX', 19)
      .attr('refY', 0)
      .attr('markerWidth', 5)
      .attr('markerHeight', 5)
      .attr('orient', 'auto')
      .append('path')
      .attr('d', 'M0,-4L8,0L0,4')
      .attr('fill', css('--muted', '#8ba0b6'));

    g = svg.append('g');
    gLinks = g.append('g').attr('class', 'links');
    gNodes = g.append('g').attr('class', 'nodes');

    zoom = d3
      .zoom()
      .scaleExtent([0.15, 3])
      .on('start', (e) => {
        // Only a gesture counts. Programmatic fitting also fires 'zoom'.
        if (e.sourceEvent) userMoved = true;
      })
      .on('zoom', (e) => g.attr('transform', e.transform));
    svg.call(zoom);
    // A tap on empty canvas puts the card away — the same gesture you'd expect
    // from any sheet, and it stops a stale card hovering over a graph you've
    // panned somewhere else.
    svg.on('click', (e) => {
      if (e.target === svg.node()) dismissCard();
    });
  }

  /** Frame everything drawn so far, until the first pan or pinch. */
  function fit() {
    if (userMoved || !sim || !sim.nodes().length) return;
    const nodes = sim.nodes();
    const pad = 40;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const x0 = Math.min(...xs) - NODE_W / 2 - pad;
    const x1 = Math.max(...xs) + NODE_W / 2 + pad;
    const y0 = Math.min(...ys) - NODE_H / 2 - pad;
    const y1 = Math.max(...ys) + NODE_H / 2 + pad;
    const w = main.clientWidth;
    const h = main.clientHeight;
    if (!w || !h || x1 <= x0 || y1 <= y0) return;
    // Never zoom past 1:1. Fitting a small graph to the viewport would otherwise
    // blow six beads up to fill the screen, which looks like a bug rather than a
    // fit — the point of this is to get everything *in*, not to magnify.
    const k = Math.min(1, Math.min(w / (x1 - x0), h / (y1 - y0)));
    const t = d3.zoomIdentity
      .translate(w / 2 - ((x0 + x1) / 2) * k, h / 2 - ((y0 + y1) / 2) * k)
      .scale(k);
    svg.transition().duration(280).call(zoom.transform, t);
  }

  /* --------------------------------------------------------------- draw */

  function paint(nodes, links) {
    const link = gLinks.selectAll('line').data(links, (d) => `${d.source.id ?? d.source}->${d.target.id ?? d.target}`);
    link.exit().remove();
    link
      .enter()
      .append('line')
      .attr('class', (d) => `gl ${d.type || ''}`)
      .attr('stroke', css('--line', '#263140'))
      .attr('stroke-width', 1.5)
      .attr('stroke-dasharray', (d) => (d.type === 'parent-child' ? '5,3' : null))
      .attr('marker-end', 'url(#arrow)')
      // Fade in with CSS, not d3. A d3 transition here shares the default name
      // with every other transition on the page — the auto-fit's among them — and
      // kept being restarted mid-flight, leaving every node stuck at opacity
      // 0.0004: a graph that was fully drawn and completely invisible.
      .attr('class', (d) => `gl arrive ${d.type || ''}`);

    const node = gNodes.selectAll('g.gn').data(nodes, (d) => d.id);
    node.exit().remove();

    const entered = node
      .enter()
      .append('g')
      // `now` is a bead an agent has claimed, `moved` one touched inside this
      // session. Both are styled in style.css rather than here, so a node's state is
      // one class instead of a pile of attributes to keep in sync — and so the
      // pulse can be a CSS animation, which the arrive animation already proved is
      // the only kind that survives on this page.
      .attr('class', (d) => `gn arrive${d.status === 'in_progress' ? ' now' : ''}${d.moved ? ' moved' : ''}`)
      .style('cursor', 'pointer')
      .on('click', (e, d) => {
        e.stopPropagation();
        select(d);
      })
      .call(
        d3
          .drag()
          // Without this a tap that moves a single pixel is a drag, and d3-drag
          // then *suppresses* the click that follows — so on a phone, where no
          // finger is perfectly still, tapping a bead did nothing at all.
          .clickDistance(8)
          .on('start', (e, d) => {
            if (!e.active) sim.alphaTarget(0.25).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on('drag', (e, d) => {
            d.fx = e.x;
            d.fy = e.y;
          })
          .on('end', (e, d) => {
            if (!e.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          })
      );

    entered
      .append('rect')
      .attr('class', 'gn-box')
      .attr('width', NODE_W)
      .attr('height', NODE_H)
      .attr('x', -NODE_W / 2)
      .attr('y', -NODE_H / 2)
      .attr('rx', 9)
      .attr('fill', css('--surface-2', '#1c242e'))
      .attr('stroke', (d) => statusColor(d.status))
      .attr('stroke-width', 1.5);

    // The status bar, so colour survives at a zoom where the outline is a hairline.
    entered
      .append('rect')
      .attr('width', 4)
      .attr('height', NODE_H - 14)
      .attr('x', -NODE_W / 2 + 5)
      .attr('y', -(NODE_H - 14) / 2)
      .attr('rx', 2)
      .attr('fill', (d) => statusColor(d.status));

    entered
      .append('text')
      .attr('x', -NODE_W / 2 + 15)
      .attr('y', -1)
      .attr('fill', css('--text', '#e6edf5'))
      .attr('font-size', 10.5)
      .text((d) => clip(d.title, 20));

    entered
      .append('text')
      .attr('x', -NODE_W / 2 + 15)
      .attr('y', 12)
      .attr('fill', css('--muted', '#8ba0b6'))
      .attr('font-size', 8.5)
      .attr('font-family', 'ui-monospace, SFMono-Regular, Menlo, monospace')
      .text((d) => d.id);

    // Touched inside this session: a bar under the top edge, clear of every glyph on
    // the node. Drawn in `--text` rather than an accent because every colour here
    // already means a status, and `--text` is the one bright value that means none of
    // them — so it can't be misread as one.
    //
    // *Inside* the box rather than riding the edge: a claimed bead's outline swells to
    // 4px as it pulses, and a bar sitting on the edge spent half of every cycle
    // underneath it. The 3px inset clears the widest the stroke ever gets.
    entered
      .filter((d) => d.moved)
      .append('rect')
      .attr('class', 'gn-moved')
      .attr('x', -NODE_W / 2 + 10)
      .attr('y', -NODE_H / 2 + 3)
      .attr('width', NODE_W - 20)
      .attr('height', 2.5)
      .attr('rx', 1.5)
      .attr('fill', css('--text', '#e6edf5'));

    // Bottom right: who is on it while someone is, how stale it is the rest of the
    // time. The pulse already says "now", so spending the only spare room on the node
    // repeating that would buy nothing — where "claimed six hours ago by whom" and
    // "untouched for three weeks" are both things you can only learn here.
    entered
      .append('text')
      .attr('class', 'gn-badge')
      .attr('x', NODE_W / 2 - 8)
      .attr('y', 12)
      .attr('text-anchor', 'end')
      .attr('fill', (d) => (d.status === 'in_progress' ? statusColor(d.status) : css('--muted', '#8ba0b6')))
      .attr('font-size', 8.5)
      .text((d) => (d.status === 'in_progress' ? clip(d.actor || 'claimed', 10) : ago(d.updated_at)));
  }

  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

  /* -------------------------------------------------------------- growth */

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  /** Is any of this live? Decides whether the summary is worth keeping on screen. */
  const inFlight = (all) => all.some((n) => n.status === 'in_progress' || n.moved);

  /**
   * The one line this view exists to produce: how big the graph is, and how much of
   * it is actually moving. It replaces the growth counter in place, because by the
   * time the count stops being interesting this is what you wanted from it.
   */
  function summarise(all) {
    const working = all.filter((n) => n.status === 'in_progress').length;
    const moved = all.filter((n) => n.moved).length;
    const bits = [`${all.length} bead${all.length === 1 ? '' : 's'}`];
    if (working) bits.push(`${working} being worked`);
    if (moved) bits.push(movedWindow ? `${moved} moved in ${movedWindow}` : `${moved} moved`);
    return bits.join(' · ');
  }

  /**
   * Reveal the graph five beads at a time.
   *
   * Ordered by bd's layer, so it grows the way the work does — things that can
   * start now first, then what waits on them — rather than in whatever order the
   * array happened to be in. A link only joins once both its ends are on screen;
   * otherwise d3 would throw on a missing node id.
   */
  function grow(all, allLinks) {
    // Fading the untouched is only meaningful when something *was* touched, so the
    // switch for it goes on the container and the rule that dims is scoped to it.
    gNodes.classed('has-moved', all.some((n) => n.moved));

    const queue = all
      .slice()
      .sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0) || (a.priority ?? 9) - (b.priority ?? 9) || a.id.localeCompare(b.id));

    const shown = [];
    const shownIds = new Set();
    const shownLinks = [];

    sim = d3
      .forceSimulation(shown)
      .force('link', d3.forceLink(shownLinks).id((d) => d.id).distance(95).strength(0.6))
      .force('charge', d3.forceManyBody().strength(-260))
      .force('x', d3.forceX((d) => 120 + (d.layer ?? 0) * 165).strength(0.28))
      .force('y', d3.forceY(0).strength(0.05))
      .force('collide', d3.forceCollide(NODE_W / 2 + 8))
      .on('tick', () => {
        gLinks
          .selectAll('line')
          .attr('x1', (d) => d.source.x)
          .attr('y1', (d) => d.source.y)
          .attr('x2', (d) => d.target.x)
          .attr('y2', (d) => d.target.y);
        gNodes.selectAll('g.gn').attr('transform', (d) => `translate(${d.x},${d.y})`);
        if (selected) placeCard();
      })
      // The layout keeps moving after the last batch, so the fit that ran with it
      // is already stale by the time it settles — which is how 108 beads ended up
      // half off the left edge. Re-frame once the simulation is actually still.
      .on('end', () => fit());

    const step = () => {
      if (paused) return;
      const batch = queue.splice(0, BATCH);
      for (const n of batch) {
        // Seed near the previous layer rather than at the origin, so a new batch
        // slides in from the right instead of exploding out of the middle.
        n.x = 120 + (n.layer ?? 0) * 165 + (Math.random() - 0.5) * 40;
        n.y = (Math.random() - 0.5) * 220;
        shown.push(n);
        shownIds.add(n.id);
      }
      for (const l of allLinks) {
        const s = l.source.id ?? l.source;
        const t = l.target.id ?? l.target;
        if (shownIds.has(s) && shownIds.has(t) && !shownLinks.includes(l)) shownLinks.push(l);
      }

      sim.nodes(shown);
      sim.force('link').links(shownLinks);
      paint(shown, shownLinks);
      sim.alpha(0.6).restart();
      fit();

      growthText.textContent = `${shown.length} of ${all.length}`;
      if (!queue.length) {
        stop();
        growthPause.hidden = true;
        growthText.textContent = summarise(all);
        // The counter was only ever a loading state and got out of the way. The
        // summary is an answer, so it stays — but a graph with nothing live in it has
        // no answer to keep, and the old behaviour is right for that one.
        if (!inFlight(all)) setTimeout(() => (growth.hidden = true), 1600);
      }
    };

    growth.hidden = false;
    growthPause.hidden = all.length <= BATCH;
    step();
    if (queue.length) timer = setInterval(step, TICK);
  }

  growthPause.addEventListener('click', () => {
    paused = !paused;
    growthPause.textContent = paused ? 'Resume' : 'Pause';
  });

  /* ---------------------------------------------------------- the card */

  function select(d) {
    selected = d;
    gNodes.selectAll('g.gn').classed('on', (n) => n === d);
    $('card-id').textContent = d.id;
    $('card-status').textContent = String(d.status || '').replace('_', ' ');
    $('card-status').style.color = statusColor(d.status);
    const p = $('card-priority');
    p.textContent = d.priority != null ? `P${d.priority}` : '';
    p.hidden = d.priority == null;
    $('card-title').textContent = d.title || '';

    // The live line — who, for how long, doing what, and whether it moved inside this
    // session. Every part is optional and a bead nobody is on shows none of them: an
    // empty row of labels would take up the space and say less than nothing.
    const live = [];
    if (d.status === 'in_progress') {
      const who = d.actor ? `${d.actor} on it` : 'claimed';
      live.push(d.started_at ? `▸ ${who} for ${ago(d.started_at)}` : `▸ ${who}`);
    }
    if (d.phase) live.push(`${d.icon || '•'} ${d.phase.replace('_', ' ')}${d.detail ? ` — ${clip(d.detail, 44)}` : ''}`);
    if (d.moved) {
      const a = ago(d.updated_at);
      live.push(a === '<1m' ? 'moved just now' : `moved ${a} ago`);
    }
    const liveEl = $('card-live');
    liveEl.textContent = live.join(' · ');
    liveEl.hidden = !live.length;

    // The shape line: what kind of bead, what it holds up, and how long it has been
    // waiting. `blocks 3` on something nobody has touched in a month is the case this
    // is here to make visible.
    const meta = [];
    if (d.type) meta.push(d.type.replace('_', ' ').replace(/^./, (c) => c.toUpperCase()));
    if (d.blocks) meta.push(`blocks ${d.blocks}`);
    if (d.waits) meta.push(`waits on ${d.waits}`);
    if (d.comments) meta.push(`${d.comments} comment${d.comments === 1 ? '' : 's'}`);
    if (d.created_at) meta.push(`${ago(d.created_at)} old`);
    $('card-deps').textContent = meta.join(' · ');

    card.hidden = false;
    placeCard();
  }

  /** Keep the card near its node, but never off-screen or under the sheet. */
  function placeCard() {
    if (!selected || card.hidden) return;
    const t = d3.zoomTransform(svg.node());
    const x = t.applyX(selected.x);
    const y = t.applyY(selected.y);
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const maxX = main.clientWidth - w - 12;
    const maxY = main.clientHeight - h - 12;
    card.style.left = `${Math.max(12, Math.min(maxX, x - w / 2))}px`;
    card.style.top = `${Math.max(12, Math.min(maxY, y + NODE_H))}px`;
  }

  function dismissCard() {
    selected = null;
    card.hidden = true;
    if (gNodes) gNodes.selectAll('g.gn').classed('on', false);
  }

  $('card-dismiss').addEventListener('click', dismissCard);
  $('card-details').addEventListener('click', () => selected && openSheet(selected));

  /* --------------------------------------------------------- the sheet */

  const md = (text) =>
    window.DOMPurify.sanitize(window.marked.parse(String(text || ''), { gfm: true, breaks: false }), {
      ADD_ATTR: ['target', 'rel'],
    });

  async function openSheet(d) {
    sheet.hidden = false;
    sheet.classList.add('open');
    $('sheet-id').textContent = d.id;
    $('sheet-body').innerHTML = '<div class="empty">Loading…</div>';
    try {
      const full = await api(`/api/bead?workspace=${encodeURIComponent(workspace)}&id=${encodeURIComponent(d.id)}`);
      $('sheet-body').innerHTML = sheetHtml(full);
    } catch (err) {
      $('sheet-body').innerHTML = `<div class="empty"><strong>Can't load this bead</strong>${esc(err.message)}</div>`;
    }
  }

  function sheetHtml(b) {
    const parts = [`<h2 class="sheet-title">${esc(b.title || '')}</h2>`];
    const meta = [
      `<span class="pill" style="color:${statusColor(b.status)}">${esc(String(b.status || '').replace('_', ' '))}</span>`,
      b.priority != null ? `<span class="pill">P${esc(b.priority)}</span>` : '',
      b.issue_type ? `<span class="pill">${esc(b.issue_type)}</span>` : '',
      // Just the local part: owners are email addresses and the pill uppercases
      // them, so the domain is two thirds of a very shouty pill saying nothing.
      b.owner ? `<span class="pill">${esc(String(b.owner).split('@')[0])}</span>` : '',
      b.dependent_count ? `<span class="pill">blocks ${esc(b.dependent_count)}</span>` : '',
      b.dependency_count ? `<span class="pill">waits on ${esc(b.dependency_count)}</span>` : '',
    ].filter(Boolean);
    parts.push(`<div class="meta">${meta.join('')}</div>`);
    if (b.description) parts.push(`<div class="md">${md(b.description)}</div>`);
    if (b.comments?.length) {
      parts.push('<div class="section-label">Thread</div>');
      parts.push(
        `<div class="comments">${b.comments
          .map(
            (c) => `<div class="comment${c.author && c.author !== 'beadcause' ? ' from-agent' : ''}">
              <span class="who">${esc(c.author || '')}</span>
              <div class="md">${md(c.text || '')}</div>
            </div>`
          )
          .join('')}</div>`
      );
    }
    return parts.join('');
  }

  function closeSheet() {
    sheet.classList.remove('open', 'full');
    sheet.hidden = true;
    $('sheet-expand').textContent = '⤢';
  }

  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-expand').addEventListener('click', () => {
    const full = sheet.classList.toggle('full');
    $('sheet-expand').textContent = full ? '⤡' : '⤢';
  });

  /* ----------------------------------------------------------- lifecycle */

  $('graph-close').addEventListener('click', () => {
    window.close();
    setTimeout(() => (location.href = '/'), 120);
  });

  async function draw() {
    stop();
    dismissCard();
    closeSheet();
    paused = false;
    userMoved = false;
    growthPause.textContent = 'Pause';
    emptyEl.hidden = true;
    growth.hidden = false;
    growthText.textContent = 'asking bd for the graph…';
    growthPause.hidden = true;
    resetCanvas();

    const label = scope === 'bead' && bead ? bead : workspace;
    titleEl.textContent = label;
    document.title = `${label} · graph`;
    for (const btn of scopeEl.querySelectorAll('.scope-btn')) btn.classList.toggle('on', btn.dataset.scope === scope);

    let data;
    try {
      const q = new URLSearchParams({ workspace });
      if (scope === 'bead' && bead) q.set('id', bead);
      data = await api(`/api/graph?${q}`);
    } catch (err) {
      return fail(err.message);
    }

    if (!data.nodes.length) {
      growth.hidden = true;
      emptyEl.hidden = false;
      emptyEl.innerHTML = `<strong>Nothing open here</strong>${esc(workspace)} has no open issues to draw.`;
      return;
    }

    now = Date.parse(data.now) || Date.now();
    movedWindow = ago(data.since);
    // Where that window came from. The server picks the cut-off and says how it chose,
    // because "this session" and "recently" are different claims and only one of them
    // is true at a time.
    growth.title =
      data.sinceKind === 'session'
        ? `Moved = touched since the oldest live session in this workspace started, ${movedWindow} ago`
        : `Moved = touched in the last ${movedWindow} — no session is running here`;

    grow(data.nodes, data.links);
  }

  window.addEventListener('resize', () => fit());

  if (!workspace) return fail('No workspace given.');
  if (!token) return fail('This device is not paired. Open the inbox first.');

  if (bead) {
    scopeEl.hidden = false;
    scopeEl.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.scope-btn');
      if (!btn || btn.dataset.scope === scope) return;
      scope = btn.dataset.scope;
      draw();
    });
  }

  draw();
})();
