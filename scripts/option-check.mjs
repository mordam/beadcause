#!/usr/bin/env node
//
// A choice answers from the list; on an open card it fills the box. Both, in a real browser.
//
//   node scripts/option-check.mjs [--baseline] [--keep]
//
// The buttons a `decision` block draws do two different things, and which one depends
// on the state of the card they are on (bc-5ldc). **Shut**, a choice is the answer:
// the first tap arms it for six seconds and the button says what the second one will
// do, and the second sends. **Open**, it writes that option's own sentence into the
// answer box and stops there, with *Answer & close* under it committing — because the
// other common thing anyone wants to do with a multiple-choice question is pick one
// **and say something about it**. **💬 Discuss**, a third button under the choices, is
// the way from the first shape to the second.
//
// Seven things have to be true at once, and none of them can be proved by reading the
// handler:
//
// 1. **A tap on a shut card writes nothing; the tap after it writes once.** This counts
//    every write the page makes. One tap answering would close a bead from a pocket,
//    which is what the arm exists to prevent; a second tap that does not send would
//    leave the whole shape decorative.
// 2. **The arm is per-option, expires, and says what it would do.** Arming a second
//    choice takes the first one's offer back, six seconds of nothing puts it down, and
//    the label names the bead — a hot button reading "Net" in a list of eight is an
//    offer to answer *something*.
// 3. **A tap on an open card sends nothing at all.** The box-filling half is unchanged
//    and is checked here exactly as it always was.
// 4. **Nothing you typed is ever eaten.** Another choice's words are replaced; words of
//    your own are appended to; the way back to an empty box only empties it while the
//    box still says exactly what the tap put there — and a **shut** card carrying a
//    draft opens rather than answering over words you cannot see.
// 5. **The pick outlives its words.** Edit the sentence and the button stays lit, and
//    the id still rides on the answer — that id is the only thing that can say whether
//    this answer commissions work (`closes: false`) rather than settling it. A chip does
//    the opposite and lets go on the first keystroke; the difference is deliberate and
//    is checked from both ends here.
// 6. **The button says what it will do.** Over a commission it reads *Answer &
//    commission*, because the close is the one outcome that is not going to happen —
//    and armed on a shut card it says *commissions* rather than *answers*.
// 7. **💬 Discuss opens the card and sends nothing.** It is not a choice: no option id,
//    so no write can be made out of it.
//
// Plus the two suppressions the card has always had: a proposal and a delivery draw
// their own controls and must grow no option buttons beside them — and so no Discuss
// button either, since there is nothing for it to be an alternative to.
//
// Like suggest-check.mjs, this drives the real public/app.js in a headless Chrome the
// size of a phone against fixtures served from this process. Nothing touches a real
// bead. `--baseline` serves the committed public/, where a tap on a shut card opens it
// rather than arming — so the run stops in the second section and says so, which is
// what makes a pass here mean something. Not in `npm test`: it needs Chrome.
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
const TOKEN = 'option-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
// `--shots` writes a PNG at each of the three states this file is about, the way
// dismiss-check.mjs and absorb-check.mjs do: an armed button and a dashed way-in are
// claims about how something *looks*, and no assertion here can see a colour.
const SHOTS = process.argv.includes('--shots');
const SHOT_DIR = path.join(ROOT, '.claude', 'shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (!fs.existsSync(CHROME)) {
  console.error(`Google Chrome not found at ${CHROME}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(PUBLIC, 'vendor', 'marked.js'))) {
  console.error('public/vendor/marked.js is missing — run `npm run vendor` first.');
  process.exit(1);
}

/* ---------------------------------------------------------------- fixtures */

const bead = (id, title, description, extra = {}) => ({
  id,
  title,
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description,
  ...extra,
});

// Three options, and the third is the one that matters: `closes: false` means the
// answer commissions work and the bead stays open, which no sentence can say.
const CHOICES = [
  'Which way should the fee be charged?',
  '',
  '```decision',
  'question: Charge the platform fee on gross or on net?',
  'options:',
  '  - id: gross',
  '    label: Gross',
  '    response: "Gross — fee on the full charge amount."',
  '    recommended: true',
  '  - id: net',
  '    label: Net',
  "    response: \"Net — after Stripe's cut.\"",
  '  - id: measure',
  '    label: Build both and measure',
  '    response: "Build both and measure — decide on the numbers, not on this thread."',
  '    closes: false',
  '```',
].join('\n');

const OPTS = toQuestion('demo', bead('oc-1', 'Charge the platform fee on gross or on net?', CHOICES));

// A proposal that also carries a block, which is the only way to prove the
// suppression rather than assume it: the per-bead controls win and the block's
// buttons are not drawn underneath them.
const PROP = toQuestion(
  'demo',
  bead(
    'oc-2',
    'Three beads came out of the review',
    `${CHOICES}\n\n\`\`\`beadproposal\nbeads:\n  - title: One\n    type: task\n    priority: 2\n\`\`\``
  )
);

// And a delivery, for the same reason — plus the regression that made this fixture
// worth the trouble: its primary button says "Request changes & close", and the
// repaint that keeps an option's label honest must not rename it.
const DELIVERY = toQuestion(
  'demo',
  bead(
    'oc-3',
    'Ready to merge: the fee split',
    `${CHOICES}\n\n\`\`\`beadpr\nnumber: 41\nurl: https://github.com/x/y/pull/41\nbranch: fee-split\nbase: main\nmethod: squash\nbead: oc-9\n\`\`\``
  )
);

// A second question with the same block, and it exists for one reason: answering from
// the shut card takes the card out of the list, and every later section needs a card
// with choices still on it. So the sending half runs here and the box-filling half
// runs on OPTS, rather than the two of them fighting over one row.
const SEND = toQuestion('demo', bead('oc-4', 'And which way for the refund fee?', CHOICES));

const KEY = OPTS.key;
const SEND_KEY = SEND.key;
const PROP_KEY = PROP.key;
const PR_KEY = DELIVERY.key;

// Written out here rather than read off the fixture, so a parser that quietly drops
// half an option cannot agree with the check meant to catch it.
const GROSS = 'Gross — fee on the full charge amount.';
const NET = "Net — after Stripe's cut.";
const MEASURE = 'Build both and measure — decide on the numbers, not on this thread.';

const ALL = [OPTS, SEND, PROP, DELIVERY];
const byId = (id) => ALL.find((q) => q.id === id) || null;

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

// Every write the page could make, counted. Which taps produce one and which produce
// none is the whole point of the file.
const posted = [];

// How many writes the shut-card section leaves behind — the one answer sent from the
// list. Everything after it counts against this rather than against zero, so "nothing
// was sent" keeps meaning nothing was sent *by this tap*.
const FROM_LIST = 1;

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const json = (body) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (p === '/api/respond' || p === '/api/comment' || p === '/api/dismiss') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        posted.push({ path: p, body });
        json({ ok: true });
      });
      return;
    }
    if (p === '/api/questions') return json({ questions: ALL, workspaces: ['demo'], spaces: [], scope: 'human' });
    if (p === '/api/question') return json(byId(url.searchParams.get('id')));
    if (p.startsWith('/api/')) return json({});

    if (BASELINE && (p === '/app.js' || p === '/style.css')) {
      res.writeHead(200, { 'content-type': TYPES[path.extname(p)] });
      return res.end(committed(`public${p}`));
    }
    const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '');
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
  const r = await s.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails)
    throw new Error(`${r.exceptionDetails.exception?.description || 'eval failed'}\n  in: ${expr.slice(0, 160)}`);
  return r.result.value;
};

