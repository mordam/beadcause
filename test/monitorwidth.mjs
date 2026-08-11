/**
 * The monitor's box has to be square, and nothing else notices when it isn't.
 *
 * `bin/monitor.js` draws a bordered frame: every line is exactly `W` terminal columns,
 * opening on `│` and closing on `│`. Getting there means counting *columns*, and JS
 * gives you code units — '⏳' is one code unit and two columns, '🤔' is two of each,
 * '✍️' is two code points and two columns, a ZWJ family is seven code points and still
 * two columns. `lib/width.js` counts them against a table of ranges, and a wrong entry
 * in that table shears the right-hand border of every line beneath it. Nothing crashes.
 * Nobody is looking at the screen at the time. So this suite is the only thing between
 * a new phase icon and a permanently crooked frame.
 *
 * Three layers, deliberately independent of each other:
 *
 * 1. **An oracle that is not the table.** Unicode's own `Emoji_Presentation` property,
 *    which V8 ships as a regex escape, decides which characters a terminal draws
 *    double-width. Every glyph this program actually prints — every phase icon, every
 *    literal in `bin/monitor.js` — is measured both ways and the two must agree. A new
 *    icon outside the WIDE table fails here, which is the regression that matters:
 *    `'🈯'` is `Emoji_Presentation=Yes` and sits below the table's first emoji range.
 *
 * 2. **A corpus with widths written out by hand**, covering what the ranges cannot be
 *    derived from: the variation selector that promotes its *neighbour*, the ZWJ that
 *    fuses two glyphs into one, skin tones, keycaps, combining accents.
 *
 * 3. **A real frame, from the real program.** `node bin/monitor.js --once` against a
 *    fake daemon serving deliberately hostile text, with every rendered line measured
 *    by the oracle rather than by the code that drew it. That is the end-to-end claim
 *    of the acceptance criteria: every line, exactly the same column width.
 *
 * No network beyond loopback, and nothing written outside a temp directory.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { dw, cut, clusterWidth, graphemes, WIDE, ZERO } from '../lib/width.js';
import { PHASES } from '../lib/activity.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');

/* ---------------------------------------------------------------- the oracle */

/*
 * A second opinion, from Unicode rather than from the table under test.
 *
 * `\p{Emoji_Presentation}` is exactly "renders as a colour emoji with no coaxing",
 * which is exactly the set a terminal gives two columns to; ICU ships the data with
 * Node, so this needs nothing installed and updates with the runtime. The rest is the
 * handful of rules the property does not cover — a variation selector or a ZWJ makes
 * emoji of its neighbours, wide scripts are wide, marks and format characters take no
 * space of their own — and everything else is one column.
 *
 * It is not a general-purpose width function and does not have to be: it is only ever
 * asked about characters this repo prints, or ones named in the corpus below.
 */
const EMOJI_PRESENTATION = /^\p{Emoji_Presentation}$/u;
const NO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
// Script_Extensions rather than Script, which is the trap: '\u30FC', the prolonged sound
// mark in \u30DC\u30FC\u30C0\u30FC, is Script=Common and belongs to no script at all by the narrow
// reading \u2014 while being as wide as the kana either side of it.
const WIDE_SCRIPT = /^[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}\p{scx=Hangul}]$/u;
const fullwidthBlock = (cp) =>
  (cp >= 0x3000 && cp <= 0x303e) || (cp >= 0xff01 && cp <= 0xff60) || (cp >= 0xffe0 && cp <= 0xffe6);
// The halfwidth forms are kana and hangul by script and one column by design, so they
// have to be taken out again before the script rule sees them.
const halfwidthBlock = (cp) => cp >= 0xff61 && cp <= 0xffdc;

