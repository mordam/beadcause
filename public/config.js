/*
  The selected space's settings, as a view of its own (bc-khoe.10).

  ## Why it is a page and not a chip

  These controls have moved twice. They were the first card on the advocate console, above
  the advocates that page is named for — eleven switches and a row per repo, which put the
  first advocate below the fold of a phone. bc-me2b took them off that roster and gave them
  a `Config` chip on the same page, which fixed the fold and left the harder half in place:
  they were still *inside* the console, reachable only from the page you open to see what
  is running this minute, and only by knowing that a second row of chips on that one page
  meant something different from the row of pills above it.

  So they are a pill on the row now, like every other place in the app. What that buys is
  not the tap it saves — it is that "what this space *is*" and "what this space is
  *doing*" stop being two modes of one screen. The console is the second, and it is a
  screen you watch; this is the first, and it is a screen you visit about once a month
  because you already know something is set wrong.

  ## What it costs, and what it does not

  Nothing here sweeps. `/api/space` is a read of the daemon's own config object — no `bd`,
  no `gh`, no disk — where the console's payload is two `bd` calls per workspace. That is
  the whole reason this can be a page without being an expensive one: it was already the
  cheapest thing the console fetched, and it is the only thing this document asks for.

  It follows no event stream, for the reason public/history.js follows none. The one
  request it makes carries the space picker's current selection (`?space=`), so there is no
  constant path for public/warm.js to fill and no first frame to arrive early — and the
  settings themselves are changed from here or from the config file, neither of which a
  wake would tell it about sooner than the ⟳ in the bar. What it does listen to is the
  picker: a different space is a different config, and that is a fetch rather than a
  repaint.

  ## The observer

  A second instance that only watches may read these and may not write them: its `cfg` is
  the acting daemon's config file, so a press here would change what that *other* process
  does at its next restart and nothing at all about what it is doing now. `POST /api/space`
  refuses it either way; the controls are drawn disabled so the refusal is not something
  you find out by pressing. The flag rides on `GET /api/space` beside the settings, which
  is the bargain `/api/prs` already makes — one boolean on a payload the page was fetching
  anyway, rather than a second request for one bit.
*/
(() => {
  /* The pairing token, picked out of `?t=` once and kept — the same pickup every page in
     the app does, and the reason a link in a notification works on a phone that has never
     scanned the QR. */
  const token = (() => {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    return localStorage.getItem('beadcause.token') || '';
  })();

  const out = document.getElementById('space');
  const pulse = document.getElementById('pulse');
  const observing = document.getElementById('observing');

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  function readOpen() {
    try {
      return JSON.parse(localStorage.getItem('beadcause.mon.open') || '[]');
    } catch {
      return [];
    }
  }

  const state = {
    /** The selected space's own configuration — see `/api/space` and `spaceHtml`. */
    space: null,
    /** Why there is no card, when there is none: the synthetic `Other` group is a 404. */
    spaceError: null,
    /** What the last write said, kept on the card until the next one. */
    spaceSaid: null, // { text, bad }
    /** The Slack channel mid-type, held here rather than in the DOM — see `onInput`. */
    slackDraft: null, // { space, text }
    /** Is this instance one that only watches? Off `/api/space`. */
    observing: false,
    /* Which panels are unfolded, under the console's own key and deliberately so: these
       are the same two panels they have always been, and somebody who left Settings open
       on the screen this card used to be part of should find it open here. */
    open: new Set(readOpen()),
  };

  const isOpen = (key) => state.open.has(key);

  function toggle(key) {
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    localStorage.setItem('beadcause.mon.open', JSON.stringify([...state.open]));
  }

  /** A collapsible section. `count` sits in the summary so a shut panel still counts. */
  function section(key, title, count, body, { tone = '', badge = '' } = {}) {
    const open = isOpen(key);
    return `<div class="mon-sec${open ? ' open' : ''}">
      <button class="mon-sum" data-toggle="${esc(key)}" aria-expanded="${open}">
        <span class="mon-caret" aria-hidden="true">▾</span>
        <span class="mon-sum-title">${esc(title)}</span>
        ${count ? `<span class="mon-n${tone ? ` ${tone}` : ''}">${esc(count)}</span>` : ''}
        ${badge}
      </button>
      ${open ? `<div class="mon-body">${body}</div>` : ''}
    </div>`;
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: {
        'x-beadcause-token': token,
        ...(opts.body ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers || {}),
      },
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    return res.json();
  }

  /* ------------------------------------------------------- the space's own settings

     The whole of what this page is, and it was one card on the advocate console until
     bc-khoe.10 — unchanged in every respect except which document draws it.

     Every one of these already existed and every one of them was a config hand-edit:
     `quietHours`, `quietDays`, `ntfyDetail` and `autoDispatch` have been read out of
     lib/spaces.js since spaces were invented, `autoMerge`/`requireApproval` joined them
     with the per-space PR policy, `autoEndorse` — whether a bead an agent filed here
     may be worked before you have read it — joined them after that, and `autoShip` joined
     them with the release queue that deploys a merge without being tapped. Editing them
     meant opening
     `~/.beadcause/config.json` on the Mac — which is exactly the wrong place, because
     the moment you know a setting is wrong is the moment you are looking at what it
     did, on a phone, at the weekend.

     Three shapes of control, and the difference between them is the shape of the
     answer, not a style choice:

     - **Muted** is two-state. There is no global "mute everything" behind it, so
       "not set" and "off" are the same thing and a third button would be a lie.
     - **The seven with a global behind them** are three-state — On, Off, *Inherit* —
       because `prPolicyFor` is explicit that a space may override the global in either
       direction, so "off" and "following the default, which is off" are different
       answers that must survive the default changing under them. The Inherit button
       says what it currently resolves to rather than the word alone. `autoEndorse` is
       one of them and its global default is `off` rather than on, which is the whole
       reason Inherit names what it resolves to instead of saying "Inherit".
     - **Quiet hours and quiet days** are a pair of times and a row of days, each
       clearable, because "no quiet hours" is a state you have to be able to get back
       to and deleting the key is the only way there.
     - **The Slack channel** is the only one you type, and it has three answers rather
       than two: a channel id, *Never* — which stores an empty string and means this
       space stays out of Slack however the global is set — and *Inherit*. Never and
       Inherit look identical on the day you press them and come apart the day
       `slack.channel` changes, which is the whole reason both buttons are there.
  */

  /** The name of the space this page is about, or null when nothing is narrowed to one. */
  const spaceName = () => {
    const f = window.beadcause?.space?.filter;
    return f && f.space && f.space !== 'all' ? f.space : null;
  };

  /**
   * The one repo the picker is pinned to, or null when the whole space is selected.
   *
   * The picker has two levels and the settings card only ever read the coarse one: pick
   * `beadcause` and it stores `{space: 'Personal', workspace: 'beadcause'}`, the card
   * asked `spaceName()` for the space, and what it drew was Personal — every setting of
   * it, and a row each for beadcause, deluvia, ehatt and sophab. The settings are
   * genuinely the space's and stay whole. The rows are not: you narrowed to one repo,
   * and a panel headed "what each repo resolves to" listing three you did not pick is
   * the console answering a question about somebody else's config (bc-me2b).
   *
   * Deliberately not `inSpace`, which is the *row* filter the advocate console narrows its
   * lists by. That one resolves a name through `spaceOf`, and a name in `d.missing` is by
   * definition not a configured workspace — so `spaceOf` calls it 'Other' and `inSpace`
   * would drop the drift warning off a card that is narrowed to nothing but a space. The
   * question here is only ever "is the picker pinned to a repo", so it is asked directly.
   */
  const onlyRepo = () => {
    const f = window.beadcause?.space?.filter;
    return f && f.workspace && f.workspace !== 'all' ? f.workspace : null;
  };

  const DAYS = [
    ['mon', 'M'],
    ['tue', 'T'],
    ['wed', 'W'],
    ['thu', 'T'],
    ['fri', 'F'],
    ['sat', 'S'],
    ['sun', 'S'],
  ];

  /** `true` → "on". The word a control is set to, and the word Inherit resolves to. */
  const onOff = (v) => (v ? 'on' : 'off');

  /**
   * One three-state row: On, Off, and Inherit — which names what it inherits *to*.
   *
   * `data-value` travels as a string because a data attribute is one; `saveSpace`
   * turns `"null"` back into the JSON null that means "clear this key", which is the
   * one value the server reads as "go back to the global".
   */
  function tri(field, label, help, value, inherited) {
    const btn = (v, text, title) =>
      `<button class="adv-btn${value === v ? ' on' : ''}" data-space-set="${esc(field)}" data-value="${esc(
        String(v)
      )}" title="${esc(title)}">${esc(text)}</button>`;
    return `<div class="space-row">
      <div class="space-row-head">
        <span class="space-what">${esc(label)}</span>
        <span class="space-state ${value === null ? 'dim' : value ? 'live' : 'held'}">${
          value === null ? `inherited · ${esc(onOff(inherited))}` : esc(onOff(value))
        }</span>
      </div>
      <p class="space-help">${esc(help)}</p>
      <div class="space-btns">
        ${btn(true, 'On', `${label} — on for this space, whatever the global says`)}
        ${btn(false, 'Off', `${label} — off for this space, whatever the global says`)}
        ${btn(null, `Inherit (${onOff(inherited)})`, `Follow the global default, which is currently ${onOff(inherited)}`)}
      </div>
    </div>`;
  }

  /**
   * The four settings a repo row may answer for itself, in the order they happen to
   * work: a filing arrives, a pull request merges, a review gates that merge, the merge
   * deploys. Reading down a row is reading the life of one piece of work.
   *
   * `on`/`off` are the sentences the *buttons* promise, so each one says what pressing
   * it does to this repo rather than naming the field again — a title reading
   * "autoShip — on" tells you nothing you could not see.
   *
   * The keys are `WORKSPACE_SETTINGS` in lib/spaces.js and the server refuses anything
   * else, so a typo here is a 400 rather than a setting silently written nowhere.
   */
  const REPO_SETTINGS = [
    {
      key: 'autoEndorse',
      what: 'Beads agents file here',
      on: 'files arrive endorsed, whatever the space says',
      off: 'files stay held for a tap, whatever the space says',
    },
    {
      key: 'autoMerge',
      what: 'Workers merge their own work',
      on: 'a worker merges its own pull request once the checks are green',
      off: 'every delivery hands you the pull request instead',
    },
    {
      key: 'requireApproval',
      what: 'An approving review first',
      // Only bites while the row above it is on: with auto-merge off every delivery is
      // already a question, and answering it *is* the approval. Said on the row rather
      // than hiding the buttons — the answer is still stored, and it is the one that
      // applies the moment auto-merge goes back on.
      moot: (r) => !r.autoMerge,
      on: 'green checks are not enough — the pull request needs an approving review',
      off: 'green checks are enough',
    },
    {
      key: 'autoShip',
      what: 'Merges ship themselves',
      on: 'a merge runs this repo’s deploy without waiting for Ship',
      off: 'a merge waits for the Ship button',
    },
  ];

  /**
   * The same three-state control as `tri`, one level down: this repo's own answer, which
   * outranks its space's.
   *
   * Its own function rather than a fourth argument to `tri` because the two write to
   * different things — `tri` posts `{ space, settings }` and this posts
   * `{ space, workspace, settings }` — and the press handlers have to be able to tell
   * them apart from the DOM alone. `data-repo-set` is that difference, and it also keeps
   * these buttons out of the `[data-space-set]` handler, which would have sent a repo's
   * press as the whole space's answer: the exact bug this feature exists to end.
   *
   * Inherit names what it resolves to *through the space*, not the global — `Inherit
   * (on)` on a repo inside an endorsing space is the truth, and reading the global there
   * would be a button promising the opposite of what pressing it does. `r.inherits`
   * carries that per field; `r.own` is `null` for every field this repo leaves alone,
   * which is what puts Inherit on.
   *
   * A row whose payload predates `own`/`inherits` draws nothing rather than four rows of
   * buttons that would all read Inherit (off) and write the wrong answer on a press — the
   * same reasoning the server side gives for treating an unreadable override as absent.
   */
  function repoTri(r) {
    if (!r.own || !r.inherits) return '';
    return REPO_SETTINGS.map((s) => {
      const own = r.own[s.key] ?? null;
      const inherited = Boolean(r.inherits[s.key]);
      const btn = (v, text, title) =>
        `<button class="adv-btn${own === v ? ' on' : ''}" data-repo-set="${esc(s.key)}" data-repo="${esc(
          r.name
        )}" data-value="${esc(String(v))}" title="${esc(title)}">${esc(text)}</button>`;
      return `<div class="space-repo-set">
      <span class="space-repo-what">${esc(s.what)}${s.moot?.(r) ? ' <span class="space-repo-moot">— moot; the merge is yours</span>' : ''}</span>
      ${btn(true, 'On', `${r.name} — ${s.on}`)}
      ${btn(false, 'Off', `${r.name} — ${s.off}`)}
      ${btn(null, `Inherit (${onOff(inherited)})`, `Follow the space, which is currently ${onOff(inherited)}`)}
    </div>`;
    }).join('');
  }

  /**
   * The whole settings card for the selected space.
   *
   * The whole of what this document draws, so `render` is one assignment. Its two panels
   * are still shut by default and still remembered in `beadcause.mon.open`: you arrive
   * here knowing which of the two you came to change, and a card that opened both would
   * be a screenful of controls to scroll past to reach the one you wanted.
   */
  function spaceHtml() {
    const name = spaceName();
    if (!name) {
      // Not an error and not worth a card: nothing is narrowed, so there is no one
      // space whose settings these would be. The picker in the bar above is the fix,
      // and saying so once is cheaper than drawing a card of controls that write nowhere.
      return `<p class="subtitle space-none">Pick a space in the bar above to see and change its settings.</p>`;
    }
    if (state.spaceError) {
      // The synthetic "Other" group lands here: it is a place the picker offers, not a
      // thing with settings, and the server 404s it rather than inventing one.
      return `<article class="card work-card mon-card plain space-card">
        <div class="work-head"><h2>${esc(name)}</h2><span class="mon-state dim">no settings</span></div>
        <p class="subtitle">${esc(state.spaceError)}${
          name === 'Other'
            ? ' — repos in no configured space follow the global defaults, and there is nothing here to set on them.'
            : ''
        }</p>
      </article>`;
    }
    const d = state.space;
    if (!d || d.space !== name) return '<p class="subtitle space-none">Reading this space…</p>';

    const s = d.settings;
    const g = d.defaults;
    const quiet = d.effective;

    const head = quiet.muted
      ? { text: 'muted — questions still arrive, the phone stays dark', tone: 'held' }
      : quiet.quiet
        ? {
            text: `quiet${quiet.quietUntil ? ` until ${new Date(quiet.quietUntil).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : ''}`,
            tone: 'held',
          }
        : { text: 'may reach you', tone: 'live' };

    const days = s.quietDays || [];
    // Only this space's — switching space while a channel is half-typed is a different
    // answer to a different question, and carrying it across would be the card showing
    // you one space's channel under another space's name.
    const draft = state.slackDraft?.space === name ? state.slackDraft.text : null;
    const rows = [
      `<div class="space-row">
        <div class="space-row-head">
          <span class="space-what">Muted</span>
          <span class="space-state ${s.muted ? 'held' : 'dim'}">${s.muted ? 'on' : 'off'}</span>
        </div>
        <p class="space-help">Never light the phone up for this space. Its questions still arrive, still list, still count — see lib/spaces.js.</p>
        <div class="space-btns">
          <button class="adv-btn${s.muted ? ' on' : ''}" data-space-set="muted" data-value="true">Mute</button>
          <button class="adv-btn${s.muted ? '' : ' on'}" data-space-set="muted" data-value="null">Unmute</button>
        </div>
      </div>`,

      `<div class="space-row">
        <div class="space-row-head">
          <span class="space-what">Quiet hours</span>
          <span class="space-state ${s.quietHours ? 'held' : 'dim'}">${
            s.quietHours ? `${esc(s.quietHours.from)} → ${esc(s.quietHours.to)}` : 'none'
          }</span>
        </div>
        <p class="space-help">Local time, and a window that crosses midnight is the ordinary case: 18:00 → 09:00 is your evening and your night.</p>
        <div class="space-btns space-hours">
          <input type="time" id="qh-from" value="${esc(s.quietHours?.from || '18:00')}" aria-label="Quiet from">
          <span class="space-arrow" aria-hidden="true">→</span>
          <input type="time" id="qh-to" value="${esc(s.quietHours?.to || '09:00')}" aria-label="Quiet until">
          <button class="adv-btn primary" data-space-hours="set">Set</button>
          ${s.quietHours ? '<button class="adv-btn" data-space-hours="clear">Clear</button>' : ''}
        </div>
      </div>`,

      `<div class="space-row">
        <div class="space-row-head">
          <span class="space-what">Quiet days</span>
          <span class="space-state ${days.length ? 'held' : 'dim'}">${days.length ? esc(days.join(', ')) : 'none'}</span>
        </div>
        <p class="space-help">Whole days this space may not interrupt. Tap to toggle.</p>
        <div class="space-btns space-days">
          ${DAYS.map(
            ([id, letter]) =>
              `<button class="adv-btn space-day${days.includes(id) ? ' on' : ''}" data-space-day="${esc(
                id
              )}" aria-pressed="${days.includes(id)}" aria-label="${esc(id)}" title="${esc(id)}">${letter}</button>`
          ).join('')}
        </div>
      </div>`,

      `<div class="space-row">
        <div class="space-row-head">
          <span class="space-what">Push detail</span>
          <span class="space-state ${s.ntfyDetail ? 'live' : 'dim'}">${
            s.ntfyDetail ? esc(s.ntfyDetail) : `inherited · ${esc(g.ntfyDetail)}`
          }</span>
        </div>
        <p class="space-help">What the notification itself says. <b>minimal</b> keeps the bead's words off the relay and sends you a bare "something is waiting".</p>
        <div class="space-btns">
          <button class="adv-btn${s.ntfyDetail === 'full' ? ' on' : ''}" data-space-set="ntfyDetail" data-value="full">Full</button>
          <button class="adv-btn${s.ntfyDetail === 'minimal' ? ' on' : ''}" data-space-set="ntfyDetail" data-value="minimal">Minimal</button>
          <button class="adv-btn${s.ntfyDetail === null ? ' on' : ''}" data-space-set="ntfyDetail" data-value="null">Inherit (${esc(g.ntfyDetail)})</button>
        </div>
      </div>`,

      // The only field on this card that is a free-text id rather than a choice, and the
      // only one whose two ways of saying "nothing" are different answers — see
      // `slackChannelFor`. `Never` writes an empty string and keeps this space out of
      // the channel however `slack.channel` is set; `Inherit` deletes the key. The
      // input's value comes from the draft first, so a repaint mid-type cannot take it.
      `<div class="space-row">
        <div class="space-row-head">
          <span class="space-what">Slack channel</span>
          <span class="space-state ${s.slackChannel ? 'live' : s.slackChannel === '' ? 'held' : 'dim'}">${
            s.slackChannel
              ? esc(s.slackChannel)
              : s.slackChannel === ''
                ? 'never posts'
                : `inherited · ${g.slackChannel ? esc(g.slackChannel) : 'none'}`
          }</span>
        </div>
        <p class="space-help">Where this space's questions are posted, with a button per option — a channel id (<b>C…</b>) or a DM id (<b>D…</b>), not a #name.${
          quiet.slack ? '' : ' <b>Slack is off</b> in the config, so nothing here posts anywhere until it is on.'
        }</p>
        <div class="space-btns space-channel">
          <input type="text" id="slack-channel" value="${esc(draft ?? s.slackChannel ?? '')}" placeholder="${esc(
            g.slackChannel || 'C0123456789'
          )}" aria-label="Slack channel for this space" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
          <button class="adv-btn primary" data-space-channel="set" title="Post this space&#39;s questions to the channel typed here">Set</button>
          <button class="adv-btn${s.slackChannel === '' ? ' on' : ''}" data-space-set="slackChannel" data-value="" title="This space never posts to Slack, whatever the global channel is">Never</button>
          <button class="adv-btn${s.slackChannel === null ? ' on' : ''}" data-space-set="slackChannel" data-value="null" title="Follow the global slack.channel, which is currently ${esc(g.slackChannel || 'unset')}">Inherit (${esc(g.slackChannel || 'none')})</button>
        </div>
      </div>`,

      `<div class="space-row">
        <div class="space-row-head">
          <span class="space-what">Slack detail</span>
          <span class="space-state ${s.slackDetail ? 'live' : 'dim'}">${
            s.slackDetail ? esc(s.slackDetail) : `inherited · ${esc(g.slackDetail)}`
          }</span>
        </div>
        <p class="space-help">How much of the question goes into the channel. <b>minimal</b> posts a nudge and a link with none of the words — the answer for a channel with people in it who should see that a decision is waiting without seeing what it is about.</p>
        <div class="space-btns">
          <button class="adv-btn${s.slackDetail === 'full' ? ' on' : ''}" data-space-set="slackDetail" data-value="full">Full</button>
          <button class="adv-btn${s.slackDetail === 'minimal' ? ' on' : ''}" data-space-set="slackDetail" data-value="minimal">Minimal</button>
          <button class="adv-btn${s.slackDetail === null ? ' on' : ''}" data-space-set="slackDetail" data-value="null">Inherit (${esc(g.slackDetail)})</button>
        </div>
      </div>`,

      tri(
        'autoDispatch',
        'Agents may answer unasked',
        'Whether an unattended agent may reply to comments in this space. The global switch is a veto: with it off, nothing here can turn it back on.',
        s.autoDispatch,
        g.autoDispatch
      ),
      tri(
        'autoEndorse',
        'Beads agents file arrive endorsed',
        'On means a discovery an agent files here is ready work the moment it exists, and an advocate may open a session on it before you have read it. Off is the hold: nothing runs until you tap Endorse.',
        s.autoEndorse,
        g.autoEndorse
      ),
      tri(
        'autoMerge',
        'Workers merge their own pull requests',
        'Off means every delivery hands you the pull request instead of landing it — which is what you want anywhere other people read the diff.',
        s.autoMerge,
        g.autoMerge
      ),
      tri(
        'requireApproval',
        'An approving review first',
        'Only bites while auto-merge is on: with it off every delivery is already a question, and answering it is the approval.',
        s.requireApproval,
        g.requireApproval
      ),
      tri(
        'autoShip',
        'Merges ship themselves',
        'On means a merge runs the repo’s own deploy without waiting for Ship — batched behind a ten-minute settle window, so four merges are one deploy. An epic labelled auto-ship or no-auto-ship overrides this for its own work.',
        s.autoShip,
        g.autoShip
      ),
    ].join('');

    // What each repo actually resolves to, which is not always what the space says:
    // `ntfy.minimalWorkspaces`, `slack.excludeWorkspaces` and `autoDispatchExclude` are
    // per-repo lists that outrank it. A screen that showed only the space's answer would
    // be quietly wrong about exactly the repo that had been singled out.
    //
    // A row is a workspace, and since lib/repos.js that is not always one checkout: a
    // `checkouts` count means this row's single answer governs that many repos of an org
    // sharing one tracker. Saying so is the whole of what the space-is-the-unit decision
    // asks of the screen — one row reading as one repo understated the reach of every
    // setting above it by fortyfold. See the block above `autoDispatchAllowed` in
    // lib/spaces.js.
    //
    // And one of these rows is a *control*. `autoEndorse` is the setting a space is the
    // wrong unit for — the reason to stop holding is "nobody but me reads this tracker",
    // which is a fact about one workspace's graph and not about the five beside it in the
    // same space — so it has a per-workspace override, and this row is where it is set.
    // A row being a workspace is what makes that sound: the override is the same grain as
    // the row and the same grain as the tracker, which is the grain the block above
    // `autoDispatchAllowed` says these answers vary at. It belongs here rather than as a
    // twelfth row above for the reason the panel already exists: the row states the
    // answer for this repo, and until now there was nothing to press on the one line that
    // knew what was wrong. The tag stays beside the buttons and is not made redundant by
    // them: it is the *resolved* answer, and the buttons say which of the three levels
    // gave it.
    //
    // And only the repo you picked, when you picked one — see `onlyRepo`. The settings
    // above stay the whole space's, because they are: pinning the picker to one repo
    // does not make `quietHours` a property of that repo, and a card that redrew them as
    // if it had would be promising a narrowing the config cannot express. What narrows
    // is this panel, which is per-repo already.
    const only = onlyRepo();
    const shown = only ? d.repos.filter((r) => r.name === only) : d.repos;
    const many = shown.filter((r) => typeof r.checkouts === 'number');
    const total = shown.reduce((n, r) => n + (typeof r.checkouts === 'number' ? r.checkouts : 1), 0);
    const repos = shown.length
      ? `<div class="space-repos">${shown
          .map(
            (r) => `<div class="space-repo">
              <div class="space-repo-tags">
              <span class="pill id">${esc(r.name)}</span>
              ${
                typeof r.checkouts === 'number'
                  ? `<span class="tag ${r.checkouts ? 'dim' : 'warn'}">${
                      r.checkouts ? `${r.checkouts} checkout${r.checkouts === 1 ? '' : 's'}, one answer` : 'no checkout resolved'
                    }</span>`
                  : ''
              }
              <span class="tag${r.ntfyDetail === 'minimal' ? ' warn' : ' dim'}">${esc(r.ntfyDetail)} push</span>
              <span class="tag ${r.autoDispatch ? 'ok' : 'dim'}">${r.autoDispatch ? 'agents may answer' : 'no agent replies'}</span>
              <span class="tag ${r.autoEndorse ? 'warn' : 'dim'}">${r.autoEndorse ? 'files endorsed' : 'files held'}</span>
              <span class="tag ${r.autoMerge ? 'ok' : 'warn'}">${r.autoMerge ? 'auto-merge' : 'hands you the PR'}</span>
              ${r.autoMerge && r.requireApproval ? '<span class="tag warn">approval first</span>' : ''}
              <span class="tag ${r.autoShip ? 'ok' : 'dim'}">${r.autoShip ? 'ships itself' : 'waits for Ship'}</span>
              ${
                // Only where Slack is on at all: a "no slack" tag on every repo of every
                // install that has never configured it would be a column of noise about a
                // feature nobody here uses. Where it *is* on, this is the tag that catches
                // `slack.excludeWorkspaces` — the per-repo veto that outranks the space,
                // exactly like `ntfy.minimalWorkspaces` on the row above.
                quiet.slack
                  ? `<span class="tag ${r.slackChannel ? 'ok' : 'warn'}">${
                      r.slackChannel
                        ? `slack ${esc(r.slackChannel)}${r.slackDetail === 'minimal' ? ' · minimal' : ''}`
                        : 'no slack'
                    }</span>`
                  : ''
              }
              </div>
              ${repoTri(r)}
            </div>`
          )
          .join('')}</div>${
          many.length
            ? `<p class="subtitle">${esc(
                many.map((r) => r.name).join(', ')
              )} holds many checkouts sharing one tracker, so the settings above are one answer for all of them — which repo a bead is about does not change them.</p>`
            : ''
        }`
      : only
        ? // The picker sets the space from the repo (`spaceOf` in public/spacebar.js), so
          // a pinned repo its own space does not contain is config that moved under a
          // selection rather than anything you can do from here. Said plainly all the
          // same — "no configured repo is in this space" would be a lie about a space
          // with five.
          `<p class="subtitle">${esc(only)} is not one of this space's repos — pick the space itself above to see the ones that are.</p>`
        : '<p class="subtitle">No configured repo is in this space.</p>';

    const missing = d.missing.length
      ? `<div class="adv-note warn">${esc(d.missing.join(', '))} ${
          d.missing.length === 1 ? 'is named by this space and is not a configured workspace' : 'are named by this space and are not configured workspaces'
        } — config drift, and nothing here reaches them.</div>`
      : '';

    // `work-card` is the padding, and this was the one card on the page without it —
    // every setting in it sat on the card's left border, and the only thing holding the
    // head off the top one was the margin an unstyled <h2> happens to bring. bc-8l74
    // took that margin away to make the head a row, so the class it should always have
    // had is here now. See `.space-card` in public/style.css.
    return `<article class="card work-card mon-card space-card">
      <div class="work-head">
        <h2>${esc(d.space)}</h2>
        <span class="mon-state ${head.tone}">${esc(head.text)}</span>
      </div>
      ${missing}
      ${state.spaceSaid ? `<div class="adv-note${state.spaceSaid.bad ? ' bad' : ''}">${esc(state.spaceSaid.text)}</div>` : ''}
      ${section(`space:${d.space}:cfg`, 'Settings', '', rows)}
      ${section(
        `space:${d.space}:repos`,
        // Narrowed to one repo, "each repo" is a heading over a panel with one row in
        // it, and the reading it invites is that this space has one repo. The fold key
        // is unchanged either way, so a panel you left open stays open across a change
        // of picker.
        only ? `What ${only} resolves to` : 'What each repo resolves to',
        String(total),
        repos
      )}
    </article>`;
  }

  /* ------------------------------------------------------------------- render */

  /**
   * The whole page: the card, and the observer's read-only treatment over it.
   *
   * One payload and one element, which is what makes this file a fraction of the size of
   * the console it came out of — there is no roster to guard against, no `bd` sweep to
   * have failed, and no second pane whose state could decide whether this one paints.
   */
  function render() {
    if (!out) return;
    out.innerHTML = spaceHtml();
    // Which daemon am I looking at? Two consoles side by side are otherwise identical,
    // and the one that acts is not the one you have been pressing. `hidden` rather than
    // absent text: the live instance must show nothing at all, so a badge that failed to
    // render can never be mistaken for "not observing".
    if (observing) {
      observing.hidden = !state.observing;
      observing.title = state.observing
        ? 'This instance watches and never acts: no sessions, proposals, worktree sweeps, session logs, reply agents or pushes.'
        : '';
    }
    if (!state.observing) return;
    // Drawn rather than hidden — a control that vanished would read as a feature this
    // build does not have, where a disabled one with a title says which machine it
    // belongs to. The server refuses the write either way (see `POST /api/space`); this
    // is so the refusal is not something you find out by pressing.
    for (const el of out.querySelectorAll(
      '[data-space-set],[data-repo-set],[data-space-day],[data-space-hours],[data-space-channel],#qh-from,#qh-to,#slack-channel'
    )) {
      el.disabled = true;
      el.title = 'This instance only watches — the settings belong to the daemon that acts.';
    }
  }

  /* --------------------------------------------------------------------- load */

  /**
   * The selected space's own configuration.
   *
   * Nothing to fetch while the picker is on All — there is no one space these would be
   * the settings of — and the card says so instead. `Other` is a 404 by design and its
   * message is drawn rather than swallowed: it is a group the picker offers, not a
   * thing with settings, and "why are there no controls" deserves a sentence.
   *
   * `observing` comes back on the same payload, so the read-only treatment is decided by
   * the request the page was making anyway rather than by a second one for one boolean.
   * A daemon too old to send it answers `undefined`, which is `false` — an instance that
   * acts, which is what every daemon that has never heard of the flag is.
   *
   * Which does mean the `⦿ observing` mark is not drawn while the picker is on All, since
   * that is the one state with no request to carry it. Left rather than fixed with a
   * second fetch: what the mark warns you about is a press reaching the wrong Mac, and on
   * All this page draws one sentence and no controls at all. It appears the moment a
   * space is picked, which is the moment there is something here to press.
   */
  async function loadSpace() {
    const name = spaceName();
    if (!name) {
      state.space = null;
      state.spaceError = null;
      return;
    }
    try {
      const detail = await api(`/api/space?space=${encodeURIComponent(name)}`);
      state.space = detail;
      state.observing = Boolean(detail.observing);
      state.spaceError = null;
    } catch (err) {
      state.space = null;
      state.spaceError = err.message;
    }
  }

  /** The one fetch this page makes, with the pulse on it while it is in flight. */
  async function load() {
    pulse?.classList.add('busy');
    try {
      await loadSpace();
      render();
    } finally {
      pulse?.classList.remove('busy');
    }
  }

  /**
   * Change one of the selected space's settings.
   *
   * One field per press, never the whole object: a read-modify-write from a payload
   * assembled before your thumb landed would put back whatever a *second* device changed
   * in between. The server patches, so a press says only what it means.
   *
   * The reply is the new detail, and it is adopted rather than re-fetched — it is the
   * one answer that is definitely post-write. `changed` is the daemon's own list of what
   * actually moved, which is shorter than the label promises exactly when it matters:
   * pressing Inherit on a field that was already inheriting changes nothing, and saying
   * "nothing to change" is more honest than a tick.
   */
  async function saveSpace(patch, btn, workspace = null) {
    const name = spaceName();
    if (!name) return;
    const was = btn?.textContent;
    if (btn) {
      btn.disabled = true;
      btn.textContent = '…';
    }
    try {
      const r = await api('/api/space', {
        method: 'POST',
        // `workspace` is what turns this into the repo row's write — one setting, this
        // repo only, outranking the space. Omitted entirely rather than sent as `null`
        // for the ordinary case, so a body that never mentions a repo cannot be read as
        // one that named an unusable one.
        body: JSON.stringify(workspace ? { space: name, workspace, settings: patch } : { space: name, settings: patch }),
      });
      state.space = r;
      state.spaceError = null;
      // Whatever was typed has either just been sent or has just been overruled by a
      // press on Never or Inherit. Either way the field goes back to showing what the
      // space now says, which is the only thing on this card that is true.
      state.slackDraft = null;
      state.spaceSaid = {
        text: r.changed?.length ? `${r.changed.join(', ')} changed` : 'nothing to change — it was already set that way',
      };
      // The picker's 🔕 comes off the same config this just wrote, and the server has
      // already refreshed its cached summary — but the bar in front of you is holding a
      // copy from the last poll, so it is told directly rather than left to catch up.
      window.beadcause?.space?.adopt({ spaces: await spaceRows() });
      render();
    } catch (err) {
      state.spaceSaid = { text: err.message, bad: true };
      if (btn) {
        btn.textContent = was;
        btn.disabled = false;
      }
      render();
    }
  }

  /** The picker's rows, refetched after a write that can have changed one of its flags. */
  async function spaceRows() {
    try {
      return (await api('/api/spaces')).spaces;
    } catch {
      // The bar keeps what it had. A stale 🔕 is a smaller wrong than a bar that
      // emptied itself because one refresh failed.
      return undefined;
    }
  }

  /* ------------------------------------------------------------------- events */

  /* The three inputs on this card, asked of the document rather than of `out`: the ids
     are unique on the page either way, and this is the lookup that stays right if the
     card is ever drawn somewhere else again. */
  const field = (id) => document.getElementById(id);

  const onClick = (e) => {
    // The space's own settings first: they carry their field on themselves, where the
    // repo rows below carry a workspace as well.
    const set = e.target.closest('[data-space-set]');
    if (set) {
      e.preventDefault();
      const raw = set.dataset.value;
      // `null` is the wire's "clear this key and follow the global", and a data
      // attribute can only carry the word — so it is turned back into the value here,
      // once, rather than being special-cased per field on the server.
      const value = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw;
      saveSpace({ [set.dataset.spaceSet]: value }, set);
      return;
    }

    // The same three buttons on a repo row, and they must be matched *before* nothing
    // else claims them: they carry a workspace as well as a field, and the handler above
    // would have written the whole space's answer from a press meant for one repo.
    const repoSet = e.target.closest('[data-repo-set]');
    if (repoSet) {
      e.preventDefault();
      const raw = repoSet.dataset.value;
      const value = raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw;
      saveSpace({ [repoSet.dataset.repoSet]: value }, repoSet, repoSet.dataset.repo);
      return;
    }

    const day = e.target.closest('[data-space-day]');
    if (day) {
      e.preventDefault();
      const days = state.space?.settings?.quietDays || [];
      const id = day.dataset.spaceDay;
      const next = days.includes(id) ? days.filter((d) => d !== id) : [...days, id];
      // An empty list clears the key rather than storing "quiet on no days", which is
      // the same thing to every reader and one more shape for the config to be in.
      saveSpace({ quietDays: next.length ? next : null }, day);
      return;
    }

    const hours = e.target.closest('[data-space-hours]');
    if (hours) {
      e.preventDefault();
      if (hours.dataset.spaceHours === 'clear') {
        saveSpace({ quietHours: null }, hours);
        return;
      }
      const from = field('qh-from')?.value;
      const to = field('qh-to')?.value;
      saveSpace({ quietHours: { from, to } }, hours);
      return;
    }

    const chan = e.target.closest('[data-space-channel]');
    if (chan) {
      e.preventDefault();
      const typed = (field('slack-channel')?.value || '').trim();
      // A blank field and a press on Set is the one gesture with no honest reading:
      // `""` is what Never writes and it is a *different* answer from Inherit, so
      // picking one of them here would be the card quietly deciding which. Both
      // buttons are an inch away.
      if (!typed) {
        state.spaceSaid = { text: 'Type a channel id, or press Never or Inherit.', bad: true };
        render();
        return;
      }
      saveSpace({ slackChannel: typed }, chan);
      return;
    }

    const sum = e.target.closest('[data-toggle]');
    if (sum) {
      toggle(sum.dataset.toggle);
      render();
    }
  };

  /* The one field on this page you type into, and it is held in `state` rather than read
     back out of the DOM: every press on this card repaints the whole thing, so a Set
     pressed after a Mute would otherwise find the input rebuilt and the id gone. The
     limit steppers on the console get the same treatment for the same reason. */
  const onInput = (e) => {
    if (!e.target.closest('#slack-channel')) return;
    state.slackDraft = { space: spaceName(), text: e.target.value };
  };

  out?.addEventListener('click', onClick);
  out?.addEventListener('input', onInput);

  /* The ⟳. One `/api/space` read of the daemon's config object, with no `bd` and no `gh`
     behind it — which is why this page can offer one at all without it being a button
     that sweeps every tracker on the Mac. */
  document.getElementById('refresh')?.addEventListener('click', () => load());

  /* The space picker moved, so this is a different space's config and it is fetched.
     Painted first all the same: the card says it is reading rather than sitting on the
     previous space's answers under the new space's name.

     The picker's *fine* level matters here too and costs nothing — `onlyRepo` narrows the
     repo panel to the one repo you pinned, which is a repaint with no fetch involved. */
  window.beadcause?.space?.onChange(() => {
    state.spaceSaid = null;
    render();
    tellPresence();
    loadSpace().then(render);
  });

  /* Where this device is, for anything mirroring it. Reported once at boot and again
     whenever the picker moves, because *which space* is half of what the mirror says
     this screen is showing. `config` is already one of `VIEWS` in lib/presence.js and
     already has a sentence in public/mirror.js — it was a chip on the console before it
     was a page, and neither of those had to change when it moved. */
  const tellPresence = () =>
    window.beadcause?.presence?.report({ view: 'config', space: spaceName() || '', detail: spaceName() || 'every space' });

  /* Draw whatever the picker already says before the first request lands: with no space
     selected that is the "pick a space" line, which is the final answer rather than a
     placeholder, and with one it is "Reading this space…". */
  render();
  load();
  tellPresence();

  /* What `scripts/space-check.mjs` drives to prove a repaint landing under your thumb
     cannot take a half-typed channel id away — the same door
     `window.beadcause.monitor.refresh` opens on the console. Nothing in the app calls it,
     and it is the whole of this page's public surface. */
  window.beadcause = window.beadcause || {};
  window.beadcause.config = { refresh: load };
})();
