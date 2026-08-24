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

// The third bead is the one with an agent on it, which is what draws the "Session log"
// button — see the foot of the card in public/app.js. A bead of its own, so the two above
// it stay exactly the cards the anchor checks were written against.
const LOGGED = BEAD(3, 'Thagomizer audit on the quarterly rollup');

// Every title here is deliberately a phrase that appears nowhere in public/*.js, so the
// anchor on it can only come back as tracker text — if one ever comes back as source,
// something has started matching loosely and every retype after it would be filed against
// the wrong file.
const FIRST = [BEAD(1, 'Zarquon threshold for the ledger sweep'), BEAD(2, 'Vermilion backstop on the nightly import'), LOGGED];
// What the second and third polls answer with. Two of them, not one, because the first
// change is spent proving the marker technique can see a rebuild at all — so the frozen
// case needs a change of its own that has never been on screen.
const SECOND = [BEAD(1, 'Zarquon threshold for the ledger sweep — revised'), BEAD(2, 'Vermilion backstop on the nightly import'), LOGGED];
const THIRD = [BEAD(1, 'Zarquon threshold for the ledger sweep — reconsidered'), BEAD(2, 'Vermilion backstop on the nightly import'), LOGGED];

const asQuestions = (issues) =>
  issues.map((i) => ({ ...toQuestion('demo', i), comments: [], awaitingAgent: i.id === 'em-3' }));

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
// public/spacebar.js is in the list because bc-p49x.5 put a gate in it: a baseline that
// served the working copy's picker would be comparing half this change with itself.
const BASELINED = ['/index.html', '/app.js', '/editmode.js', '/spacebar.js', '/style.css'];

