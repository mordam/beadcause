/*
  One pull request, drawn once, for the two screens that draw them.

  ## Why this file exists

  A pull request was rendered twice in this app. `public/prs.js` drew the board's rows —
  the number, the title, the beads, the diffstat, the check rollup and the lamps — and
  `public/app.js` drew a merge card in the inbox from the same facts under different
  class names. Two renderers of one object is the duplication the UX review's §6 step 5
  names for proposals, and it has the same failure: a fact added to one screen is a fact
  missing from the other, and nobody notices until the two disagree in front of you.

  bc-l8jp.6 took the PRs tab off the bottom bar and made pull requests **inbox cards**,
  which would have been the *third* place. So the row moved here first: `bodyHtml` is the
  whole inside of a pull request row, and both screens wrap it in their own shell — a
  `<button>` that folds, on the board; an `<article class="card">` in the inbox. What
  differs between the two is the wrapper and the actions, which is exactly what should
  differ, because a board row unfolds into buttons and an inbox card is one item in a
  stack of cards.

  ## The ladder, and why the words are here twice

  `STAGES` is the mirror of `lib/prstage.js` — the same six ids, the same labels, the
  same notes. A browser cannot import a lib module, and the alternative (shipping the
  table down on every board payload) would mean the inbox's filter chips could not be
  drawn until a `gh` sweep had answered. So it is stated twice and asserted once:
  `test/prstage.mjs` reads both files and fails if the ids or the labels drift. The same
  arrangement `LIVE` in prs.js has with `lib/deploy.js`, for the same reason.

  **The derivation is not here.** Nothing in this file decides what stage a pull request
  is on; it reads `p.stage`, which the daemon computed in one place. A client that
  re-derived it from the flags would be the second implementation all over again, one
  network hop further away from the facts.

  ## The four lamps

  Merged · Pushed · Deployed · Live, and each has three states — on, off, and *unknown*,
  drawn as a hollow ring, because "this Mac has never fetched that commit" and "this repo
  has no deploy beadcause can watch" are not `no`. The board had three of these; `Deployed`
  used to mean the running build and now means *a deploy ran that carried it*, with `Live`
  taking over the stronger claim. That split is the fourth and fifth rungs of the ladder
  and the reason both exist: only beadcause can say `live` about beadcause, and a
  `fly deploy` of another repo can only ever be `deployed`. See lib/prstage.js.
*/
(() => {
  'use strict';

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

  /* ------------------------------------------------------------------- the ladder */

  /** The mirror of `STAGES` in lib/prstage.js. Asserted against it by test/prstage.mjs. */
  const STAGES = [
    { id: 'review', label: 'Review', note: 'Open on GitHub, waiting on a decision.' },
    { id: 'merged', label: 'Merged', note: 'Merged at GitHub. This Mac has not seen the merge commit on origin.' },
    { id: 'pushed', label: 'Pushed', note: 'On origin, and no deploy has carried it yet.' },
    {
      id: 'deployed',
      label: 'Deployed',
      note: 'A deploy ran that carried it. Whether what came up is what went out is not visible from here.',
    },
    {
      id: 'live',
      label: 'Live',
      note: 'In the build this daemon is running — the strongest answer there is, and only beadcause can give it about itself.',
    },
    { id: 'closed', label: 'Closed', note: 'Closed without merging. Not a rung on the way anywhere.' },
  ];

  const BY_ID = new Map(STAGES.map((s) => [s.id, s]));

  const stageInfo = (id) => BY_ID.get(String(id || '')) || null;

  /**
   * The rung, as a word you can read while scrolling.
   *
   * Beside the lamps rather than instead of them: the lamps are the evidence and this is
   * the conclusion, and it is the conclusion that the inbox's status sub-filter names —
   * a chip called `Pushed` over rows that never say the word would be a control you have
   * to decode. The note rides along as the title, because five of the six words mean
   * something more specific than they look.
   */
  function stageHtml(p) {
    const s = stageInfo(p?.stage);
    if (!s) return '';
    return `<span class="pill pr-stage st-${esc(s.id)}" title="${esc(s.note)}">${esc(s.label)}</span>`;
  }

  /* -------------------------------------------------------------------- the lamps */

  /**
   * One lamp. `null` is a state and it is drawn as one.
   *
   * The title is where the "why" goes: a hollow Live on a repo beadcause does not run is
   * not a warning, and the only thing that can say so is the thing you long-press or
   * hover. It costs nothing and it is the difference between an honest gap and a mystery.
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
        p.merged ? p.shipped ?? null : false,
        p.shipped === true
          ? 'a deploy has run that carried this merge'
          : p.shipped === false
            ? 'no deploy has run since it merged'
            : 'nothing here can say whether a deploy carried it'
      )}
      ${lamp(
        'Live',
        p.merged ? p.deployed : false,
        p.deployTracked ? 'in the build this daemon is running' : 'no deploy this daemon can see for this repo'
      )}
    </span>`;
  }

  /* -------------------------------------------------------------------- the facts */

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
      <span class="diffstat"><ins>+${esc(p.additions)}</ins> <del>−${esc(p.deletions)}</del></span>
      ${p.files ? `<span>${plural(p.files, 'file')}</span>` : ''}
      ${checks}
    </span>`;
  }

  /** The beads this pull request is for, as links into the graph. */
  function beadsHtml(p) {
    const beads = (p.beads || [])
      .map((b) => `<a class="pill id" href="${esc(graphUrl(p.workspace, b.id))}">${esc(b.id)}</a>`)
      .join('');
    return beads || '<span class="board-nobead">no bead named</span>';
  }

  /* --------------------------------------------------------------------- the row */

  /**
   * The inside of a pull request row: what it is, what it is for, and where it got to.
   *
   * `title` is a link when the caller has nowhere else to put one — the inbox card,
   * where the row is not a button — and plain text when it is inside one, because an
   * `<a>` inside a `<button>` is a nested interactive element and a phone will pick
   * whichever it likes.
   *
   * `repo` names the workspace, which the board does not need (its cards are one repo
   * each) and the inbox does: a flat list of pull requests from six repos with no repo on
   * the row is six repos of numbers.
   */
  function bodyHtml(p, { titleHref = '', repo = false } = {}) {
    const title = `<span class="board-num">#${esc(p.number)}</span> ${esc(p.title)}${
      p.draft ? ' <span class="pill">draft</span>' : ''
    }`;
    return `<span class="work-main">
      <span class="work-title">${
        titleHref ? `<a class="pr-title-link" href="${esc(titleHref)}" target="_blank" rel="noopener">${title}</a>` : title
      }</span>
      <span class="work-sub">${repo ? `<span class="pill">${esc(p.workspace)}</span>` : ''}${stageHtml(p)}${beadsHtml(
        p
      )} ${factsHtml(p)}</span>
      ${lampsHtml(p)}
    </span>
    <time>${esc(age(p.updatedAt))}</time>`;
  }

  window.beadcause = window.beadcause || {};
  window.beadcause.prCard = {
    STAGES,
    stageInfo,
    /** Every rung, in ladder order — what the inbox's status chips are drawn from. */
    stageIds: () => STAGES.map((s) => s.id),
    esc,
    plural,
    age,
    ago,
    graphUrl,
    stageHtml,
    lampsHtml,
    factsHtml,
    beadsHtml,
    bodyHtml,
  };
})();
