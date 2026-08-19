/* Where everything in flight actually is — the two queues, as cards.
 *
 * ## What this page took, and from where
 *
 * The deploy strip used to be the first thing on the PR board (public/prs.js), above a
 * screen that is otherwise about pull requests: a restart in flight has a much shorter
 * fuse than a lamp does, so it was told rather than scanned for, and the top of the
 * nearest page was where it went. That was the right place while it was the only place.
 * It is not any more — `GET /api/queues` (lib/queues.js) says where every bead in flight
 * is, in both queues, and a deploy is one rung of one of them. So the strip moves here
 * with the ladder it belongs to, and the board keeps what is actually about a pull
 * request: the row, the lamps, and the Ship button with its count.
 *
 * ## Two kinds of card, one renderer
 *
 * A **Merge Card** per bead with an unmerged branch, from the moment its pull request
 * joins the merge queue; a **Release Card** per merged pull request, in the batch it will
 * ship with. They are different queues — entered by different events, drained by
 * different agents — and nothing is ever in both. What they share is a shape: every entry
 * in either carries `rungs[]`, the whole ladder with each rung `done` · `now` · `pending`
 * · `untracked`, which is why `cardHtml` below does not ask which queue it is drawing.
 * A card that had to know would be two renderers wearing one name.
 *
 * **The stage is the collapsed summary.** The card says where the work is without being
 * opened, because the question this page answers is "where is it" and an answer you have
 * to tap twelve times to read is a worse answer than none. Unfolding gets you the whole
 * ladder, the times somebody actually recorded, and the sentence explaining the rung it
 * is on — and the whole collapsed card is the tap target, not a chevron you have to hit.
 *
 * ## `untracked` is never a tick
 *
 * Three release rungs — deployed to green, green verification, swapping to blue — are
 * observed by the router's handover trail (lib/handover.js) and by nothing else, because
 * `npm run swap` deliberately writes no deploy record. Where there is no handover to read
 * they come back `untracked`, and this file draws that as its own state with the word on
 * it. Filling them in from the current stage would tick "green verification" over a
 * verification nobody ran, which reads exactly like the truth and is not it. The
 * derivation is not here and must not be: the daemon decided every rung in one place, and
 * a client that re-derived one would be a second, worse copy of that ladder.
 *
 * ## The two clocks
 *
 * The queues are woken by the event log — a merge, a deploy starting or settling, an
 * advocate moving something — and ask for nothing in between. A deploy *in flight* is the
 * exception and keeps the fast four-second tick the strip has always had: its steps are a
 * file being written on the Mac and no event can carry them. When nothing is running there
 * is no timer at all unless the stream is down, which is the fallback rather than the
 * rule; see `scheduleDeploys`.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('releases');
  const pulse = document.getElementById('pulse');
  const observing = document.getElementById('observing');

  /** The events that can have moved something in either queue. */
  const QUEUE_EVENTS = window.beadcause?.stream?.BOARD_EVENTS || [
    'merged',
    'changes',
    'pr-declined',
    'deploy',
    'advocate',
  ];

  /* The deploy strip's own clock, while something is actually running. Fast enough that
     a step change is news rather than history. */
  const DEPLOY_LIVE_MS = 4000;

  /* And the fallback for a page with no stream behind it — an older service-worker shell,
     a proxy that keeps no log, a poll between its failure and its next retry. */
  const DEPLOY_IDLE_MS = 30000;

  /* How many deploys the strip asks for. The last few are the subject; the journal keeps
     forty and a history of forty is a different screen nobody has asked for. */
  const DEPLOY_LIMIT = 6;

  const state = {
    /** `/api/queues`, or null before the first answer. */
    data: null,
    /** Which card is unfolded, by its key. At most one — that is what makes it a list. */
    open: null,
    /** `{deploys, deployable}` from /api/deploys, or null before the first answer. */
    deploys: null,
    /** Which deploy row is unfolded, by id, and the full record behind it. */
    deploy: null,
    detail: null,
    /** True while /api/deploys itself is unreachable. Read together with a live restart. */
    gone: false,
    /** The last queues fetch's failure, if it failed. Cleared by the next one that works. */
    error: null,
  };

  /* Four small ones from public/prcard.js, which the board and the inbox already share.
     Taken apart here rather than reached for through `window` at every call site. */
  const { esc, plural, ago, graphUrl } = window.beadcause.prCard;

  /** Is this repo in the selected space? See public/spacebar.js. */
  const inSpace = (r) => window.beadcause?.space?.matches?.(r.workspace) ?? true;

  /* -------------------------------------------------------------------- the ladder */

  /**
   * The mark against a rung, and it is four marks rather than two.
   *
   * `untracked` gets a dash and the word beside it, never the tick. It is the whole
   * reason `rungsFor` computes state on the daemon instead of leaving a screen to work it
   * out from the position — see the header.
   */
  const MARK = { done: '✓', now: '●', pending: '○', untracked: '–' };

  function rungHtml(r) {
    const at = r.at ? `<span class="queue-rung-at">${esc(ago(r.at))}</span>` : '';
    const untracked = r.state === 'untracked' ? '<span class="queue-untracked">not tracked</span>' : '';
    // The sentence only under the rung it is about. Every rung has one and printing all
    // seven would be a paragraph where the ladder was supposed to be a glance.
    const note = r.state === 'now' ? `<p class="queue-rung-note">${esc(r.note)}</p>` : '';
    return `<li class="queue-rung ${esc(r.state)}">
      <span class="queue-mark" aria-hidden="true">${MARK[r.state] || '○'}</span>
      <span class="queue-rung-name">${esc(r.label)}</span>
      ${untracked}${at}
      ${note}
    </li>`;
  }

  /* ------------------------------------------------------------------- one card */

  /** A card's key: the queue it is in and the thing it is about, which is unique in both. */
  const keyFor = (e) =>
    e.kind === 'merge' ? `merge:${e.workspace}:${e.mergeBead}` : `release:${e.key}:${e.number}`;

  /** The bead pills on a card — every bead the pull request was for, not just the first. */
  const beadsHtml = (e) => {
    const ids = e.kind === 'merge' ? [e.bead].filter(Boolean) : e.beads?.length ? e.beads : [e.bead].filter(Boolean);
    return ids.map((id) => `<a class="pill id" href="${esc(graphUrl(e.workspace, id))}">${esc(id)}</a>`).join(' ');
  };

  /**
   * The facts under the ladder — different per queue, because they answer different
   * questions.
   *
   * A merge card is read when something has *not* merged, so what it owes is the branch,
   * how many attempts are left and whatever refused it. A release card is read when
   * something has merged and you want to know whether it is live, so what it owes is the
   * commit, the deploy carrying it and the handover that swapped to it.
   */
  function factsHtml(e) {
    const row = (name, value) => (value ? `<div class="queue-fact"><dt>${esc(name)}</dt><dd>${value}</dd></div>` : '');
    const code = (v) => `<code>${esc(v)}</code>`;

    if (e.kind === 'merge') {
      return `<dl class="queue-facts">
        ${row('Branch', e.branch ? `${code(e.branch)} → ${code(e.base)}` : '')}
        ${row(
          'Merge bead',
          e.mergeBead ? `<a class="pill id" href="${esc(graphUrl(e.workspace, e.mergeBead))}">${esc(e.mergeBead)}</a>` : ''
        )}
        ${row('Attempts', e.attempts ? `${esc(e.attempts)} made · ${plural(e.attemptsLeft, 'left')}` : '')}
        ${row('Downmerges', e.downmerges ? esc(e.downmerges) : '')}
        ${row('Approved', e.approved ? 'yes — a review is on it' : '')}
        ${row('Refused', e.refused ? esc(e.refused) : '')}
      </dl>`;
    }

    /* Never "deployed" from a status alone: `unconfirmed` is the ordinary ending of a
       deploy that SIGKILLs the runner that asked for it, so the word is the record's own
       and the ladder above is what says whether anything went live. */
    const dep = e.deploy ? `${code(e.deploy.id)} · ${esc(e.deploy.status)}` : '';
    const hand = e.handover
      ? `${esc(ago(e.handover.at))}${e.handover.port ? ` · port ${esc(e.handover.port)}` : ''}${
          e.handover.build ? ` · ${code(String(e.handover.build).slice(0, 7))}` : ''
        }`
      : '';
    return `<dl class="queue-facts">
      ${row('Merged', e.mergedAt ? `${esc(ago(e.mergedAt))}${e.sha ? ` · ${code(e.sha)}` : ''}` : '')}
      ${row('Deploy', dep)}
      ${row('Handover', hand)}
      ${row(
        'Ship bead',
        e.shipBead ? `<a class="pill id" href="${esc(graphUrl(e.workspace, e.shipBead))}">${esc(e.shipBead)}</a>` : ''
      )}
    </dl>`;
  }

  /**
   * How old a live release is, in the one sentence the ageing rule is written in.
   *
   * `ago` counts *releases* and not days, which is the whole point: a repo that deploys
   * twice an hour and one that deploys twice a week keep an entry visible for the same
   * amount of work. An entry more than `KEEP_RELEASES` back never arrives here at all —
   * the daemon drops it — so there are only ever two sentences to write.
   */
  const liveNote = (e) =>
    e.ago === 0 ? 'live in what is running now' : e.ago === 1 ? 'live — one release back' : `live — ${e.ago} releases back`;

  /**
   * One card, either kind.
   *
   * The whole collapsed card is the `<button>`: the tap target is the card, not a chevron
   * on it, which on a phone is the difference between a list you can use one-handed and
   * one you aim at. `aria-expanded` is on the same element for the same reason.
   */
  function cardHtml(e) {
    const key = keyFor(e);
    const open = state.open === key;
    const num = e.number ? `<span class="board-num">#${esc(e.number)}</span> ` : '';
    const title = e.title || (e.kind === 'merge' ? e.branch || 'a branch' : 'a merged pull request');
    // `live` is its own tone rather than the last rung of a ladder nobody has opened: on
    // this page "is it out?" is the question, and every other stage is the answer "not
    // yet, here is where".
    /* Every class this card wears is `queue-`prefixed, the kind and the tone included.
       `.release` is already this stylesheet's Ship strip on the PR board — a bordered,
       padded, tinted box — so an `<article class="… release">` here quietly inherited the
       lot, which on a screen reads as a card styled slightly differently rather than as
       two rules fighting. Grep public/style.css for any class name you are about to
       invent; `.pill` and `.pill-row` cost bc-khoe.1 the same hour. */
    const tone =
      e.kind === 'merge'
        ? e.stage === 'issues' || e.stage === 'conflicts'
          ? 'queue-warn'
          : 'queue-live'
        : e.stage === 'live'
          ? 'queue-good'
          : 'queue-live';
    const said = e.kind === 'release' && e.stage === 'live' ? liveNote(e) : e.stageLabel;
    return `<article class="queue-card queue-${esc(e.kind)} ${tone}${open ? ' unfolded' : ''}">
      <button class="queue-sum" type="button" data-card="${esc(key)}" aria-expanded="${open}">
        <span class="queue-main">
          <span class="queue-title">${num}${esc(title)}</span>
          <span class="queue-line">
            <span class="queue-stage"><span class="queue-dot" aria-hidden="true"></span>${esc(said)}</span>
          </span>
        </span>
        <span class="chev" aria-hidden="true">›</span>
      </button>
      ${
        open
          ? `<div class="queue-body">
              <ol class="queue-rungs">${(e.rungs || []).map(rungHtml).join('')}</ol>
              <div class="queue-links">
                ${e.url ? `<a class="board-btn link" href="${esc(e.url)}" target="_blank" rel="noopener">On GitHub</a>` : ''}
                ${beadsHtml(e)}
              </div>
              ${factsHtml(e)}
            </div>`
          : ''
      }
    </article>`;
  }

  /* ---------------------------------------------------------------- the two queues */

  /**
   * One queue, as a section — grouped by repo, and only labelled by repo where there is
   * more than one of them.
   *
   * The grouping is the batch. A release goes out per repo and takes everything on
   * `origin` with it, so the merged-and-not-live entries of one repo *are* the batch it
   * will ship with — which is a fact about the list's shape rather than a line of prose,
   * and this is where it is said. With one repo drawing there is nothing to distinguish,
   * and a heading over every card repeating the same word would be noise.
   */
  function sectionHtml(what, title, empty, groups) {
    const live = groups.filter((g) => g.entries.length);
    const n = live.reduce((sum, g) => sum + g.entries.length, 0);
    if (!n) {
      return `<section class="queue-sec" data-sec="${esc(what)}"><h2 class="queue-head">${esc(title)}</h2><p class="queue-empty">${esc(
        empty
      )}</p></section>`;
    }
    const many = live.length > 1;
    const body = live
      .map((g) => `${many ? `<h3 class="queue-group">${esc(g.where)}</h3>` : ''}${g.entries.map((e) => cardHtml(e)).join('')}`)
      .join('');
    return `<section class="queue-sec" data-sec="${esc(what)}">
      <h2 class="queue-head">${esc(title)} <span class="queue-count">${esc(n)}</span></h2>
      ${body}
    </section>`;
  }

  function queuesHtml() {
    const d = state.data;
    if (!d) {
      if (state.error) return `<div class="empty"><strong>Can't reach the server</strong>${esc(state.error)}</div>`;
      return '<div class="empty">Asking where everything is…</div>';
    }
    if (d.unavailable) return `<div class="empty"><strong>Nothing to show</strong>${esc(d.unavailable)}</div>`;

    const repos = (d.repos || []).filter(inSpace);

    // A tracker that would not answer is not an empty queue, and the difference is the
    // whole of what this line is for: a merge queue that came back empty because Dolt was
    // mid-write reads exactly like one with nothing in it.
    const errors = (d.errors || []).length
      ? `<p class="board-foot bad">Could not read the merge queue in ${(d.errors || [])
          .map((e) => esc(e.workspace))
          .join(', ')} — what is below may be short.</p>`
      : '';

    // What is on screen is the last answer that came back. Saying when, rather than
    // replacing it with an error, is the difference between a stale answer you can read
    // and no answer at all — and during a restart it is stale on purpose.
    const stale = state.error
      ? `<p class="board-foot bad board-quiet">Showing the queues as of ${esc(ago(d.at))} — the last refresh did not answer.</p>`
      : '';

    const merges = repos.map((r) => ({ where: r.where, entries: r.merge || [] }));
    if ((d.orphans || []).length) {
      // Listed rather than dropped: a merge-bead naming a repo this board has no card for
      // is a branch that cannot merge, and dropping it would make it look like one that
      // already has.
      merges.push({ where: 'not on this board', entries: d.orphans });
    }
    const releases = repos.map((r) => ({ where: r.where, entries: r.release || [] }));

    // A repo that can release nothing gets no release entries at all — there is no event
    // that could ever move one along — so it is said once here rather than being an
    // absence you have to notice.
    const untracked = repos.filter((r) => !r.releasable).map((r) => esc(r.where));
    const foot = untracked.length
      ? `<p class="board-foot">Nothing is released from here in ${untracked.join(', ')} — ${
          untracked.length === 1 ? 'that repo declares' : 'those repos declare'
        } no deploy beadcause can run and it cannot see the build. Merges there leave this page when they land.</p>`
      : '';

    return (
      stale +
      errors +
      sectionHtml('merge', 'Merging', 'Nothing is waiting to merge.', merges) +
      sectionHtml('release', 'Releasing', 'Everything merged is live.', releases) +
      foot
    );
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

  /** How a record says which repo it is of — `beadcause`, or `climative · athena-service`. */
  const whereOf = (x) => (x?.repoName ? `${x.workspace} · ${x.repoName}` : x?.workspace || x?.key || '');

  /**
   * Is the daemon about to go away, or already gone?
   *
   * Only a deploy that has *declared* it restarts beadcause counts. Everything else that
   * cannot be reached is a server that cannot be reached, and saying "it is restarting"
   * over that would be the comfortable lie rather than the true one.
   */
  const restarting = () => liveDeploys().some((r) => r.restarts);

  /**
   * Which step it is on, in a phrase.
   *
   * The status *is* the step — the runner writes it before each phase rather than after,
   * precisely so a record read mid-flight says where it got to. What is deliberately not
   * read here is the last entry in `steps`: a step is appended when it *finishes*, so
   * during a rebuild the newest one is the `git diff` before it. The restart is called out
   * because it is the one phase that ends this page.
   */
  function phaseOf(r) {
    const { word } = says(r);
    if (r.status === 'deploying' && r.restarts) return `${word} · restarting beadcause`;
    return word;
  }

  /**
   * How long it has taken, or took. A live one is measured against now, so the number
   * grows every poll — which is the only thing on the row that distinguishes a deploy that
   * is working from one that has been sitting on the same step for four minutes.
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
   * A deploy refused because the LaunchAgent it would have restarted is not this tree.
   *
   * `rec.error` says all of this already, in one paragraph — which reads as narrative when
   * what you actually want is four lookups: *which label, which program, which file, what
   * do I type*. So each is a row with a heading, and the paths and the command are
   * `<code>`, because a path in prose is a path you have to select carefully.
   *
   * `null` for every ordinary deploy, which is nearly all of them; see lib/deploy.js.
   */
  function launchAgentHtml(rec) {
    const la = rec.launchAgent;
    if (!la) return '';

    // Each row only if it has an answer. An `unreadable` plist has no program, and a
    // "Program: —" would be a field pretending to be a fact.
    const row = (name, value, note = '') =>
      value
        ? `<div class="la-row"><dt>${esc(name)}</dt><dd>${value}${note ? ` <span class="la-note">${esc(note)}</span>` : ''}</dd></div>`
        : '';

    const code = (v) => `<code>${esc(v)}</code>`;
    const fix = la.fixCommand
      ? `${code(la.fixCommand)}${la.fix ? ` <span class="la-note">${esc(la.fix)}</span>` : ''}`
      : la.fix
        ? esc(la.fix)
        : '';

    const why = (la.lines || []).filter((l) => !la.fixCommand || !l.includes(la.fixCommand));

    return `<section class="deploy-la">
      <p class="la-head">Refused — the LaunchAgent is not in step with this checkout.</p>
      <dl class="la-fields">
        ${row('Label', code(la.label))}
        ${row('Program', code(la.program), 'is what launchd would have restarted')}
        ${row('Plist', code(la.plist))}
        ${row('Fix', fix)}
      </dl>
      ${why.length ? `<p class="la-why">${esc(why.join(' '))}</p>` : ''}
    </section>`;
  }

  /**
   * The unfolded deploy: what it moved, every step it ran, and the runner's own log.
   *
   * The log is a second request (`?id=`) because the list deliberately does not carry it —
   * see `briefDeploy` in lib/deploy.js. Until it arrives the steps are already there,
   * which is the part that answers "where did it stop".
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

    // The checkout, unless naming it would only repeat the workspace already on the row —
    // which is the ordinary case, and a line that says "demo · demo" reads as a bug.
    const where = rec.dir?.replace(/^.*\//, '');
    const dir = where && where !== rec.workspace && where !== rec.repo ? `<code>${esc(where)}</code>` : '';

    return `<div class="deploy-body">
      ${rec.launchAgent ? launchAgentHtml(rec) : rec.error ? `<p class="deploy-why">${esc(rec.error)}</p>` : ''}
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
          <span class="deploy-what"><span class="deploy-dot" aria-hidden="true"></span>${esc(whereOf(r))}<span
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
   * Nothing is the ordinary state and it should look like it: a repo that has never been
   * deployed from here gets no empty box explaining that. The banner is the exception —
   * while the daemon is unreachable *and* a restart is in flight, the strip is the only
   * thing on the page that can say why.
   */
  function deploysHtml() {
    // A deploy belongs to the repo it ships, so the strip narrows with everything else.
    // The banner does not: a restart of beadcause itself is why this page is blank, and
    // suppressing the one line that says so because the deploy was of another repo would
    // leave the screen unexplained.
    const list = deploys().filter(inSpace);
    const banner =
      state.gone && restarting()
        ? `<p class="deploy-banner">beadcause is restarting — that is the deploy. This page comes back on its own.</p>`
        : '';
    if (!list.length) return banner ? `<section class="deploys">${banner}</section>` : '';
    return `<section class="deploys">${banner}${list.map(deployHtml).join('')}</section>`;
  }

  /* -------------------------------------------------------------------- render */

  function render() {
    if (!state.data && !state.deploys && !state.error) return;
    // `out` is inside the shell's scroller (bc-7utr), not the window: read and written on
    // the same element, so a repaint does not throw your place away.
    const scroller = out.closest?.('.pagescroll') || out;
    const was = scroller.scrollTop;
    out.innerHTML = deploysHtml() + queuesHtml();
    scroller.scrollTop = was;
  }

  /* -------------------------------------------------------------------- tapping */

  out.addEventListener('click', (ev) => {
    // A bead pill or the GitHub link inside a card is a navigation, not a fold.
    if (ev.target.closest('a[href]')) return;

    const deploy = ev.target.closest('[data-deploy]');
    if (deploy) {
      const id = deploy.dataset.deploy;
      state.deploy = state.deploy === id ? null : id;
      // The detail belongs to whichever one is open; keeping the old one would flash the
      // previous deploy's log under the row you just unfolded.
      state.detail = null;
      render();
      if (state.deploy) loadDetail(state.deploy);
      return;
    }

    const card = ev.target.closest('[data-card]');
    if (card) {
      const key = card.dataset.card;
      state.open = state.open === key ? null : key;
      render();
    }
  });

  /* -------------------------------------------------------------------- fetching */

  async function load({ refresh = false } = {}) {
    pulse.classList.add('busy');
    try {
      const res = await fetch(`/api/queues${refresh ? '?refresh=1' : ''}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      state.data = await res.json();
      // Kept for the next document that wants it — this page, on the next tap of its
      // pill. What a warm boot saves here is not the sweep, it is the blank screen over
      // it, and this is the page you open while the daemon behind it is restarting.
      window.beadcause?.warm?.write?.('/api/queues', state.data);
      observing.hidden = !state.data.observing;
      state.error = null;
      render();
      // Only from a request that came back, and only once — see public/warm.js.
      window.beadcause?.warm?.prewarm?.({ here: 'releases', api: warmApi });
    } catch (err) {
      // Kept in state rather than written over the page: `queuesHtml` decides what a
      // failure looks like, and with queues already on screen it is a line under the
      // deploy strip instead of the loss of everything the page was showing.
      state.error = err.message;
      render();
    } finally {
      pulse.classList.remove('busy');
      // Whether or not that worked, and deliberately: a page opened during a deploy is
      // looking at a daemon that is restarting, and the stream is what brings it back.
      follow();
    }
  }

  /**
   * What is deploying, on its own timer.
   *
   * Separate from the queues' fetch, and deliberately so: this is a directory read on the
   * daemon and can be asked every four seconds, where `/api/queues` rides a `gh` sweep per
   * repo and cannot. It is also the request that keeps working when the other has stopped
   * mattering — during a restart neither answers, and this is the one whose silence the
   * page knows how to explain.
   */
  async function loadDeploys() {
    const wasLive = liveDeploys().length > 0;
    try {
      const res = await fetch(`/api/deploys?limit=${DEPLOY_LIMIT}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // A stub or a daemon predating this endpoint answers `{}` for anything it has no
      // opinion about. Neither is a reason to draw an empty strip over working queues.
      state.deploys = Array.isArray(data.deploys) ? data : state.deploys;
      state.gone = false;
      render();
      // A live deploy's own record is what the open row is drawing, so keep it fresh.
      if (state.deploy && LIVE.has(deploys().find((r) => r.id === state.deploy)?.status)) loadDetail(state.deploy);
      // A deploy that has just settled has moved a card behind it from `deploying` to
      // `live`, and nothing else on this page knows that yet.
      if (wasLive && !liveDeploys().length) load({ refresh: true });
    } catch {
      // No message anywhere: with a restart in flight this is the deploy working, and
      // without one the queues' own failure is already saying it. See `deploysHtml`.
      state.gone = true;
      render();
    } finally {
      // From here, not from the caller: whoever asked has just changed the answer to "how
      // fast should this page be asking", and the pending timeout was set against the old.
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
   * The strip's clock, set from what the last answer said rather than fixed at boot — and,
   * while nothing is running, no clock at all.
   *
   * A deploy's *steps* are a file being written on the Mac and no event carries them, so a
   * deploy in flight is watched on four seconds. With nothing running the daemon's event
   * log is what says one has begun (`beginDeploy` in lib/server.js emits on the start as
   * well as on the settle), so an idle page holds a socket and asks for nothing.
   *
   * **The fallback is not decoration.** A page whose stream is not following has nothing to
   * wake it, and a strip that had quietly stopped refreshing would look exactly like one
   * with nothing to say.
   */
  let deployTimer = null;
  function scheduleDeploys() {
    clearTimeout(deployTimer);
    deployTimer = null;
    // Unreachable *and* a restart in flight is the fastest cadence there is a reason for:
    // nothing on the page will change until the daemon is back, and that is the moment
    // worth catching.
    if (liveDeploys().length || (state.gone && restarting())) {
      deployTimer = setTimeout(loadDeploys, DEPLOY_LIVE_MS);
      return;
    }
    if (!stream?.following) deployTimer = setTimeout(loadDeploys, DEPLOY_IDLE_MS);
  }

  /* The space picker moved — on this device or on the other one. Nothing is refetched: the
     payload already holds every repo, and which of them is drawn is a decision made at
     paint time. */
  window.beadcause?.space?.onChange(() => render());

  document.getElementById('refresh').addEventListener('click', () => {
    loadDeploys();
    load({ refresh: true });
  });

  /* ------------------------------------------------------------------- the stream */

  /**
   * Follow the event log instead of re-asking on a clock.
   *
   * `want: 'presence'` is what makes the park free: the daemon sweeps `bd` for a poll that
   * asked for the inbox questions, and this page draws none of them — it wants to be woken,
   * and then it decides for itself whether the news was about a queue.
   */
  let stream = null;
  function follow() {
    if (!window.beadcause?.stream) return;
    if (stream) {
      stream.start();
      return scheduleDeploys();
    }
    stream = window.beadcause.stream.follow({
      api: warmApi,
      want: 'presence',
      cold: true,
      onWake({ events, resync }) {
        if (resync) {
          loadDeploys();
          load({ refresh: true });
          return;
        }
        if (!window.beadcause.stream.touched(events, QUEUE_EVENTS)) return;
        load();
        // A deploy has started, or settled — lib/server.js emits the same event type for
        // both, and the record's `status` is what tells them apart. This is the whole of
        // the strip's clock while nothing is running.
        if (window.beadcause.stream.touched(events, 'deploy')) loadDeploys();
      },
      /** The stream has stopped — `scheduleDeploys` reads `stream.following` and puts the
       *  fallback timer back, so the two cadences stay one decision made in one place. */
      onSettle() {
        scheduleDeploys();
      },
    });
    stream.start();
    scheduleDeploys();
  }

  /** A plain GET, for the delta stream. `opts` carries its abort signal. */
  async function warmApi(path, opts = {}) {
    const res = await fetch(path, { ...opts, headers: { 'x-beadcause-token': token, ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /**
   * Draw the queues this device had last time, before anything has been asked for.
   *
   * A miss is not a failure — `render` simply has nothing yet and the "asking where
   * everything is…" line stands until the fetch lands, which is what every page here does
   * without a warm layer behind it.
   */
  function warmBoot() {
    const hit = window.beadcause?.warm?.read?.('/api/queues');
    if (!Array.isArray(hit?.data?.repos)) return false;
    state.data = hit.data;
    observing.hidden = !state.data.observing;
    render();
    return true;
  }

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    warmBoot();
    // `loadDeploys` runs alongside the queues rather than after them: if a deploy is in
    // flight the other request is the one that is about to fail, and the strip is what
    // says why. It schedules its own next tick — see `scheduleDeploys`.
    load();
    loadDeploys();
  }
})();
