#!/usr/bin/env node
//
// Does a tab tap draw from memory, and does one event move one row?
//
//   node scripts/warm-check.mjs [--baseline] [--keep]
//
// Two claims, both of which are about time and neither of which any unit test can
// make. `test/warm.mjs` holds the store, the reconciler's decisions and the two
// endpoints agreeing; what it cannot hold is whether the inbox actually paints
// before its own request has left, or whether a repaint really leaves the forty
// cards that did not change alone. Those are facts about a browser.
//
// So: the real public/*.js in a headless Chrome the size of a phone, against a
// fixture served from this process — nothing here talks to a daemon or touches a
// bead. The fixture answers `/api/questions` after a deliberate 900ms, which is
// roughly what a `bd` sweep across seven workspaces costs on the Mac, and counts
// every request. The measurements are then simply true or false:
//
//   1. A cold load waits out the sweep. (The control. Without it the rest proves
//      nothing — a fast second load could just mean a fast fixture.)
//   2. Coming back to the tab draws cards well inside that, from what was kept.
//   3. Nothing on the page asks for the whole list again on a timer: the refresh is
//      a parked `/api/poll`, so an idle inbox costs no sweep at all.
//   4. One bead changing replaces one card. Proved by stamping every card node
//      before the change and reading which stamps survived it — a rebuilt list
//      loses all of them, and a stamp is something the app knows nothing about, so
//      it cannot agree with a bug in the thing it is checking.
//
// `--baseline` serves the committed public/app.js and public/warm.js instead of the
// working copies, which is how you check that a failure here is a real one: baseline
// must fail 2, 3 and 4 and pass 1.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'warm-check-token';
const BASELINE = process.argv.includes('--baseline');
// What a `bd human list` sweep across seven workspaces costs, near enough. The whole
// check is a comparison against this number, so it is named once.
const SWEEP_MS = 900;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const BEAD = (n) => ({
  id: `wm-${n}`,
  title: `A question waiting (${n})`,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: `Short brief ${n}.`,
});

const ISSUES = [1, 2, 3, 4, 5].map(BEAD);
let questions = ISSUES.map((i) => ({ ...toQuestion('demo', i), comments: [] }));
const KEY = questions[2].key; // the one that will change

let seq = 5;
/** Whoever is parked on /api/poll, waiting for the sequence to move. */
const parked = new Set();
function bump() {
  seq += 1;
  for (const fn of [...parked]) fn();
  parked.clear();
}

const counts = { questions: 0, poll: 0, pollSweeps: 0 };

/** The screen both endpoints answer with — the same shape lib/server.js sends. */
const screen = () => ({
  questions,
  requests: [],
  workspaces: ['demo'],
  spaces: [],
  filter: { space: 'all', workspace: 'all' },
  dismissAsk: null,
  summary: { sessions: 0, proposals: 0, questions: questions.length },
  seq,
});

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

