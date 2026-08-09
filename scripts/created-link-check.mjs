#!/usr/bin/env node
//
// Does the link you tap right after filing a bead land on the bead?
//
//   node scripts/created-link-check.mjs [--baseline] [--keep]
//
// The "✓ Created N beads" note is the one place in beadcause where you have just
// made something and immediately want to read it. It used to link to
// /graph?ws=…&id=…, where `id` only sets the graph's *scope* — so the tap landed on
// a force layout mid-animation and reading what you filed took two more taps: find
// the node, tap it, tap Details. Only the id pill was tappable; the title beside it
// was a much larger piece of text that did nothing.
//
// This drives the real public/console.js and public/graph.js in a headless Chrome
// the size of a phone, against fixtures served from this process, so nothing here
// touches a real bead or needs the daemon. `--baseline` serves the committed copies
// of the three files instead of the working ones, which is how you check a failure
// here is a real one: baseline must fail the link and target cases and pass the two
// that describe what already worked.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'created-link-check-token';
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
// A title long enough to wrap on a phone, because the whole complaint is that the
// big wrapping thing next to the pill was the part that looked tappable.
const MADE = [
  { ref: 'a', id: 'cd-aaa', title: 'A bead you just filed, whose title is long enough to wrap on a phone' },
  { ref: 'b', id: 'cd-bbb', title: 'The second one' },
];
const SEED = { id: 'cd-see', title: 'The bead this conversation started from' };
// Only in the sheet — never in the graph, never in the console — so finding it on
// screen can only mean the sheet fetched and drew this bead.
const MARK = 'ONLY-IN-THE-SHEET';

const CONSOLE = {
  id: 'cx-1',
  agent: 'console',
  workspace: WS,
  title: 'Two beads, filed',
  seed: SEED,
  status: 'idle',
  seq: 4,
  closedAt: null,
  draft: null,
  messages: [
    { role: 'user', text: 'File those two.', at: '2026-08-01T10:00:00Z' },
    { role: 'system', kind: 'created', created: MADE, warnings: [], at: '2026-08-01T10:01:00Z' },
  ],
};

const NODES = [
  { id: 'cd-aaa', title: MADE[0].title, status: 'open', priority: 2, layer: 0 },
  { id: 'cd-bbb', title: MADE[1].title, status: 'open', priority: 2, layer: 1 },
];
const GRAPH = { nodes: NODES, links: [{ source: 'cd-aaa', target: 'cd-bbb' }], empty: false };

const BEAD = (id) => ({
  id,
  title: MADE.find((m) => m.id === id)?.title || SEED.title,
  status: 'open',
  priority: 2,
  issue_type: 'task',
  owner: 'beadcause@example.com',
  dependent_count: 0,
  dependency_count: 0,
  description: `${MARK} — the text that was in the sheet all along.`,
  comments: [],
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

// The committed copies, for --baseline. Read through git rather than from a second
// checkout so the comparison is against HEAD of this very worktree.
const BASE_FILES = ['/console.js', '/graph.js', '/style.css'];
const committed = (p) => execFileSync('git', ['show', `HEAD:public${p}`], { cwd: ROOT });

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/console') return json(CONSOLE);
    if (p === '/api/graph') return json(GRAPH);
    if (p === '/api/bead') return json(BEAD(url.searchParams.get('id') || ''));
    // The console's long poll. Answered late and with the same console, so nothing
    // repaints under the measurements below; the run is over long before it fires.
    if (p === '/api/console/poll') return setTimeout(() => json(CONSOLE), 30000).unref?.();
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && BASE_FILES.includes(p)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] });
      return res.end(committed(p));
    }
    // The daemon serves these two as pages, not as files on disk.
    const PAGES = { '/': 'index.html', '/console': 'console.html', '/graph': 'graph.html' };
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-created-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
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
    if (await evalJs(s, expr)) return true;
  }
  return false;
};

/* -------------------------------------------------------------------- probe */

// What a finger would hit. Measured with elementFromPoint rather than by trusting
// the markup, so "the whole row is the target" is checked the way it is used: aim
// at the middle of the *title*, and see whether the link is what answers.
const HIT = (titleSel) => `(() => {
  const t = document.querySelector(${JSON.stringify(titleSel)});
  if (!t) return { err: 'no title element' };
  const r = t.getBoundingClientRect();
  const at = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
  const link = at && at.closest('a[href]');
  return { href: link ? link.getAttribute('href') : null, rowHeight: link ? Math.round(link.getBoundingClientRect().height) : 0 };
})()`;

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
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  /* ---- the console: the note you get the moment the beads exist ---- */

  await s.send('Page.navigate', { url: `${BASE}/console?id=${CONSOLE.id}&t=${TOKEN}` });
  if (!(await waitFor(s, `!!document.querySelector('.created-note')`)))
    throw new Error('the created note never rendered');

  const hit = await evalJs(s, HIT('.created-note .created-title'));
  const wantId = MADE[0].id;
  check(
    'the title is part of the link, not text beside it',
    Boolean(hit.href) && hit.href.includes(`id=${wantId}`),
    hit.href ? `title hits ${hit.href}` : `title hits nothing (${hit.err || 'no link under it'})`
  );
  check('the row is a 40px target', hit.rowHeight >= 40, `${hit.rowHeight}px`);
  check(
    'the link opens the bead, not just the graph it lives in',
    Boolean(hit.href) && /(^|[?&])open=1(&|$)/.test(hit.href),
    hit.href || 'no link'
  );

  const seedHit = await evalJs(s, HIT('.seed-note .seed-title, .seed-note'));
  check(
    'the line saying where this started is one target too',
    Boolean(seedHit.href) && seedHit.href.includes(`id=${SEED.id}`) && /open=1/.test(seedHit.href),
    seedHit.href || 'no link under the seed title'
  );

  /* ---- following it: the sheet, with no taps in between ---- */

  const href = hit.href || `/graph?ws=${WS}&id=${wantId}&open=1`;
  await s.send('Page.navigate', { url: BASE + href });
  const opened = await waitFor(
    s,
    `(() => { const el = document.getElementById('sheet-body'); return el && el.textContent.includes(${JSON.stringify(MARK)}); })()`
  );
  const sheetId = await evalJs(s, `(document.getElementById('sheet-id') || {}).textContent || ''`);
  check(
    "the link lands on the bead's own text, with nothing tapped",
    opened && sheetId === wantId,
    opened ? `sheet shows ${sheetId}` : 'the sheet never showed the description'
  );

  /* ---- and dismissing it leaves the graph, as it did before ---- */

  await evalJs(s, `document.getElementById('sheet-close').click()`);
  await sleep(300);
  const after = await evalJs(
    s,
    `({ sheet: document.getElementById('sheet').hidden,
        title: document.getElementById('graph-title').textContent,
        nodes: document.querySelectorAll('#canvas g.gn').length })`
  );
  check(
    'dismissing it leaves you on the graph, scoped to that bead',
    after.sheet && after.title === wantId && after.nodes > 0,
    `${after.nodes} node(s), titled ${after.title}`
  );

  /* ---- a link that means "show me the neighbourhood" still does ---- */

  await s.send('Page.navigate', { url: `${BASE}/graph?ws=${WS}&id=${wantId}` });
  await waitFor(s, `document.querySelectorAll('#canvas g.gn').length > 0`);
  await sleep(400);
  const plain = await evalJs(s, `document.getElementById('sheet').hidden`);
  check('a graph link without open=1 still opens on the graph', plain === true, plain ? '' : 'the sheet opened uninvited');
} finally {
  close();
  server.closeAllConnections?.();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (KEEP) console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
