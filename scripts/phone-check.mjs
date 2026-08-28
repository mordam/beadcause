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
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../lib/config.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const VP = { width: 393, height: 852, dpr: 3 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
// `--id=<bead>` opens the graph the way "What this is blocking" does, and asserts
// that bead ends up under the glass rather than somewhere off screen.
const ID = (process.argv.find((a) => a.startsWith('--id=')) || '').slice(5);
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
  const trm = t.match(/translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/);
  const tr = trm ? [+trm[1], +trm[2]] : [0, 0];
  const W = main ? main.clientWidth : 0, H = main ? main.clientHeight : 0;
  const clientBox = main ? main.getBoundingClientRect() : { left: 0, top: 0, right: 0, bottom: 0 };
  let on = 0, over = 0;
  for (const n of nodes) {
    const r = n.getBoundingClientRect();
    if (r.right > clientBox.left && r.left < clientBox.right && r.bottom > clientBox.top && r.top < clientBox.bottom) on++;
    over = Math.max(over, clientBox.left - r.left, r.right - clientBox.right, clientBox.top - r.top, r.bottom - clientBox.bottom);
  }
  // The same box fit() itself now measures — gNodes' own drawn extent — rather than
  // rebuilding one from node centres plus a hardcoded 132x40, which drifts from
  // whatever fit() actually frames the moment the two stop being computed the same
  // way. A bare width/height, with no pad: this line reports what is drawn, not the
  // margin fit() adds around it.
  const nodesGroup = document.querySelector('g.nodes');
  const sceneBox = nodesGroup && nodesGroup.getBBox ? nodesGroup.getBBox() : { width: 0, height: 0 };
  return {
    nodes: nodes.length,
    onScreen: on,
    overflow: Math.round(over),
    k: +k.toFixed(4),
    viewport: [W, H],
    box: nodes.length ? [Math.round(sceneBox.width), Math.round(sceneBox.height)] : [0, 0],
    settled: (document.getElementById('growth') || {}).hidden === true,
    loupe: (() => {
      const rim = document.querySelector('.loupe-rim');
      const use = document.querySelector('.loupe use');
      if (!rim || !use || rim.getAttribute('display') === 'none') return { up: false };
      const m = +((use.getAttribute('transform') || '').match(/scale\\(([-\\d.]+)\\)/) || [0, 1])[1];
      const R = +rim.getAttribute('r');
      const cx = +rim.getAttribute('cx'), cy = +rim.getAttribute('cy');
      // Beads whose magnified position lands inside the glass, and how many of
      // them sit shoulder to shoulder across its middle.
      const seen = [];
      for (const n of document.querySelectorAll('g.gn')) {
        const mt = (n.getAttribute('transform') || '').match(/translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/);
        if (!mt) continue;
        const sx = m * (+mt[1] * k + tr[0]) + cx * (1 - m);
        const sy = m * (+mt[2] * k + tr[1]) + cy * (1 - m);
        if (Math.hypot(sx - cx, sy - cy) <= R) seen.push([sx, sy]);
      }
      const band = seen.filter(p => Math.abs(p[1] - cy) < 40 * m * k * 1.5).length;
      const fits = Math.floor((2 * R) / (132 * m * k));
      const ret = document.querySelector('g.gn.reticled');
      const label = document.getElementById('reticle-label');
      return {
        up: true, m: +m.toFixed(3), r: R,
        innerK: +(m * k).toFixed(3),
        inGlass: seen.length,
        acrossMiddle: band,
        fitsAcross: fits,
        reticled: !!ret,
        label: label && !label.hidden ? [...label.children].map(e => e.textContent.trim()).join(' — ') || label.textContent.trim() : null,
      };
    })(),
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

const { s, close } = await launchChrome('beadcause-phone-');
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
  //
  // `?t=` on both navigations, not just in localStorage: this is the one check script
  // that drives the *live* daemon, and with Google sign-in configured a document
  // request carrying no credential is answered with the login page (lib/server.js).
  // localStorage is set after the first navigation, so it cannot help that one.
  const t = `t=${encodeURIComponent(cfg.token || '')}`;
  await s.send('Page.navigate', { url: `${BASE}/?${t}` });
  await sleep(1200);
  await evalJs(s, `localStorage.setItem('beadcause.token', ${JSON.stringify(cfg.token)})`);
  const url = `${BASE}/graph?ws=${encodeURIComponent(WS)}${ID ? `&id=${encodeURIComponent(ID)}&scope=all` : ''}&${t}`;
  await s.send('Page.navigate', { url });

  console.log(`\niPhone 14 Pro ${VP.width}x${VP.height} @${VP.dpr}x · ${url}\n`);

  let p = null;
  for (let i = 0; i < 90; i++) {
    await sleep(1000);
    p = await evalJs(s, PROBE);
    if (p.settled && p.nodes) break;
  }
  // The glass goes up a beat after the layout settles, and when a bead was named
  // it then slides under it — wait for that to finish before measuring.
  await sleep(ID ? 5000 : 3000);
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

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `phone-${WS}.png`);
    const r = await s.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    say('screenshot', file);
  }

  const L = p.loupe || { up: false };
  console.log('\nthe glass in the middle');
  if (L.up) {
    say('magnifies by', `${L.m}x  (scene ${p.k} -> ${L.innerK} inside)`);
    say('radius (css px)', L.r);
    say('bead title inside', `${(p.titlePx * L.innerK).toFixed(1)} css px`);
    say('room for', `${L.fitsAcross} beads across  (${L.inGlass} actually under it)`);
    say('reticle says', L.label || '(nothing under it)');
  } else {
    say('glass', 'down — the scene is already at a readable scale');
  }

  console.log('\nwhat a finger can do');
  // Only for the whole-workspace view. Asking for one bead pans it to the middle,
  // which pushes the far edge of the graph off screen on purpose.
  check(
    'everything on screen',
    ID ? true : p.overflow <= 2,
    ID
      ? `${p.onScreen} of ${p.nodes} still visible after panning to ${ID}`
      : `${p.onScreen} of ${p.nodes} beads visible` + (p.overflow > 0 ? `, worst bead ${p.overflow}px outside the canvas` : '')
  );
  // With few enough beads the scene is already readable and the glass stays down
  // on purpose — so the requirement is "readable one way or the other", and the
  // glass-specific rows only mean something when there is a glass.
  check(
    'a bead is readable',
    L.up ? p.titlePx * L.innerK >= 8 : p.titlePx * p.k >= 8,
    L.up
      ? `${(p.titlePx * L.innerK).toFixed(1)} css px inside the glass`
      : `${(p.titlePx * p.k).toFixed(1)} css px, no glass needed`
  );
  if (L.up) {
    check('room for three across', L.fitsAcross >= 3, `${L.fitsAcross} bead widths across the glass`);
    // A gap in the layout can legitimately land under the reticle, and then the
    // HUD says so — which is a non-empty label naming nothing. Assert only when
    // there is actually something under the glass to name.
    check(
      'reticle names a bead',
      L.inGlass === 0 || L.reticled,
      L.reticled ? L.label : `nothing under the glass (${L.inGlass} beads inside it, none within reach of the reticle)`
    );
  }
  if (ID) check('opened onto that bead', (L.label || '').startsWith(ID), L.label ? `glass holds ${L.label.slice(0, 40)}` : 'nothing under the glass');


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

  // Tap what a finger can see. Under the glass that is the magnified copy, not
  // the speck it was made from — tapping the speck would be testing a thing
  // nobody is looking at, and would select the wrong bead.
  const spot = await evalJs(s, `(() => {
    const scene = document.querySelector('#scene');
    // The bead the brackets are on, or failing that the one nearest the middle
    // that is genuinely inside the glass. Tapping a bead outside it would be
    // aiming at something the magnification does not apply to.
    const ret = document.querySelector('g.gn.reticled');
    if (!ret) return null;
    const box = document.getElementById('graph-main').getBoundingClientRect();
    const t = scene.getAttribute('transform') || '';
    const k = +((t.match(/scale\\(([-\\d.]+)\\)/) || [0, 1])[1]);
    const trm = t.match(/translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/);
    const tr = trm ? [+trm[1], +trm[2]] : [0, 0];
    const mt = (ret.getAttribute('transform') || '').match(/translate\\(([-\\d.]+),\\s*([-\\d.]+)\\)/);
    if (!mt) return null;
    let sx = +mt[1] * k + tr[0], sy = +mt[2] * k + tr[1];
    const rim = document.querySelector('.loupe-rim');
    const use = document.querySelector('.loupe use');
    if (rim && use && rim.getAttribute('display') !== 'none') {
      const m = +((use.getAttribute('transform') || '').match(/scale\\(([-\\d.]+)\\)/) || [0, 1])[1];
      const cx = +rim.getAttribute('cx'), cy = +rim.getAttribute('cy');
      sx = m * sx + cx * (1 - m);
      sy = m * sy + cy * (1 - m);
    }
    return [Math.round(box.left + sx), Math.round(box.top + sy)];
  })()`);
  if (spot) {
    await tap(s, spot[0], spot[1]);
    const tapped = await evalJs(s, PROBE);
    check('tap raises the card', !tapped.cardHidden, tapped.cardHidden ? 'card stayed hidden' : `"${(tapped.cardTitle || '').slice(0, 34)}"`);
  } else {
    console.log('  --   tap raises the card        skipped: no bead under the reticle to tap');
  }

  console.log(failures ? `\n${failures} check${failures === 1 ? '' : 's'} failed.\n` : '\nAll checks passed.\n');
  process.exitCode = failures ? 1 : 0;
} finally {
  close();
}
