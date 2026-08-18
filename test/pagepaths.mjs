#!/usr/bin/env node
/**
 * Every URL a phone still has on its home screen, and what it serves.
 *
 *     npm test
 *     node test/pagepaths.mjs
 *
 * Pages get renamed and merged; the shortcuts people already made do not. So each
 * view answers to several paths — `/monitor`, `/advocates`, `/sessions`, `/work`,
 * `/work.html`, `/prs`, `/pulls` and `/prs.html` are by now all one page — and the whole
 * point of keeping the extra ones is that a bookmark never 404s. There was nothing
 * checking that, and the aliases live in a run of one-line `if`s in `serveStatic` which
 * is exactly the shape a merge conflict eats.
 *
 * The case that made this worth a test: when the sessions view was merged into the
 * advocate console, `public/work.html` was deleted. `/work` and `/sessions` were already
 * aliases and were simply repointed; `/work.html` never *had* been one — it resolved as
 * a file on disk — so deleting the file broke it, and it is the one of the three a
 * service worker had been precaching by name. Nothing in the app would have said so.
 * It has happened once more since, the same way: the pull request board became a pane on
 * that same page (bc-d4d5) and `public/prs.html` went with it, which makes `/prs.html`
 * the second path in this file whose file on disk is gone.
 *
 * Static serving only, so no `bd`, no advocates and no poller: `createApp` is handed a
 * config with all of that off.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundPort } from './helpers/net.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LIB = (f) => path.join(HERE, '..', 'lib', f);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-pagepaths-'));
process.env.BEADCAUSE_CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(process.env.BEADCAUSE_CONFIG_DIR, { recursive: true });

let failures = 0;
let ran = 0;
const ok = (name) => {
  ran += 1;
  console.log(`  \x1b[32m✓\x1b[0m ${name}`);
};
const bad = (name, detail) => {
  ran += 1;
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

/* ----------------------------------------------------------------- the app */

const ws = path.join(tmp, 'ws');
fs.mkdirSync(path.join(ws, '.beads'), { recursive: true });

const cfg = {
  port: 0,
  host: '127.0.0.1',
  baseUrl: 'http://127.0.0.1',
  token: 'pagepaths-token',
  actor: 'beadcause-test',
  workspaces: [{ name: 'demo', dir: ws }],
  openSessions: false,
  autoDispatch: false,
  claudeSessions: false,
  pollSeconds: 3600,
  terminal: false,
  ntfy: { enabled: false },
  advocates: { enabled: false, workspaces: [] },
};

const { createApp, listen } = await import(LIB('server.js'));

const app = createApp(cfg);
const servers = listen(cfg, app.handler);
const port = await boundPort(servers);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        // `location` because two of these paths are a redirect rather than a document,
        // and `http.request` does not follow one — which is what makes it the right
        // client here: the hop itself is the thing under test.
        res.on('end', () => resolve({ status: res.statusCode, body: out, location: res.headers.location }));
      }
    );
    req.on('error', reject);
    req.end();
  });

/* -------------------------------------------------------------------- cases */

/**
 * One page, every path that must reach it, and a string only that page contains.
 *
 * The marker is an id or a script src rather than a title, because a title is the
 * sort of thing a redesign changes on purpose and the point here is only "which
 * document came back".
 */
