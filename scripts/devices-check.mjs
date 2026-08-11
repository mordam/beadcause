#!/usr/bin/env node
//
// The signed-in devices card on /admin — does it hold up on a phone?
//
//   node scripts/devices-check.mjs [--out=DIR]
//
// `test/auth.mjs` proves the daemon end of this: sign in twice, revoke one, watch the
// other keep working. What it cannot see is the screen, and the screen is where the
// mistake would actually be made — this is the one control in the app that ends a
// session on a device that is not in the room, and pressing it on the wrong row is not
// undoable from that device. So the three things checked here are the three that make
// the row you press the row you meant:
//
//   - **which row is which** — a label and a last-seen on every one of them;
//   - **which row is you** — the browser reading the page is marked, and its button
//     says "sign this browser out" rather than "revoke", because that is what it does;
//   - **and that one tap is never enough.** Every revoke arms first, like the kill
//     button beside it. The assertion is not that the label changes: it is that *no
//     request reached the server* on the first tap.
//
// public/ is served from this process with stubbed API bodies, so nothing here touches
// a real session, a real daemon or a real Google. `--out=DIR` writes a screenshot.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor'))) {
  console.error('public/vendor is missing — run `npm run vendor` first');
  process.exit(1);
}

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
const is = (name, got, want) =>
  got === want ? ok(name) : bad(name, `got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`);

/* ---------------------------------------------------------------- fixtures */

const iso = (minsAgo) => new Date(Date.now() - minsAgo * 60000).toISOString();

/** Two browsers signed in as the same person, which is the whole normal case. */
const HERE = 'sid-this-browser';
const initial = () => [
  { id: HERE, email: 'adam@example.com', label: 'Mac · Chrome', first: iso(60 * 24 * 3), last: iso(1), current: true },
  { id: 'sid-the-phone', email: 'adam@example.com', label: 'iPhone · Safari', first: iso(60 * 24), last: iso(90), current: false },
];

const ADMIN = {
  reopenIsFresh: false,
  at: null,
  scopes: [
    {
      id: '*',
      label: 'Everything',
      workspaces: ['demo'],
      advocates: { total: 1, pausedCount: 0, ours: 0, workers: 0 },
      terminals: { live: 0, closed: 0 },
    },
  ],
  closed: [],
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

/**
 * The stub. `google` is a knob because the card must draw *nothing at all* on a
 * token-only install — an empty list there would read as "you are signed out
 * everywhere" rather than "this does not apply here".
 */
function serve(state) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    if (p === '/auth/whoami') return json({ google: state.google, signedIn: state.google, email: 'adam@example.com', token: true });
    if (p === '/api/devices' && req.method === 'GET') {
      return json({ google: state.google, current: state.google ? HERE : null, devices: state.google ? state.devices : [] });
    }
    if (p === '/api/devices' && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const { id } = JSON.parse(body || '{}');
        state.posted.push(id);
        const had = state.devices.some((d) => d.id === id);
        state.devices = state.devices.filter((d) => d.id !== id);
        json({ ok: true, revoked: had, self: id === HERE, current: id === HERE ? null : HERE, devices: state.devices });
      });
      return;
    }
    if (p === '/api/admin') return json(ADMIN);
    if (p === '/api/work') return json({ workspaces: [], advocates: [], elsewhere: [], observing: false });
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (p.startsWith('/api/')) return json({});
    const rel = p === '/admin' ? '/admin.html' : p;
    const file = path.join(PUBLIC, rel === '/' ? 'index.html' : rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server)));
}

/* ------------------------------------------------------------------ chrome */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const pr = msg.id != null && pending.get(msg.id);
      if (!pr) return;
      pending.delete(msg.id);
      msg.error ? pr.reject(new Error(msg.error.message)) : pr.resolve(msg.result);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-devices-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-timer-throttling',
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

/** What the card is showing, read off the DOM rather than off the fixture. */
const PROBE = `(() => {
  const card = document.querySelector('#devices .admin-card');
  if (!card) return { card: false };
  const rows = [...card.querySelectorAll('.admin-row')].map((el) => ({
    what: el.querySelector('.admin-what')?.textContent.trim(),
    state: el.querySelector('.admin-state')?.textContent.trim(),
    detail: el.querySelector('.admin-detail')?.textContent.trim(),
    button: el.querySelector('button[data-revoke]')?.textContent.trim(),
    id: el.querySelector('button[data-revoke]')?.dataset.revoke,
    mine: !!el.querySelector('.pill'),
    tap: Math.round(el.querySelector('button[data-revoke]')?.getBoundingClientRect().height || 0),
  }));
  return { card: true, heading: card.querySelector('h2')?.textContent.trim(), rows };
})()`;

