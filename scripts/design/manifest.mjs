// What the Claude Design project is made of.
//
// One entry per card. `markup` is the app's own markup with synthetic content in it —
// real structure, invented beads. Nothing here is scraped from the running instance,
// deliberately: the project lives on claude.ai and real bead titles, agent logs and
// account addresses have no business being uploaded to it.
//
// The build slices CSS strictly against the classes each `markup` renders, so a class
// named here that the markup does not carry contributes nothing, and a class the markup
// carries that style.css never styles is simply inert. Add `extraClasses` only for
// state variants a static preview cannot show (`.busy`, `.on`).

import { SURFACES } from './cards-surfaces.mjs';

const TOKENS = [
  ['--bg', 'the page'],
  ['--surface', 'a card, a button, anything raised off the page'],
  ['--surface-2', 'raised again — a menu over a card, an inset well'],
  ['--line', 'every border and rule in the app'],
  ['--text', 'headings and anything you act on'],
  ['--prose', 'long-form body copy, a step below --text so it reads calmer at length'],
  ['--muted', 'metadata, captions, the second grain'],
  ['--accent', 'the live thing: the pulse, the primary button, the current tab'],
  ['--accent-ink', 'what is legible *on* --accent'],
  ['--warn', 'a state worth a second look'],
  ['--danger', 'destructive, and a failure'],
  ['--bead-answered', 'the bead you answered, in flight'],
  ['--bead-made', 'the beads your decision created, in flight'],
];

const swatches = (rows) => rows.map(([name, use]) => `
  <div class="ds-sw">
    <span class="ds-chip" style="background: var(${name})"></span>
    <code>${name}</code>
    <span class="ds-use">${use}</span>
  </div>`).join('');

const SWATCH_CSS = `
.ds-sw { display: grid; grid-template-columns: 44px 148px 1fr; align-items: center; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.ds-sw:last-child { border-bottom: 0; }
.ds-chip { width: 44px; height: 26px; border-radius: 7px; box-shadow: inset 0 0 0 1px var(--line); display: block; }
.ds-sw code { font: 12px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); }
.ds-use { color: var(--muted); font-size: 13px; }
.ds-scale > div { border-bottom: 1px solid var(--line); padding: 10px 0; }
.ds-scale > div:last-child { border-bottom: 0; }
.ds-scale small { display: block; color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; margin-bottom: 4px; }
.ds-box { display: flex; align-items: flex-end; gap: 14px; }
.ds-box figure { margin: 0; text-align: center; color: var(--muted); font-size: 11px; }
.ds-box i { display: block; background: var(--accent); border-radius: 4px; margin-bottom: 6px; }
`;

