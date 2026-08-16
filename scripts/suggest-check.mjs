#!/usr/bin/env node
//
// Do the suggested answers reach the thumb, and do they stop where they are meant to?
//
//   node scripts/suggest-check.mjs [--baseline] [--keep]
//
// test/suggest.mjs proves the parser: given a bead body, these are the options and
// this one is recommended. It cannot prove the half that matters on a phone, which
// is what a tap actually does — and that half has one rule with real consequences
// behind it.
//
// **A suggestion fills the box. It never sends.** The words came out of a paragraph
// rather than out of an agent's `response:` field, so they go somewhere Adam reads
// them and *Answer & close* is still what commits them. A refactor that routed a
// chip through the `option` handler — which is one line away, and reads as tidying
// up a duplicate — would post a machine-extracted sentence on a thread under his
// name and close the bead. So this counts /api/respond and fails on one.
//
// The rest is about not losing what he typed. A chip that replaced a sentence he
// had written would be the app eating an answer, which is the thing every other
// part of this card is built to prevent; a chip that always appended would turn
// changing your mind into two contradictory answers on one thread. Both are here.
//
// Like wrap-check.mjs, this drives the real public/app.js in a headless Chrome the
// size of a phone against fixtures served from this process. Nothing touches a real
// bead. `--baseline` serves the committed public/, where every suggestion case must
// fail and the controls must pass: a closed card has no chips, the box starts empty,
// nothing is sent before the button is pressed, pressing it sends, and a bead with a
// real decision block still draws its own buttons. **7/23 at baseline, 23/23 here** —
// which is what makes a pass mean something. Not in `npm test`: it needs Chrome.
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
const TOKEN = 'suggest-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
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

// Written the way bd hands it back — folded at 78 columns, continuation lines
// indented — because a fixture that is not wrapped tests a bead that cannot exist.
const DESIGN = [
  '- **Restore at promotion** — move restoreTerminals() out of startup and into',
  '  /internal/activate, so a promoted backend reads its list fresh. Costs a',
  '  directory read on the critical path of a swap.',
  '- **Restore at startup** — leave it where it is and rely on the reaper gating',
  '  alone. A list that is minutes stale after promotion is acceptable.',
  '',
  'RECOMMEND Restore at promotion — the swap read is cheap and a stale list is',
  'the failure nobody would notice until it mattered.',
].join('\n');

const PROSE_BEAD = {
  id: 'sc-1',
  title: 'When should a standby backend restore terminals?',
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: 'Merging main into the branch put the terminal and the swap in one\nprocess for the first time, and they interact.',
  design: DESIGN,
};

// The control: a bead that carries a real block. It must keep its full-width
// buttons, gain a ★ on the one the block recommends, and grow no chips at all.
const BLOCK_BEAD = {
  id: 'sc-2',
  title: 'Charge the platform fee on gross or on net?',
  issue_type: 'task',
  status: 'open',
  priority: 2,
  created_at: '2026-08-01T10:05:00Z',
  updated_at: '2026-08-01T10:05:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: [
    'Some ordinary context above the block.',
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
    '    response: "Net — after Stripe\'s cut."',
    '```',
  ].join('\n'),
};

const PROSE = toQuestion('demo', PROSE_BEAD);
const BLOCK = toQuestion('demo', BLOCK_BEAD);
const KEY = PROSE.key;
const BLOCK_KEY = BLOCK.key;

// Asserted against the DOM rather than derived from it, so a parser that quietly
// drops half an option cannot agree with the check that is supposed to catch it.
const FIRST = 'Restore at promotion';
const SECOND = 'Restore at startup';

const byId = (id) => [PROSE, BLOCK].find((q) => q.id === id) || null;

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

// Every write the app could make, counted. Zero of these is the point of the file.
const posted = [];

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
    if (p === '/api/questions')
      return json({ questions: [PROSE, BLOCK], workspaces: ['demo'], spaces: [], scope: 'human' });
    // expand() asks by workspace+id, and hands the answer straight to Object.assign
    // — so a fixture that answered with the wrong bead would merge one card's
    // options onto another's question and still look like it worked.
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

