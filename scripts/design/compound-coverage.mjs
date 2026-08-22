// What no card renders together — the compound half of coverage.mjs.
//
// coverage.mjs asks whether style.css's classes are rendered by some card, **one class at
// a time**. That is not the same question as whether a *rule* is ever exercised: a
// selector like `.pr-stage.st-live` needs both classes on the same element, and a card can
// render `.pr-stage` on one span and `.st-live` on another and satisfy coverage.mjs while
// the rule itself fires nowhere in the whole bundle. contrast.mjs then has nothing to
// measure it against, and a colour failure can sit under AA indefinitely with "0 below AA"
// printing every run — which is exactly what happened to `.pr-stage.st-live` for as long
// as bc-15tu's five rules were filed (fixed there by hand, in public/prcard.js's own
// markup; the manifest card is the worked example this file pins as a regression, below).
//
// This is bc-ka5y.16, the general form of that one case. A crude probe over the sheet at
// the time it was filed counted 525 compound selector-parts, 290 rendered together by no
// card, 134 of those setting a colour. Both the co-occurrence check and the colour check
// below are text matches rather than a real cascade, so treat every count this prints as
// an upper bound the way that filing did — some of the 290 are legitimately uncoverable
// (`:has()`, a state no static card can be in) — but the *shape* of the gap is real, and
// it is exactly the shape a text-only audit cannot otherwise see.
//
// Run: node scripts/design/compound-coverage.mjs [--all]
import { readFileSync } from 'node:fs';
import { parse } from './cssslice.mjs';
import { GROUPS } from './manifest.mjs';

/** Split on commas/combinators that are not nested inside `()` or `[]` — `:not(a, b)` and
 *  `[data-x="a b"]` both carry characters that are not selector separators. */
function splitTop(str, seps) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of str) {
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
    if (depth === 0 && seps.includes(ch)) {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const CLASS_RE = /\.(-?[A-Za-z_][\w-]*)/g;
const COLOR_PROP_RE =
  /(?:^|[;{])\s*(?:-webkit-|-moz-)?(color|background|background-color|border-color|outline-color|fill|stroke|caret-color|text-decoration-color)\s*:/i;

/**
 * Every chained (no-combinator) group of 2+ classes a selector list asks for — the part
 * that has to land on **one element**. `.pr-stage.st-live .pill` yields one compound,
 * `{classes: [pr-stage, st-live], text: '.pr-stage.st-live'}`; `.pr-stage .st-live` (a
 * descendant, not a compound) yields none, because that pair is not this bug's shape.
 */
export function compounds(selectorList) {
  const out = [];
  for (const sel of splitTop(selectorList, [','])) {
    for (const part of splitTop(sel, [' ', '\t', '\n', '>', '+', '~'])) {
      const classes = [...new Set([...part.matchAll(CLASS_RE)].map((m) => m[1]))];
      if (classes.length >= 2) out.push({ text: part, classes: classes.sort() });
    }
  }
  return out;
}

/** Walk the sheet the way coverage.mjs does: top-level rules, one level into
 *  @media/@supports/@layer, and never into @keyframes — nothing there is a selector. */
function eachRule(css, fn) {
  for (const n of parse(css)) {
    if (n.type === 'rule') fn(n);
    else if (n.type === 'atrule' && !/^@keyframes/i.test(n.prelude)) {
      for (const m of parse(n.body)) if (m.type === 'rule') fn(m);
    }
  }
}

/**
 * Every class= attribute value in every card's markup, kept as its own set — a real
 * element's classes, never flattened into one bag the way coverage.mjs's Set does.
 * Deliberately excludes `extraClasses`/`bodyClass`: both are the manifest's own admission
 * that the static markup does *not* carry that class (a hover/armed/busy state a
 * screenshot cannot show — see manifest.mjs's own comment on the field), so crediting them
 * as "on the element together with whatever else is there" would assert a combination
 * nobody has actually drawn, which is the exact failure this file exists to catch.
 */
export function renderedClassSets(groups) {
  const sets = [];
  for (const g of groups) for (const c of g.cards) {
    for (const m of c.markup.matchAll(/class\s*=\s*"([^"]*)"/g)) {
      sets.push(new Set(m[1].split(/\s+/).filter(Boolean)));
    }
  }
  return sets;
}

/** One row per distinct class combination in the sheet: does any rendered set carry every
 *  class in it, and does any rule using it set a colour? */
export function findCompounds(css, renderedSets) {
  const byKey = new Map();
  eachRule(css, (node) => {
    const color = COLOR_PROP_RE.test(node.body);
    for (const c of compounds(node.prelude)) {
      const key = c.classes.join('.');
      if (!byKey.has(key)) {
        const matched = renderedSets.some((set) => c.classes.every((cl) => set.has(cl)));
        byKey.set(key, { classes: c.classes, color: false, selectors: new Set(), matched });
      }
      const e = byKey.get(key);
      e.color = e.color || color;
      e.selectors.add(c.text);
    }
  });
  return [...byKey.values()];
}

function main() {
  const css = readFileSync('public/style.css', 'utf8');
  const all = findCompounds(css, renderedClassSets(GROUPS));
  const gaps = all.filter((e) => !e.matched);
  const colorGaps = gaps.filter((e) => e.color);

  const showAll = process.argv.includes('--all');
  const rows = (showAll ? all : gaps)
    .slice()
    .sort((a, b) => Number(b.color) - Number(a.color) || a.classes.join().localeCompare(b.classes.join()));

  for (const e of rows) {
    const mark = e.matched ? ' ' : '✗';
    const tag = e.color ? 'color' : '     ';
    console.log(`${mark} ${tag}  .${e.classes.join('.')}  (${[...e.selectors].join(', ')})`);
  }

  console.log(
    `\n${all.length} compound class-selectors · ${gaps.length} rendered together by no card · ` +
    `${colorGaps.length} of those set a colour`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) main();
