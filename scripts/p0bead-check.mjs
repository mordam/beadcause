#!/usr/bin/env node
// A bead in the tree expands in place to its full details — driven for real. bc-rfnr.9.4.
//
//     node scripts/p0bead-check.mjs [--out=/tmp/shots] [--baseline]
//
// test/p0bead.mjs renders the block out of a `node:vm` and asserts what is in the string.
// Four things about this feature are not in the string, and each of them leaves a page
// that looks perfectly fine:
//
//   • **The tap has to be delegated to.** Every handler on the inbox hangs off `#list`;
//     the rows are drawn inside the board, which is drawn inside it — but a row is a
//     `<button>` now, nested in a card whose summary is *also* a button, and a browser is
//     the only thing that will tell you the tap reaches the handler rather than the card.
//   • **The details are a fetch.** The renderer is pure and the suite hands it a bead. Here
//     nothing is handed anything: the tap has to ask `/api/bead`, the answer has to land,
//     and the board has to repaint with it — three seams a string cannot cross.
//   • **The children have to still be there, on the screen.** Document order is asserted in
//     the suite; what is asserted here is that the child row is still *drawn*, still below
//     the expansion, and still indented deeper than the bead that is open.
//   • **It has to fit a phone.** The expansion carries a description, a thread and a row of
//     labels inside a card 360-odd pixels wide, and an element wider than the viewport does
//     not scroll on a phone — it shrink-fits the whole page, so every other card pays.
//
// Same shape as scripts/p0fold-check.mjs: the real public/app.js in a headless Chrome the
// size of a phone, against fixtures served from this process, so it never touches a
// daemon, a bead or iTerm. `--baseline` serves the committed app.js and style.css, whose
// rows are links to the graph, so it must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'p0bead-check-token';
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
const P0 = { id: 'a-p0', title: 'Make the phone the whole interface' };
// Parent and child, in that order, because the whole claim is about what happens to the
// row *underneath* the one you opened.
const PARENT = 'a-p0.1';
const CHILD = 'a-p0.1.1';
const TITLES = {
  [PARENT]: 'The card summarises collapsed and shows its tree expanded',
  [CHILD]: 'A bead in the tree expands in place to its full details',
};

const DESCRIPTION = 'Tapping a bead inside a P0 tree opens the same full detail it would get as an inbox card.';
const ACCEPTANCE = 'Any bead in the tree opens to its full details in place, children included.';

/** What `/api/bead` answers — `bd show` plus the thread, for a bead with no question. */
const detail = (id) => ({
  workspace: WS,
  id,
  title: TITLES[id] || id,
  status: id === PARENT ? 'closed' : 'open',
  priority: 1,
  issue_type: 'feature',
  owner: 'adam@example.com',
  labels: ['inbox', 'phone', 'tracker'],
  description: DESCRIPTION,
  acceptance_criteria: ACCEPTANCE,
  notes: 'The indent is capped at three steps.',
  close_reason: id === PARENT ? 'Landed as #243 as e8315969 — still owed: CAN BE DEPLOYED' : '',
  closed_at: id === PARENT ? '2026-08-14T12:00:00.000Z' : null,
  parent: id === CHILD ? PARENT : P0.id,
  dependent_count: id === PARENT ? 1 : 0,
  dependencies: [
    { id: id === CHILD ? PARENT : P0.id, title: 'the one above it', status: 'open', dependency_type: 'parent-child' },
    { id: 'a-p0.9', title: 'The server sends the tree', status: 'closed', dependency_type: 'blocks' },
  ],
  comments: [
    { id: `${id}-c1`, author: 'beadcause', text: 'Queued #243.', created_at: '2026-08-14T11:00:00.000Z' },
    { id: `${id}-c2`, author: 'worker (adam)', text: 'The pills wrapped onto a line of their own.', created_at: '2026-08-14T11:30:00.000Z' },
  ],
  noRoot: false,
  model: null,
});

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