let polls = 0;
// The log tail's own clock, two seconds and nothing to do with the poll. Every read hands
// back one more line than the last, and the lines are long enough that a pane which took
// one changes length as well as content — the frozen check reads both.
let logReads = 0;
const logLines = () =>
  Array.from({ length: logReads }, (_, i) => `[agent] line ${i + 1} of the run, written while nobody was looking`);

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
        // A second repo appears on the poll the frozen screen takes, which is what makes
        // the picker above the list want to rebuild its options — and, at two repos
        // rather than one, to stop being hidden at all.
        workspaces: polls >= 3 ? ['demo', 'demo-two'] : ['demo'],
        spaces: [],
        scope: 'human',
      });
    }
    if (p === '/api/agent-log') {
      logReads += 1;
      return json({ running: true, lines: logLines() });
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

  /* 0b. bc-p49x.5 — the three writers of this screen that are not the poll, made live.
     Each of them needs a deliberate tap in the seconds *before* the mode is entered,
     which is exactly the sequence somebody reaching for the ✏️ is in the middle of. So
     they are armed here, on purpose, and the frozen window below is what they run into.
     A card is opened first because the dismiss button lives under the answer box. */
  await evalJs(s, `document.querySelector('.card[data-key][data-act="toggle"]').click()`);
  await sleep(600);
  await evalJs(s, `document.querySelector('[data-act="log"]')?.click()`);
  await sleep(900);
  const staged = await evalJs(
    s,
    `(() => {
      const dismiss = document.querySelector('.dismiss');
      dismiss?.click();
      return {
        dismiss: dismiss?.textContent?.trim() || null,
        log: document.querySelector('pre[data-log]')?.textContent || null,
      };
    })()`
  );
  check(
    'a dismiss is armed and a session log is tailing, in the seconds before the mode',
    /Tap again/.test(staged.dismiss || '') && Boolean(staged.log),
    JSON.stringify(staged)
  );

  /* 1. the mode is enterable and says so.

     Through the module rather than the ✏️: bc-p49x.12 parked the button, so there is no
     longer anything on the inbox to tap, and `beadcause.editMode.toggle()` is the whole
     way in for a check, for the console, and for anybody who wants the mode at all. What
     is being proved here is the same as it was — the mode turns on, the body wears the
     tint, and the banner says the screen has stopped — minus the one assertion that was
     about the button's own `aria-pressed` and nothing else. */
  const entered = await evalJs(
    s,
    `(() => {
      window.beadcause.editMode.toggle();
      return {
        button: !!document.getElementById('editmode'),
        active: window.beadcause.editMode.active(),
        editing: document.body.classList.contains('editing'),
        banner: document.querySelector('.editbar')?.textContent || null,
      };
    })()`
  );
  check('the module turns the mode on with no button to press', entered.active && entered.editing, JSON.stringify(entered));
  check('and there is indeed no ✏️ on the screen to have pressed', !entered.button, entered.button ? 'the button is back — bc-p49x.12 parked it' : '');
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
  const readsBefore = logReads;
  // What the three non-poll writers are drawing at the instant the screen was frozen. The
  // `<pre>` is kept by reference as well as by value: `pre.textContent = text` leaves the
  // element itself alone, so identity alone would not notice the write and the string
  // alone would not notice a rebuild.
  const held = await evalJs(
    s,
    `(() => {
      window.__logNode = document.querySelector('pre[data-log]');
      return {
        dismiss: document.querySelector('.dismiss')?.textContent?.trim() || null,
        log: window.__logNode?.textContent || null,
        picker: document.querySelector('#space-pick')?.innerHTML || null,
      };
    })()`
  );
  await evalJs(s, `window.beadcause.refresh()`);
  // Past the six seconds every armed control in this app gives you, and three ticks of the
  // log's own two-second clock.
  await sleep(7500);
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

  /* 2b. bc-p49x.5 — and neither did the three writers that are not the poll */
  const still = await evalJs(
    s,
    `(() => ({
      dismiss: document.querySelector('.dismiss')?.textContent?.trim() || null,
      log: document.querySelector('pre[data-log]')?.textContent || null,
      sameNode: window.__logNode === document.querySelector('pre[data-log]'),
      picker: document.querySelector('#space-pick')?.innerHTML || null,
    }))()`
  );
  check(
    'an arm timer expired under the frozen screen and repainted nothing',
    still.dismiss === held.dismiss && /Tap again/.test(still.dismiss || ''),
    `"${held.dismiss}" → "${still.dismiss}"`
  );
  // The half that would be easy to get wrong by stopping the timer instead of its paint:
  // the log kept being *read* the whole time, which is what makes the catch-up free.
  check(
    'the log tail kept reading while the screen was frozen',
    logReads > readsBefore,
    `${readsBefore} → ${logReads} reads`
  );
  check(
    'and wrote none of it into the open pane, which is the same element it was',
    still.log === held.log && still.sameNode,
    still.sameNode ? `${held.log?.length} → ${still.log?.length} chars` : 'the <pre> itself was replaced'
  );
  check(
    'the picker above the list did not rebuild on a poll carrying a second repo',
    still.picker === held.picker && !/demo-two/.test(still.picker || ''),
    `${held.picker?.length} → ${still.picker?.length} chars`
  );

  /* 3. any element tapped yields an anchor that names one line, or honestly none */
  const chrome = await evalJs(s, ANCHOR('#refresh'));
  check(
    'a chrome control resolves to exactly one line of this app`s source',
    chrome.source?.found === 1,
    `${chrome.source?.found} sites via ${chrome.source?.query} — ${JSON.stringify(chrome.source?.sites?.[0] || null)}`
  );
  // The mode's own banner: written once, in public/editmode.js, and drawn on the screen
  // it is describing. Chrome text is only retypable when it is written in exactly one
  // place, and most of this app's labels are not — '↑ Collapse' is written three times.
  const say = await evalJs(s, ANCHOR('.editbar-say'));
  check(
    'chrome text written in exactly one place is source text, and may be retyped',
    say.text?.from === 'source' && say.editable?.ok === true,
    `${say.text?.from}; ${say.editable?.why || 'editable'}`
  );

  // A control inside a card, which is where the grep-key premise has to hold if the
  // apply half is ever to work: a data-act names the one handler branch that answers it.
  const toggle = await evalJs(s, ANCHOR('.card[data-key][data-act="toggle"]'));
  check(
    'a control inside a card resolves to one line too',
    toggle.source?.found === 1,
    `${toggle.source?.found} sites via ${toggle.source?.query}`
  );

  const title = await evalJs(s, ANCHOR('.card[data-key] .q'));
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
  // `class="q"` is written three times in public/app.js — the card's head (a <button>
  // since bc-rfnr.9.8), its foot (still a <p>) and the agent card's head — so this is the
  // third outcome the anchor has to be honest about: not one site, not none, but every
  // candidate named and nothing offered as an edit. The chain is what narrows it: the
  // `.card-head` around it rules the foot's out. It only works because the button's own
  // markup stays inline in each renderer rather than behind a shared helper — see the
  // note on `shutCardAct` in public/app.js.
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
  await evalJs(s, `window.beadcause.editMode.toggle()`);
  await sleep(900);
  const thawed = await evalJs(
    s,
    `({
      editing: document.body.classList.contains('editing'),
      banner: !!document.querySelector('.editbar'),
      caught: document.querySelector('#list').textContent.includes('reconsidered'),
      seen: document.querySelector('.card[data-key] .q')?.textContent || null,
    })`
  );
  check('leaving the mode takes the banner and the tint with it', !thawed.editing && !thawed.banner, JSON.stringify(thawed));
  check(
    'and one repaint catches the screen up on everything the poll carried',
    thawed.caught,
    thawed.caught ? '' : 'the list is still showing the payload from before the mode'
  );

  /* 4b. bc-p49x.5 — and on the three writers that are not the poll, from state alone.
     No refetch is asked for here and none is waited on: what these draw is what `adopt`,
     `state.logText` and `space.adopt` were quietly taking the whole time the screen was
     held. The picker's catch-up used not to be a line of app.js either — the last
     statement of render() was publishCounts(), which landed in public/spacebar.js as an
     adopt(). bc-ka5y.1 deleted the picker's counts and that call with them, so that file
     now registers a one-shot editMode.onChange from inside its own freeze; either way it
     is off this page's exit and there is nothing here to drive it. */
  const caught = await evalJs(
    s,
    `(() => ({
      dismiss: document.querySelector('.dismiss')?.textContent?.trim() || null,
      log: document.querySelector('pre[data-log]')?.textContent || null,
      picker: document.querySelector('#space-pick')?.innerHTML || null,
      barShown: document.querySelector('.spacebar')?.hidden === false,
    }))()`
  );
  check(
    'the arm that expired behind the freeze comes back disarmed, which is the truth',
    Boolean(caught.dismiss) && !/Tap again/.test(caught.dismiss),
    `"${caught.dismiss}"`
  );
  check(
    'the log pane is at whatever the agent has since reached, with no refetch asked for',
    Boolean(caught.log) && caught.log.length > (held.log?.length || 0),
    `${held.log?.length} → ${caught.log?.length} chars`
  );
  check(
    'and the picker draws the repo that arrived during the freeze',
    /demo-two/.test(caught.picker || '') && caught.barShown,
    caught.barShown ? '' : 'the bar is still hidden at one repo'
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
