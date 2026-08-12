#!/usr/bin/env node
//
// Is anything in a console thread tappable and inert?
//
//   node scripts/console-check.mjs [--baseline] [--keep]
//
// A reply that proposed beads keeps `proposed: N` for the life of the transcript,
// but the draft it pointed at does not — creating spends it, the next turn replaces
// it, closing drops it. The button under an old proposal therefore outlives its
// target, and the bug this checks for is what it used to do then: nothing at all,
// silently.
//
// Same shape as scroll-check.mjs: the real public/console.js in a headless Chrome
// the size of a phone, against a fixture console served from this process, so
// nothing here talks to a daemon or touches a bead. `--baseline` serves the
// committed console.js instead of the working copy — baseline must fail the filed
// and revised cases, the working copy must pass all of them.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeDraft } from '../lib/draft.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'console-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
// console.js renders every reply through marked and DOMPurify as it draws; without
// them the thread never appears and every assertion below is about a blank page.
for (const v of ['marked.js', 'purify.js']) {
  if (!fs.existsSync(path.join(PUBLIC, 'vendor', v))) {
    console.error(`public/vendor/${v} is missing — run \`npm run vendor\` first.`);
    process.exit(1);
  }
}

/* ---------------------------------------------------------------- fixtures */

// Through the real normaliser, so a draft here cannot be a shape the server would
// never hand the screen.
const draftOf = (...titles) =>
  normalizeDraft({ beads: titles.map((t) => ({ title: t, type: 'task', priority: 2, description: `Why ${t}.` })) });

const at = (n) => new Date(Date.UTC(2026, 7, 1, 10, n)).toISOString();

// One transcript with all three living states in it, oldest first: a proposal that
// became beads, a proposal a later turn revised, and the newest one, still live.
const LIVE = {
  id: 'live',
  workspace: 'demo',
  title: 'Three proposals deep',
  status: 'idle',
  error: null,
  seq: 7,
  seed: null,
  created: [],
  closedAt: null,
  draft: draftOf('The bead that is still only proposed'),
  messages: [
    { role: 'user', text: 'Two beads for the importer, please.', at: at(0) },
    { role: 'assistant', text: 'Here are two.', tools: [], at: at(1), proposed: 2 },
    {
      role: 'system',
      kind: 'created',
      text: '',
      at: at(2),
      warnings: [],
      created: [
        { ref: 'a', id: 'dm-a01', title: 'Read the CSV without loading it all' },
        { ref: 'b', id: 'dm-b02', title: 'Report the row that failed' },
      ],
    },
    { role: 'user', text: 'Now three about the exporter.', at: at(3) },
    { role: 'assistant', text: 'Three, then.', tools: [], at: at(4), proposed: 3 },
    { role: 'user', text: 'Actually just the first one.', at: at(5) },
    { role: 'assistant', text: 'One it is.', tools: [], at: at(6), proposed: 1 },
  ],
};

// A proposal whose draft went away without becoming anything: closing a console
// drops the unspent cards, and the button is all that is left of them.
const SPENT = {
  ...LIVE,
  id: 'spent',
  title: 'Closed on an unspent proposal',
  status: 'closed',
  seq: 3,
  draft: null,
  closedAt: at(2),
  messages: [
    { role: 'user', text: 'Two beads for the importer, please.', at: at(0) },
    { role: 'assistant', text: 'Here are two.', tools: [], at: at(1), proposed: 2 },
    { role: 'system', kind: 'closed', text: 'Closed.', at: at(2) },
  ],
};

const CONSOLES = { live: LIVE, spent: SPENT };

/* ------------------------------------------------------------------ server */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// Read through git rather than from a second checkout, so --baseline compares
// against HEAD of this very worktree.
const committed = () => execFileSync('git', ['show', 'HEAD:public/console.js'], { cwd: ROOT });

