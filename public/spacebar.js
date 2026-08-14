/*
  The space picker — one repo at a time, in the top bar of every standing view.

  ## Why it is chrome and not a filter row

  Beadcause reads every beads workspace under `~/beads/`, which in practice is every
  repo you have: work, three side projects, a trip, a house. That is the right thing
  for a notification daemon and the wrong thing for a screen. Six repos of questions,
  advocates, pull requests and chats interleaved by priority is a list where the thing
  you are actually doing this hour is three rows down from something you will not touch
  for a month, and no amount of sorting fixes it — the rows are all legitimately live.

  So the app grew four separate answers to the same problem, one per page: the inbox
  had a space chip row and a workspace chip row, the chat launcher had a repo tab bar
  with its own localStorage key, the agents screen had a 📁 button that cycled
  workspaces, and the PR board and advocate console had nothing at all. Four controls,
  four states, and switching context meant setting the same thing in four places and
  still having two pages that ignored you.

  This is the one control. It sits in the top bar, it is the same on every page, and
  what it selects is what the page shows — the list, the empty state, all of it.
  Picking `beadcause` means beadcause's questions, beadcause's advocate, beadcause's
  pull requests and beadcause's chats, and nothing else anywhere.

  ## What it selects, and why the two levels stay

  A space is a *group* of workspaces that share a notification policy (lib/spaces.js) —
  "Personal", "Climative". A workspace is one repo. The picker offers both, because both
  are things you mean: "Climative, all of it" is a workday, and "beadcause" is an hour.
  Coarsest first, each space's repos indented under it, so the list reads as the
  hierarchy it is. Everything is one flat `<select>` all the same: a native dropdown is
  a wheel on a phone and a real menu on a laptop, needs no outside-click handling, and
  cannot end up half-open behind a card.

  **`All` stays, and stays the default.** The stored filter is what the notification
  path reads to decide whether your phone rings (see `quietReasonFor`), so a picker
  that defaulted to one repo would silence five others for somebody who had never
  touched it — and a question you were never told about is the one failure this app
  exists to prevent. Narrowing is a decision you make; it is not made for you.

  ## Where the selection lives

  On the server, in `state.json`, as the same `{space, workspace}` the inbox chips have
  always written — `POST /api/filter`. Not localStorage, for two reasons that have not
  changed: the push path reads it from inside the poll with no client in the loop, and
  one person with a phone and a laptop should not have two devices disagreeing about
  what they are working on. The accepted consequence is that narrowing on the laptop
  narrows the phone, which is the same person either way.

  Which also means this file owns the write. A page that repaints from a poll must not
  snap the picker back to a value its own tap has already replaced, so `writing()` is
  how a page asks whether a write of ours is still in flight before adopting a filter
  off a payload that was assembled before it landed.

  ## What a page has to do

      window.beadcause.space.onChange(() => render());     // repaint when it moves
      rows.filter((r) => window.beadcause.space.matches(r.workspace));

  `matches()` is the same two-level test `matchesFilter` applies on the server, and it
  has to stay that way: the server decides whether a bead may ring your phone, this
  decides whether you can see it, and a bead that rings and cannot be found is worse
  than either half being wrong on its own. A row with no workspace at all — a session
  outside every repo — is out while anything is selected and back the moment nothing is.

  ## There are no numbers, and that is deliberate

  This control drew three of them until bc-ka5y.1: a pill on the bar, a `· N` tail on
  every repo row, and a total on each space. All three are gone, and so is the
  `counts` map behind them and the warning marker that flagged a sum taken over a sweep
  with a hole in it. **Do not put one back.** They were a second count of a list that is already on
  screen, published from whichever page happened to be drawing — which meant every page
  had to keep them in step with what it was showing, and the failure was silent and
  looked exactly like the truth. What the picker says now is *where you are*, which is
  a question about the config and cannot drift from anything.

  What remains adoptable is the shape: the spaces, the configured workspaces, and the
  selection. Our `/api/spaces` fetch is for the pages that sweep nothing, and it is in
  flight before any page has published — so it is adopted weakly: whatever a page has
  published for itself, the fetch does not touch.

  Missing on purpose: **the admin page has no picker.** It is the one page that
  deliberately acts on every repo at once (see the header of public/admin.js), and a
  control that page ignored would be a lie about what the buttons under it do.
*/
(() => {
  'use strict';

  const bar = document.querySelector('.topbar');
  if (!bar) return;

  const ALL = 'all';

  /* The same `?t=` pickup the other pages do, and here for a reason of its own: this
     file loads *before* the page's own script so a page can register `onChange` at the
     top of its IIFE, which means it can be the first thing on the page to want the
     token. Read, never stripped — the page it runs ahead of is what owns the address
     bar, and two `history.replaceState` calls for one query parameter is one too many. */
  const token = (() => {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      try {
        localStorage.setItem('beadcause.token', fromUrl);
      } catch {
        /* private mode. The page's own pickup will complain if it matters. */
      }
      return fromUrl;
    }
    try {
      return localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  })();

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const state = {
    /** `summarise()` rows: { name, workspaces, count, quiet, muted }. The shape and the
     *  flags are read; `count` is not — see "there are no numbers" above. */
    spaces: [],
    /** Every configured workspace, whether or not anything is waiting in it. */
    workspaces: [],
    filter: { space: ALL, workspace: ALL },
    /** Has anything real arrived yet? Until it has, the bar is not drawn. */
    known: false,
  };

  /* How many writes of ours are in flight. A counter and not a boolean, for the reason
     app.js's `filterWrites` was one: picking twice quickly starts a second write before
     the first has answered, and a boolean would clear on the first reply and leave the
     second exposed to the next poll. */
  let writes = 0;
  const listeners = [];

  /* Which fields a page has published for itself, and so owns. Our own `/api/spaces`
     fetch adopts weakly and skips these: it was sent before the page's script ran, and
     a reply that overwrote what a page had already published would put the bar one
     poll behind the page it sits on. */
  const owned = new Set();

  /* ------------------------------------------------------------------ the model */

  /** The space a workspace belongs to. Unassigned repos answer to "Other", exactly as
   *  `summarise()` and the inbox's own `spaceOf` do — if these three ever disagreed,
   *  a bead would be pushed by a filter that cannot show it. */
  const spaceOf = (workspace) =>
    state.spaces.find((s) => (s.workspaces || []).includes(workspace))?.name || 'Other';

  /** Configured workspaces in no configured space, in the order the server sent them. */
  const strays = () => state.workspaces.filter((w) => spaceOf(w) === 'Other');

  /**
   * Is this row in view? The client half of `matchesFilter` in lib/spaces.js.
   *
   * Defaults to true while nothing is known, so a page that renders before this file
   * has heard from the server shows everything rather than briefly showing nothing.
   */
  const matches = (workspace) => {
    const { space, workspace: only } = state.filter;
    if (space === ALL && only === ALL) return true;
    // A row that belongs to no repo at all — a session started outside every workspace,
    // which the advocate console draws under "Elsewhere" — answers to "Other", because
    // `spaceOf('')` is 'Other' and the server's `matchesFilter` reads a bead with no
    // space the same way. So it is hidden by every real space and shown by that one.
    // Not a special case here, deliberately: a special case is precisely how the two
    // halves of this decision would start to differ.
    if (space !== ALL && spaceOf(workspace) !== space) return false;
    if (only !== ALL && workspace !== only) return false;
    return true;
  };

  /** What is selected, in words: "beadcause", "Personal", "everything". */
  const label = () => {
    const { space, workspace } = state.filter;
    if (workspace !== ALL) return workspace;
    if (space !== ALL) return space;
    return 'everything';
  };

  /* ------------------------------------------------------------------ the control */

  const el = document.createElement('div');
  el.className = 'spacebar';
  el.hidden = true;
  el.innerHTML = `<div class="spacepick">
      <select id="space-pick" aria-label="Which space to show — everything outside it is hidden"></select>
      <span class="spacepick-caret" aria-hidden="true">▾</span>
    </div>`;
  bar.append(el);

  const sel = el.querySelector('#space-pick');

  /** The rows as they were last written, so an unchanged paint touches no DOM. */
  let drawn = null;

  /** The value that means this selection, and the selection that value means. */
  const valueOf = (filter) =>
    filter.workspace !== ALL ? `ws:${filter.workspace}` : filter.space !== ALL ? `space:${filter.space}` : ALL;
  const filterOf = (value) => {
    if (value.startsWith('ws:')) {
      const workspace = value.slice(3);
      // Both halves, always. The space is what the notification path tests first, and a
      // workspace pinned under `space: all` reads as a wider filter than it is.
      return { space: spaceOf(workspace), workspace };
    }
    if (value.startsWith('space:')) return { space: value.slice(6), workspace: ALL };
    return { space: ALL, workspace: ALL };
  };

  const option = (value, text, on) =>
    `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(text)}</option>`;

  /**
   * Repaint once the screen is let go of again.
   *
   * Registered from inside the freeze rather than at load, for one reason: this file runs
   * ahead of every page script, and public/editmode.js may not have defined
   * `window.beadcause.editMode` yet. Inside the guard it certainly has — `frozen()` just
   * answered true. One listener at most, ever; it repaints on the change that turns edit
   * mode off and does nothing on the one that turns it on, which `paint()`'s own guard
   * already handles.
   */
  let thawWatching = false;
  function thawFirst() {
    if (thawWatching) return;
    const mode = window.beadcause?.editMode;
    if (typeof mode?.onChange !== 'function') return;
    thawWatching = true;
    mode.onChange(() => {
      if (!mode.frozen?.()) paint();
    });
  }

  /**
   * The dropdown: All, then each space with its repos under it.
   *
   * Every *configured* workspace gets a row whether or not anything is waiting in it —
   * the picker is how you get to a quiet repo, and a list of only the noisy ones would
   * be a list you cannot use to change the subject. A muted space says so with the
   * same 🔕 its chip used to carry, because a repo you hear nothing from should not
   * look like a repo with nothing in it.
   */
  function paint() {
    // Not while the page is deliberately holding still. Edit mode (public/editmode.js)
    // is a state in which every tap points at an element rather than acting on it, so a
    // poll that rebuilds this `<select>`'s options has moved the chrome above the list
    // out from under a thumb that was aiming at it.
    //
    // Only the paint waits. `adopt()` above has already taken the new spaces, repos and
    // selection into `state`, so nothing is lost and no refetch is owed — and the skipped
    // paint is *remembered*, so the thaw repaints the bar rather than leaving it holding
    // whatever it drew before the freeze. It used to be able to rely on the inbox instead:
    // the last line of `render()` was `publishCounts()`, which was a `space.adopt()`,
    // which ended here — so the repaint that thawed the list repainted this bar in the
    // same tick. bc-ka5y.1 deleted those counts and with them that call, so the catch-up
    // is owned here now. A page with no edit mode, or one served before the file existed,
    // answers undefined and paints as it always did.
    if (window.beadcause?.editMode?.frozen?.()) return void thawFirst();
    const now = valueOf(state.filter);
    const rows = [option(ALL, 'All spaces', now === ALL)];

    for (const s of state.spaces) {
      const inside = (s.workspaces || []).filter((w) => state.workspaces.includes(w));
      // A space whose every workspace has left the config is config drift, not a place
      // to go. Its own row stays — it is still what the filter may be pinned to.
      rows.push(`<optgroup label="${esc(s.name)}${s.quiet ? ' 🔕' : ''}">`);
      rows.push(option(`space:${s.name}`, `${s.name} — all`, now === `space:${s.name}`));
      for (const w of inside) rows.push(option(`ws:${w}`, w, now === `ws:${w}`));
      rows.push('</optgroup>');
    }

    const rest = strays();
    if (rest.length) {
      // The same synthetic group `summarise()` emits, and named the same, so a filter
      // pinned to "Other" has a row to be selected in.
      rows.push(`<optgroup label="Other">`);
      for (const w of rest) rows.push(option(`ws:${w}`, w, now === `ws:${w}`));
      rows.push('</optgroup>');
    }

    // Assigned only when it has actually changed. Pages republish on every poll and on
    // every filter tap — and rebuilding a `<select>` under an open native dropdown, on
    // a phone, is a wheel that shuts itself. Compared against what we last wrote rather
    // than against `sel.innerHTML`, because a real DOM hands that back normalised and
    // would never match.
    const html = rows.join('');
    if (html !== drawn) {
      drawn = html;
      sel.innerHTML = html;
    }

    // One repo and one space is not a choice. Drawn from the configured list rather
    // than from what has questions in it, so the bar does not appear and disappear as
    // the day goes.
    el.hidden = !state.known || state.workspaces.length < 2;
    el.classList.toggle('narrowed', valueOf(state.filter) !== ALL);
  }

  const same = (a, b) => a.space === b.space && a.workspace === b.workspace;

  function notify(detail) {
    for (const fn of listeners) {
      try {
        fn(detail);
      } catch {
        /* One page's repaint must not stop the next listener, or the bar itself. */
      }
    }
  }

  /* --------------------------------------------------------------- the write */

  /**
   * Pick a space. The paint is immediate and the write follows it — a failed write
   * costs the persistence, not the filtering, which is the right way round: the next
   * poll puts the stored value back.
   */
  function set(next, { post = true } = {}) {
    const before = state.filter;
    state.filter = { space: next.space || ALL, workspace: next.workspace || ALL };
    paint();
    if (!post) {
      if (!same(before, state.filter)) notify({ filter: state.filter, source: 'adopt' });
      return Promise.resolve(null);
    }
    if (same(before, state.filter)) return Promise.resolve(null);
    notify({ filter: state.filter, source: 'pick' });
    writes += 1;
    return fetch('/api/filter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
      body: JSON.stringify(state.filter),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .finally(() => {
        writes -= 1;
      });
  }

  sel.addEventListener('change', () => set(filterOf(sel.value)));

  /* --------------------------------------------------------------- coming in */

  /**
   * What a page already knows, fed in rather than fetched again.
   *
   * The inbox has all of this on `/api/questions` — the spaces, the workspaces, the
   * stored filter — and a second fetch would paint the bar and then repaint it.
   * Everything is optional: a page that knows only the filter says only that.
   *
   * The filter is skipped while a write of ours is in flight, because that payload was
   * assembled before the tap that changed it.
   *
   * A page calling this owns every field it sends, from then on: `weak` is ours alone,
   * for the `/api/spaces` reply, and it yields field by field to whatever a page has
   * already published rather than replacing the lot. Field by field because the two
   * payloads are not the same picture — the fetch is the only source of the spaces on a
   * page that publishes nothing but the filter, and vice versa.
   */
  function adopt(data = {}, { weak = false } = {}) {
    const FIELDS = ['spaces', 'workspaces', 'filter'];
    if (!weak) for (const f of FIELDS) if (data[f] !== undefined) owned.add(f);
    const take = (f) => data[f] !== undefined && !(weak && owned.has(f));

    if (take('spaces') && Array.isArray(data.spaces)) state.spaces = data.spaces;
    if (take('workspaces') && Array.isArray(data.workspaces)) state.workspaces = data.workspaces;
    const first = !state.known;
    state.known = true;
    if (take('filter') && data.filter && !writes) {
      set(data.filter, { post: false });
    } else {
      paint();
    }
    // A page that rendered before any of this arrived is showing everything, which is
    // right and is also stale the moment a filter is in force.
    if (first) notify({ filter: state.filter, source: 'load' });
  }

  /**
   * The pages with no sweep of their own. Cheap — see /api/spaces.
   *
   * Weak, because this request is sent from the top of this file, before the page's own
   * script has run: on the inbox, which warm-boots a list out of cache in the same tick,
   * the reply lands *after* the page has published what it is showing, and one poll
   * behind it.
   */
  async function load() {
    if (!token) return;
    try {
      const res = await fetch('/api/spaces', { headers: { 'x-beadcause-token': token } });
      if (!res.ok) return;
      adopt(await res.json(), { weak: true });
    } catch {
      /* No bar rather than a wrong one. The page's own error handling has the network. */
    }
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.space = {
    /** What is selected, as the server's own `{space, workspace}`. */
    get filter() {
      return state.filter;
    },
    matches,
    label,
    spaceOf,
    /** Configured workspaces inside the selection — what a page offers when it has to
     *  pick one repo itself (the agents screen, the chat launcher's ＋). */
    inside() {
      const { space, workspace } = state.filter;
      if (workspace !== ALL) return [workspace];
      return state.workspaces.filter((w) => space === ALL || spaceOf(w) === space);
    },
    /** Called on every move, and once when the first data lands. */
    onChange(fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    set,
    adopt,
    /** Is a write of ours still in flight? A poll must not adopt a filter over it. */
    writing: () => writes > 0,
  };

  load();
})();