const waitFor = async (s, expr, tries = 60) => {
  for (let i = 0; i < tries; i++) {
    if (await evalJs(s, expr)) return true;
    await sleep(200);
  }
  return false;
};

/* ------------------------------------------------------------------- probe */

const card = (key) => `.card[data-key=${JSON.stringify(key)}]`;

// What the card is offering, read off the DOM: the buttons, which one claims to be
// in the box, what the box says, and what the button under it promises to do.
const READ = (key) => `(() => {
  const el = document.querySelector(${JSON.stringify(card(key))});
  if (!el) return null;
  const opts = [...el.querySelectorAll('.option[data-opt]')].map((o) => ({
    label: o.dataset.label,
    said: o.querySelector('.label')?.textContent.trim() || '',
    rec: o.classList.contains('rec'),
    picked: o.classList.contains('picked'),
    armed: o.classList.contains('confirm'),
    pressed: o.getAttribute('aria-pressed') === 'true',
    commission: !!o.querySelector('.hand-tag'),
    height: Math.round(o.getBoundingClientRect().height),
  }));
  // The third button, read separately — it is not a choice and must never be counted
  // as one. \`last\` is the whole options block's last child, which is where it belongs.
  const d = el.querySelector('.option.discuss');
  const box = el.querySelector('[data-role="answer"]');
  return {
    opts,
    discuss: d
      ? {
          said: d.querySelector('.label')?.textContent.trim() || '',
          opt: d.dataset.opt ?? null,
          last: d === el.querySelector('.options')?.lastElementChild,
          height: Math.round(d.getBoundingClientRect().height),
        }
      : null,
    open: el.classList.contains('open'),
    box: box ? box.value : null,
    focused: box ? document.activeElement === box : false,
    primary: el.querySelector('.freeform .primary')?.textContent.trim() || '',
  };
})()`;

