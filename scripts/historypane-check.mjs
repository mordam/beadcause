#!/usr/bin/env node
//
// The ledger as a pane of the shell — in a real Chrome, on a real phone-sized screen.
//
//   node scripts/historypane-check.mjs
//
// `test/historyfilter.mjs` runs `public/history.js` in a `node:vm` against a hand-made
// document and a stand-in for `public/panes.js`, and it is the suite that actually gates a
// delivery. What it cannot ask is the half this file exists for: whether the *real*
// `panes.js`, `panestage.js`, `viewbar.js` and stylesheet do what those stand-ins pretend
// they do. Four of the claims bc-khoe.30.5 is built on are only true in a browser:
//
//   * **it lays out.** The pane is a flex item of the shell's column and the ledger is the
//     one thing in it that scrolls. Every other page in this app is that shape already
//     (see `test/shell.mjs`), but a pane is one level deeper than a page was, and the
//     failure is not a horizontal scrollbar — it is a list that ends at the first
//     screenful with nothing saying so;
//   * **the scroll position survives.** A hidden pane has no layout box, so `panes.js`
//     carries `scrollTop` across by hand. Whether it comes back is a browser fact and
//     nothing else, and it is the single thing this whole epic is buying;
//   * **the pill stopped being a link.** `viewbar.js` reads `panes.has('history')` off the
//     document, which is now true only because the `data-pending` attribute came off — so
//     what is asserted is that the markup and the row agree, not that the row's own logic
//     is right (`test/panes.mjs` has that);
//   * **the staged boot did what it says.** Landing on `/#history?status=closed` must build
//     the ledger *first* and make its very first request the narrowed one — one request,
//     not a wide one corrected afterwards.
//
// And the compatibility half, at the end: `/history` is still its own document until
// bc-khoe.30.7, so the same file has to draw the same list there with its filters in the
// query string rather than in the hash.
//
// Not part of `npm test`: it wants Chrome. It is self-contained otherwise — its own HTTP
// server over `public/` with a fixture ledger behind `/api/history`, no daemon, no `bd`,
// no tracker. About fifteen seconds.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** One screenful of the ledger, which is what `/api/history` pages at. */
const PAGE = 40;

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the fixture */

const WORKSPACES = ['beadcause'];
/** What `/api/spaces` answers, and what every other payload carries along with it. */
const SPACEPAY = {
  spaces: [{ name: 'Personal', workspaces: WORKSPACES, count: 1, quiet: false }],
  workspaces: WORKSPACES,
  filter: { space: 'all', workspace: 'all' },
};

/** A ledger row, shaped the way `toRow` in lib/history.js shapes one. */
const rowFor = (i) => ({
  id: `bc-${String(i).padStart(3, '0')}`,
  workspace: 'beadcause',
  title: `ledger row ${i}`,
  type: 'task',
  // Half open and half closed, so `?status=closed` is a narrowing with a countable answer
  // rather than the whole list under a chip.
  status: i % 2 ? 'open' : 'closed',
  priority: 2,
  updated: new Date(Date.UTC(2026, 0, 1, i)).toISOString(),
  created: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  closeReason: i % 2 ? null : 'landed',
  labels: [],
  createdBy: 'x',
  provenance: 'human',
  hasSession: false,
});
/* Three pages of it, so the list is longer than the screen and there is something to lose
   a scroll position in. */
const LEDGER = Array.from({ length: 120 }, (_, i) => rowFor(i + 1));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
/* The two rewrites in `serveStatic` (lib/server.js) this file needs, written out rather
   than imported: importing the server would bring a config, a tracker and a daemon. */
const ROUTES = { '/history': '/history.html', '/monitor': '/monitor.html' };

