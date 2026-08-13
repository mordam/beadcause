#!/usr/bin/env node
//
// Can the three gestures be performed with a thumb?
//
//     node scripts/editgesture-check.mjs [--baseline] [--keep]
//
// This is bc-p49x.2's acceptance criteria, and the half of it no suite can answer. Every
// case here is driven as touches — `Input.dispatchTouchEvent` against a real Chrome with
// touch emulation on and a phone's viewport — because the whole design of the gesture
// layer is a bet about what a *finger* does, and every part of that bet is invisible to a
// vm:
//
//   - **A tap and a hold and a scroll are the same three events** until you time them.
//     test/editchanges.mjs fires `pointerdown` and moves the clock by hand, which proves
//     the logic and assumes the browser delivers the sequence. Chrome is the thing that
//     actually decides — it synthesises pointer events from touches, and it is the thing
//     that starts scrolling the list out from under a hold.
//   - **The scroll is the case that matters.** A mode that swallowed the scroller would
//     make the inbox unreachable below the fold with nothing on screen saying why, and it
//     is exactly what a naive "drag from pointerdown" implementation does. So a swipe is
//     performed here and the page is required to have *moved*.
//   - **`elementFromPoint` needs a real layout.** What a drop lands on is a question
//     about where things are on a 393-point screen, and a fixture that agrees with the
//     implementation about that is a fixture that proves nothing.
//
// `--baseline` serves the committed public/ instead of the working copy, which is how you
// check a failure here is a real one — it fails everything, being a page from before the
// gestures existed. Note the trap the sibling checks all carry: it serves `git show
// HEAD:…`, so it only proves anything BEFORE you commit.
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
const TOKEN = 'editgesture-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'marked.js'))) {
  console.error('public/vendor is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const BEAD = (n, title) => ({
  id: `eg-${n}`,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T09:00:00Z',
  updated_at: '2026-08-01T09:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: `A short brief for ${title}.`,
});

// Enough cards that the list is taller than the screen, because one of the cases is that
// the list still scrolls in this mode — which cannot be asked of a page that fits.
// The titles are phrases that appear nowhere in public/*.js, so an anchor on one can only
// come back as tracker text.
const BEADS = [
  BEAD(1, 'Zarquon threshold for the ledger sweep'),
  BEAD(2, 'Vermilion backstop on the nightly import'),
  BEAD(3, 'Perihelion budget for the quarterly rollup'),
  BEAD(4, 'Cinnabar quota on the archive walk'),
  BEAD(5, 'Tessellate the overnight reconciliation'),
  BEAD(6, 'Manticore limit for the outbound queue'),
  BEAD(7, 'Halyard offset in the settlement window'),
  BEAD(8, 'Quicksilver ceiling on the retry ladder'),
];

const asQuestions = (issues) => issues.map((i) => ({ ...toQuestion('demo', i), comments: [] }));

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

function committed(rel) {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
  } catch {
    return null;
  }
}
const BASELINED = ['/index.html', '/app.js', '/editmode.js', '/style.css'];

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      return json({ questions: asQuestions(BEADS), workspaces: ['demo'], spaces: [], scope: 'human' });
    }
    if (p.startsWith('/api/')) return json({});

    const rel = p === '/' ? '/index.html' : p;
    if (BASELINE && BASELINED.includes(rel)) {
      const body = committed(`public${rel}`);
      if (!body) {
        res.writeHead(404).end('no');
        return;
      }
      res.writeHead(200, { 'content-type': TYPES[path.extname(rel)] });
      return res.end(body);
    }
    const file = path.join(PUBLIC, rel.replace(/^\/+/, ''));
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404).end('no');
      return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/* -------------------------------------------------------------------- hand */

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  }
  return r.result.value;
};

/** One finger, as a phone reports it. */
const finger = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 12, radiusY: 12, force: 1 }];

