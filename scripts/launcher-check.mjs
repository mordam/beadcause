#!/usr/bin/env node
//
// Does the launcher's repo row filter, and does ＋ still start?
//
//   node scripts/launcher-check.mjs [--baseline] [--keep]
//
// The row used to be the start button: tapping a repo opened a new conversation
// in it, and every conversation from every repo sat in one pile underneath. It is
// a tab bar now — All on the left, one tab per repo, the list below filtered to
// the tab — which moves starting onto a ＋ of its own. That swap is exactly the
// kind of change that half-lands: the filter works and ＋ starts in the wrong
// repo, or All has no way to start anything at all.
//
// Same shape as console-check.mjs: the real public/console.{js,html} and
// public/style.css in a headless Chrome the size of a phone, against a fixture
// `/api/consoles` served from this process, so nothing here talks to a daemon or
// touches a bead. `--baseline` serves the committed copies instead of the working
// ones — baseline has no tabs at all, so it must fail.
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
const TOKEN = 'launcher-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/* ---------------------------------------------------------------- fixtures */

const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

// Three repos, and deliberately one of them with nothing in it: a repo you have
// never talked to still needs a tab, because the tab is how you reach it to start.
const WORKSPACES = ['beadcause', 'sophab', 'deluvia'];

const row = (id, workspace, title, extra = {}) => ({
  id,
  agent: 'console',
  workspace,
  title,
  seed: null,
  status: 'idle',
  closedAt: null,
  messageCount: 2,
  beadCount: 0,
  created: [],
  createdAt: at(0),
  updatedAt: at(9),
  ...extra,
});

const CONSOLES = [
  row('bc-1', 'beadcause', 'The launcher is one pile'),
  row('bc-2', 'beadcause', 'A finished one', { closedAt: at(5) }),
  // Started from /foundations, not from here — same record, same workspace, so it
  // lands under beadcause's tab looking exactly like the two above it unless the
  // row says who it is with. The server names the agent; see lib/agents.js.
  row('bc-3', 'beadcause', 'Chat with the critic', { agent: 'critic', agentName: 'Critic', agentEmoji: '🧨' }),
  row('sp-1', 'sophab', 'Hero openings'),
  row('sp-2', 'sophab', 'Pricing tiers'),
];

const COUNTS = { all: 5, beadcause: 3, sophab: 2, deluvia: 0 };

// One thread to land in, so a ＋ that navigates arrives somewhere real.
const THREAD = {
  id: 'started',
  workspace: 'sophab',
  title: 'Just started',
  status: 'idle',
  error: null,
  seq: 1,
  seed: null,
  created: [],
  closedAt: null,
  draft: null,
  messages: [{ role: 'user', text: 'Hello.', at: at(0) }],
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

// Read through git rather than from a second checkout, so --baseline compares
// against HEAD of this very worktree.
const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
const BASELINED = ['/console.js', '/console.html', '/style.css'];
// Every launcher control below is reached with `?.`, because under --baseline half
// of them do not exist yet and a baseline run has to *report* that as failures
// rather than die on the first missing button.

const parked = new Set();
/** Every POST /api/console the page made, in order — what ＋ actually asked for. */
const started = [];
/** The server-owned space filter, which is where the selected repo now lives. */
let filter = { space: 'all', workspace: 'all' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/consoles') return json({ consoles: CONSOLES, workspaces: WORKSPACES });
    /* The repo tabs are a face of the space picker now (public/spacebar.js), so which
       repo the launcher is on is a value on the server rather than in localStorage —
       which is exactly what makes it survive a reload here. Two endpoints, and the
       fixture has to hold the value between them or the tab would come back as All. */
    if (p === '/api/spaces') {
      return json({ spaces: [], workspaces: WORKSPACES, counts: {}, filter, waiting: 0 });
    }
    if (p === '/api/filter' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        filter = { space: parsed.space || 'all', workspace: parsed.workspace || 'all' };
        json({ ok: true, filter, dismissAsk: null });
      });
    }
    if (p === '/api/console' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        started.push(JSON.parse(body || '{}'));
        json({ id: THREAD.id });
      });
    }
    if (p === '/api/console') return json(url.searchParams.get('id') === THREAD.id ? THREAD : { error: 'not found' });
    // The long poll never returns: the fixture never changes, and answering it
    // would spin the page's poll loop for the length of the run.
    if (p === '/api/console/poll') return void parked.add(res);
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/console' ? 'console.html' : p.replace(/^\/+/, '') || 'index.html';
    // Against `/console`, not `/console.html`: the page is reached by the route,
    // and a baseline that quietly served the working copy's HTML would be a
    // baseline that passes half the run.
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
    const file = path.join(PUBLIC, rel);
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
      const q = msg.id != null && pending.get(msg.id);
      if (!q) return;
      pending.delete(msg.id);
      msg.error ? q.reject(new Error(msg.error.message)) : q.resolve(msg.result);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-launcher-'));
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
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// The tab bar as the screen has it: which repo, what it says, which one is on.
const TABS = `[...document.querySelectorAll('#ws-row [data-ws]')].map((b) => ({
  ws: b.dataset.ws,
  text: b.textContent.trim(),
  on: b.getAttribute('aria-selected') === 'true',
  stop: b.tabIndex === 0,
}))`;

