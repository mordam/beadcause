#!/usr/bin/env node
//
// The inbox's bead search box, on a phone.
//
//   node scripts/beadsearch-check.mjs [--baseline] [--shots]
//
// bc-0xil put a typeahead in the filter panel: type part of a bead id, click a match,
// and the inbox narrows to that bead and everything under it, with a pill and an × to
// undo it. `node test/beadsearch.mjs` drives the same control through a hand-made
// document and covers the logic exhaustively. What it cannot see is the half that only
// exists once there is a layout, and every item below is one of those:
//
//   • **the dropdown must not push the panel around.** It is absolutely positioned so it
//     draws *over* whatever is below it in the panel; if it ever laid out in flow, the
//     controls under it would slide down under the thumb reaching for them, and on a
//     phone the panel would grow past the bottom of the screen. Measured as the panel's
//     height not changing — it used to be measured against the kind chips, and bc-khoe.2
//     moved those out onto the pill row.
//   • **the × has to be a target.** The glyph is 15px. The button around it is 22 square,
//     and a control that removes a filter is the worst one to miss — you are left with a
//     narrowed list and a control that looks broken.
//   • **the input has to be 16px.** Anything smaller and iOS zooms the page in on focus,
//     which moves an absolutely positioned panel out from under itself. It inherits that
//     from `.filter-text`, and inheriting is exactly the kind of thing a wrapper breaks.
//   • **it has to fit.** The panel is `min(420px, 100vw - 32px)` and the box, the pills
//     and the dropdown are all inside it; a bead id in a monospace pill is the widest
//     thing that has ever been in there.
//   • **and the list actually has to narrow, and come back.** The end-to-end tap, through
//     the real `/api/beads` and `/api/bead/tree` shapes.
//
// Real public/*.js and public/style.css in a headless Chrome the size of a phone, against
// fixtures served from this process — nothing here touches a real bead or needs a daemon.
//
// `--baseline` serves the committed public/, which is how you tell a real failure from a
// flaky one: at baseline there is no box at all and every case must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchBeads } from '../lib/beadsearch.js';
import { toQuestion } from '../lib/decision.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'beadsearch-check-token';
const BASELINE = process.argv.includes('--baseline');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, '.claude', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'purify.js'))) {
  console.error('public/vendor is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const WS = 'demo';

/**
 * A small tracker: one epic, two children, and two beads with nothing to do with it.
 *
 * The two strangers are the point of the fixture — narrowing to the epic has to take
 * them off the screen, and taking the pill back off has to bring them back.
 */
const GRAPH = [
  { id: 'bc-rfnr', title: 'The inbox is a P0 board', status: 'open', workspace: WS },
  { id: 'bc-rfnr.1', title: 'An owner is a label, not an assignee', status: 'open', workspace: WS },
  { id: 'bc-rfnr.2', title: 'The inbox leads with the P0s you own', status: 'open', workspace: WS },
  { id: 'bc-qid9', title: 'What a picked bead filters to', status: 'open', workspace: WS },
  { id: 'bc-s557', title: 'Match bead ids only, or titles too', status: 'open', workspace: WS },
];
const TREE = { 'bc-rfnr': ['bc-rfnr', 'bc-rfnr.1', 'bc-rfnr.2'] };

/**
 * Every bead above as an inbox row, so the list has something to narrow.
 *
 * Through `toQuestion` rather than hand-shaped, for the reason every other check does it:
 * that is the function the daemon builds a row with, and a row assembled a second way
 * here would drift from the one the phone actually gets.
 */
const QUESTIONS = GRAPH.map((b) => ({
  ...toQuestion(WS, {
    id: b.id,
    title: b.title,
    issue_type: 'task',
    status: 'open',
    priority: 2,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    comment_count: 0,
    dependent_count: 0,
    description: 'Which way should this go?',
  }),
  comments: [],
}));

/* ------------------------------------------------------------------ server */

/** `warming` on demand, so the cold-daemon sentence can be provoked rather than waited for. */
const state = { warming: 0, searches: [], trees: [] };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const BASE_FILES = ['/app.js', '/style.css', '/index.html', '/filtermenu.js', '/inboxfilter.js'];
const committed = (p) => {
  try {
    return execFileSync('git', ['show', `HEAD:public${p}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({
        questions: QUESTIONS,
        requests: [],
        consoles: [],
        workspaces: [WS],
        spaces: [],
        scope: 'human',
        // `owned: false` — the P0 board's own narrowing is off, so what the list does is
        // the bead filter and nothing else. The two are asserted against each other in
        // test/beadsearch.mjs; here the question is whether the tap works.
        p0board: { p0s: [], under: {}, unhomed: {}, owned: false },
        summary: { questions: QUESTIONS.length, sessions: 0, proposals: 0 },
        seq: 1,
      });
    }
    // The real ranking, not a stub of it: the dropdown's order is half of what makes the
    // box usable, and a fixture that sorted its own way would hide a regression in it.
    if (p === '/api/beads') {
      const q = url.searchParams.get('q') || '';
      state.searches.push(q);
      return json({ beads: searchBeads(GRAPH, q), warming: state.warming, q });
    }
    if (p === '/api/bead/tree') {
      const id = url.searchParams.get('id') || '';
      state.trees.push(id);
      const keys = (TREE[id] || [id]).map((x) => `${WS}/${x}`);
      return json({ workspace: WS, id, title: '', keys });
    }
    if (p === '/api/poll') {
      // Parked the way the daemon parks it, or the page restarts the long poll the
      // instant it answers and spins at full speed against this stub.
      const timer = setTimeout(() => json({ events: [], seq: 1 }), 30_000);
      return req.on('close', () => clearTimeout(timer));
    }
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/' ? '/index.html' : p;
    if (BASELINE && BASE_FILES.includes(rel)) {
      const bodyOut = committed(rel);
      if (!bodyOut) return res.writeHead(404).end('no');
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || TYPES['.html'] });
      return res.end(bodyOut);
    }
    const file = path.join(PUBLIC, rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return res.writeHead(404).end('no');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- probes */

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

const waitFor = async (s, expr, tries = 60, gap = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(gap);
  }
  return false;
};

const tap = (s, sel) => evalJs(s, `(document.querySelector(${JSON.stringify(sel)}) || { click(){} }).click(), true`);

/** Type into the box the way a person does: the value, then the event the page listens for. */
const typeInto = (s, text) =>
  evalJs(
    s,
    `(() => {
      const el = document.querySelector('.filter-typeahead .filter-text');
      if (!el) return false;
      el.focus();
      el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`
  );

const cards = (s) => evalJs(s, `[...document.querySelectorAll('#list .card[data-key]')].map((c) => c.dataset.key)`);

const suggestions = (s) =>
  evalJs(s, `[...document.querySelectorAll('.suggest-row')].map((r) => r.querySelector('.suggest-id').textContent)`);

/**
 * Everything the layout can get wrong about the box, in one round trip.
 *
 * The kind chips are found by `.chip-row.kinds` and not by `[data-group="kind"]`:
 * filtermenu.js writes the group id into the class as `chip-row <id>s`, which is the name
 * the stylesheet has always keyed off, while the `data-group` attribute is written through
 * `dataset` — so a selector on it is one `scripts/checks.mjs --audit` cannot see.
 *
 * (And the explanation lives out here rather than inside the template literal below, where
 * a `${...}` in prose is not a comment but an interpolation the tag tries to evaluate.)
 */
const GEOMETRY = `(() => {
  const wrap = document.querySelector('.filter-typeahead');
  if (!wrap) return null;
  const input = wrap.querySelector('.filter-text');
  const list = wrap.querySelector('.suggest');
  const panel = document.querySelector('.filter-panel');
  const r = (el) => (el ? el.getBoundingClientRect() : null);
  const ib = r(input), lb = r(list), pb = r(panel);
  return {
    fontPx: Math.round(parseFloat(getComputedStyle(input).fontSize)),
    listShown: !!(list && !list.hidden),
    listPosition: list ? getComputedStyle(list).position : null,
    inputRight: ib ? Math.round(ib.right) : null,
    listRight: lb ? Math.round(lb.right) : null,
    panelRight: pb ? Math.round(pb.right) : null,
    panelBottom: pb ? Math.round(pb.bottom) : null,
    // "Over, not above" is measured as the panel not growing. It used to be measured as
    // the list's box overlapping the kind chips' row — and bc-khoe.2 promoted the kinds
    // out of this panel and onto the pill row, so that box no longer exists and the
    // assertion read false for the one reason it was never about. The panel's own height
    // is the property that was always meant: an absolutely-positioned dropdown draws
    // over whatever is under it and reflows nothing, whichever group happens to be
    // under it that week.
    panelH: pb ? Math.round(pb.height) : null,
    fits: !!(ib && pb && ib.right <= pb.right + 1 && ib.left >= pb.left - 1),
  };
})()`;

const PILLS = `(() => [...document.querySelectorAll('.pill-row .pill')].map((p) => {
  const x = p.querySelector('.pill-x');
  const b = x ? x.getBoundingClientRect() : null;
  const pb = p.getBoundingClientRect();
  return {
    id: p.dataset.pick,
    label: (p.querySelector('.pill-label') || {}).textContent || '',
    label2: x ? x.getAttribute('aria-label') : '',
    w: b ? Math.round(b.width) : 0,
    h: b ? Math.round(b.height) : 0,
    onScreen: pb.right <= ${VP.width} + 1 && pb.width > 0,
  };
}))()`;

let shotN = 0;
async function shot(s, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(SHOT_DIR, `beadsearch-${String(++shotN).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`    · ${out}`);
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-beadsearch-');

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD:public/)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  if (!(await waitFor(s, `!!document.querySelector('#list .card[data-key]')`)))
    throw new Error('the inbox never rendered');
  // Nothing is stored, so the box is empty on every load — the filter panel simply has
  // to be open for any of this to be reachable.
  await tap(s, '.filter-summary');
  await sleep(150);

  /* ============================================================ 1. it is there */

  console.log('the box, in the panel');

  const cold = await evalJs(s, GEOMETRY);
  await shot(s, 'panel-open');
  check('the box is drawn inside the filter panel', Boolean(cold), cold ? '' : 'no .filter-typeahead');
  check(
    'at 16px, so focusing it does not zoom iOS in on the panel',
    cold?.fontPx === 16,
    `${cold?.fontPx}px`
  );
  check('and it fits the panel at phone width', cold?.fits === true, `input right ${cold?.inputRight} / panel ${cold?.panelRight}`);
  check('with no list until something is typed', cold?.listShown === false, `shown=${cold?.listShown}`);

  /* ========================================================= 2. typing narrows */

  console.log('\ntyping');

  await typeInto(s, 'rfnr');
  // For *these* results and not merely for some: the last query's rows are still on
  // screen until the next answer lands, so waiting on "any row" taps a stale one.
  await waitFor(s, `!!document.querySelector('.suggest-row[data-suggest="${WS}/bc-rfnr"]')`);
  const offered = await suggestions(s);
  const open = await evalJs(s, GEOMETRY);
  await shot(s, 'dropdown');

  check('the matches drop down', offered.length === 3, offered.join(', '));
  check(
    'the bead you named leads, ahead of its own children',
    offered[0] === 'bc-rfnr',
    offered.join(', ')
  );
  check(
    'the list draws *over* the panel rather than pushing it open',
    open?.listPosition === 'absolute' && open?.panelH === cold?.panelH,
    `position ${open?.listPosition}, panel ${cold?.panelH}px -> ${open?.panelH}px`
  );
  check(
    'and it stays inside the panel, squared up with the box above it',
    (open?.listRight ?? 0) <= (open?.panelRight ?? -1) && open?.listRight === open?.inputRight,
    `list ${open?.listRight}, input ${open?.inputRight}, panel ${open?.panelRight}`
  );

  // One request per word, not one per letter — four letters typed the way a person types
  // them, in one round trip. Four separate CDP calls would each take longer than the
  // debounce and measure this driver rather than the page.
  state.searches.length = 0;
  await evalJs(
    s,
    `(() => {
      const el = document.querySelector('.filter-typeahead .filter-text');
      // At --baseline there is no box. Every check below must then *fail*, which is the
      // point of that flag — a throw here would end the run instead, and a run that
      // stopped early is not evidence about the checks it never reached.
      if (!el) return false;
      for (const t of ['q', 'qi', 'qid', 'qid9']) {
        el.value = t;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`
  );
  await sleep(700);
  check('four keystrokes are one request, not four', state.searches.length === 1, `${state.searches.length}: ${state.searches.join(',')}`);

  /* ============================================================= 3. the pick */

  console.log('\npicking one');

  await typeInto(s, 'rfnr');
  // For *these* results and not merely for some: the last query's rows are still on
  // screen until the next answer lands, so waiting on "any row" taps a stale one.
  await waitFor(s, `!!document.querySelector('.suggest-row[data-suggest="${WS}/bc-rfnr"]')`);
  await tap(s, '.suggest-row');
  await waitFor(s, `document.querySelectorAll('.pill-row .pill').length > 0`);
  await sleep(400);
  const pills = await evalJs(s, PILLS);
  const narrowed = await cards(s);
  await shot(s, 'picked');

  check('a pill appears, naming the bead', pills[0]?.label === 'bc-rfnr', JSON.stringify(pills[0] || null));
  check(
    'its × is a real target and says which pill it removes',
    (pills[0]?.w ?? 0) >= 22 && (pills[0]?.h ?? 0) >= 22 && /Remove bc-rfnr/.test(pills[0]?.label2 || ''),
    `${pills[0]?.w}x${pills[0]?.h} "${pills[0]?.label2}"`
  );
  check('the pill fits the panel', pills[0]?.onScreen === true, `onScreen=${pills[0]?.onScreen}`);
  check('the box empties itself — the question it asked has been answered', (await evalJs(s, `(document.querySelector('.filter-typeahead .filter-text') || { value: 'x' }).value`)) === '', '');
  check('the list narrows to that bead and the two under it', narrowed.length === 3 && narrowed.every((k) => k.startsWith(`${WS}/bc-rfnr`)), narrowed.join(', '));
  check('the tree was fetched once', state.trees.length === 1 && state.trees[0] === 'bc-rfnr', state.trees.join(','));
  check(
    'and the collapsed line says so, in bold, without being opened',
    await evalJs(s, `document.querySelector('.filter-menu').classList.contains('narrowed') && /bc-rfnr/.test(document.querySelector('.filter-summary .sel').textContent)`),
    await evalJs(s, `document.querySelector('.filter-summary .sel').textContent`)
  );

  /* ============================================================ 4. and back */

  console.log('\nand back');

  await tap(s, '.pill-row .pill .pill-x');
  await sleep(400);
  const back = await cards(s);
  await shot(s, 'cleared');
  check('the × brings the whole list back', back.length === QUESTIONS.length, back.join(', '));
  check(
    'and the line stops claiming a narrowing',
    !(await evalJs(s, `document.querySelector('.filter-menu').classList.contains('narrowed')`)),
    ''
  );

  /* ================================================== 5. the sentences it says */

  console.log('\nwhat it says when there is nothing to show');

  await typeInto(s, 'zzzz');
  await sleep(600);
  const none = await evalJs(s, `(document.querySelector('.suggest-note-line') || {}).textContent || ''`);
  check('an empty result says so, rather than showing an empty box', /No bead matches/.test(none), none);

  state.warming = 3;
  await typeInto(s, 'zzzy');
  await sleep(600);
  const warm = await evalJs(s, `(document.querySelector('.suggest-note-line') || {}).textContent || ''`);
  await shot(s, 'warming');
  check(
    'a daemon that has not read the trackers says *that*, not "no such bead"',
    /Still reading/.test(warm),
    warm
  );
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\n${failed.length} of ${results.length} failed${BASELINE ? ' (expected at baseline)' : ''}`
    : `\nall ${results.length} passed`
);
process.exit(failed.length && !BASELINE ? 1 : 0);
