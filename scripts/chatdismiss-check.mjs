#!/usr/bin/env node
//
// Putting a conversation away from the inbox, with a finger.
//
//   node scripts/chatdismiss-check.mjs [--baseline] [--shots]
//
// The inbox's chat cards got the ✕ the launcher has had since chats gained a dismissed
// state (bc-vau1). It is one tap on a card whose whole body is a link to the
// conversation, which is the shape every way this can go wrong comes from:
//
//   • the ✕ must dismiss and *nothing else*. A button inside an <a> is invalid HTML
//     and navigates; the card is a wrapper with the two as siblings, and the tap that
//     proves it is a tap that leaves you on the inbox.
//   • the row has to go on the tap rather than at the next 25-second poll — and stay
//     gone across the poll that was already in flight, which still lists it. That is
//     the failure with no visible cause: the row slides back a second later and leaves
//     again twenty seconds after that.
//   • refused mid-turn, the row has to come back with the reason on it. A conversation
//     with a `claude` process streaming into it cannot be closed under it.
//   • the accessible name has to say *which* conversation, because a list of six ✕s
//     all called "Dismiss" is six buttons a screen reader cannot tell apart.
//   • and the card must still be the thing the scroll position anchors to —
//     `.card[data-key]`, which moved from the anchor to the wrapper in the same change.
//
// What it is not: a test of the close itself. That is soft, the server owns it, and
// `test/chatinbox.mjs` drives the real endpoint. Here the endpoint is a stub that
// records what arrived and can refuse on demand.
//
// Real public/app.js and public/style.css in a headless Chrome the size of a phone,
// against fixtures served from this process. Nothing here touches a real conversation.
//
// `--baseline` serves the committed public/, which is how you tell a real failure from
// a flaky one: at baseline there is no ✕ at all and every case must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'chatdismiss-check-token';
const BASELINE = process.argv.includes('--baseline');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, '.claude', 'shots');
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

// Two conversations, and the second is with an agent: the ✕'s accessible name names
// the agent there and only there, exactly as the launcher's does, because two chats in
// one repo are otherwise the same sentence twice.
const CHATS = [
  {
    id: 'c0ffee01',
    agent: 'console',
    workspace: WS,
    space: null,
    title: 'What the next bead should be',
    seed: null,
    status: 'idle',
    closedAt: null,
    messageCount: 4,
    beadCount: 2,
    created: [],
    createdAt: '2026-08-09T08:00:00Z',
    updatedAt: '2026-08-09T08:40:00Z',
  },
  {
    id: 'c0ffee02',
    agent: 'critic',
    agentName: 'Critic',
    agentEmoji: '🔎',
    workspace: WS,
    space: null,
    title: 'Whether the router should retry',
    seed: null,
    status: 'idle',
    closedAt: null,
    messageCount: 9,
    beadCount: 0,
    created: [],
    createdAt: '2026-08-09T07:00:00Z',
    updatedAt: '2026-08-09T08:10:00Z',
  },
];

/* ------------------------------------------------------------------ server */

// `stale` is the poll that was already in flight when you tapped: the close is
// recorded, and the next payload still carries the row. `fail` is the mid-turn
// refusal, in the server's own words.
const state = { closes: [], fail: false, stale: false, gone: new Set() };
const live = () => CHATS.filter((c) => !state.gone.has(c.id));

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const BASE_FILES = ['/app.js', '/style.css', '/index.html'];
const committed = (p) => {
  try {
    return execFileSync('git', ['show', `HEAD:public${p}`], { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({
        questions: [],
        consoles: live(),
        workspaces: [WS],
        spaces: [],
        scope: 'human',
        summary: { questions: 0, sessions: 0, proposals: 0 },
      });
    }
    if (p === '/api/console/close') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        state.closes.push(parsed);
        if (state.fail) {
          // Word for word what lib/console.js throws, because what the toast has to
          // show is the server's sentence and not a paraphrase of it.
          return json({ error: 'this chat session is mid-turn — wait for it to finish' }, 409);
        }
        if (!state.stale) state.gone.add(parsed.id);
        return json({ ok: true });
      });
    }
    // The delta stream: parked the way the daemon parks it, or the page restarts the
    // long poll the instant it answers and spins at full speed against this stub.
    if (p === '/api/poll') {
      const timer = setTimeout(() => json({ events: [], seq: 1 }), 30_000);
      return req.on('close', () => clearTimeout(timer));
    }
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/' ? '/index.html' : p;
    if (BASELINE && BASE_FILES.includes(rel)) {
      const bodyOut = committed(rel);
      if (!bodyOut) return res.writeHead(404).end('no');
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] || TYPES['.html'] });
      return res.end(bodyOut);
    }
    const file = path.join(PUBLIC, rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return res.writeHead(404).end('no');
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

const waitFor = async (s, expr, tries = 60, gap = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(gap);
  }
  return false;
};

