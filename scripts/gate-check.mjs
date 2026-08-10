#!/usr/bin/env node
//
// What the phone does when bd will not close the bead.
//
//   node scripts/gate-check.mjs [--baseline] [--keep] [--out=<dir>]
//
// The server now refuses the *close* before writing anything and says why (409 with
// a `gate`). This is the other half: what that has to look like in your hand. The
// failure it is defending against is not an exception — it is you reading a red
// toast over a question you just answered, concluding the answer was lost, and
// typing it in again. Five beads across two workspaces carry the same answer two
// and three times over from exactly that.
//
// So the assertions are mostly about what must NOT happen: no error toast, no
// write, and the draft still in the box.
//
// Same shape as scroll-check.mjs — the real public/app.js in a headless Chrome the
// size of a phone against fixtures served from this process, so it never touches a
// daemon or a bead. `--baseline` serves the committed app.js/style.css, where a 409
// is just an error, so it must fail.
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
const TOKEN = 'gate-check-token';
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

const bead = (id, title) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: 'Should we do the thing?\n\nA short brief, with nothing clever in it.',
});

// The first one is the sophab case — sp-hz3.5, blocked by three open beads and
// answered three times over. The second closes normally, which is what proves the
// gate is not simply refusing everything.
const GATED = bead('gt-1', 'Go live — the one bd will not close');
const FREE = bead('gt-2', 'An ordinary question');
const QUESTIONS = [GATED, FREE].map((i) => ({ ...toQuestion('demo', i), comments: [] }));
const GATE = {
  kind: 'blocked',
  reason: 'blocked by gt-9, gt-8',
  blockers: [
    { id: 'gt-9', title: 'Deliver the paid plan set immediately' },
    { id: 'gt-8', title: 'preflight.py has no Stripe check' },
  ],
};
const ANSWER = 'I want sample sets first.';

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

