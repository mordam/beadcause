#!/usr/bin/env node
//
// Does a graph or a document open *over* the tab you were on, and give it back?
//
//   node scripts/drawer-check.mjs [--baseline] [--keep]
//
// /graph and /doc used to be full-page navigations linked from all four views, so
// looking at a bead's graph cost you your place in the list and the way back was an
// ✕ to the inbox. public/drawer.js makes them a panel over the current tab. The
// things that can quietly break, and so are checked here:
//
//   - the tab is never navigated, and an open brief is exactly where it was when
//     the drawer closes — the whole point of the change;
//   - the drawer spends exactly ONE history entry, so back lands on the tab and not
//     on the last document you'd opened inside it. In-drawer navigation goes
//     through location.replace() for that reason, and nothing about it is visible
//     from the outside, which is what makes it worth a test;
//   - the drawer shows exactly ONE header and ONE ✕ — the panel's, carrying the name
//     the page inside handed up — and that ✕ closes the drawer rather than calling
//     window.close() on a tab it does not own or navigating the app to the inbox;
//   - the page's own chrome comes back when it really is a page, because that is the
//     fallback a pasted URL lands on and out there the top bar is all there is;
//   - the graph is still the graph in there: the scope toggle works at drawer width
//     and renames the header with it, and the detail sheet opens inside the panel
//     rather than across the window;
//   - full width on a phone, inset on a wide screen, backdrop dismisses;
//   - a pasted /graph URL still loads the standalone page, with no drawer in it.
//
// `/session?pid=…` is the drawer's third page and gets the same treatment, plus the
// two things only it can get wrong: a session row on the advocate console and the advocate
// console's own rows must reach the *same* address — that is the whole of what the
// bead asked for, and it is the kind of thing that is right in one list and forgotten
// in the other two — and a pid whose process has gone has to say it finished rather
// than showing an empty transcript.
//
// Real public/*.js in a headless Chrome at phone size, against fixtures served from
// this process, so nothing here touches a real bead or needs the daemon.
// `--baseline` serves the committed copies of the changed files instead of the
// working ones, which is how you check a failure here is a real one.
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
const PHONE = { width: 393, height: 852, dpr: 3 };
const WIDE = { width: 1200, height: 900, dpr: 1 };
const TOKEN = 'drawer-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
// Geometry is asserted below; what it *looks* like is not something a number can
// say, so `--out=DIR` drops the two shots worth eyeballing.
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
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
const DIR = '/tmp/beadcause-drawer-check';
const SPEC = `${DIR}/SPEC.md`;
const SIBLING = `${DIR}/sibling.md`;
// Each marker lives in exactly one document, so finding it on screen can only mean
// the drawer is showing that one.
const IN_SPEC = 'ONLY-IN-THE-SPEC';
const IN_SIBLING = 'ONLY-IN-THE-SIBLING';

const DOCS = {
  [SPEC]: [
    '# The spec you were told to read',
    '',
    `${IN_SPEC} — the first document.`,
    '',
    '[The sibling document](sibling.md)',
  ].join('\n'),
  [SIBLING]: ['# The sibling', '', `${IN_SIBLING} — the one a link inside the first leads to.`].join('\n'),
};

// Long enough that the brief scrolls on a phone: "closing it restores the tab with
// its scroll position intact" says nothing at all if there is nowhere to scroll to.
const paras = (n) =>
  Array.from({ length: n }, (_, i) => `Body paragraph ${i + 1}. ` + 'Text that has to wrap on a phone. '.repeat(4)).join(
    '\n\n'
  );

const BEAD = {
  id: 'dr-one',
  title: 'A question with a spec to read and a graph behind it',
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  // The "What this is blocking" link only renders when something is: see briefHtml.
  dependent_count: 2,
  description: [
    'The context above the block.',
    '',
    '```decision',
    'question: Gross or net?',
    'options:',
    '  - id: gross',
    '    label: Gross',
    '    response: "Gross."',
    '  - id: net',
    '    label: Net',
    '    response: "Net."',
    'docs:',
    '  - label: The spec you need to read first',
    `    path: ${SPEC}`,
    '```',
    '',
    paras(30),
  ].join('\n'),
};

const QUESTIONS = [{ ...toQuestion(WS, BEAD), comments: [] }];
const KEY = QUESTIONS[0].key;

/* One live session, listed in three places at once: as a `sessions` row on the advocate
   console, as the advocate's own worker row for the bead it is on, and as a row in the
   mirror. Every one of them has to reach `/session?pid=4242`. */
const PID = 4242;
const SESSION_NAME = 'Demo - dr-one the session detail';
const IN_TRANSCRIPT = 'ONLY-IN-THE-TRANSCRIPT';

