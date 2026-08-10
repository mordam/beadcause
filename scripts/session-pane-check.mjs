#!/usr/bin/env node
//
// Does a live session on the advocate console open, and stay open?
//
//   node scripts/session-pane-check.mjs [--out=DIR]
//
// The console absorbed the sessions view, and the one capability that had to be
// carried across rather than merely deleted is the pane under a `claude` row: the
// process facts, and its own Claude Code transcript tailed live. On its old page that
// pane sat on a list which repainted every 45 seconds. Here it sits inside an advocate
// card on a page that repaints every 20 seconds, after every control press, and every
// time any advocate's survey transcript gains a line — so "it keeps its place" is a
// much stronger claim here, and it is the claim nothing else checks.
//
// What is asserted, in order:
//
//   - the row is a button and not a dead <div>, in all three places it appears —
//     inside an advocate card, on a repo with no advocate, and under Elsewhere;
//   - tapping it fills the facts table and the transcript, without waiting for a tick;
//   - a repaint driven by the page itself leaves the pane open, with the same scroll
//     offset, when you had scrolled back up it;
//   - a repaint leaves it pinned to the tail when you were already at the tail;
//   - the advocate's own transcript still pins to its foot, and does not drag the
//     session pane down with it (they are different classes for exactly that reason);
//   - one pane at a time, and tapping the open row shuts it;
//   - a session that exits takes its pane with it rather than leaving a stale one;
//   - a transcript that cannot be read says so in the pane rather than taking the card
//     down.
//
// Real public/*.js in a headless Chrome against fixtures served from this process, so
// nothing here touches a real bead, a real transcript or a running daemon. Like the
// other browser checks it is not in `npm test`, because it needs Chrome.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 2 };
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const ADVOCATED = 4242; // a session in the repo that has an advocate
const PLAIN = 5353; // a session in the repo that has none
const ELSEWHERE = 6464; // a session in no configured workspace
const GONE = 7575; // a session that will exit mid-run

const session = (pid, name, where) => ({
  pid,
  name,
  where,
  cwd: `/Users/x/repos/${where}`,
  workspace: where,
  kind: 'interactive',
  status: 'busy',
  sessionId: `${pid}`.repeat(4) + '-aaaa-bbbb-cccc-dddddddddddd',
  startedAt: '2026-08-10T09:00:00Z',
  at: '2026-08-10T09:20:00Z',
});

/* Long enough that the pane really scrolls: "it kept its offset" says nothing at all
   about a pane with nowhere to scroll to. */
const LINES = Array.from({ length: 120 }, (_, i) => `line ${String(i + 1).padStart(3, '0')} of the transcript`);
const FIRST = LINES[0];
const LAST = LINES[LINES.length - 1];

/* The advocate's own survey transcript, which grows on the second poll — that growth
   is what makes the page repaint under the open session pane. */
let advocateLines = ['[advocate] surveying demo', '> bd ready --json'];
let sessionGone = false;

