#!/usr/bin/env node
//
// Is a proposed bead readable before you approve it?
//
//   node scripts/proposal-check.mjs [--baseline] [--keep]
//
// The approve/decline card is where the decision to file a bead actually gets
// made, and it used to show the least of any surface in the app: acceptance
// criteria wrapped in among the type and priority pills with no label saying what
// they were, the description came out as escaped text clamped to three lines — so
// a bulleted description was one run-on line, then truncated with no way to read
// the rest — and design, notes, labels and deps never appeared at all, even though
// approval writes every one of them.
//
// This drives the real public/app.js in a headless Chrome the size of a phone,
// against a proposal built by lib/proposal.js and parsed back by lib/decision.js,
// so the fixture is a real round trip and nothing here touches a bead. Same shape
// as scroll-check.mjs, and the same rule: `--baseline` serves the committed
// app.js and style.css instead of the working copy, so a failure here can be told
// apart from a flake — baseline must fail the record cases, the working copy must
// pass all of them.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { proposalBody, proposalTitle } from '../lib/proposal.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'proposal-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
// Screenshots of the folded and expanded row, for reviewing the look rather than
// the assertions. Off unless asked for, so a plain run stays a pass/fail.
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

// Bead 1 is the case the whole bead was about: a bulleted description and three
// acceptance criteria, plus every optional field approval would write.
const BEADS = [
  {
    title: 'Cache-bust site.js on deploy',
    type: 'task',
    priority: 2,
    description: [
      'The script tag carries no `?v=`, so a shipped change looks absent, and the',
      'paragraph saying so arrives hard-wrapped the way bd stores every field it',
      'has — which must reflow here rather than take a forced break per line:',
      '',
      '- a browser that has the page cached keeps the old file',
      '- a hard reload is the only way anyone finds out',
      '- which means the first report of a bug is always "it did nothing"',
    ].join('\n'),
    acceptance: [
      '- a deploy changes the URL of the script',
      '- an unreloaded browser gets the new file on its next navigation',
      '- the hash comes from the file, not from the clock',
    ].join('\n'),
    design: 'Hash the file at build time and stamp it into the template — no query string written by hand.',
    notes: 'Found while reading webapp/templates/base.html.',
    rationale: 'Every deploy so far has needed a "hard-reload it" message afterwards.',
    labels: ['ui', 'deploy'],
    deps: ['discovered-from:bc-4jt'],
  },
  // Short on purpose: a row with nothing to hide must not grow a fold control.
  {
    title: 'Drop the unused qr dependency',
    type: 'chore',
    priority: 4,
    description: 'Nothing imports it since the pairing screen moved.',
    acceptance: '',
    design: '',
    notes: '',
    rationale: '',
    labels: [],
    deps: [],
  },
];

const WS = 'demo';
const ISSUE = {
  id: 'pc-proposal',
  title: proposalTitle(WS, BEADS),
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: proposalBody(WS, BEADS),
};

const QUESTIONS = [{ ...toQuestion(WS, ISSUE), comments: [] }];
const KEY = QUESTIONS[0].key;
if (!QUESTIONS[0].proposal?.beads?.length) {
  console.error('the fixture did not parse back into a proposal — lib/proposal.js changed shape');
  process.exit(1);
}

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
// against HEAD of this very worktree. Both files, because half of what this
// checks — the indent, the fold — is in the stylesheet.
const committed = (f) => execFileSync('git', ['show', `HEAD:public/${f}`], { cwd: ROOT });

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({ questions: QUESTIONS, workspaces: [WS], spaces: [], scope: 'human' });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' });
    }
    // Everything else the app pokes at on boot — agents, work, consoles.
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/style.css')) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] });
      return res.end(committed(p.slice(1)));
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
  const port = 9600 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-proposal-'));
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
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  return r.result.value;
};

/* ------------------------------------------------------------------- probe */

