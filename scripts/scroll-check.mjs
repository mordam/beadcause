#!/usr/bin/env node
//
// Does an open bead stay where you left it when the list repaints?
//
//   node scripts/scroll-check.mjs [--baseline] [--keep]
//
// The inbox rebuilds its whole list with innerHTML on every poll. That is fine
// for the list and ruinous for a brief you are halfway down: the swap empties
// every mermaid placeholder, the page is at its shortest exactly when the old
// scroll offset is written back, the browser clamps the offset to the short
// document, and then the diagrams render and push everything down again. You end
// up screens above where you were — the jump back to the top of the card.
//
// This drives the real public/app.js in a headless Chrome the size of a phone,
// against fixtures served from this process rather than the daemon, so nothing
// here touches a real bead. `--baseline` serves the committed app.js instead of
// the working copy, which is how you check that a failure here is a real one:
// baseline must fail the scroll cases, the working copy must pass them all.
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
const TOKEN = 'scroll-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
// The whole point of this check is a diagram that sizes itself after the repaint,
// so a missing mermaid bundle would leave it asserting nothing at all.
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'mermaid.js'))) {
  console.error('public/vendor/mermaid.js is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

// Long enough that the middle of it is several screens below the head of the
// card, and numbered so a paragraph can be found again by its text after the
// list has been thrown away and rebuilt.
const paras = (n, tag) =>
  Array.from({ length: n }, (_, i) => `${tag} paragraph ${i + 1}. ` + 'Text that has to wrap on a phone. '.repeat(4)).join(
    '\n\n'
  );

const DIAGRAM_BEAD = {
  id: 'sc-diagram',
  title: 'A long brief with a diagram above the reading point',
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: [
    'The context above the diagram.',
    '',
    '```decision',
    'question: Gross or net?',
    'options:',
    '  - id: gross',
    '    label: Gross',
    '    response: "Gross."',
    '  - id: net',
    '    label: Net',
    '    response: "Net."',
    'diagram: |',
    '  graph TD',
    '    Buyer --> Platform',
    '    Platform --> Seller',
    '    Seller --> Bank',
    '    Bank --> Ledger',
    '    Ledger --> Report',
    '```',
    '',
    paras(40, 'Body'),
  ].join('\n'),
};

const PLAIN_BEAD = (n) => ({
  id: `sc-plain-${n}`,
  title: `Another question waiting (${n})`,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: `Short brief ${n}.\n\n${paras(3, `Other${n}`)}`,
});

const ISSUES = [DIAGRAM_BEAD, PLAIN_BEAD(1), PLAIN_BEAD(2)];
const QUESTIONS = ISSUES.map((i) => ({ ...toQuestion('demo', i), comments: [] }));
const KEY = QUESTIONS[0].key;
const OTHER_KEY = QUESTIONS[1].key;

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

// The committed app.js, for --baseline. Read through git rather than from a
// second checkout so the comparison is against HEAD of this very worktree.
const committedApp = () => execFileSync('git', ['show', 'HEAD:public/app.js'], { cwd: ROOT });

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({ questions: QUESTIONS, workspaces: ['demo'], spaces: [], scope: 'human' });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' });
    }
    // Everything else the app pokes at on boot — agents, work, consoles. An empty
    // body is a valid answer to all of them and keeps the fixture to the point.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && p === '/app.js') {
      res.writeHead(200, { 'content-type': TYPES['.js'] });
      return res.end(committedApp());
    }
    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

// Deliberately not awaitPromise: the page's own work (a refresh, mermaid) is
// waited for by sleeping and re-measuring, and asking the protocol to await a
// promise that the page may drop is how this used to die with "Promise was
// collected" instead of a result.
const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  return r.result.value;
};

/* ------------------------------------------------------------------- probe */