const tap = (id) => `(() => {
  const b = document.querySelector('button[data-revoke="${id}"]');
  if (!b) return 'no such button';
  b.click();
  return b.textContent.trim();
})()`;

/* -------------------------------------------------------------------- run */

const chrome = await launch();
const { s } = chrome;
await s.send('Page.enable');
await s.send('Runtime.enable');
await s.send('Emulation.setDeviceMetricsOverride', { ...VP, deviceScaleFactor: VP.dpr, mobile: true });

const open = async (port) => {
  await s.send('Page.navigate', { url: `http://127.0.0.1:${port}/admin` });
  await sleep(1200);
};

/* --- the install with no sign-in configured: nothing is drawn at all --- */

console.log('\nwith no Google sign-in configured');
{
  const state = { google: false, devices: initial(), posted: [] };
  const server = await serve(state);
  await open(server.address().port);
  const seen = await evalJs(s, PROBE);
  // An empty list here would read as "you are signed out everywhere", which is a
  // sentence about a feature this install does not have.
  is('no devices card is drawn', seen.card, false);
  is('and the page itself still works', await evalJs(s, `!!document.querySelector('#admin .admin-card')`), true);
  server.close();
}

/* --- two browsers signed in --- */

console.log('\nwith two browsers signed in');
const state = { google: true, devices: initial(), posted: [] };
const server = await serve(state);
await open(server.address().port);

{
  const seen = await evalJs(s, PROBE);
  is('the card is drawn', seen.heading, 'Signed-in devices');
  is('one row per device', seen.rows.length, 2);
  // Which row is which. A label and a time, because "revoke" with nothing to aim it
  // at is a control nobody presses.
  is('each row says what it is', seen.rows.map((r) => r.what.replace(' this browser', '')).join(' / '), 'Mac · Chrome / iPhone · Safari');
  is('and when it was last seen', /ago|just now/.test(seen.rows[1].state), true);
  is('and when it first signed in', /first signed in/.test(seen.rows[1].detail), true);
  // Which row is you. Revoking your own session is signing out, and being surprised
  // by that is how somebody locks themselves out of the screen they are looking at.
  is('the browser reading the page is marked', seen.rows[0].mine, true);
  is('and no other row is', seen.rows.filter((r) => r.mine).length, 1);
  is('its button says what it really does', seen.rows[0].button, 'Sign this browser out');
  is('and the other one says revoke', seen.rows[1].button, 'Revoke');
  is('both are real tap targets', seen.rows.every((r) => r.tap >= 40), true);
}

/** A shot of the card itself, scrolled to — it is the bottom of a long page. */
async function shoot(name) {
  if (!outDir) return;
  fs.mkdirSync(outDir, { recursive: true });
  await evalJs(s, `document.querySelector('#devices')?.scrollIntoView({ block: 'start' }), 1`);
  await sleep(200);
  const shot = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(outDir, `devices-${name}.png`), Buffer.from(shot.data, 'base64'));
}
await shoot('listed');

console.log('\none tap is never enough');
{
  const armed = await evalJs(s, tap('sid-the-phone'));
  await sleep(300);
  // The assertion that matters: not that the label changed, but that nothing was sent.
  is('the first tap sends nothing', state.posted.length, 0);
  is('and puts the consequence in the button', armed, 'Tap again to end that session');
  // Armed goes solid rather than only changing its words — the house treatment for the
  // press that is about to act, shared with the kill button above it.
  // Resolved through the browser rather than compared to the token's text, so this
  // asks the question a person asks — is it filled, and is it the danger colour.
  is(
    'and the armed button looks live rather than merely reading differently',
    await evalJs(
      s,
      `(() => {
         const probe = document.createElement('div');
         probe.style.background = 'var(--danger)';
         document.body.append(probe);
         const want = getComputedStyle(probe).backgroundColor;
         probe.remove();
         return getComputedStyle(document.querySelector('button[data-revoke="sid-the-phone"]')).backgroundColor === want;
       })()`
    ),
    true
  );
  is('the row is still there', (await evalJs(s, PROBE)).rows.length, 2);
}

console.log('\nand the second one revokes that device and no other');
{
  await evalJs(s, tap('sid-the-phone'));
  await sleep(600);
  is('the phone was the one revoked', state.posted.join(), 'sid-the-phone');
  const seen = await evalJs(s, PROBE);
  is('one row is left', seen.rows.length, 1);
  is('and it is this browser', seen.rows[0].id, HERE);
  is('with the outcome said on the card', await evalJs(s, `/signed out/.test(document.querySelector('#devices .admin-said')?.textContent || '')`), true);
}

await shoot('revoked');

server.close();
chrome.close();

console.log(`\n${failures ? '\x1b[31m' : '\x1b[32m'}${ran - failures}/${ran} passed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
