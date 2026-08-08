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
    spaces: [],
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
    // Keys whose run has finished. The pane stays — you are usually reading it at
    // the moment the agent stops — but a log that has stopped changing must stop
    // being asked for, or an open pane is a file read every two seconds forever.
    logsDone: new Set(),
    logTimer: null,
    // Key of the card whose ⋮ menu is showing. At most one, and it is deliberately
    // opened and closed by DOM surgery rather than render() — see closeMenu().
    menu: null,
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
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
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

  function renderMarkdown(md) {
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
    const html = window.marked.parse(patched, { breaks: true, gfm: true });
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
   * What is behind the kebab: the two ways out of a card that aren't reading it.
   *
   * The first acts *on* this bead. The second goes the other way — what work comes
   * off the back of it — and is an anchor rather than a button, because the console
   * page opens the conversation itself from `?ws=&seed=` (see public/console.js) and
   * so needs nothing from this one.
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
        href="/console?ws=${encodeURIComponent(ws)}&amp;seed=${encodeURIComponent(id)}">
        <span class="glyph">🧾</span> Work out the next beads from this
      </a>
    </div>`;
  }

  function cardHtml(q) {
    if (q.agent) return agentCardHtml(q);
    const d = q.decision;
    const opts = d?.options || [];
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
    // read one at a time, and on a phone an inline accordion meant the brief, the
    // thread and the answer box all competed with the list around them.
    return `<article class="card${open ? ' open' : ''}${q.awaitingAgent ? ' replied' : ''}" id="card-${cardId(
      q.key
    )}" data-key="${esc(q.key)}">
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
      ${options ? `<div class="options">${options}</div>` : ''}
      <div class="actions">
        <button class="linkish" data-act="toggle" data-key="${esc(q.key)}">
          ${open ? 'Hide details' : draft ? 'Resume your answer' : hasBrief ? 'Show details' : 'Write an answer'}
        </button>
        ${
          // While an agent has it, or for as long as its pane is open: the reply can
          // land while you are still reading the log, and a pane whose button has
          // gone with the flag that drew it is one you can no longer close.
          q.awaitingAgent || state.logs.has(q.key)
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
    if (q.description) parts.push(`<div class="md">${renderMarkdown(q.description)}</div>`);
    // `notes` is where sessions record what they actually did, and it is often the
    // only part worth reading — a bead can have an aspirational description and a
    // notes field saying it shipped three days ago.
    if (q.notes) {
      parts.push('<div class="section-label">notes</div>');
      parts.push(`<div class="md">${renderMarkdown(q.notes)}</div>`);
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

    if (d?.context) parts.push(`<div class="md">${renderMarkdown(d.context)}</div>`);

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
      parts.push(`<div class="md">${renderMarkdown(s.markdown)}</div>`);
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
    if (state.scope === 'agent') {
      return `<div class="empty"><strong>Nothing live</strong>No open, claimed or blocked beads in any workspace.</div>`;
    }
    if (state.scope === 'both') {
      return `<div class="empty"><strong>Nothing live</strong>No questions, and no bead open anywhere.</div>`;
    }
    return `<div class="empty"><strong>Nothing to decide</strong>No open questions labelled <code>human</code>.${gearNudge()}</div>`;
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
      if (!only && state.logsDone.has(key)) continue;
      const [workspace, id] = [key.slice(0, key.indexOf('/')), key.slice(key.indexOf('/') + 1)];
      try {
        const data = await api(`/api/agent-log?workspace=${encodeURIComponent(workspace)}&id=${encodeURIComponent(id)}`);
        // The endpoint says whether an agent is still running. The read that first
        // sees it stopped is also the read that collects its last lines, so this
        // key can go quiet straight afterwards without losing the end of the run.
        if (data.running) state.logsDone.delete(key);
        else state.logsDone.add(key);
        const text =
          (data.lines || []).join('\n') ||
          (data.running
            ? 'No output yet — the agent is starting.'
            : 'No log for this bead — no agent has run on it.');
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

  function render(force = false) {
    if (!force && isAnswering()) {
      pendingRender = true;
      return;
    }
    pendingRender = false;
    const scrollY = window.scrollY;

    // Two levels of filter: space (work vs personal), then workspace within it.
    // With no spaces configured the first level is skipped entirely and this
    // behaves exactly as it did before.
    const inSpace =
      state.space === 'all'
        ? state.questions
        : state.questions.filter((q) => spaceOf(q) === state.space);
    const visible =
      state.workspace === 'all' ? inSpace : inSpace.filter((q) => q.workspace === state.workspace);

    if (!state.questions.length) {
      listEl.innerHTML = emptyHtml();
    } else if (!visible.length) {
      const where = state.workspace !== 'all' ? state.workspace : state.space !== 'all' ? state.space : '';
      listEl.innerHTML = `<div class="empty">Nothing waiting${where ? ` in ${esc(where)}` : ''}.${gearNudge()}</div>`;
    } else {
      // Anything you've already replied to sinks to the bottom. It is not waiting on
      // you any more — an agent has it — so it must not sit between you and the
      // questions that are. Order within each group is left exactly as the server
      // sent it (priority, then age).
      const waiting = visible.filter((q) => !q.awaitingAgent);
      const replied = visible.filter((q) => q.awaitingAgent);
      listEl.innerHTML = [...waiting, ...replied].map(cardHtml).join('');
    }

    renderFilters(inSpace);

    // innerHTML replacement collapses the page height for an instant; put the
    // reader back where they were rather than at the top of the list.
    if (scrollY) window.scrollTo(0, scrollY);

    openLinksInNewTab(listEl);
    drawDiagrams(listEl);
  }

  /* --------------------------------------------------------------- actions */

  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', bad);
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), bad ? 5000 : 2600);
  }

  const byKey = (key) => state.questions.find((q) => q.key === key);

  function disarm() {
    state.armed = null;
    clearTimeout(state.armedTimer);
  }

  async function submit(key, text, { close }) {
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
      await api(close ? '/api/respond' : '/api/comment', {
        method: 'POST',
        body: JSON.stringify(
          close ? { workspace: q.workspace, id: q.id, response: text } : { workspace: q.workspace, id: q.id, text }
        ),
      });
      clearDraft(key);
      if (close) {
        state.questions = state.questions.filter((x) => x.key !== key);
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
        toast(`Comment added — an agent will be told`);
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
    state.open.add(key);
    render(true);
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
      listEl
        .querySelector(`.card[data-key="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
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
        state.logsDone.delete(key);
      } else {
        state.logs.add(key);
        // Reopening must tail again even if the last run had finished — by now it
        // may be a second dispatch, against a second comment.
        state.logsDone.delete(key);
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
    if (key) setDraft(key, box.value);
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

  scopeDlg.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-scope]');
    if (!btn || btn.dataset.scope === state.scope) return;
    state.scope = btn.dataset.scope;
    localStorage.setItem('beadcause.scope', state.scope);
    paintScope();
    // The workspace filter was almost certainly pointing at the one workspace that
    // had a question in it; keeping it would hide everything the widening just let in.
    state.workspace = 'all';
    schedulePoll();
    state.questions = [];
    listEl.innerHTML = '<div class="empty">Asking bd…</div>';
    load();
  });

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
      // Keep any already-fetched detail so an open card doesn't flicker.
      const prev = new Map(state.questions.map((q) => [q.key, q]));
      state.questions = data.questions.map((q) => {
        const before = prev.get(q.key);
        if (!before) return q;
        // `agent` has to be reset before the merge, not left to it: a question
        // payload omits the field rather than sending false, so a bead that has
        // just gained the `human` label would otherwise keep rendering as
        // read-only agent work for as long as the tab stayed open.
        return Object.assign(before, { agent: false }, q);
      });
      state.spaces = data.spaces || [];
      // A space that has been renamed or removed in config would otherwise leave the
      // filter pinned to something that no longer exists, showing an empty list.
      if (state.space !== 'all' && !state.spaces.some((s) => s.name === state.space)) state.space = 'all';
      state.open = new Set([...openKeys].filter((k) => state.questions.some((q) => q.key === k)));
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
    await expand(key);
    const el = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
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

  // The one thing the page exposes to its host. The Android shell calls this when
  // you come back from the notification shade or a document, so the list is fresh
  // without a reload — a reload would discard scroll position and any draft sitting
  // in a textarea. render() still refuses to repaint mid-answer.
  window.beadcause = { refresh: load };

  /** The scope survives a reload — it is a preference, not a session detail. */
  function bootScope() {
    const saved = localStorage.getItem('beadcause.scope');
    if (SCOPES.includes(saved)) state.scope = saved;
    paintScope();
  }

  bootToken();
  bootScope();
  load();
})();
