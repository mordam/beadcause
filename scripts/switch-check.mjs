#!/usr/bin/env node
//
// Are several chats really open at once, and is switching between them a repaint?
//
//   node scripts/switch-check.mjs [--baseline] [--out=<dir>]
//
// The page used to be about exactly one conversation: `?id=` named it, and opening
// another was a full navigation that threw away the transcript, the scroll position
// and anything half-typed in the composer. It holds a map now, one entry per chat, and
// the tap on a row is answered from memory.
//
// That is the kind of change nothing else can see. A unit test cannot tell a repaint
// from a page load, and both of them end with the right transcript on screen — the
// difference is only whether the second visit cost a request, whether the words you
// left in the box are still there, and whether the browser stayed on the same document
// the whole time. So: a marker set on `window` before the first tap, and every
// assertion below asks whether it is still there.
//
// Same shape as launcher-check.mjs and console-check.mjs: the real public/console.js,
// public/sendqueue.js and public/console.html in a headless Chrome the size of a phone,
// against a fixture served from this process, so nothing here talks to a daemon or
// touches a bead. `--baseline` serves the committed copies instead — baseline navigates
// for every switch, so it must fail everything but the reload.
//
// One thing here is deliberately routed the long way round. Every switch writes the
// address, so the back gesture walks back through them — but the list is still the only
// surface you can switch *from*, so the history a phone actually builds is chat, list,
// chat, and going back from the second chat is going back to the list. Two chats
// stacked on each other is a tap on a handle, and the handles are the next bead. What
// this asserts is the half that exists: each switch is its own history entry, and the
// conversation you return to was never unloaded.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'switch-check-token';
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

// A is long on purpose: a scroll position that is only ever "the bottom" proves
// nothing about whether it was restored.
const longMessages = () =>
  Array.from({ length: 40 }, (_, i) =>
    i % 2
      ? { role: 'assistant', text: `Answer number ${i}, with enough words on it to take up a line or two of a phone screen.`, at: at(i) }
      : { role: 'user', text: `Question number ${i}`, at: at(i) }
  );

const CHATS = {
  'chat-a': {
    id: 'chat-a',
    workspace: 'beadcause',
    title: 'The long one',
    status: 'idle',
    error: null,
    seq: 1,
    seed: null,
    created: [],
    closedAt: null,
    draft: null,
    messages: longMessages(),
  },
  'chat-b': {
    id: 'chat-b',
    workspace: 'sophab',
    title: 'The other one',
    status: 'idle',
    error: null,
    seq: 1,
    seed: null,
    created: [],
    closedAt: null,
    draft: null,
    messages: [{ role: 'user', text: 'Only one thing said here.', at: at(0) }],
  },
};

const listRow = (c, status) => ({
  id: c.id,
  agent: 'console',
  workspace: c.workspace,
  title: c.title,
  seed: null,
  status,
  closedAt: null,
  messageCount: c.messages.length,
  beadCount: 0,
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

// Read through git rather than from a second checkout, so --baseline compares
// against HEAD of this very worktree.
const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
const BASELINED = ['/console.js', '/console.html', '/sendqueue.js', '/style.css'];

/** Every GET of a whole transcript, by id — the request a switch must not make twice. */
const fetched = [];
/** Every long poll, with whether it is still parked. A switch has to cut the old one. */
const polls = [];
/** How many times the page has asked for the list, which is the background status feed. */
let listed = 0;
const parked = new Set();
let filter = { space: 'all', workspace: 'all' };
/** A turn starts in the background chat once the thread is up. */
let aThinking = false;

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/consoles') {
      listed += 1;
      return json({
        consoles: [listRow(CHATS['chat-a'], aThinking ? 'thinking' : 'idle'), listRow(CHATS['chat-b'], 'idle')],
        workspaces: WORKSPACES,
      });
    }
    if (p === '/api/spaces') return json({ spaces: [], workspaces: WORKSPACES, counts: {}, filter, waiting: 0 });
    if (p === '/api/filter' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        filter = { space: parsed.space || 'all', workspace: parsed.workspace || 'all' };
        json({ ok: true, filter, dismissAsk: null });
      });
    }
    if (p === '/api/console' && req.method === 'GET') {
      const id = url.searchParams.get('id');
      fetched.push(id);
      return CHATS[id] ? json(CHATS[id]) : json({ error: 'not found' });
    }
    // Never answered: the fixture never changes, and answering would spin the loop for
    // the length of the run. `close` is how a switch aborting one is seen from here.
    if (p === '/api/console/poll') {
      const entry = { id: url.searchParams.get('id'), open: true };
      polls.push(entry);
      res.on('close', () => (entry.open = false));
      return void parked.add(res);
    }
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
const { s, close } = await launchChrome('beadcause-switch-');

