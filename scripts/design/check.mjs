// Does each card actually carry the app's real styling?
//
// Two failure modes the build cannot see on its own. A class in the markup that
// style.css never styles is a typo — the preview renders, it just renders wrong.
// A card whose slice came out near-empty means the strict matcher rejected every
// rule, which usually means the markup is missing the parent class a rule needs.
//
// Run: node scripts/design/check.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse, selectorClasses } from './cssslice.mjs';
import { GROUPS } from './manifest.mjs';

const CSS = readFileSync('public/style.css', 'utf8');

// Every class style.css styles anywhere, at any depth.
const STYLED = new Set();
for (const n of parse(CSS)) {
  if (n.type === 'rule') for (const c of selectorClasses(n.prelude)) STYLED.add(c);
  else if (n.type === 'atrule') {
    for (const m of parse(n.body)) if (m.type === 'rule') for (const c of selectorClasses(m.prelude)) STYLED.add(c);
  }
}

// Classes the bundle owns rather than the app — the card frame, not the component.
const FRAME = /^ds-/;

// Classes the app's own markup carries. Some of these style.css never styles and
// never should — `.option .label` inherits everything from the button around it, and
// exists so paintPicked() has something to write textContent into. So "unstyled" on
// its own is not the error; "unstyled AND the app has never heard of it" is, and that
// one is a class this manifest invented, which renders as a preview that looks right
// and is not the component.
const APP = readdirSync('public')
  .filter(f => /\.(html|js)$/.test(f))
  .map(f => readFileSync(join('public', f), 'utf8'))
  .join('\n');
// Classes the app builds by interpolation, which no literal search can find. The app
// writes `class="pill p${b.priority}"`, so `.p2` is really in the DOM — it just has no
// rule, because only P0 and P1 carry colour. A card that renders `pill p2` is being
// faithful to the markup, not inventing a class, so these families are known by shape.
const TEMPLATED = [
  /^p[0-4]$/,              // pill p${priority}
  /^st-[a-z_]+$/,          // pill st-${status}, pr-stage st-${stage}
  /^pick-(yes|no)$/,       // prop-row pick-${choice}
];

// Matching inside any string literal, not just a whole one: the app appends state with
// `${done ? ' closed' : ''}`, so the class arrives as ' agent-chat' — leading space and
// all — and an equality test never sees it.
const known = (c) => {
  if (TEMPLATED.some(re => re.test(c))) return true;
  const e = c.replace(/[-]/g, '\\-');
  return new RegExp(`["'\`][^"'\`\\n]*\\b${e}\\b`).test(APP);
};

const cards = GROUPS.flatMap(g => g.cards.map(c => ({ ...c, group: g.group })));
const problems = [];
let thin = 0;

for (const card of cards) {
  const used = new Set();
  for (const m of card.markup.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !FRAME.test(c)) used.add(c);
  }
  const invented = [...used].filter(c => !STYLED.has(c) && !known(c));
  if (invented.length) problems.push({ card: card.path, kind: 'class the app does not have', detail: invented.join(' ') });

  const file = join('design-bundle', card.path);
  let body = '';
  try { body = readFileSync(file, 'utf8'); } catch { problems.push({ card: card.path, kind: 'not built', detail: '' }); continue; }

  if (!body.startsWith(`<!-- @dsCard group="${card.group}" -->`)) {
    problems.push({ card: card.path, kind: 'missing @dsCard marker', detail: '' });
  }
  const sliced = body.slice(body.indexOf('<style>'), body.indexOf('/* Card frame'));
  const rules = (sliced.match(/\{/g) || []).length;
  // Foundations cards are spec sheets built from tokens, not from app classes — a
  // small slice there is correct, so they are held to the token block only.
  const floor = card.group === 'Foundations' ? 3 : 8;
  if (rules < floor) { thin++; problems.push({ card: card.path, kind: 'thin slice', detail: `${rules} rules, want ≥${floor}` }); }
  if (!/--accent:/.test(sliced)) problems.push({ card: card.path, kind: 'no token block', detail: '' });
}

// Rule counts prove a card got *something*. These prove it got the right thing —
// one load-bearing declaration per family, so a slicer that starts dropping
// descendant rules or losing a selector list's later parts fails here rather than
// shipping fifty previews that are subtly not the app.
const MUST = [
  ['decisions/card-shut.html', /\.card \{[^}]*border-radius: var\(--radius\)/],
  ['decisions/options.html', /\.option\.picked \{[^}]*background: var\(--accent\)/],
  ['decisions/pills.html', /\.pill\.id\b/],
  ['chrome/tabbar.html', /\.tabbar \{[^}]*position: fixed/],
  ['chrome/topbar.html', /\.topbar \{[^}]*position: sticky/],
  ['chrome/pulse.html', /@keyframes pulse/],
  ['workrows/work-row.html', /\.work-row\b/],
  ['monitor/service.html', /\.svc\.bad\b/],
  ['filters/chips.html', /\.chip\b/],
  ['utility/buttons.html', /\.primary \{/],
];
for (const [path, re] of MUST) {
  let body = '';
  try { body = readFileSync(join('design-bundle', path), 'utf8'); } catch { continue; }
  if (!re.test(body)) problems.push({ card: path, kind: 'lost a load-bearing rule', detail: String(re) });
}

// Every card path must be unique, or write_files silently overwrites one with another.
const seen = new Map();
for (const c of cards) {
  if (seen.has(c.path)) problems.push({ card: c.path, kind: 'duplicate path', detail: `also ${seen.get(c.path)}` });
  seen.set(c.path, c.name);
}

const total = (function walk(dir) {
  let n = 0;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    n += statSync(p).isDirectory() ? walk(p) : 1;
  }
  return n;
})('design-bundle');

for (const p of problems) console.log(`✗ ${p.card.padEnd(38)} ${p.kind}${p.detail ? ' — ' + p.detail : ''}`);
console.log(`\n${cards.length} cards in manifest, ${total} files built, ${problems.length} problems (${thin} thin)`);
process.exit(problems.length ? 1 : 0);
