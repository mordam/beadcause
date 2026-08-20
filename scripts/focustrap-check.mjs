#!/usr/bin/env node
//
// Does Tab actually stay inside a layer that claims `aria-modal="true"`? bc-ywiy.
//
//   node scripts/focustrap-check.mjs [--baseline] [--out=dir]
//
// Three layers say `role="dialog" aria-modal="true"` — the epic's full-tab
// (`.p0-full`), the tools-arming warning (`.dialog`) and the drawer (`.drawer`) — and
// the attribute tells a screen reader everything behind them is inert. Nothing kept
// Tab to the same claim: a keyboard reader could tab straight out of any of the three
// into the page underneath, which is covered by an opaque layer with no focus ring
// anywhere on screen. Nothing here is visible in the markup — the failure is entirely
// about where a real Tab key sends `document.activeElement`, which is why this drives
// a real headless Chrome rather than reading strings.
//
// `Input.dispatchKeyEvent` rather than a JS `KeyboardEvent`: the browser only runs its
// own default Tab-moves-focus behaviour for input it believes came from a real key,
// and a script-dispatched `KeyboardEvent` is never trusted for that. CDP's input
// events are — the same mechanism Puppeteer's `keyboard.press` uses — so a Tab that
// reaches here without a `preventDefault()` really does move the browser's focus,
// exactly as it would under a thumb on a real keyboard.
//
// Real public/*.js in a headless Chrome at phone size, against fixtures served from
// this process — no daemon, no bead, no iTerm. `--baseline` serves the committed
// copies of the three files this bead touched, which trap nothing and must fail here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { publicRoster } from '../lib/agents.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'focustrap-check-token';
const BASELINE = process.argv.includes('--baseline');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
for (const v of ['marked.js', 'purify.js']) {
  if (!fs.existsSync(path.join(PUBLIC, 'vendor', v))) {
    console.error(`public/vendor/${v} is missing — run \`npm run vendor\` first.`);
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- fixtures */

const WS = 'demo';

/* -- the epic, for .p0-full -- */

const P0 = { id: 'ft-p0', title: 'Keep the keyboard where the screen says it is' };
const TREE = [
  { id: 'ft-p0.1', title: 'A row under the epic', status: 'open', parent: P0.id, depth: 1, key: `${WS}/ft-p0.1` },
  { id: 'ft-p0.2', title: 'A second row', status: 'open', parent: P0.id, depth: 1, key: `${WS}/ft-p0.2` },
];
const board = () => ({
  owned: true,
  under: {},
  // The plain bead is under no epic — `assignedToMe` in public/app.js keeps it on the
  // Questions pill only because it is here, exactly as bc-i7tw's own loose question is.
  unhomed: { [`${WS}/ft-one`]: true },
  assigned: { [`${WS}/${P0.id}`]: true, ...Object.fromEntries(TREE.map((r) => [r.key, true])) },
  roots: [
    {
      key: `${WS}/${P0.id}`,
      workspace: WS,
      id: P0.id,
      title: P0.title,
      status: 'open',
      issue_type: 'epic',
      owners: ['adam'],
      open: TREE.length,
      inFlight: 0,
      waitingOn: null,
      advocate: null,
      tree: TREE,
    },
  ],
});

/* -- a plain bead, for .dialog (the tools warning) and .drawer (a doc link) -- */

const DIR = '/tmp/beadcause-focustrap-check';
const SPEC = `${DIR}/SPEC.md`;
const IN_SPEC = 'ONLY-IN-THE-SPEC';
const DOCS = { [SPEC]: `# The spec\n\n${IN_SPEC} — read from inside the drawer.` };

const CFG = { defaultAgent: 'answerer', agents: [{ id: 'critic', tools: 'Bash(bd show:*), Read' }] };
const armed = new Set();
let acknowledged = false;
const rosterNow = () => publicRoster(CFG, { armed });
const AGENTS = rosterNow();
const TOOLS_AGENT = AGENTS.find((a) => a.id === 'critic');
if (!TOOLS_AGENT?.tools) {
  console.error('the roster fixture did not come back with a tools agent — lib/agents.js changed shape');
  process.exit(1);
}

const BEAD = {
  id: 'ft-one',
  title: 'A question with a document to read and a warning to get past',
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  // A bare absolute path, not a pre-built `/doc?p=…` href: `renderMarkdown` in
  // public/app.js is what turns a local path in prose into a reader-tab link
  // (`docUrl`), and handing it one already-built double-wraps it.
  description: `Some context first.\n\n[Read the spec](${SPEC})`,
};
const QUESTIONS = [{ ...toQuestion(WS, BEAD), comments: [] }];
const KEY = QUESTIONS[0].key;

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
};
const BASE_FILES = ['/app.js', '/drawer.js', '/style.css'];
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
    const read = (fn) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => fn(JSON.parse(raw || '{}')));
    };
    if (p === '/api/questions') {
      return json({
        questions: QUESTIONS,
        requests: [],
        workspaces: [WS],
        spaces: [{ name: 'Work', workspaces: [WS], quiet: false, muted: false, count: QUESTIONS.length }],
        filter: { space: 'all', workspace: 'all' },
        rootboard: board(),
        summary: { sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json({ ...q, comments: [] }) : json({ error: 'not found' });
    }
    if (p === '/api/agents') return json({ agents: rosterNow(), default: CFG.defaultAgent });
    if (p === '/api/agent-arm') {
      return read((body) => {
        const agent = rosterNow().find((a) => a.id === body.id);
        if (!agent) return json({ error: 'no such agent' }, 404);
        if (body.disarm) {
          armed.delete(agent.id);
          return json({ ok: true, armed: false, agents: rosterNow() });
        }
        if (!acknowledged && !body.acknowledge) {
          return json(
            {
              needsAcknowledgement: true,
              disclaimer: {
                agent: agent.name,
                title: `Give ${agent.name} extended tools?`,
                tools: agent.tools,
                points: ['For one reply only.', 'It runs unattended, as you, on this Mac.'],
              },
            },
            428
          );
        }
        acknowledged = true;
        armed.add(agent.id);
        return json({ ok: true, armed: true, agents: rosterNow() });
      });
    }
    if (p === '/api/asset') {
      const body = DOCS[url.searchParams.get('p') || ''];
      if (body == null) return void res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
      res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
      return res.end(body);
    }
    if (p.startsWith('/api/')) {
      if (req.method === 'POST') return void read(() => json({}));
      return json({});
    }

    if (BASELINE && BASE_FILES.includes(p)) {
      const body = committed(p);
      if (body == null) return void res.writeHead(404).end('not at HEAD');
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'text/plain' });
      return res.end(body);
    }
    // The daemon serves these as pages, not as files on disk.
    const PAGES = { '/': 'index.html', '/doc': 'doc.html' };
    const rel = PAGES[p] || p.replace(/^\/+/, '');
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- probe */

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-focustrap-');

const evalJs = async (expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval failed');
  return r.result.value;
};

const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 150; i++) {
    if (await evalJs(expr)) return true;
    await sleep(150);
  }
  return false;
};

