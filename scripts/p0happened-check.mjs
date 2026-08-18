#!/usr/bin/env node
// What happened to a bead — its pull requests and its session — driven for real. bc-rfnr.9.5.
//
//     node scripts/p0happened-check.mjs [--out=/tmp/shots] [--baseline]
//
// test/p0happened.mjs renders the block out of a `node:vm` and asserts what is in the
// string. Four things about it are not in the string, and every one of them leaves a page
// that reads as working:
//
//   • **The rows have to fit a phone.** Each carries a number or a glyph, a title and a
//     rung, inside a card 360-odd pixels wide, at the bottom of an expansion that is
//     already a screenful. An element wider than the viewport does not scroll on a phone
//     — it shrink-fits the whole page, so every other card on the board pays for it.
//   • **The pull request row has to actually open the card.** It is a `<button>` nested
//     inside the bead expansion, which is nested inside a card whose summary is *also* a
//     button, and the sheet it opens is a row the inbox's own filter would have hidden
//     (most pull requests you reach from a bead are merged, and the default sub-filter
//     shows the unmerged ones). Two ways for that tap to end in nothing happening, and
//     both of them look like a page that simply ignored you.
//   • **The empty case has to have nothing to press.** "Offers nothing to tap" is a claim
//     about the rendered document, and the string suite can only assert it about the
//     fragment. Here it is asked of the block as it stands on the screen.
//   • **The board arrives on its own clock.** The section paints before `/api/prs` has
//     answered, so what a reader actually sees first is the "reading" state resolving
//     into rows — and the row must not be tappable until it is one.
//
// Same shape as scripts/p0bead-check.mjs: the real public/app.js in a headless Chrome the
// size of a phone, against fixtures served from this process, so it never touches a
// daemon, a bead or iTerm. `--baseline` serves the committed app.js and style.css, which
// draw no such block at all, so it must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'p0happened-check-token';
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
// The bead everything happened to: two pull requests, one of them declined, and a window
// on it right now. And the bead nothing happened to, which is most beads in a tracker.
const DELIVERED = 'a-p0.1';
const QUIET = 'a-p0.2';
const TITLES = {
  [DELIVERED]: 'Every bead on the board links to its pull requests and its session',
  [QUIET]: 'A bead nobody has started',
};
const PID = 4415;

const detail = (id) => ({
  workspace: WS,
  id,
  title: TITLES[id] || id,
  status: id === DELIVERED ? 'in_progress' : 'open',
  priority: 1,
  issue_type: 'feature',
  owner: 'adam@example.com',
  labels: ['inbox', 'phone'],
  description: 'A short brief, with nothing clever in it.',
  acceptance_criteria: 'It draws what happened to the bead, and says so when nothing has.',
  parent: P0.id,
  dependent_count: 0,
  dependencies: [{ id: P0.id, title: P0.title, status: 'open', dependency_type: 'parent-child' }],
  comments: [],
  noRoot: false,
  model: null,
});

const PRS = {
  repos: [
    {
      key: WS,
      workspace: WS,
      repoName: WS,
      prs: [
        {
          key: `${WS}#391`,
          number: 391,
          title: 'An expanded bead offers its pull requests and its session',
          url: 'https://github.example/pull/391',
          branch: 'worktree-bead-happened',
          base: 'main',
          stage: 'review',
          state: 'OPEN',
          merged: false,
          pushed: false,
          local: false,
          deployed: false,
          shipped: false,
          deployTracked: false,
          additions: 240,
          deletions: 6,
          files: 6,
          updatedAt: '2026-08-17T18:00:00.000Z',
          workspace: WS,
          repoKey: WS,
          checks: { state: 'passing', passing: 1, pending: 0, failing: 0 },
          beads: [{ id: DELIVERED, title: TITLES[DELIVERED], status: 'in_progress' }],
        },
        {
          key: `${WS}#300`,
          number: 300,
          title: 'An approach that was declined',
          url: 'https://github.example/pull/300',
          branch: 'worktree-old',
          base: 'main',
          stage: 'closed',
          state: 'CLOSED',
          merged: false,
          pushed: false,
          local: false,
          deployed: false,
          shipped: false,
          deployTracked: false,
          additions: 12,
          deletions: 3,
          files: 2,
          updatedAt: '2026-08-15T18:00:00.000Z',
          workspace: WS,
          repoKey: WS,
          checks: { state: 'none' },
          beads: [{ id: DELIVERED, title: TITLES[DELIVERED], status: 'in_progress' }],
        },
      ],
    },
  ],
  counts: {},
};

/** What `/api/session-archive` answers: one run for the delivered bead, none for the quiet one. */
const ARCHIVE = {
  [DELIVERED]: { sessions: [{ commit: 'abc1234', at: '2026-08-16T09:00:00.000Z', subject: 'bc-rfnr.9.5 session' }] },
  [QUIET]: { sessions: [] },
};

const row = (id, session) => ({
  id,
  title: TITLES[id],
  status: id === DELIVERED ? 'in_progress' : 'open',
  parent: P0.id,
  depth: 1,
  key: `${WS}/${id}`,
  pending: false,
  session,
});

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
      inFlight: 1,
      waitingOn: null,
      advocate: null,
      tree: [
        row(DELIVERED, { pid: PID, name: `worker - ${DELIVERED}`, status: 'busy', at: null, opening: false }),
        row(QUIET, null),
      ],
    },
  ],
});

