#!/usr/bin/env node
// Starting an epic from the board, driven for real. bc-s8mc.
//
//     node scripts/p0start-check.mjs [--out=/tmp/shots] [--baseline]
//
// test/p0start.mjs renders the picker out of a `node:vm` and drives the two routes against
// a fake `bd`. Four things about this feature are in neither half, and every one of them
// leaves a page that looks perfectly fine:
//
//   • **The page must not move out from under the tap.** This used to be the sharp one:
//     the picker opened at the foot of the board, which is *above* the inbox list, and
//     `capturePlace` anchors the scroll on the first card in that list — so a repaint that
//     grew the board scrolled the page down by exactly the height of what had opened, the
//     button you pressed leaving the screen. bc-khoe.27.2 moved the picker onto ＋, which is
//     fixed to the bottom corner and adds no flow height, so the jump is designed out rather
//     than held still by `keepTheScreenStill`. The reading stays, because "designed out" is a
//     claim about layout that only a browser can settle — and because the panel opening
//     *upward* off the top of a small screen is the new way to lose a row.
//   • **The tap has to be delegated to.** Every handler on the inbox hangs off `#list`, and
//     these controls are buttons drawn inside a section drawn inside it — one of them, the
//     ↩ on a card, sits in a row beside a link and under a summary that is itself a button.
//   • **The write has to be a POST that carries the bead.** The renderer puts the workspace
//     and the id on `data-` attributes; whether the handler reads them, and which route it
//     posts to, is only visible from outside.
//   • **A refusal has to leave a control you can press again.** The daemon answers 409 for
//     every race the picker cannot see, and the whole acceptance criterion is that this is
//     loud rather than a card that silently never appears.
//
// Same shape as scripts/p0bead-check.mjs: the real public/app.js in a headless Chrome the
// size of a phone, against fixtures served from this process, so it never touches a daemon,
// a bead or iTerm. `--baseline` serves the committed app.js and style.css, which have no
// picker at all, so it must fail.
//
// Everything below drives `#compose` — the ＋ in the bottom right — because on `My Epics`
// that button *is* this create (bc-khoe.27.2). The page is left on the kind it lands on,
// which is `My Epics`, so no pill is tapped to get there.
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
const TOKEN = 'p0start-check-token';
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
const STARTED = { id: 'a-p0', title: 'Make the phone the whole interface' };
const PICK = 'a-next';
const DOOMED = 'a-gone';

// Enough questions under the started epic that the list below the board is longer than the
// screen — without something to scroll, the place-restore this check is about has nothing
// to anchor on and the whole assertion passes for the wrong reason.
const QUESTIONS = Array.from({ length: 8 }, (_, i) => ({
  ...toQuestion(WS, {
    id: `a-p0.${i + 1}`,
    title: `A question under the epic, number ${i + 1}`,
    issue_type: 'task',
    status: 'open',
    priority: 2,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    comment_count: 0,
    dependent_count: 0,
    description: 'A short brief, with nothing clever in it, repeated so the list is long.',
  }),
  space: 'Work',
  comments: [],
}));

/** Which P0s are started right now — the fixture the POST below actually moves. */
const started = new Set([STARTED.id]);

const card = (id, title) => ({
  key: `${WS}/${id}`,
  workspace: WS,
  id,
  title,
  status: 'in_progress',
  issue_type: 'epic',
  owners: ['adam'],
  open: 3,
  inFlight: 0,
  waitingOn: null,
  advocate: null,
  tree: [{ id: `${id}.1`, title: 'something under it', status: 'open', parent: id, depth: 1, key: `${WS}/${id}.1`, pending: false }],
});

const OFFERS = [
  { id: PICK, title: 'An epic you have not started yet', open: 12 },
  { id: DOOMED, title: 'One somebody closed while you were reading', open: 4 },
];

const board = () => ({
  owned: true,
  under: Object.fromEntries(QUESTIONS.map((q) => [q.key, STARTED.id])),
  unhomed: {},
  roots: [...started].map((id) => card(id, id === STARTED.id ? STARTED.title : OFFERS.find((o) => o.id === id)?.title || id)),
  startable: OFFERS.filter((o) => !started.has(o.id)).map((o) => ({
    key: `${WS}/${o.id}`,
    workspace: WS,
    id: o.id,
    title: o.title,
    issue_type: 'epic',
    open: o.open,
  })),
});

