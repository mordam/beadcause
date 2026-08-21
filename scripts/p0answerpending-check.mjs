#!/usr/bin/env node
//
// Tapping "Answer it" on a bead inside an epic's tree is answered before the fetch is.
// bc-ka5y.14.
//
//   node scripts/p0answerpending-check.mjs [--baseline] [--keep] [--out=<dir>]
//
// bc-jair put `.card.opening` on a shut inbox card so a tap is answered before the fetch
// that opens it returns. The board's tree rows never got it, and `p0-answer` — the
// "Answer it" button `p0BeadHtml` draws under an expanded bead — has exactly the same
// wait: it is `await expand(key)` and nothing else, so on a slow link the row sat there
// with nothing to show for the tap. scripts/pending-check.mjs proved the card side of this
// mechanism; this is the row side, and only a browser can see either.
//
//   1. **It is on before the browser has painted anything.** Same one-`Runtime.evaluate`
//      trick as pending-check.mjs: the click is dispatched and the class read back inside
//      one round trip, so no frame boundary can have happened in between.
//   2. **Nothing moves.** `.p0-row.opening` only recolours the edge the row already has —
//      the row's box and the title inside it are pixel-identical across the tap.
//   3. **It goes when the card opens, and it goes when the fetch fails** — `expand()`
//      swallows both of its own failures, so a mark only cleared on success would stick
//      until the page reloaded.
//   4. **Reduced motion keeps the edge and drops the pulse.**
//
// Same shape as scripts/p0bead-check.mjs and scripts/pending-check.mjs: the real
// public/app.js in a headless Chrome the size of a phone, against fixtures served from
// this process, so it never touches a daemon or a bead. `--baseline` serves the committed
// app.js/style.css, which has no row-shaped mark at all, so it must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { aliasPage, pageAliases } from '../lib/pagealias.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'p0answer-pending-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Same duration pending-check.mjs uses, for the same reason: unambiguously on screen
// between the tap and the answer, short enough that this stays a fast check.
const DELAY = 1200;

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

/* ---------------------------------------------------------------- fixtures */

const WS = 'alpha';
const P0 = { id: 'a-p0', title: 'Make the phone the whole interface' };
// Two beads under the epic, each itself a question — `pending: true` — so the tree draws
// "Answer it" under both once opened. One answers slowly, the other refuses.
const SLOW = 'a-p0.1';
const FAILS = 'a-p0.2';

const bead = (id, title) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-08T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: 'Whether the standby build is kept after a swap, and what that costs.',
});

const SLOW_BEAD = bead(SLOW, 'A question whose brief is a second away');
const FAILS_BEAD = bead(FAILS, 'A question whose brief will not load');

// `comments` deliberately absent — that is what `expand()` reads to decide it has to
// fetch `/api/question` at all, same as pending-check.mjs's own fixture.
const QUESTIONS = [toQuestion(WS, SLOW_BEAD), toQuestion(WS, FAILS_BEAD)];

/** What `/api/bead` answers for the tree's own expansion — `bd show`, no question on it. */
const detail = (id, title) => ({
  workspace: WS,
  id,
  title,
  status: 'open',
  priority: 1,
  issue_type: 'task',
  owner: 'adam@example.com',
  labels: ['inbox'],
  description: 'Whether the standby build is kept after a swap, and what that costs.',
  dependent_count: 0,
  dependencies: [{ id: P0.id, title: P0.title, status: 'open', dependency_type: 'parent-child' }],
  comments: [],
});

