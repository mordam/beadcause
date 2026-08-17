#!/usr/bin/env node
//
// The epic board is a grid, and a card opens full-tab.
//
//   node scripts/p0grid-check.mjs [--baseline] [--out=<dir>]
//
// bc-grut. The board was a single vertical stack of full-width cards at every width, on a
// premise the CSS comment stated outright — "these are the four or five things the week is
// about". It has never been four or five: every open owned P0 until bc-6s96, about two
// dozen on this tracker, and the ones you have started since. What that produced was a
// long scroll on a phone and a narrow ribbon down an empty desktop, with a tapped card
// unfolding its tree inline between the board and the inbox list.
//
// test/p0card.mjs holds the renderer: what markup each state produces, that only one tab
// is drawn, that the collapsed card's numbers do not move when the filter does. Everything
// this file checks is a *measurement* it cannot make, and every one of them is green in
// that suite while being wrong on the screen:
//
//   • **One column, then two, then three.** `grid-template-columns` is a declaration; how
//     many cards actually share a row is geometry, and the two come apart in the one way
//     that matters here. A grid track's automatic minimum is its content, so `1fr` rather
//     than `minmax(0, 1fr)` lets a column bid wider than its share on an unbroken
//     60-character bead title and pushes the third card onto a row of its own — with the
//     rule in the stylesheet, the declaration asserted, and the layout wrong. Read as the
//     cards' own `left` edges: one row is one distinct `top`.
//   • **The controls line up across a row.** Cards in a grid line stretch to the tallest,
//     so an advocate button that followed each card's own last line of text would step up
//     and down across the board. `margin-top: auto` is what fixes it, and only a rendered
//     board of unequal titles shows whether it took.
//   • **The tab actually covers the tab.** `.p0-full` is `position: fixed` inside `#list`,
//     which is where it must be — every handler on this page is delegated from that
//     element — and a fixed layer is defeated by any ancestor with a `transform`, a
//     `filter` or `contain` on it. That failure is invisible to a renderer test and to the
//     stylesheet rule alike: the markup is right, the rule is right, and the sheet is a
//     box halfway down the page. Read as the layer's own bounding rect against the
//     viewport.
//   • **The board does not scroll out from under the tap** — bc-rfnr.9.9, which this bead
//     ends by construction rather than by correction. The old expansion inserted several
//     hundred pixels above the inbox list, and `capturePlace` anchors on the first `.card`
//     there and faithfully scrolled the page down to hold it still. Read as the tapped
//     card's own `top` before and after, which is the same way that bug was measured.
//   • **And the way back leaves you where you were**, which is the other end of it.
//
// Same shape as p0fold-check.mjs: the real public/app.js in a headless Chrome, against
// fixtures served from this process, so it never touches a daemon, a bead or iTerm. Two
// viewports rather than one, because the whole first claim is about the difference between
// them. `--baseline` serves the committed app.js and style.css, which have never heard of
// the grid, so it must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const PHONE = { width: 393, height: 852, dpr: 3 };
const DESK = { width: 1280, height: 900, dpr: 2 };
const TOKEN = 'p0grid-check-token';
const BASELINE = process.argv.includes('--baseline');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
for (const v of ['marked.js', 'purify.js']) {
  if (!fs.existsSync(path.join(PUBLIC, 'vendor', v))) {
    console.error(`public/vendor/${v} is missing — run \`npm run vendor\` first.`);
    process.exit(1);
  }
}

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const BASELINED = ['/app.js', '/style.css'];
const committed = (rel) => execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`]);

/* ---------------------------------------------------------------- fixtures */

const WS = 'alpha';

/**
 * Six epics, which is the number this is about — three columns is a claim you cannot make
 * with two cards, and the wrap onto a second row is where a bad track minimum shows.
 *
 * The titles are deliberately unequal, and one of them is a single unbroken 62-character
 * token. That token is the whole reason `minmax(0, 1fr)` is in the stylesheet: with a
 * plain `1fr` its column bids for its content's width and takes room off its neighbours.
 * The unequal ones are what make `margin-top: auto` on the acts row visible.
 */
const P0S = [
  { id: 'a-p0', title: 'Make the phone the whole interface', done: 2, of: 5, asks: 1 },
  { id: 'b-p0', title: 'Everything an agent decides is a bead, and every bead is a card you can answer from a train', done: 7, of: 9, asks: 0 },
  { id: 'c-p0', title: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', done: 0, of: 4, asks: 2 },
  { id: 'd-p0', title: 'The release queue', done: 3, of: 3, asks: 0 },
  { id: 'e-p0', title: 'One inbox for every workspace on the Mac', done: 1, of: 6, asks: 0 },
  { id: 'f-p0', title: 'Compliance, as a register rather than as a document', done: 4, of: 8, asks: 1 },
];

const bead = (id, title) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: 'A short brief, with nothing clever in it.',
});

/**
 * Enough inbox rows under the first epic to put the list well past a screen.
 *
 * That is not scenery: bc-rfnr.9.9 is the page scrolling to hold the first `.card` still
 * while something above it grows, and a list too short to scroll cannot show it either
 * way. Ten rows is comfortably past 852px.
 */
const QUESTIONS = Array.from({ length: 10 }, (_, i) => ({
  ...toQuestion(WS, bead(`a-p0.${i + 1}`, `A child of a-p0, number ${i + 1}`)),
  space: 'Work',
  comments: [],
}));

/** One epic's descendants — `done` closed, the rest open, `asks` of them questions. */
const treeFor = (p) =>
  Array.from({ length: p.of }, (_, i) => ({
    id: `${p.id}.${i + 1}`,
    title: `A child of ${p.id}, number ${i + 1}`,
    status: i < p.done ? 'closed' : 'open',
    parent: p.id,
    depth: 1,
    key: `${WS}/${p.id}.${i + 1}`,
    pending: i >= p.done && i < p.done + p.asks,
  }));

/** The board, as `p0Card` in lib/server.js builds it — trees and all, since bc-rfnr.9.1. */
const board = () => ({
  owned: true,
  under: Object.fromEntries(QUESTIONS.map((q, i) => [`${WS}/a-p0.${i + 1}`, 'a-p0'])),
  unhomed: {},
  p0s: P0S.map((p) => {
    const tree = treeFor(p);
    return {
      key: `${WS}/${p.id}`,
      workspace: WS,
      id: p.id,
      title: p.title,
      status: 'open',
      issue_type: 'epic',
      owners: ['adam'],
      open: tree.filter((r) => r.status !== 'closed').length,
      inFlight: 0,
      waitingOn: null,
      advocate: null,
      tree,
    };
  }),
});

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const read = (fn) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => fn(JSON.parse(body || '{}')));
    };

    if (p === '/api/questions') {
      return json({
        questions: QUESTIONS,
        requests: [],
        workspaces: [WS],
        spaces: [{ name: 'Work', workspaces: [WS], quiet: false, muted: false, count: QUESTIONS.length }],
        filter: { space: 'all', workspace: 'all' },
        p0board: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    if (p.startsWith('/api/')) {
      if (req.method === 'POST') return void read(() => json({}));
      return json({});
    }

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return void res.writeHead(404).end('no');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-p0grid-');

const evalJs = async (expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 150; i++) {
    if (await evalJs(expr)) return true;
    await sleep(150);
  }
  return false;
};

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `p0grid-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The board and the tab, as geometry.
 *
 * `rowsOf` is the count of *distinct card tops* — that is what "three across" means, and
 * it is the number a declaration cannot give you. `perRow` is the first row's width, so a
 * board that wrapped one card early is a different number rather than the same one.
 *
 * `full` is the open tab's rect against the viewport. Read as a rect rather than as a
 * class because the failure this is here for is a `position: fixed` defeated by an
 * ancestor's `transform` — every rule right, every attribute right, and the sheet a box
 * halfway down the page.
 */
