// Build the Claude Design bundle out of public/style.css and the component manifest.
//
// One HTML file per card, each self-contained: the token block, the element-level
// base rules, and only the rules whose classes that card actually renders. The first
// line is the `<!-- @dsCard group="…" -->` marker the Design System pane indexes on.
//
// Run: node scripts/design/build.mjs   → writes design-bundle/
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse, selectorClasses, isElementOnly, pruneKeyframes } from './cssslice.mjs';
import { GROUPS } from './manifest.mjs';

const CSS = readFileSync('public/style.css', 'utf8');
const NODES = parse(CSS);
const OUT = 'design-bundle';

const ROOTISH = /^(:root|html|body|\*)\b/;

/** Class names a fragment of markup renders. */
function markupClasses(html) {
  const out = new Set();
  for (const m of html.matchAll(/class\s*=\s*"([^"]*)"/g)) {
    for (const c of m[1].split(/\s+/)) if (c) out.add(c);
  }
  return out;
}

/**
 * Strict slice: keep a rule only when every class it names is one this card renders.
 *
 * Permissive matching ("any class in common") drags a card like `.card` into every
 * descendant rule in the sheet — hundreds of them, none of which fire. Strict keeps
 * the card honest in the other direction too: a rule that quietly vanishes because
 * the markup forgot a class shows up as a preview that looks wrong, which is a
 * signal, where dead CSS is not.
 */
function sliceFor(want, { base = true } = {}) {
  const keep = (sel) => {
    if (ROOTISH.test(sel)) return true;
    if (isElementOnly(sel)) return base;
    const cs = selectorClasses(sel);
    if (!cs.size) return false;
    for (const c of cs) if (!want.has(c)) return false;
    return true;
  };
  // A selector list is kept per-comma-part, so `.pill, .chip` survives for a card
  // that only draws pills. Splitting on top-level commas only — `:not(a, b)` and
  // `color-mix(…)` both carry commas that are not selector separators.
  const splitList = (sel) => {
    const parts = []; let depth = 0, start = 0;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) { parts.push(sel.slice(start, i)); start = i + 1; }
    }
    parts.push(sel.slice(start));
    return parts.map(s => s.trim()).filter(Boolean);
  };
  const rewrite = (node) => {
    const parts = splitList(node.prelude);
    const kept = parts.filter(keep);
    if (!kept.length) return null;
    if (kept.length === parts.length) return node.raw;
    return `${node.lead}${kept.join(',\n')} {${node.body}}`;
  };

  const out = [];
  for (const node of NODES) {
    if (node.type === 'rule') { const r = rewrite(node); if (r) out.push(r); continue; }
    if (node.type === 'atrule') {
      if (/^@keyframes/i.test(node.prelude)) { out.push(node.raw); continue; }
      const inner = parse(node.body).filter(n => n.type === 'rule' || n.type === 'atrule');
      const kept = [];
      for (const n of inner) {
        if (n.type === 'atrule') { kept.push(n.raw); continue; }
        const r = rewrite(n);
        if (r) kept.push(r);
      }
      if (kept.length) out.push(`${node.lead}${node.prelude} {${kept.join('')}\n}`);
    }
  }
  return pruneKeyframes(out.join('').trim());
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function page(card, css) {
  const bodyClass = card.bodyClass ? ` class="${card.bodyClass}"` : '';
  return `<!-- @dsCard group="${card.group}" -->
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(card.name)} · Beadcause</title>
<style>
${css}

/* Card frame — not part of the app. Enough page ground for the component to sit on. */
html, body { min-height: 100%; }
body { padding: 16px; }
.ds-note {
  max-width: 62ch; margin: 0 0 14px; padding: 0 0 12px;
  border-bottom: 1px solid var(--line);
  color: var(--muted); font-size: 13px; line-height: 1.5;
}
.ds-note b { color: var(--prose); font-weight: 600; }
.ds-stack { display: grid; gap: 18px; }
.ds-label {
  color: var(--muted); font-size: 11px; letter-spacing: .08em;
  text-transform: uppercase; margin: 0;
}
${card.extraCss || ''}
</style>
</head>
<body${bodyClass}>
${card.note ? `<p class="ds-note">${card.note}</p>` : ''}
${card.markup.trim()}
</body>
</html>
`;
}

export function build() {
  rmSync(OUT, { recursive: true, force: true });
  const written = [];
  for (const card of GROUPS.flatMap(g => g.cards.map(c => ({ ...c, group: g.group })))) {
    const want = new Set([...markupClasses(card.markup), ...(card.extraClasses || [])]);
    const css = sliceFor(want, { base: card.base !== false });
    const path = join(OUT, card.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page(card, css));
    written.push({ path: card.path, group: card.group, name: card.name, classes: want.size, bytes: css.length });
  }
  return written;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const w = build();
  const byGroup = new Map();
  for (const c of w) byGroup.set(c.group, (byGroup.get(c.group) || 0) + 1);
  for (const [g, n] of byGroup) console.log(String(n).padStart(3), g);
  console.log(`— ${w.length} cards, ${(w.reduce((a, c) => a + c.bytes, 0) / 1024).toFixed(0)} KB of sliced CSS`);
}
