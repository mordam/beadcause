#!/usr/bin/env node
//
// Does edit mode actually hold the screen still, and does a tap name a line of source?
//
//     node scripts/editmode-check.mjs [--baseline] [--keep]
//
// This is bc-p49x.1's acceptance criteria, driven against the real thing: a poll cycle
// has to pass with edit mode on and leave the DOM untouched, and any element tapped has
// to yield an anchor that a text search finds exactly one source site for — or that says
// honestly it found none.
//
// Neither half can be proved by test/editmode.mjs, and for two different reasons. The
// freeze is a claim about the whole page — the poller, the reconciler and the renderer
// agreeing to do nothing — where the suite can only read the two gates as text. And the
// anchor's premise is that a *real* element under a *real* Chrome, with the classes the
// browser actually gives it, resolves to one line: a hand-made element in a vm is one
// this check was written to agree with.
//
// The proof that the freeze is real is the control case, and it runs first: with the
// mode OFF, the same poll against the same changed payload replaces the very nodes the
// frozen case then keeps. Without it, a check that marked nodes and found them intact
// would pass just as happily against a page that never polled at all.
//
// `--baseline` serves the committed public/ instead of the working copy, which is how
// you check a failure here is a real one. Note the trap the sibling checks all carry:
// it serves `git show HEAD:…`, so it only proves anything BEFORE you commit.
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
const TOKEN = 'editmode-check-token';
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
  id: `em-${n}`,
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

// The title is deliberately a phrase that appears nowhere in public/*.js, so the anchor
// on it can only come back as tracker text — if it ever comes back as source, something
// has started matching loosely and every retype after it would be filed against the
// wrong file.
const FIRST = [BEAD(1, 'Zarquon threshold for the ledger sweep'), BEAD(2, 'Vermilion backstop on the nightly import')];
// What the second and third polls answer with. Two of them, not one, because the first
// change is spent proving the marker technique can see a rebuild at all — so the frozen
// case needs a change of its own that has never been on screen.
const SECOND = [BEAD(1, 'Zarquon threshold for the ledger sweep — revised'), BEAD(2, 'Vermilion backstop on the nightly import')];
const THIRD = [BEAD(1, 'Zarquon threshold for the ledger sweep — reconsidered'), BEAD(2, 'Vermilion backstop on the nightly import')];

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

// The committed copy of a file, for --baseline. A file that does not exist at HEAD — the
// state this very branch is in before it lands — comes back null and is served as a 404,
// which is the honest baseline: a page from before edit mode existed.
function committed(rel) {
  try {
    return execFileSync('git', ['show', `HEAD:${rel}`], { cwd: ROOT });
  } catch {
    return null;
  }
}
const BASELINED = ['/index.html', '/app.js', '/editmode.js', '/style.css'];

let polls = 0;

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/questions') {
      polls += 1;
      // The first sweep is the list you enter the mode looking at; every one after it
      // carries the change the frozen screen must not show and the thawed one must.
      return json({
        questions: asQuestions(polls === 1 ? FIRST : polls === 2 ? SECOND : THIRD),
        workspaces: ['demo'],
        spaces: [],
        scope: 'human',
      });
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

