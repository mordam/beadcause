/*
  Edit mode: the running app as the thing you point at.

  Today a change to this webapp starts by describing a screen, in words, to a chat that
  cannot see it — from the phone the screen is on. The screen is right there and is the
  best description of itself. Edit mode is the state that lets it be used that way, and
  it is where the whole of bc-p49x lives except the filing. It does five things, and the
  first three are the preconditions for the two that follow (bc-p49x.1 built those three,
  bc-p49x.2 the two after them, and bc-p49x.3 turns the list at the end into beads).

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

  ## 4. Three ways to say what should change

  One press, told apart by time and then by movement, because a phone has one gesture
  surface and this needs three meanings out of it. **Tap** to retype text in place, which
  is the one edit in this epic that is literal. **Hold** to describe: the element is
  picked up, and letting go without moving it asks for a sentence about what it should do
  instead. **Hold and drag** to point: where you let go names another element, and what is
  recorded is the relationship — above the title, inside this card, out of this row — plus
  the sentence, which is the half an agent actually acts on.

  Nothing a gesture does to the screen is a change to the app, and the mode says so at
  every step. A dropped element snaps back before the note box has even opened; a retyped
  word reverts the moment the mode ends; the panel's foot says outright that nothing here
  has changed anything. A mode whose gestures *looked* like they had taken effect would be
  read as a save that failed the next time the app was opened.

  ## 5. The pass is a change list, and it is reviewable before it is anything else

  All three land in one list, in the order they were made, and any one of them can be
  dropped before Save — a point with no note is dropped for you, because it is a finger
  that slipped rather than an edit. The list is what bc-p49x.3 files: `changes()` is JSON
  and holds everything an agent needs cold, `clearChanges()` is what Save takes once the
  beads are filed, and nothing in this file writes to `bd`.
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
    /** Registered by app.js. Where in the app you are standing — the surface, the tab,
     *  the filters that are on. Read at the moment an edit is recorded rather than at
     *  Save, because a pass made across two filters is two different screens and the
     *  agent acting on the third edit needs the one *it* was said on. */
    context: null,
    /** Called with `true`/`false` on every change. app.js takes its catch-up repaint here. */
    listeners: [],
  };

  /** The page's own source, as fetched. `null` until a load has been asked for. */
  let sources = null;
  let loading = null;
  /** The payload text as of the moment the screen was frozen. See `snapshotData`. */
  let painted;

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
        sites.push({
          file: file.url,
          line,
          // The character offset as well as the line, because the chain narrowing below
          // asks how far apart two hits are and lines are the wrong unit for that: a
          // template literal is one statement spread over twenty of them.
          at,
          text: file.text.slice(from, end === -1 ? undefined : end).trim().slice(0, 200),
        });
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

  /**
   * The classes this mode puts on an element itself — picked up, being retyped, spoken
   * about — and the reason `classesOf` filters.
   *
   * They are on the element only while you are pointing at it, and an anchor is a record
   * that outlives the pointing. One carrying `editsaid` would name a class this app never
   * wrote, put it in the selector chain, and offer it to the source search as a grep key
   * that can only ever resolve to this file. Found the second time an element was
   * anchored: describe one, then retype it, and the second anchor's class attribute is
   * `class="card-act editsaid"`, which appears nowhere in the source that drew it.
   */
  const MARKS = ['editpick', 'editdrag', 'editretype', 'editretyped', 'editsaid'];

  const classesOf = (el) =>
    String(el?.getAttribute?.('class') || '')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .filter((c) => !MARKS.includes(c));

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
    // Written out in full, as one template literal writes it — but off `classesOf`, so a
    // mark this mode put on the element is not part of the key. See `MARKS`.
    const written = classesOf(el).join(' ');
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
      let sites = sitesFor(key.query);
      tried.push({ kind: key.kind, query: key.query, found: sites.length });
      if (sites.length > 1) {
        // The chain is the anchor, not the element. `<p class="q">` is written three
        // times in public/app.js — in the card's head, in its foot and in the agent
        // card — and the element alone cannot say which; the `.card-head` it is inside
        // can rule one of the three out. See `byChain`.
        const narrowed = byChain(sites, el);
        if (narrowed.length && narrowed.length < sites.length) {
          sites = narrowed;
          tried.push({ kind: `${key.kind}+chain`, query: key.query, found: sites.length });
        }
      }
      if (sites.length === 1) return { ...key, sites, found: 1, tried };
      if (sites.length && (!best || sites.length < best.sites.length)) best = { ...key, sites };
    }
    if (best) return { ...best, found: best.sites.length, tried };
    return { kind: null, query: null, sites: [], found: 0, tried };
  }

  /**
   * How far above a hit an ancestor's own hit is allowed to be, in characters.
   *
   * A card in this app is one template literal of a few thousand characters, and the
   * element being anchored is emitted somewhere inside the block its parent opened. Wide
   * enough to hold the biggest of those, narrow enough that the *next* renderer down the
   * file is outside it — which is the whole distinction being drawn.
   */
  const CHAIN_WINDOW = 3000;

  /**
   * Keep the candidate sites that have the element's ancestors written above them.
   *
   * The DOM knows the element is a `.q` inside a `.card-head`; the source has three
   * `.q`s and three `.card-head`s, and the pairing is the ordering in the file. So a
   * candidate survives if the nearest ancestor that resolves to anything at all has one
   * of its own sites in the same file, before it, and close enough to plausibly be the
   * block it opened.
   *
   * Ancestors are tried nearest first and stop as soon as one narrows the field, because
   * each step up is a weaker claim: a grandparent's class may open a block containing
   * several candidates, and applying it after the parent has already decided would only
   * risk throwing the right one away. Narrowing to *nothing* is discarded by the caller —
   * that means the guess was wrong, and a wrong guess must not beat an honest ambiguity.
   */
  function byChain(sites, el) {
    let node = el.parentElement;
    for (let hops = 0; node && node.nodeType === 1 && hops < 4; hops++, node = node.parentElement) {
      const above = ancestorSites(node);
      if (!above.length) continue;
      const kept = sites.filter((s) =>
        above.some((a) => a.file === s.file && a.at <= s.at && s.at - a.at <= CHAIN_WINDOW)
      );
      if (kept.length && kept.length < sites.length) return kept;
    }
    return [];
  }

  /** The narrowest set of sites an ancestor resolves to on its own, or nothing. */
  function ancestorSites(node) {
    let best = [];
    for (const key of keysFor(node, '')) {
      const sites = sitesFor(key.query, 40);
      if (!sites.length) continue;
      if (!best.length || sites.length < best.length) best = sites;
      if (best.length === 1) break;
    }
    return best;
  }

  /**
   * What the payload was drawing at the moment the screen was frozen.
   *
   * Taken once, on the way in, and this is not an optimisation either — it is the freeze
   * being applied to the second thing that has to be frozen. The poll keeps running while
   * the mode is on, so `state` in app.js moves on: five minutes into a session the
   * provider is describing a payload three sweeps newer than the pixels. Asked live, the
   * title you are pointing at would not be in the answer, and a bead title would come
   * back as `unknown` — not tracker text, not refused, and one step from being filed as
   * an edit to a file it was never in. Found exactly that way, by the browser check
   * watching a card go stale under a frozen screen.
   *
   * So the screen and the set of strings it is drawing are frozen together, and they
   * thaw together too: the next `on()` takes a fresh snapshot.
   */
  function snapshotData() {
    try {
      const out = mode.dataText?.();
      painted = Array.isArray(out) ? out : [];
    } catch {
      // A provider that throws is a bug in the caller, and the honest consequence here is
      // that nothing can be recognised as data — which makes every string look like
      // source. So it is reported rather than swallowed silently: see `text.provider`.
      painted = null;
    }
  }

  /** The snapshot, or a fresh read for a caller anchoring outside the mode entirely. */
  function dataStrings() {
    if (painted !== undefined) return painted;
    snapshotData();
    return painted;
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

  /* ----------------------------------------------------------------- changes */

  /**
   * The pass.
   *
   * Every edit made since the mode was first entered, in the order they were made. One
   * list for all three gestures, because they are three ways of saying the same kind of
   * thing and an agent reading them back wants them in the order they were said — the
   * second edit is very often a qualification of the first.
   *
   * It outlives leaving the mode, deliberately. The visuals do not: a retyped word
   * reverts and a marked element goes plain the instant the mode ends, because none of
   * it was ever real. But the *record* of what you asked for is the one thing in this
   * epic that cannot be reconstructed from the screen afterwards, and a thumb that hits
   * ✏️ twice is not a decision to throw a pass away. Save is what empties it (bc-p49x.3;
   * this file holds the list and hands it over, and files nothing itself).
   */
  const changes = [];
  let changeNo = 0;
  /** id -> the function that puts the screen back. Not part of the record: these are
   *  closures over live elements, where the record is JSON and outlives the page. */
  const undos = new Map();
  const changeListeners = [];

  const esc = (s) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  /** Enough of an element to name it in a sentence a person would recognise. */
  function labelFor(el) {
    const text = visibleText(el);
    if (text) return text.length > 44 ? `${text.slice(0, 42)}…` : text;
    const s = el && el.nodeType === 1 ? step(el) : null;
    return s ? s.sel : 'the screen';
  }

  function sayChanges() {
    paintList();
    paintCount();
    for (const fn of changeListeners) {
      try {
        fn(changesOf());
      } catch {
        /* one listener's problem is not another's */
      }
    }
  }

  /**
   * Where in the app this was said — the surface, and whatever narrowing is on.
   *
   * A bare copy of what app.js hands over, and it is a *copy*: the object it returns is
   * that page's own live state on a good day, and an edit's record has to survive the
   * next repaint changing it. A provider that throws is a page mid-load rather than a
   * reason to lose the edit, so it answers with nothing and the bead simply has no
   * where-block.
   */
  function contextNow() {
    try {
      const said = mode.context?.();
      if (!said || typeof said !== 'object') return null;
      const out = {};
      for (const [key, value] of Object.entries(said)) {
        const words = String(value ?? '').trim();
        if (words) out[key] = words;
      }
      return Object.keys(out).length ? out : null;
    } catch {
      return null;
    }
  }

  /**
   * File one edit into the pass.
   *
   * `undo` is how the screen gets back to the truth — run when the entry is dropped and
   * when the mode ends, and run at most once either way.
   */
  function record(rec, undo) {
    changeNo += 1;
    const entry = { id: `e${changeNo}`, ...rec, context: contextNow() };
    // What the last Save said is about a pass that has now moved on. Left up, it would
    // read as a report on the edit just made.
    outcome = null;
    changes.push(entry);
    if (undo) undos.set(entry.id, undo);
    sayChanges();
    return entry;
  }

  function undoOne(id) {
    const fn = undos.get(id);
    undos.delete(id);
    try {
      fn?.();
    } catch {
      // A restore that throws is one against an element the page has since thrown away,
      // which is exactly the case where there is nothing left to put back.
    }
  }

  /** Drop one entry before it is saved, and put back whatever it did to the screen. */
  function dropChange(id) {
    const at = changes.findIndex((c) => c.id === id);
    if (at === -1) return false;
    changes.splice(at, 1);
    undoOne(id);
    sayChanges();
    return true;
  }

  /** The whole pass, gone — and the screen back as it was. What Save takes once it has
   *  filed it, and what a second thought about the whole pass takes without filing. */
  function clearChanges() {
    for (const c of [...changes]) undoOne(c.id);
    changes.length = 0;
    undos.clear();
    sayChanges();
  }

  /** The pass as JSON, which is the only form anything outside this file should see. */
  const changesOf = () => changes.map((c) => JSON.parse(JSON.stringify(c)));

  /** Every visual this pass has put on the screen, off — the records stay. */
  function restoreScreen() {
    for (const c of changes) undoOne(c.id);
  }

  /* ----------------------------------------------------------------- the save */

  /**
   * Save: the pass becomes beads, and this is the only thing in this file that writes.
   *
   * Everything above it is a conversation held entirely in one browser tab, which is the
   * right place for it — an edit is reviewable and droppable right up to the moment it is
   * filed, and a gesture that wrote to the tracker as it was made would file half a pass
   * with no way back. So there is one write, it happens on a press, and it happens once.
   *
   * **What comes back decides what is dropped, and the direction is deliberate.** The
   * change list is the only copy of what was said; the beads are durable the instant they
   * exist. So an entry is dropped only against an id the daemon has confirmed, and
   * anything else — a 502, a dead link, a daemon that filed three of five — leaves its
   * entry sitting in the list to be saved again. Filing something twice costs a
   * duplicate bead somebody can close; losing it costs the thought.
   *
   * `sending` is not politeness. A double-tapped Save is two passes filed, and the second
   * one lands as a whole second session bead with the same edits under it.
   */
  const SAVE_URL = '/api/edits';
  let sending = false;
  /** What the last Save did, as a sentence the panel keeps until the pass moves on. */
  let outcome = null;

  const token = () => {
    try {
      return win.localStorage?.getItem('beadcause.token') || '';
    } catch {
      // A browser refusing storage still has a session cookie, which is the phone's way in.
      return '';
    }
  };

  /** The surface the pass happened on, as app.js names it — `the inbox`, not `/`. */
  const viewNow = () => String(contextNow()?.view || '').trim();

  async function save() {
    if (sending || !changes.length) return null;
    sending = true;
    outcome = null;
    paintList();
    say('Filing…');
    let data = null;
    let error = null;
    try {
      const res = await win.fetch(SAVE_URL, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', 'x-beadcause-token': token() },
        body: JSON.stringify({
          page: win.location?.pathname || '/',
          view: viewNow(),
          at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
          changes: changesOf(),
        }),
      });
      data = await res.json().catch(() => ({}));
      if (!res.ok || !data?.ok) error = data?.error || `the daemon answered ${res.status}`;
    } catch (err) {
      error = err?.message || 'the daemon could not be reached';
    }
    sending = false;

    // Whatever landed is gone from the list whether or not the call as a whole succeeded:
    // those beads exist, and an entry left behind would be filed a second time by the
    // next press.
    const filed = Array.isArray(data?.filed) ? data.filed : [];
    for (const one of filed) dropChange(one.changeId);
    const left = changes.length;

    if (error) {
      outcome = filed.length
        ? `Filed ${filed.length}, then stopped: ${error}. The other ${left} are still here — press Save again.`
        : `Nothing was filed: ${error}. The pass is still here.`;
      say('Save failed — the pass is still here');
    } else {
      outcome =
        `Filed as ${data.session?.id || 'a pass'} — ${filed.length} bead${filed.length === 1 ? '' : 's'}` +
        ` under ${data.root?.id || 'the standing root'}${data.root?.made ? ', which this Save created' : ''}.`;
      say(`Filed as ${data.session?.id || 'a pass'}`);
    }
    paintList();
    return { ok: !error, error, data, left };
  }

  /* ---------------------------------------------------------------- the note */

  /**
   * The box that asks what you meant.
   *
   * Two of the three gestures end here and the third never does. A drag says *where* and
   * a long-press says *which*, and neither of them says what should be different — the
   * words do, and the words are what an agent acts on. Retyping is the exception, and
   * the only literal edit in the epic: the new string is the whole of the intent.
   *
   * `Add` stays refused while the box is empty rather than filing a gesture with nothing
   * on it. A point with no note is not an edit, it is a finger that slipped, and a
   * tracker full of "something about this card" is worse than an empty one.
   */
  let note = null;

  function closeNote(cancelled) {
    const open = note;
    note = null;
    if (!open) return;
    open.el?.remove?.();
    if (cancelled) open.onCancel?.();
  }

  const ASK = {
    point: 'It snapped back — nothing on this screen moved. Say what should be different about where it sits.',
    describe: 'What should this do instead?',
  };

  function askNote(about, onAdd, onCancel) {
    closeNote(true);
    const box = doc.createElement('div');
    box.className = 'editnote';
    box.setAttribute('role', 'dialog');
    box.innerHTML =
      `<p class="editnote-what">${esc(about.said)}</p>` +
      `<p class="editnote-ask">${esc(ASK[about.kind] || ASK.describe)}</p>` +
      `<textarea class="editnote-box" rows="3" placeholder="say what you meant"></textarea>` +
      `<div class="editnote-row">` +
      `<button type="button" class="editnote-cancel" data-act="edit-note-cancel">Discard</button>` +
      `<button type="button" class="editnote-add" data-act="edit-note-add" disabled>Add to the list</button>` +
      `</div>`;
    const field = box.querySelector('[class="editnote-box"]');
    const add = box.querySelector('[data-act="edit-note-add"]');
    const cancel = box.querySelector('[data-act="edit-note-cancel"]');
    const words = () => String(field?.value || '').trim();
    field?.addEventListener?.('input', () => {
      if (words()) add?.removeAttribute?.('disabled');
      else add?.setAttribute?.('disabled', 'disabled');
    });
    add?.addEventListener?.('click', () => {
      const said = words();
      if (!said) return;
      closeNote(false);
      onAdd(said);
    });
    cancel?.addEventListener?.('click', () => closeNote(true));
    doc.body.appendChild(box);
    note = { el: box, field, add, onCancel };
    // The same mic the answer card carries, for the same reason: this mode is aimed at a
    // phone and a sentence is a lot of thumb. A page served without dictate.js gets a box
    // with no mic beside it rather than one that fails on tap.
    try {
      win.beadcause?.dictation?.attach?.(field, { label: 'Dictate this note' });
    } catch {
      /* a mic that will not attach is not a reason to lose the note */
    }
    field?.focus?.();
    return note;
  }

  /* --------------------------------------------------------------- the panel */

  const KIND = { point: '⤢', retype: '✎', describe: '💬' };

  /** The list itself: what has been said so far, in order, each row with a way out. */
  let panel = null;
  let panelOpen = false;

  function paintList() {
    if (!panelOpen || !mode.on) {
      panel?.remove?.();
      panel = null;
      return;
    }
    if (!panel) {
      panel = doc.createElement('div');
      panel.className = 'editlist';
      panel.setAttribute('role', 'dialog');
      // Delegated, because the rows are rebuilt on every change and a listener per ✕
      // would have to be rewired every time — the same reconciler problem this whole
      // mode exists to hold still, in miniature.
      panel.addEventListener?.('click', (ev) => {
        const drop = ev.target?.closest?.('[data-drop]');
        if (drop) return void dropChange(drop.getAttribute('data-drop'));
        if (ev.target?.closest?.('[data-act="edit-save"]')) return void save();
        if (ev.target?.closest?.('[data-act="edit-list-close"]')) toggleList(false);
      });
      doc.body.appendChild(panel);
    }
    const rows = changes
      .map(
        (c) =>
          `<li class="editlist-row"><span class="editlist-kind">${KIND[c.kind] || '•'}</span>` +
          `<span class="editlist-said">${esc(c.said)}${c.note ? `<em class="editlist-note">${esc(c.note)}</em>` : ''}</span>` +
          `<button type="button" class="editlist-drop" data-drop="${esc(c.id)}" aria-label="Drop this change">✕</button></li>`
      )
      .join('');
    panel.innerHTML =
      `<div class="editlist-head"><span class="editlist-count">${changes.length} ${changes.length === 1 ? 'change' : 'changes'}</span>` +
      `<button type="button" class="editlist-close" data-act="edit-list-close">Close</button></div>` +
      `<ul class="editlist-rows">${rows || '<li class="editlist-none">Nothing yet. Tap to retype, hold to describe, hold and drag to point.</li>'}</ul>` +
      // The foot is where the mode stops being honest by accident: everything above it is
      // a conversation, and this is the one control that makes any of it real. So it says
      // what pressing it does, in the two states it can be in, and the sentence about
      // nothing having changed stays up until it has been pressed.
      `<div class="editlist-actions"><p class="editlist-foot">${
        outcome
          ? esc(outcome)
          : 'Nothing here has changed the app yet. Save files the pass as beads — one for the pass, one for each change.'
      }</p><button type="button" class="editlist-save" data-act="edit-save"${
        sending || !changes.length ? ' disabled' : ''
      }>${sending ? 'Filing…' : 'Save'}</button></div>`;
  }

  function toggleList(open) {
    panelOpen = open === undefined ? !panelOpen : Boolean(open);
    paintList();
  }

  /* ------------------------------------------------------------- the gestures */

  /**
   * One press, three outcomes.
   *
   * A phone has one gesture surface and this mode needs three meanings out of it, so they
   * are separated by *time* and then by *movement* — which is the idiom every phone
   * already uses to pick something up:
   *
   *   - **Tap** — retype. The one literal edit, and the one that needs no prose.
   *   - **Hold** — the element is picked up. Let go without moving it and what you are
   *     doing is describing it: the words are the whole of the edit.
   *   - **Hold, then drag** — a point. Where you let go names an element, and what gets
   *     recorded is the relationship to it rather than the pixels.
   *
   * Why the hold is not skipped for the drag: this list scrolls, and a thumb moving down
   * the screen is a scroll every other second of the day. Nothing is intercepted until
   * the hold has fired, so the scroller keeps working in edit mode — and by the time it
   * has fired, the browser has already decided this finger is not scrolling.
   */
  const HOLD_MS = 450;
  /** How far a thumb may wander during the hold before it is a scroll instead. */
  const SLOP = 10;
  /** Our own furniture. A tap on any of it is a control, not a thing being pointed at. */
  const OURS = '.editbar, .editnote, .editlist, #editmode, [data-mic]';

  let press = null;
  let armed = false;

  const later = (fn, ms) => (win.setTimeout ? win.setTimeout(fn, ms) : null);
  const unlater = (t) => {
    if (t != null) win.clearTimeout?.(t);
  };

  const ours = (el) => Boolean(el?.closest?.(OURS));
  const typing = (el) => Boolean(el?.closest?.('[contenteditable="true"]'));

  /** Say something in the banner for a moment, then put the sentence back. */
  let saying = null;
  function say(words) {
    const line = mode.banner?.querySelector?.('[class="editbar-say"]');
    if (!line) return;
    unlater(saying);
    line.textContent = words;
    saying = later(() => {
      line.textContent = FROZEN;
    }, 3200);
  }

  function putDown(el) {
    el?.classList?.remove?.('editpick');
    el?.classList?.remove?.('editdrag');
    if (el?.style) el.style.transform = '';
  }

  function onDown(ev) {
    if (!mode.on || ours(ev.target) || typing(ev.target)) return;
    const el = ev.target;
    if (!el || el.nodeType !== 1) return;
    unlater(press?.timer);
    press = { el, x0: ev.clientX, y0: ev.clientY, held: false, moved: false, timer: null };
    press.timer = later(() => {
      if (!press) return;
      press.held = true;
      press.el?.classList?.add?.('editpick');
      // The picked-up element is transparent to hit-testing from here on, so the drop can
      // ask what is *under* the thumb rather than being answered by the thing already in
      // it. Its descendants go with it — pointer-events is inherited.
      press.el?.classList?.add?.('editdrag');
      say('Picked up — let go to describe it, or drag it where it belongs');
    }, HOLD_MS);
  }

  function onMove(ev) {
    if (!press) return;
    const dx = ev.clientX - press.x0;
    const dy = ev.clientY - press.y0;
    const far = Math.abs(dx) > SLOP || Math.abs(dy) > SLOP;
    if (!press.held) {
      // Moved before the hold fired, so this was a scroll all along. Let go of it
      // entirely rather than fighting the scroller for it.
      if (far) {
        unlater(press.timer);
        press = null;
      }
      return;
    }
    if (far) press.moved = true;
    if (press.el?.style) press.el.style.transform = `translate(${Math.round(dx)}px, ${Math.round(dy)}px)`;
    ev.preventDefault?.();
  }

  function onUp(ev) {
    const p = press;
    press = null;
    if (!p) return;
    unlater(p.timer);
    if (!p.held) return void retype(p.el);
    if (!p.moved) {
      putDown(p.el);
      return void describe(p.el);
    }
    point(p, ev);
  }

  function onCancel() {
    const p = press;
    press = null;
    if (!p) return;
    unlater(p.timer);
    putDown(p.el);
  }

  /* --------------------------------------------------------------- 1. retype */

  /**
   * A tap on text makes it editable in place, or says why it is not.
   *
   * The refusals are the point of this half. `editable.ok` is false for tracker text —
   * retyping a bead title is editing `bd` while believing you are editing the app — and
   * false for a string written in more than one place in source, where picking one of
   * them would be a guess. Both come back with the reason `anchorFor` already worked out,
   * said in the banner: a control that silently does nothing reads as a broken mode, and
   * a person would tap it again rather than reach for the chat they can still use.
   *
   * Only a leaf. An element with children is a box around text, not the text, and making
   * a card `contenteditable` hands a thumb the ability to delete half a screen.
   */
  function retype(el) {
    if (!el || el.nodeType !== 1) return;
    const anchor = anchorFor(el);
    if (!anchor) return;
    if (el.children?.length) return void say('Tap the words themselves, not the box around them');
    if (!anchor.editable?.ok) return void say(anchor.editable?.why || 'that cannot be retyped here');
    const was = anchor.text.value;
    el.setAttribute('contenteditable', 'true');
    el.classList?.add?.('editretype');
    const onKey = (ev) => {
      if (ev.key === 'Enter' && !ev.shiftKey) {
        // The keyboard's own return key, which on a phone is the only way out of an edit
        // that does not mean something else: every tap elsewhere is another gesture.
        ev.preventDefault?.();
        el.blur?.();
      } else if (ev.key === 'Escape') {
        el.textContent = was;
        el.blur?.();
      }
    };
    const finish = (keep) => {
      el.removeAttribute?.('contenteditable');
      el.removeEventListener?.('keydown', onKey);
      el.classList?.remove?.('editretype');
      const now = visibleText(el);
      // Emptied counts as abandoned rather than as "delete this text". A thumb that
      // selected everything and tapped away looks identical to one that meant it, and of
      // the two readings only this one is recoverable — the words are back and you can
      // say what you wanted in a note instead.
      if (!keep || now === was || !now) {
        el.textContent = was;
        return;
      }
      el.classList?.add?.('editretyped');
      record({ kind: 'retype', said: `“${was}” → “${now}”`, anchor, from: was, to: now }, () => {
        if (el.isConnected === false) return;
        el.textContent = was;
        el.classList?.remove?.('editretyped');
      });
    };
    el.addEventListener?.('blur', () => finish(true), { once: true });
    el.addEventListener?.('keydown', onKey);
    el.focus?.();
    selectAll(el);
    say('Retype it, then tap away');
  }

  /** Put the caret across the whole of it, so a thumb replaces rather than appends. */
  function selectAll(el) {
    try {
      const range = doc.createRange?.();
      const sel = win.getSelection?.();
      if (!range || !sel) return;
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
    } catch {
      /* a browser that will not place a caret still lets you type at the end */
    }
  }

  /* ------------------------------------------------------------- 2. describe */

  /** A held element with nothing else asked of it: the words are the whole of the edit,
   *  and the gesture exists only to say which element they are about. */
  function describe(el) {
    const anchor = anchorFor(el);
    if (!anchor) return;
    const said = `About “${labelFor(el)}”`;
    askNote({ kind: 'describe', said }, (words) => {
      el.classList?.add?.('editsaid');
      record({ kind: 'describe', said, anchor, note: words }, () => el.classList?.remove?.('editsaid'));
    });
  }

  /* ---------------------------------------------------------------- 3. point */

  /**
   * Where a drop landed, said as a relationship rather than as a position.
   *
   * Two elements and one preposition, which is what a person would have said anyway:
   * *above the title*, *inside this card*, *out of this row*. Pixels are deliberately not
   * recorded, because nothing downstream could act on them — this app's layout is a
   * stylesheet and a template, and "56 pixels left" is not a change anybody can make to
   * either, where "out of the head and under the buttons" is.
   *
   * `elementFromPoint` answers with what is under the thumb, because the dragged element
   * was made transparent to hit-testing when it was picked up. This mode's own furniture
   * is skipped: dropping on the banner is dropping on nothing, and saying so is better
   * than recording an edit about the banner.
   */
  function relationAt(el, x, y) {
    const under = doc.elementFromPoint?.(x, y) || null;
    const target = under && !ours(under) && under !== el && !el.contains?.(under) ? under : null;
    const chunk = (n) => n?.closest?.('[data-key]') || null;
    const mine = chunk(el);
    const left = mine && chunk(target) !== mine ? labelFor(mine) : null;
    if (!target || target === doc.body) {
      return { rel: 'nowhere', target: null, left, said: `“${labelFor(el)}” — dropped where the app has nothing anchored` };
    }
    const box = target.getBoundingClientRect?.() || null;
    // A drop well inside a container that holds other things is asking to be *in* it; one
    // near an edge, or on a leaf, is asking to be above or below the thing it landed on.
    const inside =
      Boolean(target.contains?.(el)) ||
      Boolean(target.children?.length && box && box.height > 40 && y > box.top + 12 && y < box.bottom - 12);
    // `beside` is the answer when the target could not be measured at all. Every element
    // in a browser has a rectangle, so it should never be reached — but a preposition
    // guessed and filed as fact is the one failure this whole design is arranged against,
    // and "below" is what an unmeasured element would otherwise be called.
    const rel = inside ? 'inside' : !box ? 'beside' : y < box.top + box.height / 2 ? 'above' : 'below';
    return {
      rel,
      target: anchorFor(target),
      left,
      said: `“${labelFor(el)}” ${left ? `out of “${left}”, ` : ''}${rel} “${labelFor(target)}”`,
    };
  }

  function point(p, ev) {
    const el = p.el;
    const where = relationAt(el, ev.clientX, ev.clientY);
    // Back where it was before the note is asked for and before anything is recorded. The
    // drag was a way of showing what you meant; it was never a change to the screen, and
    // an element left sitting where it was dropped would say otherwise — and would then
    // vanish back on the mode's exit, which reads as a change that failed to save.
    putDown(el);
    const anchor = anchorFor(el);
    askNote({ kind: 'point', said: where.said }, (words) => {
      el.classList?.add?.('editsaid');
      record({ kind: 'point', said: where.said, anchor, where, note: words }, () => el.classList?.remove?.('editsaid'));
    });
  }

  /* -------------------------------------------------------------- the wiring */

  /**
   * Capture, and on the document, for one reason: in this mode a tap means something
   * else, and the app's own handlers are still on every card underneath. A click that
   * reached them would open the card you were pointing at.
   *
   * Added once and answering nothing while the mode is off, rather than being added and
   * removed with it. A page that never enters edit mode pays for five listeners that
   * return on their first line, and a mode left mid-gesture cannot strand one.
   */
  function armGestures() {
    if (armed || !doc?.addEventListener) return;
    armed = true;
    doc.addEventListener('pointerdown', onDown, true);
    doc.addEventListener('pointermove', onMove, true);
    doc.addEventListener('pointerup', onUp, true);
    doc.addEventListener('pointercancel', onCancel, true);
    // The scroll, refused only once a drag is genuinely under way. Non-passive, because a
    // passive listener cannot refuse anything, and this is the one place the browser has
    // to be told that this finger is not scrolling the list.
    doc.addEventListener(
      'touchmove',
      (ev) => {
        if (press?.held) ev.preventDefault?.();
      },
      { passive: false, capture: true }
    );
    // And the click the app would otherwise act on, swallowed on the way down — after the
    // pointer sequence above has already decided what the gesture was.
    doc.addEventListener(
      'click',
      (ev) => {
        if (!mode.on || ours(ev.target) || typing(ev.target)) return;
        ev.preventDefault?.();
        ev.stopPropagation?.();
      },
      true
    );
  }

  /* -------------------------------------------------------------------- mode */

  /** What the banner says when it is not saying anything more urgent. See `say`. */
  const FROZEN = 'Edit mode — the screen is frozen';

  /** The banner. It is the whole of "says so unmistakably", so it is not subtle. */
  function raiseBanner() {
    if (!doc || mode.banner) return;
    const bar = doc.createElement('div');
    bar.className = 'editbar';
    bar.id = 'editbar';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span class="editbar-dot"></span>' +
      `<span class="editbar-say">${FROZEN}</span>` +
      // The way to the change list, and the only running count of the pass. In the banner
      // rather than in a corner of its own because the banner is the one thing on this
      // screen guaranteed to be visible and reachable in the mode — an open card covers
      // everything else. Hidden at nothing changed: a 0 is a control with nothing behind
      // it.
      '<button type="button" class="editbar-count" data-act="edit-list" hidden>0</button>' +
      '<button type="button" class="editbar-done" data-act="edit-done">Done</button>';
    bar.querySelector('[data-act="edit-done"]').addEventListener('click', () => off());
    bar.querySelector('[data-act="edit-list"]')?.addEventListener?.('click', () => toggleList());
    doc.body.appendChild(bar);
    mode.banner = bar;
    paintCount();
  }

  /**
   * How many edits the pass is holding — on the banner, and on the ✏️ underneath it.
   *
   * The button's badge is the one that matters, because it is the only thing that says so
   * *after* the mode has ended. Leaving puts the whole screen back the way the app has it,
   * which is the truth and is also exactly what a save that failed would look like; a
   * count still sitting on the way back in is the difference between "nothing was applied,
   * and here is what you said" and "it lost my edits".
   *
   * bc-p49x.12 parked the ✏️, so on the inbox today that half writes nothing: the `if
   * (btn)` is what makes a missing button a no-op rather than a throw on the way out of
   * the mode. Nothing else here changes, and the badge comes back with the element.
   */
  function paintCount() {
    const btn = doc?.getElementById?.('editmode');
    if (btn) {
      if (changes.length) btn.setAttribute?.('data-changes', String(changes.length));
      else btn.removeAttribute?.('data-changes');
      sayButton(btn);
    }
    const chip = mode.banner?.querySelector?.('[data-act="edit-list"]');
    if (!chip) return;
    chip.textContent = String(changes.length);
    chip.setAttribute?.('aria-label', `${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}`);
    if (changes.length) chip.removeAttribute?.('hidden');
    else chip.setAttribute?.('hidden', 'hidden');
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
    // Before anything is drawn or fetched: the snapshot has to describe the screen as it
    // is at this instant, and the first poll to land afterwards moves `state` without
    // moving a pixel.
    snapshotData();
    doc?.body?.classList?.add('editing');
    raiseBanner();
    armGestures();
    loading = loading || loadSources();
    tell(true);
    return loading;
  }

  /**
   * And off, which is where app.js takes the one repaint that catches the screen up.
   *
   * Everything this pass drew on the screen comes off first, and before the listeners are
   * told — the repaint they take rebuilds the list, and a retyped word restored *after*
   * it would be restored onto an element the reconciler had already thrown away. The
   * records survive; see `changes`.
   */
  function off() {
    if (!mode.on) return;
    mode.on = false;
    painted = undefined;
    closeNote(true);
    onCancel();
    restoreScreen();
    panelOpen = false;
    paintList();
    doc?.body?.classList?.remove('editing');
    dropBanner();
    tell(false);
  }

  const toggle = () => (mode.on ? off() : on());

  /**
   * The way in, if the page has one — and since bc-p49x.12 no page does.
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
    btn.addEventListener('click', () => toggle());
    mode.listeners.push(() => sayButton(btn));
    sayButton(btn);
  }

  /** Which way the ✏️ is, and what it is holding. Said in both places a screen reader and
   *  a thumb look: the pressed state, and the label. */
  function sayButton(btn) {
    if (!btn) return;
    btn.setAttribute?.('aria-pressed', mode.on ? 'true' : 'false');
    btn.classList?.toggle?.('on', mode.on);
    const held = changes.length ? ` — ${changes.length} unsaved ${changes.length === 1 ? 'change' : 'changes'}` : '';
    btn.setAttribute?.('aria-label', mode.on ? `Leave edit mode${held}` : `Edit this screen${held}`);
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
    /* --- the pass. What Save (bc-p49x.3) reads, files and then clears. --- */
    /** Every edit made this pass, in the order they were made, as JSON. */
    changes: changesOf,
    /** Drop one before it is saved, putting back whatever it did to the screen. */
    dropChange,
    /** File the pass. The only write in this file, and the only one a press reaches. */
    save,
    /** Whether a Save is in flight — a second press must not file a second pass. */
    saving: () => sending,
    /** All of them, gone — after they have been filed, or instead of filing them. */
    clearChanges,
    /** Told on every change to the list, with the list. The panel and the count are two
     *  of these, in this file; a Save button's enabled state is the obvious third. */
    onChanges: (fn) => {
      if (typeof fn === 'function') changeListeners.push(fn);
    },
    /** Open or close the change list. The banner's count is the way in by thumb. */
    showChanges: toggleList,
    /* --- the gestures, by their own names, so a check can drive one without
       synthesising a touch. See scripts/editgesture-check.mjs for the one that does. --- */
    retype,
    describe,
    /** Where a drop at this point would land, without dropping anything. */
    relationAt,
    /** app.js hands over what it is drawing out of the payload. See the precedence rule. */
    provideText: (fn) => {
      if (typeof fn === 'function') mode.dataText = fn;
    },
    /** And where in the app you are standing, which only that page can know: a flat
     *  object of label → value. `view` is special only in that it names the surface the
     *  pass gets titled after; everything else is carried through to the bead as it is. */
    provideContext: (fn) => {
      if (typeof fn === 'function') mode.context = fn;
    },
  };

  wireButton();
})();
