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
    // `{ count, keys }` when narrowing the filter has left unread notifications on the
    // phone for beads it now excludes, else null. Server-decided, both halves: whether
    // to ask at all, and how many — see lib/ringing.js. Held here rather than drawn on
    // the spot because the prompt has to survive the 25s poll that lands while you are
    // reading it.
    dismissAsk: null,
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
    // Keys whose answer is written but not yet acknowledged. The card leaves the
    // list on the tap so the bead has somewhere to collapse into — but the bead is
    // still open on the server until the write lands, so a poll that overlapped the
    // write would put the card straight back underneath the flight. Held until the
    // write resolves either way; see submit().
    inFlight: new Set(),
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
    // Comments you have opened or shut by hand, as `${key}|${comment id}` → true
    // when shut. Only the exceptions live here; the default — the last thing each
    // side said, open, everything above it collapsed — is derived at render time by
    // openThreadIndexes(). Out here with the picks and the drafts for the same
    // reason they are: a 25-second poll rebuilds the list, and a comment you opened
    // to read must not fold up again underneath you.
    thread: new Map(),
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
    if (!state.token) needCredential();
  }

  /**
   * No token in this browser — which since Google sign-in is two situations, not one.
   *
   * The page may be perfectly authorised already: an httpOnly session cookie is
   * invisible to this script, so "no token" no longer means "no credential". Asking
   * the daemon is the only way to tell, and it is one unauthenticated request that
   * answers all three cases — signed in (do nothing, the cookie rides on every fetch),
   * sign-in configured but not done (go and do it), or no sign-in on this install at
   * all (the token dialog, exactly as before).
   *
   * Deliberately not awaited by the boot sequence. `load()` runs regardless, because
   * with a session cookie it will simply work, and holding the first paint on a round
   * trip that usually says "you are fine" is the wrong trade on a phone.
   */
  let asking = false;
  async function needCredential() {
    if (asking) return;
    asking = true;
    let who = null;
    try {
      who = await (await fetch('/auth/whoami', { headers: { accept: 'application/json' } })).json();
    } catch {
      /* the daemon is not answering — fall through to the dialog, which needs nobody */
    }
    asking = false;
    if (who?.signedIn) return;
    if (who?.google) {
      const here = location.pathname + location.search + location.hash;
      location.assign(`/login?next=${encodeURIComponent(here)}`);
      return;
    }
    askForToken();
  }

  function askForToken() {
    const dlg = $('#setup');
    // Two callers can reach this in one boot — bootToken and a 401 from the first
    // poll — and `showModal` on an open dialog throws, which surfaces as the list
    // failing to load rather than as anything about a token.
    if (dlg.open) return;
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
      // A stored token that the daemon refuses is worth forgetting. A 401 with no
      // stored token means the session cookie ended, and there is nothing to forget —
      // `needCredential` sends that browser back to sign in rather than showing it a
      // box for a token it was never using.
      if (state.token) localStorage.removeItem('beadcause.token');
      state.token = '';
      // Held payloads are somebody's inbox, and as of this refusal not provably
      // yours. Dropped before the sign-in prompt goes up, so nothing warms the next
      // page from a list the daemon has stopped agreeing to send.
      window.beadcause?.warm?.forget?.();
      needCredential();
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
  // A live microphone counts as answering even before the first word lands: the box
  // is still empty at that moment, and a poll-driven repaint would throw away the
  // textarea the dictation is aimed at — see public/dictate.js, which then has no
  // choice but to stop mid-sentence.
  const isAnswering = () =>
    isTyping() ||
    Boolean(window.beadcause?.dictation?.listening()) ||
    [...listEl.querySelectorAll('[data-role="answer"]')].some((t) => t.value.trim());

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
   * You have answered this bead before, and here it is again.
   *
   * **Above the options, and on the collapsed card as well as the open one.** Both
   * placements are the point. Answering closes the bead, so a card can only be here a
   * second time because something reopened it — and the card is rebuilt from the bead,
   * so it arrives carrying the same four options and no memory at all of what you
   * chose last time. The gesture that goes wrong is a two-tap answer from the list
   * without ever opening the card, which is why this cannot live in the brief or the
   * thread: by the time you would scroll to it, the answer has been sent. bc-goo.2 was
   * answered identically at 13:33 and 14:35 on 2026-08-09 exactly this way.
   *
   * It does not disable anything. Re-answering is often right — the bead may have come
   * back with something genuinely new to ask, and beadcause cannot tell the two apart —
   * so this states the fact and leaves the decision where it belongs.
   */
  function answeredBeforeHtml(q) {
    const b = q.answeredBefore;
    if (!b) return '';
    const when = relTime(b.at);
    const times = b.count > 1 ? ` · answered ${b.count} times already` : '';
    return `<div class="answered-before">
      <strong>⟳ You answered this${when ? ` ${when}` : ' before'}${times}</strong>
      ${b.response ? `<p>${esc(b.response)}</p>` : ''}
    </div>`;
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

  /**
   * Written from here, rather than by something on the other end.
   *
   * Every comment beadcause files carries `--actor beadcause` (see bd.js), so this
   * is exact rather than a guess — and it is the same test `.from-agent` has always
   * been painted from, which is why the collapse and the jump below agree with the
   * accent stripe down the side of the bubble. A comment typed into `bd` on the Mac
   * is somebody else's as far as this screen is concerned, because that is not a
   * message this app sent.
   */
  const fromMe = (c) => !c.author || c.author === 'beadcause';

  /** Enough of a collapsed comment to recognise it by, on one line. */
  const peek = (text) => {
    const flat = String(text || '')
      .replace(/\s+/g, ' ')
      .trim();
    return flat.length > 100 ? `${flat.slice(0, 100)}…` : flat;
  };

  /**
   * Which entries in a thread are open: the last thing I said, and the last thing
   * the other side said.
   *
   * A thread on a bead that has been round a few times is mostly history, and read
   * on a phone that history is what stands between you and the exchange you are
   * actually in. Two is the right number rather than one because the recent
   * exchange *is* a pair — the last reply only means something next to what it was
   * replying to — and the one from each side is what guarantees you get the pair
   * even when the last four comments are all an agent's.
   *
   * Returned as a Set of indexes. Indexes are safe as identity here because a
   * thread only ever gains entries at the end, and `state.thread` keys off the
   * comment's own uuid anyway; this is only about which ones start open.
   */
  function openThreadIndexes(comments) {
    const open = new Set();
    for (const mine of [true, false]) {
      for (let i = comments.length - 1; i >= 0; i--) {
        if (fromMe(comments[i]) === mine) {
          open.add(i);
          break;
        }
      }
    }
    return open;
  }

  /** A comment's identity for `state.thread`, which remembers what you opened. */
  const commentId = (key, c, i) => `${key}|${c.id || i}`;

  /**
   * Is this entry collapsed? Your own tap wins over the default, for as long as the
   * tab lives.
   *
   * It has to be state rather than a class left on the DOM: the list is rebuilt by
   * every 25-second poll, and a comment you opened to read closing again under a
   * background refresh is the same category of loss as a half-typed answer
   * disappearing. Toggling writes here and flips the class in place — never through
   * render(), for exactly that reason.
   */
  const isShut = (key, c, i, open) => state.thread.get(commentId(key, c, i)) ?? !open.has(i);

  /**
   * One message in a bead's thread. Shared with the agent-bead card, which has a
   * thread but no decision and nothing to answer.
   *
   * The author line is the toggle. A separate chevron button would be a second tap
   * target on a bubble whose whole point is the one sentence inside it, and the line
   * saying who and when is already the thing your eye uses to decide whether this is
   * the comment you were looking for — so it is what you press. The body stays in
   * the DOM while collapsed (hidden by CSS) so opening it costs no re-render, and
   * `data-mine` is on the element because the jump below has to find the last one.
   */
  function commentHtml(c, { shut = false, key = '', i = 0 } = {}) {
    const mine = fromMe(c);
    return `<div class="comment${mine ? '' : ' from-agent'}${shut ? ' shut' : ''}"${
      mine ? ' data-mine="1"' : ''
    } data-comment="${esc(commentId(key, c, i))}">
      <button class="who" type="button" data-act="comment" aria-expanded="${!shut}">
        <span class="caret" aria-hidden="true"></span>
        <span class="who-name">${esc(c.author || 'you')} · ${esc(relTime(c.created_at))}</span>
        <span class="peek">${esc(peek(c.text))}</span>
      </button>
      <div class="md">${renderMarkdown(c.text || '')}</div>
    </div>`;
  }

  /** A whole thread, with everything but the recent exchange collapsed. */
  function threadHtml(q) {
    const comments = q.comments || [];
    const open = openThreadIndexes(comments);
    return comments
      .map((c, i) => commentHtml(c, { shut: isShut(q.key, c, i, open), key: q.key, i }))
      .join('');
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

  /**
   * "This already exists" — outside the fold, deliberately.
   *
   * Every other field on a row lives in `.prop-body`, which a long row starts folded
   * (see below). This one cannot: it is the only thing on the card that changes what
   * ✓ *means*, and a warning you have to tap "Show the rest" to find is a warning that
   * arrives after the decision. It is stamped on by lib/dupe.js when the proposal is
   * written, and it rides through the stored bead in the `beadproposal` block, so what
   * is drawn here is what the server itself would find.
   */
  function dupeHtml(b) {
    const d = b.duplicate;
    if (!d?.id) return '';
    const where = d.status === 'proposed' ? 'already proposed in' : `already ${esc(d.status)} as`;
    return `<div class="prop-dupe">
      <span class="prop-dupe-flag">Possible duplicate</span>
      <span>${where} <span class="pill id">${esc(d.id)}</span>${d.title ? ` — ${esc(d.title)}` : ''}</span>
    </div>`;
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
            ${dupeHtml(b)}
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
        ${shipHtml(q, d, live)}
        <button class="secondary" data-act="pr-changes" data-key="${esc(q.key)}">Request changes</button>
        <button class="linkish danger" data-act="pr-decline" data-key="${esc(q.key)}">Decline it</button>
      </div>`
      }
    </div>`;
  }

  /**
   * The repo's deploy, if it has one — offered here, on the card, or not at all.
   *
   * Merging is the same act in every repo; deploying is not. beadcause restarts under
   * launchd, sophab runs `fly deploy`, most repos have no declaration at all — so the
   * option only exists when the worker that filed this card found one, and the button
   * says what that deploy will actually run rather than promising "deploy" and meaning
   * something different per repo. See lib/deploy.js and `deployHint`.
   *
   * Read out of the decision block rather than out of the `beadpr` block, because the
   * decision block is the list of answers this card offers and this is one of them:
   * the same list an ntfy action button sends from, so the phone and the notification
   * cannot come to different conclusions about whether Ship exists. The response text
   * is built here for the same reason `pr-merge` builds its own — the server consents
   * on the marker, and this card has just re-read GitHub.
   */
  function shipOptionFor(q) {
    return (q?.decision?.options || []).find((o) => o.id === 'ship') || null;
  }

  function shipHtml(q, d, live) {
    const opt = shipOptionFor(q);
    if (!opt) return '';
    const armed = state.armed === `${q.key}|ship`;
    return `<button class="secondary pr-ship${armed ? ' confirm' : ''}" data-act="pr-ship" data-key="${esc(q.key)}"
      ${live?.pr && !canMerge(live.pr) ? 'disabled' : ''}>
      <span class="pr-ship-do">${armed ? 'Tap again to confirm · ' : ''}Ship #${d.number}</span>
      <span class="pr-ship-what">${esc(shipWhat(opt))}</span>
    </button>`;
  }

  /** The hint, minus the backticks — this is a button, not a paragraph of markdown. */
  const shipWhat = (opt) => String(opt?.hint || 'merge, then deploy').replace(/`/g, '');

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
    // GitHub's own three words for the three methods. The fallback used to be
    // `${d.method} and merge`, which read as "merge and merge #42" for the plain merge
    // commit — fine while `squash` was the default and the label on nearly every card
    // once it stopped being (see `pr.mergeMethod`).
    const how = { squash: 'Squash and merge', rebase: 'Rebase and merge' }[d.method] || 'Merge';
    return `${how} #${d.number}`;
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
    // Ship arms and disables on exactly the same facts as merge, because it *is* the
    // merge plus a deploy — a PR GitHub will not take is not one to ship either.
    const ship = block.querySelector('.pr-ship');
    if (ship) {
      ship.disabled = Boolean(live?.pr && !canMerge(live.pr));
      const armed = state.armed === `${key}|ship`;
      const doing = ship.querySelector('.pr-ship-do');
      if (doing) doing.textContent = `${armed ? 'Tap again to confirm · ' : ''}Ship #${q.delivery.number}`;
      ship.classList.toggle('confirm', armed);
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
    // Empty where no microphone can work at all — see public/dictate.js — which is
    // also the case that decides whether the strip is worth drawing: with no roster
    // *and* no mic it has nothing in it, and used to be hidden for exactly that
    // reason.
    const mic = window.beadcause?.dictation?.buttonHtml({ label: 'Dictate this answer' }) || '';
    return `<div class="reply-bar"${state.agents.length || mic ? '' : ' hidden'}>
      <span class="reply-who">${replyLineHtml(chosen)}</span>
      ${mic}
      <div class="agent-wrap"${state.agents.length ? '' : ' hidden'}>
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
      // A roster that never loaded leaves no chooser — the server falls back to its
      // default agent exactly as it did before any of this existed. The strip itself
      // survives that if there is a mic in it, because dictating an answer has
      // nothing to do with which agent picks it up.
      const wrap = bar.querySelector('.agent-wrap');
      if (wrap) wrap.hidden = !state.agents.length;
      bar.hidden = !state.agents.length && !bar.querySelector('.mic');
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
        //
        // The recommended tag is a *sibling* of `.label`, never inside it, because
        // paintArmed writes `label.textContent` — a badge nested in there would
        // survive until the first tap and then silently vanish.
        return `<button class="option${o.recommended ? ' rec' : ''}${
          armed ? ' confirm' : ''
        }" data-act="option" data-key="${esc(q.key)}" data-opt="${esc(o.id)}" data-label="${esc(o.label)}">
          <span class="label">${armed ? 'Tap again to confirm · ' : ''}${esc(o.label)}</span>
          ${o.recommended ? '<span class="rec-tag">★ recommended</span>' : ''}
          ${
            // A sibling of `.label` for the same reason the star is — paintArmed
            // writes label.textContent, and anything nested in there is gone on the
            // first tap. Worth saying before the tap rather than only in the toast
            // after it: this option is an instruction, and the bead stays open.
            o.closes === false ? '<span class="hand-tag">↪ commissions the work</span>' : ''
          }
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
      ${answeredBeforeHtml(q)}
      ${proposalHtml(q)}
      ${deliveryHtml(q)}
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
      ${open ? freeformHtml(q) : ''}
    </article>`;
  }

  /**
   * The answer box: who replies, what you type, and the two things you can do with it.
   *
   * A sibling of `.brief`, not the last thing inside it. That is the whole point: an
   * open card is a fixed head, a brief that scrolls on its own, and this pinned to
   * the bottom (see .card.open in style.css, and .console-body, which is the same
   * three-part shape). Inside the brief it was several screens below the fold on any
   * bead with a real description — you read down, scrolled back to reply, and every
   * glance back at the details lost the box again.
   *
   * The reply bar comes with it, and belongs with it: the ⋯ chooses who answers
   * *this* box, so a strip on the box's own top edge is the one place it can be that
   * stays true when the box stops scrolling with the thread above it.
   *
   * On a delivery the box has one job, which job depending on what you tapped to get
   * here — so it says which. A button labelled "Answer & close" over a pull request
   * invites a sentence that reads like approval and lands as a rejection.
   *
   * **A close bd will refuse is not offered at all.** `/api/question` now says
   * whether this bead is gated (an epic with open children, or something still
   * blocking it), so the primary button is simply not drawn and the comment takes
   * its place — see gateWhyHtml for what stands in for it. A button that cannot do
   * what its label says is worse than no button: the old shape took the answer you
   * typed, took the press, and only then said the tracker was never going to allow
   * it, which is a lot of work to be told no.
   *
   * Only rendered for an open card, which is also what the landscape split keys off:
   * `.card:has(> .brief:not([hidden]))`.
   */
  function freeformHtml(q) {
    const declining = q.delivery && state.prDecline.has(q.key);
    // Only the plain answer path. A delivery's buttons are about a pull request and
    // carry their own machinery, and `closeGate` already on the card means a refusal
    // has just been reported in full above — a second telling under it would be the
    // card saying the same thing twice.
    const gated = !q.delivery && !q.closeGate ? q.gate : null;
    const boxPlaceholder = declining
      ? 'Optional — what should the next attempt do instead?'
      : q.delivery
      ? 'What needs changing before this can merge…'
      : gated
      ? 'Say something on the thread…'
      : 'Answer in your own words…';
    const boxLabel = declining
      ? `Decline #${q.delivery.number} &amp; close`
      : q.delivery
      ? 'Request changes &amp; close'
      : 'Answer &amp; close';
    return `<div class="freeform${declining ? ' declining' : ''}">
      ${replyBarHtml(q.key)}
      ${gateNoteHtml(q)}
      ${gated ? gateWhyHtml(q, gated) : ''}
      ${declining ? '' : suggestedHtml(q)}
      <textarea data-role="answer" placeholder="${boxPlaceholder}" rows="3">${esc(getDraft(q.key))}</textarea>
      <div class="row">
        ${
          gated
            ? ''
            : `<button class="primary${declining ? ' danger' : ''}" data-act="${
                declining ? 'pr-decline-go' : 'answer'
              }" data-key="${esc(q.key)}">${boxLabel}</button>`
        }
        <button class="${gated ? 'primary' : 'secondary'}" data-act="note" data-key="${esc(q.key)}">${
      gated ? 'Comment' : 'Comment only'
    }</button>
      </div>
      ${declining ? '' : dismissHtml(q)}
    </div>`;
  }

  /**
   * Why this card has no *Answer & close* — said before you type, not after.
   *
   * The quiet twin of gateNoteHtml below. That one is a refusal: you pressed, the
   * tracker said no, and it has buttons because something has to happen to the
   * words you had already written. This one is a fact about the bead, standing where
   * the button would have been, so it has nothing to offer and nothing to dismiss —
   * the comment underneath is the whole offer.
   *
   * The children are named and linked for the same reason as in the refusal: "an
   * epic with four open children" with no ids is a dead end, and the way out of it
   * starts with reading them.
   */
  function gateWhyHtml(q, gate) {
    const until = gate.kind === 'epic' ? 'its children are closed' : 'its blockers are closed';
    return `<div class="gate-why">
      <strong>${esc(q.id)} can't be closed from here — ${esc(gate.reason)}</strong>
      <p>A comment is what this box can do; it stays on the thread and the bead closes when ${until}.</p>
      ${gateBlockersHtml(q, gate)}
    </div>`;
  }

  /** The beads behind a gate, as links into the graph. Shared by both gate blocks. */
  function gateBlockersHtml(q, gate) {
    const blockers = (gate.blockers || [])
      .map(
        (b) =>
          `<a class="pill id" href="${esc(graphUrl({ workspace: q.workspace, id: b.id }))}&amp;open=1"
            target="_blank" rel="noopener" title="${esc(b.title || '')}">${esc(b.id)}</a>`
      )
      .join(' ');
    return blockers ? `<div class="gate-blockers">${blockers}</div>` : '';
  }

  /**
   * The answers this question looks like it has, when nobody wrote it any.
   *
   * A `decision` block gets `.options`: full-width buttons above the fold that
   * answer and close on two taps, because an agent wrote the sentence each one
   * sends. These are the other case — lib/suggest.js read them out of the prose —
   * and three things follow from that difference.
   *
   * **They live in the answer box, not above the card.** Their whole job is to
   * save you typing into the box under them, and a chip several screens away from
   * the thing it fills is a chip you have to scroll back from to check.
   *
   * **They are chips, not buttons.** The visual weight has to say which kind of
   * thing this is without a word of explanation, and `.options` already owns the
   * shape that means "this closes the bead".
   *
   * **A tap fills; it never sends.** The words came out of a paragraph rather than
   * out of an agent's `response:` field, so they go where you can read and edit
   * them, and *Answer & close* is still the thing that commits them. One tap, no
   * arming: filling a box you are looking at is not a gesture that needs guarding.
   *
   * Only ever drawn on an open card, which is the same as saying you have had the
   * chance to read the brief the chips were lifted from.
   */
  function suggestedHtml(q) {
    const options = q.suggested?.options || [];
    if (!options.length) return '';
    const draft = getDraft(q.key).trim();
    return `<div class="suggested" data-key="${esc(q.key)}">
      <div class="section-label">Suggested · from the ${esc(q.suggested.from)} <span>tap to fill the box</span></div>
      <div class="chips">${options
        .map(
          (o) => `<button class="chip${o.recommended ? ' rec' : ''}" data-act="suggest" data-key="${esc(
            q.key
          )}" data-opt="${esc(o.id)}" aria-pressed="${draft === o.response.trim()}"
            title="${esc(o.response)}">${o.recommended ? '<span class="star">★</span>' : ''}${esc(o.label)}</button>`
        )
        .join('')}</div>
    </div>`;
  }

  /**
   * The third thing you can do with a question: set it aside.
   *
   * Under the two buttons rather than beside them, and quiet. Three equal buttons in
   * one row on a 360px phone leaves "Answer & close" too narrow to fit its own label,
   * and the ranking is real anyway — this is the rare one. Same reasoning as the
   * decline link on a delivery: last, centred, and never where a thumb lands by
   * accident.
   *
   * **It no longer closes the bead**, and the label is where that has to be visible.
   * It used to say *closes `dv-gr6` unanswered*, which was both a promise the tracker
   * would refuse — an epic with thirty open children cannot be closed — and the wrong
   * intent: "I am not dealing with this now" is not "this is decided". So the second
   * tap says what actually happens, which is that the card leaves the inbox and the
   * bead does not move. Still two taps, because a card sitting open in a pocket must
   * not be cleared by a stray thumb, and still `.danger`-coloured, because it is the
   * one button here that makes something disappear.
   */
  function dismissHtml(q) {
    const armed = state.armed === `${q.key}|dismiss`;
    return `<button class="linkish danger dismiss${armed ? ' confirm' : ''}" data-act="dismiss"
      data-key="${esc(q.key)}" data-id="${esc(q.id)}">${esc(dismissLabel(q.key, q.id, armed))}</button>`;
  }

  /** What the dismiss button says, given the draft under it and whether it is armed. */
  const dismissLabel = (key, id, armed) => {
    const noted = Boolean(getDraft(key).trim());
    // "Hides", never "closes": the bead stays exactly as open as it was, and the one
    // thing this label must not do is imply the question has been dealt with.
    if (armed) return `Tap again — hides ${id}${noted ? ', with your note on the thread' : ''}`;
    return noted ? 'Set aside with this note' : 'Set aside for now';
  };

  /**
   * bd will not close this bead — said on the card, over the box you typed in.
   *
   * The two gates are the tracker's, not beadcause's: a bead blocked by open
   * dependencies, and an epic with open children. Neither is a fault and neither
   * is anything you can fix from a phone, so this is not an error — it is the
   * screen saying which half of *Answer & close* is available and offering it.
   *
   * It has to live on the card rather than in a toast. A toast is gone in three
   * seconds, and the one thing that must not happen here is you concluding the
   * answer was lost and typing it again — which is exactly how five beads ended up
   * carrying the same answer three times over. Your draft is still in the box
   * underneath, untouched, for the same reason.
   *
   * The beads behind it are named and linked, because "blocked by open issues" with
   * no ids is a dead end, and the fix — close those first — starts with reading them.
   *
   * **This is now the rare path, not the ordinary one.** A gate the card already knew
   * about when it opened draws no answer button at all (gateWhyHtml), so what is left
   * to arrive here is a gate that appeared in between: a child reopened, a blocker
   * filed while you were reading. The card is minutes old by then, and the refusal is
   * the only thing that can say so.
   *
   * **Answering and dismissing both land here**, because both of them close the bead
   * and bd gates the close, not the reason for it. What differs is the offer. An
   * answer always has something worth keeping, so it is always offered; a dismissal
   * is usually wordless — *Dismiss without answering* is the ordinary case — and a
   * "Save as a comment" button over an empty box would save nothing and say it had.
   * The server decides which, in `canComment`, because it is the side that knows
   * whether a note came with the request.
   */
  function gateNoteHtml(q) {
    const gate = q.closeGate;
    if (!gate) return '';
    const verb = gate.from === 'dismiss' ? 'dismissed' : 'closed';
    const until = gate.kind === 'epic' ? 'its children are' : 'its blockers are';
    const offer = gate.canComment !== false;
    return `<div class="gate-note">
      <strong>${esc(q.id)} cannot be ${verb} — ${esc(gate.reason)}</strong>
      <p>Nothing has been written. ${
        offer
          ? `Save what you typed as a comment and it stays on the thread; the bead stays open until ${until} closed.`
          : `The bead stays open until ${until} closed. Close ${
              gate.kind === 'epic' ? 'the children' : 'the blockers'
            } and this one goes with them.`
      }</p>
      ${gateBlockersHtml(q, gate)}
      <div class="row">
        ${offer ? `<button class="primary" data-act="gate-comment" data-key="${esc(q.key)}">Save as a comment</button>` : ''}
        <button class="${offer ? 'secondary' : 'primary'}" data-act="gate-dismiss" data-key="${esc(
      q.key
    )}">${offer ? 'Not now' : 'OK'}</button>
      </div>
    </div>`;
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
      parts.push(`<div class="comments">${threadHtml(q)}</div>`);
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
        `<div class="comments">${threadHtml(q)}${working ? pendingHtml(working) : ''}</div>`
      );
    }

    // The answer box used to come next, at the very end of this brief — the thread
    // running straight into the box you answer it in. It is a sibling of the brief
    // now, pinned to the bottom of the card (see freeformHtml), so the thread runs
    // into the *edge* of that box instead and the run-on is kept by position rather
    // than by order. What follows here is the tail of the scrolling body only.

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
  const widenNudge = () =>
    state.scope === 'human' ? ' Tap <b>Both</b> above to include the work agents are on.' : '';

  function emptyHtml() {
    // "Nothing to decide" printed directly under a pane saying an agent is asking to
    // be changed is the app contradicting itself. The empty state is about the
    // questions feed, so when the other channel has something in it, say which
    // emptiness this is.
    if ((state.requests || []).length) {
      return `<div class="empty">Nothing about work is waiting.${widenNudge()}</div>`;
    }
    if (state.scope === 'agent') {
      return `<div class="empty"><strong>Nothing live</strong>No open, claimed or blocked beads in any workspace.</div>`;
    }
    if (state.scope === 'both') {
      return `<div class="empty"><strong>Nothing live</strong>No questions, and no bead open anywhere.</div>`;
    }
    return `<div class="empty"><strong>Nothing to decide</strong>No open questions labelled <code>human</code>.${widenNudge()}</div>`;
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

  /**
   * "You have just hidden three beads that are still buzzing on your phone."
   *
   * Narrowing the filter silences what comes next, and used to say nothing about the
   * notifications already sitting unread for the beads it now excludes — which are
   * exactly the ones you have just decided not to think about.
   *
   * Three things about the shape:
   *
   * - **It asks; it does not act.** Clearing notifications you did not ask to have
   *   cleared is the kind of silent tidying that makes an inbox untrustworthy, and
   *   the count is in the sentence because "some" is not enough to decide on.
   * - **Both buttons are answers**, and *Leave them* is not a cancel: it is recorded,
   *   which is what stops the next poll asking again. So neither is styled as the
   *   dangerous one — there is nothing to undo either way.
   * - **It is drawn inside `#list`**, above the foundation channel, for the same
   *   reason that channel is: every handler on this page is delegated from that
   *   element, so a pane in a sibling container would render and do nothing.
   *
   * Nothing here says "dismissed" or "answered" about the beads, because none of that
   * is true: they stay open, unanswered and in the inbox, and widening the filter
   * brings them straight back.
   */
  function dismissAskHtml() {
    const ask = state.dismissAsk;
    if (!ask?.count) return '';
    const n = ask.count;
    const many = n !== 1;
    return `<section class="shade-ask" aria-label="Unread notifications the filter excludes">
      <header>
        <span class="shade-icon" aria-hidden="true">🔔</span>
        <div>
          <h2>${n} unread notification${many ? 's' : ''} for bead${many ? 's' : ''} this filter hides</h2>
          <p>Clearing them touches the phone and nothing else — the bead${many ? 's stay' : ' stays'}
            open and unanswered, and ${many ? 'they come' : 'it comes'} back when you widen the filter.</p>
        </div>
      </header>
      <div class="shade-actions">
        <button class="primary" data-act="shade-clear">Clear ${many ? 'them' : 'it'}</button>
        <button class="secondary" data-act="shade-leave">Leave ${many ? 'them' : 'it'}</button>
      </div>
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

    // The tabs live at the foot of every page, but only this one has the numbers:
    // they ride the inbox's poll. A page that never sets a badge shows none, which
    // is better than a number it has no way to refresh.
    //
    // One badge, and it is the proposals. A badge means *needs you* — that is what
    // makes it worth putting a number on a tab you are not looking at — and a running
    // agent needs nothing; it is a fact about the machine. `summary.sessions` is still
    // served and still worth reading, and it is read on the page itself, in the
    // advocate console's tally ("N working · M to answer"), where it sits beside the
    // repo it belongs to instead of standing for every repo at once.
    const badge = window.beadcause?.tabBadge;
    if (!badge) return;
    const proposals = Number(s.proposals) || 0;
    badge('advocates', proposals, `Advocates — ${proposals} proposal${proposals === 1 ? '' : 's'} waiting`);
  }

  /**
   * Repaint the armed option in place. Cheap, and never touches the textarea.
   *
   * Every armable control on the list is painted here, not just the one that was
   * tapped — arming any of them disarms the others, and a dismiss button left
   * reading "Tap again" after an option stole the arm would be a lie about what the
   * next tap does.
   */
  function paintArmed() {
    for (const btn of listEl.querySelectorAll('.option')) {
      const armed = state.armed === `${btn.dataset.key}|${btn.dataset.opt}`;
      btn.classList.toggle('confirm', armed);
      const label = btn.querySelector('.label');
      if (label) label.textContent = (armed ? 'Tap again to confirm · ' : '') + btn.dataset.label;
    }
    for (const btn of listEl.querySelectorAll('.dismiss')) {
      const armed = state.armed === `${btn.dataset.key}|dismiss`;
      btn.classList.toggle('confirm', armed);
      btn.textContent = dismissLabel(btn.dataset.key, btn.dataset.id, armed);
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

  /**
   * Light the suggested chip whose words are currently in the box, and only that
   * one. Derived from the text rather than remembered from the tap, so it stays
   * true after a keystroke, after a draft is restored on reopening a card, and
   * after two chips in a row.
   */
  function paintSuggested(key, text) {
    const block = listEl.querySelector(`.suggested[data-key="${CSS.escape(key)}"]`);
    if (!block) return;
    const options = byKey(key)?.suggested?.options || [];
    const now = String(text ?? '').trim();
    for (const chip of block.querySelectorAll('.chip')) {
      const opt = options.find((o) => o.id === chip.dataset.opt);
      chip.setAttribute('aria-pressed', String(Boolean(opt) && opt.response.trim() === now));
    }
  }

  /** Which space a question belongs to. Unassigned workspaces collect under "Other". */
  const spaceOf = (q) => q.space || 'Other';

  /**
   * The scope chips. The third column is what the settings panel used to spell out
   * under the switch; it rides along as the chip's `title` and its accessible name,
   * because three one-word chips are not self-explanatory and there is no longer a
   * paragraph of prose to put it in.
   */
  const SCOPE_CHIPS = [
    ['human', 'Human', 'Beads labelled human — the ones asking you something. This is the inbox.'],
    ['both', 'Both', 'Questions first, then every bead that is open, claimed or blocked.'],
    ['agent', 'Agent', 'Only what the agents are on: every live bead that is not a question.'],
  ];

  const scopeRowHtml = () =>
    `<div class="chip-row scopes" role="group" aria-label="Which beads to list">` +
    SCOPE_CHIPS.map(
      ([id, label, note]) =>
        `<button class="chip" data-scope="${id}" aria-pressed="${state.scope === id}" title="${esc(
          note
        )}" aria-label="${esc(`${label} — ${note}`)}">${label}</button>`
    ).join('') +
    `</div>`;

  /**
   * The scope row, and only the scope row.
   *
   * There used to be three rows here, coarsest first: which slice of the tracker, then
   * which space, then which workspace within it. The bottom two are the space picker in
   * the top bar now (public/spacebar.js) — they were the inbox's private copy of a
   * choice that four other pages were each making their own way, and this page was the
   * only one where it was visible at all.
   *
   * What is left is genuinely a different kind of control, which is why it stayed: the
   * scope decides what gets *fetched* — questions, or every live bead — while the picker
   * decides which repo any of it is about. Two axes, and only one of them belongs to the
   * whole app.
   */
  function renderFilters() {
    // Unconditional, so the nav no longer hides itself.
    filtersEl.hidden = false;
    filtersEl.innerHTML = scopeRowHtml();
  }

  /**
   * Hand the picker the numbers this page has just fetched.
   *
   * The inbox is the one page that sweeps the tracker, so its counts are fresher than
   * /api/spaces can be — and they are counted over the *scope* on screen, which is what
   * makes the picker agree with the list under it when you are looking at `Both`. The
   * filter is handed over too, because this payload is also how a change made on the
   * laptop reaches the phone.
   */
  function publishSpaces(data) {
    const counts = {};
    for (const q of state.questions) counts[q.workspace] = (counts[q.workspace] || 0) + 1;
    window.beadcause?.space?.adopt({
      spaces: state.spaces,
      // Configured workspaces, not the ones with something in them: the picker is how
      // you reach a quiet repo.
      workspaces: Array.isArray(data.workspaces) ? data.workspaces : undefined,
      counts,
      filter: data.filter,
    });
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

  /* ----------------------------------------------------- keeping your place */

  /**
   * Where the reader was, stored as "this element, this far down the screen"
   * rather than as a scroll offset — and applied to the element that actually
   * scrolls, which is usually not the window.
   *
   * An open card is `position: fixed; inset: 0` (see .card.open): it takes the whole
   * screen and scrolls its own contents — its `.brief`, once the answer box was
   * pinned below it, or the card itself on a viewport too short for that — so
   * `window.scrollY` is 0 the entire time a brief is being read. Rebuilding the list
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
   * Does this element scroll its own contents? Asking rather than assuming is what
   * keeps this honest across the three shapes a card can take: the fixed layer whose
   * brief scrolls, the same layer scrolling whole on a short viewport, and a plain
   * row in the list that scrolls with the page.
   */
  const scrolls = (el) =>
    el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY);

  /**
   * Which part of a card is the scroller, named rather than measured.
   *
   * Named, because the answer is needed twice: once before the rebuild, where the
   * card is fully laid out and can be measured, and once after, where it is at its
   * shortest and would measure as scrolling nothing. Capture decides, restore obeys.
   */
  const SCROLLER_IN = { card: (card) => card, brief: (card) => card.querySelector(':scope > .brief') };
  const scrollerOf = (card) => {
    if (scrolls(card)) return 'card';
    const brief = SCROLLER_IN.brief(card);
    return brief && scrolls(brief) ? 'brief' : null;
  };

  function capturePlace() {
    const place = {
      gen: ++placeGen,
      docTop: docScroller().scrollTop,
      key: null,
      self: null,
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
    place.self = scrollerOf(anchor);
    const scroller = place.self ? SCROLLER_IN[place.self](anchor) : docScroller();
    place.key = anchor.dataset.key;
    place.scrollTop = scroller.scrollTop;
    place.top = anchor.getBoundingClientRect().top;

    // Then down into it, by child index, to the deepest thing still starting above
    // the fold. The card alone is not a fine enough anchor for a long brief: a
    // diagram inside it and above where you are reading grows after the repaint,
    // and everything under it — the paragraph you were on included — slides down by
    // that diagram's height while the card's own top never moves.
    //
    // Measured from the top of the *scroller*, which is no longer the top of the
    // card: with the head fixed and only the brief scrolling, a fold at the card's
    // top matches the head every time and the descent never reaches the brief at all.
    const fold = (place.self ? scroller.getBoundingClientRect().top : 0) + ANCHOR_SLOP;
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

    // The rebuilt card may no longer have the part that was scrolling — a brief
    // collapsed since the capture. A card offset written onto the document would
    // scroll the list to somewhere nobody asked for, so leave the page where the
    // docTop above put it.
    const scroller = place.self ? SCROLLER_IN[place.self](card) : docScroller();
    if (!scroller) return;
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

  // The card that has just been opened, waiting for the render that will draw it.
  // One shot, set by expand() and consumed by render().
  let openOn = '';

  /**
   * A card just opened: start it on the last thing I said.
   *
   * The top of a card is the question, and the question is the part you already know
   * — it is why you opened it. What you have lost is the conversation: what you asked
   * for last time, and what came back. So an opening card lands on your last message,
   * with the reply to it just below, and the description scrolled up out of the way
   * but still there when you swipe back.
   *
   * Only on the way in. A card already open stays exactly where the reader put it —
   * capturePlace/restorePlace exist to guarantee that, and a poll that jumped you
   * back down to your own comment every 25 seconds would undo them.
   *
   * Re-run as the layout settles, for the same reason restorePlace is: mermaid draws
   * after the repaint, and every diagram above the thread pushes it further down than
   * it was when we measured.
   */
  function jumpToMine(key, drawn) {
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    const target = [...(card?.querySelectorAll('.comment[data-mine]') || [])].pop();
    // Nothing of mine on this thread — a question I have not answered yet, which is
    // the common case. The top of the card is right for that one.
    if (!target) return;
    const go = () => {
      // Asked each time rather than once: straight after the repaint the card is at
      // its shortest and may not be overflowing yet, and nothing that does not
      // overflow needs scrolling — everything in it is already on screen.
      const self = scrollerOf(card);
      const scroller = self ? SCROLLER_IN[self](card) : null;
      if (!scroller) return;
      const delta = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - ANCHOR_SLOP;
      scroller.scrollTop += delta;
    };
    // This scroll is the point of opening the card, so it outranks the restore that
    // the same render() has just queued — exactly as the collapse button does.
    releasePlace();
    go();
    requestAnimationFrame(go);
    drawn.then(go).catch(() => {});
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

  /**
   * Draw the keyed chunks, through the reconciler when there is one.
   *
   * The fallback is the whole-list `innerHTML` this used to do unconditionally, and
   * it is not dead code: `warm.js` is a separate file, and a phone holding a service
   * worker from before it existed loads this page without it. That phone gets the
   * inbox exactly as it had it last week rather than a blank list, which is the only
   * acceptable way for a speed-up to be missing.
   */
  function paintList(chunks) {
    const warm = window.beadcause?.warm;
    if (warm?.paint) warm.paint(listEl, chunks);
    else listEl.innerHTML = chunks.map((c) => c.html).join('');
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
    // Above even that, and above the empty state especially: narrowing the filter to
    // something with nothing in it is the most likely way to get here, and the pane
    // asking about the notifications you just hid must not be the thing that is missing
    // from an otherwise empty screen.
    // The list as keyed chunks rather than one string, because what gets drawn from
    // here is a reconcile: `warm.paint` replaces only the chunks whose HTML actually
    // differs and leaves the rest of the DOM alone. On a 25-second poll where one
    // bead moved, that is one card rebuilt instead of forty — and, more to the point,
    // it is forty rendered mermaid diagrams, one open ⋮ menu and the caret in a
    // textarea that never have to be put back, because they were never taken away.
    //
    // The `@` keys are the panes that are not beads. A bead key is `workspace/id` and
    // can never begin with one, so the two namespaces cannot collide.
    const chunks = [];
    const ask = dismissAskHtml();
    if (ask) chunks.push({ key: '@shade', html: ask });
    const reqs = requestsHtml();
    if (reqs) chunks.push({ key: '@requests', html: reqs });

    if (!state.questions.length) {
      chunks.push({ key: '@empty', html: emptyHtml() });
    } else if (!visible.length) {
      const where = state.workspace !== 'all' ? state.workspace : state.space !== 'all' ? state.space : '';
      chunks.push({
        key: '@empty',
        html: `<div class="empty">Nothing waiting${where ? ` in ${esc(where)}` : ''}.${widenNudge()}</div>`,
      });
    } else {
      // Anything you've already replied to sinks to the bottom. It is not waiting on
      // you any more — an agent has it — so it must not sit between you and the
      // questions that are. Order within each group is left exactly as the server
      // sent it (priority, then age).
      const waiting = visible.filter((q) => !q.awaitingAgent);
      const replied = visible.filter((q) => q.awaitingAgent);
      for (const q of [...waiting, ...replied]) chunks.push({ key: q.key, html: cardHtml(q) });
    }
    paintList(chunks);

    paintRequestBadge();
    paintSummary();
    renderFilters();
    // The live half of any delivery on screen. `ensurePr` is a no-op for a card it
    // has already fetched, so this costs one GitHub round trip per pull request for
    // the life of the tab, not one per render.
    for (const q of visible) if (q.delivery) ensurePr(q);

    openLinksInNewTab(listEl);
    const drawn = drawDiagrams(listEl);
    // Puts the caret and the scroll position back — immediately, and again as the
    // diagrams and images size themselves afterwards.
    settlePlace(place, drawn);
    // Unless a card has just been opened, in which case where to be is not where you
    // were — it is the last thing you said on the thread. One shot: cleared here so
    // the next poll's repaint restores your place like any other.
    if (openOn) {
      const key = openOn;
      openOn = '';
      jumpToMine(key, drawn);
    }
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
   *
   * `dismiss` rides on `close` rather than replacing it: a dismissal closes the bead
   * and takes the card out of the list in exactly the same way, so every piece of the
   * optimistic dance above — the flight, the removal, the restore on failure — is the
   * same code. All that differs is which route it goes to and what the toast says.
   */
  async function submit(key, text, { close, dismiss = false, create = null, edits = null, option = null, onRestore = null }) {
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
    //
    // A dismissal absorbs too, and that is not the same lie: the mark is the inbox,
    // not the tracker, and the card genuinely is leaving it. The bead stays open,
    // which is what the toast underneath says and what brings the card back later.
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
      const res = await api(dismiss ? '/api/dismiss' : close ? '/api/respond' : '/api/comment', {
        method: 'POST',
        body: JSON.stringify(
          dismiss
            ? // Whatever was in the box, if anything. Sent as `reason` rather than as
              // `response` so it can never be mistaken for an answer by a route that
              // reads markers out of one — a dismissal must not merge a pull request.
              { workspace: q.workspace, id: q.id, reason: text }
            : close
            ? {
                workspace: q.workspace,
                id: q.id,
                response: text,
                // Explicit, rather than leaving the server to read the numbers back
                // out of the sentence: the text is for you, the array is for it.
                ...(create ? { create } : {}),
                // Which button was pressed, for the one thing the sentence cannot
                // say: whether this answer commissions work rather than settling it.
                // Sent as the id and read back off the bead server-side — the card
                // in front of you may be a poll old, and only the bead knows.
                ...(option ? { option } : {}),
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
        // The dismissal toast says when it comes back, because a card that vanishes
        // with "Dismissed" on screen reads as gone for good — and it is not. The
        // server names the condition it is waiting on; without one, a new comment
        // is what brings it back.
        toast(
          dismiss
            ? `${q.id} set aside — back when ${res?.until ? `${res.until} clears` : 'someone comments'}`
            : // An approval the server would not act on, and the one outcome here that
              // is genuinely unexpected: a proposed bead that already exists is not
              // created, however the tap read. First, because "Answered" over a create
              // that did not happen is the sort of quiet difference you find out about
              // a fortnight later. The whole sentence is on the thread.
              res?.skipped?.length
              ? `Answered ${q.id} — ${res.skipped.length} already filed, not created again`
              : // A commission leaves the inbox without being finished, and the card
              // vanishing looks identical either way. This line is the only place
              // the difference is visible, so it comes off what the server did
              // rather than off which button was pressed.
              res?.handedBack
              ? `Answered ${q.id} — handed back as work`
              : `Answered ${q.id}`
        );
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
      // The tracker refusing to *close* the bead is not the answer failing, and it
      // must not read like one. The server wrote nothing and said why, so the card
      // comes back carrying the reason and the offer — and the draft stays in the
      // box, because the failure mode this whole path exists to stop is you deciding
      // the answer was lost and typing it in again.
      // Which button was pressed rides along, because the note reads differently for
      // the two: an answer is always worth keeping, a wordless dismissal is not.
      const gate = err.status === 409 && err.body?.gate ? err.body.gate : null;
      if (gate) q.closeGate = { ...gate, from: dismiss ? 'dismiss' : 'answer', canComment: err.body.canComment };
      else toast(err.message, true);
      // Reverse the travel first, then re-open the card underneath where the beads
      // came down. A tracker that refused the answer must not be shown swallowing it.
      await flight?.recall();
      restoreCard();
      // The card is rebuilt by restoreCard, so the note is on screen; put the caret
      // back where it was rather than making you find the box again.
      if (gate) openOnly(key);
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
    // Opening, as opposed to refreshing one that is already up. Only the first of
    // those gets to move the reader — see jumpToMine.
    const opening = !state.open.has(key);
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
    if (opening) openOn = key;
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

    /**
     * Both answers to the notification prompt — see dismissAskHtml().
     *
     * The keys go back up with the tap rather than the server re-deciding on its own,
     * so what is cleared is exactly what the sentence you read was counting. A bead
     * that started ringing in between is not covered by it.
     *
     * The pane goes on the tap, before the write. If the write fails the server state
     * is unchanged, so the next poll brings the same ask straight back — which is the
     * right way round: a prompt that reappears is recoverable, a prompt that hangs
     * about after you answered it is not.
     */
    if (act === 'shade-clear' || act === 'shade-leave') {
      const ask = state.dismissAsk;
      const clear = act === 'shade-clear';
      state.dismissAsk = null;
      render(true);
      if (!ask?.keys?.length) return;
      // Counted for exactly the reason the filter's own writes are: the 25s poll is
      // very likely to be in flight when you tap, and its payload was assembled before
      // this write landed. Without the guard, answering the prompt would be followed by
      // the same prompt sliding back onto the screen a second later.
      shadeWrites += 1;
      try {
        const res = await api('/api/notifications/dismiss', {
          method: 'POST',
          body: JSON.stringify({ confirm: clear, keys: ask.keys }),
        });
        const n = clear ? res.cleared ?? 0 : res.left ?? 0;
        toast(
          clear
            ? `Cleared ${n} notification${n === 1 ? '' : 's'} — the bead${n === 1 ? '' : 's'} stay${n === 1 ? 's' : ''} open`
            : `Left ${n === 1 ? 'it' : 'them'} on the phone`
        );
      } catch (err) {
        // The server state is unchanged, so the next poll offers the same ask again.
        toast(err.message, true);
      } finally {
        shadeWrites -= 1;
      }
      return;
    }

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

    /*
      Open or shut one comment. DOM surgery on that one bubble, never a render():
      the answer box is below the thread with your draft and possibly the caret in
      it, and rebuilding the list to hide a paragraph would cost both. The choice is
      recorded in state.thread so the next poll paints it back the way you left it.
    */
    if (act === 'comment') {
      const box = btn.closest('.comment');
      if (!box) return;
      const shut = box.classList.toggle('shut');
      btn.setAttribute('aria-expanded', String(!shut));
      if (box.dataset.comment) state.thread.set(box.dataset.comment, shut);
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

      // All four are snapshotted, not just dropped: submit() can hand the card back
      // if bd refuses the write, and a proposal that came back with every yes/no —
      // and every rewrite you typed — wiped would cost far more than the failure did.
      // See `onRestore` below.
      const hadPicks = new Map(picksFor(key));
      const hadEdits = new Map(editsFor(key));
      const hadOpen = [...state.propOpen].filter((t) => t.startsWith(`${key}|`));
      const hadEditOpen = [...state.propEdit].filter((t) => t.startsWith(`${key}|`));

      state.picks.delete(key);
      state.edits.delete(key);
      for (const t of hadOpen) state.propOpen.delete(t);
      for (const t of hadEditOpen) state.propEdit.delete(t);
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
        onRestore: () => {
          state.picks.set(key, hadPicks);
          state.edits.set(key, hadEdits);
          for (const t of hadOpen) state.propOpen.add(t);
          for (const t of hadEditOpen) state.propEdit.add(t);
        },
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
     * Ship it: the same merge, and then the repo's deploy on top.
     *
     * Two taps like merge, and for a bigger reason. A merge changes what is on
     * `origin` and is undone by another commit; this changes what is *running*, and on
     * this repo it restarts the daemon you are tapping — so the confirm step is the
     * last chance to notice you meant the button above.
     *
     * The answer is a distinct marker rather than a flag on `MERGE:`. The wire carries
     * the response string and nothing else, and a merge must never widen into a deploy
     * because a sentence got appended to it. See lib/delivery.js.
     */
    if (act === 'pr-ship') {
      const q = byKey(key);
      const d = q?.delivery;
      if (!d) return;
      const token = `${key}|ship`;
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
      await submit(key, `SHIP: ${d.method} and merge #${d.number}, then deploy ${d.workspace || 'it'}.`, { close: true });
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
      await submit(key, opt.response, { close: true, option: opt.id });
      return;
    }

    /**
     * A suggested answer, tapped: put its words in the box.
     *
     * Nothing is sent and nothing is armed — see suggestedHtml for why this half of
     * the feature deliberately stops short of answering.
     *
     * The one rule with teeth is what happens to text already in the box. Replacing
     * it wholesale would let a tap destroy a sentence you typed, which is the thing
     * this app protects hardest; appending always would turn changing your mind into
     * "Restore at promotion\nRestore at startup", two contradictory answers on one
     * thread. So: swap when what is there is a suggestion (you are picking again),
     * append when it is yours (you are adding a choice to a caveat you wrote).
     *
     * Painted in place for the usual reason — render() would rebuild the card under
     * the textarea and take the keyboard down with it.
     */
    if (act === 'suggest') {
      const q = byKey(key);
      const opts = q?.suggested?.options || [];
      const opt = opts.find((o) => o.id === btn.dataset.opt);
      const box = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"] [data-role="answer"]`);
      if (!opt || !box) return;

      const current = box.value.trim();
      const mine = current && !opts.some((o) => o.response.trim() === current);
      box.value = mine ? `${current}\n${opt.response}` : opt.response;
      setDraft(key, box.value);
      paintDraftMark(key);
      paintSuggested(key, box.value);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
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
        // `endorsed` is the server saying this bead was being held back from every
        // agent until this tap (lib/endorse.js). Worth a word: it is a decision you
        // just made, and nothing else on this card says you made it.
        toast(
          `${res.endorsed ? 'Endorsed it — session' : 'Session'} open in ${res.dir.split('/').pop()} — go to your Mac`
        );
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

    /**
     * Dismiss: close the question, answer nothing.
     *
     * Two taps, on the same six-second arm as an option — a card sitting open in a
     * pocket must not be binned by a stray thumb. Nothing here validates the box:
     * an empty dismissal is the ordinary case, and anything typed goes with it as
     * the reason, which is what the armed label has just promised.
     */
    if (act === 'dismiss') {
      const token = `${key}|dismiss`;
      if (state.armed !== token) {
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
      const box = btn.closest('.card')?.querySelector('[data-role="answer"]');
      await submit(key, (box?.value || '').trim(), { close: true, dismiss: true });
      return;
    }

    /**
     * The offer under a refused close: keep the answer, leave the bead open.
     *
     * It goes down the ordinary comment path — same endpoint, same `human-replied`
     * label, same agent dispatched. That is deliberate rather than a shortcut: what
     * you typed is a reply on a thread, and the only thing the tracker refused was
     * the closing of the bead. Routing it anywhere else would make a comment that
     * looks like every other comment behave differently from every other comment.
     */
    if (act === 'gate-comment') {
      const q = byKey(key);
      const card = btn.closest('.card');
      const box = card.querySelector('[data-role="answer"]');
      const text = (box?.value || getDraft(key)).trim();
      if (!text) return toast('Write something first', true);
      if (q) q.closeGate = null;
      await submit(key, text, { close: false });
      if (box) box.value = '';
      return;
    }

    // Taken back without writing anything. The draft stays: dismissing the note is
    // not abandoning the answer, and the commonest next move is closing a blocker
    // in another tab and pressing Answer & close again.
    if (act === 'gate-dismiss') {
      const q = byKey(key);
      if (q) q.closeGate = null;
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
    // And the dismiss button, which changes its mind about what it would do with
    // the box the moment there is anything in it. In place for the same reason the
    // mark is: a render() here would rebuild the card under the keystroke.
    paintArmed();
    // A pressed chip is a claim about what the box says. Edit one word of it and
    // the claim stops being true, so it lets go rather than sitting there lit under
    // an answer that is now yours.
    paintSuggested(key, box.value);
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

  /** How many answers to the notification prompt are in flight. See the `shade-clear`
   *  handler. The filter's own writes are the picker's now — `space.writing()`. */
  let shadeWrites = 0;

  /**
   * The picker moved: adopt it and repaint.
   *
   * `state.space` / `state.workspace` stay this page's own mirror of the selection
   * rather than being read off the picker at every use — there are a dozen readers and
   * a mirror keeps the diff honest — but the picker is the only writer, both to the
   * server and to here.
   *
   * The `ask` source is the same tap, arriving a round trip later: the write that
   * narrows the filter is what asks about the notifications the new filter excludes,
   * because "at the moment of the change" is the only moment where clearing them is
   * obviously part of the same act. The inbox is the only page that can draw that
   * prompt, so it is the only page that listens for it.
   */
  window.beadcause?.space?.onChange(({ filter, source, dismissAsk }) => {
    if (source === 'ask') {
      // Nothing to ask and nothing being asked is not a repaint. Widening away from a
      // prompt that *is* up is, which is the whole reason `null` is announced at all.
      if (!dismissAsk && !state.dismissAsk) return;
      state.dismissAsk = dismissAsk || null;
      render(true);
      return;
    }
    state.space = filter.space || 'all';
    state.workspace = filter.workspace || 'all';
    render(true);
  });

  filtersEl.addEventListener('click', (ev) => {
    const scopeChip = ev.target.closest('[data-scope]');
    if (scopeChip) chooseScope(scopeChip.dataset.scope);
  });

  /* ---------------------------------------------------------------- scope */

  /**
   * Move the armed scope chip without rebuilding the row.
   *
   * The scope row is painted by renderFilters(), but the switch below clears the list
   * and waits on `bd` rather than rendering — so on the tap itself there is nothing to
   * repaint the chips. Doing it in place also keeps the spaces and workspaces rows on
   * screen while the fetch is out; rendering with an emptied list would drop them and
   * then bring them back a couple of seconds later.
   */
  function paintScope() {
    for (const btn of filtersEl.querySelectorAll('[data-scope]')) {
      btn.setAttribute('aria-pressed', String(btn.dataset.scope === state.scope));
    }
  }

  /**
   * Switch which slice of the tracker the list is.
   *
   * Out of the chip row's click handler because the count in the top bar is the other
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
    // The workspace filter used to be cleared here, on the grounds that it was probably
    // pointing at the one workspace that had a question in it and would hide everything
    // the widening let in. It is not cleared any more, and the reason is that it stopped
    // being this page's filter: it is the space picker, it is on every screen, it is
    // stored on the server, and it decides whether the phone rings. A scope tap must not
    // quietly change what you are working on — on this device or on the other one.
    schedulePoll();
    // Only the questions. The scope is a setting about which slice of *work* the
    // list is, and the other channel is not a slice of it — clearing the pane here
    // would blank a pending constitutional request for a couple of seconds because
    // you tapped a filter that has nothing to do with it.
    state.questions = [];
    // The scope you have just switched to may be one this tab has already had —
    // flipping between `human` and `both` and back is an ordinary thing to do — and
    // then there is a list to draw rather than a wait to sit through. `load()` runs
    // behind it either way: a scope change is still confirmed with the server.
    if (!warmBoot()) {
      const reqs = requestsHtml();
      paintList([
        ...(reqs ? [{ key: '@requests', html: reqs }] : []),
        { key: '@empty', html: '<div class="empty">Asking bd…</div>' },
      ]);
    }
    load();
  }

  // The count is the second way to the same chip: it says how many beads are asking
  // you something, so tapping it shows you exactly those.
  $('#waiting')?.addEventListener('click', () => chooseScope('human'));

  /* ----------------------------------------------------------------- load */

  let loading = false;
  let loadAgain = false;

  /** The path whose payload is this scope's — and the key it is warmed under. */
  const questionsPath = (scope) => `/api/questions?scope=${encodeURIComponent(scope)}`;

  /**
   * Where in `/api/poll`'s event log the list on screen was true.
   *
   * 0 means "we do not know" — an old daemon that does not send it, or nothing
   * fetched yet — and every reader treats that as a reason to fall back to the timer.
   */
  let seq = 0;

  /**
   * Take a payload and become it.
   *
   * Split out of `load` because three things now arrive with this shape and all of
   * them have to be adopted identically: the cold fetch below, the payload kept from
   * the last visit to this tab, and `/api/poll` waking with the list on it. A second
   * copy of this merge for the poll is how the poll would end up drawing a subtly
   * different inbox from the one a reload gives you.
   */
  function adopt(data) {
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
    // The filter is the server's, so every load adopts it — that is what makes a
    // change on the phone show up on the laptop. The exception is a write of our
    // own still in flight: this payload was assembled before it landed, so applying
    // it would snap the chip back to the value the tap just replaced.
    if (data.filter && !window.beadcause?.space?.writing?.()) {
      state.space = data.filter.space || 'all';
      state.workspace = data.filter.workspace || 'all';
      // The prompt travels with the filter and is adopted on the same terms, because
      // it is a fact about that filter: the laptop can narrow it, and then this phone
      // is the device holding the notifications and the only one that can be asked.
      // Skipped while a write of our own is in flight for the same reason as above —
      // this payload was assembled before the tap that changed it. `shadeWrites`
      // covers the second tap that can be in flight here: the answer to the prompt.
      if (!shadeWrites) state.dismissAsk = data.dismissAsk?.count ? data.dismissAsk : null;
    }
    // A space that has been renamed or removed in config would otherwise leave the
    // filter pinned to something that no longer exists, showing an empty list.
    if (state.space !== 'all' && !state.spaces.some((s) => s.name === state.space)) state.space = 'all';
    // The same for a workspace, which now outlives the page and so can name one that
    // has since left the config. Checked against the configured list rather than the
    // beads on screen: a workspace that exists but has nothing in this space is
    // legitimately an empty list, not a stale filter to silently reset.
    if (state.workspace !== 'all' && Array.isArray(data.workspaces) && !data.workspaces.includes(state.workspace)) {
      state.workspace = 'all';
    }
    // After the two reconciliations above, so the picker is handed what this page has
    // decided to show rather than what the payload said — those two can differ by
    // exactly one config change, and the picker is where it would be visible.
    publishSpaces({ ...data, filter: { space: state.space, workspace: state.workspace } });
    // Kept open across a refresh only if the bead is still somewhere — in either
    // channel. Checking only `questions` would collapse an open request every 25
    // seconds, mid-read.
    state.open = new Set([...openKeys].filter((k) => Boolean(byKey(k))));
    render();
    focusHash();
  }

  /**
   * Ask `bd` for the whole list.
   *
   * The expensive one — a sweep across every workspace — and after this change it is
   * no longer what keeps the page current. It runs on the cold boot that has nothing
   * warm to draw, on a scope change, on the ⟳, and whenever the poll below has lost
   * its place. The steady state is the poll.
   */
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
      const data = await api(questionsPath(asked));
      // Changed under us while the request was out. These are rows from the list
      // you just left; the re-run queued above is the one that counts.
      if (asked !== state.scope) return;
      seq = Number(data.seq) || 0;
      keep(asked, data);
      adopt(data);
      // This is where the timer hands over: the sweep that just ran is also the thing
      // that told us where in the log we are, so the next refresh can be the log
      // waking us rather than another sweep. A no-op when the log is already being
      // followed, and a no-op on a daemon that sends no sequence.
      schedulePoll();
      warmOthers();
    } catch (err) {
      if (err.message !== 'token rejected') {
        // Only over an empty list. With cards already on screen — warm ones, or the
        // ones from before the link went — replacing the lot with an error message
        // throws away everything the page could still usefully show, and the poll
        // that failed will simply come back.
        if (!state.questions.length && !(state.requests || []).length) {
          paintList([
            { key: '@empty', html: `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>` },
          ]);
        }
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

  /**
   * Keep this payload for the next document that wants it.
   *
   * Which is this page, next time you tap Inbox: a tab switch throws the document
   * away, and without this the next one starts from nothing and waits out a `bd`
   * sweep with a blank list on screen. See public/warm.js.
   */
  function keep(scope, data) {
    // Trimmed to what `adopt` reads, rather than kept whole. Two of the three payloads
    // that reach here come off `/api/poll`, which carries the advocate snapshot, the
    // event log and the presence list as well — none of which this page draws, all of
    // which would be sat in the phone's storage for nothing, and one of which is a list
    // of devices. What is stored is exactly what would be painted back.
    const { questions, requests, workspaces, spaces, filter, dismissAsk, summary } = data;
    window.beadcause?.warm?.write?.(
      questionsPath(scope),
      { questions, requests, workspaces, spaces, filter, dismissAsk, summary },
      Number(data.seq) || 0
    );
  }

  /**
   * Draw the list this tab had last time, before anything has been asked for.
   *
   * This is the whole tab-switch saving. The shell is already cached, so the page is
   * on screen in a frame; what you used to wait for after that was a `bd` sweep with
   * an empty list underneath it. The payload kept from the last visit paints in that
   * frame instead, and the sequence it carries is what lets the refresh behind it be
   * a parked poll rather than a second sweep.
   *
   * Returns whether anything was drawn, because the caller's next move depends on it:
   * with a warm list up there is no hurry, and without one there is nothing at all.
   */
  function warmBoot() {
    const hit = window.beadcause?.warm?.read?.(questionsPath(state.scope));
    if (!Array.isArray(hit?.data?.questions)) return false;
    seq = hit.seq;
    adopt(hit.data);
    return true;
  }

  /**
   * Fetch the other tabs' payloads, behind this one.
   *
   * Called only from a request that has already come back 200: a 401 here would put
   * the sign-in dialog up over a page nobody asked to sign in on, so proving the
   * credential first is not politeness, it is the condition. Called from both refresh
   * paths and on every one of them, because `prewarm` is itself once-per-document —
   * see public/warm.js for that and for what else stops it doing too much.
   */
  function warmOthers() {
    window.beadcause?.warm?.prewarm?.({ here: 'inbox', api });
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

  /*
    Open this page in Chrome — shown only where there is somewhere to go.

    In a browser the button would offer to put you in the browser you are already in,
    so its default is hidden and the Android shell's bridge is what reveals it. Tested
    for the method rather than the object: an APK built before this shipped injects a
    `BeadcauseNative` with `answered` and `version` and nothing else, and a button that
    appeared there would do nothing when tapped.

    Nothing is passed. The shell builds the URL from its own prefs and this WebView's
    address — so the token comes from where the token lives, and this page has no say
    in where the intent points.
  */
  if (typeof window.BeadcauseNative?.openInBrowser === 'function') {
    const chrome = $('#open-chrome');
    chrome.hidden = false;
    chrome.addEventListener('click', () => window.BeadcauseNative.openInBrowser());
  }

  addEventListener('hashchange', () => {
    hashHandled = '';
    focusHash();
  });
  /**
   * How often to re-ask, for the scopes that have to ask on a clock.
   *
   * Scope decides, because they cost very different amounts: `human` is one
   * `bd human list` per workspace and stays where it was, while the wider ones are a
   * full `bd list` sweep — around 2.5s of `bd` across seven workspaces — so they back
   * off rather than keeping seven CLI processes warm on the Mac for a list you are
   * probably just glancing at.
   *
   * `human` is not on this clock any more; see `follow` below. It is left in the
   * table because the fallback path uses it whenever the long-poll cannot run.
   */
  const POLL_MS = { human: 25000, both: 60000, agent: 60000 };
  let pollTimer = null;

  /* -------------------------------------------------------------- the long poll */

  /**
   * Follow the event log instead of re-asking on a timer.
   *
   * `/api/poll` parks until the daemon's sequence moves and only then sweeps `bd` —
   * so an idle inbox costs one held socket instead of a sweep across seven workspaces
   * every 25 seconds, and a bead that moves lands here in the moment it moved rather
   * than up to 25 seconds later. Faster *and* cheaper, which is unusual enough to be
   * worth saying: the sweep was never doing anything the log could not say for free.
   *
   * Three things keep it honest:
   *
   * - **Only in `human` scope.** The poll's `questions` is the human channel; the
   *   wider scopes are a different sweep the log does not carry, so they stay on the
   *   clock. This is the scope the app is nearly always in and the one that polled
   *   fastest, so it is where all of the saving was.
   * - **Only with a sequence to start from.** `seq` comes off the payload; a daemon
   *   that predates it sends none, and this never starts.
   * - **Every failure falls back rather than stopping.** A refused or broken poll
   *   drops to the timer, which is what the page did before this existed. The one
   *   thing that must never happen is an inbox that has quietly stopped refreshing.
   */
  let following = false;
  let pollAbort = null;

  const canFollow = () => state.scope === 'human' && seq > 0 && Boolean(state.token);

  async function follow() {
    if (following || !canFollow()) return;
    following = true;
    try {
      while (canFollow() && !document.hidden) {
        const at = seq;
        pollAbort = new AbortController();
        let data;
        try {
          data = await api(`/api/poll?since=${at}&wait=25`, { signal: pollAbort.signal });
        } finally {
          pollAbort = null;
        }
        // The scope changed while we were parked, or the token went. Either way this
        // answer is about a list nobody is looking at.
        if (!canFollow() || at !== seq) break;
        // The poll answered, so the credential is good and the daemon is up: the one
        // moment it is safe to go and warm the other four tabs.
        warmOthers();
        seq = Number(data.seq) || 0;
        // Null means the park timed out with nothing but presence traffic — the quiet
        // case, and the whole point: no sweep ran on the daemon and nothing repaints
        // here. An empty array would mean "the inbox is empty", which is why the two
        // are different values on the wire.
        if (Array.isArray(data.questions)) {
          keep('human', { ...data, seq });
          adopt(data);
        }
        if (!seq) break; // an old daemon answering without one; nothing to follow
      }
    } catch (err) {
      // An abort is us, on the way to somewhere else. Anything else — the daemon
      // restarting, the tailnet dropping, a 401 — falls through to the timer, and
      // the visibility handler will try to pick the log back up.
      if (err?.name !== 'AbortError' && err?.message !== 'token rejected') seq = 0;
    } finally {
      following = false;
      schedulePoll();
    }
  }

  /** Stop waiting on an answer about a list we have stopped showing. */
  function unfollow() {
    pollAbort?.abort();
    pollAbort = null;
  }

  /**
   * The timer, which now runs only when the log cannot be followed — a wide scope, an
   * old daemon, or a poll that failed. `follow()` is started from the same place, so
   * exactly one of the two is ever live.
   */
  function schedulePoll() {
    clearInterval(pollTimer);
    if (canFollow() && !document.hidden) {
      follow();
      return;
    }
    // Whatever is parked is parked on a list this page has stopped drawing — a scope
    // it left, or a screen that has gone dark. Dropped here rather than left to time
    // out, so exactly one of the two refresh paths is ever live.
    unfollow();
    pollTimer = setInterval(() => {
      if (!document.hidden) load();
    }, POLL_MS[state.scope] || 25000);
  }

  // These keep fetching; render() decides whether it's safe to repaint.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      // A parked socket in a pocket. The daemon drops the waiter when the request
      // closes, so this costs nothing on either end — and coming back re-asks from
      // the sequence we left off at, which is what makes the return instant.
      unfollow();
      return;
    }
    if (canFollow()) schedulePoll();
    else load();
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
    // Painted here rather than waiting for the first render, so the row that says
    // which slice you are looking at is on screen while `bd` is still being asked —
    // which is exactly when a wide scope makes the wait long enough to wonder.
    filtersEl.innerHTML = scopeRowHtml();
    filtersEl.hidden = false;
  }

  bootToken();
  bootScope();
  // Warm first, then decide what to ask for. With a list on screen and a place in the
  // event log, the refresh is a parked poll that costs the daemon nothing until
  // something moves — so the ordinary tab tap does no `bd` sweep at all. Without
  // either, this is the cold start it always was.
  if (warmBoot() && canFollow()) schedulePoll();
  else load();
  // After the list, and never blocking it: the chooser only appears inside an open
  // card, so there is nothing on screen waiting for this.
  loadAgents();
})();