const parked = new Set();

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/console') return json(CONSOLES[url.searchParams.get('id')] || { error: 'not found' });
    // The long poll never returns: the fixture never changes, and answering it
    // would spin the page's poll loop for the length of the run.
    if (p === '/api/console/poll') return void parked.add(res);
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && p === '/console.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(committed());
    }
    const rel = p === '/console' ? 'console.html' : p.replace(/^\/+/, '') || 'index.html';
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

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`);
  return r.result.value;
};

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

// Every proposal line in the thread, in order, as the screen shows them.
const BUTTONS = `[...document.querySelectorAll('#thread .proposed-link')].map((b) => ({
  text: b.textContent.trim(),
  disabled: b.disabled,
  cls: b.className,
}))`;

// What a tap has to change: the sheet came up, or the thread moved, or something in
// it lit up, or it said why not. A button that does none of these is the bug.
const SNAPSHOT = `({
  sheet: !document.querySelector('#sheet').hidden,
  scroll: Math.round(document.querySelector('#thread').scrollTop),
  flash: !!document.querySelector('#thread .flash'),
  toast: !document.querySelector('#toast').hidden,
})`;

// The rule the bead states, applied to whatever is on the screen: tap every
// proposal line there is, and require the screen to answer.
async function sweep() {
  const count = await evalJs(s, `document.querySelectorAll('#thread .proposed-link').length`);
  for (let i = 0; i < count; i++) {
    const pick = `document.querySelectorAll('#thread .proposed-link')[${i}]`;
    const label = await evalJs(s, `${pick}.textContent.trim().slice(0, 44)`);
    if (await evalJs(s, `${pick}.disabled`)) {
      check(`tapping “${label}” — disabled, so it cannot be`, true);
      continue;
    }
    const before = await evalJs(s, SNAPSHOT);
    await evalJs(s, `${pick}.click()`);
    await sleep(900);
    const after = await evalJs(s, SNAPSHOT);
    const moved =
      after.sheet !== before.sheet ||
      after.flash !== before.flash ||
      after.toast !== before.toast ||
      after.scroll !== before.scroll;
    check(`tapping “${label}” does something`, moved, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    // Back to a clean screen for the next one.
    await evalJs(
      s,
      `(() => {
        if (!document.querySelector('#sheet').hidden) document.querySelector('#sheet-close').click();
        for (const f of document.querySelectorAll('#thread .flash')) f.classList.remove('flash');
        document.querySelector('#toast').hidden = true;
      })()`
    );
    await sleep(500);
  }
}

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-console-');

const openConsole = async (id) => {
  await s.send('Page.navigate', { url: `${BASE}/console?id=${id}&t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('#thread .msg')`)) return;
  }
  throw new Error(`the thread never rendered for console ${id}`);
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

  console.log(
    `\n${BASELINE ? 'BASELINE (HEAD:public/console.js)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`
  );

  /* ---- one thread, three proposals, three different fates ---- */
  await openConsole('live');
  const btns = await evalJs(s, BUTTONS);
  check('all three proposals still show a line', btns.length === 3, `${btns.length} found`);

  check(
    'the filed proposal says it was filed',
    /filed/i.test(btns[0]?.text || '') && !/review/i.test(btns[0]?.text || ''),
    JSON.stringify(btns[0]?.text)
  );
  check('the revised proposal says it was revised', /revised/i.test(btns[1]?.text || ''), JSON.stringify(btns[1]?.text));
  check(
    'the newest proposal still offers the review',
    /review/i.test(btns[2]?.text || '') && !btns[2]?.disabled,
    JSON.stringify(btns[2]?.text)
  );

  /* ---- nothing enabled in the thread can be tapped for no effect ---- */
  await sweep();

  /* ---- the filed one leads to the beads it became ---- */
  await evalJs(s, `document.querySelector('#thread').scrollTop = document.querySelector('#thread').scrollHeight`);
  await sleep(300);
  // Null-safe on purpose: under --baseline there is no filed line at all, and a
  // baseline run has to report that as failures rather than die on the click.
  await evalJs(s, `document.querySelector('#thread .proposed-link.filed')?.click()`);
  await sleep(1200);
  const landed = await evalJs(
    s,
    `(() => {
      const note = document.querySelector('#thread .created-note');
      if (!document.querySelector('#thread .proposed-link.filed')) return { onScreen: false, flashed: false, ids: [] };
      const r = note.getBoundingClientRect();
      return {
        onScreen: r.top < window.innerHeight && r.bottom > 0,
        flashed: note.classList.contains('flash'),
        ids: [...note.querySelectorAll('.pill.id')].map((a) => a.textContent.trim()),
      };
    })()`
  );
  check('the filed proposal walks you to the beads it became', landed.onScreen, JSON.stringify(landed));
  check('and marks which note it sent you to', landed.flashed, `flash=${landed.flashed}`);
  check('which is where the ids are', landed.ids.join(',') === 'dm-a01,dm-b02', landed.ids.join(','));

  /* ---- the revised one opens the draft that replaced it ---- */
  const revised = await evalJs(s, `!!document.querySelector('#thread .proposed-link.revised')`);
  await evalJs(s, `document.querySelector('#thread .proposed-link.revised')?.click()`);
  await sleep(900);
  const sheet = await evalJs(
    s,
    `({ open: !document.querySelector('#sheet').hidden, title: document.querySelector('#sheet-title').textContent.trim() })`
  );
  check(
    'the revised proposal opens the current draft',
    revised && sheet.open && /^1 bead/.test(sheet.title),
    JSON.stringify(sheet)
  );
  await evalJs(s, `document.querySelector('#sheet-close').click()`);
  await sleep(400);

  /* ---- a proposal whose draft went away without becoming anything ---- */
  await openConsole('spent');
  await sweep();
  const spent = await evalJs(s, BUTTONS);
  check(
    'a discarded proposal is visibly disabled',
    spent.length === 1 && spent[0].disabled && !/review/i.test(spent[0].text),
    JSON.stringify(spent[0])
  );
} finally {
  if (!KEEP) close();
  for (const res of parked) res.destroy();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
