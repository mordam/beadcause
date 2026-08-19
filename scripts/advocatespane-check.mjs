#!/usr/bin/env node
//
// The advocate console as a pane of the shell — in a real Chrome, on a phone-sized screen.
//
//   node scripts/advocatespane-check.mjs
//
// `test/panes.mjs` and `test/montabs.mjs` run the real files in a `node:vm` against a
// hand-made document, and they are the suites that gate a delivery. What they cannot ask is
// the half this file exists for: whether the *real* `panes.js`, `panestage.js`, `montabs.js`
// and stylesheet do what those stand-ins pretend they do. Five of the claims bc-khoe.4 is
// built on are only true in a browser:
//
//   * **it lays out.** This is the one pane with a row of its own inside it, so the column
//     is topbar / pill row / chip row / scroller, one level deeper than any page was. The
//     failure is not a horizontal scrollbar — it is a roster that ends at the first
//     screenful with nothing saying so;
//   * **the scroll position survives** the pane being hidden and shown, which is the single
//     thing this whole epic is buying and is a browser fact and nothing else;
//   * **the sections stand down when the pane goes away.** This pane is the one exception
//     to bc-khoe.30.4's rule that a hidden pane stays live, because the board is a `gh`
//     sweep per repo and the Mirror publishes `view: null` for this device. A unit test can
//     assert the guard; only a browser can count the requests that did not happen;
//   * **one poll, not four.** `montabs.js` is the pane's single registration with the
//     stager and the three sections open no socket of their own — so a document with all of
//     them on it holds exactly one parked `/api/poll`;
//   * **the chip is on the address.** `#advocates?tab=prs` has to survive a reload, which
//     is what makes bc-khoe.30.7's redirect for `/prs` possible at all.
//
// And the compatibility half, at the end: `/monitor` is still its own document until
// bc-khoe.30.7, so the same four files have to draw the same three sections there, off the
// path rather than off the hash.
//
// Not part of `npm test`: it wants Chrome. It is self-contained otherwise — its own HTTP
// server over `public/` with fixtures behind the four payloads, no daemon, no `bd`, no
// tracker. About twenty seconds.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the fixture */

const WORKSPACES = ['beadcause', 'sophab', 'deluvia'];
const SPACEPAY = {
  spaces: [{ name: 'Personal', workspaces: WORKSPACES, count: 3, quiet: false }],
  workspaces: WORKSPACES,
  filter: { space: 'all', workspace: 'all' },
};

/* Enough repos that the roster is longer than a 393x852 screen — the scroll position this
   file is about has to have somewhere to be lost. Twelve of them, three advocated. */
const REPOS = Array.from({ length: 12 }, (_, i) => ({
  name: `repo-${String(i + 1).padStart(2, '0')}`,
  counts: { open: 9 + i, ready: 2, inProgress: 1 },
  sessions: [],
}));

const WORK = {
  workspaces: REPOS,
  advocates: REPOS.slice(0, 3).map((r, i) => ({
    workspace: r.name,
    workers: [],
    queue: 3 - i,
    limit: 4,
    paused: false,
    surveying: false,
  })),
  roster: [],
  elsewhere: [],
  globals: { maxWorkers: 9 },
  observing: true,
  seq: 1,
};

/* The board. One repo with one pull request is all this file needs: what it counts is
   whether `/api/prs` was asked for at all, not what came back. */
const PRS = {
  unavailable: null,
  build: null,
  counts: {},
  repos: [
    {
      key: 'beadcause',
      workspace: 'beadcause',
      repo: 'mordam/beadcause',
      prs: [],
    },
  ],
  observing: true,
  ...SPACEPAY,
};