const PAGES = [
  {
    what: 'the inbox',
    marker: '/app.js',
    paths: ['/', '/index.html'],
  },
  {
    // Nine, and six of them are inherited. The sessions view was merged into this page
    // and its three paths came with it rather than being retired under people's thumbs;
    // the pull request board became a pane on it (bc-d4d5) and its three came the same
    // way. `/work.html` and `/prs.html` are the two with no file behind them any more,
    // which is exactly why they are worth a row here.
    what: 'the advocate console',
    marker: '/monitor.js',
    paths: [
      '/monitor',
      '/advocates',
      '/monitor.html',
      '/sessions',
      '/work',
      '/work.html',
      '/prs',
      '/pulls',
      '/prs.html',
    ],
  },
  // One live session's facts and its transcript — the page every session row in the app
  // links to, and the reason the console could absorb the sessions view at all.
  { what: 'one session', marker: '/session.js', paths: ['/session', '/session.html'] },
  // And the same detail for one that has finished, addressed by bead instead of by pid.
  // `/archive` is the second path because it is the word the repo uses for this everywhere
  // else — `refs/beadcause/sessions/…` is "the archive" in the README and in the API — and
  // it is therefore the path somebody types.
  {
    what: 'one finished session',
    marker: '/beadsession.js',
    paths: ['/bead-session', '/archive', '/beadsession.html'],
  },
  // The board itself, which has no paths of its own any more — these are the three the
  // advocate console above inherited from it. Listed a second time with a second marker
  // on purpose: `/monitor.js` proves those paths reach that page, and only `/prs.js`
  // proves the page they reach is one that can draw a board. A monitor.html that dropped
  // the pane's script would pass every row above and serve a Ship button that is not
  // there, which is the failure bc-d4d5 was filed about arriving by a different door.
  { what: 'the pull request board', marker: '/prs.js', paths: ['/prs', '/pulls', '/prs.html'] },
  // The endorsement queue. Three, because the screen has two honest names — the place
  // you *endorse* and the *queue* of what is waiting — and which one comes to mind
  // depends on whether you arrived from the inbox's 🗳️ or went looking for it.
  {
    what: 'the endorsement queue',
    marker: '/endorse.js',
    paths: ['/endorse', '/queue', '/endorsements', '/endorse.html'],
  },
  // The ledger. Two paths and not three, unlike the queue above it: it has been a tab
  // on the bottom bar since the day it existed, so the bar is the only thing that has
  // ever linked to it and there is no older name in anybody's home screen to keep alive.
  { what: 'the history tab', marker: '/history.js', paths: ['/history', '/history.html'] },
  // The selected space's settings (bc-khoe.10). Two paths for the same reason the queue
  // has three: the screen has two honest names — it is the *config* of a space, which is
  // the word the chip it used to be was labelled with, and it is where its *settings*
  // are, which is what somebody types. Not `/space`: that reads as the picker rather than
  // as the thing the picker selects.
  { what: "the space's settings", marker: '/config.js', paths: ['/config', '/settings', '/config.html'] },
  // The skill library and whether anything uses it (bc-dgx7.5). Two paths, because the
  // page is reached both by what it holds and by what the programme calls the things
  // waiting to become one. No pill claims either, which is the recorded decision in
  // public/viewbar.js for a page you read when you are arguing about the system.
  { what: 'the skills view', marker: '/skills.js', paths: ['/skills', '/candidates', '/skills.html'] },
  { what: 'the chat session', marker: '/console.js', paths: ['/console', '/console.html'] },
  { what: 'the in-app terminal', marker: '/term.js', paths: ['/terminal', '/term.html'] },
  { what: 'the admin screen', marker: '/admin.js', paths: ['/admin', '/admin.html'] },
  // The notification-sound audition (bc-ka5y.15.3). `/audition` as well as `/sounds`
  // because that is the word the bead and the README use for what happens on it, and a
  // channel's sound is immutable once cut — a 404 on the way to the last screen where a
  // sound can still be argued with is an expensive 404.
  { what: 'the sound audition', marker: '/sounds.js', paths: ['/sounds', '/audition', '/sounds.html'] },
  { what: 'the graph', marker: '/graph.js', paths: ['/graph', '/graph.html'] },
  { what: 'the reader', marker: '/doc.js', paths: ['/doc', '/doc.html'] },
  // The sign-in screen. Its alias lives in the same run of one-line `if`s as all of
  // the above — and this is the one page a browser is *sent* to rather than typing, so
  // a 404 here is a redirect loop with nothing on screen. Reachable with sign-in off
  // too, which is the configuration this test runs in: it is also where the pairing
  // token is explained.
  { what: 'the sign-in screen', marker: '/login.js', paths: ['/login', '/login.html'] },
];

