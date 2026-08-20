#!/usr/bin/env node
//
// What the top bar costs on a phone, and whether it is still one row.
//
//   node scripts/topbar-check.mjs [--out=DIR]
//
// The picker had a full-width row of its own inside `.topbar` until bc-khoe.5, so six
// pages carried two rows of pinned chrome where they used to carry one. bc-hne3 argued
// that trade at 360px and decided the row stayed, because the first row was full at four
// icon buttons. bc-khoe.5 emptied the first row instead — the buttons are rows in the
// mark's menu (public/accountbar.js) — and the picker moved up beside the mark. So the
// budget this file defends is **one** row, and two is now the failure rather than the
// ceiling: a decision made once about a number nobody measures again is a decision that
// quietly stops being true, and a row arrives one icon at a time.
//
// So this measures, in a headless Chrome the size of a cheap Android, on every page that
// has a picker:
//
//   * the bar lays out in **exactly one line** — the mark, the page's title and the
//     picker, and nothing else. Anything that pushes it to two has taken 43px of the
//     screen back off the list, on every page at once;
//   * the picker is **on that line**, sharing it — its whole claim used to be that it was
//     the frame for everything under it and therefore wanted the width; what it is now is
//     the narrow value of that frame, and the accent border is what still says something
//     is being kept off the screen;
//   * its label is **cut rather than wide**: at most twelve characters drawn, and past
//     that nine and an ellipsis (`shorten` in public/spacebar.js). Both halves are
//     asserted, because "it fits" and "it is the rule the code says it is" are different
//     claims and only the second survives a font change;
//   * and the **dropdown is untouched** — every row in it is a whole name, because that
//     list is the one place the whole name is the point;
//   * the bar **plus the pill row** stays inside a **170px** budget on a 640px screen.
//     The number is the one bc-hne3 spent and it is kept deliberately: what it defends
//     now is that the room stays spare. Two changes have taken chrome off it in a row —
//     bc-khoe.5 folded the bar to one line, and bc-khoe.1 replaced the 54px bar along the
//     bottom with the 53px pill row under the top one;
//   * the page **fits the screen at all** — that one is not about the bar, but this
//     is the file that noticed. A page laying out wider than the viewport is shrink-
//     fitted by the browser, so every measurement above it is in a different unit from
//     the width it is being judged at. /monitor was 376px at a 360px screen until
//     bc-3ui6, and the symptom is not a horizontal scrollbar — it is the whole console
//     drawn at 96% and draggable sideways, which reads as a font being slightly off;
//   * and **the chrome does not move when you scroll**. That one used to be "nothing
//     else sticks underneath it", because the bar was `position: sticky` at z-index 20
//     and a second sticky box pinning at `top: 0` pinned itself out of sight —
//     /monitor's Advocates/PRs/Mirror strip did exactly that (bc-ugd4). bc-khoe.1
//     changed the shape rather than the arithmetic: every page is a viewport-height
//     shell, the bar and the pill row are rows of a flex column, and the one element
//     marked `.pagescroll` is the only thing that scrolls. So what is asked here now is
//     the thing bc-7utr was filed about — scroll the scroller and the two rows are in
//     exactly the same place, and the *document* has not moved at all. A sticky box
//     pinning to the window is still reported, because reintroducing one is how the old
//     bug comes back.
//
// It also prints the arithmetic, per page: how much of the row the mark and the title
// take and how much is left for the picker. That used to be the premise behind bc-hne3's
// decision and it is now the margin behind bc-khoe.5's — a page whose title grows until
// there is no room left for a picker is the way this comes back, and it would come back
// silently.
//
// Not part of `npm test`: it wants Chrome. Run it when you have touched the top bar, the
// picker, the mark's menu or the icon buttons on any page that has one. `--out=DIR`
// writes a picture per page per width, which is the one thing a column of numbers cannot
// tell you.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The bar plus the pill row, on a 640px screen. One row of bar is 55px since bc-khoe.5
   and the pill row under it is 53px; the two rows of bar plus the old bottom bar were
   159px. The number is bc-hne3's and is kept rather than tightened:
   the slack is what a font or a border may move inside, and shrinking the budget to
   today's measurement would fail the repo for a 2px line-height. What stops a second row
   arriving is the line count above, which is exact. */