const QUESTIONS = {
  questions: [],
  requests: [],
  consoles: [],
  ...SPACEPAY,
  scope: 'human',
  rootboard: { roots: [], under: {}, unhomed: {}, owned: false },
  summary: { questions: 0, sessions: 0, proposals: 0 },
  seq: 1,
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
/* The rewrites in `serveStatic` (lib/server.js) this file needs, written out rather than
   imported: importing the server would bring a config, a tracker and a daemon. All nine of
   the console's paths still answer with that document — landing them on the pane is
   bc-khoe.30.7 — and `/prs` is here because the last section of this file drives it. */
const ROUTES = {
  '/monitor': '/monitor.html',
  '/advocates': '/monitor.html',
  '/sessions': '/monitor.html',
  '/work': '/monitor.html',
  '/prs': '/monitor.html',
  '/pulls': '/monitor.html',
};

/** Every parked poll this run has open at once — the number this file is really about. */
let parked = 0;

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const json = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/api/spaces') return json(SPACEPAY);
    if (p === '/api/work') return json(WORK);
    if (p === '/api/prs') return json(PRS);
    if (p === '/api/questions') return json(QUESTIONS);
    /* Parked the way the daemon parks it. An immediate empty answer turns the shell's poll
       into a spin loop against this fixture, and the run is over long before this timer. */
    if (p === '/api/poll') {
      parked += 1;
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 30000);
      res.on('close', () => {
        parked -= 1;
        clearTimeout(timer);
      });
      return;
    }
    if (p === '/auth/whoami') return json({ signedIn: true });
    if (p.startsWith('/api/')) return json({});
    const rel = ROUTES[p] || p;
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

/* --------------------------------------------------------------------- the run */

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

