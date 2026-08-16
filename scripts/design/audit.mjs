// What each card is MISSING that the app would have.
//
// The strict slicer keeps a rule only when every class in its selector is one the
// card renders. That is the right default, but it means a component previewed
// outside the parent it normally lives in quietly loses the rules that key off that
// parent — `.card.open .freeform` never fires for a bare `.freeform`, and the preview
// then shows a composer the app never draws.
//
// So: for every rule that mentions one of a card's classes but was rejected, print
// which classes were the reason. A short list of "context" classes (the card is a
// fragment, and its parent is genuinely elsewhere) is expected. A long one means the
// markup is wrong.
//
// Run: node scripts/design/audit.mjs [pathFragment]
import { readFileSync } from 'node:fs';
import { parse, selectorClasses, isElementOnly } from './cssslice.mjs';
import { GROUPS } from './manifest.mjs';

const CSS = readFileSync('public/style.css', 'utf8');
const ROOTISH = /^(:root|html|body|\*)\b/;

/** Flatten to (selectorPart, context) pairs, media wrapper included for reporting. */
function allSelectors() {
  const out = [];
  const push = (node, at) => {
    for (const part of splitList(node.prelude)) out.push({ sel: part, at });
  };
  for (const n of parse(CSS)) {
    if (n.type === 'rule') push(n, '');
    else if (n.type === 'atrule' && !/^@keyframes/i.test(n.prelude)) {
      for (const m of parse(n.body)) if (m.type === 'rule') push(m, n.prelude);
    }
  }
  return out;
}

function splitList(sel) {
  const parts = []; let depth = 0, start = 0;
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (c === ',' && depth === 0) { parts.push(sel.slice(start, i)); start = i + 1; }
  }
  parts.push(sel.slice(start));
  return parts.map(s => s.trim()).filter(Boolean);
}

const SELECTORS = allSelectors();
const only = process.argv[2];
const cards = GROUPS.flatMap(g => g.cards.map(c => ({ ...c, group: g.group })))
  .filter(c => !only || c.path.includes(only));

let totalGaps = 0;
for (const card of cards) {
  const have = new Set();
  for (const m of card.markup.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c && !/^ds-/.test(c)) have.add(c);
  }
  for (const c of card.extraClasses || []) have.add(c);
  if (card.bodyClass) for (const c of card.bodyClass.split(/\s+/)) have.add(c);

  // Rules that touch this card but were rejected, and the classes to blame.
  const blame = new Map();
  for (const { sel, at } of SELECTORS) {
    if (ROOTISH.test(sel) || isElementOnly(sel)) continue;
    const cs = [...selectorClasses(sel)];
    if (!cs.some(c => have.has(c))) continue;      // not about this card at all
    const missing = cs.filter(c => !have.has(c));
    if (!missing.length) continue;                 // kept
    for (const m of missing) {
      if (!blame.has(m)) blame.set(m, []);
      blame.get(m).push(at ? `${at} { ${sel} }` : sel);
    }
  }

  if (!blame.size) continue;
  const ranked = [...blame.entries()].sort((a, b) => b[1].length - a[1].length);
  totalGaps += ranked.length;
  console.log(`\n${card.path}  (${card.group})`);
  for (const [cls, sels] of ranked) {
    console.log(`  .${cls.padEnd(22)} ${String(sels.length).padStart(2)}  ${sels[0].slice(0, 88)}`);
  }
}
console.log(`\n${cards.length} cards, ${totalGaps} missing-context classes`);
