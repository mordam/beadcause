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
    summary line to read.
  - **`said()`** is whether the summary line mentions it, and it is deliberately *wider*
    than `hidden()`. A narrowing that is still applied while its chips are off screen is
    the one thing a filter control must never do quietly.

  A **text group** is the same shape with `text: true` and `value()` / `set(v)` instead
  of `options()` / `pick()`. It draws one input rather than a row of chips — the ledger's
  id substring is not a set of chips, and a second control somewhere else on the page
  would be the two-rows-of-chrome problem all over again.

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
          if (g.text) return String(g.value() || '') || g.all || 'Any';
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
        g.set(String(input.value || ''));
        paint();
      });
      row.input = input;
      return input;
    }

    /** A group's chips: their pressed state and their counts, in place where it can be. */
    function paintGroup(g) {
      const row = ui.rows.get(g.id);
      if (!row) return;
      // Hidden rather than removed, so the panel does not rebuild — and so the chips are
      // still there, still painted, for the summary line to read.
      if (row.box) row.box.hidden = !shown(g);
      if (g.text) {
        if (!row.input) row.el.replaceChildren(makeInput(g, row));
        const want = String(g.value() || '');
        // Never while it has the caret: the page can rewrite the filter — a Clear, a
        // back button — but a repaint that reset the field mid-word would be a control
        // fighting the person using it.
        if (row.input.value !== want && document.activeElement !== row.input) row.input.value = want;
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
      ui.rows.set(g.id, { el: row, box, ids: '', chips: new Map(), input: null });
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
