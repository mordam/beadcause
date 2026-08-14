/*
  The flowchart screen — one renderer, two hosts.

  This file draws the model in lib/flowchart.js, and it is loaded by two different
  things: `/flow` in the app, which fetches `GET /api/flowchart`, and the standalone
  page `node scripts/flowchart.mjs` writes into docs/, which embeds the same object as
  `window.FLOWCHART` and then loads this file verbatim. Hence the one branch at the top
  and nothing else host-specific below it. Two renderers for one drawing is how the
  committed doc and the screen come to disagree about the system they are both about.

  **The diagram and the words are one thing, not two.** The first version drew the flow
  and then listed every step below it as its own card — which reads as two documents
  about the same subject, and made the diagram a picture you scroll past rather than
  something you use. Now there is exactly one detail card, beside the diagram on a wide
  screen and directly under it on a phone, and tapping a shape fills it. What was a
  hundred and twenty-six cards is a strip of numbered chips: an index, so a step is
  reachable without hunting for it in the drawing, and small enough not to compete with
  the drawing for the page.

  Three rules fall out of that and are worth keeping:

  - **The card is never empty.** Opening a flow selects its first step, so there is no
    state where the right-hand column is an instruction to go and tap something.
  - **Selection is shown in three places at once** — the shape, the chip and the card —
    because on a phone the card is below the fold of the diagram and the only thing that
    says which step you are reading is the one you can see.
  - **The prose column has a width, and the type is small.** This is a reference screen
    read at a desk as often as on a phone; a detail set at body size and run to 1100px is
    a single line of text across a laptop, which is the one layout nobody can read.

  **The stylesheet is in here, as a string, rather than in public/style.css.** That is
  against the grain of every other page and it is deliberate. style.css is a shared file
  with a dozen sessions a week appending to it — test/css.mjs exists because a merge
  once took the tail of one rule into the middle of another — and none of these rules is
  reused by anything. A page-owned block conflicts with nobody, and it is what lets the
  standalone doc be genuinely self-contained rather than shipping a copy of a stylesheet
  that has moved on since it was copied.

  **No backtick may appear between the opening and closing one of SHEET.** It is a
  template literal, and a backtick inside a CSS comment ends it — which the browser then
  reports as a syntax error thirty lines further down, in code that is perfectly fine.

  **Colour is never the only distinction.** Every kind has a shape as well as a hue (see
  `mermaidFor`), and the detail card names the kind in words. The whole point of the
  screen is a boundary — code here, an agent there — and a boundary you can only see if
  your screen is good and your eyes are rested is not one.
*/
(() => {
  'use strict';

  const root = document.getElementById('flow');
  if (!root) return;

  /* ---------------------------------------------------------------- the styles */

  const SHEET = `
  .fc {
    max-width: 1280px; margin: 0 auto; padding: 12px 12px 80px;
    font-size: 12.5px; line-height: 1.5;
  }
  .fc-head { max-width: 68ch; }
  .fc h1 { font-size: 17px; line-height: 1.25; margin: 0 0 3px; letter-spacing: -0.015em; }
  .fc .sub { color: var(--muted); margin: 0 0 11px; font-size: 12px; line-height: 1.45; }

  /* The proportions bar: the one number this drawing is for. */
  .fc-bar { display: flex; height: 7px; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
  .fc-bar > span { display: block; }
  .fc-bar-key { display: flex; flex-wrap: wrap; gap: 2px 12px; margin: 5px 0 11px; font-size: 11px; color: var(--muted); }
  .fc-bar-key b { color: var(--text); font-weight: 600; font-variant-numeric: tabular-nums; }

  .fc-legend { margin: 0 0 12px; border: 1px solid var(--line); border-radius: 10px; background: var(--surface); }
  /* Shrunk to its own label while closed. Full width, it read as an empty panel
     rather than as something to open. */
  .fc-legend:not([open]) { max-width: max-content; }
  .fc-legend > summary {
    cursor: pointer; list-style: none; padding: 6px 10px; font-size: 11.5px; color: var(--muted);
    display: flex; justify-content: space-between; gap: 8px; align-items: center; min-height: 30px;
  }
  .fc-legend > summary::-webkit-details-marker { display: none; }
  .fc-legend > summary::after { content: "▾"; transition: transform 0.15s; }
  .fc-legend[open] > summary::after { transform: rotate(180deg); }
  .fc-legend-body { display: grid; gap: 6px; padding: 0 11px 10px; }
  .fc-legend-body > div { display: grid; grid-template-columns: 66px 1fr; gap: 9px; align-items: baseline; }
  .fc-legend .swatch {
    text-align: center; font-size: 9.5px; font-weight: 700; padding: 2px 5px;
    border-radius: 6px; border: 1.5px solid; white-space: nowrap;
    text-transform: uppercase; letter-spacing: 0.05em;
  }
  .fc-legend p { margin: 0; font-size: 11.5px; color: var(--prose); line-height: 1.45; max-width: 74ch; }
  .fc-legend p b { color: var(--text); }

  .fc-nav { display: flex; flex-wrap: wrap; gap: 4px; margin: 0 0 12px; }
  .fc-nav button {
    font: inherit; font-size: 11.5px; padding: 5px 9px; border-radius: 999px;
    border: 1px solid var(--line); background: var(--surface); color: var(--muted); cursor: pointer;
    min-height: 30px; white-space: nowrap;
  }
  .fc-nav button[aria-pressed="true"] { background: var(--accent); color: var(--accent-ink); border-color: transparent; font-weight: 600; }

  .fc-flow > h2 { font-size: 14px; line-height: 1.3; margin: 0 0 5px; max-width: 46ch; }
  .fc-trigger {
    display: inline-block; font-size: 11px; color: var(--muted); line-height: 1.4;
    border: 1px dashed var(--line); border-radius: 6px; padding: 3px 7px; margin: 0 0 8px;
  }
  .fc-summary { color: var(--prose); font-size: 12px; line-height: 1.55; margin: 0 0 11px; max-width: 84ch; }
  .fc-summary p { margin: 0 0 6px; }
  .fc-summary p:last-child { margin: 0; }

  /* Diagram beside detail on anything wide enough for both; stacked otherwise, with the
     card immediately under the drawing so a tap and its answer stay in one glance. */
  .fc-split { display: grid; gap: 10px; align-items: start; }
  @media (min-width: 900px) {
    /* The card takes a real share rather than a fixed 340px. A top-down chart is about
       740px wide at this type size, so a fixed sidebar left five hundred pixels of empty
       box beside it on a laptop and gave the prose a 40-character measure — the two
       complaints are the same pixels. */
    .fc-split { grid-template-columns: minmax(0, 1.55fr) minmax(300px, 1fr); }
    .fc-detail { position: sticky; top: 10px; }
    .fc-diagram { max-height: min(80vh, 900px); overflow: auto; }
  }

  /* Wide diagrams scroll inside their own box; the page never scrolls sideways. */
  .fc-diagram {
    overflow-x: auto; background: var(--surface); border: 1px solid var(--line);
    border-radius: 10px; padding: 10px;
  }
  .fc-diagram svg { max-width: none; min-width: 560px; height: auto; display: block; margin: 0 auto; }
  .fc-diagram pre { margin: 0; font-size: 10px; color: var(--muted); white-space: pre; }
  .fc-diagram .node { cursor: pointer; }
  .fc-diagram .node rect,
  .fc-diagram .node polygon,
  .fc-diagram .node circle,
  .fc-diagram .node path { stroke-width: 1.5px; transition: stroke-width 0.12s; }
  .fc-diagram .node span,
  .fc-diagram .node p,
  .fc-diagram .node div { color: inherit !important; }
  /* The selected shape, and it has to be findable at a glance in a chart of sixteen.
     Four signals at once, because any one of them alone is a shrug on a phone in
     daylight: everything else steps back, the shape keeps its kind colour but takes the
     accent as its outline, it gets a halo, and it flashes once when it changes so a tap
     on a shape you cannot quite see still tells you where it landed. */
  .fc-diagram.has-sel g.node:not(.sel) { opacity: 0.42; }
  .fc-diagram g.node { opacity: 1; transition: opacity 0.15s; }
  .fc-diagram.has-sel g.node:not(.sel) .nodeLabel { font-weight: 400; }
  .fc-diagram .node.sel rect,
  .fc-diagram .node.sel polygon,
  .fc-diagram .node.sel path {
    stroke: var(--accent) !important; stroke-width: 3px;
    filter: drop-shadow(0 0 5px var(--accent));
  }
  .fc-diagram .node.sel .nodeLabel { font-weight: 700; }
  .fc-diagram .node.sel { animation: fc-pop 0.34s ease-out; }
  @keyframes fc-pop {
    0% { filter: brightness(1.9); }
    100% { filter: brightness(1); }
  }
  @media (prefers-reduced-motion: reduce) {
    .fc-diagram .node.sel { animation: none; }
  }
  .fc-diagram .nodeLabel { font-size: 11.5px; }
  .fc-diagram .edgeLabel { font-size: 10px; }

  /* The one card. Everything a step is, in the place you were already looking. */
  .fc-detail {
    border: 1px solid var(--line); border-left-width: 4px; border-radius: 10px;
    background: var(--surface); padding: 10px 12px 11px;
  }
  .fc-detail-top { display: flex; gap: 5px; align-items: center; flex-wrap: wrap; margin: 0 0 6px; }
  .fc-kind {
    font-size: 9.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
    padding: 2px 6px; border-radius: 999px; border: 1px solid;
  }
  .fc-gate { font-size: 9.5px; color: var(--warn); border: 1px solid var(--warn); border-radius: 999px; padding: 2px 6px; letter-spacing: 0.04em; }
  .fc-step-n { margin-left: auto; font-size: 10px; color: var(--muted); font-variant-numeric: tabular-nums; }
  .fc-detail h3 { margin: 0 0 5px; font-size: 12.5px; line-height: 1.3; letter-spacing: -0.005em; max-width: 38ch; }
  .fc-detail .body { margin: 0 0 8px; font-size: 11.5px; line-height: 1.55; color: var(--prose); max-width: 68ch; }
  .fc-detail .body p { margin: 0 0 6px; }
  .fc-detail .body p:last-child { margin: 0; }
  .fc-detail .body strong { color: var(--text); font-weight: 600; }
  .fc-where { border-top: 1px solid var(--line); padding-top: 7px; }
  .fc-where h4 { margin: 0 0 4px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600; }
  .fc-src { display: flex; flex-wrap: wrap; gap: 3px; }
  .fc-src code { font-size: 10px; color: var(--prose); background: var(--surface-2); border-radius: 5px; padding: 2px 5px; }
  .fc-agentlink {
    display: inline-block; margin-top: 6px; font-size: 11px; color: var(--accent);
    text-decoration: none; border-bottom: 1px solid currentColor;
  }

  .fc-steps { display: flex; gap: 4px; align-items: center; margin: 7px 0 0; padding-top: 7px; border-top: 1px solid var(--line); }
  .fc-steps button {
    font: inherit; font-size: 10.5px; padding: 3px 8px; border-radius: 6px; cursor: pointer;
    border: 1px solid var(--line); background: var(--surface-2); color: var(--muted); min-height: 28px;
  }
  .fc-steps .fc-pos { margin: 0 auto; font-size: 10px; color: var(--muted); }

  /* The index. Small on purpose: it is how you reach a step you cannot find in the
     drawing, not a second copy of the drawing. */
  .fc-index { margin: 12px 0 0; }
  .fc-index h4 { margin: 0 0 5px; font-size: 9.5px; text-transform: uppercase; letter-spacing: 0.07em; color: var(--muted); font-weight: 600; }
  .fc-chips { display: flex; flex-wrap: wrap; gap: 4px; }
  .fc-chip {
    font: inherit; font-size: 10.5px; text-align: left; cursor: pointer; min-height: 24px;
    padding: 3px 7px 3px 6px; border-radius: 6px; border: 1px solid var(--line);
    border-left-width: 3px; background: var(--surface); color: var(--prose);
    display: inline-flex; gap: 5px; align-items: center; max-width: 100%;
  }
  .fc-chip .n { color: var(--muted); font-variant-numeric: tabular-nums; font-size: 9.5px; }
  .fc-chip .t { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 24ch; }
  .fc-chip[aria-pressed="true"] { background: var(--surface-2); color: var(--text); border-color: var(--accent); font-weight: 600; }

  /* The agents pane. Two columns where there is room — five agents read as a comparison
     rather than as five documents, and that is the whole point of putting them together. */
  .fc-agents { display: grid; gap: 10px; }
  @media (min-width: 900px) { .fc-agents { grid-template-columns: 1fr 1fr; align-items: start; } }
  .fc-agent { border: 1px solid var(--line); border-radius: 10px; background: var(--surface); padding: 11px 13px; }
  .fc-agent h3 { margin: 0 0 2px; font-size: 12.5px; line-height: 1.3; }
  .fc-agent .id { color: var(--muted); font-weight: 400; font-size: 10.5px; }
  .fc-agent .purpose { color: var(--prose); font-size: 11.5px; margin: 0 0 8px; line-height: 1.45; max-width: 66ch; }
  .fc-facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 5px; margin: 0 0 8px; }
  .fc-fact { background: var(--surface-2); border-radius: 7px; padding: 5px 7px; }
  .fc-fact dt { font-size: 9px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); margin: 0 0 1px; }
  .fc-fact dd { margin: 0; font-size: 11px; line-height: 1.35; word-break: break-word; }
  .fc-yes { color: var(--danger); font-weight: 600; }
  .fc-no { color: var(--muted); }
  .fc-agent details { margin-top: 6px; border-top: 1px solid var(--line); padding-top: 6px; }
  .fc-agent summary { cursor: pointer; font-size: 11px; color: var(--muted); min-height: 26px; display: flex; align-items: center; }
  .fc-agent pre {
    white-space: pre-wrap; word-break: break-word; font-size: 10.5px; line-height: 1.5;
    background: var(--surface-2); border-radius: 8px; padding: 9px; margin: 6px 0 0; color: var(--prose);
  }
  .fc-tools { display: flex; flex-wrap: wrap; gap: 3px; margin: 6px 0 0; }
  .fc-tools code { font-size: 9.5px; background: var(--surface-2); border-radius: 5px; padding: 2px 5px; color: var(--prose); }
  .fc-note { font-size: 11px; color: var(--muted); line-height: 1.45; max-width: 80ch; }
  .fc-amended { color: var(--warn); margin: 0 0 8px; }
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
  .fc-detail[data-kind="${k.id}"] { border-left-color: var(--k-${k.id}-line); }
  .fc-detail[data-kind="${k.id}"] .fc-kind { background: var(--k-${k.id}-bg); border-color: var(--k-${k.id}-line); color: var(--k-${k.id}-fg); }
  .fc-chip[data-kind="${k.id}"] { border-left-color: var(--k-${k.id}-line); }
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

  /**
   * Prose from the model, as paragraphs.
   *
   * Three things happen here and the first is the one that matters. A detail in
   * lib/flowchart.js is a template literal wrapped to fit an 100-column source file, so
   * its single newlines are an accident of where the author's editor ended a line —
   * rendering them (which `white-space: pre-line` did) reflows the card into the shape
   * of the *file*, with breaks mid-sentence and a ragged right edge that reads as
   * broken. A blank line is a real paragraph break and the only one; everything else
   * joins.
   *
   * Then `**bold**` and `*italic*`, because the sentences worth emphasising are already
   * written that way in the model and printing literal asterisks on the one screen meant
   * for reading them would be the wrong half of plain text. Escaped first and marked up
   * second, so nothing in the text can become a tag.
   */
  const prose = (s) =>
    esc(s)
      .split(/\n\s*\n/)
      .map((para) => para.replace(/\s*\n\s*/g, ' ').trim())
      .filter(Boolean)
      .map((para) =>
        `<p>${para.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')}</p>`
      )
      .join('');

  /** The label, on one line, for a chip or a heading. */
  const flat = (s) => String(s).replace(/\n/g, ' ');

  /**
   * A flow's short name, for a nav pill and the card's footer.
   *
   * Written in the model — see `short` there. The fallback is for a payload from an
   * older daemon than this file, where a pill saying too much beats a pill saying
   * nothing.
   */
  const shortName = (f) => f.short || flat(f.title).split(/[—-]/)[0].trim();

  /** The mermaid source for one flow. Kept in the payload so the client never re-derives it. */
  const sourceOf = (flow) => flow.mermaid || '';

  let model = null;
  let current = null;
  /** Which step of the current flow the card is showing. An index, because the card steps. */
  let step = 0;

  /* ------------------------------------------------------------------ the head */

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

  /**
   * The legend, folded away by default.
   *
   * It is the thing you read once and never again, and open it was the first two
   * screenfuls of a page whose subject is a diagram. The bar above it carries the same
   * six colours in the same order, so the fold costs nothing at a glance.
   */
  function legend(kinds) {
    return `<details class="fc-legend">
      <summary>What the six colours mean</summary>
      <div class="fc-legend-body">${kinds
        .map(
          (k) => `<div>
          <span class="swatch k-${k.id}-swatch">${esc(k.short)}</span>
          <p><b>${esc(k.label)}.</b> ${esc(k.meaning)}</p>
        </div>`
        )
        .join('')}</div>
    </details>`;
  }

  /* --------------------------------------------------------------- the one card */

  function detailCard(flow, i) {
    const node = flow.nodes[i];
    const kind = model.kinds.find((k) => k.id === node.kind);
    const agent = node.agent && node.agent !== '*' ? model.agents.find((a) => a.id === node.agent) : null;
    const link = agent
      ? `<a class="fc-agentlink" href="#agent-${esc(agent.id)}" data-agent="${esc(agent.id)}">${esc(agent.emoji)} what ${esc(agent.name)} may do →</a>`
      : node.agent === '*'
        ? `<p class="fc-note" style="margin:7px 0 0">Whichever kind has just finished a task — all five can argue with their own foundation.</p>`
        : '';
    return `<aside class="fc-detail" data-kind="${esc(node.kind)}" data-node="${esc(node.id)}" tabindex="-1">
      <div class="fc-detail-top">
        <span class="fc-kind">${esc(kind ? kind.short : node.kind)}</span>
        ${node.gate ? '<span class="fc-gate">gate</span>' : ''}
        <span class="fc-step-n">${i + 1} / ${flow.nodes.length}</span>
      </div>
      <h3>${esc(flat(node.label))}</h3>
      <div class="body">${prose(node.detail)}</div>
      <div class="fc-where">
        <h4>Where it happens</h4>
        <div class="fc-src">${(node.source || []).map((s) => `<code>${esc(s)}</code>`).join('')}</div>
        ${link}
      </div>
      <div class="fc-steps">
        <button type="button" data-move="-1" aria-label="Previous step">◀</button>
        <span class="fc-pos">${esc(shortName(flow))}</span>
        <button type="button" data-move="1" aria-label="Next step">▶</button>
      </div>
    </aside>`;
  }

  function indexChips(flow, i) {
    return `<div class="fc-index">
      <h4>Every step, in order</h4>
      <div class="fc-chips">${flow.nodes
        .map(
          (n, k) => `<button type="button" class="fc-chip" data-kind="${esc(n.kind)}" data-go-step="${k}"
          aria-pressed="${k === i}"><span class="n">${k + 1}</span><span class="t">${esc(flat(n.label))}</span></button>`
        )
        .join('')}</div>
    </div>`;
  }

  function flowSection(flow, i) {
    return `<section class="fc-flow" id="flow-${esc(flow.id)}">
      <h2>${esc(flow.icon || '')} ${esc(flow.title)}</h2>
      <div><span class="fc-trigger">Starts when: ${esc(flow.trigger)}</span></div>
      <div class="fc-summary">${prose(flow.summary)}</div>
      <div class="fc-split">
        <div class="fc-diagram" data-flow="${esc(flow.id)}"><pre>${esc(sourceOf(flow))}</pre></div>
        ${detailCard(flow, i)}
      </div>
      ${indexChips(flow, i)}
    </section>`;
  }

  /* ------------------------------------------------------------------- agents */

  function fact(label, value, cls = '') {
    return `<div class="fc-fact"><dt>${esc(label)}</dt><dd class="${cls}">${value}</dd></div>`;
  }

  function agentCard(a) {
    const where = a.spawnedAt.length
      ? a.spawnedAt.map((sp) => `<code>${esc(sp.flow)}/${esc(sp.node)}</code>`).join(' ')
      : '<span class="fc-no">nothing on this map spawns it</span>';
    const tools = (a.allowedTools || []).length
      ? `<div class="fc-tools">${a.allowedTools.map((t) => `<code>${esc(t)}</code>`).join('')}</div>`
      : `<p class="fc-note" style="margin:6px 0 0">No allowlist — this one is interactive, and you approve in the loop.</p>`;
    return `<article class="fc-agent" id="agent-${esc(a.id)}">
      <h3>${esc(a.emoji)} ${esc(a.title)} <span class="id">${esc(a.id)}</span></h3>
      <p class="purpose">${esc(a.purpose)}</p>
      ${
        a.amended.length
          ? `<p class="fc-note fc-amended">Amended on this Mac: ${a.amended.map((f) => `<code>${esc(f)}</code>`).join(' ')}</p>`
          : ''
      }
      <dl class="fc-facts">
        ${fact('Writes to the tracker', a.writes ? 'yes' : 'no', a.writes ? 'fc-yes' : 'fc-no')}
        ${fact('Repo of its own', a.ownsRepo ? 'yes — tier 3' : 'no', a.ownsRepo ? 'fc-yes' : 'fc-no')}
        ${fact('Model', a.model ? esc(a.model) : '<span class="fc-no">the config’s</span>')}
        ${fact('Timeout', a.timeoutMs ? `${Math.round(a.timeoutMs / 60000)} min` : '<span class="fc-no">none set</span>')}
        ${fact('Permission mode', a.permissionMode ? esc(a.permissionMode) : '<span class="fc-no">the config’s</span>')}
        ${fact('Parses its output', `<code>${esc(a.protocolOwner)}</code>`)}
        ${fact('Writes its brief', `<code>${esc(a.briefOwner)}</code>`)}
        ${fact('Spawned at', where)}
      </dl>
      <details>
        <summary>Allowlist — ${(a.allowedTools || []).length || 'none'} entr${(a.allowedTools || []).length === 1 ? 'y' : 'ies'}</summary>
        ${tools}
      </details>
      <details>
        <summary>Role — the amendable half of the system prompt</summary>
        ${
          a.role
            ? `<pre>${esc(a.role)}</pre>`
            : `<p class="fc-note" style="margin:6px 0 0">None, and that is honest rather than missing: this one carries its identity inside the per-invocation brief written by <code>${esc(a.briefOwner)}</code>. An agent noticing the gap and asking for a role is exactly what the amendment loop is for.</p>`
        }
      </details>
    </article>`;
  }

  function agentsSection() {
    return `<section class="fc-flow">
      <h2>🧬 What each agent is</h2>
      <div class="fc-summary"><p>${
        model.effective
          ? 'Read out of lib/foundation.js at the moment you asked — the <strong>effective</strong> foundations, which is the baselines with every amendment you have approved on this Mac applied.'
          : 'Read out of lib/foundation.js — the <strong>baselines</strong>, which is what ships in the release, before any approved amendment.'
      } Nothing about an agent is restated on this page: a diagram carrying its own copy of an allowlist would be a second definition of an agent, which is the thing lib/foundation.js exists to prevent.</p></div>
      <div class="fc-agents">${model.agents.map(agentCard).join('')}</div>
      <p class="fc-note" style="margin-top:10px">Amendable: ${model.amendableFields.map((f) => `<code>${esc(f)}</code>`).join(' ')} · Never, whatever you approve: ${model.protectedFields
        .map((f) => `<code>${esc(f)}</code>`)
        .join(' ')}</p>
    </section>`;
  }

  /* ------------------------------------------------------------------- render */

  function draw() {
    root.innerHTML = `<div class="fc">
      <div class="fc-head">
        <h1>${esc(model.title)}</h1>
        <p class="sub">${esc(model.subtitle)}</p>
      </div>
      ${bar(model.counts, model.kinds)}
      ${legend(model.kinds)}
      <nav class="fc-nav">${model.flows
        .map((f) => `<button type="button" data-go="${esc(f.id)}">${esc(f.icon || '')} ${esc(shortName(f))}</button>`)
        .join('')}
        <button type="button" data-go="agents">🧬 The agents</button>
      </nav>
      <div id="fc-body"></div>
    </div>`;
    root.querySelector('.fc-nav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-go]');
      if (b) show(b.dataset.go);
    });
    // One listener for the whole body rather than one per chip and button, because the
    // body is replaced on every selection and re-binding forty chips each time is how a
    // repaint comes to cost more than the fetch it saved.
    root.querySelector('#fc-body').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-go-step]');
      if (chip) return select(Number(chip.dataset.goStep));
      // `data-move` and not `data-step`: the drawn shapes carry `data-step` (see
      // `bindTaps`) and they sit inside this same subtree, so a tap on a node was read
      // here as "move the card by N" as well as by its own handler — which selected a
      // step nobody had pointed at, in the one gesture the whole page is built on.
      const arrow = e.target.closest('[data-move]');
      if (arrow) {
        const flow = flowNow();
        return select((step + Number(arrow.dataset.move) + flow.nodes.length) % flow.nodes.length);
      }
      const link = e.target.closest('[data-agent]');
      if (link) {
        e.preventDefault();
        show('agents');
        const card = root.querySelector(`#agent-${CSS.escape(link.dataset.agent)}`);
        if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
    show(current || model.flows[0].id);
  }

  const flowNow = () => model.flows.find((f) => f.id === current) || model.flows[0];

  function show(id) {
    current = id;
    step = 0;
    const body = root.querySelector('#fc-body');
    root.querySelectorAll('.fc-nav button').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.go === id));
    });
    if (id === 'agents') {
      body.innerHTML = agentsSection();
      window.scrollTo({ top: 0 });
      return;
    }
    const flow = flowNow();
    body.innerHTML = flowSection(flow, step);
    window.scrollTo({ top: 0 });
    renderDiagram(flow);
  }

  /**
   * Move the card to step `i`, and say so in all three places at once.
   *
   * The diagram is patched rather than redrawn: mermaid takes 50–200ms per flow, and
   * re-rendering it to move a highlight would make stepping through a flow feel like
   * loading a page each time.
   *
   * `scroll` is what a tap on a *shape* asks for and nothing else does. On a phone the
   * card sits under a diagram taller than the viewport, so filling it from a tap up in
   * the drawing puts the answer entirely off screen — and then only when it really is
   * off screen, because scrolling a page that did not need it is the jolt that makes a
   * tap feel like a navigation.
   */
  function select(i, { scroll = false } = {}) {
    const flow = flowNow();
    step = Math.max(0, Math.min(i, flow.nodes.length - 1));
    const old = root.querySelector('.fc-detail');
    if (old) old.outerHTML = detailCard(flow, step);
    const chips = root.querySelector('.fc-chips');
    if (chips) {
      chips.querySelectorAll('[data-go-step]').forEach((c) => {
        c.setAttribute('aria-pressed', String(Number(c.dataset.goStep) === step));
      });
    }
    const box = root.querySelector('.fc-diagram');
    if (box) {
      box.querySelectorAll('g.node.sel').forEach((g) => g.classList.remove('sel'));
      const g = box.querySelector(`g.node[data-step="${step}"]`);
      if (g) g.classList.add('sel');
      // The dimming of everything else hangs off the box rather than off each node, so
      // it is one class to write instead of fifteen — and so a diagram mermaid failed to
      // draw is never left with every shape faded and nothing lit.
      box.classList.toggle('has-sel', Boolean(g));
      // And bring it into view inside the box, which scrolls in both axes on a phone: a
      // step chosen from the index below is otherwise selected somewhere off the edge of
      // a diagram that looks unchanged.
      if (g && g.scrollIntoView) g.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (scroll) {
      const card = root.querySelector('.fc-detail');
      if (card) {
        const r = card.getBoundingClientRect();
        if (r.top < 0 || r.bottom > window.innerHeight) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  }

  /**
   * Draw one flow with mermaid, and bind a tap on a shape to the card.
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
      const dark = matchMedia('(prefers-color-scheme: dark)').matches;
      window.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'neutral',
        fontFamily: 'inherit',
        flowchart: { htmlLabels: true, curve: 'basis', padding: 6, nodeSpacing: 30, rankSpacing: 34 },
      });
      const { svg } = await window.mermaid.render(`fc-${flow.id}-${Date.now()}`, sourceOf(flow));
      box.innerHTML = svg;
      bindTaps(box, flow);
      select(step);
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
   * Stamp each drawn shape with its step number, and bind the tap.
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
    const byLength = flow.nodes.map((n, i) => ({ id: n.id, i })).sort((a, b) => b.id.length - a.id.length);
    const stepOf = (raw) => {
      const hit = byLength.find((n) =>
        new RegExp(`flowchart-${n.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-\\d+$`).test(raw)
      );
      return hit ? hit.i : null;
    };
    box.querySelectorAll('g.node').forEach((g) => {
      const i = stepOf(g.id || '');
      if (i === null) return;
      // Written onto the element so `select` can find it again without re-deriving the
      // id scheme every time the card moves.
      g.dataset.step = String(i);
      g.addEventListener('click', () => select(i, { scroll: true }));
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
