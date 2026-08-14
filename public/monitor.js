/* The advocate console — what every repo's advocate is doing, and why.
 *
 * bin/monitor.js gave each advocate one line: a workspace name, one state word, and
 * up to three bead ids. Behind that line sits a 929-line subsystem that surveys a
 * tracker, opens sessions, gives up on beads, argues for new ones, archives what its
 * sessions did to a git ref and sweeps the worktrees they left. None of that was
 * visible anywhere, so an advocate holding off for a perfectly good reason and an
 * advocate that had quietly broken looked identical.
 *
 * This page is the whole of `advocates.snapshot()` laid out per repo, plus the three
 * things the snapshot can only point at: the survey agent's live transcript, the
 * proposals waiting on you, and the session logs it pushed to refs.
 *
 * **It is also the sessions view.** `/sessions` was a second page over the same
 * `/api/work` payload — the same card per repo, the same claimed beads, the same live
 * `claude` rows, one advocate state line each — and every question it answered is
 * answered here, per repo, which is the way you actually arrive: "what is running" is
 * nearly always "what is running *in this repo*". The one thing it had that this page
 * did not was somewhere for a session row to go, and that stopped being true when the
 * detail moved out to `/session?pid=` and every list in the app got the same link. So
 * `/sessions`, `/work` and `/work.html` all serve this page now, and public/work.js is
 * gone.
 *
 * **It reads and it does not instrument.** Everything here comes from endpoints the
 * daemon already served — `/api/work`, `/api/questions`, `/api/advocate-log`,
 * `/api/session-archive` — and the only writes are the ones you press: the advocate
 * controls and answering a proposal. That is the property bin/monitor.js's header
 * claimed and it is worth keeping: a console wedged on a slow request must never
 * cost the daemon a question.
 *
 * Two disciplines carried over from the page it absorbed, because they are what make
 * this one honest rather than merely full:
 *
 *   - **A worker is a window we opened, not a process we can see.** The rows say what
 *     is actually known — the bead, when it opened, whether it was ever claimed — and
 *     name a pid only where the session took the bead id into its own name.
 *   - **A held-off advocate is drawn, never hidden.** Paused, quiet, cooling down and
 *     out-of-slots each say so in full, because an advocate you cannot see is
 *     indistinguishable from a repo with nothing left to do.
 *
 * Every session listed here — a worker row whose window is still running, a "Claude
 * sessions" row, an Elsewhere row — links to `/session?pid=…`, the same detail the
 * mirror sends you to, and it opens in the drawer over this console. The rows on this
 * page used to be inert `<div>`s, and the detail behind them existed in exactly one
 * place: folded inline under the row on /sessions. Giving every row the one address is
 * what made that page a strict duplicate of this one, and so what let it go. See
 * public/session.js.
 */
