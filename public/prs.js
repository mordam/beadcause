/* The pull requests, and how far each one has actually got.
 *
 * The inbox asks *may I merge this?* and the card is gone the moment you answer. This
 * is the screen for everything after that, which had nowhere to be asked from a phone:
 * it merged — did it reach origin, and is it running?
 *
 * Three things about the shape of the page.
 *
 * **The lamps are the page.** Merged · Pushed · Deployed, on every row, always
 * visible — not behind the fold, because "which of these has not shipped" is a
 * question you answer by scanning, and a fold would make it a question you answer by
 * tapping twelve times. They are three lamps rather than one word because they go
 * true at three different times and the gap between them is the whole subject.
 *
 * **A lamp has three states, not two.** On, off, and *unknown* — a hollow ring. This
 * Mac has never fetched that commit; this repo has no deploy the daemon can see. An
 * unknown drawn as "off" would say work was not pushed when the truth is that nobody
 * has looked, and that is the one way this screen could actually mislead you.
 *
 * **Merge is armed; ship and comment are not.** Merging is irreversible and lands on
 * origin the instant it is pressed, so it takes two taps with the consequence written
 * into the button between them — the same arming pattern as the destructive control on
 * /admin, and for the same reason: a `confirm()` on a phone is a sheet you dismiss by
 * reflex. Shipping opens a window on the Mac, which you can watch and stop; commenting
 * writes a sentence on GitHub. Neither of those needs a guard.
 */