const work = () => ({
  observing: false,
  workspaces: [
    {
      name: 'demo',
      counts: { open: 5, ready: 2, inProgress: 1 },
      working: [{ id: 'de-1', title: 'a claimed bead', actor: 'someone', since: '2026-08-10T08:00:00Z' }],
      sessions: sessionGone
        ? [session(ADVOCATED, 'demo - the one that stays', 'demo')]
        : [session(ADVOCATED, 'demo - the one that stays', 'demo'), session(GONE, 'demo - the one that exits', 'demo')],
    },
    {
      name: 'plain',
      counts: { open: 2, ready: 1 },
      working: [],
      sessions: [session(PLAIN, 'plain - no advocate here', 'plain')],
    },
  ],
  advocates: [
    {
      workspace: 'demo',
      workers: [{ id: 'de-9', title: 'a bead it opened a window on', claimed: true, at: '2026-08-10T09:10:00Z', attempt: 1 }],
      limit: 3,
      queue: 2,
      paused: false,
      quiet: false,
      surveying: true, // forces the Thinking panel open, so pumpLogs repaints the page
      next: [{ id: 'de-2', title: 'the next one', priority: 2, type: 'task', createdAt: '2026-08-10T07:00:00Z' }],
      lastSurveyAt: '2026-08-10T09:19:00Z',
      lastLaunchAt: '2026-08-10T09:10:00Z',
      lastProposalAt: null,
    },
  ],
  elsewhere: [session(ELSEWHERE, 'somewhere else entirely', 'scratch')],
});

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
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (b, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(b));
    };

    if (p === '/api/work') return json(work());
    if (p === '/api/questions') return json({ questions: [], workspaces: ['demo'], spaces: [], scope: 'human' });
    if (p === '/api/advocate-log') return json({ lines: advocateLines, running: true });
    if (p === '/api/session-log') {
      const pid = Number(url.searchParams.get('pid'));
      // The one that exits: 404 afterwards, exactly as the daemon answers for a pid
      // that is no longer running.
      if (pid === GONE && sessionGone) return json({ error: `no session running as pid ${pid}` }, 404);
      // A repo whose transcript cannot be read. The pane has to say so in place.
      if (pid === PLAIN) return json({ error: 'the transcript could not be read' }, 500);
      return json({ pid, sessionId: `${pid}`, status: 'busy', file: `/Users/x/.claude/projects/x/${pid}.jsonl`, lines: LINES });
    }
    // The mirror pane parks a long-poll here; answering it at once would spin.
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (p === '/api/presence' || p.startsWith('/api/')) return json({});

    let rel = p;
    if (rel === '/monitor' || rel === '/advocates' || rel === '/sessions' || rel === '/work') rel = '/monitor.html';
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-session-pane-'));
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
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

async function waitFor(s, expr, tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(s, `!!(${expr})`)) return true;
    await sleep(250);
  }
  return false;
}

/* ------------------------------------------------------------------- probes */

const tap = (pid) => `(() => {
  const b = document.querySelector('[data-session="${pid}"]');
  if (!b) return false;
  b.click();
  return true;
})()`;

/** Everything about the open pane, in one round trip. */
const PANE = `(() => {
  const pre = document.querySelector('[data-session-log]');
  const rows = [...document.querySelectorAll('[data-session]')];
  const open = rows.filter((r) => r.getAttribute('aria-expanded') === 'true');
  const facts = [...document.querySelectorAll('.session-detail .session-facts div')].map((d) => [
    d.querySelector('dt').textContent,
    d.querySelector('dd').textContent,
  ]);
  const mon = document.querySelector('.mon-log');
  return {
    rows: rows.length,
    tags: [...new Set(rows.map((r) => r.tagName.toLowerCase()))],
    openRows: open.length,
    openPid: open[0] ? open[0].dataset.session : null,
    panes: document.querySelectorAll('.session-detail').length,
    facts,
    text: pre ? pre.textContent : null,
    top: pre ? Math.round(pre.scrollTop) : null,
    scrollable: pre ? pre.scrollHeight > pre.clientHeight + 20 : false,
    atBottom: pre ? pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40 : null,
    maxH: pre ? Math.round(parseFloat(getComputedStyle(pre).maxHeight)) : null,
    // The advocate's own transcript, which must be at its foot and must not be the
    // same element as the session pane.
    monPinned: mon ? mon.scrollHeight - mon.scrollTop - mon.clientHeight < 40 : null,
    monIsPane: mon ? mon.hasAttribute('data-session-log') : null,
  };
})()`;

