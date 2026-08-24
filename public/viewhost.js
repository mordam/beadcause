/*
  Repo views — the host, and the SDK a repo's own view is handed.

  ## What this file is

  Everything else in `public/` draws a screen this app decided to have. This one draws no
  screen at all: it asks `/api/views` which screens the *repos* have decided to have,
  builds each of them an address, a pill and a pane, loads the script the repo wrote, and
  hands that script an object with everything it would otherwise have to reinvent.

  The whole feature is one sentence long from a repo's side — declare
  `.beadcause/views.json`, write a script — and the reason it can be that short is that
  the shell already has all the hard parts. A repo view gets, for free and by construction:

  * an address (`/v/<ws>/<id>`) that a phone's home screen can hold, and a hash
    (`#<ws>.<id>`) the back button walks like every other view;
  * a pane, which means its scroll position survives a switch away and back, and it is
    never rebuilt (public/panes.js);
  * a pill on the one row of chrome this app has (public/viewbar.js);
  * the app's own stylesheet, so a `.card` is a card and a `.pill` is a pill without a
    line of CSS;
  * the one long poll the whole document shares, fanned out per pane rather than one
    socket per view (public/panestage.js);
  * a bead id that is *tappable* — it opens the real card, with the real thread and the
    real answer box, because it is the same hash a notification carries.

  That last one is the argument for hosting a repo's view here at all rather than letting
  it be a static page somewhere. A board full of bead ids that are text is a board you read
  and then go and do something about. A board whose ids open the card is the thing itself.

  ## Why the repo ships code and not a description of a screen

  The first shape this was designed in was a block vocabulary: the repo emits JSON — stat
  rows, tables, lists — and this file renders it. It is safer and it looks native by
  construction, and it was rejected, because the first real use case killed it. deluvia's
  board has a five-rung gate ladder, three production lines each running through a subset
  of those rungs, a nineteen-agent department roster and a production ledger grouped by
  day. Not one of those is a table. Either the vocabulary grows deluvia-shaped — at which
  point it is not a vocabulary, it is deluvia's board with extra steps — or the board loses
  the shapes that make it worth reading.

  So the repo ships code. What this file provides is not a renderer but a *host*: the SDK
  below is the shell's own capabilities, made reachable, and the drawing is the repo's.

  ## The trust position, said out loud

  A repo view's script runs on this app's origin with this app's DOM. It is not sandboxed
  and it is not going to be. The manifest lives in a checkout this daemon already runs
  test suites, deploy scripts and unattended Claude Code sessions inside (see the
  trust-boundary note in lib/repoviews.js) — a repo that can make this machine run its
  tests can already make it run anything, and an iframe here would buy a real cost in
  theme, in card-opening and in offline behaviour to prevent nothing.

  What *is* enforced is which files: the manifest is an allowlist, and the server resolves
  every path through `realpath` against the repo's `.beadcause/` prefix. That is a check
  about reach, not about intent, and it is the honest one to make.

  ## What a badly-behaved view can and cannot take down

  Contained at three points, and each is a different failure:

  * a script that **fails to load** — a 404, a syntax error — leaves its pill drawn and its
    pane holding the reason. Not removed: a pill that vanishes is indistinguishable from a
    repo that never had a view, and the one thing worth knowing is that it is broken.
  * a `build` that **throws** takes its own pane and nothing else, because
    public/panestage.js already contains a builder that throws and rethrows it out of a
    timer so public/report.js files it as the P0 it is.
  * a **generator** that fails does not blank the board. The server hands back the last
    good payload with `stale: true` and the reason (see `payloadFor`), and the chrome draws
    that reason above a board that is merely old. A board with a timestamp on it is worth
    a great deal more than an empty pane with an error in it.

  ## What is deliberately not here

  **No polling of its own.** A view's payload is fetched when its pane is built and again
  on ⟳, and a view that wants more rides the document's one poll through `wake`. A timer
  per view is exactly the bill public/panestage.js's header refuses.

  **No caching in the page.** The daemon holds the payload for the manifest's `ttl` and
  shares one generator between concurrent callers; a second cache here would be a second
  answer to "how old is this board" and the two would disagree the first time ⟳ was
  pressed.

  **No layout.** The chrome below is a header and a scroller and that is the whole of it.
  Where the cards go is the view's business, which is the point.
*/
(() => {
  'use strict';

  const bc = (window.beadcause = window.beadcause || {});
  const route = bc.route;
  const panes = bc.panes;

  /*
    The shell and nothing else. This file is in the service worker's precache and so is
    loaded on the one page that has panes; on the eleven pages that are still documents
    there is nothing to adopt a pane into, and a pill for a view they cannot show would be
    a pill that navigates to `/v/…` and hops straight back. Cheaper to say no here.
  */
  if (!route || !panes || !document.querySelector('.pane')) return;

  const esc = (s) =>
    String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const token = () => {
    try {
      return localStorage.getItem('beadcause.token') || '';
    } catch {
      return '';
    }
  };

  /**
   * The authenticated fetch every view gets, and the one this file uses.
   *
   * Small on purpose, like public/panestage.js's: it does not handle a refused credential,
   * because the inbox is the screen that owns that conversation and a pane throwing up a
   * second sign-in prompt behind it would be two answers to one question.
   */
  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { 'x-beadcause-token': token(), ...(opts.headers || {}) },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  /** "4 minutes ago", from a count of seconds. The chrome's one piece of prose. */
  function ago(seconds) {
    const n = Number(seconds);
    if (!Number.isFinite(n)) return '';
    if (n < 45) return 'just now';
    if (n < 5400) return `${Math.round(n / 60)} min ago`;
    if (n < 172800) return `${Math.round(n / 3600)} h ago`;
    return `${Math.round(n / 86400)} days ago`;
  }

  /** Every view being hosted, by full id, from the moment its pane exists. */
  const hosted = new Map();

  /* -------------------------------------------------------------- the pane chrome */

  /**
   * The container, the header and the scroller — the three things every pane of this app
   * has, so that a repo view is a pane of this app rather than something embedded in one.
   *
   * `.work.pagescroll` is the same pair every other pane's body carries, and it is what
   * public/panes.js reads to save and restore a scroll position. Marked in the markup
   * rather than inferred, exactly as that file's header says, and the view draws *inside*
   * it — a view that made its own scroller would get a pane whose scroll position was
   * never carried.
   */
  function makePane(v) {
    const el = document.createElement('div');
    el.className = 'pane';
    el.dataset.pane = v.view;
    el.dataset.repoView = v.workspace;
    el.hidden = true;
    el.innerHTML =
      `<main class="work pagescroll">` +
      `<div class="viewhost-head">` +
      `<span class="viewhost-title">${esc(v.label)}</span>` +
      `<span class="viewhost-age" data-age></span>` +
      `<button type="button" class="viewhost-refresh" data-refresh title="Read it again">⟳</button>` +
      `</div>` +
      `<p class="viewhost-note" data-note hidden></p>` +
      `<div class="viewhost-body" data-body></div>` +
      `</main>`;
    return el;
  }

  /* --------------------------------------------------------------------- the SDK */

  /**
   * What a repo's script is handed.
   *
   * One object, built once per view and passed to `build` and to every `wake`, so a view
   * can keep it rather than reaching for globals. Everything on it is either something the
   * shell already knows and the view would otherwise have to duplicate, or something the
   * view cannot get at all from where it stands.
   */
  function makeContext(v, el) {
    const body = el.querySelector('[data-body]');
    const noteEl = el.querySelector('[data-note]');
    const ageEl = el.querySelector('[data-age]');
    const listeners = [];

    const ctx = {
      /** The full view id, `<workspace>.<id>` — what the hash and the pane are named. */
      view: v.view,
      /** Which workspace declared it. Pre-bound into `bead` below, and rarely needed raw. */
      workspace: v.workspace,
      /** The pane itself, for a view that wants the header or the whole column. */
      pane: el,
      /** Where the view draws. Inside the scroller, under the chrome. */
      el: body,

      /** The last payload the generator produced, or `null` for a view with no generator. */
      data: null,
      /** `{ at, age, stale, problem }` about that payload — how old it is, and what failed. */
      meta: {},

      /**
       * The daemon, with the credential on it.
       *
       * A view is not limited to its own generator: `/api/questions`, `/api/work`,
       * `/api/bead` and everything else are there, and a view that wants the live bead
       * list should ask for it rather than shelling out to `bd` a second time.
       */
      api,

      /** The URL of another file this view declared. For an image, a font, a second sheet. */
      asset: (rel) => `/v/${encodeURIComponent(v.workspace)}/${encodeURIComponent(v.id)}/asset/${String(rel)}`,

      /** HTML-escape. Every view needs it and every view would otherwise write it again. */
      esc,

      /**
       * Markdown, sanitised — the app's own two vendored libraries.
       *
       * Answers the raw text escaped when they are not loaded, which is the case on a page
       * cached before they were, rather than throwing: a board with a paragraph of literal
       * asterisks in it still reads.
       */
      md(text) {
        const src = String(text == null ? '' : text);
        if (!window.marked?.parse || !window.DOMPurify?.sanitize) return esc(src);
        return window.DOMPurify.sanitize(window.marked.parse(src, { breaks: true, gfm: true }));
      },

      /**
       * Beads, as things you can tap.
       *
       * The single most valuable thing this host provides, and the reason a repo view is
       * worth more here than as a page somewhere. `href` is `hashForCard`'s own spelling —
       * the exact form every notification this daemon has ever sent carries — so a link
       * built here and a link tapped in a notification shade land in the same place, and
       * `open` is that hash written to the URL. Home takes it from there (`focusHash` in
       * public/app.js): switch to the inbox, find the card, expand it, scroll to it.
       *
       * The workspace is pre-bound, because a repo view is about one workspace by
       * construction and making every call site restate it is how one of them gets it
       * wrong. `link` is the anchor, ready to drop into a template string, because that is
       * what a board is made of.
       */
      bead: {
        href: (id) => `#${encodeURIComponent(`${v.workspace}/${String(id)}`)}`,
        open(id) {
          location.hash = `#${encodeURIComponent(`${v.workspace}/${String(id)}`)}`;
        },
        link(id, text) {
          const key = `${v.workspace}/${String(id)}`;
          return `<a class="beadlink" href="#${encodeURIComponent(key)}">${esc(text == null ? id : text)}</a>`;
        },
      },

      /** The space picker's current selection, and a hook for when it moves. */
      space: {
        get filter() {
          return bc.space?.filter || null;
        },
        label: () => bc.space?.label?.() || '',
        onChange: (fn) => bc.space?.onChange?.(fn),
      },

      /**
       * A line above the board, for something the view wants to say about itself.
       *
       * Shared with the chrome's own use of it — a stale payload writes here — and last
       * writer wins, deliberately: both are "what is wrong with what you are looking at",
       * and two stacked lines saying it is the shape that gets ignored.
       */
      note(text, kind) {
        if (!noteEl) return;
        noteEl.hidden = !text;
        noteEl.textContent = String(text || '');
        noteEl.dataset.kind = String(kind || '');
      },

      /** Run the generator again and redraw. What ⟳ does; a view may ask for it too. */
      refresh: () => pull(v, { refresh: true }),

      /** Called whenever a new payload lands, including the first. */
      onData(fn) {
        if (typeof fn === 'function') listeners.push(fn);
      },

      /** Internal: the chrome's own handle on the listeners. Not part of the contract. */
      _emit() {
        if (ageEl) {
          ageEl.textContent = ctx.meta.at ? ago(ctx.meta.age) : '';
          ageEl.dataset.stale = ctx.meta.stale ? '1' : '';
        }
        for (const fn of listeners) {
          try {
            fn(ctx.data, ctx.meta);
          } catch (err) {
            console.error(`[view] ${v.view} threw on new data`, err);
          }
        }
      },
    };
    return ctx;
  }

  /* ------------------------------------------------------------------- the payload */

  /**
   * Fetch one view's payload and hand it to the view.
   *
   * A refusal is drawn rather than thrown. The one case worth spelling out is the 502 with
   * nothing held: the generator has never succeeded, so there is no board to show and the
   * pane says why in the place a board would be. Every other failure — a generator that
   * broke after working, a daemon restarting mid-fetch — leaves the last board on screen
   * with a line above it, which is the whole reason `payloadFor` hands back what it holds.
   */
  async function pull(v, { refresh = false } = {}) {
    const host = hosted.get(v.view);
    if (!host?.ctx || !v.dataUrl) return;
    const { ctx } = host;
    try {
      const out = await api(`${v.dataUrl}${refresh ? '?refresh=1' : ''}`);
      ctx.data = out.data;
      ctx.meta = { at: out.at, age: out.age, stale: Boolean(out.stale), problem: out.problem || '' };
      ctx.note(out.problem ? `could not read it again — ${out.problem}` : '', 'warn');
      ctx._emit();
    } catch (err) {
      ctx.meta = { ...ctx.meta, problem: err.message };
      ctx.note(
        ctx.data ? `could not read it again — ${err.message}` : `this view has never built — ${err.message}`,
        'stop'
      );
      ctx._emit();
    }
  }

  /* -------------------------------------------------------------------- the loader */

  /**
   * `define` — what a repo's script calls, and the whole of the contract from its side.
   *
   *     window.beadcause.view.define({
   *       build(ctx) { ctx.el.innerHTML = draw(ctx.data); },
   *       wake(ctx)  { ctx.refresh(); },     // optional
   *       want: 'presence',                  // optional
   *     });
   *
   * The id comes from `document.currentScript`, which this file stamped when it injected
   * the tag — so the ordinary case is one argument and a script cannot get its own name
   * wrong. `define(id, spec)` is there for a script that defers past its own execution,
   * where `currentScript` is null by the time it calls.
   *
   * `build` is called once, when the first payload has landed (or failed to). Not before:
   * a view whose `build` had to cope with `ctx.data === null` would make every view author
   * write the same empty state, and the chrome above already draws the waiting and the
   * failure. A view with no generator is built at once, because there is nothing to wait
   * for.
   */
  function define(a, b) {
    const script = document.currentScript;
    const id = typeof a === 'string' ? a : script?.dataset?.view || '';
    const spec = typeof a === 'string' ? b : a;
    const host = hosted.get(id);
    if (!host) {
      console.error(`[view] define() for "${id || '(unnamed)'}", which is not a view being hosted`);
      return false;
    }
    if (typeof spec?.build !== 'function') {
      console.error(`[view] ${id} defined no build()`);
      return false;
    }
    host.spec = spec;
    host.ready();
    return true;
  }

  /**
   * Put one view up: grammar, pane, pill, stylesheet, script.
   *
   * The order is forced and each step is why the next one can happen. `route.add` first,
   * because `panes.adopt` refuses an id the grammar does not know — which is what stops a
   * container existing under a name no hash could produce. The pill after the pane, so the
   * moment it is drawn it is already a `<button>` that switches rather than an `<a>` that
   * reloads. The script last, because by then there is somewhere for it to draw.
   */
  function host(v) {
    if (!route.add({ id: v.view, paths: [v.path] })) return;

    const el = makePane(v);
    // After the last pane in the document, so the repo views are a run at the end of the
    // column in the same order they are a run at the end of the pill row.
    const last = [...document.querySelectorAll('.pane')].pop();
    (last?.parentNode || document.body).insertBefore(el, last ? last.nextSibling : null);
    if (!panes.adopt(v.view, el)) {
      el.remove();
      return;
    }

    const ctx = makeContext(v, el);
    const entry = { v, el, ctx, spec: null, built: false };
    hosted.set(v.view, entry);

    /*
      Build the view, once, when both halves have arrived — the script has defined itself
      and the first payload is in. Either may land first: a cached script executes before
      the fetch answers, and a generator this daemon is already holding answers before a
      cold script has been parsed. So both call this and the first one to find the other
      done is the one that builds.
    */
    entry.ready = () => {
      if (entry.built || !entry.spec) return;
      if (v.dataUrl && !ctx.meta.at && !ctx.meta.problem) return;
      entry.built = true;
      try {
        entry.spec.build(ctx);
      } catch (err) {
        ctx.note(`this view failed to draw — ${err.message}`, 'stop');
        // Out of a timer, so public/report.js files it as the P0 it is without taking
        // this loop — and the other repo views behind it — down. The same shape
        // public/panestage.js uses, and for the same reason.
        setTimeout(() => {
          throw err;
        }, 0);
      }
    };
    ctx.onData(() => entry.ready());

    bc.views?.add?.({ id: v.view, icon: v.icon, label: v.label, href: v.path });

    el.querySelector('[data-refresh]')?.addEventListener('click', () => ctx.refresh());

    /*
      Ride the document's one poll. `want` defaults to presence — the cheap park that costs
      the daemon no `bd` sweep — because a view that has not said it needs the inbox must
      not widen the request the whole page shares. See public/panestage.js.

      A view with no `wake` is registered anyway: `register` is also what makes the stager
      call `build`, and the fan-out skips a pane with nothing to call.
    */
    bc.stage?.register?.(v.view, {
      build: () => {},
      want: v.want === 'questions' ? 'questions' : undefined,
      wake: (w) => entry.spec?.wake?.(ctx, w),
    });

    if (v.styleUrl) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = v.styleUrl;
      document.head.appendChild(link);
    }

    const script = document.createElement('script');
    script.src = v.scriptUrl;
    script.dataset.view = v.view;
    script.addEventListener('error', () => {
      ctx.note(`this view's script did not load — ${v.script}`, 'stop');
    });
    document.head.appendChild(script);

    if (v.dataUrl) pull(v);
    else entry.ready();
  }

  /* ----------------------------------------------------------------------- the boot */

  bc.view = {
    define,
    /** Every view being hosted, by full id. For a test, and for anything that has to agree. */
    hosted: () => [...hosted.keys()],
    /** One hosted view's context, for a script that lost its reference. */
    context: (id) => hosted.get(id)?.ctx || null,
  };

  /*
    Discovery is one request and it is deliberately not awaited by anything. The shell is
    already on screen — this file runs after the pill row is drawn and after the staged
    boot has built the landed-on pane — so a slow answer, or no answer at all, costs
    exactly the pills it would have added and nothing else.

    Which is also why a failure is a console line rather than anything louder: `/api/views`
    failing on a phone with no link is the same event as every other fetch failing, and
    public/freshness.js already says so once for the whole page.
  */
  api('/api/views')
    .then((out) => {
      for (const p of out.problems || []) console.warn(`[view] ${p}`);
      for (const v of out.views || []) {
        try {
          host(v);
        } catch (err) {
          console.error(`[view] could not host ${v?.view}`, err);
        }
      }
    })
    .catch((err) => console.warn('[view] could not ask which views the repos have —', err.message));

  /*
    ⟳ in the mark's menu means "read the view I am looking at again" (see the same handler
    in public/app.js and its mirror in public/history.js). A repo view's own is the
    generator, so the press spends a real run rather than the held payload — which is the
    one moment somebody is explicitly asking for the truth rather than for the board.
  */
  document.getElementById('refresh')?.addEventListener('click', () => {
    const showing = panes.showing?.();
    const entry = showing && hosted.get(showing);
    if (entry) entry.ctx.refresh();
  });
})();
