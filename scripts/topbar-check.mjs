#!/usr/bin/env node
//
// What the top bar costs on a phone, and whether the space picker's row is still the
// only honest way to draw it.
//
//   node scripts/topbar-check.mjs [--out=DIR]
//
// The picker is a full-width row of its own inside `.topbar` (see `.spacebar` in
// public/style.css), so six pages carry two rows of sticky chrome where they used to
// carry one. bc-hne3 asked whether that is the right trade at 360px and decided the row
// stays — but a decision made once about a number nobody measures again is a decision
// that quietly stops being true. Two rows is a choice; three is an accident, and it is
// the kind that arrives one icon at a time.
//
// So this measures, in a headless Chrome the size of a cheap Android, on every page that
// has a picker:
//
//   * the bar lays out in **at most two lines** — the budget bc-hne3 actually spent;
//   * the picker is on the **last** line, **alone** and **full width** — its whole claim
//     is that it is the frame for everything under it, and a picker sharing a row with
//     three icon buttons is a filter;
//   * its label is **not clipped** — neither the selected one nor the widest row in the
//     dropdown, because a repo name cut to `beadca…` is the failure the row was bought
//     to prevent;
//   * the bar **plus the tab bar** stays inside a **170px** budget on a 640px screen.
//     159px is what it costs today. A third row is +43px and fails this on the spot,
//     which is the whole point of the number being written down.
//
// It also prints the arithmetic that made the decision, per page, and says so when the
// premise has expired: if *every* page's first row grows enough room to hold the picker
// at its full label width, then "the first row is already full" has stopped being true
// and bc-hne3 is worth reopening. Every page and not any page, because three of the six
// have room at 360px today — collapsing only where it fits is what makes the control a
// title on one tab and a chip on the next. That is a notice and not a failure; the tree
// is not broken by getting roomier, but somebody should see it.
//
// Not part of `npm test`: it wants Chrome. Run it when you have touched the top bar, the
// picker, or the icon buttons on any page that has one. `--out=DIR` writes a picture per
// page per width, which is the one thing a column of numbers cannot tell you.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outDir = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The bar plus the tab bar, on a 640px screen. Two rows is 159px today; one would be
   116px. The slack is deliberate and small — enough for a font or a border to move,
   nothing like enough for another row. */
const CHROME_BUDGET = 170;

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- the fixture */

/* Six repos in two spaces, because the bar hides itself under two (`el.hidden` in
   public/spacebar.js) and because the widest row in the dropdown is what has to fit,
   not the shortest. `climative` and `beadcause` carry the counts, so the `· N` tails
   the labels are measured with are the ones that ship. */