function oracle(cluster) {
  const cps = [...cluster];
  // A ZWJ sequence is one emoji however many code points went into it, and U+FE0F asks
  // for the emoji form of whatever it follows. Both are two columns.
  if (cps.includes('\u200D') || cps.includes('\uFE0F')) return 2;
  const base = cps[0];
  const cp = base.codePointAt(0);
  if (EMOJI_PRESENTATION.test(base)) return 2;
  if (NO_WIDTH.test(base)) return 0;
  // Nothing below U+1100 is drawn double-width — and some of it is claimed by Han
  // through Script_Extensions without being drawn like Han at all: U+00B7, the middle
  // dot this program separates fields with, is Latin and Han at once.
  if (cp < 0x1100) return 1;
  if (halfwidthBlock(cp)) return 1;
  if (WIDE_SCRIPT.test(base) || fullwidthBlock(cp)) return 2;
  return 1;
}

/** The width of a whole string, as the oracle sees it. Used to measure real output. */
const columns = (s) => graphemes(s).reduce((n, g) => n + oracle(g), 0);

/* ------------------------------------------- 1. every glyph the monitor prints */

/**
 * The distinct non-ASCII grapheme clusters appearing literally in a source file.
 *
 * Comments included on purpose: the prose in these files is full of the same
 * characters the code draws with, and a wider corpus costs nothing.
 */
function glyphsIn(rel) {
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  return new Set(graphemes(src).filter((g) => /[^\x00-\x7f]/.test(g)));
}

const printed = new Set([
  ...glyphsIn('bin/monitor.js'),
  ...glyphsIn('lib/activity.js'),
  ...Object.values(PHASES)
    .map((p) => p.icon)
    .filter(Boolean),
]);

assert.ok(printed.size > 20, `expected a corpus of glyphs from the monitor, got ${printed.size}`);

for (const g of printed) {
  const cps = [...g].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')).join(' ');
  assert.equal(
    dw(g),
    oracle(g),
    `${JSON.stringify(g)} (${cps}) is ${dw(g)} column(s) by lib/width.js and ${oracle(g)} by Unicode — ` +
      'a glyph the monitor prints that the WIDE table disagrees with will shear the border'
  );
}

// Every phase icon, named individually, because these are the ones that arrive one at a
// time as the daemon grows and each one is a chance to get it wrong.
for (const [phase, meta] of Object.entries(PHASES)) {
  if (!meta.icon) continue;
  assert.equal(dw(meta.icon), oracle(meta.icon), `the ${phase} icon`);
  assert.ok([1, 2].includes(dw(meta.icon)), `the ${phase} icon takes ${dw(meta.icon)} columns`);
}

// And the guard itself: a plausible icon the table does not know about must be caught,
// or the loop above is only asserting that two things agree about nothing. U+1F22F is
// Emoji_Presentation=Yes and sits below the first emoji range in WIDE.
assert.notEqual(dw('🈯'), oracle('🈯'), 'U+1F22F is meant to be the known gap the oracle catches');

/* --------------------------------------------- 2. the corpus, widths by hand */

/** [string, columns] — every expectation here is written down, not derived. */
const CORPUS = [
  ['', 0],
  ['abc', 3],
  ['   ', 3],
  // East Asian wide, in the three shapes a title could arrive in.
  ['漢字', 4],
  ['ひらがな', 8],
  ['한글', 4],
  ['Ａ', 2], // fullwidth latin A, U+FF21
  ['、。', 4], // CJK punctuation
  ['ボーダー', 8], // U+30FC, the prolonged sound mark, is wide and belongs to no script
  ['ｱｲｳ', 3], // halfwidth katakana: kana by script, one column each
  // Emoji: one code unit and two columns, and two of each.
  ['⏳', 2],
  ['🤔', 2],
  ['✅', 2],
  ['⛔', 2],
  // U+FE0F promotes the character *before* it, which is the rule no range can express.
  ['✍️', 2], // U+270D U+FE0F — the drafting icon
  ['✍', 1], // the same character alone, text presentation
  ['⚠', 1],
  ['⚠️', 2],
  // A ZWJ fuses what follows into what precedes: seven code points, one glyph.
  ['👨‍👩‍👧', 2],
  ['👍🏽', 2], // skin tone modifier, which adds nothing of its own
  ['1️⃣', 2], // keycap: '1' promoted by U+FE0F, then a zero-width enclosing mark
  // Zero-width things, which must not be counted and must not crash.
  ['é', 1], // combining acute
  ['\u200B', 0], // zero-width space // zero-width space
  ['a\u200Bb', 2],
  // The monitor's own furniture.
  ['│', 1],
  ['┌─┐', 3],
  ['●', 1],
  ['◌', 1],
  ['✕', 1],
  ['⦿', 1],
  ['…', 1],
  ['·', 1],
  ['▶', 1],
  ['⏸', 1],
  ['🔇', 2],
  ['🔔', 2],
  // Mixed, which is what a bead title actually looks like.
  ['bc-n5g 漢字 ⏳ done', 19], // 6 + 1 + 4 + 1 + 2 + 1 + 4
];