// Everything is read off the row as the DOM actually is, by geometry and by tag
// name, so nothing here can agree with a bug in the rendering it is checking.
const ROW = (n) => `document.querySelector('.prop-row[data-idx="${n}"]')`;

const FIELD = (n, label) => `(() => {
  const row = ${ROW(n)};
  if (!row) return null;
  for (const f of row.querySelectorAll('.prop-field')) {
    const l = f.querySelector('.prop-label');
    const want = ${JSON.stringify(label)};
    if (want ? l && l.textContent.trim().toLowerCase() === want.toLowerCase() : !l) {
      return {
        lists: f.querySelectorAll('ul, ol').length,
        breaks: f.querySelectorAll('br').length,
        items: f.querySelectorAll('li').length,
        pills: f.querySelectorAll('.pill').length,
        text: f.textContent.replace(/\\s+/g, ' ').trim().slice(0, 120),
        left: Math.round(f.getBoundingClientRect().left),
      };
    }
  }
  return null;
})()`;

const PICKS = () => `(() => {
  const out = {};
  for (const row of document.querySelectorAll('.prop-row')) {
    out[row.dataset.idx] = {
      yes: row.querySelector('.prop-btn.yes').getAttribute('aria-pressed'),
      no: row.querySelector('.prop-btn.no').getAttribute('aria-pressed'),
      cls: [...row.classList].filter((c) => c.startsWith('pick-')).join(','),
    };
  }
  return out;
})()`;

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launch();

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
    `\n${BASELINE ? 'BASELINE (HEAD:public/app.js + style.css)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`
  );

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('.card[data-key]')`)) break;
  }
  if (!(await evalJs(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  await evalJs(s, `document.querySelector('.card[data-key=${JSON.stringify(KEY)}] [data-act="toggle"]').click()`);
  await sleep(600);
  if (!(await evalJs(s, `!!${ROW(1)}`))) throw new Error('the proposal never rendered');

  /* 1. the description is a list, under a label */
  const desc = await evalJs(s, FIELD(1, ''));
  check(
    'a bulleted description renders as a list',
    !!desc && desc.lists >= 1 && desc.items === 3,
    desc ? `${desc.lists} list(s), ${desc.items} items` : 'no description field at all'
  );
  check(
    'a hard-wrapped paragraph reflows instead of stepping down the screen',
    !!desc && desc.breaks === 0,
    desc ? `${desc.breaks} forced break(s)` : 'no description field at all'
  );

  /* 2. acceptance is its own labelled line, not a pill in among the others */
  const acc = await evalJs(s, FIELD(1, 'Done when'));
  check(
    'three acceptance criteria render as a list, labelled',
    !!acc && acc.lists >= 1 && acc.items === 3,
    acc ? `${acc.lists} list(s), ${acc.items} items` : 'no acceptance field at all'
  );
  const meta = await evalJs(
    s,
    `(() => { const m = ${ROW(1)}.querySelector('.prop-meta'); return m ? { kids: m.children.length, text: m.textContent.replace(/\\s+/g,' ').trim() } : null; })()`
  );
  check(
    'acceptance is not loose in among the type and priority pills',
    !!meta && meta.kids === 2 && !/deploy changes the URL/.test(meta.text),
    meta ? `pill row is "${meta.text}"` : 'no pill row'
  );

  /* 3. every field approval would write is on the row */
  for (const [label, want] of [
    ['Design', /Hash the file at build time/],
    ['Notes', /base\.html/],
  ]) {
    const f = await evalJs(s, FIELD(1, label));
    check(`${label.toLowerCase()} appears`, !!f && want.test(f.text), f ? f.text.slice(0, 60) : 'missing');
  }
  const labels = await evalJs(s, FIELD(1, 'Labels'));
  check('labels appear', !!labels && labels.pills === 2, labels ? `${labels.pills} pills` : 'missing');
  const deps = await evalJs(s, FIELD(1, 'Depends on'));
  check(
    'depends-on appears',
    !!deps && /discovered-from:bc-4jt/.test(deps.text),
    deps ? deps.text.slice(0, 60) : 'missing'
  );

  /* 4. the body hangs off the number, so the gutter reads as a list marker */
  const indent = await evalJs(
    s,
    `(() => {
      const row = ${ROW(1)};
      const at = (sel) => { const e = row.querySelector(sel); return e ? Math.round(e.getBoundingClientRect().left) : null; };
      // The text edge, not the box edge — an indent done with padding leaves the box
      // where it was, and it is the prose that has to line up with the title.
      const body = row.querySelector('.prop-body');
      const first = body && body.querySelector('.prop-field, .prop-meta');
      return { n: at('.prop-n'), title: at('.prop-title'), body: first ? Math.round(first.getBoundingClientRect().left) : null };
    })()`
  );
  check(
    'the body is indented under the title, past the number',
    indent.n != null && indent.body != null && indent.body > indent.n + 8 && Math.abs(indent.body - indent.title) <= 4,
    `number ${indent.n}px, title ${indent.title}px, body ${indent.body}px`
  );

  /* 5. a long row starts folded, with a way to open it; a short one doesn't */
  const folded = await evalJs(
    s,
    `(() => {
      const row = ${ROW(1)}, short = ${ROW(2)};
      const btn = row.querySelector('.prop-more');
      const body = row.querySelector('.prop-body') || row.querySelector('.prop-main');
      return {
        collapsed: row.classList.contains('is-collapsed'),
        hasBtn: !!btn,
        label: btn ? btn.textContent.trim() : '',
        height: Math.round(body.getBoundingClientRect().height),
        shortBtn: !!short.querySelector('.prop-more'),
        shortCollapsed: short.classList.contains('is-collapsed'),
      };
    })()`
  );
  check(
    'a long row starts folded, with a control that opens it',
    folded.collapsed && folded.hasBtn && /show/i.test(folded.label),
    `collapsed=${folded.collapsed}, button="${folded.label}", body ${folded.height}px`
  );
  check(
    'a short row is left alone — no fold, no control',
    !folded.shortCollapsed && !folded.shortBtn,
    `collapsed=${folded.shortCollapsed}, button=${folded.shortBtn}`
  );

  /* 6. nothing is cut off with no way to reach it */
  await evalJs(s, `${ROW(1)}.querySelector('.prop-more')?.click()`);
  await sleep(300);
  const opened = await evalJs(
    s,
    `(() => {
      const row = ${ROW(1)};
      const btn = row.querySelector('.prop-more');
      const body = row.querySelector('.prop-body') || row.querySelector('.prop-main');
      return {
        collapsed: row.classList.contains('is-collapsed'),
        label: btn ? btn.textContent.trim() : '',
        expanded: btn ? btn.getAttribute('aria-expanded') : '',
        height: Math.round(body.getBoundingClientRect().height),
      };
    })()`
  );
  check(
    'expanding shows the whole record',
    !opened.collapsed && opened.height > folded.height && opened.expanded === 'true',
    `body ${folded.height}px → ${opened.height}px, button now "${opened.label}"`
  );

  /* 7. the decision you are halfway through must survive the expand */
  await evalJs(s, `${ROW(1)}.querySelector('.prop-more')?.click()`); // fold it back
  await sleep(200);
  await evalJs(s, `${ROW(1)}.querySelector('.prop-btn.yes').click()`);
  await evalJs(s, `${ROW(2)}.querySelector('.prop-btn.no').click()`);
  await sleep(200);
  const before = await evalJs(s, PICKS());
  const goBefore = await evalJs(s, `document.querySelector('.prop-go').textContent.trim()`);
  await evalJs(s, `${ROW(1)}.querySelector('.prop-more')?.click()`);
  await sleep(300);
  const after = await evalJs(s, PICKS());
  const goAfter = await evalJs(s, `document.querySelector('.prop-go').textContent.trim()`);
  check(
    'expanding a row leaves the picks untouched',
    JSON.stringify(before) === JSON.stringify(after) && before['1'].yes === 'true' && before['2'].no === 'true',
    `${JSON.stringify(before)} → ${JSON.stringify(after)}`
  );
  check(
    'and leaves the primary button saying the same thing',
    goBefore === goAfter && /Create 1 of 2/.test(goAfter),
    `"${goBefore}" → "${goAfter}"`
  );

  /* 8. a poll must not fold a row back up under you */
  await evalJs(s, `window.beadcause.refresh()`);
  await sleep(1200);
  const survived = await evalJs(
    s,
    `(() => { const r = ${ROW(1)}; return r ? { collapsed: r.classList.contains('is-collapsed'), picks: ${PICKS()} } : null; })()`
  );
  check(
    'a refresh leaves the row open and the picks made',
    !!survived && !survived.collapsed && survived.picks['1'].yes === 'true' && survived.picks['2'].no === 'true',
    survived ? `collapsed=${survived.collapsed}` : 'the row vanished'
  );

  /* 9. still a phone card: nothing spills sideways, the buttons stay tappable */
  // Framed against the card rather than the viewport on purpose. The document is
  // wider than 393px before this card is even on it — .sheet-actions in the topbar
  // is six 40px buttons beside the brand — and measuring against the viewport would
  // just report that someone else's bug, every run, forever.
  const phone = await evalJs(
    s,
    `(() => {
      const row = ${ROW(1)};
      const card = row.closest('.card');
      const btns = [...row.querySelectorAll('.prop-btn')].map((b) => b.getBoundingClientRect());
      const over = [];
      for (const el of [row, ...row.querySelectorAll('*')]) {
        // A field that scrolls sideways is a field you cannot read one-handed: an
        // unbreakable dep id or a wide code span, escaping its column.
        if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'visible') {
          over.push((el.className || el.tagName) + ' ' + el.clientWidth + '→' + el.scrollWidth);
        }
      }
      return {
        cardRight: Math.round(card.getBoundingClientRect().right),
        rowRight: Math.round(row.getBoundingClientRect().right),
        over,
        minBtn: Math.round(Math.min(...btns.map((r) => Math.min(r.width, r.height)))),
        btnRight: Math.round(Math.max(...btns.map((r) => r.right))),
      };
    })()`
  );
  check(
    'the row stays inside its card — nothing spills sideways',
    phone.rowRight <= phone.cardRight && !phone.over.length,
    phone.over.length ? phone.over.join(', ') : `row ends at ${phone.rowRight}px, card at ${phone.cardRight}px`
  );
  check(
    'approve and decline are still thumb-sized and reachable',
    phone.minBtn >= 40 && phone.btnRight <= phone.cardRight,
    `${phone.minBtn}px, right edge ${phone.btnRight}px of ${phone.cardRight}px`
  );

  /* A picture of both states, for the times the numbers above are not the argument. */
  if (OUT) {
    fs.mkdirSync(OUT, { recursive: true });
    for (const [name, fold] of [
      ['proposal-expanded', false],
      ['proposal-folded', true],
    ]) {
      await evalJs(
        s,
        `(() => {
          const row = ${ROW(1)};
          const want = ${fold};
          if (row.classList.contains('is-collapsed') !== want) row.querySelector('.prop-more')?.click();
          row.scrollIntoView({ block: 'start' });
        })()`
      );
      await sleep(400);
      const shot = await s.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
      console.log(`  → ${file}`);
    }
  }

  if (KEEP) {
    console.log(`\n  serving at ${BASE}/?t=${TOKEN} — ctrl-c to stop\n`);
    await new Promise(() => {});
  }
} finally {
  if (!KEEP) {
    close();
    server.close();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
process.exit(failed.length ? 1 : 0);