const QUESTIONS = [{ ...toQuestion(WS, bead('a-p0.7', 'A question under the epic')), space: 'Work', comments: [] }];

/** The board, as `rootCard` in lib/server.js builds it — flat, pre-order, a depth each. */
const board = () => ({
  owned: true,
  under: { [`${WS}/a-p0.7`]: P0.id },
  roots: [
    {
      key: `${WS}/${P0.id}`,
      workspace: WS,
      id: P0.id,
      title: P0.title,
      status: 'open',
      issue_type: 'epic',
      owners: ['adam'],
      open: 3,
      inFlight: 0,
      waitingOn: null,
      advocate: null,
      tree: [
        { id: PARENT, title: TITLES[PARENT], status: 'closed', parent: P0.id, depth: 1, key: `${WS}/${PARENT}`, pending: false },
        { id: CHILD, title: TITLES[CHILD], status: 'in_progress', parent: PARENT, depth: 2, key: `${WS}/${CHILD}`, pending: false },
        { id: 'a-p0.7', title: 'A question under the epic', status: 'open', parent: P0.id, depth: 1, key: `${WS}/a-p0.7`, pending: true },
      ],
    },
  ],
});

let beadCalls = 0;

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
        rootboard: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    // The route the expansion is built on. Counted, because "never on the poll" is a
    // claim about how often this is asked and nothing else can see it.
    if (p === '/api/bead') {
      beadCalls += 1;
      return json(detail(url.searchParams.get('id') || ''));
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
const check = (name, ok, detailText) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detailText ? ` — ${detailText}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-p0bead-');

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
  const file = path.join(OUT, `p0bead-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The tree from outside: the rows, the expansions, and where each of them is on screen.
 *
 * Positions are read as `getBoundingClientRect().top` rather than as document order,
 * because document order is what the vm suite already proves and what a phone shows is
 * where things land — an expansion absolutely positioned over its own children would
 * satisfy the string and hide half the tree.
 */
const TREE = `((PARENT, CHILD) => {
  const row = (id) => document.querySelector('[data-p0bead="alpha/' + id + '"]');
  const box = (el) => el ? Math.round(el.getBoundingClientRect().top) : null;
  const blockOf = (id) => document.getElementById('p0bead-alpha_' + id.replace(/[^\\w-]/g, '_'));
  const parent = row(PARENT), child = row(CHILD);
  const open = blockOf(PARENT);
  const step = (el) => el ? getComputedStyle(el).marginLeft : '';
  return {
    rows: document.querySelectorAll('.p0-row').length,
    blocks: document.querySelectorAll('.p0-bead').length,
    parentTag: parent?.tagName || '',
    parentExpanded: parent?.getAttribute('aria-expanded') || '',
    parentTop: box(parent),
    childTop: box(child),
    openTop: box(open),
    openHeight: open ? Math.round(open.getBoundingClientRect().height) : 0,
    rowHeight: parent ? Math.round(parent.getBoundingClientRect().height) : 0,
    parentIndent: step(parent),
    childIndent: step(child),
    text: (open?.textContent || '').replace(/\\s+/g, ' ').trim(),
    graph: !!open?.querySelector('a.p0-graph'),
    comments: open ? open.querySelectorAll('.comment').length : 0,
    wide: document.documentElement.scrollWidth <= window.innerWidth,
    widest: Math.max(0, ...[...document.querySelectorAll('.p0-bead, .p0-row')].map((e) => Math.round(e.getBoundingClientRect().right))),
  };
})(${JSON.stringify(PARENT)}, ${JSON.stringify(CHILD)})`;

const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width, height: VP.height, deviceScaleFactor: VP.dpr,
    mobile: true, screenWidth: VP.width, screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-card') !== null`, 15000);
  await press('.p0-card .p0-tap');
  await waitFor(`document.querySelector('.p0-tree') !== null`, 4000);

  let v = await evalJs(TREE);
  // Where the row sits before anything is tapped, because the sharpest thing this check
  // can see is whether the page moves out from under it.
  const wasTop = v.parentTop;
  check('the tree is drawn, and every row in it is a control', v.rows === 3 && v.parentTag === 'BUTTON', `${v.rows} rows`);
  check('a thumb can find a row', v.rowHeight >= 34, `${v.rowHeight}px`);
  check('nothing is expanded until something is tapped', v.blocks === 0 && v.parentExpanded === 'false');
  check('and nothing has been asked of bd', beadCalls === 0, `${beadCalls} calls`);
  await shot('tree');

  /* ---- the tap: it has to reach the handler, and the handler has to fetch ---- */

  const tapped = await press(`[data-p0bead="${WS}/${PARENT}"]`);
  const landed = await waitFor(`document.querySelector('.p0-bead .md') !== null`, 6000);
  v = await evalJs(TREE);
  check('tapping a row opens that bead where it stands', tapped && v.blocks === 1 && v.parentExpanded === 'true');
  check('the details were fetched from /api/bead', landed && beadCalls === 1, `${beadCalls} calls`);
  check('and they are the bead, not a question card', v.text.includes(DESCRIPTION) && v.text.includes(ACCEPTANCE));
  check('with its thread under it', v.comments === 2, `${v.comments} comments`);
  check('how it ended, since it is closed', v.text.includes('still owed: CAN BE DEPLOYED'));
  check('and the graph still one tap away, on the bead itself', v.graph);
  await shot('open');

  /* ---- the half the string cannot show: the children are still there ---- */

  check('the child row is still on the screen', v.childTop !== null);
  check('the expansion is between the bead and its child', v.parentTop < v.openTop && v.openTop < v.childTop, `${v.parentTop} → ${v.openTop} → ${v.childTop}`);
  check('the child is still indented deeper than the bead that is open', v.parentIndent !== v.childIndent, `${v.parentIndent} vs ${v.childIndent}`);
  check('the expansion has real height rather than collapsing to nothing', v.openHeight > 80, `${v.openHeight}px`);
  // The one this check exists for, and the only place it can be seen. `capturePlace`
  // anchors the scroll on the first card in the LIST, so six hundred pixels opening
  // above it scrolls the page down by six hundred pixels — the bead you tapped leaves
  // the top of the screen and you land in the middle of its description. Measured 0 →
  // 486 before `keepTheScreenStill`.
  check(
    'the row you tapped is still where you tapped it',
    wasTop !== null && v.parentTop !== null && Math.abs(v.parentTop - wasTop) <= 2,
    `${wasTop} → ${v.parentTop}`
  );
  check('nothing overflows a 393px phone', v.wide && v.widest <= VP.width, `widest ${v.widest}px`);

  /* ---- two at once, because an accordion would close the parent holding the child ---- */

  await press(`[data-p0bead="${WS}/${CHILD}"]`);
  await waitFor(`document.querySelectorAll('.p0-bead .md').length >= 2`, 6000);
  v = await evalJs(TREE);
  check('opening the child leaves the parent open', v.blocks === 2, `${v.blocks} open`);
  check('and it is still the child, still under it', v.childTop > v.openTop);
  await shot('both');

  /* ---- a poll must not fold them up ---- */

  const before = beadCalls;
  await press('#refresh');
  await sleep(1500);
  v = await evalJs(TREE);
  check('a repaint 25 seconds later leaves both open', v.blocks === 2, `${v.blocks} open`);
  check('and asks bd nothing on the way through', beadCalls === before, `${beadCalls - before} extra calls`);

  /* ---- and the tap folds it up again ---- */

  await press(`[data-p0bead="${WS}/${PARENT}"]`);
  await sleep(400);
  v = await evalJs(TREE);
  check('tapping the row again folds that bead away', v.blocks === 1 && v.parentExpanded === 'false');
  check('and leaves the other one where it was', v.childTop !== null);
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
