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
 * The third is what a phone forced, and the desktop never showed: a graph that fits
 * a phone is a graph too small to read — 128 beads fit at a thirteenth of full
 * size, where a title is 1.4px. So the fitted view stays and a circle in the
 * middle of it is magnified instead. See the loupe section below.
 *
 * The fourth, and the reason for the marks below: a graph where every node is
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
  const ZOOM_MIN = 0.15;    // the floor a finger can reach on its own
  const ZOOM_MAX = 3;
  const LOUPE_ACROSS = 3;   // beads that fit across the glass
  const LOUPE_MIN_M = 1.1;  // below this the glass shows what the screen already does

  const $ = (id) => document.getElementById(id);
  const main = $('graph-main');
  const titleEl = $('graph-title');
  const scopeEl = $('scope');
  const growth = $('growth');
  const growthText = $('growth-text');
  const growthPause = $('growth-pause');
  const emptyEl = $('empty');
  const reticleLabel = $('reticle-label');
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
  let loupe, loupeBack, loupeUse, loupeRim, reticle;
  let loupeR = 0;
  let loupeK = 1;
  let loupeOn = false;      // off until the graph has finished arriving
  let centred = null;       // the bead under the glass

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

    defs.append('clipPath').attr('id', 'loupe-clip').append('circle').attr('r', 0);

    g = svg.append('g').attr('id', 'scene');
    gLinks = g.append('g').attr('class', 'links');
    gNodes = g.append('g').attr('class', 'nodes');

    // The loupe is a second rendering of the very same scene — a <use> of it,
    // clipped to a circle. Nothing is laid out twice and nothing has to be kept
    // in sync: the force simulation ticks the original and the copy follows.
    loupe = svg.append('g').attr('class', 'loupe').attr('clip-path', 'url(#loupe-clip)').attr('pointer-events', 'none');
    loupeBack = loupe.append('circle').attr('class', 'loupe-back');
    loupeUse = loupe.append('use').attr('href', '#scene');
    loupeRim = svg.append('circle').attr('class', 'loupe-rim').attr('pointer-events', 'none');
    reticle = svg.append('g').attr('class', 'reticle').attr('pointer-events', 'none');
    reticle.append('path').attr('class', 'reticle-l');
    reticle.append('path').attr('class', 'reticle-r');

    zoom = d3
      .zoom()
      .scaleExtent([ZOOM_MIN, ZOOM_MAX])
      .on('start', (e) => {
        // Only a gesture counts. Programmatic fitting also fires 'zoom'.
        if (e.sourceEvent) userMoved = true;
      })
      .on('zoom', (e) => {
        g.attr('transform', e.transform);
        updateLoupe();
      });
    svg.call(zoom);
    // A tap on empty canvas puts the card away — the same gesture you'd expect
    // from any sheet, and it stops a stale card hovering over a graph you've
    // panned somewhere else.
    svg.on('click', (e) => {
      if (e.target === svg.node()) dismissCard();
    });
    // Inside the loupe you are looking at a magnified copy, and the copy takes no
    // pointer events — so without this a tap would fall through to whichever
    // speck happens to sit under your finger in the unmagnified scene, and select
    // the wrong bead. Capture the tap first and resolve it against what you can
    // actually see. Capture phase, so it runs before the nodes' own handlers.
    svg.node().addEventListener(
      'click',
      (e) => {
        if (!loupeOn) return;
        const box = main.getBoundingClientRect();
        const p = [e.clientX - box.left, e.clientY - box.top];
        const c = centre();
        if (Math.hypot(p[0] - c[0], p[1] - c[1]) > loupeR) return;
        e.stopPropagation();
        const hit = beadUnder(unmagnify(p));
        hit ? select(hit) : dismissCard();
      },
      true
    );
  }

  /* --------------------------------------------------------------- loupe */

  /*
   * A phone can hold the whole graph or it can hold a readable bead, never both:
   * 128 beads only fit by shrinking to a thirteenth, where a title is 1.4px. So
   * keep the fitted view — the shape of the work is worth seeing — and magnify a
   * circle in the middle of it, big enough for three beads across and the rows
   * above and below. You pan the graph under the glass rather than zooming in
   * and losing your place.
   *
   * The magnification is exact and needs no layout maths. Holding the centre of
   * the screen fixed and scaling everything about it by m is, in screen space,
   * `translate(c(1-m)) scale(m)` — so the loupe is that transform on a <use> of
   * the scene, and the scene keeps its own zoom transform underneath.
   */

  const centre = () => [main.clientWidth / 2, main.clientHeight / 2];

  /** Radius, and the scale the magnified copy is drawn at. */
  function loupeGeometry() {
    const w = main.clientWidth;
    const h = main.clientHeight;
    const r = Math.max(96, Math.min((w - 24) / 2, (h - 132) / 2, 190));
    // Three beads across the diameter, with a gap between them — and never past
    // 1:1, for the same reason the fit never magnifies: this is for reading what
    // is there, not for blowing three beads up to fill a phone.
    const k = Math.min(1, (2 * r) / (LOUPE_ACROSS * NODE_W + (LOUPE_ACROSS - 1) * 16));
    return { r, k };
  }

  /** How much the loupe magnifies what is under it, given the current zoom. */
  function loupeFactor() {
    const t = d3.zoomTransform(svg.node());
    return t.k > 0 ? loupeK / t.k : 1;
  }

  /** A point on screen, back through the magnification to where it really is. */
  function unmagnify(p) {
    const m = loupeFactor();
    const c = centre();
    return [(p[0] - c[0] * (1 - m)) / m, (p[1] - c[1] * (1 - m)) / m];
  }

  /** The bead whose box contains a screen point, or null. */
  function beadUnder(p) {
    if (!sim) return null;
    const t = d3.zoomTransform(svg.node());
    const qx = (p[0] - t.x) / t.k;
    const qy = (p[1] - t.y) / t.k;
    for (const n of sim.nodes())
      if (Math.abs(n.x - qx) <= NODE_W / 2 && Math.abs(n.y - qy) <= NODE_H / 2) return n;
    return null;
  }

  /** The bead nearest the middle of the screen, if it is under the glass. */
  function beadAtCentre() {
    if (!sim || !sim.nodes().length) return null;
    const t = d3.zoomTransform(svg.node());
    const c = centre();
    const qx = (c[0] - t.x) / t.k;
    const qy = (c[1] - t.y) / t.k;
    const m = loupeFactor();
    let best = null;
    let bd = Infinity;
    for (const n of sim.nodes()) {
      // Distance to the box rather than to the centre, so a wide bead you are
      // sitting on top of wins over a nearer neighbouring bead's midpoint.
      const dx = Math.max(Math.abs(n.x - qx) - NODE_W / 2, 0);
      const dy = Math.max(Math.abs(n.y - qy) - NODE_H / 2, 0);
      const d = Math.hypot(dx, dy);
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    // Only lock on to something actually inside the glass.
    return bd * t.k * m <= loupeR * 0.72 ? best : null;
  }

  function updateLoupe() {
    if (!loupe) return;
    const geo = loupeGeometry();
    loupeR = geo.r;
    loupeK = geo.k;
    const m = loupeFactor();
    const c = centre();

    // Below about a tenth of magnification the glass shows what the naked screen
    // already does, and a ring around nothing is just clutter.
    const on = loupeOn && m >= LOUPE_MIN_M;
    loupe.attr('display', on ? null : 'none');
    loupeRim.attr('display', on ? null : 'none');
    reticle.attr('display', on ? null : 'none');
    if (reticleLabel) reticleLabel.hidden = !on;
    if (!on) {
      if (gNodes) gNodes.selectAll('g.gn').classed('reticled', false);
      return;
    }

    svg.select('#loupe-clip circle').attr('cx', c[0]).attr('cy', c[1]).attr('r', loupeR);
    loupeBack.attr('cx', c[0]).attr('cy', c[1]).attr('r', loupeR);
    loupeUse.attr('transform', `translate(${c[0] * (1 - m)},${c[1] * (1 - m)}) scale(${m})`);
    loupeRim.attr('cx', c[0]).attr('cy', c[1]).attr('r', loupeR);

    updateReticle(m, c);
  }

  /** Frame the bead under the glass, and say which one it is. */
  function updateReticle(m, c) {
    const n = beadAtCentre();
    centred = n;
    gNodes.selectAll('g.gn').classed('reticled', (d) => d === n);

    const t = d3.zoomTransform(svg.node());
    // Where the bead is drawn inside the loupe: through the zoom, then through
    // the magnification. With no bead under the glass the brackets sit dead
    // centre at bead size, so the HUD still says what it is looking for.
    const sx = n ? m * t.applyX(n.x) + c[0] * (1 - m) : c[0];
    const sy = n ? m * t.applyY(n.y) + c[1] * (1 - m) : c[1];
    const w = (NODE_W * loupeK) / 2 + 5;
    const h = (NODE_H * loupeK) / 2 + 5;
    const arm = Math.min(h * 0.55, 12);
    reticle
      .select('.reticle-l')
      .attr('d', `M${sx - w + arm},${sy - h}H${sx - w}V${sy + h}H${sx - w + arm}`);
    reticle
      .select('.reticle-r')
      .attr('d', `M${sx + w - arm},${sy - h}H${sx + w}V${sy + h}H${sx + w - arm}`);

    if (reticleLabel) {
      reticleLabel.style.top = `${c[1] + loupeR + 12}px`;
      reticleLabel.innerHTML = n
        ? `<span class="pill id">${esc(n.id)}</span><span class="reticle-title">${esc(n.title || '')}</span>`
        : '<span class="reticle-hint">pan a bead into the glass</span>';
    }
  }

  /** Slide a bead under the glass, keeping the zoom the fit chose. */
  function centreOn(n) {
    if (!n) return;
    const t = d3.zoomTransform(svg.node());
    const c = centre();
    const to = d3.zoomIdentity.translate(c[0] - n.x * t.k, c[1] - n.y * t.k).scale(t.k);
    svg.transition().duration(620).call(zoom.transform, to);
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
    // `zoom.transform` isn't clamped by scaleExtent but every gesture is, so a
    // graph big enough to fit below the floor — deluvia's 128 beads land at 0.13
    // on a phone — opens on a view a finger can never get back to: the first
    // pinch out stops at 0.15 and half the graph is off screen for good. Let the
    // floor follow the fit down.
    zoom.scaleExtent([Math.min(ZOOM_MIN, k), ZOOM_MAX]);
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
        if (loupeOn) updateLoupe();
        if (selected) placeCard();
      })
      // The layout keeps moving after the last batch, so the fit that ran with it
      // is already stale by the time it settles — which is how 108 beads ended up
      // half off the left edge. Re-frame once the simulation is actually still,
      // then raise the glass; and if this graph was opened for one bead, slide
      // that bead under it, which is the whole reason you tapped through to here.
      .on('end', () => {
        fit();
        setTimeout(() => {
          loupeOn = true;
          updateLoupe();
          if (bead && !userMoved) {
            const n = sim.nodes().find((d) => d.id === bead);
            if (n) centreOn(n);
          }
        }, 320);
      });

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

  /**
   * Which bead the glass is over, for the monitor's mirror.
   *
   * The graph is the one view where what you are looking at is not what you
   * navigated to: the page is a workspace, the thing being read is whichever node
   * was last tapped. Both are published — the workspace so the mirror can draw the
   * same graph, the id so it can put that bead's full text beside it.
   */
  function publishView(d) {
    window.beadcause?.presence?.report({
      view: 'graph',
      workspace,
      id: d?.id || (scope === 'bead' ? bead : ''),
      key: d ? `${workspace}/${d.id}` : '',
      scope,
      detail: d?.title || '',
    });
  }

  function select(d) {
    selected = d;
    publishView(d);
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
    //
    // `waits` is counted off the graph's own edges by `enrichGraph` (lib/graph.js), not
    // taken from bd's `dependency_count` — that number counts the edge to a bead's
    // parent, so every subtask here used to say "waits on 1" while waiting on nothing.
    // Nought is therefore a real answer and prints nothing at all.
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
    let x = t.applyX(selected.x);
    let y = t.applyY(selected.y);
    // A bead tapped through the glass is drawn magnified, so anchor the card
    // where you actually saw it rather than on the speck underneath.
    if (loupeOn) {
      const m = loupeFactor();
      const c = centre();
      const mx = m * x + c[0] * (1 - m);
      const my = m * y + c[1] * (1 - m);
      if (Math.hypot(mx - c[0], my - c[1]) <= loupeR) {
        x = mx;
        y = my;
      }
    }
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const maxX = main.clientWidth - w - 12;
    const maxY = main.clientHeight - h - 12;
    card.style.left = `${Math.max(12, Math.min(maxX, x - w / 2))}px`;
    card.style.top = `${Math.max(12, Math.min(maxY, y + NODE_H))}px`;
  }

  function dismissCard() {
    selected = null;
    publishView(null);
    card.hidden = true;
    if (gNodes) gNodes.selectAll('g.gn').classed('on', false);
  }

  $('card-dismiss').addEventListener('click', dismissCard);
  $('card-details').addEventListener('click', () => selected && openSheet(selected));

  /* --------------------------------------------------------- the sheet */

  /**
   * Same split, and the same default, as the inbox: a newline means a line break,
   * because a person typed it. bd's own fields are the exception — they arrive
   * hard-wrapped at ~78 columns and have to reflow, so they opt out with FROM_BD.
   */
  const FROM_BD = { breaks: false };
  const md = (text, { breaks = true } = {}) =>
    window.DOMPurify.sanitize(window.marked.parse(String(text || ''), { gfm: true, breaks }), {
      ADD_ATTR: ['target', 'rel'],
    });

  /**
   * Which sheet is on screen, as a number that goes up on every open.
   *
   * The children fetch below outlives the sheet that asked for it — tap a bead, read a
   * line, tap through to another, and the first answer is still in the air. Every async
   * append checks this before touching the DOM, so a slow reply lands nowhere rather
   * than under a bead it is not about.
   */
  let sheetSeq = 0;

  /**
   * Whether the closed children are folded away, remembered across sheets and reloads.
   *
   * Default is *shown*, which is the whole point of listing them: an epic whose finished
   * work is invisible reads as though it never started. The fold is for the other
   * reading — what is left — and the choice outlives the sheet, because making it again
   * on every bead is not a choice, it is a chore.
   */
  const HIDE_CLOSED_KEY = 'beadcause.childrenHideClosed';
  let hideClosed = localStorage.getItem(HIDE_CLOSED_KEY) === '1';

  async function openSheet(d) {
    sheet.hidden = false;
    sheet.classList.add('open');
    const seq = ++sheetSeq;
    $('sheet-id').textContent = d.id;
    $('sheet-body').innerHTML = '<div class="empty">Loading…</div>';
    let full;
    try {
      full = await api(`/api/bead?workspace=${encodeURIComponent(workspace)}&id=${encodeURIComponent(d.id)}`);
    } catch (err) {
      if (seq === sheetSeq) {
        $('sheet-body').innerHTML = `<div class="empty"><strong>Can't load this bead</strong>${esc(err.message)}</div>`;
      }
      return;
    }
    if (seq !== sheetSeq) return;
    $('sheet-body').innerHTML = sheetHtml(full);
    // Deliberately not awaited. The sheet is on screen and readable at this line, and
    // the children are an addition to it — see loadChildren for what that buys.
    loadChildren(full, seq);
  }

  /**
   * The children, asked for after the sheet is already up and appended when they land.
   *
   * Everything here is arranged so the sheet never waits on this call and never breaks
   * over it. The caller does not await it, so a slow `bd` costs the block and not the
   * first screen. A failure is swallowed rather than shown, because replacing a sheet
   * you can already read with an error message would take the bead away over the part
   * of it that did not arrive. And an answer for a bead you have since navigated away
   * from is dropped on the sequence check.
   *
   * The toggle re-renders from the rows already in hand — folding the closed ones away
   * is a question about what is on screen, not a new question for bd.
   */
  async function loadChildren(b, seq) {
    if (!mightHaveChildren(b)) return;
    let data;
    try {
      data = await api(
        `/api/bead-children?workspace=${encodeURIComponent(workspace)}&id=${encodeURIComponent(b.id)}`
      );
    } catch {
      return;
    }
    if (seq !== sheetSeq) return;
    const kids = (data.children || []).filter(Boolean);
    const slot = $('sheet-kids');
    // No children after all — `dependent_count` counts the beads this one blocks as
    // well, so a bead that blocks something and parents nothing gets here. It draws
    // nothing, and the empty slot it leaves has no height.
    if (!slot || !kids.length) return;
    const paint = () => {
      slot.innerHTML = childrenHtml(kids, hideClosed);
    };
    paint();
    slot.addEventListener('click', (ev) => {
      const btn = ev.target.closest('.kids-toggle');
      if (!btn) return;
      hideClosed = !hideClosed;
      if (hideClosed) localStorage.setItem(HIDE_CLOSED_KEY, '1');
      else localStorage.removeItem(HIDE_CLOSED_KEY);
      paint();
    });
  }

  /**
   * The bead's own sheet, rather than the graph around it — the link the gate
   * blockers in the inbox already use (`gateBlockersHtml`, public/app.js).
   *
   * `&open=1` is the whole point: landing on a force layout mid-animation and
   * hunting for one node is three taps that were never what the tap meant.
   * Inside the drawer these never escape it — drawer.js intercepts any `/graph?`
   * link and re-points the iframe with `location.replace`, so back still closes
   * the drawer exactly once no matter how many beads deep you walked.
   */
  const beadUrl = (id) =>
    `/graph?ws=${encodeURIComponent(workspace)}&id=${encodeURIComponent(id)}&open=1`;

  /**
   * Where the bead sits, split out of the one array bd already sends.
   *
   * `bd show --json` returns `dependencies[]` with a full row per edge — id, title,
   * status — and a `dependency_type` saying which kind of edge it is. The parent is
   * in there too, as `parent-child`, which is why the count beside it cannot be
   * trusted: a subtask that waits on nothing at all still arrived here claiming
   * "waits on 1", because bd counts the edge to its parent among them.
   *
   * So the array is split rather than counted, and each edge goes to the group whose
   * label is true of it. `discovered-from` and `related` get their own group instead
   * of being folded into "waits on": neither blocks anything, and a bead that says it
   * is waiting on something it is not is worse than one that says nothing.
   */
  const RELATED = new Set(['discovered-from', 'related']);

  function relations(b) {
    const known = Array.isArray(b.dependencies);
    const rows = known ? b.dependencies.filter(Boolean) : [];
    const parent = rows.find((r) => r.dependency_type === 'parent-child');
    return {
      // Whether the edges themselves arrived, as against only bd's count of them.
      // The rows are the truth when they are here; the count is what is left when
      // they are not.
      known,
      // The row carries the title; `b.parent` is only an id. Falling back to it means
      // a payload that lost the row still gets a way up rather than nothing at all.
      parent: parent || (b.parent ? { id: b.parent } : null),
      waits: rows.filter((r) => r !== parent && !RELATED.has(r.dependency_type)),
      related: rows.filter((r) => RELATED.has(r.dependency_type)),
    };
  }

  /** One group of linked beads, or nothing — never a heading with no rows under it. */
  function relGroupHtml(label, rows) {
    if (!rows.length) return '';
    return `<div class="rel-group">
      <span class="rel-kind">${esc(label)}</span>
      ${rows
        .map(
          (r) => `<a class="rel-row" href="${esc(beadUrl(r.id))}">
            <span class="rel-dot" style="background:${statusColor(r.status)}"></span>
            <span class="pill id">${esc(r.id)}</span>
            <span class="rel-title">${esc(r.title || '')}</span>
          </a>`
        )
        .join('')}
    </div>`;
  }

  /**
   * Is it worth asking bd what is under this bead?
   *
   * There is no child count in the payload to read. What there is is `dependent_count`
   * — every edge pointing *at* this bead — and a child's `parent-child` edge is one of
   * them, so a bead with no dependents has no children and the call can be skipped
   * outright. That is the direction that has to be exact, and it is: this never skips a
   * bead that has children.
   *
   * It is deliberately not tight the other way. A bead that blocks something and parents
   * nothing — bc-7w1l, one dependent, no children — costs one call that comes back
   * empty and draws nothing. bd offers nothing better to gate on, and the alternative is
   * asking on every sheet, which is the leaf beads that are most of what you tap.
   */
  const mightHaveChildren = (b) => Boolean(b && b.dependent_count);

  /**
   * Every child of a bead, with the closed ones foldable.
   *
   * The same row as the relations above it, on purpose: a child is another bead you tap
   * through to, and giving it a second visual language would say it was a different kind
   * of thing. Status is colour here as it is everywhere else on this page — the dot, the
   * node outline, the pill — so a finished child is grey, and stepped back besides.
   *
   * What is added is the fraction `bd show` prints under its own CHILDREN section, and
   * the control that folds the closed tail away. The control only exists when there is
   * something for it to hide: "Hide closed (0)" on an epic that has finished nothing is
   * a button that does nothing. The count on it is what says how many went, which is the
   * only thing a fold owes you.
   *
   * Pure — the fold state is passed in rather than read here — so the whole block can be
   * rendered in a test with no DOM and no localStorage behind it.
   */
  function childrenHtml(children, hideClosed) {
    const rows = (children || []).filter(Boolean);
    if (!rows.length) return '';
    const done = rows.filter((c) => c.status === 'closed');
    const shown = hideClosed ? rows.filter((c) => c.status !== 'closed') : rows;
    const toggle = done.length
      ? `<button type="button" class="kids-toggle" aria-pressed="${hideClosed ? 'true' : 'false'}">${
          hideClosed ? `Show closed (${done.length})` : `Hide closed (${done.length})`
        }</button>`
      : '';
    return `<div class="rel-group kids">
      <div class="kids-head">
        <span class="rel-kind">Children</span>
        <span class="kids-count">${done.length}/${rows.length} done</span>
        ${toggle}
      </div>
      ${shown
        .map(
          (c) => `<a class="rel-row${c.status === 'closed' ? ' is-closed' : ''}" href="${esc(beadUrl(c.id))}">
            <span class="rel-dot" style="background:${statusColor(c.status)}"></span>
            <span class="pill id">${esc(c.id)}</span>
            <span class="rel-title">${esc(c.title || '')}</span>
          </a>`
        )
        .join('')}
    </div>`;
  }

  /**
   * When a bead closed, in words rather than an ISO string.
   *
   * Not `ago()`: that one is three characters wide because it lives on a node badge,
   * and "2h" is the wrong answer to "when did this close" on a sheet with room for
   * the date. Same shape the session page and the inbox already use for an absolute
   * time. The raw ISO stays on the `<time datetime>`, which is where a long-press
   * tooltip and anything reading the page finds it.
   */
  const closedWhen = (iso) => {
    const t = Date.parse(iso || '');
    if (!Number.isFinite(t)) return '';
    return new Date(t).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  /**
   * What actually happened to a closed bead.
   *
   * The sheet drew the status pill — the word "closed" — and stopped there, so the
   * one sentence that says *why* it closed was readable only from a terminal:
   * "Landed as #113 as e8315969 — still owed: CAN BE DEPLOYED" out of bin/deliver.js,
   * "Answered via Beadcause" under an answer, a revoke's reason under its fixed
   * prefix, "Superseded by bc-rk2o". Those are the endings, and the sheet is the
   * screen every bead link in the app opens.
   *
   * Drawn in full, never clamped. The longest close reason in this tracker is 1664
   * characters and the sheet body already scrolls, so there is nothing to gain by
   * folding it and something real to lose: /history's row clamps its own copy to two
   * lines (`.hist-why`) precisely because tapping the row lands here, and a clamp at
   * both ends would put the sentence nowhere in the app at all.
   *
   * Only while the bead is actually closed. `bd` clears `closed_at` on reopen but
   * leaves `close_reason` sitting there, so a reopened bead would otherwise carry the
   * reason it was closed the last time as though it still applied — which is the one
   * failure mode worse than drawing nothing.
   */
  function closedHtml(b) {
    if (b.status !== 'closed') return '';
    const when = closedWhen(b.closed_at);
    const why = String(b.close_reason || '').trim();
    if (!when && !why) return '';
    const stamp = when
      ? `<div class="closed-when">Closed <time datetime="${esc(b.closed_at)}">${esc(when)}</time></div>`
      : '';
    // `FROM_BD` for the same reason every other bd field on this sheet has it: these
    // are hard-wrapped at ~78 columns by the terminal that wrote them, and honouring
    // those newlines would break one sentence into a ragged column.
    const body = why ? `<div class="md">${md(why, FROM_BD)}</div>` : '';
    return `<div class="closed-note">${stamp}${body}</div>`;
  }

  function sheetHtml(b) {
    const parts = [`<h2 class="sheet-title">${esc(b.title || '')}</h2>`];
    const rel = relations(b);
    const meta = [
      `<span class="pill" style="color:${statusColor(b.status)}">${esc(String(b.status || '').replace('_', ' '))}</span>`,
      b.priority != null ? `<span class="pill">P${esc(b.priority)}</span>` : '',
      b.issue_type ? `<span class="pill">${esc(b.issue_type)}</span>` : '',
      // Just the local part: owners are email addresses and the pill uppercases
      // them, so the domain is two thirds of a very shouty pill saying nothing.
      b.owner ? `<span class="pill">${esc(String(b.owner).split('@')[0])}</span>` : '',
      b.dependent_count ? `<span class="pill">blocks ${esc(b.dependent_count)}</span>` : '',
      // Only when the rows are not there to say it better. A count and the list it
      // counts, one above the other, is the sheet saying the same thing twice — and
      // the count is the half you cannot tap. Worse, on a subtask the count is not
      // even true: the edge bd is counting is the one to the parent.
      !rel.known && b.dependency_count ? `<span class="pill">waits on ${esc(b.dependency_count)}</span>` : '',
    ].filter(Boolean);
    parts.push(`<div class="meta">${meta.join('')}</div>`);
    // Straight under the pills, above everything else. On a closed bead the outcome is
    // the fact you came for — the status pill raises the question and this is the only
    // place in the app that answers it — and it is the half of the sheet that is
    // meaningless once you have scrolled past the description looking for it.
    const closed = closedHtml(b);
    if (closed) parts.push(closed);
    // Above the description, because "what is this under, and what is it stuck
    // behind" is the question you have before you read a word of it — and because
    // a bead with neither draws nothing here, so it looks exactly as it did before.
    const groups = [
      relGroupHtml('Parent', rel.parent ? [rel.parent] : []),
      relGroupHtml('Waits on', rel.waits),
      relGroupHtml('Related', rel.related),
    ].filter(Boolean);
    if (groups.length) parts.push(`<div class="rel">${groups.join('')}</div>`);
    if (b.description) parts.push(`<div class="md">${md(b.description, FROM_BD)}</div>`);
    // Where the children land, once the second call has been made for them — empty at
    // first paint, and absent entirely on a bead that cannot have any.
    //
    // Below the description because that is the question children answer: you read what
    // the epic is *for*, and then what it is made of. And because the sheet opens at the
    // top, the block arrives in the space under what you are reading rather than pushing
    // it — the one position where landing late costs nothing. An empty div has no height,
    // so a call that comes back with nothing leaves no gap and no heading behind it.
    if (mightHaveChildren(b)) parts.push('<div id="sheet-kids"></div>');
    // The rest of the row, in the order bd itself prints it. `/api/bead` has always
    // returned all of it; the sheet just stopped reading after `description`, so the
    // acceptance criteria — the one part you close a bead against — were readable
    // only from a terminal. Description stays unlabelled, the way it is on the card,
    // so a bead carrying none of these looks exactly as it did before.
    //
    // FROM_BD on every one of them, for the same reason the description has it:
    // these are bd's own fields, hard-wrapped at ~78 columns, and honouring those
    // newlines would break a paragraph into a ragged column.
    for (const [label, text] of [
      ['acceptance', b.acceptance_criteria],
      ['design', b.design],
      ['notes', b.notes],
    ]) {
      if (!String(text || '').trim()) continue;
      parts.push(`<div class="section-label">${label}</div>`);
      parts.push(`<div class="md">${md(text, FROM_BD)}</div>`);
    }
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

  // The same one rule every subordinate view's ✕ obeys — drawer.js, and its header
  // is where it is written down.
  $('graph-close').addEventListener('click', () => window.beadcause.closeView());

  async function draw() {
    stop();
    dismissCard();
    closeSheet();
    paused = false;
    userMoved = false;
    loupeOn = false;
    centred = null;
    growthPause.textContent = 'Pause';
    emptyEl.hidden = true;
    growth.hidden = false;
    growthText.textContent = 'asking bd for the graph…';
    growthPause.hidden = true;
    resetCanvas();

    const label = scope === 'bead' && bead ? bead : workspace;
    titleEl.textContent = label;
    publishView(null);
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

  window.addEventListener('resize', () => {
    fit();
    updateLoupe();
  });

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

  // `&open=1` lands on the bead's own text rather than on the graph it lives in.
  // A link made right after filing something is a link to read the thing you filed,
  // and finding one node in a force layout mid-animation is three taps that were
  // never the point.
  //
  // openSheet needs nothing but an id — it fetches the rest from /api/bead — so this
  // does not wait for a node to exist. It waits on draw() only because draw() opens
  // by closing the sheet, and it runs even when draw() failed: a graph that would not
  // load is when having the text anyway is worth most. Dismissing the sheet leaves you
  // on the graph, scoped to that bead, which is where this link used to stop.
  const drawn = draw();
  if (bead && params.get('open') === '1') drawn.finally(() => openSheet({ id: bead }));
})();