/** Every write the page attempted — the assertion for "nothing was written". */
const writes = [];

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
      const q = QUESTIONS.find((x) => x.id === url.searchParams.get('id'));
      return q ? json(q) : json({ error: 'not found' });
    }
    if ((p === '/api/respond' || p === '/api/comment' || p === '/api/dismiss') && req.method === 'POST') {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const parsed = JSON.parse(body || '{}');
        writes.push({ path: p, ...parsed });
        // The gated bead refuses the close, exactly as the server does — 409, a
        // reason, and nothing written. Commenting on it is fine, which is the whole
        // point of the offer.
        //
        // `/api/dismiss` gates identically, because a dismissal is a close too. What
        // it changes is `canComment`: a dismissal carries an optional note, and with
        // nothing typed there is nothing to offer to save.
        if (p === '/api/respond' && parsed.id === GATED.id) {
          return json({ error: `bd will not close ${GATED.id}: ${GATE.reason}`, gate: GATE, canComment: true }, 409);
        }
        // `/api/dismiss` is deliberately NOT gated: it closes nothing, so the bead
        // bd will least let you close is dismissed like any other.
        if (p === '/api/dismiss') return json({ ok: true, closed: false, dismissed: true, until: GATE.reason });
        json({ ok: true, closed: p !== '/api/comment' });
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
  const port = 9800 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-gate-'));
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
  const file = path.join(OUT, `gate-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

const KEY = (id) => JSON.stringify(QUESTIONS.find((q) => q.id === id).key);

/** Open a question's card and type an answer into it, then press Answer & close. */
const answerIt = async (id, text) => {
  // The key carries a slash (`demo/gt-1`), so it has to be a quoted attribute value.
  const card = `document.querySelector('.card[data-key=' + JSON.stringify(${KEY(id)}) + ']')`;
  if (!(await evalJs(s, `!!${card}`))) throw new Error(`no card for ${id}`);
  // Open it the way a thumb does — the details toggle — rather than by reaching
  // into the module. Already-open is fine; the toggle is checked first.
  if (!(await evalJs(s, `${card}.querySelector('[data-role="answer"]') !== null`))) {
    await evalJs(s, `${card}.querySelector('[data-act="toggle"]').click()`);
    await sleep(700);
  }
  await evalJs(
    s,
    `(() => {
      const box = ${card}.querySelector('[data-role="answer"]');
      box.focus();
      box.value = ${JSON.stringify(text)};
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await sleep(300);
  await evalJs(s, `${card}.querySelector('[data-act="answer"]').click()`);
  await sleep(600);
};

/**
 * Wait for the screen to settle after an answer.
 *
 * A refused answer is not instant: the beads fly out of the card on the tap, and
 * the card only comes back once that flight has been reversed. Polling for the
 * note rather than sleeping a guessed number of milliseconds is what keeps this
 * from being a check that passes on a fast machine and fails on a busy one.
 */
const waitFor = async (expr, ms = 8000) => {
  for (let i = 0; i < ms / 200; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(200);
  }
  return false;
};

const NOTE = `(() => {
  const n = document.querySelector('.gate-note');
  return {
    shown: !!n,
    text: (n?.textContent || '').replace(/\\s+/g, ' ').trim(),
    blockers: [...document.querySelectorAll('.gate-blockers .pill')].map((a) => a.textContent.trim()),
    draft: document.querySelector('[data-role="answer"]')?.value || '',
    toast: !document.querySelector('#toast').hidden,
    cards: document.querySelectorAll('.card').length,
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
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `document.querySelectorAll('.card').length >= 2`)) break;
  }

  /* ---- the refused close comes back as a note, not an error ---- */
  writes.length = 0;
  await answerIt(GATED.id, ANSWER);
  // Sampled before the wait below, not after: the toast hides itself after 6s, so
  // asking once the note has settled would let a baseline that DID shout pass this.
  const earlyToast = await evalJs(s, `!document.querySelector('#toast').hidden`);
  const appeared = await waitFor(`!!document.querySelector('.gate-note')`);
  const note = await evalJs(s, NOTE);
  await shot('note');

  check('the card says bd will not close it', appeared && note.shown, JSON.stringify(note.text.slice(0, 90)));
  check('and says why, in words', /blocked by gt-9, gt-8/.test(note.text), note.text.slice(0, 120));
  check('naming the beads in the way', note.blockers.join(',') === 'gt-9,gt-8', note.blockers.join(','));
  check('it says nothing was written', /nothing has been written/i.test(note.text), note.text.slice(0, 160));
  check(
    'the answer is still in the box',
    note.draft === ANSWER,
    JSON.stringify(note.draft)
  );
  check('no error toast over it', earlyToast === false && note.toast === false, `early=${earlyToast} late=${note.toast}`);
  check('the question is still in the list', note.cards === 2, `${note.cards} cards`);
  check(
    'and the server was asked exactly once, for the close',
    writes.length === 1 && writes[0].path === '/api/respond',
    JSON.stringify(writes.map((w) => w.path))
  );

  /* ---- "Not now" writes nothing and keeps the answer ---- */
  await evalJs(s, `document.querySelector('[data-act="gate-dismiss"]')?.click()`);
  await waitFor(`!document.querySelector('.gate-note')`);
  await sleep(300);
  const dismissed = await evalJs(s, NOTE);
  check('Not now takes the note away', dismissed.shown === false, JSON.stringify(dismissed.shown));
  check('and leaves the answer where it was', dismissed.draft === ANSWER, JSON.stringify(dismissed.draft));
  check('having written nothing', writes.length === 1, JSON.stringify(writes.map((w) => w.path)));

  /* ---- "Save as a comment" is the offer, and it takes it ---- */
  await answerIt(GATED.id, ANSWER);
  await waitFor(`!!document.querySelector('[data-act="gate-comment"]')`);
  // Null-safe: under --baseline there is no offer at all, and a baseline run has to
  // report that as failures rather than die on a missing button.
  await evalJs(s, `document.querySelector('[data-act="gate-comment"]')?.click()`);
  await waitFor(`!document.querySelector('.gate-note')`);
  await sleep(800);
  const saved = writes.filter((w) => w.path === '/api/comment');
  check(
    'Save as a comment posts the answer as a comment',
    saved.length === 1 && saved[0].text === ANSWER && saved[0].id === GATED.id,
    JSON.stringify(saved)
  );
  const after = await evalJs(s, NOTE);
  check('the note goes once it is taken', after.shown === false, String(after.shown));
  check(
    'and the bead stays in the list, because it is still open',
    after.cards === 2,
    `${after.cards} cards`
  );

  /* ---- and dismissing the very same bead is not gated at all ---- */
  //
  // The gate belongs to *answering*, which closes the bead. Dismissing does not,
  // so the bead bd will least let you close — the one you most want off the screen
  // — is dismissed without a murmur. It briefly did 409 here too, which was fixing
  // the wrong thing: it made the unclosable card also undismissable.
  //
  // Two taps, because the button arms first.
  await evalJs(s, `document.querySelector('[data-act="gate-dismiss"]')?.click()`);
  await sleep(400);
  writes.length = 0;
  const gatedCard = `document.querySelector('.card[data-key=' + JSON.stringify(${KEY(GATED.id)}) + ']')`;
  // Saving the comment collapsed the card, so the dismiss button is not in the DOM
  // until it is open again.
  if (!(await evalJs(s, `${gatedCard}?.querySelector('[data-act="dismiss"]') !== null`))) {
    await evalJs(s, `${gatedCard}.querySelector('[data-act="toggle"]').click()`);
    await sleep(700);
  }
  const armedLabel = await evalJs(
    s,
    `(() => {
      const b = ${gatedCard}.querySelector('[data-act="dismiss"]');
      if (!b) return null;
      const before = b.textContent.trim();
      b.click();
      const armed = ${gatedCard}.querySelector('[data-act="dismiss"]').textContent.trim();
      return { before, armed };
    })()`
  );
  check(
    'the dismiss button never says it closes anything',
    armedLabel && !/close/i.test(armedLabel.before) && !/close/i.test(armedLabel.armed),
    JSON.stringify(armedLabel)
  );
  check(
    'and the armed tap says what it really does — hides it',
    armedLabel && /hides/i.test(armedLabel.armed),
    JSON.stringify(armedLabel?.armed)
  );
  await evalJs(s, `${gatedCard}.querySelector('[data-act="dismiss"]')?.click()`);
  await waitFor(`document.querySelectorAll('.card').length === 1`);
  const binned = await evalJs(s, NOTE);
  check(
    'dismissing the bead bd will not close just works',
    binned.cards === 1 && !binned.shown,
    `${binned.cards} cards, note=${binned.shown}`
  );
  check(
    'through /api/dismiss, once',
    writes.length === 1 && writes[0].path === '/api/dismiss',
    JSON.stringify(writes.map((w) => w.path))
  );

  /* ---- the gate is not simply refusing everything ---- */
  writes.length = 0;
  await answerIt(FREE.id, 'Yes, go ahead.');
  // The gated card was set aside just above, so this one leaving empties the list.
  await waitFor(`document.querySelectorAll('.card').length === 0`);
  const ordinary = await evalJs(s, NOTE);
  check(
    'a question bd would close still answers and leaves the list',
    ordinary.cards === 0 && !ordinary.shown,
    `${ordinary.cards} cards, note=${ordinary.shown}`
  );
  check(
    'through the ordinary answer path',
    writes.length === 1 && writes[0].path === '/api/respond' && writes[0].id === FREE.id,
    JSON.stringify(writes.map((w) => `${w.path} ${w.id}`))
  );
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
