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
    // Which card has the ⋯ roster open, for the same reason as `menu`: the panel
    // hangs over a half-written comment, so it is shown and hidden by hand, and
    // this is what paints it back when a poll rebuilds the list underneath it.
    agentMenu: null,
    // Per-bead decisions on an advocate's proposal: key → Map(1-based index →
    // 'yes' | 'no'). Held here rather than on the question so a background refresh
    // cannot wipe a half-made decision, the same reason drafts live outside it.
    picks: new Map(),
    // Which proposal rows you have unfolded, as `${key}|${n}`. Out here with the
    // picks for the same reason: a background refresh must not fold a row back up
    // while you are reading it.
    propOpen: new Set(),
    // Which rows you are *adjusting*, as `${key}|${n}`, and what you have changed:
    // key → Map(1-based index → patch). ✓ and ✕ are a verdict on someone else's
    // sentence, and the common case is neither — the bead is worth filing but the
    // title is wrong. Without a third option that lands as a decline, and the work
    // comes back next week phrased exactly the same way.
    propEdit: new Set(),
    edits: new Map(),
    // The live half of a delivery card: key → { loading, pr, unavailable }. The
    // diffstat and the check rollup come from GitHub rather than from the bead,
    // because a diffstat frozen when the session ended is wrong the moment anyone
    // pushes to the branch — and the number you are looking at when you press merge
    // is the one that has to be right. Fetched once per card, never on the poll.
    prs: new Map(),
    // Which delivery cards you have started declining. A mode rather than an armed
    // button, because a decline can carry direction for the next attempt and typing
    // a paragraph would outlive any arm timer — see declineHtml.
    prDecline: new Set(),
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

  /**
   * Don't yank the textarea out from under a thumb mid-sentence.
   *
   * The adjust fields count too. They hold their value in `state.edits` rather than
   * in the DOM, so a repaint would not *lose* anything — but it would drop focus and
   * put the caret back at the end, which mid-word is the same insult.
   */
  const isTyping = () =>
    !!document.activeElement?.matches?.('[data-role="answer"], [data-role="edit-field"]');

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

  /* ------------------------------------------------------------- adjusting */

  /** What you have rewritten on this proposal so far: 1-based index → partial bead. */
  const editsFor = (key) => {
    if (!state.edits.has(key)) state.edits.set(key, new Map());
    return state.edits.get(key);
  };

  /**
   * A proposed bead as it stands: what the agent wrote, under whatever you changed.
   *
   * Every surface reads beads through this rather than off `q.proposal` — the row,
   * the fold height, the primary button's count — so an adjusted bead looks adjusted
   * everywhere, and there is never a moment where the card shows one title and the
   * create sends another.
   */
  const beadAt = (key, b, n) => ({ ...b, ...(editsFor(key).get(n) || {}) });

  /** Whether row `n` differs from what was proposed. Drives the "adjusted" flag. */
  const isAdjusted = (key, n) => {
    const patch = editsFor(key).get(n);
    return !!patch && Object.keys(patch).length > 0;
  };

  /** The fields adjusting exposes, and nothing else. */
  const EDIT_FIELDS = [
    { key: 'title', label: 'Title', tag: 'input' },
    { key: 'description', label: 'Description', tag: 'textarea', rows: 5 },
    { key: 'acceptance', label: 'Done when', tag: 'textarea', rows: 2 },
  ];

  const TYPES = ['task', 'bug', 'feature', 'epic', 'chore', 'decision'];

  /**
   * The row, in edit mode.
   *
   * Deliberately the same five things the chat session lets you change — title, type,
   * priority, description, acceptance — and deliberately not labels or dependencies.
   * Those are structural, they are rarely what is wrong with a proposed bead, and a
   * chip editor is not something to build on a card you are trying to keep short.
   * What you do not adjust is created exactly as proposed.
   *
   * Values come out of `state.edits`, never out of the DOM, so a background poll
   * that does manage to repaint cannot lose a word of it — the same discipline the
   * answer box keeps with its draft.
   */
  function propEditHtml(key, b, n) {
    const cur = beadAt(key, b, n);
    const field = (f) => {
      const v = esc(cur[f.key] || '');
      const attrs = `data-role="edit-field" data-key="${esc(key)}" data-idx="${n}" data-field="${f.key}"`;
      return `<label class="edit-field">
        <span class="prop-label">${f.label}</span>
        ${
          f.tag === 'input'
            ? `<input type="text" ${attrs} value="${v}">`
            : `<textarea rows="${f.rows}" ${attrs}>${v}</textarea>`
        }
      </label>`;
    };
    return `<div class="prop-edit">
      ${EDIT_FIELDS.map(field).join('')}
      <div class="edit-row">
        <label class="edit-field small">
          <span class="prop-label">Type</span>
          <select data-role="edit-field" data-key="${esc(key)}" data-idx="${n}" data-field="type">
            ${TYPES.map((t) => `<option value="${t}"${t === cur.type ? ' selected' : ''}>${t}</option>`).join('')}
          </select>
        </label>
        <label class="edit-field small">
          <span class="prop-label">Priority</span>
          <select data-role="edit-field" data-key="${esc(key)}" data-idx="${n}" data-field="priority">
            ${[0, 1, 2, 3, 4]
              .map((p) => `<option value="${p}"${p === Number(cur.priority) ? ' selected' : ''}>P${p}</option>`)
              .join('')}
          </select>
        </label>
      </div>
      <button class="linkish" data-act="prop-edit" data-key="${esc(key)}" data-idx="${n}">Done adjusting</button>
    </div>`;
  }

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
      .map((raw, i) => {
        const n = i + 1;
        // Everything below reads the *adjusted* bead, so a row you have rewritten
        // looks rewritten — there is never a moment where the card shows one title
        // and pressing create sends another.
        const b = beadAt(q.key, raw, n);
        const choice = picks.get(n) || '';
        const editing = state.propEdit.has(`${q.key}|${n}`);
        const adjusted = isAdjusted(q.key, n);
        // Long rows start folded so three proposals still fit on the screen you are
        // deciding from. A fold and not the old three-line clamp, because a clamp
        // cuts markdown mid-list-item and leaves no way at all to see the rest.
        // A row being adjusted is never folded: you cannot edit what is hidden.
        const long = propLines(b) > COLLAPSE_AT && !editing;
        const collapsed = long && !state.propOpen.has(`${q.key}|${n}`);
        return `<div class="prop-row ${choice ? `pick-${choice}` : ''}${collapsed ? ' is-collapsed' : ''}${
          editing ? ' is-editing' : ''
        }" data-idx="${n}" data-key="${esc(q.key)}">
          <div class="prop-main">
            <div class="prop-head"><span class="prop-n">${n}</span><span class="prop-title">${esc(b.title)}</span>${
          adjusted ? '<span class="pill adjusted">adjusted</span>' : ''
        }</div>
            ${
              editing
                ? propEditHtml(q.key, raw, n)
                : `<div class="prop-body">
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
            </div>`
            }
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
            <button class="prop-btn edit${editing ? ' on' : ''}" data-act="prop-edit" data-key="${esc(q.key)}" data-idx="${n}"
              aria-label="Adjust bead ${n}" aria-pressed="${editing}">✎</button>
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

  /* --------------------------------------------------------------- delivery */

  /**
   * A worker handing back finished work as a pull request.
   *
   * The one card in the inbox whose answer changes something outside this Mac, so it
   * is built around making that judgeable *without* leaving for GitHub: what changed,
   * how big it is, whether the tests went green, and — the part that has to be live —
   * whether GitHub will actually take it right now.
   *
   * The live half arrives after the card does. Everything from the `beadpr` block
   * draws immediately; the diffstat and the check rollup come from `/api/pr` and are
   * painted in when they land. That order is deliberate: a card that waits on the
   * network to draw anything is a card that shows a spinner in a tunnel, and the
   * summary the session wrote is worth reading with no signal at all.
   */
  function deliveryHtml(q) {
    const d = q.delivery;
    if (!d) return '';
    const live = state.prs.get(q.key);
    const armed = state.armed === `${q.key}|merge`;

    return `<div class="delivery" data-key="${esc(q.key)}">
      <div class="section-label">Pull request <span>nothing merges until you say so</span></div>
      <a class="pr-link" href="${esc(d.url)}" target="_blank" rel="noopener">
        <span class="pr-num">#${d.number}</span>
        <span class="pr-title">${esc(d.title || d.branch)}</span>
      </a>
      <div class="pr-branch"><code>${esc(d.branch)}</code> → <code>${esc(d.base)}</code></div>
      ${prSummaryHtml(q, d)}
      <div class="pr-stats">${prStatsHtml(live)}</div>
      ${
        state.prDecline.has(q.key)
          ? declineHtml(q, d)
          : `<div class="pr-actions">
        <button class="primary pr-merge${armed ? ' confirm' : ''}" data-act="pr-merge" data-key="${esc(q.key)}"
          ${live?.pr && !canMerge(live.pr) ? 'disabled' : ''}>
          ${armed ? 'Tap again to confirm · ' : ''}${esc(mergeLabel(d, live))}
        </button>
        <button class="secondary" data-act="pr-changes" data-key="${esc(q.key)}">Request changes</button>
        <button class="linkish danger" data-act="pr-decline" data-key="${esc(q.key)}">Decline it</button>
      </div>`
      }
    </div>`;
  }

  /**
   * Declining, once you have said you mean to.
   *
   * The three actions are not three shades of the same thing, and this panel exists
   * to stop the two that look alike from being confused. **Request changes** says the
   * branch is right and something on it is wrong: same PR, more commits. **Decline**
   * says the approach is wrong: the PR closes, the branch is abandoned, and the bead
   * goes back to the queue for a fresh start. Choosing the wrong one wastes a whole
   * session, so the panel says which is which at the moment of choosing.
   *
   * It replaces the buttons rather than sitting under them, which is what makes this
   * two deliberate steps without an arm timer to race — and a decline can carry a
   * paragraph of direction, which no six-second timer would survive.
   */
  function declineHtml(q, d) {
    return `<div class="pr-decline">
      <p class="decline-head">Declining <strong>#${d.number}</strong></p>
      <p class="decline-why">The pull request closes and <code>${esc(d.branch)}</code> is abandoned.
        ${d.bead ? `<strong>${esc(d.bead)}</strong> goes back in the queue` : 'The work stays open'} for a fresh start —
        declining this attempt is not declining the work.</p>
      <p class="decline-why">Say what to do instead in the box below, if you know. It is optional, and it is the
        difference between a session that starts again and a session that starts again the same way.</p>
      <div class="pr-actions">
        <button class="primary danger" data-act="pr-decline-go" data-key="${esc(q.key)}">Decline #${d.number}</button>
        <button class="linkish" data-act="pr-decline-cancel" data-key="${esc(q.key)}">Cancel</button>
      </div>
    </div>`;
  }

  /**
   * What the session said about its own work — on the card, not in the brief.
   *
   * Everywhere else in the inbox, context lives behind *Show details*, because a
   * question is a sentence and the brief is the argument for it. A delivery is the
   * other way round: the question is always the same four words, and the argument is
   * the entire content. Merge is two taps from the collapsed card, so anything you
   * would want to have read before those two taps has to be above them.
   *
   * Folded when it is long, by the same machinery and for the same reason as a
   * proposal row: three deliveries should still fit on the screen you are deciding
   * from, and a fold beats a clamp because a clamp cuts a list mid-item.
   */
  function prSummaryHtml(q, d) {
    const parts = [];
    if (d.summary) parts.push(`<div class="md">${renderMarkdown(d.summary, FROM_BD)}</div>`);
    for (const [label, value] of [
      ['Tests', d.tests],
      ['Worth knowing', d.risk],
      ['Left undone', d.left],
    ]) {
      if (value) {
        parts.push(
          `<div class="prop-field"><span class="prop-label">${label}</span><div class="md">${renderMarkdown(
            value,
            FROM_BD
          )}</div></div>`
        );
      }
    }
    if (!parts.length) return '';

    const prose = [d.summary, d.tests, d.risk, d.left].filter(Boolean).join('\n');
    const long = prose.split('\n').reduce((n, l) => n + Math.max(1, Math.ceil(l.length / PHONE_COLS)), 0) > COLLAPSE_AT;
    const collapsed = long && !state.propOpen.has(`${q.key}|pr`);
    return `<div class="pr-summary${collapsed ? ' is-collapsed' : ''}">${parts.join('')}</div>${
      long
        ? `<button class="prop-more" data-act="prop-more" data-key="${esc(q.key)}" data-idx="pr"
            aria-expanded="${!collapsed}">${collapsed ? 'Show the rest' : 'Show less'}</button>`
        : ''
    }`;
  }

  /** What the primary button promises, which must never overstate what it will do. */
  function mergeLabel(d, live) {
    if (live?.pr?.state === 'MERGED') return `#${d.number} is already merged`;
    if (live?.pr?.state === 'CLOSED') return `#${d.number} is closed`;
    if (live?.pr?.mergeable === 'CONFLICTING') return `#${d.number} conflicts with ${d.base}`;
    return `${d.method === 'squash' ? 'Squash and merge' : `${d.method} and merge`} #${d.number}`;
  }

  /**
   * Whether pressing merge could possibly work.
   *
   * Only ever *disables* on facts GitHub has already stated — merged, closed,
   * conflicting. Failing checks deliberately do **not** disable it: a red check is
   * sometimes a flake and the decision is Adam's, so it is shown loudly and left
   * pressable. The server re-checks all of this anyway; this is courtesy, not a gate.
   */
  const canMerge = (pr) => pr.state === 'OPEN' && pr.mergeable !== 'CONFLICTING';

  /** The live numbers, or an honest line about why there aren't any. */
  function prStatsHtml(live) {
    if (!live || live.loading) return '<span class="pr-chip quiet">reading GitHub…</span>';
    if (live.unavailable) return `<span class="pr-chip warn">${esc(live.unavailable)}</span>`;
    const pr = live.pr;
    if (!pr) return '<span class="pr-chip quiet">no live state</span>';

    const chips = [
      `<span class="pr-chip">${pr.files} file${pr.files === 1 ? '' : 's'}</span>`,
      `<span class="pr-chip diff"><span class="add">+${pr.additions}</span> <span class="del">−${pr.deletions}</span></span>`,
    ];
    // Four states and four sentences. "none" is not "passing": a repo with no CI has
    // told you nothing, and dressing that up as a green tick is the one thing this
    // chip must never do.
    const c = pr.checks;
    if (c.state === 'failing') {
      chips.push(`<span class="pr-chip bad">${c.failing} check${c.failing === 1 ? '' : 's'} failing${
        c.failed.length ? `: ${esc(c.failed.join(', '))}` : ''
      }</span>`);
    } else if (c.state === 'pending') {
      chips.push(`<span class="pr-chip warn">${c.pending} check${c.pending === 1 ? '' : 's'} still running</span>`);
    } else if (c.state === 'passing') {
      chips.push(`<span class="pr-chip good">${c.passing} check${c.passing === 1 ? '' : 's'} passing</span>`);
    } else {
      chips.push('<span class="pr-chip quiet">no checks</span>');
    }
    if (pr.state === 'MERGED') chips.push('<span class="pr-chip good">merged</span>');
    else if (pr.state === 'CLOSED') chips.push('<span class="pr-chip warn">closed</span>');
    else if (pr.mergeable === 'CONFLICTING') chips.push('<span class="pr-chip bad">conflicts</span>');
    if (pr.draft) chips.push('<span class="pr-chip warn">draft</span>');
    return chips.join('');
  }

  /**
   * Fetch the live half, once per card.
   *
   * Never on the poll: that would be a `gh` call per delivery every 25 seconds, for
   * cards nobody is looking at, and `gh` is a network round trip through GitHub's
   * API. The refresh you actually want is the one after you have been away, and
   * re-opening the card is what asks for it.
   */
  async function ensurePr(q) {
    if (!q.delivery || state.prs.has(q.key)) return;
    state.prs.set(q.key, { loading: true, pr: null, unavailable: null });
    try {
      const res = await api(`/api/pr?workspace=${encodeURIComponent(q.workspace)}&id=${encodeURIComponent(q.id)}`);
      state.prs.set(q.key, { loading: false, pr: res.pr, unavailable: res.unavailable });
    } catch (err) {
      // An unreachable daemon must not blank the card: everything from the block is
      // still on screen and still true, and the link still works.
      state.prs.set(q.key, { loading: false, pr: null, unavailable: err.message });
    }
    paintPr(q.key);
  }

  /**
   * Send the decline, with whatever direction is in the box.
   *
   * One function, two buttons: the confirm in the panel where you tapped decline, and
   * the primary under the box you may have scrolled down to type in. They are far
   * apart on a long card and either one should finish the job, so neither may have
   * its own idea of what gets sent.
   *
   * The note is optional by design and the wording says which happened, because
   * "declined" and "declined, and here is what to do instead" are different messages
   * to leave for the session that picks the bead up next.
   */
  async function declineNow(key) {
    const q = byKey(key);
    const d = q?.delivery;
    if (!d) return;
    const box = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"] [data-role="answer"]`);
    const note = (box?.value || '').trim();
    state.prDecline.delete(key);
    disarm();
    await submit(key, note ? `DECLINE: ${note}` : `DECLINE: close #${d.number} — this approach is not the one.`, {
      close: true,
    });
  }

  /** Repaint one delivery's live half in place — never a render(), same as paintPicks. */
  function paintPr(key) {
    const q = byKey(key);
    const block = listEl.querySelector(`.delivery[data-key="${CSS.escape(key)}"]`);
    if (!block || !q?.delivery) return;
    const live = state.prs.get(key);
    const stats = block.querySelector('.pr-stats');
    if (stats) stats.innerHTML = prStatsHtml(live);
    const go = block.querySelector('.pr-merge');
    if (go) {
      go.disabled = Boolean(live?.pr && !canMerge(live.pr));
      const armed = state.armed === `${key}|merge`;
      go.textContent = `${armed ? 'Tap again to confirm · ' : ''}${mergeLabel(q.delivery, live)}`;
      go.classList.toggle('confirm', armed);
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
   *
   * All of it now lives behind the ⋯ on the answer box (see replyBarHtml). Nearly
   * every comment goes to the default agent, and this was several centimetres of
   * chooser between the thread you just read and the box you were about to type in.
   * The panel is the same markup in a different place — nothing here decides which
   * agents exist, what any of them may do, or how the dispatch is sent.
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

    return `<div class="section-label">Who replies <span>to your comment</span></div>
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
   * Which agent replies, said with the panel shut.
   *
   * Collapsing the roster to a bare ⋯ would make every comment a guess, so the
   * answer stays on screen and the roster is one tap away. It names the button as
   * well as the agent, because the chooser governs exactly one of the two: a
   * comment dispatches (server.js), and "Answer & close" spawns nobody. The old
   * label — "the agent that picks up your comment" — described a mailbox that
   * nothing has watched since dispatch started launching the reply itself.
   */
  function replyLineHtml(chosen) {
    if (!chosen) return '';
    // An armed override is spent on send, so it cannot only live inside the panel:
    // shut, the box would look ordinary at the moment you press the button.
    return `<b>Comment only</b> → ${esc(chosen.emoji || '🤖')} ${esc(chosen.name)} replies${
      chosen.armed ? ' <span class="reply-armed">· ⚠ with tools, this once</span>' : ''
    }`;
  }

  const dotsLabel = (chosen) =>
    chosen
      ? `Choose who replies — now ${chosen.name}${chosen.armed ? ', tools allowed for this comment' : ''}`
      : 'Choose who replies';

  /**
   * The strip along the top of the answer box: who replies, and the ⋯ that opens
   * the roster.
   *
   * Attached to the textarea rather than floating above it, so the ⋯ reads as that
   * box's own corner — this chooses who answers *this*, and nothing else on the
   * card. The panel is rendered with the card and only shown or hidden, which is
   * what lets paintAgents keep repainting it in place while it is open.
   */
  function replyBarHtml(key) {
    const chosen = currentAgent();
    const on = state.agentMenu === key;
    return `<div class="reply-bar"${state.agents.length ? '' : ' hidden'}>
      <span class="reply-who">${replyLineHtml(chosen)}</span>
      <div class="agent-wrap">
        <button class="agent-dots${chosen?.armed ? ' armed' : ''}${on ? ' on' : ''}" data-act="agent-menu"
          data-key="${esc(key)}" aria-haspopup="true" aria-expanded="${on}"
          aria-label="${esc(dotsLabel(chosen))}"><span class="dots-emoji">${esc(
            chosen?.emoji || '🤖'
          )}</span>⋯</button>
        <div class="agents agent-panel" role="group" aria-label="Who replies to your comment"${
          on ? '' : ' hidden'
        }>${agentsHtml()}</div>
      </div>
    </div>`;
  }

  /**
   * Repaint the chooser in place.
   *
   * Never through render(): the comment box sits directly beneath it, and rebuilding
   * the card to change which chip is pressed would drop a half-written comment —
   * which is the exact failure the draft machinery elsewhere exists to prevent. The
   * same rule reaches the strip outside the panel: its text is rewritten, but the ⋯
   * element itself is left alone so an open panel does not close under the repaint.
   */
  function paintAgents() {
    const chosen = currentAgent();
    for (const block of listEl.querySelectorAll('.agents')) block.innerHTML = agentsHtml();
    for (const bar of listEl.querySelectorAll('.reply-bar')) {
      // A roster that never loaded leaves no strip at all — the server falls back to
      // its default agent exactly as it did before any of this existed.
      bar.hidden = !state.agents.length;
      const who = bar.querySelector('.reply-who');
      if (who) who.innerHTML = replyLineHtml(chosen);
      const dots = bar.querySelector('.agent-dots');
      if (!dots) continue;
      dots.classList.toggle('armed', !!chosen?.armed);
      dots.setAttribute('aria-label', dotsLabel(chosen));
      const emoji = dots.querySelector('.dots-emoji');
      if (emoji) emoji.textContent = chosen?.emoji || '🤖';
    }
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
    // sets of buttons for the same choice, disagreeing about granularity. A delivery
    // draws its own three for the same reason — and because merge has to know
    // whether GitHub will take it, which a generic option button cannot.
    const opts = q.proposal?.beads?.length || q.delivery ? [] : d?.options || [];
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
      ${deliveryHtml(q)}
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

    // The thread runs straight into the box you answer it in; who replies is a line
    // on the box's own top edge, and the roster is behind the ⋯ on that line.
    //
    // And on a delivery the box has one job, which job depending on what you tapped
    // to get here — so it says which. A button labelled "Answer & close" over a pull
    // request invites a sentence that reads like approval and lands as a rejection.
    const declining = q.delivery && state.prDecline.has(q.key);
    const boxPlaceholder = declining
      ? 'Optional — what should the next attempt do instead?'
      : q.delivery
      ? 'What needs changing before this can merge…'
      : 'Answer in your own words…';
    const boxLabel = declining
      ? `Decline #${q.delivery.number} &amp; close`
      : q.delivery
      ? 'Request changes &amp; close'
      : 'Answer &amp; close';
    parts.push(`<div class="freeform${declining ? ' declining' : ''}">
      ${replyBarHtml(q.key)}
      <textarea data-role="answer" placeholder="${boxPlaceholder}" rows="3">${esc(getDraft(q.key))}</textarea>
      <div class="row">
        <button class="primary${declining ? ' danger' : ''}" data-act="${
      declining ? 'pr-decline-go' : 'answer'
    }" data-key="${esc(q.key)}">${boxLabel}</button>
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
   *   same chat session whichever repo it was working in when it hit the wall.
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
    // The live half of any delivery on screen. `ensurePr` is a no-op for a card it
    // has already fetched, so this costs one GitHub round trip per pull request for
    // the life of the tab, not one per render.
    for (const q of visible) if (q.delivery) ensurePr(q);

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

  async function submit(key, text, { close, create = null, edits = null }) {
    const q = byKey(key);
    if (!q) return;
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    card?.classList.add('answering');
    // Writes go through bd, which can retry against the Dolt lock for a second or
    // two. Say so, rather than leaving a dimmed card and no explanation.
    const sending = document.createElement('div');
    sending.className = 'sending';
    sending.innerHTML = `<span class="spark"></span>${close ? 'Recording your answer…' : 'Adding your comment…'}`;
    card?.appendChild(sending);
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
                // And your rewrites, keyed by the same numbers. The server puts each
                // one back through the parser's own normaliser before anything is
                // created, so a priority you typed into the wrong box is clamped
                // there rather than failing at `bd create` with half the proposal filed.
                ...(edits ? { edits } : {}),
              }
            : // Which agent picks this up. Absent or unknown resolves to the
              // default server-side, so an old phone still gets an answer.
              { workspace: q.workspace, id: q.id, text, agent: state.agent || undefined }
        ),
      });
      clearDraft(key);
      if (close) {
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
        // Forced: the answered card's textarea is still in the DOM holding text,
        // so a deferred render would never fire and the card would linger.
        render(true);
      } else {
        toast(res?.elevated ? 'Comment added — running with tools, this once' : 'Comment added — an agent will be told');
        // The server has spent the arm on this dispatch, so the box must come back
        // off. Re-read rather than assume: if the dispatch was refused the arm is
        // still there, and a tick that lied either way would be the worst outcome.
        loadAgents();
        card?.classList.remove('answering');
        sending.remove();
        // Reflect the awaiting-agent flag the server just set, without waiting
        // for the next poll.
        q.awaitingAgent = true;
        // Collapse and let it sink. You have said your piece; keeping the card open
        // in front of you implies there is something left for you to do with it,
        // when the next move belongs to the agent. It comes back up when it replies.
        state.open.delete(key);
        clearDraft(key);
        render(true);
      }
    } catch (err) {
      card?.classList.remove('answering');
      sending.remove();
      toast(err.message, true);
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

  /**
   * Shut the ⋯ roster the same way: by hand, never through render().
   *
   * Focus goes back to the ⋯ only when it was inside the panel. Escape pressed
   * while you are typing must close the panel and leave the caret in the box —
   * pulling it out to a button is how you lose your place in a comment.
   */
  function closeAgentMenu() {
    state.agentMenu = null;
    for (const panel of listEl.querySelectorAll('.agent-panel')) {
      const had = panel.contains(document.activeElement);
      panel.hidden = true;
      const dots = panel.closest('.agent-wrap')?.querySelector('.agent-dots');
      if (!dots) continue;
      dots.classList.remove('on');
      dots.setAttribute('aria-expanded', 'false');
      if (had) dots.focus();
    }
  }

  // A tap anywhere that isn't the menu or its button dismisses it. This runs after
  // the list's own handler below, so opening the menu doesn't immediately close it.
  document.addEventListener('click', (ev) => {
    if (state.menu && !ev.target.closest('.menu-wrap')) closeMenu();
    // The panel is the one popover whose own contents repaint under the tap — every
    // chip and checkbox in it ends in paintAgents(). By the time this runs the
    // tapped node has been thrown away, and a detached node has no ancestors, so
    // closest() would call every tap inside the panel a tap outside it. The path is
    // taken at dispatch and still remembers where the tap actually was.
    //
    // The tools disclaimer counts as inside for the same reason it exists: it is a
    // modal on document.body, so arming is outside the panel by geometry and inside
    // it by intent, and must not shut the roster out from under the checkbox that
    // asked.
    const inPanel = (ev.composedPath?.() || []).some(
      (n) => n?.classList?.contains('agent-wrap') || n?.classList?.contains('dialog-wrap')
    );
    if (state.agentMenu && !inPanel) closeAgentMenu();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    // With the tools warning up, Escape is the modal's business — closing the panel
    // out from under it would leave the dialog answering for a chooser that is no
    // longer on screen.
    if (document.querySelector('.dialog-wrap')) return;
    if (state.agentMenu) closeAgentMenu();
    if (state.menu) closeMenu();
  });

  listEl.addEventListener('click', async (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const key = btn.dataset.key;
    const act = btn.dataset.act;

    if (act === 'agent-menu') {
      const wasOpen = state.agentMenu === key;
      closeMenu();
      closeAgentMenu();
      if (wasOpen) return;
      state.agentMenu = key;
      btn.classList.add('on');
      btn.setAttribute('aria-expanded', 'true');
      const panel = btn.parentElement.querySelector('.agent-panel');
      if (panel) {
        panel.hidden = false;
        // On a wide screen the brief is its own scroll column, so a panel opened at
        // the foot of it can land below that column's fold.
        panel.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    if (act === 'menu') {
      const wasOpen = state.menu === key;
      closeMenu();
      closeAgentMenu();
      if (wasOpen) return;
      state.menu = key;
      btn.classList.add('on');
      btn.setAttribute('aria-expanded', 'true');
      btn.parentElement.insertAdjacentHTML('beforeend', menuHtml(key));
      return;
    }

    if (act === 'toggle') {
      closeMenu();
      closeAgentMenu();
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
      closeAgentMenu();
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
      // A proposal row folds its `.prop-body`; a delivery folds its `.pr-summary`
      // and has no row around it. Same button, same state, whichever it found.
      const fold = btn.closest('.prop-row') || btn.previousElementSibling;
      const token = `${key}|${btn.dataset.idx}`;
      const open = !state.propOpen.has(token);
      if (open) state.propOpen.add(token);
      else state.propOpen.delete(token);
      fold?.classList.toggle('is-collapsed', !open);
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

    /**
     * Open or close the editor on one row.
     *
     * Opening it also approves the row, and that is not a shortcut — adjusting a
     * bead is the strongest possible statement that you want it. Making you rewrite
     * the title and *then* find the ✓ is how a considered edit turns into an
     * accidental decline.
     */
    if (act === 'prop-edit') {
      const n = Number(btn.dataset.idx);
      const token = `${key}|${n}`;
      if (state.propEdit.has(token)) state.propEdit.delete(token);
      else {
        state.propEdit.add(token);
        picksFor(key).set(n, 'yes');
      }
      disarm();
      render(true);
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
      // Only the rows being created carry their edits: a bead you adjusted and then
      // declined is a bead nobody filed, and sending the rewrite for it would put
      // your words in the record of something that does not exist.
      const edits = {};
      for (const n of approved) {
        const patch = editsFor(key).get(n);
        if (patch && Object.keys(patch).length) edits[n] = patch;
      }
      const adjusted = Object.keys(edits).length;

      state.picks.delete(key);
      state.edits.delete(key);
      for (const t of [...state.propOpen]) if (t.startsWith(`${key}|`)) state.propOpen.delete(t);
      for (const t of [...state.propEdit]) if (t.startsWith(`${key}|`)) state.propEdit.delete(t);
      const declined = beads.length - approved.length;
      const text = approved.length
        ? `CREATE: ${approved.join(',')} — filing ${approved.length} of ${beads.length} proposed bead${
            beads.length === 1 ? '' : 's'
          }${declined ? `, declining ${declined}` : ''}${adjusted ? `, ${adjusted} adjusted` : ''}.`
        : `Not now — none of the ${beads.length} proposed beads.`;
      await submit(key, text, {
        close: true,
        create: approved.length ? approved : null,
        edits: adjusted ? edits : null,
      });
      return;
    }

    /**
     * Merge it. Two taps, like every other answer that closes a bead — except this
     * one also lands code in main, which is the strongest argument for the second tap
     * in the whole app.
     */
    if (act === 'pr-merge') {
      const q = byKey(key);
      const d = q?.delivery;
      if (!d) return;
      const token = `${key}|merge`;
      if (state.armed !== token) {
        state.armed = token;
        clearTimeout(state.armedTimer);
        state.armedTimer = setTimeout(() => {
          disarm();
          paintPr(key);
        }, 6000);
        paintPr(key);
        return;
      }
      disarm();
      // Built here rather than read out of the decision block's option: the server
      // consents on the marker alone, and a card that has just re-read GitHub knows
      // more about this PR than the block written when the session ended.
      await submit(key, `MERGE: ${d.method} and merge #${d.number}${d.bead ? `, then close ${d.bead}` : ''}.`, { close: true });
      return;
    }

    /**
     * Ask for changes — which is a sentence, not a button, so this opens the card and
     * puts you in the box rather than answering anything. "Changes requested" with no
     * note is the least useful thing anyone could send a session that is about to try
     * again, so there is deliberately no one-tap path to it.
     */
    if (act === 'pr-changes') {
      state.open.add(key);
      disarm();
      render(true);
      const box = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"] [data-role="answer"]`);
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
      toast('Say what needs changing — it goes on the PR and back to the session');
      return;
    }

    /**
     * Step one of declining: say you mean to, and get somewhere to say why.
     *
     * Opens the card the same way "request changes" does, because the direction for
     * the next attempt is typed in the same box — but unlike changes, an empty box is
     * a complete answer here.
     */
    if (act === 'pr-decline') {
      state.prDecline.add(key);
      state.open.add(key);
      disarm();
      render(true);
      const box = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"] [data-role="answer"]`);
      if (box) {
        box.focus();
        box.setSelectionRange(box.value.length, box.value.length);
      }
      return;
    }

    if (act === 'pr-decline-cancel') {
      state.prDecline.delete(key);
      render(true);
      return;
    }

    if (act === 'pr-decline-go') {
      await declineNow(key);
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
      /**
       * On a delivery, typed prose that closes the question *is* a change request.
       *
       * The three things you can do to a pull request all have buttons; what the box
       * is for here is the sentence that says what is wrong with it. So it is sent
       * with the marker, and the button above says so rather than saying "Answer".
       *
       * Note which way this fails. The marker can only ever produce "not merged" —
       * there is no wording of a free-text answer that merges anything, because
       * merging needs `MERGE:` and only the button writes that. Prose is safe here in
       * the one direction where safety matters.
       */
      const q = byKey(key);
      const asChanges = act === 'answer' && q?.delivery;
      await submit(key, asChanges ? `CHANGES: ${text}` : text, { close: act === 'answer' });
      if (act === 'note') box.value = '';
    }
  });

  // Every keystroke is kept, so collapsing the card, a background refresh, or
  // the phone killing the tab can't eat a half-written answer.
  listEl.addEventListener('input', (ev) => {
    // A rewrite of a proposed bead, kept the same way and for the same reason.
    // `change` as well as `input`, because the two `<select>`s only fire the former.
    const field = ev.target.closest('[data-role="edit-field"]');
    if (field) return recordEdit(field);

    const box = ev.target.closest('[data-role="answer"]');
    if (!box) return;
    const key = box.closest('.card')?.dataset.key;
    if (!key) return;
    setDraft(key, box.value);
    // Keep the incomplete mark honest from the first character, so the card is
    // already carrying it by the time the accordion collapses it.
    paintDraftMark(key);
  });

  listEl.addEventListener('change', (ev) => {
    const field = ev.target.closest('[data-role="edit-field"]');
    if (field) recordEdit(field);
  });

  /**
   * One field of one adjusted bead, into `state.edits`.
   *
   * A value equal to what the agent proposed is *removed* rather than stored, so
   * typing a word and deleting it again leaves the row un-adjusted — the "adjusted"
   * flag has to mean something, and a row that carries it because of a keystroke
   * that was undone is a row that lies.
   */
  function recordEdit(el) {
    const key = el.dataset.key;
    const n = Number(el.dataset.idx);
    const f = el.dataset.field;
    const q = byKey(key);
    const original = q?.proposal?.beads?.[n - 1];
    if (!original) return;

    const value = f === 'priority' ? Number(el.value) : el.value;
    const patch = editsFor(key).get(n) || {};
    if (value === original[f] || (typeof value === 'string' && value.trim() === String(original[f] ?? '').trim())) {
      delete patch[f];
    } else {
      patch[f] = value;
    }
    if (Object.keys(patch).length) editsFor(key).set(n, patch);
    else editsFor(key).delete(n);
    paintAdjusted(key, n);
  }

  /**
   * The heading over an open editor, repainted in place as you type.
   *
   * The row keeps its title above the fields, and while you are rewriting that title
   * the two disagree — so the heading has to follow. In place rather than through
   * render(), for the obvious reason: a re-render on every keystroke would take the
   * field out from under the caret, which is the one thing this whole editor must
   * never do.
   *
   * The **adjusted** flag matters more than the heading. It appears the moment a
   * field differs and goes again when it matches, so the word is a fact about the row
   * rather than a memory of having once tapped ✎.
   */
  function paintAdjusted(key, n) {
    const row = listEl.querySelector(`.prop-row[data-key="${CSS.escape(key)}"][data-idx="${n}"]`);
    const q = byKey(key);
    const original = q?.proposal?.beads?.[n - 1];
    if (!row || !original) return;

    const b = beadAt(key, original, n);
    const title = row.querySelector('.prop-title');
    if (title && title.textContent !== b.title) title.textContent = b.title;

    const head = row.querySelector('.prop-head');
    const flag = head?.querySelector('.pill.adjusted');
    if (isAdjusted(key, n) && !flag && head) {
      const pill = document.createElement('span');
      pill.className = 'pill adjusted';
      pill.textContent = 'adjusted';
      head.appendChild(pill);
    } else if (!isAdjusted(key, n) && flag) {
      flag.remove();
    }
  }

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
      // Absent rather than empty means an old server that predates the channel — keep
      // whatever is on screen instead of silently emptying the pane.
      state.requests = Array.isArray(data.requests) ? data.requests.map(merge) : state.requests;
      state.questions = data.questions.map(merge);
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