for (const [s, expected] of CORPUS) {
  assert.equal(dw(s), expected, `dw(${JSON.stringify(s)})`);
  assert.equal(columns(s), expected, `the oracle disagrees about ${JSON.stringify(s)} — check the expectation`);
}

// Additivity: a string is the sum of its clusters, which is what lets `seg()` measure
// each part as it is added and never re-measure the line.
for (const [s] of CORPUS) {
  assert.equal(
    dw(s),
    graphemes(s).reduce((n, g) => n + clusterWidth(g), 0),
    `dw is not the sum of its clusters for ${JSON.stringify(s)}`
  );
}

// Control characters are invisible rather than one column, so a stray \r in a bead
// title cannot push the border out.
assert.equal(dw('a\rb'), 2, 'control characters take no columns');
assert.equal(dw('\0'), 0, 'NUL takes no columns');

// The tables themselves: ordered, non-overlapping, low ≤ high. A range typed backwards
// matches nothing and would be invisible in every other assertion here.
for (const [name, table] of [
  ['WIDE', WIDE],
  ['ZERO', ZERO],
]) {
  for (const [a, b] of table) {
    assert.ok(Number.isInteger(a) && Number.isInteger(b), `${name}: [${a}, ${b}] is not a pair of integers`);
    assert.ok(a <= b, `${name}: [${a.toString(16)}, ${b.toString(16)}] is back to front, so it matches nothing`);
  }
}

/* ------------------------------------------------------------------ 3. cut() */

for (const [s] of CORPUS) {
  for (let max = 0; max <= dw(s) + 2; max++) {
    const { text, width } = cut(s, max);
    assert.ok(width <= max, `cut(${JSON.stringify(s)}, ${max}) is ${width} columns wide`);
    assert.equal(dw(text), width, `cut(${JSON.stringify(s)}, ${max}) reported the wrong width`);
    assert.ok(s.startsWith(text), `cut(${JSON.stringify(s)}, ${max}) is not a prefix`);
    // Never half a glyph: what comes back is a whole number of clusters.
    assert.ok(
      graphemes(s).slice(0, graphemes(text).length).join('') === text,
      `cut(${JSON.stringify(s)}, ${max}) split a grapheme cluster`
    );
  }
  assert.equal(cut(s, dw(s)).text, s, `cut at its own width should be the whole of ${JSON.stringify(s)}`);
}

// The odd boundary: a wide glyph cannot half-fit, so a column is left empty rather than
// borrowed from the border.
assert.deepEqual(cut('🤔🤔🤔', 5), { text: '🤔🤔', width: 4 }, 'a wide glyph must not be split across the border');
assert.deepEqual(cut('🤔', 1), { text: '', width: 0 }, 'one column is not enough for a two-column glyph');

/* ------------------------------------------------- 4. a real frame, end to end */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'beadcause-monitorwidth-'));
const CONFIG_DIR = path.join(tmp, 'config');
fs.mkdirSync(CONFIG_DIR, { recursive: true });

// The child gets this as its HOME, because `loadConfig()` reconciles the saved
// workspace list against `~/beads` on every load — so without it the frame would show
// whichever workspaces this Mac happens to have, and say so on stdout above the box.
const WORKSPACES = ['beadcause', 'personal'];
for (const w of WORKSPACES) fs.mkdirSync(path.join(tmp, 'beads', w, '.beads'), { recursive: true });

