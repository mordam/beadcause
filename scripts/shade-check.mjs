#!/usr/bin/env node
//
// The prompt that appears when narrowing the filter leaves notifications behind.
//
//   node scripts/shade-check.mjs [--baseline] [--out=<dir>]
//
// The server half of this has a suite of its own (test/ringing.mjs). What that cannot
// reach is the half that lives in a thumb, and it is where this feature can fail
// while every unit test passes:
//
//   • **The pane has to be inside `#list`.** Every handler on the inbox is delegated
//     from that element, so a section drawn in a sibling container renders perfectly
//     and does nothing at all — the exact trap `requestsHtml` documents. A button that
//     looks right and answers nothing is the worst outcome available here.
//   • **It has to arrive on the tap that narrowed the filter**, from that response,
//     not a poll 25 seconds later.
//   • **Each button must reach `/api/notifications/dismiss` with the right `confirm`,
//     and carry the keys it was shown.** Routed anywhere else — `/api/dismiss`, say —
//     it would set the beads aside instead of clearing a notification, which is the
//     one confusion this whole feature is built to avoid.
//   • **The pane must go on the tap**, and must not come back on the next poll.
//   • And it must survive a poll landing while it is on screen, because a prompt that
//     flickers away unanswered is a prompt that never got answered.
//
// Same shape as gate-check.mjs and its siblings: the real public/app.js in a headless
// Chrome the size of a phone, against fixtures served from this process, so it never
// touches a daemon or a bead. `--baseline` serves the committed app.js, which has
// never heard of any of this, so it must fail.
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
const TOKEN = 'shade-check-token';
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

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };
const BASELINED = ['/app.js', '/style.css'];
const committed = (rel) => execFileSync('git', ['-C', ROOT, 'show', `HEAD:${rel}`]);

/* ---------------------------------------------------------------- fixtures */

// Two workspaces in two spaces, so narrowing to one space excludes the other. Built
// through `toQuestion` rather than hand-written, for the same reason its siblings do
// it: the inbox reads a dozen fields off a question and a fixture missing one fails as
// "can't reach the server", which is a confusing way to learn you mistyped a shape.
//
// The beads themselves are ordinary. Nothing about them says "ringing" — that is a
// fact the server holds, never a field on a question.
const bead = (id, title) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: 'A short brief, with nothing clever in it.',
});

const question = (workspace, space, id, title) => ({
  ...toQuestion(workspace, bead(id, title)),
  space,
  comments: [],
});

const QUESTIONS = [
  question('alpha', 'Work', 'a-1', 'Ship the router change?'),
  question('beta', 'Personal', 'b-1', 'Rename the sideproject?'),
  question('beta', 'Personal', 'b-2', 'Drop the old keystore?'),
];
const SPACES = [
  { name: 'Work', workspaces: ['alpha'], quiet: false, muted: false, count: 1 },
  { name: 'Personal', workspaces: ['beta'], quiet: false, muted: false, count: 2 },
];
const RINGING = ['beta/b-1', 'beta/b-2'];

/** What the server would decide, in the one line of it this fixture needs. */
let filter = { space: 'all', workspace: 'all' };
let declined = [];
let cleared = [];
const askNow = () => {
  if (filter.space === 'all' && filter.workspace === 'all') return null;
  const keys = RINGING.filter((k) => {
    const q = QUESTIONS.find((x) => x.key === k);
    if (filter.space !== 'all' && q.space !== filter.space) return true;
    if (filter.workspace !== 'all' && q.workspace !== filter.workspace) return true;
    return false;
  }).filter((k) => !declined.includes(k) && !cleared.includes(k));
  return keys.length ? { count: keys.length, keys } : null;
};

