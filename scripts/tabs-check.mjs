#!/usr/bin/env node
//
// Is there a handle per open chat, does it fit on a phone, and does it stay put?
//
//   node scripts/tabs-check.mjs [--baseline] [--out=<dir>]
//
// bc-dmt made the page hold several conversations at once; the only way between two of
// them was still the launcher list. The strip is the short list — All on the left, then
// one handle per chat you opened — and almost everything that can be wrong with it is
// invisible to a unit test:
//
//   * **Does it move?** It is the one strip on screen in both views. If it is drawn
//     inside the launcher it jumps up the page on the first tap, taking the handle out
//     from under the thumb that just pressed it. So the same rectangle is measured on
//     the list and over a conversation, and they have to be the same rectangle.
//   * **Does it fit?** A chat is titled with a sentence. Six of those either wrap the
//     strip into four lines and push the transcript off the bottom of the phone, or
//     they scroll sideways with the selected one somewhere off the end of it.
//   * **Is the spark there at all?** `.spark` is a bare span sized in px, so it needs a
//     flex parent or it lays out as nothing — the exact way the same dot is invisible
//     on the launcher's own rows today (bc-7vzr). A test that reads HTML sees a spark
//     either way; only a browser can say it has a box.
//
// Same shape as switch-check.mjs, which it is the sequel to: the real public/console.js,
// public/console.html and public/style.css in a headless Chrome the size of a phone,
// against a fixture served from this process, so nothing here talks to a daemon or
// touches a bead. `--baseline` serves the committed copies instead, where there is no
// strip at all, so it must fail everything.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'tabs-check-token';
const BASELINE = process.argv.includes('--baseline');
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
const WORKSPACES = ['beadcause', 'sophab'];

// Titles as long as the ones an agent actually writes. The whole layout question here
// is what a strip does with five of these on a 393px screen.
const TITLES = {
  'chat-a': 'The installer never checks that iTerm2 is there',
  'chat-b': 'Every bd sweep call shares one thirty-second timeout',
  'chat-c': 'The launcher list is not a way to move between chats',
  'chat-d': 'A dismissed conversation should say what dismissed it',
  'chat-e': 'Warm payloads age out while the inbox is still open',
};

const chat = (id, workspace, status, beads) => ({
  id,
  agent: 'console',
  workspace,
  title: TITLES[id],
  status,
  error: null,
  seq: 1,
  seed: null,
  created: [],
  closedAt: null,
  draft: beads ? { beads: Array.from({ length: beads }, (_, i) => ({ ref: `r${i}`, title: `Bead ${i}`, type: 'task', priority: 2 })) } : null,
  messages: [{ role: 'user', text: `Only one thing said in ${id}.`, at: at(0) }],
});

const CHATS = {
  'chat-a': chat('chat-a', 'beadcause', 'idle', 0),
  'chat-b': chat('chat-b', 'beadcause', 'idle', 0),
  'chat-c': chat('chat-c', 'beadcause', 'idle', 2),
  'chat-d': chat('chat-d', 'beadcause', 'idle', 0),
  'chat-e': chat('chat-e', 'sophab', 'idle', 0),
};

/** A turn starts in the first chat once it is in the background. */
let aThinking = false;

const listRow = (c) => ({
  id: c.id,
  agent: 'console',
  workspace: c.workspace,
  title: c.title,
  seed: null,
  status: c.id === 'chat-a' && aThinking ? 'thinking' : c.status,
  closedAt: null,
  messageCount: c.messages.length,
  beadCount: c.draft?.beads?.length || 0,
  created: [],
  createdAt: at(0),
  updatedAt: at(9),
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

// Read through git rather than from a second checkout, so --baseline compares against
// HEAD of this very worktree.
const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
const BASELINED = ['/console.js', '/console.html', '/style.css'];

/** Every soft close the page asked for. The ✕ on a handle must ask for none. */
const closed = [];
const parked = new Set();
let filter = { space: 'all', workspace: 'all' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/consoles') return json({ consoles: Object.values(CHATS).map(listRow), workspaces: WORKSPACES });
    if (p === '/api/spaces') return json({ spaces: [], workspaces: WORKSPACES, filter });
    if (p === '/api/filter' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        filter = { space: parsed.space || 'all', workspace: parsed.workspace || 'all' };
        json({ ok: true, filter });
      });
    }
    if (p === '/api/console/close' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        closed.push(JSON.parse(body || '{}').id);
        json({ ok: true });
      });
    }
    if (p === '/api/console' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      return CHATS[id] ? json(CHATS[id]) : json({ error: 'not found' });
    }
    // Never answered: the fixture never changes, and answering would spin the loop for
    // the length of the run.
    if (p === '/api/console/poll') return void parked.add(res);
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/console' ? 'console.html' : p.replace(/^\/+/, '') || 'index.html';
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

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-tabs-');

