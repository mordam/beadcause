/*
  What Home is carrying, and which of it you are looking at.

  ## Six pills at the top, and what they cost to get there

  This file used to be a filter panel with ten chips under a `Kinds` legend, behind a
  collapsed line you had to reach for. Every one of those ten was a *category of thing
  arriving* — a question, a proposal, a merge, a pull request, a ticket, a bead held for
  endorsement, and live beads in three states — which is a navigation, not a filter, and
  the collapse meant it was a navigation nobody could see. bc-khoe.2 promoted them out
  and amalgamated ten into six. They are the pill row across the top of every page now
  (public/viewbar.js); the argument for the row itself is in that file's header.

  The remaining panel — `#filters`, one line at rest, opening on hover with a pointer
  and on a tap without one — is still here, and everything below about it still holds.
  It is `public/filtermenu.js` that draws it, shared with the History page's own; what
  is left in it is the bead search and the two sub-filters, which narrow *within* the
  pill you are on rather than choosing between pills. The scope went out onto the row in
  front of it (bc-khoe.24, public/filterpills.js) for the same reason the kinds did, only
  harder: it decides which sweep runs, so a scope nobody can see is a screen that is
  empty for a reason that is off screen.

  The seam is `mount()` at the foot: this file hands filtermenu.js a list of groups and
  is asked, on every paint, what each one looks like right now. Nothing about the inbox
  crosses it — `unmerged`, `agent-filed` are words filtermenu.js has never heard — and
  nothing about the panel is decided here.

  ## The kinds

  Home is not one list. An advocate asking to create beads, a worker asking you to merge
  a pull request, a plain question, and — under `Both` and `Agent` — the live beads
  nobody is asking you about at all, are different jobs that happen to arrive at the
  same address. `KINDS` is the table that names them, and it is deliberately the only
  place that knows: bc-l8jp.5 (chat sessions in the inbox), bc-l8jp.6 (pull requests as
  cards), bc-0i27.3 (JIRA tickets) and bc-w156 (beads held for endorsement) were each
  one row here, and each got a filter, a count and a place in the summary line for free.

  Three of those four are folded into a neighbour now, and folding them cost the table
  nothing it did not already have — the predicates moved, the rows went, and the rest of
  the app went on asking `kindOf` and `matches` the same two questions. That is the same
  property that made adding them cheap, running the other way, and it is the reason the
  amalgamation is edits to these rows rather than a second table somewhere: the moment
  two files know what a Question is, one of them is wrong and nothing says which.

  Each kind carries a `side`, because a scope that never fetched a row cannot show a
  pill for it: `human` sweeps questions, `agent` sweeps live beads, `both` does both.
  `usable()` is what applies that, and `set()` drops selections the new scope cannot
  produce — otherwise switching to `Human` with `All Beads` selected is an empty screen
  with nothing on it to say why. `any` is the third value and it means what it says: a
  pull request comes off `gh`, a chat session off no sweep at all, and Questions can be
  produced by either sweep, so for none of them is there a scope that could have failed
  to fetch one, and none of them has a scope in which its pill would be dead.

  **A `side` is a fact about the fetch, not a veto on the tap** (bc-khoe.25). The row
  draws every pill on every scope and knows nothing about any of this, so for a while
  `All Beads` under the default `Human` scope was a pill that lit `My Epics` — `set`
  dropped the one selection it could ever make. Dropping is right when the scope has
  just had the last word (a switch, a survey, a reload) and wrong when the *pill* is
  having it: asking for the beads is asking for the sweep that fetches them. So `pick`
  and `asked` go through `widen`, which public/app.js answers by moving the scope to
  `Both` — in the switch beside the row, where you can see it happen.

  ## The two sub-filters

  A kind may carry a `sub`: a second group of chips that appears in the panel *only when
  that kind's pill is selected*, and narrows within it. There are two, and the pair of
  them is why the mechanism is worth having rather than being a special case for one
  screen.

  **PR status** came first and is the one with teeth. Five pull requests are open right
  now and thirty have merged in the last three weeks, so a PRs pill with no second axis
  would be a list of history with this morning's decisions somewhere inside it. Two
  rules make it safe:

  - **Its default is not "everything".** With no status chosen the list shows only what
    has *not merged* — `review`. A merged pull request is history, and history should be
    asked for. Which is a filter you did not set, so the summary line says `unmerged`,
    and there is no state in which the control claims to be showing you everything while
    showing you one rung.
  - **It applies whether or not its pill is selected.** The default above is about what
    Home *is*, not about what you last tapped. The panel only stops offering the choice.

  **Bead status** is the second (bc-khoe.2) and it is deliberately the other way round:
  `claimed`, `blocked` and `unclaimed` were three pills' worth of one thing in three
  states, and none of the three is history. So it has no `fallback` — nothing chosen
  means every rung — and the summary line says nothing about it until you choose one,
  because a line reporting a filter that is not filtering is noise around the one that
  is. `inSub` and `subSaid` are where those two behaviours part.

  ## What this does *not* touch

  **A kind filter does not change what rings your phone.** The space picker's does —
  it is stored on the server and the push path reads it (see `quietReasonFor`) — and
  this deliberately is not: it lives in localStorage, on this device, because "I am
  reading pull requests this hour" is not "do not tell me about questions". The accepted
  consequence is that a hidden kind can still notify you, and the lit pill saying `PRs`
  over a list with no questions in it is the standing reminder that it is narrowed.
*/
(() => {
  'use strict';

  const KEY = 'beadcause.kinds';
  /** The PR status sub-filter, kept apart so widening the kinds does not reset it. */
  const SUB_KEY = 'beadcause.prstatus';

  /**
   * Is this row a pull request, for the pill that carries both halves of one?
   *
   * A delivery bead that is *also* a proposal is not, and that exclusion is the one
   * piece of precedence in this file. Nothing writes such a row today; if anything ever
   * did, it is an advocate asking to create beads before it is a branch waiting on a
   * merge, and Questions is where a thing asking you something belongs. Stated here
   * rather than in two predicates so the two cannot disagree.
   */
  const isPr = (q) => Boolean(q.pr) || (!q.proposal && Boolean(q.delivery));

  /**
   * The kinds of thing Home carries, in the order their pills are drawn.
   *
   * ## Six rows, and two of them are not slices of the list
   *
   * A kind with a `test` is a **slice**: a predicate over the rows the inbox holds. The
   * four of those partition it — every row the list can hold answers to exactly one, so
   * `kindOf` never returns null for a row the app drew and a new kind cannot silently
   * steal rows from an old one. That is the property test/inboxkinds.mjs asserts, in
   * both directions, and it is the reason the exclusions below are spelled out in the
   * predicates rather than left to the order of the rows.
   *
   * A kind here carries what a kind *is* — its id, its label, its note, its icon and
   * which scope can fetch it — and deliberately not **where its pill goes**. That is
   * public/viewbar.js's, because it is a fact about the row rather than about the kind,
   * and a URL written down in both files is the drift this table exists to prevent. What
   * the two do share is the identity half, and test/inboxkinds.mjs holds them to it.
   *
   * A kind with no `test` is a **place**. `My Epics` is Home with nothing narrowed —
   * the P0 board and the work under it, which is a card (bc-rfnr.9) and not a category
   * of row — and `History` is a different page altogether. Neither is a filter, so
   * neither can be selected: `set()` drops them, exactly as it drops an id the table
   * has never heard of. They are in this table anyway, because the pill row is one row
   * of six and a reader asking "what are the six" must not have to find two of them
   * somewhere else. public/viewbar.js draws the row from a list of its own — it is on
   * twelve pages and this file is on one — and test/inboxkinds.mjs is what holds the
   * two lists to the same six ids, labels and hrefs.
   *
   * ## What the amalgamation cost, and what it bought
   *
   * There were ten of these and they were chips inside a collapsed panel (bc-khoe.2).
   * Ten categories behind a line you have to open is a navigation nobody can see, and
   * six is what fits across a phone as pills you can. Four rows went into two:
   *
   * - **Questions** absorbs `proposal`, `jira` and `endorsement`. All four are the same
   *   job — something waiting on a word from you — and having them apart meant three
   *   chips you had to know to check. `endorsement` is the one that changes `side`
   *   here: a held bead is only ever returned by the *agent* sweep (`agentBeads` in
   *   lib/server.js) while a question comes off the human one, so the amalgamated kind
   *   is reachable under either scope and is therefore `any` rather than `question`.
   * - **PRs** absorbs `delivery`. A worker's finished branch waiting on a merge and the
   *   pull request that branch opened are one thing arriving twice; bc-khoe.2 folds what
   *   the Merges card said into the PR card rather than keeping a pill for each.
   * - **All Beads** absorbs `claimed`, `blocked` and `unclaimed`, which were never three
   *   kinds of thing — they are one kind of thing in three states. They are a sub-filter
   *   now, the way PR status already was, and the difference between the two is worth
   *   knowing: PR status narrows by default (`unmerged`), bead status does not.
   *
   * `side` is which scope fetches it; see `usable`.
   *
   * ## `filters` — which of the panel's groups this pill can use
   *
   * The kinds left the panel; what stayed behind is a bead search and two sub-filters,
   * and **not one of the three is relevant to every pill** (bc-khoe.3). PR status over
   * `Chats` is a control that cannot change anything, and the bead search over `Chats`
   * is worse than that: `inBead` in public/app.js hides every row that is not a bead, so
   * a bead picked while you are looking at chats is an empty screen whose cause is a
   * control the panel is still offering. That is the same complaint that made the kinds
   * pills in the first place, one level down.
   *
   * So each pill names the groups it can use, by id, and everything else follows from
   * the one list:
   *
   * - the panel offers those groups' chips and hides the rest (`hidden`),
   * - the summary line names only what is narrowing something this pill can hold
   *   (`said`, and `subSaid` below for the one case where the two part company),
   * - and a selection the newly-picked pill cannot use is **dropped** rather than left
   *   narrowing a list it is not about — which is `set()`'s existing rule for a kind the
   *   new scope cannot produce, applied one level in.
   *
   * The ids are the panel's, not this table's: `bead` is public/app.js's search box, and
   * `status`/`beadstatus` are the two `sub` groups below. A page group named by no pill
   * would never be offered, which is why `mount()` warns about one.
   *
   * ## `compose` — which of the six has a ＋
   *
   * ＋ used to be a fixed part of Home's chrome: one button, drawn on every kind,
   * starting a chat session. That was right while Home was one list (bc-l8jp.5) and is
   * wrong now the pills are five screens, because *new* is a different thing on each of
   * them — an epic on `My Epics`, a conversation on `Chats`, a bead on `All Beads` —
   * and it is not anything at all on `Questions` or `PRs`. Both of those are queues of
   * things waiting on a word from you; there is nothing on either screen to create, and
   * a button whose only honest label there would be "make yourself another question to
   * answer" is worse than no button.
   *
   * So the flag lives here, one row per kind, rather than as a list of ids in
   * public/app.js — for the same reason the predicates do. A second file that knows
   * what the six kinds are is a second file that can be wrong about them, and nothing
   * would say which.
   *
   * **And it says what ＋ does, not only whether it is drawn.** It was a bare `true`
   * while every ＋ did the same thing; bc-khoe.27.3 gave `All Beads` a create of its
   * own, and the moment two of them differ the branch has to be written down somewhere.
   * A `switch` in public/app.js over kind ids would be that second file knowing what the
   * kinds are — the thing the paragraph above says not to do — so the value *is* the
   * answer: `chat` starts a conversation, `bead` opens the create form. Absent means no
   * ＋ at all, which is `composes()`, unchanged. bc-khoe.27.2 is one word on the `epics`
   * row when it lands.
   */
  const KINDS = [
    {
      id: 'epics',
      // A place, not a slice. Home with nothing narrowed *is* the board, so this pill
      // has no predicate and no selection: it is where you land, and every other pill
      // on this page is a narrowing of it.
      side: 'any',
      icon: '🎯',
      label: 'My Epics',
      note: 'The P0 board — the epics you own, and the work under them.',
      // Home with nothing narrowed holds every kind, so every group here *can* narrow
      // it — and only the search is offered all the same. The two sub-filters are the
      // second axis of a pill you have not picked, and offering both of them over a
      // list that is mostly neither would be the collapsed panel of ten chips again.
      // What they still do here is confessed on the line rather than dropped: see
      // `subSaid`, and the standing `unmerged` default it exists for.
      filters: ['bead'],
      // A place with a create, which is not a contradiction: `compose` is about the
      // screen you are on, and `test` is about which rows are in the list. This is the
      // screen you land on, so it is also the one ＋ is drawn on by default.
      //
      // Still `chat`, because that is still what the button does here. bc-khoe.27.2 is
      // where it becomes `epic`, and it is one word in this file when it lands.
      compose: 'chat',
    },
    {
      id: 'question',
      // `any`, and this is the one row where that word is doing something other than
      // describing a fetch that no scope owns. A plain question comes off the human
      // sweep and a held bead off the agent one, so *both* scopes can produce a row of
      // this kind and neither can be said to be the one that fetches it. A chip that is
      // dead under one of them is what `side` exists to prevent, and this kind is dead
      // under neither.
      side: 'any',
      icon: '❓',
      label: 'Questions',
      note: 'Everything waiting on a word from you — questions, proposals, tickets, and beads held for endorsement.',
      // Still the "none of the above" predicate, and still the one that would silently
      // absorb anything new — which is why the two exclusions are by name rather than
      // implied by where the row sits. `!q.session` because a chat session is not a
      // question and answering it is a different gesture; `!isPr` because a pull
      // request is the pill next door. The agent clause is the endorsement half: an
      // agent-side row belongs here only while it is *held*, because a held bead is a
      // decision waiting on you and every other agent row is a report about work.
      test: (q) => !q.session && !isPr(q) && (q.agent ? Boolean(q.held) : true),
      // Every row here is a bead, so the search is the whole of what narrows this list.
      // Neither sub-filter can: a question is not a pull request and it is not one of
      // the live beads nobody is asking you about.
      filters: ['bead'],
    },
    {
      id: 'pr',
      // On neither side in the original sense of the word: a pull request comes off
      // `gh`, not off a `bd` sweep, so no scope fetches it and no scope can fail to.
      // The delivery beads it now also carries do come off the human sweep, which does
      // not narrow it — a scope that can produce *either* half can produce the kind.
      side: 'any',
      icon: '🚢',
      label: 'PRs',
      note: 'Pull requests, and the finished branches waiting on a merge. Unmerged unless you ask for more.',
      test: (q) => !q.session && isPr(q),
      // The one pill with both. A pull request follows its beads — see `inBead` in
      // public/app.js — so the search narrows this list as well as the status does.
      filters: ['bead', 'status'],
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
        // A delivery bead has no rung of its own — it is the branch, not the pull
        // request — so it answers `review`, the one rung that means "not merged yet".
        // Which is also what puts it in the list under the default: the whole argument
        // for folding Merges into PRs is that the two are the same thing arriving
        // twice, and a fold that hid one of them by default would not be one.
        of: (q) => q?.pr?.stage || (q?.delivery ? 'review' : ''),
      },
    },
    {
      id: 'session',
      // A chat session is not in the tracker, so no scope fetches it and no scope can
      // fail to — which is what `any` says. Next to `pr` because the two are the same
      // shape of row: something outside `bd` that Home nonetheless holds.
      side: 'any',
      icon: '💬',
      label: 'Chats',
      note: 'Conversations you have open about what to file next. Tap one to pick it up.',
      test: (q) => Boolean(q.session),
      // **The empty list, and the reason this bead exists.** A chat is not in the
      // tracker, so it is under no bead and has no status — and `inBead` hides a row
      // that is not a bead outright rather than showing it, so a pick left over from
      // the pill next door empties this screen completely. Nothing narrows chats, so
      // the panel has nothing to offer here and hides itself; see `mount`.
      filters: [],
      // The original ＋: this list is conversations, and the create is a conversation.
      compose: 'chat',
    },
    {
      id: 'history',
      // The second place. /history is a page with its own filter bar and its own poll,
      // and it was a tab before it was a pill — nothing about it moves here except that
      // the row it is on is the same row as the five above and below it.
      side: 'any',
      icon: '📜',
      label: 'History',
      note: 'What already happened — the ledger of answered questions, merges and deploys.',
      // A place, and a different page at that: /history has a filter bar of its own
      // (public/history.js, the same public/filtermenu.js behind it) and this panel
      // never narrows it. `set()` refuses to select a place, so this is the honest
      // answer rather than a reachable state.
      filters: [],
    },
    {
      id: 'bead',
      // The one kind still tied to a scope, and it is the agent sweep that fetches it.
      // A chip for it under `Human` would be a control with nothing behind it until
      // something pays for a second query per workspace per poll, which is the bill the
      // chrome refused (bc-w156.4).
      side: 'agent',
      icon: '🧿',
      label: 'All Beads',
      note: 'Every live bead nobody is asking you about — claimed, blocked or waiting to be picked up.',
      // A list of every live bead is the one screen where "file another one" is the
      // obvious next thing to do, so ＋ here opens a form and files one — bc-khoe.27.3.
      compose: 'bead',
      // `!q.held` is the endorsement half of Questions stated from the other side. It is
      // here rather than left to the order of the rows for the reason every exclusion in
      // this table is: exclusivity is the property the table is asserted on, and a
      // partition that only holds while nobody reorders it is not one.
      test: (q) => Boolean(q.agent) && !q.held && !q.session && !isPr(q),
      // Beads, so the search applies, plus the three rungs below.
      filters: ['bead', 'beadstatus'],
      // Where `claimed`, `blocked` and `unclaimed` went. Three kinds became three rungs
      // of one, and the difference from the PR ladder above is the whole reason `inSub`
      // has two behaviours: **this group's default is everything**. A bead's status is
      // not a claim about whether it is finished with — nothing here is history the way
      // a merged pull request is — so there is no rung it would be honest to hide.
      sub: {
        id: 'beadstatus',
        legend: 'Bead status',
        multi: true,
        /** No `fallback`, which is what makes "nothing chosen" mean every rung. */
        all: 'any status',
        options: () => [
          { id: 'claimed', label: 'Claimed', note: 'Work an agent has in hand right now.' },
          { id: 'blocked', label: 'Blocked', note: 'Live beads waiting on something else.' },
          { id: 'unclaimed', label: 'Unclaimed', note: 'Open beads nobody has picked up.' },
        ],
        // The same three-way split the three predicates made, in one place. Anything bd
        // grows a name for tomorrow lands on `unclaimed`, exactly as it did before —
        // a row no chip can show is a row `All` cannot show either.
        of: (q) => (q?.status === 'in_progress' ? 'claimed' : q?.status === 'blocked' ? 'blocked' : 'unclaimed'),
      },
    },
  ];

  const BY_ID = new Map(KINDS.map((k) => [k.id, k]));

  /** The four that are slices of the list. The other two are places — see KINDS. */
  const SLICES = KINDS.filter((k) => typeof k.test === 'function');

  /** Which kind a row is. Never null for a row the inbox drew — see KINDS. */
  const kindOf = (q) => SLICES.find((k) => k.test(q))?.id || null;

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
    /**
     * kind id → how many rows of it are in view, before this filter is applied.
     *
     * Two readers, and they want the same number for different jobs: `subSaid` asks
     * whether a sub-filter is narrowing anything worth naming on the summary line, and
     * `paint` pushes the whole map at the pill row, where four of the ids are drawn as a
     * badge (public/viewbar.js). `epics` is in here too and is the only key not counted
     * by the caller — see `survey`.
     */
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
   * `fallback` is what a group means with nothing chosen, and the two groups in the
   * table mean opposite things by it. PR status **has** one — with nothing chosen a
   * pull request has to be on the `review` rung to be in the list, because a merged one
   * is history and history should be asked for. Bead status has **none**, and that is
   * the deliberate other half rather than an omission: an agent's bead is live whether
   * it is claimed, blocked or waiting, so there is no rung it would be honest to hide
   * from somebody who asked for all of them. A group with no `fallback` therefore
   * answers true for every value, which is "all of them" and not "none of them" — the
   * distinction is worth stating because getting it backwards is a screen that is empty
   * for a reason nothing on it explains.
   */
  function inSub(q) {
    const sub = subOf(kindOf(q));
    if (!sub) return true;
    const chosen = chosenSub(subKindOf(sub));
    const value = sub.of(q);
    if (chosen.size) return chosen.has(value);
    return sub.fallback ? sub.fallback.includes(value) : true;
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
   * cannot produce: `Agent` with `All Beads` held over and then a switch to `Human` is
   * an empty list whose cause is off screen, and the only thing worse than a filter you
   * cannot see is one you cannot see selecting something that does not exist here.
   *
   * A **place** — `My Epics`, `History` — is dropped the same way and for a plainer
   * reason: it has no predicate, so selecting it would hide every row in the list. The
   * pill row treats `My Epics` as the empty selection this leaves behind, which is what
   * it means: Home, with nothing narrowed.
   */
  function set(ids, { quiet = false } = {}) {
    const next = new Set(
      (ids || []).filter((id) => BY_ID.get(id)?.test && state.usable.includes(id))
    );
    const same = next.size === state.on.size && [...next].every((id) => state.on.has(id));
    state.on = next;
    save();
    // One level in from the rule above, and for the same reason: a filter the newly-lit
    // pill cannot use is dropped rather than kept and quietly narrowing a list it is not
    // about. Only when the pill actually moved — `dropUnusable` reads the selection, so
    // running it on a no-op set would be a chance to clear something for no reason.
    if (!same) dropUnusable();
    paint();
    if (!same && !quiet) notify();
    return same;
  }

  /**
   * Which pill is lit, as an id from the table. Never null.
   *
   * The empty selection is `epics`, and that is the whole of what My Epics means — Home
   * with nothing narrowed. It is a function rather than a stored value because the
   * selection can be changed by things that are not a pill tap (`revealPr` widens it to
   * show a card you arrived at from a notification, and `survey` drops a kind the new
   * scope cannot produce), and a row painted from a second copy of the answer would go
   * stale on exactly those paths.
   *
   * More than one selected is possible — nothing in the row can produce it, but
   * `revealPr` can — and the first in table order wins, because a row of pills has to
   * light exactly one and lighting the leftmost is the only answer that does not depend
   * on the order the selections arrived in.
   */
  const current = () => SLICES.find((k) => state.on.has(k.id))?.id || 'epics';

  /**
   * How the page makes a kind reachable that the current scope cannot produce, if it
   * has an answer. Returns whether it moved anything.
   *
   * `null` until a page registers one, and optional forever: the row is on twelve pages
   * and only Home has a scope at all, so a page that never calls `onWiden` is a page
   * where this seam has nothing to do. See `pick`.
   */
  let widen = null;

  /**
   * Tap a pill. Exclusive, unlike the chips it replaced.
   *
   * The chips were a multi-select because they were a filter panel; a row of pills is a
   * navigation, and a navigation with two destinations lit is not one. `epics` — and
   * any other place, and any id the table does not know — clears the selection, which
   * is what "Home with nothing narrowed" is.
   *
   * **A pill for a kind this scope cannot produce widens the scope rather than being
   * dropped** (bc-khoe.25). `set` drops it, and that is right for everything `set` is
   * for — a scope switch, a reload, a survey — because those are all the scope having
   * the last word. A tap is not: the row draws `All Beads` on every scope, so under
   * `Human`, where `bead` is unreachable, dropping the selection lit `My Epics` and the
   * pill was a control that did nothing at all. Asking for the beads is asking for the
   * sweep that fetches them, and the widening is visible — the scope switch beside the
   * row moves to `Both` — which is what makes it a control you watch rather than a
   * preference something changed behind your back.
   *
   * A tap that widened is applied **quietly**, and that is not a detail: the widening
   * has already told the page more than a filter change ever does — it emptied the
   * list, put the wait on screen and went back to `bd`. The listeners' repaint on top
   * of that would draw an *empty* list over "Asking bd…", which is the one screen this
   * tap has least right to show, because nothing has come back yet. The refetch is what
   * repaints, when it has something to repaint with.
   */
  const pick = (id) => {
    if (!BY_ID.get(id)?.test) return set([]);
    const widened = !state.usable.includes(id) && Boolean(widen?.(id));
    return set([id], { quiet: widened });
  };

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
   *
   * Since bc-khoe.23 these numbers are also what four of the pills say out loud, so the
   * paragraph above is the badge's claim as well as the chip's: `Questions 4` is a
   * promise about the screen a tap opens, and the only way to keep it is to count what
   * this function counts, where it counts it.
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
    if (counts && typeof counts === 'object') {
      /*
        `epics` is derived here rather than counted by the caller, because it is a fact
        about this file rather than about the render.

        My Epics is a *place*, not a slice: it carries no `test`, so no row is ever of
        that kind and a loop keying on `kindOf` can never produce a number for it. What
        picking it does is clear the selection — and `matches()` with nothing selected is
        `inSub()` alone, which is precisely the rows the caller has already counted, each
        through its own sub-filter. So the sum of the slices *is* the number, and summing
        them here means the two can never disagree about it.

        Summed over the slices only, so an `epics` the caller passed cannot be counted
        into its own total.
      */
      const rows = Object.entries(counts).reduce(
        (n, [id, c]) => (BY_ID.get(id)?.test ? n + (Number(c) || 0) : n),
        0
      );
      state.counts = { ...counts, epics: rows };
    }
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

  /** Extra chip groups the page puts in the same panel. */
  let pageGroups = [];

  /** The chrome, once mounted. `null` until then — see `paint`. */
  let chrome = null;

  /*
    **There is no kinds group in the panel any more** (bc-khoe.2). There was — ten chips
    under a `Kinds` legend — and the whole of this bead is that ten categories behind a
    line you have to open is a navigation nobody can see. They are the pill row now
    (public/viewbar.js), which is on screen without being reached for.

    What is left in the panel is what a pill cannot be: the bead search, which wants a
    dropdown under it, and the two sub-filters below, which narrow *within* the pill you
    are on rather than choosing between them. The scope was here too until bc-khoe.24 and
    is a segmented switch in front of this panel now (public/filterpills.js). bc-khoe.26
    is what takes the rest of it apart the same way.
  */

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

  const allGroups = () => [...pageGroups, ...subGroups()];

  /**
   * Which panel groups the lit pill can use — its `filters`, by id (bc-khoe.3).
   *
   * Read off `current()` rather than off `state.on` so the empty selection answers as
   * `My Epics`, which is what it means. A pill the table has somehow lost offers
   * nothing, which is the safe direction: a control that is not drawn cannot narrow a
   * list behind your back, and a control that is drawn over a pill it does nothing for
   * is the whole complaint.
   */
  const offers = () => BY_ID.get(current())?.filters || [];

  /** Is this group's control on screen right now? The one question `hidden` asks. */
  const offered = (id) => offers().includes(id);

  /**
   * Can the list, as it is narrowed right now, hold a row of this kind at all?
   *
   * Wider than "is this pill lit": the empty selection is every kind. It is the
   * difference between a narrowing that is dormant and one that is still biting — a PR
   * status chosen and then widened back to `My Epics` goes on hiding merged pull
   * requests, and the same choice under `Questions` hides nothing, because there is no
   * pull request in that list to hide.
   */
  const inView = (kindId) => state.on.size === 0 || state.on.has(kindId);

  /**
   * Drop what the pill that is now lit cannot use. Called from `set`, and only there.
   *
   * Two shapes, because the two kinds of group keep their selection in different
   * places. A sub-filter's lives here, and it is dropped once its kind is out of view
   * entirely — *not* merely because its chips have gone, which is the `My Epics` case
   * above and is a narrowing that is still real. A page group's lives with the page, so
   * all this end can do is ask: `clear()` is optional, and a group without one keeps
   * whatever it had, which is what every group did before this existed.
   *
   * Quiet on the way through. The caller has just changed the selection and is about to
   * paint and notify for it, and a second notify here would re-enter the page's render
   * for one half of one change.
   */
  function dropUnusable() {
    for (const k of KINDS) {
      if (!k.sub || inView(k.id) || !chosenSub(k.id).size) continue;
      setSub(k.id, [], { quiet: true });
    }
    for (const g of pageGroups) {
      if (offered(g.id) || typeof g.clear !== 'function') continue;
      try {
        g.clear();
      } catch {
        /* a page that cannot clear its own box must not stop the pill being picked */
      }
    }
  }

  /**
   * A page's own group, with this file's answer to "does the lit pill use it" folded in.
   *
   * Wrapped rather than mutated: `beadGroup` in public/app.js is a literal that file
   * owns, and writing a `hidden` onto it from here would be this file editing another's
   * descriptor — the thing that made the panel and the pill row able to take the same
   * shape in the first place. A group that already has a `hidden` of its own keeps it;
   * the two are OR-ed, because either reason to hide a control is a reason.
   *
   * A group no pill names could never be drawn, which is a filter the page believes it
   * has and has not — the same failure public/filterpills.js warns about for a text
   * group on the flat row, and loud here for the same reason.
   */
  function adopt(g) {
    if (!g || !g.id) return g;
    if (!KINDS.some((k) => (k.filters || []).includes(g.id))) {
      console.warn(`[inboxFilter] no pill can use the "${g.id}" group — it will never be offered`);
    }
    const own = typeof g.hidden === 'function' ? g.hidden : () => false;
    return { ...g, hidden: () => !offered(g.id) || Boolean(own()) };
  }

  /** Are this sub group's chips on screen? Only while its own pill can use them. */
  const subOpen = (g) => offered(g.id);

  /**
   * Does the summary line mention this sub group?
   *
   * Wider than "are its chips showing", deliberately. A status chosen while `PRs` was
   * selected goes on narrowing the list after you widen back to `My Epics`, and a
   * narrowing nothing on screen admits to is the one thing this control must never do.
   *
   * The third clause is the standing default, and it is why the group has to have one to
   * qualify: PR status narrows with nothing chosen, so the line says `unmerged` over a
   * screen with pull requests on it whether or not you touched the chips. Bead status
   * narrows nothing with nothing chosen, so saying `any status` there would be the line
   * reporting a filter that is not filtering — noise around the one that is.
   *
   * **Both of the wider clauses are gated on `inView`** (bc-khoe.3), which is the other
   * half of the same rule and the one that is easy to miss. `counts` is taken before the
   * kind filter — that is what makes a pill's number the list it would open — so under
   * `Questions` there are still four pull requests counted and none of them in the list.
   * Without the gate the line would read `unmerged` over a screen with no pull request
   * on it, which is this control's own failure in the mirror: naming a filter that is
   * not filtering is the same lie as hiding one that is.
   */
  const subSaid = (g) =>
    subOpen(g) ||
    (inView(g.parent) &&
      (chosenSub(g.parent).size > 0 ||
        (Boolean(subOf(g.parent)?.fallback) && (state.counts[g.parent] || 0) > 0)));

  /** Chips and summary, never structure. Safe to call from a render loop, and a no-op
   *  before the control is drawn — `set()` runs at load, which is earlier than that. */
  function paint() {
    if (chrome) chrome.paint();
    // And the row, which is the kinds' half of the chrome now. Pushed rather than
    // pulled: viewbar.js is loaded on twelve pages and this file on one, so the row
    // cannot ask which kind is selected — it would have to know the storage key, which
    // is the second place that knows this bead exists to remove. A no-op everywhere but
    // Home, where `mark` is what moves the lit pill.
    window.beadcause?.views?.mark?.(current());
    // And the numbers on it, down the same channel and for the same reason. The row
    // reads only the four ids it draws a badge for; what is in the rest of the map is
    // this file's business, not its. Counted before the kind filter and after the space
    // picker, so a badge is what tapping the pill would leave you with — see `survey`.
    window.beadcause?.views?.counts?.(state.counts);
  }

  /**
   * Draw the control inside `host`, once.
   *
   * `groups` are the page's own — the inbox puts its bead search here. Each is
   * `{ id, legend, all?, multi?, options(), pick() }` — or a text group, or a typeahead;
   * see public/filtermenu.js — and stays owned by the page: filtermenu.js paints them and
   * routes the taps, and knows nothing about what they mean. It is the same descriptor
   * public/filterpills.js takes, which is what let the scope move from this list to that
   * row without being rewritten.
   *
   * `opts.narrowed` is the other half of that ownership. This file answers "are the kinds
   * narrowed"; a page with a group of its own that hides rows has to say so, or the
   * summary line stays quiet over a list that is missing most of itself.
   */
  function mount(host, opts = {}) {
    if (!host || chrome) return null;
    pageGroups = (Array.isArray(opts.groups) ? opts.groups : []).map(adopt);
    if (typeof opts.onChange === 'function') listeners.push(opts.onChange);
    const pageNarrowed = typeof opts.narrowed === 'function' ? opts.narrowed : () => false;
    chrome = window.beadcause.filterMenu.mount(host, {
      groups: allGroups,
      closeOnPick: opts.closeOnPick,
      // What "this list is showing less than everything" means for the inbox. Not "some
      // chip is pressed": the scope switch — on the row in front of this panel since
      // bc-khoe.24 — always has exactly one, and `Both` is not a narrowing.
      //
      // `opts.narrowed` is the page's own half, for the same reason `opts.groups` is: a
      // group the page owns narrows the page's list, and this file cannot know whether it
      // has. The inbox's bead search is the one that does — a bead picked in it hides most
      // of the screen, and a summary line that did not go bold over it would be the
      // collapsed-filter risk this whole control was built against.
      //
      // **The selected kind is deliberately not part of this any more** (bc-khoe.2). It
      // was, and had to be, while the kinds were chips inside the panel: a narrowing you
      // could only see by opening something is the one this line exists to confess. They
      // are a lit pill in the row above now, which is a stronger admission than a bold
      // line and is on screen without being reached for — and a line that went bold for
      // every pill but the leftmost would be bold nearly always, which is a signal that
      // has stopped signalling.
      narrowed: () => subNarrowed() || Boolean(pageNarrowed()),
    });
    return chrome ? chrome.root : null;
  }

  /* What was selected last time, restored before anything asks. At load rather than at
     mount: `matches()` is answered by the page's very first render, which on a phone
     coming back from a notification happens before the control is drawn — and a filter
     that only applies once the chrome exists is a list that shows everything for a
     frame and then takes half of it away. Last in the file, because `set` paints, and
     the nodes it paints are declared above. */
  /**
   * The id `?kind=` names, if the table still has one by that name. Null otherwise.
   *
   * Parsed by hand off `window.location`. `URLSearchParams` is a web API rather than a
   * language one, and this file is driven in a vm by test/inboxkinds.mjs with a document
   * small enough to read — adding a URL parser to that room to answer one question would
   * be more fake than the thing under test.
   *
   * Two callers read it as two different questions and neither can be the other, which
   * is why the parse is its own function: `arrived` wants the *selection* to boot with,
   * and `asked` wants the *slice that was asked for*, because a slice may need a wider
   * scope before it can be selected at all. See `asked`.
   */
  const named = () => {
    try {
      const m = /[?&]kind=([^&]*)/.exec(window?.location?.search || '');
      if (!m) return null;
      const id = decodeURIComponent(m[1]);
      return BY_ID.has(id) ? id : null;
    } catch {
      // A stray `%` makes `decodeURIComponent` throw, and this runs at the top level of
      // the file: an uncaught one here would mean no `window.beadcause.inboxFilter` at
      // all, so the inbox would lose its whole filter control over a malformed query.
      // Reading it as "no instruction" is the same answer an unknown kind gets.
      return null;
    }
  };

  /**
   * `?kind=…` as a selection, which is how a pill tapped on another page arrives here.
   *
   * It outranks what is on disk, and it has to: tapping `PRs` from /history is a request
   * for the pull requests, and landing on Home showing whatever you last looked at
   * instead would be the row's one job not working. `epics` — and any place — is the
   * empty selection, so `My Epics` from another page arrives at an unnarrowed Home
   * rather than at your last narrowing of it.
   *
   * An id the table does not know is `null` rather than `[]`, which is the difference
   * between "no instruction" and "clear it": a stale link from a phone's home screen
   * naming a kind that has since been folded into another should leave the selection
   * alone, not silently widen it.
   */
  const arrived = () => {
    const id = named();
    return id ? (BY_ID.get(id).test ? [id] : []) : null;
  };

  /**
   * The **slice** `?kind=` asks for, if it asks for one. `null` for a place, an id the
   * table has forgotten, and a URL with no `kind` in it.
   *
   * Read by public/app.js before it mounts anything, because the arrival is the same
   * request a tap is (see `pick`) and the scope it needs has to be settled *before* the
   * first survey — a survey under the stored scope would drop the selection this query
   * came here to make, and there is no tap left to widen on.
   */
  const asked = () => {
    const id = named();
    return id && BY_ID.get(id).test ? id : null;
  };

  state.sub = loadSub();
  set(arrived() || load(), { quiet: true });

  window.beadcause = window.beadcause || {};
  window.beadcause.inboxFilter = {
    KINDS,
    kindOf,
    matches,
    survey,
    set,
    paint,
    mount,
    /** Which pill is lit. `epics` — Home, nothing narrowed — when nothing is selected. */
    current,
    /** Tap a pill: exclusive, and a place clears the selection. */
    pick,
    /** The slice `?kind=` asks for — a pill tapped on another page. Null for none. */
    asked,
    /** How to reach a kind this scope cannot produce. One page has an answer; see `pick`. */
    onWiden(fn) {
      if (typeof fn === 'function') widen = fn;
    },
    /**
     * Does the view you are on have a create of its own? See `compose` in KINDS.
     *
     * A question rather than a stored answer, and derived from `current()` rather than
     * from the selection, for the same reason the lit pill is: `revealPr` and `survey`
     * both change which kind you are on without a pill being tapped, and a button drawn
     * from a second copy of the answer would still be there after them.
     */
    composes: () => Boolean(BY_ID.get(current())?.compose),
    /**
     * *What* ＋ creates on the view you are on — `chat`, `bead`, or `''` for no button.
     *
     * The same read one word further along, so the button and its action can never come
     * from two different answers to "which kind am I on". public/app.js branches on this
     * rather than on the kind id: it is what keeps the list of what the six kinds are in
     * this file only. An unrecognised value there falls back to the chat, which is what
     * ＋ has always done — a newer table beside an older script must not leave the app's
     * primary action doing nothing.
     */
    creates: () => String(BY_ID.get(current())?.compose || ''),
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
