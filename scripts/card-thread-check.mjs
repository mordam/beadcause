#!/usr/bin/env node
//
// What an opened card does with a long thread, and what it offers on an epic.
//
//   node scripts/card-thread-check.mjs [--baseline] [--keep] [--out=<dir>]
//
// Three things that are all the same complaint — an open card spends your attention
// on what you already know — and one that is a promise it cannot keep:
//
//   1. **No *Answer & close* on a bead bd will refuse to close.** gate-check.mjs
//      covers the refusal; this covers not needing it. `/api/question` says whether
//      the bead is gated, so an epic with open children draws no answer button at
//      all — the comment takes its place — and an ordinary question still draws one.
//   2. **A thread folded to the recent exchange.** Everything collapses to its
//      author line except the last thing each side said, and a fold is one tap on
//      that line — a tap that must not repaint the list, because the answer box
//      underneath it is holding a draft.
//   3. **Opening lands on my last message.** The top of a card is the question,
//      which is why you opened it; what you have lost is the conversation.
//
// Same shape as gate-check.mjs — the real public/app.js in a headless Chrome the
// size of a phone, against fixtures served from this process, so it never touches a
// daemon or a bead. `--baseline` serves the committed app.js/style.css, where every
// comment is open, the epic offers to close itself and the card opens at the top, so
// it must fail.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'card-thread-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
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

// Long enough that the brief scrolls on a 393x852 phone — which is the whole point
// of assertion 3: a card that fits on one screen has nowhere to scroll to, and would
// pass the jump check by accident.
const BRIEF = [
  'Should the router keep the standby build after a swap?',
  ...Array.from(
    { length: 24 },
    (_, i) =>
      `Paragraph ${i + 1}. The standby build is what a rollback swaps back to, so keeping ` +
      'it costs a copy of the tree and buys the only fast way out of a bad deploy.'
  ),
].join('\n\n');

const bead = (id, title, extra = {}) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-08T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: BRIEF,
  ...extra,
});

// The epic is the case this exists for: bd will not close it while its children are
// open, and the old card offered to anyway. The plain one is the control — it must
// keep every button it had.
const EPIC = bead('ct-1', 'Blue/green router — the epic', { issue_type: 'epic' });
const PLAIN = bead('ct-2', 'An ordinary question with a long thread');

const EPIC_GATE = {
  kind: 'epic',
  reason: 'an epic with 2 open child issues',
  blockers: [
    { id: 'ct-11', title: 'Swap the symlink under a held request' },
    { id: 'ct-12', title: 'Keep the standby tree after a swap' },
  ],
};

// A thread that has been round four times. Alternating sides on purpose: the last
// two entries are both the agent's, so a rule that kept "the last two comments"
// would leave nothing of mine on screen — which is the thing being ruled out.
const MINE = 'beadcause';
const THEM = 'claude';
const thread = (n) =>
  Array.from({ length: n }, (_, i) => ({
    id: `c-${i + 1}`,
    issue_id: PLAIN.id,
    author: i % 2 === 0 ? MINE : THEM,
    text:
      i % 2 === 0
        ? `Mine ${i + 1}: keep the standby tree — say what that costs on disk.`
        : `Theirs ${i + 1}: about 180MB per build, so two builds and the live tree.`,
    created_at: `2026-08-0${1 + Math.floor(i / 2)}T1${i}:00:00Z`,
  })).concat([
    {
      id: 'c-last-them',
      issue_id: PLAIN.id,
      author: THEM,
      text: 'Theirs last: I can make the count configurable if you want more than two.',
      created_at: '2026-08-09T09:00:00Z',
    },
  ]);

// Six alternating, then one more from them — so my last message is second from the
// bottom and the two that stay open are not adjacent to the ends by accident.
const COMMENTS = thread(6);
const LAST_MINE = COMMENTS.filter((c) => c.author === MINE).pop();
const LAST_THEM = COMMENTS[COMMENTS.length - 1];

