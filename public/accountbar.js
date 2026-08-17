/*
  The app menu — everything the top bar used to hold loose, behind the mark.

  ## What the trigger is, and why it is the mark

  Beadcause reads every tracker on the Mac, and until accounts existed that meant the
  inbox, the board, the pull requests and the space picker showed work and not-work in
  one list. `spaces` groups them by *when they may interrupt you*, which is a real
  question and not this one. This is the level above: which of your lives the whole app
  is currently about — see lib/accounts.js for the model and for why it is a view scope
  rather than a credential.

  The control was the address itself for a while, as a chip at the right-hand end of the
  bar: the email says both which identity you are in and what the daemon will stamp on
  anything you file (`accountHandles`), where a chip saying "Personal" would need a second
  surface to say the same thing. bc-khoe.5 took the chip out anyway, and the reason is the
  row rather than the address. The space picker had a full-width row of its own under a
  first row that was full, so every standing view carried two rows of sticky chrome; the
  picker is beside the mark now and the chip's width is what paid for it. The address did
  not go — it is the second line of **Switch account**, one tap in, which is where it was
  usually being read from anyway.

  So the trigger is **the mark, in a gear**. It is the one thing already at that end of
  every bar, it is where a settings affordance is on every phone the app is trying to look
  like, and the gear is what says the tap does something other than go home. On a page with
  no mark — every page but the inbox draws a title there instead — the button is the gear
  on its own, in the same place, so the menu is never somewhere new.

  ## What is inside it, and why the buttons moved

  The top right of every page carried between one and four loose icon buttons — refresh,
  the endorsement queue, foundations, the gear, open-in-Chrome — different on every page,
  and on the inbox four of them competing for the width of a thumb. They are rows in this
  menu now, with the words their `aria-label` already had. Nothing about them changed:
  **the nodes are moved, never copied**, so a page script that does
  `getElementById('refresh').addEventListener(…)` after this file has run is still
  wiring the button the person taps. That is the one invariant here worth stating
  outright — a clone would leave every page's chrome dead in a way that looks fine.

  **Refresh is in here too now**, and it is the one row that costs something: ⟳ was kept
  loose in the bar until bc-khoe.5 because it is the most-pressed control in the app, and
  it is two taps from here. That was the trade the bead asked for and it is worth saying
  out loud rather than burying — the bar it bought is one row on every screen.

  **Admin is a row this file draws rather than one it hoists**, because only the advocate
  console ever had a door to it up there. It is skipped on /admin itself and on any page
  that hoisted an `/admin` link of its own — see `admin()`.

  ## Switching, and adding

  "Switch account" opens the picker: one row per account, the active one ticked, and a
  ＋ that opens the form behind it — an address, a name, and the workspaces (and, for the
  one workspace that is forty checkouts, the repos) that account can see. Both write to
  the server: the selection to `state.json` beside the inbox filter, the accounts to
  `config.json`. Neither is per-device, for the reason the filter is not: the push path
  reads the account from inside the poll with no client in the loop, and a phone and a
  laptop should not disagree about which life you are in.

  A switch **reloads the page**, which is a deliberate exception to how the space picker
  behaves. That one repaints in place because every page publishes the rows it is already
  holding and can filter them itself. An account changes what the *server* will hand over
  — questions, spaces, tickets, chats, pull requests, the workspace list behind every
  picker — so every cache on the page is wrong at once, and a reload is both the honest
  and the shortest way to say so. It happens once when you change life, not once a
  minute.

  ## What it does when nothing is configured

  Every install starts with no accounts, and on one the chip draws `cfg.me` — the address
  this Mac already files as — and the picker offers to add the first. Adding one adds
  two: see `withAccount` in lib/accounts.js for why a config with one account and eight
  unclaimed workspaces is not a state this can leave you in.
*/
(() => {
  'use strict';

  const bar = document.querySelector('.topbar');
  if (!bar) return;

  /* The same `?t=` pickup spacebar.js does, and here for the same reason: this file runs
     ahead of the page's own script, so it can be the first thing on the page to want the
     token. Read, never stripped — the page owns the address bar. */
  const token = (() => {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      try {
        localStorage.setItem('beadcause.token', fromUrl);
      } catch {
        /* private mode; the page's own pickup will complain if it matters */
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
    /** `accountRoster()` rows: { email, label, everything, workspaces, repos, active }. */
    accounts: [],
    /** The active address, or null when none is configured. */
    account: null,
    /** Every workspace on the Mac — the form's list, not the scoped one. */
    workspaces: [],
    /** `{ workspace: [repo, …] }`, only for the workspaces that hold more than one. */
    repos: {},
    /** What the chip says when no account is configured: this Mac's own address. */
    me: null,
    known: false,
  };

  /* ------------------------------------------------------------------ the chrome */

  /*
    Inside `.brand`, at the left-hand end, rather than an element of its own at the right:
    the trigger is the mark, and the mark is already there. `.accountbar` is the positioned
    box the menu hangs off — the menu is absolute, and `.brand` itself is shared with a
    page title that must stay free to ellipsise.

    Two shapes, and which one a page gets is decided by whether it has a mark.

      the inbox    <h1 class="mark"><button class="markmenu"><img …><span>⚙</span></button></h1>
      every other  <button class="markmenu markmenu-bare">⚙</button>

    The `<h1>` stays *outside* the button on purpose. A heading is flow content and a
    button takes phrasing, so wrapping the other way round is markup no parser owes us
    anything for — and keeping the `h1` where it was is what keeps `.brand h1.mark img`
    matching, which is the selector public/absorb.js flies every absorbed bead into and
    the one the mark's own styling is written against.
  */
  const brand = bar.querySelector('.brand') || bar;
  const el = document.createElement('div');
  el.className = 'accountbar';
  el.innerHTML = `
    <div class="accountmenu" id="account-menu" role="menu" hidden>
      <div class="accountmenu-actions" id="account-actions"></div>
      <a class="accountmenu-row" id="account-admin" role="menuitem" href="/admin" hidden>
        <span class="accountmenu-glyph" aria-hidden="true">⏸</span>
        <span class="accountmenu-label">Admin</span>
      </a>
      <button type="button" class="accountmenu-row accountmenu-switch" id="account-switch" role="menuitem">
        <span class="accountmenu-glyph" aria-hidden="true">⇄</span>
        <span class="accountmenu-label">Switch account<span class="accountmenu-sub" id="account-who">…</span></span>
      </button>
    </div>`;

  /** The mark's own heading, on the one page that has one. */
  const markHead = brand.querySelector('h1.mark');
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = markHead ? 'markmenu' : 'markmenu markmenu-bare';
  chip.id = 'account-chip';
  chip.setAttribute('aria-haspopup', 'menu');
  chip.setAttribute('aria-expanded', 'false');
  chip.setAttribute('aria-label', 'Menu — accounts, admin, and what this page can do');
  if (markHead) {
    // The image itself, moved into the button and the button left inside the heading, so
    // the alt text is still what the `<h1>` says the page is.
    const img = markHead.querySelector('img');
    if (img) chip.append(img);
    chip.insertAdjacentHTML('beforeend', '<span class="markmenu-gear" aria-hidden="true">⚙</span>');
    markHead.append(chip);
    el.insertBefore(markHead, el.firstChild);
  } else {
    chip.textContent = '⚙';
    el.insertBefore(chip, el.firstChild);
  }

  /* After the pulse dot and before whatever the page calls itself. The dot is the app's
     "something is happening" light and belongs against the left edge; on the inbox this
     puts the mark back exactly where it already was. */
  const dot = brand.querySelector('.dot');
  if (dot && dot.parentNode === brand) dot.after(el);
  else brand.insertBefore(el, brand.firstChild);

  const who = el.querySelector('#account-who');
  const menu = el.querySelector('#account-menu');
  const actions = el.querySelector('#account-actions');
  const adminRow = el.querySelector('#account-admin');

  /**
   * Move the page's own top-right buttons into the menu.
   *
   * Only `.topbar .sheet-actions`, and only the `.icon-btn`s inside it: `.sheet-actions`
   * is also the class on a card's own action row (the bead sheet, the graph's panel), and
   * a selector without the `.topbar` in front of it would empty those into a menu that is
   * nowhere near them. Anything else living up there — the monitor's tally, the
   * `⦿ observing` marker — is a fact rather than a control and stays where it is.
   *
   * The label is the `aria-label` up to its first em dash, which is how every one of them
   * is already written: "Endorsement queue — beads an agent filed, waiting on you". The
   * whole string stays on the button as its title, so the long half is still readable.
   */
  function hoist() {
    const row = document.querySelector('.topbar .sheet-actions');
    if (!row) return;
    /* ⟳ used to be exempt, and is not any more (bc-khoe.5). It was kept in the bar
       because it is the control pressed most often and the least worth two taps — and,
       the reason that would not have been guessed, because it was the last piece of text
       on the inbox the app itself had written in exactly one place. Edit mode is
       *retyping the app's own words* (public/editmode.js) and it freezes the screen, so
       nothing behind a tap-to-open menu can be reached from inside it, and hoisting this
       one as well once left that screen with nothing retypable on it at all.

       Both halves are answered now rather than argued away. The bar is one row and has
       no loose buttons on it at all, so an exemption would have been a single icon
       floating between the mark and the picker — which is the shape the row was
       flattened to get rid of. And `scripts/editgesture-check.mjs` opens this menu
       through `beadcause.account.menu()` before it goes looking for something to retype,
       so the labels in here are what it finds; the check that noticed the hole is the
       check that now covers it. The cost stands as filed: refresh is two taps. */
    for (const btn of [...row.querySelectorAll('.icon-btn')]) {
      const item = document.createElement('span');
      item.className = 'accountmenu-row accountmenu-item';
      item.setAttribute('role', 'menuitem');
      const label = document.createElement('span');
      label.className = 'accountmenu-label';
      label.textContent = String(btn.getAttribute('aria-label') || btn.textContent || '').split('—')[0].trim();
      // The node itself, moved. Cloning it would leave every page script wired to an
      // element nobody can see, and the page would look right while nothing worked.
      item.append(btn, label);
      // The words are half the target on a phone, so the row forwards to the button —
      // which is a `<button>` on some pages and an `<a>` on others, and `.click()` is the
      // one call that does the right thing for both.
      item.addEventListener('click', (e) => {
        // Not while the screen is deliberately held still. Edit mode (public/editmode.js)
        // is a state in which a tap points at an element rather than acting on it, and
        // this row would otherwise do both: fire the button it holds, and shut the menu
        // out from under the thumb that was aiming at it — taking a `contenteditable`
        // the mode had just opened with it.
        if (frozen()) return;
        if (e.target !== btn && !btn.contains(e.target)) btn.click();
        close();
      });
      actions.append(item);
    }
    // Emptied, not removed: pages measure their own header and one of them (the monitor)
    // puts a tally back into it on every poll.
    row.classList.add('hoisted');
  }

  /**
   * Whether the standing **Admin** row is drawn.
   *
   * Two pages answer no, for different reasons. On /admin it would be a row that goes
   * where you already are. And on a page carrying a door of its own — the advocate
   * console's ⚙, which is an `<a href="/admin">` and has been hoisted into this very menu
   * a moment ago — it would be the second Admin row in one menu, which reads as two
   * different places. The page's own wins because it is the one with the longer label and
   * the one every existing check names.
   */
  function admin() {
    const here = /^\/admin(\.html)?\/?$/.test(location.pathname);
    const already = actions.querySelector('a[href="/admin"], a[href="/admin.html"]');
    adminRow.hidden = Boolean(here || already);
  }

  /* -------------------------------------------------------------------- the menu */

  /** Is the page being held still by edit mode? False on a page that has never heard of it. */
  const frozen = () => Boolean(window.beadcause?.editMode?.frozen?.());

  const open = () => {
    menu.hidden = false;
    chip.setAttribute('aria-expanded', 'true');
  };
  const close = () => {
    menu.hidden = true;
    chip.setAttribute('aria-expanded', 'false');
  };
  const toggle = () => (menu.hidden ? open() : close());

  chip.addEventListener('click', (e) => {
    e.stopPropagation();
    // Same rule as the rows: a frozen screen is being pointed at, not pressed. `menu()`
    // on the API below is the way in for anything that has to open it anyway.
    if (frozen()) return;
    toggle();
  });
  // A tap anywhere else shuts it. On the document rather than on a backdrop element: a
  // backdrop over a phone's whole screen would eat the first tap of whatever you were
  // actually reaching for, which is the wrong trade for a menu you open by accident.
  document.addEventListener('click', (e) => {
    if (frozen()) return;
    if (!menu.hidden && !el.contains(e.target)) close();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) close();
  });

  /* ------------------------------------------------------------------ the picker */

  const dlg = document.createElement('dialog');
  dlg.className = 'accountpick';
  dlg.innerHTML = `<div class="accountpick-body" id="accountpick-body"></div>`;
  document.body.append(dlg);
  const body = dlg.querySelector('#accountpick-body');

  const showPicker = () => {
    paintPicker();
    if (!dlg.open) dlg.showModal();
  };

  /** "3 repos", "everything" — what a row says it can see, in the fewest words. */
  const scopeOf = (a) =>
    a.everything ? 'every workspace' : `${a.workspaces.length} workspace${a.workspaces.length === 1 ? '' : 's'}`;

  function paintPicker() {
    const rows = state.accounts
      .map(
        (a) => `
        <li class="accountpick-row${a.active ? ' on' : ''}">
          <button type="button" class="accountpick-pick" data-email="${esc(a.email)}">
            <span class="accountpick-tick" aria-hidden="true">${a.active ? '✓' : ''}</span>
            <span class="accountpick-who">
              <strong>${esc(a.label)}</strong>
              <span class="accountpick-mail">${esc(a.email)}</span>
              <span class="accountpick-scope">${esc(scopeOf(a))}</span>
            </span>
          </button>
          <button type="button" class="accountpick-edit" data-edit="${esc(a.email)}" aria-label="Edit ${esc(a.email)}">✎</button>
        </li>`
      )
      .join('');
    body.innerHTML = `
      <h2 class="accountpick-title">Accounts</h2>
      <p class="accountpick-lede">One at a time. What the account you are in can see is the
        whole of what this app shows — the others are not hidden behind a filter, they are
        not on the screen at all.</p>
      <ul class="accountpick-list">${rows || '<li class="accountpick-none">No accounts yet — every workspace is in scope.</li>'}</ul>
      <div class="accountpick-actions">
        <button type="button" class="accountpick-add" id="accountpick-add">＋ Add account</button>
        <button type="button" class="accountpick-close" id="accountpick-close">Close</button>
      </div>`;
    body.querySelector('#accountpick-close').addEventListener('click', () => dlg.close());
    body.querySelector('#accountpick-add').addEventListener('click', () => paintForm(null));
    for (const b of body.querySelectorAll('[data-email]')) {
      b.addEventListener('click', () => switchTo(b.getAttribute('data-email')));
    }
    for (const b of body.querySelectorAll('[data-edit]')) {
      b.addEventListener('click', () =>
        paintForm(state.accounts.find((a) => a.email === b.getAttribute('data-edit')) || null)
      );
    }
  }

  /**
   * The form behind ＋, and behind the ✎ on a row.
   *
   * Two questions and a list: what the address is, what to call it, and which workspaces
   * it can see. The repos under a workspace are the second grain and only appear for a
   * workspace that has more than one checkout approved — which on almost every install is
   * none of them, so almost every install sees a flat list of repos and never learns
   * there is a level below it.
   */
  function paintForm(account) {
    // A new account starts with nothing ticked, an existing one with what it has. The
    // asymmetry is the point: what you tick here is what this account *takes*, and a form
    // that opened with everything already taken would make the common mistake — one
    // account owning the lot and the other owning nothing — the default one.
    const chosen = new Set(account ? (account.everything ? state.workspaces : account.workspaces) : []);
    const repos = account?.repos || {};
    const wsRows = state.workspaces
      .map((w) => {
        const inner = (state.repos[w] || [])
          .map(
            (r) => `
            <label class="accountform-repo">
              <input type="checkbox" data-repo="${esc(w)}" value="${esc(r)}"
                ${chosen.has(w) ? '' : 'disabled'}
                ${!repos[w] || repos[w].includes(r) ? 'checked' : ''}>
              <span>${esc(r)}</span>
            </label>`
          )
          .join('');
        return `
        <li class="accountform-ws">
          <label class="accountform-pick">
            <input type="checkbox" data-ws value="${esc(w)}" ${chosen.has(w) ? 'checked' : ''}>
            <strong>${esc(w)}</strong>
          </label>
          ${inner ? `<div class="accountform-repos">${inner}</div>` : ''}
        </li>`;
      })
      .join('');

    body.innerHTML = `
      <h2 class="accountpick-title">${account ? 'Edit account' : 'Add an account'}</h2>
      <label class="accountform-field">
        <span>Email address</span>
        <input type="email" id="accountform-email" inputmode="email" autocapitalize="off"
          autocorrect="off" spellcheck="false" value="${esc(account?.email || '')}"
          ${account ? 'readonly' : 'placeholder="you@example.com"'}>
      </label>
      <label class="accountform-field">
        <span>Name</span>
        <input type="text" id="accountform-label" value="${esc(account?.label || '')}" placeholder="Personal">
      </label>
      <p class="accountpick-lede">Which workspaces this account can see. Everything left
        unticked belongs to your other accounts and will not appear anywhere while this one
        is in force.</p>
      <ul class="accountform-list">${wsRows}</ul>
      <div class="accountpick-actions">
        <button type="button" class="accountpick-add" id="accountform-save">Save</button>
        ${account ? '<button type="button" class="accountpick-remove" id="accountform-remove">Remove</button>' : ''}
        <button type="button" class="accountpick-close" id="accountform-back">Back</button>
      </div>
      <p class="accountform-error" id="accountform-error" hidden></p>`;

    // The repos inside a workspace are only a question once the workspace itself is taken.
    // Disabled rather than hidden, so the shape of what is in there is still readable
    // while you decide — and so ticking the workspace does not make four rows appear
    // under a thumb that was aiming at the next one.
    for (const box of body.querySelectorAll('[data-ws]')) {
      box.addEventListener('change', () => {
        for (const repo of body.querySelectorAll(`[data-repo="${CSS.escape(box.value)}"]`)) repo.disabled = !box.checked;
      });
    }
    body.querySelector('#accountform-back').addEventListener('click', paintPicker);
    body.querySelector('#accountform-save').addEventListener('click', save);
    body.querySelector('#accountform-remove')?.addEventListener('click', () => remove(account.email));

    function save() {
      const email = body.querySelector('#accountform-email').value.trim();
      const label = body.querySelector('#accountform-label').value.trim();
      const workspaces = [...body.querySelectorAll('[data-ws]')].filter((i) => i.checked).map((i) => i.value);
      // An account owning no workspace at all is a screen with nothing on it and no
      // control that widens — the daemon would store it happily, which is exactly why the
      // refusal belongs here, next to the ticks.
      if (!workspaces.length) return fail('Pick at least one workspace for this account.');
      const picked = {};
      for (const [ws, all] of Object.entries(state.repos)) {
        if (!workspaces.includes(ws)) continue;
        const on = [...body.querySelectorAll(`[data-repo="${CSS.escape(ws)}"]`)]
          .filter((i) => i.checked)
          .map((i) => i.value);
        // Only when it is actually a narrowing. "All of them" is what an absent entry
        // already means, and writing it out would freeze the list at today's checkouts —
        // a repo approved next month would be invisible to an account that had said yes
        // to every repo there was.
        if (on.length && on.length < all.length) picked[ws] = on;
      }
      post('/api/accounts', 'POST', { email, label, workspaces, repos: picked });
    }
  }

  const fail = (msg) => {
    const p = body.querySelector('#accountform-error');
    if (!p) return;
    p.textContent = msg;
    p.hidden = false;
  };

  async function post(path, method, payload) {
    try {
      const res = await fetch(path, {
        method,
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return fail(data.error || `the daemon said ${res.status}`);
      // Everything the warm layer is holding was fetched for the account you were in a
      // second ago, and several of those payloads are narrowed server-side by which
      // account you are — so they are not this one's to paint. Dropped before the reload
      // rather than left to be corrected by the fetch behind it, because the whole
      // promise of that layer is a *first frame* drawn from what is held, and a first
      // frame of somebody else's inbox is the one thing it must never draw. It mattered
      // less when the store died with the tab (public/warm.js); since bc-1kwl.14 it does
      // not die, so every moment a held payload stops being yours has to say so.
      window.beadcause?.warm?.forget?.();
      // Everything on this page was fetched for the account you were in a second ago —
      // see the header. The reload is the change taking effect, not a fallback.
      location.reload();
    } catch {
      fail('the daemon is not answering');
    }
  }

  const switchTo = (email) => {
    if (email === state.account) return dlg.close();
    post('/api/account', 'POST', { email });
  };
  const remove = (email) => post('/api/accounts', 'DELETE', { email });

  el.querySelector('#account-switch').addEventListener('click', () => {
    close();
    showPicker();
  });

  /* --------------------------------------------------------------- coming in */

  function paint() {
    /* The address is the second line of **Switch account** rather than a chip on the bar
       (see the header). Which means it is one tap from every screen instead of nought, and
       the row it is on is the row that changes it — the two things you want the address
       for are "which am I" and "not this one", and they are now the same target. */
    const label = state.account || state.me || 'no account yet';
    /* "not set" leads, because with nothing configured what is drawn is the address this
       Mac already files as rather than a choice anybody made, and the line ellipsises from
       the right — so the half that says which it is has to be the half that survives. The
       chip that used to draw this said the same thing by going grey, which is a distinction
       nobody has ever read off a colour. */
    who.textContent = state.account ? label : `not set · ${label}`;
    chip.title = state.account
      ? `${label} — accounts, admin, and what this page can do`
      : 'No account configured — every workspace is in scope';
  }

  /**
   * What a page already knows, fed in rather than waited for. The inbox carries the
   * roster on `/api/questions`, and it publishes it here — so the chip is right in the
   * first paint rather than after a round trip, which on a phone is the difference
   * between a chip and a chip that flickers.
   *
   * Field by field, and every field optional: a page publishes the two it has and never
   * the three the *form* needs, which come from `/api/accounts` below. There is no weak
   * adoption here — unlike the space picker, whose fetch and whose page can disagree
   * about a filter that has just been tapped, everything on this payload is server-owned
   * and the two sources cannot say different things about it.
   */
  function adopt(data = {}) {
    if (!data || typeof data !== 'object') return;
    if (data.account !== undefined) state.account = data.account || null;
    if (Array.isArray(data.accounts)) state.accounts = data.accounts;
    if (Array.isArray(data.workspaces)) state.workspaces = data.workspaces;
    if (data.repos && typeof data.repos === 'object') state.repos = data.repos;
    if (typeof data.me === 'string') state.me = data.me;
    state.known = true;
    paint();
  }

  /**
   * The three fields no page's payload carries: every workspace on the Mac, the repos
   * inside the ones that hold more than one, and this Mac's own address.
   *
   * The first is why this fetch exists at all. A page's own payload carries the
   * *scoped* workspace list — the account's — and a form built from that could only ever
   * offer the workspaces you can already see, which is the one list an add-an-account
   * form must not be built from.
   */
  async function load() {
    if (!token) return;
    try {
      const res = await fetch('/api/accounts', { headers: { 'x-beadcause-token': token } });
      if (!res.ok) return;
      adopt(await res.json());
    } catch {
      /* the daemon is not answering; the chip stays as it was */
    }
  }

  hoist();
  admin();
  paint();
  load();

  /**
   * The page's hook. `adopt` is what the inbox calls with the payload it already has;
   * `accounts()` is for anything that wants to know which life it is drawing.
   */
  window.beadcause = window.beadcause || {};
  window.beadcause.account = {
    adopt,
    current: () => state.account,
    accounts: () => state.accounts.slice(),
    open: showPicker,
    /**
     * Open the menu without a tap.
     *
     * For the one caller that cannot tap: `scripts/editgesture-check.mjs` drives edit
     * mode, and edit mode intercepts a tap by design — it points at an element rather
     * than acting on it. The page's own actions live in this menu now, so a check that
     * could not open it could not see them at all.
     */
    menu: open,
  };
})();