function serve() {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const json = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/api/spaces') return json(SPACEPAY);
    if (p === '/api/history') {
      // Only the one filter this file drives. Everything else about `parseQuery` is
      // test/historyapi.mjs's, and a fuller fake here would be a second implementation of
      // it that could disagree.
      const status = u.searchParams.get('status');
      const kept = status ? LEDGER.filter((r) => status.split(',').includes(r.status)) : LEDGER;
      const offset = Number(u.searchParams.get('offset') || 0);
      const limit = Number(u.searchParams.get('limit') || PAGE);
      const rows = kept.slice(offset, offset + limit);
      return json({ rows, total: kept.length, more: offset + rows.length < kept.length, errors: [] });
    }
    if (p === '/api/questions')
      return json({
        questions: [],
        requests: [],
        consoles: [],
        ...SPACEPAY,
        scope: 'human',
        rootboard: { roots: [], under: {}, unhomed: {}, owned: false },
        summary: { questions: 0, sessions: 0, proposals: 0 },
        seq: 1,
      });
    if (p === '/api/prs') return json({ unavailable: null, build: null, counts: {}, repos: [], ...SPACEPAY });
    /* Parked the way the daemon parks it. An immediate empty answer turns the shell's poll
       into a spin loop against this fixture, and the run is over long before this timer. */
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 30000);
      res.on('close', () => clearTimeout(timer));
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

