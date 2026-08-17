/*
  The filters that are not behind anything — a row of them on the chrome (bc-khoe.24).

  ## What this is for

  `public/filtermenu.js` is one collapsed line that opens into every group at once. It
  was the right shape when the inbox had three permanent rows of chips and the argument
  was that they cost more screen than they were worth. It is the wrong shape for a
  control that decides what the page can contain at all: the scope — Human, Both, Agent
  — picks which sweep runs, so it decides whether Home holds the questions, the live
  beads, or both, and it spent its life as the `Show` group inside a panel you have to
  reach for. A control nobody can see is a control nobody remembers is set, and this one
  is the reason a screen is empty often enough that the epic is about it.

  So this file is the other half of that pair: **groups drawn flat, on the chrome, in
  the row under the view pills**. Nothing here opens or closes. Whatever is armed is
  armed in view.

  ## The same group descriptor, deliberately

  A group here is exactly what filtermenu.js takes —
  `{ id, legend, all?, multi?, options(), pick(id), hidden?() }` — and that is the whole
  design. bc-khoe.26 takes the bead search and the two status sub-filters out of the
  panel and puts them on this row; if a group had to be rewritten to move, the move would
  be a rewrite of the page rather than a change of container, and the two containers
  would drift into meaning different things by `on` and `all`. A page hands the same
  object to whichever of the two it wants, and moves it between them by editing the list
  it is in.

  What this file does *not* support is the two shapes that only make sense inside a
  panel: `text` groups (the bead typeahead, which needs a dropdown under it) and `said`
  (which is about a summary line, and there is no summary line here — the chips are the
  summary). bc-khoe.26 is where the typeahead's own shape is decided; a half-drawn text
  box on the chrome today would be a control that looks finished and is not, so a group
  carrying `text` is skipped and says so rather than being drawn wrong.

  ## Why a segmented switch and not a pill that opens three chips

  The scope has three options and exactly one of them is always armed, which is the
  definition of a segmented control — and the acceptance this was built to is that the
  armed one is legible *without opening anything*. A pill saying `Human ▾` would be
  legible too, and it would cost a second tap to change and would re-introduce the thing
  being removed: a set of choices you have to open to see. Three words fit across a
  phone. Five would not, which is why bc-khoe.26 gets to decide the other shape, for the
  groups that have five.

  The look is `.chip-row.scopes` in public/style.css, which is where it already was: this
  bead moves the switch out of the panel, it does not redraw it. Somebody who used the
  old one finds the same control in front of the panel instead of inside it.

  ## Painting

  `paint()` touches text and attributes only, never structure, and rebuilds a group's
  chips only when the *set* of option ids changes. The inbox repaints every 25 seconds:
  a row rebuilt on that clock would drop the focus ring off a chip somebody is tabbing
  through, and swap a chip out from under a pointer on the way to it. Same discipline as
  filtermenu.js, and for the same reason.
*/
(() => {
  'use strict';

  /** Every mounted row, so `paint()` is one call for the page rather than one per row. */
  const rows = [];

  const shown = (g) => (typeof g.hidden === 'function' ? !g.hidden() : true);

  /**
   * One chip. The third column of a group's option table rides along as the title and
   * the accessible name, exactly as it does in the panel: one-word chips are not
   * self-explanatory and there is no prose out here to put it in.
   */
  function makeChip(group, o, cell, doc) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'chip';
    btn.dataset.chip = o.id;
    btn.setAttribute('aria-pressed', String(o.on));
    btn.title = o.note || o.label;
    btn.setAttribute('aria-label', o.note ? `${o.label} — ${o.note}` : o.label);
    const label = doc.createElement('span');
    label.className = 'chip-label';
    label.textContent = o.label;
    btn.append(label);
    btn.addEventListener('click', () => {
      group.pick(o.id);
      // The group's own `pick` is what refetches, and it may repaint this row itself on
      // the way through. Painting again after it costs nothing — nothing is rebuilt
      // unless the option ids moved — and it is what keeps the armed chip right for a
      // group whose `pick` does not call back.
      paint();
    });
    cell.chips.set(o.id, btn);
    return btn;
  }

  /** A group's chips, in the state its `options()` says they are in right now. */
  function paintGroup(cell, doc) {
    const g = cell.group;
    cell.el.hidden = !shown(g);
    if (cell.el.hidden) return;
    const options = g.options();
    const ids = options.map((o) => o.id).join(',');
    if (cell.ids !== ids) {
      cell.ids = ids;
      cell.chips = new Map();
      cell.el.replaceChildren(...options.map((o) => makeChip(g, o, cell, doc)));
      return;
    }
    for (const o of options) cell.chips.get(o.id)?.setAttribute('aria-pressed', String(o.on));
  }

  /** Every row on the page, repainted. Safe from a render loop — see the header. */
  function paint() {
    for (const row of rows) for (const cell of row.cells) paintGroup(cell, row.doc);
  }

  /**
   * Draw these groups into `host`, flat.
   *
   * **Prepended, not replacing.** On Home this host is `#filters`, which
   * public/filtermenu.js also mounts into — with `replaceChildren` — so the pills go in
   * after it and go to the head of the row, which is where the coarsest control belongs:
   * the scope decides what the panel behind it is even filtering. public/app.js is what
   * mounts the two in that order, and its `renderFilters` is what unhides the row once
   * either of them has put something in it.
   *
   * A group is a `role="group"` carrying its `legend` as the accessible name rather than
   * a visible one. The legend was a line of its own inside the panel, where there was
   * room; out here it would be a word of chrome per control, on the one row of it this
   * epic is trying not to spend twice — and the chips are what it would be labelling.
   */
  function mount(host, opts = {}) {
    if (!host) return null;
    const doc = host.ownerDocument || document;
    const groups = (Array.isArray(opts.groups) ? opts.groups : []).filter((g) => {
      if (!g || typeof g.options !== 'function' || typeof g.pick !== 'function') return false;
      if (g.text) {
        // Loud rather than silent: a text group handed to this row is a filter the page
        // believes it has drawn and has not. See the header.
        console.warn(`[filterpills] ${g.id} is a text group — this row draws chips only`);
        return false;
      }
      return true;
    });
    if (!groups.length) return null;
    const root = doc.createElement('div');
    root.className = 'filterpills';
    const cells = groups.map((g) => {
      const el = doc.createElement('div');
      // `chip-row` for the flex row it already is everywhere else, plus the group's own
      // plural, which is the class the stylesheet has always keyed the scope's segmented
      // banding off (`.chip-row.scopes`).
      el.className = `chip-row ${g.id}s`;
      el.dataset.group = g.id;
      el.setAttribute('role', 'group');
      el.setAttribute('aria-label', g.legend || g.id);
      root.append(el);
      return { group: g, el, ids: '', chips: new Map() };
    });
    host.prepend(root);
    host.hidden = false;
    rows.push({ doc, root, cells });
    paint();
    return root;
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.filterPills = {
    mount,
    /** Re-read every group and move the armed chips. Never rebuilds unless the ids moved. */
    paint,
    /** Which chip is armed in a group, for anything that has to agree with the row. */
    armed: (id) => {
      for (const row of rows) {
        for (const cell of row.cells) {
          if (cell.group.id !== id) continue;
          return cell.group.options().find((o) => o.on)?.id || '';
        }
      }
      return '';
    },
  };
})();
