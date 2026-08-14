#!/usr/bin/env node
//
// Does the map actually draw, and does the drawing agree with the model behind it?
//
//   node scripts/flow-check.mjs [--shot FILE] [--keep]
//
// `test/flowchart.mjs` holds the model: that every edge lands on a node, that every node
// names a file still in the tree, that no agent kind is missing from the map. None of
// that is a claim about a browser, and every way this feature actually fails is:
//
//   1. **mermaid renders nothing and the page still looks fine.** The fallback is the
//      diagram's own source in a `<pre>`, which is deliberate and readable — and which is
//      also exactly what a broken render leaves behind. Nobody would notice for months.
//      So: an `<svg>` in the box, with as many nodes drawn as the flow has.
//   2. **The colours are frozen light.** mermaid writes `classDef` out as inline `style`,
//      which beats a stylesheet, so a diagram styled that way stays light on a phone in
//      the dark. `mermaidFor` therefore emits a bare `class` per node and public/flow.js
//      colours it from CSS variables — a property that is invisible until somebody opens
//      it at night. Checked as: the node group carries `k-<kind>`, and its shape's
//      computed fill differs between the two colour schemes.
//   3. **A tap on a shape goes nowhere.** The binding parses mermaid's own `id` scheme
//      (`flowchart-<node>-<n>`), which is not API and will change under us one day. When
//      it does, the diagram silently stops being an index into the detail.
//
// It runs against the standalone page — `node scripts/flowchart.mjs --out <tmp>` — rather
// than against the daemon, on purpose: that page carries the same public/flow.js and the
// same payload as `/flow`, and needs no service, no token and no tracker. A check that
// needed a running daemon to prove a diagram draws would be a check nobody runs.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEP = process.argv.includes('--keep');
const SHOT = (() => {
  const i = process.argv.indexOf('--shot');
  return i === -1 || i === process.argv.length - 1 ? null : path.resolve(process.argv[i + 1]);
})();
// The phone, because that is what this app is. A map is one of the few screens with a
// real case for a wide window, and it is still the narrow one that breaks.
const VP = { width: 393, height: 852, dpr: 2 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, 'public', 'vendor', 'mermaid.js'))) {
  console.error('public/vendor/mermaid.js is missing — run `npm run vendor` (a fresh worktree has no vendor/)');
  process.exit(1);
}

