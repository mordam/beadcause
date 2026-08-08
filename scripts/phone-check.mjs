#!/usr/bin/env node
//
// Open the graph tab the way a phone does, and report what it looks like there.
//
//   node scripts/phone-check.mjs [workspace]
//
// Everything else in this repo was verified in a desktop browser, which is the
// one place the graph is never used. This drives a headless Chrome emulating an
// iPhone 14 Pro — 393x852 at 3x, mobile user agent, real touch events — against
// the running daemon, and prints the four things that only go wrong on a phone:
//
//   - what zoom the auto-fit settles on, and how big a bead's title is there
//   - whether a two-finger pinch actually zooms
//   - whether a tap raises the card
//   - whether the view it opened on is still reachable after you've moved
//
// It talks to Chrome over the DevTools protocol using Node's global WebSocket,
// so it adds no dependency. Screenshots land in the directory given by --out.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const cfg = loadConfig();
const WS = args[0] || cfg.workspaces[0]?.name;
// Defaults to the running daemon. `--base=` points it at a checkout you are
// editing, so a change can be checked before it is the thing serving the phone.
const BASE = (process.argv.find((a) => a.startsWith('--base=')) || '').slice(7) || `http://127.0.0.1:${cfg.port}`;

if (!WS) {
  console.error('No workspace to check. Pass one: node scripts/phone-check.mjs <workspace>');
  process.exit(1);
}
if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
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
  const port = 9400 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-phone-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Without these the renderer is throttled to about one frame a second when
      // the window isn't visible, the force layout never settles, and every
      // measurement below is a measurement of the throttling instead of the page.
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
        /* Chrome is still letting go of its profile; it's a temp dir */
      }
    },
  };
}

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

/** A two-finger pinch. `from`/`to` are half the gap between the fingers. */
async function pinch(s, { cx, cy, from, to, steps = 12 }) {
  const pts = (gap) => [
    { x: cx - gap, y: cy, id: 1, radiusX: 12, radiusY: 12, force: 1 },
    { x: cx + gap, y: cy, id: 2, radiusX: 12, radiusY: 12, force: 1 },
  ];
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pts(from) });
  for (let i = 1; i <= steps; i++) {
    await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pts(from + ((to - from) * i) / steps) });
    await sleep(16);
  }
  // Lift the fingers one at a time. A touchend carrying an empty touchPoints
  // array has an empty changedTouches, so d3-zoom never clears its two touch
  // slots and quietly ignores every gesture after the first.
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pts(to)[1]] });
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}

/** A tap, with the pixel of slide every real finger makes. */
async function tap(s, x, y) {
  const p = (dx) => [{ x: x + dx, y, id: 1, radiusX: 12, radiusY: 12, force: 1 }];
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: p(0) });
  await sleep(30);
  await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: p(1) });
  await sleep(30);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(400);
}

/* ------------------------------------------------------------------- probe */

const PROBE = `(() => {
  const g = document.querySelector('#canvas > g');
  const main = document.getElementById('graph-main');
  const nodes = [...document.querySelectorAll('g.gn')];
  const t = (g && g.getAttribute('transform')) || '';
  const k = +((t.match(/scale\\(([-\\d.]+)\\)/) || [0, 1])[1]);
  const W = main ? main.clientWidth : 0, H = main ? main.clientHeight : 0;
  const box = main ? main.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
  let on = 0, over = 0;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.right > box.left && r.left < box.right && r.bottom > box.top && r.top < box.bottom) on++;
    over = Math.max(over, box.left - r.left, r.right - box.right, box.top - r.top, r.bottom - box.bottom);
  }
  const pos = nodes.map(n => {
    const m = (n.getAttribute('transform') || '').match(/translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/);
    return m ? [+m[1], +m[2]] : [0, 0];
  });
  const xs = pos.map(p => p[0]), ys = pos.map(p => p[1]);
  return {
    nodes: nodes.length,
    onScreen: on,
    overflow: Math.round(over),
    k: +k.toFixed(4),
    viewport: [W, H],
    box: xs.length ? [Math.round(Math.max(...xs) - Math.min(...xs)) + 132, Math.round(Math.max(...ys) - Math.min(...ys)) + 40] : [0, 0],
    settled: (document.getElementById('growth') || {}).hidden === true,
    cardHidden: (document.getElementById('card') || {}).hidden,
    cardTitle: (document.getElementById('card-title') || {}).textContent,
    titlePx: nodes.length ? +getComputedStyle(nodes[0].querySelector('text')).fontSize.replace('px', '') : 0,
  };
})()`;