const TOKEN = 'monitorwidth-test-token';

/**
 * A config that names the spaces the payload does, so the monitor takes the branch that
 * recomputes quiet locally — the one that prints "🔇 quiet until …" beside a wide glyph.
 */
fs.writeFileSync(
  path.join(CONFIG_DIR, 'config.json'),
  JSON.stringify({
    token: TOKEN,
    port: 4318,
    workspaces: WORKSPACES.map((name) => ({ name, dir: path.join(tmp, 'beads', name, '.beads') })),
    spaces: [
      { name: '仕事', workspaces: ['beadcause'], quietDays: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
      { name: 'Personal 🌙', workspaces: ['personal'], muted: true },
      { name: 'Loud', workspaces: ['loud'] },
    ],
  })
);

/** One question per phase, so every icon in `PHASES` is drawn by the real renderer. */
const PHASE_KEYS = Object.entries(PHASES).filter(([, m]) => m.icon);
const status = {};
PHASE_KEYS.forEach(([phase], i) => {
  status[`beadcause/bc-${i}`] = {
    phase,
    detail: `漢字 ${phase} ✍️ progress`,
    actor: 'agent 👩‍💻',
    at: new Date(Date.now() - 90_000).toISOString(),
  };
});
fs.writeFileSync(path.join(CONFIG_DIR, 'status.json'), JSON.stringify(status));

const HOSTILE = [
  'plain ascii, nothing clever',
  '漢字だらけの題名でボーダーを試す',
  'emoji everywhere 🤔🔍🔨⛔⏳✅ and back',
  'a ZWJ family 👨‍👩‍👧‍👦 and a skin tone 👍🏽 and a keycap 1️⃣',
  'combining marks: ééé and a zero width​space',
  'variation selectors: ✍️ ⚠️ ✕ ⦿ ●',
  // Long enough to be truncated at every width the frame might use, and wide enough
  // that the truncation lands mid-glyph.
  `🤔${'漢'.repeat(80)}🤔 tail`,
  `${'🔍'.repeat(70)}`,
];

const payload = {
  seq: 41,
  observing: true,
  workspaces: ['beadcause', 'personal'],
  spaces: [
    { name: '仕事', count: 3, quiet: true, muted: false },
    { name: 'Personal 🌙', count: 0, quiet: false, muted: true },
    { name: 'Loud', count: 1, quiet: false, muted: false },
  ],
  advocates: [
    {
      workspace: 'beadcause',
      queue: 4,
      limit: 3,
      paused: false,
      quiet: false,
      surveying: false,
      note: 'ラストティック ⏳',
      workers: [
        { id: 'bc-n5g', at: new Date(Date.now() - 300_000).toISOString(), claimed: true },
        { id: 'bc-2mpr', at: new Date(Date.now() - 60_000).toISOString(), claimed: false },
      ],
      next: [{ id: 'bc-abc' }],
    },
    { workspace: '個人', queue: 0, limit: 2, paused: true, quiet: false, workers: [], note: '一時停止 🔇' },
  ],
  requests: [
    {
      key: 'beadcause/bc-req',
      id: 'bc-req',
      question: 'may I 🤔 differ in 漢字?',
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      awaitingAgent: true,
      amendment: { agent: 'worker 👷', kind: 'prohibited', scope: `wide scope ${'⛔'.repeat(30)}` },
    },
  ],
  questions: PHASE_KEYS.map(([phase], i) => ({
    key: `beadcause/bc-${i}`,
    id: `bc-${i}`,
    priority: i % 5,
    question: HOSTILE[i % HOSTILE.length],
    createdAt: new Date(Date.now() - (i + 1) * 120_000).toISOString(),
    commentCount: i,
    awaitingAgent: i === 0,
  })),
  events: [
    { type: 'foundation-request', at: new Date().toISOString(), key: 'beadcause/bc-req', title: '🤔 asks', scope: '漢字' },
    { type: 'advocate', at: new Date().toISOString(), key: 'beadcause', action: 'opened', title: '👨‍👩‍👧 group', detail: '⏳' },
    { type: 'question', at: new Date().toISOString(), key: 'beadcause/bc-0', title: `${'🔨'.repeat(60)}`, quiet: true },
  ],
};

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;

/**
 * One frame from the real program, piped — which is what makes it monochrome and 100
 * columns wide, so the output is text to be measured rather than a screen.
 *
 * `spawn` and not `spawnSync`, deliberately: the fake daemon above is served by *this*
 * process, and `spawnSync` blocks this event loop until the child exits. The child's
 * `--once` fetch has no timeout, so the two would wait for each other forever.
 */
function frame(target) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'bin/monitor.js'), '--once', '--url', target], {
      cwd: ROOT,
      env: { ...process.env, HOME: tmp, BEADCAUSE_CONFIG_DIR: CONFIG_DIR, NO_COLOR: '1' },
    });
    let out = '';
    let err = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (err += d));
    const guard = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(guard);
      try {
        assert.equal(code, 0, `monitor --once exited ${code}\n${err}`);
        const all = out.split('\n').filter((l) => l.length);
        // The frame starts at the top border. Anything above it is `loadConfig()`
        // narrating on stdout, which is not the box and is not this suite's business.
        const top = all.findIndex((l) => l.startsWith('┌'));
        assert.notEqual(top, -1, `no frame in the output:\n${out}`);
        const lines = all.slice(top);
        assert.ok(lines.length > 10, `a frame should be more than ${lines.length} lines:\n${out}`);
        resolve(lines);
      } catch (e) {
        reject(e);
      }
    });
  });
}

