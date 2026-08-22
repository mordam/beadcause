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

  ## It is on the first row now, and narrow

  It had a row of its own until bc-khoe.5 — `flex: 1 0 100%`, the full width of the bar,
  under a first row that was full at four icon buttons. Those buttons are rows in the
  mark's menu (public/accountbar.js), so the first row is a mark and a picker and the bar
  is one row on every page again: 43px of sticky chrome back on the one screen a phone has.

  The cost is paid by the label rather than by the bar. What is drawn is at most twelve
  characters — see `shorten` below — so a long repo name is cut instead of pushing the bar
  wider or wrapping it. The dropdown is untouched: every row in it is the whole name, which
  is where the whole name is actually needed. `scripts/topbar-check.mjs` measures both
  halves and fails the repo for a second row.

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

  ## The poll that was already out when you tapped

  `writing()` covers a payload that lands *during* our POST, and there is a second
  ordering it cannot see. A poll issued before the tap and answered after the write has
  resolved arrives with `writing()` already false, carrying the filter the tap replaced —
  and adopting it repaints the bar and tells every page to re-filter to the old repo. That
  is the pick that applies and then reverts on its own (bc-5k22), and it is intermittent
  because it needs the poll to land inside that gap.

  So a pick leaves a `pending` note behind it: the value we sent, the value it replaced,
  and a deadline. While that note stands, an adopted filter equal to the *replaced* value
  is not believed — it can only be a payload older than the tap. Anything else clears the
  note: our own value echoed back (the server has caught up), a third value (somebody has
  moved it since, and that is newer than our tap either way), or the deadline passing.
  A failed write clears it too, because a write that did not land has nothing to echo and
  the stored value is then the true one.

  The cost is stated rather than avoided: a deliberate switch *back* to the value you just
  replaced, made on the laptop inside the window, is ignored on the phone until the note
  expires. `PENDING_MS` is what bounds it, and the note is normally gone within one poll
  — long before that bound is reached.

  Dropping a filter is not silent. The page that handed it to us has very likely mirrored
  it into its own state already — public/app.js keeps `state.space` for a dozen readers —
  so the drop notifies with what is actually selected, and the mirror is corrected in the
  same tick. Which is why this belongs here and not in five pages: one file knows a tap
  happened, and the pages only have to keep listening.

  ## Four readings of one selection, and only three of them are ours

  What is selected is drawn four times over: the span the bar fills, the `<select>`'s
  value, its `title`, and whatever the page under the bar filtered itself to. `paint()`
  writes three of those. The fourth the *browser* writes — a `<select>`'s value moves on
  the pick itself, and again on a form restore after a back navigation, with no line of
  ours involved.

  So the value is assigned here rather than left to ride along inside the markup as a
  `selected` attribute. It used to do exactly that, and the rebuild that carries it is
  guarded — identical rows are not written again, because rebuilding a `<select>` under an
  open native wheel shuts the wheel. Which meant a value that moved without a `change`
  reaching this file was never put back by anything, and the bar kept the old space until
  the page was reloaded (bc-ka5y.32).

  It also means the selection needs a row to be held in even when the list no longer
  offers one: a `<select>` whose value matches nothing shows its *first* option, which
  says "All spaces" over a list that is still narrowed. See the `held` flag below.

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

  /* The name of the group for repos in no configured space. Not a space — there is no
     entry for it in `spaces` and nothing to set on it (`GET /api/space` 404s on it by
     design) — but it is a value the filter can hold, so it needs a name in one place.
     It has to stay the string `summarise()` uses in lib/spaces.js and the one
     `matchesFilter` there compares against: a filter pinned to a name only one of the
     three spells would push a bead the picker cannot show. */
  const STRAY = 'Other';

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

  /* The last pick the server has not yet been seen to agree with: `{ours, stale, until,
     id}`. `stale` is the value the tap replaced, and while this note stands an adopted
     filter equal to it is a payload assembled before the tap — see the header. Null
     whenever there is nothing outstanding, which is almost always.

     One note and not a queue: picking twice makes the second tap's `stale` the first
     tap's `ours`, so the live note already refuses the value the screen was most recently
     showing, and holding the older one too would only widen the window in which the
     laptop is ignored. The residual is a tap straight back to where you started — A, B,
     A — where a payload carrying A cannot be told apart from the echo of our own second
     write, so it clears the note and a later payload still carrying B can land. Two taps
     and two polls inside about a second. The alternative is a note that never clears on
     an echo, which would cost every cross-device change the whole of `PENDING_MS`
     instead of one poll, on every pick rather than on that one. */
  let pending = null;

  /* Which pick a note belongs to, so a write that fails cannot clear a note a later tap
     has already replaced. */
  let picks = 0;

  /* How long a pick refuses the value it replaced, if the server never echoes anything.
     Long enough to cover a poll that was already out — the inbox's is 25s apart and its
     sweep is not instant — and it is a backstop rather than the normal path: the first
     payload assembled after our POST carries our own value and clears the note. */
  const PENDING_MS = 30000;

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
    state.spaces.find((s) => (s.workspaces || []).includes(workspace))?.name || STRAY;

  /** Configured workspaces in no configured space, in the order the server sent them. */
  const strays = () => state.workspaces.filter((w) => spaceOf(w) === STRAY);

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

  /*
    The control is a `<select>` with a span drawn where its text would be, and the select
    itself laid over the whole thing at `opacity: 0` — see `.spacepick` in
    public/style.css. That is not decoration, and it is not the usual reason for a custom
    select either: the picker shares the top row with the mark now (bc-khoe.5), so its
    *width* is part of the bar's budget, and a native select shows whatever its selected
    option says. `climative-platform` on that row is a bar with no room left on it.

    So what is shown is `shorten(label())` — at most `SHOWN_MAX` characters, and past that
    the first `SHOWN_KEEP` with an ellipsis — while every row in the dropdown keeps its
    full name. Truncating the option text instead would have been one line and would have
    truncated the list you are choosing *from*, which is the one place the whole name is
    the point.

    The select keeps the tap, the keyboard and the accessible name; it is invisible rather
    than absent, so a phone still gets its native wheel and a laptop still gets a real
    menu, and none of the outside-click handling a hand-built dropdown would owe exists
    here at all.
  */
  const el = document.createElement('div');
  el.className = 'spacebar';
  el.hidden = true;
  el.innerHTML = `<div class="spacepick">
      <span class="spacepick-shown" id="space-shown" aria-hidden="true"></span>
      <span class="spacepick-caret" aria-hidden="true">▾</span>
      <select id="space-pick" aria-label="Which space to show — everything outside it is hidden"></select>
    </div>`;
  /* Directly after the brand, not at the end of the bar. It used to be a row of its own so
     the order of the bar's children did not matter; on a shared row it does — /monitor
     keeps a live tally in `.sheet-actions`, and appending would put the picker beyond it,
     at the far right, on that page alone. Beside the mark on every page or it is four
     controls again. */
  const brand = bar.querySelector('.brand');
  if (brand && brand.parentNode === bar) brand.after(el);
  else bar.append(el);

  const sel = el.querySelector('#space-pick');
  const shownEl = el.querySelector('#space-shown');

  /* Twelve through, nine and an ellipsis past that. Twelve is what fits beside the mark
     at 360px with the bar's padding and the caret paid for — measured, not guessed, and
     `scripts/topbar-check.mjs` fails the repo if the bar ever needs a second row again.

     Nine rather than eleven is the part worth a sentence: it makes the *cut* form
     narrower than the widest uncut one, so a long repo name costs the bar less than a
     borderline one rather than more, and the ellipsis is a visible third of the label
     rather than a hairline at the end of a box that already looks full. What a cut label
     has to say is "there is more of this name", and at eleven-and-a-dot it does not. */
  const SHOWN_MAX = 12;
  const SHOWN_KEEP = 9;

  /** What the bar shows for a selection. The dropdown never sees this. */
  const shorten = (text) => {
    const s = String(text ?? '');
    return s.length > SHOWN_MAX ? `${s.slice(0, SHOWN_KEEP)}…` : s;
  };

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

  /* Did any row this paint built carry the selection? A `<select>` whose value matches no
     option shows its *first* one, so a filter pinned to something the list no longer
     offers says "All spaces" over a list that is still narrowed — which is the hole
     bc-qid8b closed for `space:Other` by always drawing that row, and which is open for
     every other pin the config can drop under you. Recorded here rather than re-derived
     after the fact, because the question is exactly "did we mark one selected", and a
     second pass over the rows asking it a different way is how the two answers start to
     differ. Reset at the top of every `paint()`. */
  let held = false;
  const option = (value, text, on) => {
    if (on) held = true;
    return `<option value="${esc(value)}"${on ? ' selected' : ''}>${esc(text)}</option>`;
  };

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
    held = false;
    const rows = [option(ALL, 'All spaces', now === ALL)];

    for (const s of state.spaces) {
      // The synthetic group is drawn once, below, and not here. `summarise()` emits a
      // row literally named "Other" for the strays that have questions, so a payload
      // carrying it used to be drawn twice: once by this loop and once by the `strays()`
      // block, under two optgroups with the same label — and a stray with a question in
      // it appeared in both, because `summarise()` had put it in the synthetic row and
      // `spaceOf` answers "Other" for it as well. Skipped rather than merged because the
      // two lists are not the same list: this one is only the strays the last sweep found
      // beads in, and the one below is every configured repo in no space, which is the
      // list the picker is for — see `strays()`.
      if (s.name === STRAY) continue;
      const inside = (s.workspaces || []).filter((w) => state.workspaces.includes(w));
      // A space whose every workspace has left the config is config drift, not a place
      // to go. Its own row stays — it is still what the filter may be pinned to.
      rows.push(`<optgroup label="${esc(s.name)}${s.quiet ? ' 🔕' : ''}">`);
      rows.push(option(`space:${s.name}`, `${s.name} — all`, now === `space:${s.name}`));
      for (const w of inside) rows.push(option(`ws:${w}`, w, now === `ws:${w}`));
      rows.push('</optgroup>');
    }

    const rest = strays();
    // The `— all` row is what a filter pinned to `space:Other` is selected in, so the
    // group is drawn for that pin even with nothing under it — a `<select>` whose value
    // matches no option shows its first, which would say "All spaces" over a narrowed
    // list. Its own quiet flag is not read: "Other" is not a configured space and has no
    // settings to be quiet by.
    if (rest.length || now === `space:${STRAY}`) {
      rows.push(`<optgroup label="${esc(STRAY)}">`);
      rows.push(option(`space:${STRAY}`, `${STRAY} — all`, now === `space:${STRAY}`));
      for (const w of rest) rows.push(option(`ws:${w}`, w, now === `ws:${w}`));
      rows.push('</optgroup>');
    }

    /*
      And a row for the selection itself, if nothing above offered one.

      The filter outlives the config it was picked under — it sits in `state.json` across
      restarts and reconfigurations — so a space renamed in `~/.config/beadcause/config.json`
      and a repo retired from `/admin` both leave it pinned to a name the payload no longer
      carries. With no row holding it the `<select>` falls back to its first option and says
      **All spaces** while the label beside it, and every list on the page, are still
      narrowed to what the filter really is: the control contradicting itself about the one
      thing it exists to say. bc-qid8b drew the `Other — all` row for exactly this reason;
      this is the same argument applied to every other pin, because "Other" was never the
      only name the list can lose.

      It says so rather than pretending, because widening the filter here is not this
      file's decision to make — `matches()` and the server's `matchesFilter` are still
      answering for the pin, so a row that quietly read `Work` would be a second lie. The
      inbox reconciles a vanished pin back to `all` on its next payload (see
      public/app.js), and until something does, this is where you can see why the list is
      empty and pick your way out of it.
    */
    if (!held) {
      rows.push(`<optgroup label="No longer configured">`);
      rows.push(option(now, `${label()} — gone`, true));
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

    /*
      The selection, said to the control rather than only to the markup — bc-ka5y.32.

      Every line above writes *rows*, and the selection rode along inside them as a
      `selected` attribute. That made the value a side effect of the rebuild, and the
      rebuild is guarded by a string: when the rows come out identical to the ones last
      written, `sel.innerHTML` is not touched, and whatever the live control is holding
      stays. The control is not only written to, though — it is the thing under the thumb,
      and its value moves without a line of code running, on the pick itself and on a form
      restore after a back navigation. So a value that moved without a `change` reaching
      us was never corrected by *anything*: not by the next poll, and not even by a poll
      that rebuilt every row, because identical rows are exactly the case the guard skips.
      The label said one repo, the dropdown held another, and it stayed that way until the
      page was reloaded, which is what was reported from the phone.

      One assignment, and only when they disagree — the same shape as the two lines below,
      and for the same reason: agreeing is the normal case, and touching a `<select>` a
      phone has open is what the guard above exists to avoid.
    */
    if (sel.value !== now) sel.value = now;

    // What the bar itself says, which is not what the dropdown says — see `shorten`.
    // Written on every paint rather than only on a change: it is one string assignment
    // against a `<select>` rebuild the paint above already guards, and the selection can
    // move without the rows moving at all.
    const shown = shorten(label());
    if (shownEl.textContent !== shown) shownEl.textContent = shown;
    // The whole name, for the thumb that hovers and for anybody who cannot see the
    // dropdown open. The control is the select's accessible name either way.
    if (sel.title !== label()) sel.title = label();

    // One repo and one space is not a choice. Drawn from the configured list rather
    // than from what has questions in it, so the bar does not appear and disappear as
    // the day goes.
    el.hidden = !state.known || state.workspaces.length < 2;
    el.classList.toggle('narrowed', valueOf(state.filter) !== ALL);
  }

  const same = (a, b) => a.space === b.space && a.workspace === b.workspace;

  /**
   * Is this adopted filter the value our own tap just replaced?
   *
   * Answering true is the whole of the fix: it says the payload was assembled before the
   * tap, whatever `writing()` says by the time it lands. Every other answer clears the
   * note as it goes, so the guard closes itself rather than waiting for its deadline —
   * which is what keeps a genuine change from the laptop arriving on the next poll and
   * not one bound later.
   */
  function replacedByUs(incoming) {
    if (!pending) return false;
    // Expired. The stored value wins again — a note that outlives its own deadline is a
    // phone that has quietly stopped taking changes from anywhere else.
    if (Date.now() > pending.until) {
      pending = null;
      return false;
    }
    // The server has caught up with us. Adopting it is a no-op and there is nothing left
    // to refuse.
    if (same(incoming, pending.ours)) {
      pending = null;
      return false;
    }
    if (same(incoming, pending.stale)) return true;
    // Neither ours nor what we replaced: somebody moved it after our tap, and that is the
    // newer decision.
    pending = null;
    return false;
  }

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
    picks += 1;
    /* Recorded before the request rather than after it, because the payload this has to
       refuse may already be on its way back: the poll it belongs to went out before the
       tap did. `ours` and `stale` are copies — `state.filter` is replaced wholesale by the
       next pick, and a note holding the live object would compare against itself. */
    const id = picks;
    pending = { ours: { ...state.filter }, stale: { ...before }, until: Date.now() + PENDING_MS, id };
    return fetch('/api/filter', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
      body: JSON.stringify(state.filter),
    })
      .then((res) => (res.ok ? res.json() : null))
      .catch(() => null)
      .then((body) => {
        // A write that did not land has nothing to echo, and the stored value is still
        // the one the tap tried to replace — so stop refusing it and let the next poll
        // put it back, which is what a failed write has always cost here. Only our own
        // note: a later tap's note is not this write's to clear.
        if (!body && pending && pending.id === id) pending = null;
        return body;
      })
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
   * assembled before the tap that changed it — and for a short while afterwards it is
   * skipped again if it carries the exact value that tap replaced, which is the poll that
   * was already out when you tapped. See "the poll that was already out" in the header.
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
      const incoming = { space: data.filter.space || ALL, workspace: data.filter.workspace || ALL };
      if (replacedByUs(incoming)) {
        // Not adopted, but not ignored either: the page that sent us this has very likely
        // already written it into its own mirror of the selection, so it is told what is
        // actually selected before it renders off the value we just refused.
        paint();
        if (!same(incoming, state.filter)) notify({ filter: state.filter, source: 'hold' });
      } else {
        set(incoming, { post: false });
      }
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
    /** The same label the bar draws — cut to fit beside the mark. Prose wants `label()`. */
    shortLabel: () => shorten(label()),
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
