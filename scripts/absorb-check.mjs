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
//   • the write is on a queue now, so the *next* card has to be answerable while the
//     last one is still on the wire — and the refusal, when it comes, arrives while
//     you are somewhere else entirely and has to say so on the card rather than in a
//     toast that has already gone
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
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toQuestion } from '../lib/decision.js';
import { proposalBody, proposalTitle } from '../lib/proposal.js';
import { CHROME, launchChrome } from './helpers/chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
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

// Three more of the same, for the case this whole change exists for: answering a run
// of cards without waiting on the last one. Three rather than two because two proves
// only that a second tap is *possible* — three proves the queue is a queue.
const RUN_ISSUES = [1, 2, 3].map((n) => ({
  ...PLAIN_ISSUE,
  id: `ab-run${n}`,
  title: `Run of cards, number ${n}`,
}));

const QUESTIONS = [PROPOSAL_ISSUE, PLAIN_ISSUE, ...RUN_ISSUES].map((i) => ({
  ...toQuestion(WS, i),
  comments: [],
}));
const PROP_KEY = QUESTIONS[0].key;
const PLAIN_KEY = QUESTIONS[1].key;
const RUN_KEYS = QUESTIONS.slice(2).map((q) => q.key);
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
// `inAir`/`mostInAir` are what tell a queued submit path from an unqueued one, and
// they are the only thing here that can. Everything visible in the page was already
// optimistic before the queue landed — the card leaves the list on the tap either way
// — so the difference is on the wire: three taps used to put three writes in the air
// at once against a tracker that is a single Dolt writer, and now they go in single
// file. Nothing in the DOM says which of those just happened; the server does.
// `landed` is the other half of a refusal, and the one the page cannot invent: an answer
// is several acts in a row with the answer written last, so a write that fails may be
// standing over a merge that already happened. The daemon puts what it performed on the
// failure body (`performed` in lib/server.js); here it is a knob, because what is being
// measured is what the card does with it.
const write = { delay: 3500, fail: false, landed: null, seen: 0, inAir: 0, mostInAir: 0 };

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
const BASE_FILES = ['/app.js', '/style.css', '/index.html', '/absorb.js', '/submitqueue.js'];
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
      write.inAir++;
      write.mostInAir = Math.max(write.mostInAir, write.inAir);
      const t = setTimeout(() => {
        write.inAir--;
        return write.fail ? json({ error: 'bd: database is locked', ...(write.landed ? { landed: write.landed } : {}) }, 500) : json({ ok: true });
      }, write.delay);
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
// The red note, and the red edge on the shut card. Both, because they are two halves
// of one claim: the note is what says *why*, and the edge is what makes the card
// findable in a list you have scrolled several cards down.
const FAILED = (key) =>
  `(() => {
     const c = document.querySelector('#list .card[data-key=${JSON.stringify(key)}]');
     if (!c) return null;
     const note = c.querySelector('.failed-note');
     const r = note && note.getBoundingClientRect();
     return {
       marked: c.classList.contains('has-failed'),
       open: c.classList.contains('open'),
       note: note ? note.textContent.replace(/\\s+/g, ' ').trim() : null,
       border: note ? getComputedStyle(note).borderTopColor : null,
       onScreen: r ? r.top >= 0 && r.top <= innerHeight : false,
     };
   })()`;
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
const { s, close } = await launchChrome('beadcause-absorb-');

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

  await tap(s, `#list .card[data-key=${JSON.stringify(PROP_KEY)}][data-act="toggle"]`);
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

  /* =============== 1b. three answered back to back ========================== */

  // bc-ka5y.10.1, and the case the queue exists for. A 2.2s write against three taps:
  // if answering still blocked on the write, the second tap could not happen until
  // ~2.2s in and the third until ~4.4s, so all three landing inside one write's worth
  // of time is the measurement. `write.seen` is the other half — three taps must be
  // three writes, never a join, because each one is its own bead.
  console.log('\nthree cards answered back to back — none of them waits for the last');

  write.fail = false;
  write.delay = 2200;

  const seenAtStart = write.seen;
  write.mostInAir = 0;
  const began = Date.now();
  for (const key of RUN_KEYS) {
    // The option answers from the shut card (bc-5ldc): the first tap arms it, the
    // second sends. Two gestures, exactly as a thumb would — and no card ever opens,
    // which is the point of tapping the same button twice here.
    const opt = `#list .card[data-key=${JSON.stringify(key)}] [data-act="option"][data-opt="net"]`;
    await tap(s, opt);
    await waitFor(s, `!!document.querySelector(${JSON.stringify(`${opt}.confirm`)})`);
    await tap(s, opt);
    // The claim: the card is out of the list *now*, without waiting for anything.
    await waitFor(s, `!${CARD(key)}`, 14, 60);
  }
  const tookToTap = Date.now() - began;
  const stillListed = await evalJs(s, RUN_KEYS.map((k) => CARD(k)).join(' || '));
  check(
    'all three are answerable inside the time a single write takes',
    !stillListed && tookToTap < write.delay,
    `${tookToTap}ms for three taps, against a ${write.delay}ms write`
  );

  // At least two of the three are still owed at this point, and that is what the beads
  // are drawing: one flight per queued answer, all in the air together.
  const midFlight = await evalJs(s, `${BEADS}.length`);
  check(
    'the queued answers are in the air together, not one at a time',
    midFlight >= 2,
    `${midFlight} bead(s) in the air at once`
  );

  // Measured *after* they have arrived, and that is not fussiness — the three cards
  // are identical and each moves up into the last one's place as it leaves, so all
  // three flights set off from very nearly the same rectangle. Where they must differ
  // is at the far end: `slot()` fans beads within one flight, so without a per-flight
  // lane three queued answers hold on one standoff point and read as one bead.
  await sleep(1200);
  await shot(s, 'three-in-lanes');
  const lanes = await evalJs(s, `({ beads: ${BEADS}, mark: ${MARK} })`);
  const apart = lanes.beads.flatMap((b, i) => lanes.beads.slice(i + 1).map((o) => dist(b, o)));
  check(
    'and each holds its own lane at the mark rather than stacking on one point',
    lanes.beads.length >= 2 && apart.every((d) => d > 6),
    lanes.beads.length >= 2
      ? `${lanes.beads.length} bead(s), closest pair ${Math.min(...apart)}px apart`
      : 'they had all landed before this could be measured'
  );

  let landed = false;
  for (let i = 0; i < 90 && !landed; i++) {
    landed = write.seen - seenAtStart >= RUN_KEYS.length;
    if (!landed) await sleep(150);
  }
  check(
    'three taps are three separate writes — nothing is joined',
    landed && write.seen - seenAtStart === RUN_KEYS.length,
    `${write.seen - seenAtStart} write(s) for ${RUN_KEYS.length} taps`
  );
  // The discriminating one, and the only assertion in this section that a page
  // without the queue cannot pass: three taps used to put three writes in the air
  // together against a tracker that can only take one at a time.
  check(
    'and they go in single file — never two in the air against one Dolt writer',
    write.mostInAir === 1,
    `${write.mostInAir} write(s) in the air at the busiest moment`
  );
  check('and the overlay is empty once they have all landed', await waitFor(s, `${LAYER} === 0`, 40, 150), '');

  /* =============== 2. a write the tracker refuses ============================ */

  // Rewritten for bc-ka5y.10.2, and the before-picture was exactly this section as it
  // stood: the card came back with the draft in it and the reason went into a toast.
  // That was honest while the tap waited for the write — you had not moved. It stopped
  // being honest the moment submits queued, because the refusal can now land while you
  // are three cards further on, where a message that fades in five seconds over an
  // unrelated question is indistinguishable from the answer having gone through.
  console.log('\na refused write — the beads come back, and so does the card, in red');

  write.delay = 900;
  write.fail = true;

  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}][data-act="toggle"]`);
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

  const failed = await evalJs(s, FAILED(PLAIN_KEY));
  check(
    'the card comes back marked failed, carrying the reason the server gave',
    Boolean(failed?.note) && /database is locked/.test(failed.note),
    failed?.note ? `“${failed.note.slice(0, 60)}…”` : 'no note on the card at all'
  );
  check(
    'the note is drawn red, not the amber a close gate uses',
    Boolean(failed?.border) && failed.border !== 'rgba(0, 0, 0, 0)',
    failed?.border || 'no border — the stylesheet has no rule for it'
  );
  check(
    'it is brought into focus rather than left to be found',
    Boolean(failed?.open) && Boolean(failed?.onScreen),
    failed?.open ? (failed?.onScreen ? 'open, note on screen' : 'open, but the note is off screen') : 'the card is shut'
  );

  // The edge is the half that has to survive collapsing the card, because the whole
  // failure mode is a refusal arriving while you are reading something else.
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="collapse"]`);
  await sleep(220);
  const shut = await evalJs(s, FAILED(PLAIN_KEY));
  check(
    'and it stays marked once it is shut again',
    Boolean(shut) && shut.marked && !shut.open,
    shut ? (shut.marked ? 'has-failed, collapsed' : 'the mark came off with the card') : 'the card went'
  );

  // Cleared by dealing with it, which is the other half of the acceptance: a red that
  // never goes away is a red nobody reads. And the draft has to survive that.
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}][data-act="toggle"]`);
  await waitFor(s, `!!document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] .failed-note')`);
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="failed-dismiss"]`);
  await sleep(220);
  const cleared = await evalJs(s, FAILED(PLAIN_KEY));
  const keptDraft = await evalJs(
    s,
    `(() => {
       const box = document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-role="answer"]');
       return box ? box.value : null;
     })()`
  );
  check(
    'dismissing the note clears the red and keeps the answer',
    Boolean(cleared) && !cleared.marked && !cleared.note && keptDraft === TYPED,
    cleared?.note ? 'the note stayed' : keptDraft === TYPED ? 'red gone, draft intact' : 'it ate the draft'
  );

  // And the one refusal that may not say nothing was written. bc-e59w: the merge runs
  // before the answer does, so bd dying in between puts *nothing was written and nothing
  // was lost* on a card whose pull request is merged and whose branch is gone — read as
  // *try again*, which is wrong in the expensive direction. When the daemon says what it
  // performed, the reassurance is replaced rather than joined.
  write.landed = ['Merged #7 as c5004cce — closed `zz-work`.'];
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}][data-act="toggle"]`);
  await waitFor(s, `!!document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-role="answer"]')`);
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="answer"]`);
  await waitFor(s, `!!document.querySelector('#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] .failed-note')`, 60, 150);
  const overMerge = await evalJs(s, FAILED(PLAIN_KEY));
  check(
    'a refusal standing over an act that landed says what landed',
    Boolean(overMerge?.note) && /Merged #7 as c5004cce/.test(overMerge.note),
    overMerge?.note ? `“${overMerge.note.slice(0, 90)}…”` : 'no note on the card at all'
  );
  check(
    'and stops claiming nothing was written, because it was',
    Boolean(overMerge?.note) && !/Nothing was written/.test(overMerge.note),
    overMerge?.note ? `“${overMerge.note.slice(0, 90)}…”` : 'no note at all'
  );
  write.landed = null;
  await tap(s, `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="failed-dismiss"]`);
  await sleep(220);

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
  // A choice answers from the shut card, on the second tap (bc-5ldc). Two gestures
  // either way; what this section needs is only that an answer completes with the
  // motion turned off.
  const plainOpt = `#list .card[data-key=${JSON.stringify(PLAIN_KEY)}] [data-act="option"][data-opt="net"]`;
  await tap(s, plainOpt);
  await waitFor(s, `!!document.querySelector(${JSON.stringify(`${plainOpt}.confirm`)})`);
  await sleep(120);
  await tap(s, plainOpt);

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