const QUESTIONS = [EPIC, PLAIN].map((i) => toQuestion('demo', i));
const DETAIL = {
  [EPIC.id]: () => ({ ...toQuestion('demo', EPIC), comments: [], gate: EPIC_GATE }),
  [PLAIN.id]: () => ({ ...toQuestion('demo', PLAIN), comments: COMMENTS, gate: null }),
};

const DRAFT = 'Two is fine.';

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

const committed = (rel) => execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
const BASELINED = ['/app.js', '/style.css'];

/**
 * Every write the page attempted — nothing here should write anything.
 *
 * `/api/presence` is not a write in that sense: it is the page telling the daemon
 * which card is on screen, it happens on every open, and the monitor depends on it.
 */
const writes = [];
const real = () => writes.filter((w) => w.path !== '/api/presence');

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({ questions: QUESTIONS, workspaces: ['demo'], spaces: [], scope: 'human' });
    }
    if (p === '/api/question') {
      const make = DETAIL[url.searchParams.get('id')];
      return make ? json(make()) : json({ error: 'not found' });
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        writes.push({ path: p, ...JSON.parse(body || '{}') });
        json({ ok: true });
      });
    }
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
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

/* ------------------------------------------------------------------ chrome */

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    let id = 0;
    const pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const q = msg.id != null && pending.get(msg.id);
      if (!q) return;
      pending.delete(msg.id);
      msg.error ? q.reject(new Error(msg.error.message)) : q.resolve(msg.result);
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-thread-'));
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

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `card-thread-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

const KEY = (id) => JSON.stringify(QUESTIONS.find((q) => q.id === id).key);
const CARD = (id) => `document.querySelector('.card[data-key=' + JSON.stringify(${KEY(id)}) + ']')`;

const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 200; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(200);
  }
  return false;
};

/** Open a card the way a thumb does — the details toggle — and let it settle. */
const openCard = async (id) => {
  const card = CARD(id);
  if (!(await evalJs(s, `!!${card}`))) throw new Error(`no card for ${id}`);
  if (!(await evalJs(s, `${card}.querySelector('[data-role="answer"]') !== null`))) {
    await evalJs(s, `${card}.querySelector('[data-act="toggle"]').click()`);
    await waitFor(`${card}.querySelector('[data-role="answer"]') !== null`);
  }
  await sleep(900);
};

const collapseCard = async (id) => {
  await evalJs(s, `${CARD(id)}.querySelector('[data-act="collapse"]')?.click()`);
  await sleep(500);
};

/** What the buttons under the box are, and what stands in for the missing one. */
const BUTTONS = (id) => `(() => {
  const card = ${CARD(id)};
  const why = card.querySelector('.gate-why');
  const note = card.querySelector('[data-act="note"]');
  return {
    answer: !!card.querySelector('[data-act="answer"]'),
    note: !!note,
    notePrimary: note ? note.classList.contains('primary') : false,
    noteLabel: note ? note.textContent.trim() : '',
    dismiss: !!card.querySelector('[data-act="dismiss"]'),
    why: why ? why.textContent.replace(/\\s+/g, ' ').trim() : '',
    whyBlockers: [...card.querySelectorAll('.gate-why .gate-blockers .pill')].map((a) => a.textContent.trim()),
  };
})()`;

/**
 * The thread as it is drawn: which entries are folded, and what shows of them.
 *
 * Every reach is null-safe, because under `--baseline` there is no `.peek` at all and
 * a baseline run has to report that as failures rather than die halfway down.
 */
const THREAD = (id) => `(() => {
  const card = ${CARD(id)};
  const all = [...card.querySelectorAll('.comment:not(.pending)')];
  const seen = (el) => !!el && el.getClientRects().length > 0;
  const shown = (sel) => all.filter((c) => seen(c.querySelector(sel)));
  return {
    total: all.length,
    open: all
      .filter((c) => !c.classList.contains('shut'))
      .map((c) => c.querySelector('.md')?.textContent.trim() || ''),
    bodiesShown: shown('.md').length,
    peeksShown: shown('.peek').length,
    peekLines: shown('.peek').map((c) => c.querySelector('.peek').getClientRects()[0].height),
    firstPeek: all[0]?.querySelector('.peek')?.textContent.trim() || '',
  };
})()`;

/**
 * Where the card has put you, measured against my last message.
 *
 * `top` is that comment's offset from the top of whatever is actually scrolling —
 * the brief, usually — so 0 means it is exactly at the fold. `scrollTop` is there to
 * prove the card moved at all: a baseline that opens at the top reports 0 and reads
 * as a pass on `top` alone only if the thread happens to start there, which with a
 * 25-paragraph brief above it it does not.
 *
 * `atEnd` is why the fold is not asserted on its own. My last message is usually near
 * the bottom of the thread, and there is nothing below it to scroll up into — so the
 * honest requirement is "as far as it goes, and my message on screen", not a number.
 */
const WHERE = (id) => `(() => {
  const card = ${CARD(id)};
  const scrolls = (el) => el && el.scrollHeight > el.clientHeight + 1;
  const scroller = scrolls(card) ? card : card.querySelector(':scope > .brief');
  const mine = [...card.querySelectorAll('.comment[data-mine]')].pop();
  if (!scroller || !mine) return { scroller: !!scroller, mine: !!mine };
  const scrollable = Math.round(scroller.scrollHeight - scroller.clientHeight);
  return {
    scroller: true,
    mine: true,
    scrollTop: Math.round(scroller.scrollTop),
    scrollable,
    atEnd: Math.abs(scroller.scrollTop - scrollable) <= 2,
    height: Math.round(scroller.clientHeight),
    top: Math.round(mine.getBoundingClientRect().top - scroller.getBoundingClientRect().top),
    text: mine.querySelector('.md').textContent.trim(),
  };
})()`;

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

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelectorAll('.card').length >= 2`);

  /* ---- 1. the epic offers a comment, not a close ---- */
  await openCard(EPIC.id);
  const epic = await evalJs(s, BUTTONS(EPIC.id));
  await shot('epic');
  check('an epic bd will not close draws no Answer & close', epic.answer === false, `answer button: ${epic.answer}`);
  check('the comment takes its place, as the primary', epic.note && epic.notePrimary, JSON.stringify(epic.noteLabel));
  check(
    'and the card says why the button is missing',
    /can't be closed from here/i.test(epic.why) && /epic with 2 open child/i.test(epic.why),
    JSON.stringify(epic.why.slice(0, 110))
  );
  check(
    'naming the children in the way',
    epic.whyBlockers.join(',') === 'ct-11,ct-12',
    epic.whyBlockers.join(',') || 'none'
  );
  check('setting it aside is still offered', epic.dismiss === true, `dismiss: ${epic.dismiss}`);
  check('and nothing was written by opening it', real().length === 0, JSON.stringify(real().map((w) => w.path)));
  await collapseCard(EPIC.id);

  /* ---- 2. an ordinary question keeps every button ---- */
  await openCard(PLAIN.id);
  const plain = await evalJs(s, BUTTONS(PLAIN.id));
  check('an ungated question still answers and closes', plain.answer === true, `answer button: ${plain.answer}`);
  check('with the comment back to being the second option', plain.notePrimary === false, JSON.stringify(plain.noteLabel));
  check('and no note about a gate it does not have', plain.why === '', JSON.stringify(plain.why.slice(0, 60)));

  /* ---- 3. the thread is folded to the recent exchange ---- */
  const folded = await evalJs(s, THREAD(PLAIN.id));
  await shot('thread');
  check('every comment is on the card', folded.total === COMMENTS.length, `${folded.total} of ${COMMENTS.length}`);
  check('exactly two are open', folded.open.length === 2, `${folded.open.length} open`);
  check(
    'the last thing I said is one of them',
    folded.open.includes(LAST_MINE.text),
    JSON.stringify(folded.open.map((t) => t.slice(0, 24)))
  );
  check(
    'and the last thing they said is the other',
    folded.open.includes(LAST_THEM.text),
    JSON.stringify(folded.open.map((t) => t.slice(0, 24)))
  );
  check('the rest have no body on screen', folded.bodiesShown === 2, `${folded.bodiesShown} bodies drawn`);
  check(
    'but each shows a line of what it said',
    folded.peeksShown === COMMENTS.length - 2 && /Mine 1:/.test(folded.firstPeek),
    `${folded.peeksShown} peeks · ${JSON.stringify(folded.firstPeek.slice(0, 40))}`
  );
  check(
    'on one line each, never two',
    folded.peekLines.length > 0 && folded.peekLines.every((h) => h < 24),
    JSON.stringify(folded.peekLines)
  );

  /* ---- 4. opening lands on my last message ---- */
  const where = await evalJs(s, WHERE(PLAIN.id));
  check(
    'the card opened somewhere other than the top',
    where.scroller && where.scrollTop > 40,
    JSON.stringify(where)
  );
  check(
    'with my last message at the fold, or as close as the end of the thread allows',
    where.mine &&
      where.text === LAST_MINE.text &&
      where.top >= -2 &&
      where.top < where.height &&
      (where.top <= 24 || where.atEnd),
    JSON.stringify({ top: where.top, height: where.height, atEnd: where.atEnd })
  );

  /* ---- 5. a fold opens in place, and takes the draft with it ---- */
  //
  // The tap must not go through render(): the answer box below the thread is holding
  // a draft and possibly the caret, and this is the same list a 25-second poll
  // rebuilds. So: the draft survives, and the poll after it puts the comment back
  // open rather than folding it under the reader.
  await evalJs(
    s,
    `(() => {
      const box = ${CARD(PLAIN.id)}.querySelector('[data-role="answer"]');
      box.focus();
      box.value = ${JSON.stringify(DRAFT)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await sleep(300);
  const opened = await evalJs(
    s,
    `(() => {
      const card = ${CARD(PLAIN.id)};
      // Null-safe on purpose: under --baseline nothing is folded and there is no
      // toggle to press, and that has to come back as failing checks rather than as
      // an exception that ends the run.
      const first = card.querySelector('.comment.shut');
      if (!first) return { openedIt: false, folded: 0 };
      first.querySelector('[data-act="comment"]').click();
      return {
        openedIt: !first.classList.contains('shut'),
        bodyShown: first.querySelector('.md').getClientRects().length > 0,
        expanded: first.querySelector('[data-act="comment"]').getAttribute('aria-expanded'),
        open: card.querySelectorAll('.comment:not(.shut):not(.pending)').length,
        draft: card.querySelector('[data-role="answer"]').value,
        focused: document.activeElement === card.querySelector('[data-role="answer"]'),
      };
    })()`
  );
  check('tapping a folded comment opens it', opened.openedIt && opened.bodyShown, JSON.stringify(opened));
  check('and says so to a screen reader', opened.expanded === 'true', String(opened.expanded));
  check('the other two stay open', opened.open === 3, `${opened.open} open`);
  check('the draft under it is untouched', opened.draft === DRAFT, JSON.stringify(opened.draft));
  check('and the caret never left the box', opened.focused === true, String(opened.focused));

  // The poll that lands a moment later is the real test of where that choice lives.
  await evalJs(s, `document.querySelector('#refresh').click()`);
  await sleep(1200);
  const survived = await evalJs(
    s,
    `(() => {
      const card = ${CARD(PLAIN.id)};
      return {
        open: card.querySelectorAll('.comment:not(.shut):not(.pending)').length,
        draft: card.querySelector('[data-role="answer"]')?.value || '',
      };
    })()`
  );
  check(
    'a refresh leaves the comment you opened open',
    survived.open === 3,
    `${survived.open} open after refresh`
  );
  check('and the draft with it', survived.draft === DRAFT, JSON.stringify(survived.draft));
  check('none of this wrote anything', real().length === 0, JSON.stringify(real().map((w) => w.path)));
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
