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

  /* A `bd list` per workspace plus a `bd show` per row behind this, and the queue is a
     screen you read rather than watch. The daemon caches it for a few seconds anyway,
     and every verdict drops that cache — so a stale row is at worst one poll old. */
  const REFRESH_MS = 45000;

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

  const graphUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}`;

  /** Is this bead in the selected space? See public/spacebar.js. */
  const inSpace = (b) => window.beadcause?.space?.matches?.(b.workspace) ?? true;

  /** The rows this page is actually drawing — everything else is in the payload, unshown. */
  const rows = () => (state.data?.beads || []).filter(inSpace);

  const rowFor = (key) => rows().find((b) => b.key === key) || null;

  /** The selected rows, and only the ones still on screen: a filtered-away pick is not one. */
  const pickedRows = () => rows().filter((b) => state.picked.has(b.key));

  const isArmed = (key, action) => state.armed === `${action}@${key}`;

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
   * (see `addProvenance`), and "found under nothing" would be a claim it never made.
   */
  function fromHtml(b) {
    if (!b.from) return '';
    const word = b.from.kind === 'discovered' ? 'Found while working' : 'Filed under';
    return `<span class="eq-from">${esc(word)} <a class="pill id" href="${esc(
      graphUrl(b.workspace, b.from.id)
    )}">${esc(b.from.id)}</a>${b.from.title ? ` <span class="eq-from-title">${esc(b.from.title)}</span>` : ''}</span>`;
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

  /* ------------------------------------------------------------- the unfolded row */

  function openHtml(b) {
    const editing = state.edit?.key === b.key;
    const said = state.said?.key === b.key ? `<div class="board-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</div>` : '';

    if (editing) return `<div class="board-open">${editHtml(b)}${said}</div>`;

    const revoking = isArmed(b.key, 'revoke');
    const buttons = [
      `<button class="board-btn merge" data-act="endorse" data-key="${esc(b.key)}">Endorse</button>`,
      `<button class="board-btn" data-act="edit" data-key="${esc(b.key)}">Adjust ✎</button>`,
      `<button class="board-btn" data-act="changes" data-key="${esc(b.key)}">Ask for changes</button>`,
      `<button class="board-btn revoke${revoking ? ' armed' : ''}" data-act="revoke" data-key="${esc(b.key)}">${
        revoking ? 'Revoke it — sure?' : 'Revoke'
      }</button>`,
      `<a class="board-btn link" href="${esc(graphUrl(b.workspace, b.id))}">Graph ↗</a>`,
    ];

    return `<div class="board-open">
      ${field('What the work is', b.description)}
      ${field('What done looks like', b.acceptance)}
      ${field('Design', b.design)}
      ${b.notes ? `<div class="eq-field prov"><h3>How it was found</h3><p>${emph(b.notes)}</p></div>` : ''}
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
    const cut = d.truncated
      ? `<p class="board-foot bad">${plural(d.truncated, 'more bead')} not shown — this list caps at ${esc(
          d.counts.shown
        )}. Answer some of these and the rest arrive.</p>`
      : '';
    const errs = (d.errors || [])
      .map((e) => `<p class="board-foot bad">⚠ ${esc(e.workspace)} did not answer — ${esc(e.error)}</p>`)
      .join('');
    return `<div class="eq-head">
      <p class="eq-count">${plural(shown, 'bead')} waiting on you${where}</p>
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
    if (!state.data && !state.error) return;
    const scrollY = window.scrollY;
    out.innerHTML = listHtml();
    window.scrollTo(0, scrollY);
  }

  /* --------------------------------------------------------------------- acting */

  /** The ids one press is aimed at, grouped by workspace — a group may span repos. */
  function targets(key) {
    const list = key === '*' ? pickedRows() : [rowFor(key)].filter(Boolean);
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

    // Two taps only for revoke, which closes a bead. Endorsing is one, deliberately:
    // it is idempotent all the way down (lib/verdict.js), the worst a stray tap does is
    // queue work you meant to queue eventually, and "endorse six in one tap" is the
    // whole reason the group bar exists — an arming step would make it two.
    if (spec.arms && !isArmed(key, action)) {
      state.armed = `${action}@${key}`;
      return render();
    }

    state.busy = true;
    state.armed = null;
    state.said = { key, text: 'Working…', bad: false };
    render();

    const results = await post(spec.path, byWorkspace, extra);
    const said = summarise(action, results, { alsoEndorse: Boolean(extra.endorse) });

    // Only what actually moved leaves the selection. A bead that failed is still
    // waiting and still ticked, which is what makes pressing the button again the right
    // thing to do rather than a guess about which five of the six went through.
    const landed = new Set(results.filter((r) => r.ok).map((r) => r.id));
    for (const b of list) if (landed.has(b.id)) state.picked.delete(b.key);

    state.said = { ...said, key: key === '*' || removes(action, extra) ? '#' : key };
    state.busy = false;
    if (action !== 'changes') state.edit = null;
    if (removes(action, extra) && key !== '*') {
      state.row = null;
      state.note = '';
    }
    render();

    // Every verdict changes what is in the queue, and the daemon has already dropped
    // its cache (see `announceVerdict` in lib/server.js) — so this comes back with the
    // rows that are genuinely still waiting.
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
      // Everything typed, armed or half-edited belongs to the row that is closing.
      state.armed = null;
      state.edit = null;
      state.note = '';
      state.said = null;
      render();
    }
  });

  /* Kept in `state` on every keystroke: the list repaints under you on its own timer,
     and a half-written objection — or a half-rewritten description — must survive it. */
  out.addEventListener('input', (ev) => {
    const note = ev.target.closest('[data-note]');
    if (note) {
      state.note = note.value;
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

  async function load({ refresh = false } = {}) {
    pulse.classList.add('busy');
    try {
      const res = await fetch(`/api/unendorsed${refresh ? '?refresh=1' : ''}`, {
        headers: { 'x-beadcause-token': token },
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      state.data = await res.json();
      // A pick on a bead that has left the queue — endorsed here, or on the laptop —
      // is a pick on nothing, and leaving it would put a phantom in the group count.
      const live = new Set((state.data.beads || []).map((b) => b.key));
      for (const key of [...state.picked]) if (!live.has(key)) state.picked.delete(key);
      if (state.row && !live.has(state.row)) {
        state.row = null;
        state.edit = null;
      }
      if (state.first) state.first = false;
      state.error = null;
      render();
    } catch (err) {
      // Kept in state rather than written over the page: `listHtml` decides what a
      // failure looks like, and with a queue already on screen it is a line at the top
      // rather than the loss of everything you were reading.
      state.error = err.message;
      render();
    } finally {
      pulse.classList.remove('busy');
    }
  }

  window.beadcause?.presence?.report({ view: 'endorse' });

  /* The space picker moved — on this device or the other one. Nothing is refetched: the
     payload already holds every workspace, and which of them is drawn is a decision made
     at paint time. Picks and folds outside the new space go with it, or reopening the
     space would leave a selection nobody remembers making. */
  window.beadcause?.space?.onChange(() => {
    const live = new Set(rows().map((b) => b.key));
    for (const key of [...state.picked]) if (!live.has(key)) state.picked.delete(key);
    if (state.row && !live.has(state.row)) {
      state.row = null;
      state.edit = null;
    }
    render();
  });

  document.getElementById('eq-refresh').addEventListener('click', () => load({ refresh: true }));

  setInterval(() => {
    // Not while you are mid-sentence, mid-edit or holding an armed revoke: a repaint
    // would throw the first two away and disarm the third under your thumb.
    if (!state.busy && !state.armed && !state.edit && !state.note) load();
  }, REFRESH_MS);

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    load();
  }
})();
