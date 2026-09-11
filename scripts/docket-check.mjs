#!/usr/bin/env node
//
// Does the docket actually draw, and does the fold actually fold?
//
//   node scripts/docket-check.mjs [--shot FILE] [--keep]
//
// `test/docket.mjs` holds the model — which beads are in a family, which events are
// folded, where a ruling is found. None of that is a claim about a browser, and the ways
// this page actually fails are all browser-shaped:
//
//   1. **The fold hides nothing.** `machine: true` arrives on the event and the page is
//      supposed to leave those lines out until you ask. A rendering that drew them anyway
//      would look *fine* — a longer page, no error, no missing content — and would quietly
//      undo the whole reason the fold exists. So: count the lines, open the day, count
//      again, and check the number the control promised is the number that appeared.
//   2. **The day you came from is not marked.** `focus` is the one thing that makes a
//      docket answer "where does my card sit in this", and an accent that stopped being
//      drawn is invisible from every angle except a screenshot.
//   3. **It is frozen at one colour scheme.** Every colour on this page is a variable and
//      the page is opened at night on a phone; a hard-coded value would show up nowhere
//      else.
//   4. **It scrolls sideways.** A stream with an id, a clock, a glyph and a sentence on
//      one row is exactly the shape that overflows 393px, and this app is a phone.
//
// It runs against `public/` with a fixture `/api/docket` behind it — no daemon, no
// tracker, no `bd`. A check that needed a running service to prove a page renders is a
// check nobody runs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i === -1 || i === process.argv.length - 1 ? null : path.resolve(process.argv[i + 1]);
})();
// The phone, because that is what this app is.
const VP = { width: 393, height: 852, dpr: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ---------------------------------------------------------------- the fixture */

/* One day carrying a ruling and four machine lines, and a second carrying only machine
   lines. The second is the case the fold's per-day heading exists for: a day on which
   only the machine did anything is still a day, and a page that skipped it would read as
   a gap in the record rather than as a quiet Tuesday. */
const ev = (o) => ({ machine: false, ...o });
const DOCKET = {
  workspace: 'demo',
  root: {
    id: 'bc-ep',
    title: 'An epic with an arc',
    status: 'open',
    priority: 1,
    issue_type: 'feature',
    description: 'What this whole thing is for, in the epic’s own words.',
    notes: '',
    labels: [],
  },
  focus: 'bc-ep.2',
  family: [
    { id: 'bc-ep', title: 'An epic with an arc', status: 'open', priority: 1, depth: 0, parent: null, labels: [] },
    { id: 'bc-ep.1', title: 'The first child, finished', status: 'closed', priority: 1, depth: 1, parent: 'bc-ep', labels: [] },
    { id: 'bc-ep.2', title: 'The one your card came from', status: 'open', priority: 1, depth: 1, parent: 'bc-ep', labels: ['human'] },
    { id: 'bc-deep', title: 'A grandchild', status: 'in_progress', priority: 2, depth: 2, parent: 'bc-ep.2', labels: [] },
  ],
  plan: {
    groups: [
      { name: 'the read side', beads: ['bc-ep.1'] },
      { name: 'the page', beads: ['bc-ep.2'] },
    ],
  },
  events: [
    ev({ at: '2026-08-01T09:00:00Z', kind: 'filed', bead: 'bc-ep' }),
    ev({ at: '2026-08-01T10:00:00Z', kind: 'filed', bead: 'bc-ep.1' }),
    ev({ at: '2026-08-01T11:00:00Z', kind: 'claimed', bead: 'bc-ep.1', machine: true, who: 'worker@example.com' }),
    ev({ at: '2026-08-01T12:00:00Z', kind: 'commented', bead: 'bc-ep.1', machine: true, voice: 'agent', text: 'working on it' }),
    ev({ at: '2026-08-01T13:00:00Z', kind: 'session', bead: 'bc-ep.1', machine: true, text: 'a run' }),
    ev({ at: '2026-08-01T14:00:00Z', kind: 'commented', bead: 'bc-ep.1', machine: true, voice: 'agent', text: 'still going' }),
    ev({ at: '2026-08-01T15:00:00Z', kind: 'ruled', bead: 'bc-ep.1', text: 'Do it the second way.' }),
    ev({ at: '2026-08-01T15:01:00Z', kind: 'closed', bead: 'bc-ep.1', reason: 'Answered via Beadcause', ruled: true }),
    ev({ at: '2026-08-02T09:00:00Z', kind: 'session', bead: 'bc-deep', machine: true, text: 'a quiet day' }),
    ev({ at: '2026-08-03T09:00:00Z', kind: 'filed', bead: 'bc-ep.2' }),
    ev({ at: '2026-08-03T10:00:00Z', kind: 'pr-merged', bead: 'bc-ep.1', number: 92, url: 'https://example.com/92', repo: 'demo', text: 'the first child' }),
  ],
  progress: {
    counts: { total: 4, open: 2, in_progress: 1, blocked: 0, closed: 1, asking: 1, held: 0 },
    firstAt: '2026-08-01T09:00:00Z',
    lastAt: '2026-08-03T10:00:00Z',
  },
  prsKnown: true,
};

const MACHINE_ON_DAY_ONE = DOCKET.events.filter((e) => e.machine && e.at.startsWith('2026-08-01')).length;
const SHOWN_ON_DAY_ONE = DOCKET.events.filter((e) => !e.machine && e.at.startsWith('2026-08-01')).length;

/* ------------------------------------------------------------------ the server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};
/* The one rewrite in `serveStatic` (lib/server.js) this file needs, written out rather
   than imported: importing the server would bring a config, a tracker and a daemon. */
const ROUTES = { '/docket': '/docket.html', '/epic': '/docket.html' };

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;
  const json = (b) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(b));
  };
  if (p === '/api/docket') return json(DOCKET);
  if (p === '/api/dockets') return json({ rows: [], errors: [] });
  /* Parked the way the daemon parks it. An immediate empty answer turns any poll on the
     page into a spin loop against this fixture. */
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
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/* ------------------------------------------------------------------- the browser */

