#!/usr/bin/env node
/**
 * Every URL a phone still has on its home screen, and what it serves.
 *
 *     npm test
 *     node test/pagepaths.mjs
 *
 * Pages get renamed and merged; the shortcuts people already made do not. So each
 * view answers to several paths — `/monitor`, `/advocates`, `/sessions`, `/work` and
 * `/work.html` are all one page, `/prs` and `/pulls` are another — and the whole point
 * of keeping the extra ones is that a bookmark never 404s. There was nothing checking
 * that, and the aliases live in a run of one-line `if`s in `serveStatic` which is
 * exactly the shape a merge conflict eats.
 *
 * The case that made this worth a test: when the sessions view was merged into the
 * advocate console, `public/work.html` was deleted. `/work` and `/sessions` were already
 * aliases and were simply repointed; `/work.html` never *had* been one — it resolved as
 * a file on disk — so deleting the file broke it, and it is the one of the three a
 * service worker had been precaching by name. Nothing in the app would have said so.
 *
 * Static serving only, so no `bd`, no advocates and no poller: `createApp` is handed a
 * config with all of that off.
 */
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const { port: p } = probe.address();
    probe.close(() => resolve(p));
  });
});

const app = createApp({ ...cfg, port });
const servers = listen({ ...cfg, port }, app.handler);

const get = (pathname) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: pathname, method: 'GET', headers: { 'x-beadcause-token': cfg.token } },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve({ status: res.statusCode, body: out }));
      }
    );
    req.on('error', reject);
    req.end();
  });

for (let i = 0; i < 100; i += 1) {
  try {
    await get('/icon.svg');
    break;
  } catch {
    await new Promise((r) => setTimeout(r, 20));
  }
}

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
    // Five, and the last three are inherited: the sessions view was merged into this
    // page, and its paths came with it rather than being retired under people's
    // thumbs. `/work.html` is the one that has no file behind it any more.
    what: 'the advocate console',
    marker: '/monitor.js',
    paths: ['/monitor', '/advocates', '/monitor.html', '/sessions', '/work', '/work.html'],
  },
  // One live session's facts and its transcript — the page every session row in the app
  // links to, and the reason the console could absorb the sessions view at all.
  { what: 'one session', marker: '/session.js', paths: ['/session', '/session.html'] },
  { what: 'the pull request board', marker: '/prs.js', paths: ['/prs', '/pulls', '/prs.html'] },
  // The endorsement queue. Three, because the screen has two honest names — the place
  // you *endorse* and the *queue* of what is waiting — and which one comes to mind
  // depends on whether you arrived from the inbox's 🗳️ or went looking for it.
  {
    what: 'the endorsement queue',
    marker: '/endorse.js',
    paths: ['/endorse', '/queue', '/endorsements', '/endorse.html'],
  },
  { what: 'the chat session', marker: '/console.js', paths: ['/console', '/console.html'] },
  { what: 'the in-app terminal', marker: '/term.js', paths: ['/terminal', '/term.html'] },
  { what: 'the admin screen', marker: '/admin.js', paths: ['/admin', '/admin.html'] },
  { what: 'the graph', marker: '/graph.js', paths: ['/graph', '/graph.html'] },
  { what: 'the reader', marker: '/doc.js', paths: ['/doc', '/doc.html'] },
  // The sign-in screen. Its alias lives in the same run of one-line `if`s as all of
  // the above — and this is the one page a browser is *sent* to rather than typing, so
  // a 404 here is a redirect loop with nothing on screen. Reachable with sign-in off
  // too, which is the configuration this test runs in: it is also where the pairing
  // token is explained.
  { what: 'the sign-in screen', marker: '/login.js', paths: ['/login', '/login.html'] },
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

for (const s of servers || []) s.close?.();
app.stop?.();

console.log(failures ? `\n\x1b[31m${failures} of ${ran} failed\x1b[0m\n` : `\n\x1b[32mall ${ran} checks passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
