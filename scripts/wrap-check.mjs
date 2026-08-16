#!/usr/bin/env node
//
// Does bd's hard wrap survive onto the phone as a forced line break?
//
//   node scripts/wrap-check.mjs [--baseline] [--keep]
//
// bd stores a description, notes, design or acceptance hard-wrapped at about 78
// columns. A phone is narrower than that, so each stored line already wraps on
// its own — and markdown's `breaks` option then puts a <br> at the fold as well,
// which is a staircase down the screen instead of a paragraph, and a list item
// that reads as two lines of loose prose.
//
// The flag is not simply wrong, which is what this checks both halves of: prose
// that came out of bd must reflow, and a comment somebody typed on the phone
// must keep every newline it was written with.
//
// Like scroll-check.mjs this drives the real public/app.js and public/graph.js in
// a headless Chrome the size of a phone, against fixtures served from this
// process, so nothing here touches a real bead. `--baseline` serves the committed
// files instead of the working copy: the bd-prose cases must fail there and the
// comment case must pass, which is how you know a pass here means something.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'wrap-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'marked.js'))) {
  console.error('public/vendor/marked.js is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

// Written the way bd hands it back: folded at 78 columns, mid-sentence, with a
// list whose first item is long enough to be folded onto a continuation line.
const DESCRIPTION = [
  'The reticle follows the finger and lands on whatever node is nearest to',
  'it, which is what you want while you are still looking and exactly wrong',
  'the moment you have stopped.',
  '',
  'Two things have to be true of the fix:',
  '',
  '- The first item is long enough that bd folds it onto a second line, and',
  '  that continuation must read as part of the item rather than as a break',
  '  inside it.',
  '- The second item is short.',
].join('\n');

// The sentence the first paragraph has to end up as once it has reflowed. Written
// out here rather than derived from DESCRIPTION, so a bug that eats or duplicates
// a word cannot agree with itself.
const PARA_1 =
  'The reticle follows the finger and lands on whatever node is nearest to it, ' +
  'which is what you want while you are still looking and exactly wrong the ' +
  'moment you have stopped.';

// Typed on a phone, where a newline is meant: three lines, no blank line between.
const COMMENT = ['Gross.', 'Reconciliation is the reason.', 'Ask me again if Stripe changes the fee.'].join('\n');

const BEAD = {
  id: 'wc-1',
  title: 'A brief that bd hard-wrapped at 78 columns',
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 1,
  dependent_count: 0,
  description: DESCRIPTION,
};

const COMMENTS = [{ author: 'adam', created_at: '2026-08-01T11:00:00Z', text: COMMENT }];

const QUESTION = { ...toQuestion('demo', BEAD), comments: COMMENTS };
const KEY = QUESTION.key;

// What /api/bead hands the graph sheet: the same prose, by the same two routes.
const FULL_BEAD = { ...BEAD, comments: COMMENTS, dependency_count: 0 };

const GRAPH = {
  nodes: [{ id: BEAD.id, title: BEAD.title, status: 'open', priority: 1, layer: 0 }],
  links: [],
  empty: false,
};

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

// The committed files, for --baseline. Read through git rather than from a second
// checkout, so the comparison is against HEAD of this very worktree.
const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') return json({ questions: [QUESTION], workspaces: ['demo'], spaces: [], scope: 'human' });
    if (p === '/api/question') return json(QUESTION);
    if (p === '/api/bead') return json(FULL_BEAD);
    if (p === '/api/graph') return json(GRAPH);
    // Everything else the app poked at on boot — agents, work, consoles. An empty
    // body answers all of them and keeps the fixture to the point.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/graph.js')) {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(committed(`public${p}`));
    }
    const rel = p === '/' ? 'index.html' : p === '/graph' ? 'graph.html' : p.replace(/^\/+/, '');
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
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  return r.result.value;
};

const waitFor = async (s, expr, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(200);
  }
  return false;
};

/* ------------------------------------------------------------------- probe */

// Read the rendered prose out of the DOM rather than out of the app: a paragraph
// is its own <p>, its text is what a reader sees, and a <br> anywhere in it is the
// staircase. `innerText` is deliberate — it renders a <br> as a newline, so a
// forced break shows up in the text as well as in the markup.
const READ = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const md = el.querySelector('.md') || el;
  const p = md.querySelector('p');
  const items = [...md.querySelectorAll('li')].map((li) => ({
    brs: li.querySelectorAll('br').length,
    text: li.innerText.replace(/\\s+/g, ' ').trim(),
  }));
  return {
    brs: md.querySelectorAll('br').length,
    paraBrs: p ? p.querySelectorAll('br').length : null,
    para: p ? p.innerText.replace(/\\s+/g, ' ').trim() : null,
    lists: md.querySelectorAll('ul').length,
    items,
  };
})()`;

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-wrap-');

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

  /* ------------------------------------------------------------- the inbox */

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  if (!(await waitFor(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(KEY)}][data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('.card .brief .md p')`))) throw new Error('the brief never rendered');

  const brief = await evalJs(s, READ(`.card[data-key=${JSON.stringify(KEY)}] .brief`));
  check(
    'a hard-wrapped paragraph reflows',
    brief.paraBrs === 0,
    brief.paraBrs === 0 ? '' : `${brief.paraBrs} forced break${brief.paraBrs === 1 ? '' : 's'} inside one paragraph`
  );
  check(
    'and it is still the whole sentence',
    brief.para === PARA_1,
    brief.para === PARA_1 ? '' : JSON.stringify(brief.para)
  );

  const item = brief.items[0];
  check('a hard-wrapped list is a list', brief.lists === 1 && brief.items.length === 2, `${brief.items.length} items`);
  check(
    'and a folded list item is one item, unbroken',
    !!item && item.brs === 0,
    item ? (item.brs ? `${item.brs} break(s) in item 1` : '') : 'no items at all'
  );

  const comment = await evalJs(s, READ(`.card[data-key=${JSON.stringify(KEY)}] .comment`));
  check(
    'a comment keeps the newlines it was typed with',
    !!comment && comment.brs === 2,
    comment ? `${comment.brs} break(s), wanted 2` : 'no comment rendered'
  );

  /* ------------------------------------------------------------- the graph */

  await s.send('Page.navigate', { url: `${BASE}/graph?ws=demo&id=${BEAD.id}` });
  if (!(await waitFor(s, `!!document.querySelector('g.gn')`))) throw new Error('the graph never drew a node');

  await evalJs(s, `document.querySelector('g.gn').dispatchEvent(new MouseEvent('click', { bubbles: true }))`);
  await evalJs(s, `document.getElementById('card-details').click()`);
  if (!(await waitFor(s, `!!document.querySelector('#sheet-body .md p')`))) throw new Error('the sheet never rendered');

  const sheet = await evalJs(s, READ('#sheet-body'));
  check('the graph sheet reflows the same prose', sheet.paraBrs === 0, sheet.paraBrs === 0 ? '' : `${sheet.paraBrs} breaks`);

  const sheetComment = await evalJs(s, READ('#sheet-body .comment'));
  check(
    'and the graph sheet keeps a comment intact',
    !!sheetComment && sheetComment.brs === 2,
    sheetComment ? `${sheetComment.brs} break(s), wanted 2` : 'no comment rendered'
  );
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
