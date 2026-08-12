/* The pull requests, and how far each one has actually got.
 *
 * The inbox asks *may I merge this?* and the card is gone the moment you answer. It also
 * now carries a card per pull request (bc-l8jp.6), which is what took **PRs** off the
 * bottom bar — so this is no longer a tab, and it is still the whole of the shipping
 * screen: the release queue, the deploy in flight, and the buttons that act on one row.
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
 * **And above all of it, the deploy that is happening now.** The Deployed lamp answers
 * *is it running?* — the strip answers *is it being made to run, right this second?*,
 * which is a different question with a much shorter fuse, because on this repo a
 * deploy SIGKILLs the daemon serving this page. It sits at the top rather than beside
 * the lamp it belongs to: a lamp is something you scan for, and a restart in flight is
 * something you are told. Three things about it:
 *
 * - **It has a clock only while something is running.** Four seconds then, because a
 *   step is a file being written on the Mac and no event can carry it — the board
 *   behind it is a `gh` call per repo and could never go that fast, where /api/deploys
 *   is a directory read and can. With nothing running there is no timer at all: the
 *   daemon says on the event log when a deploy *starts* as well as when it settles, so
 *   an idle board holds a socket and asks for nothing until one does.
 * - **A dropped connection during a restart is the deploy working, not the page
 *   breaking.** When a live deploy says it restarts beadcause, a failed fetch is
 *   drawn as "it is coming back" and the last board is left on screen — where the
 *   generic "can't reach the server" would have thrown away the one thing that
 *   explains it.
 * - **Four endings, not two.** ok, failed, and the two that mean *nobody knows*:
 *   `unconfirmed` — the command ran and nothing outlived it to say what happened,
 *   which is the ordinary ending of a restart — and `lost`. Neither is drawn as a
 *   tick, for the same reason a hollow lamp is not drawn as a no.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('prs');
  const pulse = document.getElementById('pulse');
  const observing = document.getElementById('observing');

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

  /* The deploy strip's own clock, while something is actually running. Fast enough that
     a step change is news rather than history — /api/deploys is a directory read, but a
     phone in a pocket should not be asking every four seconds all day. */
  const DEPLOY_LIVE_MS = 4000;

  /* The clock while nothing is running, which is now the *fallback* and not the rule:
     the daemon emits a `deploy` event when one starts, so a following stream is what
     turns the strip on. This is what a page with no stream behind it falls back to —
     see `scheduleDeploys`. */
  const DEPLOY_IDLE_MS = 30000;

  /* How many deploys the strip asks for. The last few are the subject; a history of
     forty is a different screen and nobody has asked for it. */
  const DEPLOY_LIMIT = 6;

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
    /** `{deploys, deployable}` from /api/deploys, or null before the first answer. */
    deploys: null,
    /** Which deploy is unfolded, by id. */
    deploy: null,
    /** `{id, deploy, log}` for the unfolded one — the full record, output and all. */
    detail: null,
    /** True while /api/deploys itself is unreachable. Read together with a live restart. */
    gone: false,
  };

  /* The row, the lamps, the ladder and the two time formats come from public/prcard.js —
     the inbox draws the same pull request from the same functions. Taken apart here rather
     than reached for through `window` at every call site, so this file reads as it did.
     It is loaded before this one (see monitor.html); a page without it has no board at
     all, which is why both are in one `sw.js` cache version. */
  const card = window.beadcause.prCard;
  const { esc, plural, age, ago, graphUrl, lampsHtml, factsHtml, bodyHtml } = card;

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
    return `Ship deploys ${esc(p.workspace)} from here${p.deployHint ? ` — ${esc(p.deployHint).replace(/`([^`]+)`/g, '<code>$1</code>')}` : ''}.`;
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
      buttons.push(
        `<button class="board-btn merge${armed ? ' armed' : ''}" data-act="merge" data-key="${esc(p.key)}">${
          armed ? `Merge #${p.number} — sure?` : 'Merge &amp; push'
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
    const armed = isArmed(c.workspace, 'release');
    const said = state.said?.key === c.workspace ? `<div class="board-said${state.said.bad ? ' bad' : ''}">${esc(state.said.text)}</div>` : '';
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
        ? `<button class="board-btn ship release-ship${armed ? ' armed' : ''}" data-act="release" data-key="${esc(c.workspace)}">${
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

    const title = c.repo || c.workspace;
    const live = liveDeploys().find((r) => r.workspace === c.workspace);
    // A deploy of this repo outranks the counts: the card's own summary is about work
    // waiting to ship, and something is shipping right now.
    const head = live ? phaseOf(live) : summary || (c.prs.length ? 'all shipped' : 'none');
    return cardHtml(c.workspace, title, head, Boolean(live || open || owed), body);
  }

  /* ------------------------------------------------------------------- deploys */

  /** The statuses a runner still owns — the mirror of LIVE in lib/deploy.js. */
  const LIVE = new Set(['queued', 'pulling', 'building', 'deploying']);

  /**
   * Every status as a word and a colour.
   *
   * The two "we do not know" endings get their own tone rather than borrowing failure's:
   * an `unconfirmed` restart is the *expected* ending on this repo, and painting it red
   * every time would teach you to ignore the colour that means something broke.
   */
  const SAYS = {
    queued: { word: 'starting', tone: 'live' },
    pulling: { word: 'bringing the checkout up to date', tone: 'live' },
    building: { word: 'rebuilding', tone: 'live' },
    deploying: { word: 'running the deploy', tone: 'live' },
    ok: { word: 'deployed', tone: 'good' },
    failed: { word: 'failed', tone: 'bad' },
    unconfirmed: { word: 'unconfirmed', tone: 'warn' },
    lost: { word: 'lost', tone: 'warn' },
  };

  const says = (r) => SAYS[r?.status] || { word: String(r?.status || 'unknown'), tone: 'warn' };

  const deploys = () => state.deploys?.deploys || [];
  const liveDeploys = () => deploys().filter((r) => LIVE.has(r.status));

  /**
   * Is the daemon about to go away, or already gone?
   *
   * Only a deploy that has *declared* it restarts beadcause counts. Everything else
   * that cannot be reached is a server that cannot be reached, and saying "it is
   * restarting" over that would be the comfortable lie rather than the true one.
   */
  const restarting = () => liveDeploys().some((r) => r.restarts);

  /**
   * Which step it is on, in a phrase.
   *
   * The status *is* the step — the runner writes it before each phase rather than
   * after, precisely so a record read mid-flight says where it got to. What is
   * deliberately not read here is the last entry in `steps`: a step is appended when
   * it *finishes*, so during a rebuild the newest one is the `git diff` before it, and
   * "rebuilding · git diff --name-only" would be a confident sentence about the wrong
   * thing. The unfolded row lists what has actually run, which is the honest version.
   *
   * The restart is called out because it is the one phase that ends this page.
   */
  function phaseOf(r) {
    const { word } = says(r);
    if (r.status === 'deploying' && r.restarts) return `${word} · restarting beadcause`;
    return word;
  }

  /**
   * How long it has taken, or took.
   *
   * A live one is measured against now, so the number grows every poll — which is the
   * only thing on the row that distinguishes a deploy that is working from one that
   * has been sitting on the same step for four minutes.
   */
  function tookOf(r) {
    const from = Date.parse(r.startedAt || r.requestedAt || '');
    const to = LIVE.has(r.status) ? Date.now() : Date.parse(r.finishedAt || r.heartbeatAt || '');
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return '';
    const secs = Math.round((to - from) / 1000);
    return secs < 90 ? `${secs}s` : `${Math.round(secs / 60)}m`;
  }

  /** One step, as the two things anyone reads: did it work, and how long did it take. */
  function stepHtml(s) {
    const good = s.code === 0;
    return `<li class="deploy-step ${good ? 'good' : 'bad'}">
      <span class="deploy-tick" aria-hidden="true">${good ? '✓' : '✗'}</span>
      <span class="deploy-step-name">${esc(s.name)}</span>
      <span class="deploy-step-note">${good ? '' : `exit ${esc(s.code)}${s.signal ? ` (${esc(s.signal)})` : ''} · `}${esc(
        s.ms >= 1000 ? `${(s.ms / 1000).toFixed(1)}s` : `${s.ms}ms`
      )}</span>
      ${s.output ? `<pre class="deploy-out">${esc(s.output.trim())}</pre>` : ''}
    </li>`;
  }

  /**
   * The unfolded deploy: what it moved, every step it ran, and the runner's own log.
   *
   * The log is a second request (`?id=`) because the list deliberately does not carry
   * it — see `briefDeploy` in lib/deploy.js. Until it arrives the steps are already
   * there, which is the part that answers "where did it stop".
   */
  function deployOpenHtml(r) {
    const detail = state.detail?.id === r.id ? state.detail : null;
    const rec = detail?.deploy || r;
    const moved =
      rec.from && rec.to && rec.from !== rec.to
        ? `<code>${esc(rec.from.slice(0, 7))}</code> → <code>${esc(rec.to.slice(0, 7))}</code>${
            rec.changed?.length ? ` · ${plural(rec.changed.length, 'file')}` : ''
          }`
        : rec.to
          ? `already at <code>${esc(rec.to.slice(0, 7))}</code> — the pull moved nothing`
          : '';

    // The checkout, unless naming it would only repeat the workspace already on the
    // row — which is the ordinary case, and a line that says "demo · demo" reads as a
    // bug rather than as a detail.
    const where = rec.dir?.replace(/^.*\//, '');
    const dir = where && where !== rec.workspace ? `<code>${esc(where)}</code>` : '';

    return `<div class="deploy-body">
      ${rec.error ? `<p class="deploy-why">${esc(rec.error)}</p>` : ''}
      <div class="deploy-where">
        ${moved}${moved && dir ? ' · ' : ''}${dir}
        ${rec.bead ? ` · <a class="pill id" href="${esc(graphUrl(rec.workspace, rec.bead))}">${esc(rec.bead)}</a>` : ''}
      </div>
      ${rec.reason ? `<p class="deploy-reason">${esc(rec.reason)}</p>` : ''}
      ${(rec.steps || []).length ? `<ol class="deploy-steps">${rec.steps.map(stepHtml).join('')}</ol>` : ''}
      ${
        detail?.log
          ? `<pre class="deploy-log">${esc(detail.log.trim().split('\n').slice(-40).join('\n'))}</pre>`
          : // Three states, not two: still fetching, and a runner that genuinely printed
            // nothing — which a permanent "fetching…" would misreport as a hung request.
            `<p class="deploy-loading">${detail ? 'The runner printed nothing.' : 'Fetching what it printed…'}</p>`
      }
    </div>`;
  }

  function deployHtml(r) {
    const open = state.deploy === r.id;
    const { tone } = says(r);
    const took = tookOf(r);
    return `<article class="deploy ${tone}${LIVE.has(r.status) ? ' live' : ''}">
      <button class="deploy-row" type="button" data-deploy="${esc(r.id)}" aria-expanded="${open}">
        <span class="deploy-main">
          <span class="deploy-what"><span class="deploy-dot" aria-hidden="true"></span>${esc(r.workspace)}<span
            class="sr-only"> deploy: </span><span class="deploy-said">${esc(phaseOf(r))}</span></span>
          <span class="deploy-sub">${esc(
            LIVE.has(r.status) ? `${took} so far` : `${took} · ${ago(r.finishedAt || r.requestedAt)}`
          )}</span>
        </span>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${open ? deployOpenHtml(r) : ''}
    </article>`;
  }

  /**
   * The strip, or nothing at all.
   *
   * Nothing is the ordinary state of this page and it should look like it: a repo that
   * has never been deployed from here gets no empty box explaining that. The banner is
   * the exception — while the daemon is unreachable *and* a restart is in flight, the
   * strip is the only thing on the page that can say why.
   */
  function deploysHtml() {
    // A deploy belongs to the repo it ships, so the strip narrows with everything else.
    // The banner does not: a restart of beadcause itself is why this page is blank, and
    // suppressing the one line that says so because the deploy was of another repo
    // would leave the screen unexplained.
    const list = deploys().filter(inSpace);
    const banner =
      state.gone && restarting()
        ? `<p class="deploy-banner">beadcause is restarting — that is the deploy. This page comes back on its own.</p>`
        : '';
    if (!list.length) return banner ? `<section class="deploys">${banner}</section>` : '';
    return `<section class="deploys">${banner}${list.map(deployHtml).join('')}</section>`;
  }

  /* -------------------------------------------------------------------- render */

  /**
   * The board half of the page, as markup rather than as a write.
   *
   * It returns a string because the deploy strip renders above it and the two arrive
   * on different clocks: a `render()` that wrote `out.innerHTML` from here would drop
   * whichever half had not been fetched yet, and during a restart the half that is
   * missing is exactly the half that explains the other one.
   */
  function boardHtml() {
    const d = state.data;
    if (!d) {
      if (state.error) return `<div class="empty"><strong>Can't reach the server</strong>${esc(state.error)}</div>`;
      return state.deploys ? '' : '<div class="empty">Asking every repo…</div>';
    }

    if (d.unavailable) return `<div class="empty"><strong>No pull requests to show</strong>${esc(d.unavailable)}</div>`;

    // The board on screen is the last one that came back. Saying when, rather than
    // replacing it with an error, is the difference between a stale answer you can
    // read and no answer at all — and during a restart it is stale on purpose.
    const stale = state.error
      ? `<p class="board-foot bad board-quiet">Showing the board as of ${esc(ago(d.at))} — the last refresh did not answer.</p>`
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
    if (cards || rest) return stale + cards + rest + build;
    const only = (d.repos || []).length ? ` in ${esc(window.beadcause?.space?.label?.() || 'this space')}` : '';
    return `${stale}<div class="empty">${only ? `No repos${only}.` : 'No workspaces configured.'}</div>`;
  }

  function render() {
    if (!state.data && !state.deploys && !state.error) return;
    const scrollY = window.scrollY;

    out.innerHTML = deploysHtml() + boardHtml();

    // There was a badge here — open decisions plus merged work that is not running, hung
    // off the PRs tab. The tab is gone (bc-l8jp.6) and so is the badge: what it was for
    // is now a count on the inbox's own PR filter chip, which sits above the list the
    // pull requests are actually in. A badge painted onto a bar with no tab to hang it
    // from would be a number nobody can see.

    window.scrollTo(0, scrollY);
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
  /** The card for a workspace — what the release strip's button acts on. */
  const cardFor = (ws) => (state.data?.repos || []).find((r) => r.workspace === ws) || null;

  /**
   * Ship the whole queue: one deploy, every merge on it.
   *
   * Kept apart from `act` rather than folded into it, because every branch in there is
   * about a *row* — it looks the pull request up by key, sends its number, and pins the
   * outcome under it. This one has no row: its key is a workspace, and the outcome
   * belongs to the strip at the top of the card.
   */
  async function shipQueue(ws) {
    const card = cardFor(ws);
    if (!card?.release?.count || state.busy) return;
    if (!isArmed(ws, 'release')) {
      state.armed = `release@${ws}`;
      return render();
    }

    const count = card.release.count;
    state.busy = true;
    state.armed = null;
    state.said = { key: ws, text: `Deploying ${ws} — ${plural(count, 'merged pull request')}…`, bad: false };
    render();

    let started = false;
    try {
      const res = await fetch('/api/release/ship', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token },
        body: JSON.stringify({ workspace: ws }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      started = true;
      // Never "shipped". A 200 means a record is on disk and a detached runner owns it;
      // on this repo the next thing that happens is the daemon being killed by its own
      // deploy, and the outcome arrives on the strip above and on the phone.
      state.said = {
        key: ws,
        text: `Deploying ${ws} — ${data.deploy?.id || 'started'}, carrying ${plural(count, 'merge')}. How it went lands on your phone.`,
        bad: false,
      };
    } catch (err) {
      state.said = { key: ws, text: err.message, bad: true };
    } finally {
      state.busy = false;
      render();
      if (started) loadDeploys();
    }
  }

  async function act(key, action) {
    if (action === 'release') return shipQueue(key);
    const p = rowFor(key);
    if (!p || state.busy) return;

    // Merge always arms. Ship arms only where it will *deploy* — where it opens a
    // window instead, the window is the guard: you can watch it and stop it, which is
    // the whole reason this button never needed a second tap before it could deploy.
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
      text: action === 'ship' ? (p.deployDeclared ? `Deploying ${p.workspace}…` : 'Opening a window on the Mac…') : 'Working…',
      bad: false,
    };
    render();

    const url = action === 'merge' ? '/api/pr/merge' : action === 'ship' ? '/api/pr/ship' : '/api/pr/comment';
    const body = { workspace: p.workspace, number: p.number };
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
        // Both halves, always. A merge that landed and a fast-forward that was refused
        // because there is uncommitted work in the checkout is a good outcome, and one
        // word over the pair would send you to the Mac to find out which happened.
        //
        // And the third half where there was one: merging here spends the inbox's own
        // "Merge #N?" card, and a card that vanishes from another screen with nothing
        // said about it is indistinguishable from a card that was never there. What is
        // reported is the *bead* rather than the card id, because the bead is what you
        // were waiting on — the card was only how it was asked.
        const closed = (data.cards || []).filter((c) => c.closed);
        const beads = closed.map((c) => c.work?.closed && c.bead).filter(Boolean);
        state.said = {
          key,
          text:
            `${data.alreadyMerged ? `#${p.number} was already merged` : `Merged #${p.number}`} — ${
              data.land?.note || 'nothing else to do here'
            }.` +
            (closed.length ? ` Closed its inbox card${beads.length ? ` and ${beads.join(', ')}` : ''}.` : ''),
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
              // being killed by its own deploy, and the outcome arrives later, on the
              // strip at the top of this page and on this phone.
              text: `Deploying ${p.workspace} — ${data.deploy?.id || 'started'}. How it went lands on your phone.`,
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
      // Merging changes the lamps on the row you are looking at, so go and find out
      // rather than leaving a board that still says "open" over a merged PR.
      if (action === 'merge') load({ refresh: true });
      // A ship that deployed has just put a record on disk, and the strip at the top
      // of this page is the thing that says what it is doing. Its idle timer is half a
      // minute away, which over a restart of *this daemon* is most of the deploy.
      if (started) loadDeploys();
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

    const deploy = ev.target.closest('[data-deploy]');
    if (deploy) {
      const id = deploy.dataset.deploy;
      state.deploy = state.deploy === id ? null : id;
      // The detail belongs to whichever one is open; keeping the old one would flash
      // the previous deploy's log under the row you just unfolded.
      state.detail = null;
      render();
      if (state.deploy) loadDetail(state.deploy);
      return;
    }

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
    pulse.classList.add('busy');
    try {
      const res = await fetch(`/api/prs${refresh ? '?refresh=1' : ''}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
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
        state.card = (state.data.repos || []).find((r) => r.prs.length && inSpace(r))?.workspace || null;
      }
      state.error = null;
      render();
      // Only from a request that came back, and only once — see public/warm.js.
      window.beadcause?.warm?.prewarm?.({ here: 'prs', api: warmApi });
    } catch (err) {
      // Kept in state rather than written over the page: `boardHtml` decides what a
      // failure looks like, and with a board already on screen it is a line under the
      // deploy strip instead of the loss of everything the page was showing.
      state.error = err.message;
      render();
    } finally {
      pulse.classList.remove('busy');
      // Whether or not that worked, and deliberately: a board opened during a deploy —
      // which is exactly when this page is opened — is looking at a daemon that is
      // restarting, and with the minute timer gone the stream is the only thing that
      // brings it back on its own. See `follow`, and its backoff.
      follow();
    }
  }

  /* ------------------------------------------------------------ the deploy poll */

  /**
   * What is deploying, on its own timer.
   *
   * Separate from the board's fetch, and deliberately so: this is a directory read on
   * the daemon and can be asked every four seconds, where the board is a `gh` call per
   * repo and cannot. It is also the request that keeps working when the board's has
   * stopped mattering — during a restart neither answers, and this is the one whose
   * silence the page knows how to explain.
   */
  async function loadDeploys() {
    const wasLive = liveDeploys().length > 0;
    try {
      const res = await fetch(`/api/deploys?limit=${DEPLOY_LIMIT}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // The stub server in scripts/prs-check.mjs answers `{}` for anything it has no
      // opinion about, and a real daemon predating this endpoint would too. Neither is
      // a reason to draw an empty strip over a working board.
      state.deploys = Array.isArray(data.deploys) ? data : state.deploys;
      state.gone = false;
      render();
      // A live deploy's own record is what the open row is drawing, so keep it fresh —
      // this is how a step that finished while you were looking at it stops saying it
      // is still running.
      if (state.deploy && LIVE.has(deploys().find((r) => r.id === state.deploy)?.status)) loadDetail(state.deploy);
      // A deploy that has just settled has changed a lamp on the board behind it, and
      // the board's own poll is up to a minute away. Go and look, rather than leaving
      // Deployed dark over a repo that came back up ten seconds ago.
      if (wasLive && !liveDeploys().length && !state.busy && !state.armed && !state.draft) load({ refresh: true });
    } catch {
      // No message anywhere: with a restart in flight this is the deploy working, and
      // without one the board's own failure is already saying it. See `deploysHtml`.
      state.gone = true;
      render();
    } finally {
      // From here, not from the caller: whoever asked — the boot, the timer, the ⟳ —
      // has just changed the answer to "how fast should this page be asking", and the
      // pending timeout was set against the old one.
      scheduleDeploys();
    }
  }

  /** The whole record and the runner's log, for the one deploy that is unfolded. */
  async function loadDetail(id) {
    try {
      const res = await fetch(`/api/deploys?id=${encodeURIComponent(id)}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // The row may have been folded, or another opened, while this was in flight.
      if (state.deploy !== id) return;
      state.detail = { id, deploy: data.deploy || null, log: String(data.log || '') };
      render();
    } catch {
      /* the steps are already on screen from the list; the log is the bonus */
    }
  }

  /**
   * The strip's clock, set from what the last answer said rather than fixed at boot —
   * and, while nothing is running, no clock at all.
   *
   * A deploy's *steps* are a file being written on the Mac, and no event carries them,
   * so a deploy in flight is still watched on a fast timer: four seconds, which is what
   * makes a step change news rather than history. Nothing about that has changed.
   *
   * What has changed is the other end. This is the timer that survived the move onto the
   * delta stream, and it survived for one reason: `bus.emit({type: 'deploy'})` used to
   * fire only when a deploy *settled*, so nothing in the log ever said "something began
   * shipping", and a 30-second idle tick was the only thing that would notice a deploy
   * started somewhere else — the Ship button on another device, an agent's own
   * `POST /api/deploy`, the release queue shipping itself. lib/server.js emits on the
   * start too now (`beginDeploy` there), that event is already in `BOARD_EVENTS`, and
   * `onWake` below turns this clock back on the moment one arrives. So an idle board
   * holds a socket and asks for nothing.
   *
   * **The fallback is not decoration.** A page whose stream is not following has nothing
   * to wake it, and a strip that had quietly stopped refreshing would look exactly like
   * one with nothing to say. That is the whole failure mode public/stream.js's own
   * `onSettle` contract exists for, so the idle tick is still here and is used whenever
   * the stream is not up: an older service-worker shell with no stream.js at all, a stub
   * or a proxy that keeps no log, a poll between its failure and its next retry.
   *
   * The previous timeout is always cleared, so a ⟳ in the middle of a wait moves the
   * next tick rather than adding a second clock.
   */
  let deployTimer = null;
  function scheduleDeploys() {
    clearTimeout(deployTimer);
    deployTimer = null;
    // Not while the board is behind another chip. The strip is the one thing on this
    // page with a clock of its own, so a hidden board that kept it would be a request
    // every four seconds for a pane nobody is looking at — and at the *fast* cadence,
    // because a live deploy is exactly when you are most likely to have swapped away to
    // watch the sessions it is restarting.
    if (out.hidden) return;
    // Unreachable *and* a restart in flight is the fastest cadence there is a reason
    // for: nothing on the page will change until the daemon is back, and that is the
    // moment worth catching.
    if (liveDeploys().length || (state.gone && restarting())) {
      deployTimer = setTimeout(loadDeploys, DEPLOY_LIVE_MS);
      return;
    }
    if (!stream?.following) deployTimer = setTimeout(loadDeploys, DEPLOY_IDLE_MS);
  }

  /* The space picker moved — on this device or on the other one. Nothing is refetched:
     the board already holds every repo, and which of them is drawn is a decision made
     at paint time. An open card in a repo that has just been filtered away is closed
     with it, or reopening the space would leave a fold nobody remembers opening. */
  window.beadcause?.space?.onChange(() => {
    if (state.card && !(state.data?.repos || []).some((r) => r.workspace === state.card && inSpace(r))) {
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
    if (out.hidden) return;
    loadDeploys();
    load({ refresh: true });
  });

  /* ------------------------------------------------------------------- the stream */

  /**
   * Follow the event log instead of re-asking on a clock.
   *
   * `want: 'presence'` is what makes the park free: the daemon sweeps `bd` for a poll
   * that asked for the inbox questions, and this page draws none of them — it wants to
   * be woken, and then it decides for itself whether the news was about a pull request.
   * `cold: true` because `/api/prs` carries no sequence, and with `want: 'presence'` the
   * `since`-less first request that learns one costs nothing.
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
  let stream = null;
  function follow() {
    if (!window.beadcause?.stream) return;
    // Mounted once and started every time `load` runs — the boot and the ⟳ — so a stream
    // that gave up after a run of failures can be picked back up by hand. `start` on one
    // that is already parked is a no-op.
    if (stream) {
      stream.start();
      return scheduleDeploys();
    }
    stream = window.beadcause.stream.follow({
      api: warmApi,
      want: 'presence',
      cold: true,
      /* Only while the board is the pane you are on. This costs more than the same guard
         on the advocates pane does: every wake this board acts on is a `gh` sweep per
         repo, and a hidden board following the log would spend one on every merge all
         day for a screen nobody has open. Coming back calls `load`, which calls `follow`,
         which restarts a stream that stood itself down. */
      ready: () => !out.hidden,
      onWake({ events, resync }) {
        // Not while you are mid-sentence or holding an armed merge: a repaint would
        // throw the first away and disarm the second under your thumb. The ⟳ is still
        // there, and so is the next event.
        if (state.busy || state.armed || state.draft) return;
        // We have lost our place in the log, so nothing on screen is provably current —
        // this is one of the three cases that earns a forced sweep.
        if (resync) {
          loadDeploys();
          load({ refresh: true });
          return;
        }
        if (!window.beadcause.stream.touched(events, BOARD_EVENTS)) return;
        load();
        // A deploy has started, or settled — lib/server.js emits the same event type for
        // both, and the record's `status` is what tells them apart. This is the whole of
        // the strip's clock while nothing is running: `loadDeploys` re-reads the journal
        // and `scheduleDeploys` behind it puts the page onto the fast tick if what came
        // back is live. The steps *within* a deploy are still a file being written on the
        // Mac and nothing the log can carry, which is why the fast tick exists at all.
        if (window.beadcause.stream.touched(events, 'deploy')) loadDeploys();
      },
      /**
       * The stream has stopped — put the timer back until it is following again.
       *
       * public/stream.js retries a broken poll on its own, and this fires whether or not
       * one is coming: a page in a pocket, a daemon mid-restart, something that answers
       * `/api/poll` but keeps no log at all. Every one of those is a strip with nothing
       * left to wake it, and a strip that has quietly stopped refreshing looks exactly
       * like one with nothing to say. `scheduleDeploys` reads `stream.following` and
       * decides; it is called here rather than reasoned about, so the fallback and the
       * fast tick stay one decision made in one place.
       */
      onSettle() {
        scheduleDeploys();
      },
    });
    stream.start();
    // The strip's fallback tick was decided before this existed — the boot calls
    // `loadDeploys` while `load` is still in flight, and `follow` runs at the end of it.
    // Decide it again now that there is a stream to ask, or an idle board would poll
    // once more for nothing.
    scheduleDeploys();
  }

  /**
   * A plain GET, for the background warm and for the delta stream.
   *
   * This page fetches with bare `fetch` in four places rather than through one
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
      state.card = (state.data.repos || []).find((r) => r.prs.length && inSpace(r))?.workspace || null;
    }
    render();
    return true;
  }

  /**
   * Everything this page used to do at boot, now that it is a pane and boots when it is
   * shown.
   *
   * `loadDeploys` runs alongside the board rather than after it: if a deploy is in flight
   * the board's request is the one that is about to fail, and the strip is what says why.
   * It schedules its own next tick — see `scheduleDeploys`.
   */
  function mount() {
    warmBoot();
    load();
    loadDeploys();
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
        // Away: stand the strip's clock down. `scheduleDeploys` reads `out.hidden` and
        // decides, so the rule lives in one place — and the stream stands itself down
        // through the same attribute, see `ready` in `follow`.
        if (which !== 'prs') return scheduleDeploys();
        if (!mounted) {
          mounted = true;
          return mount();
        }
        loadDeploys();
        load();
      });
  }
})();
