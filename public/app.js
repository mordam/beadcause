/* Beadcause — mobile decision inbox for `bd human` questions. */
(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const listEl = $('#list');
  const filtersEl = $('#filters');
  const pulseEl = $('#pulse');
  const toastEl = $('#toast');

  // Which slice of the tracker the list is. See the settings panel in index.html:
  // `human` is the app's premise, but it made a workspace with no questions look
  // empty when it was anything but.
  const SCOPES = ['human', 'both', 'agent'];

  const state = {
    token: '',
    scope: 'human',
    questions: [],
    // The other channel: agents asking to change what they are. Its own array, never
    // merged into `questions`, because everything that reads `questions` — the
    // filters, the counts, the empty state, the order — is about work, and a
    // constitutional decision is not work. See `requestsHtml`.
    requests: [],
    spaces: [],
    // The counts the chrome draws — beads asking you something, agents running,
    // advocates waiting. Server-held rather than counted out of the rows above,
    // because two of the three are about things that are not in this list at all
    // and the third has to survive a scope that never fetched it. See summaryNow()
    // in lib/server.js.
    summary: {},
    space: 'all',
    workspace: 'all',
    open: new Set(),
    armed: null, // key of the option awaiting its confirm tap
    armedTimer: null,
    // Which cards have their agent log showing, and the text last fetched for each.
    // Kept out of the question objects so a list refresh can't wipe a pane you are
    // reading mid-run.
    logs: new Set(),
    logText: new Map(),
    logTimer: null,
    // Key of the card whose ⋮ menu is showing. At most one, and it is deliberately
    // opened and closed by DOM surgery rather than render() — see closeMenu().
    menu: null,
    // The roster you can put a comment to, and which one is selected. The choice is
    // global rather than per card: "who am I talking to" is a mode you are in, not a
    // property of one question.
    agents: [],
    agent: localStorage.getItem('beadcause.agent') || '',
    agentForm: false,
    // Per-bead decisions on an advocate's proposal: key → Map(1-based index →
    // 'yes' | 'no'). Held here rather than on the question so a background refresh
    // cannot wipe a half-made decision, the same reason drafts live outside it.
    picks: new Map(),
    // Which proposal rows you have unfolded, as `${key}|${n}`. Out here with the
    // picks for the same reason: a background refresh must not fold a row back up
    // while you are reading it.
    propOpen: new Set(),
    // Keys whose answer is written but not yet acknowledged. The card leaves the
    // list on the tap so the bead has somewhere to collapse into — but the bead is
    // still open on the server until the write lands, so a poll that overlapped the
    // write would put the card straight back underneath the flight. Held until the
    // write resolves either way; see submit().
    inFlight: new Set(),
  };

  /* ---------------------------------------------------------------- token */

  function bootToken() {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      // Keep the token out of the address bar (and out of the home-screen title).
      history.replaceState(null, '', location.pathname + location.hash);
    }
    state.token = localStorage.getItem('beadcause.token') || '';
    if (!state.token) askForToken();
  }

  function askForToken() {
    const dlg = $('#setup');
    dlg.showModal();
    dlg.addEventListener(
      'close',
      () => {
        const val = $('#token-input').value.trim();
        if (!val) return;
        localStorage.setItem('beadcause.token', val);
        state.token = val;
        load();
      },
      { once: true }
    );
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'content-type': 'application/json', 'x-beadcause-token': state.token, ...(opts.headers || {}) },
    });
    if (res.status === 401) {
      localStorage.removeItem('beadcause.token');
      askForToken();
      throw new Error('token rejected');
    }
    const data = await res.json().catch(() => ({}));
    // The body travels with the error: a 428 asking for an acknowledgement carries
    // the whole warning to show, and a message string alone would throw it away.
    if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status, body: data });
    return data;
  }

  /* -------------------------------------------------------------- helpers */

  const esc = (s) =>
    String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /** `sophab/sp-hz3.5` is not a valid id attribute; the anchor has to survive it. */
  const cardId = (key) => esc(String(key).replace(/[^\w-]/g, '_'));

  /** Local files can't be loaded by the browser directly — route them through the server. */
  function assetUrl(p) {
    const s = String(p || '').trim();
    if (!s) return '';
    if (/^(https?:|data:)/i.test(s)) return s;
    if (/^file:\/\//i.test(s) || s.startsWith('/') || s.startsWith('~')) {
      const abs = s.startsWith('~') ? s.replace(/^~/, '') : s;
      return `/api/asset?p=${encodeURIComponent(abs)}&t=${encodeURIComponent(state.token)}`;
    }
    return s;
  }

  function relTime(iso) {
    if (!iso) return '';
    const then = new Date(iso).getTime();
    if (!then) return '';
    const mins = Math.round((Date.now() - then) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.round(hrs / 24)}d ago`;
  }

  const isLocalPath = (s) => /^(file:\/\/|~\/|\/)/.test(String(s || '').trim());

  /** A file on the Mac opens in the reader tab, not as a dead file:// link. */
  function docUrl(p) {
    let s = String(p || '').trim();
    if (s.startsWith('file://')) s = decodeURIComponent(s.slice(7));
    if (s.startsWith('~')) s = s.replace(/^~/, '');
    return `/doc?p=${encodeURIComponent(s)}`;
  }

  /** The bd dependency graph for a question, in its own tab. */
  function graphUrl(q) {
    return `/graph?ws=${encodeURIComponent(q.workspace)}&id=${encodeURIComponent(q.id)}`;
  }

  /** What bd handed us: hard-wrapped, so let the paragraph reflow. */
  const FROM_BD = { breaks: false };

  /**
   * `breaks` is a choice, not a default. bd stores its fields hard-wrapped at ~78
   * columns, so on a phone every stored line wraps naturally and then takes a
   * forced break on top — a staircase instead of a paragraph, and list items that
   * read as loose prose. Prose that came out of bd renders with `breaks: false`.
   * Anything typed by a person means its newlines, so it keeps them.
   */
  function renderMarkdown(md, { breaks = true } = {}) {
    let patched = String(md || '');
    // Rewrite local image paths before parsing — DOMPurify would strip file:// URLs.
    patched = patched.replace(
      /!\[([^\]]*)\]\(\s*([^)\s]+)((?:\s+"[^"]*")?)\s*\)/g,
      (_, alt, href, title) => `![${alt}](${assetUrl(href)}${title})`
    );
    // A link to a file on disk becomes a reader-tab link. (The leading group
    // keeps this from matching the image syntax rewritten above.)
    patched = patched.replace(
      /(^|[^!])\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g,
      (m, pre, label, href) => (isLocalPath(href) ? `${pre}[${label}](${docUrl(href)})` : m)
    );
    const html = window.marked.parse(patched, { breaks, gfm: true });
    return window.DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
  }

  /** Every link in a brief opens in its own tab — you're mid-answer, don't navigate away. */
  function openLinksInNewTab(root) {
    for (const a of root.querySelectorAll('.md a[href], .links a[href], .docs a[href]')) {
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
    }
  }

  /* --------------------------------------------------------------- drafts */

  const draftKey = (key) => `beadcause.draft.${key}`;
  const getDraft = (key) => localStorage.getItem(draftKey(key)) || '';
  const setDraft = (key, text) => {
    if (text.trim()) localStorage.setItem(draftKey(key), text);
    else localStorage.removeItem(draftKey(key));
  };
  const clearDraft = (key) => localStorage.removeItem(draftKey(key));

  /** Don't yank the textarea out from under a thumb mid-sentence. */
  const isTyping = () => !!document.activeElement?.matches?.('[data-role="answer"]');

  /**
   * Answering means focused OR holding text. The second half matters: you tap a
   * doc link to go read the spec, focus leaves, and the answer you'd started must
   * still be sitting there when you come back.
   */
  const isAnswering = () =>
    isTyping() || [...listEl.querySelectorAll('[data-role="answer"]')].some((t) => t.value.trim());

  /* -------------------------------------------------------------- mermaid */

  let mermaidReady = null;
  function loadMermaid() {
    if (mermaidReady) return mermaidReady;
    mermaidReady = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = '/vendor/mermaid.js';
      s.onload = () => {
        const dark = matchMedia('(prefers-color-scheme: dark)').matches;
        window.mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          theme: dark ? 'dark' : 'default',
          fontFamily: 'inherit',
        });
        resolve(window.mermaid);
      };
      s.onerror = () => reject(new Error('mermaid failed to load'));
      document.head.appendChild(s);
    });
    return mermaidReady;
  }

  let diagramSeq = 0;
  async function drawDiagrams(root) {
    const targets = [
      ...root.querySelectorAll('.diagram[data-src]'),
      ...root.querySelectorAll('pre > code.language-mermaid'),
    ];
    if (!targets.length) return;
    let mermaid;
    try {
      mermaid = await loadMermaid();
    } catch {
      return;
    }
    for (const node of targets) {
      const isFence = node.tagName === 'CODE';
      const src = isFence ? node.textContent : node.dataset.src;
      const host = isFence ? node.closest('pre') : node;
      try {
        const { svg } = await mermaid.render(`mmd-${++diagramSeq}`, src);
        if (isFence) {
          const box = document.createElement('div');
          box.className = 'diagram';
          box.innerHTML = svg;
          host.replaceWith(box);
        } else {
          host.innerHTML = svg;
          delete host.dataset.src;
        }
      } catch (err) {
        if (!isFence) host.textContent = `diagram error: ${err.message}`;
      }
    }
  }

  /* --------------------------------------------------------------- render */

  const PHASE_ICON = {
    thinking: '🤔',
    researching: '🔍',
    drafting: '✍️',
    building: '🔨',
    blocked: '⛔',
    waiting: '⏳',
    done: '✅',
  };
  // Phases where an agent is actively working — these get the animated dot.
  const LIVE_PHASES = new Set(['thinking', 'researching', 'drafting', 'building']);

  /** What an agent is doing about this question right now. */
  function activityHtml(q) {
    const a = q.activity;
    if (a?.phase) {
      const live = LIVE_PHASES.has(a.phase);
      return `<div class="activity${live ? ' live' : ''}">
        <span class="spark"></span>
        <span class="phase">${PHASE_ICON[a.phase] || '•'} ${esc(a.phase)}</span>
        ${a.detail ? `<span class="detail">${esc(a.detail)}</span>` : ''}
        ${a.at ? `<time>${esc(relTime(a.at))}</time>` : ''}
      </div>`;
    }
    if (q.awaitingAgent) {
      return `<div class="activity waiting">
        <span class="spark"></span>
        <span class="phase">⏳ you replied</span>
        <span class="detail">waiting on an agent to pick this up</span>
      </div>`;
    }
    return '';
  }

  /**
   * The agent state worth showing as a pending reply at the foot of the thread.
   *
   * `done` is excluded deliberately: a finished agent has already left a real
   * comment above, so a ghost bubble under it would just be a duplicate.
   */
  function pendingActivity(q) {
    if (q.activity?.phase && q.activity.phase !== 'done') return q.activity;
    if (q.awaitingAgent) return { phase: 'waiting', detail: 'waiting on an agent to pick this up' };
    return null;
  }

  /** One message in a bead's thread. Shared with the agent-bead card, which has a
   *  thread but no decision and nothing to answer. */
  function commentHtml(c) {
    return `<div class="comment${c.author && c.author !== 'beadcause' ? ' from-agent' : ''}">
      <span class="who">${esc(c.author || '')} · ${esc(relTime(c.created_at))}</span>
      <div class="md">${renderMarkdown(c.text || '')}</div>
    </div>`;
  }

  /** A placeholder shaped like the agent comment that is about to land here. */
  function pendingHtml(a) {
    const live = LIVE_PHASES.has(a.phase);
    return `<div class="comment from-agent pending${live ? ' live' : ''}">
      <span class="who"><span class="spark"></span>${PHASE_ICON[a.phase] || '•'} ${esc(a.phase)}</span>
      <div class="pending-detail">${esc(a.detail || 'working on your comment…')}</div>
    </div>`;
  }

  /**
   * The corner controls an open card carries: the kebab, and collapse — hard right.
   *
   * A card only grows these once it is open, because closed it is a row in a list
   * and has nothing to collapse. Both corners get a way out: the top one is where
   * your thumb already is when the card opens, the bottom one is where you land
   * after reading a brief with a diagram and a thread in it.
   *
   * Everything that is neither reading nor answering lives behind the kebab — the
   * card is a question, and a third full-width button under the answer box read as
   * a third way to answer it.
   */
  function cardTopHtml(q) {
    const on = state.menu === q.key;
    return `<div class="card-top">
      <div class="menu-wrap">
        <button class="kebab${on ? ' on' : ''}" data-act="menu" data-key="${esc(q.key)}"
          aria-haspopup="true" aria-expanded="${on}" aria-label="More actions">⋮</button>
        ${on ? menuHtml(q.key) : ''}
      </div>
      <button class="collapse" data-act="collapse" data-key="${esc(q.key)}">↑ Collapse</button>
    </div>`;
  }

  /**
   * The same identifying line the card opens with, repeated at its foot.
   *
   * A brief can run several screens — a diagram, a spec, a thread — and by the time
   * you reach the answer box the workspace, the id and the question itself are far
   * above you. Answering the wrong bead is the expensive mistake here, so the foot
   * says which one this is rather than making you scroll up to check.
   *
   * Quieter than the head on purpose: the same facts, second time, as a caption.
   */
  function cardFootHtml(q) {
    const time = q.agent ? q.since : q.createdAt;
    const sub = q.agent
      ? [q.type, q.actor].filter(Boolean).map(esc).join(' · ')
      : q.question && q.title !== q.question
        ? esc(q.title)
        : '';
    return `<div class="card-foot">
      <div class="meta">
        <span class="pill">${esc(q.workspace)}</span>
        <span class="pill id">${esc(q.id)}</span>
        ${q.priority != null ? `<span class="pill p${q.priority}">P${q.priority}</span>` : ''}
        ${q.agent ? `<span class="pill st-${esc(q.status)}">${esc(STATUS_LABEL[q.status] || q.status)}</span>` : ''}
        ${q.dependentCount ? `<span class="pill">blocks ${q.dependentCount}</span>` : ''}
        <time>${esc(relTime(time))}</time>
      </div>
      <p class="q">${esc(q.question || q.title)}</p>
      ${sub ? `<p class="subtitle">${sub}</p>` : ''}
    </div>`;
  }

  /**
   * What is behind the kebab: the three ways out of a card that aren't reading it.
   *
   * The first two act *on* this bead and differ only in which screen the session
   * lands on — the Mac's, or this one. The third goes the other way: what work
   * comes off the back of it. All but the first are anchors rather than buttons,
   * because both of those pages open from `?ws=&seed=` on their own (see
   * public/term.js and public/console.js) and so need nothing from this one.
   *
   * The key is `workspace/id`; a workspace name never contains a slash, so the first
   * one splits it.
   */
  function menuHtml(key) {
    const cut = String(key).indexOf('/');
    const ws = String(key).slice(0, cut);
    const id = String(key).slice(cut + 1);
    return `<div class="menu" role="menu">
      <button class="menu-item" role="menuitem" data-act="discuss" data-key="${esc(key)}">
        <span class="glyph">&gt;_</span> Discuss in a Claude session on the Mac
      </button>
      <a class="menu-item" role="menuitem"
        href="/terminal?ws=${encodeURIComponent(ws)}&amp;seed=${encodeURIComponent(id)}">
        <span class="glyph">⌨️</span> Drive a session on it from here
      </a>
      <a class="menu-item" role="menuitem"
        href="/console?ws=${encodeURIComponent(ws)}&amp;seed=${encodeURIComponent(id)}">
        <span class="glyph">🧾</span> Work out the next beads from this
      </a>
    </div>`;
  }

  /** What you have said about each proposed bead so far. */
  const picksFor = (key) => {
    if (!state.picks.has(key)) state.picks.set(key, new Map());
    return state.picks.get(key);
  };

  const approvedIndices = (key, beads) =>
    beads.map((_, i) => i + 1).filter((n) => picksFor(key).get(n) === 'yes');

  /**
   * The fields a proposed bead would be created with, in the order proposalBody
   * prints them (lib/proposal.js) — the row and the question body it came from
   * should read the same way round. Rationale is deliberately absent here: it is an
   * argument for the bead rather than part of it, so the row prints it last.
   */
  const PROP_FIELDS = [
    // The description needs no label: it is what a bead obviously is, and a row with
    // one short line in it should not carry a heading saying so.
    { key: 'description', label: '' },
    { key: 'acceptance', label: 'Done when' },
    { key: 'design', label: 'Design' },
    { key: 'notes', label: 'Notes' },
    { key: 'labels', label: 'Labels', pills: true },
    { key: 'deps', label: 'Depends on', pills: 'id' },
  ];

  /**
   * Everything that would end up on the bead, each under a quiet label.
   *
   * Prose goes through the markdown renderer rather than out as escaped text: an
   * advocate writes a description as a bulleted list, and a list rendered as one
   * run-on line is a list you skip — which is the whole failure this row had.
   */
  function propFieldsHtml(b) {
    return PROP_FIELDS.map((f) => {
      const v = b[f.key];
      const body = f.pills
        ? (Array.isArray(v) ? v : [])
            .map((x) => `<span class="pill${f.pills === 'id' ? ' id' : ''}">${esc(x)}</span>`)
            .join('')
        : v
        ? `<div class="md">${renderMarkdown(v, FROM_BD)}</div>`
        : '';
      if (!body) return '';
      const label = f.label ? `<span class="prop-label">${f.label}</span>` : '';
      return `<div class="prop-field${f.pills ? ' pills' : ''}">${label}${body}</div>`;
    }).join('');
  }

  // A phone column fits about this many characters, and this many lines of one row
  // is as much as can sit above the next proposal and still leave it scannable.
  const PHONE_COLS = 42;
  const COLLAPSE_AT = 9;

  /**
   * Roughly how tall a row's prose will be. Cheap on purpose: the alternative is
   * measuring after layout, and this only has to be right about "is this a wall of
   * text", which counting wrapped lines settles well enough.
   */
  function propLines(b) {
    const prose = [b.description, b.acceptance, b.design, b.notes, b.rationale].filter(Boolean).join('\n');
    if (!prose) return 0;
    return prose.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / PHONE_COLS)), 0);
  }

  /**
   * An advocate asking to create beads.
   *
   * Every other question in the inbox is one decision, which is why the rest of this
   * file can treat an option tap as the answer. A proposal is *n* decisions that
   * happen to arrive together, and flattening them into "all or nothing" is what
   * makes an agent's suggestions annoying: one good bead in three is a perfectly
   * ordinary outcome, and having to decline all three to avoid the two bad ones
   * teaches you to decline everything.
   *
   * So: approve and decline per row, two bulk controls for when they all point the
   * same way, and one primary action that says exactly how many it will file. It
   * paints in place — see paintPicks — because a re-render would rebuild the card
   * under a decision you are halfway through making.
   */
  function proposalHtml(q) {
    const beads = q.proposal?.beads || [];
    if (!beads.length) return '';
    const picks = picksFor(q.key);
    const approved = approvedIndices(q.key, beads);
    const armed = state.armed === `${q.key}|proposal`;

    const rows = beads
      .map((b, i) => {
        const n = i + 1;
        const choice = picks.get(n) || '';
        // Long rows start folded so three proposals still fit on the screen you are
        // deciding from. A fold and not the old three-line clamp, because a clamp
        // cuts markdown mid-list-item and leaves no way at all to see the rest.
        const long = propLines(b) > COLLAPSE_AT;
        const collapsed = long && !state.propOpen.has(`${q.key}|${n}`);
        return `<div class="prop-row ${choice ? `pick-${choice}` : ''}${collapsed ? ' is-collapsed' : ''}" data-idx="${n}" data-key="${esc(q.key)}">
          <div class="prop-main">
            <div class="prop-head"><span class="prop-n">${n}</span><span class="prop-title">${esc(b.title)}</span></div>
            <div class="prop-body">
              <div class="prop-meta">
                <span class="pill">${esc(b.type)}</span><span class="pill p${b.priority}">P${b.priority}</span>
              </div>
              ${propFieldsHtml(b)}
              ${
                b.rationale
                  ? `<div class="prop-why"><span class="prop-label">Why</span><div class="md">${renderMarkdown(
                      b.rationale,
                      FROM_BD
                    )}</div></div>`
                  : ''
              }
            </div>
            ${
              long
                ? `<button class="prop-more" data-act="prop-more" data-key="${esc(q.key)}" data-idx="${n}"
                    aria-expanded="${!collapsed}">${collapsed ? 'Show the rest' : 'Show less'}</button>`
                : ''
            }
          </div>
          <div class="prop-choice">
            <button class="prop-btn yes" data-act="pick" data-key="${esc(q.key)}" data-idx="${n}" data-pick="yes"
              aria-label="Approve bead ${n}" aria-pressed="${choice === 'yes'}">✓</button>
            <button class="prop-btn no" data-act="pick" data-key="${esc(q.key)}" data-idx="${n}" data-pick="no"
              aria-label="Decline bead ${n}" aria-pressed="${choice === 'no'}">✕</button>
          </div>
        </div>`;
      })
      .join('');

    // Undecided rows are counted, not silently treated as a no: "3 undecided" is the
    // difference between a considered decline and a half-read card.
    const undecided = beads.length - [...picks.values()].filter((v) => v === 'yes' || v === 'no').length;

    return `<div class="proposal" data-key="${esc(q.key)}">
      <div class="section-label">${beads.length} bead${beads.length === 1 ? '' : 's'} proposed <span>nothing is created until you say so</span></div>
      ${rows}
      <div class="prop-bulk">
        <button class="linkish" data-act="pick-all" data-key="${esc(q.key)}" data-pick="yes">Approve all</button>
        <button class="linkish" data-act="pick-all" data-key="${esc(q.key)}" data-pick="no">Decline all</button>
        <span class="prop-count">${undecided ? `${undecided} undecided` : ''}</span>
      </div>
      <button class="primary prop-go${armed ? ' confirm' : ''}" data-act="pick-submit" data-key="${esc(q.key)}" ${
        approved.length || undecided === 0 ? '' : 'disabled'
      }>${propGoLabel(approved.length, beads.length, armed)}</button>
    </div>`;
  }

  /** The primary button says what it will do, including when that is "create nothing". */
  function propGoLabel(approved, total, armed) {
    const what = approved === 0 ? 'Decline all — create nothing' : approved === total ? `Create all ${total}` : `Create ${approved} of ${total}`;
    return armed ? `Tap again to confirm · ${what}` : what;
  }

  /**
   * Repaint one proposal in place: row states, the undecided count and the primary
   * button. Deliberately not a render() — that rebuilds every card in the list, and
   * this runs on every tap.
   */
  function paintPicks(key) {
    const q = byKey(key);
    const beads = q?.proposal?.beads || [];
    const block = listEl.querySelector(`.proposal[data-key="${CSS.escape(key)}"]`);
    if (!block || !beads.length) return;
    const picks = picksFor(key);

    for (const row of block.querySelectorAll('.prop-row')) {
      const n = Number(row.dataset.idx);
      const choice = picks.get(n) || '';
      row.classList.toggle('pick-yes', choice === 'yes');
      row.classList.toggle('pick-no', choice === 'no');
      for (const btn of row.querySelectorAll('.prop-btn')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.pick === choice));
      }
    }

    const decided = [...picks.values()].filter((v) => v === 'yes' || v === 'no').length;
    const undecided = beads.length - decided;
    const approved = approvedIndices(key, beads).length;
    const count = block.querySelector('.prop-count');
    if (count) count.textContent = undecided ? `${undecided} undecided` : '';
    const go = block.querySelector('.prop-go');
    if (go) {
      const armed = state.armed === `${key}|proposal`;
      go.textContent = propGoLabel(approved, beads.length, armed);
      go.classList.toggle('confirm', armed);
      go.disabled = !(approved || undecided === 0);
    }
  }

  /** The selected agent, falling back to the first one the server offered. */
  const currentAgent = () => state.agents.find((a) => a.id === state.agent) || state.agents[0] || null;

  /**
   * Who answers when you comment.
   *
   * Commenting has always dispatched an agent; there was just only one of it, and
   * its brief was hard-coded. Half the time what a thread needs is not an answer but
   * the counter-argument, or the three paths that settle it — different briefs, not
   * different phrasings of one.
   *
   * The chips are a mode, not a per-card setting, and the foundation of the selected
   * one is printed underneath: an agent whose brief you cannot read is a name you
   * are guessing at. Creating one needs only a name and that paragraph — never
   * tools, which is why this form cannot widen what any agent may do.
   */
  function agentsHtml() {
    if (!state.agents.length) return '';
    const chosen = currentAgent();
    const chips = state.agents
      .map(
        (a) => `<button class="chip agent-chip" data-act="agent" data-agent="${esc(a.id)}"
          aria-pressed="${a.id === chosen?.id}">${esc(a.emoji || '🤖')} ${esc(a.name)}</button>`
      )
      .join('');

    return `<div class="section-label">Reply from <span>the agent that picks up your comment</span></div>
      <div class="chip-row agent-row">
        ${chips}
        <button class="chip agent-add" data-act="agent-new" aria-label="New agent">＋</button>
      </div>
      <p class="agent-desc">${esc(chosen?.description || '')}</p>
      ${allowToolsHtml(chosen)}
      <div class="agent-form" ${state.agentForm ? '' : 'hidden'}>
        <input data-role="agent-name" placeholder="Name — e.g. Pricing hawk" maxlength="40">
        <textarea data-role="agent-desc" rows="4"
          placeholder="Its foundation: what this agent is for, and how it should answer. This goes in front of every reply it writes."></textarea>
        <div class="row">
          <button class="primary" data-act="agent-create">Create agent</button>
          <button class="secondary" data-act="agent-cancel">Cancel</button>
        </div>
      </div>`;
  }

  /**
   * "Allow tools" — off by every time.
   *
   * A checkbox rather than a setting, because it is spent by the comment it rides
   * on: the server arms the agent's configured override for exactly one reply and
   * drops it the moment the dispatch goes. So this is re-ticked for every comment
   * you want it for, which is the point — an elevation you set once and forget is an
   * elevation nobody remembers granting.
   *
   * Only drawn for an agent that HAS an override in the config file. Nothing here
   * can write one; this decides whether it is used, never what it says.
   */
  function allowToolsHtml(agent) {
    if (!agent?.tools) return '';
    const busy = agent.busyOn;
    return `<label class="allow-tools${agent.armed ? ' on' : ''}${busy ? ' busy' : ''}">
      <input type="checkbox" data-act="allow-tools" data-agent="${esc(agent.id)}" ${agent.armed ? 'checked' : ''} ${
        busy ? 'disabled' : ''
      }>
      <span class="allow-label">⚠ Allow tools for this comment</span>
      <span class="allow-note">${
        busy
          ? `${esc(agent.name)} is answering ${esc(busy)} — not while it is running`
          : agent.armed
            ? 'armed · spent when you send'
            : esc(agent.tools)
      }</span>
    </label>`;
  }

  /**
   * The warning, the first time an agent is given its extra reach.
   *
   * The text comes from the server so every client warns in the same words about the
   * same tools — and it names them verbatim, because a warning that will not say
   * what is being granted is theatre.
   */
  function confirmTools(disclaimer) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.className = 'dialog-wrap';
      wrap.innerHTML = `<div class="dialog" role="dialog" aria-modal="true" aria-label="${esc(disclaimer.title)}">
        <h2>${esc(disclaimer.title)}</h2>
        <pre class="dialog-tools">${esc(disclaimer.tools)}</pre>
        <ul>${disclaimer.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
        <div class="row">
          <button class="primary" data-yes>I understand — allow for this comment</button>
          <button class="secondary" data-no>Cancel</button>
        </div>
      </div>`;
      const done = (v) => {
        wrap.remove();
        resolve(v);
      };
      wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-yes]')) return done(true);
        // The backdrop cancels, like every other dismissable thing here — but a tap
        // inside the panel must not, or reading it would close it.
        if (ev.target.closest('[data-no]') || !ev.target.closest('.dialog')) return done(false);
      });
      document.body.appendChild(wrap);
    });
  }

  /**
   * Repaint the chooser in place.
   *
   * Never through render(): the comment box sits directly beneath it, and rebuilding
   * the card to change which chip is pressed would drop a half-written comment —
   * which is the exact failure the draft machinery elsewhere exists to prevent.
   */
  function paintAgents() {
    for (const block of listEl.querySelectorAll('.agents')) block.innerHTML = agentsHtml();
  }

  async function loadAgents() {
    try {
      const data = await api('/api/agents');
      state.agents = data.agents || [];
      if (!state.agents.some((a) => a.id === state.agent)) state.agent = data.default || state.agents[0]?.id || '';
      paintAgents();
    } catch {
      // A roster that won't load must not stop you commenting: with no chips, the
      // server falls back to the default agent exactly as it did before this existed.
      state.agents = [];
    }
  }

  function cardHtml(q) {
    if (q.agent) return agentCardHtml(q);
    const d = q.decision;
    // A proposal draws its own controls, one pair per bead plus the two bulk ones.
    // Showing the decision block's "Create all / No" underneath as well would be two
    // sets of buttons for the same choice, disagreeing about granularity.
    const opts = q.proposal?.beads?.length ? [] : d?.options || [];
    const open = state.open.has(q.key);
    const hasBrief = Boolean(
      d?.diagrams?.length || d?.links?.length || d?.docs?.length || d?.images?.length || q.sections.length || d?.context
    );

    const options = opts
      .map((o) => {
        const armed = state.armed === `${q.key}|${o.id}`;
        // The arm/disarm state is painted in place by paintArmed() — it must never
        // go through render(), which would rebuild the list under a half-typed answer.
        return `<button class="option${armed ? ' confirm' : ''}" data-act="option" data-key="${esc(q.key)}" data-opt="${esc(
          o.id
        )}" data-label="${esc(o.label)}">
          <span class="label">${armed ? 'Tap again to confirm · ' : ''}${esc(o.label)}</span>
          ${o.hint ? `<span class="hint">${esc(o.hint)}</span>` : ''}
        </button>`;
      })
      .join('');

    const brief = open ? briefHtml(q) : '';
    const draft = getDraft(q.key);

    // `open` takes the card full screen — see .card.open in style.css. A question is
    // read one at a time, and on a phone expanding inline meant the brief, the thread
    // and the answer box all competed with the list around them. openOnly() is what
    // keeps "one at a time" true.
    return `<article class="card${open ? ' open' : ''}${draft ? ' has-draft' : ''}${
      q.awaitingAgent ? ' replied' : ''
    }" id="card-${cardId(q.key)}" data-key="${esc(q.key)}">
      ${open ? cardTopHtml(q) : ''}
      <div class="card-head">
        <div class="meta">
          <span class="pill">${esc(q.workspace)}</span>
          <span class="pill id">${esc(q.id)}</span>
          ${q.priority != null ? `<span class="pill p${q.priority}">P${q.priority}</span>` : ''}
          ${q.dependentCount ? `<span class="pill">blocks ${q.dependentCount}</span>` : ''}
          ${draft && !open ? '<span class="draft-flag">draft saved</span>' : ''}
          <time>${esc(relTime(q.createdAt))}</time>
        </div>
        ${activityHtml(q)}
        <p class="q">${esc(q.question || q.title)}</p>
        ${q.question && q.title !== q.question ? `<p class="subtitle">${esc(q.title)}</p>` : ''}
        ${(q.errors || []).map((e) => `<p class="subtitle bad">⚠ ${esc(e)}</p>`).join('')}
      </div>
      ${proposalHtml(q)}
      ${options ? `<div class="options">${options}</div>` : ''}
      <div class="actions">
        <button class="linkish" data-act="toggle" data-key="${esc(q.key)}">
          ${open ? 'Hide details' : draft ? 'Resume your answer' : hasBrief ? 'Show details' : 'Write an answer'}
        </button>
        ${
          q.awaitingAgent
            ? `<button class="linkish log-btn" data-act="log" data-key="${esc(q.key)}">${
                state.logs.has(q.key) ? 'Hide session log' : 'Session log'
              }</button>`
            : ''
        }
      </div>
      ${
        state.logs.has(q.key)
          ? `<pre class="agent-log" data-log="${esc(q.key)}">${esc(state.logText.get(q.key) || 'opening the log…')}</pre>`
          : ''
      }
      <div class="brief"${open ? '' : ' hidden'}>${brief}</div>
    </article>`;
  }

  const STATUS_LABEL = { in_progress: 'claimed', blocked: 'blocked', open: 'open' };

  /**
   * A bead nobody is asking you about.
   *
   * Read-only on purpose. There is no decision block, so there are no options — and
   * deliberately no "Answer & close", because that path comments "Answered via
   * Beadcause" and closes the bead, which on another session's in-progress work
   * would be vandalism rather than an answer. What a card gives you is what the bead
   * is, who has it, and the two ways in: the graph, or a session on the Mac that can
   * actually write.
   *
   * Smaller type than a question, too. There can be two hundred of these and eleven
   * questions; they must not compete for attention with the thing that needs you.
   */
  function agentCardHtml(q) {
    const open = state.open.has(q.key);
    return `<article class="card agent-card" id="card-${cardId(q.key)}" data-key="${esc(q.key)}">
      ${open ? cardTopHtml(q) : ''}
      <div class="card-head">
        <div class="meta">
          <span class="pill">${esc(q.workspace)}</span>
          <span class="pill id">${esc(q.id)}</span>
          ${q.priority != null ? `<span class="pill p${q.priority}">P${q.priority}</span>` : ''}
          <span class="pill st-${esc(q.status)}">${esc(STATUS_LABEL[q.status] || q.status)}</span>
          ${q.dependentCount ? `<span class="pill">blocks ${q.dependentCount}</span>` : ''}
          <time>${esc(relTime(q.since))}</time>
        </div>
        ${activityHtml(q)}
        <p class="q">${esc(q.title)}</p>
        ${
          q.actor || q.type
            ? `<p class="subtitle">${[q.type, q.actor].filter(Boolean).map(esc).join(' · ')}</p>`
            : ''
        }
      </div>
      <div class="actions">
        <button class="linkish" data-act="toggle" data-key="${esc(q.key)}">${open ? 'Hide details' : 'Show details'}</button>
        <a class="linkish" href="${esc(graphUrl(q))}" target="_blank" rel="noopener noreferrer">Graph →</a>
      </div>
      <div class="brief"${open ? '' : ' hidden'}>${open ? agentBriefHtml(q) : ''}</div>
    </article>`;
  }

  /** The body of an agent bead: description, notes, thread. Fetched by expand(). */
  function agentBriefHtml(q) {
    const parts = [];
    if (q.description) parts.push(`<div class="md">${renderMarkdown(q.description, FROM_BD)}</div>`);
    // `notes` is where sessions record what they actually did, and it is often the
    // only part worth reading — a bead can have an aspirational description and a
    // notes field saying it shipped three days ago.
    if (q.notes) {
      parts.push('<div class="section-label">notes</div>');
      parts.push(`<div class="md">${renderMarkdown(q.notes, FROM_BD)}</div>`);
    }
    if (!q.description && !q.notes) parts.push('<p class="subtitle">No description on this bead.</p>');

    if (q.comments?.length) {
      parts.push('<div class="section-label">Thread</div>');
      parts.push(`<div class="comments">${q.comments.map(commentHtml).join('')}</div>`);
    }

    // Nothing on this card writes to the bead, so the way to act on it is a session
    // that can — and that lives behind the kebab in the corner, with everything else
    // that isn't reading.
    parts.push(cardFootHtml(q));

    parts.push(`<div class="collapse-row">
      <button class="collapse" data-act="collapse" data-key="${esc(q.key)}">↑ Collapse</button>
    </div>`);

    return parts.join('');
  }

  function briefHtml(q) {
    const d = q.decision;
    const parts = [];

    if (d?.context) parts.push(`<div class="md">${renderMarkdown(d.context, FROM_BD)}</div>`);

    for (const src of d?.diagrams || []) {
      parts.push(`<div class="diagram" data-src="${esc(src)}">drawing…</div>`);
    }

    for (const img of d?.images || []) {
      parts.push(`<img src="${esc(assetUrl(img))}" alt="" loading="lazy">`);
    }

    if (d?.docs?.length) {
      parts.push(
        `<div class="docs">${d.docs
          .map(
            (doc) =>
              `<a href="${esc(docUrl(doc.path))}" target="_blank" rel="noopener noreferrer"><span>${esc(
                doc.label
              )}<span class="path">${esc(doc.path)}</span></span></a>`
          )
          .join('')}</div>`
      );
    }

    // Only when something is actually waiting on this answer. A question that
    // blocks nothing draws as a single lonely node, which is worse than no link.
    if (q.dependentCount) {
      parts.push(
        `<div class="docs"><a class="graph-link" href="${esc(graphUrl(q))}" target="_blank" rel="noopener noreferrer">
          <span>What this is blocking<span class="path">${q.dependentCount} issue${
            q.dependentCount === 1 ? '' : 's'
          } · dependency graph</span></span>
        </a></div>`
      );
    }

    if (d?.links?.length) {
      parts.push(
        `<div class="links">${d.links
          .map((l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener noreferrer">${esc(l.label)}</a>`)
          .join('')}</div>`
      );
    }

    for (const s of q.sections || []) {
      if (s.field !== 'description') parts.push(`<div class="section-label">${esc(s.field)}</div>`);
      parts.push(`<div class="md">${renderMarkdown(s.markdown, FROM_BD)}</div>`);
    }

    // The same agent state as the card head, repeated at the END of the thread.
    // The banner is correct but it's above a long brief, so after typing a comment
    // you're at the bottom and never see it — which reads as nothing happening.
    const working = pendingActivity(q);

    if (q.comments?.length || working) {
      parts.push('<div class="section-label">Thread</div>');
      parts.push(
        `<div class="comments">${(q.comments || []).map(commentHtml).join('')}${
          working ? pendingHtml(working) : ''
        }</div>`
      );
    }

    parts.push(`<div class="agents">${agentsHtml()}</div>`);

    parts.push(`<div class="freeform">
      <textarea data-role="answer" placeholder="Answer in your own words…" rows="3">${esc(getDraft(q.key))}</textarea>
      <div class="row">
        <button class="primary" data-act="answer" data-key="${esc(q.key)}">Answer &amp; close</button>
        <button class="secondary" data-act="note" data-key="${esc(q.key)}">Comment only</button>
      </div>
    </div>`);

    parts.push(cardFootHtml(q));

    // A second way out, at the end of the brief — under the one in the top corner,
    // which after a long brief with diagrams and a thread is several screens above
    // you. Both sit hard right, so collapsing is the same corner either way.
    parts.push(`<div class="collapse-row">
      <button class="collapse" data-act="collapse" data-key="${esc(q.key)}">↑ Collapse</button>
    </div>`);

    return parts.join('');
  }

  /**
   * An empty list has to say which empty it is.
   *
   * The old text — "no open questions labelled human" — was true and still read as a
   * broken app, because a space could be showing 0 while fifty-four beads were open
   * in it. So when the scope is the narrow one, the empty state names the way out.
   */
  const gearNudge = () => (state.scope === 'human' ? ' Tap ⚙ to include the work agents are on.' : '');

  function emptyHtml() {
    // "Nothing to decide" printed directly under a pane saying an agent is asking to
    // be changed is the app contradicting itself. The empty state is about the
    // questions feed, so when the other channel has something in it, say which
    // emptiness this is.
    if ((state.requests || []).length) {
      return `<div class="empty">Nothing about work is waiting.${gearNudge()}</div>`;
    }
    if (state.scope === 'agent') {
      return `<div class="empty"><strong>Nothing live</strong>No open, claimed or blocked beads in any workspace.</div>`;
    }
    if (state.scope === 'both') {
      return `<div class="empty"><strong>Nothing live</strong>No questions, and no bead open anywhere.</div>`;
    }
    return `<div class="empty"><strong>Nothing to decide</strong>No open questions labelled <code>human</code>.${gearNudge()}</div>`;
  }

  /**
   * The foundation channel: agents asking to change what they are.
   *
   * A pane of its own, above the list and outside every filter on it. The reasoning,
   * because it looks like a styling choice and is not:
   *
   * - **It is not filtered by space or workspace.** Those answer "which of my lives
   *   is this about", and an agent's definition is not in one of them — it is the
   *   same console whichever repo it was working in when it hit the wall.
   * - **It is not sorted with the questions, or counted with them.** A P0 question
   *   is urgent; a request to change what an agent is is *pending*, indefinitely, and
   *   letting the two compete for the top of the screen would mean either the urgent
   *   thing sinks or the constitutional one is never seen.
   * - **It is drawn inside `#list` all the same**, as its own section. Every handler
   *   on this page is delegated from that element, so a card in a sibling container
   *   would render perfectly and answer nothing.
   *
   * Cards are `cardHtml` unchanged — the request is answered exactly the way a
   * question is, and a second card renderer would be a second place for the approve
   * path to drift.
   */
  function requestsHtml() {
    const rows = state.requests || [];
    if (!rows.length) return '';
    const many = rows.length > 1;
    return `<section class="channel foundation-channel" aria-label="Foundation requests">
      <header class="channel-head">
        <span class="channel-icon" aria-hidden="true">⚖️</span>
        <div>
          <h2>${many ? `${rows.length} agents are` : 'An agent is'} asking to change what ${many ? 'they are' : 'it is'}</h2>
          <p>Not a question about work. Approving writes one commit and re-seeds the agent.</p>
        </div>
      </header>
      ${rows.map(cardHtml).join('')}
    </section>`;
  }

  /** How many requests are waiting, on the ⚖️ in the header. */
  function paintRequestBadge() {
    const badge = $('#req-badge');
    if (!badge) return;
    const n = (state.requests || []).length;
    badge.textContent = n > 9 ? '9+' : String(n);
    badge.hidden = !n;
  }

  /**
   * The three counts in the chrome: what is waiting on you, and what is waiting
   * elsewhere.
   *
   * Where each one goes is the whole argument. "Waiting on you" is the app's
   * premise and has no icon of its own, so it takes the space the wordmark used
   * to; the other two already have a tab apiece, so they become badges on those
   * tabs rather than a second row of chips — the number and the way to act on it
   * end up the same tap target.
   *
   * The waiting number is counted off the rows on screen whenever this scope
   * actually swept them, so answering a question drops it on the tap rather than
   * on the next poll. The `agent` scope sweeps no questions at all, and there the
   * server's held count is the only honest answer — a zero would read as "nothing
   * is asking you anything" when the truth is "you did not ask".
   */
  function paintSummary() {
    const s = state.summary || {};
    const swept = state.scope !== 'agent';
    const held = Number(s.questions);
    const waiting = swept || !Number.isFinite(held) ? state.questions.filter((q) => !q.agent).length : held;

    const el = $('#waiting');
    if (el) {
      el.hidden = !waiting;
      // The word is a separate element so a narrow phone can drop it and keep the
      // number — see .waiting in style.css.
      el.innerHTML = `${waiting}<span class="word">waiting</span>`;
      el.setAttribute(
        'aria-label',
        `${waiting} bead${waiting === 1 ? '' : 's'} waiting on you${state.scope === 'human' ? '' : ' — show only these'}`
      );
    }

    // Both tabs live at the foot of every page, but only this one has the numbers:
    // they ride the inbox's poll. A page that never sets a badge shows none, which
    // is better than a number it has no way to refresh.
    const badge = window.beadcause?.tabBadge;
    if (!badge) return;
    const sessions = Number(s.sessions) || 0;
    const proposals = Number(s.proposals) || 0;
    badge('sessions', sessions, `Sessions — ${sessions} agent${sessions === 1 ? '' : 's'} running`);
    badge('advocates', proposals, `Advocates — ${proposals} proposal${proposals === 1 ? '' : 's'} waiting`);
  }

  /** Repaint the armed option in place. Cheap, and never touches the textarea. */
  function paintArmed() {
    for (const btn of listEl.querySelectorAll('.option')) {
      const armed = state.armed === `${btn.dataset.key}|${btn.dataset.opt}`;
      btn.classList.toggle('confirm', armed);
      const label = btn.querySelector('.label');
      if (label) label.textContent = (armed ? 'Tap again to confirm · ' : '') + btn.dataset.label;
    }
  }

  /**
   * Turn the unsent-draft mark on or off in place.
   *
   * Same rule as paintArmed(): a draft changes on every keystroke, and going through
   * render() to show it would rebuild the list under the textarea the keystroke went
   * into. The mark is an inset shadow rather than a border for the same reason —
   * toggling it reflows nothing, so the line you are typing on does not move.
   */
  function paintDraftMark(key) {
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    card?.classList.toggle('has-draft', Boolean(getDraft(key)));
  }

  /** Which space a question belongs to. Unassigned workspaces collect under "Other". */
  const spaceOf = (q) => q.space || 'Other';

  /**
   * The filter rows: spaces on top, workspaces below.
   *
   * A muted space still shows its count — the whole design is that a quiet space is
   * quiet, not hidden. The bell tells you why nothing buzzed, so silence never looks
   * like a bug.
   */
  function renderFilters(inSpace) {
    const spaces = state.spaces || [];
    const showSpaces = spaces.length >= 2;
    const names = [...new Set(inSpace.map((q) => q.workspace))].sort();
    const showWorkspaces = names.length >= 2;

    filtersEl.hidden = !showSpaces && !showWorkspaces;
    if (filtersEl.hidden) return;

    const rows = [];

    if (showSpaces) {
      const total = state.questions.length;
      rows.push(
        `<div class="chip-row spaces">` +
          `<button class="chip" data-space="all" aria-pressed="${state.space === 'all'}">All ${total}</button>` +
          spaces
            .map(
              (s) =>
                `<button class="chip${s.quiet ? ' quiet' : ''}" data-space="${esc(s.name)}" aria-pressed="${
                  state.space === s.name
                }" title="${s.quiet ? 'Muted right now — arrives without notifying' : ''}">${esc(s.name)} ${s.count}${
                  s.quiet ? ' <span class="bell">🔕</span>' : ''
                }</button>`
            )
            .join('') +
          `</div>`
      );
    }

    if (showWorkspaces) {
      const counts = (ws) => inSpace.filter((q) => q.workspace === ws).length;
      rows.push(
        `<div class="chip-row">` +
          `<button class="chip" data-ws="all" aria-pressed="${state.workspace === 'all'}">All ${inSpace.length}</button>` +
          names
            .map(
              (ws) =>
                `<button class="chip" data-ws="${esc(ws)}" aria-pressed="${state.workspace === ws}">${esc(ws)} ${counts(
                  ws
                )}</button>`
            )
            .join('') +
          `</div>`
      );
    }

    filtersEl.innerHTML = rows.join('');
  }

  let pendingRender = false;

  /**
   * Rebuilding the list destroys every textarea in it, drops focus, closes the
   * keyboard and resets scroll — so an answer being written looks like it was
   * thrown away. While a card is being answered, defer instead; the flush
   * happens on blur, or when the answer is submitted.
   */
  /**
   * Tail the agent's log into the open panes.
   *
   * Written straight into the `<pre>` rather than through render(): a repaint would
   * scroll the pane back to the top every two seconds, and the list around it does
   * not change just because an agent typed another line.
   */
  async function pollLogs(only = null) {
    const keys = only ? [only] : [...state.logs];
    for (const key of keys) {
      if (!state.logs.has(key)) continue;
      const [workspace, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
      try {
        const data = await api(`/api/agent-log?workspace=${encodeURIComponent(workspace)}&id=${encodeURIComponent(id)}`);
        const text = (data.lines || []).join('\n') || 'No output yet — the agent is starting.';
        state.logText.set(key, text);
        const pre = listEl.querySelector(`[data-log="${CSS.escape(key)}"]`);
        if (pre) {
          const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
          pre.textContent = text;
          // Follow the tail only if you were already at the bottom, so scrolling
          // back to read something isn't yanked away by the next line.
          if (atBottom) pre.scrollTop = pre.scrollHeight;
        }
      } catch {
        /* the next tick tries again */
      }
    }
  }

  // One timer for every open pane. It costs a file read per pane per two seconds,
  // and only ever runs while at least one is open.
  setInterval(() => {
    if (state.logs.size) pollLogs();
  }, 2000);

  /* ----------------------------------------------------- keeping your place */

  /**
   * Where the reader was, stored as "this element, this far down the screen"
   * rather than as a scroll offset — and applied to the element that actually
   * scrolls, which is usually not the window.
   *
   * An open card is `position: fixed; inset: 0; overflow-y: auto` (see .card.open):
   * it takes the whole screen and scrolls its own contents, so `window.scrollY` is
   * 0 the entire time a brief is being read. Rebuilding the list with innerHTML
   * throws that card away and builds a new one at scrollTop 0 — which is the jump
   * back to the top of the card, and why putting `window.scrollY` back never helped a
   * reader with a brief open: it was restoring a number that was zero all along.
   *
   * The offset alone is still not enough. mermaid renders asynchronously, so at the
   * moment the position is put back every diagram is an empty placeholder and the
   * card is at its shortest; the offset is clamped to the short content, the
   * diagrams then draw and push everything down, and the reader ends up above where
   * they were. So an element is stored too — the card by its key, then the way down
   * into it by child index — and re-measured each time the layout changes.
   */
  const ANCHOR_SLOP = 8;
  // Redrawn or rewritten wholesale, so never anchor *inside* one: a mermaid
  // placeholder holds a fresh SVG after every repaint, and a log pane is replaced
  // line by line.
  const OPAQUE = '.diagram, svg, pre';
  const docScroller = () => document.scrollingElement || document.documentElement;
  let placeGen = 0;

  /** Something deliberate is moving the page. Stop putting it back. */
  const releasePlace = () => {
    placeGen++;
  };
  // A thumb, a wheel or an arrow key is the reader deciding where to be, and it
  // ends any restore still waiting on a late diagram. Deliberate scrolls in code
  // call releasePlace() themselves. `scroll` is deliberately not in this list —
  // the restore scrolls, and would cancel itself.
  for (const ev of ['wheel', 'touchmove', 'keydown']) {
    addEventListener(ev, releasePlace, { passive: true });
  }

  /**
   * Does this element scroll its own contents? An open card does — it is fixed to
   * the screen with `overflow-y: auto` — and asking rather than assuming is what
   * keeps this honest if the card ever lays out inline on a wider screen.
   */
  const scrolls = (el) =>
    el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);

  function capturePlace() {
    const place = {
      gen: ++placeGen,
      docTop: docScroller().scrollTop,
      key: null,
      self: false,
      scrollTop: 0,
      top: 0,
      path: [],
      focus: null,
    };

    // An open card is the whole screen, so it is the only thing worth anchoring to
    // while one is up. Otherwise: the card that owns the top of the list — the last
    // one starting at or above it, since anything below moves when a height above it
    // changes. Above the first card, the first card is the best there is.
    let anchor = [...listEl.querySelectorAll('.card.open')].pop() || null;
    if (!anchor) {
      for (const card of listEl.querySelectorAll('.card[data-key]')) {
        const top = card.getBoundingClientRect().top;
        if (top <= ANCHOR_SLOP || !anchor) anchor = card;
        if (top > ANCHOR_SLOP) break;
      }
    }
    if (!anchor) return place;

    // Decided here rather than at restore time: straight after the rebuild the card
    // is at its shortest, so it may not look like a scroller even though it is one,
    // and mistaking it for the page would write a card offset onto the document.
    place.self = scrolls(anchor);
    const scroller = place.self ? anchor : docScroller();
    place.key = anchor.dataset.key;
    place.scrollTop = scroller.scrollTop;
    place.top = anchor.getBoundingClientRect().top;

    // Then down into it, by child index, to the deepest thing still starting above
    // the fold. The card alone is not a fine enough anchor for a long brief: a
    // diagram inside it and above where you are reading grows after the repaint,
    // and everything under it — the paragraph you were on included — slides down by
    // that diagram's height while the card's own top never moves.
    const fold = (place.self ? place.top : 0) + ANCHOR_SLOP;
    let node = anchor;
    while (!node.matches(OPAQUE)) {
      const kids = node.children;
      let step = null;
      for (let i = kids.length - 1; i >= 0; i--) {
        const r = kids[i].getBoundingClientRect();
        if (r.height && r.top <= fold) {
          step = { index: i, top: r.top };
          break;
        }
      }
      if (!step) break;
      place.path.push(step);
      node = kids[step.index];
    }

    const box = document.activeElement;
    if (box?.matches?.('[data-role="answer"]')) {
      place.focus = {
        key: box.closest('.card')?.dataset.key,
        start: box.selectionStart,
        end: box.selectionEnd,
        scrollTop: box.scrollTop,
      };
    }
    return place;
  }

  function restorePlace(place) {
    if (place.gen !== placeGen) return;
    // The list behind an open card scrolls too, and it is what you come back to
    // when the card is collapsed.
    docScroller().scrollTop = place.docTop;
    if (!place.key) return;
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(place.key)}"]`);
    // The anchor card is gone — answered, or filtered away. The page offset above
    // is all that is left to go on.
    if (!card) return;

    const scroller = place.self ? card : docScroller();
    // Absolute, not incremental: every call starts from the recorded offset and
    // then corrects, so running again after the diagrams land refines the answer
    // instead of compounding the last one.
    scroller.scrollTop = place.scrollTop;

    // As deep as the rebuilt card still goes. A step that no longer resolves means
    // that part of the brief has not been laid out yet, and its parent is the best
    // anchor available until it has — which is exactly why this runs again once the
    // diagrams are drawn.
    let node = card;
    let top = place.top;
    for (const step of place.path) {
      const kid = node.children[step.index];
      if (!kid) break;
      node = kid;
      top = step.top;
    }
    const delta = node.getBoundingClientRect().top - top;
    if (Math.abs(delta) > 1) scroller.scrollTop += delta;
  }

  /**
   * Put the caret back where it was.
   *
   * This cannot promise the soft keyboard: a textarea removed from the document is
   * blurred, and refocusing outside a touch gesture does not always raise the
   * keyboard again. That is why a repaint is still deferred whenever it can be
   * (see isAnswering) — this is what makes the repaints that *cannot* be deferred,
   * like the one after a comment is filed, survivable rather than destructive.
   */
  function restoreFocus(f) {
    if (!f.key) return;
    const box = listEl.querySelector(`.card[data-key="${CSS.escape(f.key)}"] [data-role="answer"]`);
    if (!box || box === document.activeElement) return;
    // preventScroll: where the card sits is restorePlace's decision, and focus
    // scrolling the box into view would fight it.
    box.focus({ preventScroll: true });
    try {
      box.setSelectionRange(f.start, f.end);
    } catch {
      /* the draft came back shorter than the selection did */
    }
    box.scrollTop = f.scrollTop;
  }

  /**
   * Restore now, then keep restoring as the late layout lands: the next frame, each
   * image as it decodes, and the diagrams — mermaid renders asynchronously, so a
   * brief with a diagram in it resizes well after the repaint that contained it.
   */
  function settlePlace(place, drawn) {
    if (place.focus) restoreFocus(place.focus);
    restorePlace(place);
    requestAnimationFrame(() => restorePlace(place));
    for (const img of listEl.querySelectorAll('img')) {
      if (!img.complete) img.addEventListener('load', () => restorePlace(place), { once: true });
    }
    drawn.then(() => restorePlace(place)).catch(() => {});
  }

  function render(force = false) {
    if (!force && isAnswering()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    const place = capturePlace();

    // Two levels of filter: space (work vs personal), then workspace within it.
    // With no spaces configured the first level is skipped entirely and this
    // behaves exactly as it did before.
    const inSpace =
      state.space === 'all'
        ? state.questions
        : state.questions.filter((q) => spaceOf(q) === state.space);
    const visible =
      state.workspace === 'all' ? inSpace : inSpace.filter((q) => q.workspace === state.workspace);

    // The other channel, always first and never filtered. It is rare enough that
    // putting it at the top costs nothing on the days there is nothing in it, and on
    // the day there is, it is the one thing that must not be scrolled past.
    const channel = requestsHtml();

    if (!state.questions.length) {
      listEl.innerHTML = channel + emptyHtml();
    } else if (!visible.length) {
      const where = state.workspace !== 'all' ? state.workspace : state.space !== 'all' ? state.space : '';
      listEl.innerHTML =
        channel + `<div class="empty">Nothing waiting${where ? ` in ${esc(where)}` : ''}.${gearNudge()}</div>`;
    } else {
      // Anything you've already replied to sinks to the bottom. It is not waiting on
      // you any more — an agent has it — so it must not sit between you and the
      // questions that are. Order within each group is left exactly as the server
      // sent it (priority, then age).
      const waiting = visible.filter((q) => !q.awaitingAgent);
      const replied = visible.filter((q) => q.awaitingAgent);
      listEl.innerHTML = channel + [...waiting, ...replied].map(cardHtml).join('');
    }

    paintRequestBadge();
    paintSummary();
    renderFilters(inSpace);

    openLinksInNewTab(listEl);
    // Puts the caret and the scroll position back — immediately, and again as the
    // diagrams and images size themselves afterwards.
    settlePlace(place, drawDiagrams(listEl));
    // The list it describes has just been replaced, so its counts are stale — but a
    // 25s poll must not make it flash on screen at someone who isn't scrolling.
    paintScrollPos(false);
    publishView(visible);
  }

  /**
   * Tell the daemon which card is up, so the monitor can show it in full.
   *
   * Called from render() rather than from each place that opens or closes a card:
   * every one of those ends in a render, and presence.js drops a report identical to
   * the last one, so the cheap call in one place beats six correct ones.
   *
   * `state.open` holds at most one key — openOnly() is what keeps that true — so its
   * last entry is the card being read. Written as a pop() off the Set rather than an
   * assumption about its size, because load() rebuilds the Set by filtering and a
   * cheap read costs nothing next to a wrong report.
   */
  function publishView(visible) {
    const p = window.beadcause?.presence;
    if (!p) return;
    const q = byKey([...state.open].pop() || '');
    p.report({
      view: q ? 'card' : 'inbox',
      workspace: q ? q.workspace : state.workspace === 'all' ? '' : state.workspace,
      id: q?.id || '',
      key: q?.key || '',
      scope: state.scope,
      space: state.space,
      detail: q ? q.title : `${visible.length} waiting`,
    });
  }

  /* ------------------------------------------ where you are in the list */

  const scrollPosEl = $('#scrollpos');
  const topbarEl = $('.topbar');
  let scrollPosTimer = null;
  let scrollPosFrame = 0;

  /**
   * Paint the scroll position indicator: which card the top of the screen is on, out
   * of how many the current filters left in the list.
   *
   * Counted off the DOM rather than off state.questions, so it describes exactly what
   * you can see — the space and workspace chips have already been applied by the time
   * the cards exist, and an open card is excluded because it is a fixed full-screen
   * layer with a scroll position of its own.
   *
   * `reveal` is what separates a scroll from a repaint. Scrolling fades it in and
   * restarts the 1.6s fade-out; a render() only refreshes the numbers, so a background
   * poll landing while you read can't flash a pill at you.
   */
  function paintScrollPos(reveal = true) {
    if (!scrollPosEl) return;
    const cards = [...listEl.querySelectorAll('.card:not(.open)')];
    // Nothing to place yourself within: a single card, an empty list, or a card open
    // over the top of it.
    if (cards.length < 2 || listEl.querySelector('.card.open')) {
      scrollPosEl.hidden = true;
      scrollPosEl.classList.remove('on');
      clearTimeout(scrollPosTimer);
      return;
    }

    // Reading starts under whatever is covering the top of the viewport, not at the
    // top of it. The topbar is sticky so it always is; the filter chips only are
    // while you are near the top of the list, and once they have scrolled away their
    // bottom edge is a long way above the screen — taking it unconditionally put
    // every card below the line and pinned the count at "1 of 9".
    const top = Math.max(
      topbarEl.getBoundingClientRect().bottom,
      filtersEl.hidden ? 0 : filtersEl.getBoundingClientRect().bottom
    );
    // The first card still showing below that line is the one you are on; the 4px is
    // slack so a card whose last pixel is under the bar doesn't count as current.
    let idx = cards.findIndex((c) => c.getBoundingClientRect().bottom > top + 4);
    if (idx < 0) idx = cards.length - 1; // scrolled past the end of the list

    if (!scrollPosEl.firstChild) {
      scrollPosEl.innerHTML =
        '<span><span class="n"></span> of <span class="total"></span></span><span class="rail"><i></i></span>';
    }
    scrollPosEl.querySelector('.n').textContent = String(idx + 1);
    scrollPosEl.querySelector('.total').textContent = String(cards.length);
    // The thumb is sized by how much of the list is on screen and placed by how far
    // down it you are, so its gaps above and below read as the cards above and below.
    const bar = scrollPosEl.querySelector('.rail i');
    const height = Math.max(100 / cards.length, 12);
    bar.style.height = `${height}%`;
    bar.style.top = `${Math.min((100 * idx) / cards.length, 100 - height)}%`;

    scrollPosEl.hidden = false;
    if (!reveal) return;
    scrollPosEl.classList.add('on');
    clearTimeout(scrollPosTimer);
    scrollPosTimer = setTimeout(() => scrollPosEl.classList.remove('on'), 1600);
  }

  // One paint per frame at most. Scroll fires far faster than the screen redraws, and
  // every paint here reads geometry back out of the layout.
  addEventListener(
    'scroll',
    () => {
      if (scrollPosFrame) return;
      scrollPosFrame = requestAnimationFrame(() => {
        scrollPosFrame = 0;
        paintScrollPos();
      });
    },
    { passive: true }
  );

  /* --------------------------------------------------------------- actions */

  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', bad);
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), bad ? 5000 : 2600);
  }

  /**
   * A card by key, from either channel.
   *
   * Every interaction on this page — open, answer, comment, the ⋮ menu, the deep
   * link from a notification — goes through here, which is why the two channels can
   * be two arrays without two of everything else. Requests first: there are at most
   * a handful, and it makes the lookup that matters the cheap one.
   */
  const byKey = (key) =>
    (state.requests || []).find((q) => q.key === key) || state.questions.find((q) => q.key === key);

  function disarm() {
    state.armed = null;
    clearTimeout(state.armedTimer);
  }

  /**
   * Send an answer or a comment, and show it becoming a bead while it goes.
   *
   * The write is the slow part — `bd` can spend a second or three retrying against
   * the Dolt lock — and what used to happen over that second was nothing: the card
   * dimmed, a "Recording your answer…" row appeared, and then the list jump-cut to
   * one without it. So the order here is deliberately optimistic:
   *
   *   1. start the flight, off the card's geometry, *before* anything is sent
   *   2. take the card out of the list and repaint, so the list has already reflowed
   *      behind the bead by the time the bead exists
   *   3. issue the write, and let the flight cover the round trip
   *   4. absorb on success, recall on failure
   *
   * Which means every piece of state the card was built from has to be recoverable,
   * because step 4 can be "put it back". That is what `at`/`rAt`/`wasOpen` are for,
   * and it is why clearDraft() still happens only once the server has accepted: the
   * restored card is rebuilt from the draft, so a draft cleared optimistically would
   * be an answer this function had thrown away.
   *
   * `onRestore` is for state submit() cannot see — the proposal's per-bead picks are
   * cleared by the caller before it gets here, and a card that came back with every
   * decision wiped would be a worse outcome than the failed write.
   */
  async function submit(key, text, { close, create = null, onRestore = null }) {
    const q = byKey(key);
    if (!q) return;
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);

    // Where it was in each channel, so a rejected write puts it back where it was
    // rather than at the end of a list you were part-way down.
    const at = state.questions.indexOf(q);
    const rAt = (state.requests || []).indexOf(q);
    const wasOpen = state.open.has(key);

    // Fired on the tap. An answer closes its bead, so its flight ends in the mark;
    // a comment does not, and absorbing a bead that is still open would be a lie —
    // so that one flies to the row it is about to come back to, and settles there.
    const flight = window.beadcause?.absorb?.launch({
      from: card,
      made: close && create ? create.length : 0,
      tone: close ? 'answer' : 'comment',
      target: close ? null : () => listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`),
    });

    // The card goes now, either out of the list entirely or just closed. Everything
    // the flight needs was measured above; from here on it is drawing over a list
    // that no longer contains what it came out of.
    state.open.delete(key);
    if (close) {
      state.inFlight.add(key);
      if (at >= 0) state.questions.splice(at, 1);
      if (rAt >= 0) state.requests.splice(rAt, 1);
    }
    // Forced: for a comment the answered card's textarea is still in the DOM holding
    // text, so a deferred render would never fire and the card would linger open.
    render(true);

    const restoreCard = () => {
      state.inFlight.delete(key);
      if (at >= 0 && !state.questions.includes(q)) {
        state.questions.splice(Math.min(at, state.questions.length), 0, q);
      }
      if (rAt >= 0 && !(state.requests || []).includes(q)) {
        state.requests.splice(Math.min(rAt, state.requests.length), 0, q);
      }
      if (wasOpen) openOnly(key);
      onRestore?.();
      render(true);
    };

    try {
      const res = await api(close ? '/api/respond' : '/api/comment', {
        method: 'POST',
        body: JSON.stringify(
          close
            ? {
                workspace: q.workspace,
                id: q.id,
                response: text,
                // Explicit, rather than leaving the server to read the numbers back
                // out of the sentence: the text is for you, the array is for it.
                ...(create ? { create } : {}),
              }
            : // Which agent picks this up. Absent or unknown resolves to the
              // default server-side, so an old phone still gets an answer.
              { workspace: q.workspace, id: q.id, text, agent: state.agent || undefined }
        ),
      });
      clearDraft(key);
      if (close) {
        // The card left the list on the tap; this is only the belt to that braces —
        // a poll that landed mid-write could have merged it back in, and the suppress
        // set comes off in the same breath.
        state.inFlight.delete(key);
        state.questions = state.questions.filter((x) => x.key !== key);
        // And out of the other channel, on the same tap. An answered request that
        // stayed in the pane would still be showing its approve button — for a bead
        // that has already been closed on the answer you just gave.
        state.requests = (state.requests || []).filter((x) => x.key !== key);
        state.open.delete(key);
        // Inside the Android shell, drop the notification for this question now.
        // Otherwise it sits in the shade with buttons that would answer a bead that
        // is already closed.
        window.BeadcauseNative?.answered?.(key);
        toast(`Answered ${q.id}`);
        render(true);
        // The tracker took it, so it may be swallowed. Awaited rather than fired and
        // forgotten so a caller that answers two questions in a row cannot have the
        // second flight start on top of the first one's.
        await flight?.absorb();
      } else {
        toast(res?.elevated ? 'Comment added — running with tools, this once' : 'Comment added — an agent will be told');
        // The server has spent the arm on this dispatch, so the box must come back
        // off. Re-read rather than assume: if the dispatch was refused the arm is
        // still there, and a tick that lied either way would be the worst outcome.
        loadAgents();
        // Reflect the awaiting-agent flag the server just set, without waiting
        // for the next poll.
        q.awaitingAgent = true;
        // Collapsed on the tap already. You have said your piece; keeping the card
        // open in front of you implies there is something left for you to do with it,
        // when the next move belongs to the agent. It comes back up when it replies.
        clearDraft(key);
        render(true);
        // Not absorbed: this bead is still open, and the mark eating it would say it
        // had been dealt with. It settles onto the row it just came back to.
        await flight?.land();
      }
    } catch (err) {
      toast(err.message, true);
      // Reverse the travel first, then re-open the card underneath where the beads
      // came down. A tracker that refused the answer must not be shown swallowing it.
      await flight?.recall();
      restoreCard();
    }
  }

  /**
   * Pull the full record (comments included) the first time a card is opened.
   *
   * Two endpoints, because the two kinds of bead are not the same thing.
   * `/api/question` parses the decision block and is only meaningful for a `human`
   * bead; an agent bead is an ordinary issue, so it comes through `/api/bead` — the
   * same endpoint the graph's detail sheet uses. Fields are copied across by name
   * rather than with a bare Object.assign, so the list's own `agent` flag and the
   * slimmed-down shape it was built from survive the merge.
   */
  async function expand(key, force = false) {
    const q = byKey(key);
    if (!q) return;
    const ws = encodeURIComponent(q.workspace);
    const id = encodeURIComponent(q.id);
    if (q.agent) {
      // `undefined` means never fetched; `''` means fetched and genuinely empty.
      if (force || q.description === undefined) {
        try {
          const full = await api(`/api/bead?workspace=${ws}&id=${id}`);
          q.description = full.description || '';
          q.notes = full.notes || '';
          q.comments = full.comments || [];
        } catch {
          q.description = q.description || '';
          q.comments = q.comments || [];
        }
      }
    } else if (force || !q.comments) {
      try {
        Object.assign(q, await api(`/api/question?workspace=${ws}&id=${id}`));
      } catch {
        q.comments = q.comments || [];
      }
    }
    openOnly(key);
    render(true);
  }

  /**
   * Expand one card and collapse whatever was expanded before it — the accordion.
   *
   * `state.open` stays a Set because the rest of the file reads it with .has() and
   * .delete(), and because load() rebuilds it by filtering; what changes is that
   * nothing ever puts a second key in it. Two reasons it has to be one:
   *
   * • `.card.open` is a fixed full-screen layer (style.css), so a second open card
   *   simply stacks on the first. Closing it revealed a brief you had already
   *   finished with instead of the list — reachable today by tapping a notification
   *   while a card is open, which deep-links straight into expand().
   * • Left to accumulate, the list grows past the point where you can find your
   *   place scrolling through it, which is the other half of this bead.
   *
   * A card being collapsed may be holding an unsent draft. That is allowed and is
   * never suppressed — the draft survives in localStorage, the card comes back
   * marked incomplete (see .card.has-draft), and its toggle reads "Resume your
   * answer". Deleted in place rather than by reassigning the Set, because load()
   * captures `state.open` by reference while a request is in flight.
   */
  function openOnly(key) {
    for (const k of [...state.open]) if (k !== key) state.open.delete(k);
    state.open.add(key);
  }

  /**
   * Shut the ⋮ menu without a render().
   *
   * The menu can be open over a half-typed answer — that is the whole reason
   * `discuss` never re-renders — so opening and closing it is DOM surgery on the
   * one popover, not a rebuild of the list. `state.menu` still exists so that a
   * refresh landing while the menu is open paints it back.
   */
  function closeMenu() {
    state.menu = null;
    for (const m of listEl.querySelectorAll('.menu')) m.remove();
    for (const k of listEl.querySelectorAll('.kebab.on')) {
      k.classList.remove('on');
      k.setAttribute('aria-expanded', 'false');
    }
  }

  // A tap anywhere that isn't the menu or its button dismisses it. This runs after
  // the list's own handler below, so opening the menu doesn't immediately close it.
  document.addEventListener('click', (ev) => {
    if (state.menu && !ev.target.closest('.menu-wrap')) closeMenu();
  });

  listEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const key = btn.dataset.key;
    const act = btn.dataset.act;

    if (act === 'menu') {
      const wasOpen = state.menu === key;
      closeMenu();
      if (wasOpen) return;
      state.menu = key;
      btn.classList.add('on');
      btn.setAttribute('aria-expanded', 'true');
      btn.parentElement.insertAdjacentHTML('beforeend', menuHtml(key));
      return;
    }

    if (act === 'toggle') {
      closeMenu();
      disarm();
      paintArmed();
      if (state.open.has(key)) {
        state.open.delete(key);
        render(true); // explicit user action
      } else {
        await expand(key);
      }
      return;
    }

    // Same as the head toggle, but it also puts you back on the card. Collapsing
    // from the foot of a tall brief otherwise removes several screens of content
    // from above you and leaves the scroll position pointing at whatever card
    // happens to have slid up into it.
    if (act === 'collapse') {
      closeMenu();
      disarm();
      paintArmed();
      state.open.delete(key);
      render(true);
      // This scroll is the point of the button, so it outranks the repaint's own
      // restore — which would otherwise pull the page back as the diagrams land.
      releasePlace();
      listEl
        .querySelector(`.card[data-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }

    if (act === 'agent') {
      state.agent = btn.dataset.agent;
      localStorage.setItem('beadcause.agent', state.agent);
      state.agentForm = false;
      paintAgents();
      return;
    }

    if (act === 'allow-tools') {
      const id = btn.dataset.agent;
      // The box is painted from the server's answer, never from the tap: an arm that
      // was refused must not leave a tick behind suggesting it was granted.
      const wanted = btn.checked;
      btn.checked = !wanted;
      try {
        const send = (extra = {}) =>
          api('/api/agent-arm', { method: 'POST', body: JSON.stringify({ id, ...extra }) });
        if (!wanted) {
          state.agents = (await send({ disarm: true })).agents || state.agents;
        } else {
          let data;
          try {
            data = await send();
          } catch (err) {
            if (!err.body?.needsAcknowledgement) throw err;
            if (!(await confirmTools(err.body.disclaimer))) return paintAgents();
            data = await send({ acknowledge: true });
          }
          state.agents = data.agents || state.agents;
          toast('Allowed for this comment only');
        }
      } catch (err) {
        toast(err.message, true);
      }
      paintAgents();
      return;
    }

    if (act === 'agent-new' || act === 'agent-cancel') {
      state.agentForm = act === 'agent-new';
      paintAgents();
      // Focus after the repaint, or there is nothing yet to focus.
      if (state.agentForm) listEl.querySelector('[data-role="agent-name"]')?.focus();
      return;
    }

    if (act === 'agent-create') {
      const block = btn.closest('.agents');
      const name = block?.querySelector('[data-role="agent-name"]')?.value.trim() || '';
      const description = block?.querySelector('[data-role="agent-desc"]')?.value.trim() || '';
      if (!name) return toast('Give it a name', true);
      if (description.length < 20) return toast('Give it a foundation — a sentence or two', true);
      btn.disabled = true;
      try {
        const data = await api('/api/agents', { method: 'POST', body: JSON.stringify({ name, description }) });
        state.agents = data.agents || state.agents;
        state.agent = data.agent.id;
        localStorage.setItem('beadcause.agent', state.agent);
        state.agentForm = false;
        paintAgents();
        toast(`${data.agent.name} is ready`);
      } catch (err) {
        btn.disabled = false;
        toast(err.message, true);
      }
      return;
    }

    // Unfolds one row, by touching that row only. Emphatically not a render(), for
    // the same reason paintPicks exists: rebuilding the card under a decision you
    // are halfway through making loses the decision.
    if (act === 'prop-more') {
      const row = btn.closest('.prop-row');
      const token = `${key}|${btn.dataset.idx}`;
      const open = !state.propOpen.has(token);
      if (open) state.propOpen.add(token);
      else state.propOpen.delete(token);
      row?.classList.toggle('is-collapsed', !open);
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? 'Show less' : 'Show the rest';
      return;
    }

    if (act === 'pick') {
      const n = Number(btn.dataset.idx);
      const picks = picksFor(key);
      // Tapping the choice you already made clears it — undecided is a real state,
      // and there has to be a way back to it.
      if (picks.get(n) === btn.dataset.pick) picks.delete(n);
      else picks.set(n, btn.dataset.pick);
      disarm();
      paintPicks(key);
      return;
    }

    if (act === 'pick-all') {
      const q = byKey(key);
      const picks = picksFor(key);
      (q?.proposal?.beads || []).forEach((_, i) => picks.set(i + 1, btn.dataset.pick));
      disarm();
      paintPicks(key);
      return;
    }

    if (act === 'pick-submit') {
      const q = byKey(key);
      const beads = q?.proposal?.beads || [];
      const approved = approvedIndices(key, beads);
      const token = `${key}|proposal`;
      if (state.armed !== token) {
        // The same two taps every other answer needs. This one creates beads.
        state.armed = token;
        clearTimeout(state.armedTimer);
        state.armedTimer = setTimeout(() => {
          disarm();
          paintPicks(key);
          paintArmed();
        }, 6000);
        paintPicks(key);
        return;
      }
      disarm();
      // Kept, not just dropped: submit() can hand the card back if bd refuses the
      // write, and a proposal that came back with every yes/no wiped would cost more
      // than the failure did. See `onRestore` below.
      const hadPicks = new Map(picksFor(key));
      const hadOpen = [...state.propOpen].filter((t) => t.startsWith(`${key}|`));
      state.picks.delete(key);
      for (const t of hadOpen) state.propOpen.delete(t);
      const declined = beads.length - approved.length;
      const text = approved.length
        ? `CREATE: ${approved.join(',')} — filing ${approved.length} of ${beads.length} proposed bead${
            beads.length === 1 ? '' : 's'
          }${declined ? `, declining ${declined}` : ''}.`
        : `Not now — none of the ${beads.length} proposed beads.`;
      await submit(key, text, {
        close: true,
        create: approved.length ? approved : null,
        onRestore: () => {
          state.picks.set(key, hadPicks);
          for (const t of hadOpen) state.propOpen.add(t);
        },
      });
      return;
    }

    if (act === 'option') {
      const q = byKey(key);
      const opt = q?.decision?.options.find((o) => o.id === btn.dataset.opt);
      if (!opt) return;
      const token = `${key}|${opt.id}`;
      if (state.armed !== token) {
        // Two taps to answer — a stray tap in a pocket shouldn't close a bead.
        state.armed = token;
        clearTimeout(state.armedTimer);
        state.armedTimer = setTimeout(() => {
          disarm();
          paintArmed();
        }, 6000);
        paintArmed();
        return;
      }
      disarm();
      await submit(key, opt.response, { close: true });
      return;
    }

    // Opens iTerm2 on the Mac with `claude` already reading this bead. Writes
    // nothing here, so — unlike answering — it deliberately never calls render():
    // the card stays exactly as it is, half-typed answer and all.
    if (act === 'discuss') {
      const q = byKey(key);
      if (!q) return;
      const label = btn.innerHTML;
      btn.disabled = true;
      btn.textContent = 'Opening a session…';
      try {
        const res = await api('/api/session', {
          method: 'POST',
          body: JSON.stringify({ workspace: q.workspace, id: q.id }),
        });
        toast(`Session open in ${res.dir.split('/').pop()} — go to your Mac`);
      } catch (err) {
        toast(err.message, true);
      } finally {
        btn.disabled = false;
        btn.innerHTML = label;
        closeMenu();
      }
      return;
    }

    if (act === 'log') {
      if (state.logs.has(key)) {
        state.logs.delete(key);
        state.logText.delete(key);
      } else {
        state.logs.add(key);
        pollLogs(key);
      }
      render(true);
      return;
    }

    if (act === 'answer' || act === 'note') {
      const card = btn.closest('.card');
      const box = card.querySelector('[data-role="answer"]');
      const text = box.value.trim();
      if (!text) return toast('Write something first', true);
      await submit(key, text, { close: act === 'answer' });
      if (act === 'note') box.value = '';
    }
  });

  // Every keystroke is kept, so collapsing the card, a background refresh, or
  // the phone killing the tab can't eat a half-written answer.
  listEl.addEventListener('input', (ev) => {
    const box = ev.target.closest('[data-role="answer"]');
    if (!box) return;
    const key = box.closest('.card')?.dataset.key;
    if (!key) return;
    setDraft(key, box.value);
    // Keep the incomplete mark honest from the first character, so the card is
    // already carrying it by the time the accordion collapses it.
    paintDraftMark(key);
  });

  // Focus left an empty box: nothing is in flight, so let any deferred refresh in.
  listEl.addEventListener('focusout', (ev) => {
    if (!ev.target.matches?.('[data-role="answer"]')) return;
    if (pendingRender && !isAnswering()) render();
  });

  filtersEl.addEventListener('click', (ev) => {
    const spaceChip = ev.target.closest('[data-space]');
    if (spaceChip) {
      state.space = spaceChip.dataset.space;
      // The workspace filter belongs to the space you just left; keeping it would
      // usually leave you staring at an empty list.
      state.workspace = 'all';
      render(true);
      return;
    }
    const chip = ev.target.closest('[data-ws]');
    if (!chip) return;
    state.workspace = chip.dataset.ws;
    render(true);
  });

  /* ------------------------------------------------------------- settings */

  const scopeDlg = $('#settings-panel');

  const SCOPE_NOTE = {
    human: 'Beads labelled human — the ones asking you something. This is the inbox.',
    both: 'Questions first, then every bead that is open, claimed or blocked.',
    agent: 'Only what the agents are on: every live bead that is not a question.',
  };

  function paintScope() {
    for (const btn of scopeDlg.querySelectorAll('[data-scope]')) {
      const on = btn.dataset.scope === state.scope;
      btn.classList.toggle('on', on);
      btn.setAttribute('aria-pressed', String(on));
    }
    $('#scope-note').textContent = SCOPE_NOTE[state.scope];
    // The gear carries the state, because the scope changes what every count on the
    // screen means and the panel that set it is closed by the time you read them.
    $('#settings').classList.toggle('wide', state.scope !== 'human');
  }

  $('#settings').addEventListener('click', () => {
    paintScope();
    scopeDlg.showModal();
  });

  /**
   * Switch which slice of the tracker the list is.
   *
   * Out of the panel's click handler because the count in the top bar is the other
   * way in: tapping "3 waiting" means "show me those three", which is this, and a
   * second copy of it would be a second place for the reset-and-refetch to drift.
   * Already-there is a no-op rather than a reload — the count you tapped is a
   * count of what is already on screen.
   */
  function chooseScope(next) {
    if (!SCOPES.includes(next) || next === state.scope) return;
    state.scope = next;
    localStorage.setItem('beadcause.scope', state.scope);
    paintScope();
    // The workspace filter was almost certainly pointing at the one workspace that
    // had a question in it; keeping it would hide everything the widening just let in.
    state.workspace = 'all';
    schedulePoll();
    // Only the questions. The scope is a setting about which slice of *work* the
    // list is, and the other channel is not a slice of it — clearing the pane here
    // would blank a pending constitutional request for a couple of seconds because
    // you tapped a filter that has nothing to do with it.
    state.questions = [];
    listEl.innerHTML = requestsHtml() + '<div class="empty">Asking bd…</div>';
    load();
  }

  scopeDlg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-scope]');
    if (btn) chooseScope(btn.dataset.scope);
  });

  // The count is a filter you can reach without opening the panel: it says how many
  // beads are asking you something, so tapping it shows you exactly those.
  $('#waiting')?.addEventListener('click', () => chooseScope('human'));

  /* ----------------------------------------------------------------- load */

  let loading = false;
  let loadAgain = false;

  async function load() {
    if (!state.token) return;
    // A scope switch made while a poll is in flight must not be dropped on the
    // floor: the wider scopes take a couple of seconds, so "in flight" is the
    // normal state when you tap, and swallowing it leaves the list on "Asking bd…"
    // until the next tick a minute later.
    if (loading) {
      loadAgain = true;
      return;
    }
    loading = true;
    pulseEl.classList.add('busy');
    try {
      const asked = state.scope;
      const data = await api(`/api/questions?scope=${encodeURIComponent(asked)}`);
      // Changed under us while the request was out. These are rows from the list
      // you just left; the re-run queued above is the one that counts.
      if (asked !== state.scope) return;
      const openKeys = state.open;
      // Keep any already-fetched detail so an open card doesn't flicker. Both
      // channels are merged against the same map: a bead moves between them only by
      // gaining or losing a label, and when it does the fresh row is what is right.
      const prev = new Map([...state.questions, ...(state.requests || [])].map((q) => [q.key, q]));
      // `agent` has to be reset before the merge, not left to it: a question payload
      // omits the field rather than sending false, so a bead that has just gained the
      // `human` label would otherwise keep rendering as read-only agent work for as
      // long as the tab stayed open.
      const merge = (q) => {
        const before = prev.get(q.key);
        return before ? Object.assign(before, { agent: false }, q) : q;
      };
      // A question whose answer is written but not yet acknowledged is still open on
      // the server, so it is still in this payload — and putting it back would drop a
      // card into the list underneath the bead that is at that moment flying out of
      // it. It comes back only if the write is refused, from submit()'s own copy.
      const live = (q) => !state.inFlight.has(q.key);
      // Absent rather than empty means an old server that predates the channel — keep
      // whatever is on screen instead of silently emptying the pane.
      state.requests = Array.isArray(data.requests) ? data.requests.map(merge).filter(live) : state.requests;
      state.questions = data.questions.map(merge).filter(live);
      state.spaces = data.spaces || [];
      // Absent means a server that predates the counts — keep the last ones rather
      // than blanking the chrome, exactly as the requests pane does above.
      if (data.summary) state.summary = data.summary;
      // A space that has been renamed or removed in config would otherwise leave the
      // filter pinned to something that no longer exists, showing an empty list.
      if (state.space !== 'all' && !state.spaces.some((s) => s.name === state.space)) state.space = 'all';
      // Kept open across a refresh only if the bead is still somewhere — in either
      // channel. Checking only `questions` would collapse an open request every 25
      // seconds, mid-read.
      state.open = new Set([...openKeys].filter((k) => Boolean(byKey(k))));
      render();
      focusHash();
    } catch (err) {
      if (err.message !== 'token rejected') {
        listEl.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
      }
    } finally {
      loading = false;
      pulseEl.classList.remove('busy');
      if (loadAgain) {
        loadAgain = false;
        load();
      }
    }
  }

  /** #workspace/id from an ntfy notification tap, or the Android shell's deep link. */
  let hashHandled = '';
  async function focusHash() {
    const key = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!key || key === hashHandled) return;
    if (!byKey(key)) {
      // A deep link always names a question, and `agent` is the one scope with no
      // questions in it — so the tap would land on a list that silently ignored it.
      // Widen instead of losing it. This does not await the reload: focusHash runs
      // from inside load(), where a nested load() only queues itself, and the
      // re-run calls back in here with the card present.
      if (state.scope === 'agent') {
        state.scope = 'both';
        localStorage.setItem('beadcause.scope', state.scope);
        paintScope();
        schedulePoll();
        load();
      }
      return;
    }
    hashHandled = key;
    // The card is already open and there is an answer on the go: the link is
    // pointing at where you already are. Rebuilding the list to "open" what is
    // open drops the keyboard and loses the caret for nothing — this is the tap
    // that comes back from the notification shade, or a fresh push about the very
    // bead being answered.
    if (state.open.has(key) && isAnswering()) return;
    await expand(key);
    const el = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    // Going to the card is what the link asked for; it outranks the restore.
    releasePlace();
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  $('#refresh').addEventListener('click', load);
  addEventListener('hashchange', () => {
    hashHandled = '';
    focusHash();
  });
  /**
   * How often to re-ask. Scope decides, because the two scopes cost very different
   * amounts: `human` is one `bd human list` per workspace and stays where it was,
   * while the wider ones are a full `bd list` sweep — around 2.5s of `bd` across
   * seven workspaces — so they back off rather than keeping seven CLI processes
   * warm on the Mac for a list you are probably just glancing at.
   */
  const POLL_MS = { human: 25000, both: 60000, agent: 60000 };
  let pollTimer = null;
  function schedulePoll() {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS[state.scope] || 25000);
  }

  // These keep fetching; render() decides whether it's safe to repaint.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) load();
  });
  schedulePoll();

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

  // What the page exposes to its host. The Android shell calls `refresh` when you
  // come back from the notification shade or a document, so the list is fresh
  // without a reload — a reload would discard scroll position and any draft sitting
  // in a textarea. render() still refuses to repaint mid-answer.
  //
  // Merged rather than assigned: presence.js is loaded before this and hangs its own
  // handle here, and replacing the object wholesale silently unhooks it — the page
  // then works perfectly while telling the monitor nothing, which is the hardest
  // possible version of this bug to see.
  window.beadcause = window.beadcause || {};
  window.beadcause.refresh = load;

  /** The scope survives a reload — it is a preference, not a session detail. */
  function bootScope() {
    const saved = localStorage.getItem('beadcause.scope');
    if (SCOPES.includes(saved)) state.scope = saved;
    paintScope();
  }

  bootToken();
  bootScope();
  load();
  // After the list, and never blocking it: the chooser only appears inside an open
  // card, so there is nothing on screen waiting for this.
  loadAgents();
})();
