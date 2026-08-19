#!/usr/bin/env node
// The board *is* the inbox — driven for real. bc-rfnr.9.7 and bc-rfnr.9.9.
//
//     node scripts/p0board-check.mjs [--out=/tmp/shots] [--baseline]
//
// Two beads, one screen, and the half of each that no string comparison can see.
//
//   • **bc-rfnr.9.9 is invisible in the HTML and obvious at 393×852.** Opening a P0's tree
//     inserts several screens of content *above* the list, and `capturePlace` anchors the
//     scroll on the first card in that list — so the restore faithfully scrolls the page
//     down by exactly the height of what just appeared, and the epic you tapped leaves the
//     top of the screen. The rendered markup is identical either way. The only thing that
//     tells you is `getBoundingClientRect().top` on the tapped element, before and after,
//     which is how scripts/p0bead-check.mjs asserts the same fix one level down. It used
//     to be asked of the board's fold as well, on the grounds that unfolding is the same
//     growth with the whole section in it; bc-khoe.28 removed the fold, so what is asked
//     of the heading now is only that pressing where it was does nothing.
//   • **bc-rfnr.9.7's claim is about two surfaces at once.** That a bead the board draws is
//     not drawn again underneath it is half a line in `underOwnedRoots` and is asserted in
//     test/ownquestion.mjs; what is not assertable there is that the *question* survived
//     the removal — that it is marked on a card whose tree is folded shut, that the count
//     is on the section heading as well, and that tapping through to it ends on a real
//     answer box rather than on a control that does nothing.
//
//   • **bc-khoe.28 is a claim about two screens that share one page.** My Epics is the
//     board and nothing under it; a kind pill is the list and no board over it. Neither
//     half is visible in one render — the failure is a chunk that is still pushed on the
//     other view — so it is driven by tapping the pill row for real and asking what is on
//     the screen either side of the tap.
//
//   • **bc-khoe.29 is what that pill then holds, and it is the opposite of what this file
//     used to assert.** Once the board is off a pill, `rootboard.under` is a narrowing
//     against a screen that is not there — it exists to stop a bead being drawn twice, and
//     on Questions nothing is drawing it once. #498 replaced it there with `assignedToMe`,
//     a positive rule off the payload's `assigned` map: a row stays if its bead is yours
//     or descends from one of yours. So the bead the board draws on My Epics is on the
//     Questions pill *on purpose* — that is the commonest row in the tracker, and 38 of
//     Adam's 97 live question rows were on no screen at all without it. The assertion here
//     was inverted rather than deleted (bc-7wwbb), and the fixture gained `assigned`: with
//     no such map `assignedToMe` returns its rows untouched, so this check was passing the
//     two pills' half of its claim without ever running the code that decides it.
//
// The fixture keeps a question under nobody's P0 — `unhomed`, bc-i7tw — because that is
// the one row a tree cannot hold, and therefore the row that has to be on the Questions
// pill and nowhere else. Before bc-khoe.28 it was also the scroll anchor `restorePlace`
// holds on to; My Epics has no list to anchor in now, and `restorePlace` returns early
// there, which is why the jump below is measured with a question pill's list on screen as
// well as without one.
//
// Same harness as scripts/p0bead-check.mjs: the real public/app.js in a headless Chrome the
// size of a phone, against fixtures served from this process, so it never touches a daemon,
// a bead or iTerm. `--baseline` serves the committed app.js and style.css, which draw the
// list as a second copy of the board and jump on every tap, so it must fail.
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
const TOKEN = 'p0board-check-token';
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
// The bead that is asking you something, the one nobody has homed anywhere, and one on
// somebody else's P0 — the third is bc-khoe.29's negative case and the only row here that
// the kind pills are supposed to leave out.
const ASKS = 'a-p0.7';
const LOOSE = 'a-loose';
const OTHERS = 'b-p0.3';
const ASKS_TITLE = 'Which way should the caret point?';
const LOOSE_TITLE = 'A question you filed from your own phone';
const OTHERS_TITLE = 'A question on an epic that is somebody else’s';

/**
 * Twelve rows, because the jump this measures is proportional to the tree.
 *
 * A three-row tree opens about a hundred pixels and a two-pixel tolerance would pass on a
 * page that had barely moved; a real epic on this tracker has sixty descendants. Twelve is
 * enough that the failure is unmistakable and few enough that the fixture stays readable.
 */
