/* The chip row on the one page that has one, and the last of the app's second bars.
 *
 * The pill row across the top of every page moves between *pages*; this row swaps a
 * *pane* on monitor.html, and the two are drawn alike because they are both rows of
 * things you tap. What separates them is that everything here is a **mode** of the page
 * you already watch work from: the same space's repos and sessions, seen another way.
 *
 * **This row was going to be deleted, and it is not** (bc-khoe.30.6). bc-khoe.4 used to
 * say that Advocates and Mirror become pills in the row above, which would have left
 * nothing here to own; the pane model settled it the other way, and the ruling is worth
 * having where the file it saves lives. Two things decided it. The Mirror **cannot** be a
 * pill by its own argument — it follows *another* device and drops its own, so on the
 * phone a pill is tapped from it is a screen with nothing to show — and a row of chips
 * that dissolves down to a row of one is a worse shape than the row it replaced. And
 * these are modes rather than views: one space's work, seen as what is running, as what
 * is waiting to ship, and as what another device is looking at. The pill row moves
 * between views; this one moves within one. What was ever wrong with the pair was that
 * the two are drawn alike, which is bc-stci — a restyle, not a deletion.
 *
 * **And bc-khoe.4 folded it, so this file now runs in two documents.** The whole of
 * monitor.html below its top bar is the Advocates pane of `public/index.html`, chip row
 * and all, and this file is that pane's **one** registration with public/panestage.js —
 * `register` holds one spec per view id, and a row that owns the swap is the only thing
 * on this screen that knows which of the three is up. `build` is "put the remembered chip
 * up"; `wake` is "hand the poll's answer to whichever section asked for it".
 *
 * It asks the *document* which one it is in — `panes.has('advocates')` — rather than
 * reading `location.pathname` or taking a flag. The eleven pages that are not the shell
 * have no `window.beadcause.panes` at all, and a pane still marked `data-pending` answers
 * `has()` false, which is exactly the state this container was in until this bead. One
 * question covers both. `/monitor` and its eight siblings are still documents and still
 * answer — they are on the phone's home screen and in the notifications the ship path
 * sends — and landing them on the pane is bc-khoe.30.7 rather than this bead.
 *
 * There are three of them. **Config** was the fourth until bc-khoe.10 took it out to a
 * view of its own, which is why the fold waited for it: folding in a section that another
 * branch was deleting is work with a conflict already written into it.
 *
 *   - **Advocates** is the page itself: what is running this minute.
 *   - **PRs** is the shipping screen (bc-d4d5). It was `/prs` with a fifth of the bottom
 *     bar, then `/prs` with nothing pointing at it — reachable only from the link on an
 *     inbox card, which meant that on a day with no PR card in the inbox there was no
 *     route to the **Ship** button at all. It is a mode of this page by the same
 *     argument the Mirror is: you glance at it, act on one row and leave.
 *   - **Config** is the selected space's settings (bc-me2b), and the only one of the four
 *     that arrived by *leaving* this pane rather than by folding a page into it. It leaves
 *     again under bc-khoe.10, for a view of its own.
 *   - **Mirror** is the phone's screen on a screen with room for it (bc-3xb).
 *
 * The swap was two lines in mirror.js while there were two panes, and a two-way boolean
 * cannot be made three-way by adding a chip: the pane that is going *away* has to be
 * told as well as the one arriving, and with three panes "the other one" is no longer a
 * name for anything. So the row is owned here, the panes subscribe, and mirror.js and
 * prs.js each answer only for themselves.
 *
 * **The pane that is hidden is not merely invisible — it is stood down.** Each of these
 * holds a parked `/api/poll` and, in the board's case, a `gh` sweep per repo behind
 * every wake; a page with three of them running at once would ask three times over for
 * two panes nobody is looking at. Every subscriber gets told which chip is up on every
 * change *and once at boot*, so "start when I am shown, stop when I am not" is the same
 * piece of code as "start at boot" and there is no first-paint special case to forget.
 *
 * **That rule survives the fold, and it is the one place bc-khoe.30.4's rule is wrong.**
 * A pane of the shell stays live while hidden, on the argument that a pane you come back
 * to should already be right rather than catching up. It is the correct default and it is
 * the wrong answer for all three of these. The board is a `gh` sweep per repo, which is
 * money spent on a screen behind two hidings. The Mirror is worse than expensive: it
 * publishes `view: null` for this device — you are nowhere, because you are looking at
 * somebody else — and a Mirror left running while you read Home would tell every other
 * device in the house that this one is nowhere, when it is on the inbox. So inside a pane
 * "hidden" means the chip is down **or** the pane is, and a chip that is up inside a
 * hidden pane is down: that is the whole of `up()` below, and it is the one question the
 * three sections ask instead of reading their own `hidden` attribute.
 *
 * The roster is the exception to the exception and costs nothing: its snapshot rides the
 * poll that was parked anyway, so public/monitor.js takes the free half of every wake
 * whether or not it is on screen and is current when you come back without having asked
 * for anything. That is why the fan-out below hands the wake to **every** section rather
 * than only to the one that is up — each answers for itself, which is the same division
 * this file already makes for the swap.
 *
 * The mapping lives in the HTML — `data-pane` is the section a chip shows and
 * `data-view` is what public/presence.js should say this device is looking at — because
 * a chip and its pane are one thing and splitting them across two files is how the
 * third one gets added to only one of them. `data-view` is empty on the Mirror
 * deliberately: you are looking at *another* device there, so this one is nowhere, and
 * a mirror that could follow itself is the absurdity presence.js's own header warns
 * about.
 */
