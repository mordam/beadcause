/* What its session did — the detail for a bead whose session has already finished.
 *
 * `/session?pid=…` is live-only by construction, and not by oversight: it resolves a
 * running process, reads the transcript Claude Code is writing for it right now, and
 * 404s the moment the pid has gone. That is the right answer for a session that exited
 * between the refresh and the tap. It is no answer at all for a bead that closed in
 * June, and a bead is the thing that lasts — a process id stops identifying anything
 * the instant the process ends.
 *
 * So this is the archived counterpart, and the address is what makes it one:
 * `/bead-session?workspace=…&id=…`. No pid anywhere. What it reads is what the session
 * left behind in the repo when it exited — `refs/beadcause/sessions/<bead>`, one commit
 * per session, described in the README under "The session log, kept in the repo".
 *
 * Three things, in this order, and the order is the argument:
 *
 *   1. **The memories the session left.** The point of the page. A log tells you what
 *      happened; a memory is the session telling you what it *learned*, which is the one
 *      thing that would otherwise have died with the window.
 *   2. **The log**, with the metrics `meta.json` already carries — outcome, exit code,
 *      when it ran and for how long, its branch, the commits it made and whether that
 *      list is exact or the since-session-start heuristic.
 *   3. **Where its worktree went** — live, retired into the attic, or gone. There is no
 *      file browser in this app, so "viewing" it means the pull request for its branch
 *      where there is one. This page does not promise to render a tree.
 *
 * ## Absence is the hard part, and it is most of this file
 *
 * Each of the three is missing independently, and for ordinary reasons: a bead closed by
 * hand from the phone had no session at all, a session that crashed may have a log and
 * no memory, a session that never entered a worktree has no worktree to have gone
 * anywhere. So every section says **"Not available"** and offers nothing to tap when its
 * piece is not there — never a link that opens an empty pane, which is the failure this
 * page was specified against.
 *
 * That is why the page is told which files exist rather than finding out by trying:
 * `/api/bead-session` lists the archived tree, and the text of the log and the memory is
 * fetched from `/api/session-archive` **only for names that listing contained**. A
 * section that says nothing is there is stating a fact it was given, not describing the
 * shape of a request that failed.
 *
 * ## It reads, and that is all it does
 *
 * Every request here is a GET. There is no composer — a finished session cannot be
 * answered, which is the whole difference between this page and `/session` — no focus
 * button, because there is no window left to raise, and no poll: nothing about a session
 * that has exited is going to change while you read it. One request, then two reads, and
 * the page is done. `test/beadsession.mjs` asserts the absence of a non-GET in this file,
 * because "read-only" is the kind of property that stays true right up until someone adds
 * a convenience button.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('beadsession');
  const pulse = document.getElementById('pulse');
  const titleEl = document.getElementById('arc-title');

  const params = new URLSearchParams(location.search);
  // `ws` as well as `workspace`, because /graph spells it `ws` and the two pages are
  // linked from the same rows — a link that carried the wrong spelling would land here
  // saying "no bead named" with the bead plainly in the URL.
  const ws = params.get('workspace') || params.get('ws') || '';
  const bead = params.get('id') || '';
  // Which of a bead's sessions. Absent means the newest, which is what you want in every
  // case except going back through a bead that was worked more than once.
  const at = params.get('commit') || '';

  const state = {
    /** The whole `/api/bead-session` answer: the session list, the chosen one, the worktree. */
    detail: null,
    /** `memory.md` and `session.log`, as text. `null` = not fetched; `undefined` never appears. */
    memory: null,
    log: null,
    /** Set when a read of one of those failed, so the section can say so in place. */
    memoryError: null,
    logError: null,
    /** A page-level failure: no archive, no workspace, a dead server. */
    stopped: null,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  /* --------------------------------------------------------------- saying when */

  /** The clock time — "3h" does not say whether it was Tuesday. */
  const clock = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime())
      ? ''
      : d.toLocaleString([], { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  /** How long ago, for a page whose whole subject is in the past. */
  function ago(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (!Number.isFinite(mins)) return '';
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.round(hrs / 24);
    return days < 60 ? `${days}d ago` : `${Math.round(days / 30)}mo ago`;
  }

  /** How long it ran. The number that says whether it was a fix or an afternoon. */
  function spanned(from, to) {
    const a = Date.parse(from || '');
    const b = Date.parse(to || '');
    if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return '';
    const mins = Math.round((b - a) / 60000);
    if (mins < 1) return 'under a minute';
    if (mins < 60) return `${mins}m`;
    return `${Math.floor(mins / 60)}h ${mins % 60}m`;
  }

  const bytes = (n) => {
    if (!Number.isFinite(n) || n <= 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  };

  /* ------------------------------------------------------------------ the header */

  /**
   * The bead, and the title the session recorded for it.
   *
   * Read twice, like /session's: in a drawer public/drawer.js watches this and hands it
   * up to the panel's header, and out of one it is the page's own title bar. The bead id
   * leads, always — it is the only part of this page that is certainly true before
   * anything has loaded, and a page about "(untitled)" says less than one about bc-nib3.5.
   */
  function setTitle() {
    const title = state.detail?.session?.meta?.title || '';
    const text = bead ? `${bead}${title ? ` · ${title}` : ''}` : 'A finished session';
    titleEl.textContent = text;
    document.title = `${bead || 'Session'} · Beadcause`;
  }

  /* ------------------------------------------------------------------- the facts */

  /**
   * What `meta.json` knows, which is everything measurable about the run.
   *
   * At the top rather than folded into the log section below, even though it is the log's
   * own metadata: it is the block that answers "which session am I looking at, and did it
   * work" — and on a bead worked three times that question comes before either the
   * memories or the log. The labels are short and the column is narrow for the reason
   * written beside `.session-facts` in the stylesheet, which this borrows wholesale.
   *
   * `commitsFrom` is stated rather than hidden, because one of its two values is a
   * heuristic and a reader three months on cannot tell which was used: `not-in-main` was
   * measured against main and is exact, `since-session-start` is what was left once the
   * work had already merged and the only remaining signal was time.
   */
  function factsHtml(session) {
    const meta = session.meta;
    if (!meta) {
      return `<p class="arc-none">No <code>meta.json</code> in this archive — the session was stored by
        something older than the metrics. What it wrote is still below.</p>`;
    }

    const ran = spanned(meta.startedAt, meta.endedAt);
    const how =
      meta.commitsFrom === 'not-in-main'
        ? 'exact — measured against main while the work was still on its branch'
        : meta.commitsFrom === 'since-session-start'
          ? 'a heuristic — it had already merged, so this is its branch since the session started'
          : meta.commitsFrom === 'no-branch'
            ? 'it never had a branch'
            : 'nothing to attribute';

    const facts = [
      ['outcome', `${meta.outcome || 'unrecorded'}${meta.exitCode == null ? '' : ` · exit ${meta.exitCode}`}`],
      ['ran', meta.startedAt ? `${clock(meta.startedAt)}${ran ? ` · ${ran}` : ''}` : 'not recorded'],
      ['ended', meta.endedAt ? `${clock(meta.endedAt)} · ${ago(meta.endedAt)}` : 'not recorded'],
      ['branch', meta.branch || 'none — it did not work on a branch'],
      [
        'commits',
        meta.commits?.length
          ? `${meta.commits.length} · ${meta.commits.map((c) => c.slice(0, 8)).join(' ')}`
          : 'none',
      ],
      ['from', how],
      // Eight characters is what identifies a session in Claude Code's own output, and
      // the rest of the uuid is no more useful here than it is on the live page.
      ['session', meta.sessionId ? meta.sessionId.slice(0, 8) : 'not recorded'],
      ...(bytes(meta.transcriptBytes) ? [['transcript', `${bytes(meta.transcriptBytes)} of raw jsonl`]] : []),
    ];

    return `<dl class="session-facts">${facts
      .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
      .join('')}</dl>`;
  }

  /* ----------------------------------------------------------------- the memories */

  /**
   * What the session learned — first, because it is why this page exists.
   *
   * Shown as the agent wrote it, not rendered as markdown. `memory.md` is a handful of
   * paragraphs written by something that will not be back to see them formatted, and
   * rendering it would mean loading a markdown parser and a sanitiser onto a page whose
   * whole job is to display four short files. Line breaks are the only structure it
   * needs, and `pre-wrap` keeps them.
   *
   * Absent is the common case and stays the common case: nothing writes one of these yet
   * (bc-nib3.4 is the write path). Which is exactly why the sentence has to be good — it
   * is the sentence almost everybody reading this page will see.
   */
  function memoryHtml(session) {
    if (!session.files.includes('memory.md')) {
      return `<p class="arc-none"><strong>Not available.</strong> This session left no memory —
        either it finished before there was a way to leave one, or it had nothing it thought
        was worth the next session's time.</p>`;
    }
    if (state.memoryError) {
      return `<p class="arc-none"><strong>Not available.</strong> The archive lists one, but reading it
        failed: ${esc(state.memoryError)}</p>`;
    }
    if (state.memory === null) return `<p class="arc-none">Reading it…</p>`;
    // An archived-but-empty file is its own thing and must not render as a blank box: a
    // box with nothing in it is the empty pane this page is not allowed to show.
    if (!state.memory.trim()) {
      return `<p class="arc-none"><strong>Not available.</strong> There is a <code>memory.md</code> in the
        archive and it is empty.</p>`;
    }
    return `<div class="arc-memory">${esc(state.memory)}</div>`;
  }

  /* ---------------------------------------------------------------------- the log */

  /**
   * `session.log` — a rendering of the transcript, not the transcript.
   *
   * Same `<pre class="agent-log">` the live pane uses, and deliberately: an archived log
   * and the pane on your phone come out of the same `renderEvent`, so the two must not
   * look like different things. It scrolls sideways rather than reflowing, because the
   * output was laid out by something counting characters at 80 columns.
   */
  function logHtml(session) {
    if (!session.files.includes('session.log')) {
      return `<p class="arc-none"><strong>Not available.</strong> Nothing was archived for this
        session — it produced no transcript, or the archive predates keeping one.</p>`;
    }
    if (state.logError) {
      return `<p class="arc-none"><strong>Not available.</strong> The archive lists one, but reading it
        failed: ${esc(state.logError)}</p>`;
    }
    const text =
      state.log === null
        ? 'Opening it…'
        : state.log.trim() || '(the archived log is empty — the session wrote nothing before it exited)';
    // The raw jsonl is archived too where `sessionTranscripts` is on for that repo, and it
    // is megabytes — so it is named rather than offered. A phone that fetched one would be
    // downloading tool-result payloads to render nothing this page can show, and not
    // saying it exists is the other kind of dishonesty.
    const raw = session.files.includes('transcript.jsonl')
      ? `<p class="arc-none">The raw transcript is archived beside it — too big for a phone, and
         readable with <code>git cat-file -p ${esc(session.commit.slice(0, 8))}:transcript.jsonl</code>.</p>`
      : '';
    return `<pre class="agent-log" data-arc-log>${esc(text)}</pre>${raw}`;
  }

  /* ----------------------------------------------------------------- the worktree */

  /**
   * Where the directory it worked in has got to — and the diff, if GitHub has one.
   *
   * Three states and no fourth: **live** and somebody may be sitting in it, **retired**
   * into `.claude/worktrees-retired/` where the sweep will remove it after two days, or
   * **gone**, which is the ordinary end of a worktree whose work has landed and is not a
   * fault. The daemon works all three out server-side, because the recorded path is a key
   * to look up rather than a place to read: retirement *moves* the directory.
   *
   * The pull request is the only thing here that costs a network call, so it arrives on a
   * second request after the page has drawn and patches this block alone. Until it does —
   * and forever, on an install with no `gh` — the section is still complete: where the
   * directory went is the question, and the diff is the bonus.
   */
  function worktreeHtml() {
    const wt = state.detail?.worktree;
    if (!wt) {
      return `<p class="arc-none"><strong>Not available.</strong> This session recorded no worktree —
        it ran in the main checkout, or exited before it entered one.</p>`;
    }

    const where = wt.isMain
      ? // Not a worktree at all: this session ran in the checkout itself, which the daemon
        // reports as live because the main checkout is a registered worktree like any
        // other. Saying "still live" about it would read as though a directory had been
        // kept for you.
        'It worked in the main checkout rather than a worktree of its own, so there is nothing to have been tidied away.'
      : wt.state === 'live'
        ? `Still live${wt.locked ? ', and locked — somebody is in it' : ''}.`
        : wt.state === 'retired'
          ? `Retired into the attic${wt.retiredAt ? ` ${ago(wt.retiredAt)}` : ''} — the sweep removes it
             two days after that, so it may already be gone by the time you look.`
          : 'Gone. Removed after its work landed, which is where a worktree is supposed to end up.';

    const rows = [
      ['state', wt.isMain ? `the main checkout · ${wt.name}` : `${wt.state} · ${wt.name}`],
      ['where', wt.at || wt.path],
      ...(wt.branch ? [['branch', wt.branch]] : []),
    ];

    const pr = wt.pr;
    const diff = pr
      ? `<a class="arc-link" href="${esc(pr.url)}" target="_blank" rel="noopener">Diff · #${esc(pr.number)} ${esc(
          pr.state
        )}${
          Number.isFinite(pr.changedFiles)
            ? ` · +${esc(pr.additions)} −${esc(pr.deletions)} in ${esc(pr.changedFiles)} file${pr.changedFiles === 1 ? '' : 's'}`
            : ''
        }</a>`
      : '';

    return `<p class="arc-where">${esc(where.replace(/\s+/g, ' '))}</p>
      <dl class="session-facts">${rows
        .map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`)
        .join('')}</dl>
      <div class="arc-links" data-arc-pr>${diff}</div>`;
  }

  /* ------------------------------------------------- the other sessions on this bead */

  /**
   * A bead worked more than once, which happens whenever the first attempt handed it back.
   *
   * Only drawn when there is a second one — a picker over a list of one is a control that
   * cannot do anything. Real links, so the drawer can own them and the back gesture works:
   * each is this same page addressed at a different commit on the same ref.
   */
  function sessionsHtml() {
    const list = state.detail?.sessions || [];
    if (list.length < 2) return '';
    const here = state.detail?.session?.commit;
    return `<div class="arc-links">${list
      .map((s) => {
        const href = `/bead-session?workspace=${encodeURIComponent(ws)}&id=${encodeURIComponent(
          bead
        )}&commit=${encodeURIComponent(s.commit)}`;
        // The archive commit's subject is `<workspace>/<bead> · <outcome> [· N commit(s)]`,
        // and the first part is the bead you are already reading about. Dropped rather
        // than shown twice — and guarded, because a subject in some other shape must not
        // leave a dangling separator on the pill.
        const rest = (s.subject || '').split(' · ').slice(1).join(' · ').trim();
        const label = [clock(s.at), rest].filter(Boolean).join(' · ');
        return s.commit === here
          ? `<span class="arc-link is-here">${esc(label || s.commit.slice(0, 8))}</span>`
          : `<a class="arc-link" href="${esc(href)}">${esc(label || s.commit.slice(0, 8))}</a>`;
      })
      .join('')}</div>`;
  }

  /* -------------------------------------------------------------------- rendering */

  function render() {
    if (state.stopped) {
      out.innerHTML = `<div class="empty"><strong>${esc(state.stopped.title)}</strong>${esc(
        state.stopped.detail
      )}</div>`;
      return;
    }
    const detail = state.detail;
    if (!detail) return; // the boot line is already on screen

    // A bead with no archive at all is not an error and must not read like one: most
    // beads in a tracker were never worked by a session, and every bead closed from the
    // phone is one of them. So it says so, in the place the page would have been.
    if (!detail.session) {
      out.innerHTML = `<div class="empty"><strong>No session was archived for ${esc(bead)}</strong>Nothing
        ran on it, or it was closed by hand. A session writes to
        <code>${esc(detail.ref || 'refs/beadcause/sessions/…')}</code> when it exits.</div>`;
      return;
    }

    out.innerHTML = `<div class="session-detail bead-session">
      ${factsHtml(detail.session)}
      ${sessionsHtml()}
      <div class="session-label">Memories <span>What it learned, in its own words.</span></div>
      <div data-arc-memory>${memoryHtml(detail.session)}</div>
      <div class="session-label">The log <span>Its transcript, as the terminal showed it.</span></div>
      <div data-arc-logblock>${logHtml(detail.session)}</div>
      <div class="session-label">Its worktree <span>Where the directory it worked in went.</span></div>
      <div data-arc-worktree>${worktreeHtml()}</div>
    </div>`;
  }

  /** Redraw one section, so a slow read cannot blank the rest of the page. */
  function repaint(sel, html) {
    const block = out.querySelector(sel);
    if (!block || !state.detail?.session) return render();
    block.innerHTML = html;
  }

  /* ---------------------------------------------------------------------- loading */

  async function api(path) {
    const res = await fetch(path, { headers: { 'x-beadcause-token': token } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  const archived = (commit, file) =>
    api(
      `/api/session-archive?workspace=${encodeURIComponent(ws)}&commit=${encodeURIComponent(
        commit
      )}&file=${encodeURIComponent(file)}`
    );

  /**
   * Load, once.
   *
   * No polling anywhere in here. Everything on this page happened in the past and the
   * files behind it are immutable — the archive commit is a git object, and a new session
   * on the same bead writes a *new* one rather than changing this. A poll would be a
   * request every two seconds for an answer that cannot change, which is exactly the cost
   * the live page pays deliberately and this one has no reason to.
   */
  async function load() {
    pulse.classList.add('busy');
    try {
      const detail = await api(
        `/api/bead-session?workspace=${encodeURIComponent(ws)}&id=${encodeURIComponent(bead)}${
          at ? `&commit=${encodeURIComponent(at)}` : ''
        }`
      );
      state.detail = detail;
      setTitle();
      render();
      window.beadcause?.presence?.report({
        view: 'session',
        workspace: ws,
        id: bead,
        detail: detail.session?.meta?.title || bead,
      });

      if (!detail.session) return;

      // Only for names the listing carried. A read fired at a file the archive does not
      // have would come back 404 and there is nothing useful to do with that: the page
      // already knows the answer and has already said it.
      const jobs = [];
      if (detail.session.files.includes('memory.md')) {
        jobs.push(
          archived(detail.session.commit, 'memory.md').then(
            (d) => {
              state.memory = d.text || '';
              repaint('[data-arc-memory]', memoryHtml(detail.session));
            },
            (err) => {
              state.memoryError = err.message;
              repaint('[data-arc-memory]', memoryHtml(detail.session));
            }
          )
        );
      }
      if (detail.session.files.includes('session.log')) {
        jobs.push(
          archived(detail.session.commit, 'session.log').then(
            (d) => {
              state.log = d.text || '';
              repaint('[data-arc-logblock]', logHtml(detail.session));
            },
            (err) => {
              state.logError = err.message;
              repaint('[data-arc-logblock]', logHtml(detail.session));
            }
          )
        );
      }

      // And the pull request, last and separately, because it is the one fact here that
      // leaves the machine. A failure is silence: the worktree section is already complete
      // without it, and "we could not reach GitHub" is not a thing this page is about.
      if (detail.worktree?.branch) {
        jobs.push(
          api(
            `/api/bead-session?workspace=${encodeURIComponent(ws)}&id=${encodeURIComponent(bead)}&commit=${encodeURIComponent(
              detail.session.commit
            )}&pr=1`
          ).then(
            (fresh) => {
              if (!fresh.worktree?.pr) return;
              state.detail = { ...state.detail, worktree: fresh.worktree };
              repaint('[data-arc-worktree]', worktreeHtml());
            },
            () => {}
          )
        );
      }

      await Promise.all(jobs);
    } catch (err) {
      if (!state.detail) state.stopped = { title: "Can't read that bead's sessions", detail: err.message };
      render();
    } finally {
      pulse.classList.remove('busy');
    }
  }

  // Opened on its own, the ✕ means the tab. In a drawer it never gets here — drawer.js
  // takes the click first, and `data-drawer-close` is what tells it to.
  document.getElementById('arc-close').addEventListener('click', () => window.beadcause.closeView());

  setTitle();

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else if (!bead || !ws) {
    out.innerHTML = `<div class="empty"><strong>No bead named</strong>A finished session is addressed by
      its workspace and its bead — a pid stops identifying anything once the process has gone.</div>`;
  } else {
    load();
  }
})();
