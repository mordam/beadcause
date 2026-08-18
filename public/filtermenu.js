/*
  The filter controls: one pill per filter, each opening its own chips.

  ## One pill per filter, and nothing nested under a summary line

  This was one collapsed line that opened into every group at once, and bc-khoe.26 takes
  it apart. The line was the last thing on this page you had to open before you could
  read it: what it said was a comma-joined digest of four different questions, and the
  only way to change any of them was to open a panel that then covered the list you were
  changing. Two filters set is one line saying `unmerged · Claimed`, which is a sentence
  you have to parse before you know which control to reach for.

  So a group is a **pill** now — its own button, its own panel under it, its own state.
  The row of them replaces the line. Nothing is nested: what you can narrow by is the
  row, and what it is narrowed *to* is written on the pill without opening anything.

  **A pill says the narrowing exactly when there is one.** At rest it is its legend and
  nothing else — `Bead status ▾` — because a pill that also said `any status` would be
  three words of chrome per control for a filter that is not filtering. The moment it
  narrows, the value goes on it: `PR status: unmerged`, `Bead: bc-0xil`. `narrowing()`
  below is the question, and a group whose *default* narrows — the inbox's PR status,
  which shows the unmerged ones until you ask for more — answers yes with nothing
  chosen, which is what keeps that standing default on screen.

  **A narrowing whose pill is gone is still said, as a note.** `hidden()` takes a pill
  off the row when the view cannot use it, and a selection that goes on biting after the
  pill has gone is the one thing a filter control must never do quietly. That case draws
  a `.filter-note` instead — the same words, no caret, not a button — because a control
  offered over a view it does nothing for is exactly what taking the panel apart was
  for, and a *statement* is not a control. `said()` is what asks for one.

  ## Why this is its own file

  It was the bottom two thirds of public/inboxfilter.js, and it stayed there for as long
  as the inbox was the only list in the app you narrowed. The History tab is the second
  one — status, priority, provenance and an id substring over the whole ledger — and the
  moment there were two, the choice was between two implementations of the same panel or
  one shared by both.

  Two would not have looked like two. They would have looked like one control that
  behaves subtly differently on two screens: the grace period on a diagonal exit, the tap
  that pins it, the `pointerdown` that closes it *before* the tap lands on the row
  underneath rather than after, the `focusout` that has to wait a tick because
  `activeElement` is still the old node. Every one of those is a decision somebody made
  once after using the thing on a phone, and none of them is visible by reading the
  second copy.

  So this file is the chrome — the pills, the panels, the chips, and the state machine
  that opens and closes them — and it knows nothing at all about what any of it
  means. What a chip *is* stays with the page: public/inboxfilter.js owns the kinds of
  thing the inbox carries, public/history.js owns the four filters over the ledger, and
  both hand this file the same shape.

  ## The shape

  A **group** is one row of chips with a legend over it:

      { id, legend, all?, multi?, options(), pick(id), hidden?(), said?(), narrowing?() }

  `options()` is called on every paint and returns `{ id, label, note?, count?, on }`.
  That is the whole contract: the group is asked what it looks like right now, so a page
  changes the chips by changing its own state and calling `paint()` — there is no setter
  here and no state about the page's filters in this file.

  - **`all`** is what the pill says when the group is narrowing and nothing in it is
    selected. Not always "All", and in the one shape that reaches it, never: the inbox's
    PR status group says `unmerged`, because with nothing chosen it is showing you one
    rung rather than everything, and a control claiming to show you everything while
    showing you one rung is the failure this whole thing exists to avoid. A group that
    is *not* narrowing says nothing at all — its pill is its legend, and `all` is never
    read.
  - **`multi`** is whether picking closes the panel on a touchscreen. A single-choice
    group has answered its question with one tap, and the next thing you want is to look
    at the list it has just changed — which is underneath the panel.
  - **`hidden()`** is whether the group's chips are on screen at all. The inbox's PR
    status group is offered only while `PRs` is selected. Hidden rather than removed, so
    the panel does not rebuild under the pointer and the chips are still there for the
    summary line to read. **When every group is hidden and none is `said()`, the whole
    control hides** — the inbox's `Chats` pill can use none of them, and a summary line
    that opens an empty box is worse chrome than no line.
  - **`said()`** is whether the row admits to it at all, and it is deliberately *wider*
    than `hidden()`. A narrowing that is still applied while its pill is off the row is
    the one thing a filter control must never do quietly; said-but-hidden is the note.
  - **`narrowing()`** is whether this group is currently showing you less than
    everything, and it exists because only the page knows whether its own "nothing
    chosen" is a narrowing. Optional: without one, a selection is the test, which is the
    right answer for every group whose empty state really is everything.

  A **text group** is the same shape with `text: true` and `value()` / `set(v)` instead
  of `options()` / `pick()`. It draws one input rather than a row of chips — the ledger's
  id substring is not a set of chips, and a second control somewhere else on the page
  would be the two-rows-of-chrome problem all over again.

  A **typeahead** is that same text group with three more functions on it, and it is one
  shape rather than a second kind of group on purpose — the input, the 16px that stops
  iOS zooming the panel out from under itself, and the never-write-while-focused rule are
  the same decisions either way, and a control that had two of them would have had two
  answers to each:

      { text: true, value(), set(v), suggestions(), picks(), pick(id), unpick(id), note?() }

  - **`suggestions()`** is asked on every paint and returns `{ id, label, note? }`. The
    list under the input is drawn from it, and it is drawn **whenever `value()` is not
    empty** — there is no open/closed flag here, because the query is the page's state and
    a dropdown that could be open over an empty box would be a second source of truth
    about whether you are searching.
  - **`picks()`** returns `{ id, label, note? }` for what has been chosen, drawn as pills
    above the input, each with an X that calls `unpick(id)`.
  - **`note()`** is the one line to draw when `suggestions()` is empty and the box is not.
    The words belong to the page because only the page knows the difference between "no
    bead matches that" and "the tracker has not been read yet", and drawing the first over
    the second is a search box calling a bead you filed a minute ago non-existent.

  **A typeahead's pill says its picks, never its query.** The two are not the same claim:
  a half-typed word narrows nothing until you click something, and a pill that showed it
  would be the control announcing a filter that is not applied — the same failure as
  `said()` hiding one that is, in the other direction. A plain text group is the other
  way round, and correctly: the ledger's id substring *is* the filter the moment it has
  a character in it.

  ## What it deliberately does not do

  **It does not store anything.** No localStorage, no URL. The inbox keeps its kinds on
  the device and the History tab keeps its filters in the query string, and those are
  different answers to a real question — a narrowed ledger is a link you can put on a
  home screen, and "I am reading merges this hour" is not.

  **It has no innerHTML and no selector engine**, which is what lets the whole control be
  driven by a hand-made document in a test (test/inboxkinds.mjs, test/historyfilter.mjs)
  rather than only by a browser. Every node it makes it keeps.
*/
(() => {
  'use strict';

  /* A pointer that can hover — a laptop. The media query rather than a touch sniff,
     because a touchscreen laptop is both and the question here is only "can this
     device hover", which is exactly what the query answers. */
  const hoverable = () => {
    try {
      return window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    } catch {
      return false;
    }
  };

  /**
   * Draw the control inside `host`, once, and hand back the handle to repaint it.
   *
   * `groups` is a function rather than an array because the set of groups moves: a
   * sub-filter whose kind the current scope cannot hold stops being offered. It is
   * called on every paint, and the pills are built from whatever it says at mount.
   *
   * There is no `narrowed` option any more, and there is nothing left for one to do
   * (bc-khoe.26). It was the page's answer to "is this list showing less than
   * everything", and it existed to put one bold line over four filters at once. Each of
   * them writes its own answer on its own pill now, which is strictly more than the line
   * could say: `unmerged` names *which* control is doing it.
   */
  function mount(host, opts = {}) {
    if (!host) return null;

    const groupsOf = typeof opts.groups === 'function' ? opts.groups : () => opts.groups || [];
    const closeOnPick = opts.closeOnPick !== false;

    /** Which pill's panel is open, by group id. `''` is none — only ever one at a time:
     *  two panels over one list is the collapsed panel's own problem in miniature. */
    let open = '';
    let pinned = false;
    let leaveTimer = null;

    /**
     * Every element this file made, kept rather than looked up again.
     *
     * The inbox repaints every 25 seconds, and a repaint that rebuilt this control would
     * swap a chip out from under the pointer hovering it — on a laptop, a panel that
     * flickers shut while you read it. Holding the nodes is what makes `paint()` able to
     * touch nothing but text and attributes.
     *
     * `rows` is group id → { el, box, ids, chips, input }, where `ids` is the chip set
     * last drawn — the one thing that, when it changes, does mean a rebuild.
     */
    const ui = { root: null, rows: new Map() };

    /** Is this group offered — a pill on the row, with its chips behind it? */
    const shown = (g) => (typeof g.hidden === 'function' ? !g.hidden() : true);

    /** Does the row admit to it at all? Wider than `shown` — see the header. */
    const said = (g) => (typeof g.said === 'function' ? g.said() : shown(g));

    /**
     * Is this group showing you less than everything right now?
     *
     * The group's own answer where it has one, because "nothing chosen" does not mean
     * the same thing in two of them: the inbox's PR status is showing you the unmerged
     * ones with nothing chosen and its bead status is showing you every rung. Without
     * one, a selection is the test — and for a plain text group the text is the
     * selection, while a typeahead's query is not (see the header).
     */
    function narrowing(g) {
      if (typeof g.narrowing === 'function') return Boolean(g.narrowing());
      if (g.text) {
        if (typeof g.picks === 'function') return (g.picks() || []).length > 0;
        return String(g.value() || '').trim().length > 0;
      }
      return g.options().some((o) => o.on);
    }

    /**
     * What the pill says after its legend, and `''` when there is nothing to say.
     *
     * Two selections are named and three or more are counted — `Merges, Proposals` is
     * worth reading and `Questions, Merges, Proposals, Blocked` is a pill that no longer
     * fits on a phone. A group that is not narrowing says nothing, which is what leaves
     * the row a row of legends until something is set.
     */
    function valueText(g) {
      if (!narrowing(g)) return '';
      if (g.text) {
        if (typeof g.picks === 'function') {
          const picks = g.picks();
          if (picks.length <= 2) return picks.map((p) => p.label).join(', ');
          return `${picks.length} ${g.legend.toLowerCase()}`;
        }
        return String(g.value() || '');
      }
      const on = g.options().filter((o) => o.on);
      if (!on.length) return g.all || 'All';
      if (on.length <= 2) return on.map((o) => o.label).join(', ');
      return `${on.length} ${g.legend.toLowerCase()}`;
    }

    /** One chip, wired to its group. Rebuilt only when the *set* of chips changes. */
    function makeChip(g, o, row) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'chip';
      btn.dataset.chip = o.id;
      btn.setAttribute('aria-pressed', String(o.on));
      // The third column of the table rides along as the title and the accessible name:
      // one-word chips are not self-explanatory and there is no prose here to put it in.
      btn.title = o.note || o.label;
      btn.setAttribute('aria-label', o.note ? `${o.label} — ${o.note}` : o.label);
      const label = document.createElement('span');
      label.className = 'chip-label';
      label.textContent = o.label;
      btn.append(label);
      let count = null;
      if (o.count != null) {
        count = document.createElement('span');
        count.className = 'chip-count';
        count.textContent = String(o.count);
        btn.append(count);
      }
      btn.classList.toggle('none', o.count === 0);
      btn.addEventListener('click', () => pick(g, o.id));
      row.chips.set(o.id, { btn, count });
      return btn;
    }

    /**
     * The one input a text group draws.
     *
     * `type="search"` for the clear affordance the platform already draws, and because
     * the on-screen keyboard it brings up is the one with a search key rather than a
     * newline. It is built once and never rebuilt: an input replaced mid-word is a word
     * you have to type again.
     */
    function makeInput(g, row) {
      const input = document.createElement('input');
      input.type = 'search';
      input.className = 'filter-text';
      input.setAttribute('aria-label', g.legend);
      if (g.placeholder) input.placeholder = g.placeholder;
      input.value = String(g.value() || '');
      input.addEventListener('input', () => {
        // A fresh word is a fresh list, so nothing is highlighted until you arrow into
        // it. Without this, typing one more letter would leave the third row of the old
        // list selected and Enter would pick whatever had moved into that slot.
        row.active = -1;
        g.set(String(input.value || ''));
        paint();
      });
      if (typeof g.suggestions === 'function') {
        // The whole combobox pattern or none of it: `role="combobox"` on its own tells a
        // screen reader there is a list to expect and then never says whether it is open
        // or what is in it, which is worse than an ordinary search field. `aria-expanded`
        // is written on every paint, beside the list's own `hidden`.
        input.setAttribute('role', 'combobox');
        input.setAttribute('aria-expanded', 'false');
        input.setAttribute('aria-controls', `filter-suggest-${g.id}`);
        input.setAttribute('aria-autocomplete', 'list');
        // The browser's own autofill drawer over a dropdown of our own is two lists of
        // suggestions on one field, and only one of them knows what a bead is.
        input.setAttribute('autocomplete', 'off');
        input.addEventListener('keydown', (ev) => onSuggestKey(g, row, ev));
      }
      row.input = input;
      return input;
    }

    /**
     * The whole of a text group: pills, the input, and the list under it.
     *
     * Built once, like the input it wraps and for the same reason — an input replaced
     * mid-word is a word you have to type again, and the pills and the list are its
     * siblings rather than its parents so that replacing either can never take it with
     * them. A plain text group gets neither and is one input in a wrapper, which is what
     * the History tab has always drawn.
     */
    function makeText(g, row) {
      const wrap = document.createElement('div');
      wrap.className = 'filter-typeahead';
      const input = makeInput(g, row);
      if (typeof g.picks === 'function') {
        row.pills = document.createElement('div');
        row.pills.className = 'pill-row';
        row.pills.hidden = true;
        // Above the input: what you have chosen, then the box you choose more in. The
        // other order would put the answer below the question.
        wrap.append(row.pills);
      }
      wrap.append(input);
      if (typeof g.suggestions === 'function') {
        row.list = document.createElement('div');
        row.list.className = 'suggest';
        row.list.id = `filter-suggest-${g.id}`;
        row.list.setAttribute('role', 'listbox');
        row.list.setAttribute('aria-label', g.legend);
        row.list.hidden = true;
        wrap.append(row.list);
      }
      return wrap;
    }

    /** One selection, and the X that takes it back off. */
    function makePill(g, p) {
      const pill = document.createElement('span');
      pill.className = 'pill';
      pill.dataset.pick = p.id;
      if (p.note) pill.title = p.note;
      const label = document.createElement('span');
      label.className = 'pill-label';
      label.textContent = p.label;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'pill-x';
      x.textContent = '×';
      // The glyph is a multiplication sign and reads as nothing at all to a screen
      // reader, so the accessible name has to carry both the verb and which one.
      x.setAttribute('aria-label', `Remove ${p.label}`);
      x.addEventListener('click', () => {
        g.unpick(p.id);
        paint();
      });
      pill.append(label, x);
      return pill;
    }

    /** The pills, rebuilt only when the *set* of them changes — as with the chips. */
    function paintPicks(g, row) {
      if (!row.pills) return;
      const picks = g.picks() || [];
      const ids = picks.map((p) => p.id).join(',');
      row.pills.hidden = picks.length === 0;
      if (row.pickIds === ids) return;
      row.pickIds = ids;
      row.pills.replaceChildren(...picks.map((p) => makePill(g, p)));
    }

    /** One row of the dropdown. A button, so it is reachable and pressable as one. */
    function makeSuggestion(g, row, o) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'suggest-row';
      btn.dataset.suggest = o.id;
      btn.setAttribute('role', 'option');
      btn.setAttribute('aria-selected', 'false');
      const label = document.createElement('span');
      label.className = 'suggest-id';
      label.textContent = o.label;
      btn.append(label);
      if (o.note) {
        const note = document.createElement('span');
        note.className = 'suggest-note';
        note.textContent = o.note;
        btn.append(note);
      }
      // `pointerdown` and not `click`: the document-level close in this file runs on
      // pointerdown, and a tap that took the panel away before this button heard about
      // it would be a suggestion you cannot click on a phone.
      btn.addEventListener('pointerdown', (ev) => {
        ev?.preventDefault?.();
        choose(g, row, o.id);
      });
      btn.addEventListener('click', () => choose(g, row, o.id));
      return btn;
    }

    /**
     * The list under the input.
     *
     * Drawn whenever the box is not empty — there is no open flag here, because the query
     * *is* the state and the page owns it. An empty result with a query in the box draws
     * the group's own `note()` instead, so "nothing matches" and "not read yet" can be
     * different sentences; with no note to draw, the list is simply hidden.
     */
    function paintSuggestions(g, row) {
      if (!row.list) return;
      const asked = String(g.value() || '').trim().length > 0;
      const items = asked ? g.suggestions() || [] : [];
      const note = asked && !items.length ? String((typeof g.note === 'function' && g.note()) || '') : '';
      row.list.hidden = !items.length && !note;
      const ids = `${items.map((o) => o.id).join(',')}|${note}`;
      if (row.suggestIds !== ids) {
        row.suggestIds = ids;
        if (row.active >= items.length) row.active = -1;
        row.items = items.map((o) => makeSuggestion(g, row, o));
        if (note) {
          const line = document.createElement('div');
          line.className = 'suggest-note-line';
          line.textContent = note;
          row.list.replaceChildren(line);
        } else {
          row.list.replaceChildren(...row.items);
        }
      }
      row.input.setAttribute('aria-expanded', String(items.length > 0));
      for (let i = 0; i < row.items.length; i += 1) {
        const on = i === row.active;
        row.items[i].setAttribute('aria-selected', String(on));
        row.items[i].classList.toggle('active', on);
        // Which row the arrow keys are on, said to a screen reader — the caret never
        // leaves the input, so `aria-selected` alone would move nothing it announces.
        if (on) row.items[i].id = row.items[i].id || `${row.list.id}-${i}`;
      }
      const active = row.active >= 0 ? row.items[row.active] : null;
      if (active) row.input.setAttribute('aria-activedescendant', active.id);
      else row.input.removeAttribute?.('aria-activedescendant');
    }

    /**
     * A suggestion taken. Never through `pick()` — a typeahead must not close the panel,
     * because the next thing you may want is a second bead and the box is in here.
     *
     * **By id and not by position.** A repaint can land between the list being drawn and
     * the tap arriving, and an index would then pick whatever had moved into that slot —
     * an id either finds the row you tapped or finds nothing, and nothing is the right
     * answer to a tap on a suggestion that no longer exists.
     */
    function choose(g, row, id) {
      if (!(g.suggestions() || []).some((o) => o.id === id)) return;
      row.active = -1;
      g.pick(id);
      paint();
    }

    /**
     * Arrows and Enter over the list.
     *
     * Enter with nothing highlighted takes the first, because the list is already ordered
     * best-first and somebody who typed a whole id and pressed Enter has said which bead
     * they mean. Escape is deliberately not here: it belongs to the panel, and a key that
     * closed the list on the first press and the panel on the second would be two
     * different controls behind one key.
     */
    function onSuggestKey(g, row, ev) {
      const key = ev?.key;
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter') return;
      const items = g.suggestions() || [];
      if (!items.length || !String(g.value() || '').trim()) return;
      ev?.preventDefault?.();
      if (key === 'Enter') {
        const chosen = items[row.active >= 0 ? row.active : 0];
        if (chosen) choose(g, row, chosen.id);
        return;
      }
      const step = key === 'ArrowDown' ? 1 : -1;
      // -1 is "nothing highlighted" and is a real position: arrowing back up off the top
      // returns the caret to the word you typed rather than wrapping to the bottom.
      row.active = Math.max(-1, Math.min(items.length - 1, (row.active ?? -1) + step));
      paint();
    }

    /**
     * One pill: what it says, whether it is on the row at all, and its chips behind it.
     *
     * Three states, and the middle one is the whole of bc-khoe.26's second acceptance.
     * A group the view can use is a pill. A group it cannot use whose narrowing is
     * still biting is a **note** — the same words, not a button. A group that is neither
     * is off the row entirely, structure and all, so nothing offers a control over a
     * list it does nothing for.
     */
    function paintGroup(g) {
      const row = ui.rows.get(g.id);
      if (!row) return;
      const on = shown(g);
      const value = valueText(g);
      // Said-but-hidden with nothing to confess is not a note: a note that read
      // `PR status` and nothing else would be chrome announcing that a filter exists
      // somewhere else, which is the panel again with fewer words.
      const note = !on && said(g) && Boolean(value);
      // Hidden rather than removed, so nothing rebuilds under the pointer — and so the
      // chips are still there, still painted, for the pill to read when it comes back.
      row.one.hidden = !on && !note;
      row.summary.hidden = !on;
      row.note.hidden = !note;
      row.sel.textContent = value;
      row.sel.hidden = !value;
      row.noteSel.textContent = value;
      // The colon is written into the legend rather than drawn by the stylesheet, so that
      // what the control says is one string a test can read and a person can select —
      // `PR status: unmerged` — rather than two spans and a `::before` between them.
      const legend = value ? `${g.legend}:` : g.legend;
      row.legend.textContent = legend;
      row.noteLegend.textContent = legend;
      row.summary.classList.toggle('on', Boolean(value));
      // No `aria-label` on either: the visible text is already `PR status: unmerged`, and
      // a label repeating it would be a second name for one control that the two could
      // then drift apart on. The uppercase is `text-transform`, which changes what is
      // drawn and not what is read.
      if (!on) {
        // A pill that has gone takes its panel with it — a panel left open under a
        // control that is no longer offered is a filter you can still change and can no
        // longer see.
        if (open === g.id) setOpen('');
        return;
      }
      if (g.text) {
        if (!row.input) row.el.replaceChildren(makeText(g, row));
        const want = String(g.value() || '');
        // Never while it has the caret: the page can rewrite the filter — a Clear, a
        // back button — but a repaint that reset the field mid-word would be a control
        // fighting the person using it.
        //
        // A typeahead is the one place the page *does* rewrite it and mean to: picking a
        // suggestion clears the box, and it does so while the caret is still in there. So
        // the emptying is allowed through — an unconditional write would fight the typing,
        // and refusing this one would leave the word you just turned into a pill sitting
        // in the box underneath it.
        const clearing = typeof g.picks === 'function' && want === '' && row.input.value !== '';
        if (row.input.value !== want && (clearing || document.activeElement !== row.input)) {
          row.input.value = want;
        }
        paintPicks(g, row);
        paintSuggestions(g, row);
        return;
      }
      const options = g.options();
      const ids = options.map((o) => o.id).join(',');
      if (row.ids !== ids) {
        row.ids = ids;
        row.chips = new Map();
        row.el.replaceChildren(...options.map((o) => makeChip(g, o, row)));
        return;
      }
      for (const o of options) {
        const chip = row.chips.get(o.id);
        if (!chip) continue;
        chip.btn.setAttribute('aria-pressed', String(o.on));
        if (chip.count && o.count != null) chip.count.textContent = String(o.count);
        // Dimmed rather than removed when there is nothing of this kind: a chip that
        // came and went as the day did would rebuild the row under the pointer, and
        // "Unclaimed 0" is a fact worth having — it is the answer to the question the
        // chip asks.
        chip.btn.classList.toggle('none', o.count === 0);
      }
    }

    /** Pills and chips, never structure. Safe to call from a render loop. */
    function paint() {
      if (!ui.root) return;
      const live = groupsOf();
      const ids = new Set(live.map((g) => g.id));
      // A group the row no longer has — a sub-filter whose kind this scope cannot hold —
      // is hidden rather than left on screen with the chips it was mounted with. Its pill
      // was built at mount, when every group was still offered.
      for (const [id, row] of ui.rows) {
        if (ids.has(id)) continue;
        row.one.hidden = true;
        if (open === id) setOpen('');
      }
      for (const g of live) paintGroup(g);
      // **A row with nothing on it goes away entirely** (bc-khoe.3). The inbox's groups
      // are a function of the pill that is lit, and `Chats` can use none of them — a chat
      // is under no bead and has no status — so what would be left is a strip of chrome
      // with nothing in it. A note counts as something: a group whose pill is gone while
      // its narrowing is still biting is exactly what a note is for.
      //
      // The History tab's groups declare no `hidden` and no `said`, so `shown` is true
      // for all four and this never fires there.
      const gone = !live.some((g) => !ui.rows.get(g.id)?.one.hidden);
      if (gone) setOpen('');
      ui.root.hidden = gone;
    }

    function pick(g, id) {
      g.pick(id);
      paint();
      // A single-choice group on a touchscreen: the panel is over the list it has just
      // changed, and the next thing you want is to look at it. On a pointer device
      // moving away does that already, and closing here would fight the mouse.
      if (!g.multi && closeOnPick && !hoverable()) setOpen('');
    }

    /**
     * Open one pill's panel, by group id, or `''` for none. Opening one shuts the last.
     *
     * An id the row has no pill for is a close rather than a state nothing can draw: this
     * is reachable from outside — `chrome.setOpen(…)` is on the handle — and an `open`
     * naming nothing would leave the root marked open with every panel shut.
     */
    function setOpen(id) {
      const next = ui.rows.has(id) ? id : '';
      if (!ui.root || open === next) return;
      const was = ui.rows.get(open);
      if (was) {
        was.one.classList.remove('open');
        was.panel.hidden = true;
        was.summary.setAttribute('aria-expanded', 'false');
      }
      open = next;
      pinned = false;
      const now = ui.rows.get(open);
      if (now) {
        now.one.classList.add('open');
        now.panel.hidden = false;
        now.summary.setAttribute('aria-expanded', 'true');
      }
      ui.root.classList.toggle('open', Boolean(open));
    }

    const cancelLeave = () => {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    };

    /*
      The row, and one pill per group in it.

      Every group gets its nodes at mount, whether or not it is offered right now: which
      of them the view can use moves with the lit pill and with the scope, and a row that
      built and destroyed nodes as that changed would rebuild under the pointer on its
      way to a chip. `paint()` hides and unhides; it never makes anything.

      A pill and its note are siblings inside the same wrapper rather than one node that
      changes tag, because they are genuinely different things — one is a button you can
      open and the other is a sentence you cannot — and a control that turned into a
      statement in place would be reachable by Tab on one render and not the next with
      nothing in the DOM to say why.
    */
    const root = document.createElement('div');
    root.className = 'filter-menu';

    for (const g of groupsOf()) {
      const one = document.createElement('div');
      one.className = 'filter-one';
      one.dataset.group = g.id;

      const summary = document.createElement('button');
      summary.type = 'button';
      summary.className = 'filter-summary';
      summary.setAttribute('aria-expanded', 'false');
      summary.setAttribute('aria-controls', `filter-panel-${g.id}`);
      summary.setAttribute('aria-haspopup', 'true');
      const legend = document.createElement('span');
      legend.className = 'filter-legend';
      const sel = document.createElement('span');
      sel.className = 'sel';
      const caret = document.createElement('span');
      caret.className = 'caret';
      caret.setAttribute('aria-hidden', 'true');
      caret.textContent = '▾';
      summary.append(legend, sel, caret);

      // The confession, for a narrowing whose pill the view cannot offer. No caret and
      // no `role`: there is nothing to open, and a caret on a thing that does not open
      // is the worst affordance in the file.
      const note = document.createElement('span');
      note.className = 'filter-note';
      note.hidden = true;
      const noteLegend = document.createElement('span');
      noteLegend.className = 'filter-legend';
      const noteSel = document.createElement('span');
      noteSel.className = 'sel';
      note.append(noteLegend, noteSel);

      const panel = document.createElement('div');
      panel.className = 'filter-panel';
      panel.id = `filter-panel-${g.id}`;
      panel.hidden = true;
      // The `.filter-group` box is still here with one group in it rather than four. It
      // is what carries the chips' own layout — and it keeps the shape a page or a check
      // reaches for by `data-group` the same whichever container is drawing it.
      const box = document.createElement('div');
      box.className = 'filter-group';
      box.dataset.group = g.id;
      const chipRow = document.createElement('div');
      // `scopes`, `kinds` — the plural is what the stylesheet has always keyed the
      // segmented look of the scope switch off.
      chipRow.className = `chip-row ${g.id}s`;
      chipRow.setAttribute('role', 'group');
      chipRow.setAttribute('aria-label', g.legend);
      box.append(chipRow);
      panel.append(box);

      one.append(summary, note, panel);
      root.append(one);

      // `pills`, `list`, `items` and `active` belong to a typeahead and stay null for
      // every other group — `active` is the highlighted suggestion, and it is the one
      // piece of state this file does keep, because which row of a dropdown the arrow
      // keys are on is a fact about the widget rather than about anybody's filter.
      ui.rows.set(g.id, {
        one,
        summary,
        legend,
        sel,
        note,
        noteLegend,
        noteSel,
        panel,
        box,
        el: chipRow,
        ids: '',
        chips: new Map(),
        input: null,
        pills: null,
        pickIds: '',
        list: null,
        items: [],
        suggestIds: '',
        active: -1,
      });

      summary.addEventListener('click', () => {
        if (open !== g.id) {
          setOpen(g.id);
          pinned = true;
        } else if (pinned || !hoverable()) {
          setOpen('');
        } else {
          pinned = true;
        }
      });

      // Hover moves between pills without a click, the way a menu bar does: crossing
      // from `PR status` to `Bead status` on a laptop opens the one you arrived at
      // rather than leaving the one you left open behind you.
      one.addEventListener('pointerenter', (ev) => {
        if (ev?.pointerType === 'touch' || !hoverable()) return;
        cancelLeave();
        setOpen(g.id);
      });
    }

    host.replaceChildren(root);
    host.hidden = false;
    Object.assign(ui, { root });
    paint();

    // The whole row rather than the one pill: moving from a pill to the panel under it
    // crosses the gap between them, and on a wrapped row it crosses the pill beside it
    // as well. Leaving the row is the only exit this control has left.
    root.addEventListener('pointerleave', (ev) => {
      if (ev?.pointerType === 'touch' || !hoverable() || pinned) return;
      cancelLeave();
      // The grace. Cutting the corner of the panel on the way to a chip is a
      // pointerleave, and a control that shut on it would be unusable with a mouse.
      // The 8px bridge above the panel (see .filter-panel::before) is what keeps the
      // gap between the pill and the panel from being one of those exits at all.
      leaveTimer = setTimeout(() => setOpen(''), 160);
    });

    // Tapping anywhere else — the touch half of "leaving closes it". `pointerdown`
    // rather than `click`, so the panel is gone before the tap lands on the card
    // underneath rather than after it.
    document.addEventListener('pointerdown', (ev) => {
      if (open && !root.contains(ev?.target)) setOpen('');
    });
    document.addEventListener('keydown', (ev) => {
      if (ev?.key !== 'Escape' || !open) return;
      // The focus goes back to the pill that was open rather than to the row: Escape out
      // of a panel puts you on the control you opened it with, which is the one you are
      // about to open again or tab past.
      const back = ui.rows.get(open)?.summary;
      setOpen('');
      back?.focus?.();
    });
    // Keyboard: the panel is reachable by Tab, so it has to close when Tab leaves it.
    // On the next tick, because at focusout the activeElement is still the old node.
    root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (open && !pinned && !root.contains(document.activeElement)) setOpen('');
      }, 0);
    });

    return {
      root,
      paint,
      /** Which pill is open, by group id — `''` for none. A string since bc-khoe.26. */
      isOpen: () => open,
      setOpen,
    };
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.filterMenu = { mount };
})();