/** Every write the page attempted, so "which endpoint" is an assertion. */
const writes = [];

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const read = (fn) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => fn(JSON.parse(body || '{}')));
    };

    if (p === '/api/questions') {
      return json({
        questions: QUESTIONS,
        requests: [],
        workspaces: ['alpha', 'beta'],
        spaces: SPACES,
        filter,
        dismissAsk: askNow(),
        summary: { questions: QUESTIONS.length, sessions: 0, proposals: 0 },
        scope: 'human',
      });
    }
    // What the space picker draws itself from on a page that has not swept the tracker.
    // The inbox has, so it feeds the picker off `/api/questions` above and this is only
    // the first paint — but a 404 here would leave the bar hidden until that arrives,
    // and the checks below drive the bar.
    if (p === '/api/spaces') {
      return json({
        spaces: SPACES,
        workspaces: ['alpha', 'beta'],
        counts: QUESTIONS.reduce((acc, q) => ({ ...acc, [q.workspace]: (acc[q.workspace] || 0) + 1 }), {}),
        filter,
        waiting: QUESTIONS.length,
      });
    }
    if (p === '/api/filter' && req.method === 'POST') {
      return void read((parsed) => {
        writes.push({ path: p, ...parsed });
        filter = { space: parsed.space || 'all', workspace: parsed.workspace || 'all' };
        // The real server prunes a decline that has stopped applying. Same rule here,
        // so the "widen then narrow again asks afresh" case is reachable.
        declined = declined.filter((k) => (askNow()?.keys || []).includes(k) || false);
        json({ ok: true, filter, dismissAsk: askNow() });
      });
    }
    if (p === '/api/notifications/dismiss' && req.method === 'POST') {
      return void read((parsed) => {
        writes.push({ path: p, ...parsed });
        const keys = parsed.keys || [];
        if (parsed.confirm) cleared.push(...keys);
        else declined.push(...keys);
        json({ ok: true, cleared: parsed.confirm ? keys.length : 0, left: parsed.confirm ? 0 : keys.length, dismissAsk: null });
      });
    }
    // Anything else the page pokes at — presence, work, activity — answers blandly.
    if (p.startsWith('/api/')) {
      if (req.method === 'POST') return void read(() => json({}));
      return json({});
    }

    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
    if (BASELINE && BASELINED.includes(`/${rel}`)) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(committed(`public/${rel}`));
    }
    const file = path.join(PUBLIC, rel);
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      return void res.writeHead(404).end('no');
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok });
  console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-shade-');

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

const shot = async (name) => {
  if (!OUT) return;
  fs.mkdirSync(OUT, { recursive: true });
  const { data } = await s.send('Page.captureScreenshot', { format: 'png' });
  const file = path.join(OUT, `shade-${name}.png`);
  fs.writeFileSync(file, Buffer.from(data, 'base64'));
  console.log(`    → ${file}`);
};

/** What the pane looks like from outside — and crucially, where it is in the DOM. */
const PANE = `(() => {
  const el = document.querySelector('.shade-ask');
  return {
    shown: !!el,
    inList: !!el && el.closest('#list') !== null,
    text: (el?.textContent || '').replace(/\\s+/g, ' ').trim(),
    buttons: [...(el?.querySelectorAll('button') || [])].map((b) => b.dataset.act),
  };
})()`;

/**
 * Tap something, and say so rather than throwing when it is not there.
 *
 * `--baseline` serves an app.js that has never heard of any of this, so every control
 * this file reaches for is missing. A stack trace there would be technically correct
 * and useless: the point of baseline mode is a clean list of what the change adds.
 */
const press = async (sel) => {
  const there = await evalJs(`document.querySelector(${JSON.stringify(sel)}) !== null`);
  if (there) await evalJs(`document.querySelector(${JSON.stringify(sel)}).click()`);
  return there;
};
const act = (name) => press(`[data-act="${name}"]`);

/**
 * Narrow the inbox to a space — through the space picker in the top bar, which is what
 * the two chip rows became (public/spacebar.js). A `<select>` is not something you can
 * `.click()` into a value, so this is the value plus the `change` the page listens for.
 *
 * Same contract as `press` above: it reports whether the control was there rather than
 * throwing, because `--baseline` serves an app.js that has never heard of any of this.
 */
const chip = async (space) => {
  const there = await evalJs(`document.querySelector('#space-pick') !== null`);
  if (!there) return false;
  const value = space === 'all' ? 'all' : `space:${space}`;
  return evalJs(`(() => {
    const s = document.querySelector('#space-pick');
    if (![...s.options].some((o) => o.value === ${JSON.stringify(value)})) return false;
    s.value = ${JSON.stringify(value)};
    s.dispatchEvent(new Event('change'));
    return true;
  })()`);
};