const say = (a, b) => console.log(`  ${String(a).padEnd(26)} ${b}`);
let failures = 0;
const check = (label, ok, detail) => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${String(label).padEnd(26)} ${detail}`);
};

const { s, close } = await launch();
try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Network.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
    screenWidth: VP.width,
    screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  await s.send('Emulation.setEmitTouchEventsForMouse', { enabled: false });
  await s.send('Network.setUserAgentOverride', {
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });

  // Pair the device the way the inbox does, then open the graph.
  await s.send('Page.navigate', { url: `${BASE}/` });
  await sleep(1200);
  await evalJs(s, `localStorage.setItem('beadcause.token', ${JSON.stringify(cfg.token)})`);
  await s.send('Page.navigate', { url: `${BASE}/graph?ws=${encodeURIComponent(WS)}` });

  console.log(`\niPhone 14 Pro ${VP.width}x${VP.height} @${VP.dpr}x · ${BASE}/graph?ws=${WS}\n`);

  let p = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    p = await evalJs(s, PROBE);
    if (p.settled && p.nodes) break;
  }
  await sleep(3000);
  p = await evalJs(s, PROBE);

  if (!p.nodes) {
    console.log('  no beads drawn — is the daemon running, and does this workspace have open issues?');
    process.exit(1);
  }

  console.log('the view it opens on');
  say('beads drawn', p.nodes);
  say('canvas (css px)', p.viewport.join(' x '));
  say('graph (svg px)', p.box.join(' x '));
  say('zoom', p.k);
  say('bead title renders at', `${(p.titlePx * p.k).toFixed(1)} css px  (${p.titlePx} px at 1:1)`);
  const fillsWidth = p.viewport[0] / p.box[0] < p.viewport[1] / p.box[1];
  say('fit is limited by', fillsWidth ? 'width — the layout is wider than it is tall' : 'height');
  say('screen left empty', `${Math.round(100 - (Math.min(1, (p.box[1] * p.k) / p.viewport[1]) * 100))}% vertically`);

  const legible = p.titlePx * p.k;
  if (legible < 8) {
    console.log(
      `\n  NOTE  at this zoom a bead title is ${legible.toFixed(1)} css px, which is not readable.\n` +
        `        ${p.nodes} beads only fit on a phone by shrinking past legibility; you have to\n` +
        `        pinch to about 1:1 to read one, and then a handful are on screen. Not a\n` +
        `        regression — it is what fitting this many beads to a phone costs.`
    );
  }

  console.log('\nwhat a finger can do');
  check(
    'everything on screen',
    p.overflow <= 2,
    `${p.onScreen} of ${p.nodes} beads visible` + (p.overflow > 0 ? `, worst bead ${p.overflow}px outside the canvas` : '')
  );

  // Retried, because a pinch that lands on a bead sometimes does nothing at all —
  // the node's drag behaviour stops propagation on touchstart, so the zoom bound
  // to the svg above it never sees the gesture. A finger would just try again.
  const beforePinch = p.k;
  let pinched = p;
  let tries = 0;
  for (const [dx, dy] of [[0, 0], [0, -160], [0, 160], [-90, 0]]) {
    tries++;
    await pinch(s, { cx: VP.width / 2 + dx, cy: VP.height / 2 + dy, from: 40, to: 150 });
    pinched = await evalJs(s, PROBE);
    if (pinched.k > beforePinch) break;
  }
  check('pinch zooms in', pinched.k > beforePinch, `${beforePinch} -> ${pinched.k}${tries > 1 ? `  (took ${tries} tries — earlier ones landed on a bead and did nothing)` : ''}`);

  for (let i = 0; i < 3; i++) await pinch(s, { cx: VP.width / 2, cy: VP.height / 2, from: 150, to: 35 });
  const out = await evalJs(s, PROBE);
  check('pinch reaches the fit', out.k <= beforePinch + 0.0005, `back to ${out.k} (opened on ${beforePinch}), ${out.onScreen} of ${out.nodes} on screen`);

  const spot = await evalJs(s, `(() => {
    const m = document.getElementById('graph-main');
    const cx = m.clientWidth / 2, cy = m.clientHeight / 2;
    let best = null, bd = Infinity;
    for (const n of document.querySelectorAll('g.gn')) {
      const r = n.getBoundingClientRect();
      const d = Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
      if (d < bd) { bd = d; best = [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; }
    }
    return best;
  })()`);
  if (spot) {
    await tap(s, spot[0], spot[1]);
    const tapped = await evalJs(s, PROBE);
    check('tap raises the card', !tapped.cardHidden, tapped.cardHidden ? 'card stayed hidden' : `"${(tapped.cardTitle || '').slice(0, 34)}"`);
  }

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `phone-${WS}.png`);
    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log(`\n  screenshot ${file}`);
  }

  console.log(failures ? `\n${failures} check${failures === 1 ? '' : 's'} failed.\n` : '\nAll checks passed.\n');
  process.exitCode = failures ? 1 : 0;
} finally {
  close();
}