const SESSION = {
  pid: PID,
  sessionId: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
  name: SESSION_NAME,
  cwd: '/Users/someone/dev/demo/.claude/worktrees/a-thing-4e7',
  where: 'a-thing-4e7',
  workspace: WS,
  status: 'busy',
  kind: 'claude',
  at: '2026-08-01T10:59:00Z',
  startedAt: '2026-08-01T09:30:00Z',
};

const ADVOCATE = {
  workspace: WS,
  limit: 3,
  queue: 1,
  paused: false,
  quiet: false,
  surveying: false,
  /* The window it opened is on `dr-two`, deliberately not on `dr-one`. On the advocate
     console a claimed bead is only drawn under "Other work in this repo" when the
     advocate did *not* open it — the ones it did are its worker rows — so a fixture whose
     only claimed bead is also its only worker gives the console no graph row at all, and
     the graph half of this file has nothing to tap. One of each is the honest shape:
     dr-two is the advocate's, dr-one is yours. */
  workers: [{ id: 'dr-two', title: 'The bead waiting on it', at: '2026-08-01T10:00:00Z', attempt: 1, claimed: true, pid: PID }],
  next: [],
  note: '',
};

const WORK = {
  observing: false,
  advocates: [ADVOCATE],
  elsewhere: [],
  workspaces: [
    {
      name: WS,
      counts: { open: 3, ready: 1, blocked: 0, inProgress: 1 },
      sessions: [SESSION],
      working: [{ id: 'dr-one', title: BEAD.title, actor: 'someone', since: '2026-08-01T10:00:00Z' }],
    },
  ],
};

const GRAPH = {
  nodes: [
    { id: 'dr-one', title: BEAD.title, status: 'open', priority: 1, layer: 0 },
    { id: 'dr-two', title: 'The bead waiting on it', status: 'open', priority: 2, layer: 1 },
  ],
  links: [{ source: 'dr-one', target: 'dr-two' }],
  empty: false,
};

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