(() => {
  'use strict';

  const tabsEl = document.getElementById('mon-tabs');
  if (!tabsEl) return;

  /** The view id this pane is, in public/hashroute.js's vocabulary. */
  const VIEW = 'advocates';

  const panes = (window.beadcause && window.beadcause.panes) || null;
  const route = (window.beadcause && window.beadcause.route) || null;

  /**
   * Is this the shell's Advocates pane, or the `/monitor` document it also still is?
   *
   * Asked of the document rather than of a flag, and of `panes` rather than of the path:
   * the eleven pages that are not the shell have no `window.beadcause.panes`, and a pane
   * still marked `data-pending` answers `has()` false — which is the state this pane's own
   * container was in until this bead filled it. One question, both answers.
   */
  const inShell = Boolean(panes && typeof panes.has === 'function' && panes.has(VIEW) && route);

  /*
   * There used to be a `ResizeObserver` here, and what it was for is worth knowing
   * before somebody puts it back (bc-ugd4, deleted in bc-khoe.1).
   *
   * The strip was `position: sticky` at `top: var(--topbar-h)`, and this file published
   * that variable by measuring `.topbar`. It could not be a constant in the stylesheet:
   * the bar is 104px with the space picker's row and 61px without, and the picker hides
   * itself whenever the daemon is watching fewer than two workspaces — so on the same
   * build, the same page, the height is a fact about the *payload*. It also carries
   * `env(safe-area-inset-top)`, which is zero in a browser and not zero in the installed
   * app on a notched phone, and the bar is `flex-wrap: wrap`, so a narrow enough screen
   * can rewrap it at any moment. An observer answered all four without knowing about any
   * of them.
   *
   * None of that is true any more, because there is nothing to stick to. Every page is an
   * app shell now (bc-khoe.1): `body` is one viewport tall and clipped, the top bar and
   * the pill row are rows of a flex column, and this strip is the row under them. The
   * viewport does not scroll, so nothing can scroll it away and no offset has to be
   * measured. If a future change makes some strip sticky under moving chrome again, this
   * is the block that comes back — but a variable nothing reads is worse than no
   * variable, because it reads as load-bearing.
   */

  /** Which chip was up last time. */
  const KEY = 'beadcause.mon.tab';
  /* What that was called while mirror.js owned the row and there were two of them. Read
     once, never written: a phone that left the Mirror up yesterday should come back to
     it, and the alternative is every such device silently landing on Advocates once. */
  const LEGACY = 'beadcause.mirror.tab';

  /* The paths that *are* the board. Arriving on one of them selects the PRs chip
     whatever was up last time — they are on the phone's home screen and in the
     notifications the ship path sends, and a notification that opened the advocates
     roster instead would be the link quietly not working. The server maps all three
     onto monitor.html; see serveStatic in lib/server.js and viewbar.js's `paths`. */
  const PR_PATHS = ['/prs', '/pulls', '/prs.html'];

  const chips = [...tabsEl.querySelectorAll('[data-tab]')];
  const paneOf = new Map(chips.map((c) => [c.dataset.tab, document.getElementById(c.dataset.pane)]));
  const viewOf = new Map(chips.map((c) => [c.dataset.tab, c.dataset.view || null]));
  const subs = [];
  const wakes = [];
  /** Which chip is up. Unchanged by the pane being hidden — coming back is not a reset. */
  let active = null;
  /** Is the pane itself on screen? Always true on the document, which has no panes. */
  let visible = !inShell;
  /** What the subscribers were last told, so a repeat costs nothing and a hide is one call. */
  let told = null;

  const known = (which) => paneOf.has(which);

  /**
   * Where the chip is written down in the shell, and it is the hash rather than anything
   * else — `#advocates?tab=prs`.
   *
   * This is the slot decision 5 of public/hashroute.js opened for the ledger's filters
   * (`#history?status=closed`), and a chip is the same kind of thing: not a view of the
   * tracker, a narrowing of one. The alternatives were named and not chosen — a second
   * hash *form* for the chip, which bc-khoe.30.2 decision 4 declined outright (one slot,
   * nothing held twice), and a `sessionStorage` handoff, which is a second place the same
   * fact lives and cannot be reloaded into or sent to a phone.
   *
   * It is worth something on its own — a reload comes back to the chip you were on, and
   * `/#advocates?tab=prs` is a link — and it is what makes bc-khoe.30.7's redirect
   * possible: `/prs`, `/pulls` and `/prs.html` mean the **board**, not merely this view,
   * and once they arrive as `/#advocates` there is no pathname left to read them off.
   * That bead's `viewHop` already carries a narrowing of exactly this shape.
   *
   * `localStorage` stays the memory for both documents. The address says which chip *this*
   * arrival wants; the store says which one you were last on when it does not say.
   */
  const address = {
    read: () => (inShell ? new URLSearchParams(route.parse(location.hash).query).get('tab') || '' : ''),
    write(which) {
      // Only while this pane is the one showing. The staged boot puts a chip up while Home
      // is on screen, and a tab written into the hash from behind a pane nobody is looking
      // at would move the address out from under the view that owns it.
      if (!inShell || panes.showing() !== VIEW) return;
      // The first chip is the pane's own default and is left off the address, so the bare
      // `#advocates` a pill tap writes is not immediately rewritten into a longer form
      // that means the same thing.
      const q = which && which !== chips[0]?.dataset.tab ? `tab=${encodeURIComponent(which)}` : '';
      const next = location.pathname + location.search + route.hashFor(VIEW, q);
      // `replaceState` because a chip is not a place you go back *to*: three chips would
      // otherwise fill the back stack with steps between you and the screen you arrived
      // from, which is the same call the ledger's filters make.
      if (next !== location.pathname + location.search + location.hash) history.replaceState(null, '', next);
    },
  };

  function stored() {
    try {
      return localStorage.getItem(KEY) || localStorage.getItem(LEGACY) || '';
    } catch {
      return '';
    }
  }

  function initial() {
    /* The address first, in the shell: `#advocates?tab=prs` is what a redirect from one of
       PR_PATHS becomes once bc-khoe.30.7 lands, and it is also just what a reload of this
       pane deserves to come back to. */
    const asked = address.read();
    if (known(asked)) return asked;
    /* And the path, on the document. Arriving on one of these selects the PRs chip whatever
       was up last time — they are on the phone's home screen and in the notifications the
       ship path sends, and a notification that opened the advocates roster instead would be
       the link quietly not working. In the shell the pathname is `/` and this never fires,
       which is exactly why the line above exists. */
    const here = location.pathname.replace(/\/+$/, '') || '/';
    if (PR_PATHS.includes(here)) return 'prs';
    const last = stored();
    return known(last) ? last : chips[0]?.dataset.tab || '';
  }

  /**
   * Whether a chip's section is really on screen — the chip is up **and**, in the shell,
   * the pane is.
   *
   * This is what the three sections ask instead of reading their own `hidden` attribute,
   * and the difference is the whole of the standing-down above: a section whose chip is up
   * inside a hidden pane has `hidden === false` and is not being looked at.
   */
  const up = (which) => visible && active === which;

  /**
   * Tell the subscribers what is on screen, and tell the daemon.
   *
   * `''` is a real answer and means "none of them" — the pane is hidden. Every subscriber
   * already reads its own name out of this argument (`if (which !== 'prs') return`), so a
   * hide stands all three down through the code path that was already there for a swap,
   * and coming back is the same call that a first paint is.
   *
   * The presence report goes `null` with it. Saying nothing instead would leave every other
   * device in the house believing this one is still on the sessions view while it reads the
   * inbox, and `null` is the word this row already sends for the Mirror.
   */
  function announce() {
    const eff = visible ? active : '';
    if (eff === told) return;
    const prev = told;
    told = eff;
    window.beadcause?.presence?.report({ view: (eff && viewOf.get(eff)) || null });
    for (const fn of subs) {
      try {
        fn(eff, prev);
      } catch (err) {
        setTimeout(() => {
          throw err;
        });
      }
    }
  }

  /**
   * Put a chip up, and tell everything that cares.
   *
   * The subscribers are called in a `try` each, and a thrower is re-raised on its own
   * turn of the loop rather than here: three panes share this call, and one of them
   * failing must not leave the other two believing they are still on screen — which
   * with a parked poll each is not a cosmetic difference. Re-raising asynchronously is
   * what keeps public/report.js's `error` handler seeing it, so the failure is still a
   * P0 bead rather than something swallowed.
   */
  function show(which) {
    if (!known(which)) which = chips[0]?.dataset.tab || '';
    if (!known(which) || which === active) return;
    active = which;
    try {
      localStorage.setItem(KEY, which);
    } catch {
      /* Private mode, or a quota. The chip still moves. */
    }
    for (const c of chips) {
      const on = c.dataset.tab === which;
      c.setAttribute('aria-pressed', String(on));
      const pane = paneOf.get(c.dataset.tab);
      if (pane) pane.hidden = !on;
    }
    address.write(which);
    announce();
  }

  /**
   * The pane went away, or came back (the shell only).
   *
   * The chip is left exactly where it was: coming back to this view is not a reset, and
   * `active` is what the address and the store both hold. All that moves is whether the
   * sections are being looked at.
   */
  function setVisible(on) {
    if (visible === Boolean(on)) return;
    visible = Boolean(on);
    // Back on screen, so the chip belongs on the address again: a pill tap writes the bare
    // `#advocates`, exactly as it does for the ledger's filters.
    if (visible) address.write(active);
    announce();
  }

  tabsEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tab]');
    if (b) show(b.dataset.tab);
  });

  /**
   * One answered poll, handed to every section that asked for one.
   *
   * Every one of them, not only the one that is up: each already knows which parts of a
   * wake are free and which cost a request, and the roster's snapshot is the free half
   * that must keep arriving while the pane is hidden (see the header). Contained per
   * section, for the reason the swap above is — one throwing is one section's screen, and
   * the others are mid-fan-out behind it.
   *
   * The shape is public/panestage.js's fan-out argument, which is `follow`'s own `onWake`
   * argument, so a section registers the same function here that it hands its own mount on
   * the document. One handler under one name rather than two free to drift.
   */
  function wake(w) {
    for (const fn of wakes) {
      try {
        fn(w);
      } catch (err) {
        console.error('[montabs] a section failed on a wake', err);
      }
    }
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.monTabs = {
    show,
    /** Which chip is up, or null before the first paint. */
    active: () => active,
    /**
     * Be told which chip is up, now and whenever it changes.
     *
     * `fn(which, prev)` — `prev` is null on the boot call, which is the handle a pane
     * needs to tell "I am being shown for the first time" from "I am being come back
     * to". Registering after the first paint calls back immediately, so load order
     * between this file and its panes is not a thing anybody has to hold in their head.
     */
    onChange(fn) {
      if (typeof fn !== 'function') return;
      subs.push(fn);
      if (told) fn(told, null);
    },
    /**
     * Whether a chip's section is the thing being looked at.
     *
     * The chip being up is not enough in the shell: the pane it is in can be hidden, and a
     * section that read its own `hidden` attribute would go on sweeping `gh` behind Home.
     * Sections reach for this with `?.` and fall back to their own `hidden`, which is what
     * a service worker cache from before this bead would give them.
     */
    up,
    /**
     * A section asking to be handed the document's poll.
     *
     * Registered by all three unconditionally: on monitor.html nothing calls `wake` — each
     * section owns its own `follow` there — and in the shell public/panestage.js calls it
     * and no section opens a socket at all. Exactly one of the two fires in either
     * document, which is what keeps one page from holding four parked requests.
     */
    onWake(fn) {
      if (typeof fn === 'function') wakes.push(fn);
    },
  };

  /**
   * Put the remembered chip up. The whole of this pane's boot.
   *
   * On the document it is `DOMContentLoaded` and always has been — every section is a
   * plain `<script>` at the foot of monitor.html, so that is the first moment all of them
   * have registered. In the shell it is whenever the stager gets to this pane, which is
   * first if the hash named it and after the first paint if it did not.
   */
  function build() {
    show(initial());
    /* `show` returns early when the chip it was going to put up is already `active`, which
       it cannot be at boot — but it can be a no-op if `initial()` answers the empty string
       on a row with no chips, and a pane that never announced would leave its sections
       waiting forever. Cheap and idempotent. */
    announce();
  }

  /*
    Offered to the stager, and built here when there is no stager to take it — monitor.html,
    or a service worker cache from before public/panestage.js existed. `register` answering
    false has to leave this file exactly as it was, which is why `build` is the function it
    would have called on its own rather than something only reachable through the shell.

    `want: 'presence'` beside the `wake`: none of these three draws the inbox's questions,
    so the daemon has no `bd` to sweep on their behalf, and the union in public/panestage.js
    stays at the free park.
  */
  if (!window.beadcause?.stage?.register?.(VIEW, { build, wake, want: 'presence' })) {
    /* After the document's own scripts have run, so every section has registered before
       the first call. They are all plain `<script>`s at the foot of monitor.html, so this
       fires once, after the last of them — and it has always been this line. In the shell
       the stager makes the same guarantee and makes it better, because it also decides
       *whether* this pane is the first one built. */
    document.addEventListener('DOMContentLoaded', build);
  }
  if (inShell) panes.onShow(() => setVisible(panes.showing() === VIEW));
})();
