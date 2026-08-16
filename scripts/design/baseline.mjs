// Which components did that stylesheet change actually move — and what about them?
//
// `shots.mjs` proves dark and light differ; this answers the question you have after
// editing one rule in a 1,300-rule sheet: what *else* did I touch. Front-end files here
// are shared by twelve pages, so "I only changed the pill" is a hypothesis.
//
//   node scripts/design/baseline.mjs --save     record the current rendering
//   node scripts/design/baseline.mjs            compare against the record
//
// **It fingerprints computed styles, not pixels.** Hashing the PNG was the obvious
// first build and it does not work: `captureBeyondViewport` at deviceScaleFactor 2 is
// not byte-stable, and a save-then-compare with nothing changed moved one to fifteen
// cards per run, never the same ones. Killing every animation and waiting two frames for
// layout did not fix it either. A screenshot is the right artifact for a person and the
// wrong one for a machine.
//
// Reading the cascade back out of the page instead is deterministic by construction, and
// it diffs far better: pixels can only say a card moved, where this says
// `.primary.danger color: rgb(255,255,255) → rgb(43,13,13)`.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { serveBundle, openPage, cardList } from './harness.mjs';

const PORT = 4580;
const FILE = 'design-shots/baseline.json';
const save = process.argv.includes('--save');
const filter = process.argv.slice(2).find((a) => !a.startsWith('--'));

/**
 * What counts as "how this looks".
 *
 * Geometry is rounded to the whole pixel: sub-pixel layout wobbles by a hundredth
 * between runs on a retina scale factor, and nobody has ever shipped a bug that was
 * one hundredth of a pixel wide.
 */
const FINGERPRINT = `(() => {
  const PROPS = [
    'color', 'backgroundColor', 'borderTopColor', 'borderTopWidth', 'borderRadius',
    'fontSize', 'fontWeight', 'fontFamily', 'letterSpacing', 'lineHeight', 'textTransform',
    'display', 'position', 'opacity', 'paddingTop', 'paddingLeft', 'marginTop', 'gap',
    'boxShadow', 'textDecorationLine',
  ];
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    const cls = typeof el.className === 'string' ? el.className.trim() : '';
    // The card frame is this bundle's furniture, not the app's — see build.mjs.
    if (/(^|\\s)ds-/.test(cls)) continue;
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
    const r = el.getBoundingClientRect();
    const style = {};
    for (const p of PROPS) style[p] = cs[p];
    out.push({
      at: el.tagName.toLowerCase() + (cls ? '.' + cls.split(/\\s+/).join('.') : ''),
      box: [Math.round(r.width), Math.round(r.height)].join('x'),
      style,
    });
  }
  return out;
})()`;

const server = await serveBundle(PORT);
const page = await openPage('beadcause-baseline-');
const cards = await cardList(filter);

const now = {};
for (const card of cards) {
  await page.size(card.viewport?.width || 440, card.viewport?.height || 400);
  for (const theme of ['dark', 'light']) {
    await page.theme(theme);
    await page.go(`http://127.0.0.1:${PORT}/${card.path}`);
    // Without this the one property that still moves is `.spark`'s opacity, read
    // mid-breath. Everything else about the cascade is already stable.
    await page.freeze();
    now[`${card.path}|${theme}`] = await page.evaluate(FINGERPRINT);
  }
  process.stdout.write('·');
}
page.close();
server.close();
console.log('\n');

mkdirSync('design-shots', { recursive: true });

if (save) {
  writeFileSync(FILE, JSON.stringify({ at: new Date().toISOString(), shots: now }));
  const els = Object.values(now).reduce((a, v) => a + v.length, 0);
  console.log(`baseline saved — ${Object.keys(now).length} renders, ${els} elements`);
  process.exit(0);
}

if (!existsSync(FILE)) {
  console.error('no baseline yet. Record one with:\n  node scripts/design/baseline.mjs --save');
  process.exit(2);
}

const was = JSON.parse(readFileSync(FILE, 'utf8'));
const changes = [];

for (const [key, rows] of Object.entries(now)) {
  const [path, theme] = key.split('|');
  const before = was.shots[key];
  if (!before) { changes.push({ path, theme, at: '(whole card)', prop: 'new', from: '', to: '' }); continue; }
  const byAt = new Map();
  // Keyed by selector *and ordinal*, so three identical pills stay three rows rather
  // than collapsing into one and reporting a change that is really a reorder.
  const index = (list) => {
    const m = new Map(); const seen = new Map();
    for (const r of list) {
      const n = (seen.get(r.at) || 0) + 1;
      seen.set(r.at, n);
      m.set(`${r.at}#${n}`, r);
    }
    return m;
  };
  const A = index(before), B = index(rows);
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) { changes.push({ path, theme, at: k, prop: 'appeared', from: '', to: b.box }); continue; }
    if (a.box !== b.box) changes.push({ path, theme, at: k, prop: 'size', from: a.box, to: b.box });
    for (const p of Object.keys(b.style)) {
      if (a.style[p] !== b.style[p]) changes.push({ path, theme, at: k, prop: p, from: a.style[p], to: b.style[p] });
    }
  }
  for (const k of A.keys()) if (!B.has(k)) changes.push({ path, theme, at: k, prop: 'removed', from: A.get(k).box, to: '' });
  void byAt;
}

const cardsMoved = new Set(changes.map((c) => c.path));
// Grouped by what changed rather than by where: one edited rule shows up on every card
// that draws it, and the useful sentence is the rule, once, with its blast radius.
const byChange = new Map();
for (const c of changes) {
  const k = `${c.at.replace(/#\d+$/, '')} · ${c.prop} · ${c.from} → ${c.to}`;
  if (!byChange.has(k)) byChange.set(k, new Set());
  byChange.get(k).add(`${c.path}:${c.theme}`);
}

for (const [k, where] of [...byChange.entries()].sort((a, b) => b[1].size - a[1].size)) {
  console.log(`  ${k}`);
  console.log(`      ${where.size} render(s) — ${[...where].slice(0, 3).join(', ')}${where.size > 3 ? ' …' : ''}`);
}

console.log(
  `\nbaseline ${was.at.slice(0, 16).replace('T', ' ')} · ` +
  `${cardsMoved.size} component(s) changed, ${byChange.size} distinct change(s), ` +
  `${Object.keys(now).length} renders compared`
);
process.exit(cardsMoved.size ? 1 : 0);
