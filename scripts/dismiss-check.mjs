#!/usr/bin/env node
//
// The third button on a question: getting rid of it without answering it.
//
//   node scripts/dismiss-check.mjs [--baseline] [--shots]
//
// Dismissing takes a card out of the inbox without answering it, and it is one tap
// away from the two buttons you press all day. So what is worth testing is not that
// it works — it is everything that stops it working by accident:
//
//   • one tap must do NOTHING but arm. A card sits open in a pocket.
//   • the arm has to expire, or a card left open for an hour is one tap from
//     vanishing, with the button still promising it will confirm first.
//   • what is in the box rides along as the reason, and the label has to say so
//     before you commit — a note silently thrown away is worse than no note.
//   • it must reach `/api/dismiss` and nowhere else. Routed to `/api/respond` it
//     would be an *answer*, read for markers, and a dismissed delivery would merge
//     a pull request.
//   • a refused write must give the card back with the text still in it, like every
//     other write here.
//
// **It used to close the bead**, and the labels here pinned that: "Dismiss without
// answering", "Tap again — closes dm-1 unanswered". It closes nothing now — the
// acknowledgement lives in beadcause's own state — so what those cases pin instead
// is that no label anywhere claims otherwise, and that the toast says when the card
// comes back. See `test/closepaths.mjs` for the writes themselves.
//
// Real public/app.js and public/style.css in a headless Chrome the size of a phone,
// against fixtures served from this process. Nothing here touches a real bead.
//
// `--baseline` serves the committed public/, which is how you tell a real failure
// from a flaky one: at baseline there is no button at all and every case must fail.
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
const TOKEN = 'dismiss-check-token';
const BASELINE = process.argv.includes('--baseline');
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, '.claude', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'purify.js'))) {
  console.error('public/vendor is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const WS = 'demo';

// Two options on it, because one of the things under test is that arming an option
// disarms the dismiss button: two controls both reading "tap again" would be two
// different things one tap could do, and only one of them is what you meant.
const ISSUE = {
  id: 'dm-1',
  title: 'Gross or net?',
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: [
    'Which of the two the report should show.',
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
    '```',
  ].join('\n'),
};

const QUESTIONS = [{ ...toQuestion(WS, ISSUE), comments: [] }];
const KEY = QUESTIONS[0].key;
const ID = QUESTIONS[0].id;

// The note that has to reach the server as the reason, verbatim, and come back into
// the box unharmed when the write is refused.
const TYPED = 'Superseded — the report was dropped in the redesign.';

/* ------------------------------------------------------------------ server */

const write = { fail: false, calls: [] };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

const BASE_FILES = ['/app.js', '/style.css', '/index.html'];
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
    if (p === '/api/questions') {
      return json({
        questions: QUESTIONS,
        workspaces: [WS],
        spaces: [],
        scope: 'human',
        summary: { questions: QUESTIONS.length, sessions: 0, proposals: 0 },
      });
    }
    if (p === '/api/question') {
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' }, 404);
    }
    // Every write, recorded with the path it went to and the body it carried. Which
    // path it was is half of what this file is checking.
    if (p === '/api/dismiss' || p === '/api/respond' || p === '/api/comment') {
      let body = '';
      req.on('data', (c) => (body += c));
      return req.on('end', () => {
        write.calls.push({ path: p, body: JSON.parse(body || '{}') });
        return write.fail ? json({ error: 'bd: database is locked' }, 500) : json({ ok: true });
      });
    }
    if (p.startsWith('/api/')) return json({});

    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (BASELINE && BASE_FILES.includes(p === '/' ? '/index.html' : p)) {
      const bodyOut = committed(p === '/' ? '/index.html' : p);
      if (!bodyOut) return res.writeHead(404).end('no');
      res.writeHead(200, { 'content-type': TYPES[path.extname(p === '/' ? '.html' : p)] || TYPES['.html'] });
      return res.end(bodyOut);
    }
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return res.writeHead(404).end('no');
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
  const port = 9800 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-dismiss-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // The arm expires on a six-second timer, and an offscreen renderer throttled
      // to a frame a second would never fire it inside this run.
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

const waitFor = async (s, expr, tries = 60, gap = 120) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(gap);
  }
  return false;
};