const CORE = [
  {
    group: 'Foundations',
    cards: [
      {
        path: 'foundations/color.html',
        name: 'Colour',
        subtitle: '13 tokens, dark and light',
        viewport: { width: 620, height: 640 },
        note: `Every colour in Beadcause is one of these. The dark values are the ones in <b>:root</b>; the light set is a <b>prefers-color-scheme</b> override of the same names, so nothing in the app ever branches on theme — it names a role and gets the right value. Toggle your system theme to see both.`,
        extraCss: SWATCH_CSS,
        markup: `<div>${swatches(TOKENS)}</div>`,
      },
      {
        path: 'foundations/two-accents.html',
        name: 'Why two greens',
        subtitle: '--bead-answered vs --bead-made',
        viewport: { width: 620, height: 340 },
        note: `The one place the palette deliberately steps outside <b>--accent</b>. When an answer is submitted it collapses into beads that fly to the app mark; the bead you <i>answered</i> and the beads your decision <i>created</i> have to be told apart from each other at a glance, and both from the teal every other live thing already uses. In the light scheme both go a step darker, because they are drawn on a near-white page.`,
        extraCss: SWATCH_CSS,
        markup: `<div>${swatches(TOKENS.slice(-2))}</div>`,
      },
      {
        path: 'foundations/type.html',
        name: 'Type',
        subtitle: 'System stack, four working sizes',
        viewport: { width: 620, height: 520 },
        note: `One family — the platform's own UI face — at 16px/1.5. There is no type scale as such; sizes are chosen per role, and these four carry almost the whole app.`,
        extraCss: SWATCH_CSS,
        markup: `<div class="ds-scale">
  <div><small>17px / 650 · page title</small><div style="font-size:17px;font-weight:650;letter-spacing:-.01em">Advocates</div></div>
  <div><small>16px / 1.5 · body, the default</small><div>Should the merge queue close the worker's bead, or leave it open for review?</div></div>
  <div><small>15px / 1.55 · --prose · long form</small><div style="font-size:15px;line-height:1.55;color:var(--prose)">Long-form prose sits a step below headings — it reads calmer at length, which matters on a brief that runs several screens before you reach the answer box.</div></div>
  <div><small>13px · --muted · metadata</small><div style="font-size:13px;color:var(--muted)">beadcause · bc-z665 · 4m ago</div></div>
  <div><small>11px / .08em uppercase · section label</small><div style="font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted)">Start one in</div></div>
</div>`,
      },
      {
        path: 'foundations/space.html',
        name: 'Space & shape',
        subtitle: '--radius 14px, --tap 48px',
        viewport: { width: 620, height: 380 },
        note: `Two tokens and a habit. <b>--radius: 14px</b> is the card corner; controls inside a card step down to 11px so they read as sitting <i>in</i> it. <b>--tap: 48px</b> is the floor for anything a thumb lands on — this is a phone app first, and the desktop pages inherit it rather than shrinking.`,
        extraCss: SWATCH_CSS,
        markup: `<div class="ds-box">
  <figure><i style="width:48px;height:48px"></i>--tap<br>48px</figure>
  <figure><i style="width:40px;height:40px;border-radius:11px"></i>icon-btn<br>40px / r11</figure>
  <figure><i style="width:96px;height:56px;border-radius:14px"></i>--radius<br>14px</figure>
  <figure><i style="width:16px;height:16px"></i>gap<br>16px</figure>
  <figure><i style="width:12px;height:12px"></i>gap<br>12px</figure>
  <figure><i style="width:9px;height:9px"></i>gap<br>9px</figure>
</div>`,
      },
    ],
  },

  {
    group: 'Chrome',
    cards: [
      {
        path: 'chrome/topbar.html',
        name: 'Top bar',
        subtitle: 'Mark, pulse, and up to four actions',
        viewport: { width: 420, height: 200 },
        note: `Sticky, blurred over the page, one hairline underneath. The mark is the app icon rather than the word — the phone already says "Beadcause" three times over. The bar is <b>full at four buttons</b>: a fifth wraps it to three rows on both phone widths, which <code>scripts/topbar-check.mjs</code> measures rather than assumes.`,
        markup: `<header class="topbar">
  <div class="brand">
    <span class="dot"></span>
    <h1 class="mark"><img src="data:image/svg+xml;utf8,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b0f14'/%3E%3Ccircle cx='22' cy='32' r='7' fill='%235eead4'/%3E%3Ccircle cx='42' cy='22' r='6' fill='%2360a5fa'/%3E%3Ccircle cx='42' cy='43' r='6' fill='%234ade80'/%3E%3C/svg%3E" alt="Beadcause" width="26" height="26"></h1>
  </div>
  <div class="sheet-actions">
    <a href="#" class="icon-btn" aria-label="Foundations">⚖️<span class="badge">3</span></a>
    <button class="icon-btn" aria-label="Open in Chrome">🌐</button>
    <button class="icon-btn" aria-label="Refresh">⟳</button>
  </div>
</header>`,
      },
      {
        path: 'chrome/tabbar.html',
        name: 'Tab bar',
        subtitle: 'Five standing views, badged',
        viewport: { width: 420, height: 180 },
        note: `Fixed to the foot of every standing view. The current tab is a <b>&lt;span&gt;, not a link</b> — tapping where you already are should do nothing, and an anchor pointed at this page would throw the list and your scroll position away to rebuild the same screen. The badge sits on the icon rather than beside the label, so the number is on the thing you tap.`,
        bodyClass: 'has-tabbar',
        markup: `<nav class="tabbar" aria-label="Views">
  <span class="tab-item" data-tab="inbox" aria-current="page">
    <span class="tab-icon" aria-hidden="true">📥<span class="tab-badge">4</span></span>
    <span class="tab-label">Inbox</span>
  </span>
  <a class="tab-item" data-tab="advocates" href="#">
    <span class="tab-icon" aria-hidden="true">🛰<span class="tab-badge">9+</span></span>
    <span class="tab-label">Advocates</span>
  </a>
  <a class="tab-item" data-tab="prs" href="#">
    <span class="tab-icon" aria-hidden="true">🔀</span>
    <span class="tab-label">PRs</span>
  </a>
  <a class="tab-item" data-tab="history" href="#">
    <span class="tab-icon" aria-hidden="true">📜</span>
    <span class="tab-label">History</span>
  </a>
  <a class="tab-item" data-tab="admin" href="#">
    <span class="tab-icon" aria-hidden="true">⏸</span>
    <span class="tab-label">Admin</span>
  </a>
</nav>`,
      },
      {
        path: 'chrome/pulse.html',
        name: 'Pulse dot',
        subtitle: 'Idle and busy',
        viewport: { width: 420, height: 160 },
        note: `Nine pixels of "the daemon is alive". At rest it is a flat accent circle; while a request is in flight <b>.busy</b> runs a 1.1s ring out of it. It is the only always-on liveness signal in the chrome, which is why it sits left of the mark rather than in a corner.`,
        extraClasses: ['busy'],
        markup: `<div class="brand"><span class="dot"></span><span class="dot busy"></span></div>`,
      },
      {
        path: 'chrome/icon-buttons.html',
        name: 'Icon buttons',
        subtitle: 'Button and anchor, badged, hoisted',
        viewport: { width: 420, height: 200 },
        note: `40×40, 11px corner, one glyph. Several of these are anchors rather than buttons — an inline anchor ignores height and refuses to centre its glyph, so the rule sets <b>inline-flex</b> for both. <b>.wide</b> is the variant that carries a word instead of a glyph.`,
        markup: `<div class="sheet-actions">
  <button class="icon-btn">⟳</button>
  <a href="#" class="icon-btn">⚖️<span class="badge">3</span></a>
  <button class="icon-btn">🌐</button>
  <button class="icon-btn wide">beadcause</button>
</div>`,
      },
    ],
  },

  {
    group: 'Decisions',
    cards: [
      {
        path: 'decisions/card-shut.html',
        name: 'Question card — shut',
        subtitle: 'The row the inbox is made of',
        viewport: { width: 420, height: 300 },
        note: `Shut, <b>the card is its own control</b>: <code>data-act="toggle"</code> sits on the article, so a tap anywhere — the title, the pills, the whitespace beside them — opens it. There is no "Show details" button any more; the card is that button. The identifying line comes first because answering the wrong bead is the expensive mistake here.`,
        markup: `<article class="card" data-act="toggle">
  <div class="card-head">
    <div class="meta">
      <span class="pill">beadcause</span>
      <span class="pill id">bc-z665</span>
      <span class="pill p0">P0</span>
      <span class="pill">blocks 2</span>
      <time>4m ago</time>
    </div>
    <p class="q">Should the merge queue close the worker's bead, or leave it open for review?</p>
    <p class="subtitle">MergeAdvocate — the worker stops merging its own work</p>
  </div>
</article>`,
      },
      {
        path: 'decisions/card-states.html',
        name: 'Question card — states',
        subtitle: 'Draft saved, replied, error',
        viewport: { width: 420, height: 520 },
        note: `Three states a shut card carries on its own. <b>.has-draft</b> means something you typed is still here and unsent. <b>.replied</b> is a card you have answered that is waiting on the agent — still in the list, visibly not yours any more, sunk to the bottom. A <b>.subtitle.bad</b> line is the bead's own error, said on the card rather than in a toast that can be swiped away.`,
        markup: `<div class="ds-stack">
  <article class="card has-draft" data-act="toggle">
    <div class="card-head">
      <div class="meta">
        <span class="pill">beadcause</span><span class="pill id">bc-r941</span><span class="pill p1">P1</span><span class="pill st-in_progress">In progress</span>
        <span class="draft-flag">draft saved</span>
        <time>12m ago</time>
      </div>
      <p class="q">Which of the two settle windows should the sweep debounce on?</p>
    </div>
  </article>

  <article class="card replied" data-act="toggle">
    <div class="card-head">
      <div class="meta">
        <span class="pill">sophab</span><span class="pill id">sp-88q2</span><span class="pill">P2</span>
        <time>1h ago</time>
      </div>
      <p class="q">Take the hero copy as drafted, or hold for the pricing change?</p>
      <p class="subtitle">Answered — waiting on the agent</p>
    </div>
  </article>

  <article class="card" data-act="toggle">
    <div class="card-head">
      <div class="meta">
        <span class="pill">deluvia</span><span class="pill id">dv-14pk</span><span class="pill">P3</span>
        <time>3h ago</time>
      </div>
      <p class="q">Should the OTA creature keep its own texture budget?</p>
      <p class="subtitle bad">⚠ bd: workspace is locked by another writer</p>
    </div>
  </article>
</div>`,
      },
      {
        path: 'decisions/pills.html',
        name: 'Pills',
        subtitle: 'Workspace, id, priority, status, held',
        viewport: { width: 480, height: 260 },
        note: `An uppercase metadata badge — except <b>.pill.id</b>, which is a bead id and is neither uppercase nor a badge, and so has a rule of its own. <b>Only P0 and P1 carry colour</b>: they are the two worth a second look, and P2–P4 are deliberately plain, because a priority scale where every step shouts is a scale that says nothing. Status is the same bargain — <code>open</code> has no class at all, since it is the default state and colouring it would mean colouring almost every row.`,
        markup: `<div class="ds-stack">
  <div class="meta">
    <span class="pill">beadcause</span>
    <span class="pill id">bc-z665</span>
    <span class="pill">blocks 2</span>
    <time>4m ago</time>
  </div>
  <div class="meta">
    <span class="pill p0">P0</span><span class="pill p1">P1</span>
    <span class="pill">P2</span><span class="pill">P3</span><span class="pill">P4</span>
  </div>
  <div class="meta">
    <span class="pill">Open</span>
    <span class="pill st-in_progress">In progress</span>
    <span class="pill st-blocked">Blocked</span>
    <span class="pill st-review">In review</span>
    <span class="pill st-live">Live</span>
    <span class="pill st-closed">Closed</span>
  </div>
</div>`,
      },
      {
        path: 'decisions/options.html',
        name: 'Options',
        subtitle: 'Plain, recommended, picked, commissioning',
        viewport: { width: 440, height: 420 },
        note: `The choices an agent offers. <b>.rec</b> is the one the brief argued for — a tinted edge and a tag, never a filled button, because recommending is not deciding. <b>.picked</b> is filled: it is the choice whose words are now in the box below. An option marked <code>closes: false</code> says so <i>before</i> the tap — it commissions work and leaves the bead open, which the answer button's label alone would not tell you in time.`,
        markup: `<div class="options">
  <button class="option rec" aria-pressed="false">
    <span class="label">Close both beads on merge</span>
    <span class="rec-tag">★ recommended</span>
    <span class="hint">The queue owns the ending; the worker delivers and stops.</span>
  </button>
  <button class="option picked" aria-pressed="true">
    <span class="label">Leave the worker's bead open for review</span>
    <span class="hint">One more pass before it counts as done.</span>
  </button>
  <button class="option" aria-pressed="false">
    <span class="label">Split the queue in two</span>
    <span class="hand-tag">↪ commissions the work</span>
    <span class="hint">Puts the answer on the thread and hands the bead back as work.</span>
  </button>
</div>`,
      },
      {
        path: 'decisions/answer-box.html',
        name: 'Answer box',
        subtitle: 'Pinned composer, primary + comment',
        viewport: { width: 440, height: 340 },
        note: `A <b>sibling of the brief, not the last thing inside it</b> — that is the whole point. An open card is a fixed head, a brief that scrolls on its own, and this pinned to the bottom. Inside the brief it sat several screens below the fold on any real bead: you read down, scrolled back to reply, and every glance at the details lost the box again. The primary button says what it will actually do, and a close <code>bd</code> would refuse is <b>not offered at all</b>.`,
        markup: `<div class="freeform">
  <textarea rows="3" placeholder="Answer in your own words…"></textarea>
  <div class="row">
    <button class="primary">Answer &amp; close</button>
    <button class="secondary">Comment only</button>
  </div>
</div>`,
      },
      {
        path: 'decisions/answer-box-variants.html',
        name: 'Answer box — variants',
        subtitle: 'Commissioning, gated, declining',
        viewport: { width: 440, height: 520 },
        note: `Three ways the composer changes its mind about what it is for. <b>Commission</b> — the picked option leaves the bead open, so the label stops saying "close". <b>Gated</b> — the tracker will refuse this close (an epic with open children, something still blocking), so the primary is simply not drawn and Comment takes its place; a button that cannot do what its label says is worse than no button. <b>Declining</b> a pull request turns the primary destructive.`,
        markup: `<div class="ds-stack">
  <div class="freeform">
    <textarea rows="2" placeholder="Answer in your own words…"></textarea>
    <div class="row">
      <button class="primary">Answer &amp; commission</button>
      <button class="secondary">Comment only</button>
    </div>
  </div>

  <div class="freeform">
    <textarea rows="2" placeholder="Say something on the thread…"></textarea>
    <div class="row">
      <button class="primary">Comment</button>
    </div>
  </div>

  <div class="freeform declining">
    <textarea rows="2" placeholder="Optional — what should the next attempt do instead?"></textarea>
    <div class="row">
      <button class="primary danger">Decline #313 &amp; close</button>
      <button class="secondary">Comment only</button>
    </div>
  </div>
</div>`,
      },
      {
        path: 'decisions/card-top.html',
        name: 'Card top bar',
        subtitle: 'Kebab and collapse, open only',
        viewport: { width: 440, height: 340 },
        note: `Only an open card has one, and an empty one is not invisible — it is still 12px of padding and it pulls the head's own padding down, so the builder returns <b>the empty string</b> rather than an empty row. Behind the kebab are the three ways out of a card that are not reading it: two act on this bead and differ only in which screen the session lands on; the third goes the other way, to what work comes off the back of it.`,
        markup: `<div class="ds-stack">
  <div class="card-top">
    <div class="menu-wrap">
      <button class="kebab on" aria-haspopup="true" aria-expanded="true">⋮</button>
    </div>
    <button class="collapse">↑ Collapse</button>
  </div>

  <div class="menu" role="menu">
    <button class="menu-item" role="menuitem"><span class="glyph">&gt;_</span> Discuss in a Claude session on the Mac</button>
    <a class="menu-item" role="menuitem" href="#"><span class="glyph">⌨️</span> Drive a session on it from here</a>
    <a class="menu-item" role="menuitem" href="#"><span class="glyph">🧾</span> Work out the next beads from this</a>
  </div>
</div>`,
      },
      {
        path: 'decisions/card-foot.html',
        name: 'Card foot',
        subtitle: 'The head again, as a caption',
        viewport: { width: 440, height: 240 },
        note: `The same identifying line the card opened with, repeated at its foot. A brief can run several screens — a diagram, a spec, a thread — and by the time you reach the answer box the workspace, the id and the question are far above you. Answering the wrong bead is the expensive mistake, so the foot says which one this is instead of making you scroll up to check. Quieter than the head on purpose: same facts, second time, as a caption.`,
        markup: `<div class="card-foot">
  <div class="meta">
    <span class="pill">beadcause</span>
    <span class="pill id">bc-z665</span>
    <span class="pill p0">P0</span>
    <time>4m ago</time>
  </div>
  <p class="q">Should the merge queue close the worker's bead, or leave it open for review?</p>
  <p class="subtitle">MergeAdvocate — the worker stops merging its own work</p>
</div>`,
      },
      {
        path: 'decisions/agent-log.html',
        name: 'Session log',
        subtitle: 'The CLI, as the CLI laid it out',
        viewport: { width: 480, height: 300 },
        note: `An agent's log, shown as the CLI would have shown it — the output was laid out by something that assumed a fixed-width terminal, so it is kept monospaced and left to scroll rather than reflowed. The button that opens it stays drawn for as long as the pane is open, not just while the agent holds the bead: the reply can land while you are still reading, and a pane whose button has gone with the flag that drew it is one you can no longer close.`,
        markup: `<div class="ds-stack">
  <div class="actions"><button class="linkish log-btn">Hide session log</button></div>
  <pre class="agent-log">$ bd ready --json
  bc-z665  P0  Publish the beadcause design system
  bc-r941  P1  MergeAdvocate — worker stops merging

→ claiming bc-z665
→ worktree design-system-z665 at daad58e9
→ 1314 rules parsed, round-trip ok</pre>
</div>`,
      },
    ],
  },
];

export const GROUPS = [...CORE, ...SURFACES];