/** The board, as `rootCard` in lib/server.js builds it — flat, pre-order, a depth each. */
const board = () => ({
  owned: true,
  under: {},
  roots: [
    {
      key: `${WS}/${P0.id}`,
      workspace: WS,
      id: P0.id,
      title: P0.title,
      status: 'open',
      issue_type: 'epic',
      owners: ['adam'],
      open: 2,
      inFlight: 0,
      waitingOn: null,
      advocate: null,
      tree: [
        { id: SLOW, title: SLOW_BEAD.title, status: 'open', parent: P0.id, depth: 1, key: `${WS}/${SLOW}`, pending: true },
        { id: FAILS, title: FAILS_BEAD.title, status: 'open', parent: P0.id, depth: 1, key: `${WS}/${FAILS}`, pending: true },
      ],
    },
  ],
});

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
const BASELINED = ['/app.js', '/style.css'];
const committed = (rel) => execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`]);
const ALIASES = pageAliases();

const writes = [];
const errors = [];
/** Which ids `/api/question` was actually asked for — proof the tap fetched at all. */
const asked = [];
const real = () => writes.filter((w) => w.path !== '/api/presence');

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
        workspaces: [WS],
        spaces: [],
        filter: { space: 'all', workspace: 'all' },
        rootboard: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    // The tree's own expansion, fast and unrelated to the wait this check is about.
    if (p === '/api/bead') {
      const id = url.searchParams.get('id');
      return json(detail(id, id === SLOW ? SLOW_BEAD.title : FAILS_BEAD.title));
    }
    // What `p0-answer` awaits — the one endpoint this check is about. Slow for one bead,
    // refused for the other, same split pending-check.mjs stages for the card.
    if (p === '/api/question') {
      const id = url.searchParams.get('id');
      asked.push(id);
      if (id === FAILS) return json({ error: 'the tracker is not answering' }, 500);
      const row = QUESTIONS.find((q) => q.id === id);
      return void setTimeout(() => json({ ...row, comments: [], gate: null }), DELAY);
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const record = { path: p, ...JSON.parse(body || '{}') };
        (p === '/api/error' ? errors : writes).push(record);
        json({ ok: true });
      });
    }
    if (p.startsWith('/api/')) return json({});

    const rel = aliasPage(p, ALIASES).replace(/^\/+/, '');
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
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
const { s, close } = await launchChrome('beadcause-p0answerpending-');

const evalJs = async (expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 200; i++) {
    if (await evalJs(expr)) return true;
    await sleep(200);
  }
  return false;
};

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `p0answerpending-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

const ROW = (id) => `document.querySelector('[data-p0bead="${WS}/${id}"]')`;

const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};

/**
 * Tap "Answer it" and read the row back **without letting go of the thread** — the same
 * discipline pending-check.mjs's `TAP` uses and for the same reason: the click dispatches
 * the listener synchronously and it marks the row before its first `await`, so anything
 * returned here is the page at the instant the tap finished, with no frame boundary, no
 * timer and no network in between.
 */
const ANSWER = (id) => `document.querySelector('.p0-answer[data-key="${WS}/${id}"]')`;

const ANSWER_TAP = (id) => `(() => {
  const row = ${ROW(id)};
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100); };
  const before = box(row);
  ${ANSWER(id)}.click();
  const now = ${ROW(id)} || row;
  const style = getComputedStyle(now);
  return {
    marked: document.querySelectorAll('[data-p0bead].opening').length,
    mine: now.classList.contains('opening'),
    colour: style.borderLeftColor,
    animation: style.animationName,
    opened: !!document.querySelector('.card.open'),
    before,
    after: box(now),
  };
})()`;