/** Tap the nth choice. Indexed over the choices only, so the third button cannot shift them. */
const tap = (key, i) =>
  `document.querySelector(${JSON.stringify(card(key))}).querySelectorAll('.option[data-opt]')[${i}].click()`;

const tapDiscuss = (key) => `document.querySelector(${JSON.stringify(card(key))} + ' .option.discuss').click()`;

const type = (key, text) => `(() => {
  const b = document.querySelector(${JSON.stringify(card(key))} + ' [data-role="answer"]');
  b.value = ${JSON.stringify(text)};
  b.dispatchEvent(new Event('input', { bubbles: true }));
})()`;

let shotN = 0;
async function shot(s, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(SHOT_DIR, `option-${String(++shotN).padStart(2, '0')}-${name}.png`);
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
const { s, close } = await launchChrome('beadcause-option-');

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
  if (!(await waitFor(s, `!!document.querySelector('.card[data-key]')`))) throw new Error('the list never rendered');

  /* ------------------------------------------------- one button per choice */

  await shot(s, "shut");
  const closed = await evalJs(s, READ(KEY));
  check(
    'a closed card shows one button per choice',
    closed.opts.length === 3 && closed.opts.map((o) => o.label).join() === 'Gross,Net,Build both and measure',
    JSON.stringify(closed.opts.map((o) => o.label))
  );
  check(
    'the recommended one is marked, and only it',
    closed.opts.filter((o) => o.rec).length === 1 && closed.opts[0]?.rec === true,
    JSON.stringify(closed.opts.map((o) => o.rec))
  );
  check(
    'the one that commissions work says so before you tap it',
    closed.opts[2]?.commission === true && !closed.opts[0]?.commission,
    JSON.stringify(closed.opts.map((o) => o.commission))
  );
  check('none of them starts pressed', closed.opts.every((o) => !o.pressed && !o.picked), '');
  check('and a choice is big enough to hit with a thumb', closed.opts.every((o) => o.height >= 44), JSON.stringify(closed.opts.map((o) => o.height)));
  check(
    'and none of them starts armed, because nothing has been tapped',
    closed.opts.every((o) => !o.armed),
    JSON.stringify(closed.opts.map((o) => o.armed))
  );

  /* ------------------------------------------------------- the third button */

  check(
    'a closed card also offers 💬 Discuss, last, under the choices',
    closed.discuss?.said.includes('Discuss') && closed.discuss.last === true,
    JSON.stringify(closed.discuss)
  );
  check(
    'and it is not a choice — no option id, so no write can be made out of it',
    closed.discuss?.opt === null,
    JSON.stringify(closed.discuss?.opt)
  );
  check(
    'it is a thumb-sized target like the rest of them',
    (closed.discuss?.height || 0) >= 44,
    JSON.stringify(closed.discuss?.height)
  );

  /* ------------------------------------------ the shut card: one tap arms, and only arms */

  await evalJs(s, tap(SEND_KEY, 1));
  await sleep(200);
  await shot(s, "armed");
  const armed = await evalJs(s, READ(SEND_KEY));
  check('a tap on a shut card sends nothing at all', posted.length === 0, JSON.stringify(posted));
  check('and does not open it either — the answer is being made where it stands', armed.open === false, '');
  check(
    'the button it hit is lit, and it is the only one',
    armed.opts.filter((o) => o.armed).length === 1 && armed.opts[1]?.armed === true,
    JSON.stringify(armed.opts.map((o) => o.armed))
  );
  check(
    'and it says what the next tap does, naming the bead it would answer',
    /tap again/i.test(armed.opts[1]?.said || '') && (armed.opts[1]?.said || '').includes('oc-4'),
    JSON.stringify(armed.opts[1]?.said)
  );

  await evalJs(s, tap(SEND_KEY, 2));
  await sleep(200);
  const moved = await evalJs(s, READ(SEND_KEY));
  check(
    'arming a second choice takes the first one’s offer back — one hot button at a time',
    moved.opts.filter((o) => o.armed).length === 1 && moved.opts[2]?.armed === true,
    JSON.stringify(moved.opts.map((o) => o.armed))
  );
  check(
    'and a commission says so rather than promising an answer',
    /commissions/i.test(moved.opts[2]?.said || ''),
    JSON.stringify(moved.opts[2]?.said)
  );
  check('still nothing sent', posted.length === 0, JSON.stringify(posted));

  await sleep(6400);
  const cooled = await evalJs(s, READ(SEND_KEY));
  check(
    'six seconds later it has put itself down — a card in a pocket cannot be finished by a knee',
    cooled.opts.every((o) => !o.armed) && cooled.opts[2]?.said === 'Build both and measure',
    JSON.stringify(cooled.opts.map((o) => o.said))
  );

  /* ------------------------------------------ the shut card: the second tap sends */

  await evalJs(s, tap(SEND_KEY, 1));
  await sleep(200);
  await evalJs(s, tap(SEND_KEY, 1));
  await sleep(800);
  const fromList = posted[0] ? JSON.parse(posted[0].body) : null;
  check(
    'two taps on a shut card send exactly one answer',
    posted.length === 1 && posted[0].path === '/api/respond',
    JSON.stringify(posted)
  );
  check(
    'it carries that choice’s own sentence, unedited',
    fromList?.response === NET,
    JSON.stringify(fromList?.response)
  );
  check(
    'and its id, which is the only thing that can say whether the bead is finished or handed back',
    fromList?.option === 'net',
    JSON.stringify(fromList?.option)
  );
  check(
    'and the card is gone from the list without ever having been opened',
    !(await evalJs(s, `!!document.querySelector(${JSON.stringify(card(SEND_KEY))})`)),
    ''
  );

  /* ------------------------------------------------------ 💬 Discuss opens the card */

  await evalJs(s, tapDiscuss(KEY));
  if (!(await waitFor(s, `!!document.querySelector('${card(KEY)} [data-role="answer"]')`)))
    throw new Error('💬 Discuss never opened the card');
  await sleep(250);
  await shot(s, "discussed");
  const opened = await evalJs(s, READ(KEY));
  check('💬 Discuss opens the card, which is where the box is', opened.open === true, '');
  check('with an empty box — it is a way in, not a choice', opened.box === '', JSON.stringify(opened.box));
  check('and nothing lit, because nothing has been picked', opened.opts.every((o) => !o.pressed && !o.armed), '');
  check('and it is gone from the open card — you are already in the discussion', opened.discuss === null, '');
  check('nothing sent by opening it', posted.length === 1, JSON.stringify(posted));

  /* ------------------------------------------------------ a tap fills the box */

  await evalJs(s, tap(KEY, 1));
  await sleep(250);

  const filled = await evalJs(s, READ(KEY));
  check('a choice tapped on the open card leaves it open', filled.open === true, '');
  check('and writes that choice into the box', filled.box === NET, JSON.stringify(filled.box));
  check('the box takes focus, with the caret at the end', filled.focused, '');
  check(
    'only the choice you tapped says it is in the box',
    filled.opts.filter((o) => o.pressed).length === 1 && filled.opts[1]?.pressed === true,
    JSON.stringify(filled.opts.map((o) => o.pressed))
  );
  check('nothing has been sent by any tap on the open card', posted.length === FROM_LIST, JSON.stringify(posted));
  check(
    'and the button under it still offers the ordinary ending',
    filled.primary === 'Answer & close',
    JSON.stringify(filled.primary)
  );

  /* ------------------------------------------- a second tap replaces the first */

  await evalJs(s, tap(KEY, 0));
  await sleep(150);
  const swapped = await evalJs(s, READ(KEY));
  check(
    'a second choice replaces the first — changing your mind is not two answers',
    swapped.box === GROSS,
    JSON.stringify(swapped.box)
  );
  check(
    'and the lit button moves with it',
    swapped.opts[0]?.pressed === true && !swapped.opts[1]?.pressed,
    JSON.stringify(swapped.opts.map((o) => o.pressed))
  );
  check('still nothing sent', posted.length === FROM_LIST, JSON.stringify(posted));

  /* ------------------------------------------------- the way back to empty */

  await evalJs(s, tap(KEY, 0));
  await sleep(150);
  const cleared = await evalJs(s, READ(KEY));
  check('tapping the choice you made takes it back', cleared.box === '', JSON.stringify(cleared.box));
  check(
    'and nothing is left claiming to be the answer',
    cleared.opts.every((o) => !o.pressed),
    JSON.stringify(cleared.opts.map((o) => o.pressed))
  );

  /* --------------------------------------------- your own words are kept */

  await evalJs(s, type(KEY, 'Only if the split survives a refund.'));
  await sleep(150);
  await evalJs(s, tap(KEY, 0));
  await sleep(150);
  const appended = await evalJs(s, READ(KEY));
  check(
    'a choice tapped after you have typed appends rather than eating what you wrote',
    appended.box === `Only if the split survives a refund.\n${GROSS}`,
    JSON.stringify(appended.box)
  );

  await evalJs(s, tap(KEY, 0));
  await sleep(150);
  const notCleared = await evalJs(s, READ(KEY));
  check(
    'and the way back to empty will not delete a sentence of yours to get there',
    notCleared.box?.startsWith('Only if the split survives a refund.'),
    JSON.stringify(notCleared.box)
  );

  /* ----------------------------------- the pick survives being written over */

  await evalJs(s, type(KEY, ''));
  await sleep(150);
  await evalJs(s, tap(KEY, 2));
  await sleep(150);
  const commission = await evalJs(s, READ(KEY));
  check('a commissioning choice fills the box like any other', commission.box === MEASURE, JSON.stringify(commission.box));
  check(
    'and the button stops promising a close, because there is not going to be one',
    commission.primary === 'Answer & commission',
    JSON.stringify(commission.primary)
  );

  await evalJs(s, type(KEY, `${MEASURE} Two weeks, then we decide.`));
  await sleep(150);
  const qualified = await evalJs(s, READ(KEY));
  check(
    'qualifying the words in a sentence does not put the choice out — a chip lets go here, a choice does not',
    qualified.opts[2]?.pressed === true,
    JSON.stringify(qualified.opts.map((o) => o.pressed))
  );
  check(
    'so the button still says what the choice will do, not what the words look like',
    qualified.primary === 'Answer & commission',
    JSON.stringify(qualified.primary)
  );

  await evalJs(s, type(KEY, ''));
  await sleep(150);
  const emptied = await evalJs(s, READ(KEY));
  check(
    'emptying the box is the one edit that ends the choice',
    emptied.opts.every((o) => !o.pressed) && emptied.primary === 'Answer & close',
    JSON.stringify({ pressed: emptied.opts.map((o) => o.pressed), primary: emptied.primary })
  );

  /* ------------------------ a shut card holding a draft opens rather than answering */

  await evalJs(s, type(KEY, 'Only if the split survives a refund.'));
  await sleep(150);
  await evalJs(s, `document.querySelector('${card(KEY)} [data-act="collapse"]').click()`);
  await sleep(300);
  const shutWithDraft = await evalJs(s, READ(KEY));
  check('the card can be collapsed with words still in it', shutWithDraft.open === false, '');
  check('and its choices are back, with the way in under them', !!shutWithDraft.discuss, '');

  await evalJs(s, tap(KEY, 0));
  await sleep(300);
  const reopened = await evalJs(s, READ(KEY));
  check(
    'a choice tapped on a card carrying a draft opens it instead of arming',
    reopened.open === true && reopened.opts.every((o) => !o.armed),
    JSON.stringify({ open: reopened.open, armed: reopened.opts.map((o) => o.armed) })
  );
  check(
    'and appends to what you wrote rather than answering over words you cannot see',
    reopened.box === `Only if the split survives a refund.\n${GROSS}`,
    JSON.stringify(reopened.box)
  );
  check('with nothing sent', posted.length === FROM_LIST, JSON.stringify(posted));

  /* ------------------------------------ the button is what sends it, with the id */

  await evalJs(s, type(KEY, ''));
  await sleep(150);
  await evalJs(s, tap(KEY, 2));
  await sleep(150);
  await evalJs(s, type(KEY, `${MEASURE} Two weeks, then we decide.`));
  await sleep(150);
  check('and nothing has been sent by any of that', posted.length === FROM_LIST, JSON.stringify(posted));

  await evalJs(s, `document.querySelector('${card(KEY)} [data-act="answer"]').click()`);
  await sleep(700);
  const sent = posted[FROM_LIST] ? JSON.parse(posted[FROM_LIST].body) : null;
  check(
    'pressing the button is what sends it, from the open card',
    posted.length === FROM_LIST + 1 && posted[FROM_LIST].path === '/api/respond',
    JSON.stringify(posted)
  );
  check(
    'it sends the words you ended up with, not the ones the tap wrote',
    sent?.response === `${MEASURE} Two weeks, then we decide.`,
    JSON.stringify(sent?.response)
  );
  check(
    'and the id of the choice, which is the only thing that can say this commissions work',
    sent?.option === 'measure',
    JSON.stringify(sent?.option)
  );

  /* --------------------------------------------- the two cards with their own controls */

  await evalJs(s, `document.querySelector('${card(PROP_KEY)}[data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('${card(PROP_KEY)} [data-role="answer"]')`)))
    throw new Error('the proposal card never opened');
  await sleep(250);
  const prop = await evalJs(s, READ(PROP_KEY));
  check(
    'a proposal draws its own per-bead controls and no choice buttons beside them',
    prop.opts.length === 0 && prop.discuss === null,
    JSON.stringify({ opts: prop.opts.map((o) => o.label), discuss: prop.discuss })
  );

  await evalJs(s, `document.querySelector('${card(PR_KEY)}[data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('${card(PR_KEY)} [data-role="answer"]')`)))
    throw new Error('the delivery card never opened');
  await sleep(250);
  const pr = await evalJs(s, READ(PR_KEY));
  check(
    'and a delivery draws its own three, for the same reason',
    pr.opts.length === 0 && pr.discuss === null,
    JSON.stringify({ opts: pr.opts.map((o) => o.label), discuss: pr.discuss })
  );
  check(
    'its box still asks for changes rather than for an answer',
    pr.primary === 'Request changes & close',
    JSON.stringify(pr.primary)
  );

  await evalJs(s, type(PR_KEY, 'The migration needs a down path.'));
  await sleep(150);
  const prTyped = await evalJs(s, READ(PR_KEY));
  check(
    'and typing in it does not let the choice repaint rename that button',
    prTyped.primary === 'Request changes & close',
    JSON.stringify(prTyped.primary)
  );
} catch (err) {
  // A behavioural check that cannot even get to its assertion is still a result, and
  // at `--baseline` it is the *expected* result: the committed build arms the first
  // tap instead of opening the card, so the run stops there rather than cascading
  // thirty consequential failures behind one real difference.
  check('the run got as far as its last assertion', false, err.message);
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