/* -------------------------------------------------------------------- probes */

const CARD = (id) => `#list .card.chat-card[data-key="chat/${id}"]`;
const XBTN = (id) => `${CARD(id)} .row-x`;
const tap = (s, sel) => evalJs(s, `(document.querySelector(${JSON.stringify(sel)}) || { click(){} }).click(), true`);
const there = (s, sel) => evalJs(s, `!!document.querySelector(${JSON.stringify(sel)})`);
const toastText = (s) => evalJs(s, `(document.querySelector('#toast') || {}).textContent || ''`);

// Everything about one card's ✕ that a finger or a screen reader can tell, in one
// round trip — including the one structural fact the whole thing rests on: the button
// is a *sibling* of the link, not something nested inside it.
const XSTATE = (id) => `(() => {
  const card = document.querySelector(${JSON.stringify(CARD(id))});
  if (!card) return null;
  const link = card.querySelector('a[href]');
  const btn = card.querySelector('.row-x');
  if (!btn) return { card: true, btn: false };
  const box = btn.getBoundingClientRect();
  const lb = link ? link.getBoundingClientRect() : null;
  return {
    card: true,
    btn: true,
    label: btn.getAttribute('aria-label') || '',
    act: btn.dataset.act || '',
    inLink: !!(link && link.contains(btn)),
    href: link ? link.getAttribute('href') : null,
    width: Math.round(box.width),
    height: Math.round(box.height),
    // Beside the row rather than under it: same middle, to the right of the link.
    besideLink: !!(lb && box.left >= lb.right - 1 && Math.abs((box.top + box.bottom) / 2 - (lb.top + lb.bottom) / 2) < 12),
    onScreen: box.right <= ${VP.width} + 1 && box.width > 0,
  };
})()`;

