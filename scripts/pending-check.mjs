#!/usr/bin/env node
//
// The tap is answered before the fetch is. bc-jair.
//
//   node scripts/pending-check.mjs [--baseline] [--keep] [--out=<dir>]
//
// Tapping a shut card runs `expand()`, which awaits `/api/question` or `/api/bead` and
// only *then* opens the card. On a fast link that is invisible; on a train it is a card
// that sits there doing nothing, and a tap with nothing to show for itself is a tap
// people make again. The mark is `.card.opening` — a ring around the card, put on inside
// the tap's own handler by `paintOpening()` and taken off by the repaint that opens it.
//
// Five things are pinned here, and only a browser can see any of them:
//
//   1. **It is on before the browser has painted anything.** Asserted the hard way: the
//      click is dispatched and the class counted *inside one `Runtime.evaluate`*, so no
//      frame boundary can have happened in between. A `sleep` and a look would pass just
//      as well for a mark that arrived 300ms late.
//   2. **Nothing moves.** The ring is an inset outline, so the card's box and the title
//      inside it are pixel-identical across the tap. A border, or a wider one, would
//      shove the words sideways under the thumb.
//   3. **It goes when the card opens, and it goes when the fetch fails.** The second is
//      the one worth a check: `expand()` swallows both of its own failures, so a mark
//      that was only cleared on success would stick until the page was reloaded.
//   4. **A card whose detail is already in hand never flashes it.** Same one-evaluate
//      trick as (1), read the other way round: the card is already open and unmarked by
//      the time `click()` returns, so there was never a frame to flash in. The fixture
//      500s that bead's detail endpoint, so a fetch would fail the run rather than
//      quietly pass it.
//   5. **Reduced motion keeps the ring and drops the pulse.** Re-run against
//      `prefers-reduced-motion: reduce`, where the outline must still be 2px and the
//      animation must be `none`.
//
// Both card kinds that await before opening are covered — a `human` question, which goes
// full screen, and an agent bead, which expands inline. The pull request and JIRA rows
// deliberately are not: they answer to `pr-open`/`jira-open`, which put the sheet up
// first and fetch underneath it, so they never sat inert and have nothing to mark.
//
// Same shape as card-thread-check.mjs — the real public/app.js in a headless Chrome the
// size of a phone, against fixtures served from this process, so it never touches a
// daemon or a bead. `--baseline` serves the committed app.js/style.css, which has no
// pending mark at all, so it must fail.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { aliasPage, pageAliases } from '../lib/pagealias.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const VP = { width: 393, height: 852, dpr: 3 };
const TOKEN = 'pending-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const OUT = (process.argv.find((a) => a.startsWith('--out=')) || '').slice(6);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Long enough that the mark is unambiguously on screen between the tap and the answer,
// short enough that five taps do not make this the slowest check in the directory.
const DELAY = 1200;

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
  description: 'Whether the standby build is kept after a swap, and what that costs.',
  ...extra,
});

const SLOW = bead('pd-1', 'A question whose brief is a second away');
const CACHED = bead('pd-2', 'A question the list already carries the thread of');
const FAILS = bead('pd-3', 'A question whose brief will not load');
const AGENT = bead('pd-4', 'A bead nobody is asking about');

// `comments` is what `expand()` reads to decide whether it has to fetch at all — an empty
// array counts as fetched-and-empty, `undefined` as never asked. Putting one on the *list*
// row is how a card arrives already cached, which is case 4.
const QUESTIONS = [
  toQuestion('demo', SLOW),
  { ...toQuestion('demo', CACHED), comments: [] },
  toQuestion('demo', FAILS),
  { ...toQuestion('demo', AGENT), agent: true, status: 'in_progress', since: '2026-08-08T10:00:00Z' },
];

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
const ALIASES = pageAliases();