const CHROME_BUDGET = 170;

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the fixture */

/* Six repos in two spaces, because the bar hides itself under two (`el.hidden` in
   public/spacebar.js) and because the widest row in the dropdown is what has to fit,
   not the shortest. The rows carry no numbers at all since bc-ka5y.1 — a repo name is
   the whole of a label now — so what is measured here is what ships.

   One of the six is deliberately over the twelve-character cut (bc-khoe.5). Every real
   workspace on this Mac happens to be nine or ten, so a fixture built from them would
   never once exercise the rule that keeps the picker narrow, and the check would go on
   passing after the truncation was deleted. `climative-platform` is what an `architecture`
   or a `climative-platform` checkout actually looks like, and it is the case the bead was
   filed about. */
const WORKSPACES = ['beadcause', 'climative-platform', 'adam.life', 'deluvia', 'ehatt', 'sophab'];
const SPACES = [
  { name: 'Personal', workspaces: ['beadcause', 'adam.life', 'deluvia', 'ehatt', 'sophab'], count: 3, quiet: false },
  { name: 'Work', workspaces: ['climative-platform'], count: 2, quiet: false },
];
const SPACEPAY = {
  spaces: SPACES,
  workspaces: WORKSPACES,
  filter: { space: 'all', workspace: 'all' },
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    /* Every page's own payload carries the picker's three fields, because a page that
       has a sweep of its own feeds the bar from it rather than fetching twice. */
    if (p === '/api/spaces') return json(SPACEPAY);
    if (p === '/api/questions')
      return json({ questions: [], consoles: [], ...SPACEPAY, scope: 'human', summary: { sessions: 0, proposals: 0 } });
    if (p === '/api/work') return json({ workspaces: [], advocates: [], elsewhere: [], ...SPACEPAY });
    if (p === '/api/prs') return json({ unavailable: null, build: null, counts: {}, repos: [], ...SPACEPAY });
    if (p === '/api/consoles') return json({ consoles: [], ...SPACEPAY });
    if (p === '/api/unendorsed') return json({ beads: [], counts: {}, truncated: false, errors: [], ...SPACEPAY });
    if (p === '/api/foundation') return json({ workspaces: WORKSPACES, agents: [], ...SPACEPAY });
    /* Parked the way the daemon parks it. An immediate empty answer turns the pages
       that poll into a spin loop against this fixture, and the run is over long before
       this timer is. */
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (p.startsWith('/api/')) return json({});
    let rel = p;
    if (rel === '/console') rel = '/console.html';
    // The board is a pane on the advocates page now (bc-d4d5), so these land there.
    if (rel === '/prs' || rel === '/pulls' || rel === '/prs.html') rel = '/monitor.html';
    if (rel === '/monitor' || rel === '/advocates' || rel === '/sessions' || rel === '/work') rel = '/monitor.html';
    if (rel === '/endorse') rel = '/endorse.html';
    if (rel === '/releases' || rel === '/deploys') rel = '/releases.html';
    if (rel === '/foundations') rel = '/foundations.html';
    // The selected space's settings (bc-khoe.10). Here because it carries the space
    // picker, which is the row of the bar this check exists to measure the cost of.
    if (rel === '/config' || rel === '/settings') rel = '/config.html';
    const file = path.join(PUBLIC, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

/* ------------------------------------------------------------------- probe */

/*
  Lines, not children. `.topbar` is `flex-wrap: wrap` with `align-items: center`, so two
  children on the same line have different `top` values whenever they are different
  heights — grouping by `top` reports the inbox's one row as two. Overlap is the test.

  The label widths are measured with a span carrying the select's own resolved font
  rather than with the select's `scrollWidth`, which under `appearance: none` and
  `text-overflow: ellipsis` reports the box and not the text.
*/
const PROBE = `(() => {
  const bar = document.querySelector('.topbar');
  if (!bar) return { bar: false };
  const cs = getComputedStyle(bar);
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.columnGap) || 0;
  const kids = [...bar.children].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
  const lines = [];
  for (const el of kids) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const line = lines.find((L) => r.top < L.bottom - 2 && r.bottom > L.top + 2);
    if (line) {
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      line.items.push({ cls: el.className, w: Math.round(r.width) });
    } else lines.push({ top: r.top, bottom: r.bottom, items: [{ cls: el.className, w: Math.round(r.width) }] });
  }
  lines.sort((a, b) => a.top - b.top);

  const sb = document.querySelector('.spacebar');
  const shown = !!(sb && !sb.hidden && getComputedStyle(sb).display !== 'none');
  const sel = sb && sb.querySelector('#space-pick');
  const face = sb && sb.querySelector('.spacepick-shown');
  /*
    What is *drawn* and what is in the *list* are two different strings now — the face is
    a span the script fills with a cut-down label and the select over it is invisible
    (see .spacepick in public/style.css). So both are reported: the face for the bar's
    width and the truncation rule, the options for the promise that the dropdown still
    carries whole names.

    The face's room is its content box, because the caret is drawn over its right-hand
    padding.
  */
  const label = (() => {
    if (!sel || !face) return null;
    const c = getComputedStyle(face);
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-family:' + c.fontFamily +
      ';font-size:' + c.fontSize + ';font-weight:' + c.fontWeight + ';letter-spacing:' + c.letterSpacing;
    document.body.append(span);
    const w = (t) => { span.textContent = t; return Math.ceil(span.getBoundingClientRect().width); };
    const texts = [...sel.options].map((o) => o.textContent);
    const widths = texts.map(w);
    const most = Math.max(...widths);
    const shownText = face.textContent;
    const out = {
      shownText,
      shown: w(shownText),
      /* Clipped is the browser's own answer, not a re-measurement: the face is sized to
         its own content, so a span measured at ceil() precision is a pixel wider than the
         box it is describing and every page reads as one pixel short. */
      clipped: face.scrollWidth > face.clientWidth + 1,
      /* What the picker says is selected, in its own words — 'everything' when nothing is,
         which is not what the option row says. The face is cut from this. */
      selectedText: String(window.beadcause?.space?.label?.() ?? sel.options[sel.selectedIndex].textContent),
      optionText: sel.options[sel.selectedIndex].textContent,
      widest: most,
      widestText: texts[widths.indexOf(most)],
      /** Every option, so the check can say the list was left alone. */
      options: texts,
      /** The whole set of faces this picker can draw, one per option — the truncation
       *  rule tested over the list rather than over whichever row happens to be on. */
      faces: texts.map((t) => (t.length > 12 ? t.slice(0, 9) + '…' : t)),
      room: Math.round(face.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight)),
    };
    span.remove();
    return out;
  })();

  const brand = document.querySelector('.brand');
  const acts = document.querySelector('.topbar .sheet-actions');
  const brandW = brand ? Math.round(brand.getBoundingClientRect().width) : 0;
  const actsW = acts && acts.getBoundingClientRect().width ? Math.round(acts.getBoundingClientRect().width) : 0;
  const row = document.querySelector('.viewbar');

  return {
    bar: true,
    barH: Math.round(bar.getBoundingClientRect().height),
    /* The bar's own content box, not \`innerWidth - pad\`: a page that lays out wider
       than the screen has been shrink-fitted by the browser, and then every number
       here is in a different unit from the viewport. Which page that is gets its own
       notice below — the picker filling its bar is true either way. */
    content: Math.round(bar.clientWidth - pad),
    layoutW: Math.round(innerWidth),
    gap,
    lines: lines.map((L) => ({ top: Math.round(L.top), h: Math.round(L.bottom - L.top), items: L.items })),
    picker: shown ? { w: Math.round(sb.getBoundingClientRect().width), h: Math.round(sb.getBoundingClientRect().height), label } : null,
    /* What the picker has left of the row once the brand has taken its share, and what
       the face it is drawing actually needs there. The margin, per page — this is the
       arithmetic bc-hne3 turned on, kept pointing the other way. */
    /* The bar's own box, so this is in the same units as \`need\` on a page the browser
       has scaled (see \`content\`). */
    spare: Math.round(bar.clientWidth - pad - brandW - (actsW ? actsW + gap : 0) - gap),
    need: label && face ? label.shown + Math.round(parseFloat(getComputedStyle(face).paddingLeft) + parseFloat(getComputedStyle(face).paddingRight)) : null,
    brandW,
    actsW,
    rowH: row ? Math.round(row.getBoundingClientRect().height) : 0,
    vh: innerHeight,
  };
})()`;

/*
  What is still on screen once the page has been scrolled — and what "scrolled" even
  means now.

  Until bc-khoe.1 the page *was* the scroller and the bar was `position: sticky`, which
  pins a box at *its own* `top`; on a page whose scroll container is the viewport, `top:
  0` is the top of the window, which is behind the bar rather than below it. That was
  bc-ugd4. The shape is different now: `body` is one viewport tall and clipped, `.topbar`
  and `.viewbar` are rows of a flex column, and the one element marked `.pagescroll` is
  the only thing with `overflow-y: auto`. Nothing is laid out against a viewport, so
  nothing can be carried by one.

  So this returns three things: where the two rows are, whether the *document* has moved
  at all, and any box still pinning itself to the window with `position: sticky`. The
  first two are what bc-7utr asked for and what a phone actually feels — the bar staying
  absolutely still through a URL-bar collapse is the same geometry as it staying still
  through a scroll of the region under it. The third is a tripwire: a sticky box pinned to
  the window is how the old bug gets back in, and one appearing here means somebody has
  put the document scroller back.

  Only boxes that are actually **pinned** count — `rect.top` equal to their resolved
  `top`, within a pixel — so a strip sticky inside some *other* scroll container (the
  agents page's `.agent-tabs`, inside `.launcher`) is skipped rather than mis-flagged,
  because its `top` is measured from that container's box and not from the window's.
*/
const SHELLPROBE = `(() => {
  const bar = document.querySelector('.topbar');
  if (!bar) return { bar: false };
  const row = document.querySelector('.viewbar');
  /* The first .pagescroll that is actually **on screen**. /monitor marks three — one per
     pane — and two of them are \`hidden\` at any moment, so taking the first would measure
     a box with no height and report a page that cannot scroll. */
  const sc = [...document.querySelectorAll('.pagescroll')].find((el) => el.getBoundingClientRect().height) || null;
  const doc = document.scrollingElement || document.documentElement;
  const br = bar.getBoundingClientRect();
  const rr = row ? row.getBoundingClientRect() : null;
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  const pinned = [];
  for (const el of document.querySelectorAll('*')) {
    if (el === bar || bar.contains(el)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== 'sticky') continue;
    const want = parseFloat(cs.top);
    if (!Number.isFinite(want)) continue;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    if (Math.abs(r.top - want) > 1) continue;
    pinned.push({ sel: name(el), top: Math.round(r.top), h: Math.round(r.height) });
  }
  return {
    bar: true,
    docTop: Math.round(doc.scrollTop),
    winY: Math.round(window.scrollY),
    scroller: sc ? name(sc) : null,
    scrollerTop: sc ? Math.round(sc.scrollTop) : null,
    barTop: Math.round(br.top),
    barBottom: Math.round(br.bottom),
    rowTop: rr ? Math.round(rr.top) : null,
    rowBottom: rr ? Math.round(rr.bottom) : null,
    pinned,
  };
})()`;

/* Make the one element that scrolls actually scrollable, and scroll it. The spacer goes
   inside `.pagescroll` rather than on `<body>`, which is where it went while the body was
   the scroller: under the shell the body is clipped at one viewport and a spacer on it is
   simply invisible, so the check would pass by measuring a page that never moved. */
const SCROLLIT = `(() => {
  const sc = [...document.querySelectorAll('.pagescroll')].find((el) => el.getBoundingClientRect().height);
  if (!sc) return 0;
  const d = document.createElement('div');
  d.style.cssText = 'height:1500px';
  d.dataset.topbarCheck = '1';
  sc.append(d);
  sc.scrollTop = 400;
  return Math.round(sc.scrollTop);
})()`;

/* Every page with a picker. The admin page is deliberately not one (it acts on every
   repo at once) and the drawers — /graph, /doc, /session, /terminal — are not standing
   views, so neither carries a `.spacebar` to measure. */
/* `/prs` is the advocates page with its board chip up (bc-d4d5) rather than a page of
   its own, and it is still measured under its own path: the top bar is shared between
   the three panes now, so what this check is really asking there is that arriving by the
   board's URL does not change what the bar costs. */
const PAGES = ['/', '/monitor', '/console', '/prs', '/releases', '/endorse', '/foundations', '/config'];

/* 360px is the cheap Android the app is for and the width the trade was argued at; 393
   is the phone in the hand. Both, because a rule that only holds at one width holds by
   accident. */
const SIZES = [
  { width: 360, height: 640 },
  { width: 393, height: 852 },
];

/* ------------------------------------------------------------------- run */

let failures = 0;
const notices = [];
/* /monitor's bar with the picker's row on it, per width — what the shorter bar below is
   compared against, so the message says how much of a row was actually lost. */
const shownBarH = new Map();
const room = [];
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
/* One sentence per offender. It used to say how far behind or below the bar each one sat
   — the two directions of bc-ugd4's mistake — and under the app shell there is no such
   distance to report: a box pinning itself to the window at all is the whole finding,
   because it means the document scroller is back. */
const misfits = (st, off) =>
  `the bar ends at ${st.barBottom}px and ` +
  off.map((b) => `${b.sel} is pinned to the window at ${b.top}px — the document scroller is back`).join('; ');
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

const server = await serve();
const { port } = server.address();
const { s, close } = await launchChrome('beadcause-topbar-');
try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  for (const size of SIZES) {
    console.log(`\n\x1b[1m${size.width}×${size.height}\x1b[0m`);
    await s.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: true });
    const pickerHeights = new Map();

    for (const page of PAGES) {
      await s.send('Page.navigate', { url: `http://127.0.0.1:${port}${page}?t=topbar-check` });
      await sleep(1100);
      /* Fed rather than fetched, the way a page with its own sweep feeds it — four of
         these pages draw the bar from a payload this fixture also answers, and waiting
         on whichever path each one takes would be measuring the fixture. */
      await evalJs(s, `window.beadcause && window.beadcause.space && window.beadcause.space.adopt(${JSON.stringify(SPACEPAY)}), 1`);
      await sleep(250);
      const m = await evalJs(s, PROBE);
      const at = `${page} @${size.width}`;

      if (!m.bar) {
        bad(`${at}: the page has a top bar`);
        continue;
      }
      if (!m.picker) {
        bad(`${at}: the space picker is drawn`, 'no .spacebar — the page may have lost its <script src="/spacebar.js">');
        continue;
      }

      // One row. bc-khoe.5's whole claim, and the thing that comes back one icon at a time.
      if (m.lines.length === 1) ok(`${at}: the bar is one line, ${m.barH}px`);
      else
        bad(
          `${at}: the bar is ${m.lines.length} lines, ${m.barH}px`,
          m.lines.map((L) => L.items.map((i) => `${i.cls || '(none)'} ${i.w}px`).join(' + ')).join('  /  ')
        );

      // And the picker is on it, sharing it rather than owning it.
      const first = m.lines[0];
      const withBrand = first.items.some((i) => /spacebar/.test(i.cls || '')) && first.items.length > 1;
      if (withBrand)
        ok(`${at}: the picker shares the row (${first.items.map((i) => `${i.cls || '(none)'} ${i.w}px`).join(' + ')})`);
      else
        bad(
          `${at}: the picker shares the first row with the brand`,
          `first line is ${first.items.map((i) => `${i.cls || '(none)'} ${i.w}px`).join(' + ')}`
        );

      const L = m.picker.label;

      /* The truncation rule, over every row the picker can select rather than over
         whichever one happens to be on. Twelve characters through, nine and an ellipsis
         past that — `shorten` in public/spacebar.js. Asserted against the rule and not
         against a width, because a width is what a font change moves. */
      const longest = L.options.reduce((a, b) => (b.length > a.length ? b : a), '');
      const wrong = L.options.filter((t, i) => (t.length > 12 ? L.faces[i] !== t.slice(0, 9) + '…' : L.faces[i] !== t));
      if (!wrong.length && L.faces.every((f) => f.length <= 12))
        ok(`${at}: no face is over 12 characters (longest name "${longest}" would draw "${L.faces[L.options.indexOf(longest)]}")`);
      else bad(`${at}: no face is over 12 characters`, `these do not follow the rule: ${wrong.join(', ')}`);

      // And the one actually on the bar is the cut form of what the picker says is selected
      // — `label()`, which answers 'everything' where the option row says 'All spaces'.
      const want = L.selectedText.length > 12 ? `${L.selectedText.slice(0, 9)}…` : L.selectedText;
      if (L.shownText === want) ok(`${at}: the bar draws "${L.shownText}" for "${L.selectedText}"`);
      else bad(`${at}: the bar draws the cut form of the selection`, `it draws "${L.shownText}"; the rule says "${want}"`);

      // What is drawn is not clipped on top of being cut — a face the layout has to
      // ellipsise a second time is the rule failing to do its job.
      if (!L.clipped) ok(`${at}: the face is not clipped ("${L.shownText}", ${L.room}px of room)`);
      else bad(`${at}: the face is not clipped`, `"${L.shownText}" is ellipsised inside ${L.room}px`);

      // The dropdown is the one place the whole name is the point.
      const cut = L.options.filter((t) => /…$/.test(t));
      if (!cut.length) ok(`${at}: every row in the dropdown is a whole name (${L.options.length} of them)`);
      else bad(`${at}: every row in the dropdown is a whole name`, `cut in the list itself: ${cut.join(', ')}`);

      // One control, the same on every page — including how tall it is.
      pickerHeights.set(page, m.picker.h);
      if (page === '/monitor') shownBarH.set(size.width, m.barH);

      // The budget. It is a phone: the list is what the screen is for.
      const chrome = m.barH + m.rowH;
      const pct = Math.round((chrome / m.vh) * 100);
      if (chrome <= CHROME_BUDGET) ok(`${at}: pinned chrome ${chrome}px (${pct}% of ${m.vh}px), budget ${CHROME_BUDGET}px`);
      else bad(`${at}: pinned chrome within ${CHROME_BUDGET}px`, `bar ${m.barH}px + pill row ${m.rowH}px = ${chrome}px, ${pct}% of the screen`);

      // The premise, restated every run. Not a failure — see the header.
      room.push({ at, page, width: size.width, spare: m.spare, need: m.need, brandW: m.brandW, actsW: m.actsW });

      /* Does the page fit the screen at all? A page laying out wider than the viewport
         has been shrink-fitted by the browser, so nothing on it is the size it was
         designed at and every other number in this file is in a different unit from the
         screen it is being compared to. This was a notice while /monitor was 376px at a
         360px screen (bc-3ui6 — one negative margin against an unpadded `<body>`); that
         landed, so it is an assertion, which is the only form that stops the next one
         arriving. It costs one declaration to fail it and nobody would see it: the
         browser scales the page silently and it reads as a font being slightly wrong. */
      if (m.layoutW <= size.width) ok(`${at}: the page fits the screen (lays out at ${m.layoutW}px, unscaled)`);
      else
        bad(
          `${at}: the page fits the screen`,
          `it lays out at ${m.layoutW}px on a ${size.width}px screen, so the browser has scaled it to ${Math.round((size.width / m.layoutW) * 100)}% — something on it is wider than the body`
        );

      if (outDir) {
        const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, `topbar-${page === '/' ? 'inbox' : page.slice(1)}-${size.width}.png`), Buffer.from(data, 'base64'));
      }

      /* Last, because it hangs a spacer inside the scroller and scrolls it. Where the two
         rows are is read *before* and *after*, because "the bar is at 0" proves nothing on
         a page that never moved — what bc-7utr is about is the difference. */
      const before = await evalJs(s, SHELLPROBE);
      const moved = await evalJs(s, SCROLLIT);
      await sleep(250);
      const st = await evalJs(s, SHELLPROBE);
      if (!moved) ok(`${at}: the page has no .pagescroll to scroll — nothing here can move`);
      else {
        const still =
          st.barTop === before.barTop && st.barBottom === before.barBottom &&
          st.rowTop === before.rowTop && st.rowBottom === before.rowBottom;
        if (still) ok(`${at}: the bar and the pill row do not move (scroller at ${st.scrollerTop}px, bar ${st.barTop}–${st.barBottom}, row ${st.rowTop}–${st.rowBottom})`);
        else
          bad(
            `${at}: the bar and the pill row do not move`,
            `at ${st.scrollerTop}px down ${st.scroller}, the bar went ${before.barTop}–${before.barBottom} → ${st.barTop}–${st.barBottom} and the row ${before.rowTop}–${before.rowBottom} → ${st.rowTop}–${st.rowBottom}`
          );
        /* And the document itself did not move, which is the declaration all of the above
           rests on — a page that scrolls as a document can pass the comparison above on a
           desktop Chrome and still drift under a collapsing iOS URL bar. */
        if (!st.docTop && !st.winY) ok(`${at}: the document does not scroll (${st.scroller} is the only thing that does)`);
        else bad(`${at}: the document does not scroll`, `document.scrollingElement is at ${st.docTop}px and window.scrollY is ${st.winY}`);
      }
      {
        const off = st.pinned || [];
        if (!off.length) ok(`${at}: nothing pins itself to the window`);
        else bad(`${at}: nothing pins itself to the window`, misfits(st, off));
      }

      /*
        And the acceptance itself: the longest name in the config actually *selected*.

        Everything above is measured on `All spaces`, which is ten characters and cuts to
        nothing — so without this the whole truncation rule could be deleted and every
        assertion in this file would still pass. Picked through the control rather than by
        calling `space.set`, because what is being asked is what a person's tap does.
      */
      const picked = await evalJs(
        s,
        `(() => {
           const sel = document.querySelector('#space-pick');
           const opt = [...sel.options].reduce((a, b) => (b.textContent.length > a.textContent.length ? b : a));
           sel.value = opt.value;
           sel.dispatchEvent(new Event('change'));
           return opt.textContent;
         })()`
      );
      await sleep(250);
      const long = await evalJs(s, PROBE);
      const lat = `${at}, "${picked}" picked`;
      const wanted = picked.length > 12 ? `${picked.slice(0, 9)}…` : picked;
      if (long.picker && long.picker.label.shownText === wanted)
        ok(`${lat}: the bar draws "${long.picker.label.shownText}"`);
      else bad(`${lat}: the bar draws the cut form`, `it draws "${long.picker?.label?.shownText}"; the rule says "${wanted}"`);
      if (long.lines.length === 1) ok(`${lat}: the bar is still one line, ${long.barH}px`);
      else
        bad(
          `${lat}: the bar is still one line`,
          long.lines.map((L) => L.items.map((i) => `${i.cls || '(none)'} ${i.w}px`).join(' + ')).join('  /  ')
        );
      if (long.picker && !long.picker.label.clipped) ok(`${lat}: and the face is not clipped on top of being cut`);
      else bad(`${lat}: the face is not clipped on top of being cut`, `"${long.picker?.label?.shownText}" is ellipsised`);
    }

    /*
      And the same thing again with the picker gone, on the one page that has a strip
      stuck to the bar.

      `spacebar.js` hides the picker outright below two workspaces (`el.hidden`), and this
      used to take the bar from 104px to 61px on the same build and the same page — which
      is the whole reason the strip's offset is a variable and not a number: a `top: 104px`
      hardcoded from a screenshot passed every assertion above and left a 43px hole between
      the bar and the strip for anybody running one repo, who is, incidentally, everybody
      on their first day.

      Since bc-khoe.5 the two heights are the same, because the picker shares the mark's
      row rather than owning one. That does not make this pass pointless — it makes it the
      thing that would notice if the picker ever went back to being a row, and it is still
      the only run in this file where the bar is drawn without one. Measured rather than
      reasoned about, because these are the two states it actually ships in.
    */
    {
      const ONE = { ...SPACEPAY, workspaces: ['beadcause'], spaces: [{ name: 'Personal', workspaces: ['beadcause'], count: 3, quiet: false }] };
      await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/monitor?t=topbar-check-one` });
      await sleep(1100);
      await evalJs(s, `window.beadcause && window.beadcause.space && window.beadcause.space.adopt(${JSON.stringify(ONE)}), 1`);
      await sleep(250);
      const m = await evalJs(s, PROBE);
      const at = `/monitor @${size.width}, one workspace`;
      if (m.picker) {
        bad(`${at}: the picker hides itself`, `it is still drawn at ${m.picker.w}px — see el.hidden in public/spacebar.js`);
      } else {
        {
          const was = shownBarH.get(size.width);
          /* Same height either way since bc-khoe.5, and that is the answer rather than a
             hole in the check: the picker is a control on the mark's row now, so hiding it
             takes width off that row and no longer takes a row off the bar. It used to be
             104px → 61px, which is the whole reason the strip below the bar offsets itself
             from a variable and not from a number read off a screenshot. */
          ok(
            was === m.barH
              ? `${at}: the picker hides itself, and the bar is ${m.barH}px — the same as with it, because it is not a row of its own any more`
              : `${at}: the picker hides itself, and the bar is ${m.barH}px rather than ${was ?? '?'}px`
          );
        }
        const before = await evalJs(s, SHELLPROBE);
        await evalJs(s, SCROLLIT);
        await sleep(250);
        const st = await evalJs(s, SHELLPROBE);
        /* The pill row sits against the picker-less bar, and stays there through a scroll.
           A hole between the two is what a hardcoded offset used to buy on the day the
           picker hid itself, and it is still the shape of the mistake worth catching. */
        if (st.rowTop === st.barBottom && st.rowTop === before.rowTop)
          ok(`${at}: the pill row sits against the picker-less bar at ${st.rowTop}px and stays there`);
        else
          bad(
            `${at}: the pill row sits against the picker-less bar and stays there`,
            `the bar ends at ${st.barBottom}px, the row starts at ${st.rowTop}px (was ${before.rowTop}px before the scroll)`
          );
        const off = st.pinned || [];
        if (off.length) bad(`${at}: nothing pins itself to the window`, misfits(st, off));
      }
    }

    const heights = [...new Set(pickerHeights.values())];
    if (heights.length === 1) ok(`@${size.width}: the picker is the same ${heights[0]}px on all ${pickerHeights.size} pages`);
    else
      bad(
        `@${size.width}: the picker is the same height on every page`,
        [...pickerHeights].map(([p, h]) => `${p} ${h}px`).join(', ')
      );
  }

  /*
    The margin, restated every run. bc-hne3 printed this to ask whether the picker could
    ever come up onto the first row; it is on that row now, so the same numbers say how
    much room is left before it is pushed back off — and what would push it is a page
    growing its *title*, which is the half of the row nobody measures on purpose.

    A notice rather than a failure while there is any room at all: the line count above is
    the assertion, and this is the thing that would have told you a week earlier.
  */
  console.log('\n\x1b[1mthe row, and what is left of it for the picker\x1b[0m');
  for (const r of room)
    console.log(
      `  · ${r.at}: ${r.spare}px left (brand ${r.brandW}${r.actsW ? ` + actions ${r.actsW}` : ''}), the face takes ${r.need}px — ${r.spare >= r.need ? `${r.spare - r.need}px to spare` : `\x1b[31mover by ${r.need - r.spare}px\x1b[0m`}`
    );
  for (const size of SIZES) {
    const mine = room.filter((r) => r.width === size.width);
    const tight = mine.filter((r) => r.spare - r.need < 24);
    if (!tight.length)
      notices.push(
        `· @${size.width}: every page has at least 24px of slack on the row. Nothing is close.`
      );
    else
      notices.push(
        `\x1b[33m!\x1b[0m @${size.width}: ${tight.length} of ${mine.length} pages have under 24px of slack (${tight.map((r) => r.page).join(', ')}) — one longer title and the bar is two rows again.`
      );
  }

  console.log('\n\x1b[1mhow close the row is to wrapping\x1b[0m');
  for (const n of notices) console.log(`  ${n}`);
} finally {
  close();
  server.close();
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mthe top bar holds its budget\x1b[0m');
