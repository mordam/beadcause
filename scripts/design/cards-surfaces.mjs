// The rest of the app, surface by surface. Same rules as manifest.mjs: real markup
// harvested from the file that emits it (`node scripts/design-shapes.mjs <file>`),
// synthetic content in it.

export const SURFACES = [
  {
    group: 'Filtering',
    cards: [
      {
        path: 'filters/filter-menu.html',
        name: 'Filter menu',
        subtitle: 'One line at rest, chips when opened',
        viewport: { width: 440, height: 420 },
        note: `The inbox's whole filter, behind <b>one line</b>. It held three permanent rows once, coarsest first — scope, space, workspace — and two rows of chips above the list is two questions you cannot see on a phone. So it collapses to a sentence saying what is selected, and opens on hover with a pointer and on a tap without one. The same control is the History tab's filter bar.`,
        markup: `<div class="ds-stack">
  <div class="filter-menu">
    <button class="filter-summary" aria-expanded="false"><span class="sel">Needs me · questions, proposals</span><span class="caret" aria-hidden="true">▾</span></button>
  </div>

  <div class="filter-menu">
    <button class="filter-summary" aria-expanded="true"><span class="sel">Needs me · questions, proposals</span><span class="caret" aria-hidden="true">▾</span></button>
    <div class="filter-panel">
      <div class="filter-group">
        <span class="filter-legend">Scope</span>
        <div class="chip-row scopes" role="group">
          <button class="chip" aria-pressed="true"><span class="chip-label">Needs me</span></button>
          <button class="chip" aria-pressed="false"><span class="chip-label">Everything</span></button>
        </div>
      </div>
      <div class="filter-group">
        <span class="filter-legend">Kinds</span>
        <div class="chip-row kinds" role="group">
          <button class="chip" aria-pressed="true"><span class="chip-label">Questions</span><span class="chip-count">4</span></button>
          <button class="chip" aria-pressed="true"><span class="chip-label">Proposals</span><span class="chip-count">2</span></button>
          <button class="chip" aria-pressed="false"><span class="chip-label">Deliveries</span><span class="chip-count">1</span></button>
          <button class="chip none" aria-pressed="false"><span class="chip-label">Endorsements</span><span class="chip-count">0</span></button>
        </div>
      </div>
    </div>
  </div>
</div>`,
      },
      {
        path: 'filters/chips.html',
        name: 'Chips',
        subtitle: 'On, off, counted, empty',
        viewport: { width: 460, height: 240 },
        note: `A chip carries its own count, and the count is <b>dimmer than the label</b> — it is how many rows picking this chip would leave you with, not the point of the chip. <b>.none</b> is a kind with nothing of it in view: still pressable, and still worth reading, because "no proposals" is information. The segmented look of the scope switch is keyed off the row's plural class (<code>.scopes</code>), not off the chips.`,
        markup: `<div class="ds-stack">
  <div class="chip-row kinds" role="group">
    <button class="chip" aria-pressed="true"><span class="chip-label">Questions</span><span class="chip-count">4</span></button>
    <button class="chip" aria-pressed="false"><span class="chip-label">Proposals</span><span class="chip-count">2</span></button>
    <button class="chip none" aria-pressed="false"><span class="chip-label">Endorsements</span><span class="chip-count">0</span></button>
    <button class="chip" aria-pressed="false"><span class="chip-label">Agents</span></button>
  </div>
  <div class="chip-row scopes" role="group">
    <button class="chip" aria-pressed="true"><span class="chip-label">Needs me</span></button>
    <button class="chip" aria-pressed="false"><span class="chip-label">Everything</span></button>
  </div>
</div>`,
      },
      {
        path: 'filters/typeahead.html',
        name: 'Typeahead filter',
        subtitle: 'Text box, selected pills, suggestions',
        viewport: { width: 460, height: 400 },
        note: `The one filter group that is not a fixed set of chips. What you have already picked becomes a row of removable pills above the box, and the dropdown is the only piece of state this file keeps — which row the arrow keys are on is a fact about the widget rather than about anybody's filter.`,
        markup: `<div class="filter-typeahead">
  <div class="pill-row">
    <span class="pill"><span class="pill-label">bc-z665</span><button class="pill-x" aria-label="Remove">✕</button></span>
    <span class="pill"><span class="pill-label">bc-r941</span><button class="pill-x" aria-label="Remove">✕</button></span>
  </div>
  <input class="filter-text" placeholder="Filter by bead…" value="des">
  <div class="suggest">
    <button class="suggest-row"><span class="suggest-id">bc-z665</span><span class="suggest-note">Publish the beadcause design system</span></button>
    <button class="suggest-row"><span class="suggest-id">bc-1kwl</span><span class="suggest-note">Move the five hand-rolled route caches onto the shared layer</span></button>
  </div>
</div>`,
      },
    ],
  },

  {
    group: 'Work rows',
    cards: [
      {
        path: 'workrows/work-row.html',
        name: 'Work row',
        subtitle: 'The app\'s most reused component',
        viewport: { width: 460, height: 380 },
        note: `One running thing, in one row: a phase glyph, a title, a sub-line. Five screens draw it — the advocates console, the monitor, the PR board, the mirror and the session list — which is why it is the row that most needs to look identical everywhere. <b>.spark</b> in the phase slot is the busy state; the slot is sized in px, so the row has to be a flex parent for it to sit right.`,
        markup: `<div class="ds-stack">
  <a class="work-row" href="#">
    <span class="work-phase"><span class="spark"></span></span>
    <span class="work-main">
      <span class="work-title">design-system-z665</span>
      <span class="work-sub">beadcause · pid 40656</span>
    </span>
  </a>
  <a class="work-row" href="#">
    <span class="work-phase">○</span>
    <span class="work-main">
      <span class="work-title">handoff-404-s336b</span>
      <span class="work-sub">beadcause · idle 14m</span>
    </span>
  </a>
  <div class="work-row adv-worker">
    <span class="work-phase">◆</span>
    <span class="work-main">
      <span class="work-title">The repo advocate</span>
      <span class="work-sub"><span class="pill id">beadcause</span> <span class="tag ok">sweeping</span></span>
    </span>
  </div>
  <div class="work-row mon-plain">
    <span class="work-phase">◍</span>
    <span class="work-main">
      <span class="work-title">Paused</span>
      <span class="work-sub"><span class="tag dim">no sweep until resumed</span></span>
    </span>
  </div>
</div>`,
      },
      {
        path: 'workrows/tags.html',
        name: 'Tags & spark',
        subtitle: 'ok, warn, live, dim',
        viewport: { width: 460, height: 200 },
        note: `The second grain inside a work row. A <b>.tag</b> says what state the row is in; <b>.spark</b> is the only animated one — a breathing dot rather than a dead grey circle, because the list it sits in is where you find the conversation that is actually moving.`,
        markup: `<div class="ds-stack">
  <div class="meta">
    <span class="tag ok">merged</span>
    <span class="tag warn">conflicted</span>
    <span class="tag live">deploying</span>
    <span class="tag dim">paused</span>
    <span class="tag">queued</span>
  </div>
  <div class="meta"><span class="spark"></span><span class="dim">busy</span></div>
</div>`,
      },
      {
        path: 'workrows/work-card.html',
        name: 'Work card',
        subtitle: 'A card that is a list of rows',
        viewport: { width: 460, height: 340 },
        note: `The container the monitor, the console and the PR board all build their screens out of: a head, a stack of work rows, a foot. It is the same <b>.card</b> the inbox uses — the design system has one card, and the surfaces differ in what they put inside it, not in what they are.`,
        markup: `<article class="card work-card">
  <div class="work-head">
    <span class="work-title">Sessions</span>
    <span class="pill">3 live</span>
  </div>
  <a class="work-row" href="#">
    <span class="work-phase"><span class="spark"></span></span>
    <span class="work-main"><span class="work-title">design-system-z665</span><span class="work-sub">beadcause · 12m</span></span>
  </a>
  <a class="work-row" href="#">
    <span class="work-phase">○</span>
    <span class="work-main"><span class="work-title">reenter-gate-f31f</span><span class="work-sub">beadcause · 2h</span></span>
  </a>
  <div class="work-foot"><span class="dim">Updated 30s ago</span></div>
</article>`,
      },
    ],
  },

  {
    group: 'Monitor',
    cards: [
      {
        path: 'monitor/service.html',
        name: 'Service check',
        subtitle: 'ok, warn, bad',
        viewport: { width: 500, height: 460 },
        note: `What the daemon is doing and whether it is really doing it. A failing check <b>carries its own fix</b> as a command you can read — the point of the row is not to tell you something is wrong, it is to tell you the next thing to type. The ✓ state collapses to a single line; only trouble expands.`,
        markup: `<div class="ds-stack">
  <div class="svc ok">
    <div class="svc-head"><span class="svc-dot">✓</span>ROUTER IS LIVE<span class="pill id">4319</span></div>
    <div class="svc-foot">ca.neadamthal.beadcause.plist</div>
  </div>

  <div class="svc warn">
    <div class="svc-head"><span class="svc-dot">⚠</span>HOT-SWAP IS NOT LIVE<span class="pill id">poisoned</span></div>
    <div class="svc-what">launchd runs <code>ca.neadamthal.beadcause</code></div>
    <div class="svc-line">The last build failed, so the router is still serving the previous tree.</div>
    <div class="svc-fix">force it: <code>npm run swap</code></div>
    <div class="svc-foot">ca.neadamthal.beadcause.plist</div>
  </div>

  <div class="svc bad">
    <div class="svc-head"><span class="svc-dot">⚠</span>APK IS STALE<span class="pill id">build</span></div>
    <div class="svc-what">public/beadcause.apk is older than public/</div>
    <div class="svc-line">The phone will install a build that predates the last four deploys.</div>
    <div class="svc-fix">rebuild it: <code>npm run apk</code></div>
    <div class="svc-foot">disk 41 MB</div>
  </div>
</div>`,
      },
      {
        path: 'monitor/release.html',
        name: 'Release',
        subtitle: 'What went out, and what it said',
        viewport: { width: 500, height: 320 },
        note: `A deploy, and the commits in it. The count is on the head rather than in the list, so a release that went out clean reads as one line — you open it only when you want to know what was in it.`,
        markup: `<div class="release">
  <div class="release-head"><span class="work-title">Deployed</span><span class="release-count">4</span><span class="tag ok">live</span></div>
  <p class="release-say">Merged to main 6m ago, settled, swapped.</p>
  <ul class="release-list">
    <li>bc-r941 — MergeAdvocate stops merging its own work</li>
    <li>bc-1kwl.3 — five route caches onto the shared layer</li>
    <li class="release-more">and 2 more</li>
  </ul>
</div>`,
      },
      {
        path: 'monitor/advocate.html',
        name: 'Advocate controls',
        subtitle: 'Step, apply, pause, and the limit',
        viewport: { width: 500, height: 320 },
        note: `The buttons that drive an advocate, and the note that says why it will not do the thing you just asked. <b>.adv-limit</b> is the ceiling on how many workers it may open at once — shown beside the controls rather than buried in config, because it is the number that explains an idle queue.`,
        markup: `<div class="ds-stack">
  <div class="space-btns">
    <button class="adv-btn adv-step">Step once</button>
    <button class="adv-btn adv-apply primary">Apply</button>
    <button class="adv-btn">Pause</button>
    <span class="adv-limit">2 of 3 workers</span>
  </div>
  <div class="adv-note">Swept 41 beads, opened nothing — every ready bead is claimed.</div>
  <div class="adv-note warn">Held: the merge queue has an unresolved conflict on worktree-flowchart-34i0.</div>
  <div class="adv-note bad">bd: workspace is locked by another writer.</div>
</div>`,
      },
    ],
  },

  {
    group: 'Pull requests',
    cards: [
      {
        path: 'prs/pr-card.html',
        name: 'PR card — shut',
        subtitle: 'One row, two screens',
        viewport: { width: 480, height: 300 },
        note: `One pull request, drawn once, for the two screens that draw them. <code>bodyHtml</code> in <code>public/prcard.js</code> is the whole inside of the row and both screens wrap it in their own shell — a folding <b>&lt;button&gt;</b> on the board, an <b>&lt;article class="card"&gt;</b> in the inbox. What differs is the wrapper and the actions, which is exactly what should differ: a board row unfolds into buttons, an inbox card is one item in a stack.`,
        markup: `<article class="card pr-card" data-stage="review">
  <button class="work-row pr-row" type="button" aria-expanded="false">
    <span class="work-main">
      <span class="work-title"><span class="board-num">#313</span> MergeAdvocate — the worker stops merging its own work</span>
      <span class="work-sub"><span class="pill">beadcause</span><span class="pill pr-stage st-review">In review</span><a class="pill id" href="#">bc-r941</a> <span class="board-facts">
        <span class="diffstat"><ins>+412</ins> <del>−96</del></span>
        <span class="board-checks passing">✓ 3</span>
      </span></span>
      <span class="board-lamps">
        <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Merged<span class="sr-only">: yes</span></span>
        <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Pushed<span class="sr-only">: yes</span></span>
        <span class="lamp unknown"><span class="lamp-dot" aria-hidden="true"></span>Deployed<span class="sr-only">: not known</span></span>
        <span class="lamp off"><span class="lamp-dot" aria-hidden="true"></span>Live<span class="sr-only">: no</span></span>
      </span>
    </span>
    <time>18m</time>
    <span class="chev" aria-hidden="true">›</span>
  </button>
  <p class="board-note">A check has not reported since the last push.</p>
</article>`,
      },
      {
        path: 'prs/lamps.html',
        name: 'The four lamps',
        subtitle: 'Merged · Pushed · Deployed · Live',
        viewport: { width: 500, height: 320 },
        note: `Each lamp has <b>three</b> states, not two — on, off, and <i>unknown</i>, drawn as a hollow ring, because "this Mac has never fetched that commit" and "this repo has no deploy beadcause can watch" are not <b>no</b>. The board had three of these; <b>Deployed</b> used to mean the running build and now means <i>a deploy ran that carried it</i>, with <b>Live</b> taking the stronger claim — only beadcause can say <code>live</code> about beadcause, where a <code>fly deploy</code> of another repo can only ever be <code>deployed</code>. Every lamp carries its reason as a title, and a <b>.sr-only</b> state so the phrase reads "Merged: yes" rather than a bare dot.`,
        markup: `<div class="ds-stack">
  <p class="ds-label">all on</p>
  <span class="board-lamps">
    <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Merged<span class="sr-only">: yes</span></span>
    <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Pushed<span class="sr-only">: yes</span></span>
    <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Deployed<span class="sr-only">: yes</span></span>
    <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Live<span class="sr-only">: yes</span></span>
  </span>
  <p class="ds-label">nothing merged yet — every lamp off</p>
  <span class="board-lamps">
    <span class="lamp off"><span class="lamp-dot" aria-hidden="true"></span>Merged<span class="sr-only">: no</span></span>
    <span class="lamp off"><span class="lamp-dot" aria-hidden="true"></span>Pushed<span class="sr-only">: no</span></span>
    <span class="lamp off"><span class="lamp-dot" aria-hidden="true"></span>Deployed<span class="sr-only">: no</span></span>
    <span class="lamp off"><span class="lamp-dot" aria-hidden="true"></span>Live<span class="sr-only">: no</span></span>
  </span>
  <p class="ds-label">unknown — the hollow ring, and the reason this state exists</p>
  <span class="board-lamps">
    <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Merged<span class="sr-only">: yes</span></span>
    <span class="lamp unknown"><span class="lamp-dot" aria-hidden="true"></span>Pushed<span class="sr-only">: not known</span></span>
    <span class="lamp unknown"><span class="lamp-dot" aria-hidden="true"></span>Deployed<span class="sr-only">: not known</span></span>
    <span class="lamp unknown"><span class="lamp-dot" aria-hidden="true"></span>Live<span class="sr-only">: not known</span></span>
  </span>
  <p class="ds-label">checks, and a PR with no bead behind it</p>
  <span class="board-facts">
    <span class="diffstat"><ins>+412</ins> <del>−96</del></span>
    <span class="board-checks passing">✓ 3</span>
    <span class="board-checks pending">◌ 1</span>
    <span class="board-checks failing">✗ 2</span>
    <span class="board-nobead">no bead named</span>
  </span>
</div>`,
      },
      {
        path: 'prs/pr-open.html',
        name: 'PR card — open',
        subtitle: 'The merge decision, full screen',
        viewport: { width: 400, height: 720 },
        note: `The same fixed full-screen sheet a question opens into, and the four rows its layout is built around: a <b>.card-top</b> that stays, a <b>.card-head</b> carrying what this is, a <b>.brief</b> that scrolls, and a pinned <b>.freeform</b>. <i>Nothing new had to be laid out for this</i> — which is most of the argument for a merge decision being a card rather than a fifth page.`,
        markup: `<article class="card pr-card open" data-stage="review">
  <div class="card-top">
    <button class="collapse">↑ Collapse</button>
  </div>
  <div class="card-head">
    <div class="work-row pr-row">
      <span class="work-main">
        <span class="work-title"><a class="pr-title-link" href="#"><span class="board-num">#313</span> MergeAdvocate — the worker stops merging its own work</a></span>
        <span class="work-sub"><span class="pill">beadcause</span><span class="pill pr-stage st-review">In review</span><a class="pill id" href="#">bc-r941</a> <span class="board-facts"><span class="diffstat"><ins>+412</ins> <del>−96</del></span><span class="board-checks passing">✓ 3</span></span></span>
        <span class="board-lamps">
          <span class="lamp on"><span class="lamp-dot" aria-hidden="true"></span>Merged<span class="sr-only">: yes</span></span>
          <span class="lamp unknown"><span class="lamp-dot" aria-hidden="true"></span>Live<span class="sr-only">: not known</span></span>
        </span>
      </span>
      <time>18m</time>
    </div>
  </div>
  <div class="brief">
    <div class="md">
      <p>The worker delivering and then merging its own branch meant delivery and acceptance were one act. The queue is what separates them.</p>
      <p>Opened by the session on <code>worktree-r941</code>.</p>
    </div>
  </div>
  <div class="freeform pr-freeform">
    <div class="board-actions">
      <button class="board-btn merge">Merge</button>
      <button class="board-btn send">Request changes</button>
      <a class="board-btn link" href="#">GitHub</a>
    </div>
  </div>
</article>`,
      },
      {
        path: 'prs/board-buttons.html',
        name: 'Board buttons',
        subtitle: 'Merge, ship, send, link',
        viewport: { width: 480, height: 260 },
        note: `The actions on a pull request. <b>.merge</b> and <b>.ship</b> are the two that change the world and are styled apart from the rest; <b>.link</b> is an anchor that leaves for GitHub and deliberately does not look like either. The hint under them is where a refusal goes — the button stays where it was and explains itself, rather than disappearing.`,
        markup: `<div class="ds-stack">
  <div class="board-actions">
    <button class="board-btn merge">Merge</button>
    <button class="board-btn ship release-ship">Ship</button>
    <button class="board-btn send">Send back</button>
    <a class="board-btn link" href="#">Open on GitHub</a>
  </div>
  <p class="board-hint">Merge is waiting on one check that has not reported yet.</p>
  <div class="board-say-row">
    <div class="board-say">Request changes…</div>
  </div>
</div>`,
      },
      {
        path: 'prs/deploy.html',
        name: 'Deploy row',
        subtitle: 'Where it went and whether it landed',
        viewport: { width: 480, height: 220 },
        note: `A merge to main deploys itself, so the board has to show the deploy as well as the merge. The row is a button because the interesting case is the failed one, and the failure detail is one tap down rather than on the row.`,
        markup: `<article class="deploy">
  <button class="deploy-row">
    <div class="deploy-where">beadcause · launchd swap</div>
    <div class="deploy-body"><span class="tag ok">live</span> <span class="dim">6m ago</span></div>
  </button>
</article>`,
      },
    ],
  },

  {
    group: 'Conversations',
    cards: [
      {
        path: 'chat/messages.html',
        name: 'Messages',
        subtitle: 'you, claude, system, error',
        viewport: { width: 460, height: 420 },
        note: `The transcript shape shared by the chat console, the mirror and the session view. Yours is right-aligned and tinted; the agent's is the page. A <b>.msg.bad</b> is not a toast — an error in a conversation belongs in the conversation, where it stays after you look away.`,
        markup: `<div class="ds-stack">
  <div class="msg you">Should the merge queue close the worker's bead too?</div>
  <div class="msg claude"><div class="md"><p>Yes — since bc-r941 the worker delivers and stops. The queue merges and closes both beads, so nothing is left half-owned.</p></div></div>
  <div class="msg mir-sys">Session resumed on worktree-design-system-z665</div>
  <div class="msg bad">bd: workspace is locked by another writer</div>
</div>`,
      },
      {
        path: 'chat/composer.html',
        name: 'Composer',
        subtitle: 'Box, mic, send',
        viewport: { width: 460, height: 260 },
        note: `What you type into, on every conversational surface. The mic is drawn only where dictation can actually work — the box asks at render time rather than showing a control that fails on tap.`,
        markup: `<div class="ds-stack">
  <form class="session-say">
    <textarea rows="2" placeholder="Say something to this session…"></textarea>
    <div class="row">
      <span class="label-mic"><button class="mic"><span class="mic-glyph">🎙</span></button></span>
      <button class="primary send">Send</button>
    </div>
  </form>
  <p class="say-hint">Enter sends; Shift-Enter starts a line.</p>
  <p class="say-blocked">This session has ended — nothing more can be said to it.</p>
</div>`,
      },
      {
        path: 'chat/comments.html',
        name: 'Comments',
        subtitle: 'A bead\'s thread',
        viewport: { width: 460, height: 320 },
        note: `What a bead has had said on it, as the graph and the endorsement queue show it. Attribution is a <b>.who</b> rather than an avatar — every actor here is either you or a named agent, and a picture would be inventing a face for a process.`,
        markup: `<div class="comments">
  <div class="comment">
    <span class="who">adam</span>
    <div class="md"><p>Close both. The worker delivering and stopping is the whole point of bc-r941.</p></div>
  </div>
  <div class="comment">
    <span class="who">MergeAdvocate</span>
    <div class="md"><p>Merged as #313 and closed bc-r941. Answered via Beadcause.</p></div>
  </div>
</div>`,
      },
      {
        path: 'chat/markdown.html',
        name: 'Markdown body',
        subtitle: '.md — every rendered brief',
        viewport: { width: 500, height: 520 },
        note: `Every piece of long-form content in the app renders through this one class: a bead's description, an agent's reply, a doc. It is the only place <b>--prose</b> is used, and it is why that token exists.`,
        markup: `<div class="md">
  <h2>Why the queue closes both</h2>
  <p>A worker that merges its own work is a worker that decides when it is done. The merge queue is what makes delivery and acceptance two separate acts.</p>
  <ul>
    <li>The worker delivers and stops.</li>
    <li>The queue merges, deploys, and closes.</li>
  </ul>
  <p>See <code>lib/mergeadvocate.js</code>, and the settle window in <code>release.settleSeconds</code>.</p>
  <blockquote><p>Persistence you don't need beats lost context.</p></blockquote>
  <pre><code>bd close bc-r941 --reason="merged as #313"</code></pre>
</div>`,
      },
    ],
  },

  {
    group: 'Graph',
    cards: [
      {
        path: 'graph/relations.html',
        name: 'Relations',
        subtitle: 'Blocks, blocked-by, discovered-from',
        viewport: { width: 480, height: 340 },
        note: `A bead's edges, grouped by kind. The dot carries the kind's colour so the group reads without its heading once you know the shape; children get a group of their own with a count, because a bead's children are the one relation you collapse.`,
        markup: `<div class="ds-stack">
  <div class="rel-group">
    <div class="section-label">Blocks</div>
    <div class="rel">
      <a class="rel-row" href="#"><span class="rel-dot"></span><span class="rel-kind">blocks</span><span class="rel-title">Publish the design system</span></a>
      <a class="rel-row" href="#"><span class="rel-dot"></span><span class="rel-kind">blocks</span><span class="rel-title">Rebuild the APK</span></a>
    </div>
  </div>
  <div class="rel-group kids">
    <div class="kids-head"><button class="kids-toggle">Children</button><span class="kids-count">3</span></div>
    <div class="rel">
      <a class="rel-row" href="#"><span class="rel-dot"></span><span class="rel-kind">child</span><span class="rel-title">Slice the CSS per component</span></a>
    </div>
  </div>
</div>`,
      },
      {
        path: 'graph/owner-model.html',
        name: 'Owner & model',
        subtitle: 'Who holds it, what ran it',
        viewport: { width: 480, height: 300 },
        note: `Two rows that answer "who is on this". The model row records what <i>actually</i> ran against what was <i>picked</i> — <b>.is-diverged</b> is the case worth drawing, because a bead worked by a model nobody chose is the kind of thing you only notice if the UI says it.`,
        markup: `<div class="ds-stack">
  <div class="owner-row">
    <span class="owner-kind">Owner</span>
    <span class="owner-who">adam</span>
    <span class="owner-acts"><button class="owner-btn">Claim</button><button class="owner-btn is-clear">Release</button></span>
  </div>
  <div class="owner-row">
    <span class="owner-kind">Owner</span>
    <span class="owner-who is-none">unclaimed</span>
    <span class="owner-acts"><button class="owner-btn">Claim</button></span>
  </div>
  <div class="model-row">
    <span class="model-kind">Model</span>
    <span class="model-picked">opus</span>
    <span class="model-ran is-diverged">ran as sonnet</span>
    <span class="model-why">the session was started before the override landed</span>
  </div>
</div>`,
      },
      {
        path: 'graph/adopt.html',
        name: 'Adopt',
        subtitle: 'Re-parenting a loose bead',
        viewport: { width: 480, height: 240 },
        note: `What to do with a bead that belongs under something else. The refusal is inline and specific — <b>.adopt-why</b> says which rule would break — because "cannot adopt" on its own leaves you guessing at a graph you cannot see.`,
        markup: `<div class="adopt-row">
  <span class="adopt-kind">Adopt into</span>
  <select class="adopt-pick"><option>bc-1kwl — shared cache layer</option><option>bc-r941 — merge queue</option></select>
  <span class="adopt-acts"><button class="adopt-btn">Adopt</button></span>
  <span class="adopt-why">A bead cannot be adopted by one of its own descendants.</span>
</div>`,
      },
    ],
  },

  {
    group: 'Endorsements',
    cards: [
      {
        path: 'endorse/queue-bar.html',
        name: 'Queue bar',
        subtitle: 'How many are held, and by whom',
        viewport: { width: 480, height: 260 },
        note: `The endorsement queue's own header. It exists because a held bead has no other presence in the chrome — the door in the top bar was removed (bc-w156) on the grounds that a list the inbox already carries should not have a fifth place to look for it.`,
        markup: `<section class="eq-bar">
  <div class="eq-bar-row">
    <span class="eq-bar-n">3</span>
    <span class="eq-from"><span class="eq-from-title">held for endorsement</span></span>
    <span class="chev">▾</span>
  </div>
  <div class="chip-row agent-row">
    <button class="chip agent-chip" aria-pressed="true"><span class="chip-label">RepoAdvocate</span><span class="chip-count">2</span></button>
    <button class="chip agent-chip" aria-pressed="false"><span class="chip-label">MergeAdvocate</span><span class="chip-count">1</span></button>
  </div>
</section>`,
      },
      {
        path: 'endorse/bead.html',
        name: 'Held bead',
        subtitle: 'What it wants, and the two answers',
        viewport: { width: 480, height: 360 },
        note: `A bead an agent is holding until you say yes. The agent's own words are a <b>.eq-bubble</b> rather than a description field, because it is an argument being made to you rather than a fact about the bead. Endorsing is one button; the other is not "reject" but <i>revoke</i> — the distinction the queue is built around.`,
        markup: `<article class="card work-card eq-bead">
  <div class="eq-head">
    <div class="eq-head-row">
      <span class="work-title">Move the five hand-rolled route caches onto the shared layer</span>
      <a class="pill id" href="#">bc-1kwl.3</a>
      <span class="pill p1">P1</span>
    </div>
  </div>
  <p class="eq-bubble">Five routes each keep their own map with their own eviction. One layer, one policy — and the sweep stops being the only thing that knows when a cache is stale.</p>
  <p class="eq-count">Waiting 2h</p>
  <div class="board-actions">
    <button class="board-btn merge">Endorse</button>
    <button class="board-btn revoke">Revoke</button>
    <a class="board-btn link" href="#">Open the bead</a>
  </div>
  <p class="board-hint eq-all-hint">Endorsing all three would open three workers at once, above the advocate's limit of two.</p>
</article>`,
      },
    ],
  },

  {
    group: 'History',
    cards: [
      {
        path: 'history/rows.html',
        name: 'History rows',
        subtitle: 'What you decided, and what it cost',
        viewport: { width: 480, height: 380 },
        note: `Every answer you have given, newest first. The <b>.hist-why</b> line is the one that earns the screen: an entry that says only "answered" is a receipt, and an entry that says what the decision <i>did</i> is a record. A refused close is kept rather than hidden — the tracker saying no is part of the history.`,
        markup: `<div class="hist-list card">
  <a class="hist-row" href="#">
    <span class="hist-top"><span class="hist-kind">answered</span><span class="pill id">bc-r941</span><span class="pill st-closed">Closed</span></span>
    <span class="hist-main"><span class="hist-title">Close both beads on merge</span></span>
    <span class="hist-why">made 2 beads · closed bc-r941</span>
  </a>
  <a class="hist-row" href="#">
    <span class="hist-top"><span class="hist-kind">commissioned</span><span class="pill id">bc-1kwl</span><span class="pill st-in_progress">In progress</span></span>
    <span class="hist-main"><span class="hist-title">Split the cache work into three</span></span>
    <span class="hist-why">made 3 beads · bead left open</span>
  </a>
  <div class="hist-foot">
    <p class="hist-count">41 decisions</p>
    <p class="hist-refused">1 close the tracker refused</p>
    <button class="hist-more">Show 20 more<span class="hist-more-note">older than 30 days</span></button>
  </div>
</div>`,
      },
    ],
  },

  {
    group: 'Agent foundations',
    cards: [
      {
        path: 'foundations-agent/fields.html',
        name: 'Foundation fields',
        subtitle: 'Editable, locked, with units',
        viewport: { width: 480, height: 380 },
        note: `What an agent kind is allowed to become. Editing one here is <b>recorded exactly like an amendment the agent asked for</b> — same history, same justification — which is why the field carries a hint rather than just a value. A locked row is one the agent may not change about itself.`,
        markup: `<div class="ds-stack">
  <div class="f-row">
    <label class="f-label">Workers at once</label>
    <input class="f-input" value="2"><span class="f-unit">workers</span>
    <p class="f-hint">The ceiling on how many beads this advocate may open in parallel.</p>
  </div>
  <div class="f-row locked">
    <label class="f-label">May merge its own work</label>
    <span class="f-locked">no</span>
    <p class="f-hint">Set by bc-r941 and not amendable by the agent.</p>
  </div>
  <div class="f-actions">
    <button class="primary">Save</button>
    <button class="secondary">Cancel</button>
  </div>
</div>`,
      },
    ],
  },

  {
    group: 'Requirements',
    cards: [
      {
        path: 'requirements/rows.html',
        name: 'Requirement rows',
        subtitle: 'Covered vs observed',
        viewport: { width: 480, height: 320 },
        note: `The two numbers a requirement carries and the difference between them: <b>covered</b> is what a test claims, <b>observed</b> is what actually ran. A requirement can be fully covered and never observed, which is exactly the state the bar is there to make visible.`,
        markup: `<div class="ds-stack">
  <div class="reqbar">
    <span class="reqbar-covered">41 covered</span>
    <span class="reqbar-observed">37 observed</span>
  </div>
  <div class="req-list">
    <button class="req-row">
      <span class="req-top"><span class="pill id">bc-uytt</span> A grep filter after <code>--</code> must not silently not apply</span>
      <span class="req-meta">covered · observed</span>
      <span class="req-files">test/grepargs.mjs</span>
    </button>
    <button class="req-row is-detail">
      <span class="req-top"><span class="pill id">bc-0p49</span> ugrep answers zero for one ERE shape</span>
      <span class="req-meta">covered · never observed</span>
      <span class="req-files">test/grepargs.mjs</span>
    </button>
  </div>
</div>`,
      },
    ],
  },

  {
    group: 'Admin',
    cards: [
      {
        path: 'admin/rows.html',
        name: 'Admin rows',
        subtitle: 'Pause all, revoke, kill',
        viewport: { width: 480, height: 380 },
        note: `The page for the things that act on the daemon rather than on a bead. The destructive controls are the only place <b>.danger-btn</b> appears in the app, and each one says what it will do in a <b>.admin-detail</b> under it rather than in a confirm dialog — the sentence is the confirmation.`,
        markup: `<section class="card admin-card">
  <div class="admin-head"><span class="work-title">Agents</span></div>
  <div class="admin-row">
    <div class="admin-row-head"><span class="work-title">Pause every advocate</span></div>
    <p class="admin-detail">No sweep opens a worker until you resume. Running workers finish.</p>
    <div class="admin-btns"><button class="primary">Pause all</button><button class="secondary">Resume all</button></div>
  </div>
  <div class="admin-row">
    <div class="admin-row-head"><span class="work-title">Access token</span></div>
    <p class="admin-warn">Revoking signs out every phone, including this one.</p>
    <div class="admin-btns"><button class="danger-btn admin-revoke">Revoke</button></div>
  </div>
  <div class="admin-row">
    <div class="admin-row-head"><span class="work-title">Sessions</span></div>
    <p class="admin-detail">Ends every Claude session this daemon started. Worktrees are left on disk.</p>
    <div class="admin-btns"><button class="danger-btn admin-kill">Kill all sessions</button></div>
  </div>
</section>`,
      },
      {
        path: 'admin/pairing.html',
        name: 'Pairing',
        subtitle: 'The QR that gets the phone on',
        viewport: { width: 420, height: 340 },
        note: `How a phone joins: a QR over Tailscale, with the token already in the link. The foot names the certificate, because the one failure mode that looks like a bug is a phone refusing a self-signed cert it has not been shown yet.`,
        markup: `<section class="card admin-card tls-pairing">
  <div class="admin-head"><span class="work-title">Pair a phone</span></div>
  <div class="tls-qr">▚▚▞▚▞▞▚<br>▞▚▞▚▚▞▚<br>▚▞▚▞▞▚▞</div>
  <p class="admin-detail">Scan on the phone. The link carries the token, so nothing needs typing.</p>
  <p class="admin-detail tls-foot">beadcause.tail9c2.ts.net · self-signed</p>
  <div class="admin-btns"><a class="secondary tls-link" href="#">Copy the link</a></div>
</section>`,
      },
    ],
  },

  {
    group: 'Edit mode',
    cards: [
      {
        path: 'editmode/bar.html',
        name: 'Edit bar',
        subtitle: 'The banner, and the way out',
        viewport: { width: 460, height: 220 },
        note: `Edit mode freezes the repaints and turns a tap into a way of <i>pointing at</i> an element rather than opening it. That is a big enough change to the meaning of a tap that it gets a banner and <b>two ways out</b> — the Done here, and the ✏️ going filled in the corner it was pressed from.`,
        markup: `<div class="ds-stack">
  <div class="editbar">
    <span class="editbar-dot"></span>
    <span class="editbar-say">Tap anything to point at it. Repaints are frozen.</span>
    <button class="editbar-count">3</button>
    <button class="editbar-done">Done</button>
  </div>
</div>`,
      },
      {
        path: 'editmode/notes.html',
        name: 'Pointed-at list',
        subtitle: 'What you marked, and what you said',
        viewport: { width: 460, height: 400 },
        note: `Each thing you tapped becomes a row with the note you attached to it. The ask is deliberately a question rather than a label — what you type here becomes a bead, and "what is wrong with this?" gets a better bead than "note".`,
        markup: `<div class="ds-stack">
  <div class="editnote-row">
    <p class="editnote-ask">What is wrong with this?</p>
    <p class="editnote-what">.card-foot · the repeated question line</p>
    <textarea class="editnote-box" rows="2">Foot repeats the title even when it is the same as the question.</textarea>
    <div class="editlist-actions"><button class="editnote-add">Add</button><button class="editnote-cancel">Cancel</button></div>
  </div>

  <div>
    <div class="editlist-head"><span class="editlist-count">2 marked</span><button class="editlist-close">✕</button></div>
    <ul class="editlist-rows">
      <li class="editlist-row"><span class="editlist-kind">.card-foot</span><span class="editlist-said">repeats the title</span><button class="editlist-drop">✕</button></li>
      <li class="editlist-row"><span class="editlist-kind">.chip-count</span><span class="editlist-said">too dim to read outdoors</span><button class="editlist-drop">✕</button></li>
    </ul>
    <p class="editlist-foot"><em class="editlist-note">Filing these makes one bead per row.</em></p>
    <div class="editlist-actions"><button class="editlist-save">File 2 beads</button></div>
  </div>
</div>`,
      },
    ],
  },

  {
    group: 'Overlays',
    cards: [
      {
        path: 'overlays/drawer.html',
        name: 'Drawer',
        subtitle: 'A graph or a doc, over the page',
        viewport: { width: 460, height: 400 },
        note: `Graph and doc links open <b>over</b> the tab you are on rather than navigating away from it — you came from a card, and going back to a rebuilt list with your scroll position gone is a worse answer than a panel. The edge is the grab handle; the backdrop is the way out.`,
        markup: `<div class="ds-stack">
  <aside class="drawer">
    <header class="drawer-head">
      <h2 class="drawer-title">bc-z665 — the graph</h2>
      <button class="icon-btn">✕</button>
    </header>
    <div class="md"><p>Two blocks, three children, one discovered-from edge.</p></div>
    <div class="drawer-edge"></div>
  </aside>
</div>`,
      },
      {
        path: 'overlays/toast.html',
        name: 'Toast',
        subtitle: 'The one transient message',
        viewport: { width: 460, height: 200 },
        note: `<code>role="status"</code>, and deliberately the <b>only</b> transient surface in the app. Anything that matters after you look away — a failed answer, an error on a bead, a refusal from the tracker — is drawn into the thing it happened to instead.`,
        markup: `<div class="ds-stack">
  <div class="toast" role="status">Answered bc-r941 — 2 beads made</div>
</div>`,
      },
      {
        path: 'overlays/setup.html',
        name: 'Token dialog',
        subtitle: 'The only modal',
        viewport: { width: 460, height: 300 },
        note: `A real <code>&lt;dialog&gt;</code>, shown once, when the app has no token. It names the file the token is in rather than only asking for one — the failure it is recovering from is usually "I opened the app from a bookmark instead of the printed link".`,
        markup: `<div class="setup">
  <form method="dialog">
    <h2>Access token</h2>
    <p>Open this app from the link the server printed, or paste the token from <code>~/.config/beadcause/config.json</code>.</p>
    <input type="password" placeholder="token">
    <button class="primary">Save</button>
  </form>
</div>`,
      },
    ],
  },

  {
    group: 'Utility',
    cards: [
      {
        path: 'utility/buttons.html',
        name: 'Buttons',
        subtitle: 'primary, secondary, danger, linkish',
        viewport: { width: 480, height: 240 },
        note: `Four, and that is the whole set. <b>.primary</b> is filled accent and there is at most one per view. <b>.linkish</b> is a button that opens a pane rather than doing something — it looks like a link because undoing it is just tapping again.`,
        markup: `<div class="ds-stack">
  <div class="row">
    <button class="primary">Answer &amp; close</button>
    <button class="secondary">Comment only</button>
  </div>
  <div class="row">
    <button class="primary danger">Decline #313</button>
    <button class="danger-btn">Revoke</button>
  </div>
  <div class="actions"><button class="linkish">Session log</button></div>
</div>`,
      },
      {
        path: 'utility/empty-lede.html',
        name: 'Empty & lede',
        subtitle: 'Nothing here, and what this screen is',
        viewport: { width: 480, height: 260 },
        note: `<b>.empty</b> is what a list says when it has nothing, and it is a sentence rather than an icon — "no questions" and "the daemon is not answering" look identical as a shrug. <b>.lede</b> is the paragraph a screen opens with, and <b>.section-label</b> is the 11px uppercase rule above a group.`,
        markup: `<div class="ds-stack">
  <h2 class="section-label">Agents</h2>
  <p class="lede">What each agent is, what it has been allowed to become, and what it is doing.</p>
  <div class="empty">Nothing is waiting on you.</div>
  <div class="empty">The daemon is not answering — check the router on the Admin tab.</div>
</div>`,
      },
      {
        path: 'utility/floating.html',
        name: 'Floating actions',
        subtitle: '＋ and ✏️, one thumb each',
        viewport: { width: 420, height: 320 },
        note: `The two controls that float over the inbox, one per thumb, at the same height. <b>＋</b> creates; <b>✏️</b> changes the screen rather than the tracker. Both sit <i>below</i> an open card, which is a fixed full-screen layer at z-index 40 — and the list pays for them, since <code>body.has-compose</code> adds their height to its own bottom padding so the last card still clears the bar.`,
        bodyClass: 'has-compose',
        markup: `<div class="ds-stack">
  <div class="compose-wrap">
    <div class="compose-pick ws-pick">
      <h2 class="section-label">Start one in</h2>
      <div class="chip-row">
        <button class="chip" aria-pressed="false"><span class="chip-label">beadcause</span></button>
        <button class="chip" aria-pressed="false"><span class="chip-label">sophab</span></button>
      </div>
    </div>
    <button class="compose" aria-expanded="true">＋</button>
  </div>
  <button class="editmode" type="button" aria-pressed="false">✏️</button>
</div>`,
      },
      {
        path: 'utility/scrollpos.html',
        name: 'Scroll position',
        subtitle: '"4 of 11" and a rail',
        viewport: { width: 420, height: 200 },
        note: `Where you are in the list. <b>aria-hidden on purpose</b>: a screen reader already walks the list item by item and knows the position, and a live region re-announcing it on every scroll tick would make the app unusable to listen to.`,
        markup: `<div class="scrollpos" aria-hidden="true">4 of 11</div>`,
      },
      {
        path: 'utility/send-queue.html',
        name: 'Send queue',
        subtitle: 'What is waiting for the network',
        viewport: { width: 460, height: 240 },
        note: `An answer typed offline does not fail — it queues, visibly, with a way to read it back and a ✕ to drop it. The phone is the primary client and Tailscale is not always up; a lost answer is the one failure this app cannot have.`,
        markup: `<div class="ds-stack">
  <div class="queued-row">
    <button class="queued-text">Close both beads on merge — the queue owns the ending.</button>
    <button class="row-x">✕</button>
  </div>
  <p class="queued-note">Waiting for the daemon. It will send itself when the network is back.</p>
</div>`,
      },
      {
        path: 'utility/badges.html',
        name: 'Badges',
        subtitle: 'On a tab, on an icon button',
        viewport: { width: 420, height: 200 },
        note: `A count on the thing you tap, never beside it. Both cap at <b>9+</b>, and both are <code>hidden</code> at zero — zero is not a state worth drawing, and a badge that says 0 reads as a badge that failed to load.`,
        markup: `<div class="ds-stack">
  <div class="sheet-actions">
    <a href="#" class="icon-btn">⚖️<span class="badge">3</span></a>
    <a href="#" class="icon-btn">⚖️<span class="badge">9+</span></a>
  </div>
  <div class="meta">
    <span class="tab-icon">🛰<span class="tab-badge">2</span></span>
    <span class="tab-icon">📥<span class="tab-badge">9+</span></span>
  </div>
</div>`,
      },
    ],
  },
];
