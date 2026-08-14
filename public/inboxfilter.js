/*
  The inbox's own filter — one line at rest, the whole set when you reach for it.

  ## What was wrong with three rows of chips

  `#filters` used to be three permanent rows: which slice of the tracker, then which
  space, then which workspace. The bottom two are the space picker in the top bar now
  (public/spacebar.js), which left one row — and the moment the inbox needs a filter
  per *kind* of incoming thing, the row is two rows again and we are back where we
  started. A phone screen is about fifteen rows tall. Spending two of them, always, on
  an answer that changes twice a week is two questions you cannot see.

  So the control collapses. At rest it is a single line saying what is selected —
  `Human · All kinds` — and it opens on hover with a pointer, on a tap without one.
  The panel is *absolutely positioned*, so opening it draws over the list rather than
  pushing it down: the cards under the pointer do not move as you reach for the chips,
  and `paintScrollPos` (which measures `#filters` to decide which card you are reading)
  measures the same one line whether the panel is open or shut.

  ## The panel is not in this file any more

  It was, and every word above still describes it — the collapsing, the hover, the tap
  that pins it, the grace period on a diagonal exit. All of that moved to
  public/filtermenu.js when the History tab needed the same control over a different
  vocabulary, and the argument for the split is in that file's header. What is left here
  is the inbox's half: which *kinds* of thing the inbox carries, which of them the
  current scope can produce, how many of each are in view, and what survives the filter.

  The seam is `mount()` at the foot: this file hands filtermenu.js a list of groups and
  is asked, on every paint, what each one looks like right now. Nothing about the inbox
  crosses it — `Merges`, `unmerged`, `agent-filed` are words filtermenu.js has never
  heard — and nothing about the panel is decided here.

  ## The kinds

  The inbox is not one list. An advocate asking to create beads, a worker asking you
  to merge a pull request, a plain question, and — under `Both` and `Agent` — the live
  beads nobody is asking you about at all, are four different jobs that happen to
  arrive at the same address. `KINDS` is the table that names them, and it is
  deliberately the only place that knows: bc-l8jp.5 (chat sessions in the inbox) and
  bc-l8jp.6 (pull requests as cards) each add one row to it and get a filter, a chip,
  a count and a place in the summary line for free. Both of them have landed — `pr` and
  `session` below — and between them they cost two rows plus two words, `!q.pr` and
  `!q.session`, in the predicate they would otherwise have fallen into. That is the
  table paying for itself: two features that each removed a tab, and neither of them
  had to touch the chips, the counts or the summary line to get a category of its own.

  `jira` is the third to take that deal (bc-0i27.3), and the first that was never a tab:
  the tickets assigned to you arrive off JIRA rather than off a `bd` sweep, and one row
  here is the whole of what makes them a section — a chip, a count, a word in the summary
  line, and the space picker and the P0 board narrowing them exactly as they narrow
  everything else. Its price was the same one word, `!q.jira`, in the predicate below.

  Each kind carries a `side`, because a scope that never fetched a row cannot show a
  chip for it: `human` sweeps questions, `agent` sweeps live beads, `both` does both,
  and a chip for something the current scope cannot contain is a control that does
  nothing. `usable()` is what applies that, and `set()` drops selections the new scope
  cannot produce — otherwise switching to `Agent` with `Merges` selected is an empty
  screen with nothing on it to say why. `any` is the third value and it means what it
  says: a pull request comes off `gh`, a chat session off no sweep at all, and a JIRA
  ticket off JIRA, so for none of the three is there a scope that could have failed to
  fetch it, and none of them has a scope in which its chip would be dead.

  ## The one sub-filter

  A kind may carry a `sub`: a second group of chips that appears in the panel *only when
  that kind is selected*, and narrows within it. Pull requests have the only one, and it
  is the reason the mechanism exists — five of them are open right now and thirty have
  merged in the last three weeks, so a PR chip with no second axis would be a list of
  history with this morning's decisions somewhere inside it.

  Two rules make it safe:

  - **Its default is not "everything".** With no status chosen the inbox shows only what
    has *not merged* — `review`. A merged pull request is history, and history should be
    asked for. Which is a filter you did not set, so the summary line says `unmerged`
    where the other groups say `All`, and there is no state in which the control claims
    to be showing you everything while showing you one rung.
  - **It applies whether or not its parent chip is pressed.** The default above is about
    what the inbox *is*, not about what you last tapped, so it holds under `All kinds`
    too. The panel only stops offering you the choice.

  ## What this does *not* touch

  **A kind filter does not change what rings your phone.** The space picker's does —
  it is stored on the server and the push path reads it (see `quietReasonFor`) — and
  this deliberately is not: it lives in localStorage, on this device, because "I am
  reading merges this hour" is not "do not tell me about questions". The accepted
  consequence is that a hidden kind can still notify you, and the summary line saying
  `Human · Merges` is the standing reminder that the list is narrowed.
*/
(() => {
  'use strict';

  const KEY = 'beadcause.kinds';
  /** The PR status sub-filter, kept apart so widening the kinds does not reset it. */
  const SUB_KEY = 'beadcause.prstatus';

  /**
   * The kinds of thing the inbox carries, in the order their chips are drawn.
   *
   * `test` is exhaustive and mutually exclusive by construction — every row the list
   * can hold answers to exactly one of these — so `kindOf` never returns null for a
   * row the app drew, and a new kind added here cannot silently steal rows from an
   * old one. `side` is which scope fetches it; see `usable`.
   */
  const KINDS = [
    {
      id: 'question',
      side: 'question',
      label: 'Questions',
      note: 'Beads asking you something in words — the app’s original inbox.',
      // `!q.pr`, `!q.session` and `!q.jira` for the same reason `!q.proposal` is spelled
      // out under Merges: none of a pull request, a chat session or a JIRA ticket is a
      // bead, and none of them answers any of the other tests, so without these three
      // they would land here — the one kind whose predicate is "none of the above" and
      // therefore the one that silently absorbs anything new. Nothing else in the
      // codebase would catch a ticket drawn as a question — it looks exactly like an
      // inbox with more questions in it — so `!q.jira` here is the whole of the guard,
      // and test/jirarow.mjs reads this line rather than the comment above it.
      test: (q) => !q.agent && !q.proposal && !q.delivery && !q.pr && !q.session && !q.jira,
    },
    {
      id: 'proposal',
      side: 'question',
      label: 'Proposals',
      note: 'An advocate asking to create beads. Approve or decline them one at a time.',
      test: (q) => !q.agent && Boolean(q.proposal),
    },
    {
      id: 'delivery',
      side: 'question',
      label: 'Merges',
      note: 'A worker’s finished branch, waiting on a merge or a request for changes.',
      // `!q.proposal` is not defensive padding: nothing writes a bead that is both, but
      // if anything ever did, two chips claiming it would double it in the counts and
      // show it under a filter that is not about it. Exclusivity is the property the
      // table is asserted on (test/inboxkinds.mjs), so it is stated here rather than
      // left to the order of the rows.
      test: (q) => !q.agent && !q.proposal && Boolean(q.delivery),
    },
    {
      id: 'pr',
      // On neither side: a pull request comes off `gh`, not off a `bd` sweep, so no
      // scope fetches it and no scope can fail to. It is here under `Human` because a
      // pull request in review is a thing waiting on you, and under `Agent` because it
      // is not a bead the sweep could have missed.
      side: 'any',
      label: 'PRs',
      note: 'Pull requests, and how far each one got. Unmerged unless you ask for more.',
      test: (q) => Boolean(q.pr),
      // The status sub-filter. `options` are read through public/prcard.js, which mirrors
      // the ladder in lib/prstage.js, so the chips cannot name a rung the daemon does not
      // put on a row. `closed` is deliberately not among them: a pull request closed
      // without merging is not on the way anywhere, so app.js does not make a card for
      // one at all, and a chip that could only ever show nothing is worse than no chip.
      sub: {
        id: 'status',
        legend: 'PR status',
        multi: true,
        /** What no selection means, in the summary line. Not "All" — see the header. */
        all: 'unmerged',
        /** And what it means to `matches()`: the first rung, the only unmerged one. */
        fallback: ['review'],
        options: () =>
          (window.beadcause?.prCard?.STAGES || [])
            .filter((s) => s.id !== 'closed')
            .map((s) => ({ id: s.id, label: s.label, note: s.note })),
        of: (q) => q?.pr?.stage || '',
      },
    },
    {
      id: 'session',
      // The second kind on neither side, and between them the reason `side` has a third
      // value at all: a chat session is not in the tracker, so no scope fetches it and
      // no scope can fail to. It is here under `Human` because it is a thing waiting on
      // you, and under `Agent` because it is not a bead the sweep could have missed —
      // it is simply always true, which is what `any` says. Next to `pr` because the two
      // are the same shape of row: something outside `bd` that the inbox nonetheless
      // holds, and the pair of them are what emptied two tabs off the bar.
      side: 'any',
      label: 'Chats',
      note: 'Conversations you have open about what to file next. Tap one to pick it up.',
      test: (q) => Boolean(q.session),
    },
    {
      id: 'jira',
      // The third on neither side, and the clearest case for the value: a JIRA ticket
      // comes off JIRA, so there is no `bd` scope that could have failed to fetch one
      // and therefore no scope in which this chip would be dead. Under `Human` because
      // an assigned ticket is a thing waiting on you; under `Agent` because it is not a
      // bead the sweep could have missed — it is not a bead at all yet, which is the
      // whole of what bc-0i27.4 exists to change.
      side: 'any',
      label: 'JIRA',
      note: 'Tickets assigned to you in JIRA, before anything here has made them work.',
      test: (q) => Boolean(q.jira),
    },
    {
      id: 'claimed',
      side: 'agent',
      label: 'Claimed',
      note: 'Work an agent has in hand right now. Nothing here is asking you anything.',
      test: (q) => Boolean(q.agent) && q.status === 'in_progress',
    },
    {
      id: 'blocked',
      side: 'agent',
      label: 'Blocked',
      note: 'Live beads waiting on something else — the work that is stuck.',
      test: (q) => Boolean(q.agent) && q.status === 'blocked',
    },
    {
      id: 'unclaimed',
      side: 'agent',
      label: 'Unclaimed',
      note: 'Open beads nobody has picked up.',
      test: (q) => Boolean(q.agent) && q.status !== 'in_progress' && q.status !== 'blocked',
    },
  ];

  const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

  /** Which kind a row is. Never null for a row the inbox drew — see KINDS. */
  const kindOf = (q) => KINDS.find((k) => k.test(q))?.id || null;

  const state = {
    /** Selected kind ids. **Empty means all** — never "none", which would be a list
     *  that is empty for a reason nothing on screen explains. */
    on: new Set(),
    /**
     * Sub-filter selections: kind id → Set of option ids.
     *
     * Empty means *that kind's own default*, which is not the same thing as "all" — the
     * PR status group's default is `unmerged`. See the header.
     */
    sub: new Map(),
    /** Which kinds the current scope can actually contain, newest survey wins. */
    usable: KINDS.map((k) => k.id),
    /** kind id → how many rows of it are in view, before this filter is applied. */
    counts: {},
    /** sub group id → option id → the same, one level down. */
    subCounts: {},
  };

  /* ------------------------------------------------------------- the sub-filters */

  const subOf = (kindId) => BY_ID.get(kindId)?.sub || null;
  const chosenSub = (kindId) => state.sub.get(kindId) || new Set();
  const subOptionIds = (sub) => sub.options().map((o) => o.id);

  /** Is any sub-filter away from its default? Part of "this list is narrowed". */
  const subNarrowed = () => KINDS.some((k) => k.sub && chosenSub(k.id).size > 0);

  /**
   * Does this row survive its own kind's sub-filter? True for a kind that has none.
   *
   * The fallback is the point: with nothing chosen a pull request has to be on the
   * `review` rung to be in the list, because a merged one is history. Every other kind
   * has no `sub` and answers true here without a decision being made about it.
   */
  function inSub(q) {
    const sub = subOf(kindOf(q));
    if (!sub) return true;
    const chosen = chosenSub(subKindOf(sub));
    const value = sub.of(q);
    return chosen.size ? chosen.has(value) : (sub.fallback || []).includes(value);
  }

  /** Which kind owns this sub descriptor. One each, and the table is small. */
  const subKindOf = (sub) => KINDS.find((k) => k.sub === sub)?.id || '';

  const listeners = [];

  function notify() {
    for (const fn of listeners) {
      try {
        fn([...state.on]);
      } catch {
        /* one page's repaint must not stop the next listener, or the control */
      }
    }
  }

  const load = () => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) || '[]');
      return Array.isArray(raw) ? raw.filter((id) => BY_ID.has(id)) : [];
    } catch {
      return [];
    }
  };

  const save = () => {
    try {
      localStorage.setItem(KEY, JSON.stringify([...state.on]));
    } catch {
      /* private mode: the filter still works, it just does not survive a reload */
    }
  };

  /**
   * The sub-filters off disk, as `{ <kind id>: [option ids] }`.
   *
   * An id the table does not offer is dropped, exactly as a kind is — and the options
   * come from public/prcard.js, so a phone that has that file cached and this one fresh
   * reads as "nothing chosen", which is the default rather than an empty screen.
   */
  const loadSub = () => {
    const out = new Map();
    let raw = {};
    try {
      const parsed = JSON.parse(localStorage.getItem(SUB_KEY) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed;
    } catch {
      /* unreadable is "nothing chosen", never "hide everything" */
    }
    for (const k of KINDS) {
      if (!k.sub) continue;
      const offered = subOptionIds(k.sub);
      const ids = Array.isArray(raw[k.id]) ? raw[k.id].filter((id) => offered.includes(id)) : [];
      out.set(k.id, new Set(ids));
    }
    return out;
  };

  const saveSub = () => {
    try {
      const out = {};
      for (const [kind, set] of state.sub) out[kind] = [...set];
      localStorage.setItem(SUB_KEY, JSON.stringify(out));
    } catch {
      /* as above */
    }
  };

  /**
   * Is this row in view?
   *
   * The kind filter is true while nothing is selected, which is the common case and the
   * default — a page that asks before the control has mounted shows everything rather
   * than nothing. The sub-filter is *not* the same: it applies whichever kinds are
   * selected, because "only unmerged pull requests" is what the inbox is rather than
   * something you last tapped.
   */
  const matches = (q) => (state.on.size === 0 || state.on.has(kindOf(q))) && inSub(q);

  /**
   * Narrow to these kinds. Unknown ids are dropped, and so are kinds the current scope
   * cannot produce: `Agent` with `Merges` held over from `Human` is an empty list whose
   * cause is off screen, and the only thing worse than a filter you cannot see is one
   * you cannot see selecting something that does not exist here.
   */
  function set(ids, { quiet = false } = {}) {
    const next = new Set(
      (ids || []).filter((id) => BY_ID.has(id) && state.usable.includes(id))
    );
    const same = next.size === state.on.size && [...next].every((id) => state.on.has(id));
    state.on = next;
    save();
    paint();
    if (!same && !quiet) notify();
    return same;
  }

  const toggle = (id) => set(state.on.has(id) ? [...state.on].filter((x) => x !== id) : [...state.on, id]);

  /**
   * Narrow one kind's sub-filter. Empty is the kind's own default, not "everything".
   *
   * Notifies like `set` does — a status change moves the list, and the page has to hear
   * about it from the same channel or the chips and the cards drift apart for 25 seconds.
   */
  function setSub(kindId, ids, { quiet = false } = {}) {
    const sub = subOf(kindId);
    if (!sub) return true;
    const offered = subOptionIds(sub);
    const next = new Set((ids || []).filter((id) => offered.includes(id)));
    const before = chosenSub(kindId);
    const same = next.size === before.size && [...next].every((id) => before.has(id));
    state.sub.set(kindId, next);
    saveSub();
    paint();
    if (!same && !quiet) notify();
    return same;
  }

  const toggleSub = (kindId, id) => {
    const on = chosenSub(kindId);
    setSub(kindId, on.has(id) ? [...on].filter((x) => x !== id) : [...on, id]);
  };

  /**
   * What the page has just drawn: which kinds are reachable, and how many of each.
   *
   * Counted *before* this filter and *after* the space picker's, so a chip's number is
   * what picking it would leave you with — which is the only number a filter chip can
   * carry without lying about what it does. Which is also why `counts` for a kind with a
   * sub-filter is counted *through* it (see `inSub` and app.js's `surveyKinds`): picking
   * `PRs` leaves you with the unmerged ones, so `PRs 2` over thirty merged pull requests
   * would be the chip promising a screen it does not open.
   *
   * `sub` is the level below — `{ status: { review: 2, merged: 30, … } }` — and those are
   * counted the other way round, over every PR row the space picker allowed, because
   * *that* is what picking one of those chips would leave you with.
   */
  function survey({ kinds, counts, sub } = {}) {
    if (sub && typeof sub === 'object') state.subCounts = sub;
    if (Array.isArray(kinds)) {
      state.usable = KINDS.filter((k) => kinds.includes(k.id)).map((k) => k.id);
      // A selection the new scope cannot produce is dropped rather than kept and
      // ignored — see set(). Quiet, because the caller is mid-render and about to
      // paint anyway; a notify() here would re-enter it.
      if ([...state.on].some((id) => !state.usable.includes(id))) set([...state.on], { quiet: true });
    }
    if (counts && typeof counts === 'object') state.counts = counts;
    paint();
  }
  /* ---------------------------------------------------------------- the groups */

  /*
    Everything below is the inbox's half of the control: what a chip *means*. The panel
    itself — the summary line, the open-and-close state machine, the chips as nodes —
    is public/filtermenu.js, shared with the History tab's own filter bar. It was here
    until there were two lists to narrow; the argument for splitting it is in that
    file's header, and the short version is that two copies of this panel would not have
    looked like two, they would have looked like one panel that behaves differently on
    two screens.
  */

  /** Extra chip groups the page puts in the same panel, above the kinds. */
  let pageGroups = [];

  /** The chrome, once mounted. `null` until then — see `paint`. */
  let chrome = null;

  /** The kinds group, built here so the page never has to know the table. */
  const kindGroup = () => ({
    id: 'kind',
    legend: 'Kinds',
    multi: true,
    all: 'All kinds',
    options: () =>
      KINDS.filter((k) => state.usable.includes(k.id)).map((k) => ({
        id: k.id,
        label: k.label,
        note: k.note,
        count: state.counts[k.id] || 0,
        on: state.on.has(k.id),
      })),
    pick: (id) => toggle(id),
  });

  /**
   * The sub-filter groups, as the same shape as every other group.
   *
   * `parent` is what makes them different and it is read in exactly two places, both of
   * them here: the box is hidden unless the parent kind is selected (`hidden`), and the
   * summary line mentions it under the rule in `subSaid` (`said`). filtermenu.js knows
   * neither word — it asks the two questions and this file answers them.
   */
  const subGroups = () =>
    KINDS.filter((k) => k.sub && state.usable.includes(k.id)).map((k) => {
      const g = {
        id: k.sub.id,
        parent: k.id,
        legend: k.sub.legend,
        multi: k.sub.multi !== false,
        all: k.sub.all,
        options: () =>
          k.sub.options().map((o) => ({
            ...o,
            // Always a number, never absent: a chip built without one could never grow one
            // in place, and the counts arrive on the render *after* the control mounts.
            count: state.subCounts?.[k.sub.id]?.[o.id] || 0,
            on: chosenSub(k.id).has(o.id),
          })),
        pick: (id) => toggleSub(k.id, id),
      };
      g.hidden = () => !subOpen(g);
      g.said = () => subSaid(g);
      return g;
    });

  const allGroups = () => [...pageGroups, kindGroup(), ...subGroups()];

  /** Are this sub group's chips on screen? Only while its kind is selected. */
  const subOpen = (g) => state.on.has(g.parent);

  /**
   * Does the summary line mention this sub group?
   *
   * Wider than "are its chips showing", deliberately. A status chosen while `PRs` was
   * selected goes on narrowing the list after you widen back to `All kinds`, and a
   * narrowing nothing on screen admits to is the one thing this control must never do.
   * It is also mentioned while its kind is merely *visible* and has rows — that is the
   * standing `unmerged` default, which is equally a narrowing you did not set. And on a
   * screen with no pull requests in it at all, it says nothing, because there is nothing
   * for it to be about.
   */
  const subSaid = (g) => subOpen(g) || chosenSub(g.parent).size > 0 || (state.counts[g.parent] || 0) > 0;

  /** Chips and summary, never structure. Safe to call from a render loop, and a no-op
   *  before the control is drawn — `set()` runs at load, which is earlier than that. */
  function paint() {
    if (chrome) chrome.paint();
  }

  /**
   * Draw the control inside `host`, once.
   *
   * `groups` are the page's own — the inbox puts the scope switch here, because a
   * scope is a filter too and two collapsing controls side by side would be the three
   * rows again with extra steps. Each is
   * `{ id, legend, all?, multi?, options(), pick() }` — or a text group, or a typeahead;
   * see public/filtermenu.js — and stays owned by the page: filtermenu.js paints them and
   * routes the taps, and knows nothing about what they mean.
   *
   * `opts.narrowed` is the other half of that ownership. This file answers "are the kinds
   * narrowed"; a page with a group of its own that hides rows has to say so, or the
   * summary line stays quiet over a list that is missing most of itself.
   */
  function mount(host, opts = {}) {
    if (!host || chrome) return null;
    pageGroups = Array.isArray(opts.groups) ? opts.groups : [];
    if (typeof opts.onChange === 'function') listeners.push(opts.onChange);
    const pageNarrowed = typeof opts.narrowed === 'function' ? opts.narrowed : () => false;
    chrome = window.beadcause.filterMenu.mount(host, {
      groups: allGroups,
      closeOnPick: opts.closeOnPick,
      // What "this list is showing less than everything" means for the inbox. Not "some
      // chip is pressed": the scope switch always has exactly one, and `Both` is not a
      // narrowing.
      //
      // `opts.narrowed` is the page's own half, for the same reason `opts.groups` is: a
      // group the page owns narrows the page's list, and this file cannot know whether it
      // has. The inbox's bead search is the one that does — a bead picked in it hides most
      // of the screen, and a summary line that did not go bold over it would be the
      // collapsed-filter risk this whole control was built against.
      narrowed: () => state.on.size > 0 || subNarrowed() || Boolean(pageNarrowed()),
    });
    return chrome ? chrome.root : null;
  }

  /* What was selected last time, restored before anything asks. At load rather than at
     mount: `matches()` is answered by the page's very first render, which on a phone
     coming back from a notification happens before the control is drawn — and a filter
     that only applies once the chrome exists is a list that shows everything for a
     frame and then takes half of it away. Last in the file, because `set` paints, and
     the nodes it paints are declared above. */
  state.sub = loadSub();
  set(load(), { quiet: true });

  window.beadcause = window.beadcause || {};
  window.beadcause.inboxFilter = {
    KINDS,
    kindOf,
    matches,
    survey,
    set,
    paint,
    mount,
    /** Selected kind ids — empty for "all of them". */
    selected: () => [...state.on],
    /** One kind's sub-filter selection — empty for that kind's own default. */
    selectedSub: (kindId) => [...chosenSub(kindId)],
    setSub,
    /** Does this row survive its kind's sub-filter alone? What `surveyKinds` counts through. */
    inSub,
    /** Every kind the current scope can contain, in display order. */
    usable: () => [...state.usable],
    /** The kinds' half of the summary line, for an empty state that has to explain itself. */
    label: () => {
      const kinds =
        state.on.size === 0 ? 'all kinds' : [...state.on].map((id) => BY_ID.get(id).label.toLowerCase()).join(', ');
      // The status rides in brackets, and only while its chips are offered: an empty
      // state saying "prs" over a list narrowed to `live` would name the wrong culprit.
      const said = subGroups()
        .filter(subOpen)
        .map((g) => {
          const on = g.options().filter((o) => o.on);
          return on.length ? on.map((o) => o.label.toLowerCase()).join(', ') : String(g.all || '');
        });
      return said.length ? `${kinds} (${said.join(', ')})` : kinds;
    },
    onChange(fn) {
      if (typeof fn === 'function') listeners.push(fn);
    },
    isOpen: () => Boolean(chrome && chrome.isOpen()),
  };
})();
