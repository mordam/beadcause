#!/usr/bin/env node
//
// The pill row, in a real Chrome, on every page that draws it.
//
//   node scripts/viewbar-check.mjs [--out=DIR]
//   npm run checks -- --only viewbar
//
// ## What this is a replacement for
//
// There was a bar along the bottom of eight pages and it had cover: `scripts/tabbar-
// check.mjs` drove every page it appeared on, at two phone widths, and asserted the
// handful of things a row of navigation has to be true of before anybody can trust it —
// that it is there, that exactly one item says *you are here*, that the item saying it is
// not a link, that every other one is, that each is big enough for a thumb, and that a
// tap on it reaches it rather than something drawn over it. bc-khoe.1 deleted the bar and
// that file went with it. The row of pills under the top bar does the same job on the
// same eight pages and arrived with none of that, which is the state this file ends.
//
// Almost all of it ports across unchanged, because those claims are about *a row of
// navigation* rather than about where on the screen it sits. One does not: the bottom bar
// had to clear the home indicator by the bottom safe-area inset, and every run was done
// twice for it. A row at the top of the app shell has nothing under it to clear, and
// `--fake-inset` would be measuring an inset nothing in this file reads.
//
// Two claims are new, and they are the ones the row itself introduced:
//
//   * **it does not wrap.** A row that goes to two lines is the thing this epic exists to
//     stop — it spends a second row of a screen that is mostly chrome already. Asked of
//     the pills' own rectangles rather than of the row's height, because those are two
//     different failures and only one of them is loud: the row has no height of its own,
//     so a wrap makes it taller and you can see it, but a pill sent to a second line
//     *inside* a row that has been given a height would be clipped by `overflow-y:
//     hidden` and simply gone, with nothing on screen looking wrong. Both are asserted —
//     one line by rectangle, and nothing overflowing the row downwards;
//   * **the current pill is scrolled into view on load.** The row scrolls sideways and
//     `scrollLeft` starts at 0, so the pill that says where you are is the one most
//     likely to be off the right-hand edge — on the one screen where it matters most.
//
// A third arrived with bc-khoe.23 and it is the only one this file feeds real data for:
//
//   * **four of the pills carry a count, on Home and nowhere else.** Which four is read
//     out of `PILLS` like everything else here, so a pill gaining or losing its badge is
//     an edit to the row rather than to this file. What the numbers have to *be* is the
//     part a static read cannot reach, so the fixture below serves a known list — three
//     questions, two chats, three pull requests of which one is merged — and the badges
//     are asserted against those numbers, through the real app.js, the real filter and
//     the real row. The merged one is the point of the third: `PRs` is counted through
//     its own sub-filter, which shows unmerged unless you ask for more, so a badge
//     saying 3 there would be the pill promising a screen it does not open. Then each
//     pill is tapped and the list it leaves is counted, because "the number agrees with
//     the list" is the whole claim and it is one the numbers alone cannot make.
//
// ## The pill list is read, never repeated
//
// `PILLS` in `public/viewbar.js` is the one place a view is added, and it keeps moving:
// bc-khoe.2 replaced four pills with seven while this file was being written, and
// bc-khoe.4 (Advocates, Mirror) and bc-khoe.7 (Releases) each change the set again. A
// list copied into this file would make every one of those a check edit as well, and a
// check that has to be edited to keep passing is a check that gets edited rather than
// believed — the same run that took the row from four pills to seven was green here
// without a line of this file changing. So the array is read out of the source the way
// `test/mirrorpane.mjs` reads it, and everything below is derived from it: which pills
// there should be, in what order, and — from `VIEWS` in `public/hashroute.js`, which is
// where each view's addresses live since bc-khoe.30.2 — which one should be lit on the
// page being looked at. Two source files rather than one, because they are two questions:
// what the row draws, and what an address means.
//
// The *page* list is derived too. Every `public/*.html` that pulls in `/viewbar.js` has
// to appear below, and a page that starts drawing the row without being added here fails
// this check rather than quietly going uncovered.
//
// ## What a pill is allowed to be
//
// Three shapes, and the difference between them is what a tap should do. The current one
// is a `<span aria-current="page">` with no href, because tapping where you already are
// should do nothing. Every other one is either an `<a href>` — a pill that goes
// somewhere — or a `<button type="button">` carrying the id the row's own click listener
// acts on, which is what a pill that moves a filter over rows already in hand looks like
// (bc-khoe.2). What is asserted is that a non-current pill is one of those two and never
// a dead `<span>`, because *that* is the failure worth catching and it is the one a
// rewrite of the row can introduce without touching a stylesheet.
//
// Not part of `npm test`: it wants Chrome. `test/shell.mjs` is the static half that is —
// it holds the 44px floor as a declaration in `public/style.css`. This is the half that
// asks what the browser actually did with it.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The tap floor, in `public/style.css` as `--viewbar-h`. A thumb is about this wide. */
const TAP = 44;

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ------------------------------------------------------- the row's own list */

/* Comments out first. The header of `public/viewbar.js` is several hundred words about
   what is *not* a pill and why — the Mirror, Admin, the chat session — and a match
   against the raw file would read that prose as the list. */
const decomment = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');

/**
 * `PILLS`, out of the source, as data.
 *
 * A literal array of object literals with no identifier in it, so it is evaluated rather
 * than parsed — in an empty `node:vm` context, which is what makes that a read of a data
 * file and not an execution of a page script. The slice is the same one
 * `test/mirrorpane.mjs` takes, deliberately: two files agreeing on where the list ends is
 * cheaper than two ways of finding out.
 *
 * A failure here is a hard stop rather than a fallback to a hardcoded list. The whole
 * point of this file is that there is no hardcoded list, and a check that quietly falls
 * back to one is a check that goes on passing after the row has changed underneath it.
 */
function arrayFromSource(file, name) {
  const src = decomment(fs.readFileSync(path.join(PUBLIC, file), 'utf8'));
  const m = src.match(new RegExp(`const ${name} = (\\[[\\s\\S]*?\\n {2}\\]);`));
  if (!m) {
    console.error(
      `could not find the ${name} array in public/${file} — this check reads the row's own lists\n` +
        'rather than repeating them, so a rename or a reshape of that array has to be reflected here.'
    );
    process.exit(1);
  }
  try {
    return vm.runInNewContext(`(${m[1]})`, Object.create(null), { timeout: 1000 });
  } catch (err) {
    console.error(`public/${file}'s ${name} array did not evaluate as data: ${err.message}`);
    process.exit(1);
  }
}