const { s, close } = await launchChrome('beadcause-docket-');
const send = (method, params = {}) => s.send(method, params);
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
  return r.result.value;
};

const cleanup = () => {
  close();
  server.close();
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
  });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  const errors = [];
  s.on((method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      errors.push(params.exceptionDetails?.exception?.description || 'exception');
    }
  });

  // The page reads its token out of localStorage before it will fetch anything, exactly
  // as every other document in this app does — so it is seeded before the navigation
  // rather than after, or the first load draws "this device is not paired".
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: "try { localStorage.setItem('beadcause.token', 'docket-check'); } catch {}",
  });
  await send('Page.navigate', { url: `${base}/docket?ws=demo&id=bc-ep.2` });

  let drawn = false;
  for (let i = 0; i < 60 && !drawn; i += 1) {
    await sleep(100);
    drawn = await evaluate(`!!document.querySelector('.dk-map .dk-row')`).catch(() => false);
  }

  console.log('the docket, in a browser\n');

  check('the page draws its four blocks', drawn, 'no bead row in .dk-map after 6s');

  const blocks = await evaluate(`({
    head: !!document.querySelector('.dk-head .dk-title'),
    phases: document.querySelectorAll('.dk-phases .dk-phase').length,
    rows: document.querySelectorAll('.dk-map .dk-row').length,
    days: document.querySelectorAll('.dk-day').length,
  })`);
  check(`the map draws every bead in the family (${blocks.rows})`, blocks.rows === DOCKET.family.length);
  check(`the plan's groups are drawn as phases (${blocks.phases})`, blocks.phases === DOCKET.plan.groups.length);
  check(
    `every day with anything on it gets a heading (${blocks.days})`,
    blocks.days === 3,
    'a day on which only the machine did anything is still a day'
  );

  // 1 — the fold.
  const before = await evaluate(`document.querySelectorAll('.dk-day')[0].querySelectorAll('.dk-ev').length`);
  check(
    `a day opens showing only what was decided (${before} of ${before + MACHINE_ON_DAY_ONE})`,
    before === SHOWN_ON_DAY_ONE,
    `${before} lines drawn where ${SHOWN_ON_DAY_ONE} are not machine work — the fold is hiding nothing`
  );
  const promised = await evaluate(`document.querySelectorAll('.dk-day')[0].querySelector('.dk-fold').textContent.trim()`);
  check(
    `and its control says how many are behind it — "${promised}"`,
    promised.includes(String(MACHINE_ON_DAY_ONE)),
    'a control that does not say how many is asking you to tap to find out whether tapping is worth it'
  );
  await evaluate(`document.querySelectorAll('.dk-day')[0].querySelector('.dk-fold').click()`);
  await sleep(80);
  const after = await evaluate(`document.querySelectorAll('.dk-day')[0].querySelectorAll('.dk-ev').length`);
  check(
    `opening it adds exactly the lines it promised (${after})`,
    after === before + MACHINE_ON_DAY_ONE,
    `${after - before} appeared, ${MACHINE_ON_DAY_ONE} promised`
  );
  const dim = await evaluate(
    `[...document.querySelectorAll('.dk-day')[0].querySelectorAll('.dk-ev.machine')].length > 0 &&
     Number(getComputedStyle(document.querySelector('.dk-ev.machine')).opacity) < 1`
  );
  check('and they read quieter than the ruling beside them', dim, 'a folded line shown at full weight is the fold undone');
  await evaluate(`document.querySelectorAll('.dk-day')[0].querySelector('.dk-fold').click()`);
  await sleep(80);

  // 2 — where you came from.
  const focus = await evaluate(`(() => {
    const el = document.querySelector('.dk-row.focus');
    if (!el) return null;
    return { id: el.id, shadow: getComputedStyle(el).boxShadow, count: document.querySelectorAll('.dk-row.focus').length };
  })()`);
  check(
    'the bead your card came from is the one that is lit',
    focus && focus.id === `bead-${DOCKET.focus}` && focus.count === 1,
    focus ? `${focus.id}, ${focus.count} lit` : 'no .dk-row.focus at all'
  );
  check(
    'and it is lit with a rule in the gutter, not a border that shunts the list',
    Boolean(focus?.shadow) && focus.shadow !== 'none',
    'the accent is an inset shadow so every row keeps its left edge'
  );

  // 4 — the phone.
  const wide = await evaluate(
    `Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) <= window.innerWidth + 1`
  );
  check('nothing overflows 393px sideways', wide, 'a row with an id, a clock, a glyph and a sentence is the shape that overflows');

  // 3 — the colour scheme.
  const darkInk = await evaluate(`getComputedStyle(document.querySelector('.dk-ev-what')).color`);
  const darkBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(150);
  const lightInk = await evaluate(`getComputedStyle(document.querySelector('.dk-ev-what')).color`);
  const lightBg = await evaluate(`getComputedStyle(document.body).backgroundColor`);
  check(
    'the page follows the colour scheme',
    darkInk !== lightInk && darkBg !== lightBg,
    `ink ${darkInk} vs ${lightInk}, ground ${darkBg} vs ${lightBg}`
  );
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });
  await sleep(120);

  // The order toggle, which is the one control on the page that is not a fold.
  const first = await evaluate(`document.querySelector('.dk-day .dk-day-name').textContent`);
  await evaluate(`document.querySelector('[data-act="order"]').click()`);
  await sleep(80);
  const flipped = await evaluate(`document.querySelector('.dk-day .dk-day-name').textContent`);
  check('the order toggle turns the arc around', first !== flipped, `${first} both ways`);
  await evaluate(`document.querySelector('[data-act="order"]').click()`);
  await sleep(80);

  check('and the page threw nothing while all that happened', errors.length === 0, errors.join('\n      '));

  if (SHOT) {
    await send('Emulation.setDeviceMetricsOverride', {
      width: VP.width,
      height: 1600,
      deviceScaleFactor: VP.dpr,
      mobile: true,
    });
    await sleep(200);
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(shot.data, 'base64'));
    console.log(`\n  shot: ${SHOT}`);
  }
} finally {
  cleanup();
}

console.log(failures ? `\n\x1b[31m${failures} check(s) failed\x1b[0m` : '\n\x1b[32mall checks passed\x1b[0m');
process.exit(failures ? 1 : 0);