/** A tap: down, the pixel of slide every real finger makes, up. */
async function tap(s, { x, y }) {
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(x, y) });
  await sleep(40);
  await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: finger(x + 1, y) });
  await sleep(40);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(300);
}

/** A hold, and then nothing: the gesture that says "this one, and let me tell you why". */
async function hold(s, { x, y }, ms = 750) {
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(x, y) });
  await sleep(ms);
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(350);
}

/** A hold and then a drag, in the small steps a thumb actually moves in. */
async function holdDrag(s, from, to, { ms = 750, steps = 10 } = {}) {
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(from.x, from.y) });
  await sleep(ms);
  for (let i = 1; i <= steps; i++) {
    const x = from.x + ((to.x - from.x) * i) / steps;
    const y = from.y + ((to.y - from.y) * i) / steps;
    await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: finger(x, y) });
    await sleep(25);
  }
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: finger(to.x, to.y) });
  await sleep(350);
}

/** A scroll: straight into the move, which is the whole difference from the drag above. */
async function swipe(s, from, to, steps = 10) {
  await s.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(from.x, from.y) });
  for (let i = 1; i <= steps; i++) {
    const y = from.y + ((to.y - from.y) * i) / steps;
    await s.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: finger(from.x, y) });
    await sleep(16);
  }
  await s.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(500);
}