let posts = [];

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
    // The two doors. `a-gone` is the race the picker cannot see — closed since the list was
    // drawn — and answers exactly what the daemon does: a 409 with a sentence.
    if (p === '/api/bead/start' || p === '/api/bead/unstart') {
      return void read((body) => {
        posts.push({ path: p, ...body });
        if (body.id === DOOMED) return json({ error: `${DOOMED} is closed — a P0 that landed does not lead the screen` }, 409);
        if (p === '/api/bead/start') started.add(body.id);
        else started.delete(body.id);
        json({ workspace: WS, id: body.id, started: p === '/api/bead/start' });
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
const check = (name, ok, detailText) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detailText ? ` — ${detailText}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-p0start-');

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
  const file = path.join(OUT, `p0start-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The board from outside: the controls, where they are on the screen, and how far down the
 * page has been scrolled.
 *
 * `top` is `getBoundingClientRect().top` — where the thing is *on the phone* — because that
 * is the only reading that catches the page moving under a tap. Document order is what the
 * vm suite already proves.
 */
const VIEW = `(() => {
  const el = (sel) => document.querySelector(sel);
  const top = (e) => e ? Math.round(e.getBoundingClientRect().top) : null;
  const pick = el('#compose');
  const panel = el('#compose-epics');
  return {
    // .p0-pick is the button that used to be at the foot of the board. Counted so the
    // move is asserted rather than assumed: two controls doing one thing, with the lower
    // one out of a thumb's reach, is exactly what bc-khoe.27.2 undoes.
    stale: document.querySelectorAll('.p0-pick').length,
    picks: pick && !pick.closest('[hidden]') ? 1 : 0,
    pickTag: pick?.tagName || '',
    pickLabel: pick?.getAttribute('aria-label') || '',
    pickControls: pick?.getAttribute('aria-controls') || '',
    pickExpanded: pick?.getAttribute('aria-expanded') || '',
    pickTop: top(pick),
    pickHeight: pick ? Math.round(pick.getBoundingClientRect().height) : 0,
    pickDisabled: pick ? !!pick.disabled : null,
    panelShut: panel ? !!panel.hidden : null,
    panelTop: panel && !panel.hidden ? top(panel) : null,
    // The panel is anchored to the bottom corner and grows upward, so a list longer than
    // the screen leaves through the *top* — where nothing can scroll it back. It has a
    // max-height and its own scroller for that, and this is the reading that proves it.
    panelBottomGap: panel && !panel.hidden ? Math.round(window.innerHeight - panel.getBoundingClientRect().bottom) : null,
    // Scoped to the panel while it is open: the rows stay in the DOM behind a hidden
    // panel, the same way the repo chips next door do, so an unscoped query would report
    // a picker still offering an epic it has already shut on.
    cands: [...document.querySelectorAll('#compose-epics:not([hidden]) .p0-cand')].map((e) => e.dataset.bead),
    candHeight: Math.round(el('#compose-epics:not([hidden]) .p0-cand')?.getBoundingClientRect().height || 0),
    candTop: top(el('#compose-epics:not([hidden]) .p0-cand')),
    offs: document.querySelectorAll('.p0-off').length,
    cards: [...document.querySelectorAll('.p0-card')].map((e) => e.dataset.key),
    // Every \`.pagescroll\` on the page, which is where the scrolling actually happens: since
    // the app shell (v69) the document itself does not scroll at all, so \`window.scrollY\` is
    // 0 whatever moved — a diagnostic saying "nothing moved" beside a reading saying the
    // button moved 149px. Measured with the fix taken out: \`0 → 149\` on \`#list\`.
    scrollY: [...document.querySelectorAll('.pagescroll')].map((e) => Math.round(e.scrollTop)).join('/'),
    toast: (el('.toast, #toast')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    wide: document.documentElement.scrollWidth <= window.innerWidth,
    widest: Math.max(0, ...[...document.querySelectorAll('.p0-cand, #compose, .p0-card')].map((e) => Math.round(e.getBoundingClientRect().right))),
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
  await waitFor(`document.querySelector('#compose') !== null`, 4000);

  let v = await evalJs(VIEW);
  const wasTop = v.pickTop;
  const wasScroll = v.scrollY;
  check('＋ is the way to start an epic', v.picks === 1 && v.pickTag === 'BUTTON', `${v.picks} found`);
  check('AND THE BOARD NO LONGER OFFERS ITS OWN', v.stale === 0, `${v.stale} at the foot of the board`);
  check('a thumb can find it', v.pickHeight >= 34, `${v.pickHeight}px`);
  check('it says what it would make, and names the panel that would open', /epic/i.test(v.pickLabel) && v.pickControls === 'compose-epics', `${v.pickLabel} → ${v.pickControls}`);
  check('and it is shut until it is asked', v.pickExpanded === 'false' && v.panelShut === true && v.cands.length === 0);
  check('the card already on the board offers the reverse', v.offs === 1, `${v.offs} found`);
  await shot('shut');

  /* ---- the tap: the list opens, and the page does not run away with it ---- */

  await press('#compose');
  await waitFor(`document.querySelectorAll('.p0-cand').length > 0`, 4000);
  v = await evalJs(VIEW);
  check('tapping it opens the list of P0s you could start', v.cands.length === 2, v.cands.join(', '));
  check('each one is a control a thumb can hit', v.candHeight >= 34, `${v.candHeight}px`);
  // THE ONE THIS CHECK EXISTS FOR, and it survived the move rather than being retired by
  // it. Opening the picker used to grow the board above the inbox list, and `capturePlace`
  // anchors on the first card in that list — so the page scrolled down by exactly the
  // height of what had opened, measured 0 → 486 on the neighbouring surface (bc-rfnr.9.4).
  // A fixed panel adds no flow height, which is the claim; this is the reading that
  // settles it, and it also catches a repaint that scrolled the list for some other reason
  // while the panel was open over it.
  check(
    'and the button you pressed is still where you pressed it',
    wasTop !== null && v.pickTop !== null && Math.abs(v.pickTop - wasTop) <= 2,
    `${wasTop} → ${v.pickTop} (scroll ${wasScroll} → ${v.scrollY})`
  );
  check('THE PAGE UNDER IT DID NOT MOVE EITHER', v.scrollY === wasScroll, `${wasScroll} → ${v.scrollY}`);
  check('the list opened above the button, where the panel is anchored', v.candTop < v.pickTop, `${v.pickTop} → ${v.candTop}`);
  check('and it did not grow off the top of the phone', v.panelTop !== null && v.panelTop >= 0, `panel top ${v.panelTop}`);
  check('nothing overflows a 393px phone', v.wide && v.widest <= VP.width, `widest ${v.widest}px`);
  await shot('open');

  /* ---- a refusal has to be loud and leave a control you can press again ---- */

  posts = [];
  await press(`.p0-cand[data-bead="${DOOMED}"]`);
  await sleep(1200);
  v = await evalJs(VIEW);
  check('choosing one posts to /api/bead/start with the bead on it', posts.length === 1 && posts[0].path === '/api/bead/start' && posts[0].id === DOOMED, JSON.stringify(posts[0] || {}));
  check('A REFUSAL IS ON THE SCREEN, not a card that never appears', /closed/.test(v.toast), v.toast || '(nothing said)');
  check('and the row it was refused for is still there to press again', v.cands.includes(DOOMED));
  await shot('refused');

  /* ---- and the one that works: the picker shuts and the card arrives ---- */

  posts = [];
  await press(`.p0-cand[data-bead="${PICK}"]`);
  await waitFor(`document.querySelectorAll('.p0-card').length === 2`, 6000);
  v = await evalJs(VIEW);
  check('starting one posts it too', posts.some((x) => x.path === '/api/bead/start' && x.id === PICK), JSON.stringify(posts));
  check('IT IS A CARD WITHOUT A RELOAD', v.cards.includes(`${WS}/${PICK}`), v.cards.join(', '));
  check('the picker shuts, and stops offering what you just started', v.pickExpanded === 'false' && v.panelShut === true && !v.cands.includes(PICK));
  await shot('started');

  /* ---- the reverse, from the card ---- */

  posts = [];
  await press(`.p0-off[data-bead="${PICK}"]`);
  await waitFor(`document.querySelectorAll('.p0-card').length === 1`, 6000);
  v = await evalJs(VIEW);
  check('↩ posts to /api/bead/unstart', posts.some((x) => x.path === '/api/bead/unstart' && x.id === PICK), JSON.stringify(posts));
  check('and the card goes, leaving the one you were already on', v.cards.length === 1 && v.cards[0] === `${WS}/${STARTED.id}`, v.cards.join(', '));
  await shot('off');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