/**
 * The paths that are a **hop** rather than a document, and where each one has to land.
 *
 * `/closed` and `/done` are the ledger narrowed to what finished (bc-nib3.7), and the
 * only reason they are not two more rows in `PAGES` above is the mechanism: the filter
 * they set lives in the query string, an alias rewrites the path and leaves the query
 * exactly as the browser sent it, so serving `history.html` at `/closed` would be the
 * whole unfiltered ledger under a name that promised otherwise. That failure is
 * invisible from the outside — a plausible list of the wrong beads — which is why the
 * `location` is asserted in full here rather than the page it eventually reaches.
 *
 * The last two rows are the two halves of what the door does with a query string it was
 * handed: everything is carried across, because `?t=` is a pairing token an ntfy action
 * or a home-screen shortcut can arrive with and dropping it turns the second navigation
 * into a login screen; and `status` alone is overruled, because `/closed?status=open` is
 * a contradiction and the name of the door is the half that is not a typo.
 */
const REDIRECTS = [
  { path: '/closed', to: '/history?status=closed', what: 'the ledger, narrowed to what finished' },
  { path: '/done', to: '/history?status=closed', what: 'the same, under the other word for it' },
  { path: '/closed?priority=P0', to: '/history?priority=P0&status=closed', what: 'a second filter, kept' },
  { path: '/closed?t=pair-me', to: '/history?t=pair-me&status=closed', what: 'the pairing token, kept' },
  { path: '/closed?status=open', to: '/history?status=closed', what: 'a contradicted status, overruled' },
];

/* The sessions view's own files. Deleted with it, and named here so a stray copy
   coming back is a failing test rather than a page nobody maintains. */
const GONE = ['/work.js'];

/**
 * Paths that were never made, and the decision that says they never will be.
 *
 * The Mirror is a *pane* on the advocates page, not a fifth bottom tab (bc-3xb — the
 * reasons are in the README under "The Mirror is a pane, not a tab"). The other way was
 * a `/mirror` route and a `mirror.html`, and the cheapest way for this decision to come
 * undone is for one of those to appear in the run of one-line `if`s above — a merge, a
 * half-remembered plan, a session that never read the bead. That would be silent: a new
 * page nobody objected to.
 *
 * `test/mirrorpane.mjs` asserts the same two absences by reading the sources, and this is
 * the other side of that pair rather than a second copy of it. A static read has to know
 * the shape the route would take — it greps `lib/server.js` for `urlPath === '/mirror'` —
 * so a redirect, a prefix match, or a `mirror.html` dropped into `public/` and served by
 * the static handler would all pass it. This asks a running server instead, which is the
 * claim the decision makes: not that the code avoids a string, but that there is nothing
 * at either path.
 */
const NEVER_MADE = [
  { path: '/mirror', why: 'the mirror is a pane on /monitor, not a page (bc-3xb)' },
  { path: '/mirror.html', why: 'and there is no document behind it to serve' },
];

console.log('\npage paths\n');

for (const page of PAGES) {
  for (const p of page.paths) {
    const res = await get(p);
    if (res.status !== 200) bad(`${p} serves ${page.what}`, `HTTP ${res.status}`);
    else if (!res.body.includes(page.marker)) bad(`${p} serves ${page.what}`, `no ${page.marker} in the body`);
    else ok(`${p} serves ${page.what}`);
  }
}

for (const { path: p, to, what } of REDIRECTS) {
  const res = await get(p);
  if (res.status !== 302) bad(`${p} sends you to ${what}`, `HTTP ${res.status}, not a redirect`);
  else if (res.location !== to) bad(`${p} sends you to ${what}`, `landed on ${res.location}, not ${to}`);
  else ok(`${p} → ${to} — ${what}`);
}

