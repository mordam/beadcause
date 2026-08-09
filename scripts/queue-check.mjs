#!/usr/bin/env node
//
// Can you keep typing while a turn is running?
//
//   node scripts/queue-check.mjs [--baseline] [--keep]
//
// The rule is one sentence: the composer stays live for the whole turn, and a
// message said mid-turn is held in front of you until the turn lands. Every half of
// that is invisible from the outside when it breaks — a disabled textarea on a phone
// is a keyboard that will not come up, and a queued message that never went looks
// exactly like one you forgot to send.
//
// Same shape as console-check.mjs and its siblings: the real public/*.js in a
// headless Chrome the size of a phone, against a fixture console served from this
// process, so nothing here talks to a daemon or touches a bead. Both surfaces are
// driven, because the queue is shared and the two screens draw it themselves.
//
// The fixture server is the other half of the point: it answers a message sent
// mid-turn with the same 409 the daemon does. Nothing on either screen may push
// through that — the client waits for the turn to end and sends after it. If a run
// ever reports a delivery while the fixture is thinking, that is the bug.
//
// `--baseline` serves the committed public/console.js and public/foundations.js
// instead of the working copies: baseline must fail: the composer was disabled there
// and the agent chat was refused outright.
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
const TOKEN = 'queue-check-token';
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

/** A console mid-turn: the agent is working, and it has been for a while. */
const thinking = () => ({
  id: 'chat',
  agent: 'console',
  workspace: 'demo',
  title: 'Mid-turn',
  status: 'thinking',
  error: null,
  seq: 3,
  seed: null,
  created: [],
  closedAt: null,
  draft: null,
  messages: [
    { role: 'user', text: 'Two beads for the importer, please.', at: at(0) },
    { role: 'assistant', text: '', streaming: '', tools: [{ name: 'Read', brief: 'importer.js' }], at: at(1), pending: true },
  ],
});

/** The mutable one every route reads. Reset between the two screens. */
let CONSOLE = thinking();
/** Every message the server actually accepted, in order. */
let delivered = [];
/** Every message it refused, because pushing through a 409 is the failure. */
let refused = 0;

const AGENT = {
  id: 'advocate',
  title: 'The advocate',
  purpose: 'Keeps one repo’s queue ready to work.',
  writes: false,
  protectedFields: ['writes'],
  amended: [],
  amendmentHistory: [],
  activity: [],
  runs: [],
  role: 'You keep a queue ready.',
  tools: null,
  allowedTools: ['Bash(bd:*)'],
  timeoutMs: 900000,
  permissionMode: null,
};

/** The turn lands: what the daemon does at the end of `finish`. */
function land() {
  CONSOLE.status = 'idle';
  const last = CONSOLE.messages[CONSOLE.messages.length - 1];
  if (last?.pending) {
    last.pending = false;
    last.text = 'Two, then.';
  }
  CONSOLE.seq += 1;
  release();
}

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

const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });

/** Long polls parked on the fixture, answered when it changes. */
const parked = new Set();
function release() {
  for (const res of parked) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(CONSOLE));
  }
  parked.clear();
}

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      try {
        resolve(JSON.parse(raw || '{}'));
      } catch {
        resolve({});
      }
    });
  });

