#!/usr/bin/env node
//
// The epic board folds away, and folding it costs nothing.
//
//   node scripts/p0fold-check.mjs [--baseline] [--out=<dir>]
//
// bc-eevn. The section at the top of the inbox is four or five epics with their controls
// — on a 393px phone that is the entire first screen, and there are days when what you
// came for is the questions underneath. So the heading became a disclosure. test/p0card.mjs
// has the renderer and the handler's source; what it cannot reach is the four ways this
// goes wrong in a browser with every unit test still green:
//
//   • **The tap has to be delegated to at all.** Every handler on the inbox hangs off
//     `#list` and resolves through `closest('[data-act]')`. A heading drawn outside that
//     element renders perfectly and does nothing — which is the failure mode this repo has
//     already paid for once, and it is invisible to a renderer test.
//   • **Folding must not touch the list underneath.** `underOwnedP0s` narrows the inbox to
//     your epics' descendants off the board *data*; a fold that reached the filter instead
//     would empty the inbox, and the rows it took away would have no visible reason to be
//     gone. Asserted by counting the rows either side of the tap.
//   • **The count has to survive the fold.** Shut, the heading is the whole section, and a
//     line that did not say how many epics were behind it would be indistinguishable from a
//     screen with no epics on it.
//   • **It has to still be folded after a reload**, which is the half `state.p0shut` alone
//     cannot show: the preference is written to `localStorage` on the tap and read back at
//     boot, and either end of that can be missing with the page looking right all session.
//
// And one that is neither: the chevron. It is the only thing on screen that says which
// state the section is in, and it turns off the shared `[aria-expanded='true'] > .chev`
// rule in the stylesheet — so it is read as a computed transform rather than as markup,
// which is what makes this a check of the *pair* of files rather than of app.js.
//
// Same shape as p0advocate-check.mjs: the real public/app.js in a headless Chrome the size
// of a phone, against fixtures served from this process, so it never touches a daemon, a
// bead or iTerm. `--baseline` serves the committed app.js and style.css, which have never
// heard of the fold, so it must fail.
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
const TOKEN = 'p0fold-check-token';
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
const P0S = [
  { id: 'a-p0', title: 'Make the phone the whole interface' },
  { id: 'b-p0', title: 'Everything an agent decides is a bead' },
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

// Two questions, one under each epic. They are the rows the fold must not disturb: with a
// board on, the list below it is your epics' descendants and nothing else, so a fold that
// reached `underOwnedP0s` would take both of these off the screen.
const QUESTIONS = P0S.map((p, i) => ({
  ...toQuestion(WS, bead(`${p.id}.${i + 1}`, `A child of ${p.id}`)),
  space: 'Work',
  comments: [],
}));

/** The board, as `p0Card` in lib/server.js builds it — trees and all, since bc-rfnr.9.1. */
const board = () => ({
  owned: true,
  under: Object.fromEntries(QUESTIONS.map((q, i) => [`${WS}/${P0S[i].id}.${i + 1}`, P0S[i].id])),
  p0s: P0S.map((p, i) => ({
    key: `${WS}/${p.id}`,
    workspace: WS,
    id: p.id,
    title: p.title,
    status: 'open',
    issue_type: 'epic',
    owners: ['adam'],
    open: 6,
    inFlight: 1,
    waitingOn: null,
    advocate: null,
    tree: [
      { id: `${p.id}.${i + 1}`, title: `A child of ${p.id}`, status: 'open', parent: p.id, depth: 1, key: `${WS}/${p.id}.${i + 1}`, pending: true },
      { id: `${p.id}.9`, title: 'Something nobody is asking about', status: 'open', parent: p.id, depth: 1, key: `${WS}/${p.id}.9`, pending: false },
    ],
  })),
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
const { s, close } = await launchChrome('beadcause-p0fold-');

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
  const file = path.join(OUT, `p0fold-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The section from outside — the heading, what it says, where in the DOM it is, and how
 * much of the board and of the list below it is on screen.
 *
 * `chevTurned` is read off the computed transform rather than off a class, because the
 * rotation is the stylesheet's half of the feature: an app.js served beside a stale
 * style.css draws a chevron that points the same way whichever state the board is in, and
 * that is the one thing telling you which state you are in.
 */
const SECTION = `(() => {
  const head = document.querySelector('.p0-board .p0-kind');
  const chev = head?.querySelector('.chev');
  const t = chev ? getComputedStyle(chev).transform : '';
  return {
    there: !!head,
    tag: head?.tagName || '',
    act: head?.dataset?.act || '',
    inList: !!head && head.closest('#list') !== null,
    expanded: head?.getAttribute('aria-expanded') || '',
    text: (head?.textContent || '').replace(/\\s+/g, ' ').trim(),
    height: head ? Math.round(head.getBoundingClientRect().height) : 0,
    chevTurned: !!t && t !== 'none' && t !== 'matrix(1, 0, 0, 1, 0, 0)',
    cards: document.querySelectorAll('.p0-card').length,
    trees: document.querySelectorAll('.p0-tree').length,
    rows: document.querySelectorAll('#list .card').length,
    wide: document.documentElement.scrollWidth <= window.innerWidth,
  };
})()`;

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

  /* ---- open, which is what a phone that has never been told otherwise gets ---- */

  let v = await evalJs(SECTION);
  check('the board opens open, with both epics on it', v.cards === 2 && v.expanded === 'true', `${v.cards} cards`);
  check('the heading says what the section is', /epics assigned to you/i.test(v.text), v.text);
  check('and no longer calls it P0s', !/your p0s/i.test(v.text), v.text);
  check('it is a button, and it is inside #list so the tap is delegated to at all', v.tag === 'BUTTON' && v.act === 'p0-fold' && v.inList);
  check('a thumb can find it', v.height >= 44, `${v.height}px`);
  check('the chevron is turned down while it is open', v.chevTurned);
  const rowsOpen = v.rows;
  // Since bc-rfnr.9.7 they are *not*: every one of these questions hangs off an epic on
  // the board, so it is a row in that epic's tree and the flat copy underneath is gone.
  // What the heading carries instead is how many of them are asking you something, which
  // is the number that has to survive the fold below.
  check('no bead the board draws is drawn again underneath it', rowsOpen === 0, `${rowsOpen} rows`);
  check('and the heading says how many are asking you', /\b2 ask you\b/.test(v.text), v.text);
  await shot('open');

  /* ---- one epic unfolded inside it, so the fold has something to not lose ---- */

  await press('.p0-card .p0-tap');
  await waitFor(`document.querySelector('.p0-tree') !== null`, 4000);
  check('an epic opened inside the board', (await evalJs(SECTION)).trees === 1);

  /* ---- the tap ---- */

  const tapped = await press('.p0-board .p0-kind');
  await sleep(400);
  v = await evalJs(SECTION);
  check('tapping the heading folds the board away', tapped && v.cards === 0, `${v.cards} cards`);
  check('the heading stays, and says it is shut', v.there && v.expanded === 'false');
  check('the chevron turned back', !v.chevTurned);
  // The one thing a fold must never do, because a screen with the count missing is
  // indistinguishable from a screen with no epics on it.
  check('the count is still on the shut line', /\b2\b/.test(v.text), v.text);
  check('nothing overflows a 393px phone', v.wide);
  await shot('shut');

  /* ---- and the list underneath is exactly as it was ---- */

  check('the list underneath is exactly as it was', v.rows === rowsOpen, `${rowsOpen} → ${v.rows}`);
  // The count that has to survive a fold, and since bc-rfnr.9.7 it is two counts: how many
  // epics are behind it and how many of them are waiting on an answer. A shut board is
  // otherwise the only thing on the screen where a question could be, so a heading that
  // dropped this is a week of unanswered questions with nothing saying they exist.
  check('and the questions are counted on the shut line', /\b2 ask you\b/.test(v.text), v.text);

  /* ---- bringing it back brings back what was open in it ---- */

  await press('.p0-board .p0-kind');
  await sleep(400);
  v = await evalJs(SECTION);
  check('tapping again brings the board back', v.cards === 2 && v.expanded === 'true');
  // Putting a drawer away is not closing what is in it: the fold writes `p0shut` and
  // touches `p0open` not at all.
  check('with the epic you had open still open', v.trees === 1, `${v.trees} trees`);
  await shot('back');

  /* ---- a poll must not undo it ---- */

  await press('.p0-board .p0-kind');
  await sleep(400);
  await press('#refresh');
  await sleep(1200);
  v = await evalJs(SECTION);
  check('a repaint 25 seconds later leaves it shut', v.cards === 0 && v.expanded === 'false');

  /* ---- and neither must a reload: this one is a standing preference ---- */

  check('which is stored rather than remembered', await evalJs(`localStorage.getItem('beadcause.p0shut')`) === '1');
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-board .p0-kind') !== null`, 15000);
  await sleep(600);
  v = await evalJs(SECTION);
  check('and the board comes back shut', v.expanded === 'false' && v.cards === 0, v.text);
  // The first frame, not the second. The flag is read out of `localStorage` in the state
  // initialiser, so there is no moment where the board is drawn and then taken away.
  check('the count came back with it', /\b2\b/.test(v.text), v.text);

  /* ---- and unfolding it is the way back, which is the state the next run wants ---- */

  await press('.p0-board .p0-kind');
  await sleep(400);
  v = await evalJs(SECTION);
  check('unfolding it after a reload puts the epics back', v.cards === 2 && v.expanded === 'true');
  check('and clears the preference rather than only the page', await evalJs(`localStorage.getItem('beadcause.p0shut')`) === '0');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