try {
  await s.send('Page.enable');
  await s.send('Runtime.enable');
  await s.send('Emulation.setDeviceMetricsOverride', {
    width: VP.width, height: VP.height, deviceScaleFactor: VP.dpr,
    mobile: true, screenWidth: VP.width, screenHeight: VP.height,
  });
  await s.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  await waitFor(`document.querySelectorAll('.card').length >= 3`, 15000);

  check('nothing is asked before the filter moves', !(await evalJs(PANE)).shown);

  /* ---- narrowing asks, on the tap ---- */

  await chip('Work');
  const asked = await waitFor(`document.querySelector('.shade-ask') !== null`, 4000);
  const pane = await evalJs(PANE);
  check('narrowing to a space asks about what it hides', asked && pane.shown, pane.text.slice(0, 60));
  check('and it says how many', /\b2 unread notifications\b/.test(pane.text), pane.text.slice(0, 40));
  // The trap this file exists for. A pane outside #list draws identically.
  check('the pane is inside #list, so its buttons are delegated to at all', pane.inList);
  check('both answers are offered', JSON.stringify(pane.buttons) === JSON.stringify(['shade-clear', 'shade-leave']), String(pane.buttons));
  check(
    'nothing has been written yet — it asks, it does not act',
    writes.filter((w) => w.path === '/api/notifications/dismiss').length === 0
  );
  await shot('asked');

  /* ---- a poll landing while it is on screen must not take it away ---- */

  await evalJs(`window.dispatchEvent(new Event('focus'))`);
  await sleep(1200);
  check('a refresh landing under it leaves the prompt up', (await evalJs(PANE)).shown);

  /* ---- Leave them ---- */

  const pressedLeave = await act('shade-leave');
  const wentOnLeave = pressedLeave && (await waitFor(`document.querySelector('.shade-ask') === null`));
  await sleep(600);
  const left = writes.filter((w) => w.path === '/api/notifications/dismiss').pop();
  check('Leave them takes the pane away', wentOnLeave);
  check('and reaches /api/notifications/dismiss, not /api/dismiss', Boolean(left) && !writes.some((w) => w.path === '/api/dismiss'));
  check('with confirm false — a decline is recorded, not a no-op', left?.confirm === false);
  check(
    'and the keys it was shown, so nothing else can be swept up',
    JSON.stringify((left?.keys || []).slice().sort()) === JSON.stringify(RINGING.slice().sort()),
    String(left?.keys)
  );

  await press('#refresh');
  await sleep(1200);
  check('declining does not come back on the next poll', !(await evalJs(PANE)).shown);

  /* ---- Clear them, on a fresh ask ---- */

  // Widen, then narrow again: the decline stopped applying when the beads came back
  // into view, so this is a new question rather than an inherited silence.
  await chip('all');
  await sleep(700);
  await chip('Work');
  const askedAgain = await waitFor(`document.querySelector('.shade-ask') !== null`, 4000);
  check('widening and narrowing again asks afresh', askedAgain);

  const pressedClear = await act('shade-clear');
  const wentOnClear = pressedClear && (await waitFor(`document.querySelector('.shade-ask') === null`));
  await sleep(600);
  const done = writes.filter((w) => w.path === '/api/notifications/dismiss').pop();
  const toast = await evalJs(`document.querySelector('#toast').textContent`);
  check('Clear them takes the pane away too', wentOnClear);
  check('with confirm true', done?.confirm === true);
  check('the toast says the beads stay open', /stay/.test(toast), toast);
  // The point of the whole feature: the cards are exactly as they were.
  await chip('all');
  check(
    'the beads are still in the inbox — clearing a notification decides nothing',
    await waitFor(`document.querySelectorAll('.card').length >= 3`)
  );
  await shot('cleared');
} finally {
  close();
  server.close();
}

const failed = results.filter((r) => !r.ok).length;
console.log(failed ? `\n\x1b[31m${failed} of ${results.length} failed\x1b[0m\n` : `\n${results.length} passed\n`);
process.exit(failed ? 1 : 0);
