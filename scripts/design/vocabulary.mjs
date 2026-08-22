// How many different sizes, radii and weights does this system actually use?
//
// A design system's claim is that a screen is assembled from a small vocabulary. That is
// checkable rather than assertable, and the baseline fingerprint already holds every
// computed value on every element of all 77 components — so this reads it back and counts.
//
// What it is looking for is the *smear*: 13px and 13.5px and 12.5px doing the same job,
// three radii within two pixels of each other, a weight scale with 650 and 640 and 620 in
// it. Each one on its own was a reasonable local call. Together they are the difference
// between a system and a habit.
//
// It reports rather than fails. A smear is not a bug — it is a conversation, and the
// numbers are what makes it a short one.
//
// That conversation happened once, at bc-03pz, and two of the axes came out of it with a
// scale: radius is 6/10/14/18 plus 999px and 50%, weight is 400/550/600/650/700, and
// `test/metricscale.mjs` fails the build on a value that is neither. The four-apart
// spacing of the radius steps is chosen against the `near` threshold below — a scale whose
// own steps are 2px apart would be reported here as a smear, which would be a fair
// complaint. **Type sizes are deliberately still unenforced**: 22 of them and the worst of
// the three, but a type scale moves layout on a 360px phone, so that one is a design
// decision rather than a normalization and this script is still the whole of what says so.
//
// Run: node scripts/design/vocabulary.mjs [--full]
import { readFileSync, existsSync } from 'node:fs';

// Deliberately NOT under design-shots/ — see baseline.mjs; shots.mjs clears that whole
// directory on every render and this file must survive it.
const FILE = 'design-baseline.json';
if (!existsSync(FILE)) {
  console.error('needs a baseline. Record one with:\n  node scripts/design/baseline.mjs --save');
  process.exit(2);
}
const full = process.argv.includes('--full');
const { shots } = JSON.parse(readFileSync(FILE, 'utf8'));

/** Properties worth counting, and how near two values have to be to count as a smear. */
const AXES = [
  { prop: 'fontSize', label: 'type sizes', unit: 'px', near: 1 },
  { prop: 'fontWeight', label: 'font weights', unit: '', near: 30 },
  { prop: 'borderRadius', label: 'corner radii', unit: '', near: 2 },
  { prop: 'letterSpacing', label: 'letter spacings', unit: '', near: 0.2 },
  { prop: 'lineHeight', label: 'line heights', unit: 'px', near: 1 },
  { prop: 'gap', label: 'gaps', unit: '', near: 1 },
  { prop: 'paddingTop', label: 'top paddings', unit: '', near: 1 },
];

// Only the light scheme: the two differ in colour, not in metrics, and counting both
// doubles every tally without adding a distinct value.
const rows = Object.entries(shots)
  .filter(([k]) => k.endsWith('|light'))
  .flatMap(([, v]) => v);

const num = (s) => {
  const m = String(s).match(/^(-?[\d.]+)/);
  return m ? parseFloat(m[1]) : null;
};

console.log(`${rows.length} elements across ${Object.keys(shots).length / 2} components\n`);

for (const axis of AXES) {
  const tally = new Map();
  for (const r of rows) {
    const v = r.style[axis.prop];
    if (!v || v === 'normal' || v === '0px' || v === 'auto' || v === 'none') continue;
    tally.set(v, (tally.get(v) || 0) + 1);
  }
  const sorted = [...tally.entries()].sort((a, b) => (num(a[0]) ?? 0) - (num(b[0]) ?? 0));
  if (!sorted.length) continue;

  // A value used once or twice is a one-off; the smear that matters is between values
  // that are each carrying real weight and are nonetheless a hair apart.
  const heavy = sorted.filter(([, n]) => n >= 3);
  const pairs = [];
  for (let i = 1; i < heavy.length; i++) {
    const a = num(heavy[i - 1][0]);
    const b = num(heavy[i][0]);
    if (a != null && b != null && b - a > 0 && b - a <= axis.near) {
      pairs.push(`${heavy[i - 1][0]} (×${heavy[i - 1][1]}) / ${heavy[i][0]} (×${heavy[i][1]})`);
    }
  }

  console.log(`${axis.label} — ${sorted.length} distinct, ${heavy.length} used 3+ times`);
  const show = full ? sorted : sorted.filter(([, n]) => n >= 3);
  console.log('  ' + show.map(([v, n]) => `${v}·${n}`).join('  '));
  if (pairs.length) {
    console.log(`  ⤷ within ${axis.near}: ${pairs.join(' · ')}`);
  }
  console.log('');
}

// Text colours are the other vocabulary, and the one most likely to have drifted off the
// tokens: a literal hex in one rule is invisible until it is counted beside the rest.
const inks = new Map();
for (const r of rows) {
  const c = r.style.color;
  if (c) inks.set(c, (inks.get(c) || 0) + 1);
}
const sortedInks = [...inks.entries()].sort((a, b) => b[1] - a[1]);
console.log(`text colours (light) — ${sortedInks.length} distinct`);
for (const [c, n] of sortedInks.slice(0, full ? 99 : 10)) console.log(`  ${String(n).padStart(4)}  ${c}`);