let shotN = 0;
async function shot(s, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(SHOT_DIR, `chatdismiss-${String(++shotN).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`    · ${out}`);
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-chatdismiss-');

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

  console.log(`\n${BASELINE ? 'BASELINE (HEAD:public/)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  if (!(await waitFor(s, `!!document.querySelector('#list .chat-card')`)))
    throw new Error('the chat cards never rendered');

  /* ================================================== 1. the button is there */

  console.log('the ✕ on a chat card');

  const plain = await evalJs(s, XSTATE(CHATS[0].id));
  const withAgent = await evalJs(s, XSTATE(CHATS[1].id));
  await shot(s, 'at-rest');

  check('every chat card has one', !!plain?.btn && !!withAgent?.btn, `${[plain, withAgent].filter((x) => x?.btn).length} of 2`);
  check(
    // The whole reason the card stopped being the anchor itself. A <button> inside an
    // <a> is invalid, and the browser's own repair of it is a tap that navigates.
    'and it is beside the link, not inside it',
    plain?.btn && !plain.inLink && plain.besideLink,
    plain ? `inLink=${plain.inLink}, beside=${plain.besideLink}` : 'no card'
  );
  check(
    'the card is still what the scroll position anchors to',
    await there(s, `#list .card[data-key="chat/${CHATS[0].id}"]`),
    // Named in the detail either way: on a pass it says what was looked for, and on a
    // failure that is exactly the sentence you need.
    `.card[data-key="chat/${CHATS[0].id}"]`
  );
  check(
    'the link under it still opens the conversation',
    plain?.href === `/console?id=${CHATS[0].id}`,
    String(plain?.href)
  );
  check(
    'it is a real tap target, and on the screen',
    plain?.btn && plain.width >= 36 && plain.height >= 36 && plain.onScreen,
    plain ? `${plain.width}x${plain.height}, onScreen=${plain.onScreen}` : ''
  );

  console.log('\nand it says which conversation it would put away');

  check(
    'the name carries the title, not "Dismiss" six times over',
    plain?.label?.includes(CHATS[0].title),
    JSON.stringify(plain?.label || null)
  );
  check(
    'an agent chat names the agent too, as the launcher does',
    withAgent?.label?.includes('Critic') && withAgent?.label?.includes(CHATS[1].title),
    JSON.stringify(withAgent?.label || null)
  );

  /* ============================================== 2. one tap, and the row goes */

  console.log('\none tap puts it away');

  // The payload keeps listing it: this is the 25-second poll that was assembled
  // before the tap, which is the thing that used to bring the row back.
  state.stale = true;
  const before = await evalJs(s, 'location.href');
  await tap(s, XBTN(CHATS[0].id));
  const went = await waitFor(s, `!document.querySelector(${JSON.stringify(CARD(CHATS[0].id))})`, 40, 100);
  await sleep(400);
  await shot(s, 'dismissed');

  check('the row leaves the list at once', went, went ? '' : 'the row was still there after 4s');
  check('and the tap did not open the conversation', (await evalJs(s, 'location.href')) === before, await evalJs(s, 'location.pathname'));
  check(
    'exactly one dismissal went out, for that conversation',
    state.closes.length === 1 && state.closes[0].id === CHATS[0].id,
    JSON.stringify(state.closes)
  );
  check('the other conversation is untouched', await there(s, CARD(CHATS[1].id)), `${(await evalJs(s, "document.querySelectorAll('#list .chat-card').length"))} chat card(s) left`);

  const said = await toastText(s);
  check(
    // A card that vanishes silently reads as data loss, and this one is not even
    // gone: it is in the launcher, under Dismissed, and saying anything reopens it.
    'the toast says where it went',
    /dismiss/i.test(said) && /launcher/i.test(said),
    said
  );

  /* ================================== 3. the poll already in flight does not undo it */

  console.log('\nthe poll that was already in flight still lists it');

  await tap(s, '#refresh');
  await sleep(900);
  check(
    'and the row stays gone',
    !(await there(s, CARD(CHATS[0].id))),
    `${await evalJs(s, "document.querySelectorAll('#list .chat-card').length")} chat card(s) on screen`
  );

  state.stale = false;
  state.gone.add(CHATS[0].id);
  await tap(s, '#refresh');
  await sleep(900);
  check(
    'still gone once the server agrees it is',
    !(await there(s, CARD(CHATS[0].id))) && (await there(s, CARD(CHATS[1].id))),
    `${await evalJs(s, "document.querySelectorAll('#list .chat-card').length")} chat card(s) on screen`
  );

  /* ============================================ 4. refused mid-turn, and why */

  console.log('\nrefused mid-turn');

  state.fail = true;
  state.closes.length = 0;
  await tap(s, XBTN(CHATS[1].id));
  await sleep(1200);
  const backSaid = await toastText(s);
  await shot(s, 'refused');

  check('the write was attempted', state.closes.length === 1, JSON.stringify(state.closes));
  check(
    'the row comes back rather than staying gone on a write that failed',
    await there(s, CARD(CHATS[1].id)),
    `${await evalJs(s, "document.querySelectorAll('#list .chat-card').length")} chat card(s) on screen`
  );
  check(
    'and it says why, in the server’s own words',
    /mid-turn/i.test(backSaid),
    backSaid
  );
  check(
    'the ✕ is usable again, not left disabled by the failure',
    await evalJs(s, `!document.querySelector(${JSON.stringify(XBTN(CHATS[1].id))})?.disabled`),
    `disabled=${await evalJs(s, `!!document.querySelector(${JSON.stringify(XBTN(CHATS[1].id))})?.disabled`)}`
  );
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\n${failed.length} of ${results.length} failed${BASELINE ? ' (expected at baseline)' : ''}`
    : `\nall ${results.length} passed`
);
process.exit(failed.length && !BASELINE ? 1 : 0);