let failures = 0;
const ok = (name) => console.log(`  \x1b[32m✓\x1b[0m ${name}`);
const bad = (name, detail) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? `\n      ${detail}` : ''}`);
};
const check = (name, cond, detail = '') => (cond ? ok(name) : bad(name, detail));

/* ------------------------------------------------------------------ the page */

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'beadcause-flowpage-'));
const page = path.join(dir, 'flowchart.html');
// `--inline`, so the served tree is one file and the fixture server below needs to know
// nothing about where mermaid lives.
execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'flowchart.mjs'), '--out', page, '--inline'], {
  stdio: 'pipe',
});

/**
 * Served rather than opened as `file:`.
 *
 * A `file:` origin is opaque, which puts `localStorage` — which public/flow.js reads on
 * the fetch path — behind a SecurityError in some Chrome configurations. The page never
 * takes that path here (the payload is embedded), but a check that depends on which
 * branch was taken to avoid an exception is a check that will fail for the wrong reason
 * one day.
 */
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/flowchart.html') || req.url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(page));
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const { s, close } = await launchChrome('beadcause-flow-');
const send = (method, params = {}) => s.send(method, params);
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'evaluate threw');
  return r.result.value;
};

const cleanup = () => {
  close();
  server.close();
  if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
  else console.log(`\nkept: ${page}`);
};

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: VP.width,
    height: VP.height,
    deviceScaleFactor: VP.dpr,
    mobile: true,
  });
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  const errors = [];
  // `on` here takes one callback for every event, not an event name — see `connect` in
  // scripts/helpers/chrome.mjs.
  s.on((method, params) => {
    if (method === 'Runtime.exceptionThrown') {
      errors.push(params.exceptionDetails?.exception?.description || 'exception');
    }
  });

  await send('Page.navigate', { url: `${base}/flowchart.html` });
  // mermaid renders asynchronously and there is no event for "the first flow is drawn",
  // so this polls for the shape rather than sleeping a guessed interval.
  let drawn = false;
  for (let i = 0; i < 100 && !drawn; i += 1) {
    await sleep(100);
    drawn = await evaluate(`!!document.querySelector('.fc-diagram svg')`).catch(() => false);
  }

  console.log('the map, in a browser\n');

  const model = await evaluate('window.FLOWCHART ? { flows: window.FLOWCHART.flows.length, first: window.FLOWCHART.flows[0].id, nodes: window.FLOWCHART.flows[0].nodes.length, agents: window.FLOWCHART.agents.length } : null');
  check('the payload is embedded', Boolean(model), 'window.FLOWCHART is not there');

  check('mermaid drew an svg rather than leaving the source', drawn, 'no <svg> in .fc-diagram after 10s — the <pre> fallback is what is showing');

  const drawnNodes = await evaluate(`document.querySelectorAll('.fc-diagram g.node').length`);
  check(
    `every step of the first flow is a shape (${drawnNodes}/${model?.nodes})`,
    drawnNodes === model?.nodes,
    `${drawnNodes} drawn, ${model?.nodes} in the model`
  );

  // 2 — the kind class is on the drawn group, which is what the stylesheet hangs off.
  const classes = await evaluate(
    `[...new Set([...document.querySelectorAll('.fc-diagram g.node')].flatMap(g => [...g.classList].filter(c => c.startsWith('k-'))))].sort()`
  );
  check(`each shape carries its kind class (${classes.join(', ')})`, classes.length > 0, 'no k-* class on any node group');

  const noInline = await evaluate(
    `[...document.querySelectorAll('.fc-diagram g.node')].every(g => !/fill:/.test(g.querySelector('rect,polygon,path')?.getAttribute('style') || ''))`
  );
  check('no inline fill on a shape — the stylesheet is what colours it', noInline, 'mermaid wrote a style attribute, so a classDef has crept back in');

  const darkFill = await evaluate(
    `getComputedStyle(document.querySelector('.fc-diagram g.node rect, .fc-diagram g.node polygon, .fc-diagram g.node path')).fill`
  );
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });
  await sleep(150);
  const lightFill = await evaluate(
    `getComputedStyle(document.querySelector('.fc-diagram g.node rect, .fc-diagram g.node polygon, .fc-diagram g.node path')).fill`
  );
  check(
    'the diagram follows the colour scheme',
    Boolean(darkFill) && Boolean(lightFill) && darkFill !== lightFill,
    `dark ${darkFill} vs light ${lightFill} — a diagram frozen at one scheme is the failure mermaid's classDef causes`
  );
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

  // 3 — a tap on a shape lights the card for that step, and it is the right one.
  const tapped = await evaluate(`(() => {
    const g = document.querySelector('.fc-diagram g.node');
    const m = /flowchart-(.+)-\\d+$/.exec(g.id || '');
    g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const lit = document.querySelector('.fc-step.lit');
    return { id: m && m[1], lit: lit && lit.dataset.node, raw: g.id };
  })()`);
  check(
    'a tap on a shape lights that step’s card',
    tapped.id && tapped.lit && tapped.id === tapped.lit,
    `shape ${tapped.id} lit ${tapped.lit} — mermaid's id scheme has moved, so public/flow.js's binding needs updating`
  );

  // Every step has its detail on screen, not only in the diagram. This is the half a
  // picture cannot carry and the reason the page is more than a diagram.
  const steps = await evaluate(
    `[...document.querySelectorAll('.fc-step')].every(el => el.querySelector('p')?.textContent.trim().length > 20 && el.querySelectorAll('.fc-src code').length > 0)`
  );
  check('every step card carries its detail and its source files', steps, 'a card with an empty body or no source path');

  // The agents pane draws every kind, with the fields that decide how much each could
  // break — read out of lib/foundation.js and never restated in the model.
  const agents = await evaluate(`(() => {
    [...document.querySelectorAll('.fc-nav button')].find(b => b.dataset.go === 'agents').click();
    return {
      cards: document.querySelectorAll('.fc-agent').length,
      tools: [...document.querySelectorAll('.fc-agent')].filter(c => c.querySelectorAll('.fc-tools code').length).length,
      writes: document.body.textContent.includes('May write to the tracker'),
    };
  })()`);
  check(`the agents pane draws every kind (${agents.cards}/${model?.agents})`, agents.cards === model?.agents);
  check('each agent’s allowlist is on the page', agents.tools >= 4, `${agents.tools} of ${agents.cards} carry one`);
  check('and whether it may write to the tracker', agents.writes);

  check('nothing threw', errors.length === 0, errors.join('\n      '));

  if (SHOT) {
    // Back to the first flow, since a screenshot of the agents pane is not the thing
    // somebody asking "does it draw?" wants to look at.
    await evaluate(`document.querySelector('.fc-nav button').click()`);
    await sleep(600);
    const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
    fs.writeFileSync(SHOT, Buffer.from(data, 'base64'));
    console.log(`\n  shot: ${SHOT}`);
  }
} finally {
  cleanup();
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m` : '\n\x1b[32mall good\x1b[0m');
process.exit(failures ? 1 : 0);
