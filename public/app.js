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
    // The conversations you have open, and for the same reason as `requests`: a chat
    // session is not a bead. It has no id in any tracker, nothing about it can be
    // answered, and every count in the chrome is about beads — so it rides its own
    // array and is turned into rows at render time (see `chatRows`). What it *is*
    // part of is the list you look at, which is the whole point of bc-l8jp.5.
    consoles: [],
    // The JIRA tickets assigned to you, and for the same reason again: a ticket is not
    // a bead. It has no id in this tracker, nothing about it can be answered here, and
    // every count in the chrome is about beads — so it rides its own array and is
    // turned into rows at render time (see `jiraRows`). Filled from the `tickets` field
    // of the inbox payload, which is where the poller in bc-0i27.2 puts what it holds;
    // until that lands the field is simply absent and this stays empty, which is the
    // same thing an install with no JIRA configured will always see.
    tickets: [],
    // The repos the last sweep could not read, each with what `bd` said (lib/sweep.js).
    // Its own array for the same reason `requests` is one, and drawn as a pane above
    // the list rather than folded into the empty state: a failed sweep is a fact about
    // this screen whether or not there is anything else on it, and an empty inbox that
    // is empty *because nobody could ask* is the one thing this app must never draw as
    // "nothing to decide".
    trouble: [],
    // And the repos that read perfectly and are no longer the same tracker as the
    // machine they share one with (lib/sync.js). Separate from `trouble` all the way to
    // the screen, because the two are opposite claims about the list below them — see
    // `syncTroubleHtml`.
    syncTrouble: [],
    // The P0 board (bc-rfnr.2): `{ p0s[], under, owned }` — which P0s carry your
    // `owner:<handle>`, and for every other row the id of the P0 it descends from.
    // `owned: false` is what an install with no `me` answers, and it means the whole
    // section and the whole filter are off: the inbox is the flat list it always was.
    // **`p0board`, not `board`** — `state.board` is the *pull request* board (`prRows`
    // reads `board.repos`), and two different things called board on one page is how a
    // page starts drawing one of them from the other's data.
    // Its own object rather than fields on the rows, because the *absence* of a row from
    // `under` is the filter — and a row that arrived before the board did must not read
    // as one with no P0 above it. See `p0Board` in lib/server.js.
    p0board: { p0s: [], under: {}, owned: false },
    spaces: [],
    // Every configured workspace, which the inbox needs for one thing only: ＋ has to
    // know where to start a conversation, and "the repos in the selected space" is a
    // question about the config rather than about the beads on screen.
    workspaces: [],
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
    armed: null, // key of the control awaiting its confirm tap
    armedTimer: null,
    // Which option each card's answer is currently making — `key → option id`.
    //
    // Remembered from the tap rather than derived from the box, unlike the
    // suggested chips, and the difference is the whole point of an option now
    // filling the box instead of sending itself: you tap (b) and then qualify it
    // in a sentence. Deriving would drop the pick at the first keystroke, and
    // with it the one thing the sentence cannot say — whether this answer
    // commissions work rather than settling it (`closes: false`, lib/decision.js).
    // Emptying the box lets it go; see the input listener.
    picked: new Map(),
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
    // The pull request board, whole, from `/api/prs` — the rows this list draws its PR
    // cards from (see prRows). Its own fetch on its own clock, never merged into
    // `questions`: a pull request is not a bead and every consumer of that array is.
    board: null,
    /** Why the last board sweep said nothing, if it failed or `gh` is missing. */
    boardError: null,
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
    // The full view's half of a pull request: `pr:<ws>#<n>` → { loading, row, pr, agent,
    // unavailable }. The board row is already in hand from the sweep — what this adds is
    // the description, the datetimes, the authoring agent and a mergeability read at the
    // moment you are about to act on it. Fetched when a card is opened, never on the poll.
    prDetail: new Map(),
    // Which pull requests you have started closing. A mode rather than an armed button,
    // for the same reason a decline is one: closing carries a reason, and typing a
    // sentence outlives any arm timer. See prCloseHtml.
    prClose: new Set(),
    // What the last act on a pull request said back: key → { kind: 'ok'|'bad', text }.
    // On the card rather than in a toast, because a refusal from GitHub is a sentence
    // you read and then act on, and a toast is gone by the time you have read it.
    prSaid: new Map(),
    // Which pull request has an act in flight, so a second tap cannot send it twice.
    // One at a time is enough: only one card is ever open (see openOnly).
    prBusy: null,
    // What is typed into a full view's two boxes — the comment and the close reason — as
    // `key` and `key|reason`. Out here rather than read off the textarea for the reason
    // every other draft in this file is: the card is repainted on every arm and every
    // answer from GitHub, and a half-typed sentence must not go with it.
    prDraft: new Map(),
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

  /**
   * A file on the Mac opens in the reader tab, not as a dead file:// link.
   *
   * `q` is optional and only the docs list of a card has one to give. It carries the
   * bead through to the reader tab, which is what lets a publish to Confluence say
   * where the document ended up *on that bead* rather than only in the daemon's own
   * state. A path lifted out of prose (`renderMarkdown`) has no bead behind it and
   * passes nothing, which the reader tab reads as "no bead" and not as an error.
   */
  function docUrl(p, q) {
    let s = String(p || '').trim();
    if (s.startsWith('file://')) s = decodeURIComponent(s.slice(7));
    if (s.startsWith('~')) s = s.replace(/^~/, '');
    const from = q?.workspace && q?.id ? `&ws=${encodeURIComponent(q.workspace)}&bead=${encodeURIComponent(q.id)}` : '';
    return `/doc?p=${encodeURIComponent(s)}${from}`;
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
  // The pick goes with the words it filled in — a card that comes back later must
  // not arrive already claiming to be making a choice nobody has made on it since.
  const clearDraft = (key) => {
    localStorage.removeItem(draftKey(key));
    state.picked.delete(key);
  };

  /**
   * Don't yank the textarea out from under a thumb mid-sentence.
   *
   * The adjust fields count too. They hold their value in `state.edits` rather than
   * in the DOM, so a repaint would not *lose* anything — but it would drop focus and
   * put the caret back at the end, which mid-word is the same insult.
   */
  // The full view's two boxes count, and they had to be named here rather than left to
  // the card's own repaints: a poll rebuilds the list every 25 seconds, and a comment or
  // a close reason half-typed into an open pull request is exactly as worth keeping as a
  // half-typed answer. See prActionsHtml.
  const TYPING_IN = '[data-role="answer"], [data-role="edit-field"], [data-role="pr-comment"], [data-role="pr-reason"]';

  const isTyping = () => !!document.activeElement?.matches?.(TYPING_IN);

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
    // Deliberately not every field in TYPING_IN: an `edit-field` is a `<select>` as well
    // as a box, and a select always holds a value — counting those would make this true
    // for as long as a proposal row was unfolded, which would stop the poll repainting
    // the list at all.
    [...listEl.querySelectorAll('[data-role="answer"], [data-role="pr-comment"], [data-role="pr-reason"]')].some((t) =>
      t.value.trim()
    );

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
   * This card got here without making a noise — and which of the three kinds of quiet
   * it was.
   *
   * **Silences that read identically until you say which.** A bead outside the inbox
   * filter, a bead in a muted space and a bead somebody else was asked all arrive, all
   * file, all count, and all leave the phone dark (see `quietReasonFor` on the server).
   * The difference is the whole of what you can do about it: a mute ends on a clock and
   * there is nothing to press, a filter ends when you press **All**, and an addressed
   * question is on another engineer's phone and is not yours to fix at all — which is
   * exactly the sentence worth having, because it is the one that stops you widening a
   * filter that was never hiding anything. Before this the distinction lived only in the
   * daemon's log, which is not a thing anyone reads from a phone at 2am.
   *
   * **And it is what stops the pile reading as a rush.** Widen the filter and every
   * bead it was hiding appears at once, in a list ordered by priority — indistinguish-
   * able from four questions that landed while you were reaching for the chip. So the
   * line leads with *when*, not with the reason: "arrived quietly 3h ago" is a card
   * that was already there, and that sentence is the acceptance criterion.
   *
   * The filter is quoted as it stood at the arrival, because by now it is almost
   * certainly not that any more — that is the point of having widened it — and the
   * value from then is the only one that explains anything.
   *
   * One line, dim, in the card head under the pills and above the question — where a
   * postmark goes. On the collapsed card as well as the open one, because the pile is
   * read from the list and most of these are never opened at all; and above the
   * question rather than below it, so it cannot be mistaken for something an agent
   * said. It states a fact and does nothing: the card answers exactly as it did.
   */
  function arrivedQuietHtml(q) {
    const a = q.arrivedQuiet;
    if (!a) return '';
    const when = relTime(a.at);
    const who = (a.for || []).join(', ');
    const why =
      a.reason === 'addressed'
        ? `asked of ${who ? esc(who) : 'somebody else'}`
        : a.reason === 'muted'
          ? `${a.space ? esc(a.space) : 'that space'} was muted`
          : `hidden by the inbox filter${a.filter && a.filter !== 'all' ? ` — ${esc(a.filter)}` : ''}`;
    const mark = { addressed: '📮', muted: '🔕' }[a.reason] || '🔇';
    return `<p class="quiet-note">
      <span aria-hidden="true">${mark}</span>
      <span>Arrived quietly${when ? ` ${esc(when)}` : ''} · ${why}</span>
    </p>`;
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
   * The card's own top bar: everything that is *about* the card rather than an
   * answer to it.
   *
   * It used to be the two corner controls an open card grew — the kebab and
   * collapse — and everything else queued up at the foot instead: the details
   * toggle, then a bulk approve/decline row, then a full-width primary. Three
   * full-width buttons under the question, none of which answered it, and the one
   * that did the work looked exactly like the two that did not.
   *
   * So they come up here. Reading (the details toggle) is hard left; acting on the
   * whole card (a proposal's bulk approve/decline) is hard right, next to the way
   * out. The foot keeps only what is genuinely a second body of content — the
   * session log — and an answer box, when there is one, is then the only full-width
   * control on the card.
   *
   * Two things stay conditional on `open`, because closed the card is a row in a
   * list: the kebab, and collapse. And an open card does *not* also get a "Hide
   * details" — collapse is that button, one row to the right of where it would go.
   */
  function cardTopHtml(q, opts = {}) {
    const on = state.menu === q.key;
    const open = state.open.has(q.key);
    return `<div class="card-top">
      ${open ? '' : `<button class="top-btn detail" data-act="toggle" data-key="${esc(q.key)}">${esc(
        opts.detailLabel || 'Show details'
      )}</button>`}
      ${propBulkHtml(q)}
      ${
        open
          ? `<div class="menu-wrap">
        <button class="kebab${on ? ' on' : ''}" data-act="menu" data-key="${esc(q.key)}"
          aria-haspopup="true" aria-expanded="${on}" aria-label="More actions">⋮</button>
        ${on ? menuHtml(q.key) : ''}
      </div>
      <button class="collapse" data-act="collapse" data-key="${esc(q.key)}">↑ Collapse</button>`
          : ''
      }
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
   * So: approve and decline per row, and — in the card's top bar rather than under
   * the rows, see propBulkHtml — the two bulk controls that say exactly how many
   * each of them will file. It paints in place, see paintPicks, because a re-render
   * would rebuild the card under a decision you are halfway through making.
   */
  function proposalHtml(q) {
    const beads = q.proposal?.beads || [];
    if (!beads.length) return '';
    const picks = picksFor(q.key);

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

    return `<div class="proposal" data-key="${esc(q.key)}">
      <div class="section-label">${beads.length} bead${beads.length === 1 ? '' : 's'} proposed <span>nothing is created until you say so</span></div>
      ${rows}
    </div>`;
  }

  /**
   * The two bulk controls, in the card's top bar — see cardTopHtml.
   *
   * There used to be three buttons at the foot of a proposal: Approve all and
   * Decline all, which only *marked* every row, and a primary underneath that did
   * the filing. Two of the three were a way of setting up the third, which is a lot
   * of screen for one decision. Now the two are the decision: each arms on the first
   * tap and files on the second, and `state.armed` is the same mechanism every other
   * two-tap answer in this app uses.
   *
   * What each one does, and why they are not symmetrical:
   *
   * - **Approve** files everything you have not explicitly declined. That is what
   *   keeps "2 of 3" reachable with the third button gone — pick ✕ on the one you
   *   don't want, then approve — and it is why undecided rows are counted rather
   *   than folded into the declines.
   * - **Decline** files nothing at all, whatever the rows say. It is the full stop,
   *   and a full stop that quietly created two beads would be the worst button in
   *   the app.
   *
   * Both name their count before the second tap: the exact number this tap will
   * create is the one fact the old primary carried that had to survive the move.
   */
  function propBulkHtml(q) {
    const beads = q.proposal?.beads || [];
    if (!beads.length) return '';
    const undecided = undecidedCount(q.key, beads);
    const canApprove = keepIndices(q.key, beads).length > 0;
    return `<div class="prop-bulk">
      <span class="prop-count">${undecided ? `${undecided} undecided` : ''}</span>
      <button class="top-btn bulk approve${state.armed === `${q.key}|prop-yes` ? ' confirm' : ''}"
        data-act="prop-bulk" data-key="${esc(q.key)}" data-pick="yes" ${canApprove ? '' : 'disabled'}
        >${propBulkLabel(q.key, beads, 'yes')}</button>
      <button class="top-btn bulk decline${state.armed === `${q.key}|prop-no` ? ' confirm' : ''}"
        data-act="prop-bulk" data-key="${esc(q.key)}" data-pick="no"
        >${propBulkLabel(q.key, beads, 'no')}</button>
    </div>`;
  }

  /** Rows an approve would file: everything not explicitly declined. */
  const keepIndices = (key, beads) =>
    beads.map((_, i) => i + 1).filter((n) => picksFor(key).get(n) !== 'no');

  /**
   * Rows you have not answered either way. Counted, not silently treated as a no:
   * "3 undecided" is the difference between a considered decline and a half-read card.
   */
  const undecidedCount = (key, beads) =>
    beads.length - [...picksFor(key).values()].filter((v) => v === 'yes' || v === 'no').length;

  /** What a bulk button will do, said as a count, armed or not. */
  function propBulkLabel(key, beads, side) {
    const total = beads.length;
    const n = side === 'yes' ? keepIndices(key, beads).length : 0;
    const armed = state.armed === `${key}|prop-${side}`;
    const what = n === 0 ? 'create nothing' : n === total ? `create all ${total}` : `create ${n} of ${total}`;
    if (armed) return `Tap again · ${what}`;
    if (side === 'no') return total === 1 ? 'Decline it' : `Decline all ${total}`;
    if (n === total) return total === 1 ? 'Approve it' : `Approve all ${total}`;
    return `Approve ${n} of ${total}`;
  }

  /**
   * Repaint one proposal in place: row states, the undecided count and the two bulk
   * buttons. Deliberately not a render() — that rebuilds every card in the list, and
   * this runs on every tap.
   *
   * Framed on the *card* rather than on `.proposal`, because the bulk controls live
   * in the card's top bar now and the rows live in the block below it. One query for
   * the card is what keeps the count and the buttons in step with the ✓/✕ that moved
   * them.
   */
  function paintPicks(key) {
    const q = byKey(key);
    const beads = q?.proposal?.beads || [];
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    const block = card?.querySelector('.proposal');
    if (!card || !block || !beads.length) return;
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

    const undecided = undecidedCount(key, beads);
    const count = card.querySelector('.prop-count');
    if (count) count.textContent = undecided ? `${undecided} undecided` : '';
    for (const btn of card.querySelectorAll('.prop-bulk .bulk')) {
      const side = btn.dataset.pick;
      btn.textContent = propBulkLabel(key, beads, side);
      btn.classList.toggle('confirm', state.armed === `${key}|prop-${side}`);
      // Only the approve side can run out of things to do: decline is always
      // available, because "create nothing" is always an answer.
      if (side === 'yes') btn.disabled = keepIndices(key, beads).length === 0;
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

  /* ------------------------------------------------------- pull requests */

  /*
    Pull requests, as cards in this list — which is what took **PRs** off the bottom bar
    (bc-l8jp.6).

    A tab is a claim that a screen is somewhere you *live*. The board was not: it is a
    thing you glance at ("did that ship?") and act on twice a day, and it cost a fifth of
    the bar to say so. The rows themselves are incoming work like everything else here, so
    they belong in the one list that already sorts incoming work — which is also the list
    that can put a pull request next to the bead it is for.

    Four decisions, in the order they matter:

    - **The board is fetched on its own clock, not on the inbox's poll.** `/api/prs` is a
      `gh` call per repo behind a 25-second server cache; the inbox polls every 25 seconds
      and would keep that sweep hot all day for six repos. So: a minute, and **only while a
      pull request could be in the list at all** — the kind filter answers that, and
      reading `Questions` for an hour costs nothing.
    - **They are rows, not `state.questions`.** Nearly everything reading that array is
      about beads: the waiting count, the picker's per-repo numbers, the answer path, the
      write. A pull request is none of those, and it is synthesised at render time from the
      board — the same shape the chat rows use.
    - **Unmerged, unless you ask.** The status sub-filter's default (public/inboxfilter.js).
      Thirty pull requests merged in the last three weeks and five are open; a list that
      showed all thirty-five would bury this morning under this month.
    - **A closed pull request gets no card at all.** Closed without merging is not on the
      way anywhere, and a rung the sub-filter deliberately does not offer must not be able
      to reach this list — see the `sub` block in the filter's KINDS table.

    And tapping one **opens it full screen** (bc-l8jp.7), which is where the merge decision
    is actually made. That is the same `.card.open` sheet every other card in this list
    uses, for the reason the comment on `cardHtml` gives: expanding inline puts the
    description, the facts and the buttons in competition with the list around them, and a
    merge is not a thing to press with half a screen of context.
  */

  /** How often the board is re-swept while pull requests are in view. */
  const BOARD_MS = 60000;

  /** Which space a repo is in, the way the server groups them. See lib/spaces.js. */
  const spaceForWorkspace = (ws) =>
    state.spaces.find((s) => (s.workspaces || []).includes(ws))?.name || 'Other';

  /**
   * The board, as rows this list can carry.
   *
   * `key` is prefixed rather than bare so it can never collide with a bead's
   * `workspace/id` — the drawer, the scroll anchor and `byKey` all key off it. `space` is
   * stamped on here because the inbox filters on `q.space` before anything else and a row
   * without one would vanish the moment a space was picked.
   */
  const prRows = () =>
    (state.board?.repos || []).flatMap((repo) =>
      (repo.prs || [])
        .filter((p) => p.stage !== 'closed')
        .map((p) => ({
          key: `pr:${p.key}`,
          pr: p,
          workspace: p.workspace,
          // Which *repo* — `beadcause`, or `climative/athena-service`. Carried on the row
          // rather than read off `row.pr` at each call site, because it is what every act on
          // this pull request is addressed by and a number alone is only unique inside a repo.
          // Falls back to the workspace, which is what it is for a workspace that is one repo.
          repoKey: p.repoKey || p.workspace,
          space: spaceForWorkspace(p.workspace),
        }))
    );

  /** The ladder's order, for sorting. The words themselves are public/prcard.js's. */
  const prRank = (row) => {
    const ids = window.beadcause?.prCard?.stageIds?.() || [];
    const at = ids.indexOf(row.pr?.stage);
    return at === -1 ? ids.length : at;
  };

  /**
   * One pull request as a card — a row while it is shut, the whole screen once it is not.
   *
   * The inside of it — the number, the title, the repo, the rung, the beads, the diffstat
   * and the four lamps — is `bodyHtml` in public/prcard.js, the same function the board
   * draws its rows with. That is the whole point of that file: this card and that row are
   * the same object seen twice, and they were two renderers until bc-l8jp.6.
   *
   * Shut, the row is a **button** rather than a link to GitHub, which is what tapping it
   * used to mean. Two reasons, and the first is the bead: the decision this row exists for
   * is made here now, not on github.com. The second is mechanical — the whole row is one
   * tap target, and an `<a>` inside it was a nested interactive element a phone could
   * resolve either way.
   */
  function prCardHtml(row) {
    const card = window.beadcause?.prCard;
    const p = row.pr;
    if (!card || !p) return '';
    if (state.open.has(row.key)) return prFullHtml(row, p, card);
    return `<article class="card pr-card" id="card-${cardId(row.key)}" data-key="${esc(row.key)}"
      data-stage="${esc(p.stage)}">
      <button class="work-row pr-row" type="button" data-act="pr-open" data-key="${esc(row.key)}"
        aria-expanded="false">
        ${card.bodyHtml(p, { repo: true })}
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${p.note ? `<p class="board-note">${esc(p.note)}</p>` : ''}
    </article>`;
  }

  /**
   * The full view: everything a merge decision needs, and the four things you can do.
   *
   * `.card.open` is the same fixed full-screen sheet a question opens into, and the four
   * rows are the ones its layout is built around (see style.css): a `.card-top` that
   * stays, a `.card-head` that carries what this *is*, a `.brief` that scrolls, and a
   * pinned `.freeform` at the bottom holding the box and the buttons. Nothing new had to
   * be laid out for this, which is most of the argument for it being a card rather than a
   * fifth page.
   *
   * What is on it, in the order the bead asks for it: the title and a link out to GitHub,
   * the description, the beads, the authoring agent, the datetimes — then merge, close and
   * comment, and the conflict path in place of merge when GitHub says it conflicts.
   *
   * The live half arrives after the sheet does, exactly as a delivery card's does: the row
   * is already in hand from the board sweep and is worth reading with no signal at all, so
   * the description, the agent and the fresh mergeability paint in when they land rather
   * than holding the whole screen on a `gh` round trip.
   */
  function prFullHtml(row, p, card) {
    const detail = state.prDetail.get(row.key);
    // GitHub's word for it, when it has spoken since the sweep. The row's own is up to 25
    // seconds old, which is the right freshness for a lamp and the wrong one for a button.
    const live = detail?.pr || null;
    return `<article class="card pr-card open" id="card-${cardId(row.key)}" data-key="${esc(row.key)}"
      data-stage="${esc(p.stage)}">
      <div class="card-top">
        <button class="collapse" data-act="collapse" data-key="${esc(row.key)}">↑ Collapse</button>
      </div>
      <div class="card-head">
        <div class="work-row pr-row">${card.bodyHtml(p, { titleHref: p.url, repo: true })}</div>
        ${p.note ? `<p class="board-note">${esc(p.note)}</p>` : ''}
      </div>
      <div class="brief">
        ${prWhoHtml(p, detail)}
        ${prBodyHtml(detail)}
      </div>
      <div class="freeform pr-freeform">
        ${prActionsHtml(row, p, live)}
      </div>
    </article>`;
  }

  /**
   * Who and when — the facts a merge decision is made against, and the two that had to be
   * found rather than read off the row.
   *
   * **The agent** is the session that produced the branch, from the archive in the repo's
   * own refs (lib/prauthor.js). It is drawn with the mismatch stated when the archive knows
   * the bead but not this branch, because "a session on this bead, but not this one" is a
   * different fact from a match and reading them the same would make the attribution
   * worthless. Where nothing is archived it says GitHub's login and calls it that.
   *
   * **The datetimes** come from `gh` rather than from the board, which carries only the
   * one it sorts by. Opened, last touched, merged — the third only where there is one,
   * since "merged: never" is a row of nothing.
   */
  function prWhoHtml(p, detail) {
    const card = window.beadcause?.prCard;
    const live = detail?.pr || null;
    const agent = detail?.agent || null;
    const when = (iso) => (iso ? `${clockTime(iso)} · ${card.ago(iso)}` : '');

    const facts = [
      ['branch', `${p.branch} → ${p.base}`],
      ['bead', (p.beads || []).map((b) => b.id).join(', ') || 'none named'],
      ['agent', agentLine(agent, detail)],
      ['opened', when(live?.createdAt || p.createdAt) || 'not recorded'],
      ['touched', when(live?.updatedAt || p.updatedAt) || 'not recorded'],
    ];
    if (p.mergedAt) facts.push(['merged', when(p.mergedAt)]);
    if (p.mergeCommit) facts.push(['commit', p.mergeCommit.slice(0, 8)]);

    return `<dl class="pr-facts">${facts
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join('')}</dl>`;
  }

  /** The clock time, because "17h" doesn't say whether it spanned lunch. */
  const clockTime = (iso) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  /**
   * One line for the agent, and it never overstates what is known.
   *
   * Four answers, because there are four states and three of them are not "an agent wrote
   * this": the archive matched this branch, the archive knows the bead but not this branch,
   * nothing is archived at all, and the detail has not arrived yet.
   */
  function agentLine(agent, detail) {
    if (!detail || detail.loading) return 'reading the session archive…';
    if (!agent) return 'not recorded';
    if (agent.kind !== 'session') return agent.login ? `${agent.login} (GitHub account, no session archived)` : 'not recorded';
    const id = agent.sessionId ? agent.sessionId.slice(0, 8) : 'unknown session';
    const what = `session ${id}${agent.outcome ? ` · ${agent.outcome}` : ''}${
      agent.commits ? ` · ${agent.commits} commit${agent.commits === 1 ? '' : 's'}` : ''
    }`;
    return agent.matched ? what : `${what} — on ${agent.bead}, but on branch ${agent.branch || 'unknown'}, not this one`;
  }

  /**
   * The description, as the pull request has it.
   *
   * Rendered as markdown, because that is what a PR body is — and through the same
   * `FROM_BD` sanitiser every other body in this app goes through, since this one is the
   * only text on the screen that came from outside the Mac.
   */
  function prBodyHtml(detail) {
    if (!detail || detail.loading) return '<p class="pr-quiet">Reading the pull request…</p>';
    if (detail.unavailable) {
      return `<p class="pr-quiet warn">${esc(detail.unavailable)} — the row above is what the last board sweep said.</p>`;
    }
    const body = String(detail.pr?.body || '').trim();
    if (!body) return '<p class="pr-quiet">This pull request has no description.</p>';
    return `<div class="section-label">Description <span>as the pull request has it</span></div>
      <div class="md">${renderMarkdown(body, FROM_BD)}</div>`;
  }

  /**
   * Merge, close, comment — and the conflict path instead of merge where there is one.
   *
   * Three things here are deliberate and are the ones bc-l8jp.7 was careful about:
   *
   * - **Merge keeps its confirm.** Two taps, with the consequence written into the button
   *   between them — the same arming `/prs` and the delivery card use, and for the reason
   *   they use it: a `confirm()` on a phone is a system sheet you dismiss by reflex, and
   *   this is the one control here that changes something outside this Mac irreversibly.
   * - **Close keeps its reason box.** A mode rather than an arm, because the sentence in
   *   the box is the only thing that will explain a closed pull request six weeks later,
   *   and no six-second timer survives typing one.
   * - **A conflict is a path, not a sentence.** GitHub refusing a merge for a conflict is
   *   work rather than a decision, so it gets a button that opens a session on the branch
   *   and a cancel beside it — where before the refusal was a sentence on a card and the
   *   next step was yours to work out.
   */
  function prActionsHtml(row, p, live) {
    if (state.prClose.has(row.key)) return prCloseHtml(row, p);
    const said = state.prSaid.get(row.key);
    const note = said ? `<p class="pr-said pr-${esc(said.kind)}">${esc(said.text)}</p>` : '';
    // GitHub's word where it has one, the sweep's where it does not.
    const phase = live?.state || p.state;
    const mergeable = live?.mergeable ?? p.mergeable;
    const conflicted = phase === 'OPEN' && mergeable === 'CONFLICTING';
    const busy = state.prBusy === row.key;

    if (conflicted) {
      const armed = state.armed === `${row.key}|conflicts`;
      return `<p class="pr-conflict">#${p.number} conflicts with <code>${esc(p.base)}</code>. Nothing merges until
        <code>${esc(p.branch)}</code> has <code>${esc(p.base)}</code> in it — which is work, not a decision, so this
        opens a session on that branch to do it. It pushes the branch and stops; the merge stays yours.</p>
        <div class="pr-row-actions">
          <button class="primary${armed ? ' confirm' : ''}" data-act="pr-conflicts" data-key="${esc(row.key)}"
            ${busy ? 'disabled' : ''}>${armed ? 'Tap again · open the session' : 'Resolve conflicts'}</button>
          <button class="linkish" data-act="pr-cancel" data-key="${esc(row.key)}">Cancel</button>
        </div>
        ${note}`;
    }

    const buttons = [];
    if (phase === 'OPEN') {
      const armed = state.armed === `${row.key}|merge`;
      buttons.push(`<button class="primary${armed ? ' confirm' : ''}" data-act="pr-merge-go" data-key="${esc(row.key)}"
        ${busy ? 'disabled' : ''}>${armed ? `Tap again · merge #${p.number}` : prMergeLabel(p, live)}</button>`);
      buttons.push(`<button class="secondary danger" data-act="pr-close" data-key="${esc(row.key)}"
        ${busy ? 'disabled' : ''}>Close it</button>`);
    }
    // The comment box is the one control that is here whatever state the pull request is
    // in: something worth saying about a merged one is the commonest note of all.
    return `${
      buttons.length
        ? `<div class="pr-row-actions">${buttons.join('')}</div>`
        : `<p class="pr-quiet">${
            phase === 'MERGED' ? `#${p.number} is merged.` : `#${p.number} is closed.`
          } Ship and the deploy queue are on <a href="/prs">the board</a>.</p>`
    }
      <textarea data-role="pr-comment" rows="2" placeholder="Say something on #${esc(p.number)}…">${esc(
        state.prDraft?.get(row.key) || ''
      )}</textarea>
      <div class="row">
        <button class="secondary" data-act="pr-comment" data-key="${esc(row.key)}" ${busy ? 'disabled' : ''}>Comment on GitHub</button>
        <a class="linkish" href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">GitHub ↗</a>
      </div>
      ${note}`;
  }

  /** What the merge button promises, which must never overstate what it will do. */
  function prMergeLabel(p, live) {
    if (live?.draft ?? p.draft) return `Merge #${p.number} anyway (draft)`;
    if ((live?.checks || p.checks)?.state === 'failing') return `Merge #${p.number} — checks red`;
    return `Merge & push #${p.number}`;
  }

  /**
   * Closing, once you have said you mean to.
   *
   * It replaces the buttons rather than sitting under them, which is what makes this two
   * deliberate steps with no timer to race. The paragraph is the part worth having: this
   * closes the pull request and **does not** put the bead back in the queue, because that
   * is what Decline on the delivery card is for and it is the one that knows which bead the
   * worker actually named. See `POST /api/pr/close`.
   */
  function prCloseHtml(row, p) {
    const busy = state.prBusy === row.key;
    const beads = (p.beads || []).map((b) => b.id);
    return `<p class="pr-conflict">Closing <strong>#${p.number}</strong> without merging. The branch
      <code>${esc(p.branch)}</code> stays — it is the only copy of the work — and ${
        beads.length
          ? `<strong>${esc(beads.join(', '))}</strong> ${beads.length === 1 ? 'is' : 'are'} left exactly as ${
              beads.length === 1 ? 'it is' : 'they are'
            }`
          : 'no bead is touched'
      }. Putting the work back in the queue is <em>Decline</em> on its card in this inbox, which knows
      which bead the session named.</p>
      <p class="pr-quiet">Say why in the box. It is optional, and it is the only thing that will explain
      this to whoever opens the closed pull request next.</p>
      <textarea data-role="pr-reason" rows="2" placeholder="Why this is not the one…">${esc(
        state.prDraft?.get(`${row.key}|reason`) || ''
      )}</textarea>
      <div class="row">
        <button class="primary danger" data-act="pr-close-go" data-key="${esc(row.key)}" ${busy ? 'disabled' : ''}>Close #${p.number}</button>
        <button class="linkish" data-act="pr-close-cancel" data-key="${esc(row.key)}">Cancel</button>
      </div>`;
  }

  /**
   * Fetch the full view's half, once per card opened.
   *
   * Never on the poll, for the reason `ensurePr` is not either: it is a `gh` round trip
   * plus a walk of the session archive, for a screen nobody may be looking at. `force` is
   * what an act asks for afterwards — a merge that was refused has changed what GitHub
   * says, and the buttons must be drawn from the new answer rather than the one that was
   * refused.
   */
  async function ensurePrDetail(row, { force = false } = {}) {
    if (!row?.pr) return;
    if (!force && state.prDetail.has(row.key)) return;
    const before = state.prDetail.get(row.key);
    state.prDetail.set(row.key, { loading: true, pr: before?.pr || null, agent: before?.agent || null, unavailable: null });
    paintPrCard(row.key);
    /* `key` is the repo — `beadcause`, or `climative/athena-service` (bc-l853.6) — and it
       is what makes the number mean something: two repos in one workspace both have a #1.
       `workspace` rides along so a daemon that predates the key still answers. */
    const q = `key=${encodeURIComponent(row.repoKey || row.pr?.repoKey || row.workspace)}&workspace=${encodeURIComponent(
      row.workspace
    )}&number=${encodeURIComponent(row.pr.number)}${force ? '&refresh=1' : ''}`;
    try {
      const res = await api(`/api/pr/detail?${q}`);
      state.prDetail.set(row.key, { loading: false, pr: res.pr, agent: res.agent, unavailable: res.unavailable || null });
      // The row the daemon just re-read, back into the board this list draws from. Without
      // it a merge would leave the lamps and the rung saying what they said before it.
      if (res.row) adoptBoardRow(res.row);
    } catch (err) {
      // An unreachable daemon must not blank the sheet: the row is still on screen, still
      // true as of the last sweep, and the link out still works.
      state.prDetail.set(row.key, {
        loading: false,
        pr: before?.pr || null,
        agent: before?.agent || null,
        unavailable: err.message,
      });
    }
    paintPrCard(row.key);
  }

  /**
   * Put one freshly-read row back into the cached board.
   *
   * The board is a payload rather than a per-row store, so this reaches into it in place.
   * Worth doing rather than waiting for the next minute's sweep: an act on this screen
   * changes the row it acted on, and a lamp that goes on a minute late is a lamp you press
   * the button again over.
   */
  function adoptBoardRow(fresh) {
    for (const repo of state.board?.repos || []) {
      // By the row's own key, which names the repo: matching on the workspace and the number
      // would put a freshly-read `athena-service` #1 into `architecture`'s #1 as well, and
      // both rows would then be drawn from the same read.
      const at = (repo.prs || []).findIndex((p) => p.key === fresh.key);
      if (at !== -1) repo.prs[at] = fresh;
    }
  }

  /**
   * Repaint one PR card in place — never a render(), same as paintPr and paintPicks.
   *
   * The comment box on an open card is a textarea with a caret in it, and this runs on
   * every arm, every refusal and every detail that lands. `render()` would rebuild the
   * list and take the caret and the keyboard with it.
   */
  function paintPrCard(key) {
    const el = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    const row = prRows().find((r) => r.key === key);
    if (!el || !row) return;
    // What is typed lives in `state.prDraft` rather than in the element, so a repaint can
    // put it back — the same bargain public/session.js strikes with its composer.
    keepPrDrafts(el, key);
    // And where the caret was, but only if it was in *this* card's box. An arm timer expiring
    // six seconds after you armed merge is a repaint you did not ask for, and it must not
    // take the sentence you have since started typing with it.
    const focused = el.contains(document.activeElement)
      ? { role: document.activeElement.dataset?.role || '', at: document.activeElement.selectionStart ?? null }
      : null;
    const html = prCardHtml(row);
    if (!html) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = html;
    const fresh = wrap.firstElementChild;
    if (!fresh) return;
    el.replaceWith(fresh);
    if (!focused?.role) return;
    const box = fresh.querySelector(`[data-role="${focused.role}"]`);
    if (!box) return;
    box.focus();
    if (focused.at !== null && box.setSelectionRange) box.setSelectionRange(focused.at, focused.at);
  }

  /** Read whatever is in this card's two boxes back into state, before it is replaced. */
  function keepPrDrafts(el, key) {
    state.prDraft = state.prDraft || new Map();
    const comment = el.querySelector('[data-role="pr-comment"]');
    if (comment) state.prDraft.set(key, comment.value);
    const reason = el.querySelector('[data-role="pr-reason"]');
    if (reason) state.prDraft.set(`${key}|reason`, reason.value);
  }

  /**
   * Arm a button, or report that it was already armed.
   *
   * `true` means *this tap was the arming one and nothing should happen*. The window is
   * the same six seconds the delivery card and the board use, and it disarms itself, so a
   * card left open with a hot button cannot be finished by a knee an hour later.
   */
  function armFirst(key, what) {
    const token = `${key}|${what}`;
    if (state.armed === token) {
      disarm();
      return false;
    }
    state.armed = token;
    clearTimeout(state.armedTimer);
    state.armedTimer = setTimeout(() => {
      disarm();
      paintPrCard(key);
    }, 6000);
    paintPrCard(key);
    return true;
  }

  /**
   * One POST about one pull request, and one sentence about what happened to it.
   *
   * Every act on the full view goes through here so that four things cannot be got
   * differently right in four places:
   *
   * - **The card says what happened, not a toast.** GitHub's refusals are the whole reason
   *   this screen re-reads the pull request before drawing its buttons, and a refusal you
   *   have to have been looking at is a refusal you act on twice.
   * - **A double tap cannot send twice.** `prBusy` disables the buttons for the flight;
   *   one at a time is enough, because only one card is ever open.
   * - **The row is re-read afterwards, always.** A merge changes the lamps, the rung and
   *   what GitHub will say next; a close changes what buttons there should be. Forced,
   *   because the sweep the row came from is now wrong about the one row you are looking at.
   * - **Nothing typed is lost.** The success sentence is built by the caller, which is also
   *   where the draft is cleared — so a refused comment keeps its words and a delivered one
   *   does not.
   */
  async function actOnPr(row, path, body, said) {
    state.prBusy = row.key;
    state.prSaid.set(row.key, { kind: 'ok', text: 'Asking GitHub…' });
    paintPrCard(row.key);
    try {
      const res = await api(path, {
        method: 'POST',
        // The repo first, for the reason `ensurePrDetail` gives: a pull request number is
        // only unique within one, and a workspace may now hold forty.
        body: JSON.stringify({
          key: row.repoKey || row.pr?.repoKey || row.workspace,
          workspace: row.workspace,
          number: row.pr.number,
          ...body,
        }),
      });
      state.prSaid.set(row.key, { kind: 'ok', text: said(res) });
    } catch (err) {
      // GitHub's own sentence travels intact through lib/pr.js, so this is usually the
      // most useful thing on the screen: a failing check, a required review, a conflict.
      state.prSaid.set(row.key, { kind: 'bad', text: err.message });
    } finally {
      state.prBusy = null;
      paintPrCard(row.key);
      // The row and the buttons, from what is true now rather than from what was refused.
      await ensurePrDetail(row, { force: true });
      render(true);
      // A closed pull request gets no card in this list at all — that is bc-l8jp.6's rule
      // and it is right — so the one act that removes the screen it was performed on has
      // to say so somewhere that outlives it. Only then: everything else stays on the card,
      // where it can be read twice.
      if (!listEl.querySelector(`.card[data-key="${CSS.escape(row.key)}"]`)) {
        const note = state.prSaid.get(row.key);
        state.prSaid.delete(row.key);
        if (note) toast(note.text, note.kind === 'bad');
      }
    }
  }

  /**
   * Is a pull request even wanted right now?
   *
   * The kind filter decides, and it is the one thing that makes the extra sweep honest:
   * with `Questions` or `Merges` selected there is nothing a board could put on screen, so
   * nothing is asked for. Without the filter file at all the answer is *no* — a page whose
   * control never loaded has no way to show a status sub-filter either, and the whole
   * board's history dumped unfiltered into the inbox is a worse fallback than no PR rows.
   */
  const prsWanted = () => {
    const on = window.beadcause?.inboxFilter?.selected?.();
    return Array.isArray(on) && (!on.length || on.includes('pr'));
  };

  /** When the board was last *asked for* — not when it last answered. See loadBoard. */
  let boardAt = 0;
  let boardBusy = false;

  /**
   * Sweep the board, at most about once a minute.
   *
   * Failure is deliberately quiet *in the list* and loud in one place: the rows are simply
   * not there, and `boardTrouble()` says why under an empty list — which is where somebody
   * who selected `PRs` and got nothing is actually looking. The last good board stays on
   * screen rather than being thrown away, the same call the board page itself makes.
   *
   * The throttle is stamped *before* the request, so it counts asking rather than
   * answering. Both halves of that matter: a filter tap seconds after a sweep reuses what
   * is in hand, and a failing sweep waits for the next tick instead of being asked again
   * by the very `render()` it just triggered.
   */
  async function loadBoard({ force = false } = {}) {
    if (!state.token || boardBusy || !prsWanted()) return;
    if (!force && Date.now() - boardAt < 20000) return;
    boardBusy = true;
    boardAt = Date.now();
    try {
      const data = await api('/api/prs');
      state.board = data;
      state.boardError = data.unavailable || null;
      // Into the same warm entry the board page reads and writes (public/warm.js): one
      // sweep now warms both screens, and the background prewarm's floor sees it and
      // leaves the path alone. Without this the two pages would each fetch it.
      window.beadcause?.warm?.write?.('/api/prs', data);
    } catch (err) {
      if (err.message !== 'token rejected') state.boardError = err.message;
    } finally {
      boardBusy = false;
      render();
    }
  }

  /**
   * The board this device already had, drawn in the first frame.
   *
   * The same entry the board page keeps, because it is the same payload — and the whole
   * point of the warm layer is that a tab switch does not go blank while a `gh` sweep per
   * repo runs. The fetch behind it still happens; what this removes is the second or two
   * of an inbox with no pull requests in it that had them a moment ago.
   */
  function warmBoard() {
    const hit = window.beadcause?.warm?.read?.('/api/prs');
    if (!Array.isArray(hit?.data?.repos)) return false;
    state.board = hit.data;
    state.boardError = hit.data.unavailable || null;
    return true;
  }

  /** The one line that explains a list with no pull requests in it. */
  const boardTrouble = () => {
    if (!prsWanted() || !state.boardError) return '';
    return ` Pull requests could not be read: ${esc(state.boardError)}`;
  };

  /**
   * The repos this sweep could not read — named, with the reason, above the list.
   *
   * A pane and not a line inside `emptyHtml`, which is the whole of bc-ksdc. Two
   * reasons it cannot be part of the empty state:
   *
   * - **The list is usually not empty when this happens.** Seven repos are swept and
   *   one fails; the other six fill the screen and the missing one leaves no gap. An
   *   inbox that is quietly six-sevenths of itself looks exactly like an inbox.
   * - **The empty state is a claim, and this is what makes it false.** "Nothing to
   *   decide" under a repo that never answered is the app asserting something it did
   *   not check, which is the one failure the whole thing exists to prevent.
   *
   * Not filtered by space or workspace, deliberately, and for the same reason the
   * foundation pane is not: a repo you have filtered out is still a repo you are not
   * being told about, and the filter is a decision about what to *look* at rather
   * than about what you may be lied to over.
   *
   * `held` is how many rows are standing in for the ones that could not be read — the
   * last good answer, kept rather than replaced by none. Zero means this repo has not
   * answered since the daemon started, which is the one case where the list really has
   * nothing of its to show, and the line says so rather than implying staleness.
   */
  function troubleHtml() {
    const rows = (state.trouble || []).filter((t) => t && t.workspace);
    if (!rows.length) return '';
    const line = (t) => {
      const held = Number(t.held) || 0;
      const standing = held
        ? `showing what it last said (${held} ${held === 1 ? 'bead' : 'beads'})`
        : 'nothing of its is on this list';
      return `<li><b>${esc(t.workspace)}</b> — ${esc(t.error || 'the sweep failed')}
        <span class="trouble-held">${esc(standing)}</span></li>`;
    };
    return `<div class="trouble" role="status">
      <strong>${rows.length === 1 ? 'A repo could not be read' : `${rows.length} repos could not be read`}</strong>
      <ul>${rows.map(line).join('')}</ul>
      <span class="trouble-note">Retried on every sweep. Counts on this screen are what
        was last read, not what is there now.</span>
    </div>`;
  }

  /**
   * The other kind of out-of-date: this repo reads perfectly and is no longer the same
   * tracker as the machine it shares one with.
   *
   * Its own banner rather than a row in the one above, because the two say opposite
   * things about the list underneath them. "Could not be read" means what you are
   * looking at is stale, and it is honest about which repo. This one means what you are
   * looking at is *exactly right about this Mac* — every count is real, nothing is
   * standing in for anything — and silently missing whatever the other machines have
   * written since it broke. There is nothing on the screen to notice, which is why it
   * is drawn even though the list beneath it looks fine.
   *
   * A conflict is called out in its own words. Everything else here retries and very
   * often fixes itself by the next interval; a conflict is two machines that wrote the
   * same bead, and no number of retries has ever resolved one.
   */
  function syncTroubleHtml() {
    const rows = (state.syncTrouble || []).filter((t) => t && t.workspace);
    if (!rows.length) return '';
    const conflicts = rows.filter((t) => t.conflict);
    const line = (t) =>
      `<li><b>${esc(t.workspace)}</b> — ${esc(t.error || 'the sync failed')}
        <span class="trouble-held">${esc(
          t.conflict ? 'needs somebody to say which version wins' : `retrying ${t.phase ? `the ${t.phase}` : ''}`.trim()
        )}</span></li>`;
    return `<div class="trouble trouble-sync" role="status">
      <strong>${
        conflicts.length
          ? `${conflicts.length === 1 ? 'A tracker has' : `${conflicts.length} trackers have`} conflicted`
          : `${rows.length === 1 ? 'A tracker is' : `${rows.length} trackers are`} not syncing`
      }</strong>
      <ul>${rows.map(line).join('')}</ul>
      <span class="trouble-note">${
        conflicts.length
          ? 'Two machines wrote the same bead and Dolt cannot merge them. This will not clear on its own.'
          : 'This list is right about this Mac. Anything written on another machine since it broke is not on it.'
      }</span>
    </div>`;
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

    const chosen = pickedOption(q);
    const options = opts
      .map((o) => {
        // The pressed state is painted in place by paintPicked() — it must never go
        // through render(), which would rebuild the list under a half-typed answer.
        //
        // The tags are *siblings* of `.label`, never inside it, because paintPicked
        // writes `label.textContent`: a badge nested in there would survive until
        // the first tap and then silently vanish.
        const picked = chosen?.id === o.id;
        return `<button class="option${o.recommended ? ' rec' : ''}${
          picked ? ' picked' : ''
        }" data-act="option" data-key="${esc(q.key)}" data-opt="${esc(o.id)}" data-label="${esc(
          o.label
        )}" aria-pressed="${picked}">
          <span class="label">${esc(o.label)}</span>
          ${o.recommended ? '<span class="rec-tag">★ recommended</span>' : ''}
          ${
            // Worth saying before the tap rather than only in the toast after it:
            // this option is an instruction, and the bead stays open.
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
      ${cardTopHtml(q, {
        detailLabel: draft ? 'Resume your answer' : hasBrief ? 'Show details' : 'Write an answer',
      })}
      <div class="card-head">
        <div class="meta">
          <span class="pill">${esc(q.workspace)}</span>
          <span class="pill id">${esc(q.id)}</span>
          ${q.priority != null ? `<span class="pill p${q.priority}">P${q.priority}</span>` : ''}
          ${q.dependentCount ? `<span class="pill">blocks ${q.dependentCount}</span>` : ''}
          ${draft && !open ? '<span class="draft-flag">draft saved</span>' : ''}
          <time>${esc(relTime(q.createdAt))}</time>
        </div>
        ${arrivedQuietHtml(q)}
        ${activityHtml(q)}
        <p class="q">${esc(q.question || q.title)}</p>
        ${q.question && q.title !== q.question ? `<p class="subtitle">${esc(q.title)}</p>` : ''}
        ${(q.errors || []).map((e) => `<p class="subtitle bad">⚠ ${esc(e)}</p>`).join('')}
      </div>
      ${answeredBeforeHtml(q)}
      ${proposalHtml(q)}
      ${deliveryHtml(q)}
      ${options ? `<div class="options">${options}</div>` : ''}
      ${
        // The foot is down to one thing, and it is a body of content rather than a
        // control: the details toggle is in the top bar and the log is the only
        // button left that opens a second pane on the card. Drawn only while an
        // agent has it, or for as long as its pane is open — the reply can land
        // while you are still reading the log, and a pane whose button has gone
        // with the flag that drew it is one you can no longer close.
        q.awaitingAgent || state.logs.has(q.key)
          ? `<div class="actions">
        <button class="linkish log-btn" data-act="log" data-key="${esc(q.key)}">${
          state.logs.has(q.key) ? 'Hide session log' : 'Session log'
        }</button>
      </div>`
          : ''
      }
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
      : esc(answerLabel(pickedOption(q)));
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
   * What the primary button will actually do, in its own words.
   *
   * *Answer & close* is the ordinary ending and stays the default. It becomes a lie
   * the moment the box holds a **commission** — an option the agent marked
   * `closes: false`, which puts the answer on the thread, takes the `human` label
   * off and hands the bead back as work rather than finishing it (lib/decision.js).
   * That used to be a property of the button you pressed; now that the buttons only
   * fill the box, the last thing between the pick and the write is this label, so
   * this is the only place left that can say it.
   *
   * Plain text, not HTML — it goes through `esc()` when the card is drawn and
   * through `textContent` when paintPicked() repaints it.
   */
  function answerLabel(chosen) {
    return chosen?.closes === false ? 'Answer & commission' : 'Answer & close';
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
   * A `decision` block gets `.options`: full-width buttons above the fold, one per
   * choice the agent actually wrote. These are the other case — lib/suggest.js read
   * them out of the prose — and both now do the same thing to the box under them.
   * What is left of the difference is worth drawing, and is three things.
   *
   * **They live in the answer box, not above the card.** Their whole job is to
   * save you typing into the box under them, and a chip several screens away from
   * the thing it fills is a chip you have to scroll back from to check.
   *
   * **They are chips, not buttons.** The visual weight has to say which kind of
   * thing this is without a word of explanation: `.options` are the answers the
   * question came with, and these were guessed at by a parser reading a paragraph.
   *
   * **They let go the moment you edit them.** A pressed chip is a claim that the
   * box says exactly what the chip says, and nothing more — see paintSuggested. An
   * option is the opposite and stays lit while you qualify it, because it carries
   * an id that means something after the words have changed and a chip does not.
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
      ${cardTopHtml(q)}
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
              `<a href="${esc(docUrl(doc.path, q))}" target="_blank" rel="noopener noreferrer"><span>${esc(
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

  /**
   * The other way to empty the list: the kind filter, which is one collapsed line and
   * therefore the easiest thing on the screen to forget you set. Says what it is set
   * to, so the way out is a fact rather than a hunt.
   */
  const kindNudge = () => {
    const f = window.beadcause?.inboxFilter;
    if (!f || !f.selected().length) return widenNudge();
    return ` The filter above is showing only <b>${esc(f.label())}</b>.`;
  };

  function emptyHtml() {
    // "Nothing to decide" printed directly under a pane saying an agent is asking to
    // be changed is the app contradicting itself. The empty state is about the
    // questions feed, so when the other channel has something in it, say which
    // emptiness this is.
    if ((state.requests || []).length) {
      return `<div class="empty">Nothing about work is waiting.${widenNudge()}${boardTrouble()}</div>`;
    }
    if (state.scope === 'agent') {
      return `<div class="empty"><strong>Nothing live</strong>No open, claimed or blocked beads in any workspace.${boardTrouble()}</div>`;
    }
    if (state.scope === 'both') {
      return `<div class="empty"><strong>Nothing live</strong>No questions, and no bead open anywhere.${boardTrouble()}</div>`;
    }
    // The one empty state that is also the app at rest, so it is the one that says
    // what the button in the corner is for. ＋ is the only control on this screen with
    // nothing else naming it, and an empty inbox is exactly when you would want it.
    return `<div class="empty"><strong>Nothing to decide</strong>No open questions labelled <code>human</code>.${widenNudge()}${boardTrouble()} ＋ starts a conversation about what to file next.</div>`;
  }

  /**
   * The foundation channel: agents asking to change what they are.
   *
   * A pane of its own, above the list and outside every filter on it. The reasoning,
   * because it looks like a styling choice and is not:
   *
   * - **It is not filtered by space or workspace.** Those answer "which of my lives
   *   is this about", and an agent's definition is not in one of them — it is the
   *   same chat session whichever repo it was working in when it hit the wall. The
   *   push agrees, as of bc-8on: `quietReasonFor` in lib/spaces.js exempts this
   *   channel from the filter, so a request cannot be visible here and silent on the
   *   phone at the same time. A mute still quietens it — that one is about your
   *   evening rather than about which life the bead is in.
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
    // The kind filter narrows this too, and has to: it sits directly above the list
    // and the number is the list's own count. The server's held figure cannot know
    // about it, so a kind filter forces the local sweep — which is available for
    // exactly the scopes that can have questions in them.
    const narrowed = Boolean(window.beadcause?.inboxFilter?.selected?.().length);
    // And the P0 board narrows it for the same reason the kind filter does — it sits
    // above the same list and hides rows from it, so a count that ignored it would say
    // forty over a list of six. `boarded` forces the local sweep the same way `narrowed`
    // does: the server's held figure is a count of questions, not of descendants.
    const boarded = isBoarded();
    const local = underOwnedP0s(state.questions).filter((q) => !q.agent && (!narrowed || inKind(q))).length;
    const waiting = swept || narrowed || boarded || !Number.isFinite(held) ? local : held;

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
   * The option this card's answer is currently making, or null.
   *
   * Two sources, and the order matters. The tap wins, because it survives you
   * editing the words — picking (b) and then qualifying it in a sentence is still
   * picking (b), and that is the gesture the buttons exist for. Failing that, a
   * box that still says exactly what one of them would have put there is read as
   * that pick, which is what carries a choice across a reload: the draft is in
   * localStorage and `state.picked` is not.
   */
  function pickedOption(q) {
    const opts = q?.decision?.options || [];
    const tapped = opts.find((o) => o.id === state.picked.get(q?.key));
    if (tapped) return tapped;
    const draft = getDraft(q?.key).trim();
    return (draft && opts.find((o) => o.response.trim() === draft)) || null;
  }

  /**
   * Light the option that is in the box, and say what the button under it will do.
   *
   * In place, never through render(), for the usual reason — the textarea directly
   * below is holding the words this is about. The primary button is repainted with
   * it because the two are one statement: an option marked `closes: false` is a
   * commission, and *Answer & close* over it would name the one outcome that is
   * not going to happen.
   */
  function paintPicked(key) {
    const q = byKey(key);
    const card = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
    const buttons = card?.querySelectorAll('.option') || [];
    // No choices on this card, so nothing here has anything to say — and in
    // particular it must not touch the primary button, which on a delivery says
    // "Request changes & close" and is not this function's to rename.
    if (!q || !buttons.length) return;
    const chosen = pickedOption(q);
    for (const btn of buttons) {
      const picked = chosen?.id === btn.dataset.opt;
      btn.classList.toggle('picked', picked);
      btn.setAttribute('aria-pressed', String(picked));
      const label = btn.querySelector('.label');
      if (label) label.textContent = btn.dataset.label;
    }
    const primary = card?.querySelector('.freeform .primary[data-act="answer"]');
    if (primary) primary.textContent = answerLabel(chosen);
  }

  /**
   * Repaint the armed control in place. Cheap, and never touches the textarea.
   *
   * Every armable control on the list is painted here, not just the one that was
   * tapped — arming any of them disarms the others, and a dismiss button left
   * reading "Tap again" after something else stole the arm would be a lie about
   * what the next tap does.
   */
  function paintArmed() {
    for (const btn of listEl.querySelectorAll('.dismiss')) {
      const armed = state.armed === `${btn.dataset.key}|dismiss`;
      btn.classList.toggle('confirm', armed);
      btn.textContent = dismissLabel(btn.dataset.key, btn.dataset.id, armed);
    }
    // A proposal's two bulk buttons are armable the same way, and they are the only
    // armed control in the app that also *creates* something — a stale "Tap again"
    // on one of them is the one worth least leaving on screen.
    for (const btn of listEl.querySelectorAll('.prop-bulk .bulk')) {
      const beads = byKey(btn.dataset.key)?.proposal?.beads || [];
      if (!beads.length) continue;
      btn.textContent = propBulkLabel(btn.dataset.key, beads, btn.dataset.pick);
      btn.classList.toggle('confirm', state.armed === `${btn.dataset.key}|prop-${btn.dataset.pick}`);
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

  /* ------------------------------------------------------ the chat sessions */

  /**
   * The conversations you have open, as rows this list can hold.
   *
   * They arrive on the same payload as everything else (`/api/questions` →
   * `consoles`) and are turned into rows here rather than merged into
   * `state.questions`, because nearly everything that reads that array is about beads:
   * the waiting count, the space picker's per-repo numbers, `byKey`, the answer path,
   * the flight the answer takes into the mark. A chat session would be counted by all
   * of them and could be answered by none.
   *
   * What a row does carry is exactly what the two filters above it read — `workspace`
   * and `space` for the picker, and `session` for the kind table, which is the field
   * `kindOf` tests. `key` is namespaced with a `chat/` prefix that no workspace can
   * produce, so a row here can never collide with a bead's `workspace/id`.
   */
  const chatRows = () =>
    (state.consoles || []).map((c) => ({
      session: c,
      key: `chat/${c.id}`,
      workspace: c.workspace,
      space: c.space || null,
    }));

  /**
   * What a chat row says while you are scrolling past it.
   *
   * The requirement is "which session, in what state, **without opening it**", so the
   * state is a word rather than a colour: the agent is composing a reply, or a
   * proposal is sitting there waiting to be read, or it is your turn. Those are the
   * only three things a conversation can be doing, and which one it is decides
   * whether you tap it now or later.
   *
   * It borrows `.console-row` and `.work-row` from the launcher on purpose. A
   * conversation is the same object on both screens and a second shape for it would
   * be a second thing to recognise; what differs is the `.card` around it, because
   * here it is one item in a stack of cards rather than a line in a list.
   */
  function chatRowHtml(row) {
    const c = row.session;
    const agent = (c.agent || 'console') === 'console' ? null : { name: c.agentName || c.agent, emoji: c.agentEmoji || '🤖' };
    const thinking = c.status === 'thinking';
    // The same two marks the launcher draws: the phase slot takes the spark while a
    // turn is running, so what the conversation *is* has to be readable somewhere
    // else — the pill beside the repo.
    const phase = thinking ? '<span class="spark"></span>' : agent ? esc(agent.emoji) : '💬';
    const bits = [];
    if (thinking) bits.push('thinking…');
    else if (c.beadCount) bits.push(`${c.beadCount} proposed · your turn`);
    else if (!c.messageCount) bits.push('not started');
    else bits.push('your turn');
    if (c.created?.length) bits.push(`${c.created.length} created`);
    if (c.seed) bits.push(`from ${c.seed.id}`);
    // Which conversation, said in full, because this is the accessible name of a
    // button and "Dismiss" alone in a list of six of them says nothing about which
    // one is about to leave. The agent is named for the same reason the row draws its
    // pill: two chats in the same repo are told apart by who they are with.
    const title = c.title || 'Untitled';
    const dismissLabel = agent ? `Dismiss “${title}” — your chat with the ${agent.name}` : `Dismiss “${title}”`;
    // The card is a wrapper around the link rather than being the link, because a
    // <button> cannot live inside an <a> and the ✕ has to be somewhere. Siblings, as
    // the launcher's rows are (.console-row in public/console.js): that shape is what
    // makes "dismiss" incapable of also opening the conversation, rather than a
    // preventDefault that has to keep being right.
    //
    // `data-key` moves to the wrapper with the `.card` class it is looked up beside —
    // capturePlace() anchors the scroll position to `.card[data-key]`, and a row that
    // carried none would be a hole in the list you cannot be restored to, the poll
    // putting you back at the nearest card instead.
    return `<div class="card chat-card" data-key="${esc(row.key)}">
      <a class="work-row" href="/console?id=${encodeURIComponent(c.id)}">
        <span class="work-phase">${phase}</span>
        <span class="work-main">
          <span class="work-title">${esc(title)}</span>
          <span class="work-sub"><span class="pill">${esc(c.workspace)}</span>${
            agent ? `<span class="pill agent">${esc(agent.emoji)} ${esc(agent.name)}</span>` : ''
          }${esc(bits.join(' · '))}</span>
        </span>
        <time>${esc(relTime(c.updatedAt))}</time>
      </a>
      <button class="row-x" data-act="chat-dismiss" data-key="${esc(row.key)}" data-id="${esc(c.id)}"
        aria-label="${esc(dismissLabel)}">✕</button>
    </div>`;
  }

  /* ----------------------------------------------------- the JIRA tickets */

  /**
   * The tickets assigned to you in JIRA, as rows this list can hold.
   *
   * The third thing in this file that is not a bead, and it follows the two above it
   * exactly (bc-0i27.3). They ride the inbox payload (`tickets`), they are turned into
   * rows here rather than merged into `state.questions`, and the reason is the one
   * `chatRows` gives: nearly everything reading that array is about beads — the waiting
   * count, the picker's per-repo numbers, `byKey`, the answer path, the flight an answer
   * takes into the mark. A JIRA ticket would be counted by all of them and answered by
   * none, and unlike a chat session it is not even a thing this app owns yet.
   *
   * **What a held ticket is**, and it is fixed by bc-0i27.2 rather than by this file:
   * `key`, `summary`, `status`, `updated`, `url`, `assignee` — deliberately enough to
   * draw the row with no second call, and deliberately no description body, which the
   * view in bc-0i27.6 fetches when you open one. Two more fields come from *where* the
   * ticket was found rather than from JIRA: `workspace`, because JIRA is configured per
   * workspace, and `space`, because the inbox filters on `q.space` before anything else
   * and a row without one collects under "Other" and vanishes the moment a space is
   * picked. That is the same requirement the chat rows put on `inboxConsoles`.
   *
   * `key` is namespaced `jira:<workspace>/<ticket>` — a fourth namespace beside the `@`
   * panes, `pr:` and `chat/`, and no bead's `workspace/id` can begin with it. Two
   * workspaces pointed at the same JIRA project would otherwise hand this list one row
   * twice under one key, and a reconcile keyed on that would draw one of them.
   */
  const jiraRows = () =>
    (state.tickets || []).map((t) => ({
      jira: t,
      key: `jira:${t.workspace || ''}/${t.key}`,
      workspace: t.workspace,
      space: t.space || null,
    }));

  /**
   * What a ticket row says while you are scrolling past it.
   *
   * The requirement is which ticket, and what state it is in, without opening it — so
   * the key and the status are on the row rather than behind a tap, and the summary is
   * the title because that is the only part anybody reads. `assignee` is not drawn: the
   * whole query is *assigned to you*, so a name on every row would be the same name on
   * every row. It is carried on the ticket for the view (bc-0i27.6) and for the day the
   * query grows a second slice.
   *
   * It borrows `.work-row` from the chat rows and the launcher for the reason they
   * borrow it from each other — a fourth shape of row is a fourth thing to recognise in
   * a list you scan — and the `.card` around it is what makes it one item in a stack.
   *
   * **The link goes to JIRA, and that is the interim.** bc-0i27.6 replaces it with the
   * ticket view opened over the tab, which is where the decision actually gets made;
   * until then a row you cannot do anything with would be a row that is only a
   * notification. `openLinksInNewTab` does not reach it (it sweeps `.md`, `.links` and
   * `.docs` only), so the attributes are written here.
   */
  function jiraRowHtml(row) {
    const t = row.jira;
    const bits = [];
    if (t.status) bits.push(String(t.status));
    // Which workspace's JIRA this came off. Drawn for the same reason a chat row draws
    // its repo: with two workspaces configured, the ticket key alone does not say which
    // project you are looking at.
    return `<div class="card jira-card" data-key="${esc(row.key)}">
      <a class="work-row" href="${esc(t.url || '#')}" target="_blank" rel="noopener noreferrer">
        <span class="work-phase">🎫</span>
        <span class="work-main">
          <span class="work-title">${esc(t.summary || t.key || 'Untitled')}</span>
          <span class="work-sub"><span class="pill id">${esc(t.key || '')}</span>${
            row.workspace ? `<span class="pill">${esc(row.workspace)}</span>` : ''
          }${esc(bits.join(' · '))}</span>
        </span>
        <time>${esc(relTime(t.updated))}</time>
      </a>
      ${jiraIngestHtml(row)}
    </div>`;
  }

  /**
   * What became of the ticket — step 5 of bc-0i27, and the only part of a ticket row
   * that is about beadcause rather than about JIRA.
   *
   * A ticket arrives, gets one held epic within the minute, and is then *read* by an
   * agent that proposes what it decomposes into (lib/jiraingest.js). That takes minutes,
   * so the row has three things to be able to say and each of them is a different next
   * move:
   *
   *   - **still reading** — there is nothing to look at yet. Tapping the row opens the
   *     ticket, which is what you read to decide, and that is the whole affordance.
   *   - **the parent id** — the reading finished and there are beads. The id is a link
   *     into the bead's own detail view, because "N beads" you cannot open is a claim
   *     rather than a result.
   *   - **it failed** — said out loud, with the reason, rather than left saying *reading*
   *     forever. A stuck ingestion that looks like a slow one is the failure this line
   *     exists to make impossible: nothing retries it until the daemon restarts, so
   *     nobody would ever find out.
   *
   * Outside the anchor above rather than inside it, and that is not layout preference: an
   * `<a>` inside an `<a>` is invalid, and the two links genuinely go to different places
   * — the row to JIRA, the pill to the bead.
   */
  function jiraIngestHtml(row) {
    const ing = row.jira?.ingest;
    if (!ing) return '';
    const bead = ing.epic
      ? `<a class="pill id" href="${esc(graphUrl({ workspace: row.workspace, id: ing.epic }))}&amp;open=1"
          target="_blank" rel="noopener">${esc(ing.epic)}</a>`
      : '';
    if (ing.state === 'done') {
      const n = Number(ing.children) || 0;
      return `<div class="jira-ingest">${bead}<span>${n} bead${n === 1 ? '' : 's'} under it</span></div>`;
    }
    if (ing.state === 'failed') {
      // The epic is still there and still worth opening — it is the ticket's bead
      // whether or not anything was written under it — so the id stays on the row.
      return `<div class="jira-ingest bad">${bead}<span>could not be read — ${esc(ing.error || 'no reason given')}</span></div>`;
    }
    return `<div class="jira-ingest waiting"><span>${
      ing.state === 'queued' ? 'waiting to be read…' : 'reading the ticket…'
    }</span></div>`;
  }

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

  /**
   * The scope, as a group of chips inside the filter menu.
   *
   * There used to be three rows in `#filters`, coarsest first: which slice of the
   * tracker, then which space, then which workspace within it. The bottom two are the
   * space picker in the top bar now (public/spacebar.js) — they were the inbox's
   * private copy of a choice that four other pages were each making their own way, and
   * this page was the only one where it was visible at all.
   *
   * The scope stayed, because it is genuinely a different kind of control: it decides
   * what gets *fetched* — questions, or every live bead — while the picker decides
   * which repo any of it is about. Two axes, and only one of them belongs to the whole
   * app. What has changed is that it no longer costs a permanent row: it shares the
   * hover-open panel with the kind chips (public/inboxfilter.js), because two
   * collapsing controls side by side would be the three rows again with extra steps.
   */
  const scopeGroup = {
    id: 'scope',
    legend: 'Show',
    all: 'Everything',
    options: () => SCOPE_CHIPS.map(([id, label, note]) => ({ id, label, note, on: state.scope === id })),
    pick: (id) => chooseScope(id),
  };

  /**
   * Which kinds this scope can contain at all.
   *
   * `human` sweeps the questions, `agent` sweeps the live beads nobody is asking you
   * about, `both` does both — so a chip for the other side would be a control that
   * cannot change anything. The filter drops any selection this leaves unreachable;
   * see `survey` in public/inboxfilter.js.
   *
   * `any` is the exception and it is not a special case so much as the absence of
   * one: a pull request comes off `gh`, a chat session off no sweep at all and a JIRA
   * ticket off JIRA, so for none of them is there a scope that could have failed to
   * fetch it, and none of them has a scope in which its chip would be dead.
   */
  const kindsForScope = () =>
    (window.beadcause?.inboxFilter?.KINDS || [])
      .filter(
        (k) =>
          k.side === 'any' ||
          (state.scope === 'both' ? true : k.side === (state.scope === 'human' ? 'question' : 'agent'))
      )
      .map((k) => k.id);

  /** Does this row survive the kind filter? True when the control never loaded. */
  const inKind = (q) => window.beadcause?.inboxFilter?.matches?.(q) ?? true;

  /**
   * Hand the control what this render is about to draw: which kinds are reachable, and
   * how many of each survived the space picker. The numbers are counted *before* the
   * kind filter, so a chip's count is what picking it would leave you with.
   */
  function surveyKinds(rows) {
    const f = window.beadcause?.inboxFilter;
    if (!f) return;
    const counts = {};
    /** The level below: how many pull requests are on each rung of the ladder. */
    const status = {};
    for (const q of rows) {
      const kind = f.kindOf(q);
      if (!kind) continue;
      if (q.pr?.stage) status[q.pr.stage] = (status[q.pr.stage] || 0) + 1;
      // Counted *through* the row's own sub-filter, so `PRs 2` means the two you would
      // get and not the thirty-five that exist. Every kind without one answers true.
      if (f.inSub?.(q) ?? true) counts[kind] = (counts[kind] || 0) + 1;
    }
    f.survey({ kinds: kindsForScope(), counts, sub: { status } });
  }

  /** Chips and the one line above them, repainted in place. Never rebuilds the panel. */
  function renderFilters() {
    // Hidden only if the control never mounted — an empty nav with padding in it is a
    // gap above the list that nothing explains.
    filtersEl.hidden = !filtersEl.firstElementChild;
    window.beadcause?.inboxFilter?.paint?.();
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
    // Over the kind filter as well as the scope, for the same reason: a picker saying
    // 5 above a list showing 1 is the two halves of one screen disagreeing about the
    // same beads.
    // …and over the P0 board, third of the three for the same reason: every filter
    // between the sweep and the screen has to be applied here or the picker is counting
    // a list nobody is looking at.
    for (const q of underOwnedP0s(state.questions)) {
      if (!inKind(q)) continue;
      counts[q.workspace] = (counts[q.workspace] || 0) + 1;
    }
    window.beadcause?.space?.adopt({
      spaces: state.spaces,
      // Configured workspaces, not the ones with something in them: the picker is how
      // you reach a quiet repo.
      workspaces: Array.isArray(data.workspaces) ? data.workspaces : undefined,
      counts,
      // So the picker's own numbers carry the same caveat the pane above the list
      // does. `state.trouble` rather than `data.trouble`: this is called with a
      // reconciled filter and one payload behind it, and the two must not be able to
      // disagree about which repos answered.
      trouble: state.trouble,
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

  /**
   * The list, narrowed to what descends from a P0 you own. bc-rfnr.2.
   *
   * **Three ways this is a no-op, and all three are on purpose.** `owned: false` is an
   * install with no `cfg.me` — the feature has never been switched on and the inbox is
   * the flat list it always was. An empty `p0s` is a machine that knows who it is and
   * owns nothing yet, which is the state before bc-rfnr.5's triage has run: narrowing
   * there would hide the entire tracker behind a section with nothing in it, and an empty
   * screen is indistinguishable from a quiet afternoon. And a payload from a server that
   * predates the board leaves `state.p0board` at its default, which is the first case.
   *
   * **Descendants only.** `under` is built from `parent-child` edges alone (lib/ancestry.js);
   * a `discovered-from` trail or a blocking edge does not pull a bead in, which matters
   * because lib/filing.js puts a `discovered-from` on everything an agent ever filed.
   *
   * **A chat is always shown.** It has no bead, so no P0 can be above it — and it is where
   * a new P0 gets filed, so hiding it would make the filter the one thing on this screen
   * you could not get out of.
   *
   * **A pull request follows its beads.** Its own key is `pr:<repo>#<n>` and will never be
   * in `under`; what decides it is whether any bead it names is. A pull request that names
   * no bead stays visible, deliberately: it is a decision somebody is waiting on, and the
   * failure mode of hiding one is worse than the failure mode of showing one too many.
   */
  /** Is the board actually narrowing anything? The three no-op cases, asked once. */
  function isBoarded() {
    const board = state.p0board;
    return Boolean(board?.owned && (board.p0s || []).length);
  }

  function underOwnedP0s(rows) {
    const board = state.p0board;
    if (!isBoarded()) return rows;
    const under = board.under || {};
    return rows.filter((q) => {
      if (q.session) return true;
      // And a JIRA ticket, on the same rule and for a stronger reason: it has no bead
      // at all until bc-0i27.4 files one, so there is nothing for `under` to hold and
      // filtering on it would hide every ticket the moment you owned a P0. Once the
      // epic exists this is the line that has to start following it — which is
      // bc-0i27.5's to write, because it is bc-0i27.5 that puts the id on the row.
      if (q.jira) return true;
      if (q.pr) {
        const named = q.pr.beads || [];
        return !named.length || named.some((b) => under[`${q.workspace}/${b.id || b}`]);
      }
      return Boolean(under[q.key]);
    });
  }

  /**
   * The P0s you own, as their own section at the top — not sorted to the top.
   *
   * The difference is the whole bead. `byUrgency` would put a P0 first *today*, and on the
   * day six crashes file themselves (lib/errors.js files every daemon crash at P0) it would
   * put your epics below the fold with nothing to say they had moved. A section cannot be
   * pushed down by the list underneath it.
   *
   * Drawn as one chunk rather than a card each, because `warm.paint` reconciles by key and
   * the board moves as a unit: the counts on every card come from one sweep, so rebuilding
   * them one at a time would be four DOM writes where the data arrived as one.
   *
   * `waitingOn` is drawn only when it is there. It is the EpicAdvocate's sentence to write
   * (bc-rfnr.3) and is null until that lands — a placeholder saying "nothing" would be a
   * claim, where an absent line is honestly nothing yet.
   */
  function p0SectionHtml() {
    const board = state.p0board;
    if (!board?.owned) return '';
    const mine = (board.p0s || []).filter(
      (c) => (state.space === 'all' || spaceForWorkspace(c.workspace) === state.space) &&
        (state.workspace === 'all' || c.workspace === state.workspace)
    );
    if (!mine.length) return '';
    const cards = mine
      .map(
        (c) => `<div class="p0-card">
          <div class="p0-head"><a class="pill id" href="${esc(`${graphUrl(c)}&open=1`)}">${esc(c.id)}</a>${
            c.inFlight ? `<span class="p0-flight">${c.inFlight} in flight</span>` : ''
          }<span class="p0-open">${c.open === 1 ? '1 open' : `${c.open} open`}</span></div>
          <a class="p0-title" href="${esc(`${graphUrl(c)}&open=1`)}">${esc(c.title || '')}</a>
          ${c.waitingOn ? `<div class="p0-waiting">${esc(c.waitingOn)}</div>` : ''}
          <button type="button" class="p0-advocate" data-act="advocate" data-ws="${esc(c.workspace)}" data-bead="${esc(
            c.id
          )}">🧭 Put an advocate on it</button>
        </div>`
      )
      .join('');
    return `<section class="p0-board" aria-label="Your P0s"><div class="p0-kind">Your P0s</div>${cards}</section>`;
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
    // The pull requests, the chat sessions and the JIRA tickets go through both filters
    // too — they are rows in this list, and a filter that some of the list ignored would
    // be worse than no filter. Concatenated before the space test rather than after it,
    // so all four kinds of row are narrowed by the same predicate rather than by a copy
    // of it. That is also the whole of what makes a quiet space's tickets as quiet as
    // its questions: quiet is per space (lib/spaces.js), a workspace belongs to a space,
    // and a ticket carries the space of the workspace whose JIRA held it.
    const rows = [...state.questions, ...prRows(), ...chatRows(), ...jiraRows()];
    const inSpace = state.space === 'all' ? rows : rows.filter((q) => spaceOf(q) === state.space);
    const inRepo =
      state.workspace === 'all' ? inSpace : inSpace.filter((q) => q.workspace === state.workspace);
    // Then the third, which is this page's own and lives in the collapsed control
    // above the list: which *kinds* of incoming thing to show. Surveyed first so the
    // chips can carry counts of what they would leave you with, then applied.
    // And the fourth, which is not a chip and not yours to switch off: with P0s owned,
    // the list below the board is their descendants and nothing else. Applied *before*
    // `surveyKinds` so the kind chips count what you can actually get to — a chip
    // offering six merges when the filter leaves you one is a control that lies.
    const inBoard = underOwnedP0s(inRepo);
    surveyKinds(inBoard);
    const visible = inBoard.filter(inKind);

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
    // Under the foundation pane and above everything the sweep produced, including the
    // empty state — see `troubleHtml`. Below the requests because a request is a
    // decision somebody is waiting on and this is a caveat about the list; above the
    // list because a caveat under forty cards is a caveat nobody reads.
    // Above the sweep's own caveats and above the list: this is the thing the screen is
    // for. Below the shade and the foundation requests, which are decisions waiting on a
    // tap rather than a standing picture of the week.
    const p0s = p0SectionHtml();
    if (p0s) chunks.push({ key: '@p0', html: p0s });
    const missed = troubleHtml();
    if (missed) chunks.push({ key: '@trouble', html: missed });
    // Directly beneath it, in the same place and for the same reason. Second of the two
    // because it is the rarer one and because a repo can be in both at once — a locked
    // Dolt fails the read and the sync in the same tick — and reading "could not be
    // read" first is the order those two sentences make sense in.
    const diverged = syncTroubleHtml();
    if (diverged) chunks.push({ key: '@synctrouble', html: diverged });

    // `rows`, not `state.questions`: with no beads at all but a pull request open or a
    // conversation on the go, the list is not empty — and the first-run copy `emptyHtml`
    // writes would be sitting above a chat you are in the middle of.
    if (!rows.length) {
      chunks.push({ key: '@empty', html: emptyHtml() });
    } else if (!visible.length) {
      const where = state.workspace !== 'all' ? state.workspace : state.space !== 'all' ? state.space : '';
      // Which of the two filters emptied it. The kind filter is collapsed to one line
      // by design, so an empty list that it caused has to name it — otherwise the
      // reason the screen is blank is a word you have to hover to read.
      const kinded = inRepo.length > 0;
      chunks.push({
        key: '@empty',
        html: `<div class="empty">Nothing waiting${where ? ` in ${esc(where)}` : ''}.${
          kinded ? kindNudge() : widenNudge()
        }${boardTrouble()}</div>`,
      });
    } else {
      // Anything you've already replied to sinks to the bottom. It is not waiting on
      // you any more — an agent has it — so it must not sit between you and the
      // questions that are. Order within each group is left exactly as the server
      // sent it (priority, then age).
      //
      // The pull requests and the conversations sit between the two, on the same rule: a
      // bead asking you a question outranks either, and either outranks a bead an agent
      // already has back. Among themselves the pull requests are in ladder order — what
      // is in review before what is waiting on a deploy — and then newest first, which is
      // the board's own order (lib/prstage.js); the chats are newest first alone, because
      // a conversation is a thing you were just doing rather than a thing with a rung.
      // Pull requests before chats: one of them is a decision somebody is waiting on, the
      // other is yours to pick up whenever.
      //
      // Their keys are `pr:<workspace>#<number>` and `chat/<id>`, two more namespaces
      // beside the `@` panes and the beads' `workspace/id`: no bead key can begin with
      // either and no pane key can, so a reconcile cannot mistake one for another. Which
      // is what lets a row be left alone on every poll where its own HTML did not change
      // — the spark starting or a count moving is the whole of what rebuilds a chat row.
      const beads = visible.filter((q) => !q.pr && !q.session && !q.jira);
      const prs = visible
        .filter((q) => q.pr)
        .sort(
          (a, b) =>
            prRank(a) - prRank(b) || String(b.pr.updatedAt || '').localeCompare(String(a.pr.updatedAt || ''))
        );
      const chats = visible
        .filter((q) => q.session)
        .sort((a, b) => String(b.session.updatedAt).localeCompare(String(a.session.updatedAt)));
      // And the tickets, newest first alone, for the reason the chats are: a JIRA ticket
      // has no rung to sort by, only a last-touched. Below both of them and above the
      // replied beads, which is where it belongs on the same rule the comment above
      // uses — a pull request is a decision somebody is waiting on, a conversation is
      // yours to pick up whenever, and a ticket is work that has not started. None of
      // the three outranks a bead asking you something, and all three outrank a bead an
      // agent already has back.
      const tickets = visible
        .filter((q) => q.jira)
        .sort((a, b) => String(b.jira.updated || '').localeCompare(String(a.jira.updated || '')));
      const waiting = beads.filter((q) => !q.awaitingAgent);
      const replied = beads.filter((q) => q.awaitingAgent);
      for (const q of waiting) chunks.push({ key: q.key, html: cardHtml(q) });
      for (const q of prs) chunks.push({ key: q.key, html: prCardHtml(q) });
      for (const q of chats) chunks.push({ key: q.key, html: chatRowHtml(q) });
      for (const q of tickets) chunks.push({ key: q.key, html: jiraRowHtml(q) });
      for (const q of replied) chunks.push({ key: q.key, html: cardHtml(q) });
    }
    paintList(chunks);

    paintRequestBadge();
    paintSummary();
    renderFilters();
    // The live half of any delivery on screen. `ensurePr` is a no-op for a card it
    // has already fetched, so this costs one GitHub round trip per pull request for
    // the life of the tab, not one per render.
    for (const q of visible) if (q.delivery) ensurePr(q);
    // And the full view's half, for the one pull request that is open. Same bargain as
    // above and a no-op for a card already fetched — but it belongs here as well as on the
    // tap, because a card can be open without anyone having tapped it in this render:
    // a poll rebuilt the list under it.
    for (const q of visible) if (q.pr && state.open.has(q.key)) ensurePrDetail(q);
    // And the board, if pull requests are wanted and the last sweep has gone stale. A
    // no-op the rest of the time — see loadBoard.
    loadBoard();

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
    // Beads only. The monitor draws this as "N waiting", which is a claim about work
    // asking you something — and none of a pull request sitting on origin, a
    // conversation you left open, or a JIRA ticket nobody has decided about yet is one
    // of those.
    publishView(visible.filter((q) => !q.pr && !q.session && !q.jira));
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

  /**
   * A line across the bottom of the screen. Red when something went wrong.
   *
   * `bad` has three states rather than two, and the third is why this comment exists.
   * `true` is a **failure** — it is shown red *and* reported to the daemon, which files
   * it as a P0 bead (public/report.js). `'refused'` is red and files nothing: the app
   * declining what you typed is not a bug, and "Give it a name" would otherwise be a P0
   * every time somebody taps Create on an empty box.
   */
  function toast(msg, bad = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle('bad', Boolean(bad));
    toastEl.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (toastEl.hidden = true), bad ? 5000 : 2600);
    // Last, and never in the way: the toast is on screen before the report is built, and
    // a page whose reporter did not load takes the `?.` and behaves as it always did.
    if (bad === true) window.beadcause?.report?.toast?.(msg);
  }

  /**
   * A card by key, from either channel.
   *
   * Every interaction on this page — open, answer, comment, the ⋮ menu, the deep
   * link from a notification — goes through here, which is why the two channels can
   * be two arrays without two of everything else. Requests first: there are at most
   * a handful, and it makes the lookup that matters the cheap one.
   */
  /**
   * The row behind a key, in whichever of the three channels holds it.
   *
   * Pull requests are the third and were added the day one could be opened full screen
   * (bc-l8jp.7). They are synthesised from the board rather than stored, so this hands back
   * a fresh object every call — which is fine for every caller, because everything about an
   * open PR card that has to survive a repaint (the arm, the drafts, the fetched detail) is
   * keyed by the string rather than hung off the row.
   *
   * It matters here rather than only at the call sites: `adopt()` keeps a card open only if
   * `byKey` still finds it, so a `pr:` key this did not know would collapse the sheet you
   * were reading on every 25-second poll.
   */
  const byKey = (key) =>
    (state.requests || []).find((q) => q.key === key) ||
    state.questions.find((q) => q.key === key) ||
    (String(key).startsWith('pr:') ? prRows().find((r) => r.key === key) : null);

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
     * Put a P0 advocate on this P0 — the one button on the board's cards.
     *
     * First, and keyed on its own `data-bead` rather than on `data-key`: the P0 cards are
     * not inbox rows and have no bead key, so every branch below this one would read
     * `undefined` and act on nothing.
     *
     * The button is disabled for the round trip and left saying what happened either way.
     * It opens an iTerm window on the Mac that files beads — that is not something to fire
     * twice because a train swallowed the first tap, and the 409 the server gives a second
     * one is a sentence worth reading rather than a silent no-op.
     */
    if (act === 'advocate') {
      const bead = btn.dataset.bead;
      const was = btn.textContent;
      btn.disabled = true;
      btn.textContent = 'Opening…';
      try {
        await api('/api/bead/advocate', {
          method: 'POST',
          body: JSON.stringify({ workspace: btn.dataset.ws, id: bead }),
        });
        btn.textContent = '🧭 Advocate opened';
        toast(`A P0 advocate is planning ${bead}`);
      } catch (err) {
        // Back to a button you can press again, with the reason on screen. Every refusal
        // this route gives is a fixable state — unowned, closed, already running — so a
        // dead control saying nothing would be the wrong end of it.
        btn.disabled = false;
        btn.textContent = was;
        toast(err.message, 'refused');
      }
      return;
    }

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

    /**
     * Put a conversation away — the ✕ on a chat card.
     *
     * One tap, no arm-then-confirm, exactly as the launcher's ✕ has always been. The
     * close is **soft**: the transcript stays on disk, the id keeps working, and saying
     * anything to the conversation reopens it (lib/console.js `closeConsole`). There is
     * nothing here to be sure about, and the two-tap path this page uses for a dismissal
     * that is not reversible would be the wrong promise about a thing that is.
     *
     * The row goes on the tap rather than at the next 25-second poll, because a card
     * that sits there for twenty more seconds after you dismissed it reads as a tap
     * that missed. `dismissedChats` is what keeps it gone: `consoles` is taken whole
     * off every payload, and the poll in flight when you tapped was assembled before
     * this write landed — without the guard the row would slide back in a second later
     * and leave on the poll after that. See adopt().
     *
     * Refused mid-turn is the one failure worth hearing about: a conversation with a
     * `claude` process streaming into it cannot be closed under it, the server says so
     * with a 409, and the row comes back with the reason under it.
     */
    if (act === 'chat-dismiss') {
      // Belt: the ✕ is a sibling of the link rather than inside it, so there is no
      // navigation to stop — but this handler is also the one place that would have to
      // change if the row were ever restructured again.
      ev.preventDefault();
      const id = btn.dataset.id;
      const row = (state.consoles || []).find((c) => c.id === id);
      if (!row) return;
      btn.disabled = true;
      dismissedChats.add(id);
      state.consoles = state.consoles.filter((c) => c.id !== id);
      render(true);
      try {
        await api('/api/console/close', { method: 'POST', body: JSON.stringify({ id }) });
        // A card that vanishes silently reads as data loss, and this one is not even
        // gone — it says where it went.
        toast('Dismissed — still in the launcher under Dismissed');
      } catch (err) {
        dismissedChats.delete(id);
        if (!state.consoles.some((c) => c.id === id)) state.consoles = [...state.consoles, row];
        render(true);
        // `token rejected` has already put the sign-in prompt up — see api().
        if (err.message !== 'token rejected') toast(err.message, true);
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
      if (!name) return toast('Give it a name', 'refused');
      if (description.length < 20) return toast('Give it a foundation — a sentence or two', 'refused');
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

    /**
     * The bulk answer: approve what you have not declined, or decline the lot.
     *
     * Both sides come through here because both *are* the same answer with a
     * different set — which is what let the third button go. See propBulkHtml for
     * why they are not symmetrical: `yes` files everything not explicitly declined,
     * `no` files nothing whatever the rows say.
     */
    if (act === 'prop-bulk') {
      const q = byKey(key);
      const beads = q?.proposal?.beads || [];
      if (!beads.length) return;
      const side = btn.dataset.pick;
      const approved = side === 'yes' ? keepIndices(key, beads) : [];
      const token = `${key}|prop-${side}`;
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
        paintArmed();
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

    /* ------------------------------------------------- a pull request, full screen */

    /**
     * Tapping a pull request row: open it over the list (bc-l8jp.7).
     *
     * `openOnly` rather than `state.open.add`, so this obeys the same accordion every
     * other card does — `.card.open` is a fixed full-screen layer and a second one just
     * stacks on the first. The detail is fetched after the sheet is up rather than before
     * it: the row is already worth reading, and a screen that waits on `gh` to draw
     * anything is a screen that shows a spinner in a tunnel.
     */
    if (act === 'pr-open') {
      closeMenu();
      closeAgentMenu();
      disarm();
      const row = byKey(key);
      if (!row?.pr) return;
      openOnly(key);
      state.prSaid.delete(key);
      render(true);
      ensurePrDetail(row);
      return;
    }

    /**
     * Merge it, from the full view. Two taps, and the first sends nothing.
     *
     * The same arming as `/prs` and the delivery card, with the same 6-second window —
     * this is the one control on this screen whose consequence is outside this Mac and
     * cannot be taken back, and a phone in a pocket must not be able to do it on one tap.
     *
     * `POST /api/pr/merge` is the board's own endpoint, not the delivery card's answer
     * path: there is no bead being answered here. It merges, brings this Mac's base up
     * behind it, and retires any delivery card that was asking about this same pull
     * request — which is what stops the inbox from carrying a question that has been
     * settled by the screen next door.
     */
    if (act === 'pr-merge-go') {
      const row = byKey(key);
      if (!row?.pr) return;
      if (armFirst(key, 'merge')) return;
      await actOnPr(row, '/api/pr/merge', {}, (res) => {
        const land = res.land?.note ? ` ${res.land.note}.` : '';
        const cards = (res.cards || []).filter((c) => c.closed).map((c) => c.id);
        return `Merged #${row.pr.number}.${land}${cards.length ? ` Closed ${cards.join(', ')}.` : ''}`;
      });
      return;
    }

    /** Step one of closing: say you mean to, and get somewhere to say why. */
    if (act === 'pr-close') {
      state.prClose.add(key);
      disarm();
      paintPrCard(key);
      const box = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"] [data-role="pr-reason"]`);
      box?.focus();
      return;
    }

    if (act === 'pr-close-cancel') {
      state.prClose.delete(key);
      paintPrCard(key);
      return;
    }

    if (act === 'pr-close-go') {
      const row = byKey(key);
      if (!row?.pr) return;
      const el = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
      if (el) keepPrDrafts(el, key);
      const reason = (state.prDraft.get(`${key}|reason`) || '').trim();
      state.prClose.delete(key);
      await actOnPr(row, '/api/pr/close', { reason }, (res) => {
        state.prDraft.delete(`${key}|reason`);
        return `Closed #${row.pr.number}${res.reason ? ' with a reason' : ' — no reason given'}.${
          (res.beads || []).length ? ` ${res.beads.join(', ')} left as ${res.beads.length === 1 ? 'it was' : 'they were'}.` : ''
        }`;
      });
      return;
    }

    /**
     * Say something on the pull request itself.
     *
     * `/api/pr/comment`, which goes to GitHub and stops there — not `/api/comment`, which
     * writes on a *bead* and puts an agent onto answering it. The box is cleared only once
     * the daemon says it delivered, the same rule public/session.js keeps.
     */
    if (act === 'pr-comment') {
      const row = byKey(key);
      if (!row?.pr) return;
      const el = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"]`);
      if (el) keepPrDrafts(el, key);
      const text = (state.prDraft.get(key) || '').trim();
      if (!text) {
        state.prSaid.set(key, { kind: 'bad', text: 'Nothing to say yet — the box is empty.' });
        paintPrCard(key);
        return;
      }
      await actOnPr(row, '/api/pr/comment', { text }, () => {
        state.prDraft.delete(key);
        return `Said it on #${row.pr.number}.`;
      });
      return;
    }

    /**
     * A conflict: open a session on the branch whose job is the merge.
     *
     * Armed like merge, because it opens an unattended session on this Mac — cheaper than
     * a merge and still not something a pocket should start. What it does is in
     * `conflictPromptFor` (lib/session.js): merge the base into the branch, resolve, run
     * the repo's own gate, push, stop. The merge stays a tap here.
     */
    if (act === 'pr-conflicts') {
      const row = byKey(key);
      if (!row?.pr) return;
      if (armFirst(key, 'conflicts')) return;
      // Three sentences, because the daemon answers three different things. A second
      // press does not open a second window — it speaks to the session that already has
      // the pull request (lib/resolvers.js, bc-utyr) — and a press that reads back
      // "Session open" over a session somebody opened ten minutes ago is exactly the
      // report that made two of them look like one. The third is the Mac being full:
      // two resolvers at a time, the rest in line, and the note the daemon sends back
      // is the one that knows how many are ahead of this one.
      await actOnPr(row, '/api/pr/conflicts', {}, (res) =>
        res.queued
          ? `${res.note}.`
          : res.reused
            ? `Already being resolved on ${res.branch} — told that session you pressed again.`
            : `Session open on ${res.branch} — it pushes the branch and stops.`
      );
      return;
    }

    /** Cancel out of the conflict path: back to the list, nothing sent. */
    if (act === 'pr-cancel') {
      disarm();
      state.open.delete(key);
      render(true);
      return;
    }

    /**
     * A choice, tapped: put its words in the box. It does not answer.
     *
     * These buttons used to answer and close on two taps, the second one confirming
     * the first. What that shape could not do is the commonest thing anyone wants to
     * do with a multiple-choice question — pick one *and say something about it*.
     * The answer went on the thread as the agent's own sentence and nothing else, so
     * qualifying it meant ignoring the buttons and typing the whole choice out with a
     * thumb. Now the tap writes the sentence for you and you send it, which is the
     * same two gestures with the useful half in the middle.
     *
     * The pick outlives the words: `state.picked` remembers which button was pressed
     * even after you have rewritten what it typed, because only the id can say
     * whether this answer commissions work rather than settling it — see submit()
     * and lib/decision.js. That is also why the confirm tap is gone rather than
     * moved: *Answer & close* is now the confirmation, it is a different button in a
     * different place, and it names what it will do.
     *
     * Three rules about text already in the box, and they are the suggested chips'
     * rules for the same reasons (see the `suggest` handler): another option's words
     * are replaced, because you are picking again; words of your own are appended to,
     * because a tap must never eat a sentence you typed; and tapping the pick you
     * have already made takes it back, because undecided is a real state and there
     * has to be a way to it — but only while the box still says exactly what that tap
     * put there, so the way back can never delete anything you wrote.
     */
    if (act === 'option') {
      const q = byKey(key);
      const opts = q?.decision?.options || [];
      const opt = opts.find((o) => o.id === btn.dataset.opt);
      if (!opt) return;

      // Whatever else on the list was armed, this tap is not its confirming tap —
      // arming any control disarms the others, which is the rule paintArmed() exists
      // to keep on screen. It reads as belt-and-braces here because an option arms
      // nothing itself any more, and that is exactly how it went missing: this handler
      // used to arm and then answer on the second tap, and when bc-l8jp.9 turned it
      // into "fill the box", the unconditional disarm() went with the answering path
      // and only the one guarding expand() survived. So on a card already open — the
      // common case, because you have to see the options to tap one — the dismiss
      // under it stayed armed and went on saying "Tap again — hides dm-1" while you
      // picked. The next tap then means two things at once, and the two write to
      // different endpoints: /api/answer and /api/dismiss.
      disarm();

      // A closed card has no box to fill, so the tap opens it — the same move
      // `pr-changes` makes, and for the same reason: what happens next is typing.
      // Through expand() rather than openOnly(), so the brief and the thread arrive
      // with it: you are about to write an answer, and the card you write it on
      // should be the whole card.
      if (!state.open.has(key)) {
        await expand(key);
      }
      // After the expand, not before: it re-renders the list, and a repaint of the
      // old buttons would be thrown away with them.
      paintArmed();
      const box = listEl.querySelector(`.card[data-key="${CSS.escape(key)}"] [data-role="answer"]`);
      if (!box) return;

      const current = box.value.trim();
      if (state.picked.get(key) === opt.id && current === opt.response.trim()) {
        state.picked.delete(key);
        box.value = '';
      } else {
        state.picked.set(key, opt.id);
        const mine = current && !opts.some((o) => o.response.trim() === current);
        box.value = mine ? `${current}\n${opt.response}` : opt.response;
      }

      setDraft(key, box.value);
      paintDraftMark(key);
      paintPicked(key);
      box.focus();
      box.setSelectionRange(box.value.length, box.value.length);
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

      // The same disarm the `option` branch above makes, for the same reason and with
      // the same history: this branch fills the box and repaints in place, and it never
      // took the arm off anything (bc-z4o4). So on a card with suggestions rather than
      // decision options, arming the dismiss and then tapping a suggestion left the
      // dismiss underneath still reading "Tap again — hides …", and the next tap meant
      // two things at once — /api/answer or /api/dismiss, which is the ambiguity
      // scripts/dismiss-check.mjs calls "one tap, one meaning".
      //
      // Painted rather than rendered, because render() would rebuild the card under the
      // textarea and take the keyboard down with it — which is the whole reason this
      // branch paints in place to begin with.
      disarm();
      paintArmed();

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
        // `repo` is the checkout the bead named, where its workspace holds several
        // (lib/repos.js). It is usually the same word as the directory's basename and
        // saying it outright is still worth the characters: the basename is where the
        // window happens to be, the repo is the thing the bead said it was about.
        toast(
          `${res.endorsed ? 'Endorsed it — session' : 'Session'} open in ${
            res.repo?.name || res.dir.split('/').pop()
          } — go to your Mac`
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
      if (!text) return toast('Write something first', 'refused');
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
      if (!text) return toast('Write something first', 'refused');
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
      await submit(key, asChanges ? `CHANGES: ${text}` : text, {
        close: act === 'answer',
        // Which choice this sentence is making, when it is making one. The words may
        // have been edited into a qualified version of it and the server never tries
        // to read the choice back out of them — the id is what says whether this
        // answer commissions work, and only the button that filled the box knows it.
        // A comment names no option: it settles nothing, so it can commission nothing.
        option: act === 'answer' ? pickedOption(q)?.id || null : null,
      });
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
    // An option is the other way round, and deliberately: editing its words is
    // *qualifying* the choice, not abandoning it, so the pick survives every
    // keystroke. Emptying the box is the one edit that ends it — at that point
    // there is nothing left of the answer it was a claim about.
    if (!box.value.trim()) state.picked.delete(key);
    paintPicked(key);
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

  /** Conversations dismissed here that the server has not yet been seen to agree are
   *  gone. A set rather than a counter, unlike `shadeWrites` above, because what has
   *  to be suppressed is one named row out of a list that is adopted whole — and it
   *  has to stay suppressed past the write, not only during it: the poll that was in
   *  flight when you tapped answers with the row still on it. Emptied by adopt(), one
   *  id at a time, on the first payload that no longer carries it. */
  const dismissedChats = new Set();

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

  /* ---------------------------------------------------------------- scope */

  /**
   * Move the armed scope chip, and the line above it, without rebuilding the panel.
   *
   * The chips are painted by renderFilters(), but the switch below clears the list and
   * waits on `bd` rather than rendering — so on the tap itself there is nothing to
   * repaint them. The control's own `paint()` also touches nothing structural, which
   * is what lets it be called while the panel is open under a pointer.
   */
  function paintScope() {
    window.beadcause?.inboxFilter?.paint?.();
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
    // Before the paint, because the scope decides which kind chips exist at all — and
    // a selection the new scope cannot produce is dropped here rather than left to
    // hide every row the refetch is about to bring back. Counts go to zero with the
    // list; the fetch below is what fills them in again.
    surveyKinds([]);
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
   * The parked poll, and with it where in `/api/poll`'s event log the list on screen
   * was true.
   *
   * Mounted further down (see `follow`), and null until then. The sequence lives on
   * the handle rather than in a variable here, because the loop is the thing that has
   * to drop an answer that came back about an older list — two copies of that number
   * is how the poll would come to apply a payload the page had already replaced.
   *
   * 0 means "we do not know" — an old daemon that does not send it, nothing fetched
   * yet, or a poll that lost its place — and every reader treats that as a reason to
   * fall back to the timer.
   */
  let stream = null;
  const seqNow = () => stream?.seq || 0;
  const seqIs = (v) => {
    if (stream) stream.seq = Number(v) || 0;
  };

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
    // Taken whole rather than merged: a conversation has no local state on this page
    // — no draft, no open card, nothing half-answered — so the server's copy is
    // always the better one. Absent means a server that predates the field, and
    // keeping the last list is the same call `requests` makes above.
    // — minus anything just dismissed from this page and still on the wire. A payload
    // assembled before that write landed still lists the conversation, and adopting it
    // would put the row back under the tap that removed it. Each id stops being
    // suppressed on the first payload that agrees it is gone, which is also what lets
    // a conversation reopened by saying something to it come back as a row.
    if (Array.isArray(data.consoles)) {
      state.consoles = data.consoles.filter((c) => !dismissedChats.has(c.id));
      for (const id of dismissedChats) if (!data.consoles.some((c) => c.id === id)) dismissedChats.delete(id);
    }
    // Taken whole, on the same terms as `consoles` and for the same reason: a ticket has
    // no local state on this page — no draft, no open card, nothing half-answered — so
    // the server's copy is always the better one. Absent means a server whose poller
    // (bc-0i27.2) has not landed yet, or an install with no JIRA configured at all, and
    // in both cases leaving the last list alone is what stops a mixed fleet from
    // flickering the section off and on between two daemons.
    if (Array.isArray(data.tickets)) state.tickets = data.tickets;
    // Taken whole, and taken even when empty — unlike `requests` and `consoles` above.
    // An empty list here is the good news ("every repo answered this time") and it has
    // to be able to clear the pane, which is the whole reason the record is rebuilt on
    // each sweep rather than accumulated. Absent still means a server that predates the
    // field, and that keeps whatever is on screen.
    // Taken whole and only when it is there. Absent means a server that predates the
    // board, and keeping the last one is what stops a mixed fleet — a phone talking to
    // an old daemon through a cached service worker — from drawing an inbox with every
    // card filtered out and nothing on screen to say why.
    if (data.p0board && typeof data.p0board === 'object') state.p0board = data.p0board;
    if (Array.isArray(data.trouble)) state.trouble = data.trouble;
    // Same rule, same reasons: taken whole, taken when empty so it can clear itself,
    // and absent leaves what is on screen alone for a server that predates the field.
    if (Array.isArray(data.syncTrouble)) state.syncTrouble = data.syncTrouble;
    // What the ＋ offers when the space holds more than one repo. Kept here rather
    // than read off `data` at the tap, because the tap can happen between polls.
    if (Array.isArray(data.workspaces)) state.workspaces = data.workspaces;
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
      seqIs(data.seq);
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
    // The pull requests first, and unconditionally: they are a second payload with a
    // warm entry of its own, and whether the questions were kept says nothing about
    // whether the board was. `adopt` renders, so this only has to be in `state` before it.
    warmBoard();
    const hit = window.beadcause?.warm?.read?.(questionsPath(state.scope));
    if (!Array.isArray(hit?.data?.questions)) return false;
    seqIs(hit.seq);
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

  /**
   * Every warmed path this page can keep young, and what a wake is able to do for each.
   *
   * The hole this closes is `prewarm`'s, in public/warm.js: it fills each path *once per
   * document* and the TTL then ages what it fetched out fifteen minutes later, and
   * `prewarmed` never goes back to false. On a page you pass through that is fine. On the
   * inbox — the page you leave open all day, which is how this app is actually used —
   * every warmed path is cold for all but the first quarter of an hour, with nothing able
   * to put it back. bc-xxzz closed it for `/api/work` alone; this table is the rest of it.
   *
   * **What makes an old entry still true is the log, not its age.** This page is parked on
   * `/api/poll`, so an entry the log has not contradicted is as true as it was when it was
   * fetched, however long ago that was — and `warm.refresh` restamps it for no request at
   * all. That is the free half, it is available to every path here, and on its own it is
   * what stops a quiet hour ageing out a payload nothing has invalidated.
   *
   * The paid half — going and asking again once the log says something *did* move — is not
   * free and is therefore decided per path, on what the request costs the daemon:
   *
   * - **`/api/work`** is two `bd` calls per workspace, and it is also the one path with a
   *   fold worth doing: `advocates.snapshot()` and `observing` ride every wake whatever
   *   woke it, so most of what that tab draws arrives for nothing. Only the `bd` half is
   *   re-asked, and only for an event `workMoved` says `bd` would answer differently.
   * - **`/api/admin`** and **`/api/consoles`** are in-memory reads on the daemon — no
   *   `bd`, no process spawn, which lib/server.js says of both in as many words — so a
   *   floored re-ask is an honest price for a tab that is otherwise blank on arrival.
   *   Neither is *patched* from the wake even though `/api/admin` looks patchable: its
   *   counts are half advocate roster and half open terminals, and public/admin.js already
   *   refuses to patch one half, for the reason that a button labelled from two different
   *   moments is true of neither. Same rule here, or the warm copy would come to disagree
   *   with the fetched one.
   * - **`/api/prs` is deliberately never fetched here**, and that is the decision this
   *   table exists to record. It is a `gh` call per repo, and a floored re-ask would keep
   *   that sweep running once a minute all day for a board nobody may open. The inbox
   *   already sweeps it on its own minute *when the kind filter wants pull requests*
   *   (`loadBoard`), which is exactly when it is drawing them; when the filter does not,
   *   the free restamp above is all this path gets. So the board is warm for as long as it
   *   is provably unchanged, and once a board event has gone by it keeps its own age and
   *   the TTL takes it — which is where it started.
   *
   * Every branch fails soft. No warm layer, no held entry to maintain, a fetch that
   * throws: all of them leave one cold tab, which is exactly where this began.
   */
  const MAINTAINED = [
    {
      path: '/api/work',
      fold: (work, data) => {
        // An entry from before `/api/work` carried rows in this shape is one we cannot
        // reason about — re-fetch rather than patch half of it.
        if (!Array.isArray(work?.workspaces)) return null;
        return {
          ...work,
          advocates: Array.isArray(data?.advocates) ? data.advocates : work.advocates,
          observing: data?.observing ?? work.observing,
        };
      },
      // A stream.js from before `workMoved` existed has no opinion, and the cheap
      // direction is the right default for the one path here that is a `bd` sweep: the
      // tab is then as cold as it was yesterday, which is what this layer promises.
      moved: (events) => Boolean(window.beadcause?.stream?.workMoved?.(events)),
      // The one path restamped even on a wake that moved it, because the half being
      // folded in *is* of now — the roster is a snapshot, not a memory — and the other
      // half is on its way below. Nowhere else is anything folded, so restamping a moved
      // entry there would be a fresh clock over a payload we know to be wrong.
      stampWhileStale: true,
      refetch: true,
    },
    {
      path: '/api/admin',
      fold: (status) => (Array.isArray(status?.scopes) ? status : null),
      moved: (events) => Boolean(window.beadcause?.stream?.moved?.(events)),
      stampWhileStale: false,
      refetch: true,
    },
    {
      path: '/api/consoles',
      fold: (list) => (Array.isArray(list?.consoles) ? list : null),
      moved: (events) => Boolean(window.beadcause?.stream?.moved?.(events)),
      stampWhileStale: false,
      refetch: true,
    },
    {
      path: '/api/prs',
      fold: (board) => (Array.isArray(board?.repos) ? board : null),
      // `!== false` rather than a plain call: a stream.js from before `boardMoved`
      // existed answers `undefined`, and "we cannot tell" has to mean "it moved" for a
      // path whose only maintenance is the restamp. Unknown then costs nothing beyond
      // the board being as cold as it is today, rather than a board kept young on a
      // guess — and the lamps on it claim to be true.
      moved: (events) => window.beadcause?.stream?.boardMoved?.(events) !== false,
      stampWhileStale: false,
      refetch: false,
    },
  ];

  /**
   * When this page last asked for each of those, on another view's behalf.
   *
   * Seeded with *now* rather than zero, which is the only reason the two warmers cannot
   * both fetch on boot: `prewarm` goes and gets these same paths 1200ms in, and a poll
   * that wakes inside that window would otherwise find nothing held and ask a second
   * time. The first minute belongs to the background warm, which is doing this anyway;
   * after that, whichever needs it asks.
   */
  const warmAskedAt = new Map(MAINTAINED.map((m) => [m.path, Date.now()]));

  /**
   * Keep one warmed path young for as long as you sit here.
   *
   * The free half first, then the paid one, and the table above decides which of them
   * each path gets. `moved` is the whole hinge: it is the log saying whether what we are
   * holding could have changed, and an entry it has not contradicted is restamped for
   * nothing. A `resync` counts as moved for the same reason it does everywhere else —
   * it is the log saying its own events are not the whole story.
   */
  function maintain(warm, spec, data, events, resync) {
    const moved = Boolean(resync) || spec.moved(events);
    const held = !moved || spec.stampWhileStale ? warm.refresh(spec.path, (d) => spec.fold(d, data)) : false;
    if (!spec.refetch) return;
    // Held and provably current: the point of the whole exercise, and it cost no request.
    if (held && !moved) return;
    // A phone in a pocket must not be warming tabs.
    if (document.hidden) return;
    // The floor is the background warm's own, and for the same reason: a burst of events
    // must not become a request each. Stamped before the request rather than after it, so
    // two wakes inside one flight cannot both get through.
    const floor = warm.PREWARM_FLOOR_MS || 60000;
    if (Date.now() - (warmAskedAt.get(spec.path) || 0) < floor) return;
    warmAskedAt.set(spec.path, Date.now());
    api(spec.path)
      .then((fresh) => warm.write(spec.path, fresh, Number(fresh?.seq) || 0))
      .catch(() => {
        /* One cold tab, which is where it started. The next event that matters comes
           round on its own, and a phone that cannot reach the daemon has a worse
           problem than a tab that has to wait for its own fetch. */
      });
  }

  /** Every maintained path, on every wake. See `MAINTAINED` for what that means per path. */
  function warmViews(data, events, resync) {
    const warm = window.beadcause?.warm;
    if (!warm?.available) return;
    // A warm layer from before `refresh` existed — a service worker cached ahead of this
    // change. Nothing to do rather than fall through to the fetches: without maintenance
    // those would be a request a minute each for tabs nobody tapped, which is the timer's
    // bill arriving by another route. A tab that is merely as cold as it was yesterday is
    // the promise this whole layer makes.
    if (typeof warm.refresh !== 'function') return;
    for (const spec of MAINTAINED) maintain(warm, spec, data, events, resync);
  }

  /**
   * A deep link that names a pull request the kind filter is hiding, made to land.
   *
   * Two ways it can be hidden and both are the ordinary state of the control rather than
   * something anybody set. The **status** group's default is `unmerged`, so every merged
   * row is out of the list by default — and a merged row that has not shipped is the
   * whole subject of the board this link comes from (see the PRs pane on /monitor), so
   * that is the common case and not the corner. The **kinds** group hides them whenever
   * something else is picked and PRs is not among it.
   *
   * Widening rather than drawing it anyway, which is the same choice `focusHash` already
   * makes for `scope`: a card that appeared in a list its own filter excludes would be a
   * row you cannot explain and cannot get back to once you collapse it. The status group
   * goes to *all* of its rungs rather than to the one this row is on, because narrowing
   * to `merged` to show a merged pull request would take every unmerged one off the
   * screen to make room for it — a link that hid four rows to reveal one. Both changes
   * are visible in the control's own summary line, and both persist, exactly as the
   * scope widening does.
   */
  function revealPr(row) {
    const f = window.beadcause?.inboxFilter;
    if (!row?.pr || !f) return;
    if (!f.inSub(row)) {
      const sub = (f.KINDS || []).find((k) => k.id === 'pr')?.sub;
      if (sub) f.setSub('pr', sub.options().map((o) => o.id));
    }
    const kinds = f.selected();
    // Empty is "all kinds" and is already wide enough — adding `pr` to it would *narrow*
    // the list to pull requests alone, which is the opposite of what this is for.
    if (kinds.length && !kinds.includes('pr')) f.set([...kinds, 'pr']);
  }

  /** #workspace/id from an ntfy notification tap, or the Android shell's deep link. */
  let hashHandled = '';
  async function focusHash() {
    const key = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (!key || key === hashHandled) return;
    // Before `byKey`, which reads the board rather than the filtered list and so finds a
    // pull request whether or not the chips would draw it. `expand` below is what would
    // not: it opens a card `render` never made.
    revealPr(byKey(key));
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

  /* ------------------------------------------------------------------- ＋ */

  /*
    Start a conversation about what to file next — the create the Chat tab used to be.

    It lands exactly where the launcher's own ＋ lands, by doing exactly what it does:
    POST /api/console, then `/console?id=<id>`. Deliberately the same two lines rather
    than a new endpoint or a redirect through `/console`, because the thing being
    reused is the *destination* — a bookmark, a stored conversation record and a
    home-screen shortcut all name that URL, and it is the one thing here that has to
    keep meaning what it meant.

    Where it starts is the space picker's answer, not a fourth copy of "which repo am
    I working in": `space.inside()` is the configured workspaces the selection allows,
    which is one repo when a repo is picked, and every repo in the space otherwise.
    One candidate starts there without asking. More than one asks, because ＋ cannot
    know, and offering to start work in a repo the app is not currently showing you is
    the one thing the filter exists to stop.
  */
  const composeEl = $('#compose');
  const composePickEl = $('#compose-pick');
  let composing = false;

  const startableRepos = () => {
    const inside = window.beadcause?.space?.inside?.();
    if (Array.isArray(inside)) return inside;
    // No picker on the page — every configured workspace is a candidate, which is what
    // the picker would have said with nothing selected.
    return state.workspaces;
  };

  function hideComposePick() {
    composePickEl.hidden = true;
    composeEl.setAttribute('aria-expanded', 'false');
  }

  function showComposePick(repos) {
    const row = $('#compose-pick-row');
    row.innerHTML = repos.length
      ? repos.map((w) => `<button class="chip" data-ws="${esc(w)}">${esc(w)}</button>`).join('')
      : `<span class="hint">${
          state.workspaces.length ? 'No workspaces in this space.' : 'No workspaces configured.'
        }</span>`;
    composePickEl.hidden = false;
    composeEl.setAttribute('aria-expanded', 'true');
    row.querySelector('.chip')?.focus();
  }

  async function startChat(workspace) {
    if (composing) return;
    composing = true;
    composeEl.disabled = true;
    hideComposePick();
    try {
      const made = await api('/api/console', { method: 'POST', body: JSON.stringify({ workspace }) });
      location.href = `/console?id=${encodeURIComponent(made.id)}`;
    } catch (err) {
      composing = false;
      composeEl.disabled = false;
      // 403 is `beadConsole: false` in the config, which is a deliberate setting and
      // not a fault — its own words rather than the daemon's, and a refusal rather than
      // a failure, so it is red on the screen and files nothing.
      const off = err.status === 403;
      if (err.message !== 'token rejected') {
        toast(off ? 'Chat sessions are turned off in the config.' : err.message, off ? 'refused' : true);
      }
    }
  }

  /* Guarded, and not out of habit: the service worker caches the document and this
     script separately, so a phone can legitimately be running today's app.js against
     last week's index.html for one load. An unguarded listener there throws before
     the poll is scheduled — which turns a missing button into a blank inbox. */
  if (composeEl && composePickEl) {
    composeEl.addEventListener('click', () => {
      if (!composePickEl.hidden) {
        hideComposePick();
        return;
      }
      const repos = startableRepos();
      if (repos.length === 1) startChat(repos[0]);
      else showComposePick(repos);
    });

    $('#compose-pick-row').addEventListener('click', (ev) => {
      const chip = ev.target.closest('[data-ws]');
      if (chip) startChat(chip.dataset.ws);
    });

    // Tapping past it closes it, which is the same bargain the kind filter's panel
    // makes: a panel over the list must not still be there when you reach for a card.
    document.addEventListener('pointerdown', (ev) => {
      if (!composePickEl.hidden && !ev.target.closest('.compose-wrap')) hideComposePick();
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !composePickEl.hidden) {
        hideComposePick();
        composeEl.focus();
      }
    });
    // What tells the stylesheet to keep the foot of the list clear of the button, the
    // same way `has-tabbar` keeps it clear of the bar. Set from here rather than
    // written into the markup because it is a fact about this script having wired ＋
    // up: on the stale-document load above there is no button, and reserving space
    // under one would be a gap at the end of the list with nothing in it.
    document.body.classList.add('has-compose');
  }

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
   *
   * The loop itself is public/stream.js now, shared with the other four views — this
   * page was where it was written and is still the only consumer that asks the daemon
   * for the questions, but five copies of an abort-and-resync rule was not a shape to
   * grow into. What is left here is the two halves that are genuinely the inbox's:
   * which scope may follow at all, and what to do with a payload that arrives.
   */
  // `stream` stays null on a page served without public/stream.js — a service worker
  // cached before it existed. `seqNow()` is 0 then, so this is false, so the timer is
  // the refresh: exactly what this page did before any of it was written. Optional
  // rather than assumed for the same reason warm.js and spacebar.js are, and with more
  // at stake, because the alternative here is a `TypeError` in the first fifty lines of
  // the inbox's own IIFE and a blank screen behind it.
  const canFollow = () => state.scope === 'human' && seqNow() > 0 && Boolean(state.token);

  stream = window.beadcause?.stream?.follow?.({
    api,
    ready: canFollow,
    // Never: this page's poll asks the daemon for the inbox questions, so a request
    // without a `since` would be an immediate answer *and* a `bd` sweep — a busy loop
    // that swept. The sequence comes off `/api/questions` or off the warm payload, and
    // without one the timer is the refresh.
    cold: false,
    // The visibility rule is this page's own, below: it has two more things to do when
    // the screen comes back — the fallback fetch and the board's own sweep — and two
    // handlers racing over one socket is worse than one handler that says it all.
    visibility: false,
    // And no retry, for the same reason: this is the one view with a timer behind it,
    // and `onSettle` is what puts it back on. The other four have nothing to fall back
    // to and let the stream try again for them.
    retryMs: 0,
    onWake({ data, events, resync }) {
      // The poll answered, so the credential is good and the daemon is up: the one
      // moment it is safe to go and warm the other four tabs.
      warmOthers();
      // And to keep them warm rather than leaving them to age out under a TTL nothing
      // was putting back — this is the wake every other view is maintained from, and
      // `MAINTAINED` is where what that means per path is argued.
      warmViews(data, events, resync);
      // Null means the park timed out with nothing but presence traffic — the quiet
      // case, and the whole point: no sweep ran on the daemon and nothing repaints
      // here. An empty array would mean "the inbox is empty", which is why the two
      // are different values on the wire.
      //
      // `resync` needs no branch of its own: the daemon sends the whole list with it,
      // so adopting is already the full refetch that case calls for.
      if (Array.isArray(data.questions)) {
        keep('human', { ...data, seq: seqNow() });
        adopt(data);
      }
    },
    // Either the log is still followable — and this re-parks — or it is not, and this
    // is where the timer comes back. Exactly one of the two is ever live.
    onSettle: () => schedulePoll(),
  }) || null;

  /** Stop waiting on an answer about a list we have stopped showing. */
  const unfollow = () => stream?.stop();

  /**
   * The timer, which now runs only when the log cannot be followed — a wide scope, an
   * old daemon, or a poll that failed. `follow()` is started from the same place, so
   * exactly one of the two is ever live.
   */
  function schedulePoll() {
    clearInterval(pollTimer);
    if (canFollow() && !document.hidden) {
      stream?.start();
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

  /**
   * The board's own clock — a minute, and only while a pull request could be in view.
   *
   * Separate from the poll above and deliberately slower: `/api/prs` is a `gh` call per
   * repo behind a 25-second cache on the daemon, and asking it every 25 seconds because
   * the inbox does would keep that sweep running all day for a screen nobody is reading.
   * The board page itself uses the same minute, for the same reason.
   */
  setInterval(() => {
    if (!document.hidden) loadBoard();
  }, BOARD_MS);

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
    // The board is not on the delta stream — it is a `gh` sweep behind its own minute
    // — so coming back asks it directly. A no-op unless the last sweep has aged out.
    loadBoard();
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
    mountFilters();
  }

  /**
   * Build the filter control, once, before the first fetch answers.
   *
   * Early on purpose: the line that says which slice you are looking at has to be on
   * screen while `bd` is still being asked, which is exactly when a wide scope makes
   * the wait long enough to wonder. The kinds group is the control's own — see
   * public/inboxfilter.js — and the scope group is handed over, so the two share one
   * panel instead of stacking two rows.
   *
   * A page served without the file still works: `renderFilters` and `inKind` both fall
   * back to doing nothing, which is the unfiltered list this page has always drawn.
   */
  function mountFilters() {
    const f = window.beadcause?.inboxFilter;
    if (!f) return;
    f.mount(filtersEl, {
      groups: [scopeGroup],
      // Forced, because a filter tap is a decision and must not be deferred behind a
      // half-written answer. Nothing is refetched for the kinds themselves — they are a
      // view over rows already in hand — but selecting `PRs` may be the first time this
      // tab has wanted a board at all, and `loadBoard` is what goes and gets one.
      onChange: () => {
        render(true);
        loadBoard();
      },
    });
    f.survey({ kinds: kindsForScope() });
  }

  bootToken();
  bootScope();
  // Warm first, then decide what to ask for. With a list on screen and a place in the
  // event log, the refresh is a parked poll that costs the daemon nothing until
  // something moves — so the ordinary tab tap does no `bd` sweep at all. Without
  // either, this is the cold start it always was.
  if (warmBoot() && canFollow()) schedulePoll();
  else load();
  // The pull requests, beside the questions rather than after them: the two feeds are
  // independent and the board is the slower of the two, so starting it second and
  // waiting for neither is what puts the questions on screen first. It is not on the
  // delta stream either — a `gh` sweep is nothing an event log can carry.
  loadBoard();
  // After the list, and never blocking it: the chooser only appears inside an open
  // card, so there is nothing on screen waiting for this.
  loadAgents();
})();