/* -------------------------------------------------------------------- probes */

const K = JSON.stringify(KEY);
const CARD = `#list .card[data-key=${K}]`;
const DISMISS = `${CARD} .dismiss`;
const BOX = `${CARD} [data-role="answer"]`;
const tap = (s, sel) => evalJs(s, `(document.querySelector(${JSON.stringify(sel)}) || { click(){} }).click(), true`);

// Everything about the button a finger can see, in one round trip.
const STATE = `(() => {
  const b = document.querySelector(${JSON.stringify(DISMISS)});
  if (!b) return null;
  const cs = getComputedStyle(b);
  const row = document.querySelector(${JSON.stringify(`${CARD} .freeform .row`)});
  return {
    text: b.textContent.trim(),
    armed: b.classList.contains('confirm'),
    inRow: !!(row && row.contains(b)),
    rowButtons: row ? row.querySelectorAll('button').length : -1,
    width: Math.round(b.getBoundingClientRect().width),
    danger: cs.color,
  };
})()`;

// Type into the box the way a phone does — the app keeps drafts off `input`, so a
// value set without one is a draft the app never saw.
const type = (s, text) => evalJs(s, `(() => {
  const box = document.querySelector(${JSON.stringify(BOX)});
  box.value = ${JSON.stringify(text)};
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

let shotN = 0;
async function shot(s, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(SHOT_DIR, `dismiss-${String(++shotN).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(out, Buffer.from(r.data, 'base64'));
  console.log(`    · ${out}`);
}

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

  console.log(`\n${BASELINE ? 'BASELINE (HEAD:public/)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  const open = async () => {
    await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
    if (!(await waitFor(s, `!!document.querySelector('#list .card[data-key]')`)))
      throw new Error('the list never rendered');
    await tap(s, `${CARD} [data-act="toggle"]`);
    if (!(await waitFor(s, `!!document.querySelector(${JSON.stringify(BOX)})`)))
      throw new Error('the answer box never appeared');
  };
  await open();

  /* ============================================ 1. it is there, and it is quiet */

  console.log('the button');

  let st = await evalJs(s, STATE);
  await shot(s, 'at-rest');
  check('the answer box has a dismiss button', !!st, st ? st.text : 'no .dismiss in the card');
  check(
    // It used to read "Dismiss without answering", which was accurate about the
    // answering and wrong about everything else: it closed the bead. Now it sets
    // the card aside and the bead does not move, so the one word the label must
    // never contain is "close".
    'it says what it does, and never that it closes anything',
    !!st && /aside/i.test(st.text) && !/close/i.test(st.text),
    st ? `"${st.text}"` : ''
  );
  check(
    'it is under the two buttons, not a third one squeezed into the row',
    !!st && !st.inRow && st.rowButtons === 2,
    st ? `inRow=${st.inRow}, ${st.rowButtons} buttons in the row` : ''
  );
  check(
    'and narrower than the row, so it does not read as a third equal choice',
    !!st && st.width > 40 && st.width < VP.width * 0.7,
    st ? `${st.width}px of ${VP.width}` : ''
  );

  /* ================================================ 2. one tap does not dismiss */

  console.log('\none tap arms it, and nothing else');

  await tap(s, DISMISS);
  await sleep(120);
  st = await evalJs(s, STATE);
  await shot(s, 'armed');
  check('one tap writes nothing at all', write.calls.length === 0, `${write.calls.length} write(s) went out`);
  check('the card is still in the list', await evalJs(s, `!!document.querySelector(${JSON.stringify(CARD)})`), '');
  check(
    'the button now says the next tap is the one that does it',
    !!st && st.armed && /tap again/i.test(st.text),
    st ? `"${st.text}"` : ''
  );
  check(
    // Names the bead, and says *hides* — because the thing the second tap must not
    // be mistaken for is closing a question nobody has answered.
    'and names the bead it would hide, without claiming to close it',
    !!st && st.text.includes(ID) && /hides/i.test(st.text) && !/close/i.test(st.text),
    st ? `"${st.text}"` : ''
  );

  /* ================================================== 3. the arm does not linger */

  console.log('\nthe arm expires, and another control steals it');

  await sleep(6400);
  st = await evalJs(s, STATE);
  check(
    'six seconds later it has disarmed itself',
    !!st && !st.armed && !/tap again/i.test(st.text),
    st ? `"${st.text}"` : ''
  );

  await tap(s, DISMISS);
  await sleep(100);
  await tap(s, `${CARD} .option[data-opt="gross"]`);
  await sleep(120);
  st = await evalJs(s, STATE);
  check(
    'arming an option disarms the dismiss — one tap, one meaning',
    !!st && !st.armed,
    st ? `"${st.text}"` : ''
  );
  check('and still nothing has been written', write.calls.length === 0, `${write.calls.length} write(s)`);
  // Put the option's own arm down before it can be confirmed by the next tap.
  await sleep(6400);

  /* ============================================ 4. the box becomes the reason */

  console.log('\nwith something typed in the box');

  await type(s, TYPED);
  await sleep(120);
  st = await evalJs(s, STATE);
  check(
    'the label admits it would take the note with it',
    !!st && /with this note/i.test(st.text),
    st ? `"${st.text}"` : ''
  );

  await tap(s, DISMISS);
  await sleep(120);
  st = await evalJs(s, STATE);
  check(
    'and armed, it promises the note rather than "unanswered"',
    !!st && st.armed && /with your note/i.test(st.text),
    st ? `"${st.text}"` : ''
  );

  /* ============================================== 5. a refused write gives it back */

  console.log('\nthe write is refused');

  write.fail = true;
  await tap(s, DISMISS);
  await waitFor(s, `${write.calls.length} >= 0 && !!document.querySelector(${JSON.stringify(CARD)})`, 40, 150);
  await sleep(700);
  const refused = write.calls[0];
  check('the second tap is the one that writes', write.calls.length === 1, `${write.calls.length} write(s)`);
  check(
    'it goes to /api/dismiss — never to the route that reads answers for markers',
    refused?.path === '/api/dismiss',
    refused ? refused.path : 'no write at all'
  );
  check(
    'carrying the note as `reason`, and nothing that could be read as an answer',
    refused?.body?.reason === TYPED && refused?.body?.response === undefined,
    JSON.stringify(refused?.body || null)
  );
  const back = await evalJs(
    s,
    `(() => {
      const card = document.querySelector(${JSON.stringify(CARD)});
      const box = document.querySelector(${JSON.stringify(BOX)});
      return { card: !!card, text: box ? box.value : null };
    })()`
  );
  check('the refused card comes back', back.card, back.card ? '' : 'the card stayed gone');
  check('with the note still in the box', back.text === TYPED, JSON.stringify(back.text));

  /* ================================================== 6. and when it is accepted */

  console.log('\nthe write is accepted');

  write.fail = false;
  write.calls.length = 0;
  await tap(s, DISMISS);
  await sleep(150);
  await tap(s, DISMISS);
  const gone = await waitFor(s, `!document.querySelector(${JSON.stringify(CARD)})`, 40, 150);
  await sleep(400);
  await shot(s, 'dismissed');
  check('the card leaves the list', gone, gone ? '' : 'the card was still there');
  check(
    'exactly one dismissal went out',
    write.calls.length === 1 && write.calls[0].path === '/api/dismiss',
    JSON.stringify(write.calls.map((c) => c.path))
  );
  const said = await evalJs(s, `(document.querySelector('#toast') || {}).textContent || ''`);
  check('the toast does not say the question was answered', !/answered/i.test(said), said);
  check(
    // A card that vanishes under the word "Dismissed" reads as gone for good, and it
    // is not — the bead is still open and something will bring it back. The toast is
    // the only place that can say so before the card is off the screen.
    'and says when it comes back, because setting aside is not losing',
    /set aside/i.test(said) && /back when/i.test(said),
    said
  );
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(
  failed.length
    ? `\n${failed.length} of ${results.length} failed${BASELINE ? ' (expected at baseline)' : ''}`
    : `\nall ${results.length} passed`
);
process.exit(failed.length && !BASELINE ? 1 : 0);