const WORKSPACES = ['beadcause', 'climative', 'adam.life', 'deluvia', 'ehatt', 'sophab'];
const SPACES = [
  { name: 'Personal', workspaces: ['beadcause', 'adam.life', 'deluvia', 'ehatt', 'sophab'], count: 3, quiet: false },
  { name: 'Work', workspaces: ['climative'], count: 2, quiet: false },
];
const SPACEPAY = {
  spaces: SPACES,
  workspaces: WORKSPACES,
  counts: { beadcause: 3, climative: 2 },
  trouble: [],
  filter: { space: 'all', workspace: 'all' },
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
    /* Every page's own payload carries the picker's four fields, because a page that
       has a sweep of its own feeds the bar from it rather than fetching twice. */
    if (p === '/api/spaces') return json(SPACEPAY);
    if (p === '/api/questions')
      return json({ questions: [], consoles: [], ...SPACEPAY, scope: 'human', summary: { sessions: 0, proposals: 0, questions: 3 } });
    if (p === '/api/work') return json({ workspaces: [], advocates: [], elsewhere: [], ...SPACEPAY });
    if (p === '/api/prs') return json({ unavailable: null, build: null, counts: {}, repos: [], ...SPACEPAY });
    if (p === '/api/consoles') return json({ consoles: [], ...SPACEPAY });
    if (p === '/api/unendorsed') return json({ beads: [], counts: {}, truncated: false, errors: [], ...SPACEPAY });
    if (p === '/api/foundation') return json({ workspaces: WORKSPACES, agents: [], ...SPACEPAY });
    /* Parked the way the daemon parks it. An immediate empty answer turns the pages
       that poll into a spin loop against this fixture, and the run is over long before
       this timer is. */
    if (p === '/api/poll') {
      const timer = setTimeout(() => {
        if (!res.writableEnded) json({ seq: 1, events: [], presence: [] });
      }, 20000);
      res.on('close', () => clearTimeout(timer));
      return;
    }
    if (p.startsWith('/api/')) return json({});
    let rel = p;
    if (rel === '/console') rel = '/console.html';
    if (rel === '/prs' || rel === '/pulls') rel = '/prs.html';
    if (rel === '/monitor' || rel === '/advocates' || rel === '/sessions' || rel === '/work') rel = '/monitor.html';
    if (rel === '/endorse') rel = '/endorse.html';
    if (rel === '/foundations') rel = '/foundations.html';
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
  const port = 9640 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-topbar-'));
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

/* ------------------------------------------------------------------- probe */

/*
  Lines, not children. `.topbar` is `flex-wrap: wrap` with `align-items: center`, so two
  children on the same line have different `top` values whenever they are different
  heights — grouping by `top` reports the inbox's one row as two. Overlap is the test.

  The label widths are measured with a span carrying the select's own resolved font
  rather than with the select's `scrollWidth`, which under `appearance: none` and
  `text-overflow: ellipsis` reports the box and not the text.
*/
const PROBE = `(() => {
  const bar = document.querySelector('.topbar');
  if (!bar) return { bar: false };
  const cs = getComputedStyle(bar);
  const pad = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
  const gap = parseFloat(cs.columnGap) || 0;
  const kids = [...bar.children].filter((el) => !el.hidden && getComputedStyle(el).display !== 'none');
  const lines = [];
  for (const el of kids) {
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) continue;
    const line = lines.find((L) => r.top < L.bottom - 2 && r.bottom > L.top + 2);
    if (line) {
      line.top = Math.min(line.top, r.top);
      line.bottom = Math.max(line.bottom, r.bottom);
      line.items.push({ cls: el.className, w: Math.round(r.width) });
    } else lines.push({ top: r.top, bottom: r.bottom, items: [{ cls: el.className, w: Math.round(r.width) }] });
  }
  lines.sort((a, b) => a.top - b.top);

  const sb = document.querySelector('.spacebar');
  const shown = !!(sb && !sb.hidden && getComputedStyle(sb).display !== 'none');
  const sel = sb && sb.querySelector('#space-pick');
  const label = (() => {
    if (!sel) return null;
    const c = getComputedStyle(sel);
    const span = document.createElement('span');
    span.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;font-family:' + c.fontFamily +
      ';font-size:' + c.fontSize + ';font-weight:' + c.fontWeight + ';letter-spacing:' + c.letterSpacing;
    document.body.append(span);
    const w = (t) => { span.textContent = t; return Math.ceil(span.getBoundingClientRect().width); };
    const texts = [...sel.options].map((o) => o.textContent);
    const widths = texts.map(w);
    const most = Math.max(...widths);
    const out = {
      selected: w(sel.options[sel.selectedIndex].textContent),
      selectedText: sel.options[sel.selectedIndex].textContent,
      widest: most,
      widestText: texts[widths.indexOf(most)],
      /* The caret is drawn over the right-hand padding, so the text's room is the
         content box — which is what \`clientWidth\` minus the padding already is. */
      room: Math.round(sel.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight)),
    };
    span.remove();
    return out;
  })();

  const brand = document.querySelector('.brand');
  const acts = document.querySelector('.sheet-actions');
  const countEl = document.querySelector('#space-count');
  const brandW = brand ? Math.round(brand.getBoundingClientRect().width) : 0;
  const actsW = acts && acts.getBoundingClientRect().width ? Math.round(acts.getBoundingClientRect().width) : 0;
  const countW = countEl && !countEl.hidden ? Math.round(countEl.getBoundingClientRect().width) + gap : 0;
  const tab = document.querySelector('.tabbar');

  return {
    bar: true,
    barH: Math.round(bar.getBoundingClientRect().height),
    /* The bar's own content box, not \`innerWidth - pad\`: a page that lays out wider
       than the screen has been shrink-fitted by the browser, and then every number
       here is in a different unit from the viewport. Which page that is gets its own
       notice below — the picker filling its bar is true either way. */
    content: Math.round(bar.clientWidth - pad),
    layoutW: Math.round(innerWidth),
    gap,
    lines: lines.map((L) => ({ top: Math.round(L.top), h: Math.round(L.bottom - L.top), items: L.items })),
    picker: shown ? { w: Math.round(sb.getBoundingClientRect().width), h: Math.round(sb.getBoundingClientRect().height), label } : null,
    /* What a picker joining the first row would have, and what it would need there —
       the arithmetic bc-hne3 turned on. */
    /* The bar's own box again, so this is in the same units as \`need\` on a page the
       browser has scaled (see \`content\`). The trailing gap is the one a picker joining
       this row would need in front of it. */
    spare: Math.round(bar.clientWidth - pad - brandW - (actsW ? actsW + gap : 0) - gap),
    need: label ? label.widest + Math.round(parseFloat(getComputedStyle(sel).paddingLeft) + parseFloat(getComputedStyle(sel).paddingRight)) + countW : null,
    brandW,
    actsW,
    tabH: tab ? Math.round(tab.getBoundingClientRect().height) : 0,
    vh: innerHeight,
  };
})()`;

/* Every page with a picker. The admin page is deliberately not one (it acts on every
   repo at once) and the drawers — /graph, /doc, /session, /terminal — are not standing
   views, so neither carries a `.spacebar` to measure. */
const PAGES = ['/', '/monitor', '/console', '/prs', '/endorse', '/foundations'];

/* 360px is the cheap Android the app is for and the width the trade was argued at; 393
   is the phone in the hand. Both, because a rule that only holds at one width holds by
   accident. */
const SIZES = [
  { width: 360, height: 640 },
  { width: 393, height: 852 },
];

/* ------------------------------------------------------------------- run */

let failures = 0;
const notices = [];
const room = [];
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}`);
  if (detail) console.log(`      ${detail}`);
};

const server = await serve();
const { port } = server.address();
const { s, close } = await launch();
try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  if (outDir) fs.mkdirSync(outDir, { recursive: true });

  for (const size of SIZES) {
    console.log(`\n\x1b[1m${size.width}×${size.height}\x1b[0m`);
    await s.send('Emulation.setDeviceMetricsOverride', { ...size, deviceScaleFactor: 2, mobile: true });
    const pickerHeights = new Map();

    for (const page of PAGES) {
      await s.send('Page.navigate', { url: `http://127.0.0.1:${port}${page}?t=topbar-check` });
      await sleep(1100);
      /* Fed rather than fetched, the way a page with its own sweep feeds it — four of
         these pages draw the bar from a payload this fixture also answers, and waiting
         on whichever path each one takes would be measuring the fixture. */
      await evalJs(s, `window.beadcause && window.beadcause.space && window.beadcause.space.adopt(${JSON.stringify(SPACEPAY)}), 1`);
      /* The inbox's chip, with a real number in it. The first row's width is the whole
         question and an empty inbox hides 75px of it. */
      await evalJs(
        s,
        `(() => { const w = document.querySelector('.waiting'); if (w) { w.innerHTML = '3 <span class="word">waiting</span>'; w.hidden = false; } return 1; })()`
      );
      await sleep(250);
      const m = await evalJs(s, PROBE);
      const at = `${page} @${size.width}`;

      if (!m.bar) {
        bad(`${at}: the page has a top bar`);
        continue;
      }
      if (!m.picker) {
        bad(`${at}: the space picker is drawn`, 'no .spacebar — the page may have lost its <script src="/spacebar.js">');
        continue;
      }

      // Two rows is the budget bc-hne3 spent. Three is what this file exists to catch.
      if (m.lines.length <= 2) ok(`${at}: the bar is ${m.lines.length} line(s), ${m.barH}px`);
      else
        bad(
          `${at}: the bar is ${m.lines.length} lines, ${m.barH}px`,
          m.lines.map((L) => L.items.map((i) => `${i.cls || '(none)'} ${i.w}px`).join(' + ')).join('  /  ')
        );

      // Last, alone, full width — the three halves of "it is a title, not a filter".
      const last = m.lines[m.lines.length - 1];
      const alone = last.items.length === 1 && /spacebar/.test(last.items[0].cls || '');
      if (alone && Math.abs(m.picker.w - m.content) <= 2)
        ok(`${at}: the picker has the last line to itself, full width (${m.picker.w}px of ${m.content}px)`);
      else
        bad(
          `${at}: the picker has the last line to itself, full width`,
          `last line is ${last.items.map((i) => `${i.cls || '(none)'} ${i.w}px`).join(' + ')}; picker ${m.picker.w}px of ${m.content}px`
        );

      // A name cut to `beadca…` is the failure the row was bought to prevent.
      const L = m.picker.label;
      if (L.room >= L.widest) ok(`${at}: no label is clipped (${L.room}px of room, widest "${L.widestText}" ${L.widest}px)`);
      else
        bad(
          `${at}: no label is clipped`,
          `${L.room}px of room, but "${L.widestText}" needs ${L.widest}px (selected "${L.selectedText}" needs ${L.selected}px)`
        );

      // One control, the same on every page — including how tall it is.
      pickerHeights.set(page, m.picker.h);

      // The budget. It is a phone: the list is what the screen is for.
      const chrome = m.barH + m.tabH;
      const pct = Math.round((chrome / m.vh) * 100);
      if (chrome <= CHROME_BUDGET) ok(`${at}: sticky chrome ${chrome}px (${pct}% of ${m.vh}px), budget ${CHROME_BUDGET}px`);
      else bad(`${at}: sticky chrome within ${CHROME_BUDGET}px`, `bar ${m.barH}px + tab bar ${m.tabH}px = ${chrome}px, ${pct}% of the screen`);

      // The premise, restated every run. Not a failure — see the header.
      room.push({ at, page, width: size.width, spare: m.spare, need: m.need, brandW: m.brandW, actsW: m.actsW });

      /* Does the page fit the screen at all? A page laying out wider than the viewport
         has been shrink-fitted by the browser, so it is not the size it was designed
         at. /monitor is 376px at a 360px screen today — bc-3ui6 — and this is a notice
         rather than an assertion so that this file does not ship red. When that bead
         lands, the notice goes quiet and this can become one. */
      if (m.layoutW > size.width)
        notices.push(
          `\x1b[33m!\x1b[0m ${at}: the page lays out at ${m.layoutW}px on a ${size.width}px screen, so the browser has scaled it to ${Math.round((size.width / m.layoutW) * 100)}% — known, bc-3ui6.`
        );

      if (outDir) {
        const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
        fs.writeFileSync(path.join(outDir, `topbar-${page === '/' ? 'inbox' : page.slice(1)}-${size.width}.png`), Buffer.from(data, 'base64'));
      }
    }

    const heights = [...new Set(pickerHeights.values())];
    if (heights.length === 1) ok(`@${size.width}: the picker is the same ${heights[0]}px on all ${pickerHeights.size} pages`);
    else
      bad(
        `@${size.width}: the picker is the same height on every page`,
        [...pickerHeights].map(([p, h]) => `${p} ${h}px`).join(', ')
      );
  }

  /*
    The arithmetic bc-hne3 turned on, restated every run. Printed per page, and then
    judged once per width — because the question is not whether *a* page could hold the
    picker inline (three of them can, at 360px, today). It is whether they *all* can:
    a picker that collapses onto the first row where it fits and keeps its own row where
    it does not is a control that changes shape as you move between tabs, which is the
    four-controls-in-one-coat the picker was built to end. Only "every page has room"
    makes collapsing free, and only then is the decision worth reopening.
  */
  console.log('\n\x1b[1mthe first row, and what a picker would need on it\x1b[0m');
  for (const r of room)
    console.log(
      `  · ${r.at}: ${r.spare}px spare (brand ${r.brandW} + actions ${r.actsW}), needs ${r.need}px — ${r.spare >= r.need ? `\x1b[33mroom to spare\x1b[0m` : `short by ${r.need - r.spare}px`}`
    );
  for (const size of SIZES) {
    const mine = room.filter((r) => r.width === size.width);
    const tight = mine.filter((r) => r.spare < r.need);
    if (!tight.length)
      notices.push(
        `\x1b[33m!\x1b[0m @${size.width}: every page with a picker could now hold it on the first row. "The first row is already full" has stopped being true — bc-hne3 is worth reopening.`
      );
    else
      notices.push(
        `· @${size.width}: ${tight.length} of ${mine.length} pages cannot hold the picker on the first row (${tight.map((r) => r.page).join(', ')}), so collapsing where it fits would move the control page to page. The row stays.`
      );
  }

  console.log('\n\x1b[1mwhat that means for the decision\x1b[0m');
  for (const n of notices) console.log(`  ${n}`);
} finally {
  close();
  server.close();
}

console.log('');
if (failures) {
  console.log(`\x1b[31m${failures} failure(s)\x1b[0m`);
  process.exit(1);
}
console.log('\x1b[32mthe top bar holds its budget\x1b[0m');