let failures = 0;
const ok = (pass, msg) => {
  if (!pass) failures++;
  console.log(`  ${pass ? '✓' : '✗'} ${msg}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const chrome = await launch();
const { s } = chrome;
const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const png = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(png.data, 'base64'));
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: VP.width, height: VP.height, deviceScaleFactor: VP.dpr, mobile: true });
  console.log(`${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: BASE + '/monitor' });
  await sleep(600);
  await evalJs(s, `localStorage.setItem('beadcause.token', 'x'); localStorage.setItem('beadcause.mirror.tab', 'advocates')`);
  // Every section open, so all three kinds of session row are on the page at once.
  await evalJs(
    s,
    `localStorage.setItem('beadcause.mon.open', JSON.stringify(['demo:work','demo:next','demo:log','demo:else']))`
  );
  await s.send('Page.navigate', { url: BASE + '/monitor' });
  if (!(await waitFor(s, `document.querySelectorAll('[data-session]').length >= 4`)))
    throw new Error('the console never drew its session rows');

  /* ---- the rows themselves ---- */
  console.log('the rows');
  const before = await evalJs(s, PANE);
  ok(before.rows === 4, `all four sessions are on the page — advocate card, plain card, elsewhere (${before.rows})`);
  ok(
    before.tags.length === 1 && before.tags[0] === 'button',
    `every session row is a button, not a dead div — ${before.tags.join('/')}`
  );
  ok(before.panes === 0, 'nothing is open before you tap anything');

  /* ---- opening one ---- */
  console.log('\nopening one, inside an advocate card');
  ok(await evalJs(s, tap(ADVOCATED)), 'the row takes a tap');
  // Deliberately short: the pane must fill on the tap, not on the 2.5s tick.
  const filled = await waitFor(s, `(document.querySelector('[data-session-log]')||{}).textContent?.includes(${JSON.stringify(LAST)})`, 8);
  const opened = await evalJs(s, PANE);
  ok(filled, 'the transcript arrives on the tap rather than on the next tick');
  ok(opened.openRows === 1 && opened.openPid === String(ADVOCATED), `exactly one row is expanded (${opened.openRows})`);
  const want = ['where', 'workspace', 'process', 'started', 'active', 'session'];
  ok(
    opened.facts.length === 6 && want.every((k, i) => opened.facts[i][0] === k),
    `the facts table is the six process facts — ${opened.facts.map(([k]) => k).join(', ')}`
  );
  ok(
    opened.facts.every(([, v]) => v && v !== 'not recorded'),
    `every fact is populated — ${JSON.stringify(opened.facts.find(([, v]) => !v || v === 'not recorded') || 'all')}`
  );
  ok(/ago/.test(opened.facts[3][1]) && !/^surveyed|^launched/.test(opened.facts[3][1]), `"started" reads as a plain time — ${opened.facts[3][1]}`);
  ok(opened.maxH === Math.round(0.34 * VP.height), `the pane is capped at 34vh inside a card, not 52 — ${opened.maxH}px`);
  ok(opened.monIsPane === false, 'the session pane is not a .mon-log, so pumpLogs cannot drag it to its foot');
  // The pane is several sections down a full card, so put it on screen before the
  // shot: what it looks like is the one thing none of the numbers above can say.
  await evalJs(s, `document.querySelector('.session-detail').scrollIntoView({ block: 'center' })`);
  await sleep(200);
  await shot('pane-open');

  /* ---- a repaint, with the pane scrolled back ---- */
  console.log('\nand a repaint under it');
  ok(opened.scrollable, 'the pane has somewhere to scroll to');
  ok(opened.atBottom, 'it opens at the tail, which is the line you came for');
  await evalJs(s, `document.querySelector('[data-session-log]').scrollTop = 0`);
  // Make the advocate's own transcript grow: that is what drives a repaint from the
  // page itself, at the moment you are reading the session pane.
  advocateLines = [...advocateLines, '> bd show de-2 --json', '[advocate] nothing worth proposing'];
  const repainted = await waitFor(s, `document.querySelector('.mon-log')?.textContent.includes('nothing worth proposing')`, 40);
  const after = await evalJs(s, PANE);
  ok(repainted, "the advocate's own transcript grew, which repaints the page");
  ok(after.openRows === 1 && after.openPid === String(ADVOCATED), 'the pane is still open after it');
  ok(after.text?.includes(FIRST), 'and still holds the transcript, rather than blanking to "opening…"');
  ok(after.top === 0, `and is exactly where you left it — scrollTop ${after.top}`);
  ok(after.monPinned, "while the advocate's transcript is pinned to its own foot");

  /* ---- a repaint while you were at the tail ---- */
  await evalJs(s, `(() => { const p = document.querySelector('[data-session-log]'); p.scrollTop = p.scrollHeight; })()`);
  advocateLines = [...advocateLines, '[advocate] done'];
  await waitFor(s, `document.querySelector('.mon-log')?.textContent.includes('[advocate] done')`, 40);
  const tailing = await evalJs(s, PANE);
  ok(tailing.atBottom, 'at the tail, a repaint follows the tail');

  /* ---- and a repaint you asked for ---- */
  console.log('\nand a control press, which repaints everything');
  await evalJs(s, `document.querySelector('[data-session-log]').scrollTop = 0`);
  ok(await evalJs(s, `!!document.querySelector('[data-adv="pause"]')?.click() || true`), 'Pause is pressed');
  // control() POSTs, then awaits a full load() — the heaviest repaint on the page.
  await waitFor(s, `document.querySelector('[data-adv]')?.textContent.trim() !== '…'`, 40);
  await sleep(400);
  const pressed = await evalJs(s, PANE);
  ok(pressed.openRows === 1 && pressed.panes === 1, `the pane survives it (${pressed.panes} panes)`);
  ok(pressed.top === 0, `with its scroll position — scrollTop ${pressed.top}`);

  /* ---- one at a time ---- */
  console.log('\none at a time');
  await evalJs(s, tap(ELSEWHERE));
  await waitFor(s, `document.querySelector('[data-session="${ELSEWHERE}"]').getAttribute('aria-expanded') === 'true'`, 20);
  const swapped = await evalJs(s, PANE);
  ok(swapped.openRows === 1 && swapped.openPid === String(ELSEWHERE), `opening another closes the first (${swapped.openRows} open)`);
  ok(swapped.panes === 1, 'and there is one pane on the page, not two');
  await evalJs(s, tap(ELSEWHERE));
  await sleep(400);
  ok((await evalJs(s, PANE)).panes === 0, 'tapping the open row shuts it');

  /* ---- a transcript that cannot be read ---- */
  console.log('\nwhen the transcript cannot be read');
  await evalJs(s, tap(PLAIN));
  const said = await waitFor(s, `(document.querySelector('[data-session-log]')||{}).textContent?.startsWith('⚠')`, 20);
  const failedPane = await evalJs(s, PANE);
  ok(said, `the failure is written into the pane — ${JSON.stringify((failedPane.text || '').slice(0, 60))}`);
  ok(
    await evalJs(s, `document.querySelectorAll('.mon-card').length >= 1 && !!document.querySelector('[data-session="${ADVOCATED}"]')`),
    'and the cards are all still there — a failed transcript does not take the page down'
  );
  await evalJs(s, tap(PLAIN));
  await sleep(300);

  /* ---- a session that exits ---- */
  console.log('\nwhen the session exits');
  await evalJs(s, tap(GONE));
  await waitFor(s, `document.querySelectorAll('.session-detail').length === 1`, 20);
  ok(true, 'its pane is open');
  sessionGone = true;
  await evalJs(s, `document.getElementById('refresh').click()`);
  const closed = await waitFor(s, `document.querySelectorAll('[data-session]').length === 3`, 40);
  await sleep(400);
  const gone = await evalJs(s, PANE);
  ok(closed, 'the row goes when the process does');
  ok(gone.panes === 0 && gone.openRows === 0, `and takes its pane with it rather than leaving a stale one (${gone.panes} panes)`);
  ok(
    await evalJs(s, `document.querySelectorAll('[data-session]').length === 3 && !!document.querySelector('[data-session="${ADVOCATED}"]')`),
    'the sessions that are still running are untouched'
  );
  await shot('pane-after-exit');
} finally {
  chrome.close();
  server.closeAllConnections?.();
  server.close();
}

console.log(failures ? `\n${failures} failed` : '\nall passed');
process.exit(failures ? 1 : 0);
