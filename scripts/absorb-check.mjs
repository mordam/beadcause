#!/usr/bin/env node
//
// Does answering a question look like anything, and can it be taken back?
//
//   node scripts/absorb-check.mjs [--baseline] [--keep]
//
// Answering used to end in a dead pause: the card dimmed to 50%, a "Recording your
// answer…" row appeared, and then nothing at all happened for as long as bd spent
// retrying against the Dolt lock — after which the list jump-cut to one without the
// card in it. What replaces it is a flight: the card collapses to a bead, the bead
// arcs to the app mark in the header, a thread grows out of the mark to catch it,
// and it is drawn in and swallowed.
//
// Almost everything that can go wrong with that is a matter of *timing*, and none of
// it is visible in the source:
//
//   • it has to start on the tap, or it has only moved the pause somewhere else
//   • the card has to leave the list before the bead exists, or the bead is drawn
//     over the thing it is supposed to have become
//   • the beads live on an overlay, because render() destroys the card they came
//     out of while they are still in the air
//   • nothing may be absorbed until the write has actually been accepted, and a
//     refused write has to fly them home and give the card back with its text
//
// So this drives the real public/app.js and public/absorb.js in a headless Chrome
// the size of a phone, against fixtures served from this process, with the fixture's
// /api/respond deliberately slow — which is what makes the middle of the flight
// something a test can stand in and measure. Nothing here touches a real bead.
//
// `--baseline` serves the committed public/, which is how you tell a real failure
// from a flaky one: baseline must fail every flight case and pass the two controls.
// `--shots` drops a PNG per stage of the flight into .claude/shots/, because the one
// thing an assertion about a bead's coordinates cannot tell you is whether it looks
// like anything.
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
const TOKEN = 'absorb-check-token';
const BASELINE = process.argv.includes('--baseline');
const KEEP = process.argv.includes('--keep');
const SHOTS = process.argv.includes('--shots');
// The bead colours are read off :root at launch and are a step darker in the light
// scheme, because the dark scheme's values wash out on a near-white page. `--light`
// is how you look at that rather than take it on trust.
const LIGHT = process.argv.includes('--light');
// Beside every other screenshot this repo takes, and outside anything the app
// serves — see scripts/shot.mjs for why.
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

// Three, because the count is the assertion: approving all of them must put four
// beads in the air — one per bead created, plus the one you answered.
const PROPOSED = [
  {
    title: 'Stamp the asset hash into the script tag',
    type: 'task',
    priority: 2,
    description: 'A shipped change looks absent to any browser that has the page cached.',
    acceptance: '- the URL of the script changes when the file does',
    design: 'Hash at build time.',
    notes: '',
    rationale: '',
    labels: ['deploy'],
    deps: [],
  },
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
  {
    title: 'Give the health endpoint a version',
    type: 'task',
    priority: 3,
    description: 'There is no way to tell which build is answering.',
    acceptance: '',
    design: '',
    notes: '',
    rationale: '',
    labels: [],
    deps: [],
  },
];

const PROPOSAL_ISSUE = {
  id: 'ab-proposal',
  title: proposalTitle(WS, PROPOSED),
  issue_type: 'task',
  status: 'open',
  priority: 1,
  created_at: '2026-08-01T10:00:00Z',
  updated_at: '2026-08-01T10:00:00Z',
  comment_count: 0,
  dependent_count: 0,
  description: proposalBody(WS, PROPOSED),
};