const TREE = Array.from({ length: 12 }, (_, i) => {
  const n = i + 1;
  const id = `${P0.id}.${n}`;
  return {
    id,
    title: id === ASKS ? ASKS_TITLE : `Something under the epic, number ${n}`,
    status: n % 4 === 0 ? 'closed' : 'open',
    parent: P0.id,
    depth: 1,
    key: `${WS}/${id}`,
    pending: id === ASKS,
  };
});

// What the board's own default filter (`Not closed`, bc-rfnr.9.6) leaves on screen. The
// tree is a mix on purpose — a fixture of all-open rows would pass a filter that had
// stopped filtering.
const LIVE = TREE.filter((r) => r.status !== 'closed').length;

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
 * A dozen questions under nobody's P0, and the count is the point.
 *
 * The jump bc-rfnr.9.9 is about can only happen on a page that has somewhere to jump *to*:
 * the restore scrolls down by the height of the tree, and a document shorter than the
 * viewport plus that height simply clamps, which would pass this check on a build that
 * still had the bug. So the list under the board is deliberately taller than the screen.
 * Twelve `unhomed` rows is also the honest shape — bc-i7tw's rows are the ones bc-rfnr.9.7
 * leaves behind.
 */
const LOOSE_IDS = Array.from({ length: 12 }, (_, i) => (i ? `${LOOSE}.${i}` : LOOSE));
const QUESTIONS = [
  { ...toQuestion(WS, bead(ASKS, ASKS_TITLE)), space: 'Work', comments: [] },
  // Under a P0 that is not yours: in no tree on this board, in neither `unhomed` nor
  // `assigned`, and therefore on no pill of yours. It is what keeps the assertion below
  // from being satisfied by a list that has stopped narrowing at all.
  { ...toQuestion(WS, bead(OTHERS, OTHERS_TITLE)), space: 'Work', comments: [] },
  ...LOOSE_IDS.map((id, i) => ({
    ...toQuestion(WS, bead(id, i ? `Another one filed with no parent, ${i}` : LOOSE_TITLE)),
    space: 'Work',
    comments: [],
  })),
];

/** What `/api/bead` answers for the bead that is asking — `bd show` plus its thread. */
const detail = (id) => ({
  workspace: WS,
  id,
  title: id === ASKS ? ASKS_TITLE : id,
  status: 'open',
  priority: 1,
  issue_type: 'task',
  owner: 'adam@example.com',
  labels: ['human', 'inbox', 'phone'],
  description: 'The caret leads the row rather than ending it.',
  acceptance_criteria: 'One of the two, decided.',
  notes: '',
  close_reason: '',
  closed_at: null,
  parent: P0.id,
  dependent_count: 0,
  dependencies: [{ id: P0.id, title: P0.title, status: 'open', dependency_type: 'parent-child' }],
  comments: [{ id: `${id}-c1`, author: 'worker (adam)', text: 'Both read fine; it is a taste call.', created_at: '2026-08-14T11:00:00.000Z' }],
  noP0: false,
  model: null,
});