const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `tabs-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** The one thing a page load destroys and a repaint cannot. See switch-check.mjs. */
const MARK = 'window.__stillHere';
const stamp = (word) => evalJs(s, `${MARK} = ${JSON.stringify(word)}`);
const alive = (word) => evalJs(s, `${MARK} === ${JSON.stringify(word)}`);

const openLauncher = async (query = '') => {
  await s.send('Page.navigate', { url: `${BASE}/console${query}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#recent .console-row, #recent .empty')`)) return;
  }
  throw new Error('the launcher never rendered');
};

/** Every handle on the strip, as the browser has actually laid it out. */
const STRIP = `(() => {
  const row = document.querySelector('#chat-tabs');
  // An empty list rather than nothing, so --baseline — where there is no strip in the
  // page at all — reports a row of failures instead of throwing out of the run.
  if (!row) return { missing: true, tabs: [] };
  const box = row.getBoundingClientRect();
  const tabs = [...row.querySelectorAll('.chat-tab')].map((t) => {
    const face = t.querySelector('[data-tab]');
    const r = t.getBoundingClientRect();
    const spark = t.querySelector('.spark');
    const sr = spark && spark.getBoundingClientRect();
    return {
      id: face ? face.dataset.tab : null,
      text: t.textContent.replace(/\\s+/g, ' ').trim(),
      selected: face ? face.getAttribute('aria-selected') === 'true' : false,
      closable: !!t.querySelector('[data-untab]'),
      spark: sr ? Math.round(sr.width) : 0,
      beads: (t.textContent.match(/🧾(\\d+)/) || [, ''])[1],
      left: Math.round(r.left), right: Math.round(r.right),
      top: Math.round(r.top), width: Math.round(r.width),
    };
  });
  return {
    up: !row.hidden && box.height > 0,
    top: Math.round(box.top), bottom: Math.round(box.bottom), height: Math.round(box.height),
    scrollWidth: Math.round(row.scrollWidth), clientWidth: Math.round(row.clientWidth),
    scrollLeft: Math.round(row.scrollLeft),
    tabs,
  };
})()`;