(() => {
  'use strict';

  const token = localStorage.getItem('beadcause.token') || '';
  const out = document.getElementById('prs');
  const pulse = document.getElementById('pulse');
  const observing = document.getElementById('observing');

  /* A `gh` call per repo behind this, so slower than the inbox on purpose. The board
     is cached for 25s on the daemon anyway; anything faster would only re-render. */
  const REFRESH_MS = 60000;

  const state = {
    data: null,
    /** Which repo card is unfolded. At most one — that is what makes it an accordion. */
    card: null,
    /** Which PR's actions are open, as `workspace#number`. */
    row: null,
    /** The armed merge button's row key, if any. Cleared by every repaint. */
    armed: null,
    /** What you have typed at a PR, kept out here so a repaint doesn't lose it. */
    draft: '',
    /** The outcome of the last action, pinned under the row it acted on. */
    said: null,
    busy: false,
    first: true,
  };

  const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /** How long ago, in the two characters a phone has room for. */
  function age(iso) {
    if (!iso) return '';
    const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24) return `${hrs}h`;
    return `${Math.round(hrs / 24)}d`;
  }

  /** "just now" already reads as a phrase; everything else wants the "ago". */
  const ago = (iso) => {
    const a = age(iso);
    return !a || a === 'just now' ? a : `${a} ago`;
  };

  const graphUrl = (ws, id) => `/graph?ws=${encodeURIComponent(ws)}&id=${encodeURIComponent(id)}`;

  /* ------------------------------------------------------------------- the lamps */

  /**
   * One lamp. `null` is a state and it is drawn as one.
   *
   * The title is where the "why" goes: a hollow Deployed on a repo beadcause does not
   * run is not a warning, and the only thing that can say so is the thing you long-press
   * or hover. It costs nothing and it is the difference between an honest gap and a
   * mystery.
   */
  const lamp = (label, value, why) => {
    const cls = value === true ? 'on' : value === false ? 'off' : 'unknown';
    const said = value === true ? 'yes' : value === false ? 'no' : 'not known';
    // No whitespace between the label and the state — the two are one phrase to a
    // reader ("Merged: yes"), and a newline in the template becomes a space in it.
    return `<span class="lamp ${cls}"${why ? ` title="${esc(why)}"` : ''}><span class="lamp-dot" aria-hidden="true"></span>${esc(
      label
    )}<span class="sr-only">: ${said}</span></span>`;
  };

  function lampsHtml(p) {
    return `<span class="board-lamps">
      ${lamp('Merged', p.merged, p.merged ? `merged ${age(p.mergedAt)} ago` : 'not merged yet')}
      ${lamp('Pushed', p.merged ? p.pushed : false, p.pushed === null ? `this Mac has not fetched that commit` : `on origin/${p.base}`)}
      ${lamp(
        'Deployed',
        p.merged ? p.deployed : false,
        p.deployTracked ? 'in the build this daemon is running' : 'no deploy this daemon can see for this repo'
      )}
    </span>`;
  }

  /* -------------------------------------------------------------------- one row */

  /** The diffstat and the checks — the two numbers that decide an open PR. */
  function factsHtml(p) {
    const checks =
      p.checks?.state && p.checks.state !== 'none'
        ? `<span class="board-checks ${esc(p.checks.state)}">${
            p.checks.state === 'passing'
              ? `✓ ${p.checks.passing}`
              : p.checks.state === 'pending'
                ? `◌ ${p.checks.pending}`
                : `✗ ${p.checks.failing}`
          }</span>`
        : '';
    return `<span class="board-facts">
      <span class="diffstat"><ins>+${p.additions}</ins> <del>−${p.deletions}</del></span>
      ${p.files ? `<span>${plural(p.files, 'file')}</span>` : ''}
      ${checks}
    </span>`;
  }

  /**
   * What you can do to it, and the note saying why you might want to.
   *
   * Which buttons exist is decided by the *stage*, not by hiding disabled ones: a
   * greyed-out Ship on an unmerged PR is a control you have to think about, where its
   * absence is a fact you read in passing.
   */
  function actionsHtml(p) {
    const armed = state.armed === p.key;
    const buttons = [];

    if (p.state === 'OPEN') {
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
      buttons.push(
        `<button class="board-btn ship" data-act="ship" data-key="${esc(p.key)}">${
          p.deployed === true ? 'Ship again' : 'Ship'
        }</button>`
      );
    }
    buttons.push(`<button class="board-btn" data-act="comment" data-key="${esc(p.key)}">Comment</button>`);
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
      <div class="board-say">
        <textarea data-say="${esc(p.key)}" rows="2" placeholder="Say something on #${esc(p.number)}…">${esc(
          state.draft
        )}</textarea>
        <button class="board-btn send" data-act="send" data-key="${esc(p.key)}">Send to GitHub</button>
      </div>
      ${said}
    </div>`;
  }

  function prRow(p) {
    const open = state.row === p.key;
    const beads = (p.beads || [])
      .map((b) => `<a class="pill id" href="${esc(graphUrl(p.workspace, b.id))}">${esc(b.id)}</a>`)
      .join('');
    return `<div class="board-pr" data-stage="${esc(p.stage)}">
      <button class="work-row board-row" type="button" data-pr="${esc(p.key)}" aria-expanded="${open}">
        <span class="work-main">
          <span class="work-title"><span class="board-num">#${esc(p.number)}</span> ${esc(p.title)}${
            p.draft ? ' <span class="pill">draft</span>' : ''
          }</span>
          <span class="work-sub">${beads || '<span class="board-nobead">no bead named</span>'} ${factsHtml(p)}</span>
          ${lampsHtml(p)}
        </span>
        <time>${esc(age(p.updatedAt))}</time>
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

  function repoHtml(c) {
    const open = c.prs.filter((p) => p.stage === 'open').length;
    const owed = c.prs.filter((p) => p.stage === 'merged' || (p.stage === 'pushed' && p.deployTracked)).length;
    const summary = [open ? `${open} open` : '', owed ? `${owed} to ship` : '', c.error ? 'error' : '']
      .filter(Boolean)
      .join(' · ');

    const body = c.error
      ? `<p class="subtitle bad">⚠ ${esc(c.error)}</p>`
      : c.note
        ? `<p class="subtitle">${esc(c.note)}</p>`
        : c.prs.length
          ? c.prs.map(prRow).join('') +
            (c.deployTracked
              ? ''
              : `<p class="board-foot">Deploy state is not tracked for this repo — beadcause only knows what it is running itself.</p>`)
          : '<p class="subtitle">No pull requests here.</p>';

    const title = c.repo || c.workspace;
    return cardHtml(c.workspace, title, summary || (c.prs.length ? 'all shipped' : 'none'), Boolean(open || owed), body);
  }

  /* -------------------------------------------------------------------- render */

  function render() {
    if (!state.data) return;
    const scrollY = window.scrollY;
    const d = state.data;

    if (d.unavailable) {
      out.innerHTML = `<div class="empty"><strong>No pull requests to show</strong>${esc(d.unavailable)}</div>`;
      return;
    }

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
    const repos = d.repos || [];
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
    out.innerHTML = cards || rest ? cards + rest + build : '<div class="empty">No workspaces configured.</div>';

    // The badge is what makes the tab worth glancing at from another view: open
    // decisions plus merged work that is not running. Set from here rather than from
    // the inbox's poll, because this is the only page that fetches the board.
    const c = d.counts || {};
    const n = (c.open || 0) + (c.owed || 0);
    window.beadcause?.tabBadge?.('prs', n, n ? `${plural(c.open || 0, 'open pull request')}, ${c.owed || 0} to ship` : '');

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
  async function act(key, action) {
    const p = rowFor(key);
    if (!p || state.busy) return;

    if (action === 'merge' && state.armed !== key) {
      // First press arms it. Nothing is sent, and the button now says what it will do.
      state.armed = key;
      return render();
    }

    const text = String(state.draft || '').trim();
    if (action === 'send' && !text) return;

    state.busy = true;
    state.armed = null;
    state.said = { key, text: action === 'ship' ? 'Opening a window on the Mac…' : 'Working…', bad: false };
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
        state.said = {
          key,
          text: `${data.alreadyMerged ? `#${p.number} was already merged` : `Merged #${p.number}`} — ${
            data.land?.note || 'nothing else to do here'
          }.`,
          bad: false,
        };
      } else if (action === 'ship') {
        state.said = { key, text: `A session is opening in ${data.dir || 'the repo'} to deploy it.`, bad: false };
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
    pulse.classList.add('busy');
    try {
      const res = await fetch(`/api/prs${refresh ? '?refresh=1' : ''}`, { headers: { 'x-beadcause-token': token } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      state.data = await res.json();
      observing.hidden = !state.data.observing;
      if (state.first) {
        state.first = false;
        // Unfold the repo with something to act on — arriving at a closed heading
        // would make the fold cost a tap on every visit for no reason.
        state.card = (state.data.repos || []).find((r) => r.prs.length)?.workspace || null;
      }
      render();
    } catch (err) {
      out.innerHTML = `<div class="empty"><strong>Can't reach the server</strong>${esc(err.message)}</div>`;
    } finally {
      pulse.classList.remove('busy');
    }
  }

  window.beadcause?.presence?.report({ view: 'prs' });

  document.getElementById('prs-refresh').addEventListener('click', () => load({ refresh: true }));
  setInterval(() => {
    // Not while you are mid-sentence or holding an armed merge: a repaint would throw
    // the first away and disarm the second under your thumb.
    if (!state.busy && !state.armed && !state.draft) load();
  }, REFRESH_MS);

  if (!token) {
    out.innerHTML = '<div class="empty"><strong>This device is not paired</strong>Open the inbox first.</div>';
  } else {
    load();
  }
})();