const OPENS = new Set(['│', '┌', '├', '└']);
const CLOSES = new Set(['│', '┐', '┤', '┘']);

function assertSquare(lines, what) {
  // Every line must agree with the top border, and the top border must be 100: piped
  // output has no `process.stdout.columns`, and the monitor falls back to 100.
  const width = columns(lines[0]);
  assert.equal(width, 100, `${what}: a piped frame is 100 columns; the top border measured ${width}`);
  for (const [i, line] of lines.entries()) {
    const got = columns(line);
    assert.equal(
      got,
      width,
      `${what}: line ${i + 1} is ${got} columns, not ${width} — the right border is sheared here:\n${line}`
    );
    // No escape sequences: colour is off when piped, and a stray one would be counted
    // as text by everything above.
    assert.ok(!line.includes('\x1b'), `${what}: line ${i + 1} carries an escape sequence`);
    const cells = graphemes(line);
    assert.ok(OPENS.has(cells[0]), `${what}: line ${i + 1} opens on ${JSON.stringify(cells[0])}`);
    assert.ok(CLOSES.has(cells[cells.length - 1]), `${what}: line ${i + 1} closes on ${JSON.stringify(cells.at(-1))}`);
  }
}

const live = await frame(url);
assertSquare(live, 'a live frame');

// The hostile content really did reach the screen — a frame that quietly dropped the
// questions pane would be square and prove nothing.
const text = live.join('\n');
for (const [phase, meta] of PHASE_KEYS) {
  assert.ok(text.includes(meta.icon), `the ${phase} icon never reached the screen`);
}
assert.ok(text.includes('漢字'), 'the wide-character title never reached the screen');
assert.ok(text.includes('👨‍👩‍👧‍👦'), 'the ZWJ family never reached the screen');
assert.ok(text.includes('…'), 'nothing was truncated, so the ellipsis path was never exercised');
assert.ok(text.includes('⦿ observing'), 'the observing badge never reached the screen');

// And the frame drawn when there is nothing to draw: no spaces, no questions, no
// events, and an offline banner instead of a connection. Same box.
server.close();
assertSquare(await frame('http://127.0.0.1:1'), 'an offline frame');

fs.rmSync(tmp, { recursive: true, force: true });

console.log(
  `✓ monitor width — ${printed.size} printed glyphs against Unicode, ${CORPUS.length} measured by hand, ` +
    `${live.length} rendered lines all ${columns(live[0])} columns`
);