const SETTLED = (id) => `(() => {
  const row = ${ROW(id)};
  return {
    marked: document.querySelectorAll('[data-p0bead].opening').length,
    mine: !!row && row.classList.contains('opening'),
    opened: !!document.querySelector('.card.open'),
  };
})()`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  await waitFor(`document.querySelectorAll('.p0-row').length >= 2`, 4000);

  /* ---- open the SLOW row so its "Answer it" button is on screen ---- */
  await press(`[data-p0bead="${WS}/${SLOW}"]`);
  await waitFor(`${ANSWER(SLOW)} !== null`, 4000);
  await shot('row-open');

  /* ---- 1 & 2. the tap is answered at once, and nothing moves ---- */
  const tapped = await evalJs(ANSWER_TAP(SLOW));
  await shot('pending');
  check(
    'the row is marked before the browser has painted anything',
    tapped.mine === true,
    JSON.stringify({ marked: tapped.marked, mine: tapped.mine })
  );
  check('and it is the only one marked', tapped.marked === 1, `${tapped.marked} marked`);
  check(
    'the mark is a visible colour on the row\'s own edge',
    tapped.colour !== 'rgba(0, 0, 0, 0)',
    tapped.colour
  );
  check('the card has not opened yet — it is waiting, and saying so', tapped.opened === false);
  check(
    'the row did not move by so much as a pixel',
    same(tapped.before, tapped.after),
    `${JSON.stringify(tapped.before)} → ${JSON.stringify(tapped.after)}`
  );

  /* ---- 3a. and it goes when the card opens ---- */
  await waitFor(`document.querySelector('.card.open') !== null`, DELAY + 4000);
  await sleep(300);
  const opened = await evalJs(SETTLED(SLOW));
  await shot('opened');
  check('the brief arrives and the card opens', opened.opened === true, JSON.stringify(opened));
  check('and the mark goes with it', opened.marked === 0 && opened.mine === false, JSON.stringify(opened));
  await evalJs(`document.querySelector('.card.open [data-act="collapse"], .card.open [data-act="toggle"]')?.click()`);
  await sleep(400);

  /* ---- 3b. and it goes when the fetch fails, which is the one that used to stick ---- */
  await press(`[data-p0bead="${WS}/${FAILS}"]`);
  await waitFor(`${ANSWER(FAILS)} !== null`, 4000);
  const failing = await evalJs(ANSWER_TAP(FAILS));
  check('a row whose brief will not load is marked too', failing.mine === true, JSON.stringify(failing.marked));
  await sleep(800);
  const gaveUp = await evalJs(SETTLED(FAILS));
  await shot('failed');
  check(
    'a refused fetch clears the mark rather than leaving it lit forever',
    gaveUp.marked === 0 && gaveUp.mine === false,
    JSON.stringify(gaveUp)
  );
  check('and the card still opens on what the list already knew', gaveUp.opened === true, JSON.stringify(gaveUp));
  await evalJs(`document.querySelector('.card.open [data-act="collapse"], .card.open [data-act="toggle"]')?.click()`);
  await sleep(400);

  /* ---- 4. reduced motion keeps the edge and drops the pulse ---- */
  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-card') !== null`, 15000);
  await press('.p0-card .p0-tap');
  await waitFor(`document.querySelectorAll('.p0-row').length >= 2`, 4000);
  await press(`[data-p0bead="${WS}/${SLOW}"]`);
  await waitFor(`${ANSWER(SLOW)} !== null`, 4000);
  const quiet = await evalJs(ANSWER_TAP(SLOW));
  await shot('reduced-motion');
  check(
    'reduced motion still gets the edge coloured — the mark is the point, the pulse is not',
    quiet.mine === true && quiet.colour !== 'rgba(0, 0, 0, 0)',
    JSON.stringify({ mine: quiet.mine, colour: quiet.colour })
  );
  check('and nothing on it animates', quiet.animation === 'none', `animation-name: ${quiet.animation}`);

  check('none of this wrote anything', real().length === 0, JSON.stringify(real().map((w) => w.path)));
  const said = (e) => `${e.kind || 'error'} — ${e.message || JSON.stringify(e)}`;
  const staged = errors.filter((e) => /\/api\/question/.test(said(e)) && /500/.test(said(e)));
  check(
    'the fetch this check stages a refusal for did refuse',
    staged.length === 1,
    `${staged.length} refusals reported`
  );
  check(
    'and the page reported no errors of its own beyond it',
    errors.length === staged.length,
    errors.filter((e) => !staged.includes(e)).map(said).join(' · ')
  );
  check('the question this check is about was actually asked for, twice', asked.filter((id) => id === SLOW).length >= 1 && asked.includes(FAILS));
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
