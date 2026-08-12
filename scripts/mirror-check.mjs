#!/usr/bin/env node
//
// Does the mirror *stream* a chat session, or re-read it on a timer?
//
//   node scripts/mirror-check.mjs [--baseline] [--keep]
//
// The mirror follows whatever the phone has open. Every view behind it costs a `bd`
// call and is fetched when the phone moves — except a chat session, which changes
// while nothing moves at all, because the agent is mid-sentence. That used to be a
// `setInterval` re-reading `/api/console` every 1.5s: a turn arrived up to a second
// and a half after it was written, and a session nobody was talking to cost forty
// requests a minute for as long as the tab was open (bc-0ia).
//
// `/api/console/poll` already exists for exactly this, and is what the console's own
// page lives on — it parks on the session's sequence and hands back the whole session
// the moment it moves. What is checked here is that the mirror uses it, and the three
// things that are easy to get wrong once it does:
//
//   - it parks, and an idle session costs nothing: one read, one held request, and no
//     second read however long the pane sits there;
//   - a turn arrives *through the park* — the new words are on screen and nothing
//     re-read the session to get them;
//   - the loop is stood down when the phone leaves the session, and a response to that
//     abandoned request neither repaints the pane nor re-parks. A timer never had to
//     think about that; it is what the `gen` guard in mirror.js exists for, because
//     the phone can leave a session and come back while the old poll is still out.
//
// Real public/*.js in a headless Chrome against fixtures served from this process, so
// nothing here touches a real bead or needs the daemon. `--baseline` serves the
// committed copy of mirror.js instead of the working one, which is how you check a
// failure here is a real one — on `--baseline` the parking cases fail, because HEAD's
// mirror never asks `/api/console/poll` anything at all.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const WIDE = { width: 1200, height: 900, dpr: 1 };
const TOKEN = 'mirror-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'purify.js'))) {
  console.error('public/vendor is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const WS = 'demo';
const ID = 'con-mirror';
// One marker per state of the session, so what is on screen can only have come from
// the response that carried it.
const SAID = 'MARKER-WHAT-I-ASKED';
const FIRST = 'MARKER-FIRST-WORDS';
const STREAMED = 'MARKER-STREAMED-LATER';
const WHILE_AWAY = 'MARKER-WHILE-LOOKING-ELSEWHERE';

const CONSOLE = {
  id: ID,
  workspace: WS,
  title: 'A chat session the phone is holding',
  status: 'thinking',
  seq: 5,
  closedAt: null,
  messages: [
    { role: 'user', text: SAID, at: new Date().toISOString() },
    { role: 'assistant', text: '', streaming: FIRST, tools: [], pending: true, at: new Date().toISOString() },
  ],
};

const NOW = new Date().toISOString();
const onConsole = {
  device: 'phone-1',
  label: 'iPhone',
  view: 'console',
  id: ID,
  workspace: WS,
  key: `${WS}/bc-seed`,
  at: NOW,
  since: NOW,
  hidden: false,
};
const onSessions = { ...onConsole, view: 'sessions', id: '', key: '' };
let presence = [onConsole];
let presenceSeq = 1;

// Enough for sessionsHtml to draw something with a phrase of its own in it, so
// "the pane left the thread" is a positive assertion rather than an absence.
const WORK = { workspaces: [{ name: WS, counts: { open: 3, ready: 1, inProgress: 1 }, sessions: [] }] };
const OFF_THREAD = '1 in progress';

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// The committed copy, for --baseline. Read through git rather than from a second
// checkout, so the comparison is against HEAD of this very worktree.
const BASE_FILES = ['/mirror.js'];
const committed = (p) => {
  try {
    return execFileSync('git', ['show', `HEAD:public${p}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

// Every request the mirror makes about this session, counted. `console` is the plain
// read — the one that used to happen every 1.5s — and `poll` is the parked one.
const hits = { console: 0, poll: 0 };
let consoleWaiters = [];
let presenceWaiters = [];

const send = (res, body) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};

/** Answer everyone parked on a feed, with whatever the fixture has become. */
function release(list) {
  for (const answer of list.splice(0)) answer();
}

/** One more streamed delta, exactly as `touch()` does it on the daemon. */
function stream(text) {
  CONSOLE.messages[1].streaming += `\n\n${text}`;
  CONSOLE.seq += 1;
  release(consoleWaiters);
}

/** Move the phone, and wake everyone parked on the bus. */
function moveTo(where) {
  presence = [where];
  presenceSeq += 1;
  release(presenceWaiters);
}

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;

    // The whole session, read once when the view opens. On HEAD this is also the
    // timer's request, which is the difference the counts below read.
    if (p === '/api/console' && req.method === 'GET') {
      hits.console += 1;
      return send(res, CONSOLE);
    }

    // The parked one: hold until the sequence moves past `since`, then hand back the
    // whole session — the real endpoint's shape, and the reason a mirror that slept
    // through half a turn is correct on its first response.
    if (p === '/api/console/poll') {
      hits.poll += 1;
      if (url.searchParams.get('id') !== ID) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'no such chat session' }));
      }
      if (CONSOLE.seq > Number(url.searchParams.get('since') || 0)) return send(res, CONSOLE);
      const answer = () => send(res, CONSOLE);
      consoleWaiters.push(answer);
      res.on('close', () => {
        consoleWaiters = consoleWaiters.filter((x) => x !== answer);
      });
      return;
    }

    // Presence, on the daemon's own shape: parked until the phone moves.
    if (p === '/api/poll') {
      const answer = () => send(res, { seq: presenceSeq, events: [], presence });
      if (presenceSeq > Number(url.searchParams.get('since') || 0)) return answer();
      presenceWaiters.push(answer);
      res.on('close', () => {
        presenceWaiters = presenceWaiters.filter((x) => x !== answer);
      });
      return;
    }

    if (p === '/api/work') return send(res, WORK);
    if (p === '/api/consoles') return send(res, { consoles: [], workspaces: [WS] });
    if (p === '/api/questions') return send(res, { questions: [], workspaces: [WS], spaces: [], scope: 'human' });
    // Everything else the pages poke at on boot. An empty body answers all of it.
    if (p.startsWith('/api/')) return send(res, {});

    if (BASELINE && BASE_FILES.includes(p)) {
      const body = committed(p);
      if (body == null) return res.writeHead(404).end('not at HEAD');
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'text/plain' });
      return res.end(body);
    }

    // The daemon serves these as pages, not as files on disk.
    const PAGES = { '/': 'index.html', '/work': 'monitor.html', '/sessions': 'monitor.html', '/advocates': 'monitor.html' };
    const file = path.join(PUBLIC, PAGES[p] || p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  return r.result.value;
};

const waitFor = async (s, expr, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    await sleep(150);
    try {
      if (await evalJs(s, expr)) return true;
    } catch {
      /* the frame is mid-navigation */
    }
  }
  return false;
};

/** The same, for something only this process can see — a request count. */
const until = async (fn, tries = 40) => {
  for (let i = 0; i < tries; i++) {
    if (fn()) return true;
    await sleep(150);
  }
  return false;
};

const mirrorText = `(document.getElementById('mirror').innerText || '')`;
// Case-folded, because `innerText` is what is *rendered*: the count pills are
// uppercased by style.css, so "1 in progress" reaches this side shouting.
const shows = (marker) => `${mirrorText}.toLowerCase().includes(${JSON.stringify(marker.toLowerCase())})`;

/* --------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-mirror-');

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: WIDE.width,
    height: WIDE.height,
    deviceScaleFactor: WIDE.dpr,
    mobile: false,
    screenWidth: WIDE.width,
    screenHeight: WIDE.height,
  });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${BASE}\n`);

  // Pair the browser, then open the advocate console on its mirror tab. Which tab is
  // showing lives in localStorage, so setting it before loading the page that reads
  // it means the pane is live from the first paint rather than after a click.
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(s, `localStorage.getItem('beadcause.token') === ${JSON.stringify(TOKEN)}`);
  await evalJs(s, `localStorage.setItem('beadcause.mirror.tab', 'mirror')`);
  await s.send('Page.navigate', { url: `${BASE}/advocates` });

  /* ---- it draws the session the phone is holding ---- */

  const drew = await waitFor(s, shows(FIRST), 80);
  check('the mirror draws the chat session the phone has open', drew, drew ? '' : 'the first words never appeared');

  /* ---- and then it parks: an idle session costs nothing ---- */

  // Long enough for the old 1.5s timer to have fired three times, and for a loop that
  // parked wrongly — `wait` dropped, or re-asking on every return — to show itself.
  await sleep(5000);
  check(
    'an idle session is parked on, not re-read',
    hits.console === 1 && hits.poll === 1,
    `${hits.console} read(s) of /api/console and ${hits.poll} of /api/console/poll, five seconds after it opened`
  );

  /* ---- a turn arrives through the park ---- */

  stream(STREAMED);
  const arrived = await waitFor(s, shows(STREAMED), 40);
  check(
    'a streamed turn arrives, and through the parked request',
    arrived && hits.console === 1,
    arrived ? `${hits.console} read(s) of /api/console` : 'the streamed words never appeared'
  );
  check(
    'and the loop parks again on the sequence it was just handed',
    await until(() => hits.poll === 2),
    `${hits.poll} poll(s)`
  );

  /* ---- the phone leaves: the loop stands down ---- */

  moveTo(onSessions);
  const left = await waitFor(s, `${shows(OFF_THREAD)} && !${shows(STREAMED)}`, 60);
  check(
    'the pane follows the phone off the session',
    left,
    left ? '' : `it shows ${JSON.stringify((await evalJs(s, mirrorText)).replace(/\s+/g, ' ').slice(0, 200))}`
  );

  const pollsWhenLeft = hits.poll;
  // The request that was parked when the phone left is still out there. Answering it
  // now is the case the `gen` guard exists for: the response is for a view nobody is
  // on, so it must neither repaint the pane nor start another one.
  stream(WHILE_AWAY);
  await sleep(2000);
  check(
    'an abandoned response neither repaints nor re-parks',
    hits.poll === pollsWhenLeft && !(await evalJs(s, shows(WHILE_AWAY))),
    `${hits.poll} poll(s), was ${pollsWhenLeft}`
  );

  /* ---- and coming back starts a fresh one ---- */

  moveTo(onConsole);
  const back = await waitFor(s, shows(WHILE_AWAY), 60);
  check(
    'coming back to it reads once more, and parks again',
    back && hits.console === 2 && (await until(() => hits.poll > pollsWhenLeft)),
    `${hits.console} read(s), ${hits.poll} poll(s)`
  );
} finally {
  release(consoleWaiters);
  release(presenceWaiters);
  close();
  server.closeAllConnections?.();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (KEEP) console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
