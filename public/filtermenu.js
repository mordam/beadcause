/*
  The collapsing filter control, and only the control.

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

  So this file is the chrome — the summary line, the panel, the chips, and the state
  machine that opens and closes it — and it knows nothing at all about what any of it
  means. What a chip *is* stays with the page: public/inboxfilter.js owns the kinds of
  thing the inbox carries, public/history.js owns the four filters over the ledger, and
  both hand this file the same shape.

  ## The shape

  A **group** is one row of chips with a legend over it:

      { id, legend, all?, multi?, options(), pick(id), hidden?(), said?() }

  `options()` is called on every paint and returns `{ id, label, note?, count?, on }`.
  That is the whole contract: the group is asked what it looks like right now, so a page
  changes the chips by changing its own state and calling `paint()` — there is no setter
  here and no state about the page's filters in this file.

  - **`all`** is what the summary line says when nothing in the group is selected. Not
    always "All": the inbox's PR status group says `unmerged`, because with nothing
    chosen it is showing you one rung rather than everything, and a control claiming to
    show you everything while showing you one rung is the failure this whole thing exists
    to avoid.
  - **`multi`** is whether picking closes the panel on a touchscreen. A single-choice
    group has answered its question with one tap, and the next thing you want is to look
    at the list it has just changed — which is underneath the panel.
  - **`hidden()`** is whether the group's chips are on screen at all. The inbox's PR
    status group is offered only while `PRs` is selected. Hidden rather than removed, so
    the panel does not rebuild under the pointer and the chips are still there for the
    summary line to read. **When every group is hidden and none is `said()`, the whole
    control hides** — the inbox's `Chats` pill can use none of them, and a summary line
    that opens an empty box is worse chrome than no line.
  - **`said()`** is whether the summary line mentions it, and it is deliberately *wider*
    than `hidden()`. A narrowing that is still applied while its chips are off screen is
    the one thing a filter control must never do quietly.

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

  **A typeahead's summary line says its picks, never its query.** The two are not the same
  claim: a half-typed word narrows nothing until you click something, and a summary line
  that showed it would be the control announcing a filter that is not applied — the same
  failure as `said()` hiding one that is, in the other direction.

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
   * called on every paint, and the boxes are built from whatever it says at mount.
   *
   * `narrowed` is the page's own answer to "is this list showing less than everything",
   * and it stays the page's because only the page knows. A group with a selection in it
   * is not the test: the inbox's scope switch always has exactly one chip pressed and
   * `Both` is not a narrowing.
   */
  function mount(host, opts = {}) {
    if (!host) return null;

    const groupsOf = typeof opts.groups === 'function' ? opts.groups : () => opts.groups || [];
    const closeOnPick = opts.closeOnPick !== false;
    const narrowed = typeof opts.narrowed === 'function' ? opts.narrowed : () => false;

    let open = false;
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
    const ui = { root: null, summary: null, sel: null, panel: null, rows: new Map() };

    /** Is this group's own row of chips (or its input) on screen? */
    const shown = (g) => (typeof g.hidden === 'function' ? !g.hidden() : true);

    /** Does the summary line mention it? Wider than `shown` — see the header. */
    const said = (g) => (typeof g.said === 'function' ? g.said() : shown(g));

    /**
     * What the one line says.
     *
     * Every group contributes: the selected label where there is one, the group's own
     * word for "everything" where there is not. Two selections are named, three or more
     * are counted — `Merges, Proposals` is worth reading and `Questions, Merges,
     * Proposals, Blocked` is a line that no longer fits on a phone.
     */
    function summaryText() {
      return groupsOf()
        .filter(said)
        .map((g) => {
          if (g.text) {
            // A typeahead says what has been picked. Its query is not a narrowing — see
            // the header — so a group with `picks` never falls through to `value()`.
            if (typeof g.picks === 'function') {
              const picks = g.picks();
              if (!picks.length) return g.all || 'Any';
              if (picks.length <= 2) return picks.map((p) => p.label).join(', ');
              return `${picks.length} ${g.legend.toLowerCase()}`;
            }
            return String(g.value() || '') || g.all || 'Any';
          }
          const on = g.options().filter((o) => o.on);
          if (!on.length) return g.all || 'All';
          if (on.length <= 2) return on.map((o) => o.label).join(', ');
          return `${on.length} ${g.legend.toLowerCase()}`;
        })
        .join(' · ');
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

    /** A group's chips: their pressed state and their counts, in place where it can be. */
    function paintGroup(g) {
      const row = ui.rows.get(g.id);
      if (!row) return;
      // Hidden rather than removed, so the panel does not rebuild — and so the chips are
      // still there, still painted, for the summary line to read.
      if (row.box) row.box.hidden = !shown(g);
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

    /** Chips and summary, never structure. Safe to call from a render loop. */
    function paint() {
      if (!ui.root) return;
      const live = groupsOf();
      const ids = new Set(live.map((g) => g.id));
      // A group the panel no longer has — a sub-filter whose kind this scope cannot hold —
      // is hidden rather than left on screen with the chips it was mounted with. Its box was
      // built at mount, when every group was still offered.
      for (const [id, row] of ui.rows) if (row.box && !ids.has(id)) row.box.hidden = true;
      for (const g of live) paintGroup(g);
      ui.sel.textContent = summaryText();
      ui.root.classList.toggle('narrowed', Boolean(narrowed()));
      // **A control with nothing in it goes away entirely** (bc-khoe.3). The inbox's
      // groups are a function of the pill that is lit, and `Chats` can use none of them
      // — a chat is under no bead and has no status — so what would be left is a
      // summary line that opens an empty box. Whichever of the two is true is enough to
      // keep it: a group whose chips are off screen while its narrowing is still biting
      // is exactly what the line is for.
      //
      // The History tab's groups declare no `hidden` and no `said`, so `shown` is true
      // for all four and this never fires there.
      const gone = !live.some(shown) && !live.some(said);
      if (gone) setOpen(false);
      ui.root.hidden = gone;
    }

    function pick(g, id) {
      g.pick(id);
      paint();
      // A single-choice group on a touchscreen: the panel is over the list it has just
      // changed, and the next thing you want is to look at it. On a pointer device
      // moving away does that already, and closing here would fight the mouse.
      if (!g.multi && closeOnPick && !hoverable()) setOpen(false);
    }

    function setOpen(next) {
      if (!ui.root || open === next) return;
      open = next;
      if (!open) pinned = false;
      ui.root.classList.toggle('open', open);
      ui.panel.hidden = !open;
      ui.summary.setAttribute('aria-expanded', String(open));
    }

    const cancelLeave = () => {
      clearTimeout(leaveTimer);
      leaveTimer = null;
    };

    const root = document.createElement('div');
    root.className = 'filter-menu';

    const summary = document.createElement('button');
    summary.type = 'button';
    summary.className = 'filter-summary';
    summary.setAttribute('aria-expanded', 'false');
    summary.setAttribute('aria-controls', 'filter-panel');
    summary.setAttribute('aria-haspopup', 'true');
    const sel = document.createElement('span');
    sel.className = 'sel';
    const caret = document.createElement('span');
    caret.className = 'caret';
    caret.setAttribute('aria-hidden', 'true');
    caret.textContent = '▾';
    summary.append(sel, caret);

    const panel = document.createElement('div');
    panel.className = 'filter-panel';
    panel.id = 'filter-panel';
    panel.hidden = true;

    for (const g of groupsOf()) {
      const box = document.createElement('div');
      box.className = 'filter-group';
      box.dataset.group = g.id;
      const legend = document.createElement('span');
      legend.className = 'filter-legend';
      legend.textContent = g.legend;
      const row = document.createElement('div');
      // `scopes`, `kinds` — the plural is what the stylesheet has always keyed the
      // segmented look of the scope switch off.
      row.className = `chip-row ${g.id}s`;
      row.setAttribute('role', 'group');
      row.setAttribute('aria-label', g.legend);
      box.append(legend, row);
      panel.append(box);
      // The box as well as the chip row: a group is hidden legend and all, and paint()
      // needs the node to hide.
      // `pills`, `list`, `items` and `active` belong to a typeahead and stay null for
      // every other group — `active` is the highlighted suggestion, and it is the one
      // piece of state this file does keep, because which row of a dropdown the arrow
      // keys are on is a fact about the widget rather than about anybody's filter.
      ui.rows.set(g.id, {
        el: row,
        box,
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
    }

    root.append(summary, panel);
    host.replaceChildren(root);
    host.hidden = false;
    Object.assign(ui, { root, summary, sel, panel });
    paint();

    summary.addEventListener('click', () => {
      if (!open) {
        setOpen(true);
        pinned = true;
      } else if (pinned || !hoverable()) {
        setOpen(false);
      } else {
        pinned = true;
      }
    });

    root.addEventListener('pointerenter', (ev) => {
      if (ev?.pointerType === 'touch' || !hoverable()) return;
      cancelLeave();
      setOpen(true);
    });
    root.addEventListener('pointerleave', (ev) => {
      if (ev?.pointerType === 'touch' || !hoverable() || pinned) return;
      cancelLeave();
      // The grace. Cutting the corner of the panel on the way to a chip is a
      // pointerleave, and a control that shut on it would be unusable with a mouse.
      // The 8px bridge above the panel (see .filter-panel::before) is what keeps the
      // gap between the line and the panel from being one of those exits at all.
      leaveTimer = setTimeout(() => setOpen(false), 160);
    });

    // Tapping anywhere else — the touch half of "leaving closes it". `pointerdown`
    // rather than `click`, so the panel is gone before the tap lands on the card
    // underneath rather than after it.
    document.addEventListener('pointerdown', (ev) => {
      if (open && !root.contains(ev?.target)) setOpen(false);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev?.key === 'Escape' && open) {
        setOpen(false);
        summary.focus();
      }
    });
    // Keyboard: the panel is reachable by Tab, so it has to close when Tab leaves it.
    // On the next tick, because at focusout the activeElement is still the old node.
    root.addEventListener('focusout', () => {
      setTimeout(() => {
        if (open && !pinned && !root.contains(document.activeElement)) setOpen(false);
      }, 0);
    });

    return {
      root,
      paint,
      isOpen: () => open,
      setOpen,
    };
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.filterMenu = { mount };
})();