// The committed copies, for --baseline. Read through git rather than from a second
// checkout so the comparison is against HEAD of this very worktree. A file that does
// not exist at HEAD is not served at all — which for a new one is exactly the
// baseline: the behaviour it brings has to fail without it.
const BASE_FILES = [
  '/index.html',
  '/doc.html',
  '/graph.html',
  '/monitor.html',
  '/monitor.js',
  '/mirror.js',
  '/session.html',
  '/session.js',
  '/style.css',
  '/drawer.js',
];
const committed = (p) => {
  try {
    return execFileSync('git', ['show', `HEAD:public${p}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** Answered once per page load, then parked — see the `/api/poll` branch below. */
let polled = false;
const NOW = new Date().toISOString();

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({ questions: QUESTIONS, workspaces: [WS], spaces: [], scope: 'human' });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' });
    }
    if (p === '/api/work') return json(WORK);
    if (p === '/api/graph') return json(GRAPH);
    // The record and the tail of its transcript, in one response — and a 404 for a pid
    // that is not running, which is what the "it finished" case reads.
    if (p === '/api/session-log') {
      if (Number(url.searchParams.get('pid')) !== PID) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: `no session running as pid ${url.searchParams.get('pid')}` }));
      }
      return json({ ...SESSION, file: '/tmp/whatever.jsonl', lines: [`❯ ${IN_TRANSCRIPT}`, '● said something back'] });
    }
    // What the graph's detail sheet fetches when you ask a node for its text.
    if (p === '/api/bead') return json({ ...BEAD, comments: [] });
    if (p === '/api/asset') {
      const body = DOCS[url.searchParams.get('p') || ''];
      if (body == null) {
        res.writeHead(404, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'not found' }));
      }
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(body);
    }
    // The mirror's parked long-poll. It answers once with a phone sitting on the
    // sessions view — which is what makes the mirror's own session rows render at all —
    // and then holds every request after it, exactly as the real endpoint does. Holding
    // matters: `feed()` restarts the moment it returns, so an endpoint that answered
    // instantly would be a tight loop on the fixture server for as long as the run.
    //
    // Once per *document*, not once per run: the console is served from two paths here
    // (`/work` and `/advocates`, since it absorbed the sessions view) and mirror.js runs
    // on both. A single answer for the whole run would be spent by whichever loaded
    // first, and the mirror on the second would sit forever on "no device has said where
    // it is" — which is a failing assertion about this fixture, not about the mirror.
    if (p === '/api/poll') {
      if (polled) return; // parked until the next page load
      polled = true;
      return json({
        seq: 1,
        events: [],
        presence: [{ device: 'phone-1', label: 'iPhone', view: 'sessions', at: NOW, since: NOW, hidden: false }],
      });
    }
    // Everything else the pages poke at on boot. An empty body answers all of it.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && BASE_FILES.includes(p)) {
      const body = committed(p);
      if (body == null) return res.writeHead(404).end('not at HEAD');
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'text/plain' });
      return res.end(body);
    }
    // The daemon serves these as pages, not as files on disk. `/work` and `/sessions`
    // are the advocate console now — the sessions view they used to serve was merged
    // into it, and the paths were kept because the phone's home screen holds them.
    const PAGES = {
      '/': 'index.html',
      '/work': 'monitor.html',
      '/sessions': 'monitor.html',
      '/graph': 'graph.html',
      '/doc': 'doc.html',
      '/session': 'session.html',
      '/advocates': 'monitor.html',
    };
    const file = path.join(PUBLIC, PAGES[p] || p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    // A fresh document means a fresh mirror, so give it a presence answer to start from.
    if (path.extname(file) === '.html') polled = false;
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
  const port = 9700 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-drawer-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Offscreen renderers are throttled to about a frame a second, which turns
      // every transition measured below into a measurement of the throttling.
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

// Going back should close a drawer and touch nothing else — but on --baseline the
// tab really did navigate, so back is a page load and the eval in flight dies with
// a protocol error instead of a result. Swallowed: what is being checked is what
// the page says once it settles.
const back = async (s) => {
  try {
    await evalJs(s, `history.back()`);
  } catch {
    /* the target navigated under us */
  }
  await sleep(600);
};

const shot = async (s, name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  // Clipped to what the page actually laid out in. The emulated device is narrower
  // than the layout viewport a `width=device-width` page settles on, and an
  // unclipped capture quietly crops the right edge off — the ✕, as it happens,
  // which looks exactly like a bug that isn't there.
  const box = await evalJs(s, `({ w: innerWidth, h: innerHeight })`);
  const { data } = await s.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: box.w, height: box.h, scale: 1 },
  });
  const file = path.join(OUT, `${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

const viewport = (s, vp, mobile) =>
  s.send('Emulation.setDeviceMetricsOverride', {
    width: vp.width,
    height: vp.height,
    deviceScaleFactor: vp.dpr,
    mobile,
    screenWidth: vp.width,
    screenHeight: vp.height,
  });

/* -------------------------------------------------------------------- probe */

// Everything the outside can see about the drawer, in one round trip. `frame` is
// read from the iframe's own location rather than from the src attribute, so an
// in-drawer navigation (which never touches src) is visible here.
const STATE = `(() => {
  const wrap = document.querySelector('.drawer-wrap');
  const panel = wrap && wrap.querySelector('.drawer');
  const frame = wrap && wrap.querySelector('.drawer-frame');
  let inner = null;
  try { inner = frame && frame.contentWindow.location.pathname + frame.contentWindow.location.search; } catch (e) {}
  return {
    exists: !!wrap,
    open: !!wrap && !wrap.hidden && wrap.classList.contains('open'),
    width: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
    right: panel ? Math.round(innerWidth - panel.getBoundingClientRect().right) : 0,
    frame: inner,
    frameBox: frame ? Math.round(frame.getBoundingClientRect().width) : 0,
    // The panel's own header: what it says the drawer is showing, and how many ways
    // out of it there are.
    head: (() => { const h = panel && panel.querySelector('.drawer-title'); return h ? h.textContent.trim() : null; })(),
    headKind: (() => { const h = panel && panel.querySelector('.drawer-title'); return h ? h.dataset.kind || '' : null; })(),
    closes: panel ? panel.querySelectorAll('[data-role="close"]').length : 0,
    // And the chrome the page inside is *still* showing. A second header under the
    // panel's, or a ✕ that means something other than "close the drawer", is the
    // thing this whole case exists to catch — so it is counted by what is on screen
    // rather than by what is in the markup.
    inner: (() => {
      try {
        if (!frame) return null;
        const d = frame.contentDocument;
        const seen = (sel) => [...d.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).length;
        return {
          bars: seen('.topbar'),
          closes: seen('#doc-close, #graph-close, #session-close'),
          scope: seen('.scope-btn'),
        };
      } catch (e) {
        return null;
      }
    })(),
    // What the page in there thinks it has to lay out in. A drawer whose contents
    // are laid out against the *window* is one whose ✕ is off the right edge.
    frameView: (() => { try { return frame ? frame.contentWindow.innerWidth : 0; } catch (e) { return -1; } })(),
    text: (() => { try { return frame ? frame.contentDocument.body.innerText.slice(0, 4000) : ''; } catch (e) { return ''; } })(),
    path: location.pathname,
    viewport: innerWidth,
  };
})()`;

// Where the reader is. An open card is `position: fixed; overflow-y: auto`, so on
// the inbox the number that moves is the card's, not the window's — take both and
// let the assertion compare the pair.
const PLACE = `(() => {
  const card = document.querySelector('.card.open');
  return { doc: Math.round((document.scrollingElement || document.documentElement).scrollTop),
           card: card ? Math.round(card.scrollTop) : -1 };
})()`;

// Tolerant of a missing element, because --baseline navigates the tab away and then
// half these selectors are on a page that is no longer here. A run that reports ✗
// per case says far more than one that dies on a null.
const clickSel = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.click();
  return true;
})()`;

// A link the page never had, clicked the way a real one would be: the drawer only
// ever opens from a tap on an anchor, and `&open=1` is a shape of link the fixtures
// do not otherwise carry.
const openViaLink = (href) => `(() => {
  const a = document.createElement('a');
  a.href = ${JSON.stringify(href)};
  document.body.appendChild(a);
  a.click();
  a.remove();
  return true;
})()`;

// The graph's own detail sheet, measured inside the drawer. It is `position: fixed`
// in there, so it is laid out against the panel rather than against the window — the
// way it can go wrong is by being the window's width and hanging off the panel.
const SHEET = `(() => {
  const f = document.querySelector('.drawer-frame');
  try {
    const d = f.contentDocument;
    const el = d.getElementById('sheet');
    if (!el || el.hidden) return { up: false, text: '' };
    const r = el.getBoundingClientRect();
    return {
      up: r.width > 0 && r.height > 0,
      width: Math.round(r.width),
      left: Math.round(r.left),
      frame: Math.round(f.contentWindow.innerWidth),
      text: (d.getElementById('sheet-body').innerText || '').slice(0, 200),
    };
  } catch (e) {
    return { up: false, text: '' };
  }
})()`;

const clickInDrawer = (sel) => `(() => {
  const f = document.querySelector('.drawer-frame');
  const el = f && f.contentDocument.querySelector(${JSON.stringify(sel)});
  if (!el) return false;
  el.click();
  return true;
})()`;

/**
 * Unfold the two advocate-card sections that hold the rows this file taps.
 *
 * "Working now" and "Other work in this repo" are shut by default and remember their
 * state in localStorage, so they are opened by hand rather than assumed — and only if
 * they are shut, because a second click would close the one a previous run left open.
 * Needed on every path that serves the console, which since the sessions view was
 * merged into it means `/work` as well as `/advocates`.
 */
const openSections = async (s) => {
  for (const key of [`${WS}:work`, `${WS}:else`]) {
    await evalJs(s, clickSel(`[data-toggle="${key}"][aria-expanded="false"]`));
    await sleep(250);
  }
};

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await viewport(s, PHONE, true);
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${PHONE.width}x${PHONE.height} · ${BASE}\n`);

  /* ---- the inbox: a document, opened from a brief you are halfway down ---- */

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  if (!(await waitFor(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(KEY)}] [data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('.docs a[href^="/doc?"]')`)))
    throw new Error('the brief never rendered its doc link');

  // Read a way down, the way you would before being sent off to the spec.
  await evalJs(
    s,
    `(() => {
      for (const p of document.querySelectorAll('.md p')) {
        if (p.textContent.startsWith('Body paragraph 18.')) return p.scrollIntoView({ block: 'start' });
      }
    })()`
  );
  await sleep(300);
  const before = await evalJs(s, PLACE);

  await evalJs(s, clickSel('.docs a[href^="/doc?"]'));
  await sleep(400);
  const opened = await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_SPEC)})`, 40);
  const withDoc = await evalJs(s, STATE);
  check(
    'a doc link opens over the inbox instead of navigating away from it',
    opened && withDoc.open && withDoc.path === '/',
    withDoc.exists ? `at ${withDoc.path}, showing ${withDoc.frame}` : 'no drawer — the tab navigated'
  );
  check(
    'full width on a phone',
    // Both halves: the panel fills the screen, and the page inside is laid out
    // against the panel rather than against the window it is sitting in.
    withDoc.open && withDoc.width === withDoc.viewport && withDoc.frameView === withDoc.frameBox,
    `${withDoc.width}px of ${withDoc.viewport}px · frame ${withDoc.frameBox}px, laid out at ${withDoc.frameView}px`
  );
  check(
    "the panel's header wears the document's name, and the page in there has put its own away",
    withDoc.open && withDoc.head === 'SPEC.md' && withDoc.headKind === 'doc' && !!withDoc.inner && withDoc.inner.bars === 0,
    `header says ${JSON.stringify(withDoc.head)} (${withDoc.headKind}) · ${
      withDoc.inner ? withDoc.inner.bars : '?'
    } page header(s) still showing inside`
  );
  check(
    "exactly one ✕, and it is the panel's",
    withDoc.closes === 1 && !!withDoc.inner && withDoc.inner.closes === 0,
    `${withDoc.closes} in the panel, ${withDoc.inner ? withDoc.inner.closes : '?'} in the page`
  );

  // A document's name is a filename and can be long. The header it moved into has one
  // row and a ✕ at the end of it, so a name that wrapped, or that pushed the ✕ off the
  // panel, would be a worse header than the top bar it replaced.
  const squeezed = await evalJs(
    s,
    `(() => {
      const h = document.querySelector('.drawer-title');
      const x = document.querySelector('.drawer [data-role="close"]');
      // Tolerant of a header that is not there, the way every other probe here is:
      // on --baseline there is no panel header at all, and a run that reports ✗ per
      // case says far more than one that dies on a null.
      if (!h || !x) return { grew: -1, fits: false, clipped: false };
      const was = h.textContent;
      const one = Math.round(h.getBoundingClientRect().height);
      h.textContent = 'a-very-long-document-name-that-nobody-would-ever-actually-choose.md';
      const head = h.closest('.drawer-head').getBoundingClientRect();
      const out = {
        grew: Math.round(h.getBoundingClientRect().height) - one,
        fits: Math.round(x.getBoundingClientRect().right) <= Math.round(head.right),
        clipped: h.scrollWidth > h.clientWidth,
      };
      h.textContent = was;
      return out;
    })()`
  );
  check(
    'a long name is clipped to the one row rather than wrapping or shoving the ✕ off the panel',
    squeezed.grew === 0 && squeezed.fits && squeezed.clipped,
    `row grew ${squeezed.grew}px, ✕ ${squeezed.fits ? 'inside' : 'off the edge'}, ${
      squeezed.clipped ? 'clipped' : 'not clipped'
    }`
  );

  await shot(s, 'phone-doc-drawer');

  const during = await evalJs(s, PLACE);
  check(
    'the brief underneath is not moved by opening one',
    // The drawer state is part of it: a tab that navigated away has no brief to
    // have moved, and would otherwise pass this by having nothing to measure.
    withDoc.open && during.card === before.card && during.doc === before.doc,
    `card ${before.card}→${during.card}px`
  );

  /* ---- the ✕ on the panel closes the drawer, not the tab ---- */

  const clicked = await evalJs(s, clickSel('.drawer [data-role="close"]'));
  await sleep(500);
  const afterX = await evalJs(s, STATE);
  const place = await evalJs(s, PLACE);
  check(
    "the panel's ✕ closes the drawer and leaves you on the tab",
    clicked && !afterX.open && afterX.path === '/',
    clicked ? `at ${afterX.path}, drawer ${afterX.open ? 'still open' : 'closed'}` : 'no ✕ on the panel to click'
  );
  check(
    'and the brief is exactly where you left it',
    afterX.exists && place.card === before.card && place.doc === before.doc,
    `card ${before.card}px → ${place.card}px`
  );

  // The page's own ✕ is hidden in there, so nothing but this reaches it — which is
  // the point of checking it. It used to mean `location.href = '/'`, and a stylesheet
  // that has not landed yet would leave that button live over the tab you were on.
  await evalJs(s, clickSel('.docs a[href^="/doc?"]'));
  await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_SPEC)})`, 40);
  const hidden = await evalJs(s, clickInDrawer('#doc-close'));
  await sleep(500);
  const afterHidden = await evalJs(s, STATE);
  check(
    "and the page's own ✕, if anything ever reaches it, closes the drawer rather than the app",
    hidden && !afterHidden.open && afterHidden.path === '/',
    hidden ? `at ${afterHidden.path}, drawer ${afterHidden.open ? 'still open' : 'closed'}` : 'the page had no ✕ left'
  );

  /* ---- a link inside a document retargets the drawer, and back still exits ---- */

  await evalJs(s, clickSel('.docs a[href^="/doc?"]'));
  await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_SPEC)})`, 40);
  const followed = await evalJs(s, clickInDrawer('#doc a[href^="/doc?"]'));
  await sleep(400);
  const moved = await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_SIBLING)})`, 40);
  const inner = await evalJs(s, STATE);
  check(
    'a link inside a document retargets the drawer rather than escaping it',
    followed && moved && inner.open && inner.path === '/',
    followed ? `showing ${inner.frame}` : 'the document had no onward link'
  );

  await back(s);
  const backOut = await evalJs(s, STATE);
  const backPlace = await evalJs(s, PLACE);
  check(
    'one back closes the drawer — not one per document read inside it',
    !backOut.open && backOut.path === '/',
    `at ${backOut.path}, drawer ${backOut.open ? 'still open' : 'closed'}`
  );
  check(
    'and back lands on the brief, not on a blank inbox',
    backPlace.card === before.card,
    `card ${before.card}px → ${backPlace.card}px`
  );

  /* ---- the advocates tab: the same module, a different view, a graph ---- */

  // Reached by `/work` on purpose: it is one of the three paths the sessions view left
  // behind, and they all serve this page now. So this half of the file exercises the
  // alias while the `/advocates` half exercises the canonical name.
  await s.send('Page.navigate', { url: `${BASE}/work` });
  if (!(await waitFor(s, `!!document.querySelector('.mon-card')`))) throw new Error('the advocate console never rendered');
  await openSections(s);
  if (!(await waitFor(s, `!!document.querySelector('.work-row[href^="/graph?"]')`)))
    throw new Error('the advocate console never rendered a graph row');

  await evalJs(s, clickSel('.work-row[href^="/graph?"]'));
  await sleep(400);
  const graphUp = await waitFor(s, `(${STATE}).frame && (${STATE}).frame.startsWith('/graph')`, 40);
  const withGraph = await evalJs(s, STATE);
  check(
    'a graph row opens over the advocate console too',
    graphUp && withGraph.open && withGraph.path === '/work',
    withGraph.exists ? `at ${withGraph.path}, showing ${withGraph.frame}` : 'no drawer — the tab navigated'
  );
  const drew = await waitFor(
    s,
    `(() => { const f = document.querySelector('.drawer-frame');
              try { return f.contentDocument.querySelectorAll('#canvas g.gn').length > 0; } catch (e) { return false; } })()`,
    40
  );
  check('the graph really draws in there', drew, drew ? '' : 'no nodes in the drawer');

  const graphChrome = await evalJs(s, STATE);
  check(
    'and it hands its name up too, without leaving a header behind',
    graphChrome.head === 'dr-one' && graphChrome.headKind === 'graph' && !!graphChrome.inner && graphChrome.inner.bars === 0,
    `header says ${JSON.stringify(graphChrome.head)} (${graphChrome.headKind}) · ${
      graphChrome.inner ? graphChrome.inner.bars : '?'
    } page header(s) still showing inside`
  );

  // The scope toggle is not chrome — it is the graph — so it stays, and it renames
  // the drawer as it goes. A header that read the title once would still say the
  // bead's id over a picture of the whole workspace.
  const toggled = await evalJs(s, clickInDrawer('.scope-btn[data-scope="all"]'));
  const renamed = await waitFor(s, `(${STATE}).head === ${JSON.stringify(WS)}`, 40);
  const scoped = await evalJs(s, STATE);
  check(
    'the scope toggle still works at drawer width, and the header follows it',
    toggled && renamed && scoped.inner && scoped.inner.scope === 2,
    toggled ? `header says ${JSON.stringify(scoped.head)} · ${scoped.inner ? scoped.inner.scope : '?'} scope buttons` : 'no scope toggle in there'
  );

  await back(s);
  const backTab = await evalJs(s, STATE);
  check(
    'back closes it and leaves you on the advocates tab',
    backTab.exists && !backTab.open && backTab.path === '/work',
    `at ${backTab.path}, drawer ${backTab.open ? 'still open' : 'closed'}`
  );

  /* ---- a session row: the drawer's third page, and one address for it ---- */

  const SESSION_HREF = `/session?pid=${PID}`;
  const hrefs = (sel) => `[...document.querySelectorAll(${JSON.stringify(sel)})].map((a) => a.getAttribute('href'))`;

  const onWork = await evalJs(s, hrefs('.session-row'));
  check(
    'a session row is a link to its own detail, not an inert div',
    onWork.length === 1 && onWork[0] === SESSION_HREF,
    JSON.stringify(onWork)
  );

  await evalJs(s, clickSel(`.work-row[href="${SESSION_HREF}"]`));
  await sleep(400);
  const sessionUp = await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_TRANSCRIPT)})`, 60);
  const withSession = await evalJs(s, STATE);
  check(
    "a session's detail opens over the list, showing what it is actually saying",
    sessionUp && withSession.open && withSession.path === '/work' && withSession.frame?.startsWith('/session'),
    withSession.exists ? `at ${withSession.path}, showing ${withSession.frame}` : 'no drawer — the tab navigated'
  );
  check(
    "the panel's header wears the session's own name, and one ✕ is the panel's",
    withSession.head === SESSION_NAME &&
      withSession.headKind === 'session' &&
      withSession.closes === 1 &&
      !!withSession.inner &&
      withSession.inner.bars === 0 &&
      withSession.inner.closes === 0,
    `header says ${JSON.stringify(withSession.head)} (${withSession.headKind}) · ${
      withSession.inner ? withSession.inner.bars : '?'
    } page header(s), ${withSession.inner ? withSession.inner.closes : '?'} page ✕ inside`
  );
  // The facts pane is the other half of the detail, and it is the half that had nowhere
  // to come from until /api/session-log started returning the whole record.
  check(
    'and the facts about the process, which no other endpoint could have told it',
    withSession.text.includes(SESSION.cwd) && withSession.text.includes(WS) && withSession.text.includes(String(PID)),
    withSession.text ? `${withSession.text.slice(0, 90).replace(/\n/g, ' ⏎ ')}…` : 'nothing in the panel'
  );
  await shot(s, 'phone-session-drawer');

  await back(s);
  const backFromSession = await evalJs(s, STATE);
  check(
    'back dismisses it and leaves you on the list you tapped from',
    backFromSession.exists && !backFromSession.open && backFromSession.path === '/work',
    `at ${backFromSession.path}, drawer ${backFromSession.open ? 'still open' : 'closed'}`
  );

  /* ---- the advocate console: the same rows, the same address ---- */

  await s.send('Page.navigate', { url: `${BASE}/advocates` });
  if (!(await waitFor(s, `!!document.querySelector('.mon-card')`))) throw new Error('the advocate console never rendered');
  await openSections(s);
  const onAdvocates = await evalJs(s, hrefs('#mon .work-row.adv-worker, #mon .work-row.session-row'));
  check(
    "the advocate's worker row and its session row both reach the same detail",
    onAdvocates.length === 2 && onAdvocates.every((h) => h === SESSION_HREF),
    JSON.stringify(onAdvocates)
  );

  await evalJs(s, clickSel(`#mon .work-row.adv-worker[href="${SESSION_HREF}"]`));
  await sleep(400);
  const overConsole = await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_TRANSCRIPT)})`, 60);
  const withConsole = await evalJs(s, STATE);
  check(
    'and it opens over the console rather than navigating away from it',
    overConsole && withConsole.open && withConsole.path === '/advocates',
    withConsole.exists ? `at ${withConsole.path}, showing ${withConsole.frame}` : 'no drawer — the tab navigated'
  );
  await back(s);

  /* ---- and the mirror, which is the third list ---- */

  await evalJs(s, clickSel('#mon-tabs [data-tab="mirror"]'));
  const mirrored = await waitFor(s, `document.querySelectorAll('#mirror .session-row').length > 0`, 60);
  const onMirror = await evalJs(s, hrefs('#mirror .session-row'));
  check(
    'the mirror sends its session rows to the same place too',
    mirrored && onMirror.length === 1 && onMirror[0] === SESSION_HREF,
    mirrored ? JSON.stringify(onMirror) : 'the mirror never listed a session'
  );

  await evalJs(s, clickSel(`#mirror .session-row[href="${SESSION_HREF}"]`));
  await sleep(400);
  const overMirror = await waitFor(s, `(${STATE}).text.includes(${JSON.stringify(IN_TRANSCRIPT)})`, 60);
  const withMirror = await evalJs(s, STATE);
  check(
    'over the mirror as well',
    overMirror && withMirror.open && withMirror.path === '/advocates',
    withMirror.exists ? `at ${withMirror.path}, showing ${withMirror.frame}` : 'no drawer — the tab navigated'
  );
  await back(s);

  /* ---- a session that has exited says so, rather than showing an empty pane ---- */

  await evalJs(s, openViaLink('/session?pid=999999'));
  const said = await waitFor(s, `(${STATE}).text.toLowerCase().includes('finished')`, 60);
  const dead = await evalJs(s, STATE);
  check(
    'a pid whose process has gone says it finished rather than showing nothing',
    said && dead.open && !dead.text.includes(IN_TRANSCRIPT),
    dead.text ? `${dead.text.slice(0, 90).replace(/\n/g, ' ⏎ ')}…` : 'nothing in the panel'
  );
  await back(s);
  await s.send('Page.navigate', { url: `${BASE}/work` });
  if (!(await waitFor(s, `!!document.querySelector('.mon-card')`))) throw new Error('the console never came back');
  await openSections(s);
  if (!(await waitFor(s, `!!document.querySelector('.work-row[href^="/graph?"]')`)))
    throw new Error('the console never rendered a graph row again');

  /* ---- the graph's detail sheet, at drawer width ---- */

  await evalJs(s, openViaLink(`/graph?ws=${WS}&id=dr-one&open=1`));
  await waitFor(s, `(${STATE}).open`, 40);
  const sheetUp = await waitFor(s, `(${SHEET}).text.includes('A question with a spec')`, 60);
  const sheet = await evalJs(s, SHEET);
  check(
    "the graph's detail sheet still opens, and inside the panel rather than across the window",
    sheetUp && sheet.up && sheet.left >= 0 && sheet.width <= sheet.frame,
    sheet.up ? `${sheet.width}px at x=${sheet.left}, in a ${sheet.frame}px panel` : 'the sheet never came up'
  );
  await shot(s, 'phone-graph-sheet');

  // Two ✕s are on screen now — the sheet's and the panel's — and they must not be the
  // same button. Dismissing the sheet leaves you on the graph, which is where the
  // standalone page leaves you too.
  await evalJs(s, clickInDrawer('#sheet-close'));
  await sleep(400);
  const afterSheet = await evalJs(s, SHEET);
  const stillUp = await evalJs(s, STATE);
  check(
    'and closing the sheet leaves you on the graph rather than closing the drawer',
    !afterSheet.up && stillUp.open && stillUp.path === '/work',
    `sheet ${afterSheet.up ? 'still up' : 'closed'}, drawer ${stillUp.open ? 'open' : 'closed'} at ${stillUp.path}`
  );
  await back(s);

  /* ---- a wide screen: inset, with a backdrop that dismisses ---- */

  await viewport(s, WIDE, false);
  await sleep(200);
  await evalJs(s, clickSel('.work-row[href^="/graph?"]'));
  await waitFor(s, `(${STATE}).open`, 40);
  await sleep(300);
  const wide = await evalJs(s, STATE);
  check(
    'inset on a wide screen rather than taking the whole window',
    wide.open && wide.width < wide.viewport - 100 && wide.right > 0,
    `${wide.width}px of ${wide.viewport}px, ${wide.right}px clear on the right`
  );
  await shot(s, 'wide-graph-drawer');

  // Aimed at the screen rather than at a selector: what has to be true is that the
  // gap beside the panel is the backdrop and that tapping it dismisses.
  await evalJs(s, `(() => { const el = document.elementFromPoint(40, 400); if (el && el.click) el.click(); return !!el; })()`);
  await sleep(500);
  const dismissed = await evalJs(s, STATE);
  check(
    'the backdrop dismisses it',
    !dismissed.open && dismissed.path === '/work',
    `at ${dismissed.path}, drawer ${dismissed.open ? 'still open' : 'closed'}`
  );

  /* ---- and the page it wraps is still a page ---- */

  await viewport(s, PHONE, true);
  await s.send('Page.navigate', { url: `${BASE}/graph?ws=${WS}&id=dr-one` });
  const pasted = await waitFor(s, `document.querySelectorAll('#canvas g.gn').length > 0`, 40);
  const standalone = await evalJs(s, STATE);
  check(
    'pasting a /graph URL straight in still loads the page itself',
    pasted && !standalone.exists && standalone.path === '/graph',
    pasted ? `at ${standalone.path}${standalone.exists ? ', with a drawer over it' : ''}` : 'the graph never drew'
  );

  // With its own header, because out here there is no panel to have taken it: no
  // title, no way back, and the page is a dead end. The ✕ means the tab, and this is
  // the one place where that is the truth.
  const chrome = await evalJs(
    s,
    `(() => {
      const seen = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).length;
      const h1 = document.querySelector('.topbar h1');
      return { bars: seen('.topbar'), closes: seen('#graph-close'), inDrawer: document.documentElement.classList.contains('in-drawer'),
               title: h1 ? h1.textContent.trim() : null };
    })()`
  );
  check(
    'and it stands on its own out there — its own header, its own ✕, no drawer mode',
    chrome.bars === 1 && chrome.closes === 1 && !chrome.inDrawer && chrome.title === 'dr-one',
    `${chrome.bars} header(s), ${chrome.closes} ✕, saying ${JSON.stringify(chrome.title)}`
  );

  await s.send('Page.navigate', { url: `${BASE}${SESSION_HREF}` });
  const pastedSession = await waitFor(s, `document.body.innerText.includes(${JSON.stringify(IN_TRANSCRIPT)})`, 60);
  const sessionChrome = await evalJs(
    s,
    `(() => {
      const seen = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).length;
      const h1 = document.querySelector('.topbar h1');
      return { drawer: !!document.querySelector('.drawer-wrap'), bars: seen('.topbar'), closes: seen('#session-close'),
               inDrawer: document.documentElement.classList.contains('in-drawer'),
               title: h1 ? h1.textContent.trim() : null };
    })()`
  );
  check(
    'a pasted /session URL loads the page itself, with its own header and its own ✕',
    pastedSession &&
      !sessionChrome.drawer &&
      sessionChrome.bars === 1 &&
      sessionChrome.closes === 1 &&
      !sessionChrome.inDrawer &&
      sessionChrome.title === SESSION_NAME,
    `${sessionChrome.bars} header(s), ${sessionChrome.closes} ✕, saying ${JSON.stringify(sessionChrome.title)}${
      sessionChrome.drawer ? ', with a drawer over it' : ''
    }`
  );

  await s.send('Page.navigate', { url: `${BASE}/doc?p=${encodeURIComponent(SPEC)}` });
  await waitFor(s, `document.body.innerText.includes(${JSON.stringify(IN_SPEC)})`, 40);
  const docChrome = await evalJs(
    s,
    `(() => {
      const seen = (sel) => [...document.querySelectorAll(sel)].filter((el) => el.getClientRects().length > 0).length;
      const h1 = document.querySelector('.topbar h1');
      return { bars: seen('.topbar'), closes: seen('#doc-close'), title: h1 ? h1.textContent.trim() : null };
    })()`
  );
  check(
    'and so does the reader',
    docChrome.bars === 1 && docChrome.closes === 1 && docChrome.title === 'SPEC.md',
    `${docChrome.bars} header(s), ${docChrome.closes} ✕, saying ${JSON.stringify(docChrome.title)}`
  );
} finally {
  close();
  server.closeAllConnections?.();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (KEEP) console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
