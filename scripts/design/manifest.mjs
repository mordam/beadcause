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
        path: 'decisions/card-open.html',
        name: 'Question card — open',
        subtitle: 'The app\'s central surface',
        viewport: { width: 400, height: 720 },
        note: `<b>open</b> takes the card full screen — <code>position: fixed; inset: 0</code> at z-index 40 — because a question is read one at a time, and on a phone expanding inline meant the brief, the thread and the answer box all competing with the list around them. Above 440px of viewport it stops being one scroller and becomes <b>four rows that shrink rather than switch</b>: a top bar and head that stay, options and brief that give up height in the order they can most afford to, and the composer pinned. Every <code>min-height</code> in that block is load-bearing for the keyboard case, not just for the pathological card.`,
        markup: `<article class="card open">
  <div class="card-top">
    <div class="menu-wrap"><button class="kebab" aria-haspopup="true" aria-expanded="false">⋮</button></div>
    <button class="collapse">↑ Collapse</button>
  </div>
  <div class="card-head">
    <div class="meta">
      <span class="pill">beadcause</span>
      <span class="pill id">bc-z665</span>
      <span class="pill p0">P0</span>
      <time>4m ago</time>
    </div>
    <p class="q">Should the merge queue close the worker's bead, or leave it open for review?</p>
    <p class="subtitle">MergeAdvocate — the worker stops merging its own work</p>
  </div>
  <div class="options">
    <button class="option rec" aria-pressed="false">
      <span class="label">Close both beads on merge</span>
      <span class="rec-tag">★ recommended</span>
    </button>
    <button class="option" aria-pressed="false">
      <span class="label">Leave the worker's bead open</span>
    </button>
  </div>
  <div class="brief">
    <div class="md">
      <p>A worker that merges its own work is a worker that decides when it is done. The merge queue is what makes delivery and acceptance two separate acts.</p>
      <p>Closing both is the tidier ending, but it means nothing gets a second look before it counts as finished.</p>
    </div>
  </div>
  <div class="freeform">
    <textarea rows="3" placeholder="Answer in your own words…"></textarea>
    <div class="row">
      <button class="primary">Answer &amp; close</button>
      <button class="secondary">Comment only</button>
    </div>
  </div>
</article>`,
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
        note: `A <b>sibling of the brief, not the last thing inside it</b> — that is the whole point. An open card is a fixed head, a brief that scrolls on its own, and this pinned to the bottom. Inside the brief it sat several screens below the fold on any real bead: you read down, scrolled back to reply, and every glance at the details lost the box again. The primary button says what it will actually do, and a close <code>bd</code> would refuse is <b>not offered at all</b>. Shown inside <code>.card.open</code>, which is the only place it exists — its side padding comes from <code>.card.open &gt; .freeform</code>, so a bare one is not this component.`,
        markup: `<article class="card open">
  <div class="brief"><div class="md"><p>The brief scrolls; the box below does not.</p></div></div>
  <div class="freeform">
    <textarea rows="3" placeholder="Answer in your own words…"></textarea>
    <div class="row">
      <button class="primary">Answer &amp; close</button>
      <button class="secondary">Comment only</button>
    </div>
    <button class="dismiss">Dismiss without answering</button>
  </div>
</article>`,
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
        path: 'decisions/proposal.html',
        name: 'Proposal',
        subtitle: 'Beads an agent wants to create',
        viewport: { width: 440, height: 620 },
        note: `<b>Nothing is created until you say so</b> — the section label says it, because a list of beads that looks filed and is not is the worst possible misread. Each row is ✓ / ✎ / ✕, and ✎ rewrites in place: everything below reads the <i>adjusted</i> bead, so there is never a moment where the card shows one title and pressing create sends another. A long row starts <b>folded</b> rather than clamped — a clamp cuts markdown mid-list-item and leaves no way to see the rest — and a row being edited is never folded, since you cannot edit what is hidden.`,
        markup: `<div class="proposal">
  <div class="section-label">3 beads proposed <span>nothing is created until you say so</span></div>

  <div class="prop-row pick-yes" data-idx="1">
    <div class="prop-main">
      <div class="prop-head"><span class="prop-n">1</span><span class="prop-title">Slice the CSS per component</span></div>
      <div class="prop-body">
        <div class="prop-meta"><span class="pill">task</span><span class="pill p1">P1</span><span class="pill">medium complexity</span></div>
        <div class="prop-why"><span class="prop-label">Why</span><div class="md"><p>A preview has to stand on its own, and the sheet is far too large to inline.</p></div></div>
      </div>
    </div>
    <div class="prop-choice">
      <button class="prop-btn yes" aria-pressed="true">✓</button>
      <button class="prop-btn edit" aria-pressed="false">✎</button>
      <button class="prop-btn no" aria-pressed="false">✕</button>
    </div>
  </div>

  <div class="prop-row is-collapsed" data-idx="2">
    <div class="prop-main">
      <div class="prop-head"><span class="prop-n">2</span><span class="prop-title">Audit every card against the sheet</span><span class="pill adjusted">adjusted</span></div>
      <div class="prop-body">
        <div class="prop-meta"><span class="pill">task</span><span class="pill p2">P2</span></div>
      </div>
      <button class="prop-more" aria-expanded="false">Show the rest</button>
    </div>
    <div class="prop-choice">
      <button class="prop-btn yes" aria-pressed="false">✓</button>
      <button class="prop-btn edit" aria-pressed="false">✎</button>
      <button class="prop-btn no" aria-pressed="false">✕</button>
    </div>
  </div>

  <div class="prop-row pick-no" data-idx="3">
    <div class="prop-main">
      <div class="prop-head"><span class="prop-n">3</span><span class="prop-title">Rewrite style.css onto the design system</span></div>
      <div class="prop-body">
        <div class="prop-meta"><span class="pill">feature</span><span class="pill p3">P3</span><span class="pill">high complexity</span></div>
      </div>
    </div>
    <div class="prop-choice">
      <button class="prop-btn yes" aria-pressed="false">✓</button>
      <button class="prop-btn edit" aria-pressed="false">✎</button>
      <button class="prop-btn no" aria-pressed="true">✕</button>
    </div>
  </div>
</div>`,
      },
      {
        path: 'decisions/proposal-bulk.html',
        name: 'Two-tap bulk',
        subtitle: 'Arms on the first tap, files on the second',
        viewport: { width: 440, height: 300 },
        note: `There used to be three buttons: Approve all and Decline all, which only <i>marked</i> every row, and a primary underneath that did the filing — two of the three being a way of setting up the third. Now the two <b>are</b> the decision. They are deliberately <b>not symmetrical</b>: Approve files everything you have not explicitly declined, which is what keeps "2 of 3" reachable; Decline files <i>nothing at all</i>, whatever the rows say, because a full stop that quietly created two beads would be the worst button in the app. Both name their exact count before the second tap.`,
        extraClasses: ['confirm'],
        markup: `<div class="ds-stack">
  <p class="ds-label">at rest</p>
  <div class="prop-bulk">
    <span class="prop-count">1 undecided</span>
    <button class="top-btn bulk approve">Approve 2</button>
    <button class="top-btn bulk decline">Decline all 3</button>
  </div>

  <p class="ds-label">armed — the second tap files</p>
  <div class="prop-bulk">
    <span class="prop-count">1 undecided</span>
    <button class="top-btn bulk approve confirm">Create 2 beads?</button>
    <button class="top-btn bulk decline">Decline all 3</button>
  </div>
</div>`,
      },
      {
        path: 'decisions/suggested.html',
        name: 'Suggested answers',
        subtitle: 'Tap to fill the box',
        viewport: { width: 440, height: 240 },
        note: `Answers the agent drafted for you, above the box. They <b>fill</b> the box rather than submitting — the label says so, because a chip that answered on one tap would make the box below it a lie. The star marks the one the brief argued for, the same claim <code>.option.rec</code> makes and with the same restraint: a mark, not a filled button.`,
        markup: `<div class="suggested">
  <div class="section-label">Suggested · from the brief <span>tap to fill the box</span></div>
  <div class="chips">
    <button class="chip rec" aria-pressed="false"><span class="star">★</span>Close both — the queue owns the ending</button>
    <button class="chip" aria-pressed="false">Leave it open for review</button>
    <button class="chip" aria-pressed="true">Split the queue in two</button>
  </div>
</div>`,
      },
      {
        path: 'decisions/agent-card.html',
        name: 'Agent card',
        subtitle: 'A bead an agent holds — read-only',
        viewport: { width: 440, height: 300 },
        note: `Not every card in the inbox asks you something. An agent card is a bead something is <i>working on</i>, and it has <b>no answer box at all</b> — deliberately, since there is no question to answer. What it has instead is a way out to the graph, and a status pill the question card does not carry.`,
        markup: `<article class="card agent-card">
  <div class="card-head">
    <div class="meta">
      <span class="pill">beadcause</span>
      <span class="pill id">bc-1kwl.3</span>
      <span class="pill p1">P1</span>
      <span class="pill st-in_progress">In progress</span>
      <span class="pill">blocks 1</span>
      <time>22m ago</time>
    </div>
    <p class="q">Move the five hand-rolled route caches onto the shared layer</p>
    <p class="subtitle">task · RepoAdvocate</p>
  </div>
  <div class="actions">
    <a class="linkish" href="#">Graph →</a>
  </div>
</article>`,
      },
      {
        path: 'decisions/reply-bar.html',
        name: 'Reply bar',
        subtitle: 'Who answers this box',
        viewport: { width: 440, height: 400 },
        note: `A strip on the answer box's own top edge — the one place a "who replies" control can sit and stay true once the box stops scrolling with the thread above it. <b>.allow-tools</b> is the serious one: it decides whether an override already in the config file is <i>used</i>, never what it says, and nothing here can write one. It arms on tick and is <b>spent when you send</b>, so it can never be left quietly on.`,
        markup: `<div class="ds-stack">
  <div class="reply-bar">
    <span class="reply-who">MergeAdvocate replies</span>
    <div class="agent-wrap">
      <button class="agent-dots on" aria-haspopup="true" aria-expanded="true"><span class="dots-emoji">🛰</span>⋯</button>
    </div>
  </div>

  <p class="ds-label">armed</p>
  <div class="reply-bar">
    <span class="reply-who">MergeAdvocate replies</span>
    <div class="agent-wrap">
      <button class="agent-dots armed" aria-haspopup="true" aria-expanded="false"><span class="dots-emoji">🛰</span>⋯</button>
    </div>
  </div>

  <div class="agents agent-panel" role="group">
    <button class="chip agent-chip" aria-pressed="true"><span class="chip-label">🛰 MergeAdvocate</span></button>
    <button class="chip agent-chip" aria-pressed="false"><span class="chip-label">◆ RepoAdvocate</span></button>
  </div>

  <label class="allow-tools on">
    <input type="checkbox" checked>
    <span class="allow-label">⚠ Allow tools for this comment</span>
    <span class="allow-note">armed · spent when you send</span>
  </label>

  <label class="allow-tools busy">
    <input type="checkbox" disabled>
    <span class="allow-label">⚠ Allow tools for this comment</span>
    <span class="allow-note">MergeAdvocate is answering bc-r941 — not while it is running</span>
  </label>
</div>`,
      },
      {
        path: 'decisions/delivery.html',
        name: 'Delivery summary',
        subtitle: 'A pull request, on a question card',
        viewport: { width: 440, height: 420 },
        note: `When the thing waiting on you is a merge, the card carries the pull request's live state rather than a link to it. <b>.pr-chip</b> has a quiet state for "reading GitHub…" and a warn state for "GitHub would not say", because the row's own facts are up to 25 seconds old — the right freshness for a lamp and the wrong one for a button. <b>.pr-ship</b> names what shipping would actually do, and arms before it does it.`,
        extraClasses: ['armed'],
        markup: `<div class="ds-stack">
  <div class="pr-summary">
    <span class="pr-chip quiet">reading GitHub…</span>
    <span class="pr-chip">7 files</span>
    <span class="pr-chip diff"><span class="add">+412</span> <span class="del">−96</span></span>
    <span class="pr-chip warn">a check has not reported</span>
  </div>

  <div class="pr-actions">
    <button class="board-btn merge">Merge #313</button>
    <button class="board-btn ship">
      <span class="pr-ship-do">Ship #313</span>
      <span class="pr-ship-what">merge, deploy, and close both beads</span>
    </button>
  </div>

  <p class="ds-label">armed — the second tap does it</p>
  <div class="pr-actions">
    <button class="board-btn merge armed">Merge #313</button>
    <button class="board-btn ship armed">
      <span class="pr-ship-do">Tap again to confirm · Ship #313</span>
      <span class="pr-ship-what">merge, deploy, and close both beads</span>
    </button>
  </div>
</div>`,
      },
      {
        path: 'decisions/activity.html',
        name: 'Activity',
        subtitle: 'What the agent is doing, on the card',
        viewport: { width: 440, height: 260 },
        note: `A card that something is working on says so on its face, so you do not answer a question an agent is already answering. <b>.live</b> is a phase that is genuinely running; <b>.waiting</b> is the state after <i>you</i> replied — the spark keeps turning, but the sentence is about waiting for an agent to pick it up rather than about work in progress.`,
        markup: `<div class="ds-stack">
  <div class="activity live">
    <span class="spark"></span>
    <span class="phase">◆ merging</span>
    <span class="detail">#313 into main</span>
    <time>2m ago</time>
  </div>
  <div class="activity">
    <span class="spark"></span>
    <span class="phase">◍ paused</span>
    <span class="detail">the advocate is at its worker limit</span>
    <time>18m ago</time>
  </div>
  <div class="activity waiting">
    <span class="spark"></span>
    <span class="phase">⏳ you replied</span>
    <span class="detail">waiting on an agent to pick this up</span>
  </div>
</div>`,
      },
      {
        path: 'decisions/addressee.html',
        name: 'Addressee',
        subtitle: 'Who a question is for',
        viewport: { width: 440, height: 220 },
        note: `Not every question in the inbox is for you. The addressee buttons say who a bead is asking, and <b>.picked</b> is a claim — the same filled treatment <code>.option.picked</code> uses, and for the same reason: it is the one that is true now.`,
        markup: `<div class="address-panel">
  <button class="address-btn picked" type="button">adam</button>
  <button class="address-btn" type="button">anyone</button>
  <button class="address-btn" type="button">MergeAdvocate</button>
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