const writes = [];
const errors = [];
/** Which beads had their detail actually asked for — case 4 is an assertion about this. */
const asked = [];
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
    // The two endpoints `expand()` awaits, and the whole reason this check exists. Each
    // one is deliberately slow, deliberately broken or deliberately fatal — see `asked`.
    if (p === '/api/question' || p === '/api/bead') {
      const id = url.searchParams.get('id');
      asked.push(id);
      if (id === FAILS.id) return json({ error: 'the tracker is not answering' }, 500);
      // Case 4 must never get here: the list row already carries the thread, so a request
      // for it is the page having fetched anyway, and a 500 turns that into a red check
      // rather than a slower one that still passes.
      if (id === CACHED.id) return json({ error: 'this detail should never have been asked for' }, 500);
      const row = QUESTIONS.find((q) => q.id === id);
      return void setTimeout(() => json({ ...row, comments: [], gate: null }), DELAY);
    }
    if (req.method === 'POST' && p.startsWith('/api/')) {
      let body = '';
      req.on('data', (c) => (body += c));
      return void req.on('end', () => {
        const record = { path: p, ...JSON.parse(body || '{}') };
        (p === '/api/error' ? errors : writes).push(record);
        json({ ok: true });
      });
    }
    if (p.startsWith('/api/')) return json({});

    const rel = aliasPage(p, ALIASES).replace(/^\/+/, '');
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

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails)
    throw new Error(
      `${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 140)}`
    );
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
const { s, close } = await launchChrome('beadcause-pending-');

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `pending-${name}.png`);
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

/**
 * Tap the card and read the DOM back **without letting go of the thread**.
 *
 * This is the assertion, not a convenience. `click()` dispatches the listener
 * synchronously and the listener marks the card before its first `await`, so everything
 * returned here is what the page looked like at the instant the tap finished — with no
 * frame boundary, no timer and no network in between. Anything that arrived a paint later
 * would come back as `marked: 0` and fail, which is exactly the bug being ruled out.
 *
 * `geom` is measured either side of the click for the same reason: the ring must not move
 * the card or the words on it, and a rect read a moment later would be a rect the page had
 * had time to settle.
 */
const TAP = (id) => `(() => {
  const card = ${CARD(id)};
  const box = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height].map((n) => Math.round(n * 100) / 100); };
  const title = card.querySelector('.q');
  const before = { card: box(card), title: box(title) };
  card.click();
  const now = ${CARD(id)} || card;
  const style = getComputedStyle(now);
  return {
    marked: document.querySelectorAll('.card.opening').length,
    mine: now.classList.contains('opening'),
    outline: style.outlineWidth,
    colour: style.outlineColor,
    animation: style.animationName,
    // A marked card must still be *shut*: the point is that it says so while it waits,
    // not that it opens early with nothing in it.
    opened: now.classList.contains('open') || !!now.querySelector('[data-role="answer"]'),
    before,
    after: { card: box(now), title: box(now.querySelector('.q')) },
  };
})()`;