(() => {
  'use strict';

  /**
   * The same `?t=` pickup the inbox does, and this page needs it more.
   *
   * scripts/open-monitor.sh opens this at login in whatever browser is default, and
   * that profile may never have been paired — it is a Mac window, not the phone that
   * scanned the QR. Taking the token from the URL means the login window works the
   * first time; stripping it afterwards keeps it out of the address bar and out of
   * the history entry.
   */
  const token = (() => {
    const fromUrl = new URLSearchParams(location.search).get('t');
    if (fromUrl) {
      localStorage.setItem('beadcause.token', fromUrl);
      history.replaceState(null, '', location.pathname + location.hash);
    }
    return localStorage.getItem('beadcause.token') || '';
  })();

  const out = document.getElementById('mon');
  const pulse = document.getElementById('pulse');
  const tally = document.getElementById('tally');
  const observing = document.getElementById('observing');

  /* There were three `bd` calls per workspace behind /api/work and a whole inbox sweep
     beside them, every twenty seconds, for as long as this page was open. It follows the
     daemon's event log now (see `follow` below), which changes the bargain in two ways:

     - **The roster arrives free.** `/api/poll` carries `advocates.snapshot()` on every
       wake, whatever woke it. So a pause, a resume, a check-in, a slot freeing — most of
       what this page is *about* — lands here without a request of any kind.
     - **The `bd` half is asked for only when something happened that `bd` would answer
       differently.** A claimed bead, a session opening, a proposal filed. An advocate
       merely saying it is still surveying is a repaint and nothing more.

     What has no event and cannot have one is a session claiming a bead in a terminal
     nobody told the daemon about. That used to be caught within twenty seconds by the
     timer and is now caught by the next event, the ⟳, or coming back to the page. In
     practice a running advocate emits several events a minute, so the page it matters on
     is the busy one. */
  const LOG_MS = 2500;

  /* Which advocate actions repaint for free and which are worth going back to `bd` for
     used to be a set and a predicate here. Both moved into public/stream.js as
     `workMoved` (bc-xxzz), because the inbox asks the same question about the copy it
     holds *for* this page, and two copies of that judgement drifting apart would mean
     the inbox handing this page a warm payload missing exactly the row you tapped
     through to see. See `follow` below for the only use of it left here. */

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** How long it has been going — the number that tells you it is stuck. */
  function age(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  }

  /**
   * "surveyed 14m ago" — the past-tense form, for the timeline in the card foot.
   *
   * `age` already returns a whole phrase for the first minute, so "just now" takes no
   * "ago" after it. Everything else is a bare duration and needs one.
   */
  function ago(iso, verb) {
    if (!iso) return `never ${verb}`;
    const a = age(iso);
    return `${verb} ${esc(a)}${a === 'just now' ? '' : ' ago'}`;
  }

  const graphUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}${id ? `&id=${encodeURIComponent(id)}` : ''}`;

  /** The one address a session has anywhere in the app — see public/session.js. */
  const sessionUrl = (pid) => `/session?pid=${encodeURIComponent(pid)}`;

  const P_LABEL = ['P0', 'P1', 'P2', 'P3', 'P4'];

  /* --------------------------------------------------------------------- state */

  /**
   * Which sections you had open, kept across refreshes and across reloads.
   *
   * The page repaints every twenty seconds and after every control press. A
   * transcript that collapsed under you mid-read would make the one panel worth
   * watching the one panel you cannot watch.
   */
  const state = {
    work: null,
    proposals: new Map(), // workspace → [question]
    logs: new Map(), // workspace → { lines, running }
    archives: new Map(), // workspace → { bead, ref, sessions } or { text }
    open: new Set(readOpen()),
    picks: new Map(), // question key → Map(1-based bead index → 'yes' | 'no')
    error: null,
    /** The selected space's own configuration — see `/api/space` and spaceHtml. */
    space: null,
    spaceError: null,
    /** What the last press changed, in the daemon's words rather than the label's. */
    spaceSaid: null,
    /* The Slack channel field, which is the one control on this card you *type* into.
       Same reason as the steppers below: a stream event repaints this page under your
       thumb, and a half-typed channel id living in the DOM would be thrown away by a
       poll nobody asked for. `{ space, text }`, dropped the moment a press sends it. */
    slackDraft: null,
    /* The three halves of a stepper that has been moved but not yet applied — see
       `limitControl`. All keyed the same way (`stepKey`), and all in `state` rather
       than in the markup for one reason: this page repaints off a poll every couple
       of seconds, so a number held in the DOM would be thrown away under the thumb
       that was still adjusting it. `applyingLimits` is here for the same reason — a
       repaint mid-write must not hand back an enabled control. */
    pendingLimits: new Map(), // step key → the number you have dialled up, not yet sent
    applyingLimits: new Set(), // step key → a write is in flight
    limitErrors: new Map(), // step key → why the last apply was refused
    /* The pull request board, for the one thing this page wants off it: how many merges
       each repo is holding that are not live yet. `/api/prs`'s own payload, unaltered, so
       the strip below draws from exactly what the PRs pane draws from. */
    board: null,
    boardAt: 0, // when it was last fetched, so this page is not asking on every repaint
    /** The armed Ship, as a repo key. At most one on the page — the second tap deploys. */
    armedShip: null,
    /** What the last Ship said, pinned to the card it was pressed on. */
    shipSaid: null, // { key, text, bad }
    shipping: false,
  };

  function readOpen() {
    try {
      return JSON.parse(localStorage.getItem('beadcause.mon.open') || '[]');
    } catch {
      return [];
    }
  }

  const isOpen = (key) => state.open.has(key);

  function toggle(key) {
    if (state.open.has(key)) state.open.delete(key);
    else state.open.add(key);
    localStorage.setItem('beadcause.mon.open', JSON.stringify([...state.open]));
  }

  const picksFor = (key) => {
    if (!state.picks.has(key)) state.picks.set(key, new Map());
    return state.picks.get(key);
  };

  /**
   * Is there a process behind this pid *in the payload we are drawing*?
   *
   * Only the worker rows need to ask. A session row came out of `sessions` and is live
   * by construction; a worker's `pid` is whatever the last advocate tick found by
   * matching a session name against the bead id, and the window may have gone since.
   * So a worker with a live pid goes to `/session?pid=…` and one without keeps its bead
   * link, which is the one honest thing left to point at.
   */
  function livePid(pid) {
    if (pid == null || pid === '') return false;
    const want = Number(pid);
    if (!Number.isInteger(want) || want <= 0 || !state.work) return false;
    return (
      (state.work.elsewhere || []).some((s) => s.pid === want) ||
      (state.work.workspaces || []).some((w) => (w.sessions || []).some((s) => s.pid === want))
    );
  }

  /**
   * A live `claude` process, wherever on this page it is listed.
   *
   * One function for what used to be three near-identical blocks — the "other work in
   * this repo" section, a repo with no advocate, and the Elsewhere card — because they
   * had drifted into three slightly different rows for the same thing, and because
   * making a row a link to somewhere was exactly the change that must not be made in
   * two of three places.
   */
  function sessionRow(s) {
    // The label names the session as well as the destination: `aria-label` replaces the
    // row's text outright, so one saying only "what pid 30342 is doing" would take the
    // session's own name away from the reader who needs it most.
    return `<a class="work-row session-row" href="${esc(sessionUrl(s.pid))}" aria-label="${esc(
      s.name || `pid ${s.pid}`
    )} — what it is doing">
      <span class="work-phase">${s.status === 'busy' ? '<span class="spark"></span>' : '○'}</span>
      <span class="work-main">
        <span class="work-title">${esc(s.name || '(unnamed session)')}</span>
        <span class="work-sub">${esc(s.where || s.cwd)} · pid ${esc(s.pid)}${
          s.status ? ` · ${esc(s.status)}` : ''
        }</span>
      </span>
      <time>${esc(age(s.at))}</time>
    </a>`;
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

  /* ------------------------------------------------------------------- pieces */

  /**
   * One line for what the advocate is doing right now, in the order that decides it.
   *
   * The order matters and mirrors `tickOne`: an error beats everything because a
   * tracker it cannot read makes every other field stale; paused beats quiet because
   * you set it; quiet beats the queue because it explains a queue that isn't moving.
   */
  function stateOf(a) {
    if (a.error) return { text: `cannot read the tracker — ${a.error}`, tone: 'bad' };
    if (a.paused) return { text: `paused · ${plural(a.queue, 'bead')} ready`, tone: 'held' };
    if (a.quiet) return { text: `quiet hours · watching, not launching`, tone: 'held' };
    if (a.surveying) return { text: 'surveying for work worth proposing', tone: 'live' };
    if (a.workers.length) return { text: `${a.workers.length} of ${plural(a.limit, 'session')}`, tone: 'live' };
    if (a.queue) return { text: `${plural(a.queue, 'bead')} ready, none picked up`, tone: 'warn' };
    return { text: 'clear — no ready beads', tone: '' };
  }

  /**
   * How many sessions this advocate may open at once — and the way to change it.
   *
   * The number it steps is `limit`, the same field the chip above quotes, and pressing
   * a button changes it on the running daemon: no config edit, no restart. So the
   * control has to be honest about three things a plain `−  3  +` would hide:
   *
   * - **the range**, which is the daemon's `MAX_WORKERS_CEILING` and travels in the
   *   snapshot rather than being written here. An end of the range is a *disabled*
   *   button, not one that silently does nothing;
   * - **what it costs**, which is why the title says the number is windows on this
   *   Mac. Nine sessions is a decision, not a slider position;
   * - **the cap it cannot argue with.** `globalMaxWorkers` is a total across every
   *   advocate, so a repo stepped to 5 under a global 3 will still only get 3. The
   *   press worked and the number is real — it is the *other* number that is binding,
   *   and saying so is the difference between a control that looks broken and one
   *   that explains itself. `tickOne` writes the same sentence into the note once it
   *   is actually blocked; this says it the moment you press, which is when you are
   *   looking.
   *
   * What it no longer does is write on every press. Each ± used to POST — so 1 → 5
   * was four writes to config.json, four applies on the running daemon and four
   * repaints, with no moment in the middle where you could change your mind. The
   * number moves in the page now and Apply is what sends it, once.
   */
  const GLOBAL_STEP = 'global';
  /** Where a stepper's pending value lives. `global` has no repo, like its action. */
  const stepKey = (ws) => (ws ? `ws:${ws}` : GLOBAL_STEP);
  const stepWorkspace = (key) => (key === GLOBAL_STEP ? undefined : key.slice(3));
  const stepAction = (key) => (key === GLOBAL_STEP ? 'globalLimit' : 'limit');

  /**
   * `−  3  +  Apply` — the body both steppers share.
   *
   * One builder for the per-repo control and the global one, because they were already
   * deliberately the same control and the hold-until-Apply behaviour is the part it
   * would be worst to have two versions of.
   *
   * Three states, and each has to survive a repaint arriving mid-adjustment:
   *
   * - **settled** — no pending value, so the number is the daemon's and there is no
   *   Apply to press. Identical to what this control has always looked like;
   * - **moved** — you have stepped it. The pill picks up `pending`, Apply appears, and
   *   nothing has been written yet: the number under it is still `live`, which is what
   *   the Apply title says out loud so a control left half-adjusted cannot be mistaken
   *   for one that took;
   * - **applying** — the write is in flight. Every button in the control is disabled,
   *   including the steppers, because a ± landing between the POST and its answer
   *   would leave a pending number that no longer means anything.
   */
  function limitControl({ key, live, ceiling, held, pillTitle, fewerTitle, moreTitle }) {
    const want = state.pendingLimits.has(key) ? state.pendingLimits.get(key) : live;
    const busy = state.applyingLimits.has(key);
    const moved = want !== live;
    const step = (delta, label, title, atEnd) =>
      `<button class="adv-btn adv-step" data-step="${esc(key)}" data-value="${
        want + delta
      }" data-ceiling="${ceiling}" title="${esc(title)}"${atEnd || busy ? ' disabled' : ''}>${label}</button>`;
    return `<span class="adv-limit${held ? ' held' : ''}${moved ? ' pending' : ''}" title="${esc(pillTitle)}">
      ${step(-1, '−', fewerTitle, want <= 1)}
      <b>${want}</b>
      ${step(1, '+', moreTitle, want >= ceiling)}
      ${
        moved
          ? `<button class="adv-btn adv-apply primary" data-apply="${esc(key)}" title="${esc(
              busy ? `Setting it to ${want}…` : `Set it to ${want}. It is still ${live} — nothing has been written yet.`
            )}"${busy ? ' disabled' : ''}>${busy ? '…' : 'Apply'}</button>`
          : ''
      }
    </span>`;
  }

  function limitStepper(a) {
    return limitControl({
      key: stepKey(a.workspace),
      live: a.limit,
      ceiling: a.ceiling || 9,
      held: a.globalHeld,
      pillTitle: a.globalHeld
        ? `${a.limit} sessions at once — but globalMaxWorkers is ${a.globalMax} across every advocate, so this repo will not get more than that`
        : `How many sessions this advocate may open at once — one iTerm window each, on this Mac`,
      fewerTitle: 'One fewer session at a time',
      moreTitle: `One more session at a time (up to ${a.ceiling || 9})`,
    });
  }

  /** The refusal from the last Apply, drawn where the press was. */
  function limitErrorHtml(key) {
    const said = state.limitErrors.get(key);
    return said ? `<div class="adv-note bad">${esc(said)}</div>` : '';
  }

  /**
   * The repo the advocate is arguing for, and how much of it is its business.
   *
   * This is the "relates to its domain" half. The tracker's own numbers come first,
   * then the two that say what this advocate can actually act on: `queue` is what it
   * would take (ready, minus questions, minus held, minus anything under the priority
   * floor), and `deferredByPriority` is the part of `ready` it is deliberately leaving
   * alone. The difference between "4 ready" and "4 ready, 3 of them below the floor" is
   * the difference between an advocate that is idle and one that is behaving as told.
   * `closed` comes last of all and is the exception to the whole row: every other number
   * here is work that is not done, so it is the one that had to go after the holds
   * rather than beside `open` where the tracker itself puts it.
   *
   * `heldByRepo` is the newest of them and the odd one out: every other hold on this
   * row resolves itself in time — a window closes, a pull request merges, an epic's
   * children get done — and this one never will. A bead naming a `repo:` token nothing
   * approved declares, or one two approved repos both declare, waits on somebody
   * editing a label or an approved list, and until then it is out of the queue with
   * nothing else on screen accounting for it. Its tooltip carries lib/repos.js's own
   * sentence, which names the fix.
   *
   * `heldByChildren` is the third such subtraction, and it earns a pill for the same
   * reason: an epic whose children are the work is ready by bd's reckoning and not by
   * the advocate's, so without this the queue is one shorter than `bd ready` says and
   * nothing on screen accounts for the difference. Its `why` goes in the tooltip —
   * the pill is the number, "bc-3zo9.1 is ready under it" is the answer to the
   * question the number provokes.
   *
   * `heldByTwin` is the fourth, and the only one of them that can move on its own: a
   * bead held because another one is the same job comes back the moment that other one
   * closes. Which is exactly why it needs the pill — "1 ready" that never becomes a
   * session, with nothing on screen naming the bead it is waiting behind, is
   * indistinguishable from an advocate that has stopped working.
   *
   * `heldByPr` is the fifth (bc-utyr), and the one whose pill is a *link*: a bead held
   * because an open pull request already carries its work is waiting on something you
   * can act on from the phone you are reading this on — a merge, or a conflict to
   * resolve — and the board is where both taps live. The others name a bead you would
   * have to go and find; this one names a number and takes you to it.
   *
   * `heldByLive` is the sixth (bc-vq78), and the one whose tooltip names a *process*: a
   * bead held because a window is already open on it is waiting on that window ending,
   * and the pid is what tells you which of the fifteen on screen it is. It earns the
   * pill more than any of the others, because the state it prevents — two sessions
   * editing one worktree — is invisible from every other view here, which is precisely
   * how it went unnoticed for an hour.
   *
   * `heldByClaim` is the eighth (bc-mp8c), and the first that names a *file* rather than a
   * bead: another session on this Mac is editing what this bead would touch, so the window
   * was not opened. `filesBusy` beside it is the same collision over a surface guessed from
   * the bead's prose rather than declared on it — dispatched anyway, because a guess may not
   * withhold work (bc-hrno), and shown anyway, because whether that gate should ever be
   * turned on is a question only the pattern on this row can answer.
   *
   * `heldByNoP0` is the ninth (bc-rfnr.7), and the only one that is not about contention
   * at all: every other pill on this row names two things wanting one bead, and this one
   * names a bead nothing has asked for. It is `p1` for `heldByRepo`'s reason — those two
   * are the holds that never clear on their own — and its tooltip names the beads,
   * because the fix is one tap into each sheet and there is nowhere else to start.
   *
   * `heldByLease` is the seventh (bc-bllw), and the first that is not about this laptop:
   * a bead another engineer's Mac has claimed in the shared tracker. `stoodDown` is its
   * other half — a window *this* Mac gave up because the other machine's claim won the
   * tiebreak — and it is on this row rather than in the sessions list because a session
   * that has already been withdrawn is not a session any more. Both are `p1` rather than
   * muted: every other pill here names something on this screen, and these two name a
   * window on somebody else's desk, which you can only settle by asking them.
   */
  function domainHtml(w, a) {
    const c = w?.counts || {};
    const unplaced = (a && a.heldByRepo) || [];
    const waiting = (a && a.heldByChildren) || [];
    const twins = (a && a.heldByTwin) || [];
    const prs = (a && a.heldByPr) || [];
    const sitting = (a && a.heldByLive) || [];
    const claimed = (a && a.heldByLease) || [];
    const onFiles = (a && a.heldByClaim) || [];
    const busyFiles = (a && a.filesBusy) || [];
    const stood = (a && a.stoodDown) || [];
    const orphans = (a && a.heldByNoP0) || [];
    const pills = [
      c.open != null ? `<span class="pill">${c.open} open</span>` : '',
      c.ready ? `<span class="pill">${c.ready} ready</span>` : '',
      // Ready in every way but the one that counts — see lib/endorse.js. It sits next to
      // `ready` because it is the part of the tracker's own ready number that has been
      // taken out of it, and an unexplained gap between the two reads as a bug.
      //
      // A link, and the main door to the endorsement queue: this was the number with no
      // way through it — "3 held for endorsement" and no way to see which three from a
      // phone. The queue is not a tab (the bottom bar is full at five, and what gives up
      // its place is bc-j0zl's decision, not this pill's), so the count you were already
      // reading is what opens it.
      c.held ? `<a class="pill muted" href="/endorse">${c.held} held for endorsement</a>` : '',
      c.inProgress ? `<span class="pill on">${c.inProgress} in progress</span>` : '',
      c.blocked ? `<span class="pill p1">${c.blocked} blocked</span>` : '',
      a && a.queue ? `<span class="pill mine">${a.queue} for the advocate</span>` : '',
      // How many checkouts one workspace name is standing for. Absent for every
      // single-repo workspace, which is almost all of them — and the tooltip is the
      // approved list, because "climative" on its own no longer says what is in scope.
      a && a.repos?.length
        ? `<span class="pill muted" title="${esc(a.repos.join('\n'))}">${a.repos.length} checkout${
            a.repos.length === 1 ? '' : 's'
          }</span>`
        : '',
      a && a.deferredByPriority
        ? `<span class="pill muted">${a.deferredByPriority} below the priority floor</span>`
        : '',
      // Toned `p1` rather than `muted`, unlike every other hold on this row: the others
      // clear themselves when a window closes or a pull request merges, and this one
      // never does. It is waiting on an edit, and the tooltip is where the edit is named.
      unplaced.length
        ? `<span class="pill p1" title="${esc(unplaced.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${unplaced.length} naming no checkout</span>`
        : '',
      waiting.length
        ? `<span class="pill muted" title="${esc(waiting.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${waiting.length} waiting on ${waiting.length === 1 ? 'its children' : 'their children'}</span>`
        : '',
      // `p1` rather than `muted`, with `heldByRepo`: those are the two holds on this row
      // that no amount of waiting resolves. This one is waiting on somebody deciding
      // where the work belongs, and the tooltip names each bead so the decision can be
      // made from the sheet the id takes you to. See lib/underp0.js.
      orphans.length
        ? `<span class="pill p1" title="${esc(orphans.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${orphans.length} with no P0 above ${orphans.length === 1 ? 'it' : 'them'}</span>`
        : '',
      twins.length
        ? `<span class="pill muted" title="${esc(twins.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${twins.length} the same job under another id</span>`
        : '',
      prs.length
        ? `<a class="pill muted" href="/prs" title="${esc(prs.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${prs.length} in an open pull request</a>`
        : '',
      // No link, unlike the pull requests: the window this names is on the same page you
      // are reading, in the sessions list below.
      sitting.length
        ? `<span class="pill muted" title="${esc(sitting.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${sitting.length} with a session already open</span>`
        : '',
      // And the seventh, which is the only pill here naming something you cannot see from
      // this screen: another Mac's window, on another desk. Hence `p1` rather than
      // `muted` — the other six are states you can settle by looking, and this one is a
      // state you can only settle by asking somebody.
      claimed.length
        ? `<span class="pill p1" title="${esc(claimed.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${claimed.length} claimed by another Mac</span>`
        : '',
      // Not a subtraction from the queue at all, but the same argument one step later: a
      // window this advocate gave up because another Mac won the race. It clears itself
      // after an hour (`standDown` in lib/advocate.js), so a pill that is here is about
      // something that happened while you were not looking.
      stood.length
        ? `<span class="pill p1" title="${esc(stood.map((s) => `${s.id} — ${s.why}`).join('\n'))}">${stood.length} stood down for another Mac</span>`
        : '',
      // The eighth, and the first that names a *file*: a bead held because another session
      // on this laptop already has its hands on what it would touch (bc-mp8c). `muted`,
      // like the other holds you can settle by looking — the tooltip names the file and the
      // worktree, and both are on this Mac.
      onFiles.length
        ? `<span class="pill muted" title="${esc(onFiles.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${onFiles.length} whose files are being edited</span>`
        : '',
      // And the near miss, which is not a hold and must not read as one: the same collision
      // over a surface guessed from the bead's text, dispatched anyway because a guess may
      // not withhold work (bc-hrno). It is here so that the question "would holding on a
      // guess have helped?" can be answered from the screen rather than from a hunch.
      busyFiles.length
        ? `<span class="pill muted" title="${esc(busyFiles.map((h) => `${h.id} — ${h.why}`).join('\n'))}">${busyFiles.length} opened onto a busy file</span>`
        : '',
      // Last, because it is the only pill on this row that is not work outstanding.
      // Everything above it is something still to do — open, ready, blocked, held one of
      // nine ways — and this is what is finished, which is why it reads oddly anywhere
      // but the end.
      //
      // A link for the same reason `held` above it is one: the count was already being
      // computed and there was nowhere to go from it. It goes to the ledger rather than
      // to a closed-only list, because there is no closed-only list — the tooltip says
      // so out loud, so a pill reading `586 closed` cannot be taken as a promise that
      // 586 rows are on the other side of it. Narrowing it is bc-nib3.7's, and it waits
      // on the filters (bc-nib3.3) existing at all.
      //
      // No `?ws=` on the link, exactly as `/endorse` and `/prs` above have none. Every
      // page in the app is scoped by the one space picker, which lives on the server —
      // a link that narrowed the list without moving the picker would hand you a page
      // whose own control disagreed with what it was showing, and one that moved the
      // picker would change what every other client is looking at because you tapped a
      // count.
      c.closed
        ? `<a class="pill muted" href="/history" title="Every bead this space has ever had, newest first — the closed ones among them">${c.closed} closed</a>`
        : '',
    ].filter(Boolean);
    return `<div class="mon-domain">${pills.join('')}</div>`;
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

  /** The windows that are writing a plan rather than code — see `planning` in snapshot(). */
  const plannersOf = (a) => (a.workers || []).filter((w) => w.planning);

  /**
   * Who is arguing for this repo, and for which epics.
   *
   * There is more than one advocate per card and there has been since epic planning
   * landed, but the page only ever drew one of them. The **repo advocate** is the card
   * itself — its name is the heading, its state is the chip beside it — and an
   * **EpicAdvocate** is a window opened on one P0 to write that epic's plan
   * (`wantsAdvocate` in lib/epicadvocate.js: a P0 that is open, owned, and not a crash).
   * Both decide what gets worked on; only one of them was visible, and the other was
   * indistinguishable from an ordinary session in "Working now".
   *
   * So this is a roster rather than a second session list. Each row says *which epic is
   * being argued for*, which is the question the sessions list cannot answer — a planner
   * row there reads as a bead somebody is coding. The slot arithmetic is deliberately
   * left where it was: a planner holds a session slot, so it is still counted and still
   * drawn under "Working now", and this section takes nothing out of that count. Two
   * views of one window, each answering a question the other cannot.
   *
   * Drawn when empty, like every held-off state on this page: "no EpicAdvocate is open"
   * is a fact about the repo, and it is the state that follows a P0 being closed — which
   * is how six epics' worth of planning went quiet on 2026-08-12 with nothing on screen
   * saying so.
   */
  function advocatesHtml(a) {
    const planners = plannersOf(a);
    // Deliberately *not* `stateOf(a)`: that sentence is already the chip in this card's
    // head, and when sessions are open it is the session count word for word — a row
    // repeating it would be three copies of one fact on one card. What the roster owes
    // instead is the count, always, plus the states you cannot infer from it: an advocate
    // at 0 of 3 because it is paused and one at 0 of 3 because nothing is ready look
    // identical, and only one of them is waiting on you.
    const held = a.error
      ? '<span class="tag warn">cannot read the tracker</span>'
      : a.paused
        ? '<span class="tag warn">paused — it will not launch</span>'
        : a.quiet
          ? '<span class="tag warn">quiet hours — watching, not launching</span>'
          : a.surveying
            ? '<span class="tag ok"><span class="spark"></span>surveying</span>'
            : '';
    // Not a link: the repo advocate has no session of its own to open — it is the daemon
    // loop, and everything you can do to it is already a button in this card's head.
    const repo = `<div class="work-row adv-worker">
      <span class="work-phase">${a.paused ? '◍' : a.surveying ? '<span class="spark"></span>' : '◆'}</span>
      <span class="work-main">
        <span class="work-title">The repo advocate</span>
        <span class="work-sub"><span class="pill id">${esc(a.workspace)}</span>
          <span class="tag dim">${esc(a.workers.length)} of ${esc(a.limit)} sessions</span>
          ${held}
        </span>
      </span>
      <time>${esc(age(a.lastSurveyAt))}</time>
    </div>`;
    // Same destination rule as `workerRow`: a live pid has a transcript worth reading, a
    // dead one does not, and the epic is the only thing left to show for it.
    const rows = planners
      .map((w) => {
        const live = livePid(w.pid);
        return `<a class="work-row adv-worker" href="${esc(live ? sessionUrl(w.pid) : graphUrl(a.workspace, w.id))}">
          <span class="work-phase">${live && !w.ended ? '<span class="spark"></span>' : w.ended ? '◍' : '◔'}</span>
          <span class="work-main">
            <span class="work-title">${esc(w.title || w.id)}</span>
            <span class="work-sub"><span class="pill id">${esc(w.id)}</span>
              <span class="tag ok">EpicAdvocate</span>
              <span class="tag" title="A planner is opened on one P0 to decide what its children are and which of them belong together. It writes a plan, not code.">writing this epic's plan</span>
              ${
                // The number the plan is actually over. A planner is deliberately shown
                // every ready child rather than a capped batch (see `maxBatchBeads` in
                // lib/advocate.js), so this is the real size of the judgement it is making.
                w.batch?.length ? `<span class="tag">over ${esc(plural(w.batch.length, 'bead'))}</span>` : ''
              }
              ${w.ended ? '<span class="tag warn">the window has exited</span>' : ''}
            </span>
          </span>
          <time>${esc(age(w.at))}</time>
        </a>`;
      })
      .join('');
    return (
      repo +
      (planners.length
        ? `<div class="session-label">EpicAdvocates <span>One per P0 being planned. Each also holds a session slot below.</span></div>${rows}`
        : `<p class="subtitle">No EpicAdvocate is open. One opens per P0 epic that is open, owned and not a crash — so a P0 that closes stops being argued for, and this says so.</p>`)
    );
  }

  /**
   * One session the advocate opened.
   *
   * Everything on this row is something we know rather than something we inferred.
   * `ended` is the session's own word for it — the command writes its exit status to
   * a file before the window closes — and it is worth its own chip, because "opened,
   * never claimed, and the window is gone" is the state that costs the bead an
   * attempt and is otherwise invisible until the row disappears.
   */
  function workerRow(a, w) {
    const chips = [
      // What kind of window this is, before anything about what it carries. A planner
      // **finishes with its bead still open**, on purpose — an epic is its children, and
      // the planner's job ends when the plan is written. Every other worker that ends
      // with its bead open has given up, so without this chip the one window doing
      // exactly the right thing is drawn identically to the one that ran out of room.
      w.planning
        ? '<span class="tag ok" title="A planner writes this epic\'s plan and no code. It ends with its bead still open, which is correct here and a give-up everywhere else.">EpicAdvocate — planning</span>'
        : '',
      // And which group of an epic's plan this window is. Without it, the four windows one
      // judgement dispatched read as four unrelated beads that happened to start together.
      w.group?.name
        ? `<span class="tag" title="${esc(
            `One group of ${w.group.epic || 'an epic'}'s plan — an EpicAdvocate decided these beads belong in one change`
          )}">${esc(w.group.name)}${w.group.epic ? ` · from ${esc(w.group.epic)}'s plan` : ''}</span>`
        : '',
      // A batch head stands for several beads and the row shows one title. Without this
      // the others are invisible: they left the queue, one window went up, and nothing on
      // screen says the two facts are the same fact.
      w.batch?.length ? `<span class="tag">carrying ${esc(w.batch.length)} more under it</span>` : '',
      w.claimed ? '<span class="tag ok">claimed</span>' : '<span class="tag">not claimed yet</span>',
      w.ended ? '<span class="tag warn">the window has exited</span>' : '',
      // Where a reclaim got to. Asked and unanswered is the state worth seeing: the
      // clock is running on that slot, and the row is the only place it shows.
      w.asked ? `<span class="tag warn">asked to check in ${esc(age(w.asked))} ago</span>` : '',
      w.checkedInAt
        ? `<span class="tag ok">checked in ${esc(age(w.checkedInAt))} ago${
            w.checkinNote ? ` · ${esc(w.checkinNote)}` : ''
          }</span>`
        : '',
      w.sessionStatus ? `<span class="tag">${esc(w.sessionStatus)}</span>` : '',
      // Which checkout the window is actually open in. Only ever present where the
      // workspace holds more than one, which is why there is no chip on a sophab row
      // saying "sophab" — see `repoNameFor` in lib/advocate.js.
      w.repo ? `<span class="tag">${esc(w.repo)}</span>` : '',
      w.pid ? `<span class="tag dim">pid ${esc(w.pid)}</span>` : '',
      w.attempt > 1 ? `<span class="tag warn">attempt ${esc(w.attempt)}</span>` : '',
      // Nothing to address, so Reclaim cannot ask about this one — it will free the
      // slot on your word alone, the way the old button did. Says so rather than
      // looking identical to a window that answers.
      w.reachable === false ? '<span class="tag dim">no window handle</span>' : '',
    ].filter(Boolean);
    // Where the pid names a process that is still running, the row goes to that
    // session's own detail — the transcript is the answer to "is this moving", and it is
    // why you were reading this section. Where it does not, the bead stays the
    // destination: a worker whose window has exited has no session to show, and
    // `/session?pid=…` for a dead pid is a 404, which is a worse row than the one it
    // replaced.
    const live = livePid(w.pid);
    return `<a class="work-row adv-worker" href="${esc(live ? sessionUrl(w.pid) : graphUrl(a.workspace, w.id))}">
      <span class="work-phase">${w.claimed && !w.ended ? '<span class="spark"></span>' : w.ended ? '◍' : '◔'}</span>
      <span class="work-main">
        <span class="work-title">${esc(w.title || w.id)}</span>
        <span class="work-sub"><span class="pill id">${esc(w.id)}</span>${chips.join('')}</span>
      </span>
      <time>${esc(age(w.at))}</time>
    </a>`;
  }

  /**
   * A window whose bead is closed and whose process is still up.
   *
   * Deliberately not a `workerRow`: the slot is already back, the bead is already
   * closed, and the only live question is whether the window has taken its signal
   * yet. Links to the session rather than the bead for the same reason — the bead has
   * nothing left to say and the process is the thing that is still there.
   */
  function closingRow(c) {
    return `<a class="work-row adv-worker" href="${esc(sessionUrl(c.pid))}">
      <span class="work-phase">◍</span>
      <span class="work-main">
        <span class="work-title">${esc(c.title || c.id)}</span>
        <span class="work-sub"><span class="pill id">${esc(c.id)}</span>
          <span class="tag dim">pid ${esc(c.pid)}</span>
          ${c.signalled ? '<span class="tag warn">signalled</span>' : '<span class="tag">waiting for it to settle</span>'}
        </span>
      </span>
      <time>${esc(age(c.at))}</time>
    </a>`;
  }

  /**
   * What it would pick up next, in the order it would take it.
   *
   * Always drawn, including while sessions are open — public/work.js hides this the
   * moment anything is running, which is exactly when "and then what" is the question
   * you have. The note underneath is the advocate's own sentence about why the head
   * of this list has not been started yet.
   */
  function nextHtml(a) {
    if (!a.next?.length) {
      return `<p class="subtitle">Nothing ready. ${
        a.lastProposalAt ? `Last asked you about new work ${esc(age(a.lastProposalAt))} ago.` : 'It has never proposed any.'
      }</p>`;
    }
    const rows = a.next
      .map(
        (b, i) => `<a class="work-row mon-next-row" href="${esc(graphUrl(a.workspace, b.id))}">
          <span class="work-phase mon-rank">${i + 1}</span>
          <span class="work-main">
            <span class="work-title">${esc(b.title)}</span>
            <span class="work-sub"><span class="pill id">${esc(b.id)}</span><span class="tag">${esc(
              P_LABEL[b.priority] ?? `P${b.priority}`
            )}</span><span class="tag dim">${esc(b.type)}</span>${
              b.repo ? `<span class="tag">${esc(b.repo)}</span>` : ''
            }</span>
          </span>
          <time>${esc(age(b.createdAt))}</time>
        </a>`
      )
      .join('');
    const more = a.queue > a.next.length ? `<p class="subtitle">…and ${a.queue - a.next.length} more in the queue.</p>` : '';
    return rows + more;
  }

  /**
   * The survey agent thinking out loud.
   *
   * The one panel here that is not a report of state: it is the live transcript of
   * the read-only agent that decides whether there is any work worth proposing —
   * every `bd` call and every file it reads. When an advocate does something you did
   * not expect, this is where the reason is, so it is polled while it is open and
   * force-opened while the agent is actually running.
   */
  function thinkingHtml(a) {
    const log = state.logs.get(a.workspace);
    if (!log) return '<p class="subtitle">Loading the transcript…</p>';
    if (!log.lines?.length) {
      return `<p class="subtitle">Nothing logged yet. The advocate writes here when it surveys for work to propose — ${
        a.lastProposalAt ? `it last did that ${esc(age(a.lastProposalAt))} ago.` : 'it has not done that yet.'
      }</p>`;
    }
    return `<pre class="agent-log mon-log">${esc(log.lines.join('\n'))}</pre>`;
  }

  /**
   * The beads it wants to file, each with its own yes and no.
   *
   * An advocate may work what exists without asking; filing something *for* you makes
   * you answerable for an idea an agent had, so nothing is created until you press it.
   * The full text of each bead is here — description, done-when, and the advocate's
   * argument for why your tracker should carry it — because a title and two buttons
   * is precisely what makes a suggestion impossible to judge.
   */
  function proposalHtml(q) {
    const beads = q.proposal?.beads || [];
    const picks = picksFor(q.key);
    const rows = beads
      .map((b, i) => {
        const n = i + 1;
        const pick = picks.get(n) || '';
        return `<div class="mon-bead${pick ? ` picked-${pick}` : ''}">
          <div class="mon-bead-head">
            <span class="mon-rank">${n}</span>
            <strong>${esc(b.title)}</strong>
            <span class="tag">${esc(P_LABEL[b.priority] ?? `P${b.priority}`)}</span>
            <span class="tag dim">${esc(b.type)}</span>
          </div>
          ${b.description ? `<p class="mon-bead-body">${esc(b.description)}</p>` : ''}
          ${b.acceptance ? `<p class="mon-bead-meta"><strong>Done when:</strong> ${esc(b.acceptance)}</p>` : ''}
          ${b.rationale ? `<p class="mon-bead-meta why">Why: ${esc(b.rationale)}</p>` : ''}
          ${b.deps?.length ? `<p class="mon-bead-meta"><strong>Depends on:</strong> ${esc(b.deps.join(', '))}</p>` : ''}
          <div class="mon-bead-acts">
            <button class="adv-btn${pick === 'yes' ? ' on' : ''}" data-pick="yes" data-key="${esc(q.key)}" data-n="${n}">Create</button>
            <button class="adv-btn${pick === 'no' ? ' on danger' : ''}" data-pick="no" data-key="${esc(q.key)}" data-n="${n}">Decline</button>
          </div>
        </div>`;
      })
      .join('');

    const approved = [...picks.entries()].filter(([, v]) => v === 'yes').length;
    const undecided = beads.length - picks.size;
    return `<div class="mon-proposal" data-key="${esc(q.key)}">
      <div class="mon-prop-head">
        <span class="pill id">${esc(q.id)}</span>
        <span class="mon-prop-title">${esc(q.title)}</span>
        <time>${esc(age(q.createdAt))}</time>
      </div>
      ${rows}
      <div class="mon-prop-foot">
        <button class="adv-btn" data-pick-all="yes" data-key="${esc(q.key)}">All</button>
        <button class="adv-btn" data-pick-all="no" data-key="${esc(q.key)}">None</button>
        <span class="mon-prop-count">${
          undecided ? `${plural(undecided, 'bead')} undecided` : `${approved} of ${beads.length} to create`
        }</span>
        <button class="adv-btn primary" data-submit="${esc(q.key)}"${undecided ? ' disabled' : ''}>${
          approved ? `Create ${approved}` : 'Decline all'
        }</button>
      </div>
    </div>`;
  }

  /**
   * What its finished sessions left behind.
   *
   * Three separate facts that all answer "and then what happened": the session log
   * pushed to `refs/beadcause/session/<bead>`, the archived branches still waiting to
   * reach main, and the last worktree sweep. None of them had ever been rendered
   * anywhere — the archive ref in particular is a session's entire record of itself.
   */
  function landedHtml(a) {
    const arc = state.archives.get(a.workspace);
    const parts = [];

    if (a.archive) {
      parts.push(`<div class="work-row mon-plain">
        <span class="work-phase">⎘</span>
        <span class="work-main">
          <span class="work-title">Archived ${esc(a.archive.bead)} — ${plural(a.archive.commits, 'commit')}</span>
          <span class="work-sub"><code>${esc(a.archive.ref)}</code></span>
        </span>
        <button class="adv-btn" data-archive="${esc(a.workspace)}" data-bead="${esc(a.archive.bead)}">Read</button>
      </div>`);
    }
    if (a.pendingNotes) {
      parts.push(
        `<p class="subtitle">${plural(
          a.pendingNotes,
          'archived session'
        )} whose branch has not reached main yet — the landing gets noted when it does.</p>`
      );
    }
    if (a.tidy?.summary) {
      parts.push(`<div class="adv-note">🧹 ${esc(a.tidy.summary)} <span class="dim">· ${esc(age(a.tidy.at))} ago</span></div>`);
    }
    // Beads closed because their pull request merged on github.com — the daemon writing
    // to the tracker on its own, which otherwise shows up nowhere but a log file.
    if (a.landed?.summary) {
      parts.push(`<div class="adv-note">🔀 ${esc(a.landed.summary)} <span class="dim">· ${esc(age(a.landed.at))} ago</span></div>`);
    }
    if (arc?.error) parts.push(`<div class="adv-note bad">${esc(arc.error)}</div>`);
    if (arc?.sessions?.length) {
      parts.push(
        `<div class="mon-arc-list">${arc.sessions
          .map(
            (s) =>
              `<button class="mon-arc-row" data-read="${esc(a.workspace)}" data-commit="${esc(s.commit)}">
                <span>${esc(s.subject)}</span><time>${esc(age(s.at))}</time>
              </button>`
          )
          .join('')}</div>`
      );
    }
    if (arc?.text != null) parts.push(`<pre class="agent-log mon-log">${esc(arc.text)}</pre>`);

    return parts.length ? parts.join('') : '<p class="subtitle">Nothing archived or swept yet.</p>';
  }

  /* ----------------------------------------------------------------- shipping */

  /**
   * How long the board this page borrows may go unasked before it is asked again.
   *
   * `/api/prs` is a `gh` sweep per approved repo behind a 25-second cache, which is the
   * right price for the PRs pane — a screen you are on in order to ship — and much too
   * high a one to pay on every repaint of a page that repaints every few seconds. So the
   * strip is refreshed on a slow clock and on the events that could have changed it (a
   * merge, a deploy — `boardMoved` in public/stream.js), which between them cover every
   * way the number below can move.
   */
  const BOARD_MS = 60000;

  /** The repo key a board card is, spelled the way lib/release.js keys its entries. */
  const cardKey = (c) => c?.key || c?.repoKey || c?.workspace || '';

  /**
   * The queue for one workspace, as cards — one per repo of it that owes a ship.
   *
   * A workspace and a repo are the same thing for every personal space here and are
   * emphatically not for Climative, whose one tracker fronts forty checkouts. The
   * advocate is per *workspace*, so its card can legitimately hold several of these, and
   * each carries its own key: two rows arming one button would be one tap deploying the
   * wrong service, which is the bug bc-l853.6 was.
   */
  const owedCards = (ws) => (state.board?.repos || []).filter((c) => c.workspace === ws && c.release?.count);

  /**
   * The Ship strip: what has merged in this repo and is not running yet.
   *
   * The same queue the PRs pane draws (lib/release.js decides it, `releaseFor`), on the
   * page you are actually looking at when you want it. That is the whole argument for
   * putting it here as well: this console is where you watch work *finish* — an advocate
   * closing beads, sessions landing and tidying themselves — and the question that
   * follows immediately from watching that is "is any of it live?". Answering it used to
   * mean the PRs chip, a board that re-sweeps every repo, and finding the card again.
   *
   * It draws nothing at all when the queue is empty, which is the ordinary state and
   * should look like it — the same rule the board's own strip keeps.
   *
   * The button is only offered where a deploy is declared. A repo beadcause cannot deploy
   * has no one-press answer (see `shipHint` in public/prs.js), and the honest thing on a
   * card that is not about pull requests is to say the number and send you to the board
   * rather than to grow a second meaning for the word here.
   */
  function shipStrip(ws) {
    const cards = owedCards(ws);
    if (!cards.length) return '';
    return cards
      .map((c) => {
        const key = cardKey(c);
        const r = c.release;
        const armed = state.armedShip === key;
        const can = r.can === 'deploy';
        const said =
          state.shipSaid?.key === key
            ? `<div class="board-said${state.shipSaid.bad ? ' bad' : ''}">${esc(state.shipSaid.text)}</div>`
            : '';
        const list = r.prs
          .slice(0, 5)
          .map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">#${esc(p.number)}</a> ${esc(p.title)}</li>`)
          .join('');
        const more = r.prs.length > 5 ? `<li class="release-more">…and ${r.prs.length - 5} more</li>` : '';
        const button = can
          ? `<button class="board-btn ship release-ship${armed ? ' armed' : ''}" data-ship="${esc(key)}"${
              state.shipping ? ' disabled' : ''
            }>${armed ? `Ship all ${r.count} — sure?` : 'Ship'}<span class="release-count" aria-hidden="true">${esc(
              r.count
            )}</span></button>`
          : '';
        return `<div class="release">
          <div class="release-head">
            ${button}
            <p class="release-say">${
              can
                ? `${plural(r.count, 'merged pull request')} ${r.count === 1 ? 'is' : 'are'} on <code>origin</code> and not live${
                    cards.length > 1 ? ` in <strong>${esc(c.repoName || key)}</strong>` : ''
                  }. One deploy ships ${r.count === 1 ? 'it' : 'them all'}${
                    r.hint ? ` — ${esc(r.hint).replace(/`([^`]+)`/g, '<code>$1</code>')}` : ''
                  }.`
                : `${plural(r.count, 'merged pull request')} ${
                    r.count === 1 ? 'is' : 'are'
                  } waiting to ship. This repo declares no deploy beadcause can run, so each one goes out from its own row on the <a href="/prs">PR board</a>.`
            }</p>
          </div>
          <ul class="release-list">${list}${more}</ul>
          ${said}
        </div>`;
      })
      .join('');
  }

  /* -------------------------------------------------------------------- cards */

  function advocateCard(w, a, proposals) {
    const st = stateOf(a);
    const key = a.workspace;
    const sessions = w?.sessions || [];
    // Beads claimed in this repo that the advocate did not open a window on: your
    // own sessions. Kept separate rather than merged — nothing records which process
    // is on which bead, and the advocate only knows about the windows it opened.
    const mine = new Set(a.workers.map((x) => x.id));
    const others = (w?.working || []).filter((x) => !mine.has(x.id));

    const controls = [
      limitStepper(a),
      `<button class="adv-btn" data-adv="${a.paused ? 'resume' : 'pause'}" data-ws="${esc(key)}">${
        a.paused ? 'Resume' : 'Pause'
      }</button>`,
      // Not "free slots" any more, because it no longer just frees them: it asks each
      // open session whether it is still working and takes back only the slots whose
      // window has gone. The label is the promise — a button called "free slots" that
      // sometimes keeps them all would be worse than either behaviour.
      a.workers.length
        ? `<button class="adv-btn" data-adv="reclaim" data-ws="${esc(key)}" title="Ask each open session whether it is still working. Windows that have gone give their slots back; the rest keep them and are asked to check in or finish.">Reclaim sessions</button>`
        : '',
      // Clears the attempt counters, so beads it gave up on are eligible again. Only
      // offered when it has actually given up on something — otherwise it is a button
      // that does nothing and reads as though it might.
      `<button class="adv-btn" data-adv="forget" data-ws="${esc(key)}" title="Clear attempt counters so beads it gave up on are eligible again">Forget attempts</button>`,
    ]
      .filter(Boolean)
      .join('');

    const secs = [
      // First, because it answers "who is deciding what happens in this repo" — and every
      // section under it is one of those decisions playing out. Open by default in the
      // sense that matters: the count in the summary is 1 + the planners, so a shut panel
      // still says whether any epic is being argued for.
      section(
        `${key}:advocates`,
        'Advocates',
        String(1 + plannersOf(a).length),
        advocatesHtml(a),
        { tone: plannersOf(a).length ? 'live' : '' }
      ),
      section(
        `${key}:work`,
        'Working now',
        a.workers.length ? `${a.workers.length}/${a.limit}` : `0/${a.limit}`,
        a.workers.length
          ? a.workers.map((x) => workerRow(a, x)).join('')
          : '<p class="subtitle">No sessions open from this advocate.</p>',
        { tone: a.workers.length ? 'live' : '' }
      ),
      // Only drawn when there is one, and there usually is not: a window sits here for
      // the grace period and then goes. It is the one state where the advocate is
      // about to signal a process, and a number that appears and clears within a
      // minute or two is how you see the thing working without reading the log.
      (a.closing || []).length
        ? section(
            `${key}:closing`,
            'Closing',
            String(a.closing.length),
            a.closing.map(closingRow).join(''),
            { tone: 'warn' }
          )
        : '',
      section(`${key}:next`, 'Up next', a.queue ? String(a.queue) : '', nextHtml(a), { tone: a.queue ? 'warn' : '' }),
      section(`${key}:log`, 'Thinking', '', thinkingHtml(a), {
        badge: a.surveying ? '<span class="tag live"><span class="spark"></span>live</span>' : '',
      }),
      proposals.length
        ? section(
            `${key}:prop`,
            'Waiting on you',
            String(proposals.reduce((n, q) => n + (q.proposal?.beads?.length || 0), 0)),
            proposals.map(proposalHtml).join(''),
            { tone: 'warn' }
          )
        : '',
      section(`${key}:landed`, 'Landed & tidied', a.archive ? plural(a.archive.commits, 'commit') : '', landedHtml(a)),
      others.length || sessions.length
        ? section(
            `${key}:else`,
            'Other work in this repo',
            String(others.length + sessions.length),
            (others.length
              ? `<div class="session-label">Claimed beads <span>Not opened by the advocate.</span></div>` +
                others
                  .map(
                    (x) => `<a class="work-row" href="${esc(graphUrl(key, x.id))}">
                      <span class="work-phase">${x.icon ? esc(x.icon) : '◗'}</span>
                      <span class="work-main">
                        <span class="work-title">${esc(x.title)}</span>
                        <span class="work-sub"><span class="pill id">${esc(x.id)}</span>${esc(x.actor || '')}${
                          x.phase ? ` · ${esc(x.phase)}` : ''
                        }${x.detail ? ` — ${esc(x.detail)}` : ''}</span>
                      </span>
                      <time>${esc(age(x.since))}</time>
                    </a>`
                  )
                  .join('')
              : '') +
              (sessions.length
                ? `<div class="session-label">Claude sessions <span>${
                    others.length ? 'Which is on which bead is not recorded.' : 'Nothing claimed in the tracker.'
                  }</span></div>` + sessions.map(sessionRow).join('')
                : '')
          )
        : '',
    ]
      .filter(Boolean)
      .join('');

    // The note is the advocate's own sentence for why it is doing what it is doing.
    // Dropped when it merely restates the chip — both are written by the same tick.
    const note = a.note && !st.text.toLowerCase().includes(a.note.toLowerCase().split(/[ ·—]/)[0]) ? a.note : '';

    return `<article class="card work-card mon-card${a.error ? ' bad' : ''}" data-ws="${esc(key)}">
      <div class="work-head">
        <h2>${esc(key)}</h2>
        <span class="mon-state ${st.tone}">${esc(st.text)}</span>
        <span class="adv-actions">${controls}</span>
      </div>
      ${domainHtml(w, a)}
      ${
        // What this repo has merged and not made live, above everything the advocate is
        // doing. High on the card on purpose: it is the only control here that changes
        // what is *running*, and a queue you have to scroll past six folds to find is a
        // queue that stays unshipped. Empty draws nothing at all.
        shipStrip(key)
      }
      ${note ? `<div class="adv-note">${esc(note)}</div>` : ''}
      ${
        // A limit the global cap will not honour. Said here rather than left to the
        // note, because the note only appears once a tick has actually been blocked
        // — which can be half an hour after the press that caused it, and until then
        // the stepper reads as though 5 were in force when 3 is.
        a.globalHeld
          ? `<div class="adv-note warn">Held by globalMaxWorkers (${a.globalMax}) — that is a total across every advocate, so this repo will not open more than ${a.globalMax} at once whatever its own limit says.</div>`
          : ''
      }
      ${
        // Why the last Apply on this card's stepper was refused. In the card rather
        // than appended to the button's parent, because applying repaints the page and
        // a note stuck onto the old DOM would vanish with it — which is exactly the
        // press whose failure has to be visible.
        limitErrorHtml(stepKey(key))
      }
      ${
        // The workspace's own error, and only when it is not the advocate's error
        // said twice. They are separate facts — the advocate holds its last failure
        // in memory, /api/work asks bd afresh — and usually the same sentence.
        w?.error && w.error !== a.error ? `<div class="adv-note bad">⚠ ${esc(w.error)}</div>` : ''
      }
      ${secs}
      <div class="work-foot">
        <div class="meta mon-times">${[
          ago(a.lastSurveyAt, 'surveyed'),
          ago(a.lastLaunchAt, 'launched'),
          ago(a.lastProposalAt, 'proposed'),
        ].join(' · ')}</div>
        <a class="work-graph" href="${esc(graphUrl(key))}">Graph →</a>
      </div>
    </article>`;
  }

  /**
   * A workspace with no advocate at all.
   *
   * Drawn, and drawn plainly, because "this repo has nobody arguing for it" is a
   * fact about the domain and not an absence of one. `advocatedWorkspaces` filters on
   * config and on the space's own `advocate: false`, and neither is visible from here
   * — so the card says what is true and stops short of guessing which it was.
   */
  function plainCard(w) {
    const sessions = w.sessions || [];
    return `<article class="card work-card mon-card plain">
      <div class="work-head">
        <h2>${esc(w.name)}</h2>
        <span class="mon-state dim">no advocate</span>
      </div>
      ${domainHtml(w, null)}
      ${w.error ? `<div class="adv-note bad">⚠ ${esc(w.error)}</div>` : ''}
      ${(w.working || [])
        .map(
          (x) => `<a class="work-row" href="${esc(graphUrl(w.name, x.id))}">
            <span class="work-phase">${x.icon ? esc(x.icon) : '◗'}</span>
            <span class="work-main">
              <span class="work-title">${esc(x.title)}</span>
              <span class="work-sub"><span class="pill id">${esc(x.id)}</span>${esc(x.actor || '')}</span>
            </span>
            <time>${esc(age(x.since))}</time>
          </a>`
        )
        .join('')}
      ${sessions.map(sessionRow).join('')}
      <div class="work-foot">
        <div class="meta"></div>
        <a class="work-graph" href="${esc(graphUrl(w.name))}">Graph →</a>
      </div>
    </article>`;
  }

  /**
   * What launchd is running — the line that would have caught the three-day bug.
   *
   * bin/router.js landed, the installer was updated to point the LaunchAgent at it,
   * and the plist in ~/Library/LaunchAgents went on naming bin/beadcause.js. Every
   * deploy kickstarted that label, the port answered every request, and the hot-swap
   * had never once run. The detection existed within a day — a banner at daemon
   * startup and a diagnosis on `npm run swap:status` — and both landed somewhere
   * nobody stands: launchd's log file, and a command you type only once you already
   * suspect something.
   *
   * This is the same verdict on a surface that gets looked at. Two shapes, because
   * they are two different jobs:
   *
   *   - **Fine** — one dim line, above the cards, saying which program launchd runs.
   *     It is here on a good day precisely so that its absence means nothing and its
   *     text means something. A health line you only ever see when broken teaches you
   *     to read "no line" as "healthy", which is exactly what the console said for
   *     three days while it was wrong.
   *   - **Not fine** — a loud block in the same place, with what launchd is actually
   *     running, why that means the hot-swap is not live, and the one command that
   *     fixes it, selectable so it can be copied off a phone.
   *
   * Inside `#mon` rather than beside it, so it hides with the advocates tab when the
   * mirror pane comes up over this one — see showTab in public/mirror.js.
   */
  function serviceHtml(svc) {
    if (!svc) return ''; // An older daemon behind a newer page: say nothing, invent nothing.
    if (svc.ok) {
      return `<div class="svc ok" title="${esc(svc.plist)}">
        <span class="svc-dot">✓</span>
        <span>launchd runs <code>${esc(svc.label || svc.program || 'nothing')}</code> — hot-swap live</span>
      </div>`;
    }
    return `<div class="svc bad">
      <div class="svc-head"><span class="svc-dot">⚠</span>HOT-SWAP IS NOT LIVE<span class="pill id">${esc(svc.code)}</span></div>
      ${
        // The headline fact, and the whole of the acceptance this was filed for. Only
        // when there is one: `not-installed` and `unreadable` have no program to name,
        // and the sentence below says which of the two it is.
        svc.label ? `<div class="svc-what">launchd runs <code>${esc(svc.label)}</code></div>` : ''
      }
      <div class="svc-line">${esc(svc.detail)}</div>
      ${
        svc.fix
          ? `<div class="svc-fix">${esc(svc.fixBefore || 'fix it:')} <code>${esc(svc.fix)}</code> ${esc(svc.fixAfter)}</div>`
          : ''
      }
      <div class="svc-foot">${esc(svc.plist)}</div>
    </div>`;
  }

  /**
   * And whether that program is serving anything — the line under the line above.
   *
   * The launchd line answers "is the right program running". This answers the question
   * that turned out to sit underneath it: a router can be the right program, hold the
   * port, pass every check launchd makes, and have *no backend behind it* — in which
   * case the phone gets a 503 and the only record is a log file. Twice in one evening a
   * build that was perfectly fine was condemned for being slow to start on a loaded Mac,
   * and stayed condemned, because "poisoned" made no distinction between a syntax error
   * and a busy machine.
   *
   * What this can show is the *degraded* half of that, and only that: serving a stale
   * build because the newer one died, or because it was too slow and is being retried.
   * A total outage is not visible from a page the daemon cannot serve — bin/router.js
   * answers that one itself, in the 503 body and in a push to the phone.
   *
   * Amber rather than red: the app is up and answering on all of these, which is a
   * different sentence from HOT-SWAP IS NOT LIVE above it, and colour is how you tell
   * "look at this soon" from "nothing you are reading is current".
   */
  function routerHtml(r) {
    if (!r) return ''; // start:bare, or an older daemon: say nothing, invent nothing.
    if (r.ok) {
      return `<div class="svc ok" title="${esc(r.disk || '')}">
        <span class="svc-dot">✓</span>
        <span>serving build <code>${esc(r.build || '?')}</code>${r.pid ? ` from pid ${esc(r.pid)}` : ''}</span>
      </div>`;
    }
    return `<div class="svc warn">
      <div class="svc-head"><span class="svc-dot">⚠</span>${
        r.serving ? 'THE PHONE IS ON AN OLDER BUILD' : 'NOTHING IS BEING SERVED'
      }<span class="pill id">${esc(r.code)}</span></div>
      <div class="svc-what">${esc(r.summary)}</div>
      ${r.detail ? `<div class="svc-line">${esc(r.detail)}</div>` : ''}
      ${r.fix ? `<div class="svc-fix">force it: <code>${esc(r.fix)}</code></div>` : ''}
      <div class="svc-foot">disk ${esc(r.disk || '?')}</div>
    </div>`;
  }

  /**
   * How many sessions may be open on this whole Mac — the third line in the block, and
   * the only one of the three you can press.
   *
   * This is `advocates.globalMaxWorkers`, and it is the cap that most often actually
   * binds: every advocate card already quotes it, in its stepper's tooltip and in the
   * amber "Held by globalMaxWorkers" note the tick writes when it is what stopped a
   * launch. Until now it was also the one number on this page you could not change
   * without editing ~/.beadcause/config.json and restarting the daemon — so the page
   * could tell you exactly which number was holding your work up and offer you nothing
   * to do about it.
   *
   * Deliberately the same control as the per-repo one — `.adv-limit`, two square
   * buttons and the number between them — because it is the same kind of decision one
   * level up, and a second shape for it would read as a different kind of setting.
   * What differs is the range (`GLOBAL_WORKERS_CEILING`, which travels in the payload
   * rather than being written here) and that it is stated as a fraction: `3 of 20` is
   * the headroom question, and it is the reason you came to look at this number.
   *
   * Above the space card and under the two health lines, because it is global and the
   * card below it is one space's — settings sorted widest-first, which is also the
   * order you scroll past them in.
   */
  function globalHtml(g, observing) {
    if (!g) return ''; // An older daemon behind a newer page: say nothing, invent nothing.
    const ceiling = g.ceiling || 36;
    const held = g.live >= g.maxWorkers;
    return `<div class="svc ok svc-set">
      <span class="svc-dot">⚙</span>
      <span><b class="svc-num${held ? ' warn' : ''}">${g.live}</b> of ${plural(
        g.maxWorkers,
        'session'
      )} open across every advocate${held ? ' — every slot is in use' : ''}</span>
      ${limitControl({
        key: GLOBAL_STEP,
        live: g.maxWorkers,
        ceiling,
        held,
        pillTitle: observing
          ? 'This instance only watches — the cap belongs to the daemon that acts.'
          : 'advocates.globalMaxWorkers — the total across every advocate on this Mac, whatever any one repo’s own limit says',
        fewerTitle: 'One fewer session on this Mac, across every advocate',
        moreTitle: `One more session on this Mac (up to ${ceiling})`,
      })}
      ${limitErrorHtml(GLOBAL_STEP)}
    </div>`;
  }

  /* ------------------------------------------------------- the space's own settings

     What makes this page the details of a *space* rather than a list of advocates that
     happens to be filtered.

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
   * Drawn above the advocate cards because it is what the page is *about*, and because
   * a setting you scrolled past six repos to find is a setting you edit on the Mac
   * instead. Shut by default like every other section here — you arrive at this page
   * to see what is running far more often than to change what a space is.
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
    const many = d.repos.filter((r) => typeof r.checkouts === 'number');
    const total = d.repos.reduce((n, r) => n + (typeof r.checkouts === 'number' ? r.checkouts : 1), 0);
    const repos = d.repos.length
      ? `<div class="space-repos">${d.repos
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
      ${section(`space:${d.space}:repos`, 'What each repo resolves to', String(total), repos)}
    </article>`;
  }

  /* ------------------------------------------------------------------- render */

  /**
   * `polled` marks the twenty-second repaint, as opposed to one your press asked for.
   *
   * The distinction exists for exactly two fields: the quiet-hours clocks are the only
   * editable inputs on this page, and a poll landing mid-edit would replace the one you
   * were setting with the value already stored. A press is never skipped — you asked
   * for it, and the answer has to appear — so the guard is on the poll alone, and the
   * cost of it is one paint deferred by twenty seconds.
   */
  function render({ polled = false } = {}) {
    const data = state.work;
    if (!data) return;
    if (polled && out.contains(document.activeElement) && document.activeElement?.type === 'time') return;

    // A pending number the daemon has since arrived at anyway — this repo stepped from
    // another device, or the value applied and came back — is settled, not pending. Done
    // here rather than in `stepLimit` because it is a *poll* that makes it true, and an
    // Apply button offering to set 5 to 5 is a press with nothing behind it.
    for (const [key, want] of state.pendingLimits) {
      if (!state.applyingLimits.has(key) && liveLimit(key) === want) state.pendingLimits.delete(key);
    }

    // Which daemon am I looking at? Two consoles side by side are otherwise
    // identical, and the one that acts is not the one you have been clicking.
    // `hidden` rather than absent text: the live instance must show nothing at all,
    // so a badge that failed to render can never be mistaken for "not observing".
    observing.hidden = !data.observing;
    observing.title = data.observing
      ? 'This instance watches and never acts: no sessions, proposals, worktree sweeps, session logs, reply agents or pushes.'
      : '';
    // Everything on this page belongs to one repo — an advocate, its workers, the
    // sessions it opened, the proposals it is waiting on — so the space picker in the
    // bar above filters the lot. See public/spacebar.js.
    const advocates = new Map(
      (data.advocates || []).filter((a) => inSpace(a.workspace)).map((a) => [a.workspace, a])
    );
    const spaces = (data.workspaces || []).filter((w) => inSpace(w.name));

    // Advocated repos first, and the busiest of those at the top: this page is about
    // the advocates, and a repo with three sessions open is why you opened it.
    const withAdv = spaces.filter((w) => advocates.has(w.name));
    const without = spaces.filter((w) => !advocates.has(w.name));
    withAdv.sort((x, y) => {
      const a = advocates.get(x.name);
      const b = advocates.get(y.name);
      return b.workers.length - a.workers.length || b.queue - a.queue || x.name.localeCompare(y.name);
    });

    // An advocate whose workspace vanished from /api/work still has state worth
    // showing — it is held in the daemon's memory, not in bd.
    const orphans = [...advocates.keys()].filter((n) => !spaces.some((w) => w.name === n));

    const cards =
      withAdv.map((w) => advocateCard(w, advocates.get(w.name), state.proposals.get(w.name) || [])).join('') +
      orphans.map((n) => advocateCard(null, advocates.get(n), state.proposals.get(n) || [])).join('') +
      without.map(plainCard).join('') +
      elsewhereHtml(data.elsewhere || []);

    // Above every card, including the "nothing configured" case: a daemon serving the
    // wrong program is the one thing you want said before anything it goes on to say
    // about the repos.
    // Empty because nothing is configured, or empty because you are looking at one
    // space and it has no advocates? The bar above is the fix for one of those and not
    // for the other, so the two do not share a sentence.
    const nothing = (data.workspaces || []).length
      ? `<div class="empty">Nothing in ${esc(window.beadcause?.space?.label?.() || 'this space')}.</div>`
      : '<div class="empty">No workspaces configured.</div>';
    // The space's own settings sit under the two health lines and above the repos: it
    // is what this page is the details *of*, and a setting you scroll six advocate
    // cards to reach is a setting you go back to editing the config file for.
    out.innerHTML =
      serviceHtml(data.service) +
      routerHtml(data.router) +
      globalHtml(data.globals, data.observing) +
      spaceHtml() +
      (cards || nothing);

    // An observer may read this space's settings and may not write them: its `cfg` is
    // the real daemon's config file, so a press here would change what the *other*
    // process does at its next restart and nothing at all about what it is doing now.
    // The server refuses it either way (see POST /api/space); this is so the refusal is
    // not something you find out by pressing. Same treatment the admin page gives its
    // own buttons, and drawn rather than hidden — a control that vanished would read as
    // a feature this build does not have.
    // The global session cap is in the same sentence for the same reason — an
    // observer's config file *is* the live daemon's, so stepping it here would change
    // how many windows the other process opens after its next restart, which is the
    // one kind of press an instance that "never acts" must not make.
    if (data.observing) {
      for (const el of out.querySelectorAll(
        '[data-space-set],[data-repo-set],[data-space-day],[data-space-hours],[data-space-channel],#qh-from,#qh-to,#slack-channel,[data-step="global"],[data-apply="global"]'
      )) {
        el.disabled = true;
        el.title = 'This instance only watches — the settings belong to the daemon that acts.';
      }
    }

    const live = [...advocates.values()].reduce((n, a) => n + a.workers.length, 0);
    // Over the selection, like everything else on the page: the proposals map holds
    // every workspace's, because the inbox sweep it comes from is not filtered.
    const waiting = [...state.proposals.entries()]
      .filter(([ws]) => inSpace(ws))
      .reduce((n, [, qs]) => n + qs.length, 0);
    tally.textContent = [live ? `${live} working` : '', waiting ? `${waiting} to answer` : '']
      .filter(Boolean)
      .join(' · ');
    tally.className = `mon-tally${waiting ? ' warn' : ''}`;
    // Opening a log card is a repaint, and it is also the moment the transcript tail has
    // to start — there is no other signal for it, and this is the one place every way of
    // opening one goes through. `scheduleLogs` is a no-op when nothing is unfolded.
    scheduleLogs();
  }

  /** Is this repo in the selected space? See public/spacebar.js. */
  const inSpace = (workspace) => window.beadcause?.space?.matches?.(workspace) ?? true;

  function elsewhereHtml(sessions) {
    // A session outside every workspace is in no space, so it is out while one is
    // selected — `matches('')` is what decides that, in one place, for the whole app.
    if (!sessions.length || !inSpace('')) return '';
    return `<article class="card work-card mon-card plain">
      <div class="work-head"><h2>Elsewhere</h2><span class="mon-state dim">${esc(
        plural(sessions.length, 'session')
      )} outside every workspace</span></div>
      ${sessions.map(sessionRow).join('')}
    </article>`;
  }

  /* --------------------------------------------------------------------- load */

  /**
   * Draw the two payloads this page had last time, before either has been asked for.
   *
   * `/api/work` is two `bd` calls per workspace and `/api/questions` is a sweep of its
   * own, so arriving here from a tab tap used to mean several seconds of an empty pane
   * over a Mac that was busy answering. What is kept from the last visit paints in the
   * first frame instead, and `load()` runs behind it. See public/warm.js.
   */
  function warmBoot() {
    const warm = window.beadcause?.warm;
    const work = warm?.read?.('/api/work');
    if (!work?.data?.workspaces) return false;
    state.work = work.data;
    const questions = warm.read('/api/questions?scope=human');
    if (questions?.data?.questions) adoptQuestions(questions.data);
    render();
    return true;
  }

  /**
   * The proposals pane and the picker's numbers, out of an inbox payload.
   *
   * Split out of `load` because the warm boot above adopts the same shape — a second
   * copy of it is how the warm pane would come to disagree with the fetched one.
   */
  function adoptQuestions(questions) {
    // This page sweeps the inbox for the proposals, so it has the picker's numbers
    // for free — fresher than /api/spaces, which is one poll behind by design.
    const counts = {};
    for (const q of questions.questions || []) counts[q.workspace] = (counts[q.workspace] || 0) + 1;
    window.beadcause?.space?.adopt({
      spaces: questions.spaces,
      workspaces: questions.workspaces,
      counts,
      filter: questions.filter,
    });
    state.proposals = new Map();
    for (const q of questions.questions || []) {
      if (!q.proposal?.beads?.length) continue; // Every other question in the inbox.
      if (!state.proposals.has(q.workspace)) state.proposals.set(q.workspace, []);
      state.proposals.get(q.workspace).push(q);
    }
  }

  async function load({ polled = false } = {}) {
    pulse.classList.add('busy');
    try {
      // Two requests, in parallel and independent: the proposals are ordinary inbox
      // questions, and a `bd` sweep that fails must not take the advocate state —
      // which is in memory and always available — down with it.
      const [work, questions] = await Promise.all([
        api('/api/work'),
        api('/api/questions?scope=human').catch(() => ({ questions: [] })),
      ]);
      state.work = work;
      // Kept for the next document that wants them — this page on the next tab tap,
      // and /admin, which boots from /api/work too.
      const warm = window.beadcause?.warm;
      // With its sequence, so the inbox can tell whether the copy it is holding for this
      // page has been invalidated by anything since — see `MAINTAINED` in public/app.js.
      warm?.write?.('/api/work', work, Number(work?.seq) || 0);
      if (questions.questions) warm?.write?.('/api/questions?scope=human', questions, questions.seq);
      adoptQuestions(questions);
      state.error = null;
      // Before the paint rather than beside it: the settings card is drawn from this,
      // and painting without it then painting again a moment later would flash "Reading
      // this space…" over a card that was already correct. Cheap — /api/space is a read
      // of `cfg`, no `bd` and no disk.
      await loadSpace();
      render({ polled });
      // Not awaited and not gated on the paint above: the Ship strip is a late addition
      // to a card that is already correct without it, and a page that waited on a `gh`
      // sweep per repo before drawing an advocate would be a slower page for a number
      // that is usually zero.
      loadBoard();
      pumpLogs().finally(scheduleLogs);
      // Only from a request that came back: warming behind a refused credential would
      // be four more refusals. See public/warm.js.
      warm?.prewarm?.({ here: 'advocates', api });
    } catch (err) {
      state.error = err.message;
      // Only over an empty pane. With a warm board already drawn, replacing it with an
      // error throws away everything still worth reading for a failure the next tick
      // will most likely undo.
      if (!state.work) out.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
    } finally {
      pulse.classList.remove('busy');
      // Whether or not that worked, and deliberately: a page opened while the daemon is
      // restarting used to be brought back by the twenty-second timer, and with the
      // timer gone the stream is the only thing that can. Its own backoff is what stops
      // that being a request every five seconds at a daemon that is not coming back yet.
      follow();
    }
  }

  /**
   * The board behind the Ship strip — borrowed, never owned.
   *
   * Three rules, and the first two are about not making this page expensive:
   *
   * - **Throttled**, because a repaint is not a reason to re-sweep every repo. `force` is
   *   for the ⟳ and for the moment after a Ship, when the number on the button is the
   *   thing that just changed.
   * - **Only while the pane is up.** The PRs pane and the Mirror stand their own polls
   *   down when hidden (public/montabs.js); a board fetched for a card nobody is looking
   *   at would be the same waste by a quieter route.
   * - **A failure is silent and keeps what it had.** The strip is a bonus on this page,
   *   not its subject: an error banner over the advocates because GitHub was slow would
   *   be a worse page than one whose Ship count is a minute old.
   */
  async function loadBoard({ force = false } = {}) {
    if (out.hidden) return;
    if (!force && Date.now() - state.boardAt < BOARD_MS) return;
    state.boardAt = Date.now();
    try {
      const board = await api('/api/prs');
      state.board = board;
      render();
    } catch {
      // Kept: see above. The next event or the next minute asks again.
    }
  }

  /**
   * The selected space's own configuration.
   *
   * Nothing to fetch while the picker is on All — there is no one space these would be
   * the settings of — and the card says so instead. `Other` is a 404 by design and its
   * message is drawn rather than swallowed: it is a group the picker offers, not a
   * thing with settings, and "why are there no controls" deserves a sentence.
   */
  async function loadSpace() {
    const name = spaceName();
    if (!name) {
      state.space = null;
      state.spaceError = null;
      return;
    }
    try {
      state.space = await api(`/api/space?space=${encodeURIComponent(name)}`);
      state.spaceError = null;
    } catch (err) {
      state.space = null;
      state.spaceError = err.message;
    }
  }

  /**
   * Fetch the transcript for every advocate whose panel is open, plus any that is
   * surveying right now.
   *
   * The second half is what makes the panel worth having: a survey runs for minutes
   * and finishes without you, so an advocate that starts thinking opens its own panel
   * rather than leaving the evidence to be found later.
   */
  async function pumpLogs() {
    const advocates = state.work?.advocates || [];
    const want = advocates.filter((a) => isOpen(`${a.workspace}:log`) || a.surveying);
    if (!want.length) return;
    let changed = false;
    await Promise.all(
      want.map(async (a) => {
        if (a.surveying && !isOpen(`${a.workspace}:log`)) {
          state.open.add(`${a.workspace}:log`);
          changed = true;
        }
        try {
          const log = await api(`/api/advocate-log?workspace=${encodeURIComponent(a.workspace)}`);
          const prev = state.logs.get(a.workspace);
          if (!prev || prev.lines.length !== log.lines.length || prev.running !== log.running) changed = true;
          state.logs.set(a.workspace, log);
        } catch {
          // A workspace that lost its advocate mid-poll 404s here. Nothing to say.
        }
      })
    );
    if (changed) {
      // A transcript arriving is a poll like any other — and this one is every two and
      // a half seconds, so it is the paint most likely to land on a clock being set.
      render({ polled: true });
      // Pin the transcript to its foot, the way a terminal does: this is a live log,
      // and the newest line is the one you are here for.
      for (const el of out.querySelectorAll('.mon-log')) el.scrollTop = el.scrollHeight;
    }
  }

  /* ------------------------------------------------------------------ actions */

  /**
   * Pause, resume, free the slots, or forget the attempt counters.
   *
   * `ws` is undefined for exactly one action: `globalLimit` is a total across every
   * advocate, so it belongs to no repo and `JSON.stringify` drops the key rather than
   * naming one. The server reads the action before it looks for a workspace. Nothing
   * reaches here with that action any more — the global cap is applied by `applyLimit`
   * — but the shape is the endpoint's, not this button row's, so it stays.
   */
  async function control(ws, action, btn, value) {
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = '…';
    try {
      await api('/api/advocate', {
        method: 'POST',
        // `value` is sent as a number or not at all. A `"4"` string would be clamped
        // to the same 4 by the daemon, but the endpoint is the contract and a
        // stringly-typed count is the sort of thing that stays wrong quietly.
        body: JSON.stringify({ workspace: ws, action, ...(value == null ? {} : { value: Number(value) }) }),
      });
      await load();
    } catch (err) {
      btn.textContent = was;
      btn.disabled = false;
      // The card for a repo's button, and the global row itself for the one button
      // that has no card — a refusal appended nowhere is a press that looks like it
      // worked, which is the whole failure this line exists to prevent.
      (btn.closest('.mon-card') || btn.closest('.svc'))?.insertAdjacentHTML(
        'beforeend',
        `<div class="adv-note bad">${esc(err.message)}</div>`
      );
    }
  }

  /**
   * Move a stepper without writing anything.
   *
   * A pending number equal to the live one is *deleted* rather than stored, so stepping
   * up and back down again puts the control back to settled — an Apply button offering
   * to set 3 to 3 is a press with nothing behind it. Clamped here as well as by the
   * disabled buttons: a keyboard repeat can outrun a repaint.
   */
  function stepLimit(key, want, ceiling) {
    if (state.applyingLimits.has(key)) return;
    const live = liveLimit(key);
    const next = Math.max(1, Math.min(Number(want) || 1, ceiling ?? Infinity));
    if (live != null && next === live) state.pendingLimits.delete(key);
    else state.pendingLimits.set(key, next);
    // A number you have just re-dialled is not a number that failed to apply.
    state.limitErrors.delete(key);
    render();
  }

  /** What the daemon currently has, for the stepper keyed `key`. */
  function liveLimit(key) {
    if (key === GLOBAL_STEP) return state.work?.globals?.maxWorkers ?? null;
    const ws = stepWorkspace(key);
    return (state.work?.advocates || []).find((a) => a.workspace === ws)?.limit ?? null;
  }

  /**
   * Send the number the stepper is holding — the one write this control makes.
   *
   * The whole control goes disabled for the round trip (`applyingLimits` plus a
   * repaint, so a poll landing mid-flight cannot re-enable it), and the pending value
   * is kept on failure: the refusal is a reason to look at the number, not a reason to
   * lose it. On success it is dropped and `load()` brings back the daemon's own answer,
   * which is what the pill then shows — the two differ whenever the clamp bit.
   */
  async function applyLimit(key) {
    const want = state.pendingLimits.get(key);
    if (want == null || state.applyingLimits.has(key)) return;
    state.applyingLimits.add(key);
    state.limitErrors.delete(key);
    render();
    try {
      await api('/api/advocate', {
        method: 'POST',
        // A number, never a string: the daemon would clamp `"4"` to the same 4, but the
        // endpoint is the contract and a stringly-typed count stays wrong quietly.
        body: JSON.stringify({ workspace: stepWorkspace(key), action: stepAction(key), value: Number(want) }),
      });
      state.pendingLimits.delete(key);
      state.applyingLimits.delete(key);
      await load();
    } catch (err) {
      state.applyingLimits.delete(key);
      state.limitErrors.set(key, err.message);
      render();
    }
  }

  /**
   * Change one of the selected space's settings.
   *
   * One field per press, never the whole object: the page repaints every twenty
   * seconds off a payload assembled before your thumb landed, and a read-modify-write
   * from that would put back whatever a *second* device changed in between. The server
   * patches, so a press says only what it means.
   *
   * The reply is the new detail, and it is adopted rather than re-fetched — it is the
   * one answer that is definitely post-write, where a poll racing the same moment
   * might not be. `changed` is the daemon's own list of what actually moved, which is
   * shorter than the label promises exactly when it matters: pressing Inherit on a
   * field that was already inheriting changes nothing, and saying "nothing to change"
   * is more honest than a tick.
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

  /**
   * Answer a proposal: create the beads you picked, decline the rest.
   *
   * The sentence is for you and the array is for the server — the same split
   * public/app.js makes, and for the same reason: the numbers must not have to be
   * read back out of prose. Nothing is sent until every bead has a decision, which
   * is what the disabled submit enforces.
   */
  async function submitProposal(key, btn) {
    const q = (state.proposals.get(key.split('/')[0]) || []).find((x) => x.key === key);
    if (!q) return;
    const beads = q.proposal?.beads || [];
    const picks = picksFor(key);
    const approved = [...picks.entries()]
      .filter(([, v]) => v === 'yes')
      .map(([n]) => n)
      .sort((a, b) => a - b);
    const declined = beads.length - approved.length;
    const text = approved.length
      ? `CREATE: ${approved.join(',')} — filing ${approved.length} of ${plural(beads.length, 'proposed bead')}${
          declined ? `, declining ${declined}` : ''
        }.`
      : `Not now — none of the ${plural(beads.length, 'proposed bead')}.`;

    btn.disabled = true;
    btn.textContent = '…';
    try {
      await api('/api/respond', {
        method: 'POST',
        body: JSON.stringify({ workspace: q.workspace, id: q.id, response: text, ...(approved.length ? { create: approved } : {}) }),
      });
      state.picks.delete(key);
      await load();
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Retry';
      out.querySelector(`.mon-proposal[data-key="${CSS.escape(key)}"]`)
        ?.insertAdjacentHTML('beforeend', `<div class="adv-note bad">${esc(err.message)}</div>`);
    }
  }

  /** List the archived sessions for a bead, or read one of them back. */
  /**
   * Ship what this repo has merged and not made live — one deploy, every merge on it.
   *
   * Two taps, like every other control in this app that restarts something: the first
   * arms and says how many are about to go out, the second sends. `/api/release/ship` is
   * the PRs pane's own endpoint and this asks it for exactly the same thing, so a Ship
   * from here and a Ship from the board are one act with two doors — the daemon logs them
   * identically and there is no second code path to keep true.
   *
   * A 200 is never "shipped". It means a record is on disk and a detached runner owns it;
   * on this repo the very next thing that happens is this daemon being SIGKILLed by the
   * deploy it just started, so the page you pressed it on may lose its connection before
   * the sentence below is read. How it went arrives on the phone, on the PRs pane's
   * deploy strip — and, now, as the page reloading itself when it comes back (see
   * public/update.js).
   */
  async function ship(key) {
    const card = (state.board?.repos || []).find((c) => cardKey(c) === key);
    if (!card?.release?.count || state.shipping) return;
    if (state.armedShip !== key) {
      state.armedShip = key;
      return render();
    }

    const count = card.release.count;
    const where = card.repoName ? `${card.workspace} · ${card.repoName}` : card.workspace;
    state.armedShip = null;
    state.shipping = true;
    state.shipSaid = { key, text: `Deploying ${where} — ${plural(count, 'merged pull request')}…`, bad: false };
    render();

    try {
      const data = await api('/api/release/ship', {
        method: 'POST',
        // Both, exactly as public/prs.js sends them: the key is what the daemon acts on,
        // and the workspace beside it is what an older daemon — one that has not been
        // deployed with this bundle yet — reads instead.
        body: JSON.stringify({ key, workspace: card.workspace }),
      });
      state.shipSaid = {
        key,
        text: `Deploying ${where} — ${data.deploy?.id || 'started'}, carrying ${plural(
          count,
          'merge'
        )}. How it went lands on your phone.`,
        bad: false,
      };
    } catch (err) {
      state.shipSaid = { key, text: err.message, bad: true };
    } finally {
      state.shipping = false;
      render();
      loadBoard({ force: true });
    }
  }

  async function openArchive(ws, bead) {
    try {
      const arc = await api(`/api/session-archive?workspace=${encodeURIComponent(ws)}&id=${encodeURIComponent(bead)}`);
      state.archives.set(ws, arc);
    } catch (err) {
      state.archives.set(ws, { error: err.message });
    }
    render();
  }

  async function readArchived(ws, commit) {
    try {
      const one = await api(`/api/session-archive?workspace=${encodeURIComponent(ws)}&commit=${encodeURIComponent(commit)}`);
      state.archives.set(ws, { ...state.archives.get(ws), text: one.text });
    } catch (err) {
      state.archives.set(ws, { ...state.archives.get(ws), error: err.message });
    }
    render();
  }

  /* ------------------------------------------------------------------- events */

  out.addEventListener('click', (e) => {
    // Ship, first of all: it is the one control on this page that changes what is
    // running, and it carries its repo on itself rather than a workspace — so nothing
    // below, all of which reads `data-ws`, may be allowed to claim the press.
    const shipBtn = e.target.closest('[data-ship]');
    if (shipBtn) {
      e.preventDefault();
      ship(shipBtn.dataset.ship);
      return;
    }

    // The space's own settings, before the advocate controls: both draw `.adv-btn`,
    // and these carry their field on themselves rather than a workspace.
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
      const from = out.querySelector('#qh-from')?.value;
      const to = out.querySelector('#qh-to')?.value;
      saveSpace({ quietHours: { from, to } }, hours);
      return;
    }

    const chan = e.target.closest('[data-space-channel]');
    if (chan) {
      e.preventDefault();
      const typed = (out.querySelector('#slack-channel')?.value || '').trim();
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
      if (sum.dataset.toggle.endsWith(':log')) pumpLogs();
      return;
    }

    // Before `[data-adv]`, and carrying no `data-adv` of their own: a stepper press is
    // now a change to a number this page is holding, and only Apply talks to the daemon.
    const stp = e.target.closest('[data-step]');
    if (stp) {
      e.preventDefault();
      stepLimit(stp.dataset.step, Number(stp.dataset.value), Number(stp.dataset.ceiling) || undefined);
      return;
    }

    const app = e.target.closest('[data-apply]');
    if (app) {
      e.preventDefault();
      applyLimit(app.dataset.apply);
      return;
    }

    const adv = e.target.closest('[data-adv]');
    if (adv) {
      e.preventDefault();
      // Nothing here carries a number any more — the two that did are the steppers
      // above, which apply through `applyLimit`. `value` stays in the signature
      // because `control` is the one door to /api/advocate and the endpoint takes one.
      control(adv.dataset.ws, adv.dataset.adv, adv, adv.dataset.value);
      return;
    }

    const pick = e.target.closest('[data-pick]');
    if (pick) {
      e.preventDefault();
      const picks = picksFor(pick.dataset.key);
      const n = Number(pick.dataset.n);
      // Tapping the choice you already made clears it — undecided is a real state,
      // and there has to be a way back to it.
      if (picks.get(n) === pick.dataset.pick) picks.delete(n);
      else picks.set(n, pick.dataset.pick);
      render();
      return;
    }

    const all = e.target.closest('[data-pick-all]');
    if (all) {
      e.preventDefault();
      const key = all.dataset.key;
      const q = (state.proposals.get(key.split('/')[0]) || []).find((x) => x.key === key);
      const picks = picksFor(key);
      (q?.proposal?.beads || []).forEach((_, i) => picks.set(i + 1, all.dataset.pickAll));
      render();
      return;
    }

    const sub = e.target.closest('[data-submit]');
    if (sub) {
      e.preventDefault();
      submitProposal(sub.dataset.submit, sub);
      return;
    }

    const arc = e.target.closest('[data-archive]');
    if (arc) {
      e.preventDefault();
      openArchive(arc.dataset.archive, arc.dataset.bead);
      return;
    }

    const read = e.target.closest('[data-read]');
    if (read) {
      e.preventDefault();
      readArchived(read.dataset.read, read.dataset.commit);
    }
  });

  /* The one field on this page you type into, and this page repaints off a stream
     event rather than off your thumb — so what has been typed is held in `state` and
     drawn from there, the same treatment the limit steppers get and for the same
     reason. Without it a poll landing between the first character and the press takes
     the channel id away and the field silently goes back to what the space already
     said. */
  out.addEventListener('input', (e) => {
    if (!e.target.closest('#slack-channel')) return;
    state.slackDraft = { space: spaceName(), text: e.target.value };
  });

  /* The ⟳ is the page's, and this page has three panes now — so it only means *this*
     one while this one is up. Without the guard, pressing it on the board would sweep
     `bd` for every tracker on the Mac to refresh a roster nobody is looking at, which is
     the same bill `ready` below exists to stop the stream running up. */
  document.getElementById('refresh').addEventListener('click', () => {
    if (out.hidden) return;
    load();
    // The ⟳ means "ask everything again", and the Ship count is one of the things on this
    // page a minute-old answer can be wrong about — a merge that landed while you read it.
    loadBoard({ force: true });
  });
  /* The space picker moved. Which repos are drawn is decided at paint time off the
     /api/work payload already in hand — but *whose settings* the card at the top shows
     has changed, and that is a different space's config, so it is fetched. Painted
     first all the same: the repos below are correct immediately, and the card says it
     is reading rather than sitting on the previous space's answers. */
  window.beadcause?.space?.onChange(() => {
    state.spaceSaid = null;
    render();
    loadSpace().then(render);
  });
  /* ------------------------------------------------------------------- the stream */

  /**
   * Follow the event log instead of re-asking on a clock.
   *
   * `want: 'presence'` is what makes the park free — this page draws none of the inbox
   * questions, so it asks the daemon not to sweep `bd` on its behalf and goes and gets
   * what it needs itself, for the events that need it. `cold: true` because `/api/work`
   * carries no sequence, and the `since`-less first request that learns one costs
   * nothing under `want: 'presence'`.
   *
   * The pane is only followed while it is the one you are looking at: the mirror tab
   * sits over this one, and a hidden page must not keep asking about every tracker on
   * the Mac. That was true of the timer this replaces and it is truer here, because the
   * park is a held socket rather than a tick.
   */
  let stream = null;
  function follow() {
    if (!window.beadcause?.stream) return;
    // Mounted once and started every time. `load` is what calls this — the boot, the ⟳,
    // and the mirror tab handing the pane back (`window.beadcause.monitor.refresh`) —
    // and the middle one is why: `ready` goes false while the mirror is up, which ends
    // the loop, and coming back has to be able to pick it up again. `start` on a stream
    // that is already parked is a no-op.
    if (stream) return stream.start();
    stream = window.beadcause.stream.follow({
      api,
      want: 'presence',
      cold: true,
      ready: () => !out.hidden,
      onWake({ data, events, resync }) {
        // The half that costs nothing. The snapshot is on every wake whatever woke it,
        // so an advocate pausing, checking in or freeing a slot repaints from the poll
        // that was already parked — no request, no `bd`.
        if (state.work && Array.isArray(data.advocates)) {
          state.work = { ...state.work, advocates: data.advocates, observing: data.observing ?? state.work.observing };
          // `render` restarts the transcript tail, which matters here as much as on a
          // fold: an advocate that has just started surveying is one this page begins
          // tailing, and the snapshot above is how it finds out.
          render({ polled: true });
        }
        if (resync) {
          // We have lost our place in the log, so nothing on screen is provably current.
          load({ polled: true });
          return;
        }
        // A merge, a deploy, a declined review: the events behind the Ship strip's number,
        // and the only things that can move it. Forced, because the whole point of hearing
        // about a merge is that the count this page is showing is now wrong — and a deploy
        // settling is what takes the strip back down to nothing.
        if (window.beadcause.stream.boardMoved(events)) loadBoard({ force: true });
        // Presence is a thumb moving on somebody's phone, and an advocate saying it is
        // still surveying is the roster above. Neither is a reason to sweep `bd`.
        if (window.beadcause.stream.workMoved(events)) load({ polled: true });
      },
    });
    stream.start();
  }

  /**
   * The transcript tail, on its own clock — and only while there is a transcript to tail.
   *
   * A self-rescheduling timeout rather than a `setInterval`, which is not a style
   * preference: an advocate's log is a file on the Mac and a file changing emits no
   * event, so this is the one thing on the page that genuinely has to ask on a clock.
   * Making it stop when no log card is open and no advocate is surveying is what keeps
   * that from being a request every two and a half seconds all day for a fold nobody
   * has opened. `render` restarts it, so opening a card is what starts the tail.
   */
  let logTimer = null;
  function scheduleLogs() {
    clearTimeout(logTimer);
    logTimer = null;
    if (out.hidden) return;
    const advocates = state.work?.advocates || [];
    if (!advocates.some((a) => isOpen(`${a.workspace}:log`) || a.surveying)) return;
    logTimer = setTimeout(() => pumpLogs().finally(scheduleLogs), LOG_MS);
  }

  // Kept for anything that wants this pane refreshed from outside. The chip row does it
  // through the subscription at the foot of this file now, rather than by name.
  window.beadcause = window.beadcause || {};
  window.beadcause.monitor = { refresh: load };

  /* Where this device is, for a mirror on some other screen, is published by
     public/montabs.js rather than here — because on this page it is a fact about which
     of the three chips is up, and there is no moment at which this file knows that and
     that one does not. The ids are on the chips themselves in monitor.html: `sessions`
     for this pane, because that is what lib/presence.js whitelists and what the mirror
     already has a name for; `prs` for the board; and nothing at all for the Mirror.

     That last one is not tidiness. This page can also *be* a mirror, and presence.js's
     own header was right that a device which followed itself would be absurd — so the
     report goes `null` while the mirror pane is up, and mirror.js drops its own device
     from the list it follows. Both halves are needed: the report is honest about which
     pane you are on, and the list cannot circle back on this one even mid-switch. */

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    // Paint what this tab had, then go and ask. The order is the whole point: `load`
    // is not made faster by this, it is made invisible.
    warmBoot();
    /* And ask only while this is the pane you are on. The chip row calls back once at
       boot with whichever chip is up — which is the boot `load()` that used to be
       written here — and again every time you come back to this one, which is what
       mirror.js used to do by calling `beadcause.monitor.refresh` by name. Arriving on
       /prs, which is this same page with the board up, now costs no `bd` sweep at all.

       The fallback is not dead code: a service worker holding a monitor.html from before
       the chip row was a file would load this one beside no montabs.js, and a page that
       then never asked for anything would be a blank roster with no way to fill it. */
    const tabs = window.beadcause?.monTabs;
    if (tabs) tabs.onChange((which) => which === 'advocates' && load());
    else load();
  }
})();
