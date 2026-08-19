#!/usr/bin/env node
//
// One status filter over the tree of the epic you have open.
//
//   node scripts/p0filter-check.mjs [--baseline] [--out=<dir>]
//
// bc-rfnr.9.6, moved into the tab by bc-grut. The control — Not closed · All · Closed —
// sat between the heading and the cards while the trees were on the board; the trees open
// full-tab now, so the filter went with them and every tap below has to open an epic
// first. test/p0card.mjs has the renderer and the handler's source. What it cannot reach
// is the four ways this goes wrong in a browser with every unit test still green:
//
//   • **The tap has to be delegated to at all.** Every handler on the inbox hangs off
//     `#list` and resolves through `closest('[data-act]')`, so a control drawn outside
//     that element renders perfectly and does nothing. The board's heading has already
//     cost this repo that failure once (see p0fold-check.mjs), and the chips are new
//     markup in the same section.
//   • **Three chips have to fit a 393px phone on one line.** It is a segmented switch;
//     with its last segment wrapped onto a row of its own it is three chips again, and
//     an option off the right edge is an option nobody finds. Read as the chips' own
//     geometry — same top, inside the viewport — rather than as a class.
//   • **The pick has to survive a repaint and a reload.** The board is one reconcile
//     chunk replaced whole every 25 seconds, and the preference is written to
//     `localStorage` on the tap and read back in the state initialiser at boot: either
//     end can be missing with the page looking right all session.
//   • **Filtering the tree must not touch the list underneath.** `underOwnedRoots` narrows
//     the inbox off the board *data*; a filter that reached it would take questions off
//     the screen with nothing saying where they went. Counted either side of every tap.
//   • **And it must not reach the collapsed cards either** (bc-grut). The board's own
//     summary — `2 of 5 done` — counts the whole tree on purpose, so that nothing on a
//     grid of two dozen cards moves because of a control that is not on the screen. It is
//     read either side of a tap on `Closed`, which is the tap that would move it.
//
// And one thing that is none of those: with `Closed` picked, the rows kept only to hold
// a branch up have to be visibly different from the rows that matched. That mark is the
// stylesheet's half (`.p0-row.via`), so it is read as a computed border style — which
// makes this a check of the *pair* of files, and is what [v62](../docs/sw-cache/v62.md)
// is about.
//
// Same shape as p0fold-check.mjs: the real public/app.js in a headless Chrome the size of
// a phone, against fixtures served from this process, so it never touches a daemon, a
// bead or iTerm. `--baseline` serves the committed app.js and style.css, which have never
// heard of the filter, so it must fail.
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
const TOKEN = 'p0filter-check-token';
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
const DONE = { id: 'b-p0', title: 'Everything here has shipped' };

/**
 * The awkward tree, and both shapes are in it on purpose: `a-p0.1` is **closed with an
 * open child**, `a-p0.2` is **open with a closed child**. Each is one direction in which
 * the filter excludes a parent while keeping what hangs off it, and the row that holds
 * the branch up is what this check is really about.
 */
const TREE = [
  { id: 'a-p0.1', title: 'Landed, with work still under it', status: 'closed', parent: 'a-p0', depth: 1 },
  { id: 'a-p0.1.1', title: 'Still going, under a landed parent', status: 'open', parent: 'a-p0.1', depth: 2 },
  { id: 'a-p0.2', title: 'Open, with something delivered under it', status: 'open', parent: 'a-p0', depth: 1 },
  { id: 'a-p0.2.1', title: 'Delivered', status: 'closed', parent: 'a-p0.2', depth: 2 },
  { id: 'a-p0.3', title: 'Waiting on somebody', status: 'blocked', parent: 'a-p0', depth: 1 },
];