/** What is on screen once the dust has settled — the other half of every case. */
const SETTLED = (id) => `(() => {
  const card = ${CARD(id)};
  return {
    marked: document.querySelectorAll('.card.opening').length,
    mine: !!card && card.classList.contains('opening'),
    opened: !!card && (card.classList.contains('open') || !!card.querySelector('[data-role="answer"]')),
  };
})()`;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

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
  await waitFor(`document.querySelectorAll('.card').length >= 4`);

  /* ---- 1 & 2. the tap is answered at once, and nothing moves ---- */
  const tapped = await evalJs(s, TAP(SLOW.id));
  await shot('pending');
  check(
    'the tapped card is marked before the browser has painted anything',
    tapped.mine === true,
    JSON.stringify({ marked: tapped.marked, mine: tapped.mine })
  );
  check('and it is the only one marked', tapped.marked === 1, `${tapped.marked} marked`);
  check(
    'the mark is a 2px ring you can actually see',
    tapped.outline === '2px' && tapped.colour !== 'rgba(0, 0, 0, 0)',
    `${tapped.outline} · ${tapped.colour}`
  );
  check(
    'the card has not opened — it is waiting, and saying so',
    tapped.opened === false,
    `opened: ${tapped.opened}`
  );
  check(
    'the card did not move by so much as a pixel',
    same(tapped.before.card, tapped.after.card),
    `${JSON.stringify(tapped.before.card)} → ${JSON.stringify(tapped.after.card)}`
  );
  check(
    'nor did the words on it',
    same(tapped.before.title, tapped.after.title),
    `${JSON.stringify(tapped.before.title)} → ${JSON.stringify(tapped.after.title)}`
  );

  /* ---- 3a. and it goes when the card opens ---- */
  await waitFor(`${CARD(SLOW.id)}?.querySelector('[data-role="answer"]') !== null`);
  await sleep(300);
  const opened = await evalJs(s, SETTLED(SLOW.id));
  await shot('opened');
  check('the brief arrives and the card opens', opened.opened === true, JSON.stringify(opened));
  check('and the mark goes with it', opened.marked === 0 && opened.mine === false, JSON.stringify(opened));
  await evalJs(s, `${CARD(SLOW.id)}.querySelector('[data-act="collapse"]')?.click()`);
  await sleep(400);

  /* ---- 4. a card the list already carries the thread of never flashes ---- */
  const before = asked.length;
  const cached = await evalJs(s, TAP(CACHED.id));
  check(
    'a card whose detail is already in hand is open the instant it is tapped',
    cached.opened === true,
    JSON.stringify({ opened: cached.opened, marked: cached.marked })
  );
  check(
    'with no frame in between for the mark to flash in',
    cached.marked === 0,
    `${cached.marked} marked at the end of the tap`
  );
  check(
    'and nothing was fetched for it',
    asked.length === before,
    JSON.stringify(asked.slice(before))
  );
  await evalJs(s, `${CARD(CACHED.id)}.querySelector('[data-act="collapse"]')?.click()`);
  await sleep(400);

  /* ---- 3b. and it goes when the fetch fails, which is the one that used to stick ---- */
  const failing = await evalJs(s, TAP(FAILS.id));
  check('a card whose brief will not load is marked too', failing.mine === true, JSON.stringify(failing.marked));
  await sleep(1200);
  const gaveUp = await evalJs(s, SETTLED(FAILS.id));
  await shot('failed');
  check(
    'a refused fetch clears the mark rather than leaving it lit forever',
    gaveUp.marked === 0 && gaveUp.mine === false,
    JSON.stringify(gaveUp)
  );
  check('and the card still opens on what the list already knew', gaveUp.opened === true, JSON.stringify(gaveUp));
  await evalJs(s, `${CARD(FAILS.id)}.querySelector('[data-act="collapse"]')?.click()`);
  await sleep(400);

  /* ---- the other card kind: a bead nobody is asking about, which expands inline ---- */
  const agentWas = await evalJs(s, `${CARD(AGENT.id)}.getBoundingClientRect().height`);
  const agent = await evalJs(s, TAP(AGENT.id));
  check(
    'an agent bead is marked on the tap as well — same handler, same wait',
    agent.mine === true && agent.outline === '2px',
    JSON.stringify({ mine: agent.mine, outline: agent.outline })
  );
  await sleep(DELAY + 600);
  const agentDone = await evalJs(s, SETTLED(AGENT.id));
  // This card expands *inline* and wears neither `.open` nor an answer box, so the only
  // honest evidence that the fetch landed and the card redrew is that it got taller.
  const agentNow = await evalJs(s, `${CARD(AGENT.id)}.getBoundingClientRect().height`);
  check(
    'and unmarked once it has expanded',
    agentDone.marked === 0 && agentDone.mine === false && agentNow > agentWas,
    JSON.stringify({ ...agentDone, was: Math.round(agentWas), now: Math.round(agentNow) })
  );

  /* ---- 5. reduced motion keeps the ring and drops the pulse ---- */
  await s.send('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelectorAll('.card').length >= 4`);
  const quiet = await evalJs(s, TAP(SLOW.id));
  await shot('reduced-motion');
  check(
    'reduced motion still gets the ring — the mark is the point, the pulse is not',
    quiet.mine === true && quiet.outline === '2px',
    JSON.stringify({ mine: quiet.mine, outline: quiet.outline })
  );
  check(
    'and nothing on it animates',
    quiet.animation === 'none',
    `animation-name: ${quiet.animation}`
  );

  check('none of this wrote anything', real().length === 0, JSON.stringify(real().map((w) => w.path)));
  /**
   * Last, because an error can arrive at any point in the run and this is the assertion
   * that has seen all of them.
   *
   * One is *expected*, and staged on purpose: case 3b's bead 500s its own detail, and the
   * page reporting that is the page working. So the refusal is counted rather than
   * ignored — a run where it is missing means the fetch this check is about never
   * happened, which would make the clearing assertion above pass for the wrong reason.
   */
  const said = (e) => `${e.kind || 'error'} — ${e.message || JSON.stringify(e)}`;
  const staged = errors.filter((e) => /\/api\/question/.test(said(e)) && /500/.test(said(e)));
  check(
    'the fetch this check stages a refusal for did refuse',
    staged.length === 1,
    `${staged.length} refusals reported`
  );
  check(
    'and the page reported no errors of its own beyond it',
    errors.length === staged.length,
    errors.filter((e) => !staged.includes(e)).map(said).join(' · ')
  );
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
