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
 * And the thing a phone forced, which the desktop never showed: a graph that fits
 * a phone is a graph too small to read — 128 beads fit at a thirteenth of full
 * size, where a title is 1.4px. So the fitted view stays and a circle in the
 * middle of it is magnified instead. See the loupe section below.
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
      .attr('class', 'gn arrive')
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

  }

  const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1) + '…' : String(s));

  /* -------------------------------------------------------------- growth */

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
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
        growthText.textContent = `${all.length} bead${all.length === 1 ? '' : 's'}`;
        setTimeout(() => (growth.hidden = true), 1600);
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
    $('card-deps').textContent = d.type ? d.type.replace('_', ' ') : '';
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