function serve() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (p === '/api/console' && req.method === 'GET') return json(CONSOLE);
    if (p === '/api/console/poll') {
      const since = Number(url.searchParams.get('since') || 0);
      if (since < CONSOLE.seq) return json(CONSOLE);
      return void parked.add(res);
    }
    if (p === '/api/console/message' && req.method === 'POST') {
      const body = await readBody(req);
      // The daemon's own rule, unchanged: a console mid-turn refuses a message.
      if (CONSOLE.status === 'thinking') {
        refused += 1;
        return json({ error: 'this console is already working on a turn' }, 409);
      }
      delivered.push(String(body.text || ''));
      CONSOLE.status = 'thinking';
      CONSOLE.messages.push({ role: 'user', text: String(body.text || ''), at: at(9) });
      CONSOLE.seq += 1;
      release();
      return json({ ok: true, seq: CONSOLE.seq });
    }
    if (p === '/api/consoles') {
      return json({
        workspaces: ['demo'],
        consoles: [{ id: 'chat', agent: CONSOLE.agent, workspace: 'demo', title: CONSOLE.title, status: CONSOLE.status, updatedAt: at(2) }],
      });
    }
    if (p === '/api/foundations') return json({ workspace: 'demo', workspaces: ['demo'], agents: [AGENT] });
    if (p === '/api/foundation') return json({ workspace: 'demo', agent: AGENT });
    if (p.startsWith('/api/')) return json({});

    for (const rel of ['public/console.js', 'public/foundations.js']) {
      if (BASELINE && p === `/${path.basename(rel)}`) {
        res.writeHead(200, { 'content-type': TYPES['.js'] });
        return res.end(committed(rel));
      }
    }
    const named = { '/console': 'console.html', '/foundations': 'foundations.html' };
    const file = path.join(PUBLIC, named[p] || p.replace(/^\/+/, '') || 'index.html');
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-queue-'));
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

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

/** Type into a composer and press its send button, the way a thumb would. */
const say = async (box, btn, text) => {
  await evalJs(
    s,
    `(() => {
      const box = document.querySelector('${box}');
      box.value = ${JSON.stringify(text)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('${btn}').click();
    })()`
  );
  await sleep(400);
};