/** An epic where everything has landed — the card the default filter empties. */
const DONE_TREE = [
  { id: 'b-p0.1', title: 'One that shipped', status: 'closed', parent: 'b-p0', depth: 1 },
  { id: 'b-p0.2', title: 'Another that shipped', status: 'closed', parent: 'b-p0', depth: 1 },
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

// One question, under the epic. It is the row the filter must not disturb: with a board
// on, the list below it is your epics' descendants and nothing else, so a filter that
// reached `underOwnedRoots` would take it off the screen.
const QUESTIONS = [{ ...toQuestion(WS, bead('a-p0.2', 'Open, with something delivered under it')), space: 'Work', comments: [] }];

const row = (r) => ({ ...r, key: `${WS}/${r.id}`, pending: false });

/** The board, as `rootCard` in lib/server.js builds it — trees and all, since bc-rfnr.9.1. */
const board = () => ({
  owned: true,
  under: { [`${WS}/a-p0.2`]: 'a-p0' },
  unhomed: {},
  roots: [
    { p0: P0, tree: TREE },
    { p0: DONE, tree: DONE_TREE },
  ].map(({ p0, tree }) => ({
    key: `${WS}/${p0.id}`,
    workspace: WS,
    id: p0.id,
    title: p0.title,
    status: 'open',
    issue_type: 'epic',
    owners: ['adam'],
    open: tree.filter((r) => r.status !== 'closed').length,
    inFlight: 0,
    waitingOn: null,
    advocate: null,
    tree: tree.map(row),
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
        rootboard: board(),
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
const { s, close } = await launchChrome('beadcause-p0filter-');

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
  const file = path.join(OUT, `p0filter-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The filter and the tree it produced, from outside.
 *
 * `via` is read off the computed `border-left-style` rather than off the class, because
 * the mark is the stylesheet's half of the feature: an app.js beside a stale style.css
 * draws those rows as ordinary matched ones, and then a `Closed` tree is a list of open
 * beads with nothing saying why — which reads as the filter not working.
 */
const SECTION = `(() => {
  const chips = [...document.querySelectorAll('.p0-status .chip')];
  const rows = [...document.querySelectorAll('.p0-row')];
  const box = (el) => el.getBoundingClientRect();
  return {
    chips: chips.map((c) => ({
      id: c.dataset.status,
      label: (c.textContent || '').replace(/\\s+/g, ' ').trim(),
      on: c.getAttribute('aria-pressed') === 'true',
      top: Math.round(box(c).top),
      right: Math.round(box(c).right),
      tall: Math.round(box(c).height),
      tag: c.tagName,
      inList: c.closest('#list') !== null,
      inFull: c.closest('.p0-full') !== null,
    })),
    full: document.querySelectorAll('.p0-full').length,
    ids: rows.map((r) => r.querySelector('.p0-row-id')?.textContent || ''),
    via: rows
      .filter((r) => getComputedStyle(r).borderLeftStyle === 'dashed')
      .map((r) => r.querySelector('.p0-row-id')?.textContent || ''),
    trees: document.querySelectorAll('.p0-tree').length,
    open: document.querySelectorAll('.p0-card.on').length,
    none: [...document.querySelectorAll('.p0-none')].map((n) => (n.textContent || '').replace(/\\s+/g, ' ').trim()),
    hints: [...document.querySelectorAll('.p0-hint')].map((n) => (n.textContent || '').trim()),
    listRows: document.querySelectorAll('#list .card').length,
    wide: document.documentElement.scrollWidth <= window.innerWidth,
  };
})()`;

const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};

/**
 * Open one epic's tab, by its place on the grid — the filter is about what is in a tree,
 * and since bc-grut a tree is only ever on the screen inside a tab.
 *
 * One at a time is the whole shape now rather than a caution about detached nodes: the
 * tab is a fixed layer over the viewport, so a second one would stack on the first, and
 * `state.p0open` is cleared on every tap for exactly that reason.
 */
const openCard = async (i) => {
  const ok = await evalJs(`(() => {
    const b = document.querySelectorAll('.p0-cards .p0-card .p0-tap')[${i}];
    if (b) b.click();
    return !!b;
  })()`);
  await sleep(400);
  return ok;
};

/** Back to the board — the one control the tab offers, and the only way out by pointer. */
const back = async () => {
  const ok = await press('.p0-full .p0-back');
  await sleep(400);
  return ok;
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
  await evalJs(`localStorage.removeItem('beadcause.p0status')`);
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-card') !== null`, 15000);

  /* ---- collapsed, where the summary is the whole of what a card says ---- */

  let v = await evalJs(SECTION);
  check(
    'a collapsed card says how far along the epic is, counted over the whole tree',
    v.hints.some((h) => /2 of 5 done/.test(h)) && v.hints.some((h) => /2 of 2 done/.test(h)),
    v.hints.join(' | ')
  );
  check('and the board carries no filter of its own any more', v.chips.length === 0, `${v.chips.length} chips`);
  const summary = v.hints.join(' | ');

  /* ---- the default: not closed, on a phone that has never been told otherwise ---- */

  await openCard(0);
  v = await evalJs(SECTION);
  check('the tap opens one tab, over the board rather than inside it', v.full === 1 && v.open === 1 && v.trees === 1, `${v.full} tabs, ${v.trees} trees`);
  check('there is one filter, and it is in the tab with the tree it narrows', v.chips.length === 3 && v.chips.every((c) => c.inFull), `${v.chips.length} chips, ${v.chips.filter((c) => c.inFull).length} in the tab`);
  check(
    'it offers not-closed, all and closed, and defaults to the first',
    v.chips.map((c) => c.id).join() === 'live,all,closed' && v.chips[0].on,
    v.chips.map((c) => `${c.label}${c.on ? '*' : ''}`).join(' · ')
  );
  check('the chips are buttons inside #list, so the tap is delegated to at all', v.chips.every((c) => c.tag === 'BUTTON' && c.inList));
  // A segmented switch with its last segment on a row of its own is three chips again.
  check('all three fit one line on a 393px phone', new Set(v.chips.map((c) => c.top)).size === 1 && Math.max(...v.chips.map((c) => c.right)) <= VP.width, `right edge ${Math.max(...v.chips.map((c) => c.right))}px`);
  check('a thumb can find them', v.chips.every((c) => c.tall >= 32), `${Math.min(...v.chips.map((c) => c.tall))}px`);
  check('nothing overflows the phone', v.wide);
  check('the open and blocked beads are drawn', v.ids.includes('a-p0.1.1') && v.ids.includes('a-p0.3'));
  check('the closed ones are not', !v.ids.includes('a-p0.2.1'), v.ids.join(' '));
  // The closed parent is kept anyway, or its open child indents under the wrong bead.
  check('but a closed parent with an open child is held up, and marked', v.ids.includes('a-p0.1') && v.via.includes('a-p0.1'), `via: ${v.via.join(' ') || 'none'}`);
  const listRows = v.listRows;
  // Since bc-rfnr.9.7 the question under the epic is a row in that epic's tree and is not
  // drawn a second time underneath the board. What this still pins is the next line: the
  // filter narrows the trees and does not reach the list, whatever is in it.
  check('the board is the only place its own beads are drawn', listRows === 0, `${listRows} rows`);
  await shot('live');

  // The other epic, whose whole tree this filter excludes. Its own tab, because only one
  // is ever open — and the sentence has to be the filter's rather than the tracker's, or
  // an epic with two closed children reads as one nobody has broken down.
  await back();
  await openCard(1);
  v = await evalJs(SECTION);
  check('an epic the filter empties says so rather than reading as unbroken-down', v.none.some((t) => /matches the filter/.test(t)), v.none.join(' | '));
  await back();
  await openCard(0);

  /* ---- closed: the delivered work, with its ancestors intact ---- */

  const tapped = await press('.p0-status [data-status="closed"]');
  await sleep(400);
  v = await evalJs(SECTION);
  // The other epic's closed children are not asserted here any more: only one tab is ever
  // open, so `b-p0.1` is not on the screen. That the pick reaches it is its own check below.
  check('tapping Closed shows the closed descendants', tapped && v.ids.includes('a-p0.2.1'), v.ids.join(' '));
  check('with their ancestors intact, so nothing indents under the wrong bead', v.ids.includes('a-p0.2'), v.ids.join(' '));
  check('and those ancestors are drawn as context rather than as answers', v.via.includes('a-p0.2') && !v.via.includes('a-p0.2.1'), `via: ${v.via.join(' ')}`);
  check('a leaf that neither matched nor holds anything up is gone', !v.ids.includes('a-p0.3'));
  check('the list underneath is untouched', v.listRows === listRows, `${listRows} → ${v.listRows}`);
  check('and still overflows nothing', v.wide);
  await shot('closed');

  // And the board behind it did not move. `2 of 5 done` is counted over the whole tree on
  // purpose — a summary that answered to this control would be a grid of two dozen cards
  // rewriting itself because of a chip inside one epic's tab. bc-grut.
  check('the collapsed cards behind the tab say exactly what they said before the tap', v.hints.join(' | ') === summary, `${summary} → ${v.hints.join(' | ')}`);

  // One pick, not one per card: it is `state.p0status`, asked once, and the next epic you
  // open is drawn the way you last asked for.
  await back();
  await openCard(1);
  v = await evalJs(SECTION);
  check('and the pick follows you into the next epic you open', v.ids.includes('b-p0.1') && v.ids.includes('b-p0.2'), v.ids.join(' '));
  await back();
  await openCard(0);

  /* ---- a poll must not undo it ---- */

  await press('#refresh');
  await sleep(1200);
  v = await evalJs(SECTION);
  check('a repaint 25 seconds later leaves the pick alone', v.chips.find((c) => c.id === 'closed')?.on === true && v.ids.includes('a-p0.2.1'));

  /* ---- and neither must a reload: this one is a standing preference ---- */

  check('which is stored rather than remembered', (await evalJs(`localStorage.getItem('beadcause.p0status')`)) === 'closed');
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelector('.p0-card') !== null`, 15000);
  // Which epic was open is deliberately *not* persisted — a phone that came back to a tab
  // over the inbox would be a screen you had to dismiss before you could see it — so the
  // reload lands on the board and the tab is opened again to read the chips.
  check('a reload comes back to the board rather than to the tab', (await evalJs(SECTION)).full === 0);
  await openCard(0);
  v = await evalJs(SECTION);
  check('and the filter comes back where you left it', v.chips.find((c) => c.id === 'closed')?.on === true && v.ids.includes('a-p0.2.1'));

  /* ---- all, which is the board as it was before any of this ---- */

  await press('.p0-status [data-status="all"]');
  await sleep(400);
  v = await evalJs(SECTION);
  check('All draws every descendant, closed and open together', TREE.every((r) => v.ids.includes(r.id)), v.ids.join(' '));
  check('and marks none of them as context', v.via.length === 0, `via: ${v.via.join(' ')}`);
  check('nothing is left saying an epic has nothing under it', v.none.length === 0, v.none.join(' | '));
  await shot('all');

  /* ---- back to the default, which is the state the next run wants ---- */

  await press('.p0-status [data-status="live"]');
  await sleep(400);
  check('and it goes back', (await evalJs(`localStorage.getItem('beadcause.p0status')`)) === 'live');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