// The committed files, for --baseline. Read through git rather than from a second
// checkout so the comparison is against HEAD of this very worktree.
const committed = (f) =>
  // stderr ignored: on the branch that introduces warm.js there is no HEAD copy of it,
  // and git saying so on every request is noise over the run it is the whole point of.
  execFileSync('git', ['show', `HEAD:${f}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/questions') {
      counts.questions += 1;
      await sleep(SWEEP_MS); // the sweep this whole change exists to stop paying for
      return json({ ...screen(), scope: 'human' });
    }

    if (p === '/api/poll') {
      counts.poll += 1;
      const since = Number(url.searchParams.get('since') || 0);
      const wait = Math.min(Number(url.searchParams.get('wait') || 25), 30) * 1000;
      if (since >= seq && wait > 0) {
        // Park, exactly as lib/events.js does: resolve when something moves, or time
        // out with nulls — which is the case that must cost nothing.
        await new Promise((resolve) => {
          const done = () => {
            clearTimeout(timer);
            parked.delete(done);
            resolve();
          };
          const timer = setTimeout(done, wait);
          parked.add(done);
          res.on('close', done);
        });
      }
      if (res.writableEnded || req.destroyed) return;
      if (since >= seq) return json({ seq, resync: false, events: [], questions: null, requests: null, spaces: null });
      counts.pollSweeps += 1;
      await sleep(SWEEP_MS);
      return json({ seq, resync: false, events: [{ type: 'commented', seq }], ...screen() });
    }

    // The one route this fixture owns rather than the app: it is how the check makes
    // something happen on the daemon's side of the wire.
    if (p === '/fixture/change') {
      questions = questions.map((q) => (q.key === KEY ? { ...q, title: 'This one changed' } : q));
      bump();
      return json({ ok: true, seq });
    }

    // Everything else the app pokes at on boot — agents, work, prs, consoles. An
    // empty body is a valid answer to all of them and keeps the fixture to the point.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/warm.js')) {
      let body;
      try {
        body = committed(`public${p}`);
      } catch {
        // warm.js does not exist at HEAD on the branch that introduces it, and that
        // is exactly the baseline: a page with no warm layer at all.
        res.writeHead(404).end('no');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(body);
    }

    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* ------------------------------------------------------------------ chrome */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = msg.id != null && pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result);
    };
    ws.onerror = () => reject(new Error('could not attach to Chrome'));
    ws.onopen = () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const i = ++id;
            pending.set(i, { resolve: res, reject: rej });
            ws.send(JSON.stringify({ id: i, method, params }));
          }),
        close: () => ws.close(),
      });
  });
}

async function launch() {
  const port = 9600 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-warm-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Without these the renderer runs at about a frame a second while offscreen,
      // and every measurement below measures the throttling instead of the page.
      '--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--hide-scrollbars',
      'about:blank',
    ],
    { stdio: 'ignore' }
  );
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(250);
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page');
    } catch {
      /* not up yet */
    }
  }
  if (!target) throw new Error('Chrome never exposed a page target');
  const s = await connect(target.webSocketDebuggerUrl);
  return {
    s,
    close: () => {
      s.close();
      proc.kill();
      try {
        fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        /* Chrome is still letting go of a temp dir */
      }
    },
  };
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  }
  return r.result.value;
};

/** How long until the list is on screen, from the moment the navigation started. */
async function timeToCards(s, url) {
  const started = Date.now();
  await s.send('Page.navigate', { url });
  for (let i = 0; i < 200; i++) {
    if (await evalJs(s, `document.querySelectorAll('.card[data-key]').length >= 5`)) return Date.now() - started;
    await sleep(20);
  }
  return null;
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });

  console.log(
    `\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · sweep ${SWEEP_MS}ms · ${BASE}\n`
  );

  /* 1. cold — the control */
  const cold = await timeToCards(s, `${BASE}/?t=${TOKEN}`);
  check(
    'a cold load waits out the sweep, which is what the rest is measured against',
    cold !== null && cold >= SWEEP_MS,
    `${cold}ms`
  );

  // Let the boot settle: the poll has to be parked and the payload kept before a tab
  // switch can mean anything.
  await sleep(600);
  const kept = await evalJs(s, `Object.keys(sessionStorage).filter((k) => k.startsWith('beadcause.warm:'))`);
  check('and it keeps what it drew, for the next document', (kept || []).length > 0, JSON.stringify(kept));

  /* 2. away and back — the tab tap */
  await s.send('Page.navigate', { url: `${BASE}/prs?t=${TOKEN}` });
  await sleep(800);
  const askedBefore = counts.questions;
  const warm = await timeToCards(s, `${BASE}/?t=${TOKEN}`);
  check(
    'coming back draws the list from memory, well inside one sweep',
    warm !== null && warm < SWEEP_MS,
    `${warm}ms against ${cold}ms cold`
  );
  check(
    'and it drew before any answer could have arrived — the cards are not a fast fetch',
    warm !== null && warm < SWEEP_MS && counts.questions === askedBefore,
    `${counts.questions - askedBefore} sweeps asked for during the paint`
  );

  /* 3. idle — the refresh is a parked poll, not a sweep on a clock
     The wait is 27 seconds and it has to be: the timer this replaces fired every 25,
     so any shorter window passes with the old code still in place and proves nothing.
     This is the slowest thing in the file and it is the check the change is for. */
  await sleep(600);
  const sweepsAtRest = counts.questions;
  const pollsAtRest = counts.poll;
  await sleep(27000);
  check(
    'the inbox follows the event log — 27 idle seconds cost no sweep at all',
    counts.questions === sweepsAtRest,
    `${counts.questions - sweepsAtRest} sweeps in 27s idle, where the old timer would have made one`
  );
  check(
    'and it is parked on /api/poll rather than merely silent',
    pollsAtRest > 0 && counts.poll > pollsAtRest,
    `${counts.poll} polls`
  );

  /* 4. one bead moves — one card is rebuilt */
  const stamped = await evalJs(
    s,
    `(() => {
      let n = 0;
      for (const c of document.querySelectorAll('.card[data-key]')) c.dataset.stamp = 'mark' + n++;
      return n;
    })()`
  );
  await fetch(`${BASE}/fixture/change`);
  // The parked poll returns, then answers with a sweep of its own.
  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (await evalJs(s, `!!document.querySelector('.card[data-key] h2, .card[data-key] .title')`)) break;
  }
  await sleep(1500);
  const survived = await evalJs(
    s,
    `(() => {
      const out = { total: 0, stamped: 0, changedStillStamped: null };
      for (const c of document.querySelectorAll('.card[data-key]')) {
        out.total += 1;
        if (c.dataset.stamp) out.stamped += 1;
        if (c.dataset.key === ${JSON.stringify(KEY)}) out.changedStillStamped = Boolean(c.dataset.stamp);
      }
      return out;
    })()`
  );
  const changedText = await evalJs(
    s,
    `(() => {
      const c = document.querySelector('.card[data-key=' + JSON.stringify(${JSON.stringify(KEY)}) + ']');
      return c ? c.textContent.includes('This one changed') : false;
    })()`
  );
  check('the change arrives at all', changedText === true, changedText ? '' : 'the card never took the new title');
  check(
    'the card that changed is rebuilt',
    survived.changedStillStamped === false,
    `stamp ${survived.changedStillStamped === false ? 'gone' : 'still there'}`
  );
  check(
    'and every card that did not change is left exactly as it was',
    survived.total === stamped && survived.stamped === stamped - 1,
    `${survived.stamped}/${survived.total} original nodes kept, of ${stamped}`
  );
} finally {
  close();
  server.close();
  for (const fn of parked) fn();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