// Which repo each visible conversation belongs to. The first pill on a row is its
// workspace; an agent chat and a closed row each carry another one after it.
const ROWS = `[...document.querySelectorAll('#recent .console-row')].map(
  (r) => r.querySelector('.pill').textContent.trim()
)`;

// What each row says about who it is with: the mark in the phase slot, and the
// agent pill if it has one.
const MARKS = `[...document.querySelectorAll('#recent .console-row')].map((r) => ({
  id: (r.querySelector('[data-close]')?.dataset.close) || '',
  title: r.querySelector('.work-title').textContent.trim(),
  phase: r.querySelector('.work-phase').textContent.trim(),
  agentPill: r.querySelector('.pill.agent')?.textContent.trim() || null,
}))`;

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

// `--out=<dir>` writes what the assertions are describing. This is a layout
// change on a phone, and a row of passing assertions says nothing about whether
// the tabs and the ＋ fit beside each other at 393px.
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `launcher-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** Land on the launcher and wait for it to have drawn its tabs. */
const openLauncher = async (query = '') => {
  await s.send('Page.navigate', { url: `${BASE}/console${query}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#recent .console-row, #recent .empty')`)) return;
  }
  throw new Error('the launcher never rendered');
};

const tapTab = async (ws) => {
  await evalJs(s, `document.querySelector('#ws-row [data-ws="${ws}"]')?.click()`);
  await sleep(250);
};

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

  /* ---- a tab per repo, plus All ---- */
  await openLauncher(`?t=${TOKEN}`);
  const tabs = await evalJs(s, TABS);
  check(
    'All leads the row, then one tab per repo',
    tabs.map((t) => t.ws).join(',') === `all,${WORKSPACES.join(',')}`,
    tabs.map((t) => t.ws).join(',') || 'no tabs at all'
  );
  check('All is what an unvisited launcher opens on', tabs[0]?.on === true, JSON.stringify(tabs[0]));
  check(
    'each tab carries how many conversations it holds',
    tabs[0]?.text === `All ${COUNTS.all}` &&
      tabs[1]?.text === `beadcause ${COUNTS.beadcause}` &&
      tabs[2]?.text === `sophab ${COUNTS.sophab}`,
    tabs.map((t) => t.text).join(' | ')
  );
  check(
    'a repo with nothing in it still gets a tab, and reports no count',
    tabs[3]?.ws === 'deluvia' && tabs[3]?.text === 'deluvia',
    JSON.stringify(tabs[3])
  );
  check(
    'only the selected tab is in the tab order',
    tabs.filter((t) => t.stop).length === 1 && tabs.find((t) => t.stop)?.ws === 'all',
    tabs.filter((t) => t.stop).map((t) => t.ws).join(',')
  );
  check('All shows every conversation', (await evalJs(s, ROWS)).length === COUNTS.all, `${(await evalJs(s, ROWS)).length}`);
  await shot('all');

  /* ---- an agent chat is not a chat session ---- */
  const marks = await evalJs(s, MARKS);
  const agentRow = marks.find((m) => m.title === 'Chat with the critic');
  const plainRows = marks.filter((m) => m.title !== 'Chat with the critic');
  check(
    'a chat started from /foundations says which agent it is with',
    agentRow?.agentPill === '🧨 Critic',
    JSON.stringify(agentRow)
  );
  check(
    "and draws that agent's emoji where a chat session draws 💬",
    agentRow?.phase === '🧨',
    `${agentRow?.phase} vs ${plainRows.map((m) => m.phase).join(',')}`
  );
  check(
    'a chat session carries no agent pill — it is what the mark is read against',
    plainRows.every((m) => m.agentPill === null),
    JSON.stringify(plainRows.filter((m) => m.agentPill))
  );

  /* ---- selecting one filters the list to it ---- */
  await tapTab('sophab');
  await shot('repo');
  const only = await evalJs(s, ROWS);
  check(
    'selecting a repo shows only that repo',
    only.length === COUNTS.sophab && only.every((w) => w === 'sophab'),
    only.join(',') || 'nothing'
  );
  const after = await evalJs(s, TABS);
  check(
    'and the tab bar says which one',
    after.filter((t) => t.on).length === 1 && after.find((t) => t.on)?.ws === 'sophab',
    after.filter((t) => t.on).map((t) => t.ws).join(',')
  );

  /* ---- the row and the dropdown above it are one control ---- */
  const pick = async (value) => {
    await evalJs(
      s,
      `(() => {
        const el = document.querySelector('#space-pick');
        if (!el) return false;
        el.value = ${JSON.stringify(value)};
        el.dispatchEvent(new Event('change'));
        return true;
      })()`
    );
    await sleep(400);
  };
  await pick('ws:beadcause');
  const viaBar = await evalJs(s, ROWS);
  const barTab = await evalJs(s, TABS);
  check(
    'the space picker in the top bar filters the same list',
    viaBar.length === COUNTS.beadcause && viaBar.every((w) => w === 'beadcause'),
    viaBar.join(',') || 'nothing'
  );
  check(
    'and the row follows it, rather than disagreeing with it',
    barTab.find((t) => t.on)?.ws === 'beadcause',
    JSON.stringify(barTab.find((t) => t.on))
  );
  // Back where the rest of the run expects to be.
  await pick('ws:sophab');

  /* ---- the selection survives a reload ---- */
  await openLauncher();
  const back = await evalJs(s, TABS);
  const backRows = await evalJs(s, ROWS);
  check(
    'the tab you left on is the tab you come back to',
    back.find((t) => t.on)?.ws === 'sophab' && backRows.length === COUNTS.sophab,
    `${back.find((t) => t.on)?.ws} · ${backRows.length} rows`
  );

  /* ---- ＋ starts one in the selected repo ---- */
  started.length = 0;
  await evalJs(s, `document.querySelector('#ws-new')?.click()`);
  await sleep(1200);
  check(
    '＋ starts a conversation in the selected repo',
    started.length === 1 && started[0]?.workspace === 'sophab',
    JSON.stringify(started)
  );
  const landed = await evalJs(
    s,
    `({ thread: !document.querySelector('#thread').hidden, launcher: !document.querySelector('#launcher') || document.querySelector('#launcher').hidden, url: location.search })`
  );
  check('and lands you in the thread it made', landed.thread && landed.launcher, JSON.stringify(landed));

  /* ---- on All there is no repo, so ＋ asks ---- */
  await openLauncher();
  await tapTab('all');
  started.length = 0;
  await evalJs(s, `document.querySelector('#ws-new')?.click()`);
  await sleep(300);
  const picker = await evalJs(
    s,
    `({
      open: document.querySelector('#ws-pick') ? !document.querySelector('#ws-pick').hidden : false,
      expanded: document.querySelector('#ws-new')?.getAttribute('aria-expanded') ?? null,
      repos: [...document.querySelectorAll('#ws-pick-row [data-ws]')].map((b) => b.dataset.ws),
    })`
  );
  check(
    '＋ on All asks which repo rather than going dead',
    picker.open && picker.repos.join(',') === WORKSPACES.join(','),
    JSON.stringify(picker)
  );
  check('and says it is open', picker.expanded === 'true', String(picker.expanded));
  check('nothing was started by the asking', started.length === 0, JSON.stringify(started));
  await shot('picker');

  await evalJs(s, `document.querySelector('#ws-pick-row [data-ws="deluvia"]')?.click()`);
  await sleep(1200);
  check(
    'picking one from there starts it in that repo',
    started.length === 1 && started[0]?.workspace === 'deluvia',
    JSON.stringify(started)
  );

  /* ---- an empty repo says so, and says how to fix it ---- */
  await openLauncher();
  await tapTab('deluvia');
  const empty = await evalJs(
    s,
    `({
      rows: document.querySelectorAll('#recent .console-row').length,
      label: document.querySelector('#recent-label')?.hidden,
      note: (document.querySelector('#recent .empty')?.textContent || '').replace(/\\s+/g, ' ').trim(),
    })`
  );
  check(
    'a repo with no conversations says so and names ＋',
    empty.rows === 0 && empty.label === true && /deluvia/.test(empty.note) && /＋/.test(empty.note),
    JSON.stringify(empty)
  );

  /* ---- the retired per-device key is not read any anymore ----

     `beadcause.console.repo` was this page's own memory of which repo you were in, and
     the space picker replaced it with a value on the server. The key is deliberately
     *not* migrated: a tab tapped on one device last week is exactly what the selection
     stopped being, and reading it at startup would narrow the whole app — the
     notifications included — on the strength of it. So writing it must change nothing.
     A repo that has *left the config* is the server's problem now, and reconcileFilter
     is where it is solved — see test/spacebar.mjs. */
  await evalJs(s, `localStorage.setItem('beadcause.console.repo', 'a-repo-that-was-removed')`);
  await openLauncher();
  const recovered = await evalJs(s, TABS);
  check(
    'the retired per-device repo key is ignored — the picker owns the selection',
    recovered.find((t) => t.on)?.ws === 'deluvia',
    JSON.stringify(recovered.find((t) => t.on))
  );
  await tapTab('all');
  const widened = await evalJs(s, ROWS);
  check('and All is still the way back out to every repo', widened.length === COUNTS.all, String(widened.length));

  /* ---- opening one by id is untouched ---- */
  await s.send('Page.navigate', { url: `${BASE}/console?id=${THREAD.id}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#thread .msg')`)) break;
  }
  const byId = await evalJs(
    s,
    `({
      thread: !!document.querySelector('#thread .msg'),
      launcher: document.querySelector('#launcher').hidden,
      composer: !document.querySelector('#composer').hidden,
    })`
  );
  check(
    'opening a conversation by id still bypasses the launcher entirely',
    byId.thread && byId.launcher && byId.composer,
    JSON.stringify(byId)
  );
} finally {
  if (!KEEP) close();
  for (const res of parked) res.destroy();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