const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `switch-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/**
 * The one thing a page load destroys and a repaint cannot.
 *
 * A different word each time it is stamped, because the back-forward cache hands a
 * navigated-away-from document back with everything on it: a single value would come
 * back with the launcher and report a navigation as a switch.
 */
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

/** What is on screen: which view, which chat, and what the address says. */
const WHERE = `({
  view: document.querySelector('#launcher').hidden ? 'thread' : 'launcher',
  title: document.querySelector('#title').textContent.trim(),
  first: document.querySelector('#thread .msg')?.textContent.trim().slice(0, 30) || '',
  said: document.querySelector('#say').value,
  scroll: document.querySelector('#thread').scrollTop,
  url: location.pathname + location.search,
})`;

const tapRow = async (id) => {
  await evalJs(s, `document.querySelector('#recent a.work-row[data-id="${id}"], #recent a.work-row[href*="${id}"]')?.click()`);
  await sleep(600);
};

const openPolls = () => polls.filter((e) => e.open).map((e) => e.id);

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

  /* ---- opening one is a repaint, not a page load ---- */
  await openLauncher(`?t=${TOKEN}`);
  await stamp('on-the-list');
  await tapRow('chat-a');
  const inA = await evalJs(s, WHERE);
  check('tapping a conversation opens it', inA.view === 'thread' && inA.first.startsWith('Question number 0'), JSON.stringify(inA.first));
  check('and the address names it', inA.url === '/console?id=chat-a', inA.url);
  check(
    'without leaving the page it was on',
    await alive('on-the-list'),
    'the document was replaced — that is a navigation, not a switch'
  );
  await shot('first');

  /* ---- what you leave in it is still in it ---- */
  await stamp('in-the-chat');
  // A place in the transcript that is not the bottom, and words that were never sent.
  await evalJs(s, `document.querySelector('#thread').scrollTop = 240`);
  await evalJs(
    s,
    `(() => { const b = document.querySelector('#say'); b.value = 'half a thought'; b.dispatchEvent(new Event('input')); })()`
  );
  const leftA = await evalJs(s, WHERE);

  await evalJs(s, `history.back()`);
  await sleep(500);
  const backOut = await evalJs(s, WHERE);
  check('the back gesture comes out to the list', backOut.view === 'launcher' && backOut.url === '/console', backOut.url);
  check('and that is a repaint too', await alive('in-the-chat'), 'coming back out reloaded the page');
  // Arriving at the list used to be a page load, which cleared the bar for free. A
  // switch has to say so itself, or the list sits under the last chat's title.
  check(
    'the bar stops belonging to the chat that was in front',
    backOut.title === 'Chat session',
    `#title reads ${JSON.stringify(backOut.title)}`
  );

  const fetchedBefore = fetched.length;
  await tapRow('chat-b');
  const inB = await evalJs(s, WHERE);
  check('a second conversation opens over the first', inB.url === '/console?id=chat-b' && inB.first.startsWith('Only one thing'), inB.url);
  check("and starts with its own empty composer", inB.said === '', JSON.stringify(inB.said));
  const listedAfterB = listed;

  await sleep(400);
  check(
    'one transcript poll at a time, and it names the chat in front',
    openPolls().length === 1 && openPolls()[0] === 'chat-b',
    openPolls().join(',') || 'none parked'
  );

  /* ---- and going back to the first costs nothing ---- */
  // Out to the list and in again, because the list is the only way between two chats
  // until there is a strip of handles to tap. What is being asserted is not the route
  // but what survived it: this is the second visit to a conversation that has never
  // been unloaded.
  await evalJs(s, `history.back()`);
  await sleep(400);
  await tapRow('chat-a');
  const againA = await evalJs(s, WHERE);
  check('a conversation opened a second time is the one already loaded', againA.url === '/console?id=chat-a', againA.url);
  check(
    'and is not fetched again',
    fetched.filter((id) => id === 'chat-a').length === 1,
    `GET /api/console?id=chat-a ×${fetched.filter((id) => id === 'chat-a').length}`
  );
  check(
    'nothing was fetched at all beyond the second conversation',
    fetched.length === fetchedBefore + 1,
    fetched.join(',')
  );
  check(
    'the thread is where it was left, not back at the bottom',
    Math.abs(againA.scroll - leftA.scroll) < 4 && againA.scroll > 0,
    `${againA.scroll} vs ${leftA.scroll}`
  );
  check('and the composer still holds what was typed into it', againA.said === 'half a thought', JSON.stringify(againA.said));
  await shot('back');

  /* ---- the background is followed by its status alone ---- */
  aThinking = true;
  check(
    'the chats in the background are asked about, all of them in one request',
    listedAfterB > 1,
    `/api/consoles ×${listedAfterB} — the launcher's own fetch is the first`
  );
  await sleep(400);
  check(
    'a chat in the background gets no transcript poll of its own',
    openPolls().length === 1 && openPolls()[0] === 'chat-a',
    openPolls().join(',') || 'none parked'
  );

  /* ---- and the URL is still the durable name for where you are ---- */
  await s.send('Page.navigate', { url: `${BASE}/console?id=chat-b` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#thread .msg')`)) break;
  }
  const reloaded = await evalJs(s, WHERE);
  check(
    'a reload lands on the conversation the address names',
    reloaded.view === 'thread' && reloaded.first.startsWith('Only one thing'),
    JSON.stringify(reloaded)
  );
} finally {
  for (const res of parked) res.destroy();
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (BASELINE) {
  // Baseline navigates for every switch, so the marker dies on the first tap and every
  // memory assertion goes with it. The reload is the one that must still pass: it is
  // the behaviour this change had to keep, not the behaviour it added.
  console.log(failed.length ? 'baseline fails, as it must' : 'BASELINE PASSED — this check proves nothing');
  process.exit(failed.length ? 0 : 1);
}
process.exit(failed.length ? 1 : 0);
