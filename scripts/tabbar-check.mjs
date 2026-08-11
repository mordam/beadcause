#!/usr/bin/env node
//
// Does the tab bar hold up on every standing view?
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
// The badge too, on the inbox: Advocates carries the proposal count the poll hands
// it, it stays inside its tab rather than spilling into the next one, and a tab with
// nothing behind it draws nothing.
//
// And `/sessions` is in the list even though it is no longer a page: it redirects to
// the advocate console now, it is still on the phone's home screen, and the failure
// this file exists to catch — a page you cannot leave — is exactly what a stale
// shortcut landing somewhere with no bar would be.
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
    // A claimed bead and a live session, so the advocate console draws a card with
    // something in it rather than an empty one. An empty fixture is how a card taking
    // the whole viewport — over the bar this file exists to check — went unnoticed
    // here for as long as it did.
    {
      name: 'demo',
      working: [{ id: 'de-1', title: 'a claimed bead', actor: 'x', since: '2026-08-01T09:00:00Z' }],
      sessions: [{ pid: 4242, name: 'human.de-1.a-session', where: 'demo', status: 'busy', at: '2026-08-01T09:30:00Z' }],
      counts: { open: 5, ready: 2 },
    },
    { name: 'other', working: [], sessions: [], counts: { open: 1 } },
  ],
  advocates: [
    { workspace: 'demo', state: 'idle', workers: [], paused: false, next: [], limit: 2, queue: 1 },
    { workspace: 'other', state: 'idle', workers: [], paused: false, next: [], limit: 2, queue: 0 },
  ],
  elsewhere: [],
};

/* Two scopes, both with something to stop, so /admin draws its full height — the
   kill button included, since clearing the bar is the thing being measured. */