const SECTION = `(() => {
  const cards = [...document.querySelectorAll('.p0-cards .p0-card')];
  const box = (el) => el.getBoundingClientRect();
  const tops = cards.map((c) => Math.round(box(c).top));
  const rows = [...new Set(tops)].sort((a, b) => a - b);
  const acts = cards.map((c) => c.querySelector('.p0-acts')).filter(Boolean);
  const full = document.querySelector('.p0-full');
  const f = full ? box(full) : null;
  return {
    cards: cards.length,
    rows: rows.length,
    perRow: rows.length ? tops.filter((t) => t === rows[0]).length : 0,
    lastRow: rows.length ? tops.filter((t) => t === rows[rows.length - 1]).length : 0,
    // Every card on the first row, and the bottom edge of each one's controls. Equal is
    // the claim: a grid item stretches to its row, so unequal means \`margin-top: auto\`
    // is not doing its work and the buttons step with the titles.
    actBottoms: [...new Set(acts.filter((a) => Math.round(box(a.closest('.p0-card')).top) === rows[0]).map((a) => Math.round(box(a).bottom)))],
    widest: Math.round(Math.max(0, ...cards.map((c) => box(c).right))),
    docWide: document.documentElement.scrollWidth,
    viewWide: window.innerWidth,
    viewTall: window.innerHeight,
    full: full ? {
      top: Math.round(f.top), left: Math.round(f.left),
      right: Math.round(f.right), bottom: Math.round(f.bottom),
      opaque: getComputedStyle(full).backgroundColor,
      fixed: getComputedStyle(full).position,
    } : null,
    trees: document.querySelectorAll('.p0-tree').length,
    back: document.querySelectorAll('.p0-full .p0-back').length,
    bars: document.querySelectorAll('.p0-cards .p0-bar').length,
    asks: [...document.querySelectorAll('.p0-cards .p0-asks')].map((n) => (n.textContent || '').trim()),
    hints: [...document.querySelectorAll('.p0-cards .p0-hint')].map((n) => (n.textContent || '').trim()),
    scrollY: Math.round(window.scrollY),
  };
})()`;

