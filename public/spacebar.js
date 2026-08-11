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
  what it selects is what the page shows — the list, the counts, the empty state, all
  of it. Picking `beadcause` means beadcause's questions, beadcause's advocate,
  beadcause's pull requests and beadcause's chats, and nothing else anywhere.

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
    /** `summarise()` rows: { name, workspaces, count, quiet, muted }. */
    spaces: [],
    /** Every configured workspace, whether or not anything is waiting in it. */
    workspaces: [],
    /** workspace → how many beads are asking you something. */
    counts: {},
    /** The repos whose sweep threw, from lib/sweep.js. A count that is missing one of
     *  these is arithmetic over a sweep with a hole in it, and must not be drawn as a
     *  figure — see `tail`. */
    trouble: [],
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

  /** How many beads are asking you something, inside the current selection. */
  const waiting = () => {
    const { space, workspace } = state.filter;
    if (workspace !== ALL) return state.counts[workspace] || 0;
    if (space !== ALL) return state.spaces.find((s) => s.name === space)?.count || 0;
    return Object.values(state.counts).reduce((a, b) => a + b, 0);
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
    </div>
    <span class="spacepick-count" id="space-count" hidden></span>`;
  bar.append(el);

  const sel = el.querySelector('#space-pick');
  const count = el.querySelector('#space-count');

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

  /** Did this repo fail to answer the last sweep? Then no number about it is a fact. */
  const unsure = (workspace) => (state.trouble || []).some((t) => t && t.workspace === workspace);

  /** And a space is unsure if any of its repos is — the total is the sum. */
  const spaceUnsure = (s) => ((s && s.workspaces) || []).some(unsure);

  /**
   * A count, drawn only where there is one — a row of zeroes reports emptiness rather
   * than offering somewhere to go.
   *
   * `unknown` is what stops that rule turning a broken sweep into a quiet repo. A
   * count is arithmetic over the rows that came back, so a repo that threw contributes
   * nothing to it and drops out of the row entirely — indistinguishable, on this
   * control, from a repo with nothing in it. The ⚠ is the difference between "there is
   * nothing here" and "we could not ask", and the number stays beside it when there is
   * one: whatever was last read is still the best answer available, it just stops
   * being presented as the whole of it.
   */
  const tail = (n, unknown) => (unknown ? ` · ${n || '?'} ⚠` : n ? ` · ${n}` : '');

  const option = (value, text, on) =>
    `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(text)}</option>`;

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
    const total = Object.values(state.counts).reduce((a, b) => a + b, 0);
    const anyTrouble = (state.trouble || []).length > 0;
    const now = valueOf(state.filter);
    const rows = [option(ALL, `All spaces${tail(total, anyTrouble)}`, now === ALL)];

    for (const s of state.spaces) {
      const inside = (s.workspaces || []).filter((w) => state.workspaces.includes(w));
      // A space whose every workspace has left the config is config drift, not a place
      // to go. Its own row stays — it is still what the filter may be pinned to.
      rows.push(`<optgroup label="${esc(s.name)}${s.quiet ? ' 🔕' : ''}">`);
      rows.push(
        option(`space:${s.name}`, `${s.name} — all${tail(s.count, spaceUnsure(s))}`, now === `space:${s.name}`)
      );
      for (const w of inside) {
        rows.push(option(`ws:${w}`, `${w}${tail(state.counts[w] || 0, unsure(w))}`, now === `ws:${w}`));
      }
      rows.push('</optgroup>');
    }

    const rest = strays();
    if (rest.length) {
      // The same synthetic group `summarise()` emits, and named the same, so a filter
      // pinned to "Other" has a row to be selected in.
      rows.push(`<optgroup label="Other">`);
      for (const w of rest) {
        rows.push(option(`ws:${w}`, `${w}${tail(state.counts[w] || 0, unsure(w))}`, now === `ws:${w}`));
      }
      rows.push('</optgroup>');
    }

    sel.innerHTML = rows.join('');

    const n = waiting();
    // The badge answers for whatever is selected, so it is unsure when the selection
    // is: one repo that threw, a space holding one, or — under All — any repo at all.
    const { space: pickedSpace, workspace: pickedWs } = state.filter;
    const unknown =
      pickedWs !== ALL
        ? unsure(pickedWs)
        : pickedSpace !== ALL
          ? spaceUnsure(state.spaces.find((s) => s.name === pickedSpace))
          : (state.trouble || []).length > 0;
    // A zero that is not a fact still has to be drawn, or the one repo nobody could
    // read would leave the bar looking exactly like a repo with nothing in it.
    count.hidden = !n && !unknown;
    count.textContent = unknown ? `${n || '?'} ⚠` : String(n);
    count.title = unknown
      ? `${n} waiting in ${label()} — and at least one repo could not be read`
      : `${n} waiting in ${label()}`;
    // The count is inside the bar and the bar is not a live region, so the number has
    // to carry its own words for a reader that cannot see where it sits.
    count.setAttribute('aria-label', count.title);

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
      .then((res) => {
        // The write is also what asks about the notifications the new filter excludes,
        // and this response is the only moment where clearing them is obviously part of
        // the same act. Only the inbox can draw that prompt, so it is handed on rather
        // than acted on here.
        //
        // Announced even when there is nothing to ask — as `null`, which is how a prompt
        // left over from the *previous* narrowing gets taken down at the moment widening
        // makes it untrue, rather than sitting there until the next poll. A refused write
        // is not that: it says nothing, because it learned nothing.
        if (!res) return null;
        notify({ filter: state.filter, source: 'ask', dismissAsk: res.dismissAsk?.count ? res.dismissAsk : null });
        return res;
      })
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
   * The inbox has all of this on `/api/questions` — the spaces with counts over the
   * scope it is showing, the workspaces, the stored filter — and a second fetch would
   * paint one set of numbers and then replace them. Everything is optional: a page that
   * knows only the filter says only that.
   *
   * The filter is skipped while a write of ours is in flight, because that payload was
   * assembled before the tap that changed it.
   */
  function adopt(data = {}) {
    if (Array.isArray(data.spaces)) state.spaces = data.spaces;
    if (Array.isArray(data.workspaces)) state.workspaces = data.workspaces;
    if (data.counts && typeof data.counts === 'object') state.counts = data.counts;
    // Adopted even when empty, unlike the three above: an empty list is "every repo
    // answered this time", and it is what takes the ⚠ back off.
    if (Array.isArray(data.trouble)) state.trouble = data.trouble;
    const first = !state.known;
    state.known = true;
    if (data.filter && !writes) {
      set(data.filter, { post: false });
    } else {
      paint();
    }
    // A page that rendered before any of this arrived is showing everything, which is
    // right and is also stale the moment a filter is in force.
    if (first) notify({ filter: state.filter, source: 'load' });
  }

  /** The four pages with no sweep of their own. Cheap — see /api/spaces. */
  async function load() {
    if (!token) return;
    try {
      const res = await fetch('/api/spaces', { headers: { 'x-beadcause-token': token } });
      if (!res.ok) return;
      adopt(await res.json());
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
    waiting,
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