/** The board, as `rootCard` in lib/server.js builds it — flat, pre-order, a depth each. */
const board = () => ({
  owned: true,
  // The question under the epic is homed; the loose one is in neither map's `under` and in
  // `unhomed`, which is what keeps it in the list and gives the scroll anchor something to
  // be. See the header.
  under: { [`${WS}/${ASKS}`]: P0.id },
  unhomed: Object.fromEntries(LOOSE_IDS.map((id) => [`${WS}/${id}`, true])),
  // bc-khoe.29's sixth field, and the kind pills' own narrowing — keyed by **bead** where
  // the two above are keyed by row, because a pull request has no row in either of them.
  // lib/server.js fills it with every bead carrying your `owner:<handle>` and everything
  // under one at any depth, so here that is the epic and its whole tree. The loose
  // questions are under nothing and `b-p0.3` is under somebody else's P0, so neither is in
  // it — the first is kept anyway by `unhomed` (bc-i7tw) and the second is not kept at all.
  assigned: Object.fromEntries([[`${WS}/${P0.id}`, true], ...TREE.map((r) => [r.key, true])]),
  roots: [
    {
      key: `${WS}/${P0.id}`,
      workspace: WS,
      id: P0.id,
      title: P0.title,
      status: 'open',
      issue_type: 'epic',
      owners: ['adam'],
      open: TREE.filter((r) => r.status !== 'closed').length,
      inFlight: 0,
      waitingOn: null,
      advocate: null,
      tree: TREE,
    },
  ],
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
        rootboard: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    if (p === '/api/bead') return json(detail(url.searchParams.get('id') || ''));
    // What `expand` asks for on the way in to the card — the parsed question and its
    // thread. Merged onto the row the page already has, so an empty thread is enough.
    if (p === '/api/question') {
      const id = url.searchParams.get('id') || '';
      return json({ ...(QUESTIONS.find((q) => q.id === id) || {}), comments: [] });
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
const { s, close } = await launchChrome('beadcause-p0board-');

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
  const file = path.join(OUT, `p0board-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The whole screen from outside: where the two controls are, what the list holds, and what
 * the board is saying about questions.
 *
 * `cardTop` and `headTop` are `getBoundingClientRect().top` because that is the only thing
 * either bead can be seen through — document order is identical before and after the fix,
 * and so is every class on every node.
 */
const VIEW = `(() => {
  const top = (el) => el ? Math.round(el.getBoundingClientRect().top) : null;
  const tap = document.querySelector('.p0-card .p0-tap');
  const head = document.querySelector('.p0-board .p0-kind');
  const tree = document.querySelector('.p0-tree');
  const listText = document.querySelector('#list')?.textContent || '';
  const open = document.querySelector('#list .card.open');
  return {
    cardTop: top(tap),
    headTop: top(head),
    headText: (head?.textContent || '').replace(/\\s+/g, ' ').trim(),
    cardText: (document.querySelector('.p0-card .p0-head')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    cards: document.querySelectorAll('.p0-card').length,
    treeHeight: tree ? Math.round(tree.getBoundingClientRect().height) : 0,
    rows: document.querySelectorAll('.p0-row').length,
    asksRow: document.querySelectorAll('.p0-row.asks').length,
    listRows: document.querySelectorAll('#list > .card').length,
    listKeys: [...document.querySelectorAll('#list > .card[data-key]')].map((c) => c.dataset.key),
    hasLoose: listText.includes(${JSON.stringify(LOOSE_TITLE)}),
    answerBtns: document.querySelectorAll('.p0-bead .p0-answer').length,
    openKey: open?.dataset?.key || '',
    openBox: !!open?.querySelector('[data-role="answer"]'),
    scrollY: Math.round(window.scrollY),
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

  /* ---- bc-rfnr.9.7: what the list holds once the board is drawing the beads ---- */

  let v = await evalJs(VIEW);
  check('My Epics is the board, with one epic on it and every tree shut', v.cards === 1 && v.rows === 0, `${v.cards} cards`);
  check(
    'the bead the board draws is not drawn again underneath it',
    !v.listKeys.includes(`${WS}/${ASKS}`),
    v.listKeys.join(' ') || 'no rows'
  );
  // bc-khoe.28: and neither is anything else. The list below the board was the second,
  // flatter copy of what the cards already hold, and on My Epics there is now no list at
  // all — not the question under nobody's P0 either, which lives on the Questions pill.
  check('AND THERE IS NO LIST UNDER IT AT ALL', v.listRows === 0 && !v.hasLoose, `${v.listRows} rows`);
  // Four levels down a tree that is folded by default is not findable; this is.
  check('the collapsed card says one bead under it is asking you', /1 asks you/.test(v.cardText), v.cardText);
  await shot('board');

  /* ---- bc-khoe.28: and the other pill is the list, with no board over it ---- */

  await press('button.viewpill[data-pill="question"]');
  await sleep(500);
  v = await evalJs(VIEW);
  // Gone, not collapsed to its shut heading line: a view shows its own kind, and half a
  // board over a list of questions is the thing this bead is about.
  check('THE BOARD IS NOT ON THE QUESTIONS PILL IN ANY FORM', v.cards === 0 && v.headTop === null, `${v.cards} cards`);
  check('and the question under nobody’s P0 is', v.hasLoose && v.listKeys.includes(`${WS}/${LOOSE}`), v.listKeys.join(' ') || 'no rows');
  check('so there is a card in the list for the scroll anchor to find', v.listRows >= 1, `${v.listRows} rows`);
  // bc-7wwbb: this asked the opposite until bc-khoe.29, and the inversion is the bead's
  // whole finding rather than a relaxation of it. "Not doubled into it" was about a bead
  // being drawn twice on one screen — and the assertion two lines up is the half of that
  // which is still true, because there is no board here to draw it the first time. What
  // `under` did on this pill was remove a question in an epic of yours from the pill whose
  // whole job is to show it; `assignedToMe` keeps it, because the bead above it is yours.
  check(
    'AND THE BEAD THE BOARD DRAWS IS ON THIS PILL, BECAUSE IT IS A QUESTION IN AN EPIC OF YOURS',
    v.listKeys.includes(`${WS}/${ASKS}`),
    v.listKeys.join(' ') || 'no rows'
  );
  // And the pill is still a narrowing. Without this the line above passes on a build with
  // `assignedToMe` deleted — an unnarrowed list holds that row too — which is exactly the
  // shape this fixture was in before it carried `assigned` at all.
  check('and a question under somebody else’s P0 is not', !v.listKeys.includes(`${WS}/${OTHERS}`), v.listKeys.join(' ') || 'no rows');
  await shot('questions');

  await press('button.viewpill[data-pill="epics"]');
  await sleep(500);
  v = await evalJs(VIEW);
  check('and tapping My Epics brings the board back and takes the list away', v.cards === 1 && v.listRows === 0, `${v.cards} cards, ${v.listRows} rows`);

  /* ---- bc-rfnr.9.9: the tap must not move the card out from under your thumb ---- */

  const cardWas = v.cardTop;
  await press('.p0-card .p0-tap');
  await waitFor(`document.querySelector('.p0-tree') !== null`, 4000);
  await sleep(400);
  v = await evalJs(VIEW);
  check('tapping the card opens its tree', v.rows === LIVE, `${v.rows} of ${LIVE} rows`);
  // Without this the measurement below is vacuous: the jump is exactly the height of what
  // opened, so a tree of no height cannot demonstrate anything.
  check('and the tree is tall enough for the jump to be real', v.treeHeight > 300, `${v.treeHeight}px`);
  check(
    'THE CARD YOU TAPPED IS STILL WHERE YOU TAPPED IT',
    cardWas !== null && v.cardTop !== null && Math.abs(v.cardTop - cardWas) <= 2,
    `${cardWas} → ${v.cardTop} (scrollY ${v.scrollY})`
  );
  check('the bead that is asking you is marked in the tree', v.asksRow === 1, `${v.asksRow} marked`);
  check('nothing overflows a 393px phone', v.wide);
  await shot('open');

  /* ---- and the heading is a heading now, not the fold it was until bc-khoe.28 ---- */

  check('the section heading says how many are asking you', /1 asks you/.test(v.headText), v.headText);
  const wasCards = v.cards;
  await press('.p0-board .p0-kind');
  await sleep(400);
  v = await evalJs(VIEW);
  // With no list beneath it, a fold would have been a control whose whole effect was to
  // leave the view blank — and persisted, blank for good. Pressing where it used to be
  // must do nothing at all.
  check('and pressing it does nothing, because there is nothing to fold', v.cards === wasCards, `${v.cards} cards`);

  /* ---- and the question is answerable from the bead it is on ---- */

  await press(`[data-p0bead="${WS}/${ASKS}"]`);
  await waitFor(`document.querySelector('.p0-bead .md') !== null`, 6000);
  v = await evalJs(VIEW);
  check('the bead expands to its own details', v.answerBtns === 1, `${v.answerBtns} answer controls`);
  await shot('bead');

  const tapped = await press('.p0-bead .p0-answer');
  await waitFor(`document.querySelector('#list .card.open') !== null`, 6000);
  v = await evalJs(VIEW);
  check('tapping it opens the question, full screen', tapped && v.openKey === `${WS}/${ASKS}`, v.openKey || 'nothing opened');
  check('with a box to answer in', v.openBox);
  await shot('answer');

  /* ---- and closing it puts the row back rather than leaving it in the list ---- */

  await press('#list .card.open [data-act="collapse"]');
  await sleep(600);
  v = await evalJs(VIEW);
  // And on My Epics that takes the whole list with it — the sheet was the one thing
  // holding a list open here (`listHere`, bc-khoe.28), so what is left is the board alone.
  check('collapsing it drops the row back out of the list', !v.listKeys.includes(`${WS}/${ASKS}`) && v.listRows === 0, v.listKeys.join(' ') || 'no rows');
  check('and the tree it was opened from is still there', v.rows === LIVE, `${v.rows} of ${LIVE} rows`);
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