const tapRow = async (id) => {
  await evalJs(s, `document.querySelector('#recent a.work-row[data-id="${id}"], #recent a.work-row[href*="${id}"]')?.click()`);
  await sleep(500);
};
const tapHandle = async (id) => {
  await evalJs(s, `document.querySelector('#chat-tabs [data-tab="${id}"]')?.click()`);
  await sleep(500);
};
const tapClose = async (id) => {
  await evalJs(s, `document.querySelector('#chat-tabs [data-untab="${id}"]')?.click()`);
  await sleep(500);
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

  /* ---- nothing open, nothing on screen ---- */
  await openLauncher(`?t=${TOKEN}`);
  await evalJs(s, `localStorage.removeItem('beadcause.console.tabs')`);
  await openLauncher();
  const bare = await evalJs(s, STRIP);
  check('the launcher opens with no strip — All alone is a row that says nothing', bare.up === false, JSON.stringify(bare.tabs?.map((t) => t.text) || bare));
  const launcherTop = await evalJs(s, `Math.round(document.querySelector('#launcher').getBoundingClientRect().top)`);

  /* ---- opening one puts a handle up ---- */
  await stamp('on-the-list');
  await tapRow('chat-a');
  const one = await evalJs(s, STRIP);
  check('opening a chat puts a strip up with All and that chat on it', one.up === true && one.tabs.length === 2, JSON.stringify(one.tabs?.map((t) => t.text)));
  check('the chat that was opened is the selected handle', one.tabs?.[1]?.selected === true && one.tabs?.[0]?.selected === false, JSON.stringify(one.tabs?.map((t) => t.selected)));
  check('All carries no ✕ and every other handle does', one.tabs?.[0]?.closable === false && one.tabs?.[1]?.closable === true, JSON.stringify(one.tabs?.map((t) => t.closable)));
  check('and it was a repaint, not a page load', await alive('on-the-list'), 'the document was replaced');
  await shot('one');

  /* ---- and it did not move getting there ---- */
  // The whole reason it is above the launcher rather than inside it: the strip is on
  // screen in both views, so tapping a handle must not shift the handle you tapped.
  await tapHandle('');
  const back = await evalJs(s, STRIP);
  check(
    'the strip is in the same place on the list as over a conversation',
    back.top === one.top && back.height === one.height,
    `list ${back.top}+${back.height}px vs chat ${one.top}+${one.height}px`
  );
  check('tapping All comes back out to the list', await evalJs(s, `!document.querySelector('#launcher').hidden`), 'All did not go back');
  check(
    'and the list starts below the strip rather than under it',
    (await evalJs(s, `Math.round(document.querySelector('#launcher').getBoundingClientRect().top)`)) >= back.bottom,
    `launcher at ${await evalJs(s, `Math.round(document.querySelector('#launcher').getBoundingClientRect().top)`)}, strip ends ${back.bottom} (was ${launcherTop} with no strip)`
  );

  /* ---- five sentences on a 393px phone ---- */
  for (const id of ['chat-b', 'chat-c', 'chat-d', 'chat-e']) {
    await tapHandle('');
    await tapRow(id);
  }
  const many = await evalJs(s, STRIP);
  check('every chat opened has a handle', many.tabs?.length === 6, `${many.tabs?.length} handles`);
  check(
    'the strip is one line, however many are on it',
    new Set(many.tabs.map((t) => t.top)).size === 1,
    `tops ${[...new Set(many.tabs.map((t) => t.top))].join(',')} — a wrapped strip eats the transcript`
  );
  check(
    'it scrolls sideways instead of squeezing them',
    many.scrollWidth > many.clientWidth,
    `${many.scrollWidth}px of handles in ${many.clientWidth}px`
  );
  check(
    'no handle is wider than half the phone',
    many.tabs.every((t) => t.width <= VP.width / 2),
    `widest ${Math.max(...many.tabs.map((t) => t.width))}px of ${VP.width}px`
  );
  check(
    'the handle in front is scrolled into view',
    (() => {
      const on = many.tabs.find((t) => t.selected);
      return on && on.left >= -1 && on.right <= many.clientWidth + 1;
    })(),
    JSON.stringify(many.tabs.find((t) => t.selected))
  );
  check(
    'the strip did not cost the composer its place on screen',
    (await evalJs(s, `Math.round(document.querySelector('#composer').getBoundingClientRect().bottom)`)) <= VP.height,
    `composer ends at ${await evalJs(s, `Math.round(document.querySelector('#composer').getBoundingClientRect().bottom)`)} of ${VP.height}`
  );
  await shot('many');

  /* ---- a running turn behind you, visible on its handle ---- */
  aThinking = true;
  // `watchBackground` asks every fifteen seconds; nudge it rather than wait one out.
  await evalJs(s, `document.dispatchEvent(new Event('visibilitychange'))`);
  await tapHandle('chat-b');
  await tapHandle('chat-c');
  await sleep(1200);
  const busy = await evalJs(s, STRIP);
  const aTab = busy.tabs?.find((t) => t.id === 'chat-a');
  check('a chat mid-turn in the background shows a spark on its handle', (aTab?.spark || 0) > 0, `the dot is ${aTab?.spark}px wide — a bare span with no flex parent is 0`);
  const cTab = busy.tabs?.find((t) => t.id === 'chat-c');
  check('a chat holding a proposal shows how many beads are in it', cTab?.beads === '2', `🧾${cTab?.beads}`);

  /* ---- the ✕ on a handle is not the ✕ on a row ---- */
  await stamp('in-the-strip');
  await tapClose('chat-d');
  const shut = await evalJs(s, STRIP);
  check('the ✕ on a handle takes it off the strip', !shut.tabs?.some((t) => t.id === 'chat-d'), JSON.stringify(shut.tabs?.map((t) => t.id)));
  check('and asks the server to close nothing', closed.length === 0, `POST /api/console/close ${closed.join(',') || '×0'}`);
  check('without leaving the page', await alive('in-the-strip'), 'removing a handle reloaded the document');
  await tapHandle('');
  check(
    'the conversation is still in the list, exactly as it was',
    await evalJs(s, `!!document.querySelector('#recent a.work-row[href*="chat-d"]')`),
    'the row left the list with the handle'
  );

  /* ---- and they are still there tomorrow ---- */
  await s.send('Page.navigate', { url: `${BASE}/console` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#recent .console-row, #recent .empty')`)) break;
  }
  const reloaded = await evalJs(s, STRIP);
  check(
    'a reload comes back with the handles it had, in the order they were opened',
    JSON.stringify(reloaded.tabs?.map((t) => t.id)) === JSON.stringify(['', 'chat-a', 'chat-b', 'chat-c', 'chat-e']),
    JSON.stringify(reloaded.tabs?.map((t) => t.id))
  );
  check('and on All, because that is the address it was reloaded on', reloaded.tabs?.[0]?.selected === true, JSON.stringify(reloaded.tabs?.map((t) => t.selected)));
  await shot('reloaded');
} finally {
  for (const res of parked) res.destroy();
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (BASELINE) {
  // There is no strip at HEAD at all, so fourteen of these fail and the rest pass
  // vacuously — there is nothing on the page for them to be wrong about. That is the
  // honest shape of a baseline for something that did not exist.
  console.log(failed.length ? 'baseline fails, as it must' : 'BASELINE PASSED — this check proves nothing');
  process.exit(failed.length ? 0 : 1);
}
process.exit(failed.length ? 1 : 0);