// Measured independently of how the app does it: a paragraph is found by its own
// text, so nothing here can agree with a bug in the anchoring it is checking.
const MARK = (key) => `(() => {
  const card = document.querySelector('.card[data-key=' + JSON.stringify(${JSON.stringify(key)}) + ']');
  if (!card) return null;
  for (const p of card.querySelectorAll('.md p')) {
    const r = p.getBoundingClientRect();
    if (r.top >= 0 && r.height) return { text: p.textContent.slice(0, 40), top: Math.round(r.top) };
  }
  return null;
})()`;

const FIND = (text) => `(() => {
  const t = ${JSON.stringify(text)};
  for (const p of document.querySelectorAll('.md p')) {
    if (p.textContent.slice(0, 40) === t) return Math.round(p.getBoundingClientRect().top);
  }
  return null;
})()`;

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-scroll-');

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

  console.log(`\n${BASELINE ? 'BASELINE (HEAD:public/app.js)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('.card[data-key]')`)) break;
  }
  if (!(await evalJs(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  // Open the long brief and let mermaid finish, the way a reader would.
  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(KEY)}][data-act="toggle"]').click()`);
  await sleep(2500);
  const drew = await evalJs(s, `!!document.querySelector('.card svg[id^="mmd-"]')`);
  check('the diagram draws at all', drew, drew ? '' : 'no mermaid svg — the rest of this proves nothing');

  /* 1. reading, empty answer box, a poll lands */
  // Deliberately deep enough that the diagram is off the top of the screen: that
  // is the case the old code got wrong, and 45% of a page whose height depends on
  // how mermaid laid the diagram out is not reliably past it.
  await evalJs(
    s,
    `(() => {
      for (const p of document.querySelectorAll('.md p')) {
        if (p.textContent.startsWith('Body paragraph 20.')) return p.scrollIntoView({ block: 'start' });
      }
    })()`
  );
  await sleep(300);
  const a0 = await evalJs(s, MARK(KEY));
  await evalJs(s, `window.beadcause.refresh()`);
  await sleep(2500);
  const a1 = await evalJs(s, FIND(a0.text));
  check(
    'a poll leaves a long brief where it was',
    a1 !== null && Math.abs(a1 - a0.top) <= 4,
    `was ${a0.top}px, now ${a1}px`
  );

  /* 2. the same, with the diagram above the reading point — it sizes late */
  const above = await evalJs(
    s,
    `(() => { const d = document.querySelector('.card[data-key=${JSON.stringify(
      KEY
    )}] .diagram'); return d ? Math.round(d.getBoundingClientRect().bottom) : null; })()`
  );
  check('the diagram is above the reading point', above !== null && above < 0, `diagram bottom at ${above}px`);

  /* 3. half-typed answer: caret, draft and place all survive a repaint */
  await evalJs(
    s,
    `(() => {
      const box = document.querySelector('.card[data-key=${JSON.stringify(KEY)}] [data-role="answer"]');
      box.scrollIntoView({ block: 'center' });
      box.focus();
      box.value = 'half a sentence';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.setSelectionRange(7, 7);
    })()`
  );
  await sleep(300);
  const b0 = await evalJs(s, MARK(KEY));
  await evalJs(s, `window.beadcause.refresh()`);
  await sleep(2000);
  const b1 = await evalJs(s, FIND(b0.text));
  const caret = await evalJs(
    s,
    `(() => {
      const box = document.activeElement;
      const ok = box && box.matches('[data-role="answer"]');
      return { focused: !!ok, value: ok ? box.value : null, start: ok ? box.selectionStart : null };
    })()`
  );
  check('a poll mid-answer keeps the place', b1 !== null && Math.abs(b1 - b0.top) <= 4, `was ${b0.top}px, now ${b1}px`);
  check('a poll mid-answer keeps the caret', caret.focused && caret.start === 7, JSON.stringify(caret));

  /* 4. a deep link naming the card already open, arriving mid-answer */
  const c0 = await evalJs(s, MARK(KEY));
  await evalJs(s, `location.hash = ${JSON.stringify('#' + KEY)}; dispatchEvent(new HashChangeEvent('hashchange'))`);
  await sleep(1500);
  const c1 = await evalJs(s, FIND(c0.text));
  const caret2 = await evalJs(
    s,
    `(() => {
      const box = document.activeElement;
      const ok = box && box.matches('[data-role="answer"]');
      return { focused: !!ok, start: ok ? box.selectionStart : null };
    })()`
  );
  check('a deep link to the open card does not move it', c1 !== null && Math.abs(c1 - c0.top) <= 4, `was ${c0.top}px, now ${c1}px`);
  check('a deep link to the open card keeps the caret', caret2.focused && caret2.start === 7, JSON.stringify(caret2));

  /* 5. a forced repaint — opening another card — collapses this one and keeps the draft
     Opening a second question is the accordion: the card being read collapses, draft
     or no draft. So "keeps the answer" cannot mean the textarea is still on screen —
     it means the draft outlived the card that held it, is marked on the collapsed
     card so you can see which question you left half-answered, and comes back in the
     box when you open it again. */
  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(OTHER_KEY)}][data-act="toggle"]').click()`);
  await sleep(1500);
  const accordion = await evalJs(
    s,
    `(() => {
      const one = document.querySelector('.card[data-key=${JSON.stringify(KEY)}]');
      const two = document.querySelector('.card[data-key=${JSON.stringify(OTHER_KEY)}]');
      return {
        collapsed: !one.classList.contains('open'),
        marked: one.classList.contains('has-draft'),
        other: two.classList.contains('open'),
        openCards: document.querySelectorAll('.card.open').length,
      };
    })()`
  );
  check(
    'opening another question collapses the one you were on',
    accordion.collapsed && accordion.other && accordion.openCards === 1,
    JSON.stringify(accordion)
  );
  check('and marks it as half-answered', accordion.marked, JSON.stringify(accordion.marked));

  // Open it again: the draft has to be back in the box, not merely in localStorage.
  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(KEY)}][data-act="toggle"]').click()`);
  await sleep(1500);
  const draft = await evalJs(
    s,
    `(document.querySelector('.card[data-key=${JSON.stringify(KEY)}] [data-role="answer"]') || {}).value`
  );
  check('a forced repaint keeps the half-typed answer', draft === 'half a sentence', JSON.stringify(draft));

  /* 6. collapsing still puts you back on the card's head */
  await evalJs(
    s,
    `(() => {
      const box = document.querySelector('.card[data-key=${JSON.stringify(KEY)}] [data-role="answer"]');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      box.blur();
      document.querySelectorAll('.card[data-key=${JSON.stringify(KEY)}] [data-act="collapse"]')[0].click();
    })()`
  );
  await sleep(2000);
  const head = await evalJs(
    s,
    `Math.round(document.querySelector('.card[data-key=${JSON.stringify(KEY)}]').getBoundingClientRect().top)`
  );
  // Not zero, and not a fixed number either: on a list this short the scroll clamps
  // before the card reaches the top, so the head comes to rest just under whatever
  // chrome is above the list — the sticky top bar, plus the filter rows when there
  // are any. Measured rather than hard-coded, because the chrome's height is not
  // this check's subject: it was 120px until the scope moved into the filters and
  // gave that nav an unconditional row, and a literal here fails on a layout change
  // that has nothing to do with where collapsing puts you.
  const chrome = await evalJs(
    s,
    `(() => {
      const f = document.querySelector('#filters');
      const el = f && !f.hidden ? f : document.querySelector('.topbar');
      return Math.round(el.getBoundingClientRect().bottom);
    })()`
  );
  check(
    'collapsing still lands on the card head',
    head >= -8 && head <= chrome + 24,
    `card top at ${head}px, chrome ends at ${chrome}px`
  );
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