let prCalls = 0;
let archiveCalls = 0;
// Held back until the tap has landed, so the "reading the board" state is a real frame
// on the screen rather than a race this check happens to lose.
let releaseBoard = () => {};
const boardReady = new Promise((r) => {
  releaseBoard = r;
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
        questions: [],
        requests: [],
        workspaces: [WS],
        spaces: [{ name: 'Work', workspaces: [WS], quiet: false, muted: false, count: 0 }],
        filter: { space: 'all', workspace: 'all' },
        rootboard: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    if (p === '/api/bead') return json(detail(url.searchParams.get('id') || ''));
    if (p === '/api/prs') {
      prCalls += 1;
      return void boardReady.then(() => json(PRS));
    }
    if (p === '/api/session-archive') {
      archiveCalls += 1;
      return json({ workspace: WS, id: url.searchParams.get('id'), ...(ARCHIVE[url.searchParams.get('id')] || { sessions: [] }) });
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
const { s, close } = await launchChrome('beadcause-p0happened-');

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
  const file = path.join(OUT, `p0happened-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** The block as it stands on the screen, for one open bead. */
const BLOCK = (id) => `((id) => {
  const el = document.getElementById('p0bead-alpha_' + id.replace(/[^\\w-]/g, '_'));
  const hap = el?.querySelector('.p0-hap, .p0-hap-none');
  const rows = [...(el?.querySelectorAll('.p0-hap-row') || [])];
  const r = (e) => e.getBoundingClientRect();
  return {
    there: !!el,
    drawn: !!hap,
    text: (el?.textContent || '').replace(/\\s+/g, ' ').trim(),
    rows: rows.length,
    tags: rows.map((e) => e.tagName),
    shortest: rows.length ? Math.min(...rows.map((e) => Math.round(r(e).height))) : 0,
    widest: rows.length ? Math.max(...rows.map((e) => Math.round(r(e).right))) : 0,
    tappable: el ? el.querySelectorAll('.p0-hap a[href], .p0-hap button').length : 0,
    prButtons: el ? [...el.querySelectorAll('button[data-act="p0-pr"]')].map((e) => e.dataset.key) : [],
    hrefs: el ? [...el.querySelectorAll('.p0-hap a')].map((e) => e.getAttribute('href')) : [],
    pageWide: document.documentElement.scrollWidth <= window.innerWidth,
  };
})(${JSON.stringify(id)})`;

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

  /* ---- the board has not answered yet: reading, and nothing to press ---- */

  await press(`[data-p0bead="${WS}/${DELIVERED}"]`);
  await waitFor(`document.querySelector('.p0-bead .md') !== null`, 6000);
  await waitFor(`document.querySelector('.p0-hap, .p0-hap-none') !== null`, 6000);
  let v = await evalJs(BLOCK(DELIVERED));
  check('the block is drawn before the board answers', v.drawn);
  check('and it says it is reading rather than that there is nothing', v.text.includes('Reading the pull request board'));
  check('nothing in it is a pull request to press yet', v.prButtons.length === 0);
  await shot('reading');

  /* ---- and then the board lands ---- */

  releaseBoard();
  await waitFor(`document.querySelector('button[data-act="p0-pr"]') !== null`, 8000);
  v = await evalJs(BLOCK(DELIVERED));
  check('the pull requests arrive off the board sweep', v.prButtons.length === 1, v.prButtons.join(', '));
  check('and the board was swept once, not once per bead', prCalls >= 1, `${prCalls} calls`);
  check('the declined one is a link out rather than a button', v.hrefs.some((h) => h.includes('/pull/300')), v.hrefs.join(' '));
  check('the live session is its pid', v.hrefs.includes(`/session?pid=${PID}`), v.hrefs.join(' '));
  check('and the archived one is the bead', v.hrefs.some((h) => h.startsWith('/bead-session?')), v.hrefs.join(' '));
  check('the archive was asked once', archiveCalls === 1, `${archiveCalls} calls`);
  check('every row is a thumb-sized target', v.shortest >= 30, `${v.shortest}px`);
  check('nothing overflows a 393px phone', v.pageWide && v.widest <= VP.width, `widest ${v.widest}px`);
  await shot('open');

  /* ---- the tap has to reach the card, through two nested buttons and a filter ---- */

  await press(`button[data-act="p0-pr"]`);
  const opened = await waitFor(`document.querySelector('.card.open') !== null`, 6000);
  check('tapping a pull request opens the card the app already has', opened);
  await shot('pr');
  if (opened) await press('.card.open .card-summary, .card.open [data-act="collapse"], .card.open .card-head');

  /* ---- and the bead nothing happened to has nothing to press ---- */

  await press(`[data-p0bead="${WS}/${QUIET}"]`);
  await waitFor(`document.getElementById('p0bead-alpha_a-p0_2') !== null`, 6000);
  await waitFor(`(document.getElementById('p0bead-alpha_a-p0_2')?.textContent || '').includes('no session has run')`, 8000);
  v = await evalJs(BLOCK(QUIET));
  check('a bead nothing happened to says so', v.text.includes(`No pull request names ${QUIET}, and no session has run on it.`));
  check('and offers nothing to tap', v.tappable === 0, `${v.tappable} controls`);
  await shot('quiet');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