const evalJs = async (s, expr) => {
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true });
  if (r.exceptionDetails) {
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 120)}`);
  }
  return r.result.value;
};

/* ------------------------------------------------------------------- probe */

// Stamp every node in the list with a token of this generation, so "was the DOM
// rebuilt" is answered by identity rather than by comparing HTML to itself. A node the
// reconciler replaced has no stamp; a node it left alone still carries the one it was
// given. Measured this way rather than by node count because a rebuild that happens to
// produce the same number of nodes is exactly the rebuild that would go unnoticed.
const STAMP = (gen) => `(() => {
  const nodes = [...document.querySelectorAll('#list, #list *')];
  for (const el of nodes) el.__em = ${gen};
  return nodes.length;
})()`;

const SURVIVORS = (gen) => `(() => {
  const nodes = [...document.querySelectorAll('#list, #list *')];
  return {
    total: nodes.length,
    kept: nodes.filter((el) => el.__em === ${gen}).length,
    fresh: nodes.filter((el) => el.__em === undefined).length,
  };
})()`;

/** An anchor for the first element matching a selector, as JSON. */
const ANCHOR = (sel) => `(() => {
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return { missing: true };
  return window.beadcause.editMode.anchorFor(el);
})()`;

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-editmode-');

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
  // Before the navigation, because the errors worth catching are the ones a new file
  // throws on load — and by the time anything else here can run, boot is over.
  await s.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__emErrors = [];
      addEventListener('error', (e) => window.__emErrors.push(String(e.message || e.error)));
      addEventListener('unhandledrejection', (e) => window.__emErrors.push(String(e.reason)));`,
  });

  console.log(`\n${BASELINE ? 'BASELINE (HEAD:public)' : 'working copy'} · ${VP.width}x${VP.height} · ${BASE}\n`);

  await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
  for (let i = 0; i < 60; i++) {
    await sleep(200);
    if (await evalJs(s, `!!document.querySelector('.card[data-key]')`)) break;
  }
  if (!(await evalJs(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  /* 0. the control — the same poll, unfrozen, does replace the DOM */
  await evalJs(s, STAMP(1));
  await evalJs(s, `window.beadcause.refresh()`);
  await sleep(1200);
  const loose = await evalJs(s, SURVIVORS(1));
  check(
    'unfrozen, a poll that changes a bead does rebuild part of the list',
    loose.fresh > 0,
    `${loose.fresh} new nodes of ${loose.total}`
  );

  /* 1. the mode is enterable and says so */
  const entered = await evalJs(
    s,
    `(() => {
      document.getElementById('editmode').click();
      return {
        pressed: document.getElementById('editmode').getAttribute('aria-pressed'),
        editing: document.body.classList.contains('editing'),
        banner: document.querySelector('.editbar')?.textContent || null,
      };
    })()`
  );
  check('the ✏️ turns the mode on', entered.pressed === 'true' && entered.editing, JSON.stringify(entered));
  check(
    'and the banner says the screen is frozen',
    Boolean(entered.banner && /frozen/i.test(entered.banner)),
    entered.banner ? `"${entered.banner}"` : 'no banner'
  );

  // The banner has to be visible where a thumb can reach it — a truthful sentence off
  // the bottom of a scrolled page is not the mode saying anything.
  const bannerBox = await evalJs(
    s,
    `(() => { const b = document.querySelector('.editbar'); if (!b) return null; const r = b.getBoundingClientRect();
      return { top: Math.round(r.top), height: Math.round(r.height), wide: Math.round(r.width) }; })()`
  );
  check(
    'the banner is at the top of the screen, not somewhere in the document',
    Boolean(bannerBox && bannerBox.top <= 0 + 1 && bannerBox.height > 20 && bannerBox.wide >= VP.width - 2),
    JSON.stringify(bannerBox)
  );

  await evalJs(s, `window.beadcause.editMode.ready()`);
  await sleep(600);

  /* 2. the acceptance: a poll cycle passes and the DOM is not rebuilt */
  await evalJs(s, STAMP(2));
  const before = await evalJs(s, `document.querySelector('#list').innerHTML.length`);
  const pollsBefore = polls;
  await evalJs(s, `window.beadcause.refresh()`);
  await sleep(1500);
  const frozen = await evalJs(s, SURVIVORS(2));
  const after = await evalJs(s, `document.querySelector('#list').innerHTML.length`);
  check('the poll still ran while the screen was frozen', polls > pollsBefore, `${pollsBefore} → ${polls} sweeps`);
  check(
    'and not one node of the list was replaced',
    frozen.fresh === 0 && frozen.kept === frozen.total,
    `${frozen.fresh} new, ${frozen.kept} of ${frozen.total} kept`
  );
  check('the list is character for character what it was', before === after, `${before} → ${after}`);
  const showsOld = await evalJs(s, `!document.querySelector('#list').textContent.includes('reconsidered')`);
  check('the change that poll carried is not on screen yet', showsOld);

  /* 3. any element tapped yields an anchor that names one line, or honestly none */
  const chrome = await evalJs(s, ANCHOR('#refresh'));
  check(
    'a chrome control resolves to exactly one line of this app`s source',
    chrome.source?.found === 1,
    `${chrome.source?.found} sites via ${chrome.source?.query} — ${JSON.stringify(chrome.source?.sites?.[0] || null)}`
  );
  // The mode's own banner: written once, in public/editmode.js, and drawn on the screen
  // it is describing. Chrome text is only retypable when it is written in exactly one
  // place, and most of this app's labels are not — 'Show details' is written twice.
  const say = await evalJs(s, ANCHOR('.editbar-say'));
  check(
    'chrome text written in exactly one place is source text, and may be retyped',
    say.text?.from === 'source' && say.editable?.ok === true,
    `${say.text?.from}; ${say.editable?.why || 'editable'}`
  );

  // A control inside a card, which is where the grep-key premise has to hold if the
  // apply half is ever to work: a data-act names the one handler branch that answers it.
  const toggle = await evalJs(s, ANCHOR('.card[data-key] [data-act="toggle"]'));
  check(
    'a control inside a card resolves to one line too',
    toggle.source?.found === 1,
    `${toggle.source?.found} sites via ${toggle.source?.query}`
  );

  const title = await evalJs(s, ANCHOR('.card[data-key] p.q'));
  check(
    'a bead`s own title comes back as tracker text',
    title.text?.from === 'data',
    `${title.text?.from}: "${title.text?.value}"`
  );
  check(
    'and is refused rather than offered as an app edit',
    title.editable?.ok === false && /tracker/.test(title.editable?.why || ''),
    title.editable?.why
  );
  // `<p class="q">` is written three times in public/app.js — the card's head, its foot
  // and the agent card — so this is the third outcome the anchor has to be honest about:
  // not one site, not none, but every candidate named and nothing offered as an edit.
  // The chain is what narrows it: the `.card-head` around it rules the foot's out.
  const narrowed = (title.source?.tried || []).some((t) => String(t.kind).endsWith('+chain'));
  check(
    'an ambiguous element is narrowed by its chain rather than guessed at',
    narrowed && title.source.found > 0 && title.source.found < 3,
    `${title.source?.found} sites; tried ${JSON.stringify(title.source?.tried)}`
  );
  check(
    'and every candidate is named, with nothing offered as an edit',
    title.source?.sites?.length === title.source?.found && title.editable?.ok === false,
    `${title.source?.sites?.length} listed of ${title.source?.found}`
  );
  check(
    'the anchor carries a selector chain and the owning chunk',
    Boolean(title.selector && title.selector.includes('.q') && title.key),
    `${title.selector} · ${title.key}`
  );

  // The honest none. An element this app never wrote — added here so the check can ask
  // for the answer the acceptance criteria name as acceptable.
  const none = await evalJs(
    s,
    `(() => {
      const el = document.createElement('div');
      el.className = 'zzz-nothing-drew-this';
      el.textContent = 'zzz nothing wrote this either';
      document.body.appendChild(el);
      const a = window.beadcause.editMode.anchorFor(el);
      el.remove();
      return a;
    })()`
  );
  check(
    'an element the app never wrote reports none rather than guessing',
    none.source?.found === 0 && Array.isArray(none.source?.tried) && none.source.tried.length > 0,
    `found ${none.source?.found} after trying ${none.source?.tried?.length} keys`
  );

  /* 4. leaving the mode takes exactly one catch-up repaint */
  await evalJs(s, `document.getElementById('editmode').click()`);
  await sleep(900);
  const thawed = await evalJs(
    s,
    `({
      editing: document.body.classList.contains('editing'),
      banner: !!document.querySelector('.editbar'),
      caught: document.querySelector('#list').textContent.includes('reconsidered'),
      seen: document.querySelector('.card[data-key] p.q')?.textContent || null,
    })`
  );
  check('leaving the mode takes the banner and the tint with it', !thawed.editing && !thawed.banner, JSON.stringify(thawed));
  check(
    'and one repaint catches the screen up on everything the poll carried',
    thawed.caught,
    thawed.caught ? '' : 'the list is still showing the payload from before the mode'
  );

  const errors = await evalJs(s, `(window.__emErrors || []).slice(0, 3)`);
  check('nothing threw along the way', errors.length === 0, errors.join(' · '));
} finally {
  if (!KEEP) await close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(bad.length ? `\n${bad.length} of ${results.length} failed\n` : `\n${results.length} passed\n`);
// A baseline run must fail: it is serving a page from before edit mode existed, and a
// baseline that passes is a check comparing the working copy with itself.
if (BASELINE && !bad.length) {
  console.log('BASELINE PASSED — this check proves nothing. Run it before committing.');
  process.exit(1);
}
process.exit(BASELINE ? 0 : bad.length ? 1 : 0);
