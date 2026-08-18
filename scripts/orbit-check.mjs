#!/usr/bin/env node
//
// Do the beads really go round the dot — and does half of the ring really go behind it?
//
//   node scripts/orbit-check.mjs [--keep]
//
// test/orbit.mjs answers everything about *when* the orbit is on screen; it drives both
// real files in a vm and it needs no browser. What it cannot answer is the whole of what
// this feature is: an ellipse, drawn by a stylesheet, half of which has to be occluded by
// a 9px circle. Three of the four things that make it read as an orbit rather than as a
// flat spinner exist only once a browser has composited it —
//
//   - the far half is painted *behind* the dot and the near half in front,
//   - a bead is largest and brightest at the front of the pass and smallest and dimmest
//     at the back, which is the only thing saying the plane is tilted,
//   - and the whole thing fits the 26px the brand row has before it reaches the app mark.
//
// — and each of them fails silently. A stacking context accidentally introduced on `.dot`
// or on either layer puts the whole ring in front, which still looks like an animation;
// a clip that stops being complementary drops a bead for a frame or draws it twice; and a
// widened orbit simply overlaps the one control that leads everywhere.
//
// So: the real style.css, the real report.js and the real orbit.js, in a real headless
// Chrome, against a brand row this file serves itself. No daemon, no beads, no config —
// the page it opens is fixture markup with the same three elements every top bar in the
// app has, which is the whole of what the orbit needs.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const KEEP = process.argv.includes('--keep');

const TYPES = { '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };

// The brand row as every page in the app writes it: the dot, the mark, a title. The
// selectors are `.brand .dot` and `.brand h1.mark`, which is what public/orbit.js and
// public/absorb.js reach for, so a rename in either shows up here as a check that finds
// nothing rather than as a check that quietly passes.
const PAGE = `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>orbit-check</title>
<link rel="stylesheet" href="/style.css"></head>
<body>
<header class="topbar">
  <div class="brand">
    <span class="dot" id="pulse"></span>
    <h1 class="mark"><img src="/icon.svg" alt="Beadcause" width="26" height="26"></h1>
    <h1 id="title">Inbox</h1>
  </div>
</header>
<main style="padding:20px">a page under the bar</main>
<script src="/report.js"></script>
<script src="/orbit.js"></script>
</body></html>`;

/* ------------------------------------------------------------------- fixture */

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/') return res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE);
  // A request this page can hold open for as long as the check wants it to. `?ms` is
  // how long the daemon is pretending to think about it.
  if (url.pathname === '/api/slow') {
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'), Number(url.searchParams.get('ms') || 800));
    return;
  }
  // The long poll, answering the way the real one does: not for ages.
  if (url.pathname === '/api/poll') {
    setTimeout(() => res.writeHead(200, { 'content-type': 'application/json' }).end('{}'), 20000);
    return;
  }
  const file = path.join(PUBLIC, url.pathname.replace(/^\/+/, ''));
  if (file.startsWith(PUBLIC) && fs.existsSync(file) && fs.statSync(file).isFile()) {
    return res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'text/plain' }).end(fs.readFileSync(file));
  }
  res.writeHead(404).end('no');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

