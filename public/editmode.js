/*
  Edit mode: the running app as the thing you point at.

  Today a change to this webapp starts by describing a screen, in words, to a chat that
  cannot see it — from the phone the screen is on. The screen is right there and is the
  best description of itself. Edit mode is the state that lets it be used that way, and
  it is the foundation the rest of bc-p49x sits on: this file does not yet capture a
  single edit. It does three things, and each one is a precondition for the ones that
  come after it.

  ## 1. It is a mode, and it says so

  In edit mode a tap means something else — it points at an element rather than opening
  a card — so the mode has to be unmistakable, not a subtle affordance you could be in
  by accident. There is a banner across the top of the screen, the page is tinted, and
  the button that turned it on turns into the way out. `body.editing` is the one flag
  everything else reads.

  ## 2. Repaints are suspended while it is on

  `render()` in public/app.js rebuilds the list, and the reconciler under it replaces
  every chunk whose HTML has changed. Both are exactly right for an inbox that polls
  every twenty-five seconds, and both are ruinous for a mode whose entire premise is
  that you are pointing at a specific element: the element you tapped is gone by the
  time the tap is handled, and a drag or a caret dies mid-gesture. That is the same
  root cause as bc-nh19.

  So the poll keeps running and the paint stops. The distinction matters: stopping the
  poll would leave the page holding a payload from before the edit began and would need
  a cold sweep to recover, where a frozen paint has the fresh state in hand the whole
  time and only owes one repaint at the end. `app.js` asks `frozen()` at its two paint
  entry points and defers, using the machinery it already had for a half-typed answer
  (`pendingRender`), and takes the deferred repaint when the mode ends.

  Deliberately *all* repaints, including the forced ones a filter tap makes. A forced
  repaint under your thumb is the case this exists to prevent, not an exception to it.

  ## 3. Every element resolves to a durable anchor

  An edit is worth nothing if nobody can find what it was about afterwards. `anchorFor`
  turns an element into a record that survives the page being thrown away: the chain of
  selectors down to it, its class names, its visible text — and, the part that makes the
  apply half tractable at all, where in this app's own source that element is written.

  **The class names here are hand-written in the template literals that emit them.**
  There is no build step, no CSS module, no generated identifier: `class="p0-title"` in
  public/app.js is the same eleven characters that end up in the DOM. That makes a class
  name — or better, an `id` or a `data-act` — an unusually good grep key back to the one
  line of source responsible for the element. So the anchor carries not just the key but
  the answer: the file and line where it was found, or an honest report that the search
  found nothing.

  The search runs against the page's own scripts, fetched from the server that served
  them. That is not a shortcut around a server-side grep — it is the more honest search
  of the two, because what it reads is exactly the source that drew the screen you are
  looking at, rather than a working tree that may have moved on.

  ### Source or tracker — the distinction the whole epic depends on

  Half the text on this screen is written in public/*.js and half of it came out of
  `bd`. Retyping the first is editing the app. Retyping the second is editing the
  tracker while believing you are editing the app, and it must be refused rather than
  filed — a bead whose acceptance criteria say "change the title to X" would be acted on
  by an agent that then changed the wrong thing in the wrong place.

  The anchor records which, in `text.from`, and the rule has a deliberate precedence:

    - **data** — the trimmed text is exactly a string the page is currently drawing out
      of the payload. `app.js` supplies that set through `provideText`.
    - **source** — not that, and found verbatim in the page's own scripts or markup.
    - **unknown** — neither. An interpolated string, a number, a run of text assembled
      from parts. Honest, and not editable.

  Data wins over source when a string is both — a bead titled "Refresh" is not the ⟳
  button — because that is the direction where being wrong is survivable. Calling a
  source string data refuses an edit that was legitimate, and you retype it in a chat
  the way you always did. Calling a tracker string source files an edit against
  public/app.js that will never be applicable and may be applied to the wrong line.
*/
(() => {
  const win = typeof window !== 'undefined' ? window : globalThis;
  const doc = win.document;

  /** The mode itself, and everything that has to be undone when it ends. */
  const mode = {
    on: false,
    banner: null,
    /** Registered by app.js. Returns every string the page is currently drawing out of
     *  the payload — see the precedence rule above. */
    dataText: null,
    /** Called with `true`/`false` on every change. app.js takes its catch-up repaint here. */
    listeners: [],
  };

  /** The page's own source, as fetched. `null` until a load has been asked for. */
  let sources = null;
  let loading = null;

  /* ------------------------------------------------------------------ source */

  /**
   * Which files could have drawn this screen.
   *
   * The document itself — the chrome in index.html is markup, not a template literal —
   * and every same-origin script it loads. The vendored bundles are excluded: marked
   * and purify are 300KB of somebody else's code that emits nothing with one of this
   * app's class names in it, and scanning them would only add coincidences.
   */
  function sourceUrls() {
    const urls = [win.location?.pathname || '/'];
    for (const s of doc?.scripts || []) {
      const src = s.getAttribute?.('src');
      if (!src || /^[a-z]+:\/\//i.test(src) || src.includes('/vendor/')) continue;
      if (!urls.includes(src)) urls.push(src);
    }
    return urls;
  }

  /**
   * Read them, once per mode, and index them by line.
   *
   * A file that will not load is skipped rather than fatal: a phone holding an older
   * service worker can be missing one, and an anchor resolved against four files out of
   * five is still an anchor — it just reports fewer sites, which is what `found: 0`
   * already means.
   */
  async function loadSources() {
    const urls = sourceUrls();
    const read = await Promise.all(
      urls.map(async (url) => {
        try {
          const res = await win.fetch(url, { credentials: 'same-origin' });
          if (!res.ok) return null;
          return { url, text: await res.text() };
        } catch {
          return null;
        }
      })
    );
    sources = read.filter(Boolean).map((f) => ({ ...f, code: blank(f.url, f.text), lines: lineStarts(f.text) }));
    return sources;
  }

  /**
   * The same file with its comments blanked out, character for character.
   *
   * Not an optimisation — a correctness fix, and one this found in itself. Every file in
   * this repo argues in prose that names the identifiers around it, and the paragraph at
   * the top of *this* file quotes `class="p0-title"` while explaining why class names are
   * good grep keys. So the first version of the anchor reported two sites for a P0 card's
   * title: the line in public/app.js that draws it, and the sentence here saying that
   * line exists. Two sites is "ambiguous, do not offer an edit", which is the wrong
   * answer arrived at by counting an English sentence as a place markup is emitted.
   *
   * Blanked rather than removed so every offset still lands on the line it came from, and
   * the snippet reported for a hit is sliced from the original text — the reader wants the
   * line as it is written, not the line with holes in it.
   */
  function blank(url, src) {
    return /\.js(\?|$)/.test(url) ? blankJs(src) : blankHtml(src);
  }

  function blankHtml(src) {
    return src.replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, ' '));
  }

  /**
   * A character scanner, because a regex cannot tell a comment from a comment's spelling.
   *
   * `//` inside a string is not a comment and `'` inside a comment does not open one, so
   * the two have to be tracked together. Template literals carry a stack because this app
   * nests them — `` `${esc(`${url}&open=1`)}` `` is one line of public/app.js — and a
   * scanner that took the inner backtick for the outer one would call the rest of the
   * template code and start finding comments in markup.
   *
   * Regular expressions are the one construct it guesses at: `/` is division or the start
   * of a literal depending on what came before it, which is not decidable without parsing.
   * The usual heuristic is used — a literal may only follow an operator, an opener or the
   * start of a statement — and the cost of guessing wrong is a blanked tail of one line,
   * which loses a site rather than inventing one.
   */
  function blankJs(src) {
    const out = src.split('');
    const stack = [];
    let mode = 'code';
    let prev = '';
    let i = 0;
    const wipe = (n) => {
      for (let k = 0; k < n; k++) if (out[i + k] !== '\n') out[i + k] = ' ';
    };
    while (i < src.length) {
      const c = src[i];
      const d = src[i + 1];
      if (mode === 'code') {
        if (c === '/' && d === '/') {
          mode = 'line';
          continue;
        }
        if (c === '/' && d === '*') {
          mode = 'block';
          continue;
        }
        if (c === '/' && /[(,=:[!&|?{};+\-*%~^<>]/.test(prev)) {
          mode = 'regex';
          i += 1;
          continue;
        }
        if (c === "'" || c === '"') {
          mode = c;
          i += 1;
          continue;
        }
        if (c === '`') {
          stack.push('tpl');
          mode = 'tpl';
          i += 1;
          continue;
        }
        // A `}` that closes a `${…}` hands the scanner back to the template around it.
        if (c === '}' && stack[stack.length - 1] === 'sub') {
          stack.pop();
          mode = 'tpl';
          i += 1;
          continue;
        }
        if (!/\s/.test(c)) prev = c;
        i += 1;
        continue;
      }
      if (mode === 'line') {
        if (c === '\n') {
          mode = 'code';
          prev = '';
          i += 1;
          continue;
        }
        wipe(1);
        i += 1;
        continue;
      }
      if (mode === 'block') {
        if (c === '*' && d === '/') {
          wipe(2);
          mode = 'code';
          i += 2;
          continue;
        }
        wipe(1);
        i += 1;
        continue;
      }
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (mode === 'tpl') {
        if (c === '`') {
          stack.pop();
          mode = 'code';
          i += 1;
          continue;
        }
        if (c === '$' && d === '{') {
          stack.push('sub');
          mode = 'code';
          i += 2;
          continue;
        }
        i += 1;
        continue;
      }
      if (mode === 'regex') {
        if (c === '/') mode = 'code';
        else if (c === '\n') mode = 'code';
        i += 1;
        continue;
      }
      // A single- or double-quoted string, named by the quote that opened it.
      if (c === mode) {
        mode = 'code';
        prev = c;
      }
      i += 1;
    }
    return out.join('');
  }

  /** Byte offsets of every line start, so a hit can be reported as a line number. */
  function lineStarts(text) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    return starts;
  }

  /** Which line an offset falls on, 1-based. Binary search — these files are large. */
  function lineAt(starts, offset) {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  }

  /**
   * Every place this literal appears, across every source read.
   *
   * A plain substring search, deliberately. The point of the key is that it is written
   * in the source exactly as it reaches the DOM, so anything cleverer would be a way of
   * matching something the source does not actually say. Capped, because a key as
   * generic as `class="card"` is a legitimate answer of "many" and there is no value in
   * carrying forty copies of it.
   */
  function sitesFor(needle, cap = 8) {
    if (!sources || !needle) return [];
    const sites = [];
    for (const file of sources) {
      let at = file.code.indexOf(needle);
      while (at !== -1) {
        const line = lineAt(file.lines, at);
        const from = file.lines[line - 1];
        const end = file.text.indexOf('\n', at);
        sites.push({ file: file.url, line, text: file.text.slice(from, end === -1 ? undefined : end).trim().slice(0, 200) });
        if (sites.length >= cap) return sites;
        at = file.code.indexOf(needle, at + needle.length);
      }
    }
    return sites;
  }

  /* ------------------------------------------------------------------ anchor */

  /** The visible text of an element, normalised the way a person reading it would. */
  function visibleText(el) {
    return String(el?.textContent || '').replace(/\s+/g, ' ').trim();
  }

  const classesOf = (el) => String(el?.getAttribute?.('class') || '').trim().split(/\s+/).filter(Boolean);

  /**
   * One step of the chain: what this element is, said as compactly as it can be said
   * without losing the ability to find it again.
   */
  function step(el) {
    const tag = String(el.tagName || '').toLowerCase();
    const classes = classesOf(el);
    const id = el.id || '';
    let sel = tag;
    if (id) sel = `#${id}`;
    else if (classes.length) sel = `${tag}.${classes.join('.')}`;
    return { tag, id, classes, sel };
  }

  /**
   * The chain from the nearest identified ancestor down to the element.
   *
   * It stops at an `id` rather than always walking to `<body>`, because an id is the one
   * thing in this app guaranteed to be unique on the page and written by hand in the
   * markup — everything above it would be `body > main > div` noise. With no id anywhere
   * above, it walks to the body and says so.
   */
  function chainFor(el) {
    const chain = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== doc.body) {
      chain.unshift(step(node));
      if (node.id) break;
      node = node.parentElement;
    }
    return chain;
  }

  /**
   * The ladder of grep keys, most specific first.
   *
   * Ordered by how likely each is to name exactly one line of source, which is what the
   * anchor is looking for. An `id` is unique on the page by definition; a `data-act` is
   * the name of one handler branch; a class attribute written out in full is one
   * template literal; a single class name may be shared by a family. Text is last
   * because it is the key most likely to be data rather than source, and the least
   * likely to be unique when it is not.
   */
  function keysFor(el, text) {
    const keys = [];
    const attr = (name) => el.getAttribute?.(name) || '';
    if (el.id) keys.push({ kind: 'id', query: `id="${el.id}"` });
    for (const name of ['data-act', 'data-role', 'data-tab', 'aria-label']) {
      const v = attr(name);
      if (v) keys.push({ kind: name, query: `${name}="${v}"` });
    }
    const written = attr('class').trim();
    if (written) keys.push({ kind: 'class', query: `class="${written}"` });
    // The classes one at a time, rarest first: `p0-title` names one line where `card`
    // names forty, and asking for the rare one first is what turns "many" into "one".
    const singles = classesOf(el)
      .map((c) => ({ kind: 'class-name', query: `"${c}"`, name: c, count: sitesFor(`"${c}"`, 40).length }))
      .filter((k) => k.count > 0)
      .sort((a, b) => a.count - b.count);
    keys.push(...singles.map(({ kind, query, name }) => ({ kind, query, name })));
    if (text && text.length >= 3) keys.push({ kind: 'text', query: text });
    return keys;
  }

  /**
   * Walk the ladder and take the first key that names exactly one line.
   *
   * Failing that, the narrowest key that named anything at all — "this element is one of
   * six `.card`s written in app.js" is a worse answer than one line and a far better one
   * than nothing. Failing *that*, `found: 0` and every key that was tried, which is the
   * honest report the acceptance asks for: the element cannot be traced to source, and
   * nothing downstream should pretend otherwise.
   */
  function resolve(el, text) {
    const tried = [];
    let best = null;
    for (const key of keysFor(el, text)) {
      const sites = sitesFor(key.query);
      tried.push({ kind: key.kind, query: key.query, found: sites.length });
      if (sites.length === 1) return { ...key, sites, found: 1, tried };
      if (sites.length && (!best || sites.length < best.sites.length)) best = { ...key, sites };
    }
    if (best) return { ...best, found: best.sites.length, tried };
    return { kind: null, query: null, sites: [], found: 0, tried };
  }

  /** Everything the page is currently drawing out of the payload, as supplied by app.js. */
  function dataStrings() {
    try {
      const out = mode.dataText?.();
      return Array.isArray(out) ? out : [];
    } catch {
      // A provider that throws is a bug in the caller, and the honest consequence here is
      // that nothing can be recognised as data — which makes every string look like
      // source. So it is reported rather than swallowed silently: see `text.provider`.
      return null;
    }
  }

  /**
   * The record an edit is filed against.
   *
   * Everything on it is derived from the element and the source, and nothing on it is a
   * reference into this document — it is JSON, and it is still true after the page it
   * describes has been thrown away.
   */
  function anchorFor(el) {
    if (!el || el.nodeType !== 1) return null;
    const text = visibleText(el);
    const chain = chainFor(el);
    const data = dataStrings();
    const dataHit = Boolean(data && data.some((s) => String(s).replace(/\s+/g, ' ').trim() === text));
    const textSites = text && text.length >= 3 ? sitesFor(text) : [];
    const source = resolve(el, text);
    return {
      page: win.location?.pathname || '/',
      selector: chain.map((s) => s.sel).join(' > '),
      chain,
      classes: classesOf(el),
      tag: String(el.tagName || '').toLowerCase(),
      // Which card, pane or row the element belongs to, when it belongs to one. The
      // inbox keys every chunk it draws; an edit inside one is about that chunk.
      key: el.closest?.('[data-key]')?.dataset?.key || null,
      text: {
        value: text,
        from: !text ? 'empty' : dataHit ? 'data' : textSites.length ? 'source' : 'unknown',
        sites: textSites,
        // Null means the provider threw and nothing could be recognised as data, so
        // `from` is not to be trusted for this anchor. Not the same as an empty set,
        // which is a page genuinely drawing no payload text.
        provider: data === null ? null : data.length,
      },
      source,
      // Whether the *text* may be retyped in place, which is the only edit this epic
      // applies literally. One site and one site only: two matching lines are two
      // places a rename would have to land, and picking one of them is a guess.
      editable: {
        ok: text.length > 0 && !dataHit && textSites.length === 1,
        why: !text
          ? 'nothing to retype'
          : dataHit
            ? 'this text is bead data — retyping it would edit the tracker, not the app'
            : textSites.length === 1
              ? ''
              : textSites.length
                ? `written in ${textSites.length} places in source`
                : 'not found in this app’s source',
      },
      resolved: Boolean(sources),
    };
  }

  /* -------------------------------------------------------------------- mode */

  /** The banner. It is the whole of "says so unmistakably", so it is not subtle. */
  function raiseBanner() {
    if (!doc || mode.banner) return;
    const bar = doc.createElement('div');
    bar.className = 'editbar';
    bar.id = 'editbar';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span class="editbar-dot"></span>' +
      '<span class="editbar-say">Edit mode — the screen is frozen</span>' +
      '<button type="button" class="editbar-done" data-act="edit-done">Done</button>';
    bar.querySelector('[data-act="edit-done"]').addEventListener('click', () => off());
    doc.body.appendChild(bar);
    mode.banner = bar;
  }

  function dropBanner() {
    mode.banner?.remove();
    mode.banner = null;
  }

  function tell(on) {
    for (const fn of mode.listeners) {
      try {
        fn(on);
      } catch {
        /* one listener's problem is not another's */
      }
    }
  }

  /**
   * Turn it on. The freeze takes effect on this line, not when the source has been read.
   *
   * Deliberately: the source read is a network fetch, and the repaint it would be racing
   * is the one that would throw away the element you are about to point at. `ready()` is
   * how a caller that needs the anchors waits for the rest.
   */
  function on() {
    if (mode.on) return loading;
    mode.on = true;
    doc?.body?.classList?.add('editing');
    raiseBanner();
    loading = loading || loadSources();
    tell(true);
    return loading;
  }

  /** And off, which is where app.js takes the one repaint that catches the screen up. */
  function off() {
    if (!mode.on) return;
    mode.on = false;
    doc?.body?.classList?.remove('editing');
    dropBanner();
    tell(false);
  }

  const toggle = () => (mode.on ? off() : on());

  /**
   * The way in, if the page has one.
   *
   * A button in the page's own markup rather than one built here, because where it goes
   * is a question about that page's layout and not about this mode — the inbox has a
   * corner free beside ＋ and the next page to want edit mode may not. A page without
   * the button still gets the whole module through `beadcause.editMode`, which is what
   * the checks and the console drive it by.
   */
  function wireButton() {
    const btn = doc?.getElementById?.('editmode');
    if (!btn) return;
    const say = () => {
      btn.setAttribute('aria-pressed', mode.on ? 'true' : 'false');
      btn.classList.toggle('on', mode.on);
      btn.setAttribute('aria-label', mode.on ? 'Leave edit mode' : 'Edit this screen');
    };
    btn.addEventListener('click', () => toggle());
    mode.listeners.push(say);
    say();
  }

  win.beadcause = win.beadcause || {};
  win.beadcause.editMode = {
    on,
    off,
    toggle,
    /** Is the mode on? */
    active: () => mode.on,
    /** Should a repaint be held? The same answer today, asked by its own name because
     *  the two are different questions and only one of them is app.js's business. */
    frozen: () => mode.on,
    /** Resolves once the page's own source has been read and anchors can name a line. */
    ready: () => loading || Promise.resolve(sources),
    anchorFor,
    onChange: (fn) => {
      if (typeof fn === 'function') mode.listeners.push(fn);
    },
    /** app.js hands over what it is drawing out of the payload. See the precedence rule. */
    provideText: (fn) => {
      if (typeof fn === 'function') mode.dataText = fn;
    },
  };

  wireButton();
})();