const PILLS = arrayFromSource('viewbar.js', 'PILLS');
/* Which addresses are which view. A view's id is its pill's id on purpose, so this joins
   to the array above by that id and no mapping is written down anywhere. */
const VIEWS = arrayFromSource('hashroute.js', 'VIEWS');
const IDS = PILLS.map((p) => p.id);

/** The path a pill claims, normalised the way the row itself normalises `location`. */
const norm = (p) => p.replace(/\/+$/, '') || '/';

/**
 * Which pill should be lit on this path, per `VIEWS` in public/hashroute.js — or `null`.
 *
 * `null` is a real answer and not a gap. /console, /endorse, /flow, /requirements and
 * /admin are pages the row is drawn on and none of them is a view: /admin in particular
 * is a recorded decision (it is the screen you least want to hit by accident, so it lives
 * in the mark's menu and on no row). A pill lit there would be a lie about where you are,
 * so "nothing is current" is asserted just as firmly as "this one is".
 */
const litFor = (urlPath) => VIEWS.find((v) => v.paths.includes(norm(urlPath)))?.id ?? null;

/* ---------------------------------------------------------------- the fixture */

/* Enough of a payload for each page to come up. None of it feeds the row — `viewbar.js`
   draws from its own list the moment it runs, before any fetch has answered, which is
   the property that lets one row say the same thing on twelve pages. What the fixture is
   for is the *rest* of each page: a script that throws on a malformed payload can take
   the layout with it, and then the row is being measured on a page that never rendered. */
const WORKSPACES = ['beadcause', 'adam.life', 'deluvia', 'ehatt', 'sophab'];
const SPACEPAY = {
  spaces: [{ name: 'Personal', workspaces: WORKSPACES, count: 3, quiet: false }],
  workspaces: WORKSPACES,
  filter: { space: 'all', workspace: 'all' },
};

/*
  A known list, for the four counts (bc-khoe.23).

  Three questions, two chat sessions and three pull requests — and the third pull request
  is `merged`, which is what makes `PRs 2` rather than `PRs 3` the right answer: the kind
  is counted through its own status sub-filter, and that filter shows unmerged unless you
  ask for more. So the expected numbers below are arithmetic on this fixture and not a
  copy of what the app happened to print, which is the difference between a check and a
  screenshot.

  `My Epics` is every row that survives its own sub-filter — 3 + 2 + 2 — because picking
  it clears the selection rather than choosing a kind. That is the number this file is
  least able to derive by reading the source and the one most worth asserting.
*/
const WS = 'beadcause';
const QUESTIONS = ['bc-a1', 'bc-a2', 'bc-a3'].map((id) =>
  toQuestion(WS, {
    id,
    title: `Which way should ${id} go?`,
    issue_type: 'task',
    status: 'open',
    priority: 2,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    comment_count: 0,
    dependent_count: 0,
    description: 'A plain question, waiting on a word from you.',
  })
);

const CONSOLES = [
  { id: 'c1', workspace: WS, title: 'What to file next', state: 'yours', updatedAt: '2026-08-01T09:00:00Z' },
  { id: 'c2', workspace: WS, title: 'The other one', state: 'yours', updatedAt: '2026-08-01T09:00:00Z' },
];

const PRS = [
  { key: `${WS}#1`, number: 1, workspace: WS, repoKey: WS, title: 'The first one', stage: 'review', beads: [] },
  { key: `${WS}#2`, number: 2, workspace: WS, repoKey: WS, title: 'The second one', stage: 'review', beads: [] },
  { key: `${WS}#3`, number: 3, workspace: WS, repoKey: WS, title: 'Already landed', stage: 'merged', beads: [] },
];