// What the card is offering, read off the DOM: the chips, which one is starred,
// which one claims to be in the box, and what the box actually says.
const READ = (key) => `(() => {
  const el = document.querySelector(${JSON.stringify(card(key))});
  if (!el) return null;
  const chips = [...el.querySelectorAll('.suggested .chip')].map((c) => ({
    text: c.innerText.replace(/\\s+/g, ' ').trim(),
    rec: c.classList.contains('rec'),
    star: !!c.querySelector('.star'),
    pressed: c.getAttribute('aria-pressed') === 'true',
    title: c.getAttribute('title') || '',
    height: Math.round(c.getBoundingClientRect().height),
  }));
  const box = el.querySelector('[data-role="answer"]');
  const opts = [...el.querySelectorAll('.option')].map((o) => ({
    label: o.dataset.label,
    rec: o.classList.contains('rec'),
    tag: !!o.querySelector('.rec-tag'),
  }));
  return {
    chips,
    opts,
    box: box ? box.value : null,
    focused: box ? document.activeElement === box : false,
    hasBlock: !!el.querySelector('.suggested'),
    label: el.querySelector('.suggested .section-label')?.innerText.replace(/\\s+/g, ' ').trim() || '',
  };
})()`;

const tapChip = (key, i) =>
  `document.querySelectorAll(${JSON.stringify(card(key))} + ' , ' + ${JSON.stringify(
    card(key)
  )}).length, document.querySelector(${JSON.stringify(card(key))}).querySelectorAll('.suggested .chip')[${i}].click()`;

/* -------------------------------------------------------------------- run */

