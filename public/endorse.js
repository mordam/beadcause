/* The endorsement queue — what an agent filed while you were asleep, and what you say
 * about it.
 *
 * A worker that trips over work no longer stops to ask: it files the bead there and
 * then, carrying `unendorsed`, and nothing in the system may open a session on one
 * (lib/endorse.js). That trade only holds up if the other end of it exists — if the
 * held beads are somewhere you can actually see and answer from a phone. Before this
 * page they were a muted pill on the advocate console reading `3 held for endorsement`,
 * which is a number with no door behind it.
 *
 * Four things about the shape of this screen.
 *
 * **The row is the bead, not a summary of it.** Unfolded, it shows what the agent
 * wrote — the description, what done looks like, and the provenance note saying how it
 * was found and whether its priority was clamped — because the decision you are being
 * asked for is whether an hour of unattended agent should go on this. Everywhere else
 * in this app a list row is a teaser for a sheet; here the sheet is the point, so it
 * is in the list.
 *
 * **Endorse is one tap; everything that cannot be undone takes two.** Endorsing is
 * idempotent all the way down (see lib/verdict.js) — the worst a stray tap does is
 * queue work you meant to queue eventually. Revoking closes a bead, so it arms first,
 * with the consequence written into the button between the taps: the same pattern as
 * Merge on the PR board and the destructive control on /admin, and for the same reason
 * — a `confirm()` on a phone is a sheet you dismiss by reflex.
 *
 * **The group tap is the case a busy week produces.** Six discoveries overnight, five
 * of them obviously fine. So rows select, and the bar above the list endorses every
 * selected bead in one request. Group *revoke* is there too and it arms; group adjust
 * and group ask-for-changes are deliberately not, even though the API takes them: one
 * title cannot be given to six beads (the server refuses it outright), and one
 * objection typed at six is an objection about none of them.
 *
 * **And the whole queue is one tap, once you have decided it is.** A hundred held
 * beads is not a hundred decisions; it is one decision about a hundred beads, and a
 * queue that can only be drained a tick at a time is one nobody drains — which quietly
 * takes the meaning out of the hold. So *Endorse all* sits in the header, reachable
 * with nothing ticked, and acts on exactly the rows the picker is drawing. It is the
 * one endorsement that **arms**, because the rule the other two are one tap under —
 * the worst a stray tap does is queue work you meant to queue eventually — stops being
 * true somewhere around the hundredth bead.
 *
 * **And the fifth control is the one that decides nothing.** Endorse, adjust, revoke and
 * ask-for-changes are four answers; Discuss is what you press when you do not have one
 * yet. It opens a thread with an agent of your choosing on the bead itself — the same
 * dispatch commenting on a question has always made (lib/dispatch.js) — and the bead
 * keeps its `unendorsed` marker throughout, because a conversation is not a verdict. The
 * folded row carries a 💬 count for the same reason: a bead you asked three questions
 * about last night must never read as one nobody has opened.
 *
 * **The row also carries what was learned after it was filed.** Every other line on a
 * folded row — title, type, priority, the provenance note — is the *filing agent's* own
 * words, written at the moment it found the work and before anybody had looked at it. The
 * evidence that a bead should not be endorsed is by definition later than that, and it
 * lands in two places: the bead's own comment thread, and a separate `human` bead asking
 * about it. So the newest comment rides on the folded row (`latestHtml`), and an open
 * question that names this bead by id draws a ⚑ line of its own (`questionsHtml`). bc-wi3s
 * had both — an advocate's "I ran the suite, it is green, close it" and an open P1
 * recommending exactly that — and was endorsed anyway in a batch of 56, because a card in
 * an inbox loses a race with a bulk press that cannot see it.
 *
 * **What happened is pinned to the row, never toasted.** These calls change real work
 * — a bead that is now workable, a bead that is now closed — and "did that go through?"
 * must not be a question you answer by opening a laptop. A group answers per bead: the
 * server reports every id separately and so does this, because a group of six where the
 * fifth lost a Dolt lock race is a 200, not a failure.
 *
 * Where it lives: its own page, and **not** a sixth tab on the bottom bar. The bar is
 * full at five and what gives up its place is its own decision (bc-j0zl) — one this
 * screen has no business pre-empting by squeezing in. The doors are the advocate
 * console's `N held for endorsement` pill, which is the number you were already looking
 * at, and the 🗳 in the inbox's top bar.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('eq');
  const pulse = document.getElementById('pulse');

  /* Which events matter to this screen is `QUEUE_EVENTS` in public/stream.js, next to
     the board's own list and for the same reason: the inbox holds a copy of this queue
     warm and has to ask the identical question about it. What that list cannot cover is
     a `bd` write made outside the app — a held bead closed in a terminal emits nothing —
     which was true of every view on the stream before this one, and is why the ⟳ is
     still in the header. */

  /** A sweep already in flight. Two of them can answer out of order — see `load`. */
  let loading = false;

  /** A wake that could not be acted on yet, because something of yours was open. */
  let stale = false;

  /* How often an open discussion asks whether the agent has said anything yet, and how
     many times it will ask before giving up. Nothing pushes a reply on a held bead (see
     `talkHtml`), so this is the whole of how an answer reaches the phone — and 3s × 200
     is ten minutes, which is `autoDispatchTimeoutMs`: the point past which the daemon
     has killed the agent and there is nothing left to wait for. */
  const TALK_POLL_MS = 3000;
  const TALK_TRIES = 200;

  /** What `adjust` may rewrite — the same six as EDITABLE in lib/verdict.js. */
  const TYPES = ['task', 'bug', 'feature', 'epic', 'chore', 'decision'];

  const state = {
    /** The last `/api/unendorsed` that answered. */
    data: null,
    /** The last fetch's failure, if it failed. The list on screen stays put. */
    error: null,
    first: true,
    busy: false,
    /** Which beads are selected, by `workspace/id`. The group bar is this, drawn. */
    picked: new Set(),
    /** Which row is unfolded. At most one — that is what makes it a list and not a wall. */
    row: null,
    /**
     * The armed button, as `<action>@<key>`, with `*` as the key for the group bar.
     * At most one on the page, and cleared by every repaint that is not a re-render of
     * the same arming tap.
     */
    armed: null,
    /** The adjust form, when it is open: `{ key, fields }`. Null the rest of the time. */
    edit: null,
    /**
     * The discussion, when one is open on a row:
     * `{ key, workspace, id, thread, text, sending, loading, running, activity }`.
     *
     * At most one, like the fold and the adjust form — a phone shows one conversation
     * at a time, and two open threads would be two poll timers arguing over the same
     * repaint.
     */
    talk: null,
    /** Who can answer, from `/api/agents`. Empty if the roster would not load. */
    agents: [],
    /** The chosen agent's id. A mode rather than a per-bead setting, as in the inbox. */
    agent: '',
    /** What you have typed at the open row, kept out here so a repaint does not lose it. */
    note: '',
    /**
     * The outcome of the last action: `{ key, text, bad }`.
     *
     * `key` is a row key, `*` for the group bar, or `#` for the page. The third one is
     * not a fallback — it is where an outcome has to go when the thing it happened to
     * is gone: an endorsed bead leaves this queue immediately, so a message pinned to
     * its row would be swept away by the refetch that proved the endorsement worked.
     */
    said: null,
    /** How old the last queue was, off `x-beadcause-kept` (lib/cache.js) — `null`
     *  until an answer has landed, which is what keeps the mark off a first paint.
     *  See `parseKept`. */
    kept: null,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** How long ago, in the two characters a phone has room for. */
  function age(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  }

  /**
   * How old the answer was, off the header the daemon puts on a kept response.
   *
   *     x-beadcause-kept: stale; age=41; refreshing
   *
   * Copied from public/history.js rather than shared — three lines twice is cheaper
   * than a module only two other pages would import (bc-1kwl.8).
   */
  function parseKept(value) {
    if (!value) return null;
    const parts = String(value).split(';').map((s) => s.trim());
    const field = parts.find((s) => s.startsWith('age='));
    return {
      stale: parts[0] === 'stale',
      ageSec: field ? Number(field.slice(4)) || 0 : 0,
      refreshing: parts.includes('refreshing'),
    };
  }

  const graphUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}`;

  /** Is this bead in the selected space? See public/spacebar.js. */
  const inSpace = (b) => window.beadcause?.space?.matches?.(b.workspace) ?? true;

  /** The rows this page is actually drawing — everything else is in the payload, unshown. */
  const rows = () => (state.data?.beads || []).filter(inSpace);

  const rowFor = (key) => rows().find((b) => b.key === key) || null;

  /** The selected rows, and only the ones still on screen: a filtered-away pick is not one. */
  const pickedRows = () => rows().filter((b) => state.picked.has(b.key));

  const isArmed = (key, action) => state.armed === `${action}@${key}`;

  /** The two keys that are not a bead: what you ticked, and everything drawn. */
  const isGroup = (key) => key === '*' || key === '@';

  /**
   * Where an outcome for this key is drawn while it is still happening.
   *
   * The group bar draws its own; *Endorse all* has no bar of its own — it is a header
   * button whose every row is about to leave the screen — so even its `Working…` belongs
   * on the page line, which is where its outcome ends up anyway.
   */
  const sayAt = (key) => (key === '@' ? '#' : key);

  /** The selected agent, falling back to whatever the server offered first. */
  const currentAgent = () => state.agents.find((a) => a.id === state.agent) || state.agents[0] || null;

  /* ------------------------------------------------------------------ one row */

  /**
   * A titled block of the agent's own words — what it is, what done looks like, why.
   *
   * Deliberately not markdown. The inbox renders a question's body through marked +
   * DOMPurify because a question is written *at* you and its author formats it; a
   * filed bead's description is plain prose out of a YAML block, and the one thing
   * that has to survive is its line breaks. `white-space: pre-wrap` on escaped text
   * does that with no parser and no sanitiser anywhere in the path.
   */
  const field = (label, text, html = esc(text)) =>
    text ? `<div class="eq-field"><h3>${esc(label)}</h3><p>${html}</p></div>` : '';

  /**
   * The three emphasis marks the daemon's own paragraph uses, and nothing else.
   *
   * `provenanceNotes` in lib/filing.js writes markdown — `_Filed by an agent…_`,
   * `**Looks like a duplicate**`, `` `unendorsed` `` — because that paragraph is also
   * read through `bd show` on a terminal, where it renders. Escaped and left alone on
   * a phone, the underscores and asterisks are litter across the one paragraph that
   * explains why the bead exists.
   *
   * Three replacements rather than marked + DOMPurify, which this page would otherwise
   * load for one field: the input is escaped first, so the only tags that can appear
   * are the three written here and there is nothing left for a sanitiser to do. The
   * agent's own description is deliberately *not* run through it — that is free text
   * out of a YAML block, and an underscore in it is an underscore.
   */
  const emph = (text) =>
    esc(text)
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s.,;:)])/gm, '$1<em>$2</em>');

  /**
   * Where this bead came from, as one line.
   *
   * The most useful sentence on the card and the one the bead cannot say about itself:
   * an agent filed it *while working something else*, and that something else is
   * usually what tells you whether this is a real discovery or a tangent. `null` is a
   * state and it is drawn as one — the daemon may not have been able to read the edge
   * (see `addShowFields`), and "found under nothing" would be a claim it never made.
   */
  function fromHtml(b) {
    if (!b.from) return '';
    const word = b.from.kind === 'discovered' ? 'Found while working' : 'Filed under';
    return `<span class="eq-from">${esc(word)} <a class="pill id" href="${esc(
      graphUrl(b.workspace, b.from.id)
    )}">${esc(b.from.id)}</a>${b.from.title ? ` <span class="eq-from-title">${esc(b.from.title)}</span>` : ''}</span>`;
  }

  /**
   * The open questions that name this bead — the loudest thing a row can say.
   *
   * Every other line on this row is what the *filing agent* wrote before anybody had
   * looked at the work. This one is what somebody concluded afterwards, and it is
   * always the reason not to endorse: an advocate's instrument for "do not work this"
   * is a `human` bead, and a card in an inbox loses a race with a bulk endorse that
   * cannot see it. bc-wi3s was endorsed in a batch of 56 with an open P1 naming it by
   * id, and no row in this app said a word about that.
   *
   * On the **folded** row, deliberately, and not tucked into the open one: the press
   * that misfires is the one made without opening anything.
   */
  function questionsHtml(b) {
    const qs = Array.isArray(b.questions) ? b.questions : [];
    if (!qs.length) return '';
    const each = qs
      .map(
        (q) =>
          `<a class="pill id" href="${esc(graphUrl(q.workspace, q.id))}">${esc(q.id)}</a>` +
          (q.priority != null ? `<span class="pill p${esc(q.priority)}">P${esc(q.priority)}</span>` : '') +
          ` <span class="eq-ask-title">${esc(q.title)}</span>`
      )
      .join('<span class="eq-ask-sep">·</span>');
    return `<span class="eq-ask">⚑ ${esc(
      qs.length === 1 ? 'An open question names this bead' : `${qs.length} open questions name this bead`
    )} ${each}</span>`;
  }

  /**
   * The last thing anybody said about this bead, in one line.
   *
   * The 💬 pill beside the id says a thread exists; it does not say whether the thread
   * is a clarifying question or an advocate writing "I ran the suite, this is already
   * green, close it rather than endorsing it" — which is what was on bc-wi3s the
   * morning it got endorsed anyway. The count is what makes you look; this is what
   * makes you stop. It rides on the same `bd show` the provenance line already costs
   * (`addShowFields` in lib/endorsequeue.js), so it is free.
   *
   * Collapsed to a single line here and never wrapped: the whole thread is one tap away
   * on **Discuss**, and a row that grew to four lines because somebody pasted an
   * evidence dump would push the next bead off the screen.
   */
  function latestHtml(b) {
    const c = b.latestComment;
    const text = String(c?.text || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    return `<span class="eq-last">💬 ${
      c.author ? `<span class="eq-last-who">${esc(c.author)}</span> ` : ''
    }<span class="eq-last-text">${esc(text)}${c.truncated ? '…' : ''}</span></span>`;
  }

  /** The pills that say what kind of work this claims to be, at a glance. */
  function pillsHtml(b) {
    const many = Object.keys(state.data?.counts?.byWorkspace || {}).length > 1;
    return [
      `<a class="pill id" href="${esc(graphUrl(b.workspace, b.id))}">${esc(b.id)}</a>`,
      // Only when there is more than one workspace in the queue. On a phone narrowed to
      // one repo, a pill repeating the repo's name on every row is noise.
      many ? `<span class="pill">${esc(b.workspace)}</span>` : '',
      b.type ? `<span class="pill">${esc(b.type)}</span>` : '',
      b.priority != null ? `<span class="pill p${esc(b.priority)}">P${esc(b.priority)}</span>` : '',
      b.status && b.status !== 'open' ? `<span class="pill st-${esc(b.status)}">${esc(b.status)}</span>` : '',
      // A thread on this bead, from the folded row. Without it a bead you asked three
      // questions about last night looks exactly like one nobody has opened — which is
      // the state this whole queue exists to empty, so it is the one thing a row must
      // never be wrong about. The count is `comment_count` off the same `bd list` the
      // row came from; no extra call (see `toRow` in lib/endorsequeue.js).
      b.commentCount ? `<span class="pill talk">💬 ${esc(b.commentCount)}</span>` : '',
      // Provenance that survives endorsement (lib/filing.js). Its absence is the tell
      // that a bead was labelled `unendorsed` by hand rather than filed by an agent.
      b.filed ? '' : '<span class="pill muted">not agent-filed</span>',
    ]
      .filter(Boolean)
      .join('');
  }

  /* ------------------------------------------------------------- the adjust form */

  /** The six fields as they stand on the bead — what the form opens with. */
  const editFrom = (b) => ({
    title: b.title || '',
    type: b.type || 'task',
    priority: b.priority == null ? 2 : Number(b.priority),
    description: b.description || '',
    acceptance: b.acceptance || '',
    // The two the daemon owns are not yours to type (PROTECTED_LABELS in
    // lib/verdict.js). Left out of the box entirely rather than shown and then
    // stripped on the way in, which would read as the server ignoring you.
    labels: (b.labels || []).filter((l) => l !== 'unendorsed' && l !== 'agent-filed').join(', '),
  });

  function editHtml(b) {
    const e = state.edit?.key === b.key ? state.edit.fields : editFrom(b);
    const opt = (v, on, label) => `<option value="${esc(v)}"${on ? ' selected' : ''}>${esc(label ?? v)}</option>`;
    return `<div class="eq-edit">
      <label class="eq-lab">Title
        <input type="text" data-edit="title" value="${esc(e.title)}">
      </label>
      <div class="eq-two">
        <label class="eq-lab">Type
          <select data-edit="type">${TYPES.map((t) => opt(t, t === e.type)).join('')}</select>
        </label>
        <label class="eq-lab">Priority
          <select data-edit="priority">${[0, 1, 2, 3, 4].map((n) => opt(n, Number(e.priority) === n, `P${n}`)).join('')}</select>
        </label>
      </div>
      <label class="eq-lab">What the work is
        <textarea data-edit="description" rows="4">${esc(e.description)}</textarea>
      </label>
      <label class="eq-lab">What done looks like
        <textarea data-edit="acceptance" rows="3">${esc(e.acceptance)}</textarea>
      </label>
      <label class="eq-lab">Labels
        <input type="text" data-edit="labels" value="${esc(e.labels)}" placeholder="comma separated">
      </label>
      <div class="board-actions">
        <button class="board-btn" data-act="save" data-key="${esc(b.key)}">Save</button>
        <button class="board-btn merge" data-act="save-endorse" data-key="${esc(b.key)}">Save &amp; endorse</button>
        <button class="board-btn link" data-act="cancel-edit" data-key="${esc(b.key)}">Cancel</button>
      </div>
      <p class="board-hint">Saving alone keeps the bead held — rewriting a title is not the
        same act as agreeing to the work. Priority is capped at P2 for anything an agent
        filed; raise it yourself if it really is more than that.</p>
    </div>`;
  }

  /* --------------------------------------------------------------- the discussion */

  /**
   * Talking about a bead instead of deciding on it.
   *
   * The fifth control on a row, and the only one that is not a verdict: the other four
   * all end with the bead somewhere else, and this one deliberately leaves it exactly
   * where it was. Half of what a decision needs at 07:00 is not endorse-or-revoke but a
   * question — is this not already filed, which file would it touch, what breaks if we
   * leave it — and without somewhere to ask it the queue offers a choice between
   * approving work you have not understood and turning down work that might have been
   * right.
   *
   * **Nothing here can resolve the bead, and the panel says so.** The comment is written
   * as you and the marker is untouched; the agent that answers runs on the read-only
   * allowlist in lib/agents.js, which has no `bd label`, no `bd close` and no `bd
   * create` on it. So a thread can run for a week and the bead is still held at the end
   * of it — which is the point, and is why the hint under the box is worth its two lines.
   *
   * **The reply is pulled, not pushed.** `checkReplies` watches `bd human` questions and
   * an unendorsed bead is not one, so nothing will buzz your phone when the agent
   * answers. Instead the panel polls `/api/bead/thread` while the daemon says an agent
   * is running, and the row says which agent is thinking while it waits. That is honest
   * about the trade: this screen is where you already are when you ask.
   */
  function bubbleHtml(c) {
    const who = c.agent ? `${c.agent.emoji || '🤖'} ${c.agent.name}` : c.author || 'you';
    return `<div class="comment${c.agent ? ' from-agent' : ''}">
      <span class="who">${esc(who)}${c.at ? ` · ${esc(age(c.at))}` : ''}</span>
      <p class="eq-bubble">${esc(c.text)}</p>
    </div>`;
  }

  /** The agent chips — who answers. Absent, rather than empty, if the roster failed. */
  function agentRowHtml() {
    if (!state.agents.length) return '';
    const chosen = currentAgent();
    const chips = state.agents
      .map(
        (a) => `<button class="chip agent-chip" type="button" data-act="agent" data-agent="${esc(a.id)}"
          aria-pressed="${a.id === chosen?.id}">${esc(a.emoji || '🤖')} ${esc(a.name)}</button>`
      )
      .join('');
    return `<div class="section-label">Who answers</div>
      <div class="chip-row agent-row">${chips}</div>
      <p class="eq-agent-desc">${esc(chosen?.description || '')}</p>`;
  }

  function talkHtml(b) {
    const t = state.talk;
    const thread = t.thread || [];
    const waiting = t.running
      ? `<p class="eq-waiting">${esc(t.activity?.detail || 'An agent is picking up your question…')}</p>`
      : '';
    const body = thread.length
      ? `<div class="comments">${thread.map(bubbleHtml).join('')}</div>`
      : `<p class="board-hint">${
          t.loading ? 'Reading the thread…' : 'Nothing said about this one yet. Ask, and it stays held while you talk.'
        }</p>`;

    return `<div class="eq-talk">
      <div class="section-label">Before you decide</div>
      ${body}
      ${waiting}
      ${agentRowHtml()}
      <div class="board-say">
        <textarea data-talk rows="3" placeholder="Ask about it — is this already covered, what would it touch…">${esc(
          t.text || ''
        )}</textarea>
        <div class="board-say-row">
          ${window.beadcause?.dictation?.buttonHtml({ label: 'Dictate this question' }) || ''}
        </div>
      </div>
      <div class="board-actions">
        <button class="board-btn merge" data-act="send" data-key="${esc(b.key)}">${
          t.sending ? 'Sending…' : 'Send'
        }</button>
        <button class="board-btn link" data-act="close-talk" data-key="${esc(b.key)}">Back to the verdicts</button>
      </div>
      <p class="board-hint">This is a conversation, not a verdict: the bead keeps its
        <code>unendorsed</code> marker however long the thread runs, and nothing can open a
        session on it until you endorse it. The agent can read the repo and the tracker and
        cannot write to either.</p>
    </div>`;
  }

  /* ------------------------------------------------------------- the unfolded row */

  /** What the agent wrote, which every state of the open row shows above its controls. */
  const wordsHtml = (b) => `
      ${field('What the work is', b.description)}
      ${field('What done looks like', b.acceptance)}
      ${field('Design', b.design)}
      ${b.notes ? `<div class="eq-field prov"><h3>How it was found</h3><p>${emph(b.notes)}</p></div>` : ''}`;

  function openHtml(b) {
    const editing = state.edit?.key === b.key;
    const said = state.said?.key === b.key ? `<div class="board-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</div>` : '';

    if (editing) return `<div class="board-open">${editHtml(b)}${said}</div>`;
    // The bead's own words stay above the thread: the question you are typing is
    // *about* the description, and a discussion panel that replaced it would have you
    // scrolling back and forth to ask what it says.
    if (state.talk?.key === b.key) return `<div class="board-open">${wordsHtml(b)}${talkHtml(b)}${said}</div>`;

    const revoking = isArmed(b.key, 'revoke');
    const buttons = [
      `<button class="board-btn merge" data-act="endorse" data-key="${esc(b.key)}">Endorse</button>`,
      `<button class="board-btn" data-act="edit" data-key="${esc(b.key)}">Adjust ✎</button>`,
      `<button class="board-btn" data-act="talk" data-key="${esc(b.key)}">${
        b.commentCount ? `Discuss 💬 ${esc(b.commentCount)}` : 'Discuss 💬'
      }</button>`,
      `<button class="board-btn" data-act="changes" data-key="${esc(b.key)}">Ask for changes</button>`,
      `<button class="board-btn revoke${revoking ? ' armed' : ''}" data-act="revoke" data-key="${esc(b.key)}">${
        revoking ? 'Revoke it — sure?' : 'Revoke'
      }</button>`,
      `<a class="board-btn link" href="${esc(graphUrl(b.workspace, b.id))}">Graph ↗</a>`,
    ];

    return `<div class="board-open">
      ${wordsHtml(b)}
      <div class="board-actions">${buttons.join('')}</div>
      <div class="board-say">
        <textarea data-note rows="2" placeholder="Say what is wrong with it, or why you are turning it down…">${esc(
          state.note
        )}</textarea>
        <div class="board-say-row">
          ${window.beadcause?.dictation?.buttonHtml({ label: 'Dictate this note' }) || ''}
        </div>
      </div>
      <p class="board-hint">The box is your note. <b>Ask for changes</b> needs it — the bead
        stays held and the next session reads your objection instead of re-filing the same
        thing next week. <b>Revoke</b> closes the bead and takes the box as the reason, or
        writes one for you if it is empty; the bead keeps its marker either way, so what was
        found and what you thought of it both stay on the record.</p>
      ${said}
    </div>`;
  }

  function beadHtml(b) {
    const open = state.row === b.key;
    const on = state.picked.has(b.key);
    return `<article class="card work-card eq-bead${open ? ' unfolded' : ''}">
      <div class="eq-line">
        <button class="eq-pick" type="button" data-pick="${esc(b.key)}" aria-pressed="${on}"
          aria-label="Select ${esc(b.title)}"><span aria-hidden="true">${on ? '✓' : ''}</span></button>
        <button class="work-row board-row" type="button" data-row="${esc(b.key)}" aria-expanded="${open}">
          <span class="work-main">
            <span class="work-title">${esc(b.title)}</span>
            <span class="work-sub">${pillsHtml(b)}</span>
            ${fromHtml(b) ? `<span class="work-sub">${fromHtml(b)}</span>` : ''}
            ${latestHtml(b) ? `<span class="work-sub">${latestHtml(b)}</span>` : ''}
            ${questionsHtml(b) ? `<span class="work-sub">${questionsHtml(b)}</span>` : ''}
          </span>
          <time>${esc(age(b.createdAt))}</time>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </div>
      ${open ? openHtml(b) : ''}
    </article>`;
  }

  /* --------------------------------------------------------------- the group bar */

  /**
   * What you can do to the beads you ticked.
   *
   * Sticky under the header rather than at the foot, because the thing it acts on is
   * the list you are scrolling and it has to stay visible while you tick the sixth row.
   * Absent entirely when nothing is selected — an always-present bar with two greyed
   * buttons is a control you have to think about on every visit.
   */
  function barHtml() {
    const picks = pickedRows();
    if (!picks.length) return '';
    const revoking = isArmed('*', 'revoke');
    const said = state.said?.key === '*' ? `<div class="board-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</div>` : '';
    return `<section class="eq-bar">
      <div class="eq-bar-row">
        <span class="eq-bar-n">${plural(picks.length, 'bead')} selected</span>
        <button class="board-btn merge" data-act="endorse" data-key="*">Endorse ${picks.length}</button>
        <button class="board-btn revoke${revoking ? ' armed' : ''}" data-act="revoke" data-key="*">${
          revoking ? `Revoke ${picks.length} — sure?` : `Revoke ${picks.length}`
        }</button>
        <button class="board-btn link" data-act="clear" data-key="*">Clear</button>
      </div>
      ${
        revoking
          ? `<p class="board-hint">All ${picks.length} are closed with the standard reason —
             a group revoke takes no typed one, because one sentence about six beads is a
             sentence about none of them. Turn one down with a reason of its own by opening it.</p>`
          : ''
      }
      ${said}
    </section>`;
  }

  /**
   * The outcome of something whose row is no longer here — an endorsed bead, a revoked
   * one, a group that has just emptied the selection.
   *
   * Sticky at the top of the list, because it is the *only* evidence the tap worked:
   * the bead itself has left the queue, and a message that scrolled away with it would
   * make "did that go through?" a question you answer on a laptop.
   */
  const pageSaidHtml = () =>
    state.said?.key === '#'
      ? `<p class="eq-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</p>`
      : '';

  /* --------------------------------------------------------------------- render */

  /**
   * Endorse all — the tap that empties the queue, and the only endorsement that arms.
   *
   * **What it acts on is what is drawn**, so it is counted over `rows()` exactly like the
   * header it sits beside, and never over the payload. A page narrowed to one space
   * reaching into another space's queue on a tap you made while looking at this one is
   * the single thing this control must never do, so what the picker is hiding is named
   * in the hint and left alone.
   *
   * **It arms, where the single row and the group bar deliberately do not.** Those are
   * small: endorsing is idempotent all the way down (lib/verdict.js), and the worst a
   * stray tap does is queue work you meant to queue eventually. That stops being true
   * somewhere around the hundredth bead, and this is the exact act lib/endorse.js exists
   * to make deliberate — so the first tap only says what the second will do, and says it
   * as a count and the repos it covers. Same rule as the inbox's bulk approve
   * (bc-l8jp.8): the button names what it will act on before it acts.
   *
   * **"All" is all that is on the page, and it says so when that is not all there is.**
   * The sweep caps at `QUEUE_MAX` (60) and a verdict takes at most `MAX_IDS` (100) ids,
   * so one workspace's rows always fit the single POST `post()` makes for it — but a
   * queue of a hundred and one endorsing sixty under the word *all* would be the
   * truncation lying twice, so the overflow is named too.
   *
   * **And it counts the beads somebody has an open question about, between the taps.**
   * This is the press bc-xl7n.76.2 was filed about: a bulk endorse of 56 took a bead an
   * advocate had filed a P1 asking to close instead, because nothing on the page could
   * see the question. It is a *count and not a refusal* — a bead can carry a stale
   * question for a month, and a control that would not fire until you had cleared every
   * one of them is a control you stop using, which quietly takes the meaning out of the
   * hold in exactly the way the paragraph above is about. The rows say which ones
   * (`questionsHtml`); this says how many, at the moment you are about to act on all of
   * them at once.
   */
  function allHtml() {
    const shown = rows().length;
    if (!shown) return '';
    const armed = isArmed('@', 'endorse');
    const label = shown === 1 ? 'Endorse the one' : `Endorse all ${shown}`;
    const by = rows().reduce((a, b) => ({ ...a, [b.workspace]: (a[b.workspace] || 0) + 1 }), {});
    const where = Object.keys(by)
      .sort()
      .map((n) => `${by[n]} in ${esc(n)}`)
      .join(', ');
    const elsewhere = Math.max(0, (state.data?.counts?.total || shown) - shown);
    const asked = rows().filter((b) => (b.questions || []).length).length;
    // **And the rows whose questions could not be read at all.** `questions` is `null`
    // rather than `[]` when a workspace's `bd human list` never came back — the whole
    // reason lib/openquestion.js keeps the two apart — and this is the one press where
    // that distinction is worth a sentence. Everywhere else `[]` and `null` draw the same
    // nothing, correctly: a folded row cannot usefully say *maybe*, and sixty rows each
    // hedging about one repo's failed read is the noise the ⚑ exists to stay clear of.
    // Here it is different, because `[]` is precisely the sentence *it is safe to endorse
    // all of these* and this button is the only place that sentence gets acted on.
    const unknown = rows().filter((b) => !Array.isArray(b.questions)).length;
    const rest = [
      asked
        ? `${asked === 1 ? 'One of them has' : `${asked} of them have`} an open question ⚑ — worth reading before you do.`
        : '',
      unknown
        ? `${unknown === 1 ? 'One of them could not be checked' : `${unknown} of them could not be checked`} for open questions — a repo's question list did not answer, so a ⚑ may be missing.`
        : '',
      elsewhere ? `${plural(elsewhere, 'bead')} in another space ${elsewhere === 1 ? 'stays' : 'stay'} held.` : '',
      state.data?.truncated
        ? `The ${esc(state.data.truncated)} over the cap are not in this tap — answer these and the rest arrive.`
        : '',
    ]
      .filter(Boolean)
      .join(' ');
    return `<button class="board-btn merge eq-all${armed ? ' armed' : ''}" data-act="endorse" data-key="@">${
      armed ? `${esc(label)} — sure?` : esc(label)
    }</button>${
      armed
        ? `<p class="board-hint eq-all-hint">Tap again and ${
            shown === 1 ? 'it goes' : `all ${shown} go`
          } to the advocate — ${where}. ${rest}</p>`
        : ''
    }`;
  }

  /** The line at the top: how many, where, and anything the sweep could not read. */
  function headHtml() {
    const d = state.data;
    const shown = rows().length;
    const by = d.counts?.byWorkspace || {};
    const names = Object.keys(by).sort();
    // Counted over what is drawn, not over the payload: the picker narrows the page and
    // a header that counted every repo would be the top of the screen arguing with the
    // rest of it.
    const where =
      names.length > 1 && shown === d.counts.total
        ? ` — ${names.map((n) => `${by[n]} in ${esc(n)}`).join(', ')}`
        : '';
    const stale = state.error
      ? `<p class="board-foot bad">Showing the queue as of ${esc(age(d.at))} ago — the last refresh did not answer.</p>`
      : '';
    // The kept-answer mark (bc-1kwl.8), in the same words and the same place as the
    // history tab's own — a suffix on the count line, in `.hist-kept`'s muted style
    // rather than a warning. Suppressed under `stale` above: that is a request that
    // failed outright, and showing both would say two different things about the same
    // list in two different tones.
    const kept =
      !stale && state.kept?.stale
        ? ` <span class="hist-kept">· as of ${
            state.kept.ageSec < 60 ? `${Math.max(0, Math.round(state.kept.ageSec))}s` : `${Math.round(state.kept.ageSec / 60)}m`
          } ago${state.kept.refreshing ? ', refreshing' : ''}</span>`
        : '';
    const cut = d.truncated
      ? `<p class="board-foot bad">${plural(d.truncated, 'more bead')} not shown — this list caps at ${esc(
          d.counts.shown
        )}. Answer some of these and the rest arrive.</p>`
      : '';
    const errs = (d.errors || [])
      .map((e) => `<p class="board-foot bad">⚠ ${esc(e.workspace)} did not answer — ${esc(e.error)}</p>`)
      .join('');
    return `<div class="eq-head">
      <div class="eq-head-row">
        <p class="eq-count">${plural(shown, 'bead')} waiting on you${where}${kept}</p>
        ${allHtml()}
      </div>
      <p class="subtitle">An agent filed these while it was working. Nothing will open a
        session on one until you endorse it.</p>
      ${cut}${errs}${stale}
    </div>`;
  }

  function listHtml() {
    const d = state.data;
    if (!d) {
      if (state.error) return `<div class="empty"><strong>Can't reach the server</strong>${esc(state.error)}</div>`;
      return '<div class="empty">Asking every workspace…</div>';
    }
    const list = rows();
    if (!list.length) {
      // The one thing that must survive an empty list: you have just endorsed the last
      // bead, and the queue emptying *is* the confirmation — but only if it is said.
      const done = pageSaidHtml();
      // Two ways of being empty, and they mean different things: nothing anywhere is
      // the good state, and nothing *here* is one tap from being undone in the bar
      // above.
      const elsewhere = d.counts.total - list.length;
      return `${done}<div class="empty"><strong>Nothing is waiting for endorsement</strong>${
        elsewhere
          ? `${plural(elsewhere, 'bead')} in another space. Change the picker above to see ${
              elsewhere === 1 ? 'it' : 'them'
            }.`
          : 'When an agent files a bead mid-task it lands here, held, until you say it may be worked.'
      }</div>`;
    }
    return headHtml() + pageSaidHtml() + barHtml() + list.map(beadHtml).join('');
  }

  function render() {
    // A wake that arrived while something of yours was open is applied here instead —
    // every path that closes one of those controls ends in a repaint, so this is the
    // one place that sees all of them. Scheduled rather than called, because `load`
    // sets the flags this reads and a repaint from inside its own `try` would find
    // them mid-flight. See `catchUp`.
    if (stale) setTimeout(catchUp, 0);
    if (!state.data && !state.error) return;
    // The queue is the scroller, not the window (bc-7utr) — it is the middle row of a
    // viewport-height shell, so the offset that has to survive a repaint is its own.
    const was = out.scrollTop;
    out.innerHTML = listHtml();
    out.scrollTop = was;
  }

  /* --------------------------------------------------------------------- acting */

  /** The ids one press is aimed at, grouped by workspace — a group may span repos. */
  function targets(key) {
    // `*` is what you ticked and `@` is everything drawn — deliberately not everything
    // in the payload, because the picker is part of the question this page is asking.
    const list = key === '*' ? pickedRows() : key === '@' ? rows() : [rowFor(key)].filter(Boolean);
    const byWorkspace = new Map();
    for (const b of list) {
      if (!byWorkspace.has(b.workspace)) byWorkspace.set(b.workspace, []);
      byWorkspace.get(b.workspace).push(b.id);
    }
    return { list, byWorkspace };
  }

  /**
   * Post one verdict, per workspace, and fold the answers into one sentence.
   *
   * A request per workspace because every verdict route takes a single `workspace` —
   * which is right, since a verdict is a `bd` write against one tracker — and a
   * selection made from a list of every repo can easily span two. The results are
   * concatenated, so what comes back is still one row per bead.
   */
  async function post(path, byWorkspace, body) {
    const results = [];
    for (const [workspace, ids] of byWorkspace) {
      try {
        const res = await fetch(path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
          body: JSON.stringify({ workspace, ids, ...body }),
        });
        const data = await res.json().catch(() => ({}));
        // A group where one bead failed is a 200 carrying a row per bead (`statusFor`
        // in lib/verdict.js), so a non-ok status is only a real failure when there are
        // no rows to read — a 400 that refused the whole request, or a dead socket.
        if (!res.ok && !Array.isArray(data.results)) throw new Error(data.error || `HTTP ${res.status}`);
        results.push(...(data.results || []));
      } catch (err) {
        for (const id of ids) results.push({ id, ok: false, error: err.message });
      }
    }
    return results;
  }

  /**
   * What to say afterwards, in the words of what actually happened.
   *
   * Never a flat "done": each verdict has an outcome that reads differently when it was
   * a no-op, and every one of those no-ops is a thing you would otherwise mistake for a
   * failure. Endorsing a bead that was already endorsed did nothing and should say so;
   * an adjust that changed no field is not an adjust; a group of six where the fifth
   * lost a Dolt lock race is five that landed, not a red error over the lot.
   */
  function summarise(action, results, { alsoEndorse = false } = {}) {
    const good = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    const n = plural(good.length, 'bead');

    let text = `Done — ${n}.`;
    if (action === 'endorse') {
      const moved = good.filter((r) => r.endorsed).length;
      text = moved
        ? `Endorsed ${plural(moved, 'bead')}${good.length > moved ? ` — the other ${good.length - moved} already were.` : '.'}`
        : `${good.length === 1 ? 'That bead was' : 'Those beads were'} already endorsed — nothing to do.`;
    } else if (action === 'revoke') {
      const closed = good.filter((r) => r.revoked).length;
      text = closed
        ? `Revoked ${plural(closed, 'bead')}${good.length > closed ? ` — the other ${good.length - closed} were already closed.` : '.'}`
        : `${good.length === 1 ? 'That bead was' : 'Those beads were'} already closed.`;
    } else if (action === 'changes') {
      text = `Your note is on ${n}. ${good.length === 1 ? 'It stays' : 'They stay'} held.`;
    } else if (action === 'adjust') {
      const changed = good.filter((r) => (r.changed || []).length).length;
      const endorsed = good.filter((r) => r.endorsed).length;
      const parts = [];
      if (changed) parts.push(`Adjusted ${plural(changed, 'bead')}`);
      else if (good.length) parts.push('Nothing to change — it already reads that way');
      if (endorsed) parts.push(`endorsed ${endorsed}`);
      else if (good.length && !alsoEndorse) parts.push('still held');
      text = `${parts.join(', ')}.`;
    }

    if (!bad.length) return { text, bad: false };
    if (!good.length) return { text: bad[0].error || 'That did not go through.', bad: true };
    return { text: `${text} ${bad[0].id} did not: ${bad[0].error}`, bad: true };
  }

  const ACTS = {
    endorse: { path: '/api/bead/endorse', arms: false },
    revoke: { path: '/api/bead/revoke', arms: true },
    changes: { path: '/api/bead/changes', arms: false },
    adjust: { path: '/api/bead/adjust', arms: false },
  };

  /**
   * Does this verdict take the bead off the screen?
   *
   * Which decides where its outcome is pinned: a bead that is gone cannot carry the
   * only evidence that the tap worked. An adjust counts when it endorses too, since
   * that is the half that removes it.
   */
  const removes = (action, extra) => action === 'endorse' || action === 'revoke' || (action === 'adjust' && extra.endorse);

  async function act(key, action, extra = {}) {
    if (state.busy) return;
    const spec = ACTS[action];
    const { list, byWorkspace } = targets(key);
    if (!spec || !list.length) return;

    // Two taps for revoke, which closes a bead, and for Endorse all, which releases the
    // whole page at once. Every other endorsement is one tap, deliberately: it is
    // idempotent all the way down (lib/verdict.js), the worst a stray tap does is queue
    // work you meant to queue eventually, and "endorse six in one tap" is the whole
    // reason the group bar exists — an arming step there would make it two.
    if ((spec.arms || key === '@') && !isArmed(key, action)) {
      state.armed = `${action}@${key}`;
      return render();
    }

    state.busy = true;
    state.armed = null;
    state.said = { key: sayAt(key), text: 'Working…', bad: false };
    render();

    const results = await post(spec.path, byWorkspace, extra);
    const said = summarise(action, results, { alsoEndorse: Boolean(extra.endorse) });

    // Only what actually moved leaves the selection. A bead that failed is still
    // waiting and still ticked, which is what makes pressing the button again the right
    // thing to do rather than a guess about which five of the six went through.
    const landed = new Set(results.filter((r) => r.ok).map((r) => r.id));
    for (const b of list) if (landed.has(b.id)) state.picked.delete(b.key);

    state.said = { ...said, key: isGroup(key) || removes(action, extra) ? '#' : key };
    state.busy = false;
    if (action !== 'changes') state.edit = null;
    if (removes(action, extra) && !isGroup(key)) {
      state.row = null;
      state.note = '';
    }
    render();

    // Every verdict changes what is in the queue, and the daemon has already dropped
    // its cache (see `announceVerdict` in lib/server.js) — so this comes back with the
    // rows that are genuinely still waiting.
    load({ refresh: true });
  }

  /* ---------------------------------------------------------- driving a discussion */

  /**
   * The token'd GET every discussion read makes. Throws with the server's own words.
   *
   * `opts` is here for the one caller that is not a discussion: the shared stream hands
   * its `AbortController` down, because a parked 25-second request that nothing can
   * cancel is a request that outlives the screen it was asked for. It is also what the
   * warm layer prewarms the other views through, which is why this is the page's fetch
   * wrapper and not the discussion's.
   */
  async function get(path, opts = {}) {
    const res = await fetch(path, { headers: { 'x-beadcause-token': token }, ...opts });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  /**
   * Who can answer. Once, lazily — the first time a discussion is opened.
   *
   * A roster that will not load must not stop you asking: with no chips the server
   * falls back to its default agent exactly as it would have, which is the same bargain
   * the inbox makes (see `loadAgents` in public/app.js).
   */
  async function loadAgents() {
    if (state.agents.length) return;
    try {
      const data = await get('/api/agents');
      state.agents = data.agents || [];
      if (!state.agents.some((a) => a.id === state.agent)) state.agent = data.default || state.agents[0]?.id || '';
    } catch {
      state.agents = [];
    }
  }

  /**
   * Read the thread, and find out whether anyone is still writing into it.
   *
   * `poll` is what makes this a conversation on a phone. Nothing pushes a reply on a
   * held bead — `checkReplies` only watches `bd human` questions — so the answer arrives
   * because this asks again, and it asks only while the daemon says an agent is running.
   * `TALK_TRIES` bounds that: an agent that dies without commenting must not leave a
   * phone polling a dead bead until the tab is closed.
   */
  async function readThread(key, { poll = false, tries = 0 } = {}) {
    const t = state.talk;
    if (!t || t.key !== key) return;
    try {
      const data = await get(`/api/bead/thread?workspace=${encodeURIComponent(t.workspace)}&id=${encodeURIComponent(t.id)}`);
      if (state.talk?.key !== key) return;
      state.talk.thread = data.thread || [];
      state.talk.running = Boolean(data.running);
      state.talk.activity = data.activity || null;
      state.talk.loading = false;
      render();
      if (poll && state.talk.running && tries < TALK_TRIES) {
        setTimeout(() => readThread(key, { poll: true, tries: tries + 1 }), TALK_POLL_MS);
      }
    } catch (err) {
      if (state.talk?.key !== key) return;
      state.talk.loading = false;
      // Pinned to the row rather than thrown away: the thread on screen is still the
      // thread, and the only thing that has failed is finding out whether it has moved.
      state.said = { key, text: `Could not read the thread — ${err.message}`, bad: true };
      render();
    }
  }

  /** Open the panel on a row, with whatever has already been said on that bead. */
  async function openTalk(key) {
    const b = rowFor(key);
    if (!b) return;
    state.talk = { key, workspace: b.workspace, id: b.id, thread: [], text: '', loading: true, running: false };
    state.armed = null;
    state.edit = null;
    state.said = null;
    render();
    await loadAgents();
    if (state.talk?.key === key) render();
    // Poll from the start: an agent may already be mid-reply on this bead from the last
    // time you asked, and opening the panel onto a stale thread that never moves is
    // indistinguishable from an agent that never came.
    readThread(key, { poll: true });
  }

  /**
   * Send the question, and start waiting for the answer.
   *
   * The bead is not touched beyond the comment, so there is nothing to take off the
   * screen and nothing to re-sort: the row stays exactly where it was, which is the
   * whole difference between this and the four verdicts. The queue is reloaded anyway,
   * for the one thing that did change — the 💬 count on the folded row.
   */
  async function send(key) {
    const t = state.talk;
    if (!t || t.key !== key || t.sending) return;
    const text = String(t.text || '').trim();
    if (!text) {
      state.said = { key, text: 'Type the question first — the comment is the discussion.', bad: true };
      return render();
    }

    t.sending = true;
    state.said = { key, text: 'Sending…', bad: false };
    render();

    try {
      const res = await fetch('/api/bead/discuss', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify({ workspace: t.workspace, id: t.id, text, agent: currentAgent()?.id || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      if (state.talk?.key !== key) return;
      state.talk.sending = false;
      state.talk.text = '';
      state.talk.thread = data.thread || state.talk.thread;
      state.talk.running = Boolean(data.dispatched);
      // Said plainly when nobody is coming. A comment that quietly gets no answer is
      // the exact failure dispatch exists to fix, and "auto-dispatch is off for this
      // workspace" is a thing you can act on where a silent thread is not.
      state.said = {
        key,
        text: data.dispatched
          ? `Asked ${data.agent?.name || 'an agent'} — the bead stays held.`
          : `Your question is on the bead, but no agent was sent${data.reason ? ` — ${data.reason}` : ''}.`,
        bad: !data.dispatched,
      };
      render();
      if (data.dispatched) setTimeout(() => readThread(key, { poll: true }), TALK_POLL_MS);
    } catch (err) {
      if (state.talk?.key !== key) return;
      state.talk.sending = false;
      state.said = { key, text: err.message, bad: true };
      render();
    }
    // The 💬 count on the folded row, and nothing else — the daemon has already dropped
    // the queue cache so this comes back with the comment counted.
    load({ refresh: true });
  }

  /** The adjust form as the server wants it: the six fields, labels split on commas. */
  function editsNow() {
    const f = state.edit?.fields || {};
    return {
      title: f.title,
      type: f.type,
      priority: Number(f.priority),
      description: f.description,
      acceptance: f.acceptance,
      labels: String(f.labels || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    };
  }

  out.addEventListener('click', (ev) => {
    const pick = ev.target.closest('[data-pick]');
    if (pick) {
      const key = pick.dataset.pick;
      if (state.picked.has(key)) state.picked.delete(key);
      else state.picked.add(key);
      // A selection and an armed group button are about different sets. Disarm.
      state.armed = null;
      state.said = null;
      return render();
    }

    const btn = ev.target.closest('[data-act]');
    if (btn) {
      ev.preventDefault();
      const { act: action, key } = btn.dataset;

      if (action === 'clear') {
        state.picked.clear();
        state.armed = null;
        state.said = null;
        return render();
      }
      if (action === 'edit') {
        const b = rowFor(key);
        if (!b) return;
        state.edit = { key, fields: editFrom(b) };
        state.armed = null;
        state.said = null;
        return render();
      }
      if (action === 'cancel-edit') {
        state.edit = null;
        return render();
      }
      if (action === 'talk') return openTalk(key);
      if (action === 'close-talk') {
        // The thread stays on the bead; only the panel closes. Nothing typed is worth
        // keeping — a half-written question you have navigated away from is one you
        // decided not to ask.
        state.talk = null;
        state.said = null;
        return render();
      }
      if (action === 'send') return send(key);
      if (action === 'agent') {
        state.agent = btn.dataset.agent || '';
        return render();
      }
      if (action === 'save' || action === 'save-endorse') {
        return act(key, 'adjust', { edits: editsNow(), endorse: action === 'save-endorse' });
      }
      if (action === 'changes') {
        const note = String(state.note || '').trim();
        if (!note) {
          // Not a silent no-op: the button is right there and the box is empty, and
          // "nothing happened" is indistinguishable from a request that failed.
          state.said = { key, text: 'Type the objection first — asking for changes is the note.', bad: true };
          return render();
        }
        return act(key, 'changes', { note });
      }
      if (action === 'revoke') {
        const reason = key === '*' ? '' : String(state.note || '').trim();
        return act(key, 'revoke', reason ? { reason } : {});
      }
      return act(key, action);
    }

    // A bead pill is a link into the graph, not a fold.
    if (ev.target.closest('.pill.id')) return;

    const row = ev.target.closest('[data-row]');
    if (row) {
      const key = row.dataset.row;
      state.row = state.row === key ? null : key;
      // Everything typed, armed or half-edited belongs to the row that is closing —
      // including the discussion panel, whose poll stops the moment `state.talk` is not
      // this row any more (see `readThread`).
      state.armed = null;
      state.edit = null;
      state.talk = null;
      state.note = '';
      state.said = null;
      render();
    }
  });

  /* Kept in `state` on every keystroke: the list repaints under you when the log moves,
     and a half-written objection — or a half-rewritten description — must survive it. */
  out.addEventListener('input', (ev) => {
    // And this is the other end of that: whatever this keystroke does to the flags
    // below, a wake that was deferred by them gets its chance immediately afterwards.
    // Emptying the box is the case that needs it — nothing else on this page repaints
    // for a keystroke, so without this the queue would sit on the news until your next
    // tap. Scheduled, so the flags are already written when it reads them.
    if (stale) setTimeout(catchUp, 0);
    const note = ev.target.closest('[data-note]');
    if (note) {
      state.note = note.value;
      return;
    }
    const question = ev.target.closest('[data-talk]');
    if (question) {
      if (state.talk) state.talk.text = question.value;
      return;
    }
    const f = ev.target.closest('[data-edit]');
    if (f && state.edit) state.edit.fields[f.dataset.edit] = f.value;
  });

  /* A <select> fires `change`, not `input`, in enough browsers to be worth both. */
  out.addEventListener('change', (ev) => {
    const f = ev.target.closest('[data-edit]');
    if (f && state.edit) state.edit.fields[f.dataset.edit] = f.value;
  });

  /* ----------------------------------------------------------------- the fetch */

  /**
   * A row named in the query string — `?bead=<workspace>/<id>&talk=1`.
   *
   * This is where the **Discuss** button on a JIRA ticket row lands (bc-0i27.7). The
   * ticket's epic is another held bead, discussing one is what this page already does,
   * and the alternative was a second thread panel — poll timer, agent picker, bubbles —
   * grafted onto an inbox row. So the row hands you here with the conversation already
   * open on the right bead, which is the difference between reusing the discuss path
   * and merely linking at the screen it lives on.
   *
   * Read once, acted on once, and deliberately not kept: coming back to this page later
   * in the same tab should give you the queue, not re-open a discussion you closed.
   */
  const WANTED = (() => {
    const q = new URLSearchParams(location.search);
    const key = String(q.get('bead') || '').trim();
    return key ? { key, talk: q.get('talk') === '1' } : null;
  })();
  let deepLinked = false;

  /**
   * Open the row the query named, once the queue holding it has arrived.
   *
   * A bead that is not in the queue is said out loud rather than silently ignored: the
   * commonest reason is the honest one — it was endorsed or revoked between the ticket
   * row being drawn and the link being followed — and a page that just showed the whole
   * queue would leave you hunting for a bead that is not on it.
   */
  function followDeepLink() {
    if (!WANTED || deepLinked) return;
    deepLinked = true;
    // `rows()` and not `state.data.beads`: the space picker is shared with the page the
    // link came from, so a bead outside the current space is one this screen genuinely
    // cannot show — and `openTalk` would return silently, leaving a row unfolded that is
    // not drawn.
    if (!rows().some((b) => b.key === WANTED.key)) {
      state.error = `${WANTED.key} is not in this queue — it has been endorsed or revoked, or it is outside the space you are looking at.`;
      return;
    }
    state.row = WANTED.key;
    if (WANTED.talk) openTalk(WANTED.key);
  }

  async function load({ refresh = false } = {}) {
    // Two sweeps in flight can answer out of order, and the older one would paint over
    // the newer list — which on this screen means a bead you have just endorsed coming
    // back from the dead under your thumb. The one that lost is deferred rather than
    // dropped: `stale` brings it round again the moment the first has landed.
    if (loading) {
      stale = true;
      return;
    }
    stale = false;
    loading = true;
    pulse.classList.add('busy');
    try {
      const res = await fetch(`/api/unendorsed${refresh ? '?refresh=1' : ''}`, {
        headers: { 'x-beadcause-token': token },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Every answer carries it — the daemon serves a kept sweep immediately and
      // refreshes it behind (lib/cache.js), and this is what lets `headHtml` say so
      // instead of drawing a kept queue as though it were this second's.
      state.kept = parseKept(res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-beadcause-kept') : null);
      state.data = await res.json();
      // A pick on a bead that has left the queue — endorsed here, or on the laptop —
      // is a pick on nothing, and leaving it would put a phantom in the group count.
      const live = new Set((state.data.beads || []).map((b) => b.key));
      for (const key of [...state.picked]) if (!live.has(key)) state.picked.delete(key);
      if (state.row && !live.has(state.row)) {
        state.row = null;
        state.edit = null;
        state.talk = null;
      }
      if (state.first) state.first = false;
      state.error = null;
      // After `state.error` is cleared, because a deep link that found nothing sets one.
      followDeepLink();
      render();
      // Held for the next document that opens this queue, and only ever from a request
      // that came back. Arriving here from the inbox's 🗳 is the visit this pays for:
      // the rows are the whole bead, so the wait in front of them was the longest of
      // any view in the app. Then, once per document, the other views are filled in
      // behind you — see public/warm.js.
      const warm = window.beadcause?.warm;
      warm?.write?.('/api/unendorsed', state.data);
      warm?.prewarm?.({ here: 'endorse', api: get });
    } catch (err) {
      // Kept in state rather than written over the page: `listHtml` decides what a
      // failure looks like, and with a queue already on screen it is a line at the top
      // rather than the loss of everything you were reading.
      state.error = err.message;
      render();
    } finally {
      loading = false;
      pulse.classList.remove('busy');
    }
  }

  window.beadcause?.presence?.report({ view: 'endorse' });

  /* The space picker moved — on this device or the other one. Nothing is refetched: the
     payload already holds every workspace, and which of them is drawn is a decision made
     at paint time. Picks and folds outside the new space go with it, or reopening the
     space would leave a selection nobody remembers making. */
  window.beadcause?.space?.onChange(() => {
    // Disarmed, and this is the load-bearing line rather than tidiness: an armed
    // "Endorse all 60 in beadcause" whose second tap landed after the picker moved
    // would endorse a different sixty in a different repo, which is the one thing this
    // control promises it cannot do.
    state.armed = null;
    const live = new Set(rows().map((b) => b.key));
    for (const key of [...state.picked]) if (!live.has(key)) state.picked.delete(key);
    if (state.row && !live.has(state.row)) {
      state.row = null;
      state.edit = null;
      state.talk = null;
    }
    render();
  });

  document.getElementById('eq-refresh').addEventListener('click', () => load({ refresh: true }));

  /* ----------------------------------------------------------------- the stream */

  /**
   * May a wake repaint the list, or is something of yours in the way?
   *
   * A repaint throws away a half-typed adjustment or a half-typed question and disarms
   * a revoke under your thumb — so the same four conditions the old 45-second timer
   * checked, for the same reasons. `state.talk?.text` is the half-typed question; an
   * open discussion with nothing typed in it is doing its own polling anyway, on a much
   * shorter timer, and has no objection to the list behind it being correct.
   */
  const settled = () => !state.busy && !state.armed && !state.edit && !state.note && !state.talk?.text;

  /**
   * Take the wake we had to put off.
   *
   * The half of the guard above that stops it being a silent drop. A queue that ignored
   * every event that arrived while you were typing would be a queue that is wrong for
   * as long as you keep typing, and nothing on the screen would say so — the failure
   * this page can least afford, because you are about to make decisions off it.
   */
  function catchUp() {
    if (!stale || loading || !settled()) return;
    load();
  }

  /**
   * Follow the log instead of asking on a clock.
   *
   * This page was the last wall-clock refetch in the app: 45 seconds, and every one of
   * them a `bd` sweep of every workspace plus a `bd show` per row, whether or not a
   * single bead had been filed. `want: 'presence'` is what makes the park itself free —
   * the daemon sweeps `bd` for a poll that asked for the inbox questions, and this page
   * draws none of them; it wants to be *woken*, and then goes and asks for its own list.
   * `cold: true` because `/api/unendorsed` carries no sequence, so a `since`-less first
   * request is how this page learns where in the log it is.
   *
   * No timer is left behind it, which is the same bet the other five views make: a poll
   * that breaks retries with a backoff, and a browser so old that `stream.js` never
   * loaded is one whose cached shell predates the file — offline, where nothing was
   * going to refresh anyway.
   */
  function followQueue() {
    if (!window.beadcause?.stream) return;
    const stream = window.beadcause.stream.follow({
      api: get,
      want: 'presence',
      cold: true,
      ready: () => Boolean(token),
      onWake({ events, resync }) {
        // `resync` is the log saying it rolled past where we were — a phone that was in
        // a pocket for an hour — and then the only honest answer is the whole list.
        // `!== false` rather than a plain call: a stream.js cached before `queueMoved`
        // existed answers `undefined`, and "we cannot tell" has to fall on the side that
        // goes and asks — a queue that quietly stopped updating is the one failure this
        // page cannot have.
        if (!resync && window.beadcause.stream.queueMoved?.(events) === false) return;
        if (!settled()) {
          stale = true;
          return;
        }
        load();
      },
    });
    stream.start();
  }

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    // The queue as another document left it, drawn before the request has left. Not
    // `followDeepLink` — a link to a bead this frame happens not to hold would set an
    // error about a queue that has not been asked for yet, and `load` does it properly
    // a moment later.
    const hit = window.beadcause?.warm?.read?.('/api/unendorsed');
    if (Array.isArray(hit?.data?.beads)) {
      state.data = hit.data;
      state.first = false;
      render();
    }
    load();
    followQueue();
  }
})();
