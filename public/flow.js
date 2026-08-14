/*
  The flowchart screen — one renderer, two hosts.

  This file draws the model in lib/flowchart.js, and it is loaded by two different
  things: `/flow` in the app, which fetches `GET /api/flowchart`, and the standalone
  page `node scripts/flowchart.mjs` writes into docs/, which embeds the same object as
  `window.FLOWCHART` and then loads this file verbatim. Hence the one branch at the top
  and nothing else host-specific below it. Two renderers for one drawing is how the
  committed doc and the screen come to disagree about the system they are both about.

  **The stylesheet is in here, as a string, rather than in public/style.css.** That is
  against the grain of every other page and it is deliberate. style.css is a shared file
  with a dozen sessions a week appending to it — test/css.mjs exists because a merge
  once took the tail of one rule into the middle of another — and none of these rules is
  reused by anything. A page-owned block conflicts with nobody, and it is what lets the
  standalone doc be genuinely self-contained rather than shipping a copy of a stylesheet
  that has moved on since it was copied.

  **Colour is never the only distinction.** Every kind has a shape as well as a hue (see
  `mermaidFor`), and every node card carries the kind's name in words. The whole point of
  the screen is a boundary — code here, an agent there — and a boundary you can only see
  if your screen is good and your eyes are rested is not one.
*/
(() => {
  'use strict';

  const root = document.getElementById('flow');
  if (!root) return;

  /* ---------------------------------------------------------------- the styles */

  const SHEET = `
  .fc { max-width: 1100px; margin: 0 auto; padding: 16px 14px 96px; }
  .fc h1 { font-size: 1.35rem; margin: 0 0 4px; letter-spacing: -0.01em; }
  .fc .sub { color: var(--muted); margin: 0 0 18px; font-size: 0.95rem; }

  /* The proportions bar: the one number this drawing is for. */
  .fc-bar { display: flex; height: 12px; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
  .fc-bar > span { display: block; }
  .fc-bar-key { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 8px 0 22px; font-size: 0.8rem; color: var(--muted); }
  .fc-bar-key b { color: var(--text); font-weight: 600; }

  .fc-legend { display: grid; gap: 8px; margin: 0 0 22px; }
  .fc-legend > div { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; }
  .fc-legend .swatch {
    min-width: 68px; text-align: center; font-size: 0.72rem; font-weight: 700;
    padding: 4px 8px; border-radius: 8px; border: 2px solid; white-space: nowrap;
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .fc-legend p b { color: var(--text); }
  .fc-legend p { margin: 0; font-size: 0.86rem; color: var(--prose); line-height: 1.45; }

  .fc-nav { display: flex; flex-wrap: wrap; gap: 6px; margin: 0 0 18px; }
  .fc-nav button {
    font: inherit; font-size: 0.82rem; padding: 7px 11px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted); cursor: pointer;
    min-height: 36px;
  }
  .fc-nav button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: transparent; }

  .fc-flow { border-top: 1px solid var(--line); padding-top: 18px; }
  .fc-flow h2 { font-size: 1.1rem; margin: 0 0 6px; }
  .fc-trigger {
    display: inline-block; font-size: 0.78rem; color: var(--muted);
    border: 1px dashed var(--line); border-radius: 8px; padding: 4px 8px; margin: 0 0 10px;
  }
  .fc-summary { color: var(--prose); font-size: 0.92rem; line-height: 1.55; margin: 0 0 16px; white-space: pre-line; }

  /* Wide diagrams scroll inside their own box; the page never scrolls sideways. */
  .fc-diagram { overflow-x: auto; background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px; margin: 0 0 18px; }
  .fc-diagram svg { max-width: none; min-width: 620px; height: auto; }
  .fc-diagram pre { margin: 0; font-size: 0.72rem; color: var(--muted); white-space: pre; }

  .fc-steps { display: grid; gap: 10px; }
  .fc-step {
    border: 1px solid var(--line); border-left-width: 5px; border-radius: 12px;
    background: var(--surface); padding: 11px 13px; scroll-margin-top: 12px;
  }
  .fc-step.lit { box-shadow: 0 0 0 2px var(--accent); }
  .fc-step h3 { margin: 0 0 4px; font-size: 0.95rem; display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
  .fc-kind { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; padding: 2px 7px; border-radius: 999px; border: 1px solid; }
  .fc-gate { font-size: 0.68rem; color: var(--warn); border: 1px solid var(--warn); border-radius: 999px; padding: 2px 7px; }
  .fc-step p { margin: 0 0 6px; font-size: 0.87rem; line-height: 1.5; color: var(--prose); white-space: pre-line; }
  .fc-src { display: flex; flex-wrap: wrap; gap: 5px; }
  .fc-src code { font-size: 0.72rem; color: var(--muted); background: var(--surface-2); border-radius: 6px; padding: 2px 6px; }

  .fc-agentlink { font-size: 0.78rem; color: var(--accent); text-decoration: none; border-bottom: 1px solid currentColor; }

  .fc-agent { border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); padding: 14px; margin: 0 0 12px; }
  .fc-agent h3 { margin: 0 0 2px; font-size: 1rem; }
  .fc-agent .purpose { color: var(--prose); font-size: 0.88rem; margin: 0 0 10px; line-height: 1.5; }
  .fc-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; margin: 0 0 10px; }
  .fc-fact { background: var(--surface-2); border-radius: 10px; padding: 7px 9px; }
  .fc-fact dt { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--muted); margin: 0 0 2px; }
  .fc-fact dd { margin: 0; font-size: 0.82rem; word-break: break-word; }
  .fc-yes { color: var(--danger); font-weight: 600; }
  .fc-no { color: var(--muted); }
  .fc-agent details { margin-top: 8px; }
  .fc-agent summary { cursor: pointer; font-size: 0.82rem; color: var(--muted); min-height: 32px; }
  .fc-agent pre {
    white-space: pre-wrap; word-break: break-word; font-size: 0.76rem; line-height: 1.5;
    background: var(--surface-2); border-radius: 10px; padding: 10px; margin: 8px 0 0; color: var(--prose);
  }
  .fc-tools { display: flex; flex-wrap: wrap; gap: 4px; margin: 6px 0 0; }
  .fc-tools code { font-size: 0.7rem; background: var(--surface-2); border-radius: 6px; padding: 2px 6px; color: var(--prose); }
  .fc-note { font-size: 0.8rem; color: var(--muted); line-height: 1.5; }

  /* The diagram's own colours. A class per kind, set by mermaidFor; no classDef, so
     these win and follow the colour scheme. The path selector catches the flag and the
     cylinder, which mermaid draws as paths rather than as a rect.
     No backtick anywhere between here and the closing one: this block is a template
     literal, and one inside a CSS comment ends it — which the browser then reports as a
     syntax error thirty lines further down, in code that is perfectly fine. */
  .fc-diagram .node rect,
  .fc-diagram .node polygon,
  .fc-diagram .node circle,
  .fc-diagram .node path { stroke-width: 2px; }
  .fc-diagram .node span,
  .fc-diagram .node p,
  .fc-diagram .node div { color: inherit !important; }
  .fc-diagram .node { cursor: pointer; }
  .fc-diagram .edgeLabel { font-size: 11px; }
  `;

  /** One block per kind, generated so a sixth kind needs no CSS written by hand. */
  function kindCss(kinds) {
    return kinds
      .map((k) => {
        const bg = `hsl(${k.hue} 62% 92%)`;
        const line = `hsl(${k.hue} 48% 42%)`;
        const fg = `hsl(${k.hue} 60% 20%)`;
        const dbg = `hsl(${k.hue} 34% 18%)`;
        const dline = `hsl(${k.hue} 55% 62%)`;
        const dfg = `hsl(${k.hue} 55% 86%)`;
        return `
  :root { --k-${k.id}-bg: ${bg}; --k-${k.id}-line: ${line}; --k-${k.id}-fg: ${fg}; }
  @media (prefers-color-scheme: dark) {
    :root { --k-${k.id}-bg: ${dbg}; --k-${k.id}-line: ${dline}; --k-${k.id}-fg: ${dfg}; }
  }
  .k-${k.id}-swatch { background: var(--k-${k.id}-bg); border-color: var(--k-${k.id}-line); color: var(--k-${k.id}-fg); }
  .fc-step[data-kind="${k.id}"] { border-left-color: var(--k-${k.id}-line); }
  .fc-step[data-kind="${k.id}"] .fc-kind { background: var(--k-${k.id}-bg); border-color: var(--k-${k.id}-line); color: var(--k-${k.id}-fg); }
  .fc-diagram g.k-${k.id} rect,
  .fc-diagram g.k-${k.id} polygon,
  .fc-diagram g.k-${k.id} path { fill: var(--k-${k.id}-bg) !important; stroke: var(--k-${k.id}-line) !important; }
  .fc-diagram g.k-${k.id} .nodeLabel { fill: var(--k-${k.id}-fg) !important; color: var(--k-${k.id}-fg) !important; }`;
      })
      .join('\n');
  }

  /* ------------------------------------------------------------------ plumbing */

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /** The mermaid source for one flow. Kept in the payload so the client never re-derives it. */
  const sourceOf = (flow) => flow.mermaid || '';

  let model = null;
  let current = null;

  /* ------------------------------------------------------------------ drawing */

  function bar(counts, kinds) {
    const total = counts.nodes || 1;
    const cells = kinds
      .map((k) => {
        const n = counts.byKind[k.id] || 0;
        if (!n) return '';
        return `<span style="width:${((n / total) * 100).toFixed(2)}%;background:var(--k-${k.id}-line)" title="${esc(k.label)}: ${n}"></span>`;
      })
      .join('');
    const key = kinds
      .map((k) => `<span><b>${counts.byKind[k.id] || 0}</b> ${esc(k.label.toLowerCase())}</span>`)
      .join('');
    return `<div class="fc-bar">${cells}</div><div class="fc-bar-key">${key}</div>`;
  }

  function legend(kinds) {
    return `<div class="fc-legend">${kinds
      .map(
        (k) => `<div>
        <span class="swatch k-${k.id}-swatch">${esc(k.short)}</span>
        <p><b>${esc(k.label)}.</b> ${esc(k.meaning)}</p>
      </div>`
      )
      .join('')}</div>`;
  }

  function stepCard(flow, node, kinds) {
    const kind = kinds.find((k) => k.id === node.kind);
    const agentLink =
      node.agent && node.agent !== '*'
        ? `<a class="fc-agentlink" href="#agent-${esc(node.agent)}">what this agent is →</a>`
        : node.agent === '*'
          ? `<span class="fc-note">whichever agent kind has just finished a task</span>`
          : '';
    return `<article class="fc-step" id="step-${esc(flow.id)}-${esc(node.id)}" data-node="${esc(node.id)}" data-kind="${esc(node.kind)}">
      <h3>
        <span class="fc-kind">${esc(kind ? kind.short : node.kind)}</span>
        <span>${esc(String(node.label).replace(/\n/g, ' '))}</span>
        ${node.gate ? '<span class="fc-gate">a gate</span>' : ''}
      </h3>
      <p>${esc(node.detail)}</p>
      <div class="fc-src">${(node.source || []).map((s) => `<code>${esc(s)}</code>`).join('')}</div>
      ${agentLink ? `<div style="margin-top:6px">${agentLink}</div>` : ''}
    </article>`;
  }

  function flowSection(flow, kinds) {
    return `<section class="fc-flow" id="flow-${esc(flow.id)}">
      <h2>${esc(flow.icon || '')} ${esc(flow.title)}</h2>
      <div><span class="fc-trigger">Starts when: ${esc(flow.trigger)}</span></div>
      <p class="fc-summary">${esc(flow.summary)}</p>
      <div class="fc-diagram" data-flow="${esc(flow.id)}"><pre>${esc(sourceOf(flow))}</pre></div>
      <div class="fc-steps">${flow.nodes.map((n) => stepCard(flow, n, kinds)).join('')}</div>
    </section>`;
  }

  function fact(label, value, cls = '') {
    return `<div class="fc-fact"><dt>${esc(label)}</dt><dd class="${cls}">${value}</dd></div>`;
  }

  function agentCard(a, model) {
    const where = a.spawnedAt.length
      ? a.spawnedAt.map((s) => `<code>${esc(s.flow)}/${esc(s.node)}</code>`).join(' ')
      : '<span class="fc-no">nothing on this map spawns it</span>';
    const tools = (a.allowedTools || []).length
      ? `<div class="fc-tools">${a.allowedTools.map((t) => `<code>${esc(t)}</code>`).join('')}</div>`
      : `<p class="fc-note">No allowlist — this one is interactive, and you approve in the loop.</p>`;
    return `<article class="fc-agent" id="agent-${esc(a.id)}">
      <h3>${esc(a.emoji)} ${esc(a.title)} <span class="fc-note">— ${esc(a.id)}</span></h3>
      <p class="purpose">${esc(a.purpose)}</p>
      <dl class="fc-facts">
        ${fact('May write to the tracker', a.writes ? 'yes' : 'no', a.writes ? 'fc-yes' : 'fc-no')}
        ${fact('Has a repo of its own', a.ownsRepo ? 'yes — tier 3' : 'no', a.ownsRepo ? 'fc-yes' : 'fc-no')}
        ${fact('Model', a.model ? esc(a.model) : '<span class="fc-no">the config’s, at spawn</span>')}
        ${fact('Timeout', a.timeoutMs ? `${Math.round(a.timeoutMs / 60000)} min` : '<span class="fc-no">none set</span>')}
        ${fact('Permission mode', a.permissionMode ? esc(a.permissionMode) : '<span class="fc-no">the config’s</span>')}
        ${fact('Parses its output', `<code>${esc(a.protocolOwner)}</code>`)}
        ${fact('Writes its brief', `<code>${esc(a.briefOwner)}</code>`)}
        ${fact('Spawned at', where)}
      </dl>
      <details>
        <summary>Its allowlist — ${(a.allowedTools || []).length || 'none'} entr${(a.allowedTools || []).length === 1 ? 'y' : 'ies'}</summary>
        ${tools}
      </details>
      <details>
        <summary>Its role — the amendable half of the system prompt</summary>
        ${
          a.role
            ? `<pre>${esc(a.role)}</pre>`
            : `<p class="fc-note">None, and that is honest rather than missing: this one carries its identity inside the per-invocation brief written by <code>${esc(a.briefOwner)}</code>. An agent noticing the gap and asking for a role is exactly what the amendment loop is for.</p>`
        }
      </details>
      <p class="fc-note" style="margin-top:10px">
        Amendable: ${model.amendableFields.map((f) => `<code>${esc(f)}</code>`).join(' ')}<br>
        Never, whatever you approve: ${model.protectedFields.map((f) => `<code>${esc(f)}</code>`).join(' ')}
      </p>
    </article>`;
  }

  /* ------------------------------------------------------------------- render */

  function draw() {
    const kinds = model.kinds;
    root.innerHTML = `<div class="fc">
      <h1>${esc(model.title)}</h1>
      <p class="sub">${esc(model.subtitle)}</p>
      ${bar(model.counts, kinds)}
      ${legend(kinds)}
      <nav class="fc-nav">${model.flows
        .map((f) => `<button type="button" data-go="${esc(f.id)}">${esc(f.icon || '')} ${esc(f.title.split(/[—-]/)[0].trim())}</button>`)
        .join('')}
        <button type="button" data-go="agents">🧬 The agents</button>
      </nav>
      <div id="fc-body"></div>
    </div>`;
    root.querySelectorAll('.fc-nav button').forEach((b) => {
      b.addEventListener('click', () => show(b.dataset.go));
    });
    show(current || model.flows[0].id);
  }

  function show(id) {
    current = id;
    const body = root.querySelector('#fc-body');
    root.querySelectorAll('.fc-nav button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.go === id));
    });
    if (id === 'agents') {
      body.innerHTML = `<section class="fc-flow">
        <h2>🧬 What each agent is</h2>
        <p class="fc-summary">Read out of lib/foundation.js rather than restated here — one agent, one object, so an amendment you approved on your phone changes what this page says. ${
          model.effective
            ? 'These are the <strong>effective</strong> foundations: the baselines with every approved amendment applied.'
            : 'These are the <strong>baselines</strong> — what ships in the release, before any approved amendment.'
        }</p>
        ${model.agents.map((a) => agentCard(a, model)).join('')}
      </section>`;
      window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
      return;
    }
    const flow = model.flows.find((f) => f.id === id) || model.flows[0];
    body.innerHTML = flowSection(flow, model.kinds);
    window.scrollTo({ top: 0 });
    renderDiagram(flow);
  }

  /**
   * Draw one flow with mermaid, and bind a tap on a shape to the card below it.
   *
   * A failure here leaves the `<pre>` that was already in the box, which is the mermaid
   * source and is perfectly readable. That is the whole fallback: no mermaid (a checkout
   * with no `npm install`, a CSP, an old phone) degrades to the text of the diagram
   * rather than to an empty rectangle.
   */
  async function renderDiagram(flow) {
    const box = root.querySelector(`.fc-diagram[data-flow="${CSS.escape(flow.id)}"]`);
    if (!box || !window.mermaid) return;
    try {
      window.mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', flowchart: { htmlLabels: true, curve: 'basis' } });
      const { svg } = await window.mermaid.render(`fc-${flow.id}-${Date.now()}`, sourceOf(flow));
      box.innerHTML = svg;
      bindTaps(box, flow);
      // Centred, not scrolled to zero. A top-down chart puts its spine down the middle
      // of a canvas wider than a phone, so the honest left edge of the box is whitespace
      // and the first step is off to the right — which reads as a diagram that failed to
      // draw rather than one that scrolls.
      box.scrollLeft = Math.max(0, (box.scrollWidth - box.clientWidth) / 2);
    } catch (err) {
      // Left as the source. Said out loud in the console because a diagram that silently
      // stays text looks like a page that has not finished loading.
      console.warn('[flow] mermaid could not draw', flow.id, err);
    }
  }

  /**
   * Bind each drawn shape to its card.
   *
   * mermaid ids a node group `<diagram>-flowchart-<node>-<n>` — the diagram id this
   * renderer chose, then a fixed word, then the node, then an ordinal. None of that is
   * API, so this does not parse it: it asks, for each node the model says is in this
   * flow, whether an element's id ends the way that node's would. A scheme change then
   * costs the taps and nothing else, and scripts/flow-check.mjs is what says so out loud
   * rather than leaving a diagram that quietly stopped being an index into the detail.
   *
   * Longest id first, because `ready` is a suffix of nothing here but one day will be:
   * the longer candidate has to be tried before the shorter one it ends with.
   *
   * Bound off the DOM rather than with mermaid's own `click`, which needs
   * `securityLevel: 'loose'` — a global relaxation of the renderer that also draws
   * diagrams agents write into bead bodies.
   */
  function bindTaps(box, flow) {
    const known = flow.nodes.map((n) => n.id).sort((a, b) => b.length - a.length);
    const idOf = (raw) =>
      known.find((n) => new RegExp(`flowchart-${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(raw)) || null;
    box.querySelectorAll('g.node').forEach((g) => {
      const id = idOf(g.id || '');
      if (!id) return;
      g.addEventListener('click', () => {
        const card = root.querySelector(`#step-${CSS.escape(`${flow.id}-${id}`)}`);
        if (!card) return;
        root.querySelectorAll('.fc-step.lit').forEach((el) => el.classList.remove('lit'));
        card.classList.add('lit');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }

  /* --------------------------------------------------------------------- boot */

  function start(payload) {
    model = payload;
    const style = document.createElement('style');
    style.textContent = SHEET + kindCss(model.kinds);
    document.head.appendChild(style);
    draw();
  }

  if (window.FLOWCHART) {
    start(window.FLOWCHART);
  } else {
    // `beadcause.token`, and the `x-beadcause-token` header — the same pair every other
    // page here uses. Wrapped because a browser with storage disabled throws on read,
    // and a map is exactly the page somebody opens in a private window.
    const token = (() => {
      try {
        return localStorage.getItem('beadcause.token') || '';
      } catch {
        return '';
      }
    })();
    fetch('/api/flowchart', { headers: token ? { 'x-beadcause-token': token } : {} })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(start)
      .catch((err) => {
        root.innerHTML = `<div class="fc"><h1>The map could not be loaded</h1><p class="sub">${esc(err.message)}</p></div>`;
      });
  }
})();