const QUEUED = (sel) => `(() => {
  const el = document.querySelector('${sel}');
  return {
    shown: !el.hidden,
    lines: [...el.querySelectorAll('.queued-text')].map((b) => b.textContent),
    toast: !document.querySelector('#toast').hidden,
  };
})()`;

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

  /* ================================================== the bead console ==== */

  console.log('/console — a turn in flight');
  await s.send('Page.navigate', { url: `${BASE}/console?id=chat&t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#thread .msg')`)) break;
  }

  const composer = await evalJs(
    s,
    `(() => {
      const box = document.querySelector('#say');
      const send = document.querySelector('#send');
      return { disabled: box.disabled, sendDisabled: send.disabled, placeholder: box.placeholder,
               thinking: !!document.querySelector('#thread .working') };
    })()`
  );
  check('the turn really is in flight', composer.thinking, JSON.stringify(composer.thinking));
  check('the textarea is not disabled mid-turn', composer.disabled === false, `disabled=${composer.disabled}`);
  check('the send button is not disabled mid-turn', composer.sendDisabled === false, `disabled=${composer.sendDisabled}`);
  check(
    'and the placeholder is not swapped for “working…”',
    !/working/i.test(composer.placeholder),
    JSON.stringify(composer.placeholder)
  );

  // Focus is the phone half of "the keyboard stays up": a box that loses focus
  // mid-turn dismisses the keyboard whatever its disabled attribute says.
  const keepsFocus = await evalJs(
    s,
    `(() => {
      const box = document.querySelector('#say');
      box.focus();
      box.value = 'still typing';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return document.activeElement === box && box.value === 'still typing';
    })()`
  );
  check('typing into it works, and it keeps focus', keepsFocus);

  await say('#say', '#send', 'and one for the exporter');
  let q = await evalJs(s, QUEUED('#queued'));
  check('a message sent mid-turn shows as pending', q.shown && q.lines.length === 1, JSON.stringify(q.lines));
  check('in your own words', q.lines[0] === 'and one for the exporter', JSON.stringify(q.lines[0]));
  check('and it is not reported as an error', !q.toast, `toast=${q.toast}`);
  check('nothing was pushed into the running turn', delivered.length === 0, `delivered=${JSON.stringify(delivered)}`);

  await say('#say', '#send', 'and a third about the report');
  q = await evalJs(s, QUEUED('#queued'));
  check('a second one queues behind it', q.lines.length === 2, JSON.stringify(q.lines));

  // Tapping a queued line takes it back — the only way to fix a typo in something
  // said but not yet delivered.
  // Null-safe on purpose: under --baseline nothing ever queues, and a baseline run
  // has to report that as failures rather than die on the click.
  const back = await evalJs(
    s,
    `(() => {
      document.querySelectorAll('#queued .queued-text')[0]?.click();
      return { box: document.querySelector('#say').value,
               left: [...document.querySelectorAll('#queued .queued-text')].map((b) => b.textContent) };
    })()`
  );
  check('tapping a queued message puts it back in the box', back.box === 'and one for the exporter', JSON.stringify(back.box));
  check('and takes it out of the queue', back.left.length === 1, JSON.stringify(back.left));

  await evalJs(s, `document.querySelector('#send').click()`);
  await sleep(300);

  // The turn lands. Everything said during it goes as one turn.
  land();
  await sleep(1500);
  q = await evalJs(s, QUEUED('#queued'));
  check('when the turn lands the queue empties', !q.shown && q.lines.length === 0, JSON.stringify(q));
  check('and everything said during it arrives as one turn', delivered.length === 1, `${delivered.length}: ${JSON.stringify(delivered)}`);
  check(
    'with both messages in it, in the order they were said',
    delivered[0] === 'and a third about the report\n\nand one for the exporter',
    JSON.stringify(delivered[0])
  );
  check('and it never pushed through the 409', refused === 0, `refused=${refused}`);

  const landedInThread = await evalJs(
    s,
    `[...document.querySelectorAll('#thread .msg.you')].map((m) => m.textContent).join(' | ')`
  );
  check('the delivered message is in the conversation now', /exporter/.test(landedInThread), landedInThread.slice(0, 90));

  /* ================================================ the agent chat tab ==== */

  console.log('\n/foundations — the same, on the agent chat');
  CONSOLE = thinking();
  CONSOLE.agent = 'advocate';
  delivered = [];
  refused = 0;

  await s.send('Page.navigate', { url: `${BASE}/foundations?id=advocate&tab=chat&t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#chat-thread .msg')`)) break;
  }

  const chatBox = await evalJs(
    s,
    `(() => {
      const box = document.querySelector('#chat-say');
      return { disabled: box.disabled, sendDisabled: document.querySelector('#chat-send').disabled,
               messages: document.querySelectorAll('#chat-thread .msg').length };
    })()`
  );
  check('the chat picked up the mid-turn conversation', chatBox.messages > 0, `${chatBox.messages} messages`);
  check('its composer is live too', chatBox.disabled === false && chatBox.sendDisabled === false, JSON.stringify(chatBox));

  await say('#chat-say', '#chat-send', 'why did you propose that one?');
  await say('#chat-say', '#chat-send', 'and what stopped you filing it?');
  q = await evalJs(s, QUEUED('#chat-queued'));
  check('two messages queue rather than failing', q.shown && q.lines.length === 2, JSON.stringify(q.lines));
  check('with no red toast about a 409', !q.toast, `toast=${q.toast}`);
  check('and nothing delivered mid-turn', delivered.length === 0, JSON.stringify(delivered));

  land();
  await sleep(1500);
  q = await evalJs(s, QUEUED('#chat-queued'));
  check('the queue empties when the turn lands', !q.shown, JSON.stringify(q));
  check('as one turn, not two', delivered.length === 1, `${delivered.length}: ${JSON.stringify(delivered)}`);
  check(
    'carrying both messages',
    delivered[0] === 'why did you propose that one?\n\nand what stopped you filing it?',
    JSON.stringify(delivered[0])
  );
  check('and it never pushed through the 409 either', refused === 0, `refused=${refused}`);
} finally {
  if (!KEEP) close();
  for (const res of parked) res.destroy();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