/** The middle of whatever this selector finds, in viewport points. */
const boxOf = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, top: r.top, bottom: r.bottom };
})()`;

const at = async (s, sel) => {
  const box = await evalJs(s, boxOf(sel));
  if (!box) throw new Error(`nothing to aim at: ${sel}`);
  return box;
};

/** Type into whatever has focus, the way the phone's keyboard does. */
async function type(s, text) {
  await s.send('Input.insertText', { text });
  await sleep(120);
}

/** Fill the open note box and add it, all by thumb. */
async function addNote(s, words) {
  await tap(s, await at(s, '.editnote-box'));
  await type(s, words);
  await tap(s, await at(s, '[data-act="edit-note-add"]'));
}

// Optional-chained on purpose: under `--baseline` this API does not exist, and a check
// that dies on a stack reads as broken where one that reports failures reads as the
// baseline it is.
const CHANGES = `JSON.stringify(window.beadcause?.editMode?.changes?.() || [])`;
const changes = async (s) => JSON.parse(await evalJs(s, CHANGES));

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-editgesture-');

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
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__egErrors = [];
      addEventListener('error', (e) => window.__egErrors.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__egErrors.push(String(e.reason)));`,
  });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD:public)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('.card[data-key]')`)) break;
  }
  if (!(await evalJs(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  // Every gesture below is aimed at a rectangle read a moment before it, because entering
  // the mode pushes the whole document down by the height of the banner.
  await tap(s, await at(s, '#editmode'));
  await evalJs(s, `window.beadcause.editMode.ready()`);
  await sleep(400);
  check('the ✏️ takes a tap from a thumb', await evalJs(s, `document.body.classList.contains('editing')`));

  /* 1. the scroll — the case a gesture layer breaks first */
  const wasAt = await evalJs(s, `window.scrollY`);
  await swipe(s, { x: 200, y: 600 }, { x: 200, y: 260 });
  const after = await evalJs(s, `({ y: window.scrollY, picked: !!document.querySelector('.editpick'), note: !!document.querySelector('.editnote') })`);
  check(
    'the list still scrolls under a thumb in edit mode',
    after.y > wasAt + 20,
    `${wasAt} → ${after.y}`
  );
  check('and a scroll picks nothing up and asks nothing', !after.picked && !after.note);
  check('and files nothing', (await changes(s)).length === 0);
  await evalJs(s, `window.scrollTo(0, 0)`);
  await sleep(300);

  /* 2. describe — a hold on a card, and a sentence about it */
  await hold(s, await at(s, '.card[data-key] p.q'));
  const asked = await evalJs(s, `document.querySelector('.editnote')?.textContent || null`);
  check('a hold asks what the thing under your thumb should do instead', Boolean(asked && /instead/i.test(asked)), asked ? `"${asked.slice(0, 60)}…"` : 'no note box');
  const refused = await evalJs(s, `document.querySelector('[data-act="edit-note-add"]')?.disabled === true`);
  check('and refuses to file it with nothing said', refused);
  await addNote(s, 'this title should say which workspace it came from');
  const one = await changes(s);
  check(
    'a described element is one entry, carrying the words and the anchor',
    one.length === 1 && one[0].kind === 'describe' && /which workspace/.test(one[0].note) && Boolean(one[0].anchor?.selector),
    JSON.stringify(one[0]?.said || null)
  );

  /* 3. point — a hold, a drag, and what it landed against */
  const from = await at(s, '.card[data-key] p.q');
  const cards = await evalJs(s, `document.querySelectorAll('.card[data-key]').length`);
  const to = await evalJs(
    s,
    `(() => { const c = document.querySelectorAll('.card[data-key]')[2]; const r = c.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + 6 }; })()`
  );
  await holdDrag(s, from, to);
  const dropped = await evalJs(s, `document.querySelector('.editnote')?.textContent || null`);
  check('a hold and a drag lands against another element and says which', Boolean(dropped && /(above|below|inside|out of)/.test(dropped)), dropped ? `"${dropped.slice(0, 70)}…"` : `no note box (${cards} cards)`);
  check(
    'and the element it came from is already back where it was',
    await evalJs(s, `!document.querySelector('.editdrag') && !document.querySelector('[style*="translate"]')`)
  );
  await addNote(s, 'this belongs under the buttons, not over them');
  const two = await changes(s);
  const point = two.find((c) => c.kind === 'point');
  check(
    'a point records a relationship to an element, not a position',
    Boolean(point && point.where?.rel && point.where.rel !== 'nowhere' && !/\b\d+px\b/.test(JSON.stringify(point))),
    point ? `${point.where?.rel} “${point.where?.target?.text?.value?.slice(0, 24) || ''}”` : 'no point recorded'
  );

  /* 4. retype — the one literal edit, and the one refusal that matters most */
  await evalJs(s, `window.scrollTo(0, 0)`);
  await sleep(200);
  await tap(s, await at(s, '.card[data-key] p.q'));
  const said = await evalJs(s, `document.querySelector('.editbar-say')?.textContent || ''`);
  check(
    'a tap on a bead’s own title is refused, because that is the tracker',
    /tracker/i.test(said) && !(await evalJs(s, `!!document.querySelector('[contenteditable="true"]')`)),
    `"${said}"`
  );

  // Something the app itself wrote, chosen by asking the page rather than by naming a
  // selector here: what is retypable is a fact about the source, and a check that picked
  // one by hand would go stale the first time that line moved.
  const chrome = await evalJs(
    s,
    `(() => {
       for (const el of document.querySelectorAll('#list *, header *, .topbar *, footer *')) {
         if (el.children.length) continue;
         const r = el.getBoundingClientRect();
         if (r.width < 8 || r.height < 8 || r.top < 50 || r.bottom > ${VP.height} - 60) continue;
         const a = window.beadcause.editMode.anchorFor(el);
         if (a?.editable?.ok) return { x: r.left + r.width / 2, y: r.top + r.height / 2, was: a.text.value };
       }
       return null;
     })()`
  );
  if (!chrome) {
    check('there is chrome text on this screen the app wrote in exactly one place', false, 'found none to retype');
  } else {
    await tap(s, chrome);
    check(
      `“${chrome.was}” opens for retyping under a thumb`,
      await evalJs(s, `!!document.querySelector('[contenteditable="true"]')`)
    );
    await type(s, 'Retyped by a thumb');
    // The keyboard's own return key, which is the way out of an edit on a phone: there is
    // no "tap away" that does not mean something else in this mode.
    await s.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await s.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(300);
    const typed = (await changes(s)).find((c) => c.kind === 'retype');
    check(
      'and the old string and the new one are both in the record',
      Boolean(typed && typed.from === chrome.was && /Retyped by a thumb/.test(typed.to)),
      typed ? `“${typed.from}” → “${typed.to}”` : 'no retype recorded'
    );
  }

  /* 5. the change list: everything said so far, reviewable, one tap from being dropped */
  const count = await evalJs(s, `document.querySelector('.editbar-count')?.textContent || null`);
  const all = await changes(s);
  check('the banner carries the running count of the pass', count === String(all.length), `${count} of ${all.length}`);
  await tap(s, await at(s, '[data-act="edit-list"]'));
  const rows = await evalJs(
    s,
    `[...document.querySelectorAll('.editlist-row')].map((r) => r.querySelector('.editlist-said')?.textContent || '')`
  );
  check(
    'the list shows every edit, in the order they were made',
    rows.length === all.length && rows.every((r, i) => r.includes(all[i].said.slice(0, 20))),
    `${rows.length} rows: ${JSON.stringify(rows.map((r) => r.slice(0, 28)))}`
  );
  const first = all[0];
  await tap(s, await at(s, `[data-drop="${first.id}"]`));
  const left = await changes(s);
  check(
    'and any one of them can be dropped with a thumb before it is saved',
    left.length === all.length - 1 && !left.some((c) => c.id === first.id),
    `${all.length} → ${left.length}`
  );

  /* 6. and none of it was ever a change to the app */
  const before = await evalJs(s, `document.querySelector('.editlist-foot')?.textContent || ''`);
  check('the list says outright that nothing here has changed the app', /Nothing here has changed the app/.test(before), `"${before}"`);
  await tap(s, await at(s, '[data-act="edit-done"]'));
  await sleep(800);
  const done = await evalJs(
    s,
    `({
       editing: document.body.classList.contains('editing'),
       banner: !!document.querySelector('.editbar'),
       note: !!document.querySelector('.editnote'),
       marked: document.querySelectorAll('.editretyped, .editsaid, .editpick, .editdrag').length,
       retyped: document.body.textContent.includes('Retyped by a thumb'),
       held: JSON.parse(JSON.stringify(window.beadcause?.editMode?.changes?.() || [])).length,
       badge: document.getElementById('editmode')?.getAttribute('data-changes') || null,
       label: document.getElementById('editmode')?.getAttribute('aria-label') || '',
     })`
  );
  check('leaving the mode takes the banner, the boxes and every mark with it', !done.editing && !done.banner && !done.note && done.marked === 0, JSON.stringify(done));
  check('the app is saying what it always said — nothing was applied', !done.retyped);
  check('and the pass itself survives, because leaving is not discarding', done.held === left.length, `${done.held} of ${left.length} kept`);
  // The screen being back the way the app has it is the truth, and is also what a failed
  // save looks like. The count on the way back in is the only thing that tells them apart.
  check(
    'the ✏️ says how many are still held, so a reverted screen does not read as a loss',
    done.badge === String(left.length) && /unsaved/.test(done.label),
    `badge ${done.badge}, “${done.label}”`
  );

  const errors = await evalJs(s, `(window.__egErrors || []).slice(0, 3)`);
  check('nothing threw along the way', errors.length === 0, errors.join(' · '));
} catch (err) {
  // Anything that could not be aimed at, tapped or read is a failure of this check rather
  // than a crash of it: the run stops here, but what it did prove is still printed and the
  // exit code still says no. It is also what `--baseline` looks like from the inside.
  check('the check ran to the end', false, String(err?.message || err).split('\n')[0]);
} finally {
  if (!KEEP) await close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} failed\n` : `\n${results.length} passed\n`);
if (BASELINE && !bad.length) {
  console.log('BASELINE PASSED — this check proves nothing. Run it before committing.');
  process.exit(1);
}
process.exit(BASELINE ? 0 : bad.length ? 1 : 0);