const ADMIN = {
  reopenIsFresh: false,
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

/* One repo, one row per stage, so the PR board draws its full height — the open row
   that carries the merge button included, since clearing the bar is what is measured. */
const PRS = {
  unavailable: null,
  build: { dir: '/Users/x/repos/demo', commit: 'a'.repeat(40), short: 'aaaaaaa', at: '2026-08-09T09:00:00Z' },
  counts: { open: 1, merged: 1, pushed: 1, deployed: 1, closed: 0, owed: 2 },
  repos: [
    {
      workspace: 'demo',
      repo: 'acme/demo',
      base: 'main',
      error: null,
      deployTracked: true,
      prs: [
        {
          key: 'demo#4',
          workspace: 'demo',
          number: 4,
          url: 'https://example.invalid/pull/4',
          title: 'Still open, waiting on a decision',
          state: 'OPEN',
          draft: false,
          branch: 'worktree-open-a1b',
          base: 'main',
          author: 'someone',
          updatedAt: '2026-08-09T08:00:00Z',
          mergedAt: null,
          mergeCommit: null,
          additions: 120,
          deletions: 4,
          files: 3,
          checks: { state: 'passing', passing: 2, failing: 0, pending: 0, failed: [], total: 2 },
          mergeable: 'MERGEABLE',
          beads: [{ id: 'de-a1b', title: 'a bead', status: 'open' }],
          merged: false,
          pushed: false,
          local: false,
          deployed: false,
          deployTracked: true,
          stage: 'open',
          note: '',
        },
        {
          key: 'demo#3',
          workspace: 'demo',
          number: 3,
          url: 'https://example.invalid/pull/3',
          title: 'Merged and pushed, not shipped',
          state: 'MERGED',
          draft: false,
          branch: 'worktree-owed-c3d',
          base: 'main',
          author: 'someone',
          updatedAt: '2026-08-09T07:00:00Z',
          mergedAt: '2026-08-09T07:00:00Z',
          mergeCommit: 'b'.repeat(40),
          additions: 40,
          deletions: 40,
          files: 2,
          checks: { state: 'none', passing: 0, failing: 0, pending: 0, failed: [], total: 0 },
          mergeable: 'MERGEABLE',
          beads: [{ id: 'de-c3d', title: 'another bead', status: 'closed' }],
          merged: true,
          pushed: true,
          local: true,
          deployed: false,
          deployTracked: true,
          stage: 'pushed',
          note: 'Merged and pushed — but not in the build that is running. Ship it.',
        },
      ],
    },
  ],
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
    if (p === '/api/prs') return json(PRS);
    // The advocate console carries the mirror pane, which parks a long-poll here and
    // restarts it the moment it returns. An immediate empty answer would turn that
    // into a spin loop at full speed against this stub, so park it the way the daemon
    // does — the run is over long before it answers.
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (p.startsWith('/api/')) return json({});
    // The same aliases the real server maps onto one page. `/sessions` and `/work` are
    // the advocate console now — see serveStatic in lib/server.js — and they are here
    // because the bar has to mark Advocates as current on all four of its paths.
    let rel = p;
    if (rel === '/console') rel = '/console.html';
    if (rel === '/prs' || rel === '/pulls') rel = '/prs.html';
    if (rel === '/monitor' || rel === '/advocates' || rel === '/sessions' || rel === '/work') rel = '/monitor.html';
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

/* The advocate console, under two of its four paths — one probe, because it is one
   page and a copy per path would be a copy that could drift. */
const MON_CLEAR = `(() => {
  const cards = [...document.querySelectorAll('#mon .card, #mon .mon-card')];
  const last = cards[cards.length - 1];
  if (!last) return { what: 'last advocate card', missing: true };
  document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
  const r = last.getBoundingClientRect();
  const bar = document.querySelector('.tabbar').getBoundingClientRect();
  return { what: 'last advocate card', bottom: Math.round(r.bottom), barTop: Math.round(bar.top), n: cards.length };
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
  // The last row's buttons — Merge & push, Ship, Comment. A bar over those is a
  // merge where a thumb reaches for a tab, which is the one mis-tap on this page
  // that cannot be taken back.
  '/prs': `(() => {
    const cards = [...document.querySelectorAll('#prs .card')];
    const last = cards[cards.length - 1];
    if (!last) return { what: 'last repo card', missing: true };
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    const r = last.getBoundingClientRect();
    const bar = document.querySelector('.tabbar').getBoundingClientRect();
    return { what: 'last repo card', bottom: Math.round(r.bottom), barTop: Math.round(bar.top), n: cards.length };
  })()`,
  '/monitor': MON_CLEAR,
  // The same page, reached by the path the phone's home screen still holds.
  '/sessions': MON_CLEAR,
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
   than written out as a number, so adding or dropping a tab is one line here and not
   a test that fails with "five tabs: <four of them>". */
const TABS = ['inbox', 'console', 'prs', 'advocates', 'admin'];

const PAGES = [
  { url: '/', tab: 'inbox', name: 'inbox' },
  { url: '/console', tab: 'console', name: 'console' },
  // "PRs" rather than "Pull requests" because five labels share 393px here and 360px
  // on the common Android width. The stylesheet has a `:has(:nth-child(6))` step-down
  // for when a sixth tab arrives; at five it does not apply, and this page is in the
  // list to keep the shortest-label tab measured rather than trusted.
  { url: '/prs', tab: 'prs', name: 'prs' },
  { url: '/monitor', tab: 'advocates', name: 'advocates' },
  // The same page under the path the sessions view left behind. The tab it lights has
  // to be Advocates: a shortcut that lands somewhere the bar calls nothing is a page
  // you cannot tell where you are on.
  // `name` is also a screenshot filename, hence the hyphen rather than an arrow.
  { url: '/sessions', tab: 'advocates', name: 'sessions-redirected' },
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

      // The badge, where the number actually arrives. It rides the inbox's own poll,
      // so this is the one page that has it — and a badge that overflowed its tab
      // would land on the neighbouring one and count the wrong thing.
      //
      // One badge, and it is the proposals: a badge means "needs you", and the running
      // agents the old Sessions tab counted need nothing. `summary.sessions` is still
      // in the fixture because the server still sends it — nothing should draw it here.
      if (page.url === '/') {
        const b = await evalJs(
          s,
          `(() => {
            const of = (id) => {
              const item = document.querySelector('.tab-item[data-tab="' + id + '"]');
              if (!item) return null;
              const el = item.querySelector('.tab-badge');
              const r = el.getBoundingClientRect();
              const box = item.getBoundingClientRect();
              return { text: el.hidden ? null : el.textContent, label: item.getAttribute('aria-label'),
                       inside: r.left >= box.left && r.right <= box.right };
            };
            return { sessions: of('sessions'), advocates: of('advocates'), inbox: of('inbox'), console: of('console') };
          })()`
        );
        ok(b.advocates.text === '1', `the count is on its tab — ${b.advocates.text}`);
        ok(
          /proposals? waiting/.test(b.advocates.label || ''),
          'the badge says what it counts, for a reader that cannot see it'
        );
        ok(b.advocates.inside, 'a badge stays inside its own tab');
        ok(b.sessions === null, 'there is no Sessions tab left to badge');
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
          // Collapse first: an open card's way out is `↑ Collapse` in its top bar,
          // and the details toggle it used to also carry at the foot is gone.
          await evalJs(
            s,
            `document.querySelector('.card.open [data-act="collapse"], .card.open [data-act="toggle"]')?.click()`
          );
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