// A plain question, for the paths that are about text rather than about beads: the
// refused write that has to give the answer back, and the comment that must not be
// shown being swallowed.
const PLAIN_ISSUE = {
  id: 'ab-plain',
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

const QUESTIONS = [PROPOSAL_ISSUE, PLAIN_ISSUE].map((i) => ({ ...toQuestion(WS, i), comments: [] }));
const PROP_KEY = QUESTIONS[0].key;
const PLAIN_KEY = QUESTIONS[1].key;
if (!QUESTIONS[0].proposal?.beads?.length) {
  console.error('the fixture did not parse back into a proposal — lib/proposal.js changed shape');
  process.exit(1);
}

// Half-typed answer for the refusal case. It has to come back verbatim.
const TYPED = 'Net, because the ledger already nets the fees before it writes a row.';

/* ------------------------------------------------------------------ server */

// How the write behaves. Mutated from the run below, which is the whole trick: a
// slow /api/respond is what turns a 1.5-second animation into something a test can
// stop in the middle of and measure.
const write = { delay: 3500, fail: false, seen: 0 };

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

// The committed copies, for --baseline. Read through git rather than from a second
// checkout so the comparison is against HEAD of this very worktree. absorb.js is new,
// so at baseline it is simply absent — which is exactly the state being compared to.
const BASE_FILES = ['/app.js', '/style.css', '/index.html', '/absorb.js'];
const committed = (p) => {
  try {
    // stderr swallowed: /absorb.js genuinely does not exist at HEAD, and git saying
    // so once per request would bury the run's own output.
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
    if (p === '/api/respond' || p === '/api/comment') {
      write.seen++;
      const t = setTimeout(
        () => (write.fail ? json({ error: 'bd: database is locked' }, 500) : json({ ok: true })),
        write.delay
      );
      return t.unref?.();
    }
    if (p.startsWith('/api/')) return json({});

    const file = path.join(PUBLIC, p === '/' ? 'index.html' : p.replace(/^\/+/, ''));
    if (BASELINE && BASE_FILES.includes(p === '/' ? '/index.html' : p)) {
      const body = committed(p === '/' ? '/index.html' : p);
      if (!body) return res.writeHead(404).end('no');
      res.writeHead(200, { 'content-type': TYPES[path.extname(p === '/' ? '.html' : p)] || TYPES['.html'] });
      return res.end(body);
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
  const port = 9700 + Math.floor(process.pid % 100);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-absorb-'));
  const proc = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Without these the renderer runs at about a frame a second while offscreen,
      // and every measurement below measures the throttling instead of the flight.
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

// Every flying bead, measured the way a finger would see it. `offsetWidth` rather
// than the client rect for the size, because the rect is mid-transform for most of
// the flight and would report the pulse rather than the bead.
const BEADS = `[...document.querySelectorAll('.flight-layer .fbead')].map((b) => {
  const r = b.getBoundingClientRect();
  const cs = getComputedStyle(b);
  return {
    x: Math.round(r.left + r.width / 2),
    y: Math.round(r.top + r.height / 2),
    w: b.offsetWidth,
    radius: cs.borderRadius,
    bg: cs.backgroundColor,
    lead: b.classList.contains('lead'),
  };
})`;

const MARK = `(() => {
  const el = document.querySelector('.brand h1.mark img') || document.querySelector('.brand');
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
})()`;

const CARD = (key) => `!!document.querySelector('#list .card[data-key=${JSON.stringify(key)}]')`;
const OPEN = (key) => `!!document.querySelector('#list .card.open[data-key=${JSON.stringify(key)}]')`;
const THREADS = `document.querySelectorAll('.flight-layer .fthread').length`;
const LAYER = `(document.querySelector('.flight-layer') || { children: [] }).children.length`;
const tap = (s, sel) => evalJs(s, `(document.querySelector(${JSON.stringify(sel)}) || { click(){} }).click(), true`);

const dist = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y));

let shotN = 0;
async function shot(s, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const r = await s.send('Page.captureScreenshot', { format: 'png' });
  const out = path.join(SHOT_DIR, `absorb-${String(++shotN).padStart(2, '0')}-${name}.png`);
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
  if (LIGHT) await s.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] });

  console.log(
    `\n${BASELINE ? 'BASELINE (HEAD:public/)' : 'working copy'} · ${VP.width}x${VP.height}${LIGHT ? ' · light' : ''} · ${BASE}\n`
  );

  const boot = async () => {
    await s.send('Page.navigate', { url: `${BASE}/?t=${TOKEN}` });
    if (!(await waitFor(s, `!!document.querySelector('#list .card[data-key]')`)))
      throw new Error('the list never rendered');
  };
  await boot();

  /* =============== 1. an answer that creates beads: the whole flight ========= */

  console.log('an approved proposal — four beads, and a slow write to watch them over');

  await tap(s, `#list .card[data-key=${JSON.stringify(PROP_KEY)}] [data-act="toggle"]`);
  await waitFor(s, `!!document.querySelector('.proposal[data-key=${JSON.stringify(PROP_KEY)}]')`);
  // Approve files everything not explicitly declined, so with nothing picked it is
  // the whole proposal — and it is in the card's top bar, not under the rows.
  const APPROVE = `[data-act="prop-bulk"][data-key=${JSON.stringify(PROP_KEY)}][data-pick="yes"]`;
  // Two taps, like every other answer here: the first arms, the second commits.
  await tap(s, APPROVE);
  await sleep(120);
  const seenBefore = write.seen;
  await shot(s, 'before');
  await tap(s, APPROVE);

  await sleep(360);
  await shot(s, 'collapsed');
  const early = await evalJs(s, `({ card: ${CARD(PROP_KEY)}, beads: ${BEADS}, threads: ${THREADS} })`);
  check(
    'the card leaves the list on the tap, not when the write lands',
    !early.card && write.seen === seenBefore + 1,
    early.card ? 'the card was still in the list a third of a second in' : 'gone, with the write still out'
  );
  const lead = early.beads.find((b) => b.lead);
  check(
    'what is left in its place is a bead, in front of the list',
    early.beads.length > 0 && !!lead,
    `${early.beads.length} bead(s) on the overlay`
  );
  check(
    'it has collapsed to bead size and rounded down to a circle',
    !!lead && lead.w >= 12 && lead.w <= 26 && lead.radius.includes('50%'),
    lead ? `${lead.w}px, radius ${lead.radius}` : 'no lead bead at all'
  );
  check(
    'one bead per bead created, plus one for the bead you answered',
    early.beads.length === PROPOSED.length + 1,
    `${early.beads.length} for ${PROPOSED.length} approved`
  );

  // Far enough in that every bead has finished igniting and none has been let go.
  await sleep(1000);
  await shot(s, 'travelling');
  const lit = await evalJs(s, BEADS);
  const litLead = lit.find((b) => b.lead);
  const made = lit.filter((b) => !b.lead);
  check(
    'the beads your decision made are not the colour of the one you answered',
    !!litLead && made.length > 0 && made.every((b) => b.bg === made[0].bg) && made[0].bg !== litLead.bg,
    litLead ? `answered ${litLead.bg}, made ${made[0]?.bg}` : 'nothing lit'
  );

  // The repaint the flight has to survive: this is what used to own the card the
  // beads came out of.
  const before = await evalJs(s, BEADS);
  await evalJs(s, `window.beadcause.refresh(), true`);
  await sleep(400);
  const after = await evalJs(s, BEADS);
  const moved = before.length === after.length && before.some((b, i) => dist(b, after[i]) > 4);
  check(
    'a list repaint underneath does not destroy the flight',
    after.length === before.length && after.length > 0 && moved,
    `${after.length} bead(s) still in the air, still moving`
  );

  // By now they have arrived and are being pulled — and the write is still out.
  await sleep(1100);
  await shot(s, 'held-at-the-mark');
  const held = await evalJs(s, `({ beads: ${BEADS}, mark: ${MARK}, threads: ${THREADS} })`);
  const far = held.beads.map((b) => dist(b, held.mark));
  check(
    'they travel to the header mark and are held just short of it',
    held.beads.length > 0 && far.every((d) => d < 60),
    held.beads.length ? `${Math.max(...far)}px from the mark at the furthest` : 'no beads left to measure'
  );
  check(
    'nothing is swallowed while the tracker has not answered',
    held.threads === 0 && held.beads.length === PROPOSED.length + 1,
    `${held.threads} thread(s), ${held.beads.length} bead(s) still out`
  );

  // Watch for the thread rather than sampling for it: it exists for about a fifth
  // of a second between the write landing and the bead going in.
  const threaded = await waitFor(s, `${THREADS} > 0`, 40, 60);
  await shot(s, 'threaded');
  check('a thread grows out of the mark to catch them', threaded, threaded ? '' : 'no thread ever appeared');

  const empty = await waitFor(s, `${LAYER} === 0`, 60, 120);
  check(
    'they are absorbed, and the overlay is left with nothing in it',
    empty && !(await evalJs(s, CARD(PROP_KEY))),
    empty ? 'layer empty, card gone' : 'something was still on the overlay'
  );

  /* =============== 2. a write the tracker refuses ============================ */

  console.log('\na refused write — the beads have to come back');

  write.delay = 900;
  write.fail = true;

  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="toggle"]`);
  await waitFor(s, `!!document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-role="answer"]')`);
  await evalJs(
    s,
    `(() => {
       const box = document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-role="answer"]');
       box.value = ${JSON.stringify(TYPED)};
       box.dispatchEvent(new Event('input', { bubbles: true }));
       return true;
     })()`
  );
  await sleep(120);
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="answer"]`);
  await sleep(350);
  const left = !(await evalJs(s, CARD(PLAIN_KEY)));

  const back = await waitFor(s, CARD(PLAIN_KEY), 60, 150);
  const restored = await evalJs(
    s,
    `(() => {
       const box = document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-role="answer"]');
       return { text: box ? box.value : null, open: ${OPEN(PLAIN_KEY)}, layer: ${LAYER} };
     })()`
  );
  check(
    'a refused write flies the beads home and gives the card back',
    left && back && restored.open,
    left ? (back ? 'gone on the tap, back on the refusal' : 'it never came back') : 'it never left'
  );
  check(
    'the answer you had typed is still in it',
    restored.text === TYPED,
    restored.text === TYPED ? 'verbatim' : `got ${JSON.stringify((restored.text || '').slice(0, 40))}`
  );
  check('nothing is left on the overlay afterwards', restored.layer === 0, `${restored.layer} element(s)`);

  /* =============== 3. a comment, which closes nothing ======================== */

  console.log('\na comment — collapses, but is not swallowed');

  write.delay = 700;
  write.fail = false;
  let sawThread = false;
  // Sampled across the whole flight rather than at the end: the failure this guards
  // against is a thread that flashes for 200ms and is gone before the assertion.
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="note"]`);
  await sleep(300);
  const collapsedEarly = !(await evalJs(s, OPEN(PLAIN_KEY))) && (await evalJs(s, CARD(PLAIN_KEY)));
  for (let i = 0; i < 30; i++) {
    if (await evalJs(s, `${THREADS} > 0`)) sawThread = true;
    await sleep(80);
  }
  check(
    'the card collapses on the tap and stays in the list',
    collapsedEarly && (await evalJs(s, CARD(PLAIN_KEY))),
    collapsedEarly ? 'closed, still listed' : 'it either stayed open or left the list'
  );
  check(
    'a bead that is still open is never threaded or absorbed',
    !sawThread,
    sawThread ? 'the mark ate a bead that is still open' : 'no thread, as it should be'
  );
  check('the overlay is clear once it has settled', (await evalJs(s, LAYER)) === 0, '');

  /* =============== 4. prefers-reduced-motion ================================= */

  console.log('\nprefers-reduced-motion — the end state, without the motion');

  // Merged rather than replaced: setEmulatedMedia takes the whole feature list, and
  // a --light run must not lose its scheme the moment reduced motion goes on.
  const scheme = LIGHT ? [{ name: 'prefers-color-scheme', value: 'light' }] : [];
  await s.send('Emulation.setEmulatedMedia', {
    features: [...scheme, { name: 'prefers-reduced-motion', value: 'reduce' }],
  });
  write.delay = 900;
  await boot();
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="option"][data-opt="net"]`);
  await sleep(120);
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="option"][data-opt="net"]`);

  let anyBead = 0;
  for (let i = 0; i < 16; i++) {
    anyBead = Math.max(anyBead, await evalJs(s, `document.querySelectorAll('.fbead').length`));
    await sleep(80);
  }
  const goneAnyway = await waitFor(s, `!${CARD(PLAIN_KEY)}`, 40, 120);
  check('no bead is ever put in the air', anyBead === 0, anyBead ? `${anyBead} bead(s) moved` : '');
  check('the end state is still reached — the card is gone', goneAnyway, goneAnyway ? '' : 'the card stayed');
  await s.send('Emulation.setEmulatedMedia', { features: scheme });
} finally {
  close();
  server.closeAllConnections?.();
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed\n`);
if (KEEP) console.log(JSON.stringify(results, null, 2));
process.exit(failed.length ? 1 : 0);