const results = [];
const check = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const server = await serve();
const BASE = `http://127.0.0.1:${server.address().port}`;
const { s, close } = await launchChrome('beadcause-suggest-');

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

  /* --------------------------------------------------- what the card offers */

  const closed = await evalJs(s, READ(KEY));
  check(
    'a closed card offers no chips — they belong to the box, and the box is not open yet',
    closed.chips.length === 0,
    closed.chips.length ? `${closed.chips.length} on a closed card` : ''
  );

  await evalJs(s, `document.querySelector('${card(KEY)}[data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('${card(KEY)} [data-role="answer"]')`)))
    throw new Error('the answer box never rendered');
  await sleep(200);

  const open = await evalJs(s, READ(KEY));
  check(
    'opening it draws one chip per option, read out of the prose',
    open.chips.length === 2 &&
      open.chips[0].text.includes(FIRST) &&
      open.chips[1].text.includes(SECOND),
    JSON.stringify(open.chips.map((c) => c.text))
  );
  check(
    'the recommended one is starred, and only it',
    open.chips.filter((c) => c.rec && c.star).length === 1 && open.chips[0]?.rec === true,
    JSON.stringify(open.chips.map((c) => `${c.text}:${c.rec}`))
  );
  check(
    'the strip says where the words came from and what a tap does',
    /design/i.test(open.label) && /fill/i.test(open.label),
    JSON.stringify(open.label)
  );
  check(
    'a chip is big enough to hit with a thumb',
    open.chips.length === 2 && open.chips.every((c) => c.height >= 32),
    JSON.stringify(open.chips.map((c) => c.height))
  );
  check(
    'and carries the whole answer it would write, for a long-press',
    (open.chips[0]?.title || '').includes('directory read on the critical path'),
    JSON.stringify((open.chips[0]?.title || '').slice(0, 60))
  );
  check('the box starts empty', open.box === '', JSON.stringify(open.box));

  /* ------------------------------------------------------------- a tap fills */

  await evalJs(s, `document.querySelectorAll('${card(KEY)} .suggested .chip')[1]?.click()`);
  await sleep(120);
  const filled = await evalJs(s, READ(KEY));
  check(
    'tapping a chip writes its answer into the box',
    filled.box?.startsWith(SECOND) && filled.box.includes('reaper gating'),
    JSON.stringify(filled.box)
  );
  check(
    'and the wrap bd folded it at is gone — one paragraph, not five lines',
    !!filled.box && !filled.box.includes('\n'),
    JSON.stringify(filled.box)
  );
  check('the box takes focus, with the caret at the end', filled.focused, '');
  check(
    'and only the chip you tapped says it is in the box',
    filled.chips.filter((c) => c.pressed).length === 1 && filled.chips[1]?.pressed === true,
    JSON.stringify(filled.chips.map((c) => c.pressed))
  );
  check('nothing has been sent', posted.length === 0, JSON.stringify(posted));

  /* ------------------------------------------------ changing your mind swaps */

  await evalJs(s, `document.querySelectorAll('${card(KEY)} .suggested .chip')[0]?.click()`);
  await sleep(120);
  const swapped = await evalJs(s, READ(KEY));
  check(
    'a second chip replaces the first — a change of mind is not two answers',
    !!swapped.box?.startsWith(FIRST) && !swapped.box.includes(SECOND),
    JSON.stringify(swapped.box)
  );
  check(
    'and the star moves with it',
    swapped.chips[0]?.pressed === true && !swapped.chips[1]?.pressed,
    JSON.stringify(swapped.chips.map((c) => c.pressed))
  );

  /* ------------------------------------------- but your own words are kept */

  await evalJs(
    s,
    `(() => {
      const b = document.querySelector('${card(KEY)} [data-role="answer"]');
      b.value = 'Yes, but check the reaper gating first.';
      b.dispatchEvent(new Event('input', { bubbles: true }));
    })()`
  );
  await sleep(120);
  const typedOver = await evalJs(s, READ(KEY));
  check(
    'typing over a suggestion puts every chip out',
    typedOver.chips.length === 2 && typedOver.chips.every((c) => !c.pressed),
    JSON.stringify(typedOver.chips.map((c) => c.pressed))
  );

  await evalJs(s, `document.querySelectorAll('${card(KEY)} .suggested .chip')[0]?.click()`);
  await sleep(120);
  const appended = await evalJs(s, READ(KEY));
  check(
    'and a chip tapped after it appends rather than eating what you wrote',
    !!appended.box?.startsWith('Yes, but check the reaper gating first.') && appended.box.includes(FIRST),
    JSON.stringify(appended.box)
  );
  check(
    'which is your answer now, not the suggestion — so no chip claims it',
    appended.chips.length === 2 && appended.chips.every((c) => !c.pressed),
    JSON.stringify(appended.chips.map((c) => c.pressed))
  );
  check('still nothing sent', posted.length === 0, JSON.stringify(posted));

  /* -------------------------------------------------- it survives a collapse */

  // Closing is ↑ Collapse in the card's top bar; the details toggle is what opens
  // it again from the list, and an open card no longer carries one.
  await evalJs(s, `document.querySelector('${card(KEY)} [data-act="collapse"]').click()`);
  await sleep(200);
  await evalJs(s, `document.querySelector('${card(KEY)}[data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('${card(KEY)} [data-role="answer"]')`)))
    throw new Error('the box never came back');
  await sleep(200);
  const reopened = await evalJs(s, READ(KEY));
  check(
    'closing and reopening the card keeps what the chip wrote',
    !!reopened.box?.includes(FIRST),
    JSON.stringify(reopened.box)
  );

  /* -------------------------------------- the button is still what commits it */

  await evalJs(
    s,
    `(() => {
      const b = document.querySelector('${card(KEY)} [data-role="answer"]');
      b.value = ${JSON.stringify(FIRST)};
      b.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('${card(KEY)} [data-act="answer"]').click();
    })()`
  );
  await waitFor(s, `true`, 1);
  await sleep(600);
  check(
    'pressing Answer & close is what actually sends it',
    posted.length === 1 && posted[0].path === '/api/respond' && posted[0].body.includes(FIRST),
    JSON.stringify(posted)
  );

  /* -------------------------------------------------- the block is untouched */

  await evalJs(s, `document.querySelector('${card(BLOCK_KEY)}[data-act="toggle"]').click()`);
  if (!(await waitFor(s, `!!document.querySelector('${card(BLOCK_KEY)} [data-role="answer"]')`)))
    throw new Error('the second card never opened');
  await sleep(200);
  const block = await evalJs(s, READ(BLOCK_KEY));
  check(
    'a bead with a real block still draws its own buttons',
    block.opts.length === 2 && block.opts.map((o) => o.label).join() === 'Gross,Net',
    JSON.stringify(block.opts)
  );
  check(
    'recommended: true stars the button it was written on',
    block.opts[0]?.rec === true && block.opts[0]?.tag === true && !block.opts[1]?.rec,
    JSON.stringify(block.opts)
  );
  check(
    'and it gets no chips beside them — the agent already said what the answers are',
    !block.hasBlock,
    block.hasBlock ? 'a suggestion strip on a card that has options' : ''
  );
} finally {
  if (!KEEP) close();
  server.close();
}

const bad = results.filter((r) => !r.ok);
console.log(`\n${results.length - bad.length}/${results.length} passed\n`);
process.exit(bad.length ? 1 : 0);