/**
 * One card's own top, by index on the grid — the same reading bc-rfnr.9.9 was measured as.
 *
 * `null` rather than a throw when there is no grid, so that `--baseline` — which serves an
 * app.js that has never heard of `.p0-cards` — reports every check as failed instead of
 * dying halfway with a `TypeError` that reads as a broken harness.
 */
const cardTop = (i) =>
  evalJs(`(() => {
    const c = document.querySelectorAll('.p0-cards .p0-card')[${i}];
    return c ? Math.round(c.getBoundingClientRect().top) : null;
  })()`);

const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};

/**
 * Move to a viewport and load the board there.
 *
 * The wait on `innerWidth` is load-bearing rather than belt and braces. The override and
 * the navigation are two round trips, and this check's whole subject is what the layout
 * does at a width — so a `SECTION` read taken before the emulation has landed measures the
 * *previous* viewport and passes or fails for a reason that has nothing to do with the
 * diff. Seen once while writing this, as `393px` reading back `497px`.
 */
const at = async (vp) => {
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width, height: vp.height, deviceScaleFactor: vp.dpr,
    mobile: vp.width < 700, screenWidth: vp.width, screenHeight: vp.height,
  });
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-card') !== null`, 15000);
  if (!(await waitFor(`window.innerWidth === ${vp.width}`, 5000))) {
    throw new Error(`the viewport never became ${vp.width}px — ${await evalJs('window.innerWidth')}px`);
  }
  // Chrome restores the scroll offset when it is navigated to a URL it already has, so
  // the second and third viewports would otherwise start halfway down the inbox — which
  // reads as the board having moved, and puts the board off the top of every screenshot.
  await evalJs('window.scrollTo(0, 0)');
  await sleep(300);
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${BASE}\n`);

  /* ---- one column, on the screen the app is for ---- */

  await at(PHONE);
  let v = await evalJs(SECTION);
  check('six epics are on the board', v.cards === 6, `${v.cards} cards`);
  check('one across on a 393px phone', v.perRow === 1 && v.rows === 6, `${v.perRow} per row over ${v.rows} rows`);
  check('and nothing overflows it', v.docWide <= v.viewWide && v.widest <= v.viewWide, `${v.docWide}px in ${v.viewWide}px`);

  /* ---- what a card says while it is shut, which is the point of scanning a grid ---- */

  check('every card carries a progress bar', v.bars === 6, `${v.bars} bars`);
  check(
    'and the two numbers beside it, counted over the whole tree',
    v.hints.includes('2 of 5 done') && v.hints.includes('7 of 9 done') && v.hints.includes('0 of 4 done'),
    v.hints.join(' | ')
  );
  check(
    'the epics with questions under them say so, and only those',
    v.asks.length === 3 && v.asks.includes('1 asks you') && v.asks.includes('2 ask you'),
    v.asks.join(' | ') || 'none'
  );
  await shot('phone');

  /* ---- the tab, which is where the tree went ---- */

  const before = await cardTop(0);
  await press('.p0-cards .p0-card .p0-tap');
  await sleep(500);
  v = await evalJs(SECTION);
  check('a tap opens the epic into a tab of its own', v.trees === 1 && v.back === 1 && !!v.full, `${v.trees} trees`);
  check(
    'and the tab fills the tab — every edge of it is the viewport',
    v.full && v.full.top === 0 && v.full.left === 0 && v.full.right === v.viewWide && v.full.bottom === v.viewTall,
    v.full ? `${v.full.left},${v.full.top} → ${v.full.right},${v.full.bottom} in ${v.viewWide}x${v.viewTall}` : 'no tab'
  );
  // A fixed layer inside `#list` is defeated by any ancestor with a transform, a filter or
  // `contain` — every rule right, every attribute right, and the sheet a box halfway down.
  check('by being fixed against the viewport rather than placed in the list', v.full?.fixed === 'fixed', v.full?.fixed || '');
  // Opaque: this is a place you went, not a dialog over a place you were, and the inbox
  // showing through under a sixty-row tree is the cramped read the bead is about.
  check('and opaque, so the inbox is not showing through the tree', /^rgba?\([^)]*(?:,\s*1)?\)$/.test(v.full?.opaque || '') && !/,\s*0(\.\d+)?\)$/.test(v.full?.opaque || ''), v.full?.opaque || '');

  /* ---- bc-rfnr.9.9: the board must not move under the thumb ---- */

  check('the page did not scroll out from under the tap', v.scrollY === 0, `scrollY ${v.scrollY}`);
  await press('.p0-full .p0-back');
  await sleep(500);
  const after = await cardTop(0);
  check('and the card you tapped is exactly where you tapped it', before !== null && before === after, `top ${before} → ${after}`);
  v = await evalJs(SECTION);
  check('the tab is gone and the board is back', !v.full && v.trees === 0 && v.cards === 6);

  /* ---- three across, on the screen the board was a ribbon on ---- */

  await at(DESK);
  v = await evalJs(SECTION);
  check('three across on a 1280px desktop', v.perRow === 3, `${v.perRow} per row`);
  check('so six epics are two rows rather than six', v.rows === 2 && v.lastRow === 3, `${v.rows} rows, ${v.lastRow} on the last`);
  check(
    'and the controls line up across the row rather than following each title',
    v.actBottoms.length === 1,
    `${v.actBottoms.length} different bottoms: ${v.actBottoms.join(', ')}`
  );
  // The one that `grid-template-columns` alone does not buy: a track's automatic minimum
  // is its content, so `1fr` on a 62-character unbroken title takes room off its
  // neighbours and puts the third card on a row of its own.
  check('an unbreakable title does not push its neighbours off the row', v.docWide <= v.viewWide, `${v.docWide}px in ${v.viewWide}px`);
  await shot('desktop');

  await press('.p0-cards .p0-card .p0-tap');
  await sleep(500);
  v = await evalJs(SECTION);
  check(
    'and the tab still fills the tab at desktop width',
    v.full && v.full.top === 0 && v.full.right === v.viewWide && v.full.bottom === v.viewTall,
    v.full ? `${v.full.right}x${v.full.bottom} in ${v.viewWide}x${v.viewTall}` : 'no tab'
  );
  await shot('desktop-open');

  /* ---- two across in between, which is the whole reason there are three breakpoints ---- */

  await at({ width: 760, height: 900, dpr: 2 });
  v = await evalJs(SECTION);
  check('two across at 760px', v.perRow === 2 && v.rows === 3, `${v.perRow} per row over ${v.rows} rows`);
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
// A baseline run must fail: it is serving a page from before the grid existed. Once the
// branch is committed, `HEAD` *is* the working copy and a baseline run is the check
// comparing a file with itself — which passes, and means nothing. Say so rather than
// letting a green line stand in for evidence. (`git reset --soft HEAD~1`, run it, then
// `git commit -C ORIG_HEAD` is how to re-measure after the fact.)
if (BASELINE && !failed) {
  console.log('BASELINE PASSED — this check proves nothing. Run it before committing.');
  process.exit(1);
}
process.exit(BASELINE ? 0 : failed ? 1 : 0);
