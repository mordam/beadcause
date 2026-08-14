// What the design system does not cover yet.
//
// audit.mjs answers "what is this card missing". This answers the other question:
// which of the 821 classes style.css defines does no card render at all, ranked by
// how much styling sits behind them — a class with 29 rules and no card is a hole in
// the system; one with a single rule usually is not.
//
// Run: node scripts/design/coverage.mjs [--all]
import { readFileSync } from 'node:fs';
import { parse, selectorClasses } from './cssslice.mjs';
import { GROUPS } from './manifest.mjs';

const CSS = readFileSync('public/style.css', 'utf8');

const weight = new Map();   // class -> how many rules mention it
const bump = (sel) => { for (const c of selectorClasses(sel)) weight.set(c, (weight.get(c) || 0) + 1); };
for (const n of parse(CSS)) {
  if (n.type === 'rule') bump(n.prelude);
  else if (n.type === 'atrule' && !/^@keyframes/i.test(n.prelude)) {
    for (const m of parse(n.body)) if (m.type === 'rule') bump(m.prelude);
  }
}

const covered = new Set();
for (const g of GROUPS) for (const c of g.cards) {
  for (const m of c.markup.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const k of m[1].split(/\s+/)) if (k && !/^ds-/.test(k)) covered.add(k);
  }
  for (const k of c.extraClasses || []) covered.add(k);
  if (c.bodyClass) for (const k of c.bodyClass.split(/\s+/)) covered.add(k);
}

const gaps = [...weight.entries()]
  .filter(([c]) => !covered.has(c))
  .sort((a, b) => b[1] - a[1]);

const cut = process.argv.includes('--all') ? 0 : 3;
const shown = gaps.filter(([, n]) => n > cut);

for (const [cls, n] of shown) console.log(String(n).padStart(3), '.' + cls);
console.log(`\n${weight.size} classes styled · ${covered.size} rendered by a card · ${gaps.length} uncovered` +
  (cut ? ` (${shown.length} with more than ${cut} rules)` : ''));