const server = await serve();
const port = server.address().port;
const { s, close } = await launchChrome('beadcause-historypane-');
const evaluate = async (expression) => {
  const r = await s.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 400));
  return r.result.value;
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 852, deviceScaleFactor: 2, mobile: true });

  /* ---------------------------------------------- landing straight on the pane */

  console.log('\nlanding cold on /#history?status=closed\n');
  // The token goes in the *query string* and the view in the hash, which is the shape of
  // every link this app mints: `?t=` is picked up into localStorage and dropped, and the
  // hash is the view. A token in the hash would be a page that is not paired, which draws
  // a perfectly good screen saying so and asserts nothing.
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=x#history?status=closed` });
  await sleep(2500);

  const cold = await evaluate(`(() => {
    const pane = document.querySelector('div.pane[data-pane="history"]');
    const list = document.getElementById('hist-list');
    return {
      shown: !pane.hidden,
      homeHidden: document.querySelector('div.pane[data-pane="epics"]').hidden,
      rows: list.querySelectorAll('.hist-row').length,
      // Every row drawn is a closed one — the narrowing came from the hash, not from a
      // wide list corrected afterwards.
      allClosed: [...list.querySelectorAll('.hist-row')].every((r) => r.classList.contains('is-closed')),
      historyPill: document.querySelector('.viewbar a[href="/history"]') ? 'a-link' : 'not-a-link',
      advocatesPill: document.querySelector('.viewbar a[href="/monitor"]') ? 'a-link' : 'not-a-link',
      current: [...document.querySelectorAll('.viewbar [aria-current]')].map((e) => e.textContent.trim()).join(','),
      // Only what is painted: the hidden panes' scrollers have no layout box at all.
      visibleScrollers: [...document.querySelectorAll('.pagescroll')].filter((el) => el.offsetParent !== null).length,
      docScrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight + 1,
      wide: document.documentElement.scrollWidth > window.innerWidth + 1,
      hash: location.hash,
      ledgerRequests: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/history')).length,
      showing: window.beadcause.panes.showing(),
      pending: Object.keys(window.beadcause.panes.pending()).join(','),
      builtFirst: window.beadcause.stage.built()[0],
      want: window.beadcause.stage.want(),
    };
  })()`);
  console.log(`    ${JSON.stringify(cold)}\n`);

  check('the History pane is the one showing, and Home is not', cold.shown && cold.homeHidden && cold.showing === 'history');
  check('the ledger drew a page of rows', cold.rows === PAGE, `${cold.rows} rows`);
  check('and the hash narrowed the very first request', cold.allClosed && cold.ledgerRequests === 1, `${cold.ledgerRequests} requests`);
  check('one visible scroller, and the document itself does not scroll', cold.visibleScrollers === 1 && !cold.docScrolls);
  check('and the page fits the screen', !cold.wide);
  check('the pane was built first, ahead of the inbox', cold.builtFirst === 'history', cold.builtFirst);
  check('and it asks the shell’s poll for nothing but presence', cold.want === 'presence', String(cold.want));
  check('the Ledger pill is not a link any more', cold.historyPill === 'not-a-link' && cold.current.includes('Ledger'), cold.current);
  check('and the panes still waiting on their beads still are', cold.advocatesPill === 'a-link' && cold.pending === 'advocates,releases', cold.pending);

  /* --------------------------------------------------- away, and back again */

  console.log('\nswitching away and back\n');
  const round = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const scroller = document.querySelector('div.pane[data-pane="history"] .pagescroll');
    scroller.scrollTop = 400;
    const before = scroller.scrollTop;
    const asked = performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/history')).length;
    window.beadcause.panes.go('epics');
    await sleep(300);
    const homeUp = !document.querySelector('div.pane[data-pane="epics"]').hidden;
    const homeHash = location.hash;
    const homeSearch = location.search;
    window.beadcause.panes.go('history');
    await sleep(400);
    return {
      before,
      after: scroller.scrollTop,
      homeUp,
      homeHash,
      homeSearch,
      hash: location.hash,
      rows: document.getElementById('hist-list').querySelectorAll('.hist-row').length,
      asked: performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/history')).length - asked,
      navigations: performance.getEntriesByType('navigation').length,
    };
  })()`);
  console.log(`    ${JSON.stringify(round)}\n`);

  check('Home carries none of the ledger’s filter', round.homeUp && round.homeHash === '' && round.homeSearch === '', `${round.homeHash} ${round.homeSearch}`);
  check('coming back puts the filters back on the address', round.hash === '#history?status=closed', round.hash);
  check('the rows survived the switch', round.rows === PAGE, String(round.rows));
  check('and so did where you were in them', round.after === round.before && round.before > 0, `${round.before} -> ${round.after}`);
  check('nothing was fetched to come back', round.asked === 0, String(round.asked));
  check('and no second document was loaded', round.navigations === 1, String(round.navigations));

  /* ------------------------------------------------------------------ a chip */

  console.log('\na filter chip\n');
  const chip = await evaluate(`(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const bar = document.getElementById('hist-filters');
    const summary = bar.querySelector('.filter-one[data-group="status"] .filter-summary');
    summary.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    summary.click();
    await sleep(150);
    // By its label rather than by a data-chip attribute selector: that attribute is
    // written as btn.dataset.chip in public/filtermenu.js, so it exists in the DOM and
    // not in the source — and lib/checkaudit.js reads the source, correctly, to say
    // whether every selector a check presses is still a thing this app draws.
    const chips = [...bar.querySelectorAll('.filter-one[data-group="status"] button.chip')];
    chips.find((c) => c.textContent.trim().startsWith('Open')).click();
    await sleep(700);
    return {
      hash: location.hash,
      search: location.search,
      rows: document.getElementById('hist-list').querySelectorAll('.hist-row').length,
    };
  })()`);
  console.log(`    ${JSON.stringify(chip)}\n`);

  // `closed,open` — the comma arrives percent-encoded, which is `URLSearchParams` writing
  // the value it was given rather than anything this app spelled.
  check('tapping a chip writes the hash', chip.hash.startsWith('#history?') && /status=closed(%2C|,)open/.test(chip.hash), chip.hash);
  check('and leaves the query string alone', chip.search === '', chip.search);
  check('and the list widened to match', chip.rows === PAGE, String(chip.rows));

  /* --------------------------------------------- /history, still its own document */

  console.log('\nand /history is still a document\n');
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/history?t=x&status=closed` });
  await sleep(2500);
  const doc = await evaluate(`(() => {
    const list = document.getElementById('hist-list');
    return {
      rows: list.querySelectorAll('.hist-row').length,
      allClosed: [...list.querySelectorAll('.hist-row')].every((r) => r.classList.contains('is-closed')),
      search: location.search,
      hash: location.hash,
      panes: Boolean(window.beadcause.panes),
      scrollers: [...document.querySelectorAll('.pagescroll')].filter((el) => el.offsetParent !== null).length,
      ownRefresh: Boolean(document.getElementById('hist-refresh')),
    };
  })()`);
  console.log(`    ${JSON.stringify(doc)}\n`);

  check('it draws the ledger on its own', doc.rows === PAGE && doc.allClosed, String(doc.rows));
  check('with its filters in the query string, where they have always been', doc.search.includes('status=closed') && doc.hash === '', `${doc.search} ${doc.hash}`);
  check('it has no panes to be one of, and its own ⟳', !doc.panes && doc.ownRefresh);
  check('and it is still one scroller', doc.scrollers === 1, String(doc.scrollers));
} catch (err) {
  bad('the run itself', String(err && err.message).slice(0, 500));
} finally {
  server.close();
  await close();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