const click = (sel) => evalJs(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return false; el.click(); return true; })()`);

// Focus, expressed the same way every check in this file needs it: "is the active
// element the one thing this selector names". A boolean rather than a description,
// because the only question ever asked here is "did it land on the right one".
const activeIs = (sel) => evalJs(`document.activeElement === document.querySelector(${JSON.stringify(sel)})`);
// Focus that has moved *into* an iframe reads, from the top document, as the
// `<iframe>` element itself holding it — that is the one case a real Tab and
// `activeIs` above can't tell apart, so this is the question asked instead.
const activeOutsideFrame = (frameSel) =>
  evalJs(`document.activeElement === document.querySelector(${JSON.stringify(frameSel)})`);

// `Input.dispatchKeyEvent`, not a script `KeyboardEvent` — see the header comment for
// why the distinction matters here.
const TAB = { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 };
const ESC = { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 };
const press = async (desc, shift = false) => {
  const modifiers = shift ? 8 : 0;
  await s.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', modifiers, ...desc });
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', modifiers, ...desc });
  await sleep(120);
};
const tab = (shift) => press(TAB, shift);
const escape = () => press(ESC);

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(OUT, `focustrap-${name}.png`), Buffer.from(data, 'base64'));
};

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

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

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  /* ================================================================ .p0-full */

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  if (!(await waitFor(`!!document.querySelector('.p0-card .p0-tap')`)))
    throw new Error('the epic card never rendered');

  await click('.p0-card .p0-tap');
  if (!(await waitFor(`!!document.querySelector('.p0-full')`, 4000))) throw new Error('the epic tab never opened');
  await sleep(200);

  check('opening the tab lands focus on its own way back', await activeIs('.p0-back'), 'the ‹ Board button');

  await tab(true); // Shift-Tab off the first control
  check(
    'Shift-Tab off the first control wraps to the last, rather than leaving the layer',
    await activeIs('.p0-full .p0-graph'),
    'the 🕸 Graph link'
  );

  // Landed on the last control directly rather than relying on the Shift-Tab above
  // having actually put it there — on a build with no trap at all, that Shift-Tab
  // escapes the layer to whatever the pill row happens to sit next to in the DOM, and
  // a plain Tab from there can land back on `.p0-back` by dumb layout luck, passing
  // this line for a reason that has nothing to do with the fix it is meant to check.
  await evalJs(`document.querySelector('.p0-full .p0-graph').focus()`);
  await tab(false); // Tab off the last control
  check(
    'and Tab off the last one wraps back to the first',
    await activeIs('.p0-back'),
    'the ‹ Board button'
  );

  const closedFocus = await evalJs(`(() => { document.querySelector('.p0-back').click(); return true; })()`);
  await sleep(200);
  check(
    'closing the tab hands the keyboard back to the card that opened it',
    closedFocus && (await activeIs('.p0-card .p0-tap')),
    ''
  );
  await shot('p0full');

  /* ================================================================== .drawer */

  if (!(await click('button.viewpill[data-pill="question"]'))) throw new Error('no Questions pill to switch to');
  if (!(await waitFor(`!!document.querySelector('.card[data-key=${JSON.stringify(KEY)}]')`))) throw new Error('the bead never rendered');
  await click(`.card[data-key=${JSON.stringify(KEY)}][data-act="toggle"]`);
  if (!(await waitFor(`!!document.querySelector('a[href^="/doc?"]')`))) throw new Error('the doc link never rendered');

  await click('a[href^="/doc?"]');
  if (
    !(await waitFor(
      `document.querySelector('.drawer-frame') && (() => { try { return document.querySelector('.drawer-frame').contentDocument.body.innerText.includes(${JSON.stringify(IN_SPEC)}); } catch (e) { return false; } })()`,
      4000
    ))
  )
    throw new Error('the drawer never opened the document');
  await sleep(300);

  // The panel itself takes the initial focus (`panel.focus()` in drawer.js's own
  // `show()`, unchanged by this bead) rather than a specific control, so a keyboard
  // reader lands on the dialog before its first control — a Tab is what actually
  // reaches the ✕.
  await tab(false);
  check('Tab from the panel reaches its close button', await activeIs('.drawer [data-role="close"]'), '');

  // Backward off the close button — the one direction drawer.js can see coming — goes
  // looking for the framed page's own last focusable rather than treating the iframe
  // as one opaque stop.
  await tab(true);
  const wentIntoFrame = await activeOutsideFrame('.drawer-frame');
  check(
    'Shift-Tab off the drawer’s ✕ reaches into the framed page rather than stopping at the iframe',
    wentIntoFrame,
    wentIntoFrame ? 'landed on the iframe, with focus delegated into its content' : 'stayed on the ✕ — no wrap at all'
  );

  // Forward escape is the hard case: a Tab pressed once focus is *inside* the iframe
  // never reaches drawer.js's own keydown listener, so the only way back is the
  // `focusin` backstop, which does not care how focus got loose — only that it did.
  // Simulated directly rather than by counting Tabs through unknown page content,
  // which is exactly the case the backstop exists for.
  await evalJs(`(() => {
    const el = document.querySelector('#list');
    el.setAttribute('tabindex', '-1');
    el.focus();
    return true;
  })()`);
  await sleep(150);
  check(
    'focus that escapes the drawer while it is open snaps straight back to the ✕',
    await activeIs('.drawer [data-role="close"]'),
    ''
  );

  await evalJs(`document.querySelector('.drawer [data-role="close"]').click()`);
  await sleep(500);
  check(
    'and closing it returns the keyboard to the link that opened it',
    await activeIs('a[href^="/doc?"]'),
    ''
  );
  await shot('drawer');

  /* ================================================================== .dialog */

  await click('.agent-dots');
  if (!(await waitFor(`!!document.querySelector('.agent-panel .agent-chip')`))) throw new Error('the roster panel never opened');
  await click(`.agent-panel .agent-chip[data-agent="${TOOLS_AGENT.id}"]`);
  await sleep(200);
  await click('.agent-panel input[data-act="allow-tools"]');
  if (!(await waitFor(`!!document.querySelector('.dialog-wrap [data-no]')`, 4000))) throw new Error('the tools warning never opened');
  await sleep(200);

  check(
    'the warning opens with focus on Cancel, not on the button that grants the reach',
    await activeIs('.dialog-wrap [data-no]'),
    ''
  );

  await tab(false);
  check('Tab moves to the other button', await activeIs('.dialog-wrap [data-yes]'), '');

  await tab(false);
  check('and Tab off that one wraps back to Cancel rather than leaving the dialog', await activeIs('.dialog-wrap [data-no]'), '');

  await tab(true);
  check('Shift-Tab off Cancel wraps the other way, to the button that grants it', await activeIs('.dialog-wrap [data-yes]'), '');

  await escape();
  await sleep(300);
  check('Escape means Cancel — the warning closes', !(await evalJs(`!!document.querySelector('.dialog-wrap')`)), '');
  check(
    'and hands the keyboard back to the checkbox that asked for it',
    await activeIs(`.agent-panel input[data-act="allow-tools"][data-agent="${TOOLS_AGENT.id}"]`),
    ''
  );
  check(
    'without leaving the box ticked — Escape granted nothing',
    !(await evalJs(`document.querySelector('.agent-panel input[data-act="allow-tools"]').checked`)),
    ''
  );
  await shot('dialog');
} finally {
  close();
  server.closeAllConnections?.();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