/** What the badges must say, derived from the fixture above rather than from the app. */
const WANT = { epics: 7, question: 3, pr: 2, session: 2 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/* The path rewrites in `serveStatic` (lib/server.js), for the paths this file opens.
   Only the ones below are needed and they are written out rather than imported, because
   importing the server would bring a config, a tracker and a daemon along with it. */
const ROUTES = {
  '/monitor': '/monitor.html',
  '/advocates': '/monitor.html',
  '/sessions': '/monitor.html',
  '/work': '/monitor.html',
  '/prs': '/monitor.html',
  '/pulls': '/monitor.html',
  '/prs.html': '/monitor.html',
  '/console': '/console.html',
  '/endorse': '/endorse.html',
  '/history': '/history.html',
  '/flow': '/flow.html',
  '/requirements': '/requirements.html',
  '/skills': '/skills.html',
  '/admin': '/admin.html',
  '/sounds': '/sounds.html',
  '/audition': '/sounds.html',
};

/* Every URL the fixture was asked for, in order. One assertion needs it: "tapping All
   Beads refetches" is a claim about a request going out, and no amount of reading the
   page afterwards can tell you whether one did. */
const HITS = [];

function serve() {
  const server = http.createServer((req, res) => {
    HITS.push(req.url);
    const p = new URL(req.url, 'http://x').pathname;
    const json = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/api/spaces') return json(SPACEPAY);
    if (p === '/api/questions')
      return json({
        questions: QUESTIONS,
        requests: [],
        consoles: CONSOLES,
        ...SPACEPAY,
        scope: 'human',
        /* The board's own narrowing off. It is not what this file is about, and with it
           on the list would be filtered by which epics the fixture pretends you own —
           which is a different check's argument (test/underownedroots.mjs) and would
           make every number below depend on it. */
        rootboard: { roots: [], under: {}, unhomed: {}, owned: false },
        summary: { questions: QUESTIONS.length, sessions: CONSOLES.length, proposals: 0 },
        seq: 1,
      });
    if (p === '/api/work') return json({ workspaces: [], advocates: [], elsewhere: [], ...SPACEPAY });
    if (p === '/api/prs')
      return json({
        unavailable: null,
        build: null,
        counts: {},
        repos: [{ key: WS, workspace: WS, repo: WS, prs: PRS }],
        ...SPACEPAY,
      });
    if (p === '/api/consoles') return json({ consoles: [], ...SPACEPAY });
    if (p === '/api/unendorsed') return json({ beads: [], counts: {}, truncated: false, errors: [], ...SPACEPAY });
    if (p === '/api/requirements') return json({ areas: [], requirements: [], ...SPACEPAY });
    if (p === '/api/flowchart') return json({ chart: 'graph TD;\\n a-->b;', ...SPACEPAY });
    if (p === '/api/admin') return json({ workspaces: [], paused: false, ...SPACEPAY });
    if (p === '/api/devices') return json({ devices: [], ...SPACEPAY });
    /* Parked the way the daemon parks it. An immediate empty answer turns every page that
       polls into a spin loop against this fixture, and the run is over long before this
       timer is. */
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
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

/* ------------------------------------------------------------------- the pages */

/**
 * Every page the row is drawn on, and the URL a phone would arrive at it by.
 *
 * `file` is what ties each entry to the document that has to pull in `/viewbar.js`, and
 * the guard below turns that into the derivation: the set of pages here must be exactly
 * the set of `public/*.html` that loads the row. A page that starts drawing it without
 * appearing here would be a page nothing measures, and it would be invisible in exactly
 * the way a passing check is: every assertion below would still be green, about the pages
 * somebody remembered.
 *
 * `/prs` is here twice over — as its own path and as `/monitor` — because the server
 * serves one document for both and what is being asked is that arriving by either URL
 * lights the pill the row's own list says it should.
 *
 * Six of these light *nothing* — `/console`, `/endorse`, `/flow`, `/requirements`,
 * `/skills`, `/admin`. No pill in `public/viewbar.js` claims their paths, and that is a
 * decision recorded there rather than an omission here, so what each of them is asked is
 * that the row draws with no `aria-current` at all. It is also why none of them reaches
 * the reveal pass below: `later` asks which pill is lit, and for these the answer is
 * none.
 */
const PAGES = [
  { url: '/', file: 'index.html' },
  { url: '/monitor', file: 'monitor.html' },
  { url: '/prs', file: 'monitor.html' },
  { url: '/history', file: 'history.html' },
  { url: '/console', file: 'console.html' },
  { url: '/endorse', file: 'endorse.html' },
  { url: '/flow', file: 'flow.html' },
  { url: '/requirements', file: 'requirements.html' },
  { url: '/skills', file: 'skills.html' },
  { url: '/admin', file: 'admin.html' },
  { url: '/sounds', file: 'sounds.html' },
];

/**
 * The pages the deleted bottom bar was on.
 *
 * The one list in this file that is written down rather than derived, and it is written
 * down because it is *history*: what `public/tabbar.js` was pulled into before bc-khoe.1
 * removed it. History does not move, so nothing here can go stale — and without it the
 * page list above is only self-consistent. A page could drop `/viewbar.js` and be dropped
 * from `PAGES` in the same edit, and every assertion in this file would go on passing
 * about the pages that were left, which is precisely the state the bar's own check would
 * have had to be in to stop mattering.
 */
const REACHED = [
  'index.html',
  'monitor.html',
  'history.html',
  'admin.html',
  'console.html',
  'endorse.html',
  'flow.html',
  'requirements.html',
];

/* 360×640 is the cheap Android this app is for and the width every trade in this epic was
   argued at; 393×852 is the phone in the hand. Both, because a rule that holds at one
   width holds by accident. */
const SIZES = [
  { width: 360, height: 640 },
  { width: 393, height: 852 },
];

/**
 * A viewport narrow enough that the row cannot fit, for the one claim that is
 * unobservable on a row that does.
 *
 * The current pill being scrolled into view is a promise about an **overflowing** row: on
 * a row with room to spare `scrollLeft` is 0, every pill is visible, and the assertion
 * passes whether or not `reveal()` exists at all. The row does overflow a phone today and
 * the assertion at 360 and 393 is a real one — but that is a property of how many pills
 * happen to be in the list, not a property of the row, and one bead removing one pill
 * would turn every one of those into a green line about nothing. An assertion that is
 * vacuous *and looks exactly like an assertion that is not* is the worst thing in a check.
 *
 * So the row is put into the state it is promising something about, by giving it less
 * width than it needs, and this pass **fails if the row turns out to fit** — the
 * precondition is asserted rather than hoped for. It is not a phone; it stands in for the
 * phone the row is heading towards as bc-khoe.4 and bc-khoe.7 add to it, and the
 * arithmetic `reveal()` does is the same either way.
 */
const PINCH = { width: 240, height: 640 };

/* ------------------------------------------------------------------- the probe */

/*
  Everything measurable about the row in one round trip.

  Lines are found by vertical overlap rather than by grouping equal `top` values, for the
  reason `scripts/topbar-check.mjs` found: pills of different heights on one line have
  different tops, and grouping by top reports one row as several. The rectangles are also
  the only thing that can name *which* pill went to the second line, which is the half of
  a wrap you want in the failure message. `downBy` is the other shape of the same mistake
  — content overflowing the row downwards where `overflow-y: hidden` will clip it rather
  than show it — and that one is invisible on the screen, which is why it is asked for
  separately rather than inferred from the row's height.

  The hit test is done at the middle of the pill's **visible slice** rather than at the
  middle of the pill, and pills with no visible slice are not tested at all. A row that
  scrolls sideways has pills off both edges by design, and their centres are points on the
  screen belonging to some *other* pill — so testing them at their own centres reports
  every scrolled row as covered by something. A slice narrower than a few pixels is not
  worth pressing either; what the test is for is a pill you can see and cannot tap.
*/
const PROBE = `(() => {
  const name = (el) => el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') +
    (typeof el.className === 'string' && el.className.trim() ? '.' + el.className.trim().split(/\\s+/).join('.') : '');
  const nav = document.querySelector('.viewbar');
  /* A way back to Home that is not the row — the acceptance's fallback, and the thing
     that would have to be true if a page ever stopped drawing the row at all. */
  const homes = [...document.querySelectorAll('a')].filter((a) => {
    const h = a.getAttribute('href');
    return (h === '/' || h === '/index.html') && !nav?.contains(a) && a.getBoundingClientRect().width;
  });
  const home = homes[0];
  /* A second way home *in the chrome* — a page's own back arrow, drawn a few pixels above
     a Home pill that goes to the same place. A link home in the body of a page is prose
     and is nobody's duplicate, which is why the notice is asked of the top bar only. */
  const spare = homes.find((a) => a.closest('.topbar'));
  /* The route to /admin. It is a row in the menu behind the mark (public/accountbar.js)
     rather than a pill, which is the whole of bc-khoe.5's answer to where Admin went. */
  const chip = document.querySelector('#account-chip');
  const adminRow = document.querySelector('#account-admin');
  const hoisted = document.querySelector('#account-actions a[href="/admin"], #account-actions a[href="/admin.html"]');
  const plus = document.querySelector('#compose');
  const out = {
    row: !!nav,
    /* Did a page arrive at all? ROUTES below is a copy of the rewrites in serveStatic,
       and a rewrite that has moved there gives this fixture a 404 whose body is the word
       "no" — a document with no top bar, no row and no link home, which reads exactly
       like the row having broken. Reported separately so it does not. */
    page: !!document.querySelector('.topbar'),
    home: home ? name(home) : null,
    spare: spare ? name(spare) : null,
    chip: !!chip,
    admin: !chip ? null : hoisted ? 'hoisted' : adminRow && !adminRow.hidden ? 'menu' : null,
    plus: null,
  };
  /* Zero-sized means the kind you are on has no ＋ (bc-khoe.27.1) — Questions and PRs
     have nothing to create, and the wrapper is hidden there. Nothing to measure and
     nothing to complain about: the assertion below is that a drawn ＋ takes its own
     taps, not that one is drawn. */
  if (plus && plus.getBoundingClientRect().width) {
    const r = plus.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    out.plus = { w: Math.round(r.width), h: Math.round(r.height), takes: !!hit && (hit === plus || plus.contains(hit)), hit: hit ? name(hit) : null };
  }
  /* How many rows the list is actually showing. What a badge promises, measured on the
     screen the tap opens. '.card' rather than 'article.card': a chat row is a <div> with
     the same class, because it borrows the launcher's row markup (see chatRowHtml in
     public/app.js), and counting articles alone quietly reports Chats as empty. */
  out.rows = document.querySelectorAll('#list .card[data-key]').length;
  if (!nav) return out;
  const cs = getComputedStyle(nav);
  const nr = nav.getBoundingClientRect();
  const pills = [...nav.querySelectorAll('.viewpill')].map((el) => {
    const r = el.getBoundingClientRect();
    const from = Math.max(r.left, nr.left);
    const to = Math.min(r.right, nr.right);
    const on = to - from >= 8;
    const hit = on ? document.elementFromPoint((from + to) / 2, r.top + r.height / 2) : null;
    return {
      id: el.dataset.pill || null,
      tag: el.tagName,
      href: el.getAttribute('href'),
      current: el.getAttribute('aria-current'),
      kind: el.dataset.kind || null,
      /* The badge, as the text it is showing — \`null\` where there is no badge node at
         all, which is a different answer from an empty one and is what "off Home none of
         them carries a number" has to be asserted on. */
      count: (() => {
        const b = el.querySelector('.viewpill-count');
        return b ? b.textContent.trim() : null;
      })(),
      type: el.getAttribute('type'),
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: r.top,
      bottom: r.bottom,
      /** The whole pill inside the row's visible box, not merely overlapping it. */
      seen: r.left >= nr.left - 1 && r.right <= nr.right + 1,
      /** Enough of it on screen to press. A row that scrolls has pills off both edges. */
      on,
      /** What a thumb landing on the visible part of it actually reaches. */
      takes: !on || (!!hit && (hit === el || el.contains(hit))),
      hit: hit ? name(hit) : null,
    };
  });
  const lines = [];
  for (const p of pills) {
    const line = lines.find((L) => p.top < L.bottom - 2 && p.bottom > L.top + 2);
    if (line) {
      line.top = Math.min(line.top, p.top);
      line.bottom = Math.max(line.bottom, p.bottom);
      line.ids.push(p.id);
    } else lines.push({ top: p.top, bottom: p.bottom, ids: [p.id] });
  }
  lines.sort((a, b) => a.top - b.top);
  return {
    ...out,
    rowH: Math.round(nr.height),
    overflowX: cs.overflowX,
    overflowY: cs.overflowY,
    wrap: cs.flexWrap,
    scrollLeft: Math.round(nav.scrollLeft),
    scrollWidth: Math.round(nav.scrollWidth),
    clientWidth: Math.round(nav.clientWidth),
    /** A wrapped line clipped by \`overflow-y: hidden\` shows up here and nowhere else. */
    downBy: Math.round(nav.scrollHeight - nav.clientHeight),
    pills,
    lines: lines.map((L) => ({ h: Math.round(L.bottom - L.top), ids: L.ids })),
  };
})()`;

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

/* ---------------------------------------------------------------------- run */

let failures = 0;
const notices = [];
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

/* --------------------------------- the page list is the pages that draw the row */

console.log(`\n\x1b[1mthe row's own list\x1b[0m`);
{
  const drawn = fs
    .readdirSync(PUBLIC)
    .filter((f) => f.endsWith('.html'))
    .filter((f) => /src="\/viewbar\.js"/.test(fs.readFileSync(path.join(PUBLIC, f), 'utf8').replace(/<!--[\s\S]*?-->/g, ' ')));
  const covered = new Set(PAGES.map((p) => p.file));
  const missing = drawn.filter((f) => !covered.has(f));
  const stale = [...covered].filter((f) => !drawn.includes(f));
  if (!missing.length && !stale.length) ok(`every page that loads /viewbar.js is driven below (${drawn.length} of them)`);
  else {
    if (missing.length)
      bad('every page that loads /viewbar.js is driven below', `not in PAGES: ${missing.join(', ')} — add it, or the row goes uncovered there`);
    if (stale.length)
      bad('every page named below still loads /viewbar.js', `named in PAGES but no longer drawing the row: ${stale.join(', ')}`);
  }
  /* And every page the bottom bar was on is still one of them. Without this the guard
     above is only self-consistent — see the note on REACHED. */
  const dropped = REACHED.filter((f) => !covered.has(f));
  if (!dropped.length) ok('and every page the deleted bottom bar was on is still among them');
  else
    bad(
      'every page the deleted bottom bar was on is still driven',
      `${dropped.join(', ')} no longer appears — the bar was the only way off these, so one of them going uncovered is how a page becomes a dead end without anybody noticing`
    );
  ok(`the row's list has ${IDS.length} pills: ${IDS.join(', ')} — read from public/viewbar.js, not repeated here`);
}

const server = await serve();
const { port } = server.address();
const { s, close } = await launchChrome('beadcause-viewbar-');
/** Which pages offered a route to /admin, so the run can say whether any did. */
const adminFrom = new Map();
try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  for (const size of SIZES) {
    console.log(`\n\x1b[1m${size.width}×${size.height}\x1b[0m`);
    await s.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: true });

    for (const page of PAGES) {
      await s.send('Page.navigate', { url: `http://127.0.0.1:${port}${page.url}?t=viewbar-check` });
      await sleep(1100);
      await evalJs(s, `window.beadcause && window.beadcause.space && window.beadcause.space.adopt(${JSON.stringify(SPACEPAY)}), 1`);
      await sleep(250);
      const m = await evalJs(s, PROBE);
      const at = `${page.url} @${size.width}`;
      const want = litFor(page.url);

      /* Nothing the bottom bar reached may become a dead end — the page draws the row, or
         it has a way back to Home. Both halves are said in one message because which one
         has failed is the first thing you would want to know: a page still loading
         `/viewbar.js` (which is how it got into PAGES) and drawing no `.viewbar` has
         broken the row itself, and that is a different bug from a page that has stopped
         loading it. */
      if (!m.page) {
        bad(
          `${at}: the fixture serves a page for this URL`,
          `nothing with a .topbar came back — ROUTES in this file is a copy of the rewrites in serveStatic (lib/server.js), and one of them has moved`
        );
        continue;
      }
      if (!m.row) {
        bad(
          `${at}: the page draws the pill row, or has a way back to Home`,
          m.home
            ? `no .viewbar, though the page still loads /viewbar.js — the row itself has broken. Not a dead end: ${m.home} goes Home.`
            : 'no .viewbar and no link back to Home — this page is a dead end, which is the one thing deleting the bottom bar was not allowed to cost'
        );
        continue;
      }

      // Every pill in the list, in the list's order, and nothing else.
      const got = m.pills.map((p) => p.id);
      if (got.length === IDS.length && got.every((id, i) => id === IDS[i]))
        ok(`${at}: the row draws every pill in public/viewbar.js's order (${got.join(' · ')})`);
      else
        bad(
          `${at}: the row draws every pill in public/viewbar.js's order`,
          `the source says ${IDS.join(', ')}; the row drew ${got.join(', ') || '(none)'}`
        );

      // One line. Not "one line or the row got taller" — see the probe.
      if (m.lines.length === 1 && m.downBy <= 0 && m.wrap === 'nowrap')
        ok(`${at}: the row is one line, ${m.rowH}px (flex-wrap: ${m.wrap})`);
      else
        bad(
          `${at}: the row does not wrap`,
          m.lines.length > 1
            ? `it laid out in ${m.lines.length} lines: ${m.lines.map((L) => L.ids.join('+')).join(' / ')}` +
              (m.downBy > 0 ? ` — and ${m.downBy}px of it is clipped by overflow-y: hidden, so nothing looks wrong` : '')
            : m.downBy > 0
              ? `${m.downBy}px overflows it downwards and is clipped — something is taller than the row`
              : `flex-wrap is ${m.wrap}, so it is one line by luck rather than by declaration`
        );

      // Sideways instead. The row is allowed to be wider than the phone; that is the trade.
      if (/^(auto|scroll)$/.test(m.overflowX)) {
        const over = m.scrollWidth - m.clientWidth;
        ok(
          `${at}: it scrolls sideways (overflow-x: ${m.overflowX}` +
            (over > 0 ? `, ${over}px past the ${m.clientWidth}px screen` : ', and today it fits') +
            ')'
        );
      } else bad(`${at}: the row scrolls sideways`, `overflow-x is ${m.overflowX} — a row that cannot scroll is a row that wraps or clips`);

      // Exactly what the view table's `paths` say is current, and nothing where they say nothing.
      const cur = m.pills.filter((p) => p.current === 'page');
      if (cur.length === (want ? 1 : 0) && cur[0]?.id === (want ?? undefined))
        ok(
          want
            ? `${at}: "${want}" is the one current pill — public/hashroute.js's VIEWS say so`
            : `${at}: no pill is current, which is what the view table says for this page`
        );
      else
        bad(
          want ? `${at}: "${want}" is the one current pill` : `${at}: no pill is current on this page`,
          `aria-current is on ${cur.length ? cur.map((p) => p.id).join(', ') : 'nothing'}; the view table says ${want ?? 'nothing'}`
        );

      // Tapping where you are does nothing — and the mark is not only colour.
      for (const p of cur) {
        if (p.tag === 'SPAN' && !p.href) ok(`${at}: the current pill is a <span> with no href — tapping it does nothing`);
        else bad(`${at}: the current pill is a <span> with no href`, `"${p.id}" is a <${p.tag.toLowerCase()}>${p.href ? ` pointing at ${p.href}` : ''}`);
        // `aria-current` is the half of the mark that is not colour. The fill and the
        // border are the other half and they say the same thing to a different reader.
        ok(`${at}: and it is marked by aria-current="page", not by colour alone`);
      }

      /* Every other pill goes somewhere, or does something. `type="button"` is required of
         the button shape rather than assumed: a `<button>` without it is a submit button,
         and the row is `.after()`'d onto whatever markup the page has above it. */
      const dead = m.pills
        .filter((p) => p.current !== 'page')
        .filter((p) => !(p.tag === 'A' && p.href) && !(p.tag === 'BUTTON' && p.kind && p.type === 'button'));
      if (!dead.length)
        ok(
          `${at}: every other pill is a link or a button (${m.pills
            .filter((p) => p.current !== 'page')
            .map((p) => `${p.id} ${p.tag === 'A' ? p.href : `→${p.kind}`}`)
            .join(', ')})`
        );
      else
        bad(
          `${at}: every other pill is a link or a button`,
          dead
            .map((p) =>
              p.tag === 'BUTTON'
                ? `"${p.id}" is a <button type="${p.type || '(none)'}"${p.kind ? '' : ' with no data-kind'}> — the row's listener will not act on it`
                : `"${p.id}" is a <${p.tag.toLowerCase()}> with no href and no data-kind — it is drawn but does nothing`
            )
            .join('; ')
        );

      // A thumb's worth of pill, in both directions.
      const small = m.pills.filter((p) => p.h < TAP - 0.5 || p.w < TAP - 0.5);
      if (!small.length)
        ok(`${at}: every pill is at least ${TAP}px (smallest ${Math.min(...m.pills.map((p) => p.w))}×${Math.min(...m.pills.map((p) => p.h))})`);
      else bad(`${at}: every pill is at least ${TAP}px`, small.map((p) => `${p.id} ${p.w}×${p.h}`).join(', '));

      // And the row takes its own taps — nothing is drawn over it.
      const covered = m.pills.filter((p) => !p.takes);
      const onScreen = m.pills.filter((p) => p.on);
      if (!covered.length)
        ok(
          `${at}: every pill on screen takes its own taps (${onScreen.length} of ${m.pills.length}` +
            (onScreen.length < m.pills.length ? ', the rest are a sideways flick away' : '') +
            ')'
        );
      else
        bad(
          `${at}: the row takes its own taps`,
          covered.map((p) => `a tap on "${p.id}" reaches ${p.hit || 'nothing'}`).join('; ')
        );

      /* Where the row starts. With something current it must be on screen; with nothing
         current there is nothing to reveal and the row must not have moved on its own. */
      if (cur.length) {
        if (cur[0].seen) ok(`${at}: the current pill is on screen at load (row scrolled ${m.scrollLeft}px)`);
        else bad(`${at}: the current pill is on screen at load`, `"${cur[0].id}" is off the edge with the row scrolled to ${m.scrollLeft}px`);
      } else if (m.scrollLeft === 0) ok(`${at}: nothing is current, and the row starts at its left edge`);
      else bad(`${at}: the row starts at its left edge when nothing is current`, `it is scrolled to ${m.scrollLeft}px`);

      /* The route to /admin. It is not on the row by design, so the row being right is
         only half the acceptance — the other half is that the screen the bottom bar's
         rightmost tab reached is still reachable. A page with no mark's menu at all is not
         asked — it has no place to put the row — which is why the run ends by saying
         whether *any* page offered the route rather than trusting that some page did. */
      if (m.chip && page.url !== '/admin') {
        if (m.admin) {
          adminFrom.set(page.url, m.admin);
          ok(`${at}: /admin is reachable from here — ${m.admin === 'hoisted' ? "the page's own ⚙, hoisted into the mark's menu" : "the Admin row in the mark's menu"}`);
        } else bad(`${at}: /admin is reachable from here`, 'no Admin row in the mark\'s menu and no ⚙ of its own — the rightmost tab\'s destination is stranded');
      }

      /* ＋ is the one control on Home that creates rather than answers, and the bottom
         bar's check ended by asking whether it was reachable — it sat above the bar and
         had to take its own taps. The bar is gone and the question survives it. */
      if (m.plus) {
        if (m.plus.takes) ok(`${at}: ＋ takes its own taps (${m.plus.w}×${m.plus.h})`);
        else bad(`${at}: ＋ takes its own taps`, `a tap on it reaches ${m.plus.hit}`);
      }

      if (outDir) {
        const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, `viewbar-${page.url === '/' ? 'inbox' : page.url.slice(1)}-${size.width}.png`), Buffer.from(data, 'base64'));
      }

      /* The counts. Which pills carry one is read out of the row's own list, like
         everything else here; *where* they are drawn is Home and nowhere else, which is
         the whole of the answer to the staleness objection in that file's header. */
      const isHome = ['/', '/index.html'].includes(norm(page.url));
      const badged = m.pills.filter((p) => p.count !== null).map((p) => p.id);
      const wantBadged = isHome ? PILLS.filter((p) => p.count).map((p) => p.id) : [];
      if (badged.length === wantBadged.length && badged.every((id, i) => id === wantBadged[i]))
        ok(
          isHome
            ? `${at}: ${badged.join(', ')} carry a count and ${IDS.length - badged.length} others carry none — public/viewbar.js's own list says so`
            : `${at}: no pill carries a count off Home`
        );
      else
        bad(
          isHome ? `${at}: the four counted pills carry a count and no others do` : `${at}: no pill carries a count off Home`,
          `the source flags ${wantBadged.join(', ') || '(none)'}; the row drew a badge on ${badged.join(', ') || '(none)'}`
        );

      /* And what they say. The fixture is the ground truth — see WANT — so this is the
         badge asserted against the list that was served rather than against itself. */
      if (isHome) {
        const said = Object.fromEntries(m.pills.filter((p) => p.count !== null).map((p) => [p.id, p.count]));
        const wrong = Object.entries(WANT).filter(([id, n]) => said[id] !== String(n));
        if (!wrong.length)
          ok(`${at}: the counts are ${Object.entries(WANT).map(([id, n]) => `${id} ${n}`).join(' · ')} — the list the fixture served`)
        else
          bad(
            `${at}: each count is the rows that pill would leave you with`,
            wrong.map(([id, n]) => `${id} says ${said[id] ?? '(no badge)'} and the fixture holds ${n}`).join('; ') +
              ' — PRs is counted through its own status sub-filter, so the merged one is deliberately not in it'
          );
      }

      /* A page that has both the row and a `‹` back to Home has two ways home drawn at
         once. Reported rather than failed: which of the two should go is a design call
         and not this file's to make — but it is the kind of thing that arrives silently
         and is never noticed by anybody who was not looking for it. */
      if (m.spare) notices.push(`\x1b[33m!\x1b[0m ${at}: the row and ${m.spare} are two ways Home in one page's chrome`);
    }
  }

  /* --------------------------------------------- the counts, on the screen they open */

  /*
    A badge is a promise about the list a tap opens, so the tap is taken and the list is
    counted. Everything above this point could be true of a row printing four numbers it
    invented.

    Home only, at the wider of the two phones, and through the row's own `<button>` — a
    kind pill on Home moves the filter rather than loading a page, so a real click is
    the whole path: the listener, `pick`, `set`, `paint`, and the render that follows.
  */
  console.log(`\n\x1b[1mwhat the counts open\x1b[0m`);
  await s.send('Emulation.setDeviceMetricsOverride', { ...SIZES[1], deviceScaleFactor: 2, mobile: true });
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=viewbar-check-counts` });
  await sleep(1400);
  for (const id of PILLS.filter((p) => p.count).map((p) => p.id)) {
    const tapped = await evalJs(
      s,
      `(() => {
        const el = document.querySelector('.viewpill[data-pill="${id}"]');
        if (!el) return 'no pill';
        if (el.tagName !== 'BUTTON') return el.tagName;
        el.click();
        return 'ok';
      })()`
    );
    /* `epics` is current on an unnarrowed Home, so it is a <span> and there is nothing to
       tap — which is the correct shape and not a failure. Its number is asserted where it
       stands, against the list that is already on screen. */
    if (tapped !== 'ok' && !(id === 'epics' && tapped === 'SPAN')) {
      bad(`/ @${SIZES[1].width}: "${id}" can be tapped`, `it is a <${String(tapped).toLowerCase()}> on an unnarrowed Home`);
      continue;
    }
    await sleep(500);
    const m = await evalJs(s, PROBE);
    const badge = m.pills.find((p) => p.id === id)?.count;
    if (badge !== null && String(m.rows) === badge)
      ok(`/ @${SIZES[1].width}: "${id}" says ${badge}, and tapping it leaves ${m.rows} row(s) on screen`);
    else
      bad(
        `/ @${SIZES[1].width}: "${id}" opens the list its badge promised`,
        `the badge says ${badge ?? '(none)'} and the list drew ${m.rows} row(s)` +
          (id === 'pr' ? ' — the merged pull request is in neither, by the status sub-filter' : '')
      );
    /* Back to an unnarrowed Home, so the next pill is tapped from the same state. */
    await evalJs(s, `document.querySelector('.viewpill[data-pill="epics"]')?.click?.(), 1`);
    await sleep(400);
  }

  /*
    In place, and never through `draw()`.

    The inbox repaints every 25 seconds and the counts ride along with it, so a badge that
    updated by rebuilding the row would drop the focus ring off a pill somebody is tabbing
    through — which is the same failure `mark()` guards against and the reason the number
    is written as text rather than as markup. Both halves are asserted at once: the badge
    node has to be the *same node* after the number moved, and the focus has to still be
    where it was.
  */
  {
    const held = await evalJs(
      s,
      `(() => {
        const pill = document.querySelector('.viewpill[data-pill="question"]');
        const badge = pill && pill.querySelector('.viewpill-count');
        if (!badge) return { ok: false, why: 'no badge on Questions' };
        const focusable = document.querySelector('button.viewpill[data-pill="pr"]');
        focusable && focusable.focus();
        const before = badge.textContent;
        window.beadcause.views.counts({ epics: 421, question: 128, pr: 999, session: 7 });
        const after = document.querySelector('.viewpill[data-pill="question"] .viewpill-count');
        return {
          ok: true,
          before,
          after: after ? after.textContent : null,
          same: after === badge,
          focused: document.activeElement === focusable,
          pr: document.querySelector('.viewpill[data-pill="pr"] .viewpill-count')?.textContent ?? null,
        };
      })()`
    );
    if (!held.ok) bad('the counts update in place', held.why);
    else {
      if (held.after === '128' && held.before !== '128') ok(`the number changes when a poll lands (${held.before} → ${held.after})`);
      else bad('the number changes when a poll lands', `it went from ${held.before} to ${held.after}`);
      if (held.same) ok('and it is the same badge element — the row was not rebuilt to say it');
      else bad('the badge is updated in place, not redrawn', 'the element holding the number was replaced');
      if (held.focused) ok('so focus stays on the pill it was on');
      else bad('focus stays on the pill it was on', 'the focused pill was replaced under the keyboard');
    }
  }

  /*
    Three digits on every count, which is the widest the row will ever be asked to be, and
    it must still be one line. Pushed rather than fetched: the row takes its numbers from
    an API, so the widest case is one call away and does not need a fixture to produce it.
  */
  for (const size of SIZES) {
    await s.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: true });
    await sleep(150);
    await evalJs(s, `window.beadcause.views.counts({ epics: 999, question: 999, pr: 999, session: 999 }), 1`);
    await sleep(150);
    const m = await evalJs(s, PROBE);
    const three = m.pills.filter((p) => p.count !== null).every((p) => p.count === '999');
    if (three && m.lines.length === 1 && m.downBy <= 0)
      ok(`/ @${size.width}: still one line with every count at three digits (${m.scrollWidth - m.clientWidth}px of sideways scroll)`);
    else
      bad(
        `/ @${size.width}: the row is one line with every count at three digits`,
        !three
          ? 'the counts did not take'
          : `${m.lines.length} line(s), ${m.downBy}px clipped downwards: ${m.lines.map((L) => L.ids.join('+')).join(' / ')}`
      );
  }

  /* ------------------------------------------- a pill the scope cannot fetch */

  /*
    The one pill on the row that is not simply a narrowing of what is already in hand.

    `bead` is the only kind with a `side` (public/inboxfilter.js), and the scope decides
    which sweep runs — so under `Human`, the default and the scope nearly every phone is
    on, the beads have not been fetched and could not be shown. The row does not know
    that: viewbar.js draws all seven pills on all twelve pages, which is what lets one
    row say the same thing everywhere. So for a while `All Beads` under `Human` was a
    pill whose tap was swallowed — `set()` dropped the selection, `current()` fell back
    and the row lit `My Epics` (bc-khoe.25).

    Driven here rather than only in `test/inboxkinds.mjs` because everything that suite
    can reach is the *filter*: this is three files agreeing across a real tap — the row's
    click handler, the filter's widen seam, and public/app.js answering it with the scope
    switch beside the row. The refetch is asserted off the fixture's own request log,
    because a page read afterwards cannot tell you whether one went out.
  */
  console.log(`\n\x1b[1mAll Beads, from the scope that cannot fetch one\x1b[0m`);
  {
    await s.send('Emulation.setDeviceMetricsOverride', { ...SIZES[1], deviceScaleFactor: 2, mobile: true });
    /* Once to have an origin to write in, then again so the page boots with the scope
       parked where the pill was dead. The stored kinds go too — a previous run of this
       file leaves `bead` in there, which would be the check passing on its own history. */
    await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=viewbar-check-scope` });
    await sleep(900);
    await evalJs(s, `localStorage.setItem('beadcause.scope', 'human'), localStorage.removeItem('beadcause.kinds'), 1`);
    await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/?t=viewbar-check-scope-2` });
    await sleep(1200);

    const STATE = `(() => {
      const armed = document.querySelector('.filterpills .chip-row.scopes .chip[aria-pressed="true"]');
      const cur = document.querySelector('.viewbar [aria-current="page"]');
      const bead = document.querySelector('.viewbar [data-pill="bead"]');
      return {
        scope: armed ? armed.dataset.chip : null,
        lit: cur ? cur.dataset.pill : null,
        beadTag: bead ? bead.tagName.toLowerCase() : null,
        stored: localStorage.getItem('beadcause.scope'),
      };
    })()`;

    const before = await evalJs(s, STATE);
    if (before.scope === 'human') ok('Home comes up on Human, which is the scope the beads are not fetched on');
    else bad('Home comes up on Human', `the armed scope chip says ${before.scope ?? 'nothing'} — the rest of this section is measuring something else`);
    if (before.lit === 'epics') ok('and My Epics is lit, which is Home with nothing narrowed');
    else bad('My Epics is lit before the tap', `the row says ${before.lit ?? 'nothing'}`);
    if (before.beadTag === 'button') ok('All Beads is drawn as a tappable button on this scope, not hidden and not inert');
    else bad('All Beads is a tappable button on Human', `it is a <${before.beadTag ?? 'nothing'}> — a pill you cannot tap is the other way to make this bug`);

    const asked = HITS.length;
    const hit = await evalJs(s, `!!document.querySelector('.viewbar button.viewpill[data-pill="bead"]')?.click() || true`);
    await sleep(1400);
    const after = await evalJs(s, STATE);

    if (after.lit === 'bead') ok('tapping it leaves All Beads lit');
    else
      bad(
        'tapping All Beads leaves All Beads lit',
        after.lit === 'epics'
          ? 'the row bounced back to My Epics — the selection was dropped rather than reached, which is bc-khoe.25 exactly'
          : `the row lights ${after.lit ?? 'nothing'}`
      );
    if (after.scope === 'both') ok('and the scope switch beside it has moved to Both, where the beads are fetched');
    else bad('the scope switch moves to Both', `it says ${after.scope ?? 'nothing'} — the widening is invisible, or did not happen`);
    if (after.stored === 'both') ok('and it is stored, so the widening survives a reload like every other scope change');
    else bad('the widened scope is stored', `beadcause.scope is ${after.stored ?? 'unset'}`);

    const refetched = HITS.slice(asked).filter((u) => u.startsWith('/api/questions?scope=both'));
    if (refetched.length) ok(`and the beads were actually asked for (${refetched[0]})`);
    else
      bad(
        'the tap refetches on the wider scope',
        `nothing asked for /api/questions?scope=both — the pill lit a slice of a payload that was never fetched. Since the tap: ${HITS.slice(asked).join(', ') || 'no requests at all'}`
      );
    /* The other half of the bead, and the one a green check above could hide: the widening
       is a request *on a tap*, and the Human poll it left behind must not have grown one.
       bc-w156.4 refused paying for a per-workspace bead query on every Human poll and that
       refusal stands. */
    const onHuman = HITS.slice(0, asked).filter((u) => u.startsWith('/api/questions?scope=') && !u.startsWith('/api/questions?scope=human'));
    if (!onHuman.length) ok('and nothing went out on a wider scope before the tap — the Human poll is unchanged');
    else bad('the Human poll asks for nothing wider', `it asked for ${[...new Set(onHuman)].join(', ')}`);
  }

  /* ------------------------------------------------- the row that does not fit */

  /*
    The reveal, on a row that has been made to overflow.

    Every page whose pill is *not* the first one, because revealing the first is what
    `scrollLeft: 0` already does and a check that only ever looked at Home would pass with
    `reveal()` deleted.
  */
  console.log(`\n\x1b[1m${PINCH.width}×${PINCH.height} — the row narrower than its pills\x1b[0m`);
  await s.send('Emulation.setDeviceMetricsOverride', { ...PINCH, deviceScaleFactor: 2, mobile: true });
  const later = PAGES.filter((p) => {
    const id = litFor(p.url);
    return id && IDS.indexOf(id) > 0;
  });
  if (!later.length) bad('some page lights a pill other than the first', 'every path in the row points at its first pill — the reveal cannot be observed');
  for (const page of later) {
    await s.send('Page.navigate', { url: `http://127.0.0.1:${port}${page.url}?t=viewbar-check-pinch` });
    await sleep(1100);
    const m = await evalJs(s, PROBE);
    const at = `${page.url} @${PINCH.width}`;
    if (!m.row) {
      bad(`${at}: the page draws the pill row`, 'it does not draw one at this width');
      continue;
    }
    const over = m.scrollWidth - m.clientWidth;
    if (over <= 0) {
      bad(
        `${at}: the row overflows at ${PINCH.width}px`,
        `it fits in ${m.clientWidth}px with ${IDS.length} pills — this pass exists to put the row in the state the reveal is about, and it is not in it`
      );
      continue;
    }
    const cur = m.pills.find((p) => p.current === 'page');
    if (!cur) {
      bad(`${at}: "${litFor(page.url)}" is current`, 'nothing carries aria-current at this width');
      continue;
    }
    if (cur.seen)
      ok(`${at}: "${cur.id}" is scrolled into view on load — the row is ${over}px wider than the screen and starts at ${m.scrollLeft}px`);
    else
      bad(
        `${at}: "${cur.id}" is scrolled into view on load`,
        `the row is ${over}px wider than its ${m.clientWidth}px of screen and sits at scrollLeft ${m.scrollLeft} — the pill saying where you are is off the edge`
      );
    // Still one line, at the width where wrapping would be most tempting.
    if (m.lines.length === 1 && m.downBy <= 0) ok(`${at}: and it is still one line`);
    else bad(`${at}: the row is still one line`, `${m.lines.length} lines, ${m.downBy}px clipped downwards`);
  }
} finally {
  close();
  server.close();
}

/* ------------------------------------------------------------------ the summary */

if (!adminFrom.size) bad('/admin is reachable from a standing page', 'no page in this run offered a route to it');
else console.log(`\n\x1b[1m/admin\x1b[0m\n  reachable from ${[...adminFrom.keys()].join(', ')}`);

if (notices.length) {
  console.log('\n\x1b[1mworth a look\x1b[0m');
  for (const n of [...new Set(notices)]) console.log(`  ${n}`);
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mthe pill row holds\x1b[0m');