/* ---------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = await launchChrome('beadcause-orbit-');
const { s } = chrome;

async function evalJs(expression, awaitPromise = false) {
  const r = await s.send('Runtime.evaluate', { expression, awaitPromise, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'the page threw');
  return r.result.value;
}

try {
  console.log('the orbiting dot');

  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', { width: 393, height: 780, deviceScaleFactor: 3, mobile: true });
  await s.send('Page.navigate', { url: BASE });
  await sleep(1200);

  /* ------------------------------------------------------------ it is built */

  const built = JSON.parse(
    await evalJs(`JSON.stringify({
      layers: document.querySelectorAll('.brand .dot .orbit').length,
      near: document.querySelectorAll('.brand .dot .orbit.near .orbit-bead').length,
      far: document.querySelectorAll('.brand .dot .orbit.far .orbit-bead').length,
      strings: document.querySelectorAll('.brand .dot .orbit-string').length,
      counts: typeof window.beadcause?.requests?.onChange,
    })`)
  );
  check('two halves, seven beads and a string in each', built.layers === 2 && built.near === 7 && built.far === 7 && built.strings === 2, JSON.stringify(built));
  check('the reporter publishes what the page is waiting on', built.counts === 'function', built.counts);

  /* ------------------------------------------------------- it turns, and stops */

  check('nothing is drawn before anything is fetched', (await evalJs("getComputedStyle(document.querySelector('.orbit.near')).display")) === 'none');

  await evalJs("fetch('/api/poll'); 1");
  await sleep(500);
  check('a parked long poll is not a load', (await evalJs('window.beadcause.orbit.running()')) === false);

  await evalJs("window.__slow = fetch('/api/slow?ms=1600'); 1");
  await sleep(80);
  check('nor is a request that has only just left', (await evalJs('window.beadcause.orbit.running()')) === false);
  await sleep(300);
  check('but one that is taking its time is', (await evalJs('window.beadcause.orbit.running()')) === true);
  check('and the stylesheet draws it', (await evalJs("getComputedStyle(document.querySelector('.orbit.near')).display")) === 'block');

  /* ------------------------------------------------- the depth, which is the point */

  // Every animation frozen at the same instant, so the geometry below is one picture
  // rather than seven snapshots of a moving thing.
  await evalJs(`(() => {
    const st = document.createElement('style');
    // Hit testing is how paint order is read back, and the layers are pointer-transparent
    // on purpose (they overlap the app mark). Handed back at the end of the run.
    st.id = 'orbit-check-probe';
    st.textContent = '.orbit-bead { pointer-events: auto !important; }';
    document.head.appendChild(st);
    return 1;
  })()`);

  const depth = JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const dot = document.querySelector('.brand .dot');
      const R = dot.getBoundingClientRect();
      const cx = R.x + R.width / 2, cy = R.y + R.height / 2;
      const read = (half) => [...document.querySelectorAll('.orbit.' + half + ' .orbit-bead')].map((b) => {
        const q = b.getBoundingClientRect();
        return { x: q.x + q.width / 2 - cx, y: q.y + q.height / 2 - cy, r: q.width / 2, o: Number(getComputedStyle(b).opacity) };
      });
      // The frame where a bead of this half is over the dot, and who wins there.
      const occlusion = (half) => {
        for (let t = 0; t <= 2800; t += 25) {
          document.getAnimations().forEach((a) => { a.pause(); a.currentTime = t; });
          const beads = read(half).sort((a, b) => (half === 'far' ? a.y - b.y : b.y - a.y));
          const b = beads[0];
          const py = cy + b.y + (half === 'far' ? b.r * 0.6 : -b.r * 0.6);
          if (Math.hypot(b.x, py - cy) >= R.width / 2 - 0.5) continue;
          const hit = document.elementFromPoint(cx + b.x, py);
          return { t, over: [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10], wins: hit ? hit.className : null };
        }
        return null;
      };
      const far = occlusion('far');
      const near = occlusion('near');
      document.getAnimations().forEach((a) => { a.pause(); a.currentTime = 0; });
      const all = [...read('near'), ...read('far')];
      const front = read('near').sort((a, b) => b.y - a.y)[0];
      const back = read('far').sort((a, b) => a.y - b.y)[0];
      return {
        far, near, front, back,
        widest: Math.max(...all.map((b) => Math.abs(b.x) + b.r)),
        tallest: Math.max(...all.map((b) => Math.abs(b.y) + b.r)),
        mark: document.querySelector('.brand h1.mark').getBoundingClientRect().x - cx,
      };
    })())`)
  );

  check(
    'a bead on the far side is painted behind the dot',
    Boolean(depth.far) && /\bdot\b/.test(depth.far.wins || ''),
    depth.far ? `at ${depth.far.over} the dot wins: ${depth.far.wins}` : 'no far bead ever crossed the dot'
  );
  check(
    'and one on the near side in front of it',
    Boolean(depth.near) && /\borbit-bead\b/.test(depth.near.wins || ''),
    depth.near ? `at ${depth.near.over} the bead wins: ${depth.near.wins}` : 'no near bead ever crossed the dot'
  );
  check(
    'the near bead is the bigger and the brighter of the two',
    depth.front.r > depth.back.r * 1.5 && depth.front.o > depth.back.o * 2,
    `near r=${depth.front.r.toFixed(2)} o=${depth.front.o} · far r=${depth.back.r.toFixed(2)} o=${depth.back.o}`
  );
  check(
    'the orbit is an ellipse, not a circle — the plane is tilted',
    depth.tallest < depth.widest * 0.7,
    `${depth.widest.toFixed(1)}px across, ${depth.tallest.toFixed(1)}px tall`
  );
  check(
    'and it stops short of the app mark beside it',
    depth.widest <= depth.mark,
    `beads reach ${depth.widest.toFixed(1)}px from the dot's centre; the mark starts at ${depth.mark.toFixed(1)}px`
  );

  /* --------------------------------------------------------- it goes away again */

  await evalJs("document.getElementById('orbit-check-probe').remove(); document.getAnimations().forEach(a => a.play()); 1");
  await evalJs('window.__slow', true);
  await sleep(900);
  check('it stops when the request settles', (await evalJs('window.beadcause.orbit.running()')) === false);
  check('and nothing is left drawn', (await evalJs("getComputedStyle(document.querySelector('.orbit.near')).display")) === 'none');

  /* ------------------------------------------------------------ reduced motion */

  await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  await evalJs("document.querySelector('.brand .dot').classList.add('busy'); 1");
  await sleep(300);
  const still = JSON.parse(
    await evalJs(`JSON.stringify((() => {
      const beads = [...document.querySelectorAll('.orbit.near .orbit-bead')];
      const at = () => beads.map((b) => Math.round(b.getBoundingClientRect().x * 100) / 100);
      const first = at();
      return {
        drawn: getComputedStyle(document.querySelector('.orbit.near')).display,
        state: getComputedStyle(beads[0]).animationPlayState,
        spread: Math.max(...first) - Math.min(...first),
        first,
      };
    })())`)
  );
  await sleep(500);
  const later = JSON.parse(await evalJs(`JSON.stringify([...document.querySelectorAll('.orbit.near .orbit-bead')].map((b) => Math.round(b.getBoundingClientRect().x * 100) / 100))`));
  check('under reduce the ring is still drawn', still.drawn === 'block' && still.state === 'paused', `${still.drawn} / ${still.state}`);
  check('the beads are placed round it, not piled on the dot', still.spread > 10, `${still.spread}px between the outermost two`);
  check('and half a second later not one of them has moved', JSON.stringify(still.first) === JSON.stringify(later), `${JSON.stringify(still.first)} then ${JSON.stringify(later)}`);

  /* -------------------------------------------- the page's own `busy` still works */

  check('a page that says `busy` gets the orbit without a request', (await evalJs("getComputedStyle(document.querySelector('.orbit.far')).display")) === 'block');
} finally {
  if (KEEP) {
    console.log(`\nleft open: ${BASE} (Chrome on :${chrome.port})`);
  } else {
    chrome.close();
    server.close();
  }
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed`);
process.exit(bad.length ? 1 : 0);
