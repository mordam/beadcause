/* The pull requests, and how far each one has actually got.
 *
 * The inbox asks *may I merge this?* and the card is gone the moment you answer. It also
 * now carries a card per pull request (bc-l8jp.6), which is what took **PRs** off the
 * bottom bar — so this is no longer a tab, and it is still the whole of the shipping
 * screen: the release queue, and the buttons that act on one row.
 *
 * **And it is a pane on /monitor now, not a page (bc-d4d5).** Taking it off the bar left
 * it with no route in at all except the link on a PR card in the inbox, which meant that
 * on a day with no pull request in the inbox there was no way to reach **Ship** short of
 * typing a URL — and a ship bead that says "press Ship on the board" is not answerable
 * from a phone that cannot find the board. So it is the third chip on the advocates page
 * (see public/montabs.js), by the same argument that makes the Mirror a pane rather than
 * a tab: it is a mode of the page you already watch work from, and you glance at it and
 * act on one row rather than living on it. `/prs`, `/pulls` and `/prs.html` all still
 * work — they are on the phone's home screen and in the notifications the ship path
 * sends — and all three now land on that page with this chip up.
 *
 * What that costs this file is small and worth naming: there is no `#prs-refresh` any
 * more (the page's one ⟳ is shared, and each pane ignores it while it is hidden), no
 * presence report of its own (the chip carries it), and nothing is fetched until the
 * chip is up. The last of those is the one that matters — every wake this board acts on
 * is a `gh` sweep per repo, and it now stands itself down behind the other two panes.
 *
 * Three things about the shape of the board.
 *
 * **The lamps are the page.** Merged · Pushed · Deployed · Live, on every row, always
 * visible — not behind the fold, because "which of these has not shipped" is a
 * question you answer by scanning, and a fold would make it a question you answer by
 * tapping twelve times. They are four lamps rather than one word because they go
 * true at four different times and the gap between them is the whole subject. Drawing
 * them is public/prcard.js's job now, along with the rest of the row: the inbox draws the
 * same pull request and a second renderer of it was the duplication bc-l8jp.6 removed.
 *
 * **A lamp has three states, not two.** On, off, and *unknown* — a hollow ring. This
 * Mac has never fetched that commit; this repo has no deploy the daemon can see. An
 * unknown drawn as "off" would say work was not pushed when the truth is that nobody
 * has looked, and that is the one way this screen could actually mislead you.
 *
 * **A button that acts is armed; a button that opens a window is not.** Merging is
 * irreversible and lands on origin the instant it is pressed, so it takes two taps with
 * the consequence written into the button between them — the same arming pattern as the
 * destructive control on /admin, and for the same reason: a `confirm()` on a phone is a
 * sheet you dismiss by reflex. Ship is now on both sides of that line, which is why it
 * says which it is: in a repo that declares a deploy it runs it from here, so it arms;
 * in a repo that declares none it opens a session on the Mac you can watch and stop, so
 * it does not. Commenting writes a sentence on GitHub and needs no guard either.
 *
 * **The deploy strip is not here any more (bc-khoe.7).** It used to sit above the cards
 * — what is being built and restarted *right this second*, which is a different question
 * from the Deployed lamp's *is it running?* and has a much shorter fuse, because on this
 * repo a deploy SIGKILLs the daemon serving this page. It was at the top of this screen
 * because this was the nearest page, not because it was about a pull request; a deploy is
 * the rung *after* one. It is on `/releases` now (public/releases.js), beside the two
 * queues it is a stage of, and this file no longer polls `/api/deploys` at all.
 *
 * What stays is everything that is about a pull request, which includes the Ship button
 * and the release count over it: how many merges one deploy of this repo would carry is a
 * fact about the rows below it, and it is what makes pressing Ship a decision rather than
 * a reflex. What a board reading this file loses is the sentence explaining a failed
 * fetch during a restart — that line is on the Releases view, where the deploy causing it
 * is drawn.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';

  /** The view id the pane this section lives in is, in public/hashroute.js's vocabulary. */
  const VIEW = 'advocates';
  /** The chip this section is behind. */
  const TAB = 'prs';

  const panes = (window.beadcause && window.beadcause.panes) || null;

  /**
   * Is this the shell's Advocates pane, or the `/prs` document it also still is?
   *
   * Asked of the document rather than of a flag — see the same three lines at the top of
   * public/montabs.js, which owns the row this section is a chip on.
   */
  const inShell = Boolean(panes && typeof panes.has === 'function' && panes.has(VIEW));

  const out = document.getElementById('prs');
  /* The brand dot. Left alone in the shell: it is the whole document's there, driven off
     public/report.js's count of what is in flight, and a second writer toggling `busy` on
     it would clear it under a fetch of the inbox's that is still out. */
  const pulse = inShell ? null : document.getElementById('pulse');
  const observing = document.getElementById('observing');

  /**
   * Is this section the thing being looked at?
   *
   * `out.hidden` was the whole answer while this was a pane of a page. In the shell it is
   * half of one — the pane holding all three sections can be hidden with this chip up, and
   * a board that read its own attribute would go on spending a `gh` sweep per repo on
   * every merge, all day, behind Home. That is the most expensive of the three to get
   * wrong, which is why the row answers it rather than each section guessing.
   */
  const upNow = () => window.beadcause?.monTabs?.up?.(TAB) ?? !out.hidden;

  /* There was a minute-long `setInterval` here that re-asked for the whole board, a `gh`
     call per repo, for as long as the page was open. It is gone: the board follows the
     daemon's event log now (see `follow` below) and asks again only when the log says a
     pull request actually moved.

     **The one thing that costs.** GitHub is outside the daemon's event log, so a pull
     request opened by something other than this app — an agent's `deliver.js`, a push
     from another machine — is not an event and does not wake the board. What brings it
     in is the ⟳, the next daemon-side event, or arriving at the page. That is the trade
     the timer was paying a `gh` sweep a minute, all day, on every open board to avoid. */

  /** The events that can have changed a lamp or a button on this board.

     Public/stream.js owns the list now, because the inbox holds this page's payload warm
     and has to answer the same question about it — see `boardMoved` there. The literal
     here is the older-sibling case and nothing else: a service worker holding this file
     beside a stream.js from before that export existed. Falling back to it rather than to
     "everything moved" matters, because on this page the difference is a `gh` sweep per
     repo per event. */
  const BOARD_EVENTS = window.beadcause?.stream?.BOARD_EVENTS || ['merged', 'changes', 'pr-declined', 'deploy', 'advocate'];

  const state = {
    data: null,
    /** Which repo card is unfolded. At most one — that is what makes it an accordion. */
    card: null,
    /** Which PR's actions are open, as `workspace#number`. */
    row: null,
    /**
     * The armed button, as `<action>@<row key>`. At most one on the whole board, and
     * cleared by every repaint — two arming buttons now share the row (Merge, and a
     * Ship that deploys rather than opening a window), and a bare key could not tell
     * them apart.
     */
    armed: null,
    /** What you have typed at a PR, kept out here so a repaint doesn't lose it. */
    draft: '',
    /** The outcome of the last action, pinned under the row it acted on. */
    said: null,
    busy: false,
    first: true,
    /** The last board fetch's failure, if it failed. Cleared by the next one that works. */
    error: null,
    /** How old the last board was, off `x-beadcause-kept` (lib/cache.js) — `null`
     *  until an answer has landed, which is what keeps the mark off a first paint.
     *  See `parseKept`. */
    kept: null,
  };

  /* The row, the lamps, the ladder and the two time formats come from public/prcard.js —
     the inbox draws the same pull request from the same functions. Taken apart here rather
     than reached for through `window` at every call site, so this file reads as it did.
     It is loaded before this one (see monitor.html); a page without it has no board at
     all, which is why both are in one `sw.js` cache version. */
  const card = window.beadcause.prCard;
  const { esc, plural, age, ago, graphUrl, lampsHtml, factsHtml, bodyHtml } = card;

  /**
   * How old the answer was, off the header the daemon puts on a kept response.
   *
   *     x-beadcause-kept: stale; age=41; refreshing
   *
   * Copied from public/history.js rather than shared — three lines twice is cheaper
   * than a module only two pages would import. It matters more here than anywhere
   * else it is drawn: this sweep is `gh` per repo, ~74s against a 25s window, so a
   * board on a kept answer while the fresh one runs behind it is this page's
   * *ordinary* state now, and this is what stops it quietly passing a minute-old
   * board off as this second's (bc-1kwl.8).
   */
  function parseKept(value) {
    if (!value) return null;
    const parts = String(value).split(';').map((s) => s.trim());
    const field = parts.find((s) => s.startsWith('age='));
    return {
      stale: parts[0] === 'stale',
      ageSec: field ? Number(field.slice(4)) || 0 : 0,
      refreshing: parts.includes('refreshing'),
    };
  }

  /* -------------------------------------------------------------------- one row */

  /** Is *this* button on *this* row the one waiting for its second tap? */
  const isArmed = (key, action) => state.armed === `${action}@${key}`;

  /**
   * The sentence under the buttons: what Ship is about to do to this repo.
   *
   * Two entirely different acts wear the word "ship" here, and which one you get is a
   * config entry you cannot see from a phone. So it is written out — with the command
   * named, because `fly deploy` costs nothing you would notice and `launchctl
   * kickstart -k` on this Mac kills the daemon you are reading this on.
   */
  function shipHint(p) {
    if (!p.deployDeclared) {
      return 'Ship opens a session on the Mac — this repo declares no deploy beadcause can run.';
    }
    return `Ship deploys ${esc(whereOf(p))} from here${p.deployHint ? ` — ${esc(p.deployHint).replace(/`([^`]+)`/g, '<code>$1</code>')}` : ''}.`;
  }

  /**
   * What you can do to it, and the note saying why you might want to.
   *
   * Which buttons exist is decided by the *stage*, not by hiding disabled ones: a
   * greyed-out Ship on an unmerged PR is a control you have to think about, where its
   * absence is a fact you read in passing.
   */
  function actionsHtml(p) {
    const buttons = [];

    if (p.state === 'OPEN') {
      const armed = isArmed(p.key, 'merge');
      /**
       * **Queue**, not Merge — bc-02ldo, and the word is the whole of what changed here.
       *
       * The button used to say *Merge &amp; push* and mean it: the tap was `gh pr merge`,
       * and by the time the row redrew the work was in `main`. It now hands the pull
       * request to the merge queue, which merges it a minute or two later once its gates
       * pass — so a button still saying *Merge* would be a button that looks broken for
       * as long as the queue's cached read takes to notice. That lag is what made Adam
       * press it three times on deluvia #55.
       */
      buttons.push(
        `<button class="board-btn merge${armed ? ' armed' : ''}" data-act="merge" data-key="${esc(p.key)}">${
          armed ? `Queue #${p.number} — sure?` : 'Queue to merge'
        }</button>`
      );
    }
    if (p.merged) {
      // Shown even when it is already deployed, because a repo can need shipping twice
      // — an APK that was never rebuilt, a daemon someone restarted onto older code —
      // and a button that vanishes the moment the lamps go green cannot say that.
      const armed = isArmed(p.key, 'ship');
      const again = p.deployed === true;
      buttons.push(
        `<button class="board-btn ship${armed ? ' armed' : ''}" data-act="ship" data-key="${esc(p.key)}">${
          armed
            ? `Deploy #${p.number} — sure?`
            : p.deployDeclared
              ? again
                ? 'Ship again'
                : 'Ship'
              : again
                ? 'Ship again on the Mac'
                : 'Ship on the Mac'
        }</button>`
      );
    }
    buttons.push(`<button class="board-btn" data-act="comment" data-key="${esc(p.key)}">Comment</button>`);
    /* The whole screen for this one pull request — the description, the authoring agent,
       the datetimes and GitHub's live word on whether it still merges. That view exists
       once, in the inbox (bc-l8jp.7), and this is a link into it rather than a second
       copy of it: `#pr:<workspace>#<number>` is the key the inbox's own deep links use,
       so a tap here lands on the same sheet a notification does. `focusHash` in app.js
       widens the status sub-filter if it has to, which is what makes this work for a
       merged row — the board's whole subject — where the inbox's default shows only
       what is unmerged. */
    buttons.push(`<a class="board-btn link" href="/#${encodeURIComponent(`pr:${p.key}`)}">Full view</a>`);
    buttons.push(`<a class="board-btn link" href="${esc(p.url)}" target="_blank" rel="noopener">GitHub ↗</a>`);

    const said = state.said?.key === p.key ? `<div class="board-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</div>` : '';

    return `<div class="board-open">
      ${p.note ? `<p class="board-note">${esc(p.note)}</p>` : ''}
      <div class="board-where">
        <code>${esc(p.branch)}</code> → <code>${esc(p.base)}</code>${p.author ? ` · ${esc(p.author)}` : ''}${
          p.mergeCommit ? ` · <code>${esc(p.mergeCommit.slice(0, 7))}</code>` : ''
        }
      </div>
      <div class="board-actions">${buttons.join('')}</div>
      ${p.merged ? `<div class="board-hint">${shipHint(p)}</div>` : ''}
      <div class="board-say">
        <textarea data-say="${esc(p.key)}" rows="2" placeholder="Say something on #${esc(p.number)}…">${esc(
          state.draft
        )}</textarea>
        <div class="board-say-row">
          <button class="board-btn send" data-act="send" data-key="${esc(p.key)}">Send to GitHub</button>
          ${window.beadcause?.dictation?.buttonHtml({ label: 'Dictate this comment' }) || ''}
        </div>
      </div>
      ${said}
    </div>`;
  }

  function prRow(p) {
    const open = state.row === p.key;
    // No `repo` and no `titleHref`: this card is one repo already, and the row is a
    // button that folds — a link inside it would be a second thing to tap in the same
    // place. The inbox passes both, because its list is flat and its card does not fold.
    return `<div class="board-pr" data-stage="${esc(p.stage)}">
      <button class="work-row board-row" type="button" data-pr="${esc(p.key)}" aria-expanded="${open}">
        ${bodyHtml(p)}
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${open ? actionsHtml(p) : ''}
    </div>`;
  }

  /* ------------------------------------------------------------------- one repo */

  /**
   * The accordion shell, borrowed from the sessions view — with one difference that
   * matters.
   *
   * The unfolded card is marked `unfolded`, **not** `open`. `.card.open` is the
   * inbox's full-screen sheet — `position: fixed; inset: 0` — which is right for a
   * question you read one at a time and catastrophic here: it takes the card out of
   * the flow, so the page can no longer reserve room for the tab bar and the last row
   * of buttons ends up underneath it. Nothing keys off `unfolded`; the fold is the
   * `hidden` attribute below, which is what does the work on both pages anyway.
   */
  function cardHtml(key, title, summary, on, body) {
    const open = state.card === key;
    return `<article class="card work-card${open ? ' unfolded' : ''}">
      <h2 class="work-head">
        <button class="work-toggle" type="button" data-card="${esc(key)}" aria-expanded="${open}">
          <span class="work-name">${esc(title)}</span>
          <span class="work-count${on ? ' on' : ''}">${esc(summary)}</span>
          <span class="chev" aria-hidden="true">›</span>
        </button>
      </h2>
      <div class="work-body"${open ? '' : ' hidden'}>${body}</div>
    </article>`;
  }

  /* ------------------------------------------------------------- the release queue */

  /* The two numbers this board is about, as predicates, so a card head cannot drift apart
     from what "to ship" means. The rule itself belongs to `count()` in lib/prboard.js —
     this is the same rule applied to a *subset*, which is what the space picker makes
     possible: the server counts every repo, and a board showing one of them must not
     summarise the other six. `review` is the first rung of the ladder; see lib/prstage.js. */
  const isOpen = (p) => p.stage === 'review';
  const isOwed = (p) => p.stage === 'merged' || (p.stage === 'pushed' && p.deployTracked);

  /** Is this repo in the selected space? See public/spacebar.js. */
  const inSpace = (r) => window.beadcause?.space?.matches?.(r.workspace) ?? true;

  /* How a card, a row and a deploy record all say *which repo* — `beadcause`, or
     `climative/athena-service`. Every one of them carries `key` since bc-l853.6, and the
     fallback is not defensive padding: this page is served to a phone that may have the
     previous bundle cached, and a board keyed on `undefined` would collapse forty cards
     into one. See `repoKey` in lib/repos.js.

     `whereOf` is the readable half — `climative · athena-service`, the workspace alone
     where it is the one repo it has always been (`whereLanded`). A hint that said
     "Ship deploys climative" over a card about one service would name the wrong thing. */
  const keyOf = (x) => x?.key || x?.repoKey || x?.workspace || '';
  const whereOf = (x) => (x?.repoName ? `${x.workspace} · ${x.repoName}` : x?.workspace || keyOf(x));

  /**
   * How many merges this repo owes a ship — the daemon's queue where it sent one, the
   * predicate above where it did not.
   *
   * The two answer the same question and the queue is the better answer: it counts what
   * a deploy would actually pick up, so a merge nobody has fetched is out of it and one
   * covered by a deploy that has already run is too. See lib/release.js. The fallback is
   * not dead code — an observer, or a phone left open across a daemon that predates the
   * queue, gets a board with no `release` on its cards and must still say a number.
   */
  const owedIn = (c) => (c.release ? c.release.count : c.prs.filter(isOwed).length);

  /**
   * What one deploy of this repo would make live, and the number on the button.
   *
   * The row Ship below it already deployed the whole of `origin/main` — a deploy has
   * never been able to ship one pull request and leave the four behind it — but nothing
   * said so, and nothing said how many. That is the whole of this strip: **the count is
   * the point**, drawn over the button rather than beside it because the question it
   * answers ("is pressing this routine, or is it the day's work going out at once?") has
   * to be answerable at a glance from the top of a card.
   *
   * Three things it deliberately does not do:
   *
   * - **It does not appear when the queue is empty.** Everything merged being live is
   *   the ordinary state and it should look like it, not like a control you decided not
   *   to press.
   * - **It does not offer to batch what cannot be batched.** A repo with no declared
   *   deploy falls back to a window on the Mac for *one* pull request, and there is no
   *   window that means "and the other three" — so it names the queue and sends you to
   *   a row, rather than growing a second meaning for the same word.
   * - **It arms, like every other button here that deploys.** The second tap says how
   *   many it is about to ship, which is the number the first tap was about.
   */
  function releaseHtml(c) {
    const r = c.release;
    if (!r?.count) return '';
    /* The repo's key and never its workspace: a Climative workspace draws one card per
       approved repo, and two of them arming the same button would be one tap shipping the
       wrong service. For every workspace that is one repo the two strings are identical. */
    const armed = isArmed(keyOf(c), 'release');
    const said = state.said?.key === keyOf(c) ? `<div class="board-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</div>` : '';
    const list = r.prs
      .slice(0, 6)
      .map(
        (p) =>
          `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">#${esc(p.number)}</a> ${esc(p.title)}${
            p.bead ? ` <a class="pill id" href="${esc(graphUrl(c.workspace, p.bead))}">${esc(p.bead)}</a>` : ''
          }</li>`
      )
      .join('');
    const more = r.prs.length > 6 ? `<li class="release-more">…and ${r.prs.length - 6} more</li>` : '';

    const button =
      r.can === 'deploy'
        ? `<button class="board-btn ship release-ship${armed ? ' armed' : ''}" data-act="release" data-key="${esc(keyOf(c))}">${
            armed ? `Ship all ${r.count} — sure?` : 'Ship'
          }<span class="release-count" aria-hidden="true">${esc(r.count)}</span></button>`
        : '';

    return `<div class="release">
      <div class="release-head">
        ${button}
        <p class="release-say">${
          r.can === 'deploy'
            ? `${plural(r.count, 'merged pull request')} ${r.count === 1 ? 'is' : 'are'} on <code>origin</code> and not live. One deploy ships ${
                r.count === 1 ? 'it' : 'them all'
              }${r.hint ? ` — ${esc(r.hint).replace(/`([^`]+)`/g, '<code>$1</code>')}` : ''}.`
            : `${plural(r.count, 'merged pull request')} ${
                r.count === 1 ? 'is' : 'are'
              } waiting to ship. This repo declares no deploy beadcause can run, so each one opens a window on the Mac from its own row.`
        }</p>
      </div>
      <ul class="release-list">${list}${more}</ul>
      ${said}
    </div>`;
  }

  function repoHtml(c) {
    const open = c.prs.filter(isOpen).length;
    const owed = owedIn(c);
    const summary = [open ? `${open} open` : '', owed ? `${owed} to ship` : '', c.error ? 'error' : '']
      .filter(Boolean)
      .join(' · ');

    const body = c.error
      ? `<p class="subtitle bad">⚠ ${esc(c.error)}</p>`
      : c.note
        ? `<p class="subtitle">${esc(c.note)}</p>`
        : c.prs.length
          ? releaseHtml(c) +
            c.prs.map(prRow).join('') +
            (c.deployTracked
              ? ''
              : `<p class="board-foot">Deploy state is not tracked for this repo — beadcause only knows what it is running itself.</p>`)
          : '<p class="subtitle">No pull requests here.</p>';

    const title = c.repo || keyOf(c);
    // What is deploying right now used to outrank this line. It is on /releases with the
    // rest of the strip (bc-khoe.7), and the summary here is what it always was underneath:
    // what this repo has open and what it owes a ship.
    const head = summary || (c.prs.length ? 'all shipped' : 'none');
    return cardHtml(keyOf(c), title, head, Boolean(open || owed), body);
  }

  /* -------------------------------------------------------------------- render */

  /**
   * The board, as markup rather than as a write.
   *
   * It returns a string rather than writing `out.innerHTML` itself, which is what it did
   * while the deploy strip rendered above it on a second clock. The strip has gone to
   * /releases (bc-khoe.7) and this is the only half left — but a renderer that hands its
   * markup back is still the right shape, because `render` is the one place that decides
   * what a repaint does to your scroll position.
   */
  function boardHtml() {
    const d = state.data;
    if (!d) {
      if (state.error) return `<div class="empty"><strong>Can't reach the server</strong>${esc(state.error)}</div>`;
      return '<div class="empty">Asking every repo…</div>';
    }

    if (d.unavailable) return `<div class="empty"><strong>No pull requests to show</strong>${esc(d.unavailable)}</div>`;

    // The board on screen is the last one that came back. Saying when, rather than
    // replacing it with an error, is the difference between a stale answer you can
    // read and no answer at all — and during a restart it is stale on purpose.
    const stale = state.error
      ? `<p class="board-foot bad board-quiet">Showing the board as of ${esc(ago(d.at))} — the last refresh did not answer.</p>`
      : '';

    // The kept-answer mark (bc-1kwl.8) — a different situation from `stale` above: the
    // daemon answered, with a cached sweep it is refreshing behind rather than a request
    // that failed outright. Only drawn when the last fetch actually succeeded, or a
    // failed refetch would be saying two different things about the same board in two
    // different tones. As in public/history.js's `keptSuffix`, quiet on purpose: the
    // whole point of serving a kept answer instantly is to not put a spinner over rows
    // that are already there.
    const kept =
      !stale && state.kept?.stale
        ? `<p class="board-foot board-quiet">Showing the board as of ${esc(
            state.kept.ageSec < 60 ? `${Math.max(0, Math.round(state.kept.ageSec))}s` : `${Math.round(state.kept.ageSec / 60)}m`
          )} ago${state.kept.refreshing ? ', refreshing' : ''}.</p>`
        : '';

    const build = d.build
      ? `<p class="board-build">Running <code>${esc(d.build.short)}</code> from <code>${esc(
          d.build.dir.replace(/^.*\//, '')
        )}</code>, started ${esc(ago(d.build.at))}. That commit is what “deployed” means here.</p>`
      : `<p class="board-build">This daemon is not running from a checkout, so nothing can be called deployed.</p>`;

    // A repo with no pull requests and nothing wrong with it is one word, not a card.
    // Seven of them — which is the ordinary case here, because most workspaces are
    // trackers rather than GitHub repos — was eight hundred pixels of scrolling past
    // the word "none" to reach a build line. They are still named, because "which
    // repos did it even look at" is a question this screen has to answer.
    // Only the repos in the selected space. Which is also why the "nothing here" line
    // below distinguishes the two ways of being empty: no repos at all is a
    // configuration to go and fix, and no repos *in this space* is one tap from being
    // undone in the bar above.
    const repos = (d.repos || []).filter(inSpace);
    const quiet = repos.filter((r) => !r.prs.length && !r.error);
    const cards = repos.filter((r) => r.prs.length || r.error).map(repoHtml).join('');
    const rest = quiet.length
      ? `<p class="board-foot board-quiet">Nothing open or recently merged in ${quiet
          .map((r) => esc(r.repo || r.workspace))
          .join(', ')}.</p>`
      : '';
    // The build line rides under the cards rather than in the header: it is the
    // footnote that defines the third lamp, and it only means something once you have
    // seen one.
    if (cards || rest) return stale + kept + cards + rest + build;
    const only = (d.repos || []).length ? ` in ${esc(window.beadcause?.space?.label?.() || 'this space')}` : '';
    return `${stale}${kept}<div class="empty">${only ? `No repos${only}.` : 'No workspaces configured.'}</div>`;
  }

  function render() {
    if (!state.data && !state.error) return;
    // `out` is the scroller, not the window (bc-7utr): the board is the last row of a
    // viewport-height shell, so the offset that survives a repaint is its own. Read and
    // written on the same element, which is also why this keeps working if the page ever
    // goes back to scrolling as a document.
    const was = out.scrollTop;

    out.innerHTML = boardHtml();

    // There was a badge here — open decisions plus merged work that is not running, hung
    // off the PRs tab. The tab is gone (bc-l8jp.6) and so is the badge: what it was for
    // is now a count on the inbox's own PR filter chip, which sits above the list the
    // pull requests are actually in. A badge painted onto a bar with no tab to hang it
    // from would be a number nobody can see.

    out.scrollTop = was;
  }

  /* -------------------------------------------------------------------- acting */

  /** Every row on the board, flattened — the buttons carry a key, not a position. */
  const rowFor = (key) => (state.data?.repos || []).flatMap((r) => r.prs).find((p) => p.key === key) || null;

  /**
   * Press one of the three.
   *
   * The outcome is pinned under the row rather than toasted away, for the same reason
   * /admin writes it into the button: these change what has happened to real work, and
   * "did that go through?" must not be a question you answer by opening GitHub.
   */
  /** The card for a repo key — what the release strip's button acts on. */
  const cardFor = (key) => (state.data?.repos || []).find((r) => keyOf(r) === key) || null;

  /**
   * Ship the whole queue: one deploy, every merge on it.
   *
   * Kept apart from `act` rather than folded into it, because every branch in there is
   * about a *row* — it looks the pull request up by key, sends its number, and pins the
   * outcome under it. This one has no row: its key is a workspace, and the outcome
   * belongs to the strip at the top of the card.
   */
  async function shipQueue(key) {
    const card = cardFor(key);
    if (!card?.release?.count || state.busy) return;
    if (!isArmed(key, 'release')) {
      state.armed = `release@${key}`;
      return render();
    }

    const where = whereOf(card);
    const count = card.release.count;
    state.busy = true;
    state.armed = null;
    state.said = { key, text: `Deploying ${where} — ${plural(count, 'merged pull request')}…`, bad: false };
    render();

    try {
      const res = await fetch('/api/release/ship', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        /* The repo, as a key. `workspace` beside it is not belt and braces: the server
           accepts either, and sending both is what lets an older daemon — one that has not
           been deployed with this bundle yet — still answer a board that has. */
        body: JSON.stringify({ key, workspace: card.workspace }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      // Never "shipped". A 200 means a record is on disk and a detached runner owns it;
      // on this repo the next thing that happens is the daemon being killed by its own
      // deploy, and the outcome arrives on /releases and on the phone.
      state.said = {
        key,
        text: `Deploying ${where} — ${data.deploy?.id || 'started'}, carrying ${plural(
          count,
          'merge'
        )}. Releases is watching it; how it went lands on your phone.`,
        bad: false,
      };
    } catch (err) {
      state.said = { key, text: err.message, bad: true };
    } finally {
      state.busy = false;
      render();
    }
  }

  async function act(key, action) {
    if (action === 'release') return shipQueue(key);
    const p = rowFor(key);
    if (!p || state.busy) return;

    // Queue always arms, and still does now that it queues rather than merges: what the
    // second tap buys is not the merge but the *approval*, which is the decision the queue
    // then acts on unattended, and a phone in a pocket must not be able to make one on a
    // single touch. Ship arms only where it will *deploy* — where it opens a window
    // instead, the window is the guard: you can watch it and stop it, which is the whole
    // reason that button never needed a second tap before it could deploy.
    const arms = action === 'merge' || (action === 'ship' && p.deployDeclared);
    if (arms && !isArmed(key, action)) {
      // First press arms it. Nothing is sent, and the button now says what it will do.
      state.armed = `${action}@${key}`;
      return render();
    }

    const text = String(state.draft || '').trim();
    if (action === 'send' && !text) return;

    /** Did this press actually start a deploy? Answered by the daemon, below. */
    let started = false;

    state.busy = true;
    state.armed = null;
    state.said = {
      key,
      text:
        action === 'ship'
          ? p.deployDeclared
            ? `Deploying ${whereOf(p)}…`
            : 'Opening a window on the Mac…'
          : action === 'merge'
            ? 'Putting it on the merge queue…'
            : 'Working…',
      bad: false,
    };
    render();

    const url = action === 'merge' ? '/api/pr/merge' : action === 'ship' ? '/api/pr/ship' : '/api/pr/comment';
    /* The repo, and the number *within* it — a pull request number is only unique inside a
       repo, so a merge sent with a workspace where the workspace holds forty of them would
       be a merge of whichever card the server happened to look at first. `workspace` rides
       along for a daemon that predates the key; see `shipQueue`. */
    const body = { key: p.repoKey || p.workspace, workspace: p.workspace, number: p.number };
    if (action === 'send') body.text = text;

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);

      if (action === 'merge') {
        /**
         * **Never "merged".** The tap queues, and the queue merges a minute or two later
         * — so the one thing this sentence must not do is claim the thing that has not
         * happened yet. It says what is true now, names the bead the queue will act on so
         * there is something to look at while waiting, and says what still has to pass.
         *
         * The three cases are genuinely different and are worth three sentences: it went
         * on the queue, it was *already* on the queue and moving (nothing moved, and the
         * approval is recorded anyway), or it is already in `main` and there was nothing
         * to do. `others` rides on the end of all of them — two open beads about one pull
         * request is a work bead that cannot close, and the phone has no stderr for it.
         */
        const extra = (data.others || []).length
          ? ` ${data.others.join(', ')} ${data.others.length === 1 ? 'is' : 'are'} also open about #${p.number} — close or supersede ${
              data.others.length === 1 ? 'it' : 'them'
            }.`
          : '';
        state.said = {
          key,
          text: data.alreadyMerged
            ? `#${p.number} was already merged — nothing to queue.`
            : (data.queued
                ? `Queued #${p.number}${data.id ? ` as ${data.id}` : ''} — the merge queue brings ${
                    p.base || 'the base'
                  } into the branch, checks it, and merges. Not merged yet.`
                : `#${p.number} was already on the merge queue${
                    data.id ? ` as ${data.id}` : ''
                  } — your approval is recorded and nothing was moved.`) + extra,
          bad: false,
        };
      } else if (action === 'ship') {
        // Which of the two happened comes from the daemon, not from what the button
        // said a second ago: the row could have been drawn before a `deploys` entry
        // was added or taken away, and the answer must be about what actually ran.
        started = data.via === 'deploy';
        state.said = started
          ? {
              key,
              // Never "deployed". A 200 here means the record is on disk and a detached
              // runner owns it — for this repo the next thing that happens is the daemon
              // being killed by its own deploy, and the outcome arrives later, on
              // /releases and on this phone.
              text: `Deploying ${whereOf(p)} — ${data.deploy?.id || 'started'}. Releases is watching it.`,
              bad: false,
            }
          : { key, text: `A session is opening in ${data.dir || 'the repo'} to deploy it.`, bad: false };
      } else {
        state.said = { key, text: 'Said on GitHub.', bad: false };
        state.draft = '';
      }
    } catch (err) {
      state.said = { key, text: err.message, bad: true };
    } finally {
      state.busy = false;
      render();
      /**
       * **No refresh on the queue path, and that is the point rather than an omission.**
       *
       * It used to reload the board because the tap had just merged and the lamps on the
       * row were wrong the instant it returned. The tap now queues: the pull request is
       * still open, every lamp is still right, and a forced sweep — which is a `gh` query
       * per repo — would come back with the identical row and paint over the sentence
       * saying what just happened. The merge arrives on its own later, and the poll that
       * is already running is what draws it.
       */
    }
  }

  out.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (btn) {
      ev.preventDefault();
      // Comment sends nothing — the box is already on the row, and the button's whole
      // job is to put the cursor in it without you hunting for it on a small screen.
      if (btn.dataset.act === 'comment') return focusSay(btn);
      return act(btn.dataset.key, btn.dataset.act);
    }

    const card = ev.target.closest('[data-card]');
    if (card) {
      const key = card.dataset.card;
      state.card = state.card === key ? null : key;
      state.row = null;
      state.armed = null;
      return render();
    }

    // A bead pill inside a row is a link into the graph, not a fold.
    if (ev.target.closest('.pill.id')) return;

    const row = ev.target.closest('[data-pr]');
    if (row) {
      const key = row.dataset.pr;
      state.row = state.row === key ? null : key;
      // Everything typed or armed belongs to the row that is closing.
      state.armed = null;
      state.draft = '';
      state.said = null;
      render();
    }
  });

  /** The Comment button has nothing to send — it puts the cursor where you type. */
  function focusSay(btn) {
    const box = out.querySelector(`[data-say="${CSS.escape(String(btn.dataset.key))}"]`);
    if (box) {
      box.focus();
      box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  // Kept in `state` on every keystroke: the board repaints under you on its own timer,
  // and a half-written sentence must survive that.
  out.addEventListener('input', (ev) => {
    const box = ev.target.closest('[data-say]');
    if (box) state.draft = box.value;
  });

  async function load({ refresh = false } = {}) {
    pulse?.classList.add('busy');
    try {
      const res = await fetch(`/api/prs${refresh ? '?refresh=1' : ''}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      // Every answer carries it — the daemon serves a kept sweep immediately and
      // refreshes it behind (lib/cache.js), and this is what lets `boardHtml` say so
      // instead of drawing a kept board as though it were this second's.
      state.kept = parseKept(res.headers && typeof res.headers.get === 'function' ? res.headers.get('x-beadcause-kept') : null);
      state.data = await res.json();
      // Kept for the next document that wants it — this page, on the next tab tap.
      // The board is a `gh` call per repo behind a 25-second cache on the daemon, so
      // what a warm boot saves is not the sweep, it is the blank screen over it.
      window.beadcause?.warm?.write?.('/api/prs', state.data);
      observing.hidden = !state.data.observing;
      if (state.first) {
        state.first = false;
        // Unfold the repo with something to act on — arriving at a closed heading
        // would make the fold cost a tap on every visit for no reason. Inside the
        // selected space, or it would unfold a card this board is not drawing.
        state.card = (state.data.repos || []).find((r) => r.prs.length && inSpace(r))?.key || null;
      }
      state.error = null;
      render();
      // Only from a request that came back, and only once — see public/warm.js.
      window.beadcause?.warm?.prewarm?.({ here: 'prs', api: warmApi });
    } catch (err) {
      // Kept in state rather than written over the page: `boardHtml` decides what a
      // failure looks like, and with a board already on screen it is a line above it
      // saying how old it is, instead of the loss of everything the page was showing.
      state.error = err.message;
      render();
    } finally {
      pulse?.classList.remove('busy');
      // Whether or not that worked, and deliberately: a board opened during a deploy —
      // which is exactly when this page is opened — is looking at a daemon that is
      // restarting, and with the minute timer gone the stream is the only thing that
      // brings it back on its own. See `follow`, and its backoff.
      follow();
    }
  }

  /* The space picker moved — on this device or on the other one. Nothing is refetched:
     the board already holds every repo, and which of them is drawn is a decision made
     at paint time. An open card in a repo that has just been filtered away is closed
     with it, or reopening the space would leave a fold nobody remembers opening. */
  window.beadcause?.space?.onChange(() => {
    if (state.card && !(state.data?.repos || []).some((r) => keyOf(r) === state.card && inSpace(r))) {
      state.card = null;
    }
    render();
  });

  /* The ⟳ is the page's and this board is one of its three panes, so it only means the
     board while the board is up. Shared with monitor.js, which guards its own the same
     way: the alternative was a second ⟳ in the top bar, and two refresh buttons side by
     side that refresh different halves of one screen is worse than one that refreshes
     what you are looking at. */
  document.getElementById('refresh').addEventListener('click', () => {
    if (!upNow()) return;
    load({ refresh: true });
  });

  /* ------------------------------------------------------------------- the stream */

  /**
   * One answered poll, whichever mount asked for it.
   *
   * The shape is `follow`'s own `onWake` argument, which is also what public/montabs.js
   * fans out from the stager — so this is the document's `onWake` and the pane's `wake`,
   * one function under one name rather than the same logic written twice and free to
   * drift.
   *
   * **Nothing in here is free, so the guard is the first line rather than a middle one.**
   * Every wake this board acts on is a `gh` sweep per repo, which is the reason the pane
   * this section is in stands down while it is hidden at all — see the header of
   * public/montabs.js. The roster next door takes the free half of a wake regardless; this
   * one has no free half to take.
   *
   * **Why it re-asks for the board rather than patching the row the event names.** The
   * three lamps are not fields on the event: `merged`, `pushed` and `deployed` are the
   * daemon's own reading of GitHub, of `origin/main` and of the deploy journal, decided
   * in lib/prboard.js. A client that set them from `{number, bead}` would be a second,
   * worse copy of that ladder — and the lamps' whole claim is that they are true. What
   * makes the re-ask cheap instead is on the daemon: the three events that move a row
   * drop the board cache as they fire, so the first board through does one `gh` sweep
   * and every other open board shares it.
   */
  function wake({ events, resync }) {
    if (!upNow()) return;
    // Not while you are mid-sentence or holding an armed merge: a repaint would
    // throw the first away and disarm the second under your thumb. The ⟳ is still
    // there, and so is the next event.
    if (state.busy || state.armed || state.draft) return;
    // We have lost our place in the log, so nothing on screen is provably current —
    // this is one of the three cases that earns a forced sweep.
    if (resync) {
      load({ refresh: true });
      return;
    }
    // `deploy` is still one of BOARD_EVENTS and still earns a sweep, because a deploy
    // that settled has moved the Deployed and Live lamps on the rows below. What it no
    // longer earns is a second request: the journal behind it is drawn on /releases
    // now (bc-khoe.7), and this page has nothing to draw from it.
    if (!window.beadcause.stream.touched(events, BOARD_EVENTS)) return;
    load();
  }

  /* The pane's own handler, registered unconditionally and called only in the shell: on
     monitor.html nothing invokes public/montabs.js's fan-out, because `follow` below owns
     this section's socket there. Exactly one of the two fires per document. */
  window.beadcause?.monTabs?.onWake?.(wake);

  /**
   * Follow the event log instead of re-asking on a clock — on the document only.
   *
   * `want: 'presence'` is what makes the park free: the daemon sweeps `bd` for a poll
   * that asked for the inbox questions, and this view draws none of them — it wants to
   * be woken, and then it decides for itself whether the news was about a pull request.
   * `cold: true` because `/api/prs` carries no sequence, and with `want: 'presence'` the
   * `since`-less first request that learns one costs nothing.
   *
   * **In the shell this does nothing at all**, and the early return is the point rather
   * than a tidy-up: that document holds exactly one poll and public/panestage.js hands its
   * answers to every pane that asked for them. A second `follow` here would be one of the
   * four parked requests one screen would otherwise hold — each a `bd` sweep per event on
   * the daemon behind it. `presence` is declared to the stager instead, by
   * public/montabs.js, and it is the same word for the same reason.
   */
  let stream = null;
  function follow() {
    // See the same three lines in public/monitor.js and public/releases.js.
    if (inShell || !window.beadcause?.stream) return;
    // Mounted once and started every time `load` runs — the boot and the ⟳ — so a stream
    // that gave up after a run of failures can be picked back up by hand. `start` on one
    // that is already parked is a no-op.
    if (stream) {
      stream.start();
      return;
    }
    stream = window.beadcause.stream.follow({
      api: warmApi,
      want: 'presence',
      cold: true,
      /* Only while the board is the section you are on. Coming back calls `load`, which
         calls `follow`, which restarts a stream that stood itself down. */
      ready: upNow,
      onWake: wake,
    });
    stream.start();
  }

  /**
   * A plain GET, for the background warm and for the delta stream.
   *
   * This page fetches with bare `fetch` in a handful of places rather than through one
   * wrapper, so there is nothing here for `prewarm` to borrow. One small one, kept
   * next to the boot it is used from.
   *
   * `opts` is spread through for exactly one caller and one field: the stream hands it
   * an `AbortController` signal, and a wrapper that dropped it would leave a parked
   * socket held for its full twenty-five seconds every time this page went into a
   * pocket.
   */
  async function warmApi(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'x-beadcause-token': token, ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Draw the board this tab had last time, before anything has been asked for.
   *
   * The fold is decided here as well as in `load`, or a warm board would arrive with
   * every repo closed and then reopen one under you a second later. `state.first` is
   * what stops it being decided twice.
   */
  function warmBoot() {
    const hit = window.beadcause?.warm?.read?.('/api/prs');
    if (!Array.isArray(hit?.data?.repos)) return false;
    state.data = hit.data;
    observing.hidden = !state.data.observing;
    if (state.first) {
      state.first = false;
      state.card = (state.data.repos || []).find((r) => r.prs.length && inSpace(r))?.key || null;
    }
    render();
    return true;
  }

  /**
   * Everything this page used to do at boot, now that it is a pane and boots when it is
   * shown.
   *
   * One request, since bc-khoe.7 took the deploy poll off this page. A board opened during
   * a deploy is looking at a daemon that is restarting and this fetch is the one that
   * fails; what says why is /releases, which is where the strip that used to explain it
   * went.
   */
  function mount() {
    warmBoot();
    load();
  }

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    /* Nothing is asked for until the PRs chip is up, and asking again when you come back
       to it is the same call. That is worth more here than on the pane beside it: this
       board is a `gh` sweep per repo, so a page that swept for it on every visit to
       /monitor would be paying GitHub for a screen most visits never look at. The chip
       row calls back once at boot too, so arriving on /prs — which is this page with the
       board already up — is the ordinary path through here and not a special case.

       `mounted` rather than the callback's `prev`, which would be right only if the first
       showing were always the boot one. It is not: arriving on /monitor and *then* tapping
       PRs is the common way in, and the warm paint below belongs to the first time this
       pane is drawn whenever that happens. The fallback is a service worker holding a
       monitor.html from before the chip row was a file; see the same guard in monitor.js. */
    const tabs = window.beadcause?.monTabs;
    let mounted = false;
    if (!tabs) mount();
    else
      tabs.onChange((which) => {
        // Away: nothing to stand down beyond the stream, which does it itself through
        // `upNow` — see `ready` in `follow`, and `wake`'s first line in the shell. The
        // empty string is one of the answers here now: it is the pane itself going away,
        // which this section can no more tell from a chip swap than it needs to.
        if (which !== TAB) return;
        if (!mounted) {
          mounted = true;
          return mount();
        }
        load();
      });
  }
})();
