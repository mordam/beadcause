#!/usr/bin/env node
//
// Does the tab bar hold up on all four standing views?
//
//   node scripts/tabbar-check.mjs [--fake-inset] [--out=DIR]
//
// The bar is the only way off any of these pages now — the ✕ that used to go back
// to the inbox is gone — so a bar that is missing, mis-marked or sitting under
// something is not a cosmetic fault, it is a page you cannot leave. This drives
// headless Chrome at phone size against public/ served from this process with
// stubbed API bodies, so nothing here touches a real bead or a running daemon.
//
// Per page: the bar is there and pinned to the bottom, exactly one tab is current
// and it is the right one, the current tab is not a link (tapping where you
// already are must not reload), it is marked by more than colour, and the thing
// the page cannot afford to have covered — the last row of the list, the console's
// composer, the last advocate card — clears it. Both colour schemes, and the
// inbox's full-screen open card too, which is meant to win over the bar.
//
// The badges too, on the inbox: Sessions and Advocates carry the counts the poll
// hands them, they stay inside their tab rather than spilling into the next one,
// and a tab with nothing behind it draws nothing.
//
// `--fake-inset` restates the stylesheet's safe-area sums with 34px of home
// indicator substituted in, for the Chromes that have no `Emulation.setSafeAreaInsets`.
// `--out=DIR` writes a screenshot per page per scheme.
import { spawn } from 'node:child_process';
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
const BOTTOM_INSET = 34; // the home indicator on a notched phone
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const issue = (n) => ({
  id: `d-${n}`,
  title: `A question waiting (${n})`,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: `Short brief ${n}.\n\nA paragraph that has to wrap on a phone. `.repeat(3),
});
const QUESTIONS = Array.from({ length: 8 }, (_, i) => ({ ...toQuestion('demo', issue(i + 1)), comments: [] }));

const WORK = {
  workspaces: [
    { name: 'demo', working: [], sessions: [], counts: { open: 5, ready: 2 } },
    { name: 'other', working: [], sessions: [], counts: { open: 1 } },
  ],
  advocates: [
    { workspace: 'demo', state: 'idle', workers: [], paused: false, next: [] },
    { workspace: 'other', state: 'idle', workers: [], paused: false, next: [] },
  ],
  elsewhere: [],
};

/* Two scopes, both with something to stop, so /admin draws its full height — the
   kill button included, since clearing the bar is the thing being measured. */