/* And that the far end of that hop is a real page and not a 404 under a good-looking
   `location` — the one thing asserting the header alone cannot tell you. */
{
  const res = await get('/history?status=closed');
  if (res.status !== 200) bad('and /history?status=closed is a page', `HTTP ${res.status}`);
  else if (!res.body.includes('/history.js')) bad('and /history?status=closed is a page', 'no /history.js in the body');
  else ok('and /history?status=closed is a page');
}

for (const p of GONE) {
  const res = await get(p);
  if (res.status === 404) ok(`${p} is gone, and says so`);
  else bad(`${p} is gone, and says so`, `HTTP ${res.status}`);
}

for (const { path: p, why } of NEVER_MADE) {
  const res = await get(p);
  if (res.status === 404) ok(`${p} 404s — ${why}`);
  else bad(`${p} 404s — ${why}`, `HTTP ${res.status}: something is serving a page this decision says does not exist`);
}

/*
  And the other half of the same worry: a path that serves the right page but that the
  pill row does not recognise (bc-khoe.1).

  Every table above proves a shortcut still *opens* something. None of them proves the
  navigation knows where you have landed — and the row marks the current view by asking
  `viewOfPath` what view `location.pathname` names, so a phone opening the `/work`
  shortcut it has had on its home screen for months would get the advocate console with
  **nothing on the row current**. That reads as the page having lost its way in, on the
  exact devices the aliases exist for.

  The table those paths live in moved to public/hashroute.js with bc-khoe.30.2 — which
  view an address names is the same question as which view a hash names, and the point of
  that file is that it is asked in one place. So this reads `VIEWS` rather than `PILLS`,
  and the word "pill" below is a view's pill: the ids are deliberately the same.

  So: for every page a pill points at, every alias of that page is claimed by exactly one
  pill. Exactly one, because two pills claiming a path is two current pills on one screen —
  and the pair this is really about is Advocates and PRs, which share a document and split
  its nine paths between them. `.html` twins are excluded: `/prs.html` is genuinely on
  people's home screens and is claimed, but `/endorse.html` belongs to a page that has no
  pill at all, and the rule is about pages that have one.
*/
{
  const src = fs.readFileSync(path.join(HERE, '..', 'public', 'hashroute.js'), 'utf8');
  const pills = [...src.matchAll(/id: '([a-z]+)',[\s\S]{0,400}?paths: \[([^\]]*)\]/g)].map((m) => ({
    id: m[1],
    paths: [...m[2].matchAll(/'([^']+)'/g)].map((q) => q[1]),
  }));
  if (!pills.length) bad('the pill row keeps its paths in one table', 'could not read VIEWS out of public/hashroute.js');
  else {
    const owner = new Map();
    let clash = null;
    for (const pill of pills) {
      for (const one of pill.paths) {
        if (owner.has(one)) clash = `${one} is claimed by both ${owner.get(one)} and ${pill.id}`;
        owner.set(one, pill.id);
      }
    }
    if (clash) bad('no path is claimed by two pills', clash);
    else ok(`the row's ${owner.size} paths are claimed by ${pills.length} pills, one each`);

    for (const page of PAGES) {
      // The page a pill lives on is the one whose alias list holds that pill's own paths.
      if (!page.paths.some((one) => owner.has(one))) continue;
      const orphans = page.paths.filter((one) => !owner.has(one));
      if (!orphans.length) ok(`every path of ${page.what} is on the row`);
      else
        bad(
          `every path of ${page.what} is on the row`,
          `${orphans.join(', ')} serve${orphans.length === 1 ? 's' : ''} it but no pill recognises ` +
            `${orphans.length === 1 ? 'it' : 'them'} — arriving that way marks nothing as current`
        );
    }
  }
}

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