const server = await serve();
const port = server.address().port;
const { s, close } = await launchChrome('beadcause-advocatespane-');
const evaluate = async (expression) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });

  /* ------------------------------------------------- landing on Home, not on this */

  console.log('\nlanding on Home, with the console behind it\n');
  // The token goes in the query string and the view in the hash, which is the shape of
  // every link this app mints. Landing on Home is the case that matters most here: the
  // pane is *built* behind it, and what this asks is what that build costs.
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=x` });
  await sleep(3000);

  const home = await evaluate(`(() => {
    const asked = (path) => performance.getEntriesByType('resource').filter((e) => e.name.includes(path)).length;
    const pane = document.querySelector('div.pane[data-pane="advocates"]');
    return {
      built: window.beadcause.stage.built().join(','),
      pending: Object.keys(window.beadcause.panes.pending()).join(','),
      want: window.beadcause.stage.want(),
      paneHidden: pane.hidden,
      chip: window.beadcause.monTabs.active(),
      // The row is told the pane is not on screen, so no section believes it is showing.
      upAdvocates: window.beadcause.monTabs.up('advocates'),
      upPrs: window.beadcause.monTabs.up('prs'),
      work: asked('/api/work'),
      board: asked('/api/prs'),
      // The console's pill is a control now rather than a link to the document it was.
      pill: document.querySelector('.viewbar a[href="/monitor"]') ? 'a-link' : 'not-a-link',
      // The chip row and the observer mark came down into the pane; neither is in the bar.
      metaInBar: Boolean(document.querySelector('.topbar #observing, .topbar #tally')),
      rowInPane: Boolean(pane.querySelector('#mon-tabs .mon-meta #observing')),
      wide: document.documentElement.scrollWidth > window.innerWidth + 1,
    };
  })()`);
  console.log(`    ${JSON.stringify(home)}\n`);

  check('every pane was built, this one among them', home.built.split(',').includes('advocates'), home.built);
  check('and no container is waiting on a bead any more', home.pending === '', home.pending);
  check('the pane is hidden, and no section believes it is showing', home.paneHidden && !home.upAdvocates && !home.upPrs);
  /* One each, and both are public/warm.js's background warm rather than either section:
     `/api/work` and `/api/prs` are entries on that list and are fetched for the views you
     are *not* on, which is the whole point of it. What this file measures from here is the
     **delta**, because that is the number the fold could have got wrong — a section that
     fetched because its pane was built would show up as a second. */
  check('nothing was fetched twice — the background warm asked, and the sections did not', home.board <= 1 && home.work <= 1, `work ${home.work}, board ${home.board}`);
  check('the Advocates pill is not a link any more', home.pill === 'not-a-link');
  check('the observer mark and the tally are in the pane, not in the shared bar', home.rowInPane && !home.metaInBar);
  check('the shell’s one request still asks for nothing but presence', home.want === 'presence', String(home.want));
  check('and Home fits the screen', !home.wide);

  /* ------------------------------------------------------------- opening the pane */

  console.log('\nopening it\n');
  const open = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const asked = (path) => performance.getEntriesByType('resource').filter((e) => e.name.includes(path)).length;
    // The baseline is whatever the background warm has already spent; what is measured is
    // what showing the pane adds to it.
    const work0 = asked('/api/work');
    const board0 = asked('/api/prs');
    window.beadcause.panes.go('advocates');
    await sleep(900);
    const pane = document.querySelector('div.pane[data-pane="advocates"]');
    const scroller = document.getElementById('mon');
    return {
      showing: window.beadcause.panes.showing(),
      chip: window.beadcause.monTabs.active(),
      up: window.beadcause.monTabs.up('advocates'),
      cards: pane.querySelectorAll('.mon-card').length,
      rowHeight: Math.round(pane.querySelector('#mon-tabs').getBoundingClientRect().height),
      // One thing scrolls, and it is the section under the chip row — not the document,
      // and not the pane. Only what is painted: a hidden pane has no layout box at all.
      visibleScrollers: [...document.querySelectorAll('.pagescroll')].filter((el) => el.offsetParent !== null).length,
      scrolls: scroller.scrollHeight > scroller.clientHeight + 1,
      docScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      wide: document.documentElement.scrollWidth > window.innerWidth + 1,
      // The chip row must be inside the pane's own column, under the shell's pill row.
      belowViewbar: pane.querySelector('#mon-tabs').getBoundingClientRect().top >
        document.querySelector('.viewbar').getBoundingClientRect().top,
      observing: !document.getElementById('observing').hidden,
      work: asked('/api/work') - work0,
      board: asked('/api/prs') - board0,
      hash: location.hash,
      navigations: performance.getEntriesByType('navigation').length,
    };
  })()`);
  console.log(`    ${JSON.stringify(open)}\n`);

  check('the pane is up and the roster drew its cards', open.showing === 'advocates' && open.cards >= 12, `${open.cards} cards`);
  check('the chip row is inside it, under the pill row', open.belowViewbar && open.rowHeight > 20, String(open.rowHeight));
  check('one visible scroller, and it is the section rather than the document', open.visibleScrollers === 1 && !open.docScrolls);
  check('the roster is longer than the screen and says so by scrolling', open.scrolls);
  check('and it still fits sideways', !open.wide);
  check('the ⦿ observing mark is showing, now that this view is', open.observing);
  check('opening it is what asked for the roster — one request', open.work === 1, `${open.work} requests`);
  /* And one board sweep with it, which is the roster's Ship strip rather than the board
     section: `loadBoard` in public/monitor.js reads how many merges one deploy would carry
     and draws it on each advocate's card. It is the number that makes pressing Ship a
     decision rather than a reflex, and it is why this file measures the board's own fetch
     by the tap on its chip further down rather than by this one. */
  check('and the Ship strip is the only thing that swept the board', open.board === 1, `${open.board} requests`);
  check('no second document was loaded to get here', open.navigations === 1, String(open.navigations));

  /* -------------------------------------------------------------------- the chips */

  console.log('\nthe chip row, and the address under it\n');
  const chips = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const asked = (path) => performance.getEntriesByType('resource').filter((e) => e.name.includes(path)).length;
    const tap = (tab) => document.querySelector('#mon-tabs [data-tab="' + tab + '"]').click();
    const board0 = asked('/api/prs');
    tap('prs');
    await sleep(800);
    const board = {
      hash: location.hash,
      shown: [...document.querySelectorAll('#mon, #prs, #mirror')].filter((e) => !e.hidden).map((e) => e.id),
      up: window.beadcause.monTabs.up('prs'),
      rosterUp: window.beadcause.monTabs.up('advocates'),
      board: asked('/api/prs') - board0,
    };
    tap('mirror');
    await sleep(500);
    const mirror = {
      hash: location.hash,
      shown: [...document.querySelectorAll('#mon, #prs, #mirror')].filter((e) => !e.hidden).map((e) => e.id),
    };
    tap('advocates');
    await sleep(400);
    return { board, mirror, bare: location.hash, search: location.search };
  })()`);
  console.log(`    ${JSON.stringify(chips)}\n`);

  check('a chip swaps exactly one section', chips.board.shown.join(',') === 'prs' && chips.mirror.shown.join(',') === 'mirror', `${chips.board.shown} / ${chips.mirror.shown}`);
  check('and the section it left stopped being the one showing', chips.board.up && !chips.board.rosterUp);
  check('the board asked for itself on the tap that showed it', chips.board.board === 1, `${chips.board.board} requests`);
  check('the chip is written into the hash beside the view', chips.board.hash === '#advocates?tab=prs' && chips.mirror.hash === '#advocates?tab=mirror', `${chips.board.hash} / ${chips.mirror.hash}`);
  check('and the pane’s own chip is the bare hash rather than a longer way of saying it', chips.bare === '#advocates', chips.bare);
  check('nothing was written into the query string', chips.search === '', chips.search);

  /* ------------------------------------------------------ away, and back again */

  console.log('\nswitching away and back\n');
  const round = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const asked = (path) => performance.getEntriesByType('resource').filter((e) => e.name.includes(path)).length;
    const scroller = document.getElementById('mon');
    scroller.scrollTop = 300;
    const before = scroller.scrollTop;
    const work = asked('/api/work');
    window.beadcause.panes.go('epics');
    await sleep(400);
    const away = {
      hash: location.hash,
      up: window.beadcause.monTabs.up('advocates'),
      chip: window.beadcause.monTabs.active(),
      observing: !document.getElementById('observing').hidden,
    };
    window.beadcause.panes.go('advocates');
    await sleep(600);
    return {
      away,
      before,
      after: scroller.scrollTop,
      chip: window.beadcause.monTabs.active(),
      hash: location.hash,
      cards: document.querySelectorAll('#mon .mon-card').length,
      asked: asked('/api/work') - work,
      navigations: performance.getEntriesByType('navigation').length,
    };
  })()`);
  console.log(`    ${JSON.stringify(round)}\n`);

  check('Home carries none of the console’s chip', round.away.hash === '', round.away.hash);
  check('the pane going away stands its sections down', !round.away.up, 'a section still believes it is on screen');
  check('but the chip itself is remembered rather than reset', round.away.chip === 'advocates' && round.chip === 'advocates', round.chip);
  check('the cards survived the switch', round.cards >= 12, String(round.cards));
  check('and so did where you were in them', round.after === round.before && round.before > 0, `${round.before} -> ${round.after}`);
  check('and no second document was loaded', round.navigations === 1, String(round.navigations));

  /* ------------------------------------------------------- one poll, not four */

  console.log('\none poll for the whole document\n');
  check('exactly one parked /api/poll is open across four panes', parked === 1, `${parked} parked`);

  /* -------------------------------------------- reloading straight onto a chip */

  console.log('\nreloading onto #advocates?tab=prs\n');
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=x#advocates?tab=prs` });
  await sleep(3000);
  const cold = await evaluate(`(() => {
    const asked = (path) => performance.getEntriesByType('resource').filter((e) => e.name.includes(path)).length;
    return {
      showing: window.beadcause.panes.showing(),
      chip: window.beadcause.monTabs.active(),
      shown: [...document.querySelectorAll('#mon, #prs, #mirror')].filter((e) => !e.hidden).map((e) => e.id),
      // The pane it landed on knows it is on screen. panes.js's own first sync runs before
      // montabs.js loads, so an onShow subscriber never hears about this one — which is
      // why the row asks panes.showing() rather than keeping a flag of its own.
      up: window.beadcause.monTabs.up('prs'),
      builtFirst: window.beadcause.stage.built()[0],
      board: asked('/api/prs'),
      work: asked('/api/work'),
      hash: location.hash,
    };
  })()`);
  console.log(`    ${JSON.stringify(cold)}\n`);

  check('the address put the board up, not the chip that was stored', cold.chip === 'prs' && cold.shown.join(',') === 'prs', `${cold.chip} / ${cold.shown}`);
  check('and the pane it landed on knows it is the one on screen', cold.up, 'the row thinks its own pane is hidden');
  check('the pane was built first, ahead of the inbox', cold.builtFirst === 'advocates', cold.builtFirst);
  /* Not pinned to a number, because public/warm.js's background warm asks for this path
     too and there is no baseline to subtract on a cold load. The count that means something
     is the pair: the section the address named went and got itself, and the one beside it —
     which the warm layer would have fetched just as readily — did not. */
  check('the board went and got itself', cold.board >= 1, `${cold.board} requests`);
  check('and the roster it did not show asked for nothing', cold.work === 0, `${cold.work} requests`);
  check('the hash survived the load unchanged', cold.hash === '#advocates?tab=prs', cold.hash);

  /* ------------------------------------------ /monitor, still its own document */

  console.log('\nand /monitor is still a document\n');
  // The stored chip is `prs` by now — the reload above put the board up and the row
  // remembers, in both documents and deliberately. Cleared first, so what this section
  // asserts is the document's own default rather than the previous page's memory.
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/monitor?t=x` });
  await sleep(1200);
  await evaluate(`(() => { localStorage.removeItem('beadcause.mon.tab'); localStorage.removeItem('beadcause.mirror.tab'); })()`);
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/monitor?t=x` });
  await sleep(3000);
  const doc = await evaluate(`(() => {
    const asked = (path) => performance.getEntriesByType('resource').filter((e) => e.name.includes(path)).length;
    return {
      panes: Boolean(window.beadcause.panes),
      chip: window.beadcause.monTabs.active(),
      up: window.beadcause.monTabs.up('advocates'),
      cards: document.querySelectorAll('#mon .mon-card').length,
      work: asked('/api/work'),
      // Its own top bar, with the mark and the tally in it where that page keeps them.
      metaInBar: Boolean(document.querySelector('.topbar #observing') && document.querySelector('.topbar #tally')),
      gear: Boolean(document.getElementById('gear')),
      scrollers: [...document.querySelectorAll('.pagescroll')].filter((el) => el.offsetParent !== null).length,
      hash: location.hash,
    };
  })()`);
  console.log(`    ${JSON.stringify(doc)}\n`);

  check('it has no panes to be one of', !doc.panes);
  check('it draws the roster on its own', doc.cards >= 12 && doc.work === 1, `${doc.cards} cards, ${doc.work} requests`);
  check('with the mark and the tally in its own bar, and its own ⚙', doc.metaInBar && doc.gear);
  check('its chip row still owns the swap', doc.chip === 'advocates' && doc.up);
  check('it is one scroller, and it writes no hash', doc.scrollers === 1 && doc.hash === '', `${doc.scrollers} ${doc.hash}`);

  /* ---------------------------------------------------- and /prs is still /prs */

  console.log('\nand /prs still opens on the board\n');
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/prs?t=x` });
  await sleep(2500);
  const prs = await evaluate(`(() => ({
    chip: window.beadcause.monTabs.active(),
    shown: [...document.querySelectorAll('#mon, #prs, #mirror')].filter((e) => !e.hidden).map((e) => e.id),
  }))()`);
  console.log(`    ${JSON.stringify(prs)}\n`);

  // The path, on the document — and it is the behaviour bc-khoe.30.7 has to keep when
  // these nine addresses become redirects and there is no pathname left to read.
  check('the path put the board up, whatever chip was stored', prs.chip === 'prs' && prs.shown.join(',') === 'prs', `${prs.chip} / ${prs.shown}`);
} catch (err) {
  bad('the run itself', String(err && err.message).slice(0, 500));
} finally {
  server.close();
  await close();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