const ADMIN = {
  reopenIsFresh: true,
  at: null,
  scopes: [
    {
      id: '*',
      label: 'Everything',
      workspaces: ['demo', 'other'],
      advocates: { total: 2, pausedCount: 0, ours: 0, workers: 2 },
      terminals: { live: 1, closed: 0 },
    },
    {
      id: 'Work',
      label: 'Work',
      workspaces: ['demo'],
      advocates: { total: 1, pausedCount: 1, ours: 1, workers: 1 },
      terminals: { live: 0, closed: 1 },
    },
  ],
  closed: [{ workspace: 'demo', bead: null, cols: 80, rows: 24 }],
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

function serve() {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    const json = (b) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };
    // `summary` is what the badges on Sessions and Advocates are drawn from, so the
    // bar this checks is the bar that ships rather than a bare one.
    if (p === '/api/questions')
      return json({
        questions: QUESTIONS,
        workspaces: ['demo'],
        spaces: [],
        scope: 'human',
        summary: { sessions: 2, proposals: 1, questions: QUESTIONS.length },
      });
    if (p === '/api/work') return json(WORK);
    if (p === '/api/consoles') return json({ consoles: [], workspaces: ['demo', 'other'] });
    if (p === '/api/admin') return json(ADMIN);
    if (p.startsWith('/api/')) return json({});
    // The same aliases the real server maps onto one page.
    let rel = p;
    if (rel === '/sessions' || rel === '/work') rel = '/work.html';
    if (rel === '/console') rel = '/console.html';
    if (rel === '/monitor' || rel === '/advocates') rel = '/monitor.html';
    if (rel === '/admin') rel = '/admin.html';
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
  const port = 9600 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-tabbar-'));
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

/* ------------------------------------------------------------------- probe */

const PROBE = `(() => {
  const bar = document.querySelector('.tabbar');
  if (!bar) return { bar: false };
  const r = bar.getBoundingClientRect();
  const items = [...bar.querySelectorAll('.tab-item')].map((el) => ({
    tab: el.dataset.tab,
    tag: el.tagName.toLowerCase(),
    href: el.getAttribute('href'),
    current: el.getAttribute('aria-current') === 'page',
    label: el.querySelector('.tab-label')?.textContent,
    w: Math.round(el.getBoundingClientRect().width),
    h: Math.round(el.getBoundingClientRect().height),
    rule: !!el.getAttribute('aria-current') && getComputedStyle(el, '::before').content !== 'none',
    color: getComputedStyle(el).color,
  }));
  return {
    bar: true,
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    height: Math.round(r.height),
    inner: Math.round(parseFloat(getComputedStyle(bar).paddingBottom)),
    vh: innerHeight,
    items,
    // Is anything from the page's own content sitting under the bar? Measured by
    // asking the document what is at the middle of the bar: if the bar is on top
    // and opaque to hit testing, it is the bar.
    atBarMiddle: (document.elementFromPoint(innerWidth / 2, r.top + r.height / 2) || {}).className,
  };
})()`;

// What must clear the bar, per page.
const CLEAR = {
  '/': `(() => {
    const cards = [...document.querySelectorAll('#list .card')];
    const last = cards[cards.length - 1];
    if (!last) return { what: 'last card', missing: true };
    // Scroll to the very bottom first: the complaint is about the last row.
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    const r = last.getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return { what: 'last card', bottom: Math.round(r.bottom), barTop: Math.round(bar.top), n: cards.length };
  })()`,
  '/console': `(() => {
    const c = document.querySelector('#composer');
    c.hidden = false;
    document.querySelector('#launcher').hidden = true;
    document.querySelector('#thread').hidden = false;
    const r = c.getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return { what: 'composer', bottom: Math.round(r.bottom), barTop: Math.round(bar.top),
             sendBottom: Math.round(document.querySelector('#send').getBoundingClientRect().bottom) };
  })()`,
  '/sessions': `(() => {
    const cards = [...document.querySelectorAll('#work .card')];
    const last = cards[cards.length - 1];
    if (!last) return { what: 'last session card', missing: true };
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    const r = last.getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return { what: 'last session card', bottom: Math.round(r.bottom), barTop: Math.round(bar.top), n: cards.length };
  })()`,
  '/monitor': `(() => {
    const cards = [...document.querySelectorAll('#mon .card, #mon .mon-card')];
    const last = cards[cards.length - 1];
    if (!last) return { what: 'last advocate card', missing: true };
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    const r = last.getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return { what: 'last advocate card', bottom: Math.round(r.bottom), barTop: Math.round(bar.top), n: cards.length };
  })()`,
  // The kill button is the last thing on the last scope's card, and it is the one
  // control on this page you must never press by accident. A bar sitting over it
  // would put "stop every running session" exactly where a thumb reaches for the
  // tab it meant to tap.
  '/admin': `(() => {
    const cards = [...document.querySelectorAll('#admin .admin-card')];
    const last = cards[cards.length - 1];
    if (!last) return { what: 'last scope card', missing: true };
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    const r = last.getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return { what: 'last scope card', bottom: Math.round(r.bottom), barTop: Math.round(bar.top), n: cards.length };
  })()`,
};

/* Every standing view, in bar order. The count is asserted from this list rather
   than written out as a number, so adding a sixth tab is one line here and not a
   test that fails with "four tabs: <five of them>". */
const TABS = ['inbox', 'console', 'sessions', 'advocates', 'admin'];

const PAGES = [
  { url: '/', tab: 'inbox', name: 'inbox' },
  { url: '/console', tab: 'console', name: 'console' },
  { url: '/sessions', tab: 'sessions', name: 'sessions' },
  { url: '/monitor', tab: 'advocates', name: 'advocates' },
  // Pause all / resume all. Nothing on it is reachable any other way, so a bar that
  // failed here would strand the one control that stops everything.
  { url: '/admin', tab: 'admin', name: 'admin' },
];

let failures = 0;
const ok = (pass, msg) => {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓' : '✗'} ${msg}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const chrome = await launch();
const { s } = chrome;

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
  });
  let insets = false;
  try {
    await s.send('Emulation.setSafeAreaInsets', { insets: { top: 59, bottom: BOTTOM_INSET, left: 0, right: 0 } });
    insets = true;
  } catch (e) {
    console.log(`  (Emulation.setSafeAreaInsets: ${e.message})`);
  }
  // This Chrome cannot emulate a notch, and `env()` cannot be set from script. So
  // with --fake-inset the stylesheet's own sums are restated with the inset the
  // phone would supply, substituted in the same places. It does not prove `env()`
  // resolves — nothing here can — but it does prove the layout survives 34px of
  // home indicator: the bar grows by it, and everything above still clears.
  if (!insets && process.argv.includes('--fake-inset')) {
    await s.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `addEventListener('DOMContentLoaded', () => {
        const st = document.createElement('style');
        st.textContent = \`
          .tabbar { padding-bottom: ${BOTTOM_INSET}px; }
          .has-tabbar { padding-bottom: calc(${BOTTOM_INSET}px + var(--tabbar-h) + 16px); }
          .console-body.has-tabbar { padding-bottom: 0; }
          .has-tabbar .toast { bottom: calc(${BOTTOM_INSET}px + var(--tabbar-h) + 18px); }
          .console-body.has-tabbar .toast { bottom: calc(${BOTTOM_INSET}px + var(--tabbar-h) + 84px); }\`;
        document.head.append(st);
      });`,
    });
    insets = true;
    console.log(`  (safe area faked in CSS at ${BOTTOM_INSET}px — see --fake-inset)`);
  }
  console.log(`${VP.width}x${VP.height} · safe-area bottom ${insets ? BOTTOM_INSET + 'px' : 'unsupported, 0'} · ${BASE}\n`);

  for (const scheme of ['dark', 'light']) {
    await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    console.log(`── ${scheme} ──`);
    for (const page of PAGES) {
      await s.send('Page.navigate', { url: BASE + page.url });
      await sleep(1400);
      // The token gate: every page shows the setup dialog without one.
      await evalJs(s, `localStorage.setItem('beadcause.token', 'x')`);
      await s.send('Page.navigate', { url: BASE + page.url });
      await sleep(1600);

      const p = await evalJs(s, PROBE);
      console.log(`${page.name} (${page.url})`);
      if (!p.bar) {
        ok(false, 'the bar is on the page');
        continue;
      }
      ok(true, `the bar is on the page — ${p.items.length} tabs, ${p.height}px tall`);
      ok(p.items.length === TABS.length, `${TABS.length} tabs: ${p.items.map((i) => i.label).join(', ')}`);
      ok(p.bottom === p.vh, `pinned to the bottom — bar bottom ${p.bottom}, viewport ${p.vh}`);
      if (insets) ok(p.inner === BOTTOM_INSET, `clears the home indicator — ${p.inner}px of safe-area padding`);
      const cur = p.items.filter((i) => i.current);
      ok(cur.length === 1, `exactly one tab is current (${cur.length})`);
      ok(cur[0]?.tab === page.tab, `the current tab is ${page.tab} (got ${cur[0]?.tab})`);
      ok(cur[0]?.tag === 'span' && !cur[0]?.href, 'the current tab is not a link — tapping it does nothing');
      ok(!!cur[0]?.rule, 'the current tab is marked by more than colour');
      const others = p.items.filter((i) => !i.current);
      ok(others.every((i) => i.tag === 'a' && i.href), 'every other tab is a link');
      ok(p.items.every((i) => i.h >= 44), `every tab is a real tap target — ${p.items.map((i) => i.h).join('/')}px`);
      ok(String(p.atBarMiddle).includes('tab'), `the bar takes its own taps (hit test: ${p.atBarMiddle})`);
      ok(!/[✕‹]/.test(await evalJs(s, `document.querySelector('.topbar').textContent`)), 'no ✕ or ‹ in the top bar');

      // The badges, where the numbers actually arrive. They ride the inbox's own
      // poll, so this is the one page that has them — and a badge that overflowed
      // its tab would land on the neighbouring one and count the wrong thing.
      if (page.url === '/') {
        const b = await evalJs(
          s,
          `(() => {
            const of = (id) => {
              const item = document.querySelector('.tab-item[data-tab="' + id + '"]');
              const el = item.querySelector('.tab-badge');
              const r = el.getBoundingClientRect();
              const box = item.getBoundingClientRect();
              return { text: el.hidden ? null : el.textContent, label: item.getAttribute('aria-label'),
                       inside: r.left >= box.left && r.right <= box.right };
            };
            return { sessions: of('sessions'), advocates: of('advocates'), inbox: of('inbox'), console: of('console') };
          })()`
        );
        ok(b.sessions.text === '2' && b.advocates.text === '1', `the counts are on their tabs — ${b.sessions.text} / ${b.advocates.text}`);
        ok(
          /agents? running/.test(b.sessions.label || '') && /proposals? waiting/.test(b.advocates.label || ''),
          'each badge says what it counts, for a reader that cannot see it'
        );
        ok(b.sessions.inside && b.advocates.inside, 'a badge stays inside its own tab');
        ok(b.inbox.text === null && b.console.text === null, 'a tab with nothing behind it has no badge');
      }

      const c = await evalJs(s, CLEAR[page.url]);
      if (c.missing) ok(false, `${c.what} rendered`);
      else ok(c.bottom <= c.barTop + 1, `the ${c.what} is not under the bar — ends at ${c.bottom}, bar starts at ${c.barTop}`);

      // An open card is `position: fixed; inset: 0; z-index: 40` — the whole
      // screen. It is meant to win: the answer buttons at its foot must not sit
      // under a tab bar, and it has its own way out. Check it actually does.
      if (page.url === '/') {
        const card = await evalJs(
          s,
          `(() => {
            // Null-safe on purpose: this selector has drifted out of the inbox's
            // markup before, and a probe that throws takes the whole run with it —
            // every page after this one goes unchecked, which is how a broken bar
            // on /admin could hide behind a stale selector on /.
            const toggle = document.querySelector('.card [data-act="toggle"]');
            if (!toggle) return { open: false, why: 'no .card [data-act="toggle"] on the page' };
            toggle.click();
            const open = document.querySelector('.card.open');
            if (!open) return { open: false, why: 'clicking the toggle did not open a card' };
            const bar = document.querySelector('.tabbar').getBoundingClientRect();
            const at = document.elementFromPoint(innerWidth / 2, bar.top + bar.height / 2);
            return { open: true, over: !!at.closest('.card.open'), covers: open.getBoundingClientRect().bottom >= innerHeight };
          })()`
        );
        ok(card.open, `a card opens${card.why ? ` — ${card.why}` : ''}`);
        if (card.open) {
          ok(card.over && card.covers, 'an open card takes the whole screen, tab bar included');
          await evalJs(s, `document.querySelector('.card.open [data-act="toggle"]')?.click()`);
          await sleep(200);
          ok(
            await evalJs(s, `!!document.elementFromPoint(innerWidth / 2, innerHeight - 20)?.closest('.tabbar')`),
            'closing it gives the bar back'
          );
        }
      }

      if (outDir) {
        fs.mkdirSync(outDir, { recursive: true });
        const shot = await s.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, `${page.name}-${scheme}.png`), Buffer.from(shot.data, 'base64'));
      }
      console.log('');
    }
  }
} finally {
  chrome.close();
  server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
